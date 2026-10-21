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

`cross_branch_integration.sql` (same harness, same reading) proves the
20261007 fixes hold together where one writes what another guards: billing's
archive and restore through the documents column guard, IMSLP provenance
(service-role only) beside the owner's own edits, library's row-first delete
tombstones and the storage-cleanup policies, sync's `patch_annotations_batch`
answer under the annotation guard, sharing's role RPC, and an account deletion
firing every user-keyed foreign key (authorship cleared through the role-keyed
guards, the change fanned out on `doc-db:{id}`, the membership event on
`doc:{id}`, and the deleted owner's scores left as tombstones for
delete-account to drain). It sets `storage.allow_delete_query` before removing
`storage.objects` rows, as the Storage API does, so hosted Storage's
`protect_delete` lets the RLS policies decide.

`share_link_errors.sql` proves
`supabase/migrations/20261009120200_share_link_errors_and_peek.sql`: a dead
link (unknown, revoked or expired) is refused with SQLSTATE `PT404` — HTTP 404
through PostgREST, where the old `P0002` was a 500 — carrying
`{"code":"invalid_share_link"}` in `detail`; redemption is otherwise unchanged;
and `peek_share_link` answers anon and signed-in callers alike with
`{valid, role}` only, the same `{false, null}` for every dead link, writing
nothing. Like the sharing proof below, it reports `failures | total` on its
last line.

`guest_email_verification.sql` proves
`supabase/migrations/20261010120200_guest_email_verification.sql`, behind the
guest-email-start / guest-email-confirm functions: `check_guest_email_code`
answers `ok` only for the right code AND the address it was sent to (keeping
the row for the attach), spends a try on each wrong one, and leaves nothing
redeemable after the last allowed wrong try (`locked`), past expiry
(`expired`) or when none was sent (`missing`); `guest_email_taken` answers the
service role only — it refuses without a service-role JWT even where EXECUTE
is held — and no client role can read the pending codes or call either
function. It also proves the `guard_guest_email` trigger on `auth.users`,
updating as `supabase_auth_admin` the way GoTrue does: a guest's row cannot
leave anonymity or gain an address without a code checked for exactly that
address in the last 10 minutes — in GoTrue's order (is_anonymous cleared,
then email set), the reverse, or one statement — while the proven address
attaches in all three, and registered accounts and soft deletes are
untouched. It reports `failures | total` on its last line.

`student_access_revocation.sql` proves
`supabase/migrations/20261010120300_student_access_revocation.sql` and
`20261010120302_library_hides_revoked_student_scores.sql`: a roster
student's token stops reaching anything (role, score, marks, assignment,
shared note, realtime topic, the library RPCs, writes through PostgREST and
both batch RPCs) the moment their row is archived or, after a reset or an
archive, when it was issued (`iat`) before `end_student_sessions` stamped
`access_revoked_at` — the same second included, a token without `iat` too —
while the student's own global sign-out on another device (GoTrue deleting
every session) leaves that device working, and teachers and ordinary
collaborators are untouched; `end_student_sessions` is the service role's
alone, refuses a non-student, stamps the clock, clears every session and
refresh token (the session-less legacy kind included) and sends the
membership hint on `doc:{id}`; a fresh sign-in after a reset, and one after
a restore, bring access back, while a token from before the archive stays
refused. It inserts `auth.sessions` / `auth.refresh_tokens` rows, and creates
stand-ins for those tables only when a local harness has none (Supabase
always does).

`annotation_payload_shape.sql` proves
`supabase/migrations/20261010120301_annotation_payload_shape.sql`: every
payload the client writes (pen, highlighter, text, imported marks, suggested
fingerings, handwriting-to-print styles, production-shaped rows, an unknown
extra key) is accepted on insert, update and both batch RPCs, and malformed
ones (wrong JSON type, bad or out-of-range points, missing or mistyped fields,
over-long text, a payload over 1 MiB, a non-hex colour) are refused with
`23514`; both constraints are validated and every stored row passes them.

`qa3_cross_branch.sql` (same harness, same reading as `column_integrity.sql`)
proves the QA round 3 migrations hold together where one branch's server
change acts on another's accounts: `guard_guest_email` lets GoTrue's reset
(password) and archive (ban) updates of a roster student through, and
`end_student_sessions` still ends the student's sessions beside it; a guest
whose address `guest-email-confirm` attached — which ends all of the guest's
sessions — keeps its role, library entry, realtime topic and writes on its
old token (the revocation is for roster students only), and those writes
still meet the annotation payload check. Like `student_access_revocation.sql`
it creates stand-ins for `auth.sessions` / `auth.refresh_tokens` only when a
local harness has none, and becomes `supabase_auth_admin` for GoTrue's
updates when the role exists.

`archived_student_password.sql` proves
`supabase/migrations/20261011120100_archived_student_password_check.sql`:
`archived_student_password_matches` is true only for the right password of
an archived, claimed roster row whose account is a provisioned student (false
for a wrong one, a live or unclaimed row, a non-student account, a non-bcrypt
hash and an unknown username), and refuses every caller but the service role.
`edge_rate_limit_refund.sql` proves
`supabase/migrations/20261011120101_refund_edge_rate_limit.sql`: a refund hands
back one use of a bucket inside its window (never below zero, never into the
next window, never creating a bucket), and only the service role may call it.

`billing_double_charge.sql` proves the guards behind the double charge QA round
4 reproduced in Stripe (`supabase/migrations/20261012120100` through `120105`,
and `20261013120100` through `120102`):
`subscriptions_one_entitling_per_user_mode` refuses a second `active` or
`trialing` subscription for one user in one Stripe account — on the insert and
on the upsert's update, naming the index in its 23505 — while leaving the other
account, another user, a cancelled subscription's replacement and the live
subscription's own updates alone; `claim_stripe_event` claims a fresh event,
answers with the state and the stamp it wrote, tells a second delivery that the
event is `processing` rather than merely refusing it (a live claim means nobody
has applied the event, so the webhook answers Stripe 409 and is delivered
again, where a bare null bought a 200 and Stripe forgot it), says `done` for one
already applied, takes over a claim left `processing` past its staleness window
(which is what makes Stripe's retry of an event whose isolate died recoverable
rather than a permanent `200 duplicate`), and is the service role's alone, as is
the table; the `subscriptions_refuse_stale_event` trigger drops an update
carrying an older `last_event_created_at` than the row holds, applies a newer or
equal one, and lets an unstamped write through without losing the stamp the row
already had; `begin_checkout_attempt` / `finish_checkout_attempt` /
`release_checkout_attempt` hold one checkout attempt per buyer per Stripe
account — an overlapping request gets nothing, the other account and other
buyers are unaffected, the session an attempt opened is remembered and handed to
the next request, a lease left by a dead isolate is taken over only once stale,
and the dead attempt can no longer record a session over the live one; and
`claim_subscription_write` / `release_subscription_write` do the same for one
subscription's writer, which is what orders two deliveries Stripe stamped in the
same second.

It then proves the three things the QA round 4 review of #56 added to those
guards. `stage_checkout_attempt` records the attempt id a Checkout Session's
Stripe idempotency key is derived from BEFORE the session is created with it, so
an isolate killed around the create leaves a key the next attempt reads back and
replays instead of minting a fresh one and being handed a second payable session
— the key is readable back, the lock is deliberately still held (the create has
not happened yet), the stored session id is cleared because by then it has been
handed back or expired, and an attempt whose lease was taken over cannot stage
and therefore never reaches the create at all, which is what stops the lease
length from being the only thing standing between a takeover and two sessions.
`write_subscription_under_lock` makes the subscription write conditional on
still holding that subscription's write lease, in the same statement: the holder
writes, a delivery whose lease was taken over is answered `lost_lock` and writes
nothing (so a customer who has just fixed their card is not put back to
`past_due` by a stalled delivery's minutes-old read), a write with no lease at
all is refused too, the staleness trigger still drops an older event stamp and
still answers `written`, a second entitling subscription answers `duplicate`
named from Postgres's own `constraint_name` diagnostics rather than from the text
of an error message, a deleted account answers `missing_user`, and any OTHER
unique violation is raised rather than swallowed. `duplicate_refunds` with
`record_` / `settle_` / `pending_duplicate_refund` keeps a duplicate's unmade
refund owed after the event that found it is gone — pending until it is settled,
counted on every attempt that reports back, mode-filtered like every other
billing lookup, never reopened once resolved, never retried once it is a human's
(`needs_human`), and kept when the account goes — its foreign key nulls the user
rather than cascading, because an account going away does not make a refund we
never issued stop being owed.
All three are the service role's alone, as is the ledger table. Like the others
it reports its checks on the last line and rolls back.

One environment note for that file: every billing table predates
`20260827140000_core_table_grants.sql` and carries no `service_role` grant, which
only the hosted image's permissive default ACL hides. Against a plain local
cluster its `subscriptions` checks used to fail with `42501 permission denied`
until `grant all on table public.subscriptions to service_role` was run by hand;
`20261013120101` now carries that grant, because the write function it adds is
SECURITY INVOKER and would otherwise answer 42501 before it reached the lease
check. Proven against PostgreSQL 17.11 on 2026-10-12 (53 checks) and again, with
the review's additions, on 2026-10-13: all 98 checks passed.

The sharing RPC proof lives beside the migrations, in
`supabase/sql-tests/sharing_access_control.sql`; it reports `failures | total`
on its last line instead. Its broadcast checks (80-82, 85, 87) need today's
`realtime.messages` partition, which an idle hosted project does not have.

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

`launch_consent.sql` proves the launch consent and retention migrations
(`20261021120000` through `20261021120300`, and the fix pass's `120400` to `120600`): `consent_age()` answers the
EU/EEA ages and 13 elsewhere; `hook_before_user_created` lets a passing
`age_gate` through, refuses a missing one with 400 and an under-age one with
403 whose message names no age, and is callable by `supabase_auth_admin`
alone; the roster's attestation columns refuse a lower-case country and a
partial attestation, a teacher reads their own `teacher_attestations` and
nobody else's and cannot write one; `scrub_student_markings` refuses a
non-student, tombstones the student's marks with their content replaced by
a valid empty shape (bumping `seq`), cuts them out of a lesson-history
snapshot that keeps the teacher's marks and stops naming the student, and
finds nothing to cut a second time; and the purges remove an archived
student 13 months on (scrubbed, account and roster row gone) while keeping
one archived six months ago, remove a guest idle for 100 days while keeping
an old guest whose session refreshed today, a new guest and an old
registered account, drop stale rate-limit and login buckets but not live
ones, and drop support mail older than 24 months; the five cron jobs are
scheduled off the hour. Proven against the local stack (PostgreSQL 17.11) on
2026-10-21: all 29 checks passed, and 43 with the fix pass's checks below.

The fix pass adds `20261021120400_delete_student_one_transaction.sql`:
`revoke_and_scrub_student` is the service role's alone and refuses an account
with no roster row; it leaves the student archived with their sessions ended
and their markings scrubbed, after which the student can write no mark while
the teacher still can; and the write guard is a BEFORE statement trigger on
`annotations` and `annotation_snapshots`.

`20261021120600_tombstone_resync_floor.sql` is proven there too: compaction
removes a 100-day-old tombstone and keeps a live mark, and records the score's
floor (the highest seq it removed); a member of the score is told the floor
by `annotation_resync_floor`, someone who cannot read the score is told
nothing (null), and no client reads `annotation_sync_floors` directly. The
client half (a device below the floor resyncs in full and drops marks the
server no longer has) is in `src/sync/syncEngine.test.ts`, "SyncEngine after
tombstone compaction".

`launch_consent_concurrency.mjs` proves what one transaction cannot: the
races. It drives two or three real `psql` sessions against the **local stack
only** (it refuses any host but localhost), orders them by waiting until a
session is blocked on a lock (never by sleeping), commits its fixtures under a
per-run id prefix and removes them at the end, pass or fail:

- **Delete student vs. the student's writes** — a mark the student is still
  writing when Delete student starts makes the deletion wait, then is scrubbed;
  a mark the student starts while the deletion runs waits, then is refused
  (`42501`), and nothing escapes the scrub. Disabling
  `annotations_refuse_revoked_student` makes the first case fail (the deletion
  no longer waits, and the in-flight mark outlives the scrub).

- **Retention vs. a restore** (`20261021120500_retention_recheck_under_lock.sql`)
  — the archived-student purge is stalled on its first candidate after it has
  listed a second; the second is restored in that gap and is kept, while the
  first is purged. The same for guests: one that signs in after the list was
  read is kept. A roster row a restore is still writing is skipped
  (`SKIP LOCKED`) rather than waited on and deleted, and the restore lands.
  Against the 20261021120300 purges the restored student is purged and the
  guest case stalls.

```sh
node tests/sql/launch_consent_concurrency.mjs          # every scenario
node tests/sql/launch_consent_concurrency.mjs delete   # one group
```

`district_retention.sql` proves `20261021120700_district_retention.sql`
(decision 1: district data goes 30 days after `contract_ends_at`), moving time
with the functions' `p_now`: only the service role may run the purge, its dry
run, read the billing record or the log, or claim notices; the purge ships
unscheduled; the dry run counts a district's students and seated teachers,
never lists one whose `contract_ends_at` is null, and writes nothing; the run
queues one notice to the owner at contract end + 16 days and logs its counts;
nothing is soft deleted while the notice is unsent, nor within 14 days of it
being sent; the sender's claim holds a notice against a second sender, a
failed send is kept for a retry and a delivered one is stamped and logged; the
soft delete archives the district's students (refusing their tokens) and
leaves another teacher's alone; a renewed contract cancels and un-archives
only the students the soft delete archived; the next cycle mails the owner
again; a student the teacher restored after the soft delete survives the hard
delete, which scrubs and deletes the rest and removes the studio, its seats
and its billing record, while teachers' own accounts, scores and other
students stay; the log keeps the counts after the studio is gone. Proven
against the local stack (PostgreSQL 17.11) on 2026-10-21: all 26 checks
passed. Round 2 adds `20261021120900_district_notice_mail_budget.sql`: a notice
the shared mail budget holds back is deferred (`defer_district_retention_notice`
releases the claim, takes the claim's attempt back and leaves it unsent, so the
purge keeps waiting), and only the service role may defer: 28 checks.

`district_student_scope.sql` proves `20261021120800_district_student_attribution.sql`
(Codex round-2 review of #64, new major 1; round 3, item A1): each roster row
records the district its provisioning named, and the district purge takes those
students and nobody else's. Only positive evidence counts: a seated teacher (or
the district's owner) who names no district provisions a private student, and
naming a district the teacher is not in (never joined, has left, or a studio
that is not a district) is refused. A private student from before joining
stays private; a teacher seated in two districts provisions into the one named;
a departed teacher's district students stay the district's, and the students
they provision after leaving are their own. The service role cannot change the
record (or how it was decided) by UPDATE, and every new row is recorded as
decided at provisioning whatever the insert says; clients cannot read it, ask
`district_provisionable`, or call the logged admin correction. The backfill
reads legacy rows only and never revisits a row decided at provisioning, and is
a no-op on a second run. Two districts' contracts then end: the soft and hard
deletes take exactly the four district students and leave every private
student, an unrelated teacher's, every teacher account and the score untouched,
with per-district counts in the log. Proven against the local stack on
2026-10-21: all 33 checks passed; against the round-2 migration (membership
inferred at provisioning), 20 fail.

`district_billing_canonical.sql` is a byte-for-byte copy of PR #61's proof of
the canonical `public.district_billing` block, which this branch's
`20261021120700_district_retention.sql` carries unchanged
(`tests/legal/districtBillingCanonical.test.ts` pins the block to #61's sha256).
With the table removed inside the transaction, the block alone builds it, and a
second run leaves the same columns, constraints, indexes, RLS and grants (the
service role's SELECT, and nothing for any client role). Proven against the
local stack on 2026-10-21 with this branch's migrations: all 12 checks passed,
and `district_retention.sql` (26), `district_student_scope.sql` (22) and
`launch_consent.sql` (43) still pass under the narrowed grant.
