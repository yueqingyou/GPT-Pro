#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ ! -f .env ]; then
  echo "缺少 .env，请先复制 .env.example" >&2
  exit 1
fi
# shellcheck source=/dev/null
set -a && . ./.env && set +a
: "${PUBLIC_HOST:?请在 .env 中设置 PUBLIC_HOST}"
: "${TENCENTCLOUD_SECRET_ID:?请在 .env 中设置 TENCENTCLOUD_SECRET_ID}"
: "${TENCENTCLOUD_SECRET_KEY:?请在 .env 中设置 TENCENTCLOUD_SECRET_KEY}"
mkdir -p data/browser data-panel data-transfer/uploads data-transfer/downloads
docker compose up -d --build --wait
DISPLAY_ADDR="${BIND_ADDR:-127.0.0.1}"
if [ "$DISPLAY_ADDR" = "0.0.0.0" ] || [ "$DISPLAY_ADDR" = "::" ]; then
  DISPLAY_ADDR=127.0.0.1
fi
echo "普通入口：https://${PUBLIC_HOST}"
echo "管理：http://${DISPLAY_ADDR}:${HTTP_PORT:-36090}/admin/"
echo "管理员浏览器：http://127.0.0.1:${MAINTENANCE_PORT:-36091}（需先登录管理页）"
if [ -z "${AUTH_PASSWORD:-}" ]; then
  echo "首次访问管理页时会引导创建管理员"
fi
