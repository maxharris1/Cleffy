# Cleffy PR #73 (launch-fix item 16) — fix round 1 report

**Status:** Complete

- PR: https://github.com/maxharris1/Cleffy/pull/73 (draft, not merged), branch `mh/launchfix-item16`
- Previous head: `57960f9f38ac91a505308495e6931a1e603e0651` (confirmed on `origin` before starting and again before the push)
- **New head: `e91a7089d62e9b804c13058280ffd0ab5e52ba67`** (fast-forward push `57960f9..e91a708`; no rebase, amend, squash or force)
- Environment: Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2`, `anthropic_cloud` (confirmed with `get_session` at the start), not Sandbox
- Inputs: packet fix round 1, Codex r1 review (REVISE), decisions 71(4), 71(6) and 72
- Every commit is authored by Max Harris <drumaxter@gmail.com>. No messages sent to any session, no handoff, no Codex review requested. Main, PR #54, hosted Supabase and live Stripe untouched. No secrets or `.env` files printed or committed.

## Per-item commits and proof

Each item has a test or proof that fails before the fix and passes after. The "before" runs used the new tests against the code at `57960f9f` (or the item's pre-fix code). The "after" runs used the new head.

### 1. MINOR: refund retries reuse the Resend key with a changed payload — `ccf1f98`

`billing-cancel: the refund request is the same email on every send of one link (PR #73 fix 1)`

- The fix: `refundRequestEmail` (`billingTerms.ts`) now depends only on things that stay fixed for one link: the email, user id, subscription, plan, mode and first purchase. The wall-clock `Requested:` line is gone; the line now reads "Requested: when this email was sent (asking again with the same link never sends a second one)". The paragraph that appeared only while the deletion was pending is replaced by one line that is always present: the subscription may be set to end, or already be cancelled (for example by a deletion), so check Stripe before refunding. `requestRefund` (`cancelFlow.ts`) no longer passes `requestedAtMs` or `accountDeletionPending`.
- Proof (`tests/billing/cancelFlow.test.ts`, "the refund request is one email per link, whenever it is sent again"). These tests go through the repository `FakeResend` via `sendViaResend`:
    - FakeResend, like Resend, answers a reused key with a different payload with a 409 (`unknown`). This is the sanity check. It passes both before and after.
    - A second press a minute later, while the account is being deleted, is answered as sent, and support gets one email. **Before: fails** (`refundRequestFailed: true`). After: passes.
    - Pending, then abandoned: the retry that cancels is answered as sent, and every request under the key carries one payload. **Before: fails** (`refundRequested: false, refundRequestFailed: true`). After: passes.

### 2. MINOR: the SQL proof did not check claim ownership — `f5ea3d3`

`SQL proof: stripe-webhook release and finish carry the delivery's own claimed_at (PR #73 fix 2)`. This change is test-only.

- The fix: in `tests/sql/stripe_webhook_deletion_pending.sql`, `pg_temp.claim(id, holder)` now keeps the `claimed_at` each claim returned, per delivery. `pg_temp.release` and `pg_temp.done` take the holder and filter on `id` and that `claimed_at`, as the store's `releaseEvent` and `markEventDone` do; `done` no longer filters by status alone. New checks 16–20c work as follows. The old delivery claims. Its claim is backdated past the 10-minute stale window, because `now()` does not move inside the one transaction. A successor takes the claim over with a later `claimed_at`. The old holder can then neither release (18) nor finish (19) the successor's claim. The successor finishes its own claim (20); the old holder still cannot release it (20b); and later deliveries read `done` (20c). `tests/sql/README.md` is updated.
- Proof: the new proof run with the first revision's helpers (release matching the row's own current `claimed_at`, finish by status) **fails 4 of 24: checks 18, 19, 20 and 20c**. With the new helpers, **24/24 pass**.

### 3(a). MAJOR (decision 72(1)): billing-cancel check-to-write race — `fceff21`

`billing-cancel: a deletion that begins after the check neither drops the refund nor spends the link for good (PR #73 fix 3a)`

- **This adds one migration**, `supabase/migrations/20261022160000_cancel_link_release_for_deletion.sql`. A migration was needed because the existing token guard refuses _any_ un-spend ("a spent cancel link stays spent"). Without one, a spent link could not be left un-spent for an abandoned deletion. The migration does two things:
    - `release_cancel_link_token_for_deletion(p_hash)`: service role only, SECURITY DEFINER, `search_path=''`. It calls `account_deletion_pending()` first, which takes the deletion's lock shared and holds it to the end of the call. If the account is being deleted, it then takes the link's history locks and sets `used_at = null` in one UPDATE. It answers `released`, `clear` or `not_found`.
    - `billing_cancel_tokens_lifetime` (the guard), redefined exactly as in 20261020160700 except for one exception. The exception lets `used_at` go back to null only on the row whose hash the release function names in the transaction-local setting `cleffy.cancel_link_release`. The setting is read with `coalesce(..., '')`: a session that never set it reads NULL. My first draft compared without `coalesce`, and the NULL comparison let the service role's direct un-spend through. The existing store test "a retry after the link was used keeps it spent" caught it, and proof check 02c now pins it.
    - The migration re-runs cleanly (applied twice locally). It is added to `tests/sql/migrations_ordered_replay.sql` and to `scripts/apply-migrations.sql` (`npm run migrations:mirror`).
- The flow (`cancelFlow.ts confirmCancel`): after the link is spent, `deletionBeganSince` calls the release once Stripe has been read and again after any Stripe failure (a read error, a refused update, or an update Stripe did not confirm). On `released`, the answer is the same as for a deletion pending from the start: Stripe is left alone, the refund request is sent, the link is unspent, and the response is `{cancelled:false, deletionPending:true, …}`. On `clear` the cancel goes on. If the release cannot be answered, it is logged as `cancel_token_release_failed` and the cancel goes on, because the check before the spend said clear.
- When Stripe has already ended the subscription after the spend (`nothing_to_cancel`), the requested in-window refund request **is now sent**. The answer is still 404 `nothing_to_cancel` and now carries `refundRequested`/`refundRequestFailed`. It is the same email under the same key, so it combines with fix 1. `cancelApi.ts` turns that 404 into a `{cancelled:false, alreadyEnded:true, …}` result, and `CancelPage` shows "Your subscription has already ended" with the refund outcome.
- Store: `billingCancelStore.ts releaseTokenIfDeletionPending`, wired in `billing-cancel/index.ts`.
- Proof:
    - `tests/billing/cancelFlow.test.ts` "a deletion that begins after the check": 6 tests, all through FakeResend. **Before: all 6 fail. After: all pass.**
        - The deletion cancelled the subscription before the link reached Stripe: the refund is sent and the link is unspent. After the deletion is abandoned, a second press gets `nothing_to_cancel` and support still has only one email.
        - The deletion began but has not cancelled yet: Stripe is untouched, the refund is sent and the link stays good. After abandonment the same link cancels.
        - The deletion began between the re-check and the update, which Stripe refuses: the refund is sent and the link stays good.
        - Stripe had already ended the subscription with no deletion: the refund request is sent and the answer is 404.
        - Call order: consume, then Stripe read, then release, then update.
        - An unanswerable re-check goes on with the cancel.
    - `tests/sql/cancel_link_release_for_deletion.sql` (new; 28 checks). Against the schema at `57960f9f` (20261020160700's guard, no function), **17 of the then-26 checks fail**. With the guard compared without `coalesce`, **02c and four that depend on it fail**. After: **28/28 pass**.
    - `tests/billing/cancelLinkStore.test.ts`: new store test against local PostgREST covering clear, then released, then the link works again, the direct un-spend refused, abandoned (clear), and not_found. The full file passes 9/9 against the local stack.
    - `src/features/billing/cancelApi.test.ts` (new, 3 tests) and a `CancelPage.test.tsx` test for the "already ended" view.

### 3(b). MAJOR (decision 72(2)): stripe-webhook check-to-write race — `aa68f1f`

`stripe-webhook: ask account_deletion_pending() again after Stripe's read, before the row and before the scores (PR #73 fix 3b)`

- The fix: `applySubscription` (`stripeEvents.ts`) is the write path every event type takes after its Stripe read. It now calls `deletionRefusal` right before `upsertSubscription`, and again before `applyFreeTierArchival` / `restorePlanArchivedScores`. If the account is pending, or the check cannot be answered, nothing more is written, the claim is released, and the answer is 503 `account_deletion_pending` (or `deletion_check_unavailable`). The invoice path's own post-read check is folded into this one, so there is no duplicate RPC. The existing invoice test now expects three checks (before the lock, before the row, before the scores). `deletionPendingPolicy.test.ts` pins the positions.
- Proof (`tests/billing/webhook.test.ts` "a deletion that begins while the event is being applied"):
    - **Before: 5 of 6 fail.** The deletion begins during the Stripe read of a subscription event, and during that of a checkout; it begins between the row and its restore, and between the row and its archive; and after abandonment the retry is processed normally, exactly once.
    - The sixth test is the same race on an invoice. It already passed before, because the invoice path had a post-read check, and it stays as a guard.
    - After: all pass.

### 4. Decision 71(6): stripe-portal refuses while deletion is pending — `674ac35`

`stripe-portal: no new portal session while the account is being deleted (PR #73 fix 4)`

- The fix: the handler moves to `supabase/functions/_shared/portalFlow.ts` (`handlePortal`, type-only imports), and `stripe-portal/index.ts` becomes wiring only, like stripe-checkout and billing-cancel. Behaviour is unchanged otherwise: the 429, 401/403 (anonymous, student), 400 unknown origin, 500 unconfigured, 404 `no_customer` and 502 paths all stay. Once the caller is known, and before the customer lookup or any Stripe call, the handler asks `account_deletion_pending()`. It answers **409** `{code:'account_deletion_pending'}` while the deletion is pending, and **503** `{code:'deletion_check_unavailable', retryAfterSec:30}` if the check throws or fails (logged as `portal_deletion_check_failed`). `deletionPendingPolicy.test.ts` now lists stripe-portal under "refuse".
- Proof: new `tests/billing/portalFlow.test.ts` (handler: 409, 503, happy path, refused caller, no_customer, 502; plus wiring) and the new policy test. **Before** (with 57960f9f's stripe-portal), the policy test fails and portalFlow.test.ts cannot load. **After**: 35/35 across the two files.

### 5. Decision 71(4): DEPLOY.md stale-deletion runbook note — `e91a708`

`DEPLOY.md: the half-deleted runbook notes Stripe's ~3-day retry window (PR #73 fix 5)`

- The fix: the "Half-deleted accounts" runbook now says the following. While the account is pending, stripe-webhook answers 503, and Stripe retries a failed event for about 3 days and then stops. An account left half-deleted longer than that never receives those mirror events, so `subscriptions`/`billing_customers` stay as they were. The money is safe, because the completing deletion's step 7 sweeps Stripe and cancels anything that can still bill. But for such an account, check Stripe rather than the mirror.
- Proof: a new `deletionPendingPolicy.test.ts` test pins the note. **Before** (DEPLOY.md without the note): fails. After: passes.

## Updated deploy notes (DEPLOY.md, item 16 section)

- **Item 16 now carries one migration**, `20261022160000_cancel_link_release_for_deletion` (it replaces the earlier "No migration"). It is service role only and re-runnable.
- **Redeploy**: `stripe-webhook`, `billing-cancel`, **`stripe-portal` (new in this round)**, `guest-email-start`, `guest-email-confirm`, and the frontend (the cancel page's "already ended" view is new).
- **Order**:
    - Apply the migration before deploying `billing-cancel`. A billing-cancel deployed before the migration logs `cancel_token_release_failed` and cancels as before.
    - Deploy the frontend with or before `billing-cancel`.
    - `stripe-portal` now answers 409/503 while a deletion is pending; the frontend already shows any refusal's message.
- Half-deleted runbook: the Stripe ~3-day retry note (item 5).

## Local checks (new head e91a708)

| Check                                                                                                                | Result                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint:check`                                                                                                 | clean                                                                                                                                             |
| `npm run typecheck`                                                                                                  | clean                                                                                                                                             |
| `npm run test`                                                                                                       | 246 files passed, 6 skipped; 3879 tests passed, 21 skipped                                                                                        |
| `npm run build`                                                                                                      | OK                                                                                                                                                |
| `deno check --config supabase/functions/deno.json supabase/functions/*/index.ts` (Deno 2.1.4, as CI)                 | exit 0                                                                                                                                            |
| Local Supabase `db reset` (all migrations, incl. 20261022160000)                                                     | OK                                                                                                                                                |
| CI's re-apply step (5 cancel-link migrations, then all 40 from 20261022100000)                                       | OK                                                                                                                                                |
| `tests/billing/cancelLinkStore.test.ts` against local stack                                                          | 9/9                                                                                                                                               |
| `tests/storage/storageLifecycle.test.ts` against local stack                                                         | 5/5                                                                                                                                               |
| Every SQL proof (`tests/sql/*.sql` + `supabase/sql-tests/sharing_access_control.sql`, via `scripts/ci/sql-proof.sh`) | 69/69 proofs OK, incl. `migrations_ordered_replay` (10/10), `stripe_webhook_deletion_pending` (24/24), `cancel_link_release_for_deletion` (28/28) |

## CI on the final head (e91a7089)

**All checks on `e91a7089d62e9b804c13058280ffd0ab5e52ba67` finished green.** I waited for every check to complete, polling the REST API every 2 minutes, before writing this. Nothing is red, so no Vercel exception was needed.

| Check                   | Run (event)                | Job / check-run id                                                    | Conclusion                           |
| ----------------------- | -------------------------- | --------------------------------------------------------------------- | ------------------------------------ |
| checks                  | 39879074352 (push)         | 120171781612                                                          | success                              |
| supabase-local          | 39879074352 (push)         | 120171781588                                                          | success                              |
| edge-functions-deno     | 39879074352 (push)         | 120171781613                                                          | success                              |
| omr-service             | 39879074352 (push)         | 120171781572                                                          | success                              |
| supabase-drift          | 39879074352 (push)         | 120171781341                                                          | success                              |
| checks                  | 39879080987 (pull_request) | 120171804174                                                          | success                              |
| supabase-local          | 39879080987 (pull_request) | 120171804142                                                          | success                              |
| edge-functions-deno     | 39879080987 (pull_request) | 120171803814                                                          | success                              |
| omr-service             | 39879080987 (pull_request) | 120171804084                                                          | success                              |
| supabase-drift          | 39879080987 (pull_request) | 120171804268                                                          | success                              |
| Vercel Preview Comments | —                          | 120171994037                                                          | success                              |
| Supabase Preview        | —                          | 120171776780                                                          | skipped                              |
| Vercel (commit status)  | —                          | https://vercel.com/maxs-projectsd/cleffy/8RJ6tyosbKkjJEr2gpheAx2xH2Yj | success ("Deployment has completed") |

Both CI workflow runs: `39879074352` (push) and `39879080987` (pull_request), each `completed / success`. The combined commit status is `success`.

## Open questions

1. **A migration in item 16.** The earlier deploy note and Codex r1 both recorded item 16 as migration-free. Decision 72(1)'s "don't leave the token permanently spent" needs the guard to allow one narrowly scoped un-spend, so this round adds `20261022160000`. Please confirm that is acceptable for #73, and note it when #73 is rebased onto #72: the 16xxxx name was picked to stay clear of #72's 14xxxx and any 15xxxx follow-ups.
2. **The refund email no longer has a `Requested:` timestamp or the "account is being deleted" line** (fix 1). Support reads the request time from the email's own date and checks the subscription's state in Stripe. Is that enough for support, or should the time be carried another way, for example in the email subject? Any per-send value would reintroduce the problem.
3. **An unanswerable post-spend re-check goes on with the cancel**, logged as `cancel_token_release_failed`, rather than answering 503. The check before the spend said clear. A 503 at that point would leave the link spent with nothing done.
4. **Mirror-side `nothing_to_cancel` before the spend** (no cancellable subscription in the mirror at all) still sends no refund request. The page never offers the refund box in that case (peek answers 404), and nothing is spent. Left as before; say if decision 72(1) should cover it too.
5. **A released link keeps its original expiry** (at most an hour from when it was asked for). After a long pending deletion that is then abandoned, the buyer asks for a new link, as the page already tells them.
6. **The webhook's second re-check (before the scores)** can leave a row written but its archive or restore not run, when a deletion begins in that gap. The claim is released and the retry re-applies both once the account is clear. If the deletion completes, the deleted-account path handles it.
