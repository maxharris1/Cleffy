#!/usr/bin/env bash
# Bring up Cleffy's LOCAL Supabase stack on a developer machine (macOS/Linux).
#
#   npm run local:up             # Supabase + local OMR worker
#   npm run local:up -- --no-omr # skip the OMR container
#   npm run local:down           # stop both
#
# Local-only. Never links, reads, or mutates hosted Supabase, and never
# overwrites ./.env — Vite env goes to .env.local, which overrides .env.
#
# Ports come from supabase/config.toml, which deliberately sits on a +100
# offset (54421/54422/...) so this stack coexists with the other Supabase
# stacks on this machine that use the default 5432x block.

set -euo pipefail

# Re-entry guard. Nothing here should ever invoke this script again; if it does,
# fail loudly instead of forking forever.
if [ -n "${CLEFFY_LOCAL_UP_RUNNING:-}" ]; then
    echo "[local-up] REFUSING re-entry (parent pid ${CLEFFY_LOCAL_UP_RUNNING})" >&2
    exit 97
fi
export CLEFFY_LOCAL_UP_RUNNING="$$"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
BOOT_COMMON_REPO_ROOT="$REPO_ROOT"
# shellcheck source=../.cursor/lib/boot-common.sh
source "$REPO_ROOT/.cursor/lib/boot-common.sh"

WITH_OMR=true
for arg in "$@"; do
    case "$arg" in
        --no-omr) WITH_OMR=false ;;
        *) echo "unknown flag: $arg" >&2; exit 2 ;;
    esac
done

log() { echo "[local-up] $*"; }

if ! docker info >/dev/null 2>&1; then
    echo "[local-up] Docker is not running — start Docker Desktop and retry." >&2
    exit 1
fi

API_PORT="$(boot_common_api_port)"
OMR_PORT="${CLEFFY_LOCAL_OMR_PORT:-8091}"

# Shared local-only secret; both sides of the OMR call must agree on it.
export OMR_SERVICE_SECRET="${OMR_SERVICE_SECRET_LOCAL:-cleffy-local-omr-secret}"
export OMR_QUEUE_MODE="push"
if [ "$WITH_OMR" = true ]; then
    # Reached from inside the edge runtime, which shares the Supabase network.
    export OMR_SERVICE_URL="http://cleffy-local-omr:8080"
else
    export OMR_SERVICE_URL=""
fi

# Order matters: `supabase start` boots the edge runtime from
# supabase/functions/.env, so that file has to exist and be valid first.
log "Writing .env.local and supabase/functions/.env..."
write_env_files

log "Starting Supabase (project $(boot_common_project_id), api :${API_PORT})..."
supabase_cli start

if ensure_scores_bucket; then
    log "OK: scores storage bucket"
else
    log "WARN: could not ensure the scores bucket — is the db container up?"
fi

if [ "$WITH_OMR" = true ]; then
    log "Starting local OMR worker on :${OMR_PORT}..."
    boot_common_env_defaults
    CLEFFY_LOCAL_OMR_SECRET="$OMR_SERVICE_SECRET" \
    CLEFFY_LOCAL_SERVICE_ROLE_KEY="$LOCAL_SERVICE_ROLE_KEY" \
    CLEFFY_LOCAL_OMR_PORT="$OMR_PORT" \
    CLEFFY_LOCAL_SUPABASE_NETWORK="supabase_network_$(boot_common_project_id)" \
        docker compose -f docker-compose.local.yml -p cleffy-local up -d
fi

cat <<EOF

[local-up] Ready.
  API / functions  http://127.0.0.1:${API_PORT}
  Studio           http://127.0.0.1:$(awk '/^\[studio\]/{f=1;next} /^\[/{f=0} f && /^[[:space:]]*port[[:space:]]*=/{print $3; exit}' supabase/config.toml)
  Mail (Mailpit)   http://127.0.0.1:$(awk '/^\[local_smtp\]/{f=1;next} /^\[/{f=0} f && /^[[:space:]]*port[[:space:]]*=/{print $3; exit}' supabase/config.toml)
$([ "$WITH_OMR" = true ] && echo "  OMR worker       http://127.0.0.1:${OMR_PORT}/healthz")

  Sign in as teacher@cleffy.local / student@cleffy.local (password: cleffy-local-test)

  Next:  npm run dev:local        # Vite on :5173
         npm run functions:serve  # edge functions
EOF
