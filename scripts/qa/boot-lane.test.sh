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
mkdir -p "$CLEFFY_QA_LANE_DIR/supabase/functions"
env_file="$CLEFFY_QA_LANE_DIR/supabase/functions/.env"
ANTHROPIC_API_KEY=fixture OMR_SERVICE_URL=https://omr.example OMR_SERVICE_SECRET=fixture OMR_QUEUE_MODE=push \
    write_functions_env >/dev/null
grep -qx 'ANTHROPIC_API_KEY=fixture' "$env_file" || fail "functions env lacks ANTHROPIC_API_KEY"
grep -qx "APP_URL=$APP_URL" "$env_file" || fail "functions env lacks APP_URL"
grep -q '^OMR_' "$env_file" && fail "functions env passes score-scanning settings: $(grep '^OMR_' "$env_file" | cut -d= -f1 | tr '\n' ' ')"
export OMR_SERVICE_URL=https://omr.example OMR_SERVICE_SECRET=fixture OMR_QUEUE_MODE=push

cat >"$tmp/bin/supabase" <<'EOF'
#!/usr/bin/env bash
env | grep '^OMR_' >"$FAKE_SUPABASE_ENV" || true
echo '{}'
EOF
chmod +x "$tmp/bin/supabase"
export FAKE_SUPABASE_ENV="$tmp/supabase-env"
start_supabase
[ -n "${OMR_SERVICE_URL:-}" ] || fail "start_supabase unset OMR_SERVICE_URL in the caller's shell"
[ -s "$FAKE_SUPABASE_ENV" ] && fail "supabase start inherits score-scanning settings: $(cut -d= -f1 "$FAKE_SUPABASE_ENV" | tr '\n' ' ')"

mkdir -p "$CLEFFY_QA_LANE_DIR/supabase/functions/omr-probe"
printf '{}\n' >"$CLEFFY_QA_LANE_DIR/supabase/functions/deno.json"
cat >"$CLEFFY_QA_LANE_DIR/supabase/functions/omr-probe/index.ts" <<'EOF'
Deno.serve(() => Response.json(['OMR_SERVICE_URL', 'OMR_SERVICE_SECRET', 'OMR_QUEUE_MODE'].filter((name) => Deno.env.get(name) !== undefined)));
EOF
printf '{"env":{"API_URL":"http://127.0.0.1:9","ANON_KEY":"fixture-anon-key","SERVICE_ROLE_KEY":"fixture"}}\n' >"$CLEFFY_QA_LANE_DIR/start.json"
start_functions >/dev/null || fail "start_functions did not start the functions server"
cat "$CLEFFY_QA_LANE_DIR/functions.pid" >>"$tmp/vite-pids"
seen="$(curl -s -m 30 "$(cat "$CLEFFY_QA_LANE_DIR/functions.url")/functions/v1/omr-probe")"
[ "$seen" = "[]" ] || fail "edge functions see score-scanning settings: $seen"
echo "PASS boot-lane.test.sh"
