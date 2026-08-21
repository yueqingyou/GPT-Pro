#!/usr/bin/with-contenv bash
set -e

mkdir -p /config/.config/openbox /config/Desktop /config/chromium
cp /defaults/autostart /config/.config/openbox/autostart
cp /etc/xdg/openbox/rc.xml /config/.config/openbox/rc.xml
chmod +x /config/.config/openbox/autostart

python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path("/config/chromium/Default/Preferences")
path.parent.mkdir(parents=True, exist_ok=True)
preferences = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
download = preferences.setdefault("download", {})
download["default_directory"] = "/transfer/downloads"
download["directory_upgrade"] = True
download["prompt_for_download"] = False
temporary = path.with_suffix(".gpc-tmp")
temporary.write_text(json.dumps(preferences, separators=(",", ":")), encoding="utf-8")
os.chmod(temporary, 0o600)
os.replace(temporary, path)
PY

chown "${PUID:-1000}:${PGID:-1000}" \
    /config/.config/openbox/autostart \
    /config/.config/openbox/rc.xml \
    /config/chromium/Default/Preferences \
    /config/chromium/Default \
    /config/Desktop \
    /config/chromium
