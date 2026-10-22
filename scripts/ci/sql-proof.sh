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
#   bash scripts/ci/sql-proof.sh "$DB_URL" tests/sql/some_proof.sql 22,24
#
# The optional third argument lists checks, by the number they print with,
# that are known to fail and are tolerated: the proof passes when every check
# that failed is on that list. A listed check that passes is reported, so the
# list can shrink. CI's supabase-local job keeps that list, with a reason for
# each entry, and runs this against the LOCAL stack only.
set -euo pipefail

db="$1"
proof="$2"
known="${3:-}"

out="$(psql "$db" -v ON_ERROR_STOP=1 -q -t -A -F ' | ' -f "$proof")"
printf '%s\n' "$out"

summary="$(printf '%s\n' "$out" | sed '/^[[:space:]]*$/d' | tail -1)"
if [[ "$summary" =~ ALL\ ([0-9]+)\ CHECKS\ PASSED ]]; then
    failures=0
    total="${BASH_REMATCH[1]}"
elif [[ "$summary" =~ ([0-9]+)\ OF\ ([0-9]+)\ CHECKS\ FAILED ]]; then
    failures="${BASH_REMATCH[1]}"
    total="${BASH_REMATCH[2]}"
elif [[ "$summary" =~ ^([0-9]+)\ \|\ ([0-9]+)$ ]]; then
    failures="${BASH_REMATCH[1]}"
    total="${BASH_REMATCH[2]}"
else
    echo "::error file=${proof}::${proof} printed no summary this script can read (last line: ${summary})"
    exit 1
fi

if ! [[ "$total" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error file=${proof}::${proof} ran no checks (failures | total: ${failures} | ${total})"
    exit 1
fi

if [ "$failures" = "0" ]; then
    echo "OK ${proof}: ${total} checks passed"
    if [ -n "$known" ]; then
        echo "::notice file=${proof}::${proof} passed every check, including the known failures ${known}: remove them from the list"
    fi
    exit 0
fi

# The number each failing check prints with: its leading digits, in both
# result shapes (`22 | name | f | detail` and `22 name | f | detail`).
failed="$(printf '%s\n' "$out" | sed '$d' | grep -E '\| f( \||$)' | sed -nE 's/^([0-9]+[a-z]?)[ |].*/\1/p' | sort -u)"
unexpected=""
for id in $failed; do
    if [[ ",${known}," != *",${id},"* ]]; then
        unexpected="${unexpected} ${id}"
    fi
done
listed="$(printf '%s\n' "$failed" | sed '/^$/d' | wc -l | tr -d ' ')"

if [ -n "$known" ] && [ -z "$unexpected" ] && [ "$listed" = "$failures" ]; then
    echo "OK ${proof}: $((total - failures)) of ${total} checks passed; the ${failures} that failed are known (${known})"
    for id in ${known//,/ }; do
        if ! printf '%s\n' "$failed" | grep -qx "$id"; then
            echo "::notice file=${proof}::known failure ${id} of ${proof} now passes: remove it from the list"
        fi
    done
    exit 0
fi

echo "::error file=${proof}::${proof} did not pass (failures | total: ${failures} | ${total}; failing:$(printf ' %s' $failed); known: ${known:-none})"
exit 1
