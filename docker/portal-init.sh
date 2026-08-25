#!/usr/bin/with-contenv bash
set -euo pipefail

install -d -m 0770 -o "${PUID:-1000}" -g "${PGID:-1000}" /run/gpc
