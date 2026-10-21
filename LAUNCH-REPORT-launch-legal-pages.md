# Launch report — Session B (`mh/launch-legal-pages`, items 11–12)

- **PR:** https://github.com/maxharris1/Cleffy/pull/63 (draft, into `dev`; no reviewers requested)
- **Head SHA:** `9ad52d064d1f5de201e9ccf8d3aaf682410dec30`, six commits on top of `dev` at `282b30a`:
    - `d42bc42`: this session's work, authored as Max Harris.
    - Five cross-PR fix commits from another Claude session (session_018QhasZZCrN97pePnmeW8cY), kept as they are:
        - `f1feb4a`: writes down how the shared mail budget is split with #62 (see Item 12).
        - `70d161e`: no policy text may let presence fall back to an email address.
        - `06e4434`: the Privacy Policy's district-deletion wording, as decisions item 1 sets it.
        - `193f946`: a takedown also cuts off realtime for collaborators who are already connected. This adds a migration change, `tests/moderation/takedownRealtime.test.ts`, and more checks in `tests/sql/content_moderation.sql`.
        - `9ad52d0`: the moderation page loads reports, takedowns and the notice log a page at a time, instead of stopping at 200.
- **CI on the head (`9ad52d0`, and on every earlier head):** green — `checks` (audit, lint, typecheck, test, build) ✅, `omr-service` ✅, `supabase-drift` ✅, Vercel preview ✅ (Supabase Preview skipped, as on other PRs). Mergeable state: clean.
    - On `9ad52d0`, GitHub ran the workflow twice. One run passed every job. The other passed `checks`, but its `omr-service` and `supabase-drift` jobs were still showing as in progress well past their usual ~20 s runtime. That looks like stuck reporting, not a failure.

## Item 11 — legal pages

- **Four versioned documents, each with its own route.** `src/features/legal/` now has one module per policy:
    - `privacyPolicy.ts` → `/privacy`
    - `termsOfService.ts` (with the **School Use Addendum**) → `/terms`
    - `refundPolicy.ts` (14-day full refund, EU/UK withdrawal information, **Annex A model withdrawal form**) → `/refunds`
    - `copyrightPolicy.ts` (DMCA notice and counter-notice, DSA notice-and-action, statement of reasons, complaints, repeat infringers, points of contact) → `/copyright`

    Types and helpers live in `legalDocument.ts`; `legalContent.ts` is now just a barrel.

- **`legalEntity.ts`:** Cleffy LLC, a New York LLC; 245 East 37th Street, Apt 3E, New York, NY 10016, USA; legal@ / privacy@ / support@cleffy.io; `dataRegion: 'United States (AWS us-west-2, Oregon)'`.
- **`LEGAL_VERSIONS`:** exported from `src/features/legal/legalVersions.ts`, an import-free file that Session C can import. Every value is currently `2026-10-20-draft`. A server mirror at `supabase/functions/_shared/legalVersions.ts` holds the versions plus the operator details; a sync test keeps the two equal.
- **Placeholders:** every page shows a draft banner, and unsettled wording appears as marked "Placeholder — awaiting legal review" callouts. Existing text was kept where it still applies.
- **Max's decisions, now in the text:**
    - ages 13+, or up to 16 where a country requires;
    - retention: archived students 12 months, guests 90 days, support mail 24 months, district data 30 days after contract end;
    - presence never shows email addresses;
    - a full refund within 14 days of first purchase, with no waiver;
    - EUR/GBP prices include VAT; USD prices do not;
    - schools buy by order form and invoice.
- **Anthropic:** not mentioned anywhere while `VITE_FEATURE_SMART_IMPORT` is off (`aiFeatures.ts`). `LegalPage.test.tsx` was rewritten and asserts this.
- **Links:**
    - The footer (`LegalLinks`) links to all four policies plus "Report content".
    - The account menu links to all four policies.
    - `docs/LEGAL_REVIEW.md` has an updated header.

## Item 12 — DSA/DMCA tooling

- **Report form at `/report`:** public and works signed out. It covers copyright (DMCA §512(c)(3) fields) and illegal content (DSA Art. 16) and is gated by Turnstile.
- **`content-report` function** (`verify_jwt = false`):
    - rate-limited per IP and per reporter;
    - resolves the score from the link;
    - stores the report in the new `content_reports` table;
    - emails an acknowledgment with a reference, BCC'd to legal@.
- **`content-moderation` function** (moderators only, through the `content_moderators` table):
    - **restrict** a score (only the owner can open it) or **remove** it (nobody can), with nothing deleted;
    - **lift** a takedown, which also voids the strike;
    - **reject** a report.
    - Each action emails the uploader a DSA Art. 17 statement of reasons and/or the reporter the outcome.
- **Strike counter:** `content_strikes` counts copyright takedowns; 3 within 12 months flags a repeat infringer.
- **Notice log:** `content_notice_log` records every event and email, with its delivery outcome.
- **Admin page:** `/admin/reports`.
- **Enforcement:** done in `document_role()` and `library_documents()`, plus triggers that refuse new members and share links on a taken-down score.
- **Migration:** `20261020150000_content_moderation.sql`; the mirror was regenerated.
- **Mail budget:** two new senders, `contentReportAck` (10/40 per hour/day) and `moderationNotice` (5/20). After `f1feb4a`:
    - guest codes are held to 35/190 (`GUEST_AND_AUTOMATED_MAIL_CAP`);
    - 10/50 is kept for #62's `billingCancelLink`;
    - the auth reserve is untouched.

## Local results

| Check                                                                                                                            | Result                                                         |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `npm run lint:check`                                                                                                             | ✅                                                             |
| `npm run typecheck`                                                                                                              | ✅                                                             |
| `npm run test`                                                                                                                   | ✅ 196 files / 2806 tests (see note)                           |
| `npm run build`                                                                                                                  | ✅ the policy text stays in the lazy `LegalPage` chunk         |
| `npx prettier --check` (changed files)                                                                                           | ✅                                                             |
| `tests/sql/content_moderation.sql` (local Postgres)                                                                              | ✅ 35/35                                                       |
| Existing SQL proofs (student_access_revocation, share_link_errors, qa3_cross_branch, cross_branch_integration, column_integrity) | ✅ all pass with the new `document_role` / `library_documents` |
| `deno check` on both new functions (Deno 2.1.4)                                                                                  | ✅                                                             |
| Both functions end to end against local Supabase (host Deno)                                                                     | ✅ (see below)                                                 |

**Note on the test run:** `cloud:up` writes a `.env.local` pointing at local Supabase. With that file present, two existing tests fail on untouched `dev` too (`tests/auth/turnstileField.test.tsx`, `src/sync/syncEngine.test.ts` backoff). The full run above was done with that file moved aside, which is how CI runs.

**Note on the Edge Functions:** `supabase functions serve` cannot boot any function in this sandbox, old or new. The edge-runtime container rejects the proxy's TLS certificate when it fetches `npm:` modules. I therefore ran the two new functions under host Deno 2.1.4 (the runtime's own version) against local Supabase, and checked:

- the report is stored;
- the acknowledgment shows as `unconfigured` (no Resend key locally, by design);
- a non-moderator and a request with no token are both refused;
- a takedown adds a strike, a duplicate takedown is refused, and a lift voids the strike;
- the statement of reasons is addressed to the uploader's GoTrue email;
- every step lands in the notice log.

All local test data was removed afterwards. The teacher's 3 seeded scores and the seeded accounts were untouched.

## ui-check

I used the `ui-check` skill (`scripts/ui/uifuzz.mjs`) on all 9 viewports and looked at every screenshot. Pages covered:

- `/privacy`, `/refunds#model-withdrawal-form`, `/copyright`;
- `/report`, filled in and submitted on desktop, iPhone SE and iPad portrait, with the success state;
- the landing-page footer;
- `/admin/reports` as a moderator, including the takedown form.

Results:

- No horizontal overflow and no console errors.
- The `small-tap-target` hits are inline links that already get the `pointer-coarse` `::after` touch area, plus the pre-existing contents list.
- One real finding was fixed before the commit: on phones, "Take down…" scrolled the form under the sticky header. The section now has a larger `scroll-mt`. I also made legal@ on the report success page a mailto link.
- The screenshots are embedded in the PR description and hosted on the scratch branch `claude/launch-legal-pages-hgfe9r` (not for merge).

## Hosted steps for Max (nothing hosted was touched)

1. Apply `20261020150000_content_moderation.sql` to dev, then prod (merge, then the integration deploys).
2. Deploy the functions:
    - `supabase functions deploy content-report --no-verify-jwt`
    - `supabase functions deploy content-moderation`
3. Add yourself as a moderator on each project: `insert into public.content_moderators (user_id, note) values ('<your auth user id>', 'Max');`
4. Optional secrets: `CONTENT_NOTICE_FROM` (default `Cleffy <noreply@cleffy.io>`) and `CONTENT_REPORT_SECRET` (falls back to the service-role key). `RESEND_API_KEY` is already set.
5. Make sure the Resend inbound route receives legal@ and privacy@cleffy.io.
6. Register a DMCA designated agent with the US Copyright Office, and send the number for `/copyright`.
7. Confirm the Resend quota (`DEFAULT_MAIL_BUDGET`). If it is larger, raise the budget; guest codes can then get more than 35/190 back.
8. When counsel's text arrives: replace the placeholders, drop `-draft` from `LEGAL_VERSIONS`, and set `LEGAL_DOCUMENTS_ARE_DRAFTS = false`.

## Open questions

- **Depends on Session A.** The policy text describes Session A's behaviour: the age screen, teacher attestation and student country, delete-student scrubbing, retention cron jobs, and presence names. It is accurate only once both PRs are merged.
- **Smart-import flag.** `aiFeatures.ts` reads `VITE_FEATURE_SMART_IMPORT` directly, so this PR doesn't touch `src/lib/features.ts`, which Session A owns. Switch to `features.smartImport` after both merge.
- **Admin role.** Moderators live in their own `content_moderators` table. Session D's admin-only seat override may want a shared admin notion.
- **Repeat infringers.** 3 strikes in 12 months is flagged but not enforced automatically; closing the account is manual.
- **Retention of reports and notice logs** is left as a placeholder for counsel.
- **Not built:** submissions to the DSA Transparency Database and transparency reports. Counsel should confirm whether they apply.
- **Deleting removed scores.** A removed score disappears from its owner's library and its owner cannot delete it (it is preserved), but account deletion still deletes it. Please confirm this is acceptable.
- **Likely merge conflicts with the other sessions:**
    - `scripts/apply-migrations.sql`: regenerate with `npm run migrations:mirror`;
    - possibly `src/types/database.ts`;
    - `LegalLinks.tsx`, since Session C adds a footer "Cancel subscription" link.

## Skipped, and why

- **Hosted Supabase and Stripe:** not touched (hard rule 3). Everything needing a hosted setting is listed above.
- **Automatic account closure for repeat infringers:** not built. The packet asked for a strike counter; closing an account is a decision for a person, and counsel has to set the threshold first.
- **The packet's shared `/workspace/cleffy-launch-compliance-report.md`:** not written. This session's instructions call for this per-PR report file on a separate branch instead.
- **Real email delivery:** not tested end to end. No Resend key is used locally (hard rule 4), so sends show as `unconfigured`. The message content is covered by unit tests.
