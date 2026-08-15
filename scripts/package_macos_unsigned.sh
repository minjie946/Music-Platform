#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="$ROOT/frontend"
BUNDLE_DIR="$FRONTEND/src-tauri/target/release/bundle"
MACOS_DIR="$BUNDLE_DIR/macos"
DMG_DIR="$BUNDLE_DIR/dmg"
ZIP_DIR="$BUNDLE_DIR/zip"
APP="$MACOS_DIR/Music Studio.app"
VERSION="$(PACKAGE_JSON="$FRONTEND/package.json" python3 - <<'PY'
import json
import os
from pathlib import Path
print(json.loads(Path(os.environ["PACKAGE_JSON"]).read_text("utf-8"))["version"])
PY
)"
ARCH="$(uname -m)"

cd "$FRONTEND"
npm run desktop:preflight
npm run desktop:runtime
node ../scripts/run_python.mjs ../scripts/run_tauri.py build --bundles app

if [ ! -d "$APP" ]; then
  echo "[mac-package] app bundle not found: $APP" >&2
  exit 1
fi

echo "[mac-package] ad-hoc signing $APP"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

mkdir -p "$ZIP_DIR" "$DMG_DIR"
README="$BUNDLE_DIR/INSTALL_MACOS_UNSIGNED.txt"
cat > "$README" <<'EOF'
Music Studio macOS unsigned build

This build is not Developer ID signed or Apple notarized.
If macOS says the app is damaged or cannot be opened, remove the quarantine flag:

  xattr -dr com.apple.quarantine "/Applications/Music Studio.app"
  open "/Applications/Music Studio.app"

You can also run it in place after extracting:

  xattr -dr com.apple.quarantine "Music Studio.app"
  open "Music Studio.app"

For normal double-click installation without this command, distribute a Developer ID signed and notarized build.
EOF

ZIP="$ZIP_DIR/Music_Studio_${VERSION}_${ARCH}.app.zip"
echo "[mac-package] creating $ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

DMG="$DMG_DIR/Music Studio_${VERSION}_${ARCH}.dmg"
echo "[mac-package] creating $DMG"
rm -f "$DMG"
hdiutil create -volname "Music Studio" -srcfolder "$APP" -ov -format UDZO "$DMG"

echo "[mac-package] done"
