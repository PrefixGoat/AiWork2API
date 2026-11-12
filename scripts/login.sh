#!/usr/bin/env bash
# 在容器里执行 AiWork 官方 CLI 设备码交互登录助手
# 适用场景：单账号交互初始化登录。多账号环境可在对应状态目录分别登录，或通过网关管理界面/挂载只读凭据目录管理。
# 用法:
#   ./scripts/login.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo ">>> 即将在容器内启动登录流程"
echo ">>> 终端会打印一个网址 + 设备码，用浏览器打开网址输入设备码即可"
echo

docker compose exec aiwork aiworkcn login "$@"

echo
echo ">>> 登录完成，检查状态："
docker compose exec aiwork aiworkcn auth status --json
