#!/usr/bin/env bash
# Stop Cleffy's local stack: the local OMR worker and local Supabase.
# Leaves every other Supabase stack on this machine alone.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
BOOT_COMMON_REPO_ROOT="$REPO_ROOT"
# shellcheck source=../.cursor/lib/boot-common.sh
source "$REPO_ROOT/.cursor/lib/boot-common.sh"

# Compose still interpolates on `down`; these placeholders satisfy the required
# vars without putting anything real on the command line.
CLEFFY_LOCAL_OMR_SECRET=- \
CLEFFY_LOCAL_SUPABASE_URL=- \
CLEFFY_LOCAL_SERVICE_ROLE_KEY=- \
    docker compose -f docker-compose.local.yml -p cleffy-local down 2>/dev/null || true

supabase_cli stop
