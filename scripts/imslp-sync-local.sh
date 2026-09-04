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

# Categories with an ok snapshot right now, one per line. A category the picker
# has not started yet has no row at all, so row counts cannot tell "done".
ok_categories() {
    docker exec "$DB_CONTAINER" psql -U postgres -d postgres -Atc \
        "select category from public.imslp_category_sync where state = 'ok' and active_generation > 0;" 2>/dev/null
}

tick=0
while :; do
    tick=$((tick + 1))
    before="$(ok_categories)"
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
    category="$(printf '%s' "$out" | sed -n 's/.*"category":"\([^"]*\)".*/\1/p')"
    # The picker only revisits an ok category once every category has one:
    # that first refresh tick means the index is complete.
    if [ -n "$category" ] && printf '%s\n' "$before" | grep -qxF -- "$category"; then
        log "index complete after $((tick - 1)) build ticks (tick $tick refreshed '$category')"
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
