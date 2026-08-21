#!/usr/bin/with-contenv bash
set -e
RAW="${PROXY_URL:-}"
RAW="$(printf '%s' "$RAW" | sed -E 's#^([a-zA-Z][a-zA-Z0-9+.-]*://([^/@]*@)?)(127\.0\.0\.1|localhost|\[::1\])([:/]|$)#\1host.docker.internal\4#')"
RAW="$(printf '%s' "$RAW" | sed -E 's#^(127\.0\.0\.1|localhost|\[::1\])(:|$)#host.docker.internal\2#')"

PROXY_OUT=/config/.gpc-proxy
START_OUT=/config/.gpc-start-url
printf '%s\n' "$RAW" > "$PROXY_OUT"
printf '%s\n' "${START_URL:-https://chatgpt.com}" > "$START_OUT"
chmod 600 "$PROXY_OUT" "$START_OUT"
chown "${PUID:-1000}:${PGID:-1000}" "$PROXY_OUT" "$START_OUT"
