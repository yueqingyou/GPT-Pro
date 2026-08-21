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
mkdir -p data/browser data-panel data-transfer/uploads data-transfer/downloads
docker compose up -d --build --wait
DISPLAY_ADDR="${BIND_ADDR:-127.0.0.1}"
if [ "$DISPLAY_ADDR" = "0.0.0.0" ] || [ "$DISPLAY_ADDR" = "::" ]; then
  DISPLAY_ADDR=127.0.0.1
fi
echo "入口：http://${DISPLAY_ADDR}:${HTTP_PORT:-36090}"
echo "管理：http://${DISPLAY_ADDR}:${HTTP_PORT:-36090}/admin/"
echo "管理员浏览器：http://${MAINTENANCE_BIND_ADDR:-127.0.0.1}:${MAINTENANCE_PORT:-36091}（需先登录管理页）"
if [ -z "${AUTH_PASSWORD:-}" ]; then
  echo "首次访问管理页时会引导创建管理员"
fi
