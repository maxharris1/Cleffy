#!/usr/bin/env bash
# Stop what boot-lane.sh started, then boot again. See docs/qa-lane.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LANE_DIR="${CLEFFY_QA_LANE_DIR:-/tmp/cleffy-qa-lane}"
LANE_USER="${CLEFFY_QA_USER:-cleffy-qa}"

as_lane_user() {
    if [ "$(id -u)" = 0 ] && id -u "$LANE_USER" >/dev/null 2>&1; then
        runuser -u "$LANE_USER" -- env "HOME=$(getent passwd "$LANE_USER" | cut -d: -f6)" "PATH=$PATH" "$@"
    else
        "$@"
    fi
}

if [ -s "$LANE_DIR/vite.pid" ]; then
    kill -- "-$(cat "$LANE_DIR/vite.pid")" 2>/dev/null || kill "$(cat "$LANE_DIR/vite.pid")" 2>/dev/null || true
    rm -f "$LANE_DIR/vite.pid"
fi
if [ -d "$LANE_DIR/supabase" ]; then
    as_lane_user env SUPABASE_EXPERIMENTAL_STACK=1 supabase stop --workdir "$LANE_DIR" || true
fi
rm -f "$LANE_DIR/start.json"
exec bash "$REPO_ROOT/scripts/qa/boot-lane.sh"
