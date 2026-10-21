# Launch compliance fix pass — Session C: PR #62 (`mh/launch-checkout`)

- **PR:** https://github.com/maxharris1/Cleffy/pull/62 (draft into `dev`; still draft, no new PR)
- **Old head (Codex review):** `d740fcd9d03c6ac3dde2c5ca5bdd18e29bcd3ef2`
- **New head:** `f6afb770aedb8bd5b8d33b406a0e26ae1f7d1937`
- **Environment:** Cleffy cloud environment (`env_01WAd3yiz3qpSnsofpyEwCh2`), confirmed with `list_environments`. Not Sandbox.
- **Pushes:** fast-forward only, to `mh/launch-checkout`. No force push, no merge into `dev`, and nothing touched on #54, hosted Supabase or Stripe.
- **This report** is on the scratch branch `claude/lc-fix-report-launch-checkout`, one commit on top of the new head. It is not on `mh/launch-checkout`.

## Findings → commits → tests

| #       | Finding                                                                                                                                     | Commit              | Tests (each new test fails against the old code)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1      | Crash recovery replayed the Stripe idempotency key with a fresh `consent_id`, so the parameters differed and Stripe would refuse the replay | `6b3921a`           | The test Stripe stub now refuses a replayed key whose parameters differ, as Stripe does. The old flow fails 3 recovery tests against it. New tests in `tests/billing/checkoutFlow.test.ts`: the replay reuses the original consent; a changed request mints a fresh key and expires the orphan; a pre-migration row is never replayed. `tests/billing/billingCorrectnessSql.test.ts` covers the SQL shape. `tests/sql/launch_checkout_fixes.sql` checks 01–10 pass on the local DB.                                                       |
| C2      | Cancel trusted the local mirror and could report success while Stripe still renews                                                          | `9dd216b`           | `tests/billing/cancelFlow.test.ts`, "acts on Stripe's copy…": a resumed subscription the mirror still calls cancelling; an update Stripe doesn't confirm (502, link still usable); peek shows Stripe's state; an ended or missing subscription; Stripe unreadable. 6 tests fail against the old flow.                                                                                                                                                                                                                                     |
| C3      | The webhook swallowed Resend and consent-completion failures and marked the event done                                                      | `6897aa9`           | `tests/billing/webhook.test.ts`: a purchase or cancellation whose notice can't be recorded fails with 500 and releases the claim; the redelivery re-applies and records the notice once. New `tests/billing/billingOutbox.test.ts`: backoff, ALERT after 5 attempts, a worker dying mid-lease, the claim token, bounded rounds, the deliverers. `launch_checkout_fixes.sql` checks 20–44 and 50–56 (dedupe, leases, settling, housekeeping, the cron job, grants) pass.                                                                   |
| C4      | The signed-out cancel lookup leaked whether an address subscribes (503 vs 200, and timing)                                                  | `493116f`           | `tests/billing/cancelFlow.test.ts`, "answers every address the same…": for a subscriber, an unknown address, an account without a subscription, a spent mail budget and a failing Resend, the handler makes the same calls in the same order before answering (IP limit → one insert → send in background), never looks up or sends, and gives the same answer. A queue failure answers the same for any address. A link held back by the budget goes out when the window reopens, and Resend failures retry with the budget handed back. |
| C5      | Mail-budget split shared with B6                                                                                                            | `dcde0fa`           | `tests/security/mailBudget.test.ts`: guest 35/190; guest + cancel link 10/50 + #63's report ack 10/40 + moderation notice 5/20 fit inside 60/hour and 300/day.                                                                                                                                                                                                                                                                                                                                                                            |
| minor 2 | Confirmation used deployment-time policy versions                                                                                           | `6897aa9` (with C3) | `billingOutbox.test.ts`: the email names the consent's versions and falls back to the published ones only when no consent matched.                                                                                                                                                                                                                                                                                                                                                                                                        |
| minor 1 | Confirmation said renewals are "at the same price" after a promotion                                                                        | `f6afb77`           | `tests/billing/billingTerms.test.ts` and `billingOutbox.test.ts`: the email shows the regular renewal price with its tax treatment, any discount applied today, and says the discount lasts only as long as the code states.                                                                                                                                                                                                                                                                                                              |

### What changed, briefly

- **C1:** `checkout_attempts` gains `consent_id` and `params_hash` (migration `20261020160100`). Staging stores them beside the key. Recovery reuses the original consent, rebuilds the parameters, and replays the key only if their SHA-256 (of the parameters plus the consent wording) matches. Otherwise it goes down layer 5: a fresh key, and the open orphan is expired. `stage_checkout_attempt` gives the two new arguments defaults, so a function deployed before the migration keeps working; its rows just aren't replayable.
- **C2:** The cancel page reads the subscription with `subscriptions.retrieve` before showing it and before acting on it. Success is reported only when Stripe's answer to the update says the subscription is cancelling.
- **C3:** New durable outbox `billing_mail_outbox` (migration `20261020160200`), with `enqueue_billing_mail`, `claim_billing_mail` (SKIP LOCKED plus an expiring lease), `settle_billing_mail` (scoped to the claim token) and `billing_mail_outbox_tick` (a pg_cron job every minute; housekeeping, then a pg_net poke to the new `billing-mail-outbox` function, which is protected by a shared secret).
    - The webhook completes the consent and enqueues the confirmation idempotently. If either write fails, it fails the event so Stripe redelivers.
    - Mail goes out after the response (`EdgeRuntime.waitUntil`), with retries backing off from 1 minute up to 6 hours. A confirmation is never dropped. The only exception is an account that no longer has an address, which logs an ALERT.
    - `billing_notices` is replaced by the outbox's unique key and dropped.
- **C4:** `start` inserts every well-formed address into the outbox and answers `200 {sent:true}`. The worker then does the lookup, the per-recipient limit, the budget check and the send (`deliverCancelLink`). A request that finds no subscription is deleted with its address, and the tick also purges any request older than a day.
- **C5:** `guestEmailCode` goes from 50/250 to 35/190. `billingCancelLink` stays at 10/50. Session B confirmed the same split: its `f1feb4a` on #63 sets `guestEmailCode` to 35/190 and adds the constants `GUEST_AND_AUTOMATED_MAIL_CAP` (35/190) and `BILLING_CANCEL_SHARE` (10/50).

## Local checks (on `f6afb77`)

| Check                                               | Result                                                 |
| --------------------------------------------------- | ------------------------------------------------------ |
| `npm run lint:check`                                | pass                                                   |
| `npm run typecheck`                                 | pass                                                   |
| `npm run test`                                      | pass: 197 files, 2838 tests                            |
| `npm run build`                                     | pass                                                   |
| `npx prettier --check` (changed TS/MD)              | pass (Prettier has no SQL/TOML parser)                 |
| `tests/sql/launch_checkout_fixes.sql` (local stack) | 42/42                                                  |
| `tests/sql/checkout_consents.sql` (local stack)     | 24/24 (`billing_notices` checks moved to the new file) |
| `tests/sql/billing_double_charge.sql` (local stack) | 95/98, see below                                       |

Notes:

- **One suite fails only on a local stack.** `tests/auth/turnstileField.test.tsx` fails whenever `npm run cloud:up` has written `.env.local`, which sets a Turnstile site key. It passes with that file moved aside, and CI has no such file. All suite runs above had `.env.local` moved aside.
- **The 3 `billing_double_charge.sql` failures predate this pass.** The local image grants anon SELECT on `checkout_attempts`, `subscription_write_locks` and `duplicate_refunds`, which come from older migrations; RLS still returns no rows. No migration in this pass touches those grants.
- The local stack ran via `npm run cloud:up` and was stopped with `npm run cloud:down` when finished.

## CI on the new head

Green on `f6afb77` (both push and pull_request runs): `checks` ✅ (lint, typecheck, test, build), `supabase-drift` ✅, `omr-service` ✅, Vercel Preview Comments ✅, Supabase Preview skipped. GitHub reports the PR `mergeable_state: clean` against `dev` @ `282b30a`. Every intermediate head was green too (`6b3921a`, `9dd216b`, `6897aa9`, `493116f`, `dcde0fa`).

## ui-check

Not run: nothing under `src/` changed. `/cancel` still gets `{sent: true}` (or 400/429/503) from `start`, and its other answers keep the same shape.

## Skipped minors

- **Cross-PR minor 5 (checkout keeps its own legal-version constants):** not fixed here. The canonical `legalVersions.ts` server mirror arrives with #63, which isn't on this branch. Wiring `billingTerms.LEGAL_VERSIONS` to it, and adding a sync test, should follow once #63 is merged and #62 is rebased. Minor 2's fix already limits the damage: confirmations now name the versions stored with each consent.
- **Cross-PR majors 1–2 (deployment order, mirror conflicts):** these are about merging and rollout, not code on #62. This branch regenerated `scripts/apply-migrations.sql` with `npm run migrations:mirror` after each migration change.
- **Pre-existing local anon SELECT grants on billing tables:** not a Codex finding, and RLS already hides the rows. Left alone so this pass doesn't widen.

## Open questions and rollout notes for Max

1. **Outbox retries need setup at rollout.** Set the Edge secret `BILLING_OUTBOX_SECRET`, deploy `billing-mail-outbox --no-verify-jwt`, and create the Vault secrets `billing_outbox_url` and `billing_outbox_secret` (`SETUP_SUPABASE.md`). Until then mail still goes out right after it's queued, but a failed send isn't retried. Ticks only do housekeeping without the secrets, so the cron is safe to schedule.
2. **New cron job `billing-mail-outbox`** is registered in `tests/migrationRecoverability.test.ts`. #64 adds a retention cron to the same pinned map, so the merge has to keep both entries.
3. **Mail budget:** agreed with Session B: guest 35/190, `contentReportAck` 10/40, `moderationNotice` 5/20 and `billingCancelLink` 10/50, which is exactly 60/300. Both branches set guest to 35/190, so merging `mailBudget.ts` only needs the union of the categories plus #63's two new constants. The outbox tables don't collide: #63 uses `content_notice_outbox`, #62 uses `billing_mail_outbox`.
4. **Privacy policy (#63):** a signed-out cancel request now stores the typed email address in the outbox until it is handled, normally seconds and at most one day. The privacy policy may want a line on that.
5. **Not verified at runtime:** the local edge runtime can't reach the sandbox's loopback egress proxy, so no function ran end to end. No Stripe test-mode run was done either (no local test keys; live Stripe is off limits). Codex's parameter-equality behaviour is modelled in the stub; a Stripe test-mode rehearsal of crash recovery and `/cancel` before launch would close that gap.
6. **The refund-request email to support@** (cancel page, opt-in) still sends inline. If it fails, the page already tells the buyer to email support themselves. It could move to the outbox later.
7. **Migration `20261020160100`** drops and recreates `begin_checkout_attempt` and `stage_checkout_attempt`. Both are compatible with the currently deployed function (old callers ignore the new columns, and the new arguments have defaults), but apply it with the rest of the set, per the merge-order decision.
