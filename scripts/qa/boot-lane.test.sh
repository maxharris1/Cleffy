#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
cleanup() {
    local pid
    for pid in $(cat "$tmp/server-pids" "$tmp/children" 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
    for pid in $(cat "$tmp/vite-pids" 2>/dev/null); do kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true; done
    rm -rf "$tmp"
}
trap cleanup EXIT

fail() { echo "FAIL boot-lane.test.sh: $1"; exit 1; }

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

export CLEFFY_QA_LANE_DIR="$tmp/lane"
mkdir -p "$CLEFFY_QA_LANE_DIR/logs"
# shellcheck source=boot-lane.sh
source "$HERE/boot-lane.sh"

broken="$(serve 500 '{"code":"BOOT_ERROR","message":"Error: fixture import failure"}')"
SECONDS=0
status=0
out="$(wait_for "$broken/functions/v1/imslp-search" OPTIONS)" || status=$?
echo "$out"
[ "$status" -ne 0 ] || fail "wait_for succeeded on a 500 BOOT_ERROR"
[ "$SECONDS" -lt 10 ] || fail "wait_for took ${SECONDS}s to give up on a 500"
grep -q BOOT_ERROR <<<"$out" || fail "wait_for output does not show the BOOT_ERROR body"

healthy="$(serve 204)"
wait_for "$healthy/functions/v1/imslp-search" OPTIONS || fail "wait_for failed on a 204"

mkdir -p "$tmp/bin"
cat >"$tmp/bin/npx" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$VITE_SUPABASE_URL" >>"$FAKE_NPX_RECORD"
sleep 300 &
echo "$!" >>"$FAKE_NPX_CHILDREN"
wait
EOF
chmod +x "$tmp/bin/npx"
export PATH="$tmp/bin:$PATH" FAKE_NPX_RECORD="$tmp/record" FAKE_NPX_CHILDREN="$tmp/children"
printf '{"env":{"ANON_KEY":"fixture-anon-key"}}\n' >"$CLEFFY_QA_LANE_DIR/start.json"

await_lines() { for _ in $(seq 1 50); do [ -s "$1" ] && [ "$(wc -l <"$1")" -ge "$2" ] && return 0; sleep 0.1; done; return 1; }

echo "http://127.0.0.1:1111" >"$CLEFFY_QA_LANE_DIR/functions.url"
start_vite
first_vite="$(cat "$CLEFFY_QA_LANE_DIR/vite.pid")"
echo "$first_vite" >>"$tmp/vite-pids"
await_lines "$tmp/children" 1 || fail "first fake vite never started"
first_child="$(sed -n 1p "$tmp/children")"

echo "http://127.0.0.1:2222" >"$CLEFFY_QA_LANE_DIR/functions.url"
start_vite
second_vite="$(cat "$CLEFFY_QA_LANE_DIR/vite.pid")"
echo "$second_vite" >>"$tmp/vite-pids"
await_lines "$tmp/record" 2 || fail "start_vite reused the Vite started against the old functions url"

[ "$(tail -1 "$tmp/record")" = "http://127.0.0.1:2222" ] || fail "latest Vite got VITE_SUPABASE_URL=$(tail -1 "$tmp/record")"
kill -0 "$first_vite" 2>/dev/null && fail "first Vite ($first_vite) still running"
kill -0 "$first_child" 2>/dev/null && fail "first Vite's child ($first_child) still running"
kill -0 "$second_vite" 2>/dev/null || fail "second Vite ($second_vite) is not running"
echo "PASS boot-lane.test.sh"
