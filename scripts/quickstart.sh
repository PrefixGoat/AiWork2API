#!/usr/bin/env bash
# AiWork2API 一键上手：检查环境 → 准备 .env → 构建并启动 → 探活 → 打印可粘贴的调用示例。
#
# 设计边界（有意为之）：
#   - 登录态只检测，不代做。官方授权必须由人在浏览器里完成。
#   - 端口被占不静默顺延，直接报错并给出现成命令。端口悄悄变了，用户后面配客户端会撞墙。
#
# 用法：
#   bash scripts/quickstart.sh              # 正常跑
#   bash scripts/quickstart.sh --skip-login-check   # 登录态在别处（自定义挂载）时跳过检测
#   bash scripts/quickstart.sh --no-build   # 只启动，不重新构建（镜像已是最新时）

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SKIP_LOGIN_CHECK=0
DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --skip-login-check) SKIP_LOGIN_CHECK=1 ;;
    --no-build) DO_BUILD=0 ;;
    -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$arg（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }

die() {
  fail "$1"
  shift
  for line in "$@"; do printf '    %s\n' "$line" >&2; done
  exit 1
}

# 写/替换 .env 里的键。值经 ENVIRON 传入，不经 awk -v 的转义解析，
# 否则 Windows 路径里的 \ 会被吞掉。
write_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  KEY="$key" VALUE="$value" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"]; done = 0 }
    $0 ~ "^[[:space:]]*" k "=" { if (!done) { print k "=" v; done = 1 }; next }
    { print }
    END { if (!done) print k "=" v }
  ' .env > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" .env
}

# compose 的变量里路径不要反斜杠；Git Bash 下 HOME 是 /c/Users/xxx 这种形式，
# Docker Desktop 虽然认，但写进 .env 后跨工具链容易出岔子，统一转成 C:/Users/xxx。
to_posix_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1" 2>/dev/null || printf '%s' "$1" | tr '\\' '/'
  else
    printf '%s' "$1" | tr '\\' '/'
  fi
}

# ---------- 1. 环境检查 ----------

bold "1/5 检查环境"

COMPOSE=""
if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
  fi
fi

[ -n "$COMPOSE" ] || die "没找到 Docker Compose。" \
  "装 Docker Desktop（Windows / macOS）或 docker-ce + compose 插件（Linux），" \
  "确认 \`docker compose version\` 能跑，再回来执行本脚本。"
ok "Docker Compose 可用（$COMPOSE）"

command -v curl >/dev/null 2>&1 || die "没找到 curl。" "本脚本用 curl 探活，先装：apt install curl"

[ -f docker-compose.yml ] || die "当前目录不是项目根目录。" "在项目根目录执行：bash scripts/quickstart.sh"
ok "项目根目录：$ROOT_DIR"

# ---------- 2. 登录态检测（只检测，不代做） ----------

bold "2/5 检查登录态"

# 官方 CLI 的状态目录在不同平台/版本上落点不同：Linux 常见 ~/.local/share/agentix，
# 运行时代码的默认值是 ~/.agentix（api-bridge.js 的 STATE_DIR）。两个都探，别只认一个。
STATE_DIR=""
if [ -n "${AGENTIX_STATE_DIR:-}" ]; then
  STATE_DIR="$AGENTIX_STATE_DIR"
elif [ -d "$HOME/.local/share/agentix" ]; then
  STATE_DIR="$HOME/.local/share/agentix"
elif [ -d "$HOME/.agentix" ]; then
  STATE_DIR="$HOME/.agentix"
fi

if [ "$SKIP_LOGIN_CHECK" = "1" ]; then
  warn "已按 --skip-login-check 跳过检测，请自行确认挂载路径正确"
  [ -n "$STATE_DIR" ] || STATE_DIR="$HOME/.local/share/agentix"
elif [ -n "$STATE_DIR" ] && [ -d "$STATE_DIR" ]; then
  ok "找到登录态目录：$STATE_DIR"
else
  fail "没有找到登录态目录，找过："
  if [ -n "${AGENTIX_STATE_DIR:-}" ]; then
    echo "      $AGENTIX_STATE_DIR（来自 AGENTIX_STATE_DIR）"
  fi
  echo "      $HOME/.local/share/agentix"
  echo "      $HOME/.agentix"
  echo
  echo "    这一步必须你自己做——官方授权要在浏览器里点确认，脚本代替不了。"
  echo
  echo "      # 装 CLI（Linux / macOS）"
  echo "      curl -fsSL https://aiwork-dl.dtagi.cn/releases/install-aiwork.sh | bash -s -- --yes --skip-tui"
  echo "      # 登录"
  echo "      aiworkcn login"
  echo
  echo "    也可以在控制台里用设备授权加账号，那样不需要挂载。"
  echo "    凭据目录不在默认位置的话，在 .env 里写："
  echo "      AGENTIX_HOST_STATE_DIR=/你的/路径"
  echo "    或直接指定：AGENTIX_STATE_DIR=/你的/路径 bash scripts/quickstart.sh"
  echo
  echo "    确认挂载在别处、想继续启动：bash scripts/quickstart.sh --skip-login-check"
  exit 1
fi

# 挂载左值不在这里改 compose：compose 读 .env 的 AGENTIX_HOST_STATE_DIR，第 3 步写入。
# 这样也不用把宿主机路径（可能含反斜杠、空格）拼进 YAML。
if [ -n "$STATE_DIR" ] && [ ! -d "$STATE_DIR" ]; then
  warn "登录态目录不存在：$STATE_DIR"
  warn "跳过了登录检测才走到这里；容器会挂进空目录，账号数仍是 0"
fi

# ---------- 3. 准备 .env ----------

bold "3/5 准备 .env"

if [ -f .env ]; then
  ok ".env 已存在，保留不动"
else
  cp .env.example .env
  ok "已从 .env.example 生成 .env"
fi

# 登录态目录写进 .env，compose 的只读挂载左值读它。用户已经填过就不动。
MOUNT_HOST="$(grep -E '^AGENTIX_HOST_STATE_DIR=' .env | head -1 | cut -d= -f2- | tr -d '\r' || true)"
if [ -n "$MOUNT_HOST" ]; then
  ok ".env 已指定 AGENTIX_HOST_STATE_DIR=$MOUNT_HOST"
elif [ -n "$STATE_DIR" ]; then
  if write_env AGENTIX_HOST_STATE_DIR "$(to_posix_path "$STATE_DIR")"; then
    ok "已写入 .env：AGENTIX_HOST_STATE_DIR=$(to_posix_path "$STATE_DIR")"
  else
    warn "写入 .env 失败，请手动填 AGENTIX_HOST_STATE_DIR=$(to_posix_path "$STATE_DIR")"
  fi
fi

# 占位 key 必须换掉：它是公开的，等于没有鉴权
if grep -q '^API_KEYS=.*sk-change-me-please' .env 2>/dev/null; then
  NEW_KEY="sk-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom 2>/dev/null | head -c 24 || true)"
  if [ -z "${NEW_KEY#sk-}" ]; then
    NEW_KEY="sk-$(date +%s)$(printf '%04d' $((RANDOM % 10000)))"
  fi
  # 只替换占位串，保留 ":展示名" 后缀
  sed -i.bak "s/sk-change-me-please/$NEW_KEY/" .env && rm -f .env.bak
  ok "已把占位的 sk-change-me-please 换成随机 key"
  GENERATED_KEY="$NEW_KEY"
else
  GENERATED_KEY="$(grep -E '^API_KEYS=' .env | head -1 | cut -d= -f2- | cut -d: -f1 || true)"
  [ -n "$GENERATED_KEY" ] && ok "沿用 .env 里已有的 key" || warn "API_KEYS 看起来是空的，稍后调用会 401"
fi

# ---------- 4. 端口检查 ----------

bold "4/5 检查端口"

HOST_PORT="$(grep -E '^HOST_PORT=' .env | head -1 | cut -d= -f2- | tr -d '[:space:]' || true)"
HOST_PORT="${HOST_PORT:-8080}"
PUBLISH_ADDR="$(grep -E '^PUBLISH_ADDR=' .env | head -1 | cut -d= -f2- | tr -d '[:space:]' || true)"
PUBLISH_ADDR="${PUBLISH_ADDR:-127.0.0.1}"

port_busy() {
  # 只把连接探测放在子 shell 里。若在父 shell 里用 exec 关闭一个并未打开的 fd，
  # 非交互 bash 会直接退出，而错误又被 2>/dev/null 吞掉——表现就是「什么都没说就退出 1」。
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

if port_busy "$HOST_PORT"; then
  # 可能是本项目的旧容器还在跑，那就不是错误
  if $COMPOSE ps --status running 2>/dev/null | grep -qi 'aiwork'; then
    warn "端口 $HOST_PORT 已被本项目的容器占用，将直接复用并重启"
  else
    NEXT_PORT=$((HOST_PORT + 1))
    die "端口 $HOST_PORT 已被其他程序占用。" \
      "换一个端口（一条命令，会同时改 .env 并重建）：" \
      "  ./scripts/set-port.sh --host $NEXT_PORT" \
      "或者手动改 .env 的 HOST_PORT 后重新执行本脚本。"
  fi
else
  ok "端口 $HOST_PORT 空闲"
fi

# ---------- 5. 启动并探活 ----------

bold "5/5 构建并启动（首次约 10~15 秒）"

if [ "$DO_BUILD" = "1" ]; then
  $COMPOSE up -d --build || die "启动失败。" "看详细日志：$COMPOSE logs -f aiwork"
else
  $COMPOSE up -d || die "启动失败。" "看详细日志：$COMPOSE logs -f aiwork"
fi

BASE="http://127.0.0.1:$HOST_PORT"
printf '  等待服务就绪'
READY=0
for _ in $(seq 1 40); do
  if curl -fsS --max-time 2 "$BASE/healthz" 2>/dev/null | grep -q '^ok'; then
    READY=1
    break
  fi
  printf '.'
  sleep 1
done
printf '\n'

if [ "$READY" != "1" ]; then
  echo
  fail "40 秒内没有探活成功（$BASE/healthz）"
  echo "    先看日志定位，多半是登录态没挂进去或端口映射不对："
  echo "      $COMPOSE logs --tail=50 aiwork"
  exit 1
fi

ok "服务已就绪"

# ---------- 收尾：把该复制的东西摆好 ----------

echo
bold "可以用了"
echo
if [ "$PUBLISH_ADDR" != "127.0.0.1" ]; then
  info "注意：PUBLISH_ADDR=$PUBLISH_ADDR，端口已对外发布；公网部署请设 ADMIN_PASSWORD。"
fi
echo "  控制台    $BASE/"
echo "  Base URL  $BASE/v1"
echo "  API Key   ${GENERATED_KEY:-（见 .env 的 API_KEYS）}"
echo
echo "  试一句："
echo
cat <<EOF
    curl $BASE/v1/chat/completions \\
      -H "Authorization: Bearer ${GENERATED_KEY:-sk-你的Key}" \\
      -H "Content-Type: application/json" \\
      -d '{"model":"automodel","messages":[{"role":"user","content":"你好"}]}'
EOF
echo
info "接 Codex CLI：docs/clients/codex.md"
info "接 Claude Code：docs/clients/claude-code.md"
info "排障：docs/troubleshooting.md"
