#!/usr/bin/env bash
# Remove what the live tests (tests/live/*.live.test.ts) leave on the LOCAL
# stack beyond the API's reach (P4 follow-up, test row cleanup): the topic
# hints the server broadcast for their throwaway scores (realtime.messages
# rows on doc:{id} / doc-db:{id} topics whose score no longer exists) and
# GoTrue's audit log of their throwaway accounts (@takedown.test,
# @district.test). Everything else they create, their own afterAll deletes.
#
#   bash scripts/live-tests-cleanup.sh             # the local stack's database
#   bash scripts/live-tests-cleanup.sh "$DB_URL"   # a local database URL
#
# LOCAL ONLY: refuses any database that is not on 127.0.0.1 or localhost.
# Idempotent; prints what it removed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
db="${1:-}"
if [ -z "$db" ]; then
    db="$(bash "$REPO_ROOT/scripts/supabase.sh" status -o env 2>/dev/null | sed -n 's/^DB_URL="\(.*\)"$/\1/p')"
fi
if [ -z "$db" ]; then
    echo "live-tests-cleanup: no database URL (is the local stack running? npm run cloud:up)" >&2
    exit 1
fi
if ! [[ "$db" =~ ^postgres(ql)?://[^@/]*@(127\.0\.0\.1|localhost)(:[0-9]+)?/ ]]; then
    echo "live-tests-cleanup: refusing a database that is not local" >&2
    exit 1
fi

psql "$db" -v ON_ERROR_STOP=1 -q -t -A <<'SQL'
with gone as (
    delete from realtime.messages m
    where m.topic ~ '^doc(-db)?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:[0-9]+)?$'
      and not exists (
          select 1 from public.documents d
          where d.id = substring(m.topic from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')::uuid
      )
    returning 1
)
select 'realtime.messages of deleted scores removed: ' || count(*) from gone;
with gone as (
    delete from auth.audit_log_entries a
    where a.payload::text ~ '@(takedown|district)\.test"'
    returning 1
)
select 'auth.audit_log_entries of live-test accounts removed: ' || count(*) from gone;
SQL
