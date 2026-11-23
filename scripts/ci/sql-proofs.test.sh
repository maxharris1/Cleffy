#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin" "$work/proofs"
cat >"$work/bin/psql" <<'STUB'
#!/usr/bin/env bash
for arg in "$@"; do file="$arg"; done
echo "$(basename "$file")" >>"$RAN_LOG"
if [ "$(basename "$file")" = b_kill.sql ]; then
    pid=$$
    while pid="$(ps -o ppid= -p "$pid" | tr -d ' ')" && [ "$pid" -gt 1 ]; do
        if ps -o args= -p "$pid" | grep -q 'sql-proofs\.sh'; then
            kill -KILL "$pid"
            exit 1
        fi
    done
fi
cat "$file"
STUB
chmod +x "$work/bin/psql"

for name in a_pass cancel_link_save_after_insert c_pass d_pass; do
    printf 'one | t | ok\n0 | 1\n' >"$work/proofs/$name.sql"
done
printf 'one | f | broken\n1 | 1\n' >"$work/proofs/b_fail.sql"

verdicts() { grep -E '^(PASS|FAIL) ' | sed -E 's/ [0-9.]+s$//' | sort; }

for lanes in 1 2; do
    : >"$work/ran.$lanes"
    rc=0
    RAN_LOG="$work/ran.$lanes" PATH="$work/bin:$PATH" \
        bash scripts/ci/sql-proofs.sh db "$lanes" "$work"/proofs/*.sql >"$work/out.$lanes" 2>&1 || rc=$?
    [ "$rc" = 1 ] || { cat "$work/out.$lanes"; echo "lanes=$lanes: exit $rc, want 1"; exit 1; }
    [ "$(sort "$work/ran.$lanes")" = "$(ls "$work/proofs" | sort)" ] || { echo "lanes=$lanes: did not run each proof once"; exit 1; }
    verdicts <"$work/out.$lanes" >"$work/verdicts.$lanes"
done

expected="$(printf 'FAIL b_fail\nPASS a_pass\nPASS c_pass\nPASS cancel_link_save_after_insert\nPASS d_pass\n' | sort)"
[ "$(cat "$work/verdicts.1")" = "$expected" ] || { cat "$work/out.1"; echo "serial verdicts wrong"; exit 1; }
diff "$work/verdicts.1" "$work/verdicts.2" || { echo "lanes verdicts differ from serial"; exit 1; }
grep -q '^lane 2: cancel_link_save_after_insert' "$work/out.2" || { cat "$work/out.2"; echo "cancel_link_save_after_insert not in lane 2"; exit 1; }
grep -q '::error::SQL proofs failed: b_fail' "$work/out.2" || { echo "no failure summary"; exit 1; }
mkdir -p "$work/killed" "$work/dup/x" "$work/dup/y"
for name in a_pass b_kill c_pass; do
    printf 'one | t | ok\n0 | 1\n' >"$work/killed/$name.sql"
done
for lanes in 1 2; do
    rc=0
    RAN_LOG=/dev/null PATH="$work/bin:$PATH" \
        bash scripts/ci/sql-proofs.sh db "$lanes" "$work"/killed/*.sql >"$work/killed.$lanes" 2>&1 || rc=$?
    [ "$rc" = 1 ] || { cat "$work/killed.$lanes"; echo "lanes=$lanes: a killed lane worker exited $rc, want 1"; exit 1; }
    grep -q '^FAIL b_kill ' "$work/killed.$lanes" || { cat "$work/killed.$lanes"; echo "lanes=$lanes: the proof whose worker died is not FAIL"; exit 1; }
    grep -q '^FAIL c_pass ' "$work/killed.$lanes" || { cat "$work/killed.$lanes"; echo "lanes=$lanes: the proof that never ran is not FAIL"; exit 1; }
done

printf 'one | t | ok\n0 | 1\n' >"$work/dup/x/same.sql"
printf 'one | f | broken\n1 | 1\n' >"$work/dup/y/same.sql"
rc=0
RAN_LOG=/dev/null PATH="$work/bin:$PATH" \
    bash scripts/ci/sql-proofs.sh db 1 "$work/dup/x/same.sql" "$work/dup/y/same.sql" >"$work/dup.out" 2>&1 || rc=$?
[ "$rc" = 1 ] || { cat "$work/dup.out"; echo "two proofs sharing a file name: exit $rc, want 1"; exit 1; }
[ "$(grep -cE '^(PASS|FAIL) same ' "$work/dup.out")" = 2 ] || { cat "$work/dup.out"; echo "two proofs sharing a file name did not get a verdict each"; exit 1; }

echo "sql-proofs.sh: serial and two lanes agree, every proof ran once, a failure, a killed worker or a lost result fails the run"
