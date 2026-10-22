# Cleffy launchfix P5: late-student retention gap fixed on PR #66 (decision 67)

**Status:** Complete

- Starting head of PR #66: `d9c1fbfe18b9be399f4bfc423c4e306b5acac0d8` (confirmed on `origin` at the start and again right before the push)
- New head of PR #66: `5ebeb8659a959b6b1dcc359889805244624abb0d`
- Environment: Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (confirmed with this session's own `get_session`), not Sandbox
- Report branch: `claude/launchfix-p5-latestudent-report` (created from the final PR #66 head plus this one file)

## 1. Summary

Decision 67 is in on the #66 branch, in two new fast-forward commits:

1. **The fix** (`859bc18`): new migration `20261022130300_district_retention_late_students.sql`, the 409 in student-provision, the committed verification proof `tests/sql/district_retention_late_student.sql`, and three new proofs (the barrier, the re-list's idempotency, and a two-session race proof of the lock).
2. **The drop** (`5ebeb86`): `20261022130200` is deleted in a new commit. `explicitServiceRoleGrants.test.ts` passes without it (2 of 2).

`district_retention_late_student.sql` passes **6 of 6**. Against the old run function it still fails the same 3 of 6 (checks 3, 5 and 6), so it really does test the fix. All 52 SQL proofs pass locally in CI's every-proof loop. The new ones are picked up by the loop's `tests/sql/*.sql` glob, so `ci.yml` is unchanged. Lint, typecheck, vitest (3761 passed), build, deno check and prettier are clean. CI results on the new head are in section 10.

## 2. Pushes (every push was a fast-forward)

| Branch | Command | Result |
|---|---|---|
| `mh/launchfix-p5-district-retention` | `git push origin HEAD:mh/launchfix-p5-district-retention` | `d9c1fbf..5ebeb86` (fast-forward). Before it, `git fetch` showed `origin/mh/launchfix-p5-district-retention` = `d9c1fbfe…` and `git merge-base --is-ancestor` confirmed the fast-forward. |
| `claude/launchfix-p5-latestudent-report` | `git push -u origin claude/launchfix-p5-latestudent-report` | New branch: the PR head `5ebeb86` plus one report commit. |

I used no `--force`, no `--force-with-lease`, no rebase, no amend and no squash. I did not touch PR #66's title, body, draft state or base (still draft, base `dev`), and opened no PR. I made no merges, did nothing on `dev` or `main`, and touched no other PR or branch (#54, #67, other `claude/launchfix-*` branches). I used no hosted service: only the local Supabase stack, stopped with `npm run cloud:down` at the end. I sent no messages and no handoff.

## 3. Design

### (a) Barrier: nothing is provisioned into, or attributed to, a district being deleted

New predicate `district_deletion_pending(studio)`: true when the district's `district_retention` row has `soft_deleted_at` (the purge has begun and not been cancelled) or `hard_deleted_at` set. A cancel (contract renewed or moved) deletes that row, which lifts the barrier.

- `district_provision_refusal(teacher, studio)` returns `null` (allowed), `'not_in_district'` or `'district_deletion_pending'`. It checks membership first, so only the district's owner and seated teachers learn its state; anyone else gets `not_in_district`.
- `district_provisionable()` is now `district_provision_refusal(...) is null`, so it says no once the purge has begun.
- The roster trigger `managed_students_district_attribution()` does two things:
  - **INSERT naming a district:** takes the district lock (below), then refuses with SQLSTATE `55000`, message `district_deletion_pending`, hint "This district is being deleted, so no new students can be added to it." This is the account-deletion barrier's style (`20261022110100`: `55000` `account_deletion_pending`). The old `42501` refusals are unchanged.
  - **Admin-flagged UPDATE moving a student into a district:** the same lock and the same `55000` refusal.
- Edge Function: `checkDistrictChoice` (`_shared/districtProvision.ts`) asks `district_provision_refusal` only when `district_provisionable` says no. It answers **409** `{ code: 'district_deletion_pending', error: 'This district is being deleted, so no new students can be added to it.' }`, still before any Auth account exists. If the purge starts between that check and the roster insert, the trigger's refusal is mapped to the same 409 on both create paths (the Auth account is undone, as for every insert failure).

### (b) Sweep: every run re-lists

New internal helper `district_retention_list_late(studio, now, by)`. It lists every student attributed to the district (`retention_district_students()`, the purge's own scope) who is **not already on its list**, then archives and signs them out exactly as the soft delete does:
- `archived_at = coalesce(archived_at, now)`, `access_revoked_at = clock_timestamp()`
- deletes from `auth.refresh_tokens` and `auth.sessions`
- records `was_archived` the same way the soft delete does
- logs `soft_deleted` with `counts.event = 'late_students_listed'` (no new step value; see `20261022130000`'s note)

After the candidates loop, `retention_district_run()` sweeps every district with `soft_deleted_at` set and `hard_deleted_at` null. Each sweep takes the billing row lock (`FOR UPDATE SKIP LOCKED`, as the run already does) and skips a district whose next step is its cancel. The sweep is not limited by `p_batch`. The result jsonb gets a new key, `students_late_listed`.

**Idempotent:** a student who is already listed is never touched again. A second run (same day or the next) lists, archives, revokes and logs nothing and leaves every stamp as it was. It also does not undo a teacher's restore of a listed student (`20261021120700`: "a teacher's restore wins").

### (c) Hard delete: re-list under the lock, then scrub and delete

In the `hard_delete` step, `district_retention_list_late(..., 'hard_delete')` runs right before the existing scrub-and-delete loop. It runs while the run holds the district's billing row `FOR UPDATE`, taken at the top of the iteration, which is the same row the provision path locks. The loop (with `20261022130000`'s attribution re-check under the roster row's lock) then works from everything attributed to the district at that moment. Nothing can be attributed afterwards: a provision waits for the run and then finds the district gone (`not_in_district`, `42501`).

### The lock and the lock order

The run has always locked a district through its billing record (`20261021120700`: `FOR UPDATE SKIP LOCKED`; an admin editing it is passed over until tomorrow). The provisioning side now takes **the same row `FOR KEY SHARE`** before it reads the district's state. Three places take it:
- the roster trigger (on INSERT, and on an admin move into a district)
- `admin_set_student_district()`, **before** it locks the roster row
- `backfill_district_student_attribution()`, before its UPDATE, on every district the evidence names, in studio-id order

`KEY SHARE` conflicts with the run's `FOR UPDATE` and with the studio's delete (the hard delete's cascade), and with nothing else a provision does. The race proof shows three outcomes:
- **A provision is in flight when the run reaches the district:** the run passes it over (SKIP LOCKED), the provision commits, and the next run soft deletes the district with that student listed.
- **A provision starts while the run holds the district:** it waits, then is refused.
- **So** the soft delete's list, and the hard delete's re-list, see every attribution that will ever commit for the district.

**Order, everywhere:** the district's billing row first, then `district_retention`, then roster rows. On a provision insert this trigger fires before the account-deletion trigger (alphabetical), so its order is billing row, then the account-deletion advisory lock, then the FK checks.
- That matches the run (billing, then `district_retention`, then roster rows) and the existing admin functions that take `district_billing ... for update` first (`20261020180500`, `20261020181000`).
- `admin_set_student_district()` previously locked only the roster row. It now takes the billing row first so it never holds a roster row while waiting on a district.
- The only path that could take roster row then billing row is a raw `UPDATE` of `district_studio_id` with the admin GUC set, outside both admin functions. The trigger still locks and refuses there.
- No deadlock with account deletion: its marker is taken under the exclusive advisory lock in a short transaction. Any provision in flight holds the shared one and finishes first, and later provisions are refused before their FK checks.

## 4. Every provisioning / attribution path, and how it refuses now

| Path | Writes `district_studio_id`? | Refusal now |
|---|---|---|
| `student-provision` `create`, code method (`createCodeStudent`) | INSERT with `districtStudioId` | Before any write: `checkDistrictChoice` → **409** `district_deletion_pending`. If the purge starts after that check, the trigger raises `55000 district_deletion_pending`, the Auth account is deleted, and the answer is the same **409**. |
| `student-provision` `create`, email method (`createEmailStudent`) | INSERT with `districtStudioId` | Same as above (both insert error branches map it). |
| Any other INSERT into `managed_students`, any role (service role, postgres; the trigger is the backstop) | INSERT | Trigger: `55000` `district_deletion_pending` (proof: barrier check 6/7, race R2). |
| `admin_set_student_district()` (human correction, service role) | UPDATE | `55000 district_deletion_pending` when moving a student into a district being deleted. Re-confirming the district a student already has is not a new attribution and stays allowed (`20261022130000`'s r5). Moving a student **out** works as before. |
| Admin-flagged raw UPDATE (`cleffy.district_attribution = 'admin'`) | UPDATE | Trigger's UPDATE branch: `55000` `district_deletion_pending`. A non-admin UPDATE is refused with `42501`, as before. |
| `backfill_district_student_attribution()` (legacy rows on recorded evidence) | UPDATE | Never attributes to a district being deleted. Such a row stays unattributed and is counted as `district_gone` (the district is going). The result keeps its exact six keys, which `district_student_scope.sql` compares byte for byte. |
| `admin_record_district_evidence()` | No (records evidence only) | Unchanged. Evidence for a district being deleted is never acted on by the backfill. |
| Roster import | None exists | There is no roster import path in `src/` or `supabase/functions/` (`grep managed_students`: only student-provision, student-claim, student-login and delete-account touch the roster, and only student-provision writes `district_studio_id`). |
| Restore / un-archive (`student-provision` `restore`, the run's cancel, `district_reattributed_restore`) | No | Not attribution, so it is unchanged (see open question 2). |

**UI copy:** the roster UI (`src/features/roster/rosterService.ts` `failFrom` → `messageFrom`) shows the server's own `error` sentence for any non-402 failure. The 409 carries "This district is being deleted, so no new students can be added to it.", which mirrors "This account is being deleted, so no new students can be added." The roster UI does not offer a district picker yet (it never sends `districtStudioId`), so no client change was needed.

## 5. Files changed and commits

### `859bc18` launchfix P5: no student provisioned into, or outliving, a district being purged
- `supabase/migrations/20261022130300_district_retention_late_students.sql` (new; full SQL in section 15)
- `scripts/apply-migrations.sql` (`npm run migrations:mirror`)
- `supabase/functions/_shared/districtProvision.ts`: `DISTRICT_DELETION_PENDING`, `isDistrictDeletionPending`, the 409 in `checkDistrictChoice`
- `supabase/functions/student-provision/index.ts`: maps the trigger's refusal on both create paths to the 409; doc comment
- `tests/sql/district_retention_late_student.sql`: the verification proof, committed (6/6)
- `tests/sql/district_provision_barrier.sql`: new barrier proof (18 checks)
- `tests/sql/district_retention_relist_idempotent.sql`: new idempotency proof (9 checks)
- `tests/sql/district_retention_late_student_race.sql`: new two-session race proof of the lock (12 checks)
- `tests/sql/migrations_ordered_replay.sql`: replays `20261022130300` too, plus a check `13b` that its definitions are the latest
- `tests/legal/districtLateStudents.test.ts` (new): pins the migration's shape (lock before state, lock before roster row, re-list before the delete loop, sweep, grants, the 409 wiring)
- `tests/legal/districtProvision.test.ts`: 409 / 502 / 403 cases and `isDistrictDeletionPending`
- `tests/legal/districtReattribution.test.ts`: the ordered-replay pin now expects `20261022130300` as the last replayed migration

### `5ebeb86` launchfix P5: drop the redundant 20261022130200 grant migration
- `supabase/migrations/20261022130200_district_retention_restores_service_role_grant.sql` (deleted)
- `scripts/apply-migrations.sql` (`npm run migrations:mirror`)
- `tests/legal/districtLateStudents.test.ts` (a test title that named 130200)

Both commits are authored `Max Harris <drumaxter@gmail.com>`.

## 6. Dropping 20261022130200

**Dropped**, by the new commit `5ebeb86`, which deletes the file and regenerates the mirror. History was not rewritten.

- `npx vitest run tests/security/explicitServiceRoleGrants.test.ts` with the file deleted: **2 passed (2)**. `20261022130000` already has `grant all on table public.district_retention_restores to service_role;` where it creates the table.
- On the freshly reset local database without `130200`: service_role has insert, select, update and delete on `district_retention_restores`, anon and authenticated have none, and `tests/sql/explicit_grants.sql` passes (22/22).

## 7. Migrations

The order from `20261022130000` on:

1. `20261022130000_district_retention_reattribution.sql` (unchanged)
2. `20261022130100_content_strikes_survive_deletion.sql` (unchanged)
3. `20261022130300_district_retention_late_students.sql` (new)

`20261022130200` was dropped.

- **Grants:** every function `20261022130300` creates or replaces is revoked from public, anon and authenticated and granted to `service_role`: `district_deletion_pending`, `district_provision_refusal`, `district_provisionable`, `managed_students_district_attribution`, `admin_set_student_district`, `backfill_district_student_attribution` and `retention_district_run`. The internal `district_retention_list_late` is revoked from public, anon, authenticated **and** service_role (it archives students, and its caller must hold the lock). It adds no table, so no table grant was needed.
- **Rerunnable:** only `create or replace function` and privilege resets. I applied it twice in a row locally, and the ordered-replay proof replays it over live retention data (9/9).
- **`npm run migrations:mirror`:** run after each migration change and committed in both commits. `tests/applyMigrationsInSync.test.ts` passes.
- **supabase-drift:** it compares the live project's applied migrations with the tree. Neither `130200` nor `130300` was ever applied to a hosted project from here; I touched no hosted service. The CI result is in section 10.

## 8. SQL proofs

Run locally exactly as CI's `supabase-local` job does:
1. Fresh `supabase db reset` of the local stack (every migration, in order, plus the seed).
2. The Realtime partition wait.
3. The 16-migration re-apply step, with the list copied from `ci.yml`.
4. `bash scripts/ci/sql-proof.sh` on every `tests/sql/*.sql` and `supabase/sql-tests/sharing_access_control.sql`.

Result on the final head `5ebeb86`: **52 of 52 proofs passed**, with no SKIP entries.

Called out:

| Proof | Result | What it shows |
|---|---|---|
| `tests/sql/district_retention_late_student.sql` (decision 53(4)) | **6 of 6** | The next run catches e2 (listed, archived, signed out); the hard delete scrubs and deletes it; nothing attributed to L outlives L. Against the pre-fix run function (`20261022130000` re-applied inside a rolled-back transaction) the same file fails checks **3, 5 and 6**, exactly as in the rebase report. |
| `tests/sql/district_provision_barrier.sql` (**barrier**) | **18 of 18** | Before the purge, the owner and the seated teacher provision (control). After the soft delete: `district_provisionable` is false and the refusal is `district_deletion_pending` (outsiders get `not_in_district`). Service-role inserts by the owner or the seated teacher are refused `55000 district_deletion_pending`, and nothing is written. Private students still provision. `admin_set_student_district` and an admin-flagged UPDATE cannot move a student in; re-confirming and moving out still work. The backfill leaves the legacy row unattributed (`district_gone`) and keeps its result shape. A cancel lifts the barrier. After the hard delete nobody is in the district. Grants as listed. |
| `tests/sql/district_retention_relist_idempotent.sql` (**idempotency**) | **9 of 9** | The next run lists two late students once: archives the active one, kills its session and refresh token, records `was_archived` for the already-archived one and keeps its stamp, and logs once. A second run the same day and one the next day list, change and log nothing (list and stamps identical). A teacher's restore of a listed student stands. A student attributed after the last sweep is listed by the hard delete itself (logged `by: hard_delete`) and deleted. A run after the hard delete finds nothing. |
| `tests/sql/district_retention_late_student_race.sql` (**the lock, two real sessions over dblink**) | **12 of 12** | **R1:** a provision in flight makes the soft delete pass its district over; the next run lists that student. **R2:** a provision during an open soft delete waits, then is refused `district_deletion_pending`. **R3:** a provision during an open hard delete waits, then is refused (district gone), and nothing attributed outlives the districts. **R4:** the student who raced the soft delete is deleted with the district. It first checks no other district would be due (the runs commit), and cleans up its committed rows (check Z). |
| `tests/sql/migrations_ordered_replay.sql` | 9 of 9 | Now replays `20261022130300` as well, with new check 13b. |
| All other existing proofs | pass | Including `district_retention.sql` (28), `district_retention_reattribution.sql` (24), `district_student_scope.sql` (47), `realtime_revocation_race.sql` (53) and `explicit_grants.sql` (22). |

### The one change to the verification proof, and why

Since `20261022130300`, the roster trigger refuses the proof's original "late" insert outright (`55000 district_deletion_pending`). That is the barrier working, but under `ON_ERROR_STOP` it would abort the proof. So `pg_temp.provision_past_barrier('e2')` writes e2 with `alter table public.managed_students disable trigger managed_students_district_attribution` around that one insert. The table is owned by `postgres`; the change is transactional and rolled back with the proof, and the trigger is re-enabled straight after the insert.

This models a row that got past the barrier anyway: written before this migration was deployed, or loaded with triggers off. That is exactly what the re-list exists for. The proof's intent and its six checks are unchanged: the header comment explains the bypass, and e1 and everything else is provisioned through the trigger as before. The real "provisioned while the soft delete runs" interleaving, which one session cannot show, is now proven by the separate race proof.

### CI's every-proof loop

The `supabase-local` job's loop runs `for proof in tests/sql/*.sql supabase/sql-tests/sharing_access_control.sql`, with `declare -A SKIP=()` empty. All four new or committed proofs live in `tests/sql/` and end in the `failures | total` shape `scripts/ci/sql-proof.sh` reads, so they run there as they are. **`ci.yml` is unchanged** (`git diff d9c1fbfe..5ebeb86 -- .github/workflows/ci.yml` is empty), with no SKIP entries. The race proof uses `dblink` with the local stack's postgres password, as `realtime_revocation_race.sql` already does in that job.

## 9. Local checks (final head `5ebeb86`)

| Check | Result |
|---|---|
| `npm run lint:check` | clean |
| `npm run typecheck` | clean |
| `npm test` (full vitest, includes `explicitServiceRoleGrants.test.ts`) | **241 files passed, 6 skipped; 3761 tests passed, 20 skipped, 0 failed**. Run with the local stack's generated `.env.local` moved aside, since CI has none. With it present, `src/sync/syncEngine.test.ts` fails 1 test (a real network call to the running stack), identically on the untouched base `d9c1fbfe`, so it is environmental, not this change. The file was put back afterwards. |
| `tests/security/explicitServiceRoleGrants.test.ts` | 2/2, both with and without `20261022130200` |
| `npm run build` | OK |
| `deno check --config supabase/functions/deno.json supabase/functions/*/index.ts` (Deno 2.1.4, CI's version, downloaded to the scratchpad) | exit 0, all 23 entry points |
| `npx prettier --check` on every changed TS file | clean. Prettier has no SQL parser in this repo, so the `.sql` files are hand-formatted in the existing proofs' style. |
| CI's local-stack vitest steps (`cancelLinkStore.test.ts`, `storageLifecycle.test.ts`) | 8/8, 5/5 |
| Every SQL proof (section 8) | 52/52 |

## 10. CI on the final head `5ebeb86`

Two CI runs, both **completed / success**:
- [39815152784](https://github.com/maxharris1/Cleffy/actions/runs/39815152784) (`pull_request`)
- [39815145708](https://github.com/maxharris1/Cleffy/actions/runs/39815145708) (`push`)

| Check | pull_request run 39815152784 | push run 39815145708 |
|---|---|---|
| `checks` (audit, lint, typecheck, vitest, build) | success (job 119951649213) | success (job 119951622480) |
| `supabase-local` (stack, re-apply, store and storage tests, every SQL proof) | success (job 119951649073) | success (job 119951622932) |
| `supabase-drift` | success (job 119951649140). This was a real check, not the inert warning: it ended "clean: this branch and the live project agree." | success (job 119951622645) |
| `edge-functions-deno` | success (job 119951648735) | success (job 119951622592) |
| `omr-service` | success (job 119951649071) | success (job 119951622731) |

Other checks on the PR:

| Check | Result |
|---|---|
| Vercel (commit status) | success, "Deployment has completed". No "Deployment rate limited" this time; I took no action on Vercel. |
| Vercel Preview Comments | success |
| Supabase Preview | skipped (the integration's own check; not triggered by this session) |

From the `supabase-local` log of run 39815152784:
- `OK tests/sql/district_provision_barrier.sql: 18 checks passed`
- `OK tests/sql/district_retention_late_student.sql: 6 checks passed`
- `OK tests/sql/district_retention_late_student_race.sql: 12 checks passed`
- `OK tests/sql/district_retention_relist_idempotent.sql: 9 checks passed`
- `OK tests/sql/migrations_ordered_replay.sql: 9 checks passed`

No proof failed or was skipped.


## 11. Follow-ups (not implemented: the separate PR after all six launch-fix PRs merge)

- **Overlapping district purges delete each other's restore record** (decision 47's residual, kept a follow-up by decision 66(1)). Untouched.
- **The other packet follow-ups**, as already listed for that PR. Untouched.
- **`retention_district_dry_run()`** still counts `students_to_delete` from the list alone. It could also report students attributed to a soft-deleted district but not yet listed, which the next run would list. This is informational only: the run itself catches them.
- **Codex narrow review** of this fix, per decision 67. Not requested or run here; that is for whoever orchestrates it.

## 12. Open questions

1. **When does the barrier start?** I read decision 67(a)'s "soft_deleted_at or a pending purge" as: from the soft delete (the purge list exists and the hard delete is pending) until a cancel, plus after the hard delete. Provisioning stays allowed during the 14-day **notice** period. That has no retention gap: the soft delete lists whoever is attributed on the day it runs, under the district's lock. If Cleffy wants the barrier from the notice (a `district_retention` row with no `hard_deleted_at`), it is a one-line change to `district_deletion_pending()` plus a proof update. I did not guess beyond the narrower reading.
2. **A student whom a teacher restores during the purge week still outlives the hard delete.** This is existing, reviewed behaviour (`20261021120700`: "a teacher's restore since the soft delete wins"). The re-list deliberately does not re-archive an already-listed student, to keep that rule; the idempotency proof checks it. Such a student keeps a `district_studio_id` that dangles after the hard delete, so decision 67(c)'s "nothing attributed to the district outlives it" holds for every student who was not deliberately restored. The other kept exception is `20261022130000`'s "other_account" row (a list entry whose roster row now names a different account), left for a human. Should the restore be refused while the district is being deleted, or should the hard delete detach or delete restored students? That is a product decision. Neither is in decision 67, so I changed neither.
3. **Renewals wait for the next daily run.** A renewal (the contract moved) lifts the barrier only when the next run's cancel deletes the `district_retention` row. Until then the district's students also stay archived. That matches how the cancel already works; say if provisioning should reopen on the billing change itself.
4. **Deploy order.** student-provision now calls `district_provision_refusal()`, but only after `district_provisionable()` says no. Deployed before `20261022130300`, it behaves as today except that a refused district provision answers 502 instead of 403. Apply the migration first (section 13).

## 13. Hosted steps left for Max (none performed here)

1. When #66 merges (after the Codex narrow review per decision 67), apply `20261022130300_district_retention_late_students.sql` with the rest of P5's migrations, through the normal integration or `db push`, **before** deploying `student-provision`. `20261022130200` no longer exists. It was never applied by this session; if any hosted branch did apply it, `supabase-drift` will name it, and that copy is a no-op grant.
2. Deploy the `student-provision` Edge Function (it imports the changed `_shared/districtProvision.ts`).
3. Unchanged from P5: `retention_district_run()` stays unscheduled until Max has read `retention_district_dry_run()`'s counts (`20261021120700`'s DEPLOY note). The run now also reports `students_late_listed`.
4. Nothing else. No secrets, Vault entries or config are new. The `content_strike_pepper` seed is untouched.

## 14. Environment

The session ran in the **Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2`**, confirmed with this session's own `get_session` (`environment_kind: anthropic_cloud`), not Sandbox.
- **Local stack:** `npm run cloud:up` started the local Supabase stack. `npx supabase db reset` (local target) rebuilt it twice for the proof runs, and `npm run cloud:down` stopped it at the end.
- **Scratch files:** Deno 2.1.4 was downloaded into the session scratchpad.
- **No hosted services:** I made no calls to hosted Supabase, Vercel or Stripe, and used no secrets.

## 15. Full SQL of the new migration `supabase/migrations/20261022130300_district_retention_late_students.sql`

(No other migration changed. `20261022130200` was deleted; its full text was one `grant all on table public.district_retention_restores to service_role;` and a comment.)

```sql
-- District retention: no student is provisioned into, or outlives, a district
-- whose purge has begun.
--
-- Decision 53(4), verified in the P5 rebase pass and failed there
-- (tests/sql/district_retention_late_student.sql, 3 of 6); fixed per decision
-- 67. The soft delete (20261021120700) listed the district's students once,
-- and the hard delete a week later worked from that list alone. A student
-- provisioned into the district after the list was taken (a roster insert
-- committing after the soft delete's snapshot, or simply the next day, since
-- district_provisionable() still let the owner or a seated teacher in) was
-- never listed, never archived, never deleted, and kept a dangling
-- district_studio_id after the district was gone. Three parts:
--
--  (a) The barrier. Once the district is soft deleted -- its students
--      archived and listed, the hard delete pending (district_retention row
--      with soft_deleted_at set and not cancelled), or hard deleted -- nothing
--      provisions into it or attributes a student to it:
--        * district_provisionable() answers false, and
--          district_provision_refusal() says why ('district_deletion_pending'
--          for the owner or a seated teacher, 'not_in_district' for anyone
--          else, so nobody outside the district learns its state);
--        * the roster table's trigger refuses an INSERT naming the district,
--          and the admin correction's UPDATE moving a student into it, with
--          SQLSTATE 55000 and the message 'district_deletion_pending' -- the
--          account deletion barrier's style (20261022110100), which
--          student-provision answers with a 409;
--        * admin_set_student_district() refuses to move a student into it
--          (re-confirming the district a student already has is not a new
--          attribution, and stays allowed: 20261022130000's r5);
--        * backfill_district_student_attribution() leaves a legacy row whose
--          evidence names it unattributed, counted as district_gone (the
--          district is going), so its result keeps its shape.
--  (b) The sweep. Every run, each soft-deleted district not yet hard deleted
--      has its students listed again: anyone attributed to it and not on its
--      list is listed, archived and signed out exactly as the soft delete did
--      (was_archived recorded the same way), and logged. Only students not
--      already listed are touched, so a second run changes nothing, and a
--      listed student a teacher restored since the soft delete stays restored
--      (20261021120700: the teacher's restore wins).
--  (c) The hard delete lists again, the same way, right before it scrubs and
--      deletes, under the district's lock, so the list it works from is
--      everything attributed to the district at that moment, and nothing can
--      be attributed to it after (the barrier, under the same lock).
--
-- THE LOCK. A district is locked through its billing record, as the run has
-- always done (20261021120700: FOR UPDATE SKIP LOCKED, so a district someone
-- else holds is passed over until tomorrow). The provisioning side now takes
-- the same row FOR KEY SHARE before it reads the district's state: the roster
-- trigger on an INSERT naming a district, and on an UPDATE moving a student
-- into one; admin_set_student_district() and the backfill take it first,
-- before any roster row. KEY SHARE conflicts with the run's FOR UPDATE and
-- with the studio's delete, and with nothing a provision does to other rows,
-- so:
--   * a provision in flight when the run reaches the district makes the run
--     pass it over (SKIP LOCKED) until the next run, which lists the student;
--   * a provision that starts while the run holds the district waits for the
--     run to commit, then reads soft_deleted_at (or finds the district gone)
--     and is refused;
--   * so the soft delete's list, and the hard delete's re-list, see every
--     attribution that will ever commit for the district.
-- Lock order, everywhere: the district's billing row first, then roster rows
-- (and, on a provision, the account-deletion advisory lock its own trigger
-- takes after this one), as the run takes billing, then district_retention,
-- then roster rows. Nothing takes a roster row and then the billing row,
-- except a direct UPDATE of district_studio_id that skipped
-- admin_set_student_district(); the trigger still locks and refuses there.
--
-- The barrier lifts with the cycle: a cancel (the contract renewed or moved)
-- deletes the district_retention row, and the district provisions again.
--
-- No new step value (20261022130000's note: 20261021120800 rebuilds the step
-- check with a fixed list). A late listing is logged as soft_deleted with
-- counts.event = 'late_students_listed'.
--
-- Rerunnable: functions are replaced with the same signatures (two new ones
-- are created or replaced), and the privileges reset to the same end state.
-- No table, trigger or constraint is added.

-- ---------------------------------------------------------------------------
-- Is the district being deleted?
-- ---------------------------------------------------------------------------
-- Soft deleted and not cancelled (the cancel deletes the row), or hard
-- deleted. The notice period before the soft delete is not: the soft delete
-- lists whoever is in the district on the day it runs.
create or replace function public.district_deletion_pending (p_studio uuid) returns boolean
language sql stable security definer
set search_path = public as $$
    select exists (
        select 1 from public.district_retention r
        where r.studio_id = p_studio
          and (r.soft_deleted_at is not null or r.hard_deleted_at is not null)
    );
$$;

-- Why this teacher may not provision into this district now, or null if they
-- may. Membership is asked first, so the district's state is told only to its
-- owner and its seated teachers.
create or replace function public.district_provision_refusal (p_teacher uuid, p_studio uuid) returns text
language sql stable security definer
set search_path = public as $$
    select case
        when not exists (
            select 1
            from public.district_billing b
            join public.studios st on st.id = b.studio_id
            where b.studio_id = p_studio
              and (st.owner_id = p_teacher
                   or exists (select 1 from public.studio_members sm
                              where sm.studio_id = p_studio and sm.user_id = p_teacher))
        ) then 'not_in_district'
        when public.district_deletion_pending (p_studio) then 'district_deletion_pending'
    end;
$$;

-- 20261021120800's question, now also no while the district is being deleted.
create or replace function public.district_provisionable (p_teacher uuid, p_studio uuid)
returns boolean language sql stable security definer
set search_path = public as $$
    select public.district_provision_refusal (p_teacher, p_studio) is null;
$$;

-- ---------------------------------------------------------------------------
-- The roster trigger: the barrier on every insert and every re-attribution
-- ---------------------------------------------------------------------------
-- 20261021120800's definition, plus the district's lock and the barrier.
create or replace function public.managed_students_district_attribution () returns trigger language plpgsql
security definer
set search_path = public as $$
declare
    v_refusal text;
begin
    if tg_op = 'INSERT' then
        -- Whatever the caller wrote, a new row is decided here and now.
        new.district_attribution := 'provisioned';
        if new.district_studio_id is not null then
            -- The district's lock, before its state is read (20261022130300):
            -- a run holding it is waited for, and its soft delete is seen.
            perform 1 from public.district_billing b where b.studio_id = new.district_studio_id for key share;
            v_refusal := public.district_provision_refusal (new.teacher_id, new.district_studio_id);
            if v_refusal = 'district_deletion_pending' then
                raise exception 'district_deletion_pending'
                    using errcode = '55000',
                          hint = 'This district is being deleted, so no new students can be added to it.';
            elsif v_refusal is not null then
                raise exception 'the teacher does not own or hold a seat in that district'
                    using errcode = '42501';
            end if;
        end if;
        -- Never a student dated before the district or the seat existed: a
        -- back-dated insert (none of the app's paths writes created_at) is
        -- refused rather than attributed to a time the district did not cover.
        if new.district_studio_id is not null
           and not public.district_held_at (new.teacher_id, new.district_studio_id, new.created_at) then
            raise exception 'the student predates the teacher''s seat in that district, or the district itself'
                using errcode = '42501';
        end if;
    elsif new.district_studio_id is distinct from old.district_studio_id
          or new.district_attribution is distinct from old.district_attribution then
        if current_setting('cleffy.district_attribution', true) is distinct from 'admin' then
            raise exception 'district attribution is recorded at provisioning and cannot be changed'
                using errcode = '42501';
        end if;
        -- A correction moving a student into a district being deleted.
        if new.district_studio_id is not null and new.district_studio_id is distinct from old.district_studio_id then
            perform 1 from public.district_billing b where b.studio_id = new.district_studio_id for key share;
            if public.district_deletion_pending (new.district_studio_id) then
                raise exception 'district_deletion_pending'
                    using errcode = '55000',
                          hint = 'This district is being deleted, so no student can be moved into it.';
            end if;
        end if;
    end if;
    return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- The admin correction: the district's lock first, and the barrier
-- ---------------------------------------------------------------------------
-- 20261022130000's definition, plus the lock (before the roster row's, the
-- run's order) and the refusal.
create or replace function public.admin_set_student_district (p_managed_student uuid, p_studio uuid, p_actor text)
returns void language plpgsql security definer
set search_path = public as $$
declare
    v_old uuid;
    v_drop public.district_retention_students;
    v_restore text;
begin
    if coalesce(trim(p_actor), '') = '' then
        raise exception 'say who is making the change' using errcode = '22023';
    end if;
    if p_studio is not null then
        perform 1 from public.district_billing b where b.studio_id = p_studio for key share;
    end if;
    select ms.district_studio_id into v_old from public.managed_students ms where ms.id = p_managed_student for update;
    if not found then
        raise exception 'no such roster student' using errcode = 'P0002';
    end if;
    if p_studio is not null and p_studio is distinct from v_old and public.district_deletion_pending (p_studio) then
        raise exception 'district_deletion_pending'
            using errcode = '55000',
                  hint = 'This district is being deleted, so no student can be moved into it.';
    end if;
    perform set_config('cleffy.district_attribution', 'admin', true);
    update public.managed_students
    set district_studio_id = p_studio, district_attribution = 'admin'
    where id = p_managed_student;
    perform set_config('cleffy.district_attribution', '', true);
    insert into public.district_retention_log (studio_id, step, counts)
    values (coalesce(p_studio, v_old, p_managed_student), 'attribution_changed',
            jsonb_build_object('managed_student_id', p_managed_student, 'from', v_old, 'to', p_studio,
                               'actor', p_actor));

    -- Each district whose purge it left: the entry goes, the student gets back
    -- what that purge took if their teacher's plan has room (or it is carried
    -- over to the district's cancel), logged under that district.
    for v_drop in
        delete from public.district_retention_students s
        where s.managed_student_id = p_managed_student
          and s.studio_id is distinct from p_studio
        returning s.*
    loop
        v_restore := case when v_drop.was_archived then 'was_archived'
                          else public.district_reattributed_restore (p_managed_student, v_drop.studio_id) end;
        if v_restore in ('on_another_purge', 'no_roster_plan', 'roster_full') then
            insert into public.district_retention_restores (studio_id, managed_student_id, student_user_id)
            values (v_drop.studio_id, v_drop.managed_student_id, v_drop.student_user_id)
            on conflict do nothing;
        end if;
        insert into public.district_retention_log (studio_id, step, counts)
        values (v_drop.studio_id, 'attribution_changed',
                jsonb_build_object('event', 'skipped_reattributed', 'students_skipped', 1,
                                   'managed_student_id', v_drop.managed_student_id,
                                   'student_user_id', v_drop.student_user_id, 'was_archived', v_drop.was_archived,
                                   'restore', v_restore, 'to', p_studio, 'actor', p_actor,
                                   'by', 'admin_set_student_district'));
    end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The backfill: no legacy row is attributed to a district being deleted
-- ---------------------------------------------------------------------------
-- 20261021120800's definition, plus the lock on every district the evidence
-- names (before any roster row, in studio order) and one more reason for
-- district_gone: the district is being deleted.
create or replace function public.backfill_district_student_attribution () returns jsonb language plpgsql
security definer
set search_path = public as $$
declare
    v_totals jsonb;
    v_districts jsonb;
    v_attributed int;
    v_result jsonb;
    v_district jsonb;
begin
    perform 1
    from public.district_billing b
    where b.studio_id in (
        select e.studio_id
        from public.district_student_evidence e
        join public.managed_students ms on ms.id = e.managed_student_id
        where ms.district_attribution = 'legacy' and ms.district_studio_id is null
    )
    order by b.studio_id
    for key share of b;

    perform set_config('cleffy.district_attribution', 'admin', true);
    with legacy as (
        select ms.id, ms.teacher_id, ms.created_at,
               array(select e.studio_id from public.district_student_evidence e
                     where e.managed_student_id = ms.id order by e.studio_id) as studios
        from public.managed_students ms
        where ms.district_attribution = 'legacy' and ms.district_studio_id is null
    ), classified as (
        select l.id, l.studios,
               case
                   when cardinality(l.studios) = 0 then 'no_evidence'
                   when cardinality(l.studios) > 1 then 'ambiguous'
                   when not exists (select 1 from public.district_billing b
                                    join public.studios st on st.id = b.studio_id
                                    where b.studio_id = l.studios[1]) then 'district_gone'
                   -- Being deleted (20261022130300): going, so gone.
                   when public.district_deletion_pending (l.studios[1]) then 'district_gone'
                   when l.created_at < (select greatest(st.created_at, b.created_at)
                                        from public.district_billing b
                                        join public.studios st on st.id = b.studio_id
                                        where b.studio_id = l.studios[1]) then 'before_district'
                   when not public.district_held_at (l.teacher_id, l.studios[1], l.created_at) then 'outside_tenure'
                   else 'attributed'
               end as outcome
        from legacy l
    ), updated as (
        update public.managed_students ms
        set district_studio_id = c.studios[1], district_attribution = 'backfilled'
        from classified c
        where c.outcome = 'attributed' and ms.id = c.id
        returning ms.id
    ), by_district as (
        select d.studio_id, jsonb_object_agg(d.outcome, d.n) as counts
        from (select s.studio_id, c.outcome, count(*) as n
              from classified c cross join lateral unnest(c.studios) as s(studio_id)
              group by s.studio_id, c.outcome) d
        group by d.studio_id
    )
    select (select count(*) from updated),
           coalesce((select jsonb_object_agg(o.outcome, o.n)
                     from (select outcome, count(*) as n from classified group by outcome) o), '{}'::jsonb),
           coalesce((select jsonb_agg(jsonb_build_object('studio_id', studio_id, 'counts', counts))
                     from by_district), '[]'::jsonb)
    into v_attributed, v_totals, v_districts;
    perform set_config('cleffy.district_attribution', '', true);

    v_result := jsonb_build_object(
        'attributed', v_attributed,
        'skipped_no_evidence', coalesce((v_totals ->> 'no_evidence')::int, 0),
        'skipped_ambiguous', coalesce((v_totals ->> 'ambiguous')::int, 0),
        'skipped_district_gone', coalesce((v_totals ->> 'district_gone')::int, 0),
        'skipped_before_district', coalesce((v_totals ->> 'before_district')::int, 0),
        'skipped_outside_tenure', coalesce((v_totals ->> 'outside_tenure')::int, 0)
    );

    if v_totals <> '{}'::jsonb then
        for v_district in select * from jsonb_array_elements(v_districts) loop
            insert into public.district_retention_log (studio_id, step, counts)
            values ((v_district ->> 'studio_id')::uuid, 'attribution_backfilled', v_district -> 'counts');
        end loop;
        insert into public.district_retention_log (studio_id, step, counts)
        values (null, 'attribution_backfill_run', v_result);
    end if;
    raise notice 'district attribution backfill: %', v_result;
    return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- List the district's students again: the ones not on its list yet
-- ---------------------------------------------------------------------------
-- The caller holds the district's lock (its billing row FOR UPDATE). Each
-- student attributed to the district (retention_district_students(), the
-- purge's one scope) and not on its list is listed, archived and signed out
-- exactly as the soft delete does it, and the listing is logged. Students
-- already listed are not touched: a second call lists, archives and logs
-- nothing, and a teacher's restore of a listed student stands. Returns how
-- many it listed.
create or replace function public.district_retention_list_late (p_studio uuid, p_now timestamptz, p_by text)
returns int language plpgsql security definer
set search_path = public as $$
declare
    v_late jsonb;
    v_n int;
begin
    with listed as (
        insert into public.district_retention_students (studio_id, managed_student_id, student_user_id, was_archived)
        select p_studio, ds.id, ds.student_user_id, ds.archived_at is not null
        from public.retention_district_students (p_studio) ds
        where not exists (
            select 1 from public.district_retention_students s
            where s.studio_id = p_studio and s.managed_student_id = ds.id
        )
        on conflict do nothing
        returning managed_student_id, student_user_id, was_archived
    )
    select coalesce(jsonb_agg(jsonb_build_object(
               'managed_student_id', l.managed_student_id,
               'student_user_id', l.student_user_id,
               'was_archived', l.was_archived) order by l.managed_student_id), '[]'::jsonb)
    into v_late
    from listed l;

    v_n := jsonb_array_length(v_late);
    if v_n = 0 then
        return 0;
    end if;

    -- As the soft delete: archived and every token refused
    -- (student_access_revoked), under the roster row's lock.
    update public.managed_students ms
    set archived_at = coalesce(ms.archived_at, p_now),
        access_revoked_at = clock_timestamp()
    where ms.id in (select (e ->> 'managed_student_id')::uuid from jsonb_array_elements(v_late) e);

    delete from auth.refresh_tokens
    where user_id in (select e ->> 'student_user_id' from jsonb_array_elements(v_late) e);
    delete from auth.sessions
    where user_id in (select (e ->> 'student_user_id')::uuid from jsonb_array_elements(v_late) e);

    insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
    values (p_studio, 'soft_deleted',
            (select r.contract_ends_at from public.district_retention r where r.studio_id = p_studio),
            jsonb_build_object('event', 'late_students_listed', 'students_archived', v_n,
                               'students', v_late, 'by', p_by));
    return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- The run: the hard delete lists again first, and every run sweeps
-- ---------------------------------------------------------------------------
-- 20261022130000's definition; the hard delete calls
-- district_retention_list_late() before its loop, and after the candidates
-- every soft-deleted district not yet hard deleted is swept, each under its
-- billing row's lock taken the same way.
create or replace function public.retention_district_run (p_now timestamptz default now(), p_batch int default 20)
returns jsonb language plpgsql security definer
set search_path = public, extensions, vault as $$
declare
    candidate record;
    v_billing public.district_billing;
    v_state public.district_retention;
    v_step text;
    v_owner uuid;
    v_email text;
    v_name text;
    v_student record;
    v_roster record;
    v_n int;
    v_late int;
    v_restored int;
    v_restore text;
    v_carried record;
    v_skipped jsonb;
    v_members int;
    v_url text;
    v_secret text;
    v_done jsonb := '{"notice":0,"soft_delete":0,"hard_delete":0,"cancel":0,"students_archived":0,"students_deleted":0,"students_restored":0,"students_skipped_reattributed":0,"students_late_listed":0}';
begin
    for candidate in
        select c.studio_id from public.retention_district_candidates (p_now) c
        order by c.contract_ends_at nulls first
        limit greatest(p_batch, 0)
    loop
        v_billing := null;
        select b.* into v_billing from public.district_billing b where b.studio_id = candidate.studio_id
        for update skip locked;
        if not found and exists (select 1 from public.district_billing b where b.studio_id = candidate.studio_id) then
            continue; -- locked by someone else: tomorrow
        end if;

        v_state := null;
        select r.* into v_state from public.district_retention r where r.studio_id = candidate.studio_id for update;

        v_step := public.retention_district_next_step (v_billing.contract_ends_at, v_state, p_now);

        if v_step = 'cancel' then
            update public.managed_students ms
            set archived_at = null
            from public.district_retention_students s
            where s.studio_id = candidate.studio_id
              and s.managed_student_id = ms.id
              and not s.was_archived
              and ms.archived_at is not null;
            get diagnostics v_n = row_count;
            -- And the ones re-attributed away while the purge was pending, whom
            -- the correction could not restore then: the same check again.
            v_restored := 0;
            for v_carried in
                select r.managed_student_id from public.district_retention_restores r
                where r.studio_id = candidate.studio_id
                order by r.managed_student_id
            loop
                if public.district_reattributed_restore (v_carried.managed_student_id, candidate.studio_id) = 'restored' then
                    v_restored := v_restored + 1;
                end if;
            end loop;
            delete from public.district_retention_restores where studio_id = candidate.studio_id;
            delete from public.district_retention_students where studio_id = candidate.studio_id;
            delete from public.district_retention_notices
            where studio_id = candidate.studio_id and sent_at is null;
            delete from public.district_retention where studio_id = candidate.studio_id;
            insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
            values (candidate.studio_id, 'cancelled', v_state.contract_ends_at,
                    jsonb_build_object('students_restored', v_n + v_restored, 'reattributed_restored', v_restored,
                                       'new_contract_ends_at', v_billing.contract_ends_at));
            v_done := v_done || jsonb_build_object(
                'cancel', (v_done ->> 'cancel')::int + 1,
                'students_restored', (v_done ->> 'students_restored')::int + v_n + v_restored);

        elsif v_step = 'notice' then
            select st.owner_id, st.name, u.email into v_owner, v_name, v_email
            from public.studios st
            left join auth.users u on u.id = st.owner_id
            where st.id = candidate.studio_id;
            if v_email is null then
                -- Nobody to tell, so nothing will be purged: the next stage
                -- waits for a SENT notice. Logged loudly for a human.
                raise warning 'district retention: studio % has no owner address; not purging', candidate.studio_id;
                continue;
            end if;
            insert into public.district_retention (studio_id, owner_id, contract_ends_at, notice_queued_at)
            values (candidate.studio_id, v_owner, v_billing.contract_ends_at, p_now);
            insert into public.district_retention_notices
                (studio_id, owner_id, to_email, studio_name, contract_ends_at, purge_not_before)
            values (candidate.studio_id, v_owner, v_email, v_name, v_billing.contract_ends_at,
                    greatest(v_billing.contract_ends_at + interval '30 days', p_now + interval '14 days'))
            -- A cycle cancelled and begun again for the same date mails again:
            -- the owner may have been told the purge was off.
            on conflict (studio_id, contract_ends_at) do update
            set to_email = excluded.to_email,
                studio_name = excluded.studio_name,
                purge_not_before = excluded.purge_not_before,
                created_at = now(),
                attempts = 0,
                lease_until = null,
                last_error = null,
                sent_at = null;
            insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
            values (candidate.studio_id, 'notice_queued', v_billing.contract_ends_at,
                    jsonb_build_object('students', (select count(*) from public.retention_district_students (candidate.studio_id)),
                                       'members', (select count(*) from public.studio_members sm
                                                   where sm.studio_id = candidate.studio_id)));
            v_done := v_done || jsonb_build_object('notice', (v_done ->> 'notice')::int + 1);

        elsif v_step = 'soft_delete' then
            insert into public.district_retention_students (studio_id, managed_student_id, student_user_id, was_archived)
            select candidate.studio_id, ds.id, ds.student_user_id, ds.archived_at is not null
            from public.retention_district_students (candidate.studio_id) ds
            on conflict do nothing;

            -- Archived and every token refused (student_access_revoked), under
            -- the roster row's lock that student writes share (20261021120400).
            update public.managed_students ms
            set archived_at = coalesce(ms.archived_at, p_now),
                access_revoked_at = clock_timestamp()
            from public.district_retention_students s
            where s.studio_id = candidate.studio_id and s.managed_student_id = ms.id;
            get diagnostics v_n = row_count;

            delete from auth.refresh_tokens
            where user_id in (select s.student_user_id::text from public.district_retention_students s
                              where s.studio_id = candidate.studio_id);
            delete from auth.sessions
            where user_id in (select s.student_user_id from public.district_retention_students s
                              where s.studio_id = candidate.studio_id);

            update public.district_retention set soft_deleted_at = p_now where studio_id = candidate.studio_id;
            insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
            values (candidate.studio_id, 'soft_deleted', v_state.contract_ends_at,
                    jsonb_build_object('students_archived', v_n,
                                       'members', (select count(*) from public.studio_members sm
                                                   where sm.studio_id = candidate.studio_id)));
            v_done := v_done || jsonb_build_object(
                'soft_delete', (v_done ->> 'soft_delete')::int + 1,
                'students_archived', (v_done ->> 'students_archived')::int + v_n);

        elsif v_step = 'hard_delete' then
            -- Everyone attributed to the district now, under its lock (held
            -- since the top of this iteration; a provision takes it too), so
            -- the loop below works from the whole district (20261022130300).
            v_late := public.district_retention_list_late (candidate.studio_id, p_now, 'hard_delete');
            v_done := v_done || jsonb_build_object(
                'students_late_listed', (v_done ->> 'students_late_listed')::int + v_late);

            v_n := 0;
            v_skipped := '[]'::jsonb;
            for v_student in
                select s.managed_student_id, s.student_user_id, s.was_archived
                from public.district_retention_students s
                where s.studio_id = candidate.studio_id
            loop
                -- The roster row's lock, as before (20261021120500's re-check),
                -- and under it the row as it is now: an admin's correction
                -- waits for it, or has committed and is read here.
                select m.district_studio_id, m.student_user_id, m.archived_at into v_roster
                from public.managed_students m
                where m.id = v_student.managed_student_id
                for update of m;
                if not found then
                    continue;
                end if;

                -- Still in the purge's scope (retention_district_students():
                -- the district this row names) and still the account that was
                -- listed. Otherwise a human re-attributed the student after
                -- the soft delete: skipped, and off the list. A student moved
                -- to another district or roster gets back what this purge took,
                -- as the correction would have done; a row whose account is not
                -- the one listed is left as it is, for a human.
                if v_roster.district_studio_id is distinct from candidate.studio_id
                   or v_roster.student_user_id is distinct from v_student.student_user_id then
                    delete from public.district_retention_students
                    where studio_id = candidate.studio_id and managed_student_id = v_student.managed_student_id;
                    v_restore := case
                        when v_roster.student_user_id is distinct from v_student.student_user_id then 'other_account'
                        when v_student.was_archived then 'was_archived'
                        else public.district_reattributed_restore (v_student.managed_student_id, candidate.studio_id) end;
                    v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
                        'managed_student_id', v_student.managed_student_id,
                        'student_user_id', v_student.student_user_id,
                        'was_archived', v_student.was_archived,
                        'now_district_studio_id', v_roster.district_studio_id,
                        'restore', v_restore));
                    continue;
                end if;

                -- Still archived (a teacher's restore since the soft delete
                -- wins) and still a provisioned student.
                if v_roster.archived_at is not null and exists (
                    select 1 from auth.users u
                    where u.id = v_student.student_user_id
                      and u.raw_app_meta_data ->> 'user_type' = 'student'
                ) then
                    perform public.scrub_student_markings (v_student.student_user_id);
                    delete from auth.users where id = v_student.student_user_id;
                    v_n := v_n + 1;
                end if;
            end loop;

            if jsonb_array_length(v_skipped) > 0 then
                insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
                values (candidate.studio_id, 'attribution_changed', v_state.contract_ends_at,
                        jsonb_build_object('event', 'skipped_reattributed',
                                           'students_skipped', jsonb_array_length(v_skipped),
                                           'students', v_skipped, 'by', 'retention_district_run'));
            end if;

            select count(*) into v_members from public.studio_members sm where sm.studio_id = candidate.studio_id;
            -- Takes the seats, the override and the billing record with it.
            delete from public.studios where id = candidate.studio_id;
            delete from public.district_retention_students where studio_id = candidate.studio_id;
            delete from public.district_retention_restores where studio_id = candidate.studio_id;
            update public.district_retention set hard_deleted_at = p_now where studio_id = candidate.studio_id;
            insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
            values (candidate.studio_id, 'hard_deleted', v_state.contract_ends_at,
                    jsonb_build_object('students_deleted', v_n, 'members_removed', v_members, 'studios', 1));
            v_done := v_done || jsonb_build_object(
                'hard_delete', (v_done ->> 'hard_delete')::int + 1,
                'students_deleted', (v_done ->> 'students_deleted')::int + v_n,
                'students_skipped_reattributed',
                (v_done ->> 'students_skipped_reattributed')::int + jsonb_array_length(v_skipped));
        end if;
    end loop;

    -- The sweep (20261022130300): every soft-deleted district not yet hard
    -- deleted lists anyone attributed to it since its list was taken. Locked
    -- as above, SKIP LOCKED included (a provision in flight: tomorrow). A
    -- district whose next step is its cancel is left to it; one whose billing
    -- record is gone has nobody left to provision into it, and its cycle is
    -- the cancel's too.
    for candidate in
        select r.studio_id from public.district_retention r
        where r.soft_deleted_at is not null and r.hard_deleted_at is null
        order by r.studio_id
    loop
        select b.* into v_billing from public.district_billing b where b.studio_id = candidate.studio_id
        for update skip locked;
        if not found then
            continue;
        end if;
        select r.* into v_state from public.district_retention r where r.studio_id = candidate.studio_id for update;
        if not found or v_state.soft_deleted_at is null or v_state.hard_deleted_at is not null
           or public.retention_district_next_step (v_billing.contract_ends_at, v_state, p_now) = 'cancel' then
            continue;
        end if;
        v_late := public.district_retention_list_late (candidate.studio_id, p_now, 'sweep');
        v_done := v_done || jsonb_build_object(
            'students_late_listed', (v_done ->> 'students_late_listed')::int + v_late);
    end loop;

    -- Wake the sender when there is mail to send. No-op without its secrets.
    if exists (select 1 from public.district_retention_notices where sent_at is null) then
        begin
            select decrypted_secret into v_url from vault.decrypted_secrets where name = 'district_notice_url' limit 1;
            select decrypted_secret into v_secret from vault.decrypted_secrets
            where name = 'district_notice_secret' limit 1;
            if v_url is not null and v_secret is not null then
                perform net.http_post(
                    url := v_url,
                    headers := jsonb_build_object('Content-Type', 'application/json', 'x-district-notice-secret', v_secret),
                    body := '{}'::jsonb,
                    timeout_milliseconds := 5000
                );
            end if;
        exception
            when others then
                raise warning 'district retention: could not wake the notice sender: %', sqlerrm;
        end;
    end if;

    return v_done;
end;
$$;

do $$
declare
    fn text;
begin
    foreach fn in array array[
        'public.district_deletion_pending (uuid)',
        'public.district_provision_refusal (uuid, uuid)',
        'public.district_provisionable (uuid, uuid)',
        'public.managed_students_district_attribution ()',
        'public.admin_set_student_district (uuid, uuid, text)',
        'public.backfill_district_student_attribution ()',
        'public.retention_district_run (timestamptz, int)'
    ]
    loop
        execute format('revoke all on function %s from public, anon, authenticated', fn);
        execute format('grant execute on function %s to service_role', fn);
    end loop;
end;
$$;

-- Internal: only the run calls it, under the district's lock. Not even the
-- service role calls it directly (it archives students, and its caller must
-- hold the lock), whatever the project's default privileges gave it.
revoke all on function public.district_retention_list_late (uuid, timestamptz, text)
from public, anon, authenticated, service_role;

-- DEPLOY: apply before deploying student-provision (it asks
-- district_provision_refusal() when district_provisionable() says no).
-- retention_district_run() stays unscheduled (20261021120700's DEPLOY note).
```
