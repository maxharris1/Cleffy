# LC-FIX5 report: PR #62 (mh/launch-checkout), round-5 fix pass

- PR: https://github.com/maxharris1/Cleffy/pull/62 (still a draft into `dev`; no reviewers requested, no merges, no new PRs)
- Start head: `6ab8228e7f7a3e867a642816abdd2ea17c11b3c9` (confirmed before any change)
- **New head: `39592f5fd09f123bcc2a27d1756d4dbb8e215d06`** (three fast-forward pushes, no force)
- Environment: Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (`anthropic_cloud`), confirmed with `get_session` at the start. Not Sandbox.
- Commit identity: Max Harris <drumaxter@gmail.com> on every commit.

## Commits

| SHA                                        | Summary                                                                    | Covers                                                                                                                                                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `794cd03607d942c37afa2d6df5534f4a6ade0c28` | fix(billing): tombstone deleted cancel links; decide sends on the DB clock | **Major 1** (tombstones) and **Major 2** (DB clock, 120 s margin, remaining-seconds send gate): migration `20261020160400_cancel_link_tombstones_db_clock.sql`, cancelFlow.ts, billingCancelStore.ts, tests |
| `9c8056016e36f0ef0048f42da9e395fd62bc2daf` | fix(billing): keep save_cancel_link_token returning text so 160300 replays | Follow-up for both majors: migration `20261020160500_cancel_link_save_replayable.sql` (see "Deviation" below)                                                                                               |
| `39592f5fd09f123bcc2a27d1756d4dbb8e215d06` | ci: run the checkout and cancel-link DB tests against a local Supabase     | **CI item** (decision 30): new `supabase-local` job, `scripts/ci/sql-proof.sh`, a guard so the store test fails instead of skipping                                                                         |

Majors 1 and 2 are in one commit because they share one migration and the same RPC. Once a migration is pushed it can't be edited, so they couldn't be pushed one at a time.

### Mapping to tests

| Item                                | Commit(s)        | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Major 1: tombstones                 | 794cd03, 9c80560 | `tests/sql/cancel_link_tombstones.sql` (38 checks); `tests/billing/cancelLinkStore.test.ts` "a spent link the cleanup deleted is tombstoned: no direct insert and no re-used row id brings it back"; unit test "a link already spent or removed is refused for good"; `cancel_link_lifetime.sql` 15a, 58, 59, 65; `checkout_consents.sql` 29                                                                                                                                                       |
| Major 2: DB clock, 120 s, send gate | 794cd03, 9c80560 | `tests/sql/cancel_link_db_clock.sql` (21 checks, incl. a dblink session holding the row lock past the expiry and from 122 s to under 120 s); store test "hands back the database's own count of the seconds left, and refuses under 120"; unit tests "the edge clock running behind cannot send a link the database says has under 120 s left" and "sends on the database's count of the seconds left, not the edge function's"; static test "sends only on the database's count of the time left" |
| CI DB job                           | 39592f5          | Job `supabase-local` in `.github/workflows/ci.yml`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## How it is enforced

### Tombstones (Major 1, decision 29)

- **Table** `public.billing_cancel_token_tombstones (token_hash text primary key, outbox_id uuid, deleted_at timestamptz default now())`. It holds no user id, no address and no mode. RLS is on.
- **Written in the same transaction as the delete:**
    - `billing_mail_outbox_tick` now deletes expired, non-retryable tokens in a CTE (`with gone as (delete … returning token_hash, outbox_id) insert into …tombstones … on conflict do nothing`). The tombstone is written in the same statement as the delete, and if the insert fails, the delete fails with it.
    - An AFTER DELETE row trigger, `billing_cancel_tokens_tombstone` (SECURITY DEFINER, `search_path = ''`), writes the tombstone for every other delete: the account-deletion cascade, an operator, a service_role DELETE. Decision 29 says "spent _or deleted_", so I covered every delete path, not only the tick.
- **Refused on insert:** a BEFORE INSERT trigger, `billing_cancel_tokens_not_tombstoned` (SECURITY DEFINER), raises 55000 "a cancel link that was spent or removed never comes back" when the hash, or a non-null outbox id, is tombstoned. It fires for every role, including the table owner. Proven as `postgres` in tombstones.sql 13, 14 and 27.
- **Refused by the save:** `save_cancel_link_token_v2` takes the row lock (pending, own claim) and then checks tombstones on both the hash and the outbox id. On a hit it answers `spent` and settles the row for good (`status = 'expired'`, `last_error = 'cancel link already spent or removed'`, address removed). A row that is already settled isn't pending, so it answers `not_held`, and 20261020160300's trigger stops a settled row ever going back to pending. A request re-created under a deleted row's UUID (same HMAC) is refused this way (tombstones.sql 20–25 and the store test).
- **Permanent:** the `billing_cancel_link_history_kept` trigger function blocks UPDATE, DELETE and TRUNCATE on tombstones for every role, including the owner. It also blocks TRUNCATE on `billing_cancel_tokens`, because a truncate would delete tokens without tombstoning them.
- **Grants:**
    - Tombstones: `revoke all … from public, anon, authenticated, service_role`, then `grant select … to service_role` (the store test reads it). INSERT, UPDATE, DELETE and TRUNCATE are revoked from everyone. Only the SECURITY DEFINER functions (owner `postgres`) write tombstones.
    - **Direct INSERT on `billing_cancel_tokens` is revoked from service_role**, along with TRUNCATE, and from PUBLIC, anon and authenticated. It was feasible: nothing in production inserts directly (the store only calls the RPC, and the cancelFlow static test asserts that). The save is now SECURITY DEFINER with `search_path = ''`. service_role keeps SELECT and UPDATE (billing-cancel spends a link) and DELETE (every delete is tombstoned). Proven in tombstones.sql 11, 12 and 49, lifetime.sql 15a, and checkout_consents.sql 29.

### DB clock after the lock, 120 s margin (Major 2, decision 30)

- `save_cancel_link_token_v2(uuid, uuid, text, uuid) returns jsonb`:
    - It locks the outbox row with `select … for update` first.
    - Every time comparison after that uses `clock_timestamp()`. The function body never uses `now()` (clock.sql 09 checks the function source).
    - The effective expiry is `least(row.link_expires_at, existing token's expires_at)`.
    - If `v_expires - clock_timestamp() < interval '120 seconds'`, it settles the row `expired` there and then (address removed, lease kept so the worker's `settle_billing_mail('expired')` still records it) and returns `{"answer":"expired","remaining_seconds":n}` with n between 0 and 119.
    - Otherwise it inserts with `ON CONFLICT DO NOTHING` and returns `{"answer":"saved","remaining_seconds":n}` with n ≥ 120, counted on the DB clock.
    - `not_held` and `spent` return `remaining_seconds: 0`.
- The token guard `billing_cancel_tokens_lifetime` (INSERT branch) now checks `v_expires <= clock_timestamp()` instead of `now()`. Its DELETE branch still uses `now()`: that decides when cleanup may delete, not whether a send can go out.
- Nothing else decides whether a send can go out. `claim_billing_mail` and `settle_billing_mail` make no expiry decision.
- **Edge gate** (`supabase/functions/_shared/cancelFlow.ts`):
    - The final send decision is `if (saved.answer !== 'saved' || saved.remainingSeconds < CANCEL_LINK_SEND_MARGIN_S) return EXPIRED;` with `CANCEL_LINK_SEND_MARGIN_S = 120`. The old `expiresAtMs <= deps.now()` check after the save is gone.
    - The early edge-clock check before anything is counted is kept. It can only refuse, and its purpose is not to spend rate-limit or budget on a link that is plainly dead.
    - `spent` maps to an `expired` outcome with reason "cancel link already spent or removed". Refusals keep this attempt's budget reservation (decision 12).
- `billingCancelStore.ts saveToken` calls `rpc('save_cancel_link_token_v2')` and validates both `answer` and a finite numeric `remaining_seconds`. Anything else throws, and the row is retried, never sent.

### Migrations

- `20261020160400_cancel_link_tombstones_db_clock.sql` is safe to re-run:
    - `create table if not exists`, `create index if not exists`
    - every trigger preceded by `drop trigger if exists`
    - `create or replace` for functions
    - `drop function if exists` before re-creating the save, whose result type it changed
    - idempotent grants and revokes
- `20261020160500_cancel_link_save_replayable.sql` is safe to re-run: `drop function if exists public.save_cancel_link_token(uuid,uuid,text,uuid)` (named by argument types only, whatever it returns), then `create or replace` for `save_cancel_link_token_v2` (jsonb) and `save_cancel_link_token` (text, a wrapper returning v2's `answer`, SECURITY DEFINER), and the grants.
- Both sort strictly between #62's `20261020160300` and #61's `20261020180400`; the recoverability test asserts this.
- `S` (`20261020160300`) is byte-identical to 6ab8228e. No pushed migration was edited and nothing was amended.
- Replays verified locally and in the CI job: S → 160400 → 160500 in order, applied over a database that already has all three; 160400 three times; 160500 twice.

### Deviation: a second new migration

The packet asked for exactly one new migration. 794cd03 shipped 160400 alone, but it changed `save_cancel_link_token` from `returns text` to `returns jsonb`. While writing the CI replay step I found that this makes **S fail to replay** over a database that has 160400 (`ERROR: cannot change return type of existing function`; reproduced locally in a rolled-back transaction).

160400 was already pushed, and the rules forbid editing a pushed migration, so I fixed it in a follow-up, 160500:

- The jsonb save moves to `save_cancel_link_token_v2`. Its body is byte-identical to 160400's save (checked programmatically).
- `save_cancel_link_token` is put back to text. It's a thin wrapper over v2, so the previous edge function, which runs during rollout until the new one deploys, still saves under every new guard. It doesn't recognize the new `spent` answer, so it throws and retries, and the row is already settled.

Net effect: two new migrations instead of one. I chose this over leaving S unable to replay. See open question 1.

## Tests run and results

All on the local stack only (`supabase start`, project `cleffy`, ports 5442x). Hosted Supabase and Stripe were never touched. The stack is stopped with `--no-backup`.

### Fail-before (6ab8228e code and database) and pass-after

| Test                                                              | On 6ab8228e                                                                                                                                                                                                                                                                                                                                                                                                                | With the fix |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `tests/sql/cancel_link_tombstones.sql`                            | 794cd03 version: **26 of 38 fail** (6, 7, 11, 12, 13, 15, 21–23, 26–28, 30, 32, 40–51). Final version: **28 of 38 fail**. 11 and 12: "no error raised" (service_role inserted the deleted hash against a new pending row). 13: 23505 (the baseline insert had succeeded). 21–23: the re-used parent UUID saved the same link.                                                                                              | **0 / 38**   |
| `tests/sql/cancel_link_db_clock.sql`                              | 794cd03 version: **12 of 19 fail**, incl. **20/21** (b's transaction began before expiry, waited on a's lock past it, and the baseline answered `saved`) and **30/31** (122 s → under 120 s, `saved`). "b waits on a's lock" and "b's transaction began before the line" pass on baseline, proving the scenario was real. Final version: aborts at line 83, `function public.save_cancel_link_token_v2(…) does not exist`. | **0 / 21**   |
| `tests/billing/cancelLinkStore.test.ts` (real store, local stack) | **2 new tests fail**: "Could not find the table 'public.billing_cancel_token_tombstones'"; `expected undefined to be 'saved'`. The 4 existing tests pass.                                                                                                                                                                                                                                                                  | **6 / 6**    |
| `tests/billing/cancelFlow.test.ts` (unit)                         | Final version: **7 fail**. The 4 new round-5 tests (edge clock behind, DB count decides, `spent`, static gate check) fail. 3 existing tests fail because the save contract changed: the `'expired'` override shape, the not-held lease test, and the static `rpc('save_cancel_link_token_v2')` check.                                                                                                                      | **52 / 52**  |

Unit test (c) in detail: the harness models the DB clock with `dbAheadMs`. With the DB 59.5 min ahead of the edge (the edge clock is behind), the edge thinks the full hour is left and the DB says 30 s. The fix sends nothing. Baseline code sent the email. A second case: the edge clock jumps past the expiry during the save while the DB says 1800 s are left. The fix sends; baseline refused on its own clock.

### Other proofs (after the fix, all re-run twice to confirm they repeat despite permanent tombstones)

| Proof                          | Result               |
| ------------------------------ | -------------------- |
| `cancel_link_lifetime.sql`     | 0 / 57               |
| `checkout_consents.sql`        | 0 / 25               |
| `launch_checkout_fixes.sql`    | 0 / 46               |
| `guest_email_verification.sql` | 0 / 53               |
| `edge_rate_limit_refund.sql`   | ALL 10 CHECKS PASSED |

### Repo gates on the final tree

- `npm run lint:check`: clean.
- `npm run typecheck`: clean.
- `npm run build`: OK.
- `npx prettier --check` on every changed TS, MD and YML file: clean. SQL and sh files have no prettier parser.
- `git diff --check`: clean.
- `npm run test`: **198 files passed, 1 skipped (cancelLinkStore, no DB env) / 2921 tests passed, 6 skipped.**

Environment note on `npm run test`: with the local stack's generated `.env.local` present, two unrelated tests fail: `src/sync/syncEngine.test.ts` "backs off exponentially…" and `tests/auth/turnstileField.test.tsx` "leaves the sign-up form submittable…". They fail identically on untouched 6ab8228e and pass with `.env.local` moved aside. CI has no `.env.local`. The suite figures above are with it moved aside.

### CI job simulated locally before pushing

On a fresh stack (`--no-backup` volumes) from a clean worktree of 39592f5, with no `.env` files and the job's exact `supabase start -x …` excludes, startup took 46 s and applied all 73 migrations. Results:

- The replay step passed.
- The store test passed 6/6 with `CLEFFY_REQUIRE_LOCAL_DB=1`.
- The proofs passed: 57, 38, 21, 25 and 46 checks, 0 failures each.
- With `CLEFFY_REQUIRE_LOCAL_DB=1` and no URL or key set, the store test exits 1 instead of skipping.
- `sql-proof.sh` exits 1 on a `1 | 2` summary.

## CI on the new head (39592f5)

**All green on 39592f5.**

| Check                                        | Push run 39681411143 | PR run 39681418228               |
| -------------------------------------------- | -------------------- | -------------------------------- |
| checks (audit, lint, typecheck, test, build) | success              | success on attempt 2 (see below) |
| **supabase-local (new DB job)**              | **success**          | **success**                      |
| omr-service                                  | success              | success                          |
| supabase-drift                               | success              | success                          |
| Vercel Preview Comments                      | success              |                                  |
| Supabase Preview                             | skipped              |                                  |

In the `supabase-local` log, migrations 160400 and 160500 are applied by `supabase start`, the replay step succeeds, the store test passes 6/6 (`Test Files 1 passed`, so it was not skipped), and the proofs pass: `cancel_link_lifetime` 57, `cancel_link_tombstones` 38, `cancel_link_db_clock` 21, `checkout_consents` 25 and `launch_checkout_fixes` 46, each with 0 failures.

Re-run, attempt 1 of the PR run's `checks`:

- One test failed: `tests/imslp/imslpDownload.test.ts > tryDownloadPdfWith > cannot be pushed past its budget by an API call that never answers` (got `bot_check`, expected `timeout`).
- That file isn't touched by #62. The test uses a real-time 150 ms budget, and the same `checks` job passed on this exact commit in the push run.
- The test passed 5/5 locally.
- I re-ran the failed job once, the only re-run, and attempt 2 passed.
- It is a pre-existing timing-sensitive test. A follow-up could make it use a fake clock.

Earlier heads: 794cd03 and 9c80560 were both green on their push and pull_request runs.

## The new CI job (`supabase-local`)

- `supabase/setup-cli@v1`, version 2.121.0 (the same CLI as the cloud env).
- `supabase start -x studio,imgproxy,mailpit,realtime,storage-api,edge-runtime,logflare,vector,supavisor,postgres-meta`, which leaves Postgres, Auth, PostgREST and Kong. This is the LOCAL stack, and it applies every migration.
- It replays 160300, 160400 and 160500 with psql.
- It runs `tests/billing/cancelLinkStore.test.ts` with `CLEFFY_REQUIRE_LOCAL_DB=1`, URL and key taken from `supabase status -o env` (the stack's demo keys).
- It runs `cancel_link_lifetime`, `cancel_link_tombstones`, `cancel_link_db_clock`, `checkout_consents` and `launch_checkout_fixes` through `scripts/ci/sql-proof.sh`, which requires the summary line to read `0 | n` with n > 0.
- No repository secrets, no hosted project ref, no link, no `playwright install`, no browser. `billing_double_charge.sql` is not included (decision 20).
- I added `checkout_consents.sql` and `launch_checkout_fixes.sql` beyond the four named ones. They are #62's own checkout proofs, and checkout_consents covers the token-table grants this round changed. Remove them if you want the job strictly to the named four.

## Migrations count

`npm run migrations:mirror` (never hand-edited): **73 total SQL / 71 mirrored**, up from 71 / 69 at 6ab8228e (+160400, +160500; the 2 catalog migrations are still excluded). `tests/applyMigrationsInSync.test.ts` passes.

**`tests/migrationRecoverability.test.ts` was updated by hand**, with two new blocks: 160400 replays cleanly, and 160500 replays cleanly and lets 160300 replay. **It is not regenerated and must be reconciled by hand at merge time**, like the existing job-map block. No cron jobs were added; the combined count stays 10 `cron.schedule` calls. The combined mirror count after all four PRs becomes 90 / 88 (was 88 / 86).

## Byte parity of the four shared files

`git diff 6ab8228e7f7a3e867a642816abdd2ea17c11b3c9 HEAD -- supabase/functions/_shared/resendDelivery.ts supabase/functions/_shared/mailBudget.ts tests/security/resendDelivery.test.ts tests/security/mailBudget.test.ts` is **empty** (0 bytes) at 39592f5. None of them needed to change.

## Skipped minors

- None from round 5. Its only minor (DB tests not run in CI) is the CI item, done in 39592f5.
- Out of scope and left alone:
    - the tick's pre-existing non-empty search_path, which Codex marked not chargeable
    - provider idempotency, still simulated by FakeResend
    - making expiry count from the actual send (decision 27's follow-up)
    - skipping a resend to Resend for a link already spent while its row still retries: existing, reviewed behaviour; the resend is deduplicated by the Idempotency-Key and the link stays dead

## Open questions

1. **Two new migrations instead of one** (160400 + 160500), explained under "Deviation" above. If one migration is required, the clean way is for Max to allow editing the unreviewed, unapplied 160400 in place (fold 160500 into it, delete 160500, regenerate the mirror). I didn't do this because the rules forbid editing a pushed migration.
2. **Commit message typo:** 9c80560's message says "73 SQL / 70 -> 71 mirrored". The correct figures are 72/70 → 73/71. It's pushed, so I didn't amend it.
3. **The legacy text `save_cancel_link_token` stays granted to service_role** so the previous edge function keeps working during rollout, now under all the new guards. Once the new billing-mail worker is deployed it could be revoked in a later migration. I didn't do that here because S re-grants it on replay anyway.
4. **Rollout note:** tombstones only exist for tokens deleted after 160400 is applied. 20261020160300 and this round ship together in #62 and neither is on hosted, so no earlier deletes can be missing a tombstone.
5. `tests/imslp/imslpDownload.test.ts`'s 150 ms real-time budget test flaked once on CI (above). It's pre-existing and not #62's.
6. The two env-dependent unit-test failures (`.env.local` from `local-up.sh`) are pre-existing and not #62's. Worth a separate look, since anyone running `npm run test` after `cloud:up` hits them.

## Hard rules check

- Pushed only to `mh/launch-checkout` (fast-forward ×3) and this report branch. No pushes to main or dev, no merges, no force.
- PR #54 untouched.
- No hosted Supabase, no Stripe at all.
- No secrets printed or committed. Only the local stack's public demo keys were used, read from `supabase status`. No `.env` committed.
- No `playwright install`.
- PR #62 is still a draft, with no reviewer requests.
- Never messaged another session and never used send_message.
