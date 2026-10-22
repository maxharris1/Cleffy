#!/usr/bin/env bash
# Run one SQL proof against a database and fail unless every check in it
# passed. psql stopping on an error fails too. The proofs end their result
# table in one of two ways, and both are read:
#
#   failures | total               (tests/sql/checkout_consents.sql and most)
#   | ALL n CHECKS PASSED | t |    (the column_integrity.sql harness), or
#   | k OF n CHECKS FAILED | f |
#
#   bash scripts/ci/sql-proof.sh "$DB_URL" tests/sql/cancel_link_lifetime.sql
#
# Any failing check fails the proof: there is no list of tolerated failures.
# Nor is the summary's count taken on trust: a `failures | total` proof must
# print exactly `total` check rows (and `failures` of them failing), and the
# harness, which prints only its failing rows, exactly `k` of them.
# CI's supabase-local job runs this against the LOCAL stack only.
set -euo pipefail

db="$1"
proof="$2"

out="$(psql "$db" -v ON_ERROR_STOP=1 -q -t -A -F ' | ' -f "$proof")"
printf '%s\n' "$out"

summary="$(printf '%s\n' "$out" | sed '/^[[:space:]]*$/d' | tail -1)"
if [[ "$summary" =~ ALL\ ([0-9]+)\ CHECKS\ PASSED ]]; then
    failures=0
    total="${BASH_REMATCH[1]}"
    shape=harness
elif [[ "$summary" =~ ([0-9]+)\ OF\ ([0-9]+)\ CHECKS\ FAILED ]]; then
    failures="${BASH_REMATCH[1]}"
    total="${BASH_REMATCH[2]}"
    shape=harness
elif [[ "$summary" =~ ^([0-9]+)\ \|\ ([0-9]+)$ ]]; then
    failures="${BASH_REMATCH[1]}"
    total="${BASH_REMATCH[2]}"
    shape=table
else
    echo "::error file=${proof}::${proof} printed no summary this script can read (last line: ${summary})"
    exit 1
fi

if ! [[ "$total" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error file=${proof}::${proof} ran no checks (failures | total: ${failures} | ${total})"
    exit 1
fi

# The rows above the summary that report a check: `name | t | detail`, with a
# leading number column in the harness (`22 | name | f | detail`). A detail
# running over several lines adds lines that carry no verdict.
above="$(printf '%s\n' "$out" | sed '/^[[:space:]]*$/d' | sed '$d')"
check_rows="$(printf '%s\n' "$above" | { grep -E '\| [tf]( \||$)' || true; })"
failing_rows="$(printf '%s\n' "$above" | { grep -E '\| f( \||$)' || true; })"
count_lines() { if [ -z "$1" ]; then echo 0; else printf '%s\n' "$1" | wc -l | tr -d ' '; fi; }
printed="$(count_lines "$check_rows")"
printed_failing="$(count_lines "$failing_rows")"

# The number each failing check prints with: its leading digits, in both
# result shapes (`22 | name | f | detail` and `22 name | f | detail`).
failed="$(printf '%s\n' "$failing_rows" | sed -nE 's/^([0-9]+[a-z]?)[ |].*/\1/p' | sort -u)"

# The summary's counts are checked against the rows: a table prints every
# check, the harness only its failing ones.
expected_rows="$total"
if [ "$shape" = harness ]; then
    expected_rows="$failures"
fi
if [ "$printed" != "$expected_rows" ] || [ "$printed_failing" != "$failures" ]; then
    echo "::error file=${proof}::${proof} reported ${failures} failing of ${total} but printed ${printed} check rows, ${printed_failing} failing (expected ${expected_rows} rows, ${failures} failing)"
    exit 1
fi

if [ "$failures" = "0" ]; then
    echo "OK ${proof}: ${total} checks passed"
    exit 0
fi

echo "::error file=${proof}::${proof} did not pass (failures | total: ${failures} | ${total}; failing:$(printf ' %s' $failed))"
exit 1
