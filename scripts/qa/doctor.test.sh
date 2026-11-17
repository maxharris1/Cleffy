#!/usr/bin/env bash
set -euo pipefail

DOCTOR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/doctor.sh"
tmp="$(mktemp -d)"
cleanup() {
    local pid
    for pid in $(cat "$tmp/server-pids" 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
    rm -rf "$tmp"
}
trap cleanup EXIT
printf '```qa-lane-settings\nQA_TEST_ALPHA\nQA_TEST_BETA\n```\n' >"$tmp/doc.md"

fail() { echo "FAIL doctor.test.sh: $1"; exit 1; }

status=0
out="$(env -u QA_TEST_BETA QA_TEST_ALPHA=placeholder CLEFFY_QA_SETTINGS_DOC="$tmp/doc.md" CLEFFY_QA_LANE_DIR="$tmp/lane" bash "$DOCTOR")" || status=$?
echo "$out"
[ "$status" -ne 0 ] || fail "doctor.sh exited 0 with QA_TEST_BETA unset"
grep -qx 'FAIL setting QA_TEST_BETA: unset' <<<"$out" || fail "no FAIL line naming QA_TEST_BETA"
grep -qx 'OK setting QA_TEST_ALPHA' <<<"$out" || fail "no OK line for QA_TEST_ALPHA"
grep -q placeholder <<<"$out" && fail "doctor.sh printed a setting's value"

serve() {
    local port_file="$tmp/port.$RANDOM"
    node -e '
        const [code, body] = process.argv.slice(1);
        require("http").createServer((req, res) => { res.writeHead(Number(code)); res.end(body); })
            .listen(0, "127.0.0.1", function () { console.log(this.address().port); });
    ' "$1" "${2:-}" >"$port_file" &
    echo "$!" >>"$tmp/server-pids"
    for _ in $(seq 1 50); do [ -s "$port_file" ] && break; sleep 0.1; done
    echo "http://127.0.0.1:$(cat "$port_file")"
}

mkdir -p "$tmp/lane"
printf '{"env":{"API_URL":"%s","ANON_KEY":"fixture-anon-key"}}\n' "$(serve 200)" >"$tmp/lane/start.json"
run_lane_doctor() { env CLEFFY_QA_SETTINGS_DOC="$tmp/doc.md" CLEFFY_QA_LANE_DIR="$tmp/lane" QA_TEST_ALPHA=x QA_TEST_BETA=x bash "$DOCTOR"; }

serve 500 '{"code":"BOOT_ERROR","message":"Error: fixture import failure"}' >"$tmp/lane/functions.url"
status=0
out="$(run_lane_doctor)" || status=$?
echo "$out"
[ "$status" -ne 0 ] || fail "doctor.sh exited 0 with a function answering 500 BOOT_ERROR"
grep -qx 'OK api' <<<"$out" || fail "no OK line for the fake API"
grep -q '^FAIL function: .*BOOT_ERROR' <<<"$out" || fail "no FAIL function line showing BOOT_ERROR"

serve 204 >"$tmp/lane/functions.url"
out="$(run_lane_doctor)" || true
echo "$out"
grep -qx 'OK function' <<<"$out" || fail "no OK function line with a function answering 204"
echo "PASS doctor.test.sh"
