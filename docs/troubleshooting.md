# 排障与已知限制

先看两条不需要排查的事实：

- **没有账号能不能用**：不能。网关是把「你已授权的账号额度」转成 API，至少得有一个可用账号——挂载官方 CLI 登录态，或在控制台用设备授权添加。
- **并发高了为什么变慢**：`agent` 模式下 CLI 是「一个 agent 跑一串会话」，请求会排队，这是上游限制，不是网关卡住，建议压到 2~4。`direct` 模式按账号限流，每个账号默认 10 个在途请求（`max_concurrency_per_account`），超了才排队。

## 启动与部署

**构建时卡在 `apt-get` 或拉不到 node 镜像**

国内网络可以给 Docker 配镜像加速，或者把 Dockerfile 第一行换成你拉得到的镜像源，比如 `FROM docker.m.daocloud.io/library/node:22-bookworm-slim`。

**构建时 `aiworkcn not found after install`**

说明官方安装脚本失败或换了安装路径。进容器排查：

```bash
docker compose run --rm aiwork bash
bash /tmp/aiwork-install.sh --help     # 看安装器说明
```

**端口 8080 被占用**

改宿主端口再重建（容器内的 8080 不要动）：

```bash
HOST_PORT=18080        # 写进 .env
docker compose up -d
```

或者一步到位：`./scripts/set-port.sh --host 18080`（见 [configuration.md](configuration.md#改端口容器内外两个)）。

**`/status` 里 `daemon` 不是 `running`**

```bash
docker compose exec aiwork aiworkcn agent list
docker compose exec aiwork aiworkcn agent start coder
docker compose logs aiwork | tail -50
```

守护进程是常驻的，如果反复挂掉，通常是内存不足（`free -h` 看一下）。

## 登录态

**对话返回 503 `cli_not_logged_in`**

服务端 CLI 没登录，或登录态失效了。报错是刻意的：返回空字符串只会让人更难排查。

```bash
docker compose exec aiwork aiworkcn auth status --json
docker compose exec aiwork aiworkcn login
```

登录成功后 `/status` 里 `cli_auth` 会变成 `active`，`models` 会从 1 变成完整的模型列表（桥接层监测 `config.json` 的 mtime，热重载，不用重启）。

**对话返回空内容 / 401 未授权**

基本是登录态过期，处理方式同上。

## 流式与响应

**流式输出变成「一次性吐出来」**

反向代理把 SSE 缓冲了。用本项目的 Caddyfile（已经带了 `flush_interval -1`）；用 nginx 的话加 `proxy_buffering off; proxy_cache off;`。

**工具调用不生效 / 回复空白**

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 模型完全不调用工具，直接文字回答 | 平台侧没开「工具调用」 | WorkBuddy：设置里模型配置打开 `supportsToolCall`；其他平台找「函数调用/工具调用」开关 |
| 一调用工具对话就结束 | 上游把 `tool_calls` 拆成几十个碎片帧，客户端只读了第一帧 | 已在网关内合并（`tool_calls merged: N call(s)`），确认日志里有这行 |
| 显示「已完成」但消息空白 | 上游只给了 function_call / 连接提前断开没发 `[DONE]` | 开启 `DEBUG_DUMP=1` 看真实原因 |

## 抓包

把 `DEBUG_DUMP=1` 加到 `.env` 后重启，每个请求会在卷里留下：

```bash
docker compose exec aiwork ls -t /data/gw-logs | head
# xxxx-req.json      客户端入参（model / tools / tool_choice / messages）
# xxxx-up.sse        上游原始 SSE（逐帧，含碎片 tool_calls）
# xxxx-err-400.json  上游错误体
```

抓包目录由 `DUMP_DIR` 决定，默认是数据卷里的 `/data/gw-logs`。文件有数量、容量和时效上限（`DEBUG_DUMP_MAX_FILES` / `DEBUG_DUMP_MAX_BYTES` / `DEBUG_DUMP_MAX_AGE_SEC`），定位完记得改回 `DEBUG_DUMP=0`。

---

## 已知限制

- **协议支持范围**：`/v1/chat/completions`、`/v1/models`、`/v1/responses`（+ `GET /v1/responses/:id`）、`/v1/messages`、`/v1/messages/count_tokens`。`/v1/responses/compact`（Codex 的上下文压缩）只能返回 501，原因见 [clients/codex.md](clients/codex.md)。
- **`automodel` 不能用于多轮工具调用**：上游会返回 409 `provider_state_unavailable`，网关把错误翻成「请换成具体模型」的提示，不会替你换。客户端直接填具体模型名就行。
- **Codex 的两项能力缺口**：`namespace` 分组工具（`multi_agent_v1` 子代理）和内置 `web_search` 网关没有对应执行能力，本地返回 400 `unsupported_tool_type`，不静默丢弃。日常改代码、跑命令不受影响。
- **`tool_choice` 在工具被消费时降级**：`tools` 全被 tool_search 消费后，`tool_choice` 与 `parallel_tool_calls` 不下发（上游无 tools 时会拒绝）；仅 `tool_choice` 指向被消费工具时，只丢该字段并写日志留痕（`[messages]` / `[responses]` 前缀）。客户端指定的工具被消费后，「指定」意图随之丢失，请求按剩余工具或纯文本继续；指向未声明工具（笔误）仍语义原样下发，由上游按未知 function 拒绝。`tools` 本来为空且未发生任何消费时不记降级（避免伪降级）。
- **Claude Code 的能力缺口**：`count_tokens` 是估算值，不是精确计数。思考档位与 thinking 块已支持（ADR-0022）：`budget_tokens` 会映射透传，`REASONING=auto` 时能看到思考块；但 thinking 块的签名是空串，接真 Anthropic 上游时需重新评估。
- **工具类型的消费策略**：Claude Code 的 tool search 一族在 `/v1/messages` 被网关**消费**——`tool_search_tool_regex` / `tool_search_tool_bm25` 等工具条目、历史里的 `tool_reference` / `server_tool_use` / `tool_search_tool_result` 检索插曲直接收走（`server_tool_use` 一律消费；其配对的 `web_search_tool_result` 等 server tool result 仍按丢弃返回 400 `unsupported_content_block_type`，整条 web_search 插曲请求照旧被拒绝）；`/v1/responses` 消费 `tool_search` 条目与 `tool_search_call` / `tool_search_output` / `tool_reference` input 项。消费的含义是**前置加载全部工具定义**，有日志留痕。`defer_loading` 字段三协议（含原生 `/v1/chat/completions`）一律收走：messages / responses 记为**消费**，chat 路径对函数工具整体白名单重建（剥离非协议字段）。原生 chat 路径的 `tool_search_tool_*` 工具条目仍返回 400（Anthropic 专有类型不会经 chat 协议自然出现）。其余未知工具类型（`web_search`、`custom_shell` 等，网关没有可替代的执行能力）本地返回 400 `unsupported_tool_type`。详见 [ADR-0021](adr/INDEX.md#adr-0021)。
- **上下文节省不实现**（ADR-0021 后果节）：网关不做网关内检索模拟，工具定义全量占用上游上下文，与直连真实 Anthropic 的体验不同；大工具量场景挤压上下文时再评估升级为模拟。
- **登录态的来源**：挂载进容器的官方 CLI 状态目录是宿主机目录（只读），重启容器不会丢；控制台通过设备授权添加的账号则落在数据卷 `/data/accounts/`。如果 `/status` 里 `cli_auth` 不是 `active`，重新执行一次 `docker compose exec aiwork aiworkcn login` 即可；直连模式看的是 `router_key_missing`，不是 `cli_auth`。
- **模型列表会热重载**：桥接层监测 `config.json` 的 mtime，登录后模型会从 1 个自动补全成该账号可用的完整列表，无需重启
- **模型名不会静默替换**：`model` 要么命中账号支持的真实模型，要么命中 `model_aliases` 里的显式别名，否则返回 404（ADR-0003）。上游仍决定实际可用的模型清单。
- **单账号并发有限**：所有调用方共享同一个账号的额度。`direct` 模式每账号默认 10 个在途请求（`max_concurrency_per_account` 可调）；`agent` 模式受 CLI 单 agent 限制，建议压到 2~4。
- **CLI 行为依赖官方版本**：本项目通过 `aiworkcn chat --json` 的 NDJSON 事件流工作。如果官方大改事件格式，需要同步调整 `runChat()` 里的解析逻辑。
