#!/usr/bin/env bash
# Block a Cursor terminal command until local Supabase infra is healthy, so
# Vite / edge functions don't start against a not-yet-ready backend.
#
# Used by .cursor/environment.json terminals:
#   bash .cursor/wait-for-stack.sh && npm run dev:local

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
BOOT_COMMON_REPO_ROOT="$REPO_ROOT"
# shellcheck source=lib/boot-common.sh
source "$REPO_ROOT/.cursor/lib/boot-common.sh"

log() { echo "[cursor-wait] $*"; }

TIMEOUT_SECONDS="${WAIT_FOR_STACK_TIMEOUT:-2700}"
INTERVAL_SECONDS="${WAIT_FOR_STACK_INTERVAL:-10}"
HEALTH_LOG="/tmp/cursor-wait-health.log"

deadline=$(($(date +%s) + TIMEOUT_SECONDS))
attempt=0

log "Waiting for cloud dev stack (timeout ${TIMEOUT_SECONDS}s)..."
while :; do
    attempt=$((attempt + 1))

    if boot_ok; then
        log "Boot OK marker present after ${attempt} check(s); proceeding."
        exit 0
    fi

    if bash .cursor/health-check.sh >"$HEALTH_LOG" 2>&1; then
        log "Infra health-check passed after ${attempt} check(s); proceeding."
        exit 0
    fi

    if boot_in_progress; then
        log "Boot in progress (attempt ${attempt}); retrying in ${INTERVAL_SECONDS}s..."
    elif boot_failed; then
        log "Boot failed marker present — proceeding so terminals can start anyway."
        log "Last health check output: ${HEALTH_LOG}"
        exit 0
    else
        log "Stack not ready (attempt ${attempt}); retrying in ${INTERVAL_SECONDS}s..."
    fi

    if [ "$(date +%s)" -ge "$deadline" ]; then
        log "Timed out after ${TIMEOUT_SECONDS}s waiting for stack; starting anyway."
        log "Last health check output: ${HEALTH_LOG}"
        exit 0
    fi

    sleep "$INTERVAL_SECONDS"
done
