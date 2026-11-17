#!/usr/bin/env bash
# Run once when a QA lane image is built. Installs only; starts nothing.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_VERSION=3.2.0
cd "$REPO_ROOT"

echo "[cloud-setup] npm ci"
npm ci --no-audit --no-fund

echo "[cloud-setup] playwright chromium"
if [ "$(id -u)" = 0 ]; then npx playwright install --with-deps chromium; else npx playwright install chromium; fi

if [ "$(supabase --version 2>/dev/null || true)" = "$SUPABASE_VERSION" ]; then
    echo "[cloud-setup] supabase $SUPABASE_VERSION already installed"
elif npm i -g "supabase@$SUPABASE_VERSION"; then
    echo "[cloud-setup] supabase $SUPABASE_VERSION installed"
else
    npm i -g --prefix "$HOME/.local" "supabase@$SUPABASE_VERSION"
    echo "[cloud-setup] supabase $SUPABASE_VERSION installed in $HOME/.local/bin; put it on PATH"
fi
