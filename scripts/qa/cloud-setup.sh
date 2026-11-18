#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_VERSION=3.2.0
DENO_VERSION=2.7.14
cd "$REPO_ROOT"

echo "[cloud-setup] npm ci"
npm ci --no-audit --no-fund

echo "[cloud-setup] playwright chromium"
if [ "$(id -u)" = 0 ]; then npx playwright install --with-deps chromium; else npx playwright install chromium; fi

install_cli() {
    local name="$1" version="$2"
    if "$name" --version 2>/dev/null | grep -w "$version" >/dev/null; then
        echo "[cloud-setup] $name $version already installed"
    elif npm i -g "$name@$version"; then
        echo "[cloud-setup] $name $version installed"
    else
        npm i -g --prefix "$HOME/.local" "$name@$version"
        echo "[cloud-setup] $name $version installed in $HOME/.local/bin; put it on PATH"
    fi
}

install_cli supabase "$SUPABASE_VERSION"
install_cli deno "$DENO_VERSION"
