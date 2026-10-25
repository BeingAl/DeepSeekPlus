#!/usr/bin/env bash
#
# Build distributable packages for the DeepSeek Plus (DSP) extension.
#
# Usage:
#   ./pack.sh          create dist/deepseek-plus-v<version>.zip
#                      and, when a Chrome/Chromium binary is found,
#                      dist/deepseek-plus-v<version>.crx (signed)
#
# Outputs:
#   dist/deepseek-plus-v<version>.zip   portable build: unzip, then
#                                       chrome://extensions -> Load unpacked.
#                                       Also the file to upload to the
#                                       Chrome Web Store.
#   dist/deepseek-plus-v<version>.crx   packed/signed extension (same format
#                                       as Chrome's "Pack extension" button).
#   extension-key.pem                   signing key, created on the first
#                                       run and reused afterwards. KEEP IT
#                                       PRIVATE: the same key is required to
#                                       ship updates for the same extension
#                                       ID, so do not lose or share it.
#
# The staging copy in dist/deepseek-plus-v<version>/ is kept after the run
# so it can also be packed manually via the Chrome GUI.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

FILES=(
  manifest.json content.js fonts.js fonts.json
  projects.js popup.html popup.js styles.css
  theme-ayu.css icons
)
KEY="extension-key.pem"

VERSION="$(
  python3 -c 'import json; print(json.load(open("manifest.json"))["version"])'
)"
STAGE_NAME="deepseek-plus-v$VERSION"
STAGE="dist/$STAGE_NAME"
ZIP="dist/$STAGE_NAME.zip"
CRX="dist/$STAGE_NAME.crx"

echo "==> Packing DeepSeek Plus (DSP) v$VERSION"

rm -rf dist
mkdir -p "$STAGE"
for f in "${FILES[@]}"; do
  cp -r "$f" "$STAGE/"
done
find "$STAGE" -name '.DS_Store' -delete

echo "==> Creating $ZIP"
python3 - "$STAGE" "$ZIP" <<'EOF'
import os
import sys
import zipfile

stage, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as bundle:
    for root, _dirs, files in os.walk(stage):
        for name in sorted(files):
            path = os.path.join(root, name)
            bundle.write(path, os.path.relpath(path, "dist"))
EOF

echo "==> Creating $CRX"
CHROME=""
for candidate in google-chrome-stable google-chrome \
  chromium chromium-browser; do
  if command -v "$candidate" >/dev/null 2>&1; then
    CHROME="$candidate"
    break
  fi
done

if [[ -z "$CHROME" ]]; then
  echo "    No Chrome/Chromium binary found; skipping the .crx" \
    "(the .zip is enough)."
else
  KEY_ARGS=()
  if [[ -f "$KEY" ]]; then
    KEY_ARGS=(--pack-extension-key="$ROOT/$KEY")
  fi
  PROFILE="$(mktemp -d)"
  (
    cd dist
    "$CHROME" --no-first-run --user-data-dir="$PROFILE" \
      --pack-extension="$PWD/$STAGE_NAME" "${KEY_ARGS[@]}" \
      >/dev/null 2>&1 || true
  )
  rm -rf "$PROFILE"

  # On the first run Chrome drops a new private key next to the .crx;
  # keep it at the project root so future builds reuse the same identity.
  if [[ -f "dist/$STAGE_NAME.pem" && ! -f "$KEY" ]]; then
    mv "dist/$STAGE_NAME.pem" "$KEY"
    echo "==> Signing key saved to $KEY (keep it private and safe)"
  fi
  rm -f "dist/$STAGE_NAME.pem"

  if [[ -f "$CRX" ]]; then
    echo "==> Created $CRX"
  else
    echo "    CRX creation failed; the .zip is still valid." >&2
  fi
fi

echo "==> Checksums"
sha256sum "$ZIP" || true
[[ -f "$CRX" ]] && sha256sum "$CRX" || true
echo "==> Done. Artifacts are in dist/"
