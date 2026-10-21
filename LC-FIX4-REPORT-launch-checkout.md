# LC-FIX4 report: #62 `mh/launch-checkout` (round-4 fix pass)

- **PR:** https://github.com/maxharris1/Cleffy/pull/62 (still a draft, base `dev`; no reviewers requested)
- **Start head:** `d9b83e20e37dc041040a9048d5ae895dbe4cb1d8` (confirmed before any change)
- **New head:** `6ab8228e7f7a3e867a642816abdd2ea17c11b3c9` (fast-forward from d9b83e20; nothing force-pushed)
- **Environment:** Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (`environment_kind: anthropic_cloud`), confirmed with `get_session` at the start. Not Sandbox.
- **Scope kept:** only the round-4 items. Pushes went to `mh/launch-checkout` and to this report branch only. No merges. PR #54, hosted Supabase (prod and dev), live Stripe, other sessions' branches: none touched. Local stack only (`npm run cloud:up`, then `npm run cloud:down`).

## Commits (all authored by Max Harris <drumaxter@gmail.com>)

| SHA       | Summary                                                                 |
| --------- | ----------------------------------------------------------------------- |
| `78ee399` | Cancel links: fix the expiry once, when the link is asked for           |
| `62bd6e0` | Cancel links: never send one after its expiry                           |
| `c7529f6` | Restore imslpLicense.ts, reformatted by accident in the previous commit |
| `6ab8228` | Cancel links: a spent link can never be revived                         |

`c7529f6` is housekeeping. A `prettier --write supabase/functions/_shared/*.ts` glob in 62bd6e0 also rewrapped one line of the unrelated `imslpLicense.ts` (whitespace only). c7529f6 restores it byte for byte to d9b83e20. Net diff for that file from d9b83e20 to the head: empty.

### Findings mapped to commits and tests

| Codex round-4 finding                                                                                                            | Commit(s)                                                 | Tests that cover it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Partial: concurrent saveToken retries** (`billingCancelStore.ts:120`, expiry last-writer-wins, no real-store concurrency test) | `78ee399`                                                 | `tests/sql/cancel_link_lifetime.sql` §2 (10–18) and §5 (30–34: two dblink sessions; the second blocks on the first's row lock; one token keeps the first expiry). `tests/billing/cancelLinkStore.test.ts` "two retries at once keep the expiry the link was asked with" (production `saveToken` and `deliverCancelLink`, run against local PostgREST). `cancelFlow.test.ts` "a retry after a lost answer mails the identical email, and leaves the expiry where it was" and "a worker that lost the row's lease saves nothing and sends nothing"                                                                                                                                                                            |
| **Partial: expiry refresh** (`cancelFlow.ts:336-341`, retry refreshes the DB expiry; no delayed-retry or cleanup test)           | `78ee399` (no refresh) + `62bd6e0` (no send after expiry) | `cancel_link_lifetime.sql` §1 (01–05) and §3 (20–26). `cancelLinkStore.test.ts` "a retry delayed past the expiry sends nothing, is settled for good, keeps the budget, and the link stays dead" (goes through the production worker `drainBillingMailNow`). `cancelFlow.test.ts`: "a link the mail budget held back is good until an hour after it was asked for, and says so", "a retry delayed past the expiry …", "the database's clock has the last word …", "a row with no expiry is never mailed"                                                                                                                                                                                                                     |
| **New major: spent links can be resurrected** (`billingCancelStore.ts:110-120`)                                                  | `6ab8228` (on top of 78ee399 and 62bd6e0)                 | `cancel_link_lifetime.sql` §4 (40–69): acceptance, lost answer, consumption, retry after use, delayed retry, cleanup, attempted re-pending and re-insert, delete guards, account-deletion cascade. `cancelLinkStore.test.ts` "a link sent with its answer lost, used, then retried late and cleaned up, never works again" and "a retry after the link was used keeps it spent, and keeps its expiry". `cancelFlow.test.ts` "a link used after a lost answer is never mailed or made usable again by a late retry". Wiring and replay guards: `cancelFlow.test.ts` "saves a link only through save_cancel_link_token …" and `migrationRecoverability.test.ts` "20261020160300_cancel_link_token_lifetime — replays cleanly" |

The packet's test list maps as: **4a** concurrency is SQL §5 plus the store test "two retries at once". **4b** delayed past expiry is SQL §3 plus the store and flow "delayed past the expiry" tests. **4c** acceptance → consumption → delayed retry → cleanup → retry is SQL §4 (40–60) plus the store test "… never works again". **4d** retry after use keeps `used_at` is SQL 45–46 plus the store test "a retry after the link was used keeps it spent". **4e** is the evidence section below.

## How it is enforced

Everything is in one new migration: **`supabase/migrations/20261020160300_cancel_link_token_lifetime.sql`**. It sorts after #62's `20261020160200_billing_mail_outbox.sql` and before #61's `20261020180400…`, so the binding merge order #63 → #62 → #61 → #64 still has no later-merged PR adding an earlier timestamp. No existing migration was edited. `scripts/apply-migrations.sql` was regenerated with `npm run migrations:mirror` in each commit and never hand-edited. The tree now has 71 migration files, 69 mirrored.

### 1. The expiry is set once

- `billing_mail_outbox.link_expires_at` is added. A `BEFORE INSERT` trigger (`billing_mail_outbox_link_lifetime`) always sets it to `created_at + 1 hour` for `cancel_link` rows and ignores any value the insert supplies. `enqueue_billing_mail` is unchanged, so every insert path gets the expiry, including the 4-argument RPC that `billing-cancel` calls. The check `billing_mail_outbox_link_expiry` requires it on cancel links and forbids it on confirmations. Rows that already exist are backfilled from `created_at`.
- The same trigger refuses any `UPDATE` that clears the expiry or moves it later (SQLSTATE 55000). It can only be brought forward, which can only make a link die sooner.
- The token is saved only by `save_cancel_link_token(outbox_id, claim, hash, user)`. It locks the outbox row `FOR UPDATE`, requires the caller to hold the row's current lease on a pending cancel-link row, copies the row's expiry and mode, and runs `INSERT … ON CONFLICT (token_hash) DO NOTHING`. The first save wins. Later saves, concurrent ones included, touch neither `expires_at` nor `used_at`. It answers `saved`, `expired` or `not_held`.
- `billingCancelStore.ts saveToken` now just calls that RPC; the PostgREST upsert is gone. The worker passes the lease and `link_expires_at` from `claim_billing_mail` into `deliverCancelLink` as a 5th argument.
- **Email wording changed (necessary consequence).** The cancel-link email used to say "expires in 60 minutes". With the expiry fixed at creation, that is false for any link the budget held back. It now says "It works once, until <formatUtc(expiry)>". `cancelLinkEmail(link, expiresAtMs)` takes the fixed expiry, so the email is still byte-identical on every retry of a row, which the Resend idempotency key depends on.

### 2. No sends after expiry

- `deliverCancelLink` checks the row's expiry first, before the per-recipient limit, the lookup or any budget reservation. It checks again just before the send. `save_cancel_link_token` also answers `expired` from the database's own clock.
- In every one of those cases the delivery is `{outcome: 'expired', reason: 'expired before delivery'}` and nothing is sent. Nothing is refunded: earlier attempts' mail-budget reservations stay, per decisions 12 and 18, and if the database refuses at save time, that attempt's own reservation stays too. A row with no expiry is treated as expired.
- `settle_billing_mail` (CREATE OR REPLACE, same signature) gains `expired` for cancel links. It sets `status = 'expired'`, clears the lease, keeps the reason in `last_error`, and removes the address (`payload - 'email'`). `expired` is added to the status check. The drain counts an expired row under `done` and logs it. Settling a confirmation as `expired` raises 22023.
- `claim_billing_mail` only takes pending rows, so an expired row is never handed out again.

### 3. A used token is never re-created

The **`billing_cancel_tokens_lifetime`** trigger (BEFORE INSERT/UPDATE/DELETE, SECURITY DEFINER, `search_path ''`, no EXECUTE for anyone) guards every writer, not only the application:

- **INSERT** is allowed only with an `outbox_id` (a new column, indexed) that names a pending `cancel_link` row whose fixed expiry has not passed. The token's `expires_at` is forced to that row's expiry.
- **UPDATE** cannot change the link, account, mode or row, cannot move `expires_at` later, and cannot clear or change `used_at` once it is set.
- **DELETE** is allowed only when the token has expired and its outbox row can no longer retry (sent and deleted, expired, given up and deleted by the day-old cleanup, or gone). The other allowed case is that its account is gone, which is how the `auth.users` cascade still works; SQL 66–68 prove it.

The **outbox trigger** refuses moving a row from `sent` or `expired` back to `pending`. A settled row is never claimed, and its old lease no longer matches, so it can never save its token again (SQL 55–57).

**Cleanup** moved out of `billingCancelStore.ts` into `billing_mail_outbox_tick` (CREATE OR REPLACE, same body plus one delete). It removes a token only when it has expired and no pending outbox row has its `outbox_id`. The store no longer writes the token table directly at all.

**Why revival is now impossible at the database level:** a token can only be absent if it expired with its row unable to retry, or its account is gone. Re-inserting it needs a pending row before that row's fixed expiry. The expiry can't be pushed later and a settled row can't become pending, so that condition can never hold again. If a token row still exists, the hash conflicts, `DO NOTHING` applies, and `used_at` can't be cleared. This holds against direct SQL and against the old upsert statement, not just the application's code path (SQL 15, 16, 43, 44, 48, 58, 59, 62, 65).

### Why the migration is re-runnable

All of it is guarded: `add column if not exists`, `create index if not exists`, `drop constraint if exists` before each `add constraint`, `drop trigger if exists` before each `create trigger`, and `create or replace function` for every function. The backfill only touches rows still missing an expiry. Tested by applying the file a second time with `psql -v ON_ERROR_STOP=1` over an already-migrated database (only "already exists, skipping" notices) and, after each commit, by applying the edited file over the previous version. It does not touch the cron job: the existing `billing-mail-outbox` job calls the tick by name, so the job map in `migrationRecoverability.test.ts` stays at 10 jobs.

## Tests run and results

Run on the local stack (Supabase CLI, PostgreSQL in `supabase_db_cleffy`), after each commit and again on the final head after a fresh `supabase db reset`.

| Check                                                                                                                             | Final head 6ab8228                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run lint:check`                                                                                                              | clean                                                                                                                                      |
| `npm run typecheck`                                                                                                               | clean                                                                                                                                      |
| `npm run test`                                                                                                                    | **198 files passed, 1 skipped; 2911 tests passed, 4 skipped** (the skipped file is `cancelLinkStore.test.ts`, which needs the local stack) |
| `npm run build`                                                                                                                   | exit 0                                                                                                                                     |
| `npx prettier --check` (changed non-SQL files)                                                                                    | clean                                                                                                                                      |
| `tests/billing/cancelLinkStore.test.ts` with the local stack                                                                      | **4/4 passed**                                                                                                                             |
| `tests/sql/cancel_link_lifetime.sql` (new)                                                                                        | **0 failures / 56**                                                                                                                        |
| `tests/sql/launch_checkout_fixes.sql`                                                                                             | 0 / 46                                                                                                                                     |
| `tests/sql/checkout_consents.sql` (30–31 updated: the token is now saved for a cancel-link request, as the insert guard requires) | 0 / 24                                                                                                                                     |
| `tests/sql/billing_double_charge.sql`                                                                                             | 3 / 98 fail: checks 89, 92 and 98, the anon/authenticated grants already on dev (decision 20). Not caused by this change                   |
| Migration re-run over the migrated DB                                                                                             | clean                                                                                                                                      |

**Local-environment note.** With the local stack's `.env.local` present, two unrelated tests fail: `src/sync/syncEngine.test.ts` (backoff jitter) and `tests/auth/turnstileField.test.tsx`. Both pass with `.env.local` moved aside, which matches CI (no `.env.local`). The full-suite numbers above were taken that way.

### Fail-before / pass-after evidence (packet item 4e)

Method: a git worktree at d9b83e20 with the final versions of the new and changed test files copied in. The local DB was reset to d9b83e20's migrations (`supabase db reset` from the worktree). The tests were run there, then the DB was reset back to the head and everything was run again.

**Unit (vitest, in-memory flow, d9b83e20 code).** In the worktree copy only, the harness's store model also accepted d9b83e20's old `saveToken({hash, userId, mode, expiresAt})` upsert contract, exactly as d9b83e20's own harness modelled it. That way pre-existing tests are not broken by the call-shape change and the failures are behavioural. Result: **9 failed / 93; every pre-existing test passed; every new test failed:**

- held-back link: `expected '…21:20:00.000Z' to be '…21:00:00.000Z'` (the expiry was measured from the send)
- retry after a lost answer: `expected '…21:25:00.000Z' to be '…21:00:00.000Z'` (the retry refreshed the expiry)
- delayed past expiry; the round-4 major sequence; DB clock refuses; no expiry: `expected [{outcome:'sent'}] to deeply equal [{outcome:'expired', …}]` (the expired link was mailed again)
- lost lease: `expected {outcome:'sent'} to … {outcome:'retry', …}`
- wiring: no `rpc('save_cancel_link_token'` in the store
- `migrationRecoverability`: the new migration is missing

**Real store (`cancelLinkStore.test.ts`, d9b83e20 store code and schema): 4 failed / 4.**

- (a) `expected 1792619947700 to be 1792619947671`: the saved expiry is the send time + 1 h, not the request time + 1 h. This fails at the first save, before the concurrent pair.
- (b) the late retry was sent again: Resend got 2 requests, expected 1.
- (c) `expected true to be false` on `linkWorks`: **the spent link works again** after the delayed retry and cleanup. This is the major, reproduced.
- (d) the token row changed after the retry: its expiry moved.

**SQL (`cancel_link_lifetime.sql`, d9b83e20 schema).** The proof uses `ON_ERROR_STOP`, so on the old schema it stops at its first statement that needs a new column. For the evidence it was also run as a copy with `ON_ERROR_STOP off` and `ON_ERROR_ROLLBACK on`, so each check records its own result: **44 failed / 56**.

- Behavioural failures, where the old schema accepts the write: 15 (the old upsert refreshes the expiry), 16, 43 (`used_at` cleared), 44, 48 (a spent token deleted while its row retries), 55 (a settled row re-pended), 59 (the old upsert re-inserts the spent token), 62.
- The rest fail because the new column, function or trigger is missing.
- The 12 that pass on both are setup or invariants that already held (21, 24, 26, 34, 41, 47, 49, 53, 54, 56, 67, 68).

**Pass-after:** on the head with a freshly reset DB: unit, real-store and SQL all pass (numbers in the table above).

## CI on the new head

PR #62 head `6ab8228e`, read through the GitHub API at about 21:01 UTC on 2026-10-21:

- `checks` (lint, typecheck, test, build, audit): **success**, both the push run and the PR run
- `omr-service`: **success** (both runs)
- `supabase-drift`: **success** (both runs)
- Vercel Preview Comments: **success**
- Supabase Preview: skipped (as before)
- `mergeable_state`: **clean**

No CI failures needed fixing. This is #62 green **on its own**; the combined merge with #63, #61 and #64 is untested, as in Codex's note.

## Byte parity of the shared files

`git diff d9b83e20e37dc041040a9048d5ae895dbe4cb1d8 HEAD -- supabase/functions/_shared/resendDelivery.ts supabase/functions/_shared/mailBudget.ts tests/security/resendDelivery.test.ts tests/security/mailBudget.test.ts` printed **nothing (0 bytes)**. SHA-256 prefixes at the head match Codex's table: `resendDelivery.ts` 1e24b2e37007, `mailBudget.ts` 1676e01b7296, `resendDelivery.test.ts` 515a4aaf6239, `mailBudget.test.ts` 42c8eb4aa959. None of the four needed to change.

## Merge-time notes

- **`tests/migrationRecoverability.test.ts` was updated by hand** with a new `describe` block for 20261020160300. It checks that the migration exists and sorts after 160200, that every column, index, constraint and trigger is guarded with no bare `create function` or `create table`, and that it never schedules or unschedules cron. The cron job map is unchanged. The generator does not write this file, so **reconcile it by hand at merge time** (keep this block next to #63's, #61's and #64's additions).
- **`scripts/apply-migrations.sql`** must be regenerated from the combined sorted set after each merge (decision 6). This branch's copy matches its own generator output.
- The new migration changes the counts in Codex's cross-PR table: #62 is now 71 SQL migrations (69 mirrored), and the combined total becomes 87/85 (previously 86/84).
- `checkout_consents.sql` 30–31 changed so the test token is saved for a cancel-link outbox row. Anyone writing to `billing_cancel_tokens` must now supply a pending `outbox_id`. No other branch touches the table: `git grep billing_cancel_tokens` over `tests/` and `supabase/` finds nothing on `origin/mh/district-seats` @94390c9, `origin/mh/launch-legal-pages` @b8adc51 or `origin/mh/launch-consent` @82d32c7 (they were read only).

## Skipped minors

None. Codex reported no new minors for #62.

## Open questions

1. **TTL vs. the mail budget (product call).** Expiry now counts from the request, as required, so a link the hour budget holds back for most of an hour arrives with little time left. If the window doesn't reopen before the hour is up, the link is never sent; the customer sees nothing and has to ask again. Options: keep it (safest, and what the packet asks), lengthen `CANCEL_LINK_TTL_MS` together with the SQL `interval '1 hour'` (a test pins the two together), or reserve budget for cancel links. I made no change.
2. **Re-inserting an outbox row with a reused id.** The token is HMAC(secret, row id). An operator who deleted a cancel-link row and re-inserted one with the _same explicit uuid_ would produce a fresh pending row whose link is the old link's. No code path does this: `enqueue_billing_mail` always uses `gen_random_uuid()`. Closing even that case would mean deriving the token from `id` plus `link_expires_at`. That is a small change to `cancelLinkToken`, but it changes every link and the round-3 determinism contract, so I left it as a question rather than widen the PR.
3. **`cancelLinkStore.test.ts` is skipped in CI** because CI has no database, the same as `tests/sql`. If Max wants it enforced, a CI job with `supabase start` could run it and the SQL proofs.
4. Not asked of any other session; nothing needed from #61, #63 or #64.

## Environment confirmation

Run entirely in the **Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2`** (anthropic_cloud), not Sandbox. Local Supabase only. The local service-role key went into the test process's environment and was never printed. No `.env` file or secret was committed.
