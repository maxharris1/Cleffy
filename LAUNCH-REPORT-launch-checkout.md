# Launch report: Session C, `mh/launch-checkout` (items 13–19)

- **PR:** https://github.com/maxharris1/Cleffy/pull/62 (draft, `mh/launch-checkout` → `dev`; no reviewers requested)
- **Head SHA:** `dcde0fa6183d8140d763b8192d318c96df7e0c34`. My commit is `d740fcd`; five follow-up fixes from session `01AMyu7iBpgK8Ssqmjf8totG` (`6b3921a`, `9dd216b`, `6897aa9`, `493116f`, `dcde0fa`) sit on top of it. See "Follow-up fixes" below.
- **Base:** `dev` at `282b30a`
- This file lives only on the scratch branch `claude/launch-report-launch-checkout`, in one commit on top of the PR head, together with the ui-check screenshots in `docs/launch-report-launch-checkout/`.

## What was done, per item

| # | Item | Done | Where |
|---|---|---|---|
| 13 | Auto-renewal consent checkbox before checkout | ✅ Unticked; "Continue to payment" stays disabled until ticked. Ticking it confirms one sentence: plan, price with tax treatment, interval, renews until cancelled, no minimum term, how to cancel (CA BPC §17602 / NY GBL §527-a). Changing country unticks it. | `src/features/billing/CheckoutReview.tsx`, `supabase/functions/_shared/billingTerms.ts` |
| 14 | Consent record table | ✅ New `checkout_consents` table. Each row holds the user, mode, Stripe customer, Checkout Session and subscription id, the **exact wording**, the wording, Terms and Refund Policy versions, the timestamp, the declared and the Stripe billing country, the IP and the user agent. The server rebuilds the wording from plan + currency and refuses a mismatch (`409 consent_outdated`). A trigger blocks any delete under 3 years, even by postgres. Account deletion sets `user_id` to null and keeps the row. | migration `20261020160000_…`, `_shared/checkoutFlow.ts`, `stripe-checkout/index.ts`, `stripe-webhook/index.ts` |
| 15 | Pre-payment disclosures | ✅ The review step shows Cleffy LLC with address and email, the price with tax treatment, the interval, auto-renewal, no minimum term, how to cancel, the 14-day full refund, the EU/UK withdrawal right, and links to Terms and Refund Policy. Stripe's Pay button also shows the renewal line via `custom_text.submit`. | `CheckoutReview.tsx`, `checkoutFlow.ts` |
| 16 | Stripe Tax in Checkout | ✅ in code: `automatic_tax`, required billing address, `customer_update`, `currency`. ⏳ Tax codes and `tax_behavior` are hosted config, done by `scripts/stripe/configure-tax.mjs` (dry run and test mode by default) and listed as Max steps. | `checkoutFlow.ts`, `scripts/stripe/configure-tax.mjs` |
| 17 | Per-currency prices | ✅ USD 7/19/49, EUR 8/21/55, GBP 7/18/45. EU/EEA → EUR, UK → GBP, everyone else → USD. The country is guessed from the browser language, can be changed in the dialog, and is remembered per device. EUR/GBP are labelled "VAT incl.", USD "+ tax". The landing page "plans from …" follows the visitor's currency. The checkout lock keys on price + currency. | `billingTerms.ts`, `billingRegion.ts`, `CountryPicker.tsx`, `pricing.ts`, `PricingDialog.tsx`, `LandingPage.tsx` |
| 18 | Purchase confirmation email | ✅ Sent through Resend on `checkout.session.completed`. It gives the plan, the total incl. tax and the tax amount, the interval, the next renewal, the renewal terms, the cancel link, the trader identity, the policy versions, the 14-day refund, and the EU/UK withdrawal info with the full model withdrawal form. It goes out once per session (`billing_notices`), and a send failure never fails the Stripe event. | `_shared/stripeEvents.ts`, `stripe-webhook/index.ts`, `_shared/billingMail.ts`, `billingTerms.ts` |
| 19 | Cancellation without sign-in | ✅ `/cancel` takes an email and sends a one-time link (1 hour; only its SHA-256 is stored). The link page has "Cancel now" (`cancel_at_period_end`, same as the portal) and an optional 14-day refund request, emailed to support@ with Reply-To set to the buyer, offered only inside the window. Every address gets the same answer. Limits are per IP, per recipient and from a mail-budget share. A cancellation confirmation with date and time is sent from the webhook whenever a cancellation is scheduled, so the portal and `/cancel` both get it. "Cancel subscription" is linked in the landing, login and account footers. | `_shared/cancelFlow.ts`, `billing-cancel/index.ts`, `CancelPage.tsx`, `cancelApi.ts`, `CancelSubscriptionLink.tsx`, `config.toml` |

Session B's `LEGAL_VERSIONS` was not on `dev` yet, so a **temporary** `LEGAL_VERSIONS` (`2026-10-20-draft`) and trader block are defined in `supabase/functions/_shared/billingTerms.ts`, as the packet allows.

## Follow-up fixes by another session

After this PR went up, session `01AMyu7iBpgK8Ssqmjf8totG` pushed five fixes to `mh/launch-checkout` for findings from a Codex review. I read all five commits. The first four fix real bugs in my first commit; the fifth re-sizes the mail budget so #63's legal mail fits:

- **`6b3921a`, checkout recovery.** When an attempt died mid-create, the next request replayed its idempotency key but recorded a **fresh** consent. The new `consent_id` changed the session metadata, and Stripe refuses a reused key sent with different parameters, so the recovery would always have failed. The attempt now stages the consent id and a SHA-256 of the session parameters beside the key, and replays only when the rebuilt parameters match. This adds migration `20261020160100_checkout_attempt_replay_inputs.sql` (a hosted step) and `tests/sql/launch_checkout_fixes.sql`.
- **`9dd216b`, cancel link.** "Cancel now" trusted our `subscriptions` mirror. A buyer who resumed in the portal before the webhook landed still showed as cancelling there, so the flow skipped Stripe, spent the link and promised a cancellation Stripe wasn't going to make. The link now reads the subscription from Stripe and reports success only when Stripe's answer confirms it.
- **`6897aa9`, durable billing mail.** A Resend failure or a failed consent completion was logged and the event still acknowledged, so the confirmation, or the consent's subscription and billing country, was lost for good. A crash after claiming a `billing_notices` row also left a claim nobody released. Mail now goes through `billing_mail_outbox` (migration `20261020160200`, which drops `billing_notices`). A failed write fails the event so Stripe redelivers, and queued mail is retried with backoff by a pg_cron tick calling the new `billing-mail-outbox` function. The confirmation now also names the Terms and Refund versions stored with the buyer's consent.
- **`493116f`, signed-out cancel without an oracle.** `/cancel`'s email step answered `200` for unknown addresses but `503` for a subscriber whenever the mail budget was spent or Resend failed, and the subscriber's lookup and send took time nobody else's did. Now every well-formed address gets the same insert into the outbox and the same `200`; the lookup, limits and send run later in the outbox worker.
- **`dcde0fa`, mail budget.** Guest-email codes drop from 50/250 to 35/190 per hour/day, so the cancel link (10/50) plus #63's report acknowledgment (10/40) and moderation notice (5/20) fit in the old 60/300 discretionary share. The auth reserve is unchanged.

## Local check results (this container, on `d740fcd`)

| Check | Result |
|---|---|
| `npm run lint:check` | ✅ pass |
| `npm run typecheck` | ✅ pass |
| `npm run test` | ✅ 196 files, 2804 tests pass. Two pre-existing tests (`syncEngine` backoff, `turnstileField`) fail **only while `cloud:up`'s `.env.local` is present**, on the untouched base `282b30a` too; with that file moved aside everything passes. CI has no `.env.local`. |
| `npm run build` | ✅ pass |
| prettier | ✅ all changed files formatted |
| SQL proof `tests/sql/checkout_consents.sql` on local Postgres | ✅ 27/27 |

## CI status

✅ **Green on head `dcde0fa`** (workflow runs 39550239366 and 39550241401), and on every earlier commit: `d740fcd`, `6b3921a`, `9dd216b`, `6897aa9`, `493116f`:

| Check | Result |
|---|---|
| `checks` (npm ci, audit, lint, typecheck, test, build) | ✅ success |
| `supabase-drift` | ✅ success |
| `omr-service` | ✅ success |
| Vercel Preview | ✅ deployed (`cleffy-git-mh-launch-checkout-…vercel.app`) |
| Supabase Preview | skipped (integration not enabled for this PR) |

Merge state: `clean`, no conflicts with `dev` at `282b30a`. No review comments; the only PR comment is Vercel's deploy notice.

## ui-check result

`scripts/ui/uifuzz.mjs` across all 9 viewports (desktop-1440, laptop-1280, iPad landscape/portrait/mini, iPhone 14, iPhone SE, Android small, iPhone landscape). I ran it against a second Vite on :5199 with the published **sandbox** price ids, so the pricing dialog renders. I opened and looked at the screenshots.

- Checked: plans in US and DE, the review step before and after ticking, `/cancel` signed out, the landing footer. "Continue to payment" was disabled before ticking and enabled after on all 9 viewports. No console errors.
- **Two real issues found and fixed before pushing:**
  1. The review step opened scrolled to the middle, hiding the price line, because React reused the card list's `Dialog` and its scroll position. Fixed by keying the two dialogs apart.
  2. "Refund Policy" wrapped across two lines on desktop. Fixed with `whitespace-nowrap` on the policy links.
- The rest of the audit output is the page behind the modal being "obscured" by the modal, which is expected. There are also small-tap-target flags on inline text links that use the existing `linkClassName` (its hit area is widened on coarse pointers). Not bugs.
- Not screenshotted: the emailed-link page (`/cancel?token=…`), because the local edge runtime can't boot functions here (see below). It's covered by `CancelPage.test.tsx` and `tests/billing/cancelFlow.test.ts`.

## Hosted steps for Max (also in the PR description)

Do 1–3 **before** deploying `stripe-checkout`: Stripe refuses a session with `automatic_tax` and `currency` until they're done.

1. Stripe Tax on (sandbox, then live): origin address, registrations (EU OSS / UK VAT / US nexus as applicable).
2. Run `scripts/stripe/configure-tax.mjs` (dry run, then `--apply`; sandbox first, then `--live --apply`). It sets product tax codes, USD `tax_behavior: exclusive`, and EUR/GBP `currency_options` with `tax_behavior: inclusive`. Any price it reports as a PROBLEM needs a new price id.
3. Customer Portal → Cancellations → "Cancel at end of billing period".
4. Apply the three migrations in order (dev, then prod): `20261020160000_checkout_consents_and_self_service_cancel.sql`, `20261020160100_checkout_attempt_replay_inputs.sql`, then `20261020160200_billing_mail_outbox.sql`. After merging the four PRs, regenerate `scripts/apply-migrations.sql` (`npm run migrations:mirror`); it will conflict between sessions.
5. Deploy `stripe-checkout` and `stripe-webhook`, plus `billing-cancel` and `billing-mail-outbox`, both with `--no-verify-jwt`.
   - Outbox retries: set the Edge secret `BILLING_OUTBOX_SECRET`, and store the `billing-mail-outbox` URL and the same secret in Vault as `billing_outbox_url` and `billing_outbox_secret` (SQL in SETUP_SUPABASE.md). Without them a failed send is never retried.
6. Optional secrets: `BILLING_EMAIL_FROM`, `BILLING_CANCEL_SECRET`, `APP_URL` (dev).
7. Confirm both webhook endpoints send `checkout.session.completed` and `customer.subscription.updated`.
8. Test-mode smoke test on dev.cleffy.io: German address, Teacher monthly. Check the €21 total incl. VAT, the confirmation email and the consent row; then cancel via `/cancel` and check the cancellation email.

## Open questions

1. **Annual EUR/GBP and Founding outside USD** aren't in the packet. Proposed: EUR 80/210/550 and GBP 70/180/450 ("two months free", like USD), Founding €109 / £95.
2. **Stripe product tax codes** (proposed): Personal `txcd_10103000` (SaaS, personal use); Teacher and Academy `txcd_10103001` (SaaS, business use).
3. The Teacher card's "under $1 per student" isn't true in EUR (€21/20 = €1.05), so it now reads "one price, however many students you teach". OK?
4. `/cancel` has no Turnstile, because no build has a site key yet. It is guarded by rate limits, and it only mails addresses that already have a running subscription.
5. The withdrawal-right summary and model form text are placeholders pending counsel (Annex A belongs to Session B's Refund Policy).
6. Consent rows have no purge after 3 years; nothing deletes them today. Decide a retention ceiling (e.g. 7 years) later.

## Skipped or not verified, and why

- **No end-to-end Stripe or Resend run.** The sandbox has no Stripe test key or Resend key, and live Stripe and hosted Supabase are off-limits. Hosted step 8 covers it.
- **Local edge functions don't boot in this container.** The edge runtime can't fetch `npm:` modules through the sandbox TLS proxy (`invalid peer certificate: UnknownIssuer`). That affects every function, not just the new ones. Pointing `DENO_CERT` at the sandbox CA from the functions env file didn't help, and that attempt was reverted. So `billing-cancel`, `stripe-checkout` and `stripe-webhook` are covered by their unit tests (which drive the same shared modules the Deno files wire up), not by live calls.
- **`/refunds` link:** points at Session B's route, so it 404s until B merges.
- **Footer:** "Cancel subscription" is a separate `CancelSubscriptionLink` next to `LegalLinks`, to stay out of Session B's files. Fold it into `LegalLinks` after both merge.
- **Shared files touched outside `src/features/billing`:** `LandingPage.tsx`, `LoginPage.tsx`, `AccountPage.tsx` (one footer line each, plus the landing price), `routes.tsx` (the `/cancel` route), `config.toml`, `mailBudget.ts` (guest-email now 35/190 after fix `dcde0fa`, leaving room for the cancel link's 10/50 and #63's legal mail) and its test, and the generated `scripts/apply-migrations.sql`. Expect easy merges, except the mirror (regenerate it).
