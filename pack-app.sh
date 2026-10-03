#!/bin/sh
# Pack a generated app directory into a selftest-ready zip.
#
# Usage: sh pack-app.sh <app-dir> [out.zip]
#
# The zip root contains Dockerfile + frontend/ + backend/ (never a wrapper
# folder). frontend/dist and backend/node_modules are prepared first so the
# selftest's offline docker build succeeds without network.
set -e

APP_DIR="${1:?usage: sh pack-app.sh <app-dir> [out.zip]}"
OUT="${2:-$(basename "$APP_DIR").zip}"
APP_DIR="$(cd "$APP_DIR" && pwd)"

# Frontend: build dist if absent (needs local network once).
if [ ! -f "$APP_DIR/frontend/dist/index.html" ]; then
  echo "[pack] building frontend/dist"
  (cd "$APP_DIR/frontend" && npm install --no-audit --no-fund && npm run build)
fi

# Backend: vendor production node_modules if absent (includes sqlite3 binding).
if [ ! -d "$APP_DIR/backend/node_modules" ]; then
  echo "[pack] vendoring backend production deps"
  (cd "$APP_DIR/backend" && npm install --omit=dev --no-audit --no-fund)
fi

# Dockerfile at zip root is mandatory for the selftest channel.
if [ ! -f "$APP_DIR/Dockerfile" ]; then
  echo "[pack] ERROR: $APP_DIR/Dockerfile missing" >&2
  exit 1
fi

echo "[pack] zipping content root -> $OUT"
case "$OUT" in
  /*) OUT_ABS="$OUT" ;;
  *) OUT_ABS="$(pwd)/$OUT" ;;
esac
rm -f "$OUT_ABS"
(cd "$APP_DIR" && zip -r -q "$OUT_ABS" . \
  -x "frontend/node_modules/*" -x ".arc/*" -x ".git/*" -x "*.db" -x "node_modules/.cache/*")

echo "[pack] done: $OUT_ABS ($(wc -c < "$OUT_ABS") bytes)"
