#!/usr/bin/env bash
# Run one tests/sql proof against a database and fail unless every check in it
# passed. The proofs print a result table whose last line is
# `failures | total`; psql stopping on an error fails too.
#
#   bash scripts/ci/sql-proof.sh "$DB_URL" tests/sql/cancel_link_lifetime.sql
#
# CI's supabase-local job runs it against the LOCAL stack only.
set -euo pipefail

db="$1"
proof="$2"

out="$(psql "$db" -v ON_ERROR_STOP=1 -q -t -A -F ' | ' -f "$proof")"
printf '%s\n' "$out"

summary="$(printf '%s\n' "$out" | sed '/^[[:space:]]*$/d' | tail -1)"
failures="${summary%% | *}"
total="${summary##* | }"
if [ "$failures" = "0" ] && [[ "$total" =~ ^[1-9][0-9]*$ ]]; then
    echo "OK ${proof}: ${total} checks passed"
else
    echo "::error file=${proof}::${proof} did not pass (failures | total: ${summary})"
    exit 1
fi
