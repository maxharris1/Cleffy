# Cleffy launchfix P6 fix4 report: PR #67 orphaned-provisioning runbook (Codex REVISE on bc070bd)

**Status:** Complete

- Repo: maxharris1/Cleffy, PR #67 (draft, base `dev`, branch `mh/launchfix-p6-golive-docs`). Draft state, base, title and body unchanged.
- Starting head: `bc070bd407bc7e96109f28830ed3263ae78f154c` (bc070bd4), on dev `d387b69f8de13dd468aaa2b6242b4c66685f95ae`. Confirmed at start (local HEAD and `origin/mh/launchfix-p6-golive-docs`) and again right before the push.
- **New PR #67 head: `614824fb759160fc9ffdd0931b3932a3f33a9534` (614824f).**
- Environment: Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (from `get_session`: `environment_id` = env_01WAd3yiz3qpSnsofpyEwCh2, `environment_kind` = anthropic_cloud). Not Sandbox.
- Date: 2026-10-22.

## Push

- `git push origin HEAD:mh/launchfix-p6-golive-docs` → `bc070bd..614824f  HEAD -> mh/launchfix-p6-golive-docs`. Fast-forward (`git merge-base --is-ancestor bc070bd4 HEAD` checked before the push; no force, no rebase, no amend).
- Only one push to the PR branch. This report is on `claude/launchfix-p6-fix4-report` (created from 614824f plus one report commit). No other branch touched.

## Commit

| SHA                                        | Summary                                                                                                  | Files                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `614824fb759160fc9ffdd0931b3932a3f33a9534` | docs(deploy): orphaned provisioning runbook needs provisioning proof, cleans document-id Storage folders | `DEPLOY.md` only (+141 / −34) |

Author and committer: Max Harris <drumaxter@gmail.com>. `git show --stat 614824f` lists DEPLOY.md only. No SQL, migration, function, code, test, script, ci.yml, .env.example or SETUP_SUPABASE.md change. All edits are inside "Recovery runbooks" → "Orphaned student provisioning accounts" (DEPLOY.md:2171-2339 at 614824f); nothing else in the doc moved or was renumbered (the section's own case list went from 5 to 6 items: a new case 5 "No proof", old case 5 "teacher_exists is false" is now case 6; only in-section references to those numbers changed).

## The three fixes (line numbers at 614824f)

### MAJOR 1: no deletion on the email fallback alone (was DEPLOY.md:2218, case 4)

- Find query, DEPLOY.md:2183-2202. It no longer calls `student_provision_intents_for()`. It reads `public.student_provision_intents` directly and puts the two accounts in **separate columns**:

    ```sql
    select i.roster_id, i.teacher_id, i.auth_email, i.created_at, i.expires_at,
           exists (select 1 from auth.users t where t.id = i.teacher_id) as teacher_exists,
           i.student_user_id as recorded_user_id,
           r.id is not null as recorded_account_exists,
           r.created_at between i.created_at - interval '1 minute' and i.expires_at as recorded_in_window,
           c.id as email_candidate_id,
           c.created_at as email_candidate_created_at,
           c.created_at between i.created_at - interval '1 minute' and i.expires_at as email_candidate_in_window
    from public.student_provision_intents i
    left join auth.users r on r.id = i.student_user_id
    left join lateral (
        select u.id, u.created_at
        from auth.users u
        where lower(u.email) = i.auth_email
          and u.id is distinct from i.student_user_id
    ) c on true
    where i.expires_at < now()
    order by i.created_at, c.created_at;
    ```

- Column notes, DEPLOY.md:2207-2218 (the fallback has no upper time bound; a candidate is "a lead, never proof"; the window is `[intent.created_at − 1 minute, intent.expires_at]`).
- Per-account inspect query, DEPLOY.md:2220-2229 (`user_type`, `flagged_teacher`, `email_confirmed_at`, `last_sign_in_at`, `has_roster_row`).
- **Provisioning proof**, DEPLOY.md:2231-2248. An account counts as made by this provisioning only if it was created inside the window (`recorded_in_window` / `email_candidate_in_window`) **and** either
    - **(A) recorded:** it is the intent's `student_provision_intents.student_user_id` (`recorded_user_id`), written by `attach_student_provision` right after `student-provision` created the account; or
    - **(B) flagged:** nothing was recorded, it is the email candidate, and `app_metadata` has `user_type = 'student'` and `teacher_id` = the intent's `teacher_id` (admin-only flag, written only by `student-provision`). An unrecorded flagged account is a code student whose request died before the attach.
    - Explicitly **not** proof: a matching address, a candidate created inside the window, null `email_confirmed_at`/`last_sign_in_at` (quote: "each also fits a separate signup at the same address. Without proof (A) or (B), nothing is deleted."). Dev records no other provisioning marker (`code_reset_worker` is the code reset's).
- Dispositions and the proof each relies on:
    - Case 1 (2252-2257) no account / recorded account already gone → finish; deletes nothing; no proof needed.
    - Case 2 (2258-2261) valid roster row confirmed (`managed_students.student_user_id`) → finish; deletes nothing.
    - Case 3 (2262-2309) **proof (A) or (B)** plus the flag for this teacher, no roster row → Storage cleanup, Auth delete, finish.
    - Case 4 (2310-2319) **proof (A)** with no flag (email invite whose flag never landed) → delete only if never signed in/confirmed, or by agreement; or keep and finish.
    - Case 5 (2320-2325) **no proof** (unrecorded unflagged candidate, account outside the window, flagged for another teacher) → "Delete nothing and do not finish the intent: it stays open. Resolve it by hand and escalate to Max with the row and the account's details."
    - Case 6 (2326-2329) teacher deleted → as cases 1 to 5.
- The pre-existing unbounded fallback in `student_provision_intents_for()` is unchanged (no SQL/code change).

### MAJOR 2: Storage by document id, cleanup before finishing (was DEPLOY.md:2212)

- DEPLOY.md:2262-2309 (case 3 steps 1-6). Quote: "Storage keeps each score under its document id: `scores/<document_id>/original.pdf` and `thumbnails/<document_id>/<rev>.jpg`."
    1. Inventory query (2269-2286): the account's `public.documents` (`owner_id`) plus pending `public.document_storage_cleanup` records (`owner_id`, minus any `document_id` a live score has reclaimed, as `delete-account` does), left-joined to `storage.objects` in buckets `scores` and `thumbnails` by `name like '<document_id>/%'`.
    2. Delete every listed object in both buckets (Dashboard, or Storage API `DELETE /storage/v1/object/<bucket>` with `{"prefixes": [...]}`); SQL cannot (`storage.protect_delete`).
    3. Re-run; every `name` must be null before going further.
    4. Delete the Auth user (its `documents` cascade and write cleanup records for the now-empty folders).
    5. Re-run; still empty; then `delete from public.document_storage_cleanup c where c.owner_id = '<user_id>' and not exists (select 1 from public.documents d where d.id = c.document_id);` (2303-2307).
    6. "Only now run `select public.finish_student_provision('<roster_id>');`" (2309).
- The order (Storage first, then account, then cleanup records, then the intent) follows `purgeOwnedDocuments` in dev's account deletion.
- I ran all four SQL blocks of the section (find, inspect, inventory, cleanup-record delete) against a throwaway local `postgres:16-alpine` container with stub `auth.users`, `storage.objects`, `documents`, `document_storage_cleanup`, `managed_students` and `student_provision_intents` tables (no Supabase stack, nothing hosted). They parse and behave as described: a later unrelated signup at an unrecorded intent's address shows only in `email_candidate_id` with `email_candidate_in_window = f`; a recorded in-window flagged account shows in `recorded_user_id`; a tombstoned id reclaimed by a live score is excluded; folder matching does not over-match. Container removed afterwards.

### MINOR: only an unresolved intent may not be cleared (was DEPLOY.md:2229)

- DEPLOY.md:2331-2339. Quote: "An intent is unresolved until there is no account to resolve (case 1), its account is confirmed on a valid roster row (case 2), its account and Storage are deleted (cases 3 and 4), or the person has agreed to keep the ordinary account (case 4). Never clear an unresolved intent, by `finish_student_provision` or by deleting its `student_provision_intents` row by hand; a case 5 intent stays open until Max resolves it. Once resolved, `finish_student_provision` is the last step, including in cases 2 and 4 where the account stays." Also "Cases 4 and 5 stay manual."

## Names verified against dev (d387b69f; identical at bc070bd4/614824f, which change only DEPLOY.md)

| Name                                                                                                                            | Dev file:line                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| table `public.student_provision_intents`                                                                                        | supabase/migrations/20261022110600_account_deletion_barrier.sql:151                                                                                    |
| columns `roster_id`, `teacher_id`, `auth_email`, `student_user_id`, `created_at`, `expires_at`                                  | same file :152, :155, :158, :160, :161, :163                                                                                                           |
| `auth_email` stored lower-cased                                                                                                 | same file :195 (`begin_student_provision`, :180)                                                                                                       |
| `attach_student_provision(p_roster_id, p_student_user)` sets `student_user_id`                                                  | same file :203-210                                                                                                                                     |
| `finish_student_provision(p_roster_id)`                                                                                         | same file :214                                                                                                                                         |
| `student_provision_intents_for()` email fallback, no upper bound                                                                | same file :227, fallback :231-236 (predicate :235)                                                                                                     |
| `begin_student_provision` called before any Auth account; 600 s default TTL                                                     | supabase/functions/student-provision/index.ts:720; migration :184, :196                                                                                |
| code path: `createUser` with `app_metadata: { user_type: 'student', teacher_id }` at creation, then attach                      | student-provision/index.ts:457, :465, :479                                                                                                             |
| email path: `inviteUserByEmail`, then attach, then `updateUserById` flag                                                        | student-provision/index.ts:554, :576, :591                                                                                                             |
| only writers of the student flag (repo-wide grep)                                                                               | student-provision/index.ts:465, :591                                                                                                                   |
| synthetic code-student address `st-<roster_id>@students.cleffy.app`                                                             | supabase/functions/_shared/studentCodes.ts:100                                                                                                         |
| `code_reset_worker` (reset marker, not provisioning)                                                                            | supabase/functions/_shared/studentCodeReset.ts:40                                                                                                      |
| account deletion's flag check before deleting an intent's account                                                               | supabase/functions/_shared/accountDeletion.ts:523, :538                                                                                                |
| `purgeOwnedDocuments` (folders in both buckets, then rows, then tombstones)                                                     | supabase/functions/_shared/accountDeletion.ts:458-481 (Codex's :465-477)                                                                               |
| `ownedDocuments` = `documents` by `owner_id`                                                                                    | supabase/functions/delete-account/index.ts:257                                                                                                         |
| `storageCleanups` = `document_storage_cleanup` by `owner_id`, minus live ids                                                    | supabase/functions/delete-account/index.ts:283-320                                                                                                     |
| `clearStorageCleanup` deletes by `document_id` + `owner_id`                                                                     | supabase/functions/delete-account/index.ts:321                                                                                                         |
| `removeFolder` (list then remove by prefix `<document_id>`)                                                                     | supabase/functions/delete-account/index.ts:116                                                                                                         |
| `public.managed_students.student_user_id` (unique, FK cascade)                                                                  | supabase/migrations/20260826194426_roster.sql:35                                                                                                       |
| `public.documents.owner_id` (FK `auth.users` on delete cascade), `storage_path` `'{id}/original.pdf'`                           | supabase/migrations/20260801160752_schema.sql:8, :10                                                                                                   |
| table `public.document_storage_cleanup`, `document_id`, `owner_id` (no FK)                                                      | supabase/migrations/20261007120401_document_storage_cleanup.sql:23, :24, :28                                                                           |
| tombstone trigger `documents_record_storage_cleanup`                                                                            | same file :67, :93                                                                                                                                     |
| `storage.protect_delete` blocks SQL deletes of objects                                                                          | same file :19                                                                                                                                          |
| `finish_document_storage_cleanup` (uses `auth.uid()`, so not usable from the SQL editor) and its `storage.objects` folder check | supabase/migrations/20261022100900_storage_cleanup_markers_and_thumbnail_cap.sql:65, :96                                                               |
| bucket `scores`                                                                                                                 | supabase/migrations/20261022100500_storage_bucket_limits.sql:24                                                                                        |
| bucket `thumbnails`                                                                                                             | supabase/migrations/20261022100500_storage_bucket_limits.sql:38 (also 20260902130000_thumbnails.sql:139)                                               |
| score path `${id}/original.pdf`                                                                                                 | src/features/library/documentsService.ts:302                                                                                                           |
| thumbnail path `${docId}/${rev}.jpg`                                                                                            | src/features/library/thumbnailRemote.ts:38                                                                                                             |
| Storage API remove `DELETE {url}/object/{bucket}` body `{ prefixes }`                                                           | node_modules/@supabase/storage-js/src/packages/StorageFileApi.ts:1155-1157                                                                             |
| `auth.users` columns `email`, `created_at`, `email_confirmed_at`, `last_sign_in_at`, `raw_app_meta_data`                        | Supabase Auth schema (not defined in the repo); already used by the bc070bd4 query and by e.g. 20261021120500_retention_recheck_under_lock.sql:45, :82 |

## Local checks (on 614824f, before the push)

- `npm run lint:check`: clean (eslint, no output).
- `npm run typecheck`: clean.
- `npm test`: 242 test files passed, 6 skipped; 3769 tests passed, 20 skipped.
- `npm run build`: succeeded.
- `npx prettier --check DEPLOY.md`: clean.
- `npm run format:check`: NOT clean at bc070bd4 already (pre-existing warnings in `tests/imslp/imslpLicense.test.ts` and `tests/imslp/worksMirrorIsolation.test.ts`, untouched here), so per the instructions it was not used as a gate.
- No local Supabase stack started.

## CI on the final head 614824f

All 17 check runs on 614824f finished, and every one passed (Supabase Preview was skipped, as it was at bc070bd4). The commit status (Vercel) is `success`. Read through the REST API at 19:20 UTC on 2026-10-22.

| Workflow run   | Event            | Run status                 | Job                     | Result                   | Job id       |
| -------------- | ---------------- | -------------------------- | ----------------------- | ------------------------ | ------------ |
| 39834035752    | pull_request     | completed / success        | checks                  | success                  | 120017489102 |
| 39834035752    | pull_request     |                            | supabase-local          | success                  | 120017489183 |
| 39834035752    | pull_request     |                            | edge-functions-deno     | success                  | 120017489246 |
| 39834035752    | pull_request     |                            | supabase-drift          | success                  | 120017489379 |
| 39834035752    | pull_request     |                            | omr-service             | success                  | 120017488756 |
| 39834030756    | push             | completed / success        | checks                  | success                  | 120017475585 |
| 39834030756    | push             |                            | supabase-local          | success                  | 120017475574 |
| 39834030756    | push             |                            | edge-functions-deno     | success                  | 120017475462 |
| 39834030756    | push             |                            | supabase-drift          | success                  | 120017475085 |
| 39834030756    | push             |                            | omr-service             | success                  | 120017475756 |
| 39834026782    | push (duplicate) | **stuck at `in_progress`** | checks                  | success (done 18:48:52Z) | 120017459715 |
| 39834026782    | push (duplicate) |                            | supabase-local          | success                  | 120017459265 |
| 39834026782    | push (duplicate) |                            | edge-functions-deno     | success                  | 120017459915 |
| 39834026782    | push (duplicate) |                            | supabase-drift          | success                  | 120017459883 |
| 39834026782    | push (duplicate) |                            | omr-service             | success                  | 120017460052 |
| (Vercel app)   |                  |                            | Vercel Preview Comments | success                  | 120017762989 |
| (Supabase app) |                  |                            | Supabase Preview        | skipped                  | 120017764714 |

- Vercel commit status: `success`, "Deployment has completed" (https://vercel.com/maxs-projectsd/cleffy/ByTyC3JCaHy4dRNtqrRqTbiQBYJ5). No rate limit, so no Vercel action was needed and none was taken.
- **Anomaly, not a failure:** GitHub started **two** `push` CI runs for the one push (39834026782 at 18:44:34Z and 39834030756 at 18:44:36Z; bc070bd4 had one). All five jobs of 39834026782 passed by 18:48:52Z, but the run and its check suite still read `in_progress` at 19:20Z (`updated_at` frozen at 18:44:46Z). No job is running or failing; the run's status just never updated. I did not re-run or cancel it (no CI kicking). The duplicate run 39834030756 for the same commit completed `success`.
- Empty app check suites (google-cloud-build, cursor, claude: `queued` with 0 check runs) look the same at bc070bd4. They are not CI.

## Follow-ups (not done here)

1. **Hard time bound on `student_provision_intents_for()`'s email fallback** (20261022110600:231-236): bound it to `u.created_at <= i.expires_at` (the intent's window), so account deletion's automatic sweep cannot resolve a stale unattached intent to a later independent signup at the same address. Its flag check (accountDeletion.ts:538) already limits automatic deletion to accounts flagged as that teacher's student, but the bound belongs in the SQL. Needs a migration; out of scope for a docs-only fix.
2. A scheduled sweep for cases 1 to 3 (decision 49(6) follow-up, as the doc already says).
3. A service-role helper for the case 3 Storage steps (list and remove `<document_id>/` in both buckets and drop the cleanup records), so the runbook does not depend on hand deletions in the Dashboard.

## Open questions for Max

1. Proof (A) treats the recorded id plus an in-window `created_at` as enough, even for an unflagged account (case 4). Is that the standard you want, or should case 4 additionally require the email path's `invited_at` (a GoTrue column dev does not write itself, so I did not use it as proof)?
2. CI started **two** `push` runs for the one push. One (39834026782) still shows `in_progress` at run level although all five of its jobs passed (see the CI section). If a merge gate reads the run-level state rather than the check runs, it may need a re-run of that run by Max; I did not touch it.

## Couldn't do / not done

- `gh pr checks` (GraphQL) is blocked in this session; CI was read through the REST API (`gh api .../check-runs`, `.../status`, `.../actions/runs`).
- No handoff or message sent to anyone (by instruction). No Codex review requested or run.

## Hosted steps left for Max (none performed)

- None from this change. The runbook only runs in production if step 20's watch query returns rows; every case 5 row is escalated to Max.
