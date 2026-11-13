<p align="center">
  <img src="assets/brand/aiwork-icon-512.png" width="104" alt="AiWork2API">
</p>

<h1 align="center">AiWork2API</h1>

<p align="center">
  <b>把 AiWork 账号变成 OpenAI / Anthropic 兼容的 API</b><br>
  三种接入协议 · 多账号池 · 用量账本 · 自带管理控制台
</p>

<p align="center">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white&style=flat-square">
  <img alt="API" src="https://img.shields.io/badge/API-OpenAI%20%2F%20Anthropic-412991?style=flat-square">
  <img alt="Deploy" src="https://img.shields.io/badge/Deploy-Docker%20%2F%20Node-2496ED?logo=docker&logoColor=white&style=flat-square">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-green?style=flat-square">
</p>

<p align="center"><sub>非官方社区项目，与 AiWork／Agentix 及其厂商无隶属、代理或背书关系 · 仅限个人自托管</sub></p>

---

## 一 · 安装

前置条件：宿主机已完成官方 CLI 登录；容器部署需 Docker 20.10+（含 Compose 插件），裸机部署需 Node 20+。完整环境要求见 [docs/configuration.md](docs/configuration.md#环境要求)。

### AiWork CLI 配置（已登录可跳过）

宿主机已完成官方 CLI 登录时可直接跳过本节。

```bash
# Linux / macOS
curl -fsSL https://aiwork-dl.dtagi.cn/releases/install-aiwork.sh | bash -s -- --yes --skip-tui

# Windows（PowerShell）
irm https://aiwork-dl.dtagi.cn/releases/install-aiwork.ps1 | iex
```

```bash
aiworkcn login                            # 按提示在浏览器完成授权
aiworkcn auth status --json               # 确认已登录
```

登录凭据默认保存在 Linux / macOS 的 `~/.local/share/agentix` 或 Windows 的 `~/.agentix`，部署脚本会自动探测上述目录。

### 用 Docker 脚本

Linux / macOS：

```bash
git clone https://github.com/PrefixGoat/AiWork2API.git && cd AiWork2API
bash scripts/quickstart.sh
```

Windows（PowerShell 5.1 不支持 `&&`，分两行执行）：

```powershell
git clone https://github.com/PrefixGoat/AiWork2API.git
cd AiWork2API
powershell -ExecutionPolicy Bypass -File scripts\quickstart.ps1
```

脚本会生成 `.env` 并替换默认占位密钥，按探测到的登录态目录配置只读挂载，构建并启动容器，探活通过后输出控制台地址、Base URL 与生成的 API Key。

<details>
<summary><b>不用脚本：手工三步</b></summary>

**① 准备配置**

```bash
cp .env.example .env
```

模板默认值可用于本机验证：`AGENTIX_HOST_STATE_DIR` 留空时默认挂载 `~/.local/share/agentix`，`API_KEYS` 含有一个公开的占位 key。对外提供服务前请替换为随机密钥（`openssl rand -hex 24`）。

**② 启动服务**

```bash
docker compose up -d --build
```

Windows 环境或凭据不在默认路径时，需先在 `.env` 中填写 `AGENTIX_HOST_STATE_DIR`，使用正斜杠，例如 `C:/Users/你的用户名/.agentix`。

**③ 验证**

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-change-me-please" \
  -H "Content-Type: application/json" \
  -d '{"model":"automodel","messages":[{"role":"user","content":"你好"}]}'
```

收到模型回复即验证通过。浏览器访问 `http://127.0.0.1:8080/` 可进入管理控制台。

</details>

### 不用 Docker

**Linux（systemd）**

```bash
bash scripts/start-systemd.sh
```

默认安装至 `~/.local/share/aiwork-gateway`，无需 root 权限。脚本会校验 Node 20+ 与官方 CLI 登录态，可通过 `--prefix /opt/aiwork-gateway` 指定安装位置，其余参数见 `--help`。

**Windows（原生 Node）**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1
```

需要 Node 20+，无需 Docker、systemd 或管理员权限。脚本在仓库目录下生成 `.env.windows` 和 `data-windows\`（均已被 git 忽略），将模板中的容器路径转换为本机路径，生成随机调用密钥并在后台启动 `node src/api-bridge.js`，探活通过后输出控制台地址与 API Key。停止服务执行输出提示中的 `Stop-Process -Id <PID>`；端口占用可加 `-Port 18081`，查看实时日志可加 `-Foreground`（按 Ctrl+C 停止），使用控制台设备授权添加账号可加 `-SkipLoginCheck`。

参数说明与手工部署步骤见 [docs/configuration.md](docs/configuration.md#裸机部署systemd)，Windows 配置说明见[该文档对应章节](docs/configuration.md#windows-原生-node)。

---

## 二 · 使用

### 实现功能

```
客户端（OpenAI SDK / Codex / Claude Code / Cline …）
        │  HTTP / WebSocket + Bearer Token
        ▼
   api-bridge.js   鉴权 · 账号池调度 · 协议翻译 · 用量账本 · 访问日志
        │
        ├── 管理控制台：对话 / 账号池 / 用量 / 模型 / 设置 / 日志
        ├── 官方 CLI 登录态：宿主机目录只读挂载（:ro）
        ▼
   AiWork Router  →  各家真实模型
```

- 三种协议共用同一条调度链路：Chat Completions 原生支持，Responses（Codex）与 Messages（Claude Code）分别通过适配层转换
- 新会话由**账号池**轮询分配可用账号，已有会话沿用已绑定的账号；网关支持在响应内容输出前自动换号重试，重试次数受上限控制（ADR-0004）
- **用量账本**按小时或天汇总，支持按账号、模型和调用凭据分组统计；日常管理可在控制台的六个标签页内完成
- 服务端口**默认仅向本机开放**：Docker 部署时容器内监听 `0.0.0.0`、宿主机端口绑定 `127.0.0.1`；裸机部署时进程默认监听 `127.0.0.1`，防止服务意外暴露至公网

默认采用 `UPSTREAM=direct` 直连上游；`agent` 为需显式开启的实验模式，两者的开销差异与安全边界见 [docs/configuration.md](docs/configuration.md#两种上游模式)。

### 接客户端

网关遵循标准 OpenAI / Anthropic 协议，不针对特定客户端做专门适配：

| 客户端 | 走哪条 | 详细说明 |
|---|---|---|
| Cline / Roo / Kilo / Continue / Cursor | Chat Completions | 填 Base URL + Key，无需额外配置 |
| OpenWebUI / LibreChat / LobeChat / Dify / FastGPT / n8n | Chat Completions | 勾上「函数调用 / 工具」开关 |
| OpenAI 官方 SDK（Python / Node） | Chat Completions | 改一个 `base_url` |
| **Codex CLI** | `/v1/responses` | [docs/clients/codex.md](docs/clients/codex.md) |
| **Claude Code / CC Switch** | `/v1/messages` | [docs/clients/claude-code.md](docs/clients/claude-code.md) |

基础接入参数：

- **Base URL**：`http://127.0.0.1:8080/v1`（Claude Code 填 `http://127.0.0.1:8080`，**不带 `/v1`**）
- **API Key**：`.env` 里的 `API_KEYS`

控制台内每份调用凭据均可直接复制接入配置（JSON / ENV / curl），地址按当前控制台地址自动填充。`model` 填写 `/v1/models` 中的模型 ID 即可调用对应模型，填写 `automodel` 则走自动路由。三套协议对未识别的模型名均直接返回 404，不做静默替换；`claude-*` / `gpt-6.1-sol` 等客户端专有模型名需替换为真实模型 ID，或在 `model_aliases` 中配置别名映射。

### 管理控制台

访问 `http://127.0.0.1:8080/`，左侧包含**对话 / 账号池 / 用量 / 模型 / 设置 / 日志**六个标签页。

未设置 `ADMIN_PASSWORD` 时，持有有效调用凭据即可执行管理操作（ADR-0012）。设置口令后，管理操作需额外通过口令校验，无法仅凭调用凭据替代。控制台支持签发和吊销 API Key、限制单 Key 可访问的账号范围、通过 `model_aliases` 配置模型别名，以及查看全局用量和账号积分。

不同调用 Key 的会话与历史记录相互隔离，相同 Session ID 亦不会跨 Key 互通。

---

## 三 · 运维

### 对外部署：域名与 HTTPS

**有域名**：解析 A 记录 → 放行 80/443 → 修改 `.env` 三项配置 → 启动 TLS 服务栈。

```diff
- PUBLISH_ADDR=0.0.0.0
+ PUBLISH_ADDR=127.0.0.1     # 只让 Caddy 访问，不直接暴露 8080
- TRUST_PROXY=0
+ TRUST_PROXY=1              # 记录真实客户端 IP
- DOMAIN=
+ DOMAIN=aiwork.你的域名.com
```

```bash
docker compose --profile tls up -d --build   # Caddy 自动申请并续期证书，约 10~30 秒
```

**无自有域名**，可按公网证书、端口直连或内网接入选择方案：

| 路线 | 做法 | 代价 |
|---|---|---|
| 免费通配域名（推荐） | `DOMAIN=1-2-3-4.sslip.io`，`nip.io` 同理 | 需要公网 IP + 80/443 可达 |
| IP + 非标端口 | `HOST_PORT=18080` + `ALLOW_IPS=你的出口IP` | **明文 HTTP**，白名单不是可选项 |
| 不暴露公网 | 内网地址 / Tailscale / `cloudflared tunnel` | 调用方要能进同一网络 |

> **中国大陆服务器注意**：未备案域名解析至大陆机房的 80/443 端口通常会被拦截，`sslip.io` 同样受此限制。请改用非标端口，或使用已完成备案的域名。
> **自签证书**（`DOMAIN` 填写 IP）不建议用于外部调用方：多数第三方平台拒绝连接，客户端 SDK 亦需手动关闭证书校验。

<details>
<summary><b>安全要点</b>（对外部署前检查项，6 条）</summary>

1. **未配置密钥禁止非回环监听**：进程监听非回环地址且未配置任何调用密钥时拒绝启动。容器内 `BIND` 固定为 `0.0.0.0`，未配置密钥无法启动；确需在内网无鉴权运行时，须显式设置 `ALLOW_OPEN_BIND=1`。宿主机端口发布范围另由 `PUBLISH_ADDR` 控制
2. **登录态只读挂载**（`:ro`）：容器不会修改或覆盖宿主机上的官方凭据目录
3. **管理权限加固**：公网部署请设置 `ADMIN_PASSWORD`。未设置时，任何有效 API Key 均具备管理权限
4. **默认不持久化请求正文**：仅保存累计计数与用量账本，请求归档仅记录元数据。仅在排障并显式开启 `DEBUG_DUMP=1` 时，才将请求入参与上游原始流写入数据卷（受容量与保留时长限制），排障完成后请及时关闭
5. **禁止跨模式回落**：直连模式请求失败时直接返回错误，不会自动切换至具备本地命令执行能力的模式
6. **启用 HTTPS 与请求限流**：按上文配置 TLS 证书，并通过 `RATE_LIMIT_PER_MIN` 限制单 API Key 的每分钟请求频率，防止异常循环请求耗尽额度

</details>

### 日常运维与备份

```bash
docker compose logs -f aiwork                  # 实时日志
docker compose logs aiwork | grep '\[access\]' # 只看访问日志（一行一条 JSON）
curl http://127.0.0.1:8080/status              # 守护进程 / 登录状态 / 模型数
docker compose restart aiwork                  # 重启
docker compose up -d                           # 改了 .env 后（restart 不会重读 env_file）
docker compose build --no-cache --pull && docker compose up -d   # 升级
```

**备份**：运行时配置、用量账本、账号配置与已持久化的刷新令牌均存放在数据卷内，迁移时整卷复制即可。`docker compose down` 不会删除数据卷；`down -v` 会一并删除数据卷，届时账号需重新授权或导入。宿主机的 CLI 登录态采用绑定挂载，不在数据卷内。

---

## 四 · 参考与声明

### 已知限制

常见限制如下，完整清单见 [docs/troubleshooting.md](docs/troubleshooting.md#已知限制)：

- **`automodel` 不能用于多轮工具调用**：上游会返回 409 `provider_state_unavailable`，网关会将该错误转换为更换具体模型的提示，不做自动替换；客户端直接指定具体模型名即可
- **`/v1/responses/compact` 返回 501**：上下文压缩依赖 OpenAI 服务端的 compaction 格式，网关不支持生成该格式
- **单账号并发有限**：同一账号的额度由所有调用方共享。直连模式每个账号默认允许 10 个在途请求（`max_concurrency_per_account` 可调）；`agent` 模式由单实例串行处理会话，请求会排队，建议并发控制在 2~4

### 文档索引

| 我想…… | 看哪里 |
|---|---|
| 接 Codex CLI | [docs/clients/codex.md](docs/clients/codex.md) |
| 接 Claude Code / CC Switch | [docs/clients/claude-code.md](docs/clients/claude-code.md) |
| 查接口、参数、会话与缓存语义 | [docs/api-reference.md](docs/api-reference.md) |
| 配环境变量、运行时设置与两种上游模式 | [docs/configuration.md](docs/configuration.md) |
| 排障 | [docs/troubleshooting.md](docs/troubleshooting.md) |
| 了解「为什么这么做」 | [docs/adr/INDEX.md](docs/adr/INDEX.md)（决策摘要） |
| 对齐术语 | [GLOSSARY.md](GLOSSARY.md) |

### 目录结构

```
AiWork2API/
├── assets/brand/            # 项目标识
├── src/
│   ├── api-bridge.js        # 核心：鉴权 / 调度 / 记账 / 访问日志
│   ├── responses-adapter.js # /v1/responses ↔ chat.completions（Codex）
│   ├── messages-adapter.js  # /v1/messages ↔ chat.completions（Claude Code）
│   ├── ws-responses.js      # Responses WebSocket 传输
│   └── index.html           # 控制台页面
├── scripts/                 # quickstart / start-systemd / start-windows / set-port / issue-key / smoke-test
├── tests/                   # 三协议兼容性自检 + 账号池离线回归
├── docs/                    # 使用文档、ADR、上游条款核查
├── systemd/                 # 裸机部署的服务单元
├── docker-compose.yml       # aiwork 服务 + 可选 caddy
├── Dockerfile               # 仅桥接层，不捆绑官方 CLI
└── .env.example             # 配置模板
```

### 友情链接

[LINUX DO 社区](https://linux.do/) · 中文技术社区

此链接表达对该社区的致谢与认可，为单向友链，不代表该社区对本项目的背书或隶属关系。

### 免责与使用边界

本项目是独立的社区协议转换工具，与 AiWork、Agentix 及其他兼容客户端厂商无隶属、代理或背书关系，亦非其官方产品。项目名称、文档中的协议兼容性表述与测试结果，均不构成任何形式的授权、许可或官方认可。README 中使用的产品图标版权归其权利人所有，仅用于标识本网关所接入的服务，不代表任何形式的授权或背书。

**本项目不提供、也不代为获取上游账号。** 发布的镜像严格为桥接层（Bridge-Only，ADR-0005）：不含官方 CLI 可执行文件，不含任何登录凭据、智能体初始化种子或账号数据；部署者须自行使用官方客户端登录本人合法持有的账号，并以只读方式（`:ro`）将状态目录挂载给网关。本项目不提供账号代登录、批量注册、多租户账号交易或额度转售能力。

**使用边界。** 使用者应持有合法授权的上游账号，遵守上游服务条款与所在地法律法规，并自行判断其接入方式、共享范围与调用规模是否被上游允许。请勿将本项目用于绕过访问控制、规避地域或配额限制、干扰上游服务、窃取他人数据或商业秘密，以及任何其他违法违规用途。

**自托管不等于免责。** 部署者将本网关向他人提供服务时（无论是否收费），其经营资质、备案登记、内容安全、数据出境、税务与用户告知等义务，均由该部署者独立承担；本项目维护者不参与、不介入，亦不承担由此产生的任何责任。上游条款的查证范围与结论见[上游条款核查记录](docs/research/upstream-terms-review.md)。

本项目依据 [MIT License](LICENSE) 按「现状」提供，不附带任何明示或默示担保。因使用或无法使用本项目导致的账号限制、数据丢失、服务中断、纠纷或损失，由使用者自行承担。基于本项目的修改、二次分发与商业利用均系第三方自发行为，与本项目无关；上游接口、官方 CLI 与兼容客户端的行为可能随时变更，本项目不承诺持续可用。

使用前请一并阅读 [合规与授权说明](COMPLIANCE.md)、[数据处理说明](PRIVACY.md)、[安全说明](SECURITY.md) 与[第三方归属](THIRD-PARTY-NOTICES.md)。

项目远程仓库：<https://github.com/PrefixGoat/AiWork2API>。
