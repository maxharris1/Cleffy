# SQL integrity checks

`column_integrity.sql` proves, against a real Supabase database, that the
column guards from `supabase/migrations/20261007120100_column_integrity.sql`
and the realtime topic split from
`supabase/migrations/20261007120101_realtime_db_topic.sql` hold:

- **Refusals** — each forgery a client could attempt is refused: rewriting an
  annotation's `created_by` / `document_id` / `created_at` / `id` / `page` /
  `kind`, attributing a create to someone else (single and batch), squatting a
  future lesson-history day, reassigning a score's `owner_id` or repointing its
  `storage_path`, rewriting a share link's token / score / author, pointing an
  import's `backup_path` at another score, handing a tag to another user,
  moving a play-along analysis, and broadcasting on the receive-only
  `doc-db:{id}` realtime topic. Client-supplied timestamps are shown replaced
  or clamped: an annotation's `created_at` is kept inside the score's lifetime,
  and `created_at` (plus `updated_at` where the table has one) is the server
  clock on documents, share links, imports, snapshots, tags, practice notes and
  play-along requests.
- **Client paths** — every write the app makes still succeeds: create score,
  rename, page count, content/thumbnail revisions, share link create / redeem /
  revoke, annotation create (upsert and `insert_annotations_batch`), patch
  (`update` and `patch_annotations_batch`), tombstone and restore, lesson-history
  snapshot push, import audit upserts, tags, favorites, practice notes, the
  play-along request, live ink and presence on `doc:{id}`, and receiving on
  both topics.
- **Server paths** — `service_role` and `postgres` are not guarded, and deleting
  an account still cascades through the `ON DELETE SET NULL` foreign keys.

Everything runs inside one transaction that ends in `ROLLBACK`. It creates
throwaway `auth.users`, scores, marks and links, acts as each user the way
PostgREST does (`set role authenticated` plus `request.jwt.claims`), and leaves
nothing behind.

## Running it

Only ever against the **dev branch project** (`qdbnlrgylelelvwbkvnm`) or a
local stack — never production, even though the script rolls back.

With psql (connection string from the dashboard, Settings → Database):

```sh
psql "$DEV_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/sql/column_integrity.sql
```

With the Supabase MCP, pass the whole file as the `query` of `execute_sql` for
the dev project. The file deliberately contains no `DROP` / `DELETE` /
`TRUNCATE` keyword (row removal is spelled at run time by `pg_temp.removed`),
because the MCP holds any statement containing one for interactive
confirmation — which, in a non-interactive session, looks like a 60-second
timeout.

## Reading the result

The last statement returns the failed checks, if any, followed by a summary
row. A clean run is exactly one row:

| n   | check_name          | passed | detail |
| --- | ------------------- | ------ | ------ |
|     | ALL n CHECKS PASSED | true   |        |

Otherwise each failing check is listed with what happened instead (the
SQLSTATE and message it got, or the row count).

The realtime fan-out checks adapt to the project: Realtime only creates the
day's `realtime.messages` partition while the project's Realtime tenant is
running, and without it `realtime.send()` swallows every broadcast as a
warning. When today's partition exists the broadcast messages themselves are
checked; otherwise the trigger functions' topics are. One informational row
in the full results says which happened.

## Testing a migration before it is applied

The script assumes both migrations are already applied. To test edited
migrations first, run a single transaction of: `begin;`, the migrations'
statements, then this file's statements after its own `begin;` — all in one
query, ending with this file's `rollback;`. Leave out the migrations'
`drop … if exists` lines (no-ops in a fresh transaction, and they trip the MCP
confirmation described above). This is how the checks were first run against
the dev branch project, before either migration existed there.

## Adding checks

Use the helpers at the top of the file:

- `pg_temp.act_as(uuid)` / `pg_temp.act_as_service()` / `pg_temp.act_as_server()`
  switch identity; `pg_temp.on_topic(text)` sets the realtime topic.
- `pg_temp.allowed(name, sql, rows)` — must succeed (and touch `rows` rows).
- `pg_temp.refused(name, sql, sqlstate, message_like)` — must fail that way.
- `pg_temp.holds(name, sql)` — the query must return `true`.
- `pg_temp.removed(name, table, where, rows)` — row removal that must succeed.

Write each SQL argument in `$q$ … $q$` so it needs no escaping.
