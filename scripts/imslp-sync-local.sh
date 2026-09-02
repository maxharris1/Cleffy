#!/usr/bin/env bash
# Warm the LOCAL IMSLP category index by driving the imslp-sync edge function
# until every taxonomy category has an ok snapshot (~15 min from cold).
#
#   npm run imslp:sync            # loop until done
#   npm run imslp:sync -- --once  # a single tick (one category, up to 50 pages)
#
# Requires `npm run local:up` and `npm run functions:serve` to be running.
# Local-only: talks to the [api] port from supabase/config.toml with the demo
# service-role key; never touches hosted Supabase.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
BOOT_COMMON_REPO_ROOT="$REPO_ROOT"
# shellcheck source=../.cursor/lib/boot-common.sh
source "$REPO_ROOT/.cursor/lib/boot-common.sh"
boot_common_env_defaults

ONCE=false
for arg in "$@"; do
    case "$arg" in
        --once) ONCE=true ;;
        *) echo "unknown flag: $arg" >&2; exit 2 ;;
    esac
done

API="http://127.0.0.1:$(boot_common_api_port)"
DB_CONTAINER="$(boot_common_container db)"
MAX_TICKS=120

log() { echo "[imslp-sync] $*"; }

status_counts() {
    docker exec "$DB_CONTAINER" psql -U postgres -d postgres -Atc \
        "select count(*) filter (where state='ok'), count(*) filter (where state<>'ok') from public.imslp_category_sync;" \
        2>/dev/null | tr '|' ' '
}

tick=0
while :; do
    tick=$((tick + 1))
    out="$(curl -sS -m 300 -X POST "$API/functions/v1/imslp-sync" \
        -H "Authorization: Bearer $LOCAL_SERVICE_ROLE_KEY" \
        -H 'Content-Type: application/json' -d '{}')" || out='{"error":"request failed"}'
    log "tick $tick: $out"

    if [ "$ONCE" = true ]; then
        break
    fi
    if echo "$out" | grep -q '"category":null'; then
        log "nothing left to build"
        break
    fi
    read -r ok not_ok <<<"$(status_counts)"
    if [ -n "${ok:-}" ] && [ "${not_ok:-1}" = "0" ] && [ "$ok" -gt 0 ]; then
        log "all $ok categories ok after $tick ticks"
        break
    fi
    if [ "$tick" -ge "$MAX_TICKS" ]; then
        log "stopping after $MAX_TICKS ticks; run again to continue"
        break
    fi
    sleep 1
done

docker exec "$DB_CONTAINER" psql -U postgres -d postgres -c \
    "select category, state, pages_done, completed_at from public.imslp_category_sync order by completed_at nulls first, category;"
