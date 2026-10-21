# LC-FIX6 report: PR #62 (mh/launch-checkout), round-6 fix pass

- PR: https://github.com/maxharris1/Cleffy/pull/62 (draft into dev, still a draft; no reviewers requested)
- Start head: `39592f5fd09f123bcc2a27d1756d4dbb8e215d06` (confirmed equal before any change)
- **New head: `31cf9c5071834339e0e65ae8fff94c051b3d8f9f`** (fast-forward pushes only, no force; nothing pushed to main/dev; no merges)
- Environment: **Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2`** (confirmed with `get_session` at the start: `environment_id: env_01WAd3yiz3qpSnsofpyEwCh2`, `environment_kind: anthropic_cloud`). Not Sandbox.
- Commit identity: every commit authored and committed as `Max Harris <drumaxter@gmail.com>`.
- Local stack only (`supabase start` / `supabase db reset` on this container). No hosted Supabase, no Stripe, no secrets printed, no `.env` committed, no `playwright install`. No other session was messaged.

## Commits

| # | SHA | Summary | Packet item | Tests that cover it |
|---|---|---|---|---|
| 1 | `b60420c12067780640c068d1fb74cff228dd64b1` | fix(billing): serialize cancel-link deletes and inserts with advisory locks | 1 (tombstone race, unique outbox tombstone) | `tests/sql/cancel_link_tombstone_race.sql` (25 checks, real two-session race via dblink); `tests/migrationRecoverability.test.ts` (new 160600 block) |
| 2 | `6a0618bd444e1bc9170c6a3886250534b86daf7a` | fix(billing): no cancel-link expiry decided on the edge clock | 2 (edge clock) | `tests/billing/cancelFlow.test.ts` (3 new tests + rewritten static test), `tests/billing/cancelLinkStore.test.ts` (new edge-ahead end-to-end test; DB-clock helpers), `tests/sql/cancel_link_read_db_clock.sql` (10 checks) |
| 3 | `31cf9c5071834339e0e65ae8fff94c051b3d8f9f` | fix(billing): count a cancel link's time left after its INSERT | 3 (remaining lifetime after INSERT) | `tests/sql/cancel_link_save_after_insert.sql` (12 checks, two sessions, held FOR UPDATE lock); static check in `cancelFlow.test.ts` |

## The migration: `supabase/migrations/20261020160600_cancel_link_serialized_history.sql`

One new migration; S (160300), M4 (160400) and M5 (160500) are byte-unchanged (`git diff 39592f5f HEAD` on the three files is empty). It sorts after `20261020160500` and before #61's `20261020180400`. It was created in commit 1 and extended in commits 2 and 3 (see open question 1).

Re-runnable because: every function is `CREATE OR REPLACE` (no function is dropped or changes its result type); the one new trigger is `DROP TRIGGER IF EXISTS` then `CREATE TRIGGER`; the unique index is `CREATE UNIQUE INDEX IF NOT EXISTS` and the index it replaces is `DROP INDEX IF EXISTS`; the de-duplication of existing tombstones only runs when a duplicate exists, so it changes nothing on a second run; grants and revokes are idempotent. Verified locally: applied twice in a row, and the whole chain 160300 → 160400 → 160500 → 160600 replayed over a database that already has all four (what the CI replay step does). The replay loop in the supabase-local job now includes `20261020160600_cancel_link_serialized_history`.

### Item 1: advisory locks and a unique outbox tombstone

- `billing_cancel_link_lock_key(kind, value)` = `hashtextextended('cleffy.billing_cancel_link.' || kind || ':' || value, 0)`, kind `outbox` (uuid as text) or `hash` (SHA-256 hex). The namespace keeps the keys apart from each other and from any other advisory lock. Every path computes keys through this one function, so they always agree. A collision only makes two unrelated saves wait for each other.
- `billing_cancel_link_lock(outbox_id, hash)` takes `pg_advisory_xact_lock` on the outbox id, then the hash. Both are held to the end of the transaction.
- **Delete paths:** a new `BEFORE DELETE` row trigger (`billing_cancel_tokens_delete_lock`, SECURITY DEFINER) takes the locks before any row goes, whoever deletes it (account cascade, operator, service role). The tombstone trigger takes them again (re-entrant). `billing_mail_outbox_tick` collects its candidate hashes, takes **every outbox-id lock, then every hash lock, each in key order**, and only then deletes them, with its conditions read again. Every other path takes one outbox id and then one hash, so no two paths can wait on each other in a cycle.
- **Insert paths:** `billing_cancel_tokens_not_tombstoned` (BEFORE INSERT) takes the locks and **only then** reads the tombstones. `save_cancel_link_token_v2` takes them right after its `FOR UPDATE` row lock and before its own tombstone check. The text wrapper `save_cancel_link_token` calls v2. An insert under any isolation level other than READ COMMITTED is refused (55000): under READ COMMITTED each statement reads a fresh snapshot, so the check after the lock wait sees the committed tombstone. Under REPEATABLE READ the snapshot could predate the delete the insert waited on. PostgREST runs READ COMMITTED (the store test passes through it).
- **Unique outbox tombstone:** `billing_cancel_token_tombstones_outbox_once` is a UNIQUE index on `(outbox_id) WHERE outbox_id IS NOT NULL`. It replaces the non-unique `billing_cancel_token_tombstones_outbox`. Existing duplicates are handled in one DO block under `SHARE ROW EXCLUSIVE`: every row keeps its hash, and all but the earliest (by `deleted_at, token_hash`) get `outbox_id` set to null. The permanence trigger is disabled only for that UPDATE and re-enabled straight after. I checked this path once by hand, rolled back: with three duplicates, `dup1` kept the id, `dup2`/`dup3` became null, the index was unique and the trigger was back to `O`. When a request has two tokens (its link saved again after the secret was rotated), the tombstone trigger writes the second as `(hash, null)` (`ON CONFLICT DO NOTHING`, then by hash), so both hashes stay tombstoned. Before this change the tick's CTE would have written a second tombstone for the id. With a unique index, that CTE would have failed the tick.

### Item 2: no edge-clock expiry decisions

- `deliverCancelLink`: the early `expiresAtMs <= deps.now()` refusal (old cancelFlow.ts:339) is gone, and `CancelLinkDeps` has no `now` field at all (the worker wiring in `billingMailWorker.ts` drops it). A row with **no** expiry (`linkExpiresAt` null or unparsable) is still never mailed. That check involves no clock. The send is decided only on v2's `remaining_seconds >= CANCEL_LINK_SEND_MARGIN_S`.
- Token read/consumption (old cancelFlow.ts:481, `Date.parse(row.expiresAt) <= deps.now()`): gone. `readToken` now calls the new `read_cancel_link_token(p_hash)` RPC (SQL, `security invoker`, `search_path ''`, service_role only). It returns `{user_id, mode}` only for a token that is unused **and** has `expires_at > pg_catalog.clock_timestamp()`, and null otherwise. `liveToken` acts on that answer alone. `StoredCancelToken` is replaced by `LiveCancelToken {userId, mode}`.
- `consumeToken` is unchanged: a conditional `UPDATE ... WHERE used_at IS NULL`, which enforces single use. The expiry decision before the Stripe action is the DB read just before it. The consume deliberately does not re-check expiry, so a cancellation Stripe has already made never loses its refund request at the expiry boundary (see open question 3).
- **Every `deps.now()` left in `supabase/functions/_shared/cancelFlow.ts`** (grep after the change; there is no `Date.now()` in the file):
  - `:552` `summaryOf` → `withinRefundWindow(firstPurchaseAt, deps.now())`: the 14-day refund-eligibility window shown on the cancel page. This is not a link expiry decision.
  - `:605` `cancelledAt = new Date(deps.now()).toISOString()`: the timestamp reported to the buyer and written as `used_at`. It records a time and decides nothing.
  - `:616` `refundEligible = withinRefundWindow(firstPurchaseAt, deps.now())`: the same refund window, for whether support is emailed.
  - `:628` `requestedAtMs: deps.now()`: the time shown in the refund-request email to support.
- The static test (old `cancelFlow.test.ts:950`, which asserted that two `<= deps.now()` comparisons remain) now asserts the opposite, with comments stripped from the source first. It checks that there is no comparison either way with `deps.now()`, no `Date.now()`, no `expiresAt` in the code, no `now` in `deliverCancelLink`, no `now:` in `CancelLinkDeps`, that `billing-cancel` calls `rpc('read_cancel_link_token', { p_hash: hash })` and never touches `expires_at`, and that the migration's read compares `t.expires_at > pg_catalog.clock_timestamp()`.

### Item 3: remaining lifetime recomputed after the INSERT

In `save_cancel_link_token_v2` (160600), the time left is now recomputed as the final step, after the row lock, the advisory locks, the tombstone read and the token INSERT (which can wait on the FK check against a `FOR UPDATE`-locked `auth.users` row, or on another insert of the same hash). Steps:

1. Re-read the sooner of the request's and the stored token's expiry.
2. Compute `v_remaining := v_expires - clock_timestamp()` with a single clock read.
3. If `v_remaining < interval '120 seconds'`: when this call inserted the token (`FOUND` after `ON CONFLICT DO NOTHING`), bring its `expires_at` forward to `clock_timestamp()` in the same transaction. That is the only direction the token trigger allows, and it means `read_cancel_link_token` never answers for the token. Then settle the row `expired` / `expired before delivery`, remove `email` from its payload, and return `{"answer":"expired","remaining_seconds":<real floor, >= 0>}`.
4. Otherwise return `saved` with the post-INSERT seconds.

A token an earlier attempt saved is left untouched, as the existing pre-INSERT check already leaves it. The pre-INSERT check stays, so a save that is already too late inserts nothing.

## Tests run and results

All runs are on this container against the local stack (Postgres on 127.0.0.1:54422, PostgREST/gateway on 54421).

### Fail-before (39592f5f) and pass-after evidence

To get a faithful "before", I ran `supabase db reset` with the 160600 file moved out, so the database held exactly 39592f5f's migration set. I then ran the new proofs, restored the file, ran `supabase db reset` again with all migrations, replayed 160300–160600, and reran everything.

| Test | On 39592f5f | After the fix |
|---|---|---|
| `tests/sql/cancel_link_tombstone_race.sql` (item 1) | **19 of 25 fail** | 25/25 OK |
| `tests/sql/cancel_link_read_db_clock.sql` (item 2) | **8 of 10 fail** (no DB-clock read exists) | 10/10 OK |
| `tests/sql/cancel_link_save_after_insert.sql` (item 3) | **8 of 12 fail**. The blocked save answered `{"answer": "saved", "remaining_seconds": 121}` after waiting 4 s from 122 s left, which is exactly Codex's scenario. | 12/12 OK. The same race answers `{"answer": "expired", "remaining_seconds": 117}`, and the 10-minute case answers 596 (counted after the wait) |
| `cancelFlow.test.ts`, new item-2 tests, run against 39592f5f's `cancelFlow.ts` | **3 fail**: "edge clock ahead at entry" got `[{outcome:'expired'}]` instead of `[{outcome:'sent'}]`; "DB-valid link opens with edge clock ahead" got 404 instead of 200; the static test matched `<= deps.now()` | all 56 pass |
| `cancelLinkStore.test.ts`, new edge-ahead test, run with 39592f5f's `cancelFlow.ts` + `billingMailWorker.ts` | **fails**: `expected [] to have a length of 1` (no email sent with the edge clock 2 h ahead) | 7/7 pass |

Details of the item-1 failures on 39592f5f:

- **1c:** the owner's insert of the deleted hash **succeeded** once the tick committed. This is the resurrection.
- **1b:** the writer waited on the deleted tuple, not on an advisory lock.
- **2a–2d:** the save of the deleted hash was not refused as `spent`.
- **3a–3d:** an insert of a new hash under the deleted token's outbox id was not even made to wait, and it landed.
- **40:** REPEATABLE READ inserts were not refused.
- **52–54:** two tombstones carried the same outbox id, and no unique index existed.
- **60–63:** the lock functions and trigger did not exist.

### The concurrency test (item 1): true two-session test, feasible and wired into CI

The test runs three connections: the psql driver plus dblink sessions `a` and `b` as postgres. It checks four scenarios, with all rows committed:

1. `a` runs the cron tick (deleting an expired, spent hash H and writing its tombstone) inside an open transaction. `b` inserts H as the table's owner against a fresh pending request. `b` is busy, waiting on an **advisory** lock (checked in `pg_locks`). `a` commits. `b` is refused with "a cancel link that was spent or removed never comes back". H stays gone, its tombstone kept.
2. The same race with `b` calling `save_cancel_link_token_v2` for H under another request's lease. `b` waits, then answers `spent` and settles its row.
3. `a` deletes an account, whose cascade deletes its pending request's token. `b` inserts a *new* hash under that request's outbox id. `b` waits and is refused, and the request's id is tombstoned.
4. A REPEATABLE READ insert is refused. Then the outbox-id uniqueness checks run, including two tokens for one request.

The test cleans up its accounts and requests. Tombstones are permanent, so it uses random hashes and ids and can be re-run.

### Full suite (on the final head 31cf9c5)

- `npm run lint:check`: exit 0
- `npm run typecheck`: exit 0
- `npm run test`: exit 0, **198 files passed, 1 skipped** (`cancelLinkStore.test.ts`, which skips without the local-DB env, as designed); 2928 tests passed, 7 skipped
- `npm run build`: exit 0
- `npx prettier --check` on every changed TS/YAML file: clean. Prettier has no SQL parser here, so the `.sql` files follow the existing files' style by hand.
- Local stack, after `supabase db reset` with all migrations and the 160300–160600 replay:
  - `CLEFFY_REQUIRE_LOCAL_DB=1 npx vitest run tests/billing/cancelLinkStore.test.ts`: **7/7 passed**, 0 skipped
  - SQL proofs via `scripts/ci/sql-proof.sh`, all OK:

| Proof | Checks |
|---|---|
| `cancel_link_lifetime` | 57 |
| `cancel_link_tombstones` | 38 |
| `cancel_link_db_clock` | 21 |
| `cancel_link_tombstone_race` (new) | 25 |
| `cancel_link_read_db_clock` (new) | 10 |
| `cancel_link_save_after_insert` (new) | 12 |
| `checkout_consents` | 25 |
| `launch_checkout_fixes` | 46 |

The supabase-local job now replays 160300, 160400, 160500 and **160600**, and runs the three new proofs alongside the five existing ones. It still uses the local stack only, with no secrets and no `billing_double_charge.sql`.

## CI on the new head

**All green on `31cf9c5`.** There are two CI runs, push [39687782337](https://github.com/maxharris1/Cleffy/actions/runs/39687782337) and pull_request [39687787895](https://github.com/maxharris1/Cleffy/actions/runs/39687787895). Both are completed/success, with the same result in each job:

- `checks`: SUCCESS
- **`supabase-local`: SUCCESS**
- `omr-service`: SUCCESS
- `supabase-drift`: SUCCESS
- Vercel Preview Comments: SUCCESS
- Supabase Preview: SKIPPED (as before)

The supabase-local log (push run, job 119526121572) shows:

- The replay loop ran with 160600 included.
- `cancelLinkStore.test.ts`: **7/7 passed**, 0 skipped.
- Proofs, all OK and no skips:

| Proof | Checks |
|---|---|
| `cancel_link_lifetime` | 57 |
| `cancel_link_tombstones` | 38 |
| `cancel_link_db_clock` | 21 |
| **`cancel_link_tombstone_race`** | **25** |
| **`cancel_link_read_db_clock`** | **10** |
| **`cancel_link_save_after_insert`** | **12** (`{"answer": "expired", "remaining_seconds": 117}` / `{"answer": "saved", "remaining_seconds": 596}`) |
| `checkout_consents` | 25 |
| `launch_checkout_fixes` | 46 |

I did not separately record CI for the intermediate pushes `b60420c` and `6a0618b`. Each was validated locally (lint, typecheck, test, build and the SQL proofs) before its push.

## Regenerated migrations count

`npm run migrations:mirror` (never hand-edited): **74 total SQL / 72 mirrored** on #62 (was 73/71; the two IMSLP catalog migrations stay excluded). Codex's combined count becomes **94 / 92** once all four PRs merge.

**`tests/migrationRecoverability.test.ts` was updated by hand** with a new `20261020160600_cancel_link_serialized_history — replays cleanly` block. The generator does not write it, so it **must be reconciled by hand at merge time**, like the 160300/160400/160500 blocks and the cron-job map.

## Byte parity of the shared files

`git diff 39592f5fd09f123bcc2a27d1756d4dbb8e215d06 HEAD -- supabase/functions/_shared/resendDelivery.ts supabase/functions/_shared/mailBudget.ts supabase/functions/_shared/legalVersions.ts tests/security/resendDelivery.test.ts tests/security/mailBudget.test.ts` is **empty** (0 lines). The SHA-256 first-16 hashes still match the r6 parity table:

| File | SHA-256 (first 16) |
|---|---|
| `mailBudget.ts` | `1676e01b7296156d` |
| `resendDelivery.ts` | `1e24b2e37007ecb6` |
| `legalVersions.ts` | `332c1dd5c0b8b9e4` |
| `mailBudget.test.ts` | `42c8eb4aa959ab0b` |
| `resendDelivery.test.ts` | `515a4aaf623931c6` |

No change to any of them was needed.

## Skipped minors and side effects (not fixed, with reasons)

- **An expired request now reaches the DB before it is refused.** Removing the edge-clock early refusal means a row whose hour has passed is only refused by v2. On its way there it counts a per-recipient limit and a mail-budget reservation, and the existing policy keeps both on `expired` ("a reservation is only handed back when nothing can have gone"). Before, an edge clock that agreed refused such a row before counting anything. It is rare: it needs a row held past its hour, usually by a spent budget. I left the refund policy unchanged because the packet scopes this pass to the three items (open question 2).
- **Multi-row deletes outside the tick lock row by row, not in key order.** That covers an operator's multi-row `DELETE` and an account cascade covering several tokens. They are serialized correctly, but two such statements racing could deadlock. Postgres then aborts one, and nothing is lost or resurrected, because the locks are taken before any history is read. The tick, the save and single-row paths cannot deadlock with each other.
- **The legacy text wrapper `save_cancel_link_token` was not re-created in 160600.** It only forwards to v2 by name (M5), so it gets the new body automatically.

## Open questions

1. **I edited 160600 after it was first pushed.** The packet requires ONE new migration and a push after each item, so `20261020160600_cancel_link_serialized_history.sql` was created in commit 1 and extended in commits 2 (read RPC) and 3 (post-INSERT recount). Nothing was amended or force-pushed. It was never reviewed or applied anywhere but this container's local stack. I read "don't edit already-pushed migrations" as covering reviewed migrations (S/M4/M5, decision 34). If Max wants each item in its own migration instead, that is a mechanical split.
2. **Should `expired`/`spent` hand back this attempt's per-recipient count (and budget)?** Nothing went out from this attempt. Now that expiry is only the DB's call, an expired row costs one count. I'd suggest handing back at least the per-recipient count. That is a policy change outside round 6, so I left it.
3. **Should `consumeToken` also refuse an expired token?** I kept it single-use only, with no expiry re-check. A cancellation that Stripe has just made, on a token the DB read as valid a moment earlier, therefore never loses its refund request at the expiry boundary. If the reviewer wants consume to refuse on expiry too, it is a one-line `and expires_at > clock_timestamp()` in a consume RPC.
4. **Designated branch.** The session harness named `claude/cancel-link-tombstone-race-fix-3wcalb` as its outcome branch. Following the task's explicit instructions, all work went to `mh/launch-checkout` and the report went to `claude/lc-fix6-report-launch-checkout`. Nothing was pushed to the harness branch.
5. Nothing needed from another session. #61/#63/#64 were not touched and are not affected beyond the known merge-time regeneration of `scripts/apply-migrations.sql` and the hand reconciliation of `tests/migrationRecoverability.test.ts`.
