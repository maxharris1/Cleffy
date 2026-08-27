#!/usr/bin/env bash
# Thin wrapper: use the Supabase CLI already on PATH (brew/scoop) when present,
# otherwise fall back to npx, which is what the Cursor cloud image has.
# `npx supabase` with no local install re-resolves the package on every call.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOT_COMMON_REPO_ROOT="$REPO_ROOT"
# shellcheck source=../.cursor/lib/boot-common.sh
source "$REPO_ROOT/.cursor/lib/boot-common.sh"
cd "$REPO_ROOT"
supabase_cli "$@"
