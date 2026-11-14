#!/usr/bin/env bash
# Build a Chrome Web Store-ready zip of the extension.
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(grep -oP '"version":\s*"\K[^"]+' manifest.json)
OUT="outlier-v${VERSION}.zip"
rm -f "$OUT"
zip -r "$OUT" manifest.json content.js panel.css popup.html icons/ >/dev/null
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
