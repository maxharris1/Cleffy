# Cleffy launch-fix follow-ups: report

**Status:** Complete

All 20 items are handled. Items 1–15 and 17–20 are done. **Item 16 is not implemented:** per the packet's rule, it needs a product and lifecycle decision for each writer, so it is written up (the _Item 16_ section) with a recommendation, and is open question 1. CI on the final head is listed check by check below.

- **PR:** https://github.com/maxharris1/Cleffy/pull/72 (draft, base `dev`, head `mh/launchfix-followups`, no reviewers requested)
- **Base:** `dev` @ `a3c7b133da94a27fb922d36f0c28499de88bf9ee` (the #67 merge). `origin/dev` had not moved; checked at the start and again before the first push.
- **Final head:** ``fb91497a304c80ebbebafec323ba99891b15a053` (`mh/launchfix-followups`)`
- **Environment:** Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (`anthropic_cloud`), confirmed with `get_session` at the start. Not Sandbox.

## Branches and pushes

- `origin/mh/launchfix-followups` did not exist at the start (`git ls-remote --heads origin mh/launchfix-followups` printed nothing), and still did not right before the first push.
- First push, which created the branch: `git push -u origin HEAD:mh/launchfix-followups` (`feb3566`).
- Every later push was `git push origin HEAD:mh/launchfix-followups`, each preceded by `git merge-base --is-ancestor origin/mh/launchfix-followups HEAD`, and each was a fast-forward: `feb3566..1b4d740`, `1b4d740..67f7f02`, `67f7f02..fb91497`. Nothing used `--force` or `--force-with-lease`, and no pushed commit was rebased, amended or squashed. Before their first push, three local commits were reworked: item 8's commit was amended (formatting); a fixup was folded into item 7's commit with `git rebase -i --autosquash`, which also rewrote item 8's still-unpushed commit; and the CI-fix commit `fb91497` was amended twice (the regenerated mirror and a wiring test). All of this was before the first push of each commit.
- Commit identity on every commit: Max Harris <drumaxter@gmail.com>.
- This report: branch `claude/launchfix-followups-report`, from the final PR head plus one commit adding this file. No other branch was touched.
- `gh` was not usable in this container (its token is invalid). The PR was created and updated, and CI read, through the GitHub MCP tools instead.

## Items

| #   | Item                                                                                                  | Status                                               | Commit               | Files (main)                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | student-claim: a throw from the `managed_students` lookup maps to `unknown`, releases, 503            | done                                                 | `42cba23`            | `supabase/functions/student-claim/{handler,index}.ts`, `tests/security/studentClaim.test.ts`                                                                       |
| 2   | Signed-out erase-conflict export copy                                                                 | done                                                 | `592b323`            | `src/features/export/exportAnnotations.ts` (+ test)                                                                                                                |
| 3   | Decision 65(1)/(2): Export or Discard notice for a lost score's held ink; "still on this device" copy | done                                                 | `ddaba79`            | `src/sync/inkRecovery.ts`, `src/features/viewer/SignedOutInkNotice.tsx`, `src/features/library/documentsService.ts`, `src/features/export/*` (+ tests)             |
| 4   | P3's migrations in CI's replay step                                                                   | done (extended in `fb91497`)                         | `f54622c`, `fb91497` | `.github/workflows/ci.yml`                                                                                                                                         |
| 5   | syncEngine backoff test hermetic with `.env.local`                                                    | done                                                 | `9fedb47`            | `src/sync/syncEngine.test.ts`                                                                                                                                      |
| 6   | Overlapping district purges delete each other's restore record (47, 66(1))                            | done                                                 | `3dd3c85`            | `20261022140000`, `tests/sql/district_retention_overlapping_restores.sql`                                                                                          |
| 7   | Decision 68(2): the hard delete detaches teacher-restored students                                    | done                                                 | `7fbe3c4`            | `20261022140100`, `tests/sql/district_retention_detach_kept.sql`                                                                                                   |
| 8   | Decision 68(3): a renewal lifts the barrier immediately                                               | done                                                 | `feb3566`            | `20261022140200`, `tests/sql/district_barrier_lifts_on_renewal.sql`, DEPLOY.md                                                                                     |
| 9   | Bound the email fallback in `student_provision_intents_for()` to the intent window                    | done                                                 | `e5f970d`            | `20261022140300`, `tests/sql/student_provision_intent_window.sql`                                                                                                  |
| 10  | P4: superseded studios and archive rotation; recheck on focus and reconnect; test row cleanup         | done                                                 | `1b4d740`            | `src/sync/realtimeChannel.ts` (+ test), `tests/sql/superseded_studio_rotation.sql`, `scripts/live-tests-cleanup.sh`, `tests/liveTestsCleanup.test.ts`              |
| 11  | P1: a multi-object delete can deadlock with a publish                                                 | done                                                 | `8960004`            | `20261022140500`, `tests/sql/thumbnail_publish_lock_order.sql`, check 36 of `storage_quota_lock_and_cover_reuse.sql`                                               |
| 12  | Storage-full UI shows usage and the cap                                                               | done                                                 | `bd79696`            | `20261022140600`, `src/lib/storageUpload.ts` (+ test), `src/types/database.ts`, `tests/sql/my_storage_usage.sql`                                                   |
| 13  | P1's grants on `content_strikes`                                                                      | done: audited, no gap, proof added                   | `e9425ab`            | `tests/sql/content_strikes_grants.sql`                                                                                                                             |
| 14  | Clear stale `code_reset_worker` markers (decision 64)                                                 | done                                                 | `2d9d036`            | `20261022140700`, `tests/sql/clear_stale_code_reset_markers.sql`, DEPLOY.md                                                                                        |
| 15  | Email reset fencing                                                                                   | done                                                 | `67f7f02`            | `20261022140800`, `supabase/functions/student-provision/index.ts`, `src/features/roster/rosterService.ts`, `tests/sql/student_email_reset_fence.sql`, wiring tests |
| 16  | Deletion-pending checks in stripe-webhook, billing-cancel and the queue writers                       | **not done** (needs a lifecycle decision; see below) | —                    | —                                                                                                                                                                  |
| 17  | `end_student_sessions()` lock order (tokens/sessions before the roster row)                           | done                                                 | `2062a9d`            | `20261022140900`, `tests/sql/end_student_sessions_lock_order.sql`                                                                                                  |
| 18  | Email-fallback cleanup never deletes an account it cannot prove (with 9)                              | done                                                 | `1972d52`, `fb91497` | `20261022140400`, `supabase/functions/{delete-account/index,_shared/accountDeletion}.ts`, `tests/account/accountDeletion.test.ts`, DEPLOY.md                       |
| 19  | DEPLOY.md orphaned-provisioning runbook: finish an intent only when all its rows are resolved         | done (docs)                                          | `9d8caf4`            | DEPLOY.md                                                                                                                                                          |
| 20  | Decision 49(6) sweep                                                                                  | done (built: small; not scheduled)                   | `e686410`            | `20261022141000`, `tests/sql/sweep_stale_account_deletions.sql`, DEPLOY.md                                                                                         |

### Notes per item

1. `teacherDeletionPending` in `student-claim/index.ts` catches a throw itself, and `handler.ts` maps any rejection to `unknown` as well. Either way the card is released and the answer is 503 `deletion_check_unavailable`. The new test fails without the handler change.
2. A signed-out export claims nothing (`claimPdfExport` returns ALLOWED for a null session), so the PDF builds. But it holds only the tab's unsaved marks, so "the export shows that version" was false for an overtaken erase. Signed out, the copy now says the newer version is a saved mark and isn't in the export.
3. `purgeLocalDocument` now **closes** a score's held ink by default (`inkRecovery.closeDocInk`): it moves under a key of its own, out of every viewer, Retry and new edit, and the app-wide notice lists it with Export (exports only that ink, and says so) and Discard (asks first, offering Export). Only `deleteDocument`, the user's own delete, passes `heldInk: 'discard'`. **Interpretation:** "Remove from my library" for a shared score and leaving via the share dialog also keep the ink, as "access lost". Decision 65(1) lists "removed from a share, left the studio", and keeping is the side that destroys nothing (decision 63). The signed-out banner copy now says the ink "is still on this device" (65(2)). A share-link guest who lost access cannot get a PDF claim for that score, so for them only "Send page as photo" works. See open question 3.
4. First commit: P3's nine migrations were added to the replay. After item 18 that broke CI (below). The step now replays the cancel-link five and **every** migration from `20261022100000` to the newest, in filename order. All 39 re-apply cleanly locally, so the proofs run on the definitions a recovery ends on.
5. With `.env.local` present, Supabase looked configured, a day snapshot's upload went to the real local stack, and undici's timers were captured as retry timers. `syncEngine.test.ts` now mocks `@/lib/supabase` as unconfigured. It passes 132/132 with and without `.env.local`.
6. **What "each other's restore record" was:** the restore that A's purge carried for a student a human moved to district B, when B's purge lists them too. B's entry says `was_archived` (A archived them), so B's renewal never restored them, and A's cancel, hard delete and raw-move skip each deleted A's record. Now each hands it on to B (`restore_handed_on`). The other districts' billing rows are locked `FOR KEY SHARE NOWAIT` before any roster row, and a district another run holds is passed over until the next run (decision 69(3)). Residual: a district that only starts listing the student after the lock was taken (a concurrent run's soft delete) gets nothing handed on. That is the old behaviour, in the narrowest window.
7. Every listed student the hard delete keeps in the district (restored by their teacher, or an account that is not a provisioned student) has `district_studio_id` cleared. Nothing is deleted and `district_attribution` is unchanged. Logged as `attribution_changed`/`detached_kept` and counted in the run's result. The `hard_deleted` log row keeps its old shape, because an existing proof pins it.
8. `district_deletion_pending()` treats a soft-deleted cycle whose billing record now names another contract end as not pending. That is the run's own `cancel` condition. The run is unchanged. A renewal undone before the run closes the barrier again, and the sweep lists whoever came in meanwhile (proved).
9. The fallback now finds only an account created between `created_at - 1 minute` and `expires_at`, and never another intent's recorded account.
10. (a) Superseded studios: with P1 and P4 both merged, superseding archives a capped member's scores past the cap (`20261022100600`), and archiving rotates each such score (`20261022120100`). Proved end to end; no migration was needed. (b) While archived, the channel also rechecks at once on window `focus`, `online` and `visibilitychange` to visible, at most once every 5 s. (c) `scripts/live-tests-cleanup.sh` removes the `realtime.messages` hints and GoTrue audit rows the live tests leave. It runs on local databases only: it refuses any host but 127.0.0.1/localhost.
11. **The deadlock:** a removal reached cover 0 (the published one, kept, but the folder lock was taken to know that), then cover 1. A publish of 1 held 1's row `FOR KEY SHARE` and waited for the folder. Reproduced locally (`deadlock detected`). The publish now reads whether its object is stored, takes the folder lock, then the row `FOR KEY SHARE NOWAIT`. A busy row is refused with `thumbnail_folder_busy` (55P03, retryable; `publishThumbnail` returns false and a later session republishes). A cover removed while the publish waited is still refused with `thumbnail_gone`. **Behaviour change:** a publish whose object row another writer holds is now refused at once instead of waiting.
12. `my_storage_usage()` gives the caller's own `used_bytes` and `limit_bytes` (granted to `authenticated` and `service_role`, not `anon`). On `storage_quota_exceeded` the client reads it and says e.g. "your storage is full (498 MB of 500 MB used)". Without it, the old wording is kept.
13. ACL `{postgres, service_role}`. anon, authenticated and PUBLIC hold nothing on the table or any column (130100's columns included). RLS is on, with no policy. The strike functions are `service_role`'s, and the pepper and key helpers belong to `postgres` alone. Nothing to fix.
14. `clear_stale_code_reset_markers(p_limit)` removes only the key, only where no live reservation holds the student. It locks the roster row (`SKIP LOCKED`) and then the reservation, the order resets and claims use. It is idempotent and not scheduled. DEPLOY.md's "do not clear it by hand" now gives this call instead.
15. The email path now runs `runCodeReset` with the code ports: reservation, lease, two fences, fenced session end, quarantine and resume token. It ends with `complete_student_email_reset()`, which refuses a code row. The mail budget is reserved first and released on any stopped reset, and the link is mailed after the reset. **New copy:** a stopped email reset now says "…no new link was sent…" instead of mentioning a card (`method: 'email'` in the answer). Three older static tests that pinned the inline scramble now pin the fenced flow.
16. **The deadlock:** reproduced locally with dblink (`deadlock detected`). The function now locks the roster row `FOR UPDATE` first.
17. **Audit result:** `delete-account` is the only automatic cleanup that reads the intents (`student-provision` undoes the account it created by its own id). It now deletes only when the new `student_provision_intents_proven()` says `proven` (DEPLOY.md's proof (A)). Anything else is logged and left, with its intent, for the runbook. `student_provision_intents_for()` keeps its three columns (see the CI fix).
18. Rows are resolved per case, and an intent is finished (`finish_student_provision`) only once every row it shows on is resolved. An intent with a recorded account is decided by that account alone. Docs only.
19. Decision 49(6)'s text is "Runbook for stale account_deletions rows in P6 now; cron sweep is a follow-up". `sweep_stale_account_deletions()` closes attempts whose lease ran out, deletes untouched markers (settle's own rule) and reports half-deleted rows without touching them. It is **not scheduled**: DEPLOY.md gives Max the cron line, and the step 13.4 list to extend. Note that P6's DEPLOY.md also mentions "a scheduled sweep could take over cases 1 to 3 (decision 49(6) follow-up)" of orphaned provisioning. That sweep is not built: case 3 deletes Storage objects and Auth users, which SQL cannot do and which would need a new scheduled Edge Function. See open question 2.

### Item 16 (not implemented): what I found and the decision needed

P3 (fix round 3) left these "by decision", noting "These need their own lifecycle policy". What each one does for a user whose deletion is pending:

- **stripe-webhook** writes `billing_customers` and `subscriptions`, archives and restores scores on plan changes, and records duplicate undos (`_shared/stripeEvents.ts`, 1,295 lines, with event claims). The deletion already cancels every subscription first and sweeps Stripe again after the Auth user is gone (step 7). An event for an account that is already gone is handled by `deletedAccountBilling.ts`.
    - Option A: answer 503 while pending. Nothing is written, Stripe retries, and the event is processed normally if the deletion is abandoned, or by the deleted-account path once it completes. This needs the event claim released on the refusal.
    - Option B: process normally and let the deletion's sweeps clean up. That is today's behaviour; the rows cascade with the user.
    - Option C: cancel at Stripe immediately, as for a deleted account.
- **billing-cancel** (signed-out cancel link) spends the link token, sets `cancel_at_period_end` at Stripe and queues mail, including the refund request to support. While a deletion is pending: refuse with 409? Still let the refund request (a legal right of withdrawal) through? Do nothing, since the deletion cancels anyway?
- **The queue and cache writers:** content reports and moderation queues (a report about someone's content may be legally required whoever is deleting), the billing mail outbox (receipts and cancellation confirmations), district retention notices, IMSLP catalog caches (not user data), quota and rate counters (user-keyed, cascade), guest email verification. Each needs a keep, refuse or drop call.

**Decision needed (Max):** a policy per writer. My recommendation: A for the webhook; for billing-cancel, refuse the Stripe update but always send the refund request; and for the queue writers, leave legally required mail and reports alone and refuse the rest. I did not implement any of it, to avoid guessing on billing and legal behaviour. It is roughly a day once decided.

## Migrations

All new, in `2026102214xxxx`. No merged migration was edited. `20261022140400` was changed in a later commit of this PR before merge (see the CI fix); it was never applied anywhere but the local stack and CI. `scripts/apply-migrations.sql` is regenerated (`npm run migrations:mirror`). There is no new public table, so no new service_role grant; `explicitServiceRoleGrants` passes.

| Migration                                           | Item | Deploy note                                                                            |
| --------------------------------------------------- | ---- | -------------------------------------------------------------------------------------- |
| `20261022140000_district_retention_restore_hand_on` | 6    | After 130400. Redefines `retention_district_run()`.                                    |
| `20261022140100_district_retention_detach_kept`     | 7    | After 140000. Redefines the run again.                                                 |
| `20261022140200_district_barrier_lifts_on_renewal`  | 8    | After 130300.                                                                          |
| `20261022140300_student_provision_intent_window`    | 9    | No constraint.                                                                         |
| `20261022140400_student_provision_intent_proven`    | 18   | **Before the new `delete-account`**, which calls `student_provision_intents_proven()`. |
| `20261022140500_thumbnail_publish_lock_order`       | 11   | No constraint.                                                                         |
| `20261022140600_my_storage_usage`                   | 12   | With or before the new frontend; without it the message has no figures.                |
| `20261022140700_clear_stale_code_reset_markers`     | 14   | No constraint. Run by hand.                                                            |
| `20261022140800_student_email_reset_fence`          | 15   | **Before the new `student-provision`**.                                                |
| `20261022140900_end_student_sessions_lock_order`    | 17   | No constraint.                                                                         |
| `20261022141000_sweep_stale_account_deletions`      | 20   | No constraint. Not scheduled.                                                          |

DEPLOY.md's go-live batch 3 (`supabase db push`) picks them all up. It now has an 11-row check for them, and step 12's order (migrations first, `student-provision` first) gives all three constraints. `retention_district_run()` stays unscheduled. Edge functions to redeploy: `student-claim`, `student-provision`, `delete-account`, plus the frontend.

## Proofs

**12 new SQL proofs, 136 checks.** Each runs in CI's every-proof loop by being in `tests/sql/`:

| Proof                                          | Checks | Fails before the fix                               |
| ---------------------------------------------- | ------ | -------------------------------------------------- |
| `district_retention_overlapping_restores.sql`  | 13     | 4 of 13 with 130400's run                          |
| `district_retention_detach_kept.sql`           | 10     | 4 of 10 with 140000's run                          |
| `district_barrier_lifts_on_renewal.sql`        | 12     | 6 of 12 with 130300's function                     |
| `student_provision_intent_window.sql`          | 14     | 3 of the first 8 with 110600's function            |
| `superseded_studio_rotation.sql`               | 10     | n/a (verification; no change needed)               |
| `thumbnail_publish_lock_order.sql` (dblink)    | 11     | `deadlock detected`; the held-row publish waited   |
| `my_storage_usage.sql`                         | 6      | 5 of 6 without the function                        |
| `content_strikes_grants.sql`                   | 11     | n/a (audit; no gap)                                |
| `clear_stale_code_reset_markers.sql`           | 11     | does not run without the function                  |
| `student_email_reset_fence.sql`                | 12     | does not run without the function                  |
| `end_student_sessions_lock_order.sql` (dblink) | 6      | `deadlock detected` with 20261020150100's function |
| `sweep_stale_account_deletions.sql`            | 10     | n/a (new function)                                 |

**Existing proofs:** all 54 that were on dev still pass (66 proofs, 2,469 checks in all on the final local run). One existing check changed: `storage_quota_lock_and_cover_reuse.sql` check 36 pinned the old publish lock order by function text, and now pins the new one (item 11).

**New and changed vitest tests:** `studentClaim.test.ts` (throwing lookup), `exportAnnotations.test.ts` (+3), `SignedOutInkNotice.test.tsx` (+1), `documentsService.test.ts` (+2), `realtimeChannel.test.ts` (+3), `liveTestsCleanup.test.ts` (new, 4), `storageUpload.test.ts` (rewritten, 7), `accountDeletion.test.ts` (+2), `rosterService.test.ts` (+1), `studentResetWiring.test.ts` (+3). Also `ShareExportMenu*.test.tsx`, `studentAccountMail.test.ts`, `studentSessions.test.ts` and `deletionPendingWiring.test.ts` were updated to the new call shapes.

## Local checks (final head)

All on the local stack (`npm run cloud:up`). Never against hosted Supabase.

- `npm run lint:check`: pass.
- `npm run typecheck`: pass.
- `npm run test`: **243 files passed, 6 skipped; 3,793 tests passed, 20 skipped, 0 failed.** At the start it was 242 files and 3,773 tests, with `syncEngine` failing once `.env.local` existed (item 5).
- `npm run build`: pass.
- `deno check --config supabase/functions/deno.json supabase/functions/*/index.ts` (Deno 2.1.4, CI's version, installed in the scratchpad): pass, 23 entry points. CI runs no `deno test`.
- CI's re-apply step, run locally: the 5 cancel-link migrations and the 39 from `20261022100000` on all re-apply cleanly.
- The local-stack API tests CI runs (`cancelLinkStore.test.ts`, `storageLifecycle.test.ts`): 13/13.
- Every SQL proof after the replay: **66 of 66 OK, 2,469 checks, 0 failing.**

## CI on the final head

Head `fb91497a304c80ebbebafec323ba99891b15a053`. Two runs of the `CI` workflow, both completed: **39853391553** (push) and **39853397051** (pull_request). **Every check is green.**

| Check                                                                  | push run 39853391553       | pull_request run 39853397051 |
| ---------------------------------------------------------------------- | -------------------------- | ---------------------------- |
| checks (audit, lint, typecheck, test, build)                           | success (job 120085197054) | success (job 120085219215)   |
| supabase-local (replay, store test, Storage API test, every SQL proof) | success (job 120085197173) | success (job 120085219225)   |
| edge-functions-deno                                                    | success (job 120085197171) | success (job 120085218846)   |
| omr-service                                                            | success (job 120085196598) | success (job 120085219255)   |
| supabase-drift                                                         | success (job 120085197211) | success (job 120085219429)   |

Other checks on the head:

- Vercel commit status: **success**, "Deployment has completed" (`https://vercel.com/maxs-projectsd/cleffy/2yR1s8fTmojiSCFS8CiZZGmL2hmA`). It was not rate limited, and no action was taken on Vercel.
- Vercel Preview Comments (check run 120085576030): success.
- Supabase Preview (check run 120085189093): skipped, as on the other launch-fix PRs.

**Earlier red, now fixed:** on `67f7f02` (runs 39850980210 and 39850986902), `supabase-local` failed in the re-apply step: `20261022110600.sql:242: ERROR: cannot change return type of existing function`. My `20261022140400` had changed `student_provision_intents_for()`'s result type, and item 4's replay re-applies `110600` after it. Fixed in `fb91497` (see item 4 and item 18). That replay would also have run the proofs against P1's publish trigger instead of `140500`'s. The local suite had missed it because my local proof runs did not repeat CI's replay; from `fb91497` on they do.

## Open questions and decisions needed

1. **Item 16:** the per-writer lifecycle policy above.
2. **Item 20 scope:** decision 49(6) names the stale `account_deletions` sweep, and that is what I built. P6's DEPLOY.md also calls "a scheduled sweep for orphaned provisioning cases 1 to 3" a 49(6) follow-up. Is that one wanted too? It is not small: it needs a scheduled Edge Function, because SQL cannot delete Storage objects or Auth users.
3. **Item 3 interpretation:** leaving a shared score yourself (Remove from my library, or Leave in the share dialog) keeps the held ink for Export or Discard, like losing access. Only deleting your own score drops it. OK? Also, a share-link guest who lost access can export it as a photo but not as a PDF, since their PDF claim names the score's owner.
4. **Item 11 behaviour change:** a publish whose object row another writer holds is now refused at once (`thumbnail_folder_busy`, retried by a later session) instead of waiting. OK?
5. **Item 15 copy:** the new email-reset failure wording ("…no new link was sent…"). OK?
6. **Item 6 residual:** a district that begins listing a moved student only after the hand-on lock was taken (two runs at once) is not handed the restore. That was the old behaviour.
7. **CI replay scope (item 4):** the step now replays every migration from P1 on, not just P1 and P3. It is the only way the proofs see the latest definitions after a replay. Confirm this is wanted.
8. Not done here, and noted only: `migrations_ordered_replay.sql`'s hand-written list still ends at P5 (from the P5 rebase report).

## Couldn't do

- Item 16, as above.
- `gh` was unusable (invalid token in the container). The GitHub MCP tools were used for the PR and CI.

## Hosted steps left for Max (none performed)

- When #72 merges and at go-live: apply the 11 migrations with batch 3 (the 11-row check is in DEPLOY.md). Deploy `student-provision` after `20261022140800` (step 12 already deploys it first), `delete-account` after `20261022140400`, and the frontend with or after `20261022140600`. Also deploy `student-claim`.
- Optional, any time after: `select public.clear_stale_code_reset_markers();`. To run the stale-deletion sweep daily: `select cron.schedule('account-deletions-sweep', '41 4 * * *', $$select public.sweep_stale_account_deletions()$$);`, then add it to step 13.4's expected list.
- Nothing hosted was touched: no hosted Supabase (prod or dev), Vercel or Stripe. No key, token or secret was printed or committed. `.env.local` (written by `cloud:up`) was never committed.

## Environment and housekeeping

- Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2`, not Sandbox.
- Local stack only (`npm run cloud:up`). `npm run cloud:down` was run at the end ("Stopped supabase local development setup."; no supabase containers left).
- No messages were sent to any session or agent, and no handoff. No Codex review was requested or run. PR #54 and every other PR and branch were left untouched.
- Deletions were limited to scratchpad files.
