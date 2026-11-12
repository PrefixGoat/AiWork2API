#!/usr/bin/env bash
# 一键改端口：宿主机端口（HOST_PORT）与容器内端口（CONTAINER_PORT）
#
# 为什么需要它：Docker 的端口映射在容器创建时就固定下来，容器里的网关看不见
# 也改不了自己的映射表。所以「外面那个端口」只能由宿主机侧改 .env 再重建容器；
# 只改容器内端口而不同步映射，页面就会打不开。
#
# 用法:
#   ./scripts/set-port.sh --host 18081                 # 只改宿主机端口
#   ./scripts/set-port.sh --container 9000             # 只改容器内端口
#   ./scripts/set-port.sh --host 18081 --container 9000
#   ./scripts/set-port.sh --host 18081 --dry-run       # 只看会改成什么，不动文件
#
# 选项:
#   --host N         宿主机端口（1-65535）
#   --container N    容器内端口（1-65535）
#   --env-file PATH  要改的环境文件，默认 ./.env
#   --dry-run        只打印结果，不改文件也不重建容器
#   --no-recreate    只改文件，不重建容器（调试用）
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=".env"
HOST_PORT_ARG=""
CONTAINER_PORT_ARG=""
DRY_RUN=0
RECREATE=1
SERVICE="aiwork"

usage() {
  cat <<'EOF'
用法: scripts/set-port.sh [选项]

  --host N         宿主机端口（1-65535）
  --container N    容器内端口（1-65535）
  --env-file PATH  要改的环境文件，默认 ./.env
  --dry-run        只打印结果，不改文件也不重建容器
  --no-recreate    只改文件，不重建容器（调试用）
  -h, --help       显示这段说明

示例:
  ./scripts/set-port.sh --host 18081
  ./scripts/set-port.sh --container 9000
  ./scripts/set-port.sh --host 18081 --container 9000
EOF
}

die() { printf '错误: %s\n' "$*" >&2; exit 2; }

valid_port() {
  case "${1:-}" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host)
      [ $# -ge 2 ] || die "--host 后面要跟端口号"
      HOST_PORT_ARG="$2"; shift 2 ;;
    --container)
      [ $# -ge 2 ] || die "--container 后面要跟端口号"
      CONTAINER_PORT_ARG="$2"; shift 2 ;;
    --env-file)
      [ $# -ge 2 ] || die "--env-file 后面要跟文件路径"
      ENV_FILE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-recreate) RECREATE=0; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "未知参数 $1（用 --help 看用法）" ;;
  esac
done

[ -n "$HOST_PORT_ARG" ] || [ -n "$CONTAINER_PORT_ARG" ] || die "至少给一个 --host 或 --container"
if [ -n "$HOST_PORT_ARG" ]; then valid_port "$HOST_PORT_ARG" || die "--host 必须是 1-65535 之间的数字"; fi
if [ -n "$CONTAINER_PORT_ARG" ]; then valid_port "$CONTAINER_PORT_ARG" || die "--container 必须是 1-65535 之间的数字"; fi
[ -f "$ENV_FILE" ] || : > "$ENV_FILE"

read_env() {
  local raw
  raw="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  printf '%s' "${raw:-$2}"
}

write_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    $0 ~ "^[[:space:]]*" k "=" { if (!done) { print k "=" v; done = 1 } ; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
}

HOST_PORT="$(read_env HOST_PORT 8080)"
CONTAINER_PORT="$(read_env CONTAINER_PORT 8080)"
[ -n "$HOST_PORT_ARG" ] && HOST_PORT="$HOST_PORT_ARG"
[ -n "$CONTAINER_PORT_ARG" ] && CONTAINER_PORT="$CONTAINER_PORT_ARG"

valid_port "$HOST_PORT" || die "现有的 HOST_PORT=${HOST_PORT} 不是合法端口，请用 --host 指定"
valid_port "$CONTAINER_PORT" || die "现有的 CONTAINER_PORT=${CONTAINER_PORT} 不是合法端口，请用 --container 指定"

if [ "$DRY_RUN" = "1" ]; then
  echo "[预览] 不修改文件、不重建容器"
  echo "HOST_PORT=${HOST_PORT}"
  echo "CONTAINER_PORT=${CONTAINER_PORT}"
  echo "映射: 宿主机 ${HOST_PORT} → 容器 ${CONTAINER_PORT}"
  echo "访问: http://127.0.0.1:${HOST_PORT}"
  exit 0
fi

if [ -n "$HOST_PORT_ARG" ]; then write_env HOST_PORT "$HOST_PORT"; fi
if [ -n "$CONTAINER_PORT_ARG" ]; then write_env CONTAINER_PORT "$CONTAINER_PORT"; fi
echo ">>> 已写入 ${ENV_FILE}: HOST_PORT=${HOST_PORT} CONTAINER_PORT=${CONTAINER_PORT}"

# 容器内的 gateway-config.json 如果固定了端口，会盖过 CONTAINER_PORT 环境变量，
# 重建后仍然监听老端口 —— 映射会静默对不上。这里把端口拿掉，只保留地址。
align_pinned_bind_port() {
  local cid
  cid="$(docker compose ps -q "$SERVICE" 2>/dev/null || true)"
  [ -n "$cid" ] || return 0
  docker exec -e WANT="$CONTAINER_PORT" "$cid" node -e '
    const fs = require("fs");
    const p = "/data/gateway-config.json";
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { process.exit(0); }
    const m = String(cfg.bind_address || "").match(/^(.*):(\d+)$/);
    if (!m || m[2] === process.env.WANT) process.exit(0);
    cfg.bind_address = m[1];
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
    console.log(">>> 配置文件里固定的端口 " + m[2] + " 会盖过 CONTAINER_PORT，已改成只保留地址 " + m[1]);
  ' || true
}

if [ "$RECREATE" != "1" ]; then
  echo ">>> 已跳过容器重建（--no-recreate）"
  exit 0
fi

align_pinned_bind_port

echo ">>> 重建容器..."
docker compose up -d

echo ">>> 等待新端口就绪..."
ready=0
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/healthz" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  printf '错误: 40 秒内 http://127.0.0.1:%s/healthz 没有就绪，看看 docker compose logs --tail 50\n' "$HOST_PORT" >&2
  exit 1
fi

printf '\n完成：宿主机 http://127.0.0.1:%s → 容器内 :%s\n' "$HOST_PORT" "$CONTAINER_PORT"
