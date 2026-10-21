# Launch compliance fix pass, round 2: Session C (mh/launch-checkout, PR #62)

- **PR:** https://github.com/maxharris1/Cleffy/pull/62 (still draft, into `dev`; no reviewers requested)
- **Starting head:** `f6afb770aedb8bd5b8d33b406a0e26ae1f7d1937` (confirmed before any change; origin had not moved)
- **New head:** `664ab41ceca3d9e5a6644e284a46ff94dcf33437`
- **Environment:** Cleffy cloud environment (`env_01WAd3yiz3qpSnsofpyEwCh2`, name "Cleffy"), **not** Sandbox. Confirmed with `get_session` / `list_environments` at the start.
- **Commits:** all authored as Max Harris <drumaxter@gmail.com>, pushed fast-forward only to `mh/launch-checkout`, one push per item. No force, no merges, nothing pushed to `main`/`dev`, and PR #54 untouched.

## Round-2 findings → commits → tests

| # | Finding | Commit | Covering tests |
|---|---|---|---|
| C1 | **Confirmation durability.** Whether a cancellation was scheduled is now read from the event payload (`previous_attributes` + embedded subscription), not from Stripe's live state. The live state can only veto an *undone* cancellation (still running, no longer cancelling). An ended subscription is confirmed from the event. | `27cd9a0` | `tests/billing/webhook.test.ts:647`: recording fails, the subscription ends (`canceled`), Stripe redelivers, and the cancellation confirmation is still recorded (fails on the old code, passes now). `:693`: same for the purchase confirmation. The existing undone/no-transition cases still pass. |
| C2 | **billing-cancel `cancel_at`.** `billing-cancel` now reads Stripe through `stripeEvents.ts liveSubscriptionOf`, the webhook's own rule. Only `cancel_at_period_end`, or a `cancel_at` at or before the current period end, counts as cancelling. A `cancel_at` months out is "not cancelling", so "Cancel now" sets `cancel_at_period_end`. The existing "Stripe must answer cancelling" check still guards success. | `bbd71d2` | `tests/billing/cancelFlow.test.ts:514`: a Stripe object with `cancel_at` 90 days past the period end goes through the adapter and the flow, and Stripe is called. `:606` and onward: unit cases (later, equal, earlier, `cancel_at_period_end`, none) plus a wiring assertion that `billing-cancel/index.ts` uses the adapter. |
| C3 | **Deploy safety.** `20261020160200_billing_mail_outbox.sql` no longer drops `billing_notices`. The previous webhook keeps claiming and sending confirmations against the migrated schema until the new one is live. The new functions never touch the table. The drop is documented as a separate, later migration, after the new webhook has been live past Stripe's 3-day retry window (`SETUP_SUPABASE.md`, "Billing mail rollout"). The mirror was regenerated with `npm run migrations:mirror`. | `664ab41` | `tests/sql/launch_checkout_fixes.sql` 43–48: on the fully migrated schema, the old webhook's claim insert succeeds, a duplicate claim raises 23505, release (delete) works, and the cancellation key fits. `tests/billing/billingOutbox.test.ts:429` fails if any migration drops `billing_notices` or any new function reads or writes it. |
| C4a | **Mail budget, canonical split.** One canonical `_shared/mailBudget.ts` with `LAUNCH_MAIL_SPLIT` (Max's binding split). `MAIL_CATEGORY_CAPS` is an alias of it. `GUEST_AND_AUTOMATED_MAIL_CAP` / `BILLING_CANCEL_SHARE` are removed. Pushed first so #63/#64 could copy it. | `5f01b8e` | `tests/security/mailBudget.test.ts:175` asserts each category's values. `:190` asserts that the totals derived from the shared constants are exactly 60/300 (no hypothetical additions, which fixes Codex cross-PR minor 2, the 75/360). |
| C4b | **Mail budget, confirmations go through it.** Purchase and cancellation confirmations send via `billingOutbox.ts sendWithinBudget`, counted against `billingConfirmation` (7/h, 30/day). A spent window defers the outbox row (`retry`, with the reopening time), never drops it and never sends past the limit. A failed send hands back its count. billing-cancel's refund request to support (the other direct Resend send on this branch) uses the same share. | `a2b38f0` | `tests/billing/billingOutbox.test.ts:313` (share spent → retry, no send), `:342` (hand-back on a failed send), `:352` (nothing spent without a recipient), `:412` (wiring: every billing send is behind a share). |
| C4c | **Single legal-versions source.** `billingTerms.ts`'s `LEGAL_VERSIONS` copy is removed. Checkout and the confirmation email take versions via `deps` from `_shared/legalVersions.ts`, added byte-identical to #63's, so the merge is clean (Codex cross-PR minor 3). | `d5c006d` | `tests/billing/billingTerms.test.ts:214` (no copy in billingTerms, and the stripe-checkout and worker wiring use the shared module), `:229` (TRADER = LEGAL_OPERATOR). #63's `legalVersions.test.ts` holds server = published. |

## Mail budget: final split (binding, Max) and merged totals

`supabase/functions/_shared/mailBudget.ts` → `LAUNCH_MAIL_SPLIT`, byte-identical on #63, #62 and #64. Checked after they copied it: `origin/mh/launch-legal-pages@4e90848` and `origin/mh/launch-consent@2208740` both match this branch.

| Category | Sender | Hour | Day |
|---|---|---:|---:|
| `guestEmailCode` | guest-email-start | 28 | 150 |
| `contentReportAck` | content-report (#63) | 8 | 35 |
| `moderationNotice` | content-moderation (#63) | 4 | 20 |
| `billingCancelLink` | billing-cancel link via outbox (#62) | 8 | 40 |
| `billingConfirmation` | purchase/cancellation confirmations + refund request to support (#62) | 7 | 30 |
| `retentionNotice` | district-retention-notices (#64) | 5 | 25 |
| **Total** | | **60** | **300** |

The total is budget 100/500 minus the 40/200 auth reserve. Every category is registered on every branch, so each branch's test asserts the merged total. No disagreement: the split was set by Max mid-pass. I had proposed different numbers to B and A before the decision and stopped on Max's instruction.

## Resend call sites on this branch (`mh/launch-checkout` @ 664ab41)

| Call site | What | Through the shared budget? |
|---|---|---|
| `supabase/functions/_shared/billingMail.ts:31` (`sendBillingEmail`) | The one billing send. Called only via `billingOutbox.ts:205` (`sendWithinBudget`: confirmations + refund request, `billingConfirmation`) and `cancelFlow.ts:323` (cancel link, `billingCancelLink`, gated at `cancelFlow.ts:290-291`) | **Yes** |
| `supabase/functions/_shared/guestEmailWiring.ts:74` | Guest-email code. Gated in `guestEmail.ts:444-445` on `mailLimit('guestEmailCode')` | **Yes** |
| `supabase/functions/resend-inbound/index.ts:208` | Forwards inbound support mail to the support mailbox. **Unchanged from `dev`**, not part of #62's diff | **No** (open question 1) |
| `supabase/functions/resend-inbound/index.ts:158` | Reads a received email from Resend (GET, sends nothing) | n/a |

## Checks run (local, Cleffy cloud environment)

Before every push: `npx prettier --write` on changed files, `npm run lint:check`, `npm run typecheck`, `npm run test`, `npm run build`. All passed at each of the 6 pushes. At the final head: **197 test files, 2853 tests passed**, lint, typecheck and build clean.

- `.env.local` (written by `npm run cloud:up`, gitignored) makes two unrelated suites (`src/sync/syncEngine.test.ts`, `tests/auth/turnstileField.test.tsx`) fail locally. Both pass without it, which is how CI runs. Not committed, not a regression.
- **SQL (local stack, `npm run cloud:up`)**: `tests/sql/launch_checkout_fixes.sql` → `0 | 46` failures/total; `tests/sql/checkout_consents.sql` → `0 | 24`.
- **Migration mirror**: `npm run migrations:mirror` re-run on this branch after the migration edit. **Max regenerates `scripts/apply-migrations.sql` and `tests/migrationRecoverability.test.ts` with `npm run migrations:mirror` after each merge.** Neither was hand-merged.
- **ui-check**: not applicable. Round 2 changed no UI (backend, migration, docs and tests only).
- No hosted Supabase, no live Stripe, no keys printed, no `.env` committed, no `playwright install`.

## CI on the new head

**Green** on `664ab41ceca3d9e5a6644e284a46ff94dcf33437` (both CI runs, completed 19:30–19:31 UTC): `checks` ✅ (lint, typecheck, tests, build) · `supabase-drift` ✅ · `omr-service` ✅ · Vercel Preview ✅ · Supabase Preview skipped (as on every earlier head). GitHub reports PR #62 `mergeable_state: clean` against `dev`; it is still draft.

## Skipped minors

- **Codex #62 minor 1 (discount duration stated in the confirmation).** Not fixed. Stating it needs the coupon's `duration`/`duration_in_months`, which the `checkout.session.completed` payload doesn't carry. That means an extra expanded Stripe read on the webhook path and new outbox payload fields, which is more than a cheap, safe minor. The email still says the renewal price, separately from today's discounted charge, and that the discount lasts only as long as the code states.
- **Codex #62 minor 2.** Already resolved in round 1; nothing to do.

## Open questions

1. **`resend-inbound` forwarding is outside the mail budget.** It's an existing `dev` sender (support mail forwarded to the support mailbox), not changed by any launch PR. Budgeting it means a seventh category, which changes the locked 60/300 split. Max to decide whether it gets a share (and from where) or stays exempt as inbound-driven internal mail.
2. **Transitional sends by the previous webhook.** Between the migrations and the function deploy, the previous `stripe-webhook` sends confirmations inline, outside the budget, as it does today. This lasts only until the new functions are deployed.
3. **`billing_notices` drop.** The follow-up migration (`drop table if exists public.billing_notices;`) is intentionally not in this PR. It should be written after the new webhook has been live for more than 3 days (`SETUP_SUPABASE.md`, "Billing mail rollout").
4. **Discount duration in the confirmation** (skipped minor 1): fine as worded, or worth the extra Stripe read?
