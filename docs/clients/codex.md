# 接 Codex CLI（`/v1/responses`）

**先纠正一个常见误判**：Codex 连不上，通常不是「地址填错了」。

从 0.4x 起 Codex 把 Chat Completions 支持**整段删掉**了，二进制里留着一句明确的报错：

```
`wire_api = "chat"` is no longer supported.
How to fix: set `wire_api = "responses"` in your provider config.
```

实测 `codex.exe`（v0.145.0）里 `chat/completions` 出现 **0 次**，只有 `/responses` 和 `/responses/compact`。所以不管 `base_url` 填什么，只要网关没有 `/v1/responses` 就一定 404——这也是为什么日志里会看到一串 `POST /v1/responses → 404`。

网关内建了这一层翻译（`src/responses-adapter.js`）：把 Responses 请求翻成 `chat.completions`，交给直连链路，再把结果翻回 `response.*` 事件流。这样工具调用合并、有限故障换号、会话指纹和用量统计都复用同一套逻辑，不用两头各修一遍。

## 配置

`~/.codex/config.toml` 照着写：

```toml
model = "deepseek-flash"          # 换成你要用的模型 id
model_provider = "aiwork"
model_context_window = 128000     # 不填会有 "Model metadata not found" 警告，且自动压缩会算错
approval_policy = "never"         # 按需
sandbox_mode = "workspace-write"  # 按需

[model_providers.aiwork]
name = "AiWork2API"
base_url = "http://127.0.0.1:8080/v1"     # 远端换成 https://你的域名/v1
wire_api = "responses"                     # 关键，必须是 responses
experimental_bearer_token = "sk-你的key"
stream_idle_timeout_ms = 300000
```

两个容易踩的点：

- **不要写 `requires_openai_auth = true`**，那会让 Codex 走 ChatGPT 账号鉴权，和自定义 Bearer 冲突。
- **`base_url` 要带 `/v1`**，Codex 会自己拼 `/responses`。（Claude Code 相反，不带 `/v1`，别填反。）

## 实测通过的链路

下面这条链路实测跑通过：

```
codex exec "用 shell_command 执行 echo hello-gateway"
  → 模型返回 function_call: shell_command({"command":"echo hello-gateway"})
  → Codex 执行命令，拿到 hello-gateway
  → 回传 function_call_output，模型复述结果
```

Codex 首发一次会带 7 个函数工具（`shell_command` / `update_plan` / `view_image` / `request_user_input` / `get_goal` / `create_goal` / `update_goal`），全部正常映射。

## 能力边界

会打日志明说，不静默失败：

| 项目 | 情况 |
|---|---|
| `shell_command` / `update_plan` 等函数工具 | ✅ 完整映射，多轮闭环 |
| 流式事件 `response.created / output_text.delta / function_call_arguments.* / completed` | ✅ 顺序与 OpenAI 一致 |
| `previous_response_id` | ✅ 网关内存里记着，进程重启就丢（Codex 默认带全量历史，影响不大） |
| `namespace` 类工具（如 `multi_agent_v1` 子代理） | ❌ 本地返回 400 `unsupported_tool_type`。网关无对应执行能力，不静默丢弃 |
| `web_search` 内置工具 | ❌ 本地返回 400 `unsupported_tool_type`。网关无法代执行联网检索 |
| `POST /v1/responses/compact` | ❌ 返回 501。上下文压缩要 OpenAI 服务端的 compaction 格式，伪造不出来 |
| `text.format` / `json_schema`、图片输入 | ✅ 正常翻译 |

表中未列出的 tool search 一族（工具条目与历史检索痕迹）按**消费**处理，以工具前置加载等价替代、有日志留痕，不落 400；完整说明见 [ADR-0021](../adr/INDEX.md#adr-0021) 与 [troubleshooting.md 的「已知限制」](../troubleshooting.md#已知限制)。

## 前缀缓存的实测

Codex 的 11K 系统提示正好越过前缀缓存阈值，实测每轮命中 70% 左右：

```
prompt_tokens: 10182  cached_tokens: 7296
```

（Codex 自己显示 "tokens used 2886"，那是未命中部分，不是总算。）

缓存的命中规律与不稳定因素见 [api-reference.md 的「前缀缓存」](../api-reference.md#前缀缓存)。
