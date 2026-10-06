#!/usr/bin/env bash
# Renders icon.svg to the PNG sizes the shells use, with headless Chrome. Run
# once after editing the SVG; the PNGs are committed so a build needs nothing.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
for n in 16 32 48 64 128 256 512 1024; do
  printf '<html><body style="margin:0;background:transparent"><img src="icon.svg" width="%s" height="%s"></body></html>' "$n" "$n" > "$HERE/.r.html"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --window-size="$n,$n" --screenshot="$HERE/icon-$n.png" "file://$HERE/.r.html" >/dev/null 2>&1
done
rm -f "$HERE/.r.html"
ls -la "$HERE"/icon-*.png | awk '{print $5, $9}'
