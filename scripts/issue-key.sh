#!/usr/bin/env bash
# 生成一个新的 API Key 并写进 .env（给某个调用方用）
#   ./scripts/issue-key.sh 平台A
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="${1:-client}"
[ -f .env ] || { echo "缺少 .env，先执行：cp .env.example .env"; exit 1; }

# 生成 32 字节随机十六进制
if command -v openssl >/dev/null 2>&1; then
  RAND="$(openssl rand -hex 16)"
else
  RAND="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
KEY="sk-${RAND}"

if grep -q '^API_KEYS=' .env; then
  CURRENT="$(grep '^API_KEYS=' .env | cut -d= -f2-)"
  if [ -z "$CURRENT" ] || [ "$CURRENT" = "sk-change-me-please:default" ]; then
    sed -i "s|^API_KEYS=.*|API_KEYS=${KEY}:${NAME}|" .env
  else
    sed -i "s|^API_KEYS=.*|API_KEYS=${CURRENT},${KEY}:${NAME}|" .env
  fi
else
  printf '\nAPI_KEYS=%s:%s\n' "$KEY" "$NAME" >> .env
fi

echo "已签发（名称: ${NAME}）"
echo
echo "  ${KEY}"
echo
echo "已写入 .env。让配置生效："
echo "  docker compose up -d"
echo
echo "调用示例："
echo "  curl ${BASE_URL:-https://你的域名}/v1/chat/completions \\"
echo "    -H 'Authorization: Bearer ${KEY}' \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"model\":\"automodel\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}'"
