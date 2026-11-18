#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=boot-lane.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/boot-lane.sh"

fail() { echo "FAIL prove-root-boot.sh: $1"; exit 1; }
table() { awk -F'\t' '{ printf "%-16s %8s %s\n", $1, $2, substr($3, 1, 200) }'; }

[ "$(id -u)" = 0 ] || fail "run as root; this proves boot-lane.sh drops from root to $LANE_USER"

for name in $(settings); do export "$name=${!name:-qa-placeholder}"; done

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
bash "$REPO_ROOT/scripts/qa/boot-lane.sh" 2>&1 | tee "$log" || fail "boot-lane.sh exited non-zero"
grep -q '^READY ' "$log" || fail "boot-lane.sh never printed READY"

bash "$REPO_ROOT/scripts/qa/doctor.sh" || fail "doctor.sh exited non-zero"

rows="$(ps -eo user:32=,pid=,args=)"
kept="$(awk '
    { user = $1; pid = $2; sub(/^ *[^ ]+ +[0-9]+ +/, "") }
    tolower($0) ~ /postgres|postgrest|gotrue|supabase|deno|vite/ { printf "%s\t%s\t%s\n", user, pid, $0 }
' <<<"$rows")"

printf '%-16s %8s %s\n' USER PID COMMAND
table <<<"$kept"

awk -F'\t' 'tolower($3) ~ /postgres([^t]|$)/ { found = 1 } END { exit !found }' <<<"$kept" || fail "no postgres process is running"
foreign="$(awk -F'\t' -v user="$LANE_USER" '$1 != user' <<<"$kept")"
if [ -n "$foreign" ]; then
    table <<<"$foreign"
    fail "the processes above do not run as $LANE_USER"
fi
echo "PASS prove-root-boot.sh"
