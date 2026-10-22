# Launchfix P3 fix round 1 report: PR #70

Written by the P3 fix-round-1 Claude session, 2026-10-22. The packet asked for this report at `/workspace/cleffy-launchfix-p3-fix1-report.md`. `/workspace` is on Max's machine, so per the session brief it is committed on the scratch branch `claude/launchfix-p3-fix1-report` (the final PR #70 head plus one commit adding this file). `claude/launchfix-p3-report` was not touched.

## Status

**Done.** Packet items 1–9 and all six Codex round-1 findings are addressed and tested. PR #70 was fast-forwarded from `1c9e8512` to **`c07fc112`**; it is still a draft with base `dev`. Local checks are green, and CI is fully green on the final head (push run 39743324374, pull_request run 39743329396). `npm run cloud:down` has run. Nothing was merged, nothing went to dev or main, and nothing hosted was touched.

## Environment

- Ran in the **Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2`** (environment kind `anthropic_cloud`), **not Sandbox**. Confirmed with `get_session` at the start.
- Started with `git fetch origin && git checkout -B mh/launchfix-p3-edge-hardening origin/mh/launchfix-p3-edge-hardening`; HEAD was `1c9e8512c115533298983654e949fca21fe0ddb9` as expected, and origin had not moved past it.
- Every commit is authored by Max Harris <drumaxter@gmail.com>. Every push was a fast-forward to `mh/launchfix-p3-edge-hardening` (`git push origin HEAD:mh/launchfix-p3-edge-hardening`); nothing was force-pushed.
- The session's harness named `claude/launchfix-p3-fix1-29m6gc` as its working branch; the explicit brief was followed instead and only `mh/launchfix-p3-edge-hardening` and `claude/launchfix-p3-fix1-report` were written.
- No other session was messaged. No `send_message` was used.

## PR, SHAs

|                     |                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------- |
| PR                  | **#70**, draft, `mh/launchfix-p3-edge-hardening` → `dev` (unchanged; no new PR)       |
| Starting head       | `1c9e8512c115533298983654e949fca21fe0ddb9`                                            |
| **New PR #70 head** | **`c07fc112a50e21dfc02a9a550cf7e076340424a6`**                                        |
| Base                | `dev` at `47e9b38f2dba36fdce852c80948245da344bcc20` (CI merge commits are against it) |
| Report branch       | `claude/launchfix-p3-fix1-report` = new head + one commit adding this file            |

## Commits (on top of 1c9e8512)

| SHA       | Summary                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| `8e93354` | ci: run the three P3 SQL proofs; pin the OMR base image by digest (items 7, 8)                              |
| `16fb657` | fix(resend-inbound): own budget, reserve every attempt, stop retries at 23 h (items 1, 2; split rebalanced) |
| `32fa8ba` | fix(delete-account): active attempts, a destructive-cleanup flag and a lease (item 3)                       |
| `4acedc1` | fix(student-provision): resets carry a holder token; a live reset is never taken over (items 5, 9)          |
| `9fefe39` | fix(student-provision): budget student invitations and reset links (item 4)                                 |
| `9238059` | fix(delete-account): extend the deletion barrier to uploads, provisioning, checkout and joins (item 6)      |
| `c07fc11` | test(sql): describe the P3 fix-round proof coverage; widen a source-guard window                            |

## How each item was addressed

### 1. MAJOR 1 (Codex Part A finding 1): inbound starved content-report acks

- `_shared/mailBudget.ts`: new category **`supportInbound` 8/h, 35/day** with its own buckets **`mail:support-inbound:{hour,day}`** (`supportInboundBudgetKey` in `resend-inbound/handler.ts`). `contentReportAck` keeps **8/35 alone**; nothing else spends `mail:content-report-ack:*`.
- The split stays inside the unchanged discretionary 60/300 and the auth reserve 40/200 is untouched: `supportInbound` 8/35 and the new `studentAccountMail` 6/30 (item 4) were carved out of `guestEmailCode` (**28/150 → 14/85**). See "Budget categories" below; this is the one number I would ask Max to look at (open question 1).
- The round-0 `mailBudgetKey` export in `contentReports.ts` (added only so inbound could share the ack buckets) was removed again; the ack key is back to its original inline form.
- Reporter copy (`ReportContentPage.tsx`): "Your confirmation email is queued. We will send it to {email} as soon as our mail capacity frees up, within 24 hours; keep this reference meanwhile." (was "… shortly").
- Tests: `contentReports.test.ts` "inbound support forwards spending their whole share cannot delay an acknowledgment" (both inbound windows exhausted, the ack still sends); `resendInbound.test.ts` source/limit guard and "a spent inbound budget defers inbound only"; `mailBudget.test.ts` split pinned; `ReportContentPage.test.tsx` queued copy.

### 2. MAJOR 2 (Codex Part A finding 2): held reservations and retry window

- `resend-inbound/handler.ts`: **every attempt reserves budget** (the `_shared/billingOutbox.ts:231-235` pattern). The `budgetHeld` skip is gone; an unknown outcome keeps that attempt's reservation, and the retry reserves again in the window it sends in. `forward_budget_held` stays as a record only.
- New migration **`20261022110300_support_inbound_retry_window.sql`**:
    - `support_messages.first_send_attempt_at`, set by the new `begin_support_forward(id, holder)` right before every send (after the budget is reserved);
    - `support_forward_retry_window()` = **23 hours** (an hour inside Resend's 24 h Idempotency-Key retention);
    - new terminal status **`failed`**: `begin_support_forward` answers `expired` and fails the row once 23 h have passed since the first send attempt; `finish_support_message` fails the row instead of scheduling a retry or deferral whose next attempt would land past the window, and also fails (rather than completes) a row out of attempts;
    - a `failed` row is answered as a duplicate by later deliveries, never claimed by the retry path or the tick, and never written by a stale holder.
- Handler: `expired` → releases this attempt's reservation, logs `forward_window_closed`, answers 200 `retry_window_closed` (Svix stops). `lost` → 503.
- Tests (`resendInbound.test.ts`): window rollover (held unknown in hour 1, 8 fresh forwards use hour 2, the held retry is deferred, nothing extra sent), expired key (no send at 23 h, row failed, reservation refunded, later delivery a duplicate, retry run skips it), backoff past the window, never-attempted rows have no window, call order reserve → beginSend → send. SQL proof section 5 of `support_inbound_lease.sql`.

### 3. MAJOR 3 (Codex Part B finding 1): deletion marker could restrict an account for good

New migration **`20261022110400_account_deletion_attempts.sql`**:

- `account_deletion_attempts` (one row per attempt, **600 s lease**); `account_deletions.attempts` is history only.
- `account_deletions.destructive_started_at`, set by `mark_account_deletion_destructive(user, attempt)` right before the first delete; refused (false) for an attempt that has ended or run out its lease.
- `account_deletion_pending(user)`: the one predicate (takes the per-account lock shared): restricted while an attempt is active **or** once destructive cleanup began. A crashed untouched attempt stops restricting when its lease runs out, with no sweep.
- `begin_account_deletion_attempt` / `settle_account_deletion_attempt`: an abandoned attempt clears the marker when no other attempt is active and no cleanup began. The round-0 `begin_account_deletion` / `settle_account_deletion` are dropped (new in this unmerged PR, never deployed).
- `accountDeletion.ts`: marks cleanup as begun after billing is stopped and before step 3; does not start deleting if it cannot (abandoned, 502 `deletion_unavailable`).
- Tests (`accountDeletion.test.ts`): **two abandoned attempts** (and a third), **one crashed attempt** (lease runs out → unrestricted; a later deletion works), **cleanup started then crash** (still restricted after the lease, an abandoned retry cannot lift it, a completing retry removes it), another tab still working, mark-before-delete ordering, mark failure. SQL proof `account_deletion_pending.sql` sections 3–5.
- Runbook entry for P6: see "P6 runbook entries" below.

### 4. Pre-existing #4 (Codex Part A finding 3): student invite and reset mail unbudgeted

- New import-free `_shared/studentAccountMail.ts`: one reservation per send, narrowest first: **per address 2/h, 3/day** (key is a SHA-256 of the lower-cased address, never the address), **per teacher 4/h, 15/day**, then the project's new **`studentAccountMail` 6/h, 30/day**. A refusal hands back what the others took.
- `student-provision`: the invite reserves before `inviteUserByEmail`; the email-method reset reserves **before the scramble**, so a spent budget answers **429 `mail_budget_spent`** with nothing revoked ("Nothing was changed; try again in about N minutes"). A place is handed back only when nothing can have been sent (email already in use; scramble/session/config failure before the OTP send).
- Tests: `tests/security/studentAccountMail.test.ts` (9).

### 5. Pre-existing #5 (Codex Part B finding 2): reset/reset/claim interleaving

New migration **`20261022110500_student_code_reset_holder.sql`**:

- `reserve_student_code_reset(student, reservation?)` returns a holder token; a live reservation of either kind answers `busy` (with its kind) unless the caller presents that reservation's own token (resume + renew). No takeover of a live reset.
- `complete_student_code_reset(student, token, hash)` writes the new code only for the holder (`lost` otherwise); `release_student_code_reset` releases only for the holder.
- The guard trigger now refuses any other code change under a live reset as well as a claim. `begin_student_code_reset` is dropped.
- `student-provision`: a failure after the reservation keeps the hold and answers 502 `reset_incomplete` with `resetToken`; a second reset gets 409 `reset_in_progress`; a reset that lost its hold gets 409 `reset_lost`.
- Tests: `studentClaim.test.ts` "reset, reset, claim: a paused reset cannot scramble the password the student chose from the other card" and resume-by-token; SQL proof section 7 of `student_claim_reservation.sql` (80–89c); `studentResetWiring.test.ts` (4).

### 6. Pre-existing #6 (Codex Part B finding 3): deletion barrier coverage

New migration **`20261022110600_account_deletion_barrier.sql`**, all through `account_deletion_pending()`:

- **Uploads into existing documents**: restrictive insert and update policies on `storage.objects` for `scores` and `thumbnails` (`caller_account_deletion_pending()`, keyed on the caller only). Removals stay allowed.
- **Auth account creation in provisioning**: `begin_student_provision` records an intent (`student_provision_intents`, no FK to the teacher so it outlives a completed deletion) **before** `createUser` / `inviteUserByEmail`, refused while the teacher is pending (409); `attach_student_provision` records the new account right after; the roster insert clears the intent by trigger; a successful undo finishes it. `student_provision_intents_for` finds a crashed provisioning's account by address (never an account created before the intent). `accountDeletion.ts` sweeps intents (flagged student of this teacher → deleted; live with no account → left to undo itself; stale with none → cleared; unflagged → left and logged for review).
- **Checkout**: a trigger on `checkout_attempts` refuses taking or staging a lease while pending (stripe-checkout answers 409 `account_deletion_pending`); the deletion refuses to start (**409 `checkout_in_progress`**, nothing deleted, abandoned) while a lease taken before the marker is live (`checkout_attempt_in_flight`, 5 minutes = `CHECKOUT_ATTEMPT_STALE_AFTER`).
- **Share-link redemption**: a BEFORE INSERT trigger on `document_members` refuses when the joining account or the score's owner is pending (covers `redeem_share_link`'s insert … on conflict).
- Tests: SQL proof `account_deletion_pending.sql` section 7 (70–93c: both buckets, upsert, deletes not restricted, share redemption both directions, checkout lease before/after the marker and staging, provisioning intents incl. a crash between create and attach, an older same-address account never matched, outliving the teacher, client roles refused); `accountDeletion.test.ts` "the barrier beyond scores and roster rows" (6); `deletionPendingWiring.test.ts` (9); `checkoutFlow.test.ts` 409.

### 7. CI: the three P3 proofs block

`.github/workflows/ci.yml` supabase-local proof loop now also runs `support_inbound_lease student_claim_reservation account_deletion_pending` (step renamed "Checkout, cancel-link and edge-hardening SQL proofs"). They are the only CI edit.

### 8. Minor: OMR base images pinned by digest

- Both stages: `FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d` (the multi-arch **index** digest, read with `docker buildx imagetools inspect`; `node:22-bookworm-slim` and `node:22.23.4-bookworm-slim` both resolved to it on 2026-10-22; the amd64 manifest is `sha256:ea11b74b986d520137cdef9a5346e447a00f275ecc4abc0055b7151226231e09`, base `debian:bookworm-slim` `sha256:ec31d744…606a`).
- **apt packages are not version-pinned** (curl, ca-certificates, fontconfig, fonts-dejavu-core): bookworm's archive serves only current versions, so exact pins break at the next security update; documented in the Dockerfile.
- Unchanged from round 0 and verified by Codex: Audiveris 5.6.1 .deb sha256 `3f05c33f…a656`, tessdata `eng.traineddata` (3.04.00) sha256 `c0515c9f…f06d`.
- `omrDockerfilePins.test.ts` now also fails on any `FROM` without a digest.
- A local `docker build` pulled the pinned digest and ran `apt-get` successfully; the Audiveris `curl` then failed with exit 60 (TLS: this sandbox's intercepting proxy CA is not trusted inside the build container). Not a pin problem; CI still does not build the image (follow-up 3).

### 9. Decision 49 item 5: failed reset holds the claim up to 10 minutes

The server's `reset_incomplete` message and the roster's `RESET_INCOMPLETE_MESSAGE`: "The reset did not finish. The student's current card is held for up to 10 minutes, so it cannot be used meanwhile. Try the reset again." The roster keeps the returned token in memory and sends it on the teacher's next reset of that student, which resumes the hold at once. Tests: `rosterService.test.ts`, `RosterPage.test.tsx`.

## Budget categories and limits now in place

Budget 100/h, 500/day (assumption, unchanged); auth reserve 40/200 (unchanged); discretionary 60/300.

| Category               | per hour | per day | Buckets                           | Change                   |
| ---------------------- | -------- | ------- | --------------------------------- | ------------------------ |
| guestEmailCode         | 14       | 85      | guest-email-start's own           | **was 28/150**           |
| contentReportAck       | 8        | 35      | `mail:content-report-ack:*`       | unchanged, now acks only |
| moderationNotice       | 4        | 20      | `mail:moderation-notice:*`        | unchanged                |
| billingCancelLink      | 8        | 40      | billing outbox                    | unchanged                |
| billingConfirmation    | 7        | 30      | `billing-confirmation:*`          | unchanged                |
| retentionNotice        | 5        | 25      | district notices                  | unchanged                |
| **supportInbound**     | **8**    | **35**  | `mail:support-inbound:*`          | **new**                  |
| **studentAccountMail** | **6**    | **30**  | `mail:student-account:{hour,day}` | **new**                  |
| total                  | 60       | 300     |                                   | = 100/500 − 40/200       |

Under `studentAccountMail`: per teacher 4/h, 15/day (`mail:student-account:teacher:<id>:*`); per address 2/h, 3/day (`mail:student-account:to:<sha256>:*`).

## Tests and SQL proofs added or changed

- New test files: `tests/security/studentAccountMail.test.ts` (9), `tests/security/studentResetWiring.test.ts` (4).
- Extended: `tests/support/resendInbound.test.ts` (25 → 31), `tests/account/accountDeletion.test.ts` (+12), `tests/account/deletionPendingWiring.test.ts` (4 → 9), `tests/security/studentClaim.test.ts` (+2), `tests/moderation/contentReports.test.ts` (+1), `tests/billing/checkoutFlow.test.ts` (+1), `tests/security/mailBudget.test.ts` (split), `tests/security/omrDockerfilePins.test.ts` (+1), `src/features/moderation/ReportContentPage.test.tsx` (+1), `src/features/roster/rosterService.test.ts` (+2), `src/features/roster/RosterPage.test.tsx` (+1).
- SQL proofs (all three now in CI): `support_inbound_lease.sql` (+section 5), `student_claim_reservation.sql` (+section 7, sections 3–5 moved to the token API), `account_deletion_pending.sql` (rewritten for attempts; +section 7 barrier). `tests/sql/README.md` updated.

### Every SQL proof, pass/total

All against the local stack (all migrations including the four new ones applied, each twice), and the CI-listed ones also in CI (supabase-local, push run 39743324374 job 119705632041 and PR run 39743329396 job 119705648000; the step fails on any failing proof, and the job passed).

| Proof                              | Local              | CI                       |
| ---------------------------------- | ------------------ | ------------------------ |
| **support_inbound_lease** (P3)     | **58/58**          | **58/58** (now blocking) |
| **student_claim_reservation** (P3) | **73/73**          | **73/73** (now blocking) |
| **account_deletion_pending** (P3)  | **89/89**          | **89/89** (now blocking) |
| cancel_link_lifetime               | 57/57              | pass                     |
| cancel_link_tombstones             | 38/38              | pass                     |
| cancel_link_db_clock               | 21/21              | pass                     |
| cancel_link_tombstone_race         | 25/25              | pass                     |
| cancel_link_read_db_clock          | 10/10              | pass                     |
| cancel_link_save_after_insert      | 12/12              | pass                     |
| cancel_link_consume_db_clock       | 36/36              | pass                     |
| checkout_consents                  | 25/25              | pass                     |
| launch_checkout_fixes              | 46/46              | pass                     |
| annotation_payload_shape           | 57/57              | not in CI                |
| archived_student_password          | 13/13              | not in CI                |
| billing_export_claims              | 35/35              | not in CI                |
| column_integrity                   | 113/113            | not in CI                |
| content_moderation                 | 99/99              | not in CI                |
| cross_branch_integration           | 37/37              | not in CI                |
| district_billing_canonical         | 12/12              | not in CI                |
| district_migrations_rerunnable     | 20/20              | not in CI                |
| district_retention                 | 28/28              | not in CI                |
| district_seat_cap                  | 192/192            | not in CI                |
| district_seats                     | 58/58              | not in CI                |
| district_student_scope             | 47/47              | not in CI                |
| edge_rate_limit_refund             | 10/10              | not in CI                |
| guest_email_verification           | 53/53              | not in CI                |
| launch_consent                     | 43/43              | not in CI                |
| qa3_cross_branch                   | 12/12              | not in CI                |
| share_link_errors                  | 26/26              | not in CI                |
| billing_double_charge              | **95/98** (3 fail) | excluded (decision 20)   |
| district_read_only_seats           | **64/68** (4 fail) | not in CI                |
| student_access_revocation          | **42/44** (2 fail) | not in CI                |

The three failing proofs fail exactly as in round 0 (same checks: 89/92/98; 49/59/60/62; 22/24), they predate P3 and belong to P1 (decision 44 / decision 49 item 7). The new triggers in this round (membership, checkout, provisioning, storage policies) did not change any other proof's result. CI per-proof counts for the nine pre-existing CI proofs were not re-read from the log (only the tail was fetched); the job passed, which requires every one to pass, and the files are unchanged from round 0 (57/38/21/25/10/12/36/25/46 there).

## Local check results (final head)

| Check                                                                    | Result                                                                                                                                                               |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint:check`                                                     | pass (exit 0)                                                                                                                                                        |
| `npm run typecheck`                                                      | pass (exit 0)                                                                                                                                                        |
| `npm run test`                                                           | pass: **226 files passed, 5 skipped (231); 3523 tests passed, 13 skipped (3536)** (round 0: 3478 passed)                                                             |
| `npm run build`                                                          | pass (exit 0)                                                                                                                                                        |
| `npx prettier --check` on every changed .ts/.tsx/.js/.mjs/.json/.md/.yml | pass (prettier has no SQL parser; .sql not checked)                                                                                                                  |
| `npm run migrations:mirror`                                              | regenerated; clean (no diff after the final run)                                                                                                                     |
| SQL proofs                                                               | as above                                                                                                                                                             |
| `deno check`                                                             | **not run this round**: `deno` is not installed in this container (round 0 had it). Edge entry points were typechecked through vitest/tsc only; see open question 5. |
| OMR `docker build`                                                       | pinned base pulled and built through apt-get; Audiveris curl then failed with exit 60 (sandbox TLS proxy), see item 8                                                |

As in round 0, the full suite was run with the `cloud:up`-generated `.env.local` moved aside (two unrelated tests read local-stack variables otherwise) and restored afterwards; CI has no `.env.local`.

## CI on the final head

All green on **`c07fc112`**:

| Workflow run | Event        | Check            | Job id       | Result                                 |
| ------------ | ------------ | ---------------- | ------------ | -------------------------------------- |
| 39743324374  | push         | checks           | 119705631816 | success                                |
| 39743324374  | push         | supabase-local   | 119705632041 | success                                |
| 39743324374  | push         | omr-service      | 119705632028 | success                                |
| 39743324374  | push         | supabase-drift   | 119705631697 | success                                |
| 39743329396  | pull_request | checks           | 119705647545 | success                                |
| 39743329396  | pull_request | supabase-local   | 119705648000 | success                                |
| 39743329396  | pull_request | omr-service      | 119705647877 | success                                |
| 39743329396  | pull_request | supabase-drift   | 119705647793 | success                                |
| n/a          | (app)        | Supabase Preview | 119705625850 | skipped (the integration's own choice) |

Intermediate head `32fa8ba`: pull_request run 39740345075 `checks` **failed at `npm audit --omit=dev --audit-level=high`** with `400 Bad Request … Invalid package tree` / "This endpoint is being retired" from registry.npmjs.org, after 5 minutes. No dependency or lockfile changed in this round; another session's branch (`claude/launchfix-p4-fix1-report`, run 39738094241) failed in the same window, and the step passed on the next push without any change. Treated as an npm-registry incident, not this PR's; no re-run was spent. supabase-local, omr-service and supabase-drift were green on that head. If the audit endpoint keeps flapping, `checks` may need a retry on later pushes (follow-up 6).

GitHub reported `mergeable_state: unstable` for the PR right after the run (no conflict; base dev still 47e9b38f). The Vercel Preview Comments app check had not reported on this head when last read.

## Migrations and files touched

**New migrations** (all in 2026102211xxxx; no existing migration edited; each applied twice cleanly on the local stack):

- `20261022110300_support_inbound_retry_window.sql`
- `20261022110400_account_deletion_attempts.sql`
- `20261022110500_student_code_reset_holder.sql`
- `20261022110600_account_deletion_barrier.sql`

`scripts/apply-migrations.sql` regenerated with `npm run migrations:mirror` (clean after the last regeneration).

**Files (36)**: `.github/workflows/ci.yml`; `services/omr-service/Dockerfile`; `src/features/moderation/ReportContentPage.tsx` (+test); `src/features/roster/rosterService.ts` (+test), `RosterPage.test.tsx`; `supabase/functions/_shared/{accountDeletion,checkoutFlow,contentReports,mailBudget,studentAccountMail(new)}.ts`; `supabase/functions/{delete-account,resend-inbound (handler, index),stripe-checkout,student-provision}`; the four migrations; the mirror; tests listed above; `tests/sql/README.md`.

**Not touched**: `session.ts`, `annotationStore.ts`, `InkController.ts`, `realtimeChannel.ts`, `src/sync/*`, existing migrations, DEPLOY.md and other docs, `supabase/config.toml`.

## student-provision/index.ts changes, for the P5 (#66) rebase

All on top of round 0's changes (readBody cap, `DELETION_PENDING`, `isDeletionPending`, the two roster-insert 409 branches):

1. Imports: `mailLimit` (`_shared/mailBudget.ts`), `refundRateLimit` (added to the `_shared/rateLimit.ts` import), `reserveStudentAccountMail`, `studentMailRefusal` (`_shared/studentAccountMail.ts`).
2. `ProvisionBody.resetToken?: unknown`.
3. New constant `RESET_INCOMPLETE_MESSAGE`; new helpers `reserveStudentMail`, `finishProvision`, `attachProvision`; `undoCreatedStudent(admin, studentUserId, rosterId)` gains a `rosterId` argument and finishes the intent on success.
4. `createCodeStudent` / `createEmailStudent`: `attachProvision` right after the Auth create (undo + 409/502 if not ok); `finishProvision` after each successful compensating `deleteUser`; `createEmailStudent` reserves mail before `inviteUserByEmail` (429 on refusal, release on email-in-use).
5. `createStudent`: the round-0 early `account_deletions` select is **removed**; `begin_student_provision` is called after `checkRosterStock` and the roster id is minted, right before `createCodeStudent` / `createEmailStudent`.
6. `resetStudentAccess`: email path reserves mail before the scramble (released on pre-send failures); code path uses `reserve_student_code_reset` / `complete_student_code_reset` and the `incomplete()` 502 with `resetToken` (replaces `begin_student_code_reset` and the direct `login_code_hash` update).
7. Header note: the one metered thing is mail.

If P5 adds a district provisioning path that creates Auth accounts, it needs the same `begin_student_provision` / `attachProvision` / `finishProvision` calls.

## P6 runbook entries requested

1. **Half-deleted accounts (destructive cleanup started, never finished).**
   Find: `select d.user_id, d.started_at, d.destructive_started_at, d.updated_at, d.attempts, d.last_error from public.account_deletions d where d.destructive_started_at is not null and not exists (select 1 from public.account_deletion_attempts a where a.user_id = d.user_id and a.ended_at is null and a.lease_until > now()) order by d.destructive_started_at;`
   The account refuses new scores, students, uploads, joins and checkouts until a deletion completes. Action: check `last_error` (billing, storage, auth), fix the cause, then ask the person to retry Delete account (it needs their session and password); if they cannot be reached, escalate to Max for a service-role completion. Never clear the row by hand while data is half-deleted. Untouched markers (no `destructive_started_at`, no live attempt) restrict nothing and need no action.
2. **Orphaned provisioning intents.**
   Find: `select * from public.student_provision_intents where expires_at < now() order by created_at;`
   Each names a provisioning that never got its roster row. Resolve the account with `select * from public.student_provision_intents_for('<teacher_id>')`; if it names an account whose `app_metadata` is `user_type = student` and `teacher_id` = the intent's teacher and no `managed_students` row has that `student_user_id`, delete that Auth user (dashboard or admin API), then `select public.finish_student_provision('<roster_id>')`. An intent naming no account can simply be finished. An account that is not flagged (an email invite whose flag never landed) needs a person to decide.
3. **Inbound support mail marked `failed`.**
   Find: `select id, resend_email_id, from_address, subject, attempts, first_send_attempt_at, forward_error, completed_at from public.support_messages where status = 'failed' order by completed_at desc;`
   These were not (or may not have been) forwarded and will not be retried automatically (23 h idempotency window, or out of attempts). Action: read the stored body in the table and forward by hand or reply directly; do not requeue rows whose `first_send_attempt_at` is older than 24 h unless a duplicate to the team inbox is acceptable.

(Decision 49 item 1's live HTTP smoke tests stay with P6: claim race, chunked 413 per function, duplicate inbound; add: a reset/reset/claim run, a deletion during an open checkout tab, an upload during a deletion.)

## Deviations

1. Rebalance taken entirely from `guestEmailCode` (28/150 → 14/85). Other categories unchanged.
2. Out-of-attempts inbound rows now end `failed` (manual review) instead of `completed` with an error.
3. `begin_account_deletion`, `settle_account_deletion` and `begin_student_code_reset` (all new in this unmerged PR) are dropped by the new migrations rather than kept beside their replacements.
4. A failed teacher reset keeps its hold (and returns a token to resume it) rather than releasing it, per decision 49 item 5; `release_student_code_reset` exists for the holder but the function does not call it.
5. The deletion now refuses to start while a checkout lease is live (409 `checkout_in_progress`), rather than waiting for it.
6. The membership trigger refuses every `document_members` insert for a pending account or into a pending owner's score, not only share-link redemption.
7. Storage refusal is keyed on the caller (who must be the owner under the permissive policies); service-role uploads bypass RLS and are not covered (none upload into a user's score folder today).

## Follow-ups

1. Cron sweeps (decision 49 item 6): half-deleted `account_deletions` rows and stale `student_provision_intents` are runbook-only for now.
2. Live HTTP checks on hosted after migrations (decision 49 item 1, P6 smoke tests), plus those listed above.
3. CI still does not build the OMR image; a `docker build` job (or a scheduled one) would turn the pins into build-verified ones.
4. Storage-api ordering: the barrier is enforced where storage-api writes the `storage.objects` row. If storage-api ever stores bytes before a refused row insert, those bytes are its own to clean up; not verified against storage-api internals here.
5. Stale `student_provision_intents` for teachers who are not being deleted (an Auth create that errored ambiguously) accumulate until the runbook/cron clears them; harmless but worth the sweep.
6. CI's `npm audit` step hit a registry 400 once this round; if it recurs, consider the bulk advisory endpoint or a retry wrapper (not in this PR's scope).
7. PR #70's description still describes round 0 (e.g. inbound sharing `contentReportAck`, "CI will run them once P1's glob lands"). I did not edit it; Max may want to append this round's summary.

## Open questions

1. **The split.** `guestEmailCode` goes from 28/150 to 14/85 to fund `supportInbound` 8/35 and `studentAccountMail` 6/30. Is 14/h enough for share-link guest codes at launch, and is 6/h (4 per teacher) enough for email-method student invites? Changing it is one edit in `mailBudget.ts` plus the pinned test.
2. **Per-teacher/per-address student mail limits** (4/h 15/day; 2/h 3/day) are my choice; confirm or adjust.
3. **Checkout during deletion.** The deletion answers 409 for up to 5 minutes after a checkout tab took its lease. Acceptable, or should the deletion wait/poll server-side instead?
4. The three pre-existing failing SQL proofs (below) still belong to P1 per decision 44; they are unchanged by this round.
5. `deno check` could not run here (no deno in this container). Should the rebase pass (or Codex) run `deno check --node-modules-dir=none` on `resend-inbound`, `delete-account`, `student-provision`, `stripe-checkout` and `student-claim` entry points? Round 0 found 7 pre-existing errors in untouched spots only.

## Hosted steps left for Max (updated; none performed)

1. Apply the migrations, in order, after round 0's three: `20261022110300_support_inbound_retry_window.sql`, `20261022110400_account_deletion_attempts.sql`, `20261022110500_student_code_reset_holder.sql`, `20261022110600_account_deletion_barrier.sql` (the Supabase GitHub integration applies them on merge: dev, then production).
2. Unchanged from round 0: Edge secret `SUPPORT_RETRY_SECRET`; Vault `support_inbound_url` and `support_inbound_secret` on each project.
3. Deploy the Edge Functions **after** the migrations: `resend-inbound`, `delete-account`, `student-provision`, `stripe-checkout` (new RPCs/triggers), plus everything round 0 listed.
4. Optional per-project mail-budget override is unchanged (`MAIL_BUDGET_PER_HOUR/DAY`); the new categories need no new secret.
5. Next OMR image build uses the digest pin; re-pin deliberately with `docker buildx imagetools inspect`.
6. Docs (P6): the runbook entries above; DEPLOY.md should say inbound forwards spend `supportInbound` (not `contentReportAck`) and list the new categories.

## Expected conflicts with the other launchfix PRs

| PR                                        | Overlap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 (#69)                                  | `scripts/apply-migrations.sql` (regenerate, never hand-merge); `tests/sql/README.md` (keep both); `.github/workflows/ci.yml` proof list (if P1's glob lands, drop this explicit list or keep both, the three proofs pass either way); storage policies: P1 adds restrictive `*_object_name_*` policies and a storage quota trigger on `storage.objects`, this PR adds `storage_refuse_during_account_deletion_*` — different names, both restrictive, no textual conflict; P1's grants on `document_members` / `checkout_attempts` / `managed_students` should re-run this PR's proofs. |
| P2 (#68)                                  | none (no shared files).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| P4 (#71)                                  | none this round.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| P5 (#66)                                  | `supabase/functions/student-provision/index.ts` (list above); `_shared/accountDeletion.ts` if P5 touches deletion (new ports `markDestructive`, `checkoutInFlight`, `provisionIntents`, `clearProvisionIntent`; `settleDeletion` takes the attempt).                                                                                                                                                                                                                                                                                                                                    |
| P6 (#67)                                  | docs only: runbook entries and DEPLOY.md lines above; P6's inventory of cron jobs is unchanged (no new cron job this round).                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| any PR touching `_shared/mailBudget.ts`   | the split table and `tests/security/mailBudget.test.ts` pinned values changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| any PR touching `_shared/checkoutFlow.ts` | `AttemptStart` gains `{ ok: false; reason: 'deletion_pending' }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Housekeeping

- `npm run cloud:down` has run ("Stopped supabase local development setup").
- No `.env` file and no secret was committed or printed; `.env.local` (generated by `cloud:up`, gitignored) was moved aside only for the test runs and restored, as in round 0.
- Hosted Supabase, Vercel, Resend live sending and Stripe were never touched. PR #54 and other sessions' branches were never touched. No PR was opened; PR #70 stays a draft with base dev; no reviewer was requested.
- The shared seeded accounts were not changed; the SQL proofs run in rolled-back transactions.
