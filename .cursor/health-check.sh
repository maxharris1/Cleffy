#!/usr/bin/env bash
# Verify the Cleffy Cursor Cloud Agent stack is running.
# Exit 0 when all required checks pass; exit 1 otherwise.
# Usage: bash .cursor/health-check.sh [--soft|--ready|--ready-infra|--ready-app]
#   (default) infra-only required checks (docker + Supabase API + db + scores bucket).
#   --soft        same required checks, plus app/port probes as WARNINGS.
#   --ready-infra infra + edge functions probe (54321/functions/v1 non-000).
#   --ready-app   infra + Vite port 5173.
#   --ready       infra + edge functions + Vite (full app usable).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
BOOT_COMMON_REPO_ROOT="$REPO_ROOT"
# shellcheck source=lib/boot-common.sh
source "$REPO_ROOT/.cursor/lib/boot-common.sh"

SOFT=false
READY=false
READY_INFRA=false
READY_APP=false
case "${1:-}" in
    --soft) SOFT=true ;;
    --ready) READY=true ;;
    --ready-infra) READY_INFRA=true ;;
    --ready-app) READY_APP=true ;;
esac

failures=()
warnings=()

log() { echo "[cursor-health] $*"; }

require_step() {
    local label="$1"
    shift
    if "$@"; then
        log "OK: ${label}"
    else
        failures+=("${label}")
        log "FAIL: ${label}"
    fi
}

warn_step() {
    local label="$1"
    shift
    if "$@"; then
        log "OK: ${label}"
    else
        warnings+=("${label}")
        log "WARN: ${label}"
    fi
}

check_docker() {
    docker info >/dev/null 2>&1
}

check_supabase_api() {
    local anon_key api_host api_port
    anon_key="$(npx supabase status -o env 2>/dev/null | sed -n 's/^ANON_KEY="\(.*\)"$/\1/p' | head -1)"
    api_host="127.0.0.1"
    api_port="54321"
    if [ -n "${anon_key}" ] && curl -sf "http://${api_host}:${api_port}/rest/v1/" \
        -H "apikey: ${anon_key}" >/dev/null 2>&1; then
        return 0
    fi
    npx supabase status 2>/dev/null | grep -qE '(API URL|Project URL).*54321'
}

check_container_running() {
    local pattern="$1"
    local name
    name="$(docker ps --filter "name=${pattern}" --format '{{.Names}}' | head -1 || true)"
    [ -n "${name}" ] && docker ps --filter "name=${name}" --format '{{.Status}}' | grep -qi 'up'
}

check_scores_bucket() {
    local db_container
    db_container="$(docker ps --filter name=supabase_db --format '{{.Names}}' | head -1 || true)"
    [ -n "${db_container}" ] || return 1
    docker exec "$db_container" psql -U postgres -d postgres -tAc \
        "select 1 from storage.buckets where id = 'scores'" 2>/dev/null | grep -q 1
}

check_port_open() {
    local port="$1"
    if command -v nc >/dev/null 2>&1; then
        nc -z 127.0.0.1 "${port}" >/dev/null 2>&1
    elif command -v curl >/dev/null 2>&1; then
        curl -sf "http://127.0.0.1:${port}/" >/dev/null 2>&1
    else
        return 1
    fi
}

log "Checking cloud dev stack..."

ensure_docker_access >/dev/null 2>&1 || true
require_step "docker daemon" check_docker
require_step "supabase API (54321)" check_supabase_api
require_step "container supabase_db" check_container_running supabase_db
require_step "scores storage bucket" check_scores_bucket

if [ "$SOFT" = true ]; then
    warn_step "port 5173 (vite)" check_port_open 5173
    warn_step "edge functions (54321/functions/v1)" check_functions_serving
fi

if [ "$READY" = true ] || [ "$READY_INFRA" = true ]; then
    require_step "edge functions (54321/functions/v1)" check_functions_serving
fi

if [ "$READY" = true ] || [ "$READY_APP" = true ]; then
    require_step "port 5173 (vite)" check_port_open 5173
fi

if [ "${#warnings[@]}" -gt 0 ]; then
    log "Warnings: ${warnings[*]}"
fi

if [ "${#failures[@]}" -gt 0 ]; then
    log "FAILED checks: ${failures[*]}"
    exit 1
fi

log "All required checks passed."
exit 0
