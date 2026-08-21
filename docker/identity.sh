#!/usr/bin/with-contenv bash
set -e

ID_FILE=/config/.gpc-machine-id

if [ ! -s "$ID_FILE" ]; then
    tr -d '-' < /proc/sys/kernel/random/uuid | tr 'A-F' 'a-f' > "$ID_FILE"
fi

MID="$(tr -dc 'a-f0-9' < "$ID_FILE" | head -c 32)"
if [ "${#MID}" -ne 32 ]; then
    echo "machine-id 数据无效" >&2
    exit 1
fi

printf '%s\n' "$MID" > /etc/machine-id
mkdir -p /var/lib/dbus
printf '%s\n' "$MID" > /var/lib/dbus/machine-id
