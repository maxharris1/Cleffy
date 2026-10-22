# Cleffy launchfix rebase pass: PR #70 (P3) onto dev

**Status:** Complete

- Starting head (PR #70): `988926240378f2af41f04424cda5f7f48e82b748` (Codex SHIP)
- Rebased onto origin/dev: `e55a148da3b0efe3c8ba117975eea5cc94199a9b` (Merge PR #68; #69 merged at 937c915b is its ancestor)
- **New PR #70 head:** `7c4515f97816076461a66c9e4c989b8dd78bc675`
- Environment: Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (`anthropic_cloud`), **not Sandbox** (confirmed with `get_session` at the start)
- PR #70 is still a **draft** with base **dev**. Its title and body were not edited, and no PR was opened.

## Pre-flight

- `git fetch origin && git checkout -B mh/launchfix-p3-edge-hardening origin/mh/launchfix-p3-edge-hardening`: HEAD = `988926240378f2af41f04424cda5f7f48e82b748` ✔
- origin/dev = `e55a148da3b0efe3c8ba117975eea5cc94199a9b` (the expected SHA; `937c915b` is an ancestor) ✔
- Commit identity set: `Max Harris <drumaxter@gmail.com>`. All 23 commits on the new branch have Max Harris as author and committer.

## Push

```
git push --force-with-lease=mh/launchfix-p3-edge-hardening:988926240378f2af41f04424cda5f7f48e82b748 origin HEAD:mh/launchfix-p3-edge-hardening
 + 9889262...7c4515f HEAD -> mh/launchfix-p3-edge-hardening (forced update)
```

**The lease held.** This was the only non-fast-forward push. No other pushes were made to the PR branch: the one fix-up commit (below) was in the same lease push, and CI needed no further fix-ups.

## Conflicts and how each was resolved

`git rebase origin/dev` replayed 22 commits. Only four files were touched by both P3 and dev: `.github/workflows/ci.yml`, `scripts/apply-migrations.sql`, `tests/migrationRecoverability.test.ts` and `tests/sql/README.md`.

| Replayed commit                                                             | File                           | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dcce6f9 student-claim reservation                                           | `scripts/apply-migrations.sql` | Generated file: regenerated with `npm run migrations:mirror`, not edited by hand. Later commits merged it cleanly, and the final tree regenerates to the identical file.                                                                                                                                                                                                                                                                                                                                                              |
| e5f6665 deletion pending                                                    | `tests/sql/README.md`          | Dev (P1) had appended `## Launchfix P1: DB release safety` and `## In CI` where P3 appended its proof paragraphs. Resolution: P1's section, then a new heading `## Launchfix P3: edge hardening` holding P3's paragraphs verbatim, then dev's `## In CI` unchanged. The heading is the only new text.                                                                                                                                                                                                                                 |
| 3bf77b4 inbound lease                                                       | `tests/sql/README.md`          | P3's paragraph appended to the P3 section, before `## In CI`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 1c9e851 review races                                                        | `tests/sql/README.md`          | P3's rewritten paragraphs taken. Dev's `## In CI` kept after them. The script that resolved this checked that HEAD's text before `## In CI` was exactly the base, so nothing of dev's was dropped.                                                                                                                                                                                                                                                                                                                                    |
| 8e93354 "ci: run the three P3 SQL proofs; pin the OMR base image by digest" | `.github/workflows/ci.yml`     | **Took dev's file unchanged.** P3's edit only added `support_inbound_lease student_claim_reservation account_deletion_pending` to the old explicit proof list and renamed that step. That step no longer exists: P1's `SQL proofs (tests/sql/*.sql …)` step runs every `tests/sql/*.sql`, so all three P3 proofs run and block, with no ci.yml change. The commit keeps its OMR Dockerfile digest pin and `omrDockerfilePins.test.ts`. Its subject line still says "run the three P3 SQL proofs" (commit messages left as they were). |
| c07fc11 fix-round proof coverage                                            | `tests/sql/README.md`          | Same as 1c9e851: P3's text change, with dev's `## In CI` after it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

`tests/migrationRecoverability.test.ts` merged without a conflict. P3's `support-inbound-retry` cron-job entry sits next to dev's entries.

### ci.yml relative to dev

`git diff origin/dev 7c4515f -- .github/workflows/ci.yml` is **dev's file plus exactly one new job appended at the end**, `edge-functions-deno`, in its final form from 9889262:

```yaml
edge-functions-deno:
    runs-on: ubuntu-latest
    steps:
        - uses: actions/checkout@v4
        - uses: denoland/setup-deno@v2
          with:
              deno-version: v2.1.4
        - name: deno check the Edge Function entry points
          run: deno check --config supabase/functions/deno.json supabase/functions/*/index.ts
```

It also keeps its 7-line explanatory comment. Nothing else from P3's old ci.yml was re-added: the explicit proof list is covered by dev's every-proof loop. P3 does not add itself to dev's "Re-apply the cancel-link and launchfix P1 migrations" step, and never had a re-apply step of its own, so nothing was added there.

### Every other P3 file is byte-identical

Of the 77 files P3 changes, every file except the four above has the same blob at `7c4515f` as at `98892624`. The fix-up commit below then changes one P3 file, `tests/sql/account_deletion_pending.sql`.

## Range-diff (`git range-diff origin/dev 988926240378f2af41f04424cda5f7f48e82b748 7c4515f`)

```
 1:  872009c =  1:  9075926 fix(sync): bound live-ink batches, strokes, peers and stroke lifetime
 2:  5f9423b =  2:  ffd6ee7 fix(omr): pin Audiveris and tessdata downloads by SHA-256
 3:  98b630a =  3:  0b67628 fix(edge): cap every request body as it streams
 4:  dcce6f9 !  4:  eae1f6a fix(student-claim): reserve the card before any password write
 5:  e5f6665 !  5:  26ab452 fix(delete-account): mark the deletion pending before anything else
 6:  3bf77b4 !  6:  089c19a fix(resend-inbound): lease, dedup, budget and deferral for inbound mail
 7:  7b9fd9d =  7:  8ddc25c test(migrations): register the support-inbound-retry cron job
 8:  1c9e851 !  8:  a78a73e fix(p3): close the races a review of this branch found
 9:  8e93354 !  9:  6bb2856 ci: run the three P3 SQL proofs; pin the OMR base image by digest
10:  16fb657 = 10:  27b96f4 fix(resend-inbound): own budget, reserve every attempt, stop retries at 23 h
11:  32fa8ba = 11:  ce7b51a fix(delete-account): active attempts, a destructive-cleanup flag and a lease
12:  4acedc1 = 12:  c85901f fix(student-provision): resets carry a holder token; a live reset is never taken over
13:  9fefe39 = 13:  4213bfd fix(student-provision): budget student invitations and reset links
14:  9238059 = 14:  4d3ad0d fix(delete-account): extend the deletion barrier to uploads, provisioning, checkout and joins
15:  c07fc11 ! 15:  5fbcff0 test(sql): describe the P3 fix-round proof coverage; widen a source-guard window
16:  5689742 = 16:  4a9b25f fix(student-provision): a fresh worker lease per reset attempt, fenced before each Auth write
17:  6bfa8a3 = 17:  23a5e76 ci: deno check the Edge Function entry points without node_modules
18:  ad0e63a = 18:  884b9b9 fix(moderation): no fixed deadline in the queued-report copy; accurate starvation comments
19:  7565f49 = 19:  2a2cf6a fix(edge): service-role writers ask account_deletion_pending() before they write
20:  dca8348 = 20:  30dc949 test(account): pin the try-again message for a deletion refused during checkout
21:  48aa965 = 21:  287d05a fix(student-provision): quarantine a reset whose Auth write may still land; deletion checks answer 503
22:  9889262 = 22:  d4bfd1e ci: deno check score-analyze too, now that its client type checks
 -:  ------- > 23:  7c4515f test(sql): account_deletion_pending uploads only names 20261022100400 allows
```

Commits marked `!` differ only as follows:

- **4 (dcce6f9 → eae1f6a)** and **8 (1c9e851 → a78a73e)**: `scripts/apply-migrations.sql` hunk context (the mirror now holds P1's migrations ahead of P3's).
- **5, 6, 8, 15** (e5f6665, 3bf77b4, 1c9e851, c07fc11): `tests/sql/README.md` placement under `## Launchfix P3: edge hardening`, ahead of dev's `## In CI` (see above). The P3 wording is unchanged.
- **9 (8e93354 → 6bb2856)**: the `ci.yml` hunk is dropped (see above). The Dockerfile pin and its test are unchanged.
- **23 (new) 7c4515f**: the fix-up below.

No commit's code (Edge Functions, migrations, src, tests other than the fix-up) differs from 98892624.

## Fix-up commit

- `7c4515f97816076461a66c9e4c989b8dd78bc675` test(sql): account_deletion_pending uploads only names 20261022100400 allows.
    - **Why:** once rebased, `tests/sql/account_deletion_pending.sql` failed check **71** ("before the deletion the owner can upload into their score"). The error was 42501 from P1's `scores_object_name_insert` policy (`20261022100400_storage_object_names.sql`), which allows only `{id}/original.pdf` and `{id}/pre-import-original.pdf` in `scores`. The proof uploaded `{id}/extra.pdf`.
    - Check **73** still "passed", but only because P1's name rule refused `late.pdf`. P3's deletion barrier never decided it.
    - **Change (test fixture only, no behaviour change):** 71 uploads `{301}/pre-import-original.pdf`. 73 uploads `{303}/original.pdf` into a second, file-less score of the same owner, created silently in the fixture so the check count stays 89.
    - **Now:** 71 passes, and 73 is refused by `storage_refuse_during_account_deletion_insert`, the barrier policy. All 89 checks pass, matching the README's count.
    - **Timing:** made before the lease push, so it went up in the same push. Local checks were re-run after it.

## Migrations

Final order of the 2026-10-22 migrations: P1's (dev) come first, then P3's in its own `2026102211xxxx` range. There is no interleaving and no timestamp clash.

```
20261022100000_explicit_service_role_grants        (P1)
20261022100100_billing_lock_tables_client_revoke   (P1)
20261022100200_deployment_config                   (P1)
20261022100300_one_studio_per_owner                (P1)
20261022100400_storage_object_names                (P1)
20261022100500_storage_bucket_limits               (P1)
20261022100600_superseded_studio_followups         (P1)
20261022100700_client_table_privileges             (P1)
20261022100800_storage_quota_and_thumbnail_lifecycle (P1)
20261022100900_storage_cleanup_markers_and_thumbnail_cap (P1)
20261022101000_storage_quota_lock_and_cover_reuse  (P1)
20261022110000_student_claim_reservation           (P3)
20261022110100_account_deletion_pending            (P3)
20261022110200_support_inbound_lease               (P3)
20261022110300_support_inbound_retry_window        (P3)
20261022110400_account_deletion_attempts           (P3)
20261022110500_student_code_reset_holder           (P3)
20261022110600_account_deletion_barrier            (P3)
20261022110700_student_code_reset_worker           (P3)
20261022110800_student_code_reset_quarantine       (P3)
```

- `npm run migrations:mirror` on the final tree: **no change**. `scripts/apply-migrations.sql` is committed in its regenerated form.
- **supabase-drift:** green on the new head (see CI). That job compares the branch with the live project and only reads.
- On the local stack: 116 migration files, 116 rows in `supabase_migrations.schema_migrations`, max version `20261022110800`.

## SQL proofs (local stack only, run the way CI runs them)

Setup:

- `npm run cloud:up` brought up local Supabase with all migrations, then `npx supabase db reset` gave a fresh database. The Realtime container was running and today's `realtime.messages` partition existed.
- The cancel-link and P1 migrations were re-applied with `psql -v ON_ERROR_STOP=1`, exactly as CI's "Re-apply" step does. All re-applied cleanly.
- `bash scripts/ci/sql-proof.sh "$DB_URL" <proof>` then ran for every `tests/sql/*.sql` and `supabase/sql-tests/sharing_access_control.sql`.

**43 / 43 proofs pass, 0 fail.**

P1's three previously stale proofs:

- `tests/sql/billing_double_charge.sql`: **PASS**, 98 checks
- `tests/sql/district_read_only_seats.sql`: **PASS**, 68 checks
- `tests/sql/student_access_revocation.sql`: **PASS**, 44 checks

P3's proofs:

- `support_inbound_lease.sql`: PASS, 58
- `student_claim_reservation.sql`: PASS, 125
- `account_deletion_pending.sql`: PASS, 89 (after the fix-up; before it, 88/89 with check 71 failing, see above)

All proofs:

```
OK tests/sql/account_deletion_pending.sql: 89 checks passed
OK tests/sql/annotation_payload_shape.sql: 57 checks passed
OK tests/sql/archived_student_password.sql: 13 checks passed
OK tests/sql/billing_double_charge.sql: 98 checks passed
OK tests/sql/billing_export_claims.sql: 35 checks passed
OK tests/sql/cancel_link_consume_db_clock.sql: 36 checks passed
OK tests/sql/cancel_link_db_clock.sql: 21 checks passed
OK tests/sql/cancel_link_lifetime.sql: 57 checks passed
OK tests/sql/cancel_link_read_db_clock.sql: 10 checks passed
OK tests/sql/cancel_link_save_after_insert.sql: 12 checks passed
OK tests/sql/cancel_link_tombstone_race.sql: 25 checks passed
OK tests/sql/cancel_link_tombstones.sql: 38 checks passed
OK tests/sql/checkout_consents.sql: 25 checks passed
OK tests/sql/column_integrity.sql: 113 checks passed
OK tests/sql/content_moderation.sql: 99 checks passed
OK tests/sql/cross_branch_integration.sql: 39 checks passed
OK tests/sql/deployment_config.sql: 34 checks passed
OK tests/sql/district_billing_canonical.sql: 12 checks passed
OK tests/sql/district_migrations_rerunnable.sql: 20 checks passed
OK tests/sql/district_read_only_seats.sql: 68 checks passed
OK tests/sql/district_retention.sql: 28 checks passed
OK tests/sql/district_seat_cap.sql: 192 checks passed
OK tests/sql/district_seats.sql: 58 checks passed
OK tests/sql/district_student_scope.sql: 47 checks passed
OK tests/sql/edge_rate_limit_refund.sql: 10 checks passed
OK tests/sql/explicit_grants.sql: 22 checks passed
OK tests/sql/guest_email_verification.sql: 53 checks passed
OK tests/sql/launch_checkout_fixes.sql: 46 checks passed
OK tests/sql/launch_consent.sql: 43 checks passed
OK tests/sql/one_studio_per_owner.sql: 30 checks passed
OK tests/sql/qa3_cross_branch.sql: 12 checks passed
OK tests/sql/share_link_errors.sql: 26 checks passed
OK tests/sql/storage_cleanup_and_thumbnail_cap.sql: 58 checks passed
OK tests/sql/storage_name_limits.sql: 32 checks passed
OK tests/sql/storage_quota.sql: 63 checks passed
OK tests/sql/storage_quota_lock_and_cover_reuse.sql: 45 checks passed
OK tests/sql/storage_quota_lock_concurrency.sql: 26 checks passed
OK tests/sql/storage_thumbnail_concurrency.sql: 18 checks passed
OK tests/sql/student_access_revocation.sql: 44 checks passed
OK tests/sql/student_claim_reservation.sql: 125 checks passed
OK tests/sql/superseded_studio_members.sql: 20 checks passed
OK tests/sql/support_inbound_lease.sql: 58 checks passed
OK supabase/sql-tests/sharing_access_control.sql: 94 checks passed
```

CI's two local-DB vitest steps were run the same way against the local stack:

- `tests/billing/cancelLinkStore.test.ts`: 8 passed
- `tests/storage/storageLifecycle.test.ts`: 5 passed

## Local checks on the final head (7c4515f)

These ran in a clean worktree of 7c4515f, which has no `.env.local`, like CI (see the note below).

| Check                                                                                                                                              | Result                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run lint:check`                                                                                                                               | pass                                                                          |
| `npm run typecheck`                                                                                                                                | pass                                                                          |
| `npm test`                                                                                                                                         | pass: 237 files passed, 6 skipped (243); 3690 tests passed, 18 skipped (3708) |
| `npm run build`                                                                                                                                    | pass                                                                          |
| `deno check --config supabase/functions/deno.json supabase/functions/*/index.ts` (Deno 2.1.4)                                                      | pass, all 23 entry points, score-analyze included                             |
| `npx prettier --check` on the conflict-resolved files (`tests/sql/README.md`, `.github/workflows/ci.yml`, `tests/migrationRecoverability.test.ts`) | pass                                                                          |

`scripts/apply-migrations.sql` and the fix-up's `.sql` file have no Prettier parser. The first is generated.

**Note on `.env.local`:**

- In the main checkout, after `npm run cloud:up` wrote `.env.local`, `src/sync/syncEngine.test.ts > SyncEngine throttling and backoff > backs off exponentially with jitter, capped at a minute` failed every time.
- The cause is the environment, not the rebase: **origin/dev fails the same test once `.env.local` is copied in**, and passes without it. The rebased head passes without it.
- CI has no `.env.local`.
- Two other one-off failures (`turnstileField.test.tsx`, `RosterPage.test.tsx`) happened while the stack was booting in parallel. They passed on re-run and in the clean full run.
- This is listed under follow-ups.

## CI on the final head (7c4515f)

Two workflow runs of `CI` on `7c4515f97816076461a66c9e4c989b8dd78bc675`: run **39790749810** (push) and run **39790755745** (pull_request). PR #70: draft, base dev, mergeable state **clean**.

| Check                                                          | push run 39790749810                                                                                                             | pull_request run 39790755745  |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| checks (audit, lint, typecheck, test, build)                   | ✅ success (job 119865817736)                                                                                                    | ✅ success (job 119865837181) |
| supabase-local (store test, Storage API test, every SQL proof) | ✅ success (job 119865818005)                                                                                                    | ✅ success (job 119865837203) |
| omr-service                                                    | ✅ success (job 119865817887)                                                                                                    | ✅ success (job 119865836941) |
| edge-functions-deno                                            | ✅ success (job 119865817888)                                                                                                    | ✅ success (job 119865836704) |
| supabase-drift                                                 | ✅ success (job 119865817386): "clean: this branch and the live project agree." (it really compared; not the inert warning path) | ✅ success (job 119865836205) |

Other checks on the head: **Vercel Preview Comments**, success. **Supabase Preview**, skipped (as on earlier heads). There is no Claude Approvals check on this repo. CI went green on the first run, so no CI fix-up commits were needed.

## Follow-ups (not done here; out of scope per the packet)

- The **student-claim `managed_students` lookup throw** (deferred minor), for the separate post-launch-fix PR.
- The deferred minors and follow-ups already listed in PR #70's body:
    - the email reset path is unfenced
    - `stripe-webhook`, `billing-cancel` and the queue/cache writers have no deletion check
    - OMR apt packages are unpinned
    - raise `studentAccountMail` before the first district contract
- `src/sync/syncEngine.test.ts` "backs off exponentially…" fails when a developer's `.env.local` (written by `npm run cloud:up` / `local:up`) is present. This happens on dev too. The test should not depend on local env.
- Commit 6bb2856 (formerly 8e93354) is still titled "ci: run the three P3 SQL proofs; …" although it no longer touches ci.yml. History was left as is.

## Open questions

- **PR #70's body is now stale in two places,** and this session must not edit it:
    - It says `supabase-local` runs the P3 proofs "alongside the nine existing proofs". They now run in P1's every-proof loop, with all 43 proofs.
    - It still flags "**Flag for the P1 rebase**", which is now done.

    Max may want to update the body (it is left as it was).

- Should P3's migrations be added to CI's "Re-apply the cancel-link and launchfix P1 migrations" step (a replay-recoverability check like P1's)? P3 never had one, and the instructions said to re-add nothing beyond the deno job, so none was added.

## Hosted steps left for Max (none performed)

Unchanged from PR #70's body:

- Apply the migrations in order. Apply 110700/110800 and deploy `student-provision` back to back inside the maintenance freeze.
- Set the Edge secret `SUPPORT_RETRY_SECRET` and the Vault secrets `support_inbound_url` / `support_inbound_secret`.
- Deploy `resend-inbound`, `delete-account`, `student-provision`, `stripe-checkout`, `student-claim`, `imslp-download`, `score-analyze` (plus the body-cap changes) after the migrations.
- Add the P6 runbook entries.
- Run the live HTTP smoke tests (P6).
- Merging stays with Grok Bot / Max. This session merged nothing and pushed nothing to dev or main.

## Environment and housekeeping

- Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2`, not Sandbox.
- Local stack only. No hosted Supabase, Vercel or Stripe was touched, and no secrets were printed or committed.
- `npm run cloud:down` was run at the end. It reported "Stopped supabase local development setup", and no supabase containers remain.
- No messages were sent to any session or agent. Coordination is through git only.
- Branches touched: `mh/launchfix-p3-edge-hardening` (one lease push), and `claude/launchfix-rebase-p3-report`, which is this report and is created from the final PR head with one extra commit.
