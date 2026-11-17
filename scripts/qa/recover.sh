#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LANE_DIR="${CLEFFY_QA_LANE_DIR:-/tmp/cleffy-qa-lane}"
LANE_USER="${CLEFFY_QA_USER:-cleffy-qa}"
LANG="$(locale -a 2>/dev/null | awk 'tolower($0) ~ /^(c|en_us)\.utf-?8$/ && !found { found = $0 } END { print found ? found : "C.UTF-8" }')"
export LANG LC_ALL="$LANG"

as_lane_user() {
    if [ "$(id -u)" = 0 ] && id -u "$LANE_USER" >/dev/null 2>&1; then
        runuser -u "$LANE_USER" -- env "HOME=$(getent passwd "$LANE_USER" | cut -d: -f6)" "PATH=$PATH" "$@"
    else
        "$@"
    fi
}

for pidfile in "$LANE_DIR/vite.pid" "$LANE_DIR/functions.pid"; do
    [ -s "$pidfile" ] || continue
    kill -- "-$(cat "$pidfile")" 2>/dev/null || kill "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
done
if [ -d "$LANE_DIR/supabase" ]; then
    as_lane_user env SUPABASE_EXPERIMENTAL_STACK=1 supabase stop --workdir "$LANE_DIR" || true
fi
rm -f "$LANE_DIR/start.json"
exec bash "$REPO_ROOT/scripts/qa/boot-lane.sh"
