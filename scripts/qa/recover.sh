#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/boot-lane.sh"

as_lane_user() {
    if [ "$(id -u)" = 0 ] && id -u "$LANE_USER" >/dev/null 2>&1; then
        runuser -u "$LANE_USER" -- env "HOME=$(getent passwd "$LANE_USER" | cut -d: -f6)" "PATH=$PATH" "$@"
    else
        "$@"
    fi
}

stop_pidfile "$LANE_DIR/vite.pid"
stop_pidfile "$LANE_DIR/functions.pid"
if [ -d "$LANE_DIR/supabase" ]; then
    as_lane_user env SUPABASE_EXPERIMENTAL_STACK=1 supabase stop --workdir "$LANE_DIR" || true
fi
rm -f "$LANE_DIR/start.json"
exec bash "$REPO_ROOT/scripts/qa/boot-lane.sh"
