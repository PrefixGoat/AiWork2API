# 接 Claude Code / CC Switch（`/v1/messages`）

Claude Code 走 Anthropic 的 Messages 协议，端点是 `{ANTHROPIC_BASE_URL}/v1/messages`。网关内建了这一层翻译（`src/messages-adapter.js`），和 Codex 那套共用一条链路，工具调用、多轮闭环、用量统计的行为一致。

## 配置

`~/.claude/settings.json` 最小写法：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8080",
    "ANTHROPIC_AUTH_TOKEN": "sk-你的key",
    "ANTHROPIC_MODEL": "deepseek-flash"
  }
}
```

两个容易踩的点：

- **`ANTHROPIC_BASE_URL` 不带 `/v1`**，Claude Code 自己会拼 `/v1/messages`。带了就变成 `/v1/v1/messages`。
- **鉴权头是 `x-api-key`**，不是 `Authorization: Bearer`。网关两个都认，但别的中转不一定。

## 模型名

填 `/v1/models` 里的真实 ID（`deepseek-flash` / `qwen3.8-max`），或填 `automodel` 走自动路由。

**别直接填 `claude-*`**：三套协议都不认没见过的模型名，未知模型一律 404，不会静默回落。而 Claude Code 会固定发 `claude-sonnet-4-5` 这类名字，得先处理一下：

- 最省事：在 `~/.claude/settings.json` 的 `ANTHROPIC_MODEL` 里直接写网关的真实模型 ID
- 想保留 `claude-*` 名字：在控制台「账号池」TAB 或 `accounts.json` 里配 `model_aliases`，把它映射到真实模型

早期版本曾把认不出的 `claude-*` 回落到 `ANTHROPIC_FALLBACK_MODEL`，这条已被 ADR-0003 废除；现在该变量只用于 `/api/fallback` 与仪表盘展示，不参与请求解析。模型匹配的完整规则见 [api-reference.md](../api-reference.md#模型名怎么填)。

模型名不是 Claude Code 认识的 `claude-*` 时，它可能警告「无法识别该模型，按 200k 上下文处理」，想消掉警告就设 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`。

## 用 CC Switch 管

Claude 页面只有两项：

| 字段 | 填什么 |
|---|---|
| API Key / Token | 网关的 key |
| API 请求地址（`ANTHROPIC_BASE_URL`） | `http://127.0.0.1:8080`（**不带 `/v1`**） |

> CC Switch 的 Codex 页面则是 `http://127.0.0.1:8080/v1`（**要带 `/v1`**），两边不一样，别填反。

## 实测通过的链路

```
claude -p "用 Read 工具读取 probe.txt，把内容原样告诉我"
  → 模型返回 tool_use: Read({"file_path":"..."})
  → Claude Code 读文件 → 回传 tool_result
  → 模型复述内容 → 输出 tool-loop-verified-2026
```

## 能力边界

| 项目 | 情况 |
|---|---|
| `text` / `image` / `tool_use` / `tool_result` 内容块 | ✅ 完整双向翻译 |
| 流式 `message_start → content_block_delta → message_delta → message_stop` | ✅ 顺序与 Anthropic 一致 |
| `input_json_delta`（工具参数流式） | ✅ |
| `/v1/messages/count_tokens` | ✅ 字符估算（上游没这个端点）。按 ASCII 3.5 字符/token、中文 1 字符/token **故意高估**，低估会让客户端以为还有余量，直到真超限才报错 |
| `system` 数组、`stop_sequences`、`tool_choice`（`auto`/`any`/`tool`/`none`） | ✅（已知限制：`tools` 全空时 `tool_choice` 与 `parallel_tool_calls` 均不下发；仅目标工具被消费时只丢 `tool_choice` 并写日志，见 [troubleshooting.md](../troubleshooting.md#已知限制)） |
| `thinking.budget_tokens` | ✅ 按数值就近归一到内部档位再透传（ADR-0022；映射表见 [api-reference.md](../api-reference.md#思考强度档位reasoning)） |
| Anthropic 服务端工具（`web_search_20250305` 等） | ❌ 本地返回 400 `unsupported_tool_type`。网关没有对应执行能力，不静默丢弃 |

表中未列出的 tool search 一族（工具条目与历史检索块）按**消费**处理，以工具前置加载等价替代、有日志留痕，不落 400；完整说明见 [ADR-0021](../adr/INDEX.md#adr-0021) 与 [troubleshooting.md 的「已知限制」](../troubleshooting.md#已知限制)。

## 一个必须知道的坑：`automodel` 不能用于多轮工具调用

实测结果：

| 模型 | 多轮工具闭环 |
|---|---|
| `deepseek-flash` | ✅ |
| `qwen3.8-max` | ✅ |
| `automodel` | ❌ 上游 409 `provider_state_unavailable` |

原因是自动路由每次可能把请求分到不同后端，而工具调用闭环需要**同一个后端持有会话状态**。网关不会替你偷偷换模型：上游返回 409 时，错误会被翻成「请把模型从 automodel 换成具体模型」的提示，客户端照着改一次就行。

同样的限制也适用于 Codex。回落模型本身默认不用 `automodel`（`resolveFallbackModel()` 返回 `deepseek-flash` 或模型表首项）。
