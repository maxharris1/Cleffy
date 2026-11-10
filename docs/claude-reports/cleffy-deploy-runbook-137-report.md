**Status:** Complete
PR: https://github.com/maxharris1/Cleffy/pull/92 · head `701019a80777284d557093b3fef86eace789d077`

# DEPLOY.md go-live runbook to 137 migrations (tag cleffy-deploy-runbook-137)

Branch `mh/deploy-runbook-137` from `origin/dev` `b768be1`. Docs only: one file, `DEPLOY.md`.
`scripts/apply-migrations.sql` needed no change: `npm run migrations:mirror` regenerated it with an
empty diff. Nothing touched hosted Supabase or Stripe.

## Counts, old vs new

| What                                                    | Runbook said (`d387b69f`) | Now (`dev` `b768be1`)                                                    |
| ------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------ |
| Migrations on `dev` (`ls supabase/migrations \| wc -l`) | 124                       | **137**                                                                  |
| Migrations on `main` (`cf1e968`)                        | 26                        | 26 (an unchanged prefix of `dev`'s; the diff is 111 additions, `A` only) |
| Pushed by hand in step 11                               | 98 (implied)              | **111**                                                                  |
| Step 11 batches                                         | 4 / 60 / 34               | **4 / 60 / 47** (staged counts 30 and 90 unchanged)                      |
| Edge Functions on `dev` / `main`                        | 23 / 13                   | 23 / 13 (unchanged)                                                      |
| Cron jobs (`cron.schedule` in migrations)               | 12                        | **12** (raw `git grep` prints 14 lines: 2 are commented-out examples)    |

## Batch placement for the 14 files at or after `20261022130400`

Batch boundaries are set by the cron jobs that must be paused right after the batch that schedules
them (batch 1 ends at `imslp-sync`, batch 2 at the five `retention-*` jobs). None of these 14
schedules a job, and all sort after `20261021120300`, so all go in **batch 3**. Nothing moves a
boundary.

| Migration                                           | Batch | Special handling                                                                                                                                                                          |
| --------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261022130400_district_retention_moveout_locks`   | 3     | Already in the runbook (P5): `55P03 district_busy`/`40001` refusals; before `student-provision`.                                                                                          |
| `20261022140000_district_retention_restore_hand_on` | 3     | Function replacements; no table, no cron.                                                                                                                                                 |
| `20261022140100_district_retention_detach_kept`     | 3     | Function replacements.                                                                                                                                                                    |
| `20261022140200_district_barrier_lifts_on_renewal`  | 3     | Function replacements.                                                                                                                                                                    |
| `20261022140300_student_provision_intent_window`    | 3     | Function replacements.                                                                                                                                                                    |
| `20261022140400_student_provision_intent_proven`    | 3     | Before the new `delete-account` (already in the runbook).                                                                                                                                 |
| `20261022140500_thumbnail_publish_lock_order`       | 3     | **Lock:** takes a `storage.objects` row `FOR KEY SHARE NOWAIT` in a security-definer function, which needs `UPDATE` on `storage.objects`. Added to the step 4 and step 11 preflight text. |
| `20261022140600_my_storage_usage`                   | 3     | With or before the new frontend (already in the runbook).                                                                                                                                 |
| `20261022140700_clear_stale_code_reset_markers`     | 3     | Defines a function you run by hand; no backfill runs at apply.                                                                                                                            |
| `20261022140800_student_email_reset_fence`          | 3     | Before the new `student-provision` (already in the runbook).                                                                                                                              |
| `20261022140900_end_student_sessions_lock_order`    | 3     | Function replacement (lock order).                                                                                                                                                        |
| `20261022141000_sweep_stale_account_deletions`      | 3     | Prints a commented-out `account-deletions-sweep` example only; the job stays unscheduled (Recovery runbooks).                                                                             |
| `20261022160000_cancel_link_release_for_deletion`   | 3     | Nullable `add column` on `billing_cancel_tokens` (empty after the wipe); before `billing-cancel`. New version check added.                                                                |
| `20261028120000_imslp_shared_pdf_cache`             | 3     | **New note in step 11.3**, covered below.                                                                                                                                                 |

The 13 after `130400` add **no data backfill** (no top-level `insert`/`update`/`delete`).

`20261028120000_imslp_shared_pdf_cache` covers:

- **`storage.objects`.** It adds 4 policies there: 1 permissive select and 3 restrictive, for select, update and delete. `main`'s `20260801160754_rls.sql` already creates policies there, so step 8's reset proves the privilege. Its RPCs read `storage.objects` and lock no row of it.
- **Locks.** It replaces `documents_storage_path_derived` and adds `documents_cache_folder_reserved` (`ACCESS EXCLUSIVE` on `documents`, checking every row). It also adds a plain partial index on `documents.storage_path`, and triggers on `documents` and `content_takedowns`. All of this is instant on the empty post-wipe table, inside the freeze.
- **Deploy order.** It goes before the new `imslp-download`, which otherwise answers `503 Could not check import permissions` because `can_import_imslp` is missing. It also goes before the new frontend, which calls `commit_pdf_replacement`. Step 12 and step 16 already give that order.
- **Copyright blocks.** A copyright takedown blocks the shared file in every library, and lifting the takedown does not clear the block. Step 18's moderation test now uses an uploaded score.
- **Tables.** `imslp_pdf_cache` and `imslp_pdf_claims` are added to step 13.3's `server_only` grants list.
- **Version check.** A new check for `20261022160000` and `20261028120000` is added to step 11.3.
- **Smoke test.** A shared-cache check is added to step 18's IMSLP smoke test.

## Cron list at `b768be1` (12)

`git grep -n "cron.schedule" b768be1 -- supabase/migrations`

| Job                            | Schedule         | Migration        | Batch         | State after step 11 |
| ------------------------------ | ---------------- | ---------------- | ------------- | ------------------- |
| `omr-sweep`                    | `* * * * *`      | `20260806140000` | main (step 8) | active              |
| `imslp-sync`                   | `*/2 * * * *`    | `20260902120000` | 1             | paused              |
| `content-notice-retry`         | `*/5 * * * *`    | `20261020150000` | 2             | active              |
| `billing-mail-outbox`          | `* * * * *`      | `20261020160200` | 2             | active              |
| `district-seat-reconcile`      | `41 * * * *`     | `20261020180500` | 2             | active              |
| `retention-archived-students`  | `17 3 * * *`     | `20261021120300` | 2             | paused              |
| `retention-stale-guests`       | `27 3 * * *`     | `20261021120300` | 2             | paused              |
| `retention-rate-limits`        | `37 3 * * *`     | `20261021120300` | 2             | paused              |
| `retention-support-messages`   | `47 3 * * *`     | `20261021120300` | 2             | paused              |
| `retention-compact-tombstones` | `23 4 * * 0`     | `20261021120300` | 2             | paused              |
| `support-inbound-retry`        | `2-59/5 * * * *` | `20261022110200` | 3             | active              |
| `retention-content-strikes`    | `7 4 * * *`      | `20261022130100` | 3             | paused              |

Commented-out, not scheduled: `retention-district` (`20261021120700`) and `account-deletions-sweep`
(`20261022141000`). Step 11 and step 13.4's expected list do not change.

## Verification

- I ran a local Supabase stack at `b768be1` with all 137 migrations applied (`schema_migrations`: 137 rows, max `20261028120000`).
    - `cron.job` has the 12 jobs above.
    - Step 13.3's grants check with the two new tables returned **0 rows**.
    - A negative control (`grant select on imslp_pdf_claims to anon`, rolled back) reported exactly that grant.
    - Step 13.4's cron check returned **0 rows** after pausing `imslp-sync` and the 6 `retention-*` jobs (rolled back).
    - The 4 `scores_shared_imslp_*` policies exist on `storage.objects`.
    - Step 18's new SQL runs.
- Local commands: `npx prettier --check DEPLOY.md` passed, as did `npm run lint:check`, `npm run typecheck` and `npm run test` (4402 passed, 22 skipped).
- CI on the PR head `701019a`: green. `checks`, `supabase-local`, `supabase-drift`, `edge-functions-deno`, `omr-service` and Vercel Preview Comments succeeded. Supabase Preview was skipped.

## Not done / notes

- Step 9's secrets table ("checked again at `d387b69f`") was not re-audited against functions at
  `b768be1`. That is out of scope for a migrations recount, and the step 1 recount on `GOLIVE_SHA` covers it.
- #54 was not touched. Step 1 still asks for #54's body to be updated with the new counts.
- I could not wake Cleffy from this session (no box access), so this report is in the PR body instead.
