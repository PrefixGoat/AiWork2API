#!/usr/bin/env bash
# AiWork2API 裸机一键部署：把源码、配置和 systemd 用户级服务装好并启动。
#
# 与 quickstart.sh 一致的设计边界：
#   - 官方浏览器授权只检测、不代做。
#   - 不替你装 Node（各发行版装法不同），不覆盖已存在的 ~/.config/aiwork-gateway.env。
#   - 默认装到用户目录，不需要 sudo；--prefix 指到系统目录时才需要写权限。
#
# 用法：
#   bash scripts/start-systemd.sh                       # 默认装到 ~/.local/share/aiwork-gateway
#   bash scripts/start-systemd.sh --prefix /opt/aiwork-gateway
#   bash scripts/start-systemd.sh --install-cli         # 顺带执行官方 CLI 安装脚本
#   bash scripts/start-systemd.sh --skip-login-check   # 账号在别处（设备授权）时跳过检测
#   bash scripts/start-systemd.sh --help

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PREFIX="${AIWORK_HOME:-$HOME/.local/share/aiwork-gateway}"
STATE_DIR="${AGENTIX_STATE_DIR:-}"
ENV_FILE="$HOME/.config/aiwork-gateway.env"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/aiwork-bridge.service"
SKIP_LOGIN_CHECK=0
INSTALL_CLI=0

usage() { sed -n '2,14p' "${BASH_SOURCE[0]}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)
      [ $# -ge 2 ] || { echo "--prefix 后面要跟路径" >&2; exit 2; }
      PREFIX="$2"; shift 2 ;;
    --install-cli) INSTALL_CLI=1; shift ;;
    --skip-login-check) SKIP_LOGIN_CHECK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }
die() {
  fail "$1"; shift
  for line in "$@"; do printf '    %s\n' "$line" >&2; done
  exit 1
}

read_env() {
  local raw
  raw="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  printf '%s' "${raw:-$2}"
}

write_env() {
  local key="$1" value="$2" tmp
  # 用 ENVIRON 传值，不用 awk -v：-v 会解析反斜杠转义，Windows 路径会被吞字符
  tmp="$(mktemp "${ENV_FILE%/*}/.env.XXXXXX")"
  KEY="$key" VALUE="$value" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"]; done = 0 }
    $0 ~ "^[[:space:]]*" k "=" { if (!done) { print k "=" v; done = 1 } ; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" > "$tmp" || { rm -f "$tmp"; fail "写入 $key 到 $ENV_FILE 失败"; return 1; }
  mv "$tmp" "$ENV_FILE"
}

# ---------- 1. 运行环境 ----------

bold "1/6 检查运行环境"

command -v systemctl >/dev/null 2>&1 || die "没找到 systemctl，这套脚本只适用于 Linux 的 systemd 用户级服务。" \
  "Docker 部署请用：bash scripts/quickstart.sh"
systemctl --user show-environment >/dev/null 2>&1 || die "systemd 用户级服务不可用。" \
  "先确认已登录会话并启动 user manager：systemctl --user status"
ok "systemd 用户级服务可用"

command -v node >/dev/null 2>&1 || die "没找到 Node.js，裸机运行需要 20+。" \
  "Debian/Ubuntu：curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs"
NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
[ "$NODE_MAJOR" -ge 20 ] 2>/dev/null || die "Node 版本太低：$(node -v)，需要 20+"
ok "Node $(node -v)"

command -v curl >/dev/null 2>&1 || die "没找到 curl。" "本脚本用 curl 探活，先装：apt install curl"

if ! command -v aiworkcn >/dev/null 2>&1; then
  if [ "$INSTALL_CLI" = "1" ]; then
    info "执行官方 CLI 安装脚本"
    curl -fsSL https://aiwork-dl.dtagi.cn/releases/install-aiwork.sh | bash -s -- --yes --skip-tui
    command -v aiworkcn >/dev/null 2>&1 || die "安装脚本跑完了，但 aiworkcn 仍不在 PATH。" \
      "重开一个终端让 PATH 生效，再执行本脚本"
  else
    die "没找到官方 CLI（aiworkcn）。" \
      "装它：curl -fsSL https://aiwork-dl.dtagi.cn/releases/install-aiwork.sh | bash -s -- --yes --skip-tui" \
      "或者让脚本代跑：bash scripts/start-systemd.sh --install-cli"
  fi
fi
ok "官方 CLI 已安装"

# ---------- 2. 登录态（只检测，不代做） ----------

bold "2/6 检查登录态"

# 官方 CLI 的状态目录在不同平台/版本上落点不同：Linux 常见 ~/.local/share/agentix，
# 运行时代码的默认值是 ~/.agentix（api-bridge.js 的 STATE_DIR）。两个都探，别只认一个。
if [ -z "$STATE_DIR" ]; then
  if [ -d "$HOME/.local/share/agentix" ]; then
    STATE_DIR="$HOME/.local/share/agentix"
  elif [ -d "$HOME/.agentix" ]; then
    STATE_DIR="$HOME/.agentix"
  fi
fi

if [ "$SKIP_LOGIN_CHECK" = "1" ]; then
  warn "已按 --skip-login-check 跳过检测，请自行确认账号可用"
  [ -n "$STATE_DIR" ] || STATE_DIR="$HOME/.local/share/agentix"
elif [ -n "$STATE_DIR" ] && [ -d "$STATE_DIR" ]; then
  ok "找到登录态目录：$STATE_DIR"
else
  fail "没有找到登录态目录，找过："
  echo "      $HOME/.local/share/agentix"
  echo "      $HOME/.agentix"
  echo
  echo "    浏览器授权必须你自己完成："
  echo "      aiworkcn login"
  echo "      aiworkcn auth status --json"
  echo
  echo "    也可以在服务起来后用控制台的设备授权添加账号，那样执行："
  echo "      bash scripts/start-systemd.sh --skip-login-check"
  exit 1
fi

# ---------- 3. 安装源码 ----------

bold "3/6 安装源码到 $PREFIX"

if ! mkdir -p "$PREFIX/data" 2>/dev/null; then
  die "没有权限创建 $PREFIX。" \
    "换个用户目录（默认就是），或给这个路径授权：sudo mkdir -p $PREFIX && sudo chown \$USER $PREFIX"
fi
mkdir -p "$PREFIX/src" "$PREFIX/scripts"
cp -R "$ROOT_DIR/src/." "$PREFIX/src/"
cp -R "$ROOT_DIR/scripts/." "$PREFIX/scripts/"
ok "已复制 src/ 与 scripts/"

# ---------- 4. 生成配置 ----------

bold "4/6 准备 $ENV_FILE"

if [ -f "$ENV_FILE" ]; then
  ok "配置文件已存在，保留不动"
else
  mkdir -p "$(dirname "$ENV_FILE")"
  cp .env.example "$ENV_FILE"

  # .env.example 是容器向的，裸机上这三个路径必须改掉，否则会去读 /accounts 和 /data
  write_env AGENTIX_STATE_DIR "$STATE_DIR"
  write_env GATEWAY_DATA_DIR "$PREFIX/data"
  write_env STATE_PATH "$PREFIX/data/usage-state.json"
  write_env DUMP_DIR "$PREFIX/data/gw-logs"
  write_env BIND "127.0.0.1"
  write_env PORT "8080"

  if grep -q '^API_KEYS=.*sk-change-me-please' "$ENV_FILE"; then
    NEW_KEY="sk-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom 2>/dev/null | head -c 24 || true)"
    [ -n "${NEW_KEY#sk-}" ] || NEW_KEY="sk-$(date +%s)$(printf '%04d' $((RANDOM % 10000)))"
    write_env API_KEYS "$NEW_KEY:default"
    ok "已生成随机调用密钥"
  fi
  chmod 600 "$ENV_FILE"
  ok "已从 .env.example 生成配置（权限 600）"
fi

PORT="$(read_env PORT 8080)"
BIND="$(read_env BIND 127.0.0.1)"
API_KEY="$(read_env API_KEYS '' | cut -d: -f1)"

# ---------- 5. 装服务 ----------

bold "5/6 安装并启动 aiwork-bridge"

mkdir -p "$UNIT_DIR"
# 服务单元里写死了 /opt/aiwork-gateway，按实际 prefix 改写一份。
# 不用 sed：PREFIX 可能含 & 或反斜杠，会被当成反向引用/转义；逐段拼接不经过转义解析。
if PREFIX="$PREFIX" awk '
  BEGIN { p = ENVIRON["PREFIX"]; needle = "/opt/aiwork-gateway" }
  {
    line = $0; out = ""
    while ((i = index(line, needle)) > 0) {
      out = out substr(line, 1, i - 1) p
      line = substr(line, i + length(needle))
    }
    print out line
  }
' "$ROOT_DIR/systemd/aiwork-bridge.service" > "$UNIT_FILE"; then
  ok "已生成 $UNIT_FILE（WorkingDirectory / ExecStart → $PREFIX）"
else
  die "改写服务单元失败" "检查 $ROOT_DIR/systemd/aiwork-bridge.service 是否存在且可读"
fi

systemctl --user daemon-reload
if systemctl --user is-active --quiet aiwork-bridge 2>/dev/null; then
  systemctl --user restart aiwork-bridge
  ok "服务已在运行，已重启以加载新配置"
else
  systemctl --user enable --now aiwork-bridge
  ok "服务已启用并启动"
fi

if ! loginctl enable-linger "$(id -un)" 2>/dev/null; then
  warn "enable-linger 没设上；SSH 断开后用户级服务可能停掉"
  info "需要的话手动执行：sudo loginctl enable-linger $(id -un)"
fi

# ---------- 6. 探活 ----------

bold "6/6 等待服务就绪"

BASE="http://127.0.0.1:$PORT"
printf '  等待 %s/healthz' "$BASE"
READY=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "$BASE/healthz" 2>/dev/null | grep -q '^ok'; then READY=1; break; fi
  printf '.'
  sleep 1
done
printf '\n'

if [ "$READY" != "1" ]; then
  echo
  fail "30 秒内没有探活成功"
  echo "      systemctl --user status aiwork-bridge" >&2
  echo "      journalctl --user -u aiwork-bridge -n 50 --no-pager" >&2
  exit 1
fi

ok "服务已就绪"

echo
bold "可以用了"
echo
info "控制台    $BASE/"
info "Base URL  $BASE/v1"
info "API Key   ${API_KEY:-（见 $ENV_FILE 的 API_KEYS）}"
info "监听      $BIND:$PORT（只听本机）"
echo
info "systemctl --user status aiwork-bridge           # 状态"
info "journalctl --user -u aiwork-bridge -f           # 日志"
info "systemctl --user restart aiwork-bridge          # 改了配置后重启"
info "systemctl --user disable --now aiwork-bridge    # 停掉"
info "手动部署步骤见 docs/configuration.md#裸机部署systemd"
