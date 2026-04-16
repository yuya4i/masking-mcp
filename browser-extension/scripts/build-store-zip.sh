#!/usr/bin/env bash
# Build the Chrome Web Store submission zip.
# Excludes dev-only files (markdown, scripts/, tests, etc.)
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')"
OUT="../pii-guard-v${VERSION}.zip"

rm -f "$OUT"

zip -r "$OUT" . \
  -x "*.md" \
  -x "scripts/*" \
  -x "test-*" \
  -x ".pytest_cache/*" \
  -x "engine/__pycache__/*" \
  -x ".playwright-mcp/*" \
  -x "*.pyc"

echo
echo "✓ Built: $OUT"
echo "  Size: $(du -h "$OUT" | awk '{print $1}')"
echo "  Files: $(unzip -l "$OUT" | tail -1 | awk '{print $2}')"
echo
echo "Upload at: https://chrome.google.com/webstore/devconsole"
