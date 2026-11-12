# 接口与调用语义

网关对外提供三种接入协议：Chat Completions 原生支持，Responses（Codex）和 Messages（Claude Code）各有一层适配。三条路最后都走同一条调度链路，选号、失败换号、记账和会话指纹的行为一致。

部署步骤见 [README](../README.md)，客户端接入细节见 [clients/](clients/)。

## 鉴权

两种头都认：

```
Authorization: Bearer <key>
x-api-key: <key>            # Anthropic SDK 的标准写法
```

请求行里写绝对 URL 的形式网关也接受（有些客户端会这么发），对所有路径生效，不限于适配层接口。

## 调用凭据与数据隔离

一份调用凭据不等于一个独立用户，但数据边界是清楚的：

- **会话与历史隔离**：会话按 Key 分开，不同调用 Key 就算用同一个 Session ID 或响应 ID，也不会串话或污染彼此的历史。
- **用量隔离**：客户端调用 `/api/usage` 只拿到自己的用量视图；`/api/keys` 按 ADR-0012 在未设口令时等同管理面，返回全部凭据的（掩码）统计。
- **只读部署视图**（ADR-0009）：持有有效调用凭据即可读 `GET /api/dashboard`（账号池就绪、积分汇总、模型倍率、本机统计）、`GET /api/logs`、`GET /api/usage/buckets`。这三个接口都不返回请求体、提示词或令牌明文；账本里的「按凭据」分组只有凭据标识与用量汇总，与请求日志本来就有的「凭据」列同级。**写操作仍然只能走管理会话。**
- **命令行配多 Key**：也可以在 `.env` 里直接写 `API_KEYS="sk-key1:平台A,sk-key2:平台B"`。

`/api/dashboard` 与 `/api/usage/buckets` 的关系是「实时快照」与「历史账本」，两者的请求数口径不同，见下文各自的说明。


## 接口清单

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|:---:|------|
| POST | `/v1/chat/completions` | ✓ | OpenAI 兼容对话，支持 `stream` |
| GET | `/v1/models` | ✓ | OpenAI 兼容模型列表 |
| POST | `/v1/responses` | ✓ | OpenAI Responses 协议（Codex CLI 用） |
| GET | `/v1/responses/:id` | ✓ | 取回 `store=true` 时的响应（内存，重启即失效） |
| POST | `/v1/responses/compact` | ✓ | 返回 501（压缩格式无法伪造，见 [clients/codex.md](clients/codex.md)） |
| POST | `/v1/messages` | ✓ | Anthropic Messages 协议（Claude Code 用） |
| POST | `/v1/messages/count_tokens` | ✓ | 上下文 token 估算（Claude Code 靠它决定何时压缩） |
| GET | `/api/models` | ✓ | 模型 + **真实计费倍率**（如 `0.2x`） |
| GET | `/api/usage` | ✓ | 本机 token 统计 + 真实本月用量/额度（全局视图仅管理会话） |
| GET | `/api/usage/buckets` | ✓ | 用量账本：按小时/天、账号、模型、凭据分桶的历史（只读，权限同仪表盘） |
| GET | `/api/keys` | ✓ | 各 Key 的请求数与 token 消耗（管理鉴权，见 ADR-0012） |
| GET | `/api/balance` | ✓ | 读本地余额/单价与真实用量（旧接口，保留给脚本） |
| POST | `/api/balance` | ✓ | 设置本地估算单价 / 重置统计（旧接口，页面不再调用） |
| GET | `/api/settings` | ✓ | 运行时配置（11 项，三组，见 ADR-0013 与 [configuration.md](configuration.md#运行时设置)） |
| PUT | `/api/settings` | ✓ | 写运行时配置；未知键回报 `ignored`，全是未知键则 400 |
| POST | `/api/local-stats/reset` | ✓ | 只重置本机统计，返回 `{ ok, usage }`；不清用量账本 |
| GET | `/api/dashboard` | ✓ | 部署级只读仪表盘：账号池 / 积分 / 模型 / 本机统计（ADR-0009） |
| GET | `/api/logs` | ✓ | 最近请求日志（内存环形缓冲 200 条，只收 `/v1/*`）；支持筛选参数，响应带归档状态 |
| GET | `/api/fallback` | ✓ | 读回落模型：`{current, source, options}` |
| POST | `/api/fallback` | ✓ | 设回落模型 `{model}`，空字符串=自动；未知模型 400 + 可用列表 |
| GET | `/healthz` | ✗ | 纯文本 `ok`，给探活用 |
| GET | `/status` | ✗ | JSON：运行时长、守护进程状态、登录状态 |
| GET | `/` | ✗ | 网页控制台（`PUBLIC_UI=0` 可关闭） |

`/api/dashboard`、`/api/models`、`/api/usage`、`/api/balance` 支持加 `?force=1` 跳过 60 秒缓存，强制刷新上游真实数据；`/api/logs` 与 `/api/usage/buckets` 读的是本地数据，没有缓存参数。

## 模型名怎么填

填 `/v1/models` 里的 id（如 `deepseek-flash`、`qwen3.8-max`）会真正路由到那个模型；填 `automodel` 走自动路由；带 vendor 前缀（如 `qwen/qwen3.8-max`）也能识别。

三套协议统一执行**严格的显式模型匹配**（ADR-0003）：模型名既不是账号支持的真实模型、也没在 `model_aliases` 里定义，就返回 404。`/v1/chat/completions` 的错误体带 `available` 数组，另两套在 `message` 里指向 `GET /v1/models`。网关绝不静默替换。

这意味着 Claude Code 固定发的 `claude-sonnet-4-5`、Codex 固定发的 `gpt-6.1-sol` 都会 404，除非配好别名。早期版本曾把认不出的 `claude-*` 回落到 `ANTHROPIC_FALLBACK_MODEL`，ADR-0003 已废除该行为；现在这个变量只被 `/api/fallback` 与仪表盘展示读取，不参与请求解析，默认值是 `deepseek-flash` 或模型表首项，不是 `automodel`。

客户端固定携带专有模型名时（Codex 的 `gpt-6.1-sol`、Claude Code 的 `claude-sonnet-4-5`），在控制台「账号池」TAB 的模型别名区或 `accounts.json` 里配置：

```json
"model_aliases": {
  "gpt-6.1-sol": "qwen3.8-max",
  "claude-sonnet-4-5": "deepseek-flash"
}
```

别名请求会精准转发到目标真实模型，上下文与 token 计算规则不变。

## 会话是怎么区分的

每个请求都是独立的 HTTP 请求，网关要判断「这是同一个对话的第几轮」，按可靠性从高到低找三个信号：

| 优先级 | 信号 | 说明 |
|---|---|---|
| 1 | 请求头 `x-session-id` / `x-conversation-id` / `x-chat-id` | 最准确，客户端愿意传就传 |
| 2 | 请求体里的 `session_id` / `conversation_id` / `chat_id` | 部分 harness 会带 |
| 3 | **提示指纹** | system（前 4096 字）+ 第一条 user 消息 的 sha1 |

第 3 条之所以成立，是因为多轮对话的 `messages` 是**前缀增长**的：

```
[sys, u1]
[sys, u1, a1, u2]
[sys, u1, a1, u2, a2, u3]
```

第一条 user 消息 `u1` 始终不变，所以三次请求算出同一个指纹；换个话题新开会话，指纹就变了。

控制台「最近会话」里带 `✱` 的就是指纹推断的，没带的是客户端显式给的 id。

已知误判：两个不同的调用方问了一模一样的首句，且 system 也相同，会被并成一个会话。要精确区分就让客户端带上 `x-session-id`：

```bash
curl ... -H "x-session-id: chat-20261028-001"
```

最多保留 `MAX_SESSIONS`（默认 50）个会话，按最后活动时间淘汰，存在 `usage-state.json` 里。

## 前缀缓存

缓存是**上游做的**，网关不缓存任何东西，只是把命中量记下来。响应里可能出现两种字段：

- `usage.prompt_tokens_details.cached_tokens`（qwen 系）
- `usage.prompt_cache_hit_tokens`（deepseek 系）

两个都会计入控制台的「缓存命中」。实测规律：

- **需要预热**：同一前缀第 1 次几乎必然 0，第 2 次起才可能命中
- **前缀太短不命中**：1000 tokens 以下基本没有缓存，因为按块计
- **命中不稳定**：同一前缀连续请求，可能第 2~4 次命中、第 5 次又归零。推测是上游多节点、缓存不共享，请求落到哪个节点看运气
- **前缀改一个字**：改在末尾时，前面的完整块仍会命中

所以别把缓存当成确定的省钱手段。真正决定成本的是**前缀本身有多大、多稳定**——调用方的 system prompt 里塞了时间戳或每轮变化的状态，缓存永远不会命中。

## 图片输入

支持两种写法：

| 写法 | 说明 |
|---|---|
| `data:image/png;base64,...` | 网关解码后交给上游，适合小图（受 `MAX_BODY_MB` 限制） |
| `https://.../a.png` | **推荐**。网关先下载（10MB / 20 秒超时，跟 3 次跳转），再交给模型 |

```json
{"messages": [{"role": "user", "content": [
  {"type": "text", "text": "这张图里有哪些字段？"},
  {"type": "image_url", "image_url": {"url": "https://example.com/shot.png"}}
]}]}
```

要点：

- 单次最多 `MAX_IMAGES`（默认 8）张
- 本地绝对路径一律拒绝，返回 400 `image_local_path_forbidden`，不再支持传同机文件
- 图片拿不到时返回 **400 `image_fetch_failed`** 并附原因，**不会**静默变成纯文本回答
- 内网地址（127.x / 10.x / 192.168.x / 172.16-31.x / localhost）会被拒绝，防止被拿来探测内网
- 平台侧的「图片输入」开关要**打开**；模型本身也要支持视觉（`/api/models` 的 `input` 字段含 `image`）

## 工具调用（function calling）

`direct` 模式把 `tools` 原样透传给上游，用模型原生 function calling；`agent` 模式则把 `tools` 转成 CLI 能理解的文本协议，再从输出里解析出 `tool_calls`。调用方按 OpenAI 标准写法用就行：

```python
tools = [{
    "type": "function",
    "function": {
        "name": "get_user_profile",
        "description": "查询内部用户资料，返回会员等级和注册时间",
        "parameters": {"type": "object", "properties": {"user_id": {"type": "string"}}, "required": ["user_id"]},
    },
}]
# 第一轮：模型返回 tool_calls
# 你执行完，把结果作为 role="tool" 的消息追加进去，再请求一次
```

实测返回：

```json
{"finish_reason": "tool_calls",
 "message": {"role": "assistant", "content": null,
   "tool_calls": [{"id": "call_shxvzquz", "type": "function",
     "function": {"name": "get_user_profile", "arguments": "{\"user_id\":\"U-8842\"}"}}]}}
```

要点：

- 支持 `tool_choice`: `auto`（默认）/`required`/`none`/指定某个函数（工具被消费时的降级见 [troubleshooting.md](troubleshooting.md#已知限制)）
- 支持**多轮闭环**：把 `role:"tool"` 的结果回传，模型会接着把话说完
- 支持一次返回**多个** `tool_calls`，各自 `index` / `id` 正确
- 流式模式下，带 `tools` 的请求会先缓冲再一次性下发 `tool_calls`（否则文本已经吐出去才发现是工具调用，客户端会解析错乱）——这是刻意的取舍
- 老式 `function_call` 字段会自动转成 `tool_calls`
- `content` 数组形式（`[{"type":"text",...}]`）、`stream_options.include_usage` 都透传
- 每帧 `content` 都是字符串、`object` 一律 `chat.completion.chunk`、chunk `id` 全程一致、结尾必有 `[DONE]`

这些形状都有回归测试钉住：

```bash
python3 tests/conformance-test.py
# 或指定远端
BASE_URL=https://你的域名 KEY=sk-xxx MODEL=qwen3.8-max python3 tests/conformance-test.py
```

这套检查覆盖 `chat.completions` / `responses` / `messages` 三套协议，项数由脚本按当次响应动态统计，不是固定值；退出码非 0 就是有退化。换 harness、升级上游后建议跑一遍。

## 思考强度档位（REASONING）

思考强度参数默认生效：三种客户端方言（`reasoning_effort`、`reasoning.effort`、`thinking.budget_tokens`）先归一成内部六档（off/minimal/low/medium/high/xhigh），再翻成上游方言（`low`/`high`/`max` 加 `thinking` 开关）：

| 客户端给的 | 上游收到的 |
|---|---|
| `none` / `off` / `disabled` | `thinking:{type:"disabled"}`（不带 effort） |
| `minimal` / `low` | `reasoning_effort:"low"` |
| `medium` / `high` | `reasoning_effort:"high"` |
| `xhigh` / `max` / `ultra` | `reasoning_effort:"max"` |
| `budget_tokens` 数值 | 就近分桶（≤1536→minimal、≤5120→low、≤12288→medium、≤24576→high、更大→xhigh） |

不认识的档位词原样透传；上游 400 拒绝思考参数时网关摘掉参数重试一次并按模型记住。智能体模式下客户端显式档位覆盖 `THINKING_LEVEL`（xhigh 映射为 CLI 的 `adaptive`）。完整规则与出处见 ADR-0022。

思考**内容**由 `REASONING` 决定：`REASONING=off`（默认）时剥掉响应里的 `reasoning_content` 以获得最佳兼容性；`REASONING=auto` 保留，且 `/v1/messages` 会把它翻成 Anthropic `thinking` 块（Claude Code 能看到思考过程）。带工具的多轮对话建议用 `auto`——off 时被剥掉的思考内容无法回传，思考模式下游会 400。

## `GET /api/usage/buckets` 参数

权限与 `/api/dashboard`、`/api/logs` 相同：管理会话或有效调用凭据均可读（ADR-0009、ADR-0017）。

| 参数 | 说明 |
|---|---|
| `hours` | 滚动窗口，默认 24，上限 1440（60 天）；超出按 1440 钳制并在响应里给 `clamped: true` |
| `from` / `to` | 显式闭区间，必须同时提供；`YYYY-MM-DD` 按整天，其他按标准时间解析 |
| `granularity` | `hour` 或 `day`；滚动窗口默认 `hour`，显式区间跨度超过 72 小时默认 `day` |
| `account` | 可选，按**账号 id** 精确过滤，可与 `hours` / `from`+`to` 组合 |

响应含 `totals`、`by_account`、`by_model`、`by_key`、`series`。几个容易读错的地方：

- 均值一律「累计 ÷ 样本数」，没有样本时为 `null`
- `credits`（估算消耗）是例外：按本机倍率折算的**累计和**、不是均值，只累加拿到 usage 的样本，没有这类样本时是 `0` 而不是 `null`（窗口里连一次尝试都没有时页面显示「—」）
- 按模型聚合时，同一模型的多个倍率合并成一行，`rates` 列出出现过的倍率
- `series` 每个点带 `scope`：`hour` 是单个小时桶，`day` 是整日汇总（按天粒度时每个点，以及按小时看时由已折叠日桶产生、落在该日 `00:00` 的点）

另有 `ledger: { buckets, max_buckets, dropped }`：账本自身的现状。桶数触顶时会先按「更早的小时」逐级折叠（30 天前 → 7 天前 → 1 天前），腾不出空间才拒收；`dropped` 是**因上限被拒收的尝试条数**，大于 0 说明账本少记了一段。

**两套口径**：账本按**尝试**计（失败也占一次请求、没有 usage 的尝试 token 记 0），仪表盘（`/api/usage` 的 `requests` / `tokens`）按**成功**计（真的拿到 usage 才 +1，智能体失败且无 usage 时不加）。同一次失败会表现为「账本请求数 +1、失败率上升，仪表盘请求数不动」，这是刻意的，见 ADR-0017 §8。

**保留与粒度**：小时桶保留最近 90 个自然日（今天 + 前 89 天，按整天折），更早的折叠成日桶并永久保留，不是丢数据。

按小时粒度看跨过 90 天的区间时，已折叠的历史会以 `scope=day` 的点出现在该日 `00:00` 槽位（`YYYY-MM-DDT00`）。那一点是**整天的合计**，不是某一小时的尖峰，别照着它判断「那一个小时很忙」；想看真实的日分布请切到「按天」。合计（`totals` 与三张分组表）始终包含日桶，趋势合计与 KPI 一致。

## `GET /api/logs` 参数

| 参数 | 说明 |
|---|---|
| `account` | 账号名或短名，包含匹配（不区分大小写） |
| `model` | 模型名，包含匹配（不区分大小写） |
| `outcome` | `success` / `upstream_error` / `stream_error` / `client_error` / `client_abort` |
| `status` | 100–599 的 HTTP 状态码，精确匹配 |
| `q` | 关键字，匹配路径 / 模型 / 错误文本 |
| `from` / `to` | unix 秒或 ISO 8601；按 unix 秒给出的 `to` 覆盖整秒 |
| `limit` | 返回条数，默认 50，上限为内存缓冲容量（200） |

`outcome` 的判定：请求结束是 `status >= 400` 且**这次从未选中账号** → `client_error`（页面「请求被拒」：未带凭据、凭据无效、限流、参数不合法等，错在调用方）；选中过账号后失败才是 `upstream_error`；流中途断开是 `stream_error`，客户端主动断开是 `client_abort`。

响应：`entries`（本次返回）、`matched`（过滤后命中总数，不受 `limit` 影响）、`total` / `capacity`（内存缓冲现状）、`archive`（归档状态：`enabled`、`files`、`bytes`、`oldest_day`、`writable`、`error`、`queued`、`dropped`）。`dropped` 是归档少记的条数（入队被拒或写失败重试仍放不下），大于 0 时日志页的归档状态会标红。归档关闭时 `archive.enabled=false`，内存记录照常返回。
