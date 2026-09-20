#!/usr/bin/env bash
# build-backend.sh - freeze the Python backend into src-tauri/backend/ on macOS/Linux.
# (The Windows equivalent is build-backend.ps1.)
#
# The Tauri shell bundles that whole folder as a resource and spawns
# backend/braindump-backend as a sidecar. Run this before
#   npm run tauri dev     (try the native app locally)
#   npm run tauri build   (make the .app / .dmg)
# CI runs it too (.github/workflows/release.yml).
#
#   ./build-backend.sh            # with voice (faster-whisper), if it installs
#   ./build-backend.sh --no-voice # smaller, no mic button
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"
if [ ! -d .venv ]; then
  echo "Creating venv..."
  "$PYTHON" -m venv .venv
fi
PY=".venv/bin/python"

echo "Installing dependencies..."
"$PY" -m pip install --disable-pip-version-check -r requirements.txt pyinstaller

VOICE_OK=0
if [ "${1:-}" != "--no-voice" ]; then
  # Voice is optional: if faster-whisper has no wheel for this Python/arch yet, build without it.
  "$PY" -m pip install --disable-pip-version-check -r requirements-voice.txt || echo "warning: voice dependencies did not install"
  if "$PY" -c "import faster_whisper" 2>/dev/null; then VOICE_OK=1; else echo "warning: faster-whisper unavailable - building WITHOUT voice"; fi
fi

ARGS=(--noconfirm --clean --onedir --name braindump-backend --distpath src-tauri --workpath build
      --add-data "app:app" --add-data "static:static" --add-data "CHANGELOG.md:." --add-data "catalog:catalog" --add-data "examples:examples")
if [ "$VOICE_OK" = 1 ]; then
  ARGS+=(--collect-all faster_whisper --collect-all ctranslate2 --collect-all av)
fi
ARGS+=(run.py)

VERSION=$("$PY" -c "from app.version import __version__; print(__version__)")
echo "Running PyInstaller v$VERSION (a few minutes)..."
rm -rf src-tauri/backend
.venv/bin/pyinstaller "${ARGS[@]}"
mv src-tauri/braindump-backend src-tauri/backend

# Fail here, not after a 20-minute app build, if the frozen backend can't run at all.
test -x src-tauri/backend/braindump-backend
echo "Done -> src-tauri/backend/braindump-backend ($(du -sm src-tauri/backend | cut -f1) MB, voice=$VOICE_OK)"
