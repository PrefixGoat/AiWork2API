#!/usr/bin/env bash
# 部署后自检：健康检查 + 鉴权 + 真实对话
#   ./scripts/smoke-test.sh                          # 自动用 .env 里的 HOST_PORT（默认 8080）
#   BASE_URL=https://你的域名 ./scripts/smoke-test.sh
set -uo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  ENV_PORT="$(grep '^HOST_PORT=' .env | cut -d= -f2- | tr -d '[:space:]')"
  KEY="$(grep '^API_KEYS=' .env | cut -d= -f2- | cut -d, -f1 | cut -d: -f1 | tr -d '[:space:]')"
else
  ENV_PORT=""; KEY=""
fi
BASE="${BASE_URL:-http://127.0.0.1:${ENV_PORT:-8080}}"

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

echo "目标: $BASE"
[ -n "$KEY" ] || echo "  （.env 里没找到 API_KEYS，鉴权相关项会失败）"

# 1) 健康检查
if curl -fsS --max-time 10 "$BASE/healthz" | grep -q '^ok'; then pass "/healthz"; else fail "/healthz"; fi

# 2) 运行状态与就绪检查
STATUS="$(curl -fsS --max-time 15 "$BASE/status" 2>/dev/null || echo '{}')"
echo "  /status: $STATUS"
case "$STATUS" in
  *'"ready":true'*|*'"status":"ready"'*) pass "网关就绪 (status: ready)" ;;
  *) fail "网关未就绪（查看 /status 或 docker compose logs aiwork）" ;;
esac

# 3) 鉴权必须生效
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/v1/models")"
if [ "$CODE" = "401" ]; then pass "未带 Key 返回 401"; else fail "未带 Key 却返回 $CODE（鉴权没生效？）"; fi

# 4) 带 Key 的模型列表
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H "Authorization: Bearer $KEY" "$BASE/v1/models")"
if [ "$CODE" = "200" ]; then pass "带 Key 取 /v1/models"; else fail "带 Key 取 /v1/models 返回 $CODE"; fi

# 5) 真实对话（会消耗一点额度）
echo "  发起一次真实对话（会消耗少量 token）..."
RESP="$(curl -sS --max-time 180 -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"automodel","messages":[{"role":"user","content":"只回复两个字：可用"}],"stream":false}' 2>&1)"
if echo "$RESP" | grep -qE '"content":"[^"]+'; then
  pass "对话返回: $(echo "$RESP" | sed -n 's/.*"content":"\([^"]*\)".*/\1/p' | head -c 60)"
else
  fail "对话内容为空或失败: $(echo "$RESP" | head -c 220)"
fi

echo
[ "$FAILED" = "0" ] && echo "全部通过 ✓" || { echo "有失败项 ✗"; exit 1; }
