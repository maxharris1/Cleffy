# Cleffy PR #73 (item 16): fix round 2 report

**Status:** Complete

- PR: https://github.com/maxharris1/Cleffy/pull/73 (draft; not merged)
- Branch: `mh/launchfix-item16`. Fast-forward only: `e91a7089d62e9b804c13058280ffd0ab5e52ba67..3595382f834448c0c802e9dda4e85de0a7c03117`
- **New head: `3595382f834448c0c802e9dda4e85de0a7c03117`**
- Environment: Claude Code cloud session in the Cleffy environment, `env_01WAd3yiz3qpSnsofpyEwCh2` (confirmed with `get_session` at the start, `environment_kind: anthropic_cloud`). Not Sandbox.

## Start checks

- `git fetch origin`: `origin/mh/launchfix-item16` was `e91a7089d62e9b804c13058280ffd0ab5e52ba67`, as the packet expected. Checked out with `git checkout -B mh/launchfix-item16 origin/mh/launchfix-item16`.
- Commit identity: Max Harris <drumaxter@gmail.com> on all three commits.
- Before pushing, re-fetched and confirmed origin had not moved and HEAD was a fast-forward of it. Ran `git push origin HEAD:mh/launchfix-item16` (accepted, `e91a708..3595382`). No force, rebase, amend or squash. No rebase onto `mh/launchfix-followups`.
- Not touched: main, PR #54, hosted Supabase, live Stripe, any `.env` file. No secrets printed or committed. I sent no messages or handoffs and requested no Codex review.

## Findings

### 1. MAJOR: district customer-link write came before its deletion re-check

**Commit `4949d8c`**: stripe-webhook: ask account_deletion_pending() again right before a district's customer link (PR #73 fix2 1)

- `supabase/functions/_shared/stripeEvents.ts`: `linkDistrictCustomer` now takes the event and returns `WebhookResult | null`. Right before `store.linkCustomer`, after the mapping lookup and only when it would actually write, it calls `deletionRefusal` again. If the deletion is pending, the refusal goes back to `applySubscription`, which returns it: claim released, 503 `account_deletion_pending`, no `billing_customers` write, no archive or restore. The `beforeScores` check stays in place for every subscription.
- Test: `tests/billing/webhook.test.ts`, "a deletion that begins while the event is being applied":
    - _a district subscription, between the row and its customer link: no billing_customers write_. This is a `send_invoice` subscription with `cleffy_plan=district` metadata, through `handleStripeEvent`. Deletion becomes pending inside `upsertSubscription`. The test asserts a 503, a released claim, no lock left, no `linkCustomer` call, an empty `customers` map and no restore.
    - _a district subscription on a clear account still links its customer_: the control case.
- **Before the fix:** the new test failed with `expected [ 'cus_1:teacher-1' ] to deeply equal []`, which is exactly Codex's trace (check clear → upsert → linkCustomer while pending → check pending → release → 503).
- **After the fix:** `tests/billing/webhook.test.ts` passes 120/120.

### 2. MINOR: refund payload depended on mutable account and billing data

**Commit `352002e`**: billing-cancel: a link's refund request is kept with it, so a retry sends the same email whatever changed (PR #73 fix2 2)

The approach is to **freeze the first payload with the link**. Dropping the email and plan from the support email would have taken useful details away from support, so the first request is stored instead:

- Migration `20261022160000_cancel_link_release_for_deletion.sql` is edited in place. It was never applied to a hosted DB. The changes:
    - New column `billing_cancel_tokens.refund_request jsonb`, added with `add column if not exists` so the migration can still be re-run.
    - The token guard forces it to null on INSERT and refuses any UPDATE that changes or clears a request once it is kept (`55000` "a cancel link keeps the refund request it first sent").
    - New `keep_cancel_link_refund_request(p_hash, p_request)`. It is SECURITY DEFINER with `search_path=''`, executable by the service role only. It sets the request only where none is stored yet, then reads back and answers `{answer:'kept', request}` or `not_found`. For two concurrent presses, the second UPDATE waits on the row lock, finds the request set, writes nothing, and its SELECT reads the first one.
- `scripts/apply-migrations.sql` regenerated with `npm run migrations:mirror`.
- `cancelFlow.ts requestRefund` builds the email as before, then calls the new `CancelDeps.keepRefundRequest`. Every send uses the kept `{subject, text, html, replyTo}` under the link's key. If the request can't be kept, nothing is sent: `refund_request_keep_failed` is logged and the buyer gets `refundRequestFailed: true`, which tells them to write in. If the link is gone, the built email is sent.
- `billingCancelStore.ts keepRefundRequest` (RPC with answer validation) is wired in `billing-cancel/index.ts`.
- `DEPLOY.md` item-16 note is updated: the migration must go before `billing-cancel`. A `billing-cancel` running without the migration sends support nothing and tells the buyer to email support.
- Tests:
    - `tests/billing/cancelFlow.test.ts`, "the account changed between the first send and the retry". These run through the real handler and the repository `FakeResend`. Each starts with a pending-deletion refund that succeeds; then:
        - deletion abandoned, **email changed**, same link retried: `cancelled:true, refundRequested:true, refundRequestFailed:false`. Support got one email, one distinct body was sent under the key, and `reply_to` and the subject still carry the first address.
        - deletion abandoned, **plan and subscription changed**: same outcome. Support got one email whose body still says `Plan: Teacher` / `sub_1`.
        - **both changed** while the deletion is still pending: same outcome.
        - a keep that throws: nothing goes to support, `refundRequestFailed:true`, and `refund_request_keep_failed` is logged.
    - The same file also gets a wiring test binding `keepRefundRequest` to the RPC.
    - `tests/billing/cancelLinkStore.test.ts` (the real store against the local stack): first request kept, a later different request answered with the first, the service role's direct UPDATE refused, link still usable, unknown hash returns `null`.
    - `tests/sql/cancel_link_release_for_deletion.sql` section 4, checks 40–49c: starts with none, first kept, later answered with first, direct change or clear refused, no spend and no expiry change, a spent link keeps one too, `not_found`, `22023` for a non-object, refused for authenticated and anon, service-role only, definer, pinned path.
- **Before the fix:**
    - The first three flow tests failed with `{refundRequested:false, refundRequestFailed:true}`, which is Codex's reproduction. The fourth failed because the dependency did not exist.
    - The SQL proof run against the migration as it stood at `e91a7089` stopped at check 41: "function public.keep_cancel_link_refund_request(text, jsonb) does not exist".
- **After the fix:** cancelFlow 90/90 (including the wiring test), cancelLinkStore 10/10 against the local stack, and the SQL proof passes all its checks.

### 3. MINOR: a matching session setting bypassed the token guard without a pending deletion

**Commit `3595382`**: cancel-link guard: un-spending needs the account's deletion pending, not just the matching setting (PR #73 fix2 3)

- `billing_cancel_tokens_lifetime` (same migration, edited in place) still allows un-spending only for the hash named in `cleffy.cancel_link_release`. It now also requires `public.account_deletion_pending(old.user_id)`, checked inside the trigger itself.
- The check uses nested `if`s, so it runs only for that one un-spend and only after the hash matches. The release function already holds the deletion lock shared, so the trigger takes it again without waiting, and the existing lock order (deletion lock → link locks → row) is unchanged.
- `scripts/apply-migrations.sql` regenerated.
- SQL proof checks 23b–23e in `tests/sql/cancel_link_release_for_deletion.sql`. Each runs `set_config('cleffy.cancel_link_release', <hash>, true)` and then a direct `UPDATE ... SET used_at = null`:
    - on a clear account's spent link, as the service role: refused (`55000`);
    - the same for another clear account under its own hash: refused;
    - both links are still spent afterwards;
    - the same as the table owner: refused.
- **Before the fix**, against the guard as it stood at `e91a7089`: 5 of 44 failed. 23b, 23c and 23e reported "no error raised", 23d failed, and check 46 failed with them because its link had been un-spent.
- **After the fix:** 44/44. The release path still works: checks 05–09 and 24, plus the store test's release case.

## Local checks (final head `3595382`)

| Check                                                                                                                                                 | Result                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint:check`                                                                                                                                  | pass                                                                                                                                                                                                                                                                                                |
| `npm run typecheck`                                                                                                                                   | pass                                                                                                                                                                                                                                                                                                |
| `npm run test` (full vitest)                                                                                                                          | pass: 246 files passed, 6 skipped; 3886 tests passed, 22 skipped. The first full run had one failure in `tests/auth/turnstileField.test.tsx` ("Unable to find a label with the text of: Birth month"), a frontend test this diff doesn't touch. It passed 3/3 alone, and the full re-run was green. |
| `npm run build`                                                                                                                                       | pass                                                                                                                                                                                                                                                                                                |
| `deno check --config supabase/functions/deno.json supabase/functions/*/index.ts` (deno 2.1.4, CI's version)                                           | pass, no errors                                                                                                                                                                                                                                                                                     |
| Prettier on changed files                                                                                                                             | clean                                                                                                                                                                                                                                                                                               |
| Local Supabase `supabase db reset` (fresh apply of every migration, final versions)                                                                   | pass                                                                                                                                                                                                                                                                                                |
| CI's replay (the five cancel-link migrations, then every migration from `20261022100000` on, `psql -v ON_ERROR_STOP=1`)                               | pass                                                                                                                                                                                                                                                                                                |
| Every SQL proof (`tests/sql/*.sql` + `supabase/sql-tests/sharing_access_control.sql` via `scripts/ci/sql-proof.sh`), after the fresh reset and replay | all 69 pass, no failures. `cancel_link_release_for_deletion` 44/44, `migrations_ordered_replay` 10/10, `explicit_grants` 22/22, `stripe_webhook_deletion_pending` 24/24                                                                                                                             |
| `tests/billing/cancelLinkStore.test.ts` against the local stack (`CLEFFY_REQUIRE_LOCAL_DB=1`)                                                         | 10/10                                                                                                                                                                                                                                                                                               |
| `tests/storage/storageLifecycle.test.ts` against the local stack                                                                                      | 5/5                                                                                                                                                                                                                                                                                                 |

## CI on the final head `3595382f834448c0c802e9dda4e85de0a7c03117`

**Fully green.** Every check finished and passed. Supabase Preview was skipped by its own condition, and Vercel passed, so the rate-limit exception was not needed.

Workflow runs for head `3595382`:

- `CI`, pull_request, run **39883317906** (attempt 1): success.
- `CI`, push, run **39883313395**: attempt 1 failure (infra, below); attempt 2 success.

| Check                                 | Run / job id                                                          | Result  |
| ------------------------------------- | --------------------------------------------------------------------- | ------- |
| checks (pull_request)                 | run 39883317906 / job 120185570662                                    | success |
| supabase-local (pull_request)         | run 39883317906 / job 120185570604                                    | success |
| edge-functions-deno (pull_request)    | run 39883317906 / job 120185570560                                    | success |
| omr-service (pull_request)            | run 39883317906 / job 120185570437                                    | success |
| supabase-drift (pull_request)         | run 39883317906 / job 120185570754                                    | success |
| checks (push, attempt 2)              | run 39883313395 / job 120186653417                                    | success |
| supabase-local (push, attempt 2)      | run 39883313395 / job 120186651809                                    | success |
| edge-functions-deno (push, attempt 2) | run 39883313395 / job 120186688642                                    | success |
| omr-service (push, attempt 2)         | run 39883313395 / job 120186699316                                    | success |
| supabase-drift (push, attempt 2)      | run 39883313395 / job 120186653769                                    | success |
| Vercel (commit status)                | https://vercel.com/maxs-projectsd/cleffy/CFqCDhFp76dULsFtkNRcFJAvRR4B | success |
| Vercel Preview Comments               | check run 120185753616                                                | success |
| Supabase Preview                      | check run 120185550348                                                | skipped |

**One re-run, for an infrastructure failure.** In attempt 1 of the push run, `supabase-local` (job 120185555746) failed in its first stack step, "Start the local Supabase stack and apply every migration":

> failed to bind host port for 0.0.0.0:54422 ... address already in use

That is a GitHub-hosted runner networking failure. Every later step (replay, store tests, SQL proofs) was skipped, so no test or proof ran. The identical job in the pull_request run (120185570604) passed on the same commit, including every SQL proof. I re-ran it once (`POST /actions/jobs/120185555746/rerun`, which started attempt 2 of the run), and all jobs passed. No other failure, and no further re-run.

## Open questions

- None blocking.
- Design choice for finding 2: the first refund request is kept on the token row, which needs a new column and RPC in the same never-applied migration. The alternative was to make the payload depend only on immutable identifiers, which would have dropped the buyer's email, Reply-To and plan from the support email. Codex may want to confirm it accepts this approach.
- Deploy order now matters for refunds: if `billing-cancel` is deployed before the migration, refund requests are not sent and buyers are told to email support. `DEPLOY.md` already says to apply the migration first.
