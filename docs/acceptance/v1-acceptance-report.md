# AiWork Gateway 首版交付验收与测试结单报告 (v1.0.0)

- **交付版本**：v1.0.0
- **签署日期**：2026-11-10
- **验收依据**：首版个人自托管多账号网关规格、支持矩阵与验收清单，以及验收时点适用的 ADR（ADR-0001 至 ADR-0018）与术语表。
- **验收原则**：遵循验收时点适用的 ADR 与术语表。**严格区分“离线模拟回归测试结果”与“获授权环境真实烟测结果”**。无个人凭据通过的模拟测试不伪称为真实环境测试；未在获授权真实环境中执行的项目一律客观标注为“待部署者现场验证”。

---

## 验收结论摘要 (Executive Summary)

AiWork Gateway（AiWork2API）首版研发工作已全部完成并闭环验收通过：
1. **任务闭环率 100%**：首版拆解的全部 9 个实施任务（Issue #01 至 #09）全部 resolved 并完成验收；
2. **测试回归率 100%**：验收时点全量 19 套端到端协议与架构测试套件全部通过（`npm test` 19.7s，100% Green；当前 62 套）；
3. **语法预检零缺陷**：原生语法预检（`npm run check`）覆盖全部 35 个 JS 文件（src+tests+scripts；验收时点，当前 82 个），耗时 1.4s，零语法错误；
4. **代码审查闭环**：经多轮 `/code-review` 双轴审查与整改（Spec 与 Standards 的发现均已修复并记录），并确立 42 行刚性 `CODING_STANDARDS.md`；
5. **容器黑盒验证就绪**：完成轻量 Bridge-Only Docker 镜像构建（86.1MB，无 Python、无官方 CLI），容器启动内置探针达到 `(healthy)`，宿主机安全回环（127.0.0.1）、未就绪响应、鉴权拦截与管理员会话全流程实测通过。

---

## 一、离线模拟上游回归测试矩阵 (无需真实账号与网络)

以下测试均在受控端到端沙箱中执行，使用合成账号资料（Mock CLI 状态目录）和模拟上游服务（`MockUpstream`），**100% 不需要真实个人上游账号、网络访问或个人机密**，任意开源贡献者均可独立重复执行。

| 测试套件 | 验证能力与工单对应 | 验证方法与执行命令 | 自动化结果 |
|---|---|---|:---:|
| **Suite 01** (`test-cli-multi-dir.js`) | 多官方 CLI 状态目录独立解析、只读保护（`:ro`）、热重载与多账号凭据隔离 (Issue #02) | `node tests/test-cli-multi-dir.js` | **通过 (100%)** |
| **Suite 02** (`test-gateway-boundary.js`) | 真实直连边界、无官方 CLI 干净启动、直连与智能体模式严格物理隔离、禁止跨模式回落 (Issue #01) | `node tests/test-gateway-boundary.js` | **通过 (100%)** |
| **Suite 03** (`test-credentials-management.js`) | 管理口令与调用凭据分离、无默认密码、带期限防爆破 Session、HTML 零秘密注入、账号集合授权范围与即时吊销 (Issue #03) | `node tests/test-credentials-management.js` | **通过 (100%)** |
| **Suite 04** (`test-account-pool-and-aliases.js`) | 多账号池管理、只读状态加载、故障标记与恢复、显式模型别名映射（精确匹配/未知模型显式 404）(Issue #04) | `node tests/test-account-pool-and-aliases.js` | **通过 (100%)** |
| **Suite 05** (`test-session-routing-and-isolation.js`) | 新会话轮询调度、已有会话粘性绑定、调用凭据会话与历史物理隔离、跨 Key 防串话与权限重新校验 (Issue #05) | `node tests/test-session-routing-and-isolation.js` | **通过 (100%)** |
| **Suite 06** (`test-bounded-failover-and-cooldown.js`) | 内容交付边界前安全换号、已交付内容（文本/思考/工具）禁止换号、429/401 细分冷却与受控虚拟时钟 (Issue #06) | `node tests/test-bounded-failover-and-cooldown.js` | **通过 (100%)** |
| **Suite 07** (`test-lifecycle-bounded-resources.js`) | 三套协议（Chat/Responses/Messages）及 WebSocket 常用能力、有界并发/队列/请求体、客户端断连取消与资源回收、SSRF 与本地文件路径拦截 (Issue #07) | `node tests/test-lifecycle-bounded-resources.js` | **通过 (100%)** |
| **Suite 08** (`test-continuation-and-privacy.js`) | 服务端内存响应历史续接（LRU/TTL）、流式与非流式语义一致、无正文持久化（零 Prompt/摘要落盘）、日志脱敏、有界调试抓包自动清理 (Issue #08) | `node tests/test-continuation-and-privacy.js` | **通过 (100%)** |
| **Suite 09** (`test-bridge-image-and-docs.js`) | 仅桥接层容器打包（无官方 CLI/种子/凭据）、默认回环监听（127.0.0.1）、实验智能体子进程有界 stderr 与取消清理、发布资料与文档一致性 (Issue #09) | `node tests/test-bridge-image-and-docs.js` | **通过 (100%)** |

**一键回归汇总**：
- 语法预检：`npm run check` -> **35/35 文件全部通过 (1.4s)**（验收时点；当前 82/82）
- 全量套件：`npm test` -> **19/19 套件全部通过 (19.7s, 0 失败, 100% Green)**（验收时点；当前 62/62）

---

## 二、双轴代码审查与规范合规性审计

依据双轴代码审查（Spec / Standards），对当前交付 HEAD 分支进行了严格复验：

1. **Spec 轴（功能规格与边界行为）**：
   - 审查结果：发现均已修复并记录（终态无未决项）。
   - 复核覆盖：WebSocket 连接生命周期与取消控制完整性、流中换号竞态写穿与旧流彻底抛弃截断（`abandonCurrentAttempt`）、跨协议迁移保护标记（`opaque_account_state` / `reconstructible`）保留、未知输入条目（`item_reference`）HTTP 400 明确拒绝。
   - 规格边界核查：**无未经授权的额外接口**（验收时点；其后复审发现的偏差均已修复并记录）。
2. **Standards 轴（架构与代码规范）**：
   - 审查结果：发现均已修复并记录（终态无未决项）。
   - 遵循标准：全面符合验收时点适用的 ADR（ADR-0001 至 ADR-0018）、GLOSSARY 统一术语及 Fowler 深度模块重构原则。
   - 代码治理落地：
     - 抽离 `_syncReloadedAccounts` 消除重复重载与冷却误解冻；
     - 抽象 `parseAccountPolicy` 消除账号策略解析漂移；
     - 抽象 `extractMigrationFlags` 收敛跨适配器字段提取；
     - 抽象 `abortAll` 收敛 WebSocket 连接 teardown；
     - 收敛 `reloadIfChanged` 为统一数组返回类型，消除基本类型偏执。
   - 建立根目录 `CODING_STANDARDS.md`（私有仓文档） 刚性准则（42 行）。

---

## 三、Docker 桥接层容器黑盒验证记录

遵循 ADR-0001 与 ADR-0005，在本地环境针对正式交付镜像与 Compose 编排进行了完整的黑盒验证：

1. **镜像构建与纯净度**：
   - 产出镜像：`aiwork-gateway:latest`（86.1MB 压缩体积）；
   - 构建耗时：~40 秒；
   - 纯净度检查：执行 `docker run --rm --entrypoint sh aiwork-gateway:latest -c "which python python3 aiworkcn dtcoder agentix"` 确认**零 Python、零官方 CLI、零预置账号凭据与种子**。
2. **安全边界防公网裸奔**：
   - 实测在 `BIND=0.0.0.0` 且未提供 `API_KEYS` 启动时，网关主动中止并输出 `FATAL` 告警，拒绝无鉴权公网监听。
3. **Compose 回环部署与运行状态**：
   - 默认端口绑定：宿主机回环 `127.0.0.1:18080->8080/tcp`；
   - 容器健康检查：内置 `CMD-SHELL curl -fsS http://127.0.0.1:8080/healthz` 运行，容器状态为 `Up (healthy)`。
4. **容器接口黑盒实测**：
   - `GET /healthz`：返回 HTTP 200 `ok`；
   - `GET /status`：返回 HTTP 200，准确标明 `status: "unready"`、`unready_reason: "router_key_missing"` 与官方 CLI 恢复指引；
   - `GET /v1/models`：未带 Key 及无效 Key 均严格返回 HTTP 401；携带合法 Key 成功返回 200 模型列表；
   - `POST /api/admin/login`：口令校验成功，下发 `HttpOnly; SameSite=Lax` 管理 Session Cookie；携带该 Cookie 成功访问 `/api/admin/keys` 与 `/api/admin/accounts`。

---

## 四、获授权环境的真实客户端烟测矩阵与状态声明

> [!IMPORTANT]
> 根据 ADR-0005 验收诚信准则，离线模拟测试结果与真实上游环境测试严格区分。真实上游调用会消耗真实额度并依赖有效官方账号，以下客观记录实测与待现场验证状态：

| 客户端 / 环境 | 承诺支持能力 | 依赖环境要求 | 验证状态 | 验证记录 / 说明 |
|---|---|---|:---:|---|
| **Linux 容器直连实例** | 仅桥接层轻量镜像干净启动，无 CLI 可执行文件与守护进程直接提供服务 | Docker / Linux 容器运行时 | **已实测验证 (100%)** | 验证 bridge-only 镜像构建、容器健康检查与黑盒 HTTP/Admin 接口实测通过。 |
| **Windows 原生 Node 启动** | 本地开发路径兼容性 | Windows 10/11, Node.js 20+ | **已实测验证 (100%)** | 本地全部 19 套自动化回归测试（验收时点）在 Windows Node 22 环境下执行并 100% 通过。 |
| **官方 CLI 状态目录** | 多账号只读挂载接入，凭据热重载与恢复 | 宿主机已安装官方 CLI 并登录有效账号 | **待部署者现场验证（未验证）** | 离线已通过合成状态与 mtime 热重载验证；真实账号需现场执行 `dtcoder login` 或挂载真实目录。 |
| **OpenAI 兼容客户端** | 标准 Chat Completions 常用文本、流式与工具调用 | 支持标准 OpenAI 协议客户端 (如 NextChat/ChatBox) | **待部署者现场验证** | 离线已通过模拟上游协议回归与交付边界拦截验证。 |
| **Codex CLI / Responses** | Responses HTTP 协议常用文本、思考片段、工具闭环及 Responses WebSocket 流式通信 | Codex CLI 最新版本 | **待部署者现场验证** | 离线已通过 Responses 协议转接、RFC 6455 WebSocket 掩码与双向会话测试。 |
| **Claude Code** | Anthropic Messages 协议常用文本、图片输入、流式生成与多轮工具调用闭环 | Claude Code CLI | **待部署者现场验证** | 离线已通过 Messages 格式互转、Token 估算说明与错误映射自检。 |

---

## 五、代码仓库与发布构建上下文安全检查

在发布镜像和提交源码前执行的安全性核验项：

- [x] **无硬编码机密**：代码、示例配置及测试脚本中无任何真实 API Key、官方 Token 或管理密码。
- [x] **构建上下文排他性**：`.dockerignore` 严格排除了 `.git/`、`.scratch/`、`tests/`、`docs/`、`.env` 等本地运行文件，预构建镜像仅打包发布所需的代码与许可证。
- [x] **许可证与声明完整性**：仓库根目录包含完整的 MIT `LICENSE` 及引用组件说明 `THIRD-PARTY-NOTICES.md`。
- [x] **零未签名 JWT 漏洞**：不接收任何第三方未签名令牌，消除了身份冒用后门。
- [x] **零正文隐私持久化**：默认配置下，无论日常运行还是持久化统计文件，绝不将任何对话正文、提示词原文或前 40 字符摘要存入磁盘。
- [x] **敏感凭据日志脱敏**：所有控制台、结构化日志与调试抓包均对 `Bearer` 令牌及 API Keys 强制执行 `sk-***` 掩码。

---

## 六、交付签署 (Sign-off)

- **验收结论**：**准予验收结单（ACCEPTED）**
- **当前 Git 提交基准**：本报告为验收时点（2026-11-10）快照；仓库历史经整理后，当前 main 最新提交见 `git log`（历史基准哈希已失效，不再引用）
- **交付工件**：
  1. 源码：`src/` 核心服务与协议适配层；
  2. 容器：`Dockerfile`（Bridge-Only）与 `docker-compose.yml`（默认回环绑定）；
  3. 自动化测试套件：`tests/` 目录下 19 个回归套件（验收时点；当前 62 套）与模拟上游装置；
  4. 开发者守卫基建：`package.json`（`npm test`、`npm run check`）、`CODING_STANDARDS.md` 与 `AGENTS.md`；
  5. 规范与文档：`README.md`、`PRIVACY.md`、`SECURITY.md`、`COMPLIANCE.md` 及 ADR-0001~0018。
