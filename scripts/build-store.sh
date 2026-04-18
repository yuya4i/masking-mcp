#!/usr/bin/env bash
# build-store.sh — produce a Chrome Web Store-ready dist/ from the
# shared browser-extension/ source tree.
#
# Pipeline:
#   1. Clean dist/browser-extension-store/ and dist/browser-extension-store.zip.
#   2. Copy browser-extension/ → dist/browser-extension-store/.
#   3. Overwrite manifest.json with manifest.store.json.
#   4. Delete LLM-only engine files (surrogates.js, llm-prompts.js).
#   5. Strip `STORE-STRIP:START … STORE-STRIP:END` blocks from every
#      .js / .html file in the dist — see strip_markers() below.
#   6. Validate the result:
#       - manifest.store.json not present (it's been inlined)
#       - no `http://*/*` permission leaked through
#       - no remaining STORE-STRIP markers
#       - no remaining references to deleted LLM files
#   7. Zip the dist/ for Web Store upload.
#
# Non-goals: minification, tree-shaking, source maps. The extension
# is already small and Chrome accepts readable source.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${REPO_ROOT}/browser-extension"
DIST="${REPO_ROOT}/dist/browser-extension-store"
ZIP="${REPO_ROOT}/dist/browser-extension-store.zip"

say() { printf "  %s\n" "$*"; }
fail() { printf "FAIL: %s\n" "$*" >&2; exit 1; }

# ---------- 1. Clean ----------
say "[1/7] cleaning previous dist"
rm -rf "$DIST" "$ZIP"
mkdir -p "$DIST"

# ---------- 2. Copy ----------
say "[2/7] copying source tree"
cp -r "$SRC/." "$DIST/"

# ---------- 3. Manifest swap ----------
say "[3/7] swapping manifest.json → manifest.store.json"
[ -f "$DIST/manifest.store.json" ] || fail "manifest.store.json missing in source"
mv "$DIST/manifest.store.json" "$DIST/manifest.json"

# ---------- 4. Delete LLM-only engine files ----------
say "[4/7] removing LLM-only engine files"
rm -f "$DIST/engine/llm-prompts.js" "$DIST/engine/surrogates.js"

# ---------- 5. Strip STORE-STRIP blocks ----------
#
# Marker convention:
#   JS:    // STORE-STRIP:START  …  // STORE-STRIP:END
#   HTML:  <!-- STORE-STRIP:START -->  …  <!-- STORE-STRIP:END -->
#
# A file that opens a block without closing it (or vice versa) is a
# bug — we fail rather than silently nuking code. This is critical
# since a rogue unbalanced marker could delete the whole file.
strip_markers() {
  local file="$1"
  local starts ends
  starts=$(grep -c "STORE-STRIP:START" "$file" || true)
  ends=$(grep -c "STORE-STRIP:END" "$file" || true)
  if [ "$starts" -ne "$ends" ]; then
    fail "unbalanced STORE-STRIP markers in $file (starts=$starts, ends=$ends)"
  fi
  [ "$starts" -eq 0 ] && return 0
  # sed -i '/START/,/END/d' — delete every line from START through END
  # inclusive. Works for both JS (// STORE-STRIP:…) and HTML (<!-- … -->)
  # because the marker substring is the same.
  sed -i '/STORE-STRIP:START/,/STORE-STRIP:END/d' "$file"
  say "    stripped $starts block(s) from ${file#$DIST/}"
}

say "[5/7] stripping STORE-STRIP blocks"
while IFS= read -r -d '' f; do
  strip_markers "$f"
done < <(find "$DIST" -type f \( -name "*.js" -o -name "*.html" \) -print0)

# ---------- 6. Validate ----------
say "[6/7] validating result"

# 6a. manifest must no longer contain http://*/*
if grep -q '"http://\*/\*"' "$DIST/manifest.json"; then
  fail "Store manifest still contains http://*/* — edit manifest.store.json"
fi

# 6b. no STORE-STRIP markers remain
leftover=$(grep -rl "STORE-STRIP:" "$DIST" 2>/dev/null || true)
if [ -n "$leftover" ]; then
  fail "STORE-STRIP markers leaked through: $leftover"
fi

# 6c. dev-only manifest file was removed (moved)
if [ -f "$DIST/manifest.store.json" ]; then
  fail "manifest.store.json still present in dist"
fi

# 6d. no references to deleted LLM engine files
for dead in "engine/surrogates.js" "engine/llm-prompts.js"; do
  if grep -rl "$dead" "$DIST" >/dev/null 2>&1; then
    fail "remaining reference to deleted file '$dead' in dist — add STORE-STRIP markers around it"
  fi
done

# 6e. manifest parses as valid JSON
if command -v python3 >/dev/null; then
  python3 -c "import json, sys; json.load(open('$DIST/manifest.json'))" \
    || fail "manifest.json is not valid JSON"
fi

# 6f. every JS file parses (node --check)
if command -v node >/dev/null; then
  while IFS= read -r -d '' f; do
    node --check "$f" >/dev/null 2>&1 \
      || fail "JS syntax error in ${f#$DIST/} after stripping"
  done < <(find "$DIST" -type f -name "*.js" -print0)
fi

# ---------- 7. Zip ----------
say "[7/7] creating zip for Web Store upload"
(cd "$DIST/.." && zip -qr "$(basename "$ZIP")" "$(basename "$DIST")")

size=$(du -h "$ZIP" | cut -f1)
file_count=$(find "$DIST" -type f | wc -l)
say ""
say "✅ Store build ready"
say "   dist:  $DIST"
say "   zip:   $ZIP  ($size, $file_count files)"
say "   Next:  upload zip to Chrome Web Store Developer Dashboard"
