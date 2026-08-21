#!/usr/bin/with-contenv bash
set -e

ROOT=/usr/share/kasmvnc/www
HTML=$ROOT/index.html

grep -q '<title>KasmVNC</title>' "$HTML"
grep -q '<script src=dist/runtime.bundle.js>' "$HTML"
grep -q 'id=noVNC_setting_enable_ime' "$HTML"

CSS='html, body, #noVNC_container {
  background: #fff !important;
  background-image: none !important;
}
#noVNC_transition,
#noVNC_transition_text,
.noVNC_spinner,
.noVNC_logo,
.noVNC_logo a,
a[href*="kasmweb.com"] {
  display: none !important;
}
#noVNC_keyboardinput {
  width: 2px !important;
  height: 2px !important;
  opacity: 0.01 !important;
  overflow: hidden !important;
}'

printf '%s\n' "$CSS" > "$ROOT/gpc-hide.css"
sed -i 's|<title>KasmVNC</title>|<title>GPT Pro</title><link rel="stylesheet" href="gpc-hide.css">|' "$HTML"
sed -i 's|<script src=dist/runtime.bundle.js>|<script type="module" src="/__gpc/admin-browser.js"></script><script src=dist/runtime.bundle.js>|' "$HTML"
