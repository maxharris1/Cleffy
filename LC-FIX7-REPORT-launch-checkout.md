# LC-FIX7 report: PR #62 (mh/launch-checkout), round-7 fix

- **PR:** https://github.com/maxharris1/Cleffy/pull/62 (draft into dev, still draft, no reviewers requested)
- **Starting head:** `31cf9c5071834339e0e65ae8fff94c051b3d8f9f`. Verified: after `git checkout -B mh/launch-checkout origin/mh/launch-checkout`, HEAD was exactly this SHA.
- **New head:** `553f5d2544f85bee52034f38859ea762fb9b7a5e` (pushed fast-forward `31cf9c5..553f5d2`, no force)
- **Environment:** Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (from `get_session`, `environment_kind: anthropic_cloud`), not Sandbox. Local Supabase stack only. I did not touch hosted Supabase, Stripe (live or test), PR #54, or the branches of #61, #63 or #64. I sent no messages to any other session.
- **Commit identity:** Max Harris <drumaxter@gmail.com>

## Commits

| SHA | Summary |
|---|---|
| `553f5d2544f85bee52034f38859ea762fb9b7a5e` | Spend a cancel link only while it is unexpired on the DB clock (Codex r7 K4) |

There is one finding, so there is one commit. The report commit exists only on `claude/lc-fix7-report-launch-checkout`.

### Fix → commit → tests

| Finding | Commit | Covered by |
|---|---|---|
| Codex r7 K4 (major): an expired cancel token can still be consumed | `553f5d25` | `tests/sql/cancel_link_consume_db_clock.sql` (36 checks, new, in supabase-local); `tests/billing/cancelLinkStore.test.ts` (new test plus `spend` now goes through the RPC); `tests/billing/cancelFlow.test.ts` (new "spent first" block with 7 tests, plus a wiring test); `src/features/billing/CancelPage.test.tsx` (2 new cases); `tests/migrationRecoverability.test.ts` (new 160700 block); the supabase-local replay loop (160700 added) |

## How expiry is enforced when a link is spent

Migration: **`supabase/migrations/20261020160700_cancel_link_consume_db_clock.sql`**. It sorts after 20261020160600 and before #61's 20261020180400. 160300–160600 are byte-unchanged.

1. **RPC `public.consume_cancel_link_token(p_hash text) returns jsonb`.**
   - `SECURITY DEFINER`, `set search_path = ''`, volatile.
   - `revoke all … from public, anon, authenticated`; `grant execute … to service_role` only.
2. **Lock order.** The RPC reads the token's `outbox_id` without a lock. The guard trigger forbids `outbox_id` from ever changing, so this read cannot go stale. It then calls M6's `public.billing_cancel_link_lock(v_outbox, p_hash)`: the outbox-id advisory xact lock first, then the hash lock, both keyed by `billing_cancel_link_lock_key`. This is the same function, order and key derivation as every other path.
3. **One statement.** The link is spent by exactly one statement:
   ```sql
   update public.billing_cancel_tokens t
   set used_at = pg_catalog.clock_timestamp()
   where t.token_hash = p_hash and t.used_at is null and t.expires_at > pg_catalog.clock_timestamp()
   returning t.user_id, t.mode, t.used_at
   ```
   Expiry is decided on the DB clock after any wait for the advisory locks.
   - If no row comes back, the RPC refuses with a distinct answer: `{"answer":"expired"}`, `{"answer":"used"}` or `{"answer":"not_found"}`. A follow-up read is used only to classify the reason, and a refusal writes nothing.
   - On success it answers `{"answer":"consumed","user_id","mode","used_at"}`.
   - The edge never decides expiry on its own clock. No `deps.now()` or `Date.now()` expiry check was added; the existing source test that forbids edge-clock comparisons still passes.
4. **Guard trigger.** `billing_cancel_tokens_lifetime` is replaced with `CREATE OR REPLACE`: M4's body plus one more UPDATE refusal. It rejects `old.used_at is null and new.used_at is not null and new.expires_at <= clock_timestamp()` with 55000 "an expired cancel link cannot be spent". It checks `new.expires_at`, which can only be the same as or earlier than `old.expires_at`, so it also catches "bring the expiry forward and spend it in one update". This applies to everyone, including the service role's direct UPDATE and the table owner.
   - **Why this matters inside the RPC, too.** If the RPC's UPDATE waits on the token's *row* lock rather than an advisory lock (for example, another writer holds it FOR UPDATE), its WHERE clause was evaluated before the wait. The BEFORE UPDATE guard runs after the wait and reads the clock again. The RPC catches exactly that guard error and answers `expired`.
   - I proved this experimentally. With the guard lines removed, proof check 2c (a row-lock wait across the expiry) **consumed** the link. With the guard in place, it answers `expired` and the link stays unused.
5. **Flow order** (`supabase/functions/_shared/cancelFlow.ts` `confirmCancel`):
   1. `readToken` (DB clock).
   2. DB-only lookups: email, the mirror's subscription, first purchase. If the mirror has nothing to cancel, the answer is 404 and the link is not spent.
   3. **`consumeToken`** (the RPC). Anything other than `consumed` → 404 `link_invalid` with `reason`, and no Stripe call and no email.
   4. Stripe `subscriptions.retrieve`.
   5. Stripe `subscriptions.update(cancel_at_period_end)`.
   6. The refund-request email.

   Only `consumed` allows steps 4–6. A Stripe failure after the spend leaves the token used and answers 502 `not_cancelled` ("…has not been cancelled, and this link has now been used. Ask for a new one below, or cancel from your Account page…"), per decision 27. `CancelPage.tsx` now switches to the "email me a new link" form on `link_invalid`, `nothing_to_cancel` or `not_cancelled` from "Cancel now". Before this change the page left a dead button.
   - A failed RPC call (an error, not a refusal) → 503, and no Stripe call or email.
   - Following decision 38, an expired or spent link gives nothing back. The confirm path never touches the per-recipient count or the mail budget, and the unit test checks that nothing is handed back.
   - `consumeToken` now lives in `billingCancelStore.ts`, so the store test runs the shipped code. `billing-cancel/index.ts` only wires it in. The old `.from('billing_cancel_tokens').update({ used_at })` is gone.
6. **Re-runnable.** The migration contains only two `CREATE OR REPLACE FUNCTION`s and idempotent revoke/grant statements. It creates or drops no table, index or trigger: the guard's trigger is 160300's and still points at the same function name. Verified three ways: `psql -f` applied it twice in a row on top of a stack that already had it; the CI replay loop ran 160300→160700 locally; and `tests/migrationRecoverability.test.ts` has a new 160700 block.

### Changed files (553f5d25)
- `.github/workflows/ci.yml`: 160700 added to the replay loop, `cancel_link_consume_db_clock` added to the proof loop
- `scripts/apply-migrations.sql`: regenerated with `npm run migrations:mirror`, append-only diff
- `supabase/migrations/20261020160700_cancel_link_consume_db_clock.sql` (new)
- `supabase/functions/_shared/cancelFlow.ts`, `supabase/functions/_shared/billingCancelStore.ts`, `supabase/functions/billing-cancel/index.ts`
- `src/features/billing/CancelPage.tsx`, `src/features/billing/CancelPage.test.tsx`
- `tests/billing/cancelFlow.test.ts`, `tests/billing/cancelLinkStore.test.ts` (lines 350–359's old UPDATE replaced by `store.consumeToken`), `tests/migrationRecoverability.test.ts`
- `tests/sql/cancel_link_consume_db_clock.sql` (new)
- `tests/sql/checkout_consents.sql`: check 32's label only. It said "(what consumeToken does)", which is no longer true; the SQL and the check count are unchanged.

## Tests run and results

### Local (cloud container, local Supabase stack via `supabase start` with CI's `-x` exclusions)
- `npm run lint:check`: clean
- `npm run typecheck`: clean
- `npm run test`: **198 files passed, 1 skipped; 2942 tests passed, 8 skipped.** The skipped file is `cancelLinkStore.test.ts`, which needs the DB environment variables; it ran separately below.
- `npm run build`: success
- `npx prettier --write` on the changed TS/TSX/YAML files: only `cancelFlow.test.ts` and `migrationRecoverability.test.ts` were reformatted, and the reformatting is in the commit
- I reproduced CI's supabase-local job by hand on a fresh `supabase db reset` (the same commands as ci.yml):
  - replay of 160300, 160400, 160500, 160600, 160700: OK
  - `cancelLinkStore.test.ts` with `CLEFFY_REQUIRE_LOCAL_DB=1`: **8 passed, 0 skipped**
  - SQL proofs: lifetime **57**, tombstones **38**, db_clock **21**, tombstone_race **25**, read_db_clock **10**, save_after_insert **12**, **consume_db_clock 36 (new)**, checkout_consents **25**, launch_checkout_fixes **46**. All OK.

### Fail-before (31cf9c50) / pass-after evidence
"Before" means a detached worktree at `31cf9c50` with only the new test files copied in, plus a `supabase db reset` run from that worktree, so the DB had migrations only through 160600.

| Test | On 31cf9c50 | After the fix (553f5d25) |
|---|---|---|
| `tests/billing/cancelFlow.test.ts` + `CancelPage.test.tsx` + `migrationRecoverability.test.ts` | **15 failed**, 84 passed. Failures: all 7 ordering tests in the new block, the 2 updated Stripe-failure tests, the wiring test, both CancelPage cases, and the 3 migration tests | all pass (64 / 5 / 30) |
| `tests/billing/cancelLinkStore.test.ts` (local DB) | **5 failed**, 3 passed (`store.consumeToken is not a function`; no RPC) | 8 passed |
| `tests/sql/cancel_link_consume_db_clock.sql` | **24 / 36 failed**. In checks 30–32 the old-style direct `UPDATE … SET used_at` **spent an expired link with no error**: that is K4 itself | 0 / 36 failed |

The one new unit test that passes on 31cf9c50 is "nothing to cancel in the mirror leaves the link unspent". It is a regression guard for behaviour that already held.

## CI on the new head (553f5d25)

**All green.** Two CI runs: run `39692077487` (push) and run `39692082779` (pull_request).

| Job | push run | pull_request run |
|---|---|---|
| checks (npm audit, lint:check, typecheck, test, build) | ✅ | ✅ |
| supabase-local | ✅ | ✅ |
| supabase-drift | ✅ | ✅ |
| omr-service | ✅ | ✅ |
| Vercel Preview Comments | ✅ | |
| Supabase Preview | skipped (as in r7) | |

PR state on 553f5d25: open, draft, `mergeable_state: clean`.

supabase-local logs (push run, job 119540429234):
- "Re-apply the cancel-link migrations": the loop now covers 160300 → 160700 and applied cleanly. The only output is the expected "already exists, skipping" notices.
- Store suite `cancelLinkStore.test.ts` (`CLEFFY_REQUIRE_LOCAL_DB=1`): **1 file, 8 passed, 0 skipped** (r7 had 7; this commit adds the expiry-before-spend test).
- SQL proofs:

| SQL proof | Checks |
|---|---:|
| cancel_link_lifetime | 57 |
| cancel_link_tombstones | 38 |
| cancel_link_db_clock | 21 |
| cancel_link_tombstone_race (dblink) | 25 |
| cancel_link_read_db_clock | 10 |
| cancel_link_save_after_insert | 12 |
| **cancel_link_consume_db_clock (new, dblink)** | **36** |
| checkout_consents | 25 |
| launch_checkout_fixes | 46 |

## Migrations count
`npm run migrations:mirror` regenerated `scripts/apply-migrations.sql`: **75 total SQL / 73 mirrored** for #62. r7 was 74 / 72; the new migration accounts for the difference. The diff of the mirror against 31cf9c50 is append-only (0 removed lines).

`tests/migrationRecoverability.test.ts` is **not** regenerated: I edited it by hand (a new 160700 block). **It must be reconciled by hand at merge time**, like the 160500 and 160600 blocks. The same applies to `scripts/apply-migrations.sql`, which must be regenerated rather than resolved by taking one side (decision 6).

## Byte parity of the shared files
`git diff 31cf9c5071834339e0e65ae8fff94c051b3d8f9f HEAD -- supabase/functions/_shared/resendDelivery.ts supabase/functions/_shared/mailBudget.ts supabase/functions/_shared/legalVersions.ts tests/security/resendDelivery.test.ts tests/security/mailBudget.test.ts` → **empty (0 bytes)**. The SHA-256 hashes match r7's table:
- mailBudget.ts `1676e01b…abcdb` (A)
- resendDelivery.ts `1e24b2e3…67d64` (B)
- legalVersions.ts `332c1dd5…bea99` (C)
- mailBudget.test.ts `42c8eb4a…29c574` (D)
- resendDelivery.test.ts `515a4aaf…537ccc` (E)

No change to any of them was needed.

## Accepted, not fixed (decision 39)
- **Codex r7 minor: a direct single-row DELETE can deadlock with the tick.** A direct DELETE takes the tuple lock before its BEFORE DELETE trigger takes the advisory locks; the tick takes the advisory locks first. Postgres aborts one transaction and nothing is lost. No application path deletes a token directly. Not fixed, per decision 39.
- **Same class, noted for completeness:** `consume_cancel_link_token` takes the advisory locks before the tuple lock, like the tick. So the same kind of direct DELETE, or an account deletion's cascade into `billing_cancel_tokens` (row first, then trigger locks), can deadlock with a concurrent spend of that same token. Postgres aborts one side. If the spend is aborted, the edge gets an error → 503, the link is not spent, and there is no Stripe call and no email. Nothing is lost, and the result fails closed.

## Open questions
1. **Spending before the Stripe *read*.** I read "consume BEFORE any Stripe call" literally, so the spend also comes before `subscriptions.retrieve`. One consequence: a link whose subscription Stripe has already ended (while the mirror still lists it) is spent, and the answer is `nothing_to_cancel`. The page then offers a new link, and a new link would get the same answer, which is harmless. The DB-only lookups (email, mirror, first purchase) still run before the spend, so a transient DB failure, or a mirror with nothing to cancel, does not spend the link. If Max would rather the Stripe read come before the spend (it changes nothing in Stripe), that is a two-line move.
2. **New error code `not_cancelled`.** This is the 502 answer after the spend when Stripe fails, so the buyer is not told to "try again in a minute" with a link that is already spent. The CancelPage change that shows the new-link form is in this commit. Codex should look at the wording.
3. **Merge-time work** (no other session needs to act now): `tests/migrationRecoverability.test.ts` and `scripts/apply-migrations.sql` must be reconciled or regenerated at each merge in the 63 → 62 → 61 → 64 order.
