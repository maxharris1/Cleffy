# Legal review before launch

The Privacy Policy (`/privacy`) and Terms of Service (`/terms`) were drafted by
engineering from what the code actually does. They have **not** been reviewed by a
lawyer. Everything below is an assumption, placeholder or open question that a
lawyer (and the owner) must confirm or change before Cleffy takes payments.

All the text lives in one module: `src/features/legal/legalContent.ts`. Business
details are in `LEGAL_ENTITY` at the top; the last-updated date is
`LEGAL_LAST_UPDATED`. Comments next to each privacy-policy statement name the code
it describes, so a change in data practice has an obvious place to be reflected.
Sections for features switched off in this build (`src/lib/features.ts`:
play-along, fingering) are omitted from the policy automatically; turning a flag on
adds its section, and that new text needs review too.

Section numbers here are referenced from code comments (`LEGAL_REVIEW.md §n`).

---

## 1. Who the operator is

- **Assumed:** the operator is called "Cleffy". No legal entity name, company
  number, registered address or country appears anywhere in the repository (the
  live Stripe account is named "Cleffy", `acct_1U35FW4eZ6RX0W0g`).
- **Needed:** the registered legal entity name and address. Most privacy laws
  (GDPR Art. 13, UK GDPR, CCPA) require the controller's identity and contact
  details; consumer law in many places requires a geographic address in the
  terms. Set `LEGAL_ENTITY.name` and add the address to both documents.
- If the operator is an individual rather than a company, the documents and the
  liability position need rethinking.

## 2. Governing law, venue and disputes

- **Placeholder:** Terms §"Governing law" says "the laws of the place where
  Cleffy is established". Replace with the actual jurisdiction, courts and any
  dispute-resolution clause (arbitration, class-action waiver — enforceability
  varies, and is largely unavailable against EU/UK consumers).

## 3. Where data is hosted

- **Not in the repo:** the Supabase project region (production
  `jibgwgosihadbjgxdsfe`). Confirm it in the Supabase dashboard (Project Settings
  → General) and set `LEGAL_ENTITY.dataRegion`; the policy then names it.
- Known from DEPLOY.md: inbound support mail is received by Resend in AWS
  `us-east-1`; the web app is served by Vercel's global edge.
- If error monitoring is enabled, choose the Sentry data region (US or EU)
  deliberately and record it.

## 4. Sub-processors, DPAs and international transfers

The policy names these processors, because the code sends them personal data:

| Processor                                                   | What it receives                                                                  | Confirm                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------ |
| Supabase, Inc.                                              | everything stored: accounts, PDFs, markings, roster, billing status, support mail | DPA signed; region (§3)              |
| Vercel, Inc.                                                | web requests (IP, user agent) for the static app                                  | DPA                                  |
| Stripe, Inc. (and Stripe Payments Europe for EEA customers) | checkout and payment data                                                         | correct contracting entity; DPA      |
| Resend (believed to be Plus Five Five, Inc.)                | outgoing auth/invite email; inbound support email                                 | **legal name**; DPA                  |
| Anthropic, PBC                                              | page images + detected marks for Smart import (owner-initiated)                   | see §11                              |
| Functional Software, Inc. (Sentry)                          | scrubbed error reports, only when `VITE_SENTRY_DSN` / `SENTRY_DSN` are set        | DPA; region; see §17                 |
| Google LLC (Cloud Run)                                      | score PDFs for play-along OMR — **only if `VITE_FEATURE_PLAYALONG` is turned on** | DPA if enabled                       |
| The mailbox behind `SUPPORT_FORWARD_TO`                     | full support emails are forwarded there by `resend-inbound`                       | **unknown provider — must be named** |

- The policy's "International transfers" section is generic. Confirm the
  transfer mechanism (EU SCCs / UK IDTA / EU-US Data Privacy Framework) per
  processor.
- The Gemini helper (`supabase/functions/_shared/gemini.ts`) is not imported by
  any deployed function today, so Google's Gemini API is not listed. If it is ever
  wired in, the policy must be updated.

## 5. Legal basis (GDPR)

The policy does not state legal bases per purpose. If Cleffy targets EEA/UK
users, add them (contract for the service; legitimate interests for security,
abuse prevention and error monitoring; legal obligation for billing records).

## 6. Refunds and withdrawal rights

- **Placeholder:** Terms say payments are non-refundable "except where the law
  gives you a right to one", with an error-charge contact. The owner must decide
  the actual refund policy (the billing workstream is adding refund handling).
- **EU/UK consumers** have a 14-day right of withdrawal for digital services
  unless they expressly consent to immediate performance and acknowledge losing
  the right. The Stripe Checkout flow does not currently capture that consent.
  Decide whether to sell to EU/UK consumers and, if so, add the consent step or a
  pro-rata refund policy.

## 7. Cancellation behaviour

- Terms say a cancelled plan "stays active until the end of the period you have
  paid for". That depends on the **Stripe Customer Portal configuration**
  (cancel at period end vs immediately), not on code. Verify both portal configs
  (live `bpc_1U9juu4eZ6RX0W0gPrUkrH6S` and sandbox).
- Account deletion cancels immediately (by design — the account stops existing).
  The deletion dialog says so; confirm no pro-rata refund is owed.
- Downgrade: scores over the new plan's limit become read-only (archived), never
  deleted (`apply_free_tier_archival`), and come back only when the user is on a
  paid plan again (`restore_plan_archived_scores`, run by the Stripe webhook, or
  an Academy owner seating them). **Changed
  2026-10-08:** an earlier draft of the Terms said "until you upgrade again or
  remove others", but the app has no way to make an archived score editable
  short of upgrading — deleting other scores frees room for new uploads, not
  for the archived ones. The Terms now say "until you upgrade again" (and the
  in-app cap notice now says "delete one to make room" instead of suggesting an
  archive action that does not exist). If the business wants "remove others"
  to work, that is a product change (an owner "make editable" action; the
  database already refuses one past the cap), not a wording one. Confirm the
  wording.

## 8. Auto-renewal disclosures

The pricing dialog now says plans renew automatically until cancelled and links
the Terms. Check against automatic-renewal laws in target markets (e.g.
California ARL, FTC negative-option rule, EU/UK): clear pre-purchase disclosure,
affirmative consent, an online cancellation path (exists: Stripe portal), and
renewal reminders for annual plans (Stripe can send these — enable if required).

## 9. Minimum age for self-registration

- **Assumed:** the Terms require users to be "old enough to agree to these terms
  where they live"; there is **no age gate** in sign-up. Decide the threshold
  (13 under COPPA; 13–16 under GDPR Art. 8 depending on country) and whether the
  sign-up form needs an age confirmation.

## 10. Student (minor) accounts provisioned by teachers

- Teachers create student accounts (`student-provision`): a display name, a
  username/password chosen by the student, or the student's email for an
  invitation, and optionally a **parent's email**. Students are likely children.
- The Terms make the teacher responsible for having authority/consent. Counsel
  must confirm this is sufficient: COPPA (school-authorisation exception — use
  only for the educational purpose, direct notice to schools, parental rights to
  review/delete), FERPA if US schools use it, UK Age Appropriate Design Code,
  GDPR for children.
- Students **cannot delete their own account** (`delete-account` refuses with
  `managed_student`; the UI says to ask the teacher or support). A parent or
  student may ask support directly — define the internal procedure and response
  time for those requests (manual deletion uses the same function logic under
  the teacher, or the admin API).
- When a teacher deletes their account, their provisioned students are deleted
  too (only accounts still flagged `user_type = student` with this
  `teacher_id`). Confirm that is acceptable versus, e.g., notifying parents.

## 11. AI processing (Anthropic)

- Smart import (`analyze-annotations`) sends a page image plus detected mark
  positions to the Claude API; it is owner-initiated and metered.
- The policy states Anthropic "does not use our requests to train its models"
  under its commercial terms. **Confirm** against the current Anthropic
  commercial terms/DPA, and confirm Anthropic's retention period for API inputs;
  consider whether to state it.
- Scores may contain a student's handwriting; consider whether that changes the
  analysis for minors.

## 12. Retention periods

The policy uses general language ("as long as your account exists", "a limited
period"). Facts from the code, to decide whether to commit to numbers:

- **Support emails** (`support_messages`) are kept indefinitely; nothing deletes
  them. Decide a retention period (and whether account deletion should delete
  messages from that address — it does not today).
- **Rate-limit counters** (`edge_rate_buckets`) are keyed by IP address or
  account id and are never pruned. Recommend a scheduled purge.
- **Erased markings** are tombstoned and kept until the score is deleted
  (`compact_annotation_tombstones` exists but is not scheduled). The policy says
  so.
- **Anonymous guest accounts** created via share links are never cleaned up.
- **Backups and logs:** Supabase backup/PITR retention for the plan in use;
  Vercel and Supabase log retention; Sentry event retention. Confirm and
  optionally state.

## 13. Stripe data after account deletion

`delete-account` cancels every subscription and expires open Checkout sessions,
but **does not delete the Stripe Customer** (it keeps email, name, payment
method and invoice history). This was chosen conservatively so refunds,
disputes and tax records keep working. Decide whether deletion should also
delete the Customer or detach payment methods, and confirm the policy's
statement that "Stripe keeps payment and invoice records as the law requires".

## 14. What survives account deletion

- Markings a deleted user drew on **other people's** scores stay on those scores
  with the author cleared (`20261007120600_account_deletion.sql`). The policy and
  deletion dialog say so. Version-history snapshots on others' scores may still
  contain the deleted account's opaque id inside their stored payload.
- Share links a deleted owner created go with their scores.
- Confirm this is acceptable under erasure rights (the content is arguably the
  score owner's, and the id is unlinkable once the account is gone).

## 15. Cookies and device storage

Cleffy stores only what it needs to work: the Supabase session in localStorage,
one first-party cookie (`cleffy-auth-restore`, up to 60 days, refresh token
only) for iOS home-screen sign-in, IndexedDB for offline scores and markings,
preference keys, and the service-worker app cache. No analytics or advertising
cookies, fonts are self-hosted. **Assumed:** this is all "strictly necessary"
and needs no consent banner under ePrivacy/PECR. Confirm, including for Sentry
when enabled (the browser SDK sets no cookies).

**Sign-out — changed 2026-10-08.** An earlier draft of the Privacy Policy said
markings and changes not yet synced are kept on the device at sign-out. That
was the behaviour before the sync fixes and is no longer true: sign-out now
uploads pending changes first, warns the user about any it could not upload
("Signing out now deletes them from this device for good"), and then removes
the account's markings, unsynced changes, sync watermarks and lesson-history
copies from the device, so the next person on a shared device can neither see
nor upload them. Markings on files opened from the device without uploading
them, and display preferences, stay. The policy's "What Cleffy stores on your
device" section now says this; confirm the wording.

## 16. Security and breach notification

The policy promises to notify users of a breach "as the law requires". Confirm
there is an incident-response process and who decides.

## 17. Error monitoring (Sentry), when enabled

- Off unless `VITE_SENTRY_DSN` (web) / `SENTRY_DSN` (Edge Functions) are set.
- Client-side scrubbing drops emails, tokens, URL query strings/fragments, share
  tokens, console breadcrumbs and annotation content; the user is reduced to the
  opaque account id; `sendDefaultPii: false`; no tracing or session replay.
- In the Sentry project settings, also enable **"Prevent Storing of IP
  Addresses"** and server-side data scrubbing, since Sentry can otherwise record
  the reporting client's IP from the connection.

## 18. Copyright, IMSLP and takedowns

- The Terms put responsibility for copyright status on the user and give a
  contact for infringement notices. For US safe harbour (DMCA §512), register a
  designated agent with the US Copyright Office and publish a formal
  notice-and-counter-notice procedure.
- IMSLP: Cleffy fetches IMSLP files server-side and caches public-domain PDFs in
  a shared bucket (`pd-pdfs`). Confirm IMSLP's terms permit this commercial use
  and caching, and the attribution/licence display (scope-imslp workstream).

## 19. Liability, warranties and consumer law

The disclaimers and the 12-months-of-fees liability cap are generic and include a
carve-out for non-excludable liability and consumer statutory rights. Confirm
they are enforceable and appropriately drafted for the target markets.

## 20. Data-subject requests and changes

- Self-serve: display name, password, account deletion (Account page). Everything
  else (access/export, email change, correction, objection) is by email to
  `support@cleffy.io`. Define the procedure and response times (GDPR: one month;
  CCPA: 45 days) and identity verification.
- The documents promise to notify users of significant changes "by email or in
  the app". There is no bulk-email or in-app notice mechanism today; one is needed
  before the first material change.

## 21. Tax

The Terms say price "and any tax" are shown before payment. Confirm Stripe Tax
(or equivalent) is configured for the markets sold into.

## 22. Before publishing

- [ ] Fill §1 entity/address and §2 governing law in `legalContent.ts`.
- [ ] Set `LEGAL_ENTITY.dataRegion` (§3).
- [ ] Name the support-mailbox provider (§4) and sign the DPAs.
- [ ] Decide refunds/withdrawal (§6), cancellation config (§7), age gate (§9).
- [ ] Update `LEGAL_LAST_UPDATED` to the publication date.
