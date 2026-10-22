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
`protect_delete` lets the RLS policies decide. Since `20261022100900` the former
owner cannot delete the tombstone; `finish_document_storage_cleanup` clears it
once both folders are empty. 39 checks.

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
`district_seats.sql` proves
`supabase/migrations/20261020180400_district_seat_overrides.sql`: a studio is
capped at Academy's 5 until an admin sets an override, which then raises the
seat trigger's limit only while the subscription it is tied to is the studio
owner's live `send_invoice` Academy subscription (a lapsed period, `past_due`,
`canceled` or a switch to `charge_automatically` puts the studio back on 5, and
a renewal or payment restores the override without anyone re-setting it); the
webhook's own subscription writes (`write_subscription_under_lock`, a write
that omits `collection_method` included) never touch the override or its log;
`admin_set_studio_seat_override` refuses an override at or below 5, no actor, an
unrecorded or another user's subscription and a card-paid one, leaving nothing
behind; owners and members read the effective limit through `studio_seat_limit`
and nobody else does; no client role reads or writes either table, calls the
admin functions (a user identity is refused even where EXECUTE is held) or
raises `studios.seat_limit`; and every set, change and clear -- a hand-run
insert and the cascade from a deleted studio included -- lands in
`studio_seat_override_log`, which outlives the studio. It reports
`failures | total` on its last line.

`district_seat_cap.sql` proves
`supabase/migrations/20261020180500_district_seat_cap_and_grace.sql`: with
nine teachers seated under a 10-seat district override, lowering it to 6,
clearing it, a send_invoice invoice past due beyond 30 days, and the district
moving to ordinary card-paid Academy each leave only the seats inside the new
limit entitled -- the owner's pick first, then the oldest -- and make the rest
read-only (`resolve_entitlements` answers tier free, `seat_read_only`, zero on
everything created and unlimited export; their scores are archived as
`plan_lapse`, so annotation RLS refuses marks while view and export still
work, and uploads, un-archiving and new invites are refused), with no score or
seat deleted; re-setting the override, an admin's grace extension and the
district paying each restore every seat and every score at once; inside 30
days past due (clock from `past_due_since`, which a later delivery does not
restart) the district keeps full access, its owner included, while a card
Teacher plan past due gets none; the hourly
`reconcile_district_seats` catches a grace period that only the clock ended;
`studio_seat_states` agrees with `studio_seat_is_active`; only the owner picks
seats (never more than the limit leaves room for, never a non-member) or reads
their status; removing a read-only teacher releases them to free with their
scores back up to the free cap; `district_billing.contract_ends_at` follows
Stripe's actual end only (null while a cancellation is merely scheduled or
the subscription is resumed or past due; on cancellation Stripe's `ended_at`
-- not the scheduled date of an earlier schedule -- or, from a webhook that
omits it (the migration deployed before the new webhook), Stripe's
`current_period_end`; with neither, nothing is invented: the record keeps what
it had, null included, and a warning is logged -- never the event's time or
now(); never moved by a redelivery; untouched by a card subscription that is
not Academy), and is null while the owner has a card-paid Academy (a paying
district, whose seats past 5 stay read-only), and is null -- so the
retention purge selects nothing -- as soon as the district pays on a
replacement subscription, with or without the override moved to it, while a
replacement not yet paid leaves the old end, and the replacement's own end
counts once it ends, until an admin pins it (a date, or null for never) --
a pinned date already past while the owner pays is cleared and logged, when
pinned and by the hourly sweep, while a future one and one for a district
that does not pay stand --
and an admin can hand it back to Stripe; one paying status set for card and
Stripe Invoicing Academy billing (`20261020180900_district_paying_status.sql`,
decisions 21 and 25): active, trialing and past_due inside 30 days of first
going past due (or an admin's per-district extension, which reaches a card
Academy too) pay -- no contract end, no purge, a past admin pin cleared and
logged -- while unpaid (even inside the 30 days and recorded with its tier) and
past_due past grace do not, and the hourly sweep gives a district that stopped
paying only by the clock its Stripe end back; every stored contract end is no
earlier than when Cleffy learned of it (`20261020181000_district_contract_end_clamp.sql`,
decision 22): a cancellation delivered late with a Stripe date months old and
an admin date already past are both stored as the time they were learned,
Stripe's or the admin's own date kept beside it, so the 14-day notice and the
30-day window are whole, and a replay, a redelivery, the hourly sweep or an
admin retry of the same date keeps the learned-at time (neither later nor the
end earlier) while a different date is a new end; every billing-record change is
logged with its actor; and no client role reads the billing record or its log, calls
the admin or reconcile functions, or writes `kept_active`. It reports
`failures | total` on its last line.
`district_read_only_seats.sql` proves
`supabase/migrations/20261020180600_read_only_seats_enforced.sql`: a seat that
the clock alone made read-only (an invoice grace period running out, with no
webhook and no hourly sweep yet, so nothing is archived) can write nothing at
once -- no mark on its own score or on a score shared with it as an editor,
through PostgREST or either batch RPC, no tombstone, no lesson-history
snapshot, no live ink on `doc:{id}`, no rename or new file, no share link, no
assignment, no seat invite, and (`20261020180700_read_only_seats_storage.sql`)
no write to its score's PDF in the `scores` bucket: an upsert over it, a new
file in its folder and removing it are refused or match nothing -- while it
still sees, downloads and exports everything, appears in presence, backfills a
page count and a cover, and can delete its own score and clean up its files;
the hourly sweep (`20261020180800_read_only_seats_live_ink.sql`) records the
seat as read-only, sends the membership hint on the live topic of every score
it can write on and rotates those scores' topics through PR #63's
`rotate_document_realtime` (a stand-in records the calls when #63 is absent),
once -- a second sweep changes nothing, and paying clears the record and hints
again without rotating; a grace period that runs out on the clock alone
(`20261020181100_read_only_seats_grace_deadline.sql`, decision 26) shuts live
ink at the deadline itself: before it the seat still marks and writes its PDF,
but a broadcast authorized with a token that outlives the deadline (or has no
exp) is refused, since Realtime would keep that answer past it, while one whose
token expires first is not and a roster student is untouched; past it, with no
sweep (nothing recorded, nothing archived), live ink and the Storage write are
refused; no client reads the record or sends the hint; an active seat and a roster
student with Edit keep writing; paying again lifts it immediately; and nobody
can ask about another user's seat. It reports `failures | total` on its last
line.

`district_migrations_rerunnable.sql` proves the district migrations
(`20261020180400` through `20261020181100`) are rerunnable whole,
not only the canonical block: it applies all three, in order, twice on top of a
database that already has them (psql `\ir`, so psql only, never the MCP), then
checks every trigger, policy, constraint and cron job exists once, every added
column and index is there, RLS and grants are unchanged, the latest function
definitions win, and an override, its log, a billing record and a kept seat
written before the rerun are untouched -- with the log trigger firing once per
change. A migration that is not rerunnable stops it with its error.
`tests/billing/districtMigrationsRerunnable.test.ts` holds the guards in CI.

`district_billing_canonical.sql` proves the canonical `public.district_billing`
definition (the marked block in
`supabase/migrations/20261020180500_district_seat_cap_and_grace.sql`, copied
byte for byte into PR #64's `20261021120700_district_retention.sql`;
`tests/billing/districtBillingCanonical.test.ts` holds the copies equal) is
rerunnable on its own: with the table removed inside the transaction, the block
alone builds it, and running it again leaves the same columns, constraints
(each once, by name), indexes, RLS and grants (the service role's SELECT, and
nothing for any client role); the source/date constraints refuse an unknown
source, a Stripe source with no date and a date with no source, while an
admin may pin null. It reports `failures | total` on its last line.

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

Decision 20 (launchfix P1, `20261022100100_billing_lock_tables_client_revoke.sql`)
revoked the client roles' default-ACL grants on `checkout_attempts`,
`subscription_writes` and `duplicate_refunds`, which checks 89, 92 and 98
caught on the local stack: all 98 checks pass there since 2026-10-22, and CI
runs it.

`cancel_link_lifetime.sql` proves
`supabase/migrations/20261020160300_cancel_link_token_lifetime.sql` (Codex round
4 on #62): a cancel link's expiry is fixed on its `billing_mail_outbox` row when
it is asked for and never moved later; its token is saved only through
`save_cancel_link_token`, under the row's lease, with the row's expiry, and a
second save — or the upsert the store used to make — changes nothing. Its last
section is a real race: two dblink sessions save the same link at once, the
second waits on the first's row lock, and the one token keeps the first save's
expiry. Because that section needs committed rows it creates its own (fixed
ids and a fresh hash each run, deleted before and after) and logs in as `postgres`; pass
`-v peer_password=…` for anything but the local stack. Against hosted
databases, use only sections 1-2. `tests/billing/cancelLinkStore.test.ts` runs
billingCancelStore.ts itself against the same local stack (skipped unless
`CLEFFY_LOCAL_SUPABASE_URL` and `CLEFFY_LOCAL_SERVICE_ROLE_KEY` are set).

`cancel_link_tombstones.sql` and `cancel_link_db_clock.sql` prove
`supabase/migrations/20261020160400_cancel_link_tombstones_db_clock.sql` and
`20261020160500_cancel_link_save_replayable.sql` (Codex round 5 on #62; the
second moves the save that answers the seconds left to
`save_cancel_link_token_v2`, so `save_cancel_link_token` stays `returns text`
and 20261020160300 still replays). The first: a token the cleanup deletes leaves a permanent
tombstone (its hash and outbox id, nothing else), and neither a direct insert of
that hash against a new pending request (the service role may not insert tokens
at all; the owner is refused by the trigger) nor a request re-created under the
deleted row's id can bring the link back; tombstones cannot be updated, deleted
or truncated. It runs in one transaction and rolls back. The second: the save
reads `clock_timestamp()` after the row lock, refuses with under 120 s left and
answers the seconds left; two dblink sessions show a save that waited on the
lock past the expiry (and from 122 s to under 120) being refused. Like
`cancel_link_lifetime.sql` it commits its own rows (random ids and hashes,
deleted again) and takes `-v peer_password=…`.

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
reads legacy rows only and never revisits a row decided at provisioning
(round 3, items A2 and Max's decision 3): a seat or ownership when a legacy
student was created attributes nothing on its own; only the district's recorded
evidence (`admin_record_district_evidence`, service role only) does, and only
for a student created within the teacher's seat tenure, which
`studio_seat_tenures` keeps after the teacher leaves -- so a departed teacher's
legacy student created while seated is attributed, and evidence from before
the seat started or after it ended is not. Evidence recorded later is picked up
by the next run, and a run with nothing new is a no-op. Item A3: nothing is
ever attributed to a time before the district existed (its studio, or its
contract) or the seat started -- neither by the backfill (an owner's students
from before the studio or the contract stay unattributed even with evidence)
nor by a back-dated insert, which is refused. Evidence naming two districts is
ambiguous and left unattributed. Each run returns and logs its counts:
attributed, and skipped by reason (no evidence, ambiguous, district gone,
before the district, outside the tenure), per district named and once for the
run. Two districts' contracts then end: the soft and hard
deletes take exactly the four district students and leave every private
student, an unrelated teacher's, every teacher account and the score untouched,
with per-district counts in the log. Proven against the local stack on
2026-10-21: all 47 checks passed. Each item's checks were run against the
previous state first: the item-A1 checks (33) had 20 failing on the round-2
migration, the item-A2 checks (41) 13 on the item-A1 migration, and the
item-A3 checks (47) 13 on the item-A2 migration.

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

## Launchfix P1: DB release safety

`explicit_grants.sql` proves `20261022100000_explicit_service_role_grants.sql`
(BL-3), `20261022100100` (decision 20) and
`20261022100700_client_table_privileges.sql` (Codex round 1 on #69, MAJOR 4):
the service role reads every public table and holds full DML on all but five
deliberately narrowed ones; anon and authenticated hold exactly a pinned,
reduced list, column grants included -- no TRUNCATE, REFERENCES, TRIGGER or
MAINTAIN anywhere, nothing for anon, nothing for either on `omr_jobs`,
`score_cache`, `imslp_category_sync` and `imslp_file_licenses`, and no client
privilege that an RLS policy does not let that role use; a table created now
gives the client roles nothing; and with the default ACL revoked in the
transaction, the fifteen BL-3 tables, stripped of what the default gave the
service role, get it back from the migration alone, the client roles
unchanged. 22 checks (`document_storage_cleanup` is SELECT only for
authenticated since `20261022100900`). Run it against the local stack. `column_integrity.sql`
checks 58, 76 and 80 now expect the client's update of a snapshot, a document
tag or a favourite to be refused (42501) rather than to match no row.
`tests/security/explicitServiceRoleGrants.test.ts` holds every table a
migration creates to an explicit service_role grant.

`deployment_config.sql` proves `20261022100200_deployment_config.sql` (BL-2):
unset, test- and live-mode subscriptions both entitle; with the config at
`{live}` a test-mode one (or a seat under a test-mode Academy) resolves free
while a live one entitles, in the same session; clearing it restores both;
the table is one service-role-only row of a non-empty subset of
`{live,test}`; `entitling_billing_modes()` is STABLE and nothing indexes on it;
and applied over production's hand-narrowed body the migration carries `{live}`
into the table first. 34 checks.

`one_studio_per_owner.sql` proves `20261022100300_one_studio_per_owner.sql`
(BL-4): the backfill keeps a district's studio (billing record or seat
override) over an older one, else the oldest, supersedes and logs the rest
with their member counts and deletes nothing; a second live studio is refused
with `studio_exists` (and by the unique index with triggers off); a superseded
studio grants no seat, active or read-only, and takes no invite. 30 checks.

`storage_name_limits.sql` proves `20261022100400_storage_object_names.sql` and
`20261022100500_storage_bucket_limits.sql` (SF-3): an owner writes only
`scores/{id}/original.pdf`, `scores/{id}/pre-import-original.pdf` and
`thumbnails/{id}/{rev}.jpg` (insert, upsert, move), a client cannot create an
archived score, and both buckets carry their size and type limits. 32 checks.
Check 06 now expects the largest int revision to be refused: it is a valid
name, but past `20261022100800`'s revision cap.

`storage_quota.sql` proves
`20261022100800_storage_quota_and_thumbnail_lifecycle.sql` (A2; Codex round 1
on #69, MAJOR 3): the per-owner byte quota comes from
`deployment_config.storage_quota_bytes` by plan tier (defaults 500 MiB free,
5 GiB paid; the column takes only known tiers and positive integers); a write
past it is refused with `storage_quota_exceeded` (42501), the Storage API's
real write and a client's size-less test insert alike, counting archived
scores' files and a deleted score's leftovers until purged, never counting an
upserted object twice and never refusing a write that does not grow an
object; a new thumbnail puts the folder's other objects on
`thumbnail_storage_cleanup`, which clears itself as they are removed; a client
may write a thumbnail only while its folder holds at most one other object and
only for a revision from 0 to the score's `content_rev` (at most 1,000,000);
and the migration ledgers covers superseded before it. 63 checks: check 69 now
holds the service role to the folder count (69b), which `20261022100900`
enforces in committed state on every writer.

`superseded_studio_members.sql` proves
`20261022100600_superseded_studio_followups.sql` (Codex round 1 on #69, MAJOR 1
and 2): after the backfill a member who drops to free is archived past the
free cap as `plan_lapse`, deleting nothing, while members still entitled
(their own plan, a seat in another owner's live studio, a seat in the kept
studio) are skipped; a rerun changes nothing; a studio superseded later is
followed by the trigger and one brought back restores; and in the last minutes
of the owner's grace a member of the retired studio only is no longer refused
live ink, while a member of the live studio still is. 20 checks.

`storage_cleanup_and_thumbnail_cap.sql` proves
`20261022100900_storage_cleanup_markers_and_thumbnail_cap.sql` (Codex round 2
on #69; decision 52): a deleted score's cleanup marker cannot be deleted by its
owner (no DELETE grant or policy) and its bytes keep counting until
`finish_document_storage_cleanup` finds both folders empty; an over-quota owner
replaces a file with one no larger, the Storage API's size-less policy test
included, while growth is refused; a third object in a thumbnail folder is
refused (`thumbnail_limit`) on the real service-role write and on the policy
test; `claim_superseded_thumbnails` claims an upload whose publish failed but
never the published revision, and a claimed cover cannot be published
(`thumbnail_claimed`). 58 checks.

`storage_thumbnail_concurrency.sql` proves the same migration under real
concurrency, through `dblink` backends that commit (it is not one transaction:
it removes its fixtures at the start and the end, and drops `dblink` again if
it created it; it connects back with the local stack's default password, so it
is local and CI only). Three uploads into one folder at once: the later two
wait on the first's lock and exactly one of them commits. A claim and a
publish of the same cover, in both orders; clearing a deleted score's marker
and an upload into its folder, in both orders (`storage_folder_gone`). 18
checks. `tests/storage/storageLifecycle.test.ts` covers the same through the
Storage API itself.

`storage_quota_lock_and_cover_reuse.sql` proves
`20261022101000_storage_quota_lock_and_cover_reuse.sql` (Codex round 3 on
#69; decision 57): the quota trigger locks a write's predecessor FOR UPDATE,
then takes the owner lock, and reads it FOR UPDATE again before the no-growth
exemption; every write takes the owner lock, a non-growing one too; a row
actually inserted is charged in full after conflict resolution
(`storage_objects_charge_insert`), even with the BEFORE check dropped; a name
this transaction deleted is charged as new when written again. A signed-in
owner's removal never takes a live score's published cover (a reused,
re-published name included, after its claim row is gone), while other covers,
a deleted score's covers and the service role's removals go. The folder lock
takes a lower score id after a higher one only if it is free
(`thumbnail_folder_busy`, 55P03, otherwise). A folder already over the
two-object cap is trimmed by a sweep (all but the published cover and the
newest other) and by the next publish. 45 checks.

`storage_quota_lock_concurrency.sql` proves the same migration under real
concurrency, through `dblink` backends that commit (the same harness, rules
and caveats as `storage_thumbnail_concurrency.sql`). A delete of X, an upsert
of X and another upload: the upsert waits on X's row, finds it gone, and is
charged as a new object, so the owner never ends over the cap (three sessions,
as in the review; and two, with the delete and the other upload in one
transaction); with the delete rolled back, the upsert is still a non-growing
replacement, allowed at the cap. A cover name reused after two devices' claims
survives the second, late removal. A removal and a publish of the same
object, both orders (`thumbnail_gone`; the removal leaves a cover published
while it waited). Opposite lock orders across two scores: the out-of-order
publish is refused at once (`thumbnail_folder_busy`), not by a deadlock, and
the claim completes; in order, the claim only waits. 26 checks. With
`20261022100900`'s functions instead, the owner ends 100 bytes over the cap,
the late removal deletes the re-published cover, and the opposite-order case
ends in `deadlock detected`.

Each `\ir`s its migrations to rerun them, so it is psql only.

## Launchfix P3: edge hardening

`student_claim_reservation.sql` proves
`20261022110000_student_claim_reservation.sql` (launchfix P3, SF-11): a
student claim reserves its roster row, bound to the card's `login_code_hash`,
before student-claim writes any password, and `complete_student_claim` commits
only while the row still carries that hash and the reservation is still the
caller's. The interleavings are written statement by statement: one claim
start to finish; two claims on one card (the second is `busy` and never
replaces the first's reservation; a taken username is 23505 with the
reservation kept); a claim against a teacher's reset both ways round (the
reset is `busy` during a claim and rotating the code under a live claim is
refused with 55006; a claim is `busy` during a reset, and the old hash can
never be committed against the new code); expiry (a dead holder is taken
over by a claim or a reset and its late commit and release are no-ops);
archive blocks a claim's commit but keeps its reservation until the claim
releases it, so a reset of the archived student waits for it; and no client
role can call any of it or read the table. Since the P3 fix round it also
proves `20261022110500_student_code_reset_holder.sql`: a reset carries a holder
token, a second reset (no token, or a wrong one) cannot take a live reset over,
the holder's own token resumes it, only the holder can complete or release it,
no other path can rotate the code under it, and the paused reset / reset /
claim interleaving can no longer scramble the student's chosen password; a
dead reset is taken over only after its TTL. Proven against the local stack on
2026-10-22: all 73 checks passed (53 before the fix round).

Since the P3 fix round 2 it also proves
`20261022110700_student_code_reset_worker.sql`: every reset attempt takes its
own worker lease (a worker id and a fencing epoch that only goes up), separate
from the resume token. Two retries of one token (section 8): B completes, the
student claims, and A -- paused before its password write -- is `lost` at its
fence, at its completion and at its report-back, so the claim stands; with the
hold still live a newer lease fences the older worker out; a worker that passed
a fence (an Auth call may be in flight) can be neither taken over by the same
token nor released under, until it reports back; and a claim since the
reservation (after the hold ran out, or a claim commit under it) fences the
reset out. Proven against the local stack on 2026-10-22: all 99 checks passed
(73 before fix round 2).

Since the P3 fix round 3 it also proves
`20261022110800_student_code_reset_quarantine.sql` (section 9): a worker whose
password write came back ambiguous does not report back, so a retry with the
token is `busy` (and is handed that worker's lease, which a caller without the
token is not), a claim of the old card waits, and the hold cannot be released;
once the write is confirmed the retry reports the worker back and takes a newer
lease, and the quarantined worker's delayed fence, session revocation and
completion all do nothing; an attempt never confirmed holds the row for the
full window from its fence, after which a retry gets a fresh reservation or the
student claims the old card, and the stale worker can do nothing more; and
`end_student_sessions_fenced` ends sessions only for the current worker of a
live hold that has passed a fence, with no claim since. Proven against the
local stack on 2026-10-22: all 125 checks passed (99 before fix round 3).

`account_deletion_pending.sql` proves
`20261022110100_account_deletion_pending.sql` (launchfix P3, SF-13): once
`begin_account_deletion` has written the marker (holding the account's
advisory lock exclusively until it commits), a new score or roster row for
that account is refused with 55000 whoever inserts it (service role, or the
owner's own tab), while other accounts and updates to existing rows are
unaffected and every insert takes the shared lock; a retry counts its attempt;
`settle_account_deletion` keeps the marker with its error on `failed`, and
clears it on `abandoned` only when it is a lone first attempt's -- a retry that
deletes nothing leaves an earlier part-way attempt's marker in place, and one
tab abandoning cannot clear the marker a second tab is sweeping under;
deleting the auth user cascades it away, and a retry for an account already
gone writes nothing; and no client role can call it or read the table.

Since the P3 fix round it proves the final shape, with
`20261022110400_account_deletion_attempts.sql` (attempt-scoped
`begin_account_deletion_attempt` / `mark_account_deletion_destructive` /
`settle_account_deletion_attempt`, the single-counter functions gone): two
abandoned attempts clear the marker; a crashed attempt stops restricting once
its lease runs out; an attempt that crashed after cleanup began keeps the
account restricted (the runbook case) until a retry completes; and
`20261022110600_account_deletion_barrier.sql`: uploads and overwrites into an
existing score (scores and thumbnails) are refused while removals are not;
share-link redemption is refused for a deleting account and into a deleting
owner's score; a checkout lease cannot be taken or staged, and one taken
before the marker reads as in flight; a provisioning intent is refused for a
deleting teacher, finds a crashed provisioning's account by address (never an
older account), is cleared by the roster insert, and outlives its teacher.
Proven against the local stack on 2026-10-22: all 89 checks passed (36 before
the fix round).

`support_inbound_lease.sql` proves `20261022110200_support_inbound_lease.sql`
(launchfix P3, SF-2 / Codex B1): the first webhook delivery inserts its
`support_messages` row and holds it under a lease; a redelivery while it is
held is `busy`, not a duplicate; only the lease holder can write the body or
finish the row; a delivery that died is resumed by the next one once its lease
runs out (no second row, the stored body handed back, the dead holder's writes
refused); a completed row is the only duplicate. A forward the budget cannot
pay for is `forward_deferred` (not an attempt) and `claim_due_support_messages`
takes it only once due, under a fresh lease that a second run or a webhook
redelivery cannot share; a redelivery before a row is due is told to wait and
is not counted as an attempt, and once due it resumes the row. Failed attempts
back off and, at the attempt cap, are failed (for review) with their error; a
forward whose outcome was unknown is retried with its kept reservation recorded
(cleared once forwarded), and the claim no longer tells the retry to skip the
budget; store-only and refused rows complete; the state is constrained to its
values; the retry tick runs and is scheduled; and no client role can call any
of it or read the table.

Since the P3 fix round it also proves
`20261022110300_support_inbound_retry_window.sql`: the window is 23 hours; the
first send attempt is recorded and later ones keep it; only the lease holder
may begin a send; past the window a claimed retry is told not to send and the
row is `failed`, a later delivery is a duplicate and the retry path never takes
it; a retry or a budget deferral whose next attempt would land past the window
fails at once; and a forward never attempted has no window. Proven against the
local stack on 2026-10-22: all 58 checks passed (43 before the fix round).

`realtime_revocation_rotation.sql` proves
`20261022120000_realtime_revocation_rotation.sql`: every way a member loses a
score, or loses write on it, moves the score to its next realtime topic
generation (the takedown's rotation, `20261020150100`), once per score per
transaction and only at commit (a deferred trigger; the proof fires it with
`SET CONSTRAINTS … IMMEDIATE`, as COMMIT would). Paths: editor -> viewer
(`set_document_member_role`, and `assign_score` flipping to view-only),
`remove_document_member` and `leave_document` in one transaction,
`revoke_share_link` withdrawing two members, `unassign_score`,
`end_student_sessions` (a reset) across two scores, an archive (the stamp,
then the session end, which does not move it again) and the district soft
delete (`retention_district_run`) of two students sharing a score. After each:
both old topics are told `topic_rotated`, the member who lost access is refused
both topics of the new generation (and the old), the members who stay join the
new one, and a viewer joins it without being able to send live ink. Gaining
access, a plain revoke and a restore move nothing, a score deleted in the same
transaction is skipped, and no client role reaches the queue. Needs the local
stack running (today's `realtime.messages` partition). Proven against the local
stack on 2026-10-22: all 59 checks passed; with the migration's three queueing
triggers dropped inside the transaction, 27 of them fail.

Since `20261022120100_realtime_revocation_races.sql` (Codex round 1 on #71) the
same proof also shows: an archived score gives no member (its owner included)
a generation, a join, live ink or presence, archiving moves it once at commit,
and restoring moves nothing and gives realtime back; `document_realtime_epochs`
holds no foreign key on `documents` (so the commit-time rotation never waits
on the score) yet a deleted score's generation still goes, after the
cascades; every assignment and membership insert locks the student's roster
row first, and an assignment for an archived student is refused under that
lock whoever writes it; and two rotations in a row tell generation 0, then
generation 1. Proven against the local stack (Realtime started) on
2026-10-22: all 78 checks passed; with the pre-fix definitions restored, 9 of
them fail.

`realtime_revocation_race.sql` proves the races in that migration between two
(or three) real sessions, in dblink connections as `postgres` that COMMIT their
own rows (random ids per run, since a deleted score leaves a tombstone; the
accounts, scores and districts are deleted again at the start and the end). A
step that must wait is sent asynchronously and the proof polls `pg_locks`
until that session is blocked before it moves the other on. R1: an archive,
then an assignment of the same student -- the assignment waits on the roster
row and is refused once the archive commits. R2: the other way round -- the
archive waits, and its rotation moves the score just granted. R3: a reset
(`end_student_sessions`), then an assignment -- it waits and goes through,
and the token from before the reset is refused the score while a fresh one
joins. R4: an assignment, then a reset -- the reset waits and moves that
score. R5: an archive, then the student redeeming a share link -- the
redemption waits, and the archived student is refused the score with either
token. R6: one `retention_district_run` soft-deleting two districts between
an assignment that locked first (the run waits, then moves that score) and
one that came after (it waits, then is refused); it first checks that only
its own two districts are due, since the run soft-deletes every due district.
D1/D2: a member removed, or an editor turned viewer, then the score deleted
-- no deadlock, and nothing left of the score. C1: two removals rotating one
score at once -- the second tells generation 1, not generation 0 again. Run it
against the LOCAL stack only, with Realtime started; pass `-v
peer_password=...` for anything but the local stack's password. Proven on
2026-10-22: all 41 checks passed; with the pre-fix definitions restored, 20 of
them fail (the deadlock aborts the deletion in D1 and D2).

Since `20261022120200_realtime_archive_recovery.sql` (Codex round 2 on #71,
decision 55) `realtime_revocation_rotation.sql` also shows that archiving is a
temporary denial: `realtime_topic_access` tells a member of an archived score
`{"status":"archived"}` (wait), the owner and an editor alike, on the token
issued before the archive, while a non-member is told null as for any score it
cannot open; once restored, the same token is told `{"status":"open","epoch":1}`
and joins generation 1, not 0, sending and tracking there again, with no second
rotation. It also checks who may call `realtime_topic_access` (signed-in users,
not anon), that a deleted score answers null, and that `redeem_share_link`
takes the roster lock before the membership. Proven against the local stack
(Realtime started) on 2026-10-22: all 88 checks passed.

`realtime_revocation_race.sql` adds H1/H2: a share redemption against the
district hard delete (`retention_district_run`) of the redeeming student. H1:
the redemption first, held open -- the hard delete waits on the roster row it
holds, then deletes the student, no deadlock. H2: the hard delete first,
stopped by a third session holding the student's account row between its
roster lock and the account's deletion; the student then redeems a link to a
score they are already on -- the redemption waits on the roster row before it
touches the membership, so the hard delete's cascade never waits on it, and
the redemption fails on the deleted account instead (a foreign-key error, not a
deadlock). Each first checks that only its own district is due, since the run
hard-deletes every due district. Its cleanup now also removes what deleting
its fixtures leaves behind (`document_storage_cleanup`, `district_billing_log`,
the membership hints in `realtime.messages`), so a run leaves no rows. Proven
on 2026-10-22: all 53 checks passed, on three runs; with the pre-fix
`redeem_share_link` restored, H2e fails (PostgreSQL's deadlock detector aborts
the redemption).

Both proofs need the Realtime container running, not only its schema: the
schema and `realtime.send` exist without it, but the day's `realtime.messages`
partition the checks write to is created by Realtime. With that partition
detached (inside a rolled-back transaction, Realtime stopped),
`realtime_revocation_rotation.sql` fails 49 of its 88 checks. So they belong
in a CI job that starts Realtime and checks that the partition exists (P1's
every-proof `supabase-local` job does both), not in one that excludes it.

## Launchfix P5: district retention and content strikes

`district_retention_reattribution.sql` proves
`supabase/migrations/20261022130000_district_retention_reattribution.sql`
(launch re-audit, Codex A4): a student the district soft delete listed under
district A and a human then re-attributed survives A's hard delete with their
markings -- moved to a private roster or to district B through
`admin_set_student_district` (which takes them off A's purge list and logs
`skipped_reattributed` under A, with where they went and who moved them), or
re-attributed the way the 20261021120800 correction did it, leaving the list
alone (the hard delete re-checks the roster row's district and account under
its lock, skips the student, takes them off the list and logs
`skipped_reattributed` with the count and ids). A list entry naming another
account than the roster row deletes neither. Controls: an unchanged student,
and one re-confirmed for A, are still scrubbed and deleted, and the hard
delete's own counts are unchanged; both functions stay the service role's.
Like the checkout proofs it ends with `failures | total`. Proven against the
local stack (PostgreSQL 17.11) on 2026-10-22: all 16 checks passed; against
the 20261021120700 / 20261021120800 definitions, 9 of the 16 failed.

## In CI

The `supabase-local` job runs every `tests/sql/*.sql` and
`supabase/sql-tests/sharing_access_control.sql` through
`scripts/ci/sql-proof.sh`, which reads both result shapes above and holds the
summary to the rows: a `failures | total` proof must print exactly `total`
check rows, `failures` of them failing, and the harness exactly its `k`
failing rows. A new proof runs there by being added. Any failing check fails the job: there is no list of
tolerated failures, and the only exception `.github/workflows/ci.yml` can hold is
a whole proof skipped with its reason (none). The job also fails, by name, unless
Realtime is running and has created today's `realtime.messages` partition, which
the broadcast checks write.
