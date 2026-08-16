#!/usr/bin/env bash
# Cursor Cloud Agent boot script — local Supabase for Cleffy.
# Runs after `install` (npm ci). Fail-loud: exits non-zero if any step fails
# so Cursor does not mark a broken environment as ready.
#
# Does not start the OMR service and does not touch hosted Supabase.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
BOOT_COMMON_REPO_ROOT="$REPO_ROOT"
# shellcheck source=lib/boot-common.sh
source "$REPO_ROOT/.cursor/lib/boot-common.sh"

failures=()

log() { echo "[cursor-start] $*"; }

record_failure() {
    failures+=("$1")
    log "FAIL: $1"
}

finish_boot() {
    if [ "${#failures[@]}" -gt 0 ]; then
        mark_boot_failed "BOOT FAILED — ${#failures[@]} step(s): ${failures[*]}"
        log "BOOT FAILED — ${#failures[@]} step(s): ${failures[*]}"
        exit 1
    fi
    log "Running infra verification..."
    if run_infra_verification; then
        mark_boot_ok
        log "BOOT OK"
        exit 0
    fi
    record_failure "infra health-check"
    mark_boot_failed "infra health-check did not pass"
    log "BOOT FAILED — infra health check did not pass"
    exit 1
}

mark_boot_in_progress

if ensure_docker_access; then
    log "OK: docker daemon"
else
    record_failure "docker daemon (see /tmp/dockerd.log)"
fi

if boot_stack cold; then
    log "OK: boot_stack cold"
else
    for step in "${BOOT_STACK_FAILURES[@]}"; do
        record_failure "${step}"
    done
    if [ "${#BOOT_STACK_FAILURES[@]}" -eq 0 ]; then
        record_failure "boot_stack cold"
    fi
fi

finish_boot
