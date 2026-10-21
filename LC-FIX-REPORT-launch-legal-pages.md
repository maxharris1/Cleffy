# Launch compliance fix pass: Session B, PR #63 (mh/launch-legal-pages)

- **PR:** https://github.com/maxharris1/Cleffy/pull/63 (still a draft into `dev`)
- **Head before:** `d42bc42` · **New head:** `6509726` (`650972657cc810013b9f7cbe50df2d1e94b268c6`)
- **Pushes:** fast-forward only, to `mh/launch-legal-pages` only. No force push, no new PR, nothing merged.
- **Environment:** Claude cloud environment **Cleffy** (`env_01WAd3yiz3qpSnsofpyEwCh2`), not Sandbox.
    - All database work ran on the local stack (`npm run cloud:up`).
    - Nothing touched hosted Supabase (prod or dev) or Stripe.
    - No secrets were committed or printed.

## Findings → commits → tests

| #   | Finding                                                                  | Commit    | Tests                                                                                                                                                          |
| --- | ------------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B6  | Mail budget: B+C inside 60/h, 300/day; guest ≈35/190                     | `f1feb4a` | `tests/security/mailBudget.test.ts`: guest held to `GUEST_AND_AUTOMATED_MAIL_CAP` (35/190); #63's caps plus #62's `BILLING_CANCEL_SHARE` (10/50) fit in 60/300 |
| B4  | Presence never falls back to email (legal copy)                          | `70d161e` | `LegalPage.test.tsx`: every legal document is scanned so that no presence sentence offers an email fallback                                                    |
| B5  | Privacy Policy district deletion matches decisions item 1                | `06e4434` | `LegalPage.test.tsx`: wording pinned for the Privacy Policy and the School Use Addendum                                                                        |
| B1  | Takedown cuts off realtime for connected collaborators                   | `193f946` | `tests/sql/content_moderation.sql` checks 03-04, 46, 70-80; `tests/moderation/takedownRealtime.test.ts` (CI guard)                                             |
| B3  | Keyset pagination for admin queue and takedown list (no 200 cap)         | `9ad52d0` | `tests/sql/content_moderation.sql` checks 90-99; `src/features/moderation/ModerationPage.test.tsx`                                                             |
| B2  | Durable outbox with retry for acks, moderation notices and the legal BCC | `6509726` | `tests/moderation/contentReports.test.ts` (outbox, budget, retry); `tests/sql/content_moderation.sql` checks A1-A7, B1-B12                                     |

Both #63 Codex minors were also fixed:

- **Minor 1** (`documents_select` owner bypass on a removed score) is in `193f946`. B1 needs it: the re-check must find a removed score gone for its owner too.
- **Minor 2** (moderators can't see the full notice) is in `9ad52d0`.

### What each fix does

**B6 (mail budget).**

- Guest codes are now 35/190 (they were 45/240).
- Content-report acks stay at 10/40 and moderation notices at 5/20.
- That leaves 10/50 for #62's `billingCancelLink`.
- The split table lives in `_shared/mailBudget.ts`, with the constants `GUEST_AND_AUTOMATED_MAIL_CAP` and `BILLING_CANCEL_SHARE`.
- I coordinated with Session C by message. #62 (`dcde0fa`) uses the same numbers: guest 35/190 and billingCancelLink 10/50. Merged, the total is exactly 60/300.

**B4 (presence copy).**

- #63's privacy text already said "email addresses are never shown" (Collaborator/Guest fallback). #64's note was about dev's old sentence.
- The commit adds a test across all four documents so the email fallback can't come back.
- The _behaviour_ (`safePresenceName`/`presenceNameOf`) ships in #64, which merges after #63. Merges come before the hosted rollout, so the deployed copy and the code agree.

**B5 (district deletion wording).** The Privacy Policy and the School Use Addendum now say:

- data is deleted 30 days after contract end, which is the contract's end date or the day the subscription ends or is cancelled;
- the owner gets an export notice at least 14 days before;
- deletion is soft first, then hard;
- a contract with no end date is never auto-purged.

**B1 (realtime cut-off).** Realtime authorizes a channel when it is joined, so:

- **The server stops broadcasting a taken-down score's committed changes.** The three `doc-db:{id}` fan-out functions (`broadcast_annotation_changes`, `broadcast_document_changes`, `broadcast_score_analysis_changes`) now return early while a live takedown exists. This holds even against a client that ignores everything.
    - Trade-off: for a _restricted_ score, the owner's own devices also stop syncing live and sync by pulling instead.
- **`apply_content_takedown` sends a `membership` hint with role null on `doc:{id}`.** It goes to every member who lost access: non-owners for restrict, everyone for remove. Existing clients already handle this: they re-read the score over PostgREST, find it gone, close it and leave both channels.
- **`documents_select`'s owner clause now stops at a removal** (minor 1). A removed score's owner can't read the row directly, and the re-check closes it for them too.
- **Residual gap, documented in the migration.** A client that ignores the hint can still receive _live ink in progress_ that other clients send on `doc:{id}`. That lasts until Realtime re-checks its token, at refresh or expiry (≤ 1 h). It never receives the score or committed marks.

**B3 (pagination).**

- `moderation_queue()` (newest 200) is replaced by:
    - `moderation_reports(open|decided|all, cursor, limit)`: open reports oldest first;
    - `moderation_takedowns(active|lifted|all, cursor, limit)`;
    - `moderation_log(before_id, limit)`.
- All use keyset pagination: `{rows, total, next}`, at most 100 rows a page, and a half cursor is refused.
- `/admin/reports` shows open reports, live takedowns, decided reports, lifted takedowns and the log as separate lists, each with "Show more".
- Report rows carry the complete notice (minor 2).

**B2 (outbox).**

- **`content_notice_outbox`** is written in the same transaction as the report (via a trigger on `content_reports`, which also logs `report_received`) or the decision (apply, lift, reject).
- **Delivery:**
    - claim with a lease, the request's own notices first;
    - take budget, render from the recorded payload, and send with `Idempotency-Key = content-notice/<id>`;
    - **out of budget:** deferred until the window reopens, not counted as an attempt;
    - **failed or unconfigured:** retried with backoff (1 min doubling, up to 6 h), indefinitely, and logged.
- **Retry:** pg_cron `content-notice-retry` runs every 5 min and pokes the new `content-notices` function (`verify_jwt = false`, shared secret).
- **Moderation page:** shows a per-notice outcome (sent, queued, failed, unconfigured or skipped) and counts the notices still owed.

## Local results (final head)

| Check                                            | Result                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run lint:check`                             | pass                                                                                                                                       |
| `npm run typecheck`                              | pass                                                                                                                                       |
| `npm run test`                                   | pass: 198 files, 2824 tests*                                                                                                               |
| `npm run build`                                  | pass                                                                                                                                       |
| `npx prettier` on changed files                  | clean, except `SETUP_SUPABASE.md`, which already failed Prettier on `dev`. I left its formatting alone rather than reflow the whole file.  |
| `tests/sql/content_moderation.sql` (local stack) | 83/83                                                                                                                                      |
| Regression SQL proofs (local)                    | column_integrity 113/113, cross_branch_integration 37/37, student_access_revocation 44/44, qa3_cross_branch 12/12, share_link_errors 26/26 |

\* Tests ran with `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` blanked, to match CI (as #64 notes, `cloud:up`'s `.env.local` otherwise makes two unrelated tests fail locally).

The SQL proofs are not run in CI. Locally, the migration was re-applied in place with psql. The `content_notice_log` delivery check was updated by hand on the local DB only; a fresh install gets it from the migration.

## CI on the new head

**Green on `6509726`.** Every check passes.

| Run                                                                          | Event        | Jobs                                | Result                           |
| ---------------------------------------------------------------------------- | ------------ | ----------------------------------- | -------------------------------- |
| [39623290606](https://github.com/maxharris1/Cleffy/actions/runs/39623290606) | pull_request | checks, omr-service, supabase-drift | all pass                         |
| [39623282332](https://github.com/maxharris1/Cleffy/actions/runs/39623282332) | push         | checks, omr-service, supabase-drift | all pass (`checks` on attempt 2) |

On the push run's first attempt, `checks` failed on one test:

- **Failing test:** `tests/imslp/imslpDownload.test.ts > tryDownloadPdfWith > cannot be pushed past its budget by an API call that never answers` (`bot_check` instead of `timeout`).
- **Why it isn't #63's:** it is a 150 ms timing-budget test in IMSLP code this PR doesn't touch, and the same job passed on the pull_request run of the same commit. It also passed 5 of 5 local runs.
- **What I did:** re-ran the failed job once (it passed) and left one comment on the PR saying so.

Every intermediate head was green too: `f1feb4a`, `06e4434`, `193f946`, `9ad52d0`. `70d161e` was never a branch head on its own; it was pushed together with `06e4434`.

## ui-check

- **Run:** `scripts/ui/uifuzz.mjs` over all 9 viewports for `/admin/reports`, with 30 open reports, 27 live takedowns and queued notices seeded locally. The teacher account was made a moderator locally for the check. Fixtures and the moderator row were removed afterwards. `/report` was also checked at desktop and iPhone SE.
- **Result:** no console errors.
- **What the screenshots show:** open reports oldest first, the "Full notice as submitted" panel, "Show more", and the queued/failing banner render correctly at every size.
- **Audit flags, all benign:**
    - the sticky header passing over a scrolled "Lift…" button on phones (the same flag #64 reported);
    - the existing inline-link tap sizes on `/report`.
- **Screenshots:** not committed; they stayed in the session scratchpad.

## Skipped or deferred minors

- **Cross-PR minor 5** (checkout keeps its own legal-version copy): this is #62's code (`billingTerms.ts`), so it's Session C's to fix. #63's `LEGAL_VERSIONS` and its server mirror are unchanged.
- **Cross-PR majors 1-2** (deploy order, mirror regeneration):
    - process items; this branch regenerated `scripts/apply-migrations.sql` with `npm run migrations:mirror` on every migration change;
    - the migration timestamp is unchanged (`20261020150000`, edited in place: the PR is unmerged and was never applied to a hosted project).
- **Edge Functions end to end:** not booted. The local Edge runtime can't fetch `npm:` packages through the sandbox's TLS proxy (`UnknownIssuer`), the same limit #64 reported. Handler logic is unit-tested and the SQL path is proven against the local DB.

## Merge notes (for Max / the rebase after each merge)

`git merge-tree` of this head against the other branches' current heads:

- **#62** (`f6afb77`) conflicts in:
    - `SETUP_SUPABASE.md`, `tests/migrationRecoverability.test.ts` and `supabase/config.toml`: each side adds its own outbox job, secrets and function; **keep both**;
    - `supabase/functions/_shared/mailBudget.ts` and `tests/security/mailBudget.test.ts`: same numbers, so **take the union of categories**: guest 35/190, contentReportAck 10/40, moderationNotice 5/20, billingCancelLink 10/50;
    - `src/app/routes.tsx`;
    - `scripts/apply-migrations.sql`.
    - My test `leaves the signed-out cancel link (#62) its share` still passes after the union, because it stops reserving `BILLING_CANCEL_SHARE` once `billingCancelLink` is registered.
- **#61** (`a537c1e`) conflicts in `scripts/apply-migrations.sql` and `tests/migrationRecoverability.test.ts`. That file's cron-job map gets `content-notice-retry`, `billing-mail-outbox`, `district-seat-reconcile` and #64's retention jobs: **keep all**.
- **#64** (`017df18`) conflicts only in `scripts/apply-migrations.sql`.
- **Every case:** regenerate `scripts/apply-migrations.sql` with `npm run migrations:mirror`; never take one side.
- **Outbox tables are distinct:** `content_notice_outbox` (#63) and `billing_mail_outbox` (#62).

## Hosted steps added by this pass (Max, after merge)

1. Deploy `content-notices` with `--no-verify-jwt`, and set the Edge secret `CONTENT_NOTICE_SECRET`.
2. Create the Vault secrets `content_notice_url` and `content_notice_secret` (`SETUP_SUPABASE.md`). Until then, queued notices go out only with the next report or moderator action.
3. Redeploy `content-report` and `content-moderation`, because their wiring changed.

## Open questions

1. **Live ink to a hint-ignoring client.** Stray live strokes can reach a modified client until token refresh or expiry (≤ 1 h). Closing that fully needs per-takedown topic rotation in the client sync code. Is the current bound acceptable for launch?
2. **Restricted scores pause the owner's cross-device live sync.** Devices still converge by pull. Acceptable?
3. **Outbox retention.** Sent rows hold the recipient address and the rendered facts. Should they be purged after N months, with #64's retention jobs, alongside the content-report retention period counsel still has to set?
4. **Notices that can never render or send.** A notice that keeps failing (bad payload, or a bounced address Resend refuses) retries every 6 h forever and shows as "failing" on the moderation page. Should there be a give-up point with a manual "mark handled"?
