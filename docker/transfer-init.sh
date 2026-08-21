#!/usr/bin/with-contenv bash
set -e

mkdir -p /transfer/uploads /transfer/downloads
chown "${PUID:-1000}:${PGID:-1000}" /transfer /transfer/uploads /transfer/downloads
chmod 700 /transfer /transfer/uploads /transfer/downloads
