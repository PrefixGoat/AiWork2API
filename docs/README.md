# 项目文档

两种文档，边界固定：**ADR 记「为什么这么决定」**，其余记「怎么用」。

## 使用文档

安装（CLI 配置、Docker 脚本、裸机 Node）、客户端接入、日常运维与免责声明见[项目 README](../README.md)。

- [接 Codex CLI](clients/codex.md)：`wire_api = "responses"` 的前提、配置、7 个内置工具的映射与能力边界。
- [接 Claude Code / CC Switch](clients/claude-code.md)：Messages 端点、`/v1` 拼法、能力边界。
- [接口与调用语义](api-reference.md)：端点清单、鉴权、模型别名、会话区分、前缀缓存、图片输入、工具调用、思考档位。
- [配置与环境变量](configuration.md)：环境要求、`.env` 全表、监听与端口、运行时设置 11 项、两种上游模式的实测对比、裸机 systemd 部署与 Windows 原生 Node 部署。
- [排障与已知限制](troubleshooting.md)：启动 / 登录 / 流式三类故障、`DEBUG_DUMP` 抓包、限制全表。

协议集成测试位于 `tests/`；启动、登录、发 Key、部署烟测与一键上手位于 `scripts/`（`quickstart.sh` 走 Docker，`start-systemd.sh` 与 `start-windows.ps1` 走裸机；另有 `smoke-test.sh`、`set-port.sh`、`issue-key.sh`）。

## 开源与安全

- [MIT License](../LICENSE)
- [合规与授权说明](../COMPLIANCE.md)
- [数据处理说明](../PRIVACY.md)
- [安全说明与反馈](../SECURITY.md)
- [第三方许可与归属](../THIRD-PARTY-NOTICES.md)

## 调研与验收

- [上游条款核查记录](research/upstream-terms-review.md)
- [上游隐私政策来源摘要](research/upstream-privacy-policy-2026-11-09.md)
- [v1 验收报告](acceptance/v1-acceptance-report.md)

## 架构与术语

- [领域术语](../GLOSSARY.md)：个人自托管、直连模式和智能体模式。

ADR 列表（按编号）：

- 见 [ADR 摘要索引](adr/INDEX.md)：每条一行结论，正文与实测数据在私有仓库中维护。

