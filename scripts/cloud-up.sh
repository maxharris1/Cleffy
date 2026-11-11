#!/usr/bin/env bash
# One command to a fully running local app in a cloud/agent container:
# Docker daemon -> local Supabase (no OMR) -> edge functions + Vite in the
# background. Idempotent: anything already running is left alone.
#
#   npm run cloud:up      # then open http://localhost:5173
#   npm run cloud:down    # stop Vite/functions and the Supabase stack
#
# Logs: /tmp/cleffy-vite.log, /tmp/cleffy-functions.log, /tmp/cleffy-local-up.log

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
BOOT_COMMON_REPO_ROOT="$REPO_ROOT"
# shellcheck source=../.cursor/lib/boot-common.sh
source "$REPO_ROOT/.cursor/lib/boot-common.sh"

log() { echo "[cloud-up] $*"; }
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

if [ "${1:-}" = "--down" ]; then
    pkill -f "vite --host --port 5173" 2>/dev/null || true
    pkill -f "supabase.* functions serve" 2>/dev/null || true
    bash scripts/local-down.sh || true
    log "Stopped."
    exit 0
fi

[ -d node_modules ] || { log "Installing dependencies..."; npm install --no-audit --no-fund --loglevel=error; }

if ! docker info >/dev/null 2>&1; then
    ensure_docker_access || { log "Docker daemon did not start (see /tmp/dockerd.log)." >&2; exit 1; }
fi
log "OK: docker"

API_PORT="$(boot_common_api_port)"
if supabase_running_ok && [ -f .env.local ]; then
    log "OK: Supabase already running on :${API_PORT}"
else
    log "Starting local Supabase (first boot pulls images and applies migrations — several minutes)..."
    if ! bash scripts/local-up.sh --no-omr >/tmp/cleffy-local-up.log 2>&1; then
        tail -30 /tmp/cleffy-local-up.log >&2
        log "local-up failed; full log: /tmp/cleffy-local-up.log" >&2
        exit 1
    fi
    log "OK: Supabase on :${API_PORT}"
fi

if pgrep -f "supabase.* functions serve" >/dev/null; then
    log "OK: edge functions already serving"
else
    nohup npm run functions:serve >/tmp/cleffy-functions.log 2>&1 &
    log "Started edge functions (log: /tmp/cleffy-functions.log)"
fi

if port_open 5173; then
    log "OK: Vite already on :5173"
else
    nohup npm run dev:local >/tmp/cleffy-vite.log 2>&1 &
    for _ in $(seq 1 60); do port_open 5173 && break; sleep 1; done
    port_open 5173 || { tail -20 /tmp/cleffy-vite.log >&2; log "Vite did not come up." >&2; exit 1; }
    log "Started Vite (log: /tmp/cleffy-vite.log)"
fi

cat <<MSG

[cloud-up] Ready.
  App              http://localhost:5173
  API / functions  http://127.0.0.1:${API_PORT}
  Accounts         teacher@cleffy.local / student@cleffy.local  (password: cleffy-local-test)
  UI checks        see .claude/skills/ui-check/SKILL.md (scripts/ui/uifuzz.mjs)
MSG
