#!/usr/bin/env bash
# Boot Cleffy without Docker for a QA lane. Prints `READY <app url> <api url>`.
# See docs/qa-lane.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LANE_DIR="${CLEFFY_QA_LANE_DIR:-/tmp/cleffy-qa-lane}"
LANE_USER="${CLEFFY_QA_USER:-cleffy-qa}"
APP_URL="http://127.0.0.1:5173"
SETTINGS_DOC="${CLEFFY_QA_SETTINGS_DOC:-$REPO_ROOT/docs/qa-lane.md}"

LANG="$(locale -a 2>/dev/null | awk 'tolower($0) ~ /^(c|en_us)\.utf-?8$/ && !found { found = $0 } END { print found ? found : "C.UTF-8" }')"
export LANG LC_ALL="$LANG"

settings() { awk '/^```qa-lane-settings$/ {on=1; next} on && /^```/ {exit} on && NF {print $1}' "$SETTINGS_DOC"; }

run_step() {
    local name="$1"; shift
    local log="$LANE_DIR/logs/$name.log"
    echo "[boot-lane] $name"
    if ! "$@" >"$log" 2>&1; then
        echo "FAILED $name (log: $log)" >&2
        tail -30 "$log" >&2
        exit 1
    fi
}

wait_for() {
    local url="$1" method="$2" accept="$3" code
    for _ in $(seq 1 90); do
        code="$(curl -s -o /dev/null -m 5 -X "$method" -w '%{http_code}' "$url" || true)"
        if [[ "$code" =~ $accept ]]; then echo "$url answered $code"; return 0; fi
        sleep 1
    done
    echo "$url did not answer (last code: ${code:-none})"
    return 1
}

start_json() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).env[process.argv[2]] ?? "")' "$LANE_DIR/start.json" "$1"; }

reexec_as_lane_user() {
    id -u "$LANE_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$LANE_USER"
    mkdir -p "$LANE_DIR"
    chown -R "$LANE_USER" "$LANE_DIR" "$REPO_ROOT"
    local home; home="$(getent passwd "$LANE_USER" | cut -d: -f6)"
    local -a keep=("PATH=$PATH" "HOME=$home" "USER=$LANE_USER" "CLEFFY_QA_LANE_DIR=$LANE_DIR")
    local name
    for name in $(settings) NODE_EXTRA_CA_CERTS SSL_CERT_FILE HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy; do
        [ -n "${!name:-}" ] && keep+=("$name=${!name}")
    done
    exec runuser -u "$LANE_USER" -- env -i "${keep[@]}" bash "$REPO_ROOT/scripts/qa/boot-lane.sh"
}

write_config() {
    rm -rf "$LANE_DIR/supabase"
    cp -r "$REPO_ROOT/supabase" "$LANE_DIR/supabase"
    rm -f "$LANE_DIR/supabase/supabase.lock" "$LANE_DIR/supabase/functions/.env"
    awk '
        /^\[remotes\./ { exit }
        /^\[/ { section = $0 }
        (section == "[api]" || section == "[db]" || section == "[studio]" || section == "[local_smtp]") && /^(port|shadow_port) *=/ { next }
        /^inspector_port *=/ { next }
        { print }
    ' "$REPO_ROOT/supabase/config.toml" >"$LANE_DIR/supabase/config.toml"
    diff "$REPO_ROOT/supabase/config.toml" "$LANE_DIR/supabase/config.toml" || true
}

start_supabase() {
    SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime native --output-format json --workdir "$LANE_DIR" >"$LANE_DIR/start.json"
}

write_functions_env() {
    local env_file="$LANE_DIR/supabase/functions/.env" name cert=""
    : >"$env_file"
    chmod 600 "$env_file"
    for name in $(settings); do
        [ -n "${!name:-}" ] && printf '%s=%s\n' "$name" "${!name}" >>"$env_file"
    done
    printf 'OMR_QUEUE_MODE=push\nAPP_URL=%s\n' "$APP_URL" >>"$env_file"
    for name in NODE_EXTRA_CA_CERTS SSL_CERT_FILE; do
        if [ -n "${!name:-}" ] && [ -f "${!name}" ]; then cert="${!name}"; break; fi
    done
    [ -n "$cert" ] && printf 'DENO_CERT=%s\n' "$cert" >>"$env_file"
    echo "wrote $(wc -l <"$env_file") names to $env_file"
}

detach() {
    if command -v setsid >/dev/null; then exec setsid nohup "$@"; else exec nohup "$@"; fi
}

start_functions() {
    [ -s "$LANE_DIR/functions.pid" ] && kill "$(cat "$LANE_DIR/functions.pid")" 2>/dev/null || true
    rm -f "$LANE_DIR/functions.url"
    (SUPABASE_URL="$(start_json API_URL)" SUPABASE_ANON_KEY="$(start_json ANON_KEY)" \
        SUPABASE_SERVICE_ROLE_KEY="$(start_json SERVICE_ROLE_KEY)" \
        detach deno run -A --env-file="$LANE_DIR/supabase/functions/.env" \
        --config "$LANE_DIR/supabase/functions/deno.json" "$REPO_ROOT/scripts/qa/functions-server.ts" \
        "$LANE_DIR/supabase/functions" "$(start_json API_URL)" "$LANE_DIR/functions.url" \
        >"$LANE_DIR/logs/functions-server.log" 2>&1 </dev/null &
        echo $! >"$LANE_DIR/functions.pid")
    for _ in $(seq 1 30); do [ -s "$LANE_DIR/functions.url" ] && cat "$LANE_DIR/functions.url" && return 0; sleep 1; done
    cat "$LANE_DIR/logs/functions-server.log"
    return 1
}

start_vite() {
    [ -s "$LANE_DIR/vite.pid" ] && kill -0 "$(cat "$LANE_DIR/vite.pid")" 2>/dev/null && return 0
    (cd "$REPO_ROOT" && VITE_SUPABASE_URL="$(cat "$LANE_DIR/functions.url")" VITE_SUPABASE_ANON_KEY="$(start_json ANON_KEY)" \
        detach npx vite --host 127.0.0.1 --port 5173 --strictPort >"$LANE_DIR/logs/vite-server.log" 2>&1 </dev/null &
        echo $! >"$LANE_DIR/vite.pid")
}

if [ "$(id -u)" = 0 ]; then
    reexec_as_lane_user
fi

mkdir -p "$LANE_DIR/logs"

if [ -s "$LANE_DIR/start.json" ] && bash "$REPO_ROOT/scripts/qa/doctor.sh" >/dev/null 2>&1; then
    echo "READY $APP_URL $(start_json API_URL)"
    exit 0
fi

run_step config write_config
run_step supabase start_supabase
run_step env write_functions_env
run_step functions-start start_functions
run_step functions wait_for "$(cat "$LANE_DIR/functions.url")/functions/v1/imslp-search" OPTIONS '^(2..|3..|4[0-35-9].|5..)$'
run_step vite-start start_vite
run_step vite wait_for "$APP_URL/" GET '^200$'
echo "READY $APP_URL $(start_json API_URL)"
