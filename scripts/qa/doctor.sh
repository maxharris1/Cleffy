#!/usr/bin/env bash
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LANE_DIR="${CLEFFY_QA_LANE_DIR:-/tmp/cleffy-qa-lane}"
SETTINGS_DOC="${CLEFFY_QA_SETTINGS_DOC:-$REPO_ROOT/docs/qa-lane.md}"
APP_URL="http://127.0.0.1:5173"
failed=0

settings() { awk '/^```qa-lane-settings$/ {on=1; next} on && /^```/ {exit} on && NF {print $1}' "$SETTINGS_DOC"; }
start_json() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).env?.[process.argv[2]] ?? "")' "$LANE_DIR/start.json" "$1" 2>/dev/null; }
http_code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@" || true; }
report() {
    if [ "$2" = ok ]; then echo "OK $1"; else echo "FAIL $1: $2"; failed=1; fi
}

code="$(http_code "$APP_URL/")"
[ "$code" = 200 ] && report app ok || report app "GET $APP_URL/ returned $code"

if [ -s "$LANE_DIR/start.json" ]; then
    api_url="$(start_json API_URL)"
    code="$(http_code -H "apikey: $(start_json ANON_KEY)" "$api_url/rest/v1/")"
    [ "$code" = 200 ] && report api ok || report api "GET $api_url/rest/v1/ returned $code"
    functions_url="$(cat "$LANE_DIR/functions.url" 2>/dev/null)/functions/v1"
    out="$(curl -s -m 10 -X OPTIONS -w '\n%{http_code}' "$functions_url/imslp-search" || true)"
    code="${out##*$'\n'}"
    body="${out%$'\n'*}"
    body="${body//[$'\r\n']/ }"
    if [[ "$code" == 2[0-9][0-9] ]]; then
        report function ok
    else
        report function "OPTIONS $functions_url/imslp-search returned $code${body:+ ${body:0:300}}"
    fi
else
    report api "no $LANE_DIR/start.json"
    report function "no $LANE_DIR/start.json"
fi

for name in $(settings); do
    [ -n "${!name:-}" ] && report "setting $name" ok || report "setting $name" unset
done

exit "$failed"
