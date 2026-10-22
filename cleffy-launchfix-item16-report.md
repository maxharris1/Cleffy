# Cleffy launch-fix item 16: report

**Status:** Complete

Decision 70(1)'s policy is implemented for every writer group (stripe-webhook, billing-cancel, the queue and cache writers), and decision 70(8)'s replay list is extended to every migration through the newest and guarded against falling behind. No writer needed a call decision 70 does not answer; the interpretations I made, and what I noticed on the way, are the open questions below. CI on the final head is listed check by check below.

- **PR:** https://github.com/maxharris1/Cleffy/pull/73 (draft, base `mh/launchfix-followups`, head `mh/launchfix-item16`, no reviewers requested). It stacks on #72 and is to be retargeted to `dev` after #72 merges (not done here).
- **Base given:** `fb91497a304c80ebbebafec323ba99891b15a053`. `origin/mh/launchfix-followups` at the start: `fb91497a304c80ebbebafec323ba99891b15a053` (equal).
- **#72 moved before my first push:** at the pre-push check `origin/mh/launchfix-followups` was `c940b0ca68539e1acfaa0820351f0624b4bac72d` (four Codex fix commits, `a49acaf`..`c940b0c`, no new migrations; they edit `20261022140400`, `140700` and `141000`). As rule 4 allows, my three still-unpushed commits were rebased onto `c940b0ca` (clean, no conflicts) and the work continued from there. **The PR's actual base is therefore `c940b0ca`**, not `fb91497a`.
- **`origin/mh/launchfix-followups` at the end:** `c940b0ca68539e1acfaa0820351f0624b4bac72d` (unchanged since the rebase; checked again after CI finished).
- **Final head:** `57960f9f38ac91a505308495e6931a1e603e0651` (`mh/launchfix-item16`)
- **Environment:** Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (`anthropic_cloud`), confirmed with `get_session` at the start. Not Sandbox.

## Branches and pushes

- At the start `git ls-remote --heads origin mh/launchfix-item16` and `... claude/launchfix-item16-report` both printed nothing. The branch was created locally with `git checkout -B mh/launchfix-item16 fb91497a…`.
- Right before the first push, `git ls-remote --heads origin mh/launchfix-item16` still printed nothing.
- First push, creating the branch: `git push -u origin HEAD:mh/launchfix-item16` (`57960f9`).
- There was only the one push to the PR branch: CI on `57960f9` was green on the first try, so no fast-forward pushes followed.
- Nothing used `--force` or `--force-with-lease`; no pushed commit was rebased, amended or squashed; no merge commits. The only history rewrite was the rebase of the three unpushed commits onto #72's new tip, before the first push.
- Commit identity on every commit: Max Harris <drumaxter@gmail.com>.
- This report: branch `claude/launchfix-item16-report`, from the final PR head plus one commit adding this file. No other branch was touched.
- The session's harness also named a branch `claude/launchfix-item16-deletion-policy-mwnhg8`; per Max's instructions it was not used or pushed.
- `gh` was not usable in this container (its token is invalid). The PR was created and CI read through the GitHub MCP tools instead.

## Commits

| Commit    | Group                   | Files (main)                                                                                                                                                                                 | Tests / proofs                                                                                                                                                                                                                                          |
| --------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d4a56b4` | stripe-webhook          | `supabase/functions/_shared/stripeEvents.ts`, `supabase/functions/stripe-webhook/index.ts`                                                                                                   | `tests/billing/webhook.test.ts` (+11), `tests/account/deletionPendingWiring.test.ts` (+1, and the fail-closed list), `tests/billing/{resubscribe,districtSeats}.test.ts` (fakes), new proof `tests/sql/stripe_webhook_deletion_pending.sql` (16 checks) |
| `fd4cfd5` | billing-cancel          | `supabase/functions/_shared/cancelFlow.ts`, `supabase/functions/billing-cancel/index.ts`, `supabase/functions/_shared/billingTerms.ts`, `src/features/billing/{cancelApi.ts,CancelPage.tsx}` | `tests/billing/cancelFlow.test.ts` (+9 flow, +1 wiring), `src/features/billing/CancelPage.test.tsx` (+2)                                                                                                                                                |
| `cbe9b60` | queue and cache writers | `supabase/functions/_shared/{guestEmail,guestEmailWiring}.ts`                                                                                                                                | `tests/auth/guestEmail.test.ts` (+3), new `tests/account/deletionPendingPolicy.test.ts` (24: pins every writer's class)                                                                                                                                 |
| `568c310` | replay list (70(8))     | `tests/sql/migrations_ordered_replay.sql`, `tests/legal/districtReattribution.test.ts`, `tests/sql/README.md`                                                                                | the proof itself (10 checks, was 9), the directory guard                                                                                                                                                                                                |
| `57960f9` | docs                    | `DEPLOY.md`                                                                                                                                                                                  | —                                                                                                                                                                                                                                                       |

Before the rebase the first three were `881c545`, `bde96ce` and `7990005` (never pushed).

## Per writer

### stripe-webhook — policy applied

| What               | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy             | While the event's user has an account deletion pending: **503, nothing written, event claim released.** A check that cannot be answered is refused the same way (503 `deletion_check_unavailable`), since nothing was written and the retry asks again.                                                                                                                                                                                                                                                                                                                    |
| Where              | `stripeEvents.ts` `deletionRefusal`, a new `WebhookStore.accountDeletionPending` port (bound in `stripe-webhook/index.ts` to `account_deletion_pending()` via `_shared/deletionPending.ts`). `checkout.session.completed`: after the user is resolved, before the customer link (the first write). `customer.subscription.*`: before the subscription lock. `invoice.*`: before the lock for every user the database ties the invoice to (its customer's mapping, the subscription's row), and again inside the lock for the user the Stripe read names, before the write. |
| Nothing written    | No `billing_customers` link, no `subscriptions` row, no archive or restore, no purchase or cancellation notice (outbox), no consent completion.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Abandoned deletion | Stripe's retry finds the account clear and is processed normally, once: its claim is taken afresh and marked done, and every later delivery is a duplicate (tested: `webhook.test.ts` "deletion abandoned" ×2; proved: `stripe_webhook_deletion_pending.sql` checks 01–07).                                                                                                                                                                                                                                                                                                |
| Completed deletion | The retry's write finds no user: `write_subscription_under_lock` answers `missing_user` and the store hands it to `deletedAccountBilling.ts` `stopDeletedAccountSubscription`, which cancels anything that can still bill; the checkout's customer link fails on the user FK and is skipped (tested with the same function: "deletion completed" ×2; proved: checks 08–14). Subscription metadata carries `user_id` (stripe-checkout sets it), so a retry still names the deleted user.                                                                                    |
| Mutation check     | With the refusal disabled, 11 of the new webhook tests fail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### billing-cancel (signed-out cancel link) — policy applied

| What                 | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy               | While the link's account is being deleted: **the Stripe subscription is not touched** (the deletion cancels it, immediately), **the link is not spent** (so the same link, or a new one, cancels as usual if the deletion is abandoned), **a refund request inside the 14 days always goes to support** (and says the account is being deleted), and **the page tells the user plainly** what happened.                                                              |
| Where                | `cancelFlow.ts`: a new `CancelDeps.accountDeletionPending` port (bound in `billing-cancel/index.ts`). `confirmCancel` asks before the link is spent or Stripe is read; `peekCancel` asks before Stripe is read.                                                                                                                                                                                                                                                      |
| Peek while pending   | Answers the mirror's summary plus `deletionPending: true`, **without reading Stripe**: by then the deletion has usually cancelled the subscription already, and the normal peek would answer "nothing to cancel" and never reach the refund request. The webhook (above) leaves the mirror alone while the deletion is pending.                                                                                                                                      |
| Cancel while pending | `200 {cancelled: false, deletionPending: true, refundRequested, refundRequestFailed}`. The refund request goes through the same send as a normal cancel (`sendBillingEmailWithinBudget`, Resend Idempotency-Key = the link's hash), so a second press, or the press after an abandoned deletion, mails support once. A failed send tells the buyer to email support, as before.                                                                                      |
| Page                 | `CancelPage.tsx`: "This account is being deleted. Deleting it cancels this subscription, so there is nothing to cancel here." and, inside the 14 days, one button, "Request a full refund". After it: "Your account is being deleted / Deleting your account cancels your subscription, so nothing was changed here.", the refund outcome, and "If the deletion does not go through, use this link again, or ask for a new one, to cancel." No new toolbar controls. |
| Check unanswered     | 503 `unavailable`; nothing spent, read, changed or sent.                                                                                                                                                                                                                                                                                                                                                                                                             |
| Tests                | Both paths: pending (peek, peek with Stripe already cancelled, cancel with and without refund, refund send failing, outside 14 days, unanswered check) and clear/abandoned (the same link then cancels at Stripe, support keyed once, then spent; the check precedes the spend). With the check disabled, 9 of the new flow tests fail.                                                                                                                              |

### Queue and cache writers — classified

| Writer                                                                                                                                              | Class      | What it does for a pending-deletion user                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `guest-email-start` (save code + mail it)                                                                                                           | **refuse** | 409 `account_deletion_pending` ("This account is being deleted, so an email address can’t be added to it now."), before the address lookup, the save, the budgets or the send; 503 `deletion_check_unavailable` if unanswered. |
| `guest-email-confirm` (try the code, attach email + password)                                                                                       | **refuse** | Same answers, before the code is tried (no try spent) or anything attached; the pending code is left for an abandoned deletion.                                                                                                |
| `content-report` (`content_reports`, `content_notice_outbox`)                                                                                       | keep       | Legally required report; unchanged, never asks.                                                                                                                                                                                |
| `content-moderation` (moderation queue, takedowns)                                                                                                  | keep       | Moderation queue; unchanged.                                                                                                                                                                                                   |
| `content-notices` (notices to uploaders)                                                                                                            | keep       | Legally required notices; unchanged.                                                                                                                                                                                           |
| `billing-mail-outbox` / `billingMailWorker.ts` / `billingMail.ts` / `billingOutbox.ts` (receipts, cancellation confirmations, cancel-link requests) | keep       | Billing receipts and cancellation mail; the cancel-link request is the route to the refund request. Unchanged.                                                                                                                 |
| `district-retention-notices` / `districtNotice.ts`                                                                                                  | keep       | District retention notices; unchanged.                                                                                                                                                                                         |
| `resend-inbound` / `supportMail.ts` (`support_messages`)                                                                                            | keep       | Inbound support mail, keyed by address, not account; decision 49(3) says report acks must never be starved. Unchanged.                                                                                                         |
| `imslp-search`, `imslp-work` (`imslp_file_licenses`), `imslp-sync` (works mirror)                                                                   | unchanged  | Catalog caches, not user data.                                                                                                                                                                                                 |
| OMR `score_cache` (`score_cache_put`, omr-service)                                                                                                  | unchanged  | Content-hash cache, not user data. (`score-analyze`, which meters and enqueues OMR jobs, already refuses since P3.)                                                                                                            |
| `analyze-annotations`, `analyze-notes` (`quota.ts` `vision_reads`)                                                                                  | unchanged  | User-keyed quota counters; cascade with the account. No queue write.                                                                                                                                                           |
| `rateLimit.ts` (`edge_rate_buckets`), `loginThrottle.ts` / `student-login` (`edge_login_attempts`)                                                  | unchanged  | Rate counters; cascade or not user data.                                                                                                                                                                                       |
| `document_realtime_rotation_queue`                                                                                                                  | unchanged  | Internal, written by triggers on access loss, empty outside a transaction.                                                                                                                                                     |

`tests/account/deletionPendingPolicy.test.ts` pins every row above: the keep and unchanged writers must not ask, and the refuse writers ask before anything is stored, mailed or tried.

Already refusing before this PR (P3, unchanged here): `student-provision`, `stripe-checkout`, `imslp-download`, `score-analyze`, `student-claim`.

**Note (open question 1):** today only an anonymous caller reaches the guest email functions (a registered account is refused `not_guest`), and deleting a guest (`accountDeletion.ts` `deleteGuest`) takes no deletion marker. So the guest email refusal **cannot fire yet**; it is in place for the day the guest path marks its deletion.

## Decision 70(8): the ordered replay list

- `tests/sql/migrations_ordered_replay.sql` now `\ir`s **every** migration from `20261020160300` to the newest, in filename order: 63 files (was 28, ending at `20261022130400`), P1 to P6 and #72's `14xxxx` included. There are no `15xxxx` migrations (this PR needed none).
- Rather than a generated include file (which would itself be picked up by CI's `tests/sql/*.sql` loop as a proof), the hand-written list is now guarded: `tests/legal/districtReattribution.test.ts` fails unless the list equals the directory from `20261020160300` on. A new migration fails CI until it is listed.
- Two changes the longer list needed: `set constraints all immediate` before the replay, so the fixtures' deferred trigger events fire as at a commit (otherwise `20261022120000`'s `ALTER TABLE` on the rotation queue refuses "pending trigger events" inside the one transaction); and a new check 13c that the follow-ups' definitions win (the run's detach and hand-on, `my_storage_usage`, both sweeps, the rotation queue). With the old list 13c fails (verified locally).
- It stays in CI's every-proof loop (it is a `tests/sql/*.sql` file); CI's own one-file-per-`psql` re-apply step is unchanged.

## Migrations

**None.** The policy lives in the Edge Functions and the frontend; every refusal asks `account_deletion_pending()` (`20261022110400`, P3, already applied). So no service_role grant, no `npm run migrations:mirror` change (`scripts/apply-migrations.sql` untouched; `applyMigrationsInSync.test.ts` passes), and nothing in the `2026102215xxxx` range.

Deploy order (DEPLOY.md, added under the follow-ups' batch-3 note): redeploy `stripe-webhook`, `billing-cancel`, `guest-email-start`, `guest-email-confirm` and the frontend. One constraint: the frontend with or before `billing-cancel`, since an older cancel page shows the new "account is being deleted" answer as an ordinary cancellation.

## Proofs

| Proof                                 | Checks | New / changed                                         | Fails without the change                                                                                                                                  |
| ------------------------------------- | ------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stripe_webhook_deletion_pending.sql` | 16     | new                                                   | n/a (proves the database half the webhook relies on: predicate states, release and fresh re-claim, done once, `missing_user` and the FK after completion) |
| `migrations_ordered_replay.sql`       | 10     | changed (63 migrations, check 13c, deferred triggers) | 13c fails with the old list                                                                                                                               |

All existing proofs pass: **68 proofs, 2,502 checks, 0 failing** on the final local run (67 on `c940b0ca` plus the new one).

## Local checks (head `57960f9`)

All on the local stack (`npm run cloud:up`), never hosted Supabase; the local database was reset (`supabase db reset --local`) after the rebase, because #72's fixes edited three of its migrations, so the run matches CI's fresh install. Checks ran in a clean worktree of the head (no `.env.local`), as CI does.

- `npm run lint:check`: pass.
- `npm run typecheck`: pass.
- `npm run test`: **244 files passed, 6 skipped; 3,847 tests passed, 20 skipped, 0 failed.** (One unexplained single failure appeared once in a partial `tests/account tests/auth` run during development and did not reproduce in four reruns or any full run.)
- `npm run build`: pass.
- `deno check --config supabase/functions/deno.json supabase/functions/*/index.ts` (Deno 2.1.4, CI's version, in the scratchpad): pass. CI runs no `deno test`.
- CI's re-apply step (the cancel-link five, then every migration from `20261022100000`): pass.
- Local-stack API tests CI runs (`cancelLinkStore.test.ts`, `storageLifecycle.test.ts`): pass.
- Every SQL proof after the replay: 68 of 68 OK, 2,502 checks.
- The same full set also passed on the pre-rebase heads `881c545` (3,805 tests; 67 proofs, 2,485 checks) and `7990005` (3,844 tests; 67 proofs, 2,485 checks).

## CI on the final head

Head `57960f9f38ac91a505308495e6931a1e603e0651`. CI triggered for this base: two runs of the `CI` workflow, both completed, **39867733416** (push) and **39867769313** (pull_request). **Every check is green.**

| Check                                                                  | push run 39867733416       | pull_request run 39867769313 |
| ---------------------------------------------------------------------- | -------------------------- | ---------------------------- |
| checks (audit, lint, typecheck, test, build)                           | success (job 120134070667) | success (job 120134191059)   |
| supabase-local (replay, store test, Storage API test, every SQL proof) | success (job 120134070597) | success (job 120134191203)   |
| edge-functions-deno                                                    | success (job 120134070216) | success (job 120134191125)   |
| omr-service                                                            | success (job 120134070666) | success (job 120134191158)   |
| supabase-drift                                                         | success (job 120134070584) | success (job 120134190720)   |

Other checks on the head:

- Vercel commit status: **success**, "Deployment has completed" (`https://vercel.com/maxs-projectsd/cleffy/HZwgrLs2r1csgaUukAgrvLQXHsca`). Not rate limited; no action taken on Vercel.
- Vercel Preview Comments (check run 120134316932): success.
- Supabase Preview (check run 120134194965): skipped, as on the other launch-fix PRs.

## Hosted steps left for Max (none performed)

- When this PR (after #72) is merged and deployed: redeploy `stripe-webhook`, `billing-cancel`, `guest-email-start`, `guest-email-confirm`, and the frontend (frontend with or before `billing-cancel`). No migration, no secret, no config change.
- Nothing hosted was touched: no hosted Supabase (prod or dev), Vercel or Stripe. No live Stripe call; Stripe is mocked in every test. No key, token or secret was printed or committed. `.env.local` (written by `cloud:up`) was never committed.

## Open questions and decisions needed

1. **Guest email refusal is inert today.** Only anonymous callers reach `guest-email-start`/`-confirm`, and `deleteGuest` takes no `account_deletions` marker, so `account_deletion_pending()` is never true for them. Should the guest deletion path take the marker (so a guest who upgrades while their profile is being deleted is refused)? That is a change to the deletion flow, so I left it.
2. **billing-cancel "always" = whenever the buyer asks inside the 14 days.** I kept the normal path's conditions (the buyer ticks/presses the refund request; first purchase within 14 days; an email on the account). Pending deletion never suppresses it. If "always" was meant to send a refund request even when the buyer did not ask, or outside the window, that is a billing/legal call.
3. **billing-cancel refund request is sent, not durably queued.** It uses the same direct send as a normal cancel (Resend with an idempotency key; a failed send tells the buyer to email support themselves). The packet's word was "queue"; decision 70(1)'s was "sends". A durable outbox row for refund requests would be a new outbox kind (and a migration). Wanted?
4. **Long-pending deletions and Stripe's retry window.** The webhook refuses for as long as the deletion is pending. An attempt is pending at most its 10-minute lease unless destructive cleanup began; a half-deleted account with no live attempt (the support runbook's case) stays pending until a retry completes it. Stripe retries a failed event for about 3 days, so events for an account left half-deleted longer than that are dropped. The deletion's own step 7 Stripe sweep still cancels subscriptions on completion, so nothing keeps billing, but the mirror for that account would not get those events. Worth a line in the stale-deletion runbook?
5. **Invoice residual.** For an invoice whose payer only the Stripe read names (no subscription row, no customer link yet), the deletion check runs inside the subscription lock, after `finishPendingDuplicateUndo`; that step only finishes a duplicate refund an earlier delivery already owed (money back to the customer). Accepted as is?
6. **Not classified by decision 70, unchanged:** `stripe-portal` (creates a Stripe Customer Portal session; writes nothing in our database) does not ask whether the account is being deleted. Out of item 16's list; flagged only.
7. **#72 moved during this session** (`fb91497a` → `c940b0ca`) before my first push; I rebased the unpushed commits onto it (rule 4). It did not move again after my first push (`c940b0ca` at the end), so nothing is left for Cleffy on that front.

## Couldn't do

- Nothing in scope was left undone. `gh` was unusable (invalid token); the GitHub MCP tools were used for the PR and CI.

## Environment and housekeeping

- Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (`anthropic_cloud`), not Sandbox.
- Local stack only. `npm run cloud:down` was run at the end ("Stopped supabase local development setup."; no supabase containers left).
- No messages were sent to any session or agent, and no handoff. No Codex review was requested or run. PR #54, PR #72 and every other PR and branch were left untouched.
- Deletions were limited to scratchpad files (plus one temporary copy of the replay proof, created and removed inside the repo's `tests/sql/` during a local check, never committed).
