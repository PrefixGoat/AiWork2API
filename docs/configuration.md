# 配置与环境变量

两套配置，改法不同：

- **环境变量**（`.env`）：容器启动时读入，改完要 `docker compose up -d` 重建才生效（`restart` 不会重读 env_file）。其中与设置页同名的那些项只作初始值，页面保存过就以配置文件为准。
- **运行时设置**（控制台「设置」TAB）：写数据卷内的 `gateway-config.json`，保存即生效，不用重建。

完整清单与逐行注释见 [`.env.example`](../.env.example)。下面只列常用项与容易踩的规则。

## 环境要求

| 项目 | 要求 |
|---|---|
| 服务器 | Linux（x86_64 / arm64）或 Windows / macOS + Docker Desktop。Windows 也可以直接跑 Node，不装 Docker |
| Docker | 容器部署需要 20.10+ 和 compose 插件（`docker compose version` 能跑）；裸机部署不需要 |
| Node.js | 仅裸机部署需要，20+ |
| 内存 / 磁盘 | 512MB 可用足够；镜像约 150~200MB（仅桥接层，不含官方 CLI） |
| 账号 | 部署者已在宿主机上用官方 CLI 完成登录 |

- **不使用 Docker**：Linux 可配置 [systemd 用户级服务](#裸机部署systemd)，Windows 可直接运行[原生 Node](#windows-原生-node)（启动脚本见 [README](../README.md#不用-docker)）
- **ARM 服务器**（鲲鹏、Ampere）：官方 CLI 提供 `aarch64` 版本，可直接使用

## 常用环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `API_KEYS` | — | 调用密钥，格式 `sk-xxx:展示名,sk-yyy:展示名2` |
| `ADMIN_PASSWORD` | 空 | 可选的管理口令；留空时管理权限随调用凭据授予（ADR-0012） |
| `HOST_PORT` / `PUBLISH_ADDR` | `8080` / `127.0.0.1` | 宿主侧端口发布；默认只绑回环 |
| `BIND` | 容器 `0.0.0.0`，裸机 `127.0.0.1` | 进程监听地址的**初始值**；设置页保存过 `bind_address` 后以配置文件为准 |
| `ALLOW_OPEN_BIND` | 未设置 | 允许非回环监听且完全没有调用凭据；仅限隔离内网，正常部署不要设 |
| `ALLOW_IPS` | 空 | 来源 IP 白名单，逗号分隔，支持 CIDR；空 = 不限制 |
| `RATE_LIMIT_PER_MIN` | compose 与裸机模板都写 `60`；完全没设时代码默认 `0`（不限） | 每个调用的每分钟请求上限，`0` = 不限 |
| `UPSTREAM` | `direct` | `direct` 直连 / `agent` 本地 CLI 实验模式 |
| `ROUTER_BASE_URL` | 官方地址 | 上游直连地址，自建反代时改 |
| `AIWORK_BILLING_BASE_URL` | 空（= 官方地址） | 只影响控制台「额度看板」的上游额度查询，不影响模型目录、设备授权与 Router Key 交换 |
| `UPSTREAM_ACCOUNTS` | 空 | 多账号只读挂载，格式 `id:路径:ro`；留空读 `AGENTIX_STATE_DIR` |
| `MAX_ACCOUNT_ATTEMPTS` | `3` | 单请求最多尝试几个不同账号（含首次） |
| `REQUEST_LOG_ARCHIVE` | `1` | 请求日志 JSONL 归档开关；`0` = 只留内存最近记录 |
| `REQUEST_LOG_RETENTION_DAYS` | `14` | 归档保留天数的初始值（设置页可改，保存即生效） |
| `REQUEST_LOG_MAX_MB` | `200` | 归档总容量上限的初始值（设置页可改） |
| `STATE_PATH` | `/data/usage-state.json` | 本机累计计数器，可被「重置本机统计」清零 |
| `USAGE_BUCKETS_PATH` | 与 `STATE_PATH` 同目录的 `usage-buckets.json` | 用量账本；清空统计不清它（ADR-0017） |
| `TRUST_PROXY` | `0` | 反代后面设为 `1`，按 `X-Forwarded-For` 记录真实来源 |
| `CONTAINER_NAME` | `aiwork` | compose 的容器名（Caddy 容器为 `<CONTAINER_NAME>-caddy`）；同机跑多个实例时改掉，否则会撞名。只影响容器命名，`docker compose exec aiwork` 仍按服务名寻址 |
| `AGENTIX_HOST_STATE_DIR` | `~/.local/share/agentix` | **宿主机**上官方 CLI 登录态目录，只读挂到容器 `/accounts/default`。Windows 上通常填 `C:/Users/你的用户名/.agentix`；`quickstart.sh` 会按探测结果写入 `.env`。与裸机的 `AGENTIX_STATE_DIR` 不是同一个东西：后者是进程自己读的目录 |

## 监听地址与容器健康检查

- 容器内请保持监听主机为 `0.0.0.0`（镜像默认），对外暴露范围由宿主侧的 `PUBLISH_ADDR` 控制；裸机部署才用 `127.0.0.1` 只放行本机。
- **不要填具体网卡 IP**：Docker healthcheck 打的是容器内的 `127.0.0.1:$PORT/healthz`（见 `Dockerfile` 与 `docker-compose.yml`），回环不再监听时容器会被判 unhealthy。
- 想限制来源，改宿主侧的 `PUBLISH_ADDR`，不要动容器内的监听主机。
- 监听地址接受 **主机[:端口]**：主机是 IPv4 字面量或主机名（如 `127.0.0.1`、`0.0.0.0`、`localhost`），端口省略时用 `PORT`（默认 8080）。IPv6 字面量与 `0` 端口会被 400 拒绝（ADR-0018 及其修订）。
- 监听地址可在设置页热改：先绑新的（换端口时新旧监听并存，没有空窗），成功后才写配置；失败返回 409 并回退到旧地址，不会把网关改到起不来的状态。
- 容器部署里端口是**发布映射的一部分**：只改宿主端口就改 `.env` 的 `HOST_PORT`（`docker compose up -d` 重建即生效）；要连着改容器端口，把 `CONTAINER_PORT` 一起改，否则宿主机访问会断。

## 改端口（容器内外两个）

| 想改的 | 改哪里 | 生效方式 |
|---|---|---|
| 宿主机端口（浏览器地址里那个） | 设置页「容器外端口」旁的复制命令，或 `.env` 的 `HOST_PORT` | `docker compose up -d` 重建容器 |
| 容器内监听端口 | 设置页「容器内端口」，或 `.env` 的 `CONTAINER_PORT` | 设置页保存即重绑；env 需重建 |

设置页把三件事分开：`监听 IP`（只填 IP）、`容器内端口`（保存即换绑）、`容器外端口`（归 compose 管，页面给你一条命令，旁边就是复制按钮）。本机部署没有容器映射，外端口跟着内端口走。

两个端口一起改，用脚本一步到位：

```bash
./scripts/set-port.sh --host 18081                 # 只改宿主机端口
./scripts/set-port.sh --container 9000             # 只改容器内端口
./scripts/set-port.sh --host 18081 --container 9000
./scripts/set-port.sh --host 18081 --dry-run       # 只预览，不动文件
```

脚本会写 `.env`、清掉 `gateway-config.json` 里可能把容器端口钉死的 `bind_address` 端口部分，再 `docker compose up -d`，最后用新端口探活，失败时明确报出来。

> **为什么设置页改不了宿主机端口**：端口映射在容器创建时由 Docker 固定，容器里的进程既看不到也改不了自己的映射表。要让它能改，只能把 `docker.sock` 挂进容器，那等于把整台宿主机交给一个 Web 控制台，不做。所以「外面那个端口」只能在宿主机侧改一次。

## 运行时设置

设置页写入 `gateway-config.json`，保存时按白名单校验类型与范围，**越界整体拒绝**，未知键忽略但在响应里回报 `ignored`。

**账号调度**（保存后立即生效，已在途的请求不受影响；调度参数在下次调度/绑定时读取）

| 设置项 | 键 | 默认 | 生效方式 |
|---|---|---|---|
| 单账号最大在途并发 | `max_concurrency_per_account` | 10 | 立即生效 |
| 会话粘性路由 | `session_binding_enabled` | true | 立即生效 |
| 会话粘性 TTL | `session_binding_ttl_sec` | 3600 | 立即生效（下次绑定读取） |

**超时**（保存后立即生效，已在途的请求沿用旧值）

| 设置项 | 键 | 默认 | 生效方式 |
|---|---|---|---|
| 短请求超时 | `short_request_timeout_sec` | 120 | 立即生效 |
| 聊天首字节超时 | `first_byte_timeout_sec` | 120 | 立即生效 |
| 流空闲超时 | `stream_idle_timeout_sec` | 300 | 立即生效 |

**网络与日志**

| 设置项 | 键 | 默认 | 生效方式 |
|---|---|---|---|
| 监听 IP | `bind_address` | `127.0.0.1`（容器内初始值为 `0.0.0.0`） | **重绑生效**：先绑成功再落盘，失败返回 409 并回退旧地址 |
| 容器内端口 | `bind_address` 的端口部分 | `PORT`（默认 8080） | **重绑生效**，与 IP 一起保存；页面拆成独立输入框 |
| 容器外端口 | 不属于应用配置 | compose 的 `HOST_PORT` | 页面给命令 + 复制按钮，宿主机执行后重建容器 |
| 出站 User-Agent | `outbound_user_agent` | `aiwork-gateway/1.0` | 立即生效 |
| 请求日志保留天数 | `request_log_retention_days` | 14 | 立即生效（每次落盘/清理读取） |
| 请求日志容量上限 | `request_log_max_mb` | 200 | 立即生效（每次落盘/清理读取） |
| 记录来源 IP 与浏览器标识 | `request_log_capture_source` | true | 立即生效（只影响新记录） |

> 页面把监听拆成「监听 IP」「容器内端口」「容器外端口」三行；配置里前两者仍是同一个 `bind_address` 字段（`主机[:端口]`，API 与脚本照旧可用）。容器内不要填具体网卡 IP，改容器端口要把 compose 的 `CONTAINER_PORT` 与发布映射一起改（ADR-0018 的修订）。

## 两种上游模式

`UPSTREAM` 切的是两套截然不同的后端，这是全项目最省钱的一个开关。

| | `direct`（默认） | `agent` |
|---|---|---|
| 后端 | 直连上游 Router | 本地 `aiworkcn chat` CLI |
| 单轮固定开销 | **25 tokens** | **19,200 tokens** |
| 工具调用 | 原生 `tool_calls` | 提示词协议模拟 |
| 图片输入 | 原生支持 | 下载落盘后传入 |
| 思考模式 | 有 `reasoning_content` | 无 |
| 前缀缓存 | 有（`prompt_cache_hit_tokens`） | 无 |
| 响应速度 | 快，无中间层 | 慢，有 agent 循环 |
| 技能（Excel/PPT/视频/代码执行/联网） | ❌ 无 | ✅ 有 |

**为什么差这么多**：`coder` 是个完整 agent，每轮都要把系统提示 + 内置工具 schema（约 16~19K）发给模型。你只想要一个 API 转发，用不上这个「大脑」。实测同一句「1+1=?」：

```
UPSTREAM=direct    prompt_tokens: 25
UPSTREAM=agent     prompt_tokens: 19,200
```

工具调用那次带 schema 是 294（含缓存命中），仍然差 60 倍以上。

> 上面这些数字来自早期的一次手工实测，仓库里没有可复现的脚本；上游改过系统提示后可能不再对得上，别把它当基准值。

> 顺带说明：关掉技能**省不了**。实测把 19 个技能全部禁用，仍然是 19,200——技能是按需加载的，不进 prompt。那 19K 是 agent 的系统提示和内置工具定义，没有开关。

### 运行模式严格隔离（ADR-0001）

- **直连模式（`UPSTREAM=direct`，默认）**：只转发模型请求，开销极低。上游报网络异常、超时、401 凭据失效或 5xx 时，网关返回标准错误，绝不自动切到智能体——那会把请求送进一个能执行本地命令的环境（ADR-0001）。
- **智能体模式（`UPSTREAM=agent`，实验）**：必须显式设置，并在独立部署实例里挂载宿主机官方 CLI 可执行文件与工作目录。它能通过 CLI 操作文件和执行命令，只在受信任的沙箱隔离环境中运行。

## 请求日志归档

默认按天写 `<DATA_DIR>/logs/requests-YYYY-MM-DD.jsonl`，保留天数与总容量由设置页控制；`REQUEST_LOG_ARCHIVE=0` 可整体关闭。

某批写失败不会整批丢：没写成功的行放回队首下一轮重试，队列实在放不下的部分计入 `archive.dropped`，日志页会标出来。日志页筛选栏右侧显示归档占用，`GET /api/logs` 的 `archive` 字段是同一份数据。

## 关停与备份

- **关停**：收到 `SIGTERM` / `SIGINT` 后先停掉所有监听（含设置页改地址重绑换下来的旧 server），给在途请求和归档队列各最多 2 秒收尾，然后退出；账本在退出前额外做一次同步落盘。
- **备份**：`.env` 之外，运行时配置（`gateway-config.json`）、用量账本（`usage-buckets.json`）、账号与请求日志归档都在数据卷里，迁移时整个卷一起复制。`docker compose down` 不会删卷。

## 裸机部署（systemd）

`bash scripts/start-systemd.sh` 会把下面这些事一次做完。想自己控制每一步，按这个顺序来。

```bash
# 1) 装官方 CLI 并登录
curl -fsSL https://aiwork-dl.dtagi.cn/releases/install-aiwork.sh | bash -s -- --yes --skip-tui
aiworkcn login

# 2) 装 Node 20+（各发行版不同）
#    Debian/Ubuntu: curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs

# 3) 放代码（示例用用户目录，免 sudo）
PREFIX="$HOME/.local/share/aiwork-gateway"
mkdir -p "$PREFIX/data" "$PREFIX/src" "$PREFIX/scripts" ~/.config/systemd/user
cp -R src/. "$PREFIX/src/" && cp -R scripts/. "$PREFIX/scripts/"

# 4) 写配置
cp .env.example ~/.config/aiwork-gateway.env
chmod 600 ~/.config/aiwork-gateway.env     # 里面有调用密钥，别留成 644
vi ~/.config/aiwork-gateway.env
```

**配置里必须改这几处**：`.env.example` 是按容器写的，裸机照抄会去读 `/accounts/default` 和 `/data`，两处都不存在。

| 键 | 改成 |
|---|---|
| `AGENTIX_STATE_DIR` | 宿主机 CLI 状态目录的绝对路径，通常是 `~/.local/share/agentix`，Windows 上常见 `~/.agentix` |
| `GATEWAY_DATA_DIR` | `$PREFIX/data` |
| `STATE_PATH` | `$PREFIX/data/usage-state.json` |
| `DUMP_DIR` | `$PREFIX/data/gw-logs`（只有开抓包时才用到） |
| `API_KEYS` | 换成自己的 key，别留 `sk-change-me-please` |
| `BIND` / `PORT` | 不填就是 `127.0.0.1` / `8080`，只听本机 |

```bash
# 5) 装服务：把单元里的 /opt/aiwork-gateway 换成你的 $PREFIX
mkdir -p ~/.config/systemd/user
cp systemd/aiwork-bridge.service ~/.config/systemd/user/
vi ~/.config/systemd/user/aiwork-bridge.service   # 改 WorkingDirectory 与 ExecStart 两行
systemctl --user daemon-reload
systemctl --user enable --now aiwork-bridge
loginctl enable-linger "$USER"       # SSH 断开也保持运行

# 6) 验证
systemctl --user status aiwork-bridge
curl "http://127.0.0.1:${PORT:-8080}/healthz"
journalctl --user -u aiwork-bridge -f
```

> 别用 `sed -i "s|/opt/aiwork-gateway|$PREFIX|g"` 批量替换：路径里一旦有 `&` 或反斜杠，会被当成反向引用或转义。手工改这两行更稳。

`systemd/aiwork-bridge.service` 的 `EnvironmentFile` 指向 `%h/.config/aiwork-gateway.env`，所以环境变量改完要 `systemctl --user restart aiwork-bridge` 才生效。

## Windows 原生 Node

Windows 上不需要 Docker 和 systemd，装好 Node 20+ 就能直接跑 `src/api-bridge.js`：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1
```

脚本会在仓库里生成两份本地文件，都不会进 git：

| 产物 | 用途 |
|---|---|
| `.env.windows` | 从 `.env.example` 复制，按本机情况改写后作为进程环境变量加载 |
| `data-windows/` | 用量账本、账号配置、调用凭据与日志 |

`.env.example` 是容器向的模板，裸机照抄会去读 `/accounts/default` 和 `/data`。脚本每次运行都会覆盖下面这些键，其余项沿用文件里已有的值（重复键会合并成一个）：

| 键 | 改成 |
|---|---|
| `AGENTIX_STATE_DIR` | 本机 CLI 状态目录，按 `AGENTIX_STATE_DIR` → `~\.agentix` → `%APPDATA%\Agentix` → `%LOCALAPPDATA%\AiWork` → `~\.local\share\agentix` 依次探测 |
| `GATEWAY_DATA_DIR` / `STATE_PATH` / `DUMP_DIR` | 都指向 `data-windows\` 下的路径 |
| `BIND` / `PORT` / `UPSTREAM` | `127.0.0.1` / 脚本的 `-Port`（默认 8080） / `direct` |
| `API_KEYS` | 仍是占位值时换成随机 key |

常用参数：

```powershell
# 8080 被占用时换端口
powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1 -Port 18081

# 前台运行，日志直接打到终端，Ctrl+C 停止
powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1 -Foreground

# 还没登录、打算用控制台的设备授权加账号
powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1 -SkipLoginCheck
```

默认在后台启动，探活成功后打印控制台地址、Base URL、API Key 和 PID。停止执行 `Stop-Process -Id <打印的 PID>`；日志在 `data-windows\gateway.log` 与 `gateway.err.log`。后台进程不随 PowerShell 窗口关闭而退出，需要开机自启就用 Windows 任务计划程序建一个指向该脚本的任务。

两点与 Docker 部署不同：容器用的 `AGENTIX_HOST_STATE_DIR` 在这里没有意义，裸机直接读 `AGENTIX_STATE_DIR`；`data-windows\api-keys.json` 一旦存在，其中保存的调用凭据优先于 `.env.windows` 的 `API_KEYS`，脚本打印的 key 取自该文件。

PowerShell 5.1 的 `Start-Process` 遇到同一变量同时存在大小写两种写法（例如 `HTTP_PROXY` 与 `http_proxy`）会报错，脚本启动前会在当前进程里去掉重复的小写形式，不改系统环境变量。
