#!/usr/bin/env bash
# AiWork Gateway 容器启动入口 (Bridge-Only)
#
# 遵循 ADR-0001 与 ADR-0005：
# 1) 正式容器为仅桥接层镜像，默认 UPSTREAM=direct 运行纯直连网关
# 2) 官方 CLI 状态目录通过外部挂载接入（推荐只读 :ro 挂载）
# 3) 实验智能体模式（UPSTREAM=agent）需显式开启并依赖外部提供的 CLI 可执行文件
set -euo pipefail

log() { printf '[entrypoint %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

UPSTREAM="${UPSTREAM:-direct}"
DATA_DIR="${GATEWAY_DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

# 清理可能污染容器内出网请求的环境代理变量
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY 2>/dev/null || true

if [ "$UPSTREAM" = "direct" ]; then
  log "以直连模式 (UPSTREAM=direct) 启动 AiWork 桥接网关..."
  log "数据目录: $DATA_DIR | 监听端口: ${PORT:-8080}"
  exec node /app/src/api-bridge.js
elif [ "$UPSTREAM" = "agent" ]; then
  cat <<'EOM'
================================================================================
[WARN] 实验智能体模式已启用 (UPSTREAM=agent)。
       该模式具备通过 CLI 操作文件和执行命令的能力，具有安全副作用。
       请确认在受信任隔离环境中运行，且正式直连实例严禁与智能体实例混用。
================================================================================
EOM
  CLI="${DTCODER_BIN:-aiworkcn}"
  if ! command -v "$CLI" >/dev/null 2>&1 && [ ! -x "$CLI" ]; then
    log "[ERROR] 未检测到可执行的 CLI ($CLI)。"
    log "        正式镜像不内置官方 CLI。若要使用实验智能体模式，请将宿主 CLI 挂载入容器，"
    log "        或将环境变量 UPSTREAM 设为 direct（默认直连模式）。"
    exit 1
  fi
  exec node /app/src/api-bridge.js
else
  log "[ERROR] 未知的 UPSTREAM 模式: $UPSTREAM（仅支持 direct 或 agent）"
  exit 1
fi
