#!/usr/bin/env bash
# Slim shared cloud boot helpers for Cleffy.
# Boots local Supabase only — no OMR container, no billing stack.

boot_common_init_repo() {
    if [ -z "${BOOT_COMMON_REPO_ROOT:-}" ]; then
        BOOT_COMMON_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
    fi
    cd "$BOOT_COMMON_REPO_ROOT"
}

boot_common_log() {
    echo "[cursor-boot] $*"
}

# Everything below is scoped to THIS project's containers. A developer machine
# may run several Supabase stacks at once (each `supabase start` names its
# containers supabase_<svc>_<project_id>), so a bare `name=supabase_` filter
# would sweep up someone else's stack.
boot_common_project_id() {
    boot_common_init_repo
    awk -F'"' '/^project_id[[:space:]]*=/{print $2; exit}' supabase/config.toml
}

# The [api] port is the single source of truth for the local stack's URL.
boot_common_api_port() {
    boot_common_init_repo
    awk '/^\[api\]/{f=1;next} /^\[/{f=0} f && /^[[:space:]]*port[[:space:]]*=/{print $3; exit}' supabase/config.toml
}

# Container-name prefix for this project only, e.g. supabase_db_my_project.
boot_common_container() {
    echo "supabase_${1}_$(boot_common_project_id)"
}

# Prefer a CLI already on PATH (brew/scoop); fall back to npx, which is what
# the cloud agent image has. `npx supabase` with no local install re-resolves
# the package on every call.
supabase_cli() {
    if command -v supabase >/dev/null 2>&1; then
        supabase "$@"
    else
        npx --yes supabase "$@"
    fi
}

boot_common_db_container() {
    local want
    want="$(boot_common_container db)"
    docker ps --filter "name=^/${want}$" --format '{{.Names}}' | head -1
}

# Cloud VM sessions may not inherit docker group membership from the Dockerfile.
# chmod on the socket is acceptable in ephemeral single-user cloud VMs only.
ensure_docker_access() {
    boot_common_init_repo
    boot_common_log "Starting Docker daemon..."
    sudo service docker start 2>/dev/null || sudo dockerd >/tmp/dockerd.log 2>&1 &

    if ! docker info >/dev/null 2>&1; then
        boot_common_log "Docker socket not accessible — applying cloud VM socket fix..."
        sudo chmod 666 /var/run/docker.sock 2>/dev/null || true
    fi

    boot_common_log "Waiting for Docker daemon..."
    local attempt
    for attempt in $(seq 1 60); do
        if docker info >/dev/null 2>&1; then
            return 0
        fi
        sleep 2
    done
    return 1
}

supabase_running_ok() {
    boot_common_init_repo
    [ -n "$(boot_common_db_container)" ] || return 1
    npx supabase status >/dev/null 2>&1
}

cleanup_supabase_state() {
    boot_common_init_repo
    boot_common_log "Clearing stale Supabase containers/networks..."
    npx supabase stop --no-backup 2>/dev/null || true
    docker ps -aq --filter "name=supabase_.*_$(boot_common_project_id)$" | xargs -r docker rm -f >/dev/null 2>&1 || true
    docker network ls -q --filter "name=supabase_network_$(boot_common_project_id)$" | xargs -r docker network rm >/dev/null 2>&1 || true
}

remove_stale_compose_containers() {
    local pattern="$1"
    local id status
    while IFS= read -r id; do
        [ -n "$id" ] || continue
        status="$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null || true)"
        if [ "$status" != "running" ]; then
            boot_common_log "Removing stale container id=${id} (pattern=${pattern}, status=${status})"
            docker rm -f "$id" >/dev/null 2>&1 || true
        fi
    done < <(docker ps -aq --filter "name=${pattern}" 2>/dev/null || true)
}

cleanup_stale_stack() {
    boot_common_init_repo
    boot_common_log "Cleaning stale Supabase containers..."
    remove_stale_compose_containers "supabase_.*_$(boot_common_project_id)$"

    if supabase_running_ok; then
        boot_common_log "Supabase healthy — leaving running stack; swept non-running supabase_* only."
    else
        boot_common_log "Supabase not healthy — clearing its stale state."
        cleanup_supabase_state
    fi
}

_supabase_start_once() {
    local log_file="$1"
    npx supabase start >"$log_file" 2>&1
}

start_supabase() {
    boot_common_init_repo
    local log_file attempt
    log_file="$(mktemp /tmp/cursor-supabase-start.XXXXXX)"

    remove_stale_compose_containers supabase_

    if _supabase_start_once "$log_file"; then
        rm -f "$log_file"
        return 0
    fi

    if grep -q 'prune operation is already running' "$log_file" 2>/dev/null; then
        boot_common_log "Supabase start hit Docker prune race — retrying with backoff..."
        for attempt in 1 2 3; do
            sleep 5
            if _supabase_start_once "$log_file"; then
                rm -f "$log_file"
                return 0
            fi
            if ! grep -q 'prune operation is already running' "$log_file" 2>/dev/null; then
                break
            fi
        done
    fi

    boot_common_log "Supabase start failed — clearing stale containers/networks and retrying once..."
    tail -5 "$log_file" 2>/dev/null || true
    cleanup_supabase_state
    sleep 3
    if _supabase_start_once "$log_file"; then
        rm -f "$log_file"
        return 0
    fi
    tail -10 "$log_file" 2>/dev/null || true
    rm -f "$log_file"
    return 1
}

boot_common_env_defaults() {
    LOCAL_SUPABASE_HOST="127.0.0.1"
    # Host that OTHER CONTAINERS use to reach this stack. Edge functions mint
    # signed storage URLs from it and hand them to the OMR container, so on
    # Docker Desktop it must be host.docker.internal — 127.0.0.1 there is the
    # edge-runtime container itself. Defaults to the loopback value so the Linux
    # cloud-agent path is unchanged.
    LOCAL_SUPABASE_INTERNAL_HOST="${LOCAL_SUPABASE_INTERNAL_HOST:-127.0.0.1}"
    LOCAL_SUPABASE_PORT="$(boot_common_api_port)"
    LOCAL_SUPABASE_URL="http://${LOCAL_SUPABASE_HOST}:${LOCAL_SUPABASE_PORT}"
    LOCAL_SUPABASE_INTERNAL_URL="http://${LOCAL_SUPABASE_INTERNAL_HOST}:${LOCAL_SUPABASE_PORT}"
    # Well-known local Supabase demo JWTs (public; only valid against local stack).
    LOCAL_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
    LOCAL_SERVICE_ROLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
}

write_env_files() {
    boot_common_init_repo
    boot_common_env_defaults

    # Write .env.local (not .env) so a checkout's production .env is never clobbered.
    # Vite loads .env.local automatically and overrides .env for the same keys.
    cat > .env.local <<EOF
# Generated by the Cleffy boot scripts (local Supabase only) — do not edit.
# Local demo keys are public defaults; never point these at hosted Supabase.
VITE_SUPABASE_URL=${LOCAL_SUPABASE_URL}
VITE_SUPABASE_ANON_KEY=${LOCAL_ANON_KEY}
EOF

    mkdir -p supabase/functions
    cat > supabase/functions/.env <<EOF
# Generated by the Cleffy boot scripts (local Supabase only) — do not edit.
# Optional secrets (ANTHROPIC_API_KEY, etc.) come from the caller's environment:
# the Cursor Secrets tab in the cloud, or your shell for the local scripts.
# No SUPABASE_* here on purpose: the CLI injects SUPABASE_URL (http://kong:8000),
# ANON_KEY, SERVICE_ROLE_KEY and DB_URL into the edge runtime itself, and refuses
# any SUPABASE_-prefixed name in this file ("Env name cannot start with SUPABASE_").
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
ANALYZE_NOTES_MODEL=${ANALYZE_NOTES_MODEL:-}
# OMR: set by scripts/local-up.sh; left blank in the cloud agent stack.
OMR_SERVICE_URL=${OMR_SERVICE_URL:-}
OMR_SERVICE_SECRET=${OMR_SERVICE_SECRET:-}
OMR_QUEUE_MODE=${OMR_QUEUE_MODE:-push}
EOF
}

ensure_scores_bucket() {
    boot_common_init_repo
    local db_container
    db_container="$(boot_common_db_container)"
    if [ -z "$db_container" ]; then
        return 1
    fi
    docker exec "$db_container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c \
        "insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
         values ('scores', 'scores', false, 52428800, array['application/pdf']::text[])
         on conflict (id) do update set
           public = excluded.public,
           file_size_limit = excluded.file_size_limit,
           allowed_mime_types = excluded.allowed_mime_types;" >/dev/null
}

check_functions_serving() {
    command -v curl >/dev/null 2>&1 || return 1
    local code
    code="$(curl -so /dev/null -w '%{http_code}' "http://127.0.0.1:$(boot_common_api_port)/functions/v1/" 2>/dev/null || true)"
    [ -n "${code}" ] && [ "${code}" != "000" ]
}

# Boot state markers (Cursor start phase ↔ agent session coordination).
CURSOR_BOOT_IN_PROGRESS="/tmp/cursor-boot-in-progress"
CURSOR_BOOT_OK="/tmp/cursor-boot-ok"
CURSOR_BOOT_FAILED="/tmp/cursor-boot-failed"

mark_boot_in_progress() {
    rm -f "$CURSOR_BOOT_OK" "$CURSOR_BOOT_FAILED"
    : >"$CURSOR_BOOT_IN_PROGRESS"
}

mark_boot_ok() {
    rm -f "$CURSOR_BOOT_IN_PROGRESS" "$CURSOR_BOOT_FAILED"
    : >"$CURSOR_BOOT_OK"
}

mark_boot_failed() {
    local msg="${1:-boot failed}"
    rm -f "$CURSOR_BOOT_IN_PROGRESS" "$CURSOR_BOOT_OK"
    printf '%s\n' "$msg" >"$CURSOR_BOOT_FAILED"
}

boot_in_progress() {
    [ -f "$CURSOR_BOOT_IN_PROGRESS" ]
}

boot_ok() {
    [ -f "$CURSOR_BOOT_OK" ]
}

boot_failed() {
    [ -f "$CURSOR_BOOT_FAILED" ]
}

run_infra_verification() {
    boot_common_init_repo
    bash .cursor/health-check.sh
}

BOOT_STACK_FAILURES=()

_boot_stack_record_failure() {
    BOOT_STACK_FAILURES+=("$1")
    boot_common_log "FAIL: $1"
}

_boot_stack_require() {
    local label="$1"
    shift
    if "$@"; then
        boot_common_log "OK: ${label}"
        return 0
    fi
    _boot_stack_record_failure "${label}"
    return 1
}

# Shared stack bring-up for start.sh. Local Supabase only — does not start OMR.
boot_stack() {
    local mode="${1:-cold}"
    local db_container

    boot_common_init_repo
    BOOT_STACK_FAILURES=()
    boot_common_log "boot_stack mode=${mode} (supabase only; OMR skipped)"

    cleanup_stale_stack
    boot_common_log "OK: stale container cleanup"

    write_env_files
    _boot_stack_require "env files" test -f .env.local -a -f supabase/functions/.env

    _boot_stack_require "npx supabase start" start_supabase

    db_container="$(boot_common_db_container)"
    if [ -n "$db_container" ]; then
        _boot_stack_require "scores storage bucket" ensure_scores_bucket
    else
        _boot_stack_record_failure "supabase_db container missing"
    fi

    [ "${#BOOT_STACK_FAILURES[@]}" -eq 0 ]
}
