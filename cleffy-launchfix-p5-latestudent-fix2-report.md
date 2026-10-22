# Cleffy P5 #66 late-student fix, round 2 (Codex REVISE): report

**Status:** Complete

- **PR:** #66 (draft, base `dev`), branch `mh/launchfix-p5-district-retention`. Title, body, draft state and base untouched; no new PR opened.
- **Starting head:** `5ebeb8659a959b6b1dcc359889805244624abb0d` (5ebeb865), confirmed on `origin/mh/launchfix-p5-district-retention` at session start and again right before the push.
- **New PR #66 head:** `45016408e00f6d8143b5e91512477935677f7b60`
- **Environment:** Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (`environment_kind: anthropic_cloud`, confirmed with `get_session` at the start), not Sandbox. Local Supabase stack only (`npm run cloud:up`, then `npm run cloud:down` at the end). No hosted Supabase, Vercel, Stripe or other hosted service was touched.
- **Codex review:** not requested or run (Cleffy runs the next one). No messages sent to any session or agent; no handoff.

## 1. Pushes

| Push | Command | Result |
| --- | --- | --- |
| PR branch | `git push origin HEAD:mh/launchfix-p5-district-retention` | `5ebeb86..4501640  HEAD -> mh/launchfix-p5-district-retention`: a fast-forward (no `+`, no force). Right before it, `git fetch origin` showed `origin/mh/launchfix-p5-district-retention` = `5ebeb8659a959b6b1dcc359889805244624abb0d`, and `git merge-base --is-ancestor` confirmed 5ebeb865 is an ancestor of the new head. |
| Report branch | `git push origin HEAD:claude/launchfix-p5-latestudent-fix2-report` | New branch, created from `4501640` plus one commit adding this file. Not on the PR branch. |

No `--force`, `--force-with-lease`, rebase, amend or squash. No other branch was touched (every earlier `claude/launchfix-*` report branch, `dev`, `main`, #54, #67 untouched).

## 2. New commit on the PR branch

| SHA | Summary | Files |
| --- | --- | --- |
| `45016408e00f6d8143b5e91512477935677f7b60` | launchfix P5: a student moved out is never listed; corrections lock in the run's order | `supabase/migrations/20261022130400_district_retention_moveout_locks.sql` (new, 638 lines), `scripts/apply-migrations.sql` (mirror, +640), `tests/sql/district_retention_moveout_race.sql` (new), `tests/sql/district_retention_admin_lock_order.sql` (new), `tests/sql/migrations_ordered_replay.sql` (+1: replays 130400), `tests/legal/districtMoveOutLocks.test.ts` (new, 8 shape tests), `tests/legal/districtReattribution.test.ts` (the ordered-replay tail now ends in 130400) |

Author and committer: Max Harris <drumaxter@gmail.com>. One commit, so every pushed commit is green (the proofs were run against 5ebeb865 before the fix existed; section 5).

### Migration choice: a new migration, 20261022130400

I added `20261022130400_district_retention_moveout_locks.sql` instead of editing 130300 in place. It is the repo's own pattern (each fix replaces the previous definition in a new file and says whose definition it extends). It also leaves the reviewed 130300 byte-for-byte as Codex read it, so the next review's diff is exactly the fix. Editing 130300 would have been possible (never applied to a hosted DB, #66 unmerged) but was not clearly better. 130400 only uses `create or replace function` for four existing functions. It adds no table, trigger, constraint or log step and is rerunnable (applied twice locally, and replayed by `migrations_ordered_replay.sql`). 20261022130200 stays dropped.

### Migration order (the 2026102213xxxx range)

1. `20261022130000_district_retention_reattribution.sql`
2. `20261022130100_content_strikes_survive_deletion.sql`
3. (20261022130200: dropped, not restored)
4. `20261022130300_district_retention_late_students.sql` (unchanged)
5. `20261022130400_district_retention_moveout_locks.sql` (new)

`npm run migrations:mirror` regenerated `scripts/apply-migrations.sql`: the only change is 130400 appended, with its `-- ===== supabase/migrations/20261022130400_... =====` header (+640 lines). I did not run the supabase-drift check locally because it reads the live project. In CI it ran with its token and passed: "migrations: 124 in this branch, 27 applied on jibgwgosihadbjgxdsfe", every other migration (130300 and 130400 included) "pending, will apply on merge", and nothing applied that is absent from the branch, so **supabase-drift is clean** (section 7).

## 3. MAJOR fix: lock each roster row, then re-check its district

**What was wrong (130300:354-387).** `district_retention_list_late()` inserted its list entries from a snapshot of `retention_district_students()`. It locked the roster rows only in the later archive UPDATE, which matched on the captured ids. A student whose move out (`admin_set_student_district(student, null)`) was in flight was listed. Once the move committed, the student was archived, their access revoked, and their sessions and refresh tokens deleted.

**Fix, in `supabase/migrations/20261022130400_district_retention_moveout_locks.sql`:**

- **The sweep and the hard delete's re-list, `district_retention_list_late()` (130400:239-313).** Both call this one function: the sweep from 130400:586 and the hard delete from 130400:481.
  - 130400:247-260 first locks the roster rows of the district's unlisted students, `FOR UPDATE` in ascending roster id, so any change in flight is waited for.
  - 130400:270-281 then lists, in a new statement under those locks, only rows still attributed to the district through `retention_district_students()` (the purge's one scope) and among the locked ids (`where ds.id = any (v_locked)`). `was_archived` comes from the row as it is now.
  - Archiving and revoking (UPDATE at 130400:296, deletes from `auth.refresh_tokens` and `auth.sessions`) only touch rows that were listed.
  - A student moved out meanwhile is skipped: not listed, `was_archived` not recorded, nothing revoked, nothing logged.
  - The roster lock is taken before the list entry, the same order as the correction RPC (roster row, then list entries).
- **The hard delete's own loop** (130400:487-538, 20261022130000's re-check under `for update of m` at 130400:498) is unchanged. It already re-checked each row under its lock.
- **The original soft-delete listing in `retention_district_run()` (130400:432-450): fixed too.** The change was small and contained: the same lock-then-list, with `v_locked` declared at 130400:336. Copying the run's body into 130400 is the repo's usual way of replacing it; no other line of the run changed (verified by diffing against 130300's body).

**Why the move-out race is closed twice.** After the MINOR fix, `admin_set_student_district(student, null)` holds the old district's billing row `FOR KEY SHARE`, so a run reaching that district passes it over (`SKIP LOCKED`) until the next run. The new proof shows this in M1: the sweep finishes without waiting, and the next run lists only the student who stayed. The lock-and-recheck is the backstop for any change that holds no district lock. M2 to M4 prove it by making the move with the roster trigger off for that one UPDATE, the convention the late-student proofs already use for rows written past the barrier.

## 4. MINOR fix: corrections take the districts' locks in the run's order

**What was wrong (130300:165, 130300:193-196).** A raw admin-flagged UPDATE locks the roster row before its BEFORE UPDATE trigger takes the destination's billing lock: roster, then billing, the reverse of the run. `admin_set_student_district()` locked only the destination, so a move out took no district lock at all.

**Fix:**

- **`admin_set_student_district()` (130400:155-231).**
  - 130400:167-172 reads the student's current district without a lock.
  - 130400:173-179 takes the billing rows of the old district and the new one with `FOR KEY SHARE`, in `order by b.studio_id` (ascending studio id). A move to null takes the old district's lock alone; a same-district re-confirm takes one row.
  - Only then does 130400:180 lock the roster row `FOR UPDATE`.
  - If the district changed between the unlocked read and the row lock (another correction got in between), 130400:184-190 refuses with SQLSTATE `40001` and a retry message. Taking the new district's lock under the row's would be the reverse order.
  - Everything after that is 130300's definition, unchanged.
- **Raw admin UPDATEs, roster trigger `managed_students_district_attribution()` (130400:83-147).** Such an UPDATE cannot prelock: PostgreSQL locks the row before the trigger runs. So I used the trigger-side alternative Codex named, a lock attempt that does not block, with explicit retry behaviour.
  - On an UPDATE that changes `district_studio_id`, 130400:126-136 takes the billing rows of the old and new districts with `FOR KEY SHARE NOWAIT`, in ascending studio id.
  - Through `admin_set_student_district()` and the backfill those locks are already held, so the attempt always succeeds.
  - A raw UPDATE that finds a run holding either district is refused at once with SQLSTATE `55P03` and the message `district_busy`. The hint says to retry, or to use `admin_set_student_district()`, which waits its turn.
  - The caller retries the statement in a new transaction. The proof's L2 does this and the retry succeeds once the run has committed.
  - I chose this over a retry loop inside the trigger: the trigger already holds the roster row, and the run may be waiting for that row, so retrying under it only delays the run until the loop gives up.
  - The barrier check (`district_deletion_pending`, 55000) follows the lock, as before.
  - The INSERT path is 130300's, unchanged: a blocking `FOR KEY SHARE` on the new district, because a new row is nobody else's to wait for.

### The final lock order

**District billing row(s) → `district_retention` row (run only) → roster row(s) → purge list entries / restores.**

| Path | Order |
| --- | --- |
| Retention run (candidate loop and sweep) | billing `FOR UPDATE SKIP LOCKED` (130400:352-353, 576-577), then `district_retention` `FOR UPDATE`, then roster rows `FOR UPDATE` in ascending id (list_late, soft delete) or one at a time (the hard-delete loop), then list entries |
| `admin_set_student_district()` | billing rows of old and new `FOR KEY SHARE`, ascending studio id (130400:176-179), then roster row `FOR UPDATE` (130400:180), then list entries deleted, restores |
| Backfill (130300, unchanged) | every evidence district's billing `FOR KEY SHARE`, ascending studio id (130300:258-267), then roster UPDATE (legacy rows have no district to leave) |
| Raw admin-flagged UPDATE | roster row (by PostgreSQL), then billing of old and new `FOR KEY SHARE NOWAIT`, ascending studio id (130400:126-130). It never waits under the row: a conflict raises 55P03 and releases everything on rollback, so it cannot close a cycle |
| Roster INSERT (student-provision, 130300) | new district's billing `FOR KEY SHARE`, then the account-deletion advisory lock (its own trigger). There is no prior roster lock |
| Existing district lock users: `district_billing_rederive()` (20261020181000:84), `admin_set_district_contract_end()` (through it) | one billing row `FOR UPDATE`, no roster rows: nothing to invert |

**Why this cannot deadlock.**

- The run never waits on a billing row (`SKIP LOCKED`).
- Every path that waits on a billing row (the correction, the backfill, an INSERT) holds no roster row while it waits.
- The one path that holds a roster row before touching billing (the raw UPDATE) never waits on billing (`NOWAIT`).
- Billing rows are always taken in ascending studio id, and `KEY SHARE` locks do not conflict with each other.

So no transaction can wait for a billing row while holding a roster row that a billing-row holder waits for. The `KEY SHARE` locks also keep 130300's existing guarantees: a correction in flight makes the run pass the district over, and a run in progress makes the correction wait.

## 5. Proofs

### 5.1 New: `tests/sql/district_retention_moveout_race.sql` (MAJOR, real two-session dblink)

The scenarios:

- **M1 (the packet's scenario).** Session A runs `admin_set_student_district(b1, null, ...)` and leaves it uncommitted. Session B runs `retention_district_run(now())` (the sweep). Then A commits and B's answer is read and committed. The proof checks that b1 is not listed, not archived, `access_revoked_at` is null, b1's `auth.sessions` and `auth.refresh_tokens` rows remain, and no late-listing log names b1. The next run lists only c1, who stayed.
- **M2, M3, M4.** The same move made with no district lock (the roster trigger off for that one UPDATE), against the sweep, the hard delete's re-list and the soft delete's own listing. Each proves the lock-and-recheck by itself: B waits for the move, then skips the student who left and lists, archives and deletes the one who stayed.

**Fail-before, against 5ebeb865** (run at 5ebeb865 before the fix was written; reproduced verbatim with the committed file by re-applying 130300's definitions to the local DB, `exit 1`):

```
1 | 0 no other district would be touched by a run now (the runs are real) | t | 
2 | M1a the sweep run while the move was open finished (while it was open: waiting) | t | {"cancel": 0, "notice": 0, "hard_delete": 0, "soft_delete": 0, "students_deleted": 0, "students_archived": 0, "students_restored": 0, "students_late_listed": 2, "students_skipped_reattributed": 0}
3 | M1b once the move committed, b1 is out of X1 and untouched: not listed, not archived, not revoked, signed in | f | 
4 | M1c the next run listed, archived and signed out c1, who stayed, and still not b1 | f | 
5 | M2a the sweep waited for the open move | t | waiting
6 | M2b and then finished | t | {"cancel": 0, "notice": 0, "hard_delete": 0, "soft_delete": 0, "students_deleted": 0, "students_archived": 0, "students_restored": 0, "students_late_listed": 2, "students_skipped_reattributed": 0}
7 | M2c b2, who left X2 while the sweep waited, is untouched | f | 
8 | M2d c2, who stayed, was listed, archived and signed out by the same sweep | f | 
9 | M3a the hard delete waited for the open move | t | waiting
10 | M3b and then deleted X3, re-listing and deleting c3, who stayed | f | 
11 | M3c b3, who left X3 while the hard delete waited, is untouched (and was never on the list) | f | 
12 | M4a the soft delete waited for the open move | t | waiting
13 | M4b and then soft deleted X4, listing, archiving and signing out c4, who stayed | t | 
14 | M4c b4, who left X4 while the soft delete waited, is untouched | f | 
15 | Z the race's accounts, districts, lists, notices and logs are gone again | t | 
7 | 15
::error file=tests/sql/district_retention_moveout_race.sql::tests/sql/district_retention_moveout_race.sql did not pass (failures | total: 7 | 15; failing: 10 11 14 3 4 7 8)
```

**Pass-after, with 130400** (`exit 0`):

```
1 | 0 no other district would be touched by a run now (the runs are real) | t | 
2 | M1a the sweep run while the move was open finished (while it was open: finished) | t | {"cancel": 0, "notice": 0, "hard_delete": 0, "soft_delete": 0, "students_deleted": 0, "students_archived": 0, "students_restored": 0, "students_late_listed": 0, "students_skipped_reattributed": 0}
3 | M1b once the move committed, b1 is out of X1 and untouched: not listed, not archived, not revoked, signed in | t | 
4 | M1c the next run listed, archived and signed out c1, who stayed, and still not b1 | t | 
5 | M2a the sweep waited for the open move | t | waiting
6 | M2b and then finished | t | {"cancel": 0, "notice": 0, "hard_delete": 0, "soft_delete": 0, "students_deleted": 0, "students_archived": 0, "students_restored": 0, "students_late_listed": 1, "students_skipped_reattributed": 0}
7 | M2c b2, who left X2 while the sweep waited, is untouched | t | 
8 | M2d c2, who stayed, was listed, archived and signed out by the same sweep | t | 
9 | M3a the hard delete waited for the open move | t | waiting
10 | M3b and then deleted X3, re-listing and deleting c3, who stayed | t | 
11 | M3c b3, who left X3 while the hard delete waited, is untouched (and was never on the list) | t | 
12 | M4a the soft delete waited for the open move | t | waiting
13 | M4b and then soft deleted X4, listing, archiving and signing out c4, who stayed | t | 
14 | M4c b4, who left X4 while the soft delete waited, is untouched | t | 
15 | Z the race's accounts, districts, lists, notices and logs are gone again | t | 
0 | 15
OK tests/sql/district_retention_moveout_race.sql: 15 checks passed
```

In M1 the sweep now finishes without waiting (`while it was open: finished`, `students_late_listed: 0`). The correction holds X1's billing row `FOR KEY SHARE`, so the sweep passes X1 over (`SKIP LOCKED`), and the next run lists only c1. In M2 to M4 the run waits for the row and then skips the student who left. Before the fix it archived and signed out all four (b1 to b4).

### 5.2 New: `tests/sql/district_retention_admin_lock_order.sql` (MINOR, no deadlock, real dblink)

A fourth session holds the swept district's `district_retention` row. That stops the run part-way, holding the districts it has already passed, while the correction starts.

- **L1.** `admin_set_student_district` moves r1 from soft-deleted S1 into live N1 while the run holds N1 (N1's notice). The correction waits and both finish.
- **L2.** The same move as a raw admin-flagged UPDATE. Against 5ebeb865 this deadlocked (`deadlock detected`). With 130400 it is refused at once with `55P03 district_busy`, the run finishes, and the retried UPDATE goes through.
- **L3.** `admin_set_student_district(r3, null)`, the move out, while the run holds S3. It now takes S3's lock, so it waits and both finish.

**Against 5ebeb865** (deadlock reproduced; `exit 1`):

```
psql:tests/sql/district_retention_admin_lock_order.sql:275: NOTICE:  deadlock detected
DETAIL:  Process 985 waits for ShareLock on transaction 5513; blocked by process 986.
Process 986 waits for ShareLock on transaction 5514; blocked by process 985.
HINT:  See server log for query details.
1 | 0 no other district would be touched by a run now (the runs are real) | t | 
2 | L1a the run was held at S1, past N1 | t | waiting
3 | L1b the correction waited for the run | t | waiting
4 | L1c the run finished: N1's notice queued, r1 listed in S1 | t | {"cancel": 0, "notice": 1, "hard_delete": 0, "soft_delete": 0, "students_deleted": 0, "students_archived": 0, "students_restored": 0, "students_late_listed": 1, "students_skipped_reattributed": 0}
5 | L1d and so did the correction, after it | t | 
6 | L1e r1 is in N1 now, and off S1's list | t | 
7 | L2a the run was held at S2, past N2 | t | waiting
8 | L2b no deadlock: neither the run nor the UPDATE was aborted as a deadlock victim | f | run: {"cancel": 0, "notice": 1, "hard_delete": 0, "soft_delete": 0, "students_deleted": 0, "students_archived": 0, "students_ / update: ERROR: ERROR: deadlock detected DETAIL: Process 985 waits for ShareLock on transaction 5513; blocked by process 986. Process 986 waits for ShareLock on transaction 5514; blocked by process 985. HINT: See server log for query details. CONTEXT: while locking tuple (0,7) in relation "district_billing" SQL statement "SELECT 1 from public.district_billing b where b.studio_id = new.district_studio_id for key share" PL/pgSQL function managed_students_district_attribution() line 38 at PERFORM
9 | L2c the UPDATE did not wait on the run: refused at once, district_busy | f | waiting: ERROR: ERROR: deadlock detected DETAIL: Process 985 waits for ShareLock on transaction 5513; blocked by process 986. Process 986 waits for ShareLock on transaction 5514; blocked by process 985. HINT: See server log for query details. CONTEXT: while locking tuple (0,7) in relation "district_billing" SQL statement "SELECT 1 from public.district_billing b where b.studio_id = new.district_studio_id for key share" PL/pgSQL function managed_students_district_attribution() line 38 at PERFORM
10 | L2d the run finished: N2's notice queued, r2 listed in S2 | t | {"cancel": 0, "notice": 1, "hard_delete": 0, "soft_delete": 0, "students_deleted": 0, "students_archived": 0, "students_restored": 0, "students_late_listed": 1, "students_skipped_reattributed": 0}
11 | L2e retried after the run, the UPDATE moved r2 into N2 | t | d5800000-0000-4000-8000-0000000005b4
12 | L3a the run was held at S3, S3's billing row locked | t | waiting
13 | L3b the move out took S3's lock too, so it waited for the run | f | finished
14 | L3c the run finished (r3 listed in S3), and so did the move out, after it | f | {"cancel": 0, "notice": 0, "hard_delete": 0, "soft_delete": 0, "students_deleted": 0, "students_archived": 0, "students_restored": 0, "students_late_listed": 0, "students_skipped_reattributed": 0} / 
15 | L3d r3 is private now, and off S3's list | t | 
16 | Z the proof's accounts, districts, lists, notices and logs are gone again | t | 
4 | 16
::error file=tests/sql/district_retention_admin_lock_order.sql::tests/sql/district_retention_admin_lock_order.sql did not pass (failures | total: 4 | 16; failing: 13 14 8 9)
```

**With 130400** (`exit 0`):

```
psql:tests/sql/district_retention_admin_lock_order.sql:275: NOTICE:  district_busy
HINT:  A retention run holds the district this student is leaving or joining. Retry, or use admin_set_student_district(), which waits for it.
1 | 0 no other district would be touched by a run now (the runs are real) | t | 
2 | L1a the run was held at S1, past N1 | t | waiting
3 | L1b the correction waited for the run | t | waiting
4 | L1c the run finished: N1's notice queued, r1 listed in S1 | t | {"cancel": 0, "notice": 1, "hard_delete": 0, "soft_delete": 0, "students_deleted": 0, "students_archived": 0, "students_restored": 0, "students_late_listed": 1, "students_skipped_reattributed": 0}
5 | L1d and so did the correction, after it | t | 
6 | L1e r1 is in N1 now, and off S1's list | t | 
7 | L2a the run was held at S2, past N2 | t | waiting
8 | L2b no deadlock: neither the run nor the UPDATE was aborted as a deadlock victim | t | run: {"cancel": 0, "notice": 1, "hard_delete": 0, "soft_delete": 0, "students_deleted": 0, "students_archived": 0, "students_ / update: ERROR: ERROR: district_busy HINT: A retention run holds the district this student is leaving or joining. Retry, or use admin_set_student_district(), which waits for it. CONTEXT: PL/pgSQL function managed_students_district_attribution() line 49 at RAISE
9 | L2c the UPDATE did not wait on the run: refused at once, district_busy | t | finished: ERROR: ERROR: district_busy HINT: A retention run holds the district this student is leaving or joining. Retry, or use admin_set_student_district(), which waits for it. CONTEXT: PL/pgSQL function managed_students_district_attribution() line 49 at RAISE
10 | L2d the run finished: N2's notice queued, r2 listed in S2 | t | {"cancel": 0, "notice": 1, "hard_delete": 0, "soft_delete": 0, "students_deleted": 0, "students_archived": 0, "students_restored": 0, "students_late_listed": 1, "students_skipped_reattributed": 0}
11 | L2e retried after the run, the UPDATE moved r2 into N2 | t | d5800000-0000-4000-8000-0000000005b4
12 | L3a the run was held at S3, S3's billing row locked | t | waiting
13 | L3b the move out took S3's lock too, so it waited for the run | t | waiting
14 | L3c the run finished (r3 listed in S3), and so did the move out, after it | t | {"cancel": 0, "notice": 0, "hard_delete": 0, "soft_delete": 0, "students_deleted": 0, "students_archived": 0, "students_restored": 0, "students_late_listed": 1, "students_skipped_reattributed": 0} / 
15 | L3d r3 is private now, and off S3's list | t | 
16 | Z the proof's accounts, districts, lists, notices and logs are gone again | t | 
0 | 16
OK tests/sql/district_retention_admin_lock_order.sql: 16 checks passed
```

### 5.3 Every proof, the way CI runs them

I ran these on the local stack after `npx supabase db reset`, which applies all 124 migrations through 20261022130400 as CI's `supabase start` does; Realtime's partition was present. Then ci.yml's "Re-apply the cancel-link and launchfix P1 migrations" step, and its loop: `bash scripts/ci/sql-proof.sh "$DB_URL" "$proof"` for each `tests/sql/*.sql` and `supabase/sql-tests/sharing_access_control.sql`. **54 of 54 OK** (52 before plus the 2 new). Re-apply OK.

```
re-apply OK
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
OK tests/sql/content_strikes_survive_deletion.sql: 42 checks passed
OK tests/sql/cross_branch_integration.sql: 39 checks passed
OK tests/sql/deployment_config.sql: 34 checks passed
OK tests/sql/district_billing_canonical.sql: 12 checks passed
OK tests/sql/district_migrations_rerunnable.sql: 20 checks passed
OK tests/sql/district_provision_barrier.sql: 18 checks passed
OK tests/sql/district_read_only_seats.sql: 68 checks passed
OK tests/sql/district_retention.sql: 28 checks passed
OK tests/sql/district_retention_admin_lock_order.sql: 16 checks passed
OK tests/sql/district_retention_late_student.sql: 6 checks passed
OK tests/sql/district_retention_late_student_race.sql: 12 checks passed
OK tests/sql/district_retention_moveout_race.sql: 15 checks passed
OK tests/sql/district_retention_reattribution.sql: 24 checks passed
OK tests/sql/district_retention_relist_idempotent.sql: 9 checks passed
OK tests/sql/district_seat_cap.sql: 192 checks passed
OK tests/sql/district_seats.sql: 58 checks passed
OK tests/sql/district_student_scope.sql: 47 checks passed
OK tests/sql/edge_rate_limit_refund.sql: 10 checks passed
OK tests/sql/explicit_grants.sql: 22 checks passed
OK tests/sql/guest_email_verification.sql: 53 checks passed
OK tests/sql/launch_checkout_fixes.sql: 46 checks passed
OK tests/sql/launch_consent.sql: 43 checks passed
OK tests/sql/migrations_ordered_replay.sql: 9 checks passed
OK tests/sql/one_studio_per_owner.sql: 30 checks passed
OK tests/sql/qa3_cross_branch.sql: 12 checks passed
OK tests/sql/realtime_revocation_race.sql: 53 checks passed
OK tests/sql/realtime_revocation_rotation.sql: 88 checks passed
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
ALL PROOFS OK
```

Named in the task, all unchanged and passing:

- `district_provision_barrier` 18
- `district_retention_late_student` 6
- `district_retention_late_student_race` 12
- `district_retention_relist_idempotent` 9
- `migrations_ordered_replay` 9 (now also replays 130400)

**The every-proof loop.** ci.yml's supabase-local step runs `for proof in tests/sql/*.sql supabase/sql-tests/sharing_access_control.sql` with `declare -A SKIP=()` empty. Both new files are under `tests/sql/`, so the loop picks them up as they are. **ci.yml is unchanged (no diff)**, with no SKIP entries. CI's own log confirms it: both supabase-local jobs list `OK tests/sql/district_retention_moveout_race.sql: 15 checks passed` and `OK tests/sql/district_retention_admin_lock_order.sql: 16 checks passed` among 54 OK proofs.

## 6. Local checks (on the pushed commit)

| Check | Result |
| --- | --- |
| `npm run lint:check` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm test` (full vitest, includes `tests/security/explicitServiceRoleGrants.test.ts`) | **242 files passed, 6 skipped; 3769 tests passed, 20 skipped**, exit 0. This is 5ebeb865's 3761 plus the 8 new tests in `districtMoveOutLocks.test.ts`. I ran it in a clean worktree at the pushed commit (see note) |
| `npm run build` | exit 0 |
| `deno check --config supabase/functions/deno.json supabase/functions/*/index.ts` | exit 0, all 23 entry points. Deno is not on this container's PATH, so I installed **deno 2.1.4**, the version CI's edge-functions-deno job pins, from npm into my scratchpad |
| `npx prettier --check` on changed TS files | clean (SQL files are not prettier-formatted in this repo) |
| SQL proofs | 54/54 (section 5.3) |

**Note on vitest.** In the main checkout, `npm test` showed 2 failures unrelated to this change:

- `src/sync/syncEngine.test.ts` "backs off exponentially…" fails whenever the `.env.local` that `npm run cloud:up` writes is present. It reproduces on a clean 5ebeb865 worktree with that file copied in, and passes without it.
- `tests/auth/turnstileField.test.tsx` passed on rerun, so it was a flake.

CI has no `.env.local`. The clean-worktree run above is the authoritative count, and CI's own count is in section 7.

## 7. CI on the final head `45016408e00f6d8143b5e91512477935677f7b60`

Both runs **success**; no check failed and nothing was re-run.

| Check | pull_request run 39823895549 | push run 39823888902 |
| --- | --- | --- |
| checks (lint, typecheck, vitest, build) | success (job 119981960417): vitest 242 files passed, 6 skipped; **3769 passed, 20 skipped** | success (job 119981936295): same counts |
| supabase-local (every SQL proof) | success (job 119981960556): **54 of 54 proofs OK**, including `district_retention_moveout_race` 15, `district_retention_admin_lock_order` 16, `district_provision_barrier` 18, `district_retention_late_student` 6, `district_retention_late_student_race` 12, `district_retention_relist_idempotent` 9, `migrations_ordered_replay` 9 | success (job 119981936603): same, 54 of 54 |
| supabase-drift | success (job 119981960237): the check ran (token present, not the INERT warning). It reported "migrations: 124 in this branch, 27 applied on jibgwgosihadbjgxdsfe", every other one "pending, will apply on merge", and no applied-but-absent migration: **clean** | success (job 119981936446): same |
| edge-functions-deno | success (job 119981959933) | success (job 119981936359) |
| omr-service | success (job 119981960379) | success (job 119981936403) |
| Supabase Preview | skipped (preview branching off, as before) | |
| Vercel (commit status) | success, "Deployment has completed". No "Deployment rate limited" this time; no Vercel action taken | |
| Vercel Preview Comments | success | |

PR #66 after the push: open, **draft**, base `dev`, head `45016408e00f6d8143b5e91512477935677f7b60`.

## 8. Follow-ups (out of scope, left alone as instructed)

- A teacher's restore during the purge still wins (20261021120700). Per decision 68(2), the hard delete should later detach restored students (clear `district_studio_id`) so nothing dangles.
- The barrier starts at soft delete, not at the 14-day notice (decision 68(1)).
- A renewal lifting the barrier waits for the next daily run; lifting it immediately is a follow-up (decision 68(3)).
- The overlapping-purges residual (decisions 47 and 66(1)).
- Pre-existing, noted by Codex and not charged: student-provision's Auth-user cleanup after a 409 is best-effort, and a failed cleanup logs an orphan.

## 9. Open questions (for Cleffy or Max; none blocked this round)

1. **Raw admin UPDATEs now fail fast.** An admin-flagged UPDATE that changes `district_studio_id` while a retention run holds either district is now refused with `55P03 district_busy` instead of waiting. Before, it waited and could deadlock. Any runbook that corrects attribution with raw SQL should use `admin_set_student_district()`, which waits its turn, or retry on 55P03. Is that acceptable as the documented behaviour?
2. **New 40001 refusal in `admin_set_student_district()`.** It now refuses with `40001` (retry) if the student's district changes between its unlocked read and its row lock, which only happens when another correction races it. OK?
3. **A correction delays the run by a day.** A correction in flight on a district (it holds `KEY SHARE`) makes that day's run pass the district over, including a due soft or hard delete. This is the same `SKIP LOCKED` behaviour 130300 already has for provisions. Fine as is?

## 10. What I could not do

- Nothing required was left undone.
- The supabase-drift check was not run locally, because it reads the live project. CI ran it (section 7).
- Deno was not preinstalled. I installed CI's pinned version, 2.1.4, into my scratchpad (not the repo) to run `deno check`.
- The fail-before outputs come from re-applying 130300's definitions to the local database. 130300 defines all four functions 130400 replaces, so this restores 5ebeb865's behaviour exactly. I also ran both proofs at 5ebeb865 before the fix was written, with the same verdicts.

## 11. Hosted steps left for Max (none performed)

- Apply, in order, `20261022130300_district_retention_late_students.sql` then `20261022130400_district_retention_moveout_locks.sql` to the hosted projects through the normal path, before deploying `student-provision` and inside the freeze (decision 68(4)). 130400 changes no edge function, so nothing else needs redeploying for it.
- `retention_district_run()` stays unscheduled (20261021120700's DEPLOY note); nothing to schedule.
- Nothing else. No hosted Supabase, Vercel or Stripe action was taken from this session.

## Appendix: full SQL of the new migration `supabase/migrations/20261022130400_district_retention_moveout_locks.sql`

```sql
-- District retention: a student moved out of a district is never listed by
-- its purge, and an admin's correction takes the districts' locks in the
-- run's order.
--
-- Codex's narrow review of 20261022130300 (REVISE), both findings:
--
--  (1) MAJOR. The run listed a district's students from a snapshot and locked
--      their roster rows only to archive them, without looking at the rows
--      again. A student an admin was moving out of the district (the
--      correction open, admin_set_student_district (student, null, ...)) was
--      read as still in it; the run's UPDATE waited for the correction, and
--      once it committed archived the student anyway, and deleted their
--      sessions and refresh tokens. Now the roster rows are locked first (FOR
--      UPDATE, in roster order) and the district re-read under the locks,
--      before anything is listed, was_archived recorded or anything revoked:
--      a student the district no longer names is skipped. In
--      district_retention_list_late() (the sweep, every run, and the hard
--      delete's re-list right before it deletes) and in the soft delete's own
--      listing in retention_district_run() (the same pattern, pre-existing,
--      and a contained change). The hard delete's loop already re-checks each
--      row under its lock (20261021120500, 20261022130000), unchanged.
--
--  (2) MINOR. A correction moving a student between districts locked the
--      roster row before the destination's billing row (a raw admin-flagged
--      UPDATE: PostgreSQL locks the row before its BEFORE UPDATE trigger
--      runs), the reverse of the run, which locks a district's billing row and
--      then its students' roster rows. A run holding the destination from an
--      earlier district and reaching the student in the source deadlocked with
--      it. And a move out (to null) took no district lock at all, which is
--      what let (1) happen.
--
-- THE LOCK ORDER, everywhere, unchanged in principle from 20261022130300 and
-- now kept by every correction: the districts' billing rows first, then
-- roster rows, then the purge's lists.
--   * The run: a district's billing row FOR UPDATE (SKIP LOCKED: one someone
--     else holds is passed over until the next run), its district_retention
--     row FOR UPDATE, then its students' roster rows FOR UPDATE (ascending id,
--     here), then the list entries.
--   * admin_set_student_district(): reads the district the student is in
--     (unlocked), takes the billing rows of that district and of the one the
--     student is moved to FOR KEY SHARE, in ascending studio id (one row when
--     they are the same; the old one alone on a move out), then the roster row
--     FOR UPDATE, then the list entries. If the student's district changed
--     between the read and the row lock, the correction is refused (40001,
--     retry): taking the new district's lock under the row's would be the
--     reverse order.
--   * The backfill (20261022130300, unchanged): the billing rows of every
--     district the evidence names FOR KEY SHARE, in studio order, then the
--     roster rows (legacy rows have no district to leave).
--   * The roster trigger: on an UPDATE that changes the district, the billing
--     rows of the district left and the one joined FOR KEY SHARE NOWAIT, in
--     ascending studio id. Through admin_set_student_district() and the
--     backfill it finds them already held. A raw admin-flagged UPDATE has
--     locked the roster row before its trigger runs, so it may not wait for a
--     district now (a run holding it may be waiting for this very row): if a
--     run holds either district, the UPDATE is refused at once with SQLSTATE
--     55P03 and the message 'district_busy'. That is its retry behaviour: the
--     caller retries the statement in a new transaction (the run has
--     committed by then, or passes the district over while the correction
--     holds it), or makes the correction through admin_set_student_district(),
--     which waits its turn. On an INSERT the trigger takes the district's lock
--     as before (20261022130300): a new row is nobody else's to wait for.
-- KEY SHARE conflicts with the run's FOR UPDATE and with the studio's delete,
-- not with another correction's KEY SHARE, and not with the FOR NO KEY UPDATE
-- of a billing write; the billing record's own writers
-- (district_billing_rederive(), admin_set_district_contract_end()) lock one
-- billing row and no roster row, so they cannot invert it either.
-- Consequences: a correction that reaches a district first makes the run pass
-- it over until the next run (which then sees the student where the
-- correction left them); a run that reaches it first makes the correction
-- wait for it, then the correction finds the student listed and takes them
-- off the list as 20261022130000 does.
--
-- Rerunnable: functions are replaced with the same signatures, and the
-- privileges reset to the same end state. No table, trigger or constraint is
-- added; no step value either.

-- ---------------------------------------------------------------------------
-- The roster trigger: both districts' locks on a move, without waiting
-- ---------------------------------------------------------------------------
-- 20261022130300's definition; the UPDATE branch takes both districts' locks
-- NOWAIT, in studio order, and refuses when a run holds one.
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
        if new.district_studio_id is distinct from old.district_studio_id then
            -- The lock of the district left and of the one joined, in studio
            -- order (20261022130400). admin_set_student_district() and the
            -- backfill hold them already. A raw UPDATE locked this row first,
            -- so it does not wait for a run holding either (the run may be
            -- waiting for this row): it is refused, to be retried.
            begin
                perform 1 from public.district_billing b
                where b.studio_id in (old.district_studio_id, new.district_studio_id)
                order by b.studio_id
                for key share of b nowait;
            exception
                when lock_not_available then
                    raise exception 'district_busy'
                        using errcode = '55P03',
                              hint = 'A retention run holds the district this student is leaving or joining. Retry, or use admin_set_student_district(), which waits for it.';
            end;
            -- A correction moving a student into a district being deleted.
            if new.district_studio_id is not null and public.district_deletion_pending (new.district_studio_id) then
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
-- The admin correction: both districts' locks, then the roster row
-- ---------------------------------------------------------------------------
-- 20261022130300's definition; the lock of the district the student leaves
-- (a move out too) is taken with the one it joins, in studio order, before
-- the roster row's.
create or replace function public.admin_set_student_district (p_managed_student uuid, p_studio uuid, p_actor text)
returns void language plpgsql security definer
set search_path = public as $$
declare
    v_old uuid;
    v_now uuid;
    v_drop public.district_retention_students;
    v_restore text;
begin
    if coalesce(trim(p_actor), '') = '' then
        raise exception 'say who is making the change' using errcode = '22023';
    end if;
    -- The district the student is in, read without a lock, so that its lock
    -- can be taken before the row's.
    select ms.district_studio_id into v_old from public.managed_students ms where ms.id = p_managed_student;
    if not found then
        raise exception 'no such roster student' using errcode = 'P0002';
    end if;
    -- Both districts' locks first, in studio order: the run's order (billing
    -- rows, then roster rows). A run holding either is waited for; a run
    -- reaching either while this holds it passes it over until the next run.
    perform 1 from public.district_billing b
    where b.studio_id in (v_old, p_studio)
    order by b.studio_id
    for key share of b;
    select ms.district_studio_id into v_now from public.managed_students ms where ms.id = p_managed_student for update;
    if not found then
        raise exception 'no such roster student' using errcode = 'P0002';
    end if;
    if v_now is distinct from v_old then
        -- Moved by someone else since it was read: the district it is in now
        -- is not locked here, and its lock under the row's would be the
        -- reverse order.
        raise exception 'the student''s district changed while this correction was being made; retry'
            using errcode = '40001';
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
-- The re-list: lock, then look again
-- ---------------------------------------------------------------------------
-- 20261022130300's definition; the unlisted students' roster rows are locked
-- first, and only those the district still names under the locks are listed.
-- The caller holds the district's lock (its billing row FOR UPDATE).
create or replace function public.district_retention_list_late (p_studio uuid, p_now timestamptz, p_by text)
returns int language plpgsql security definer
set search_path = public as $$
declare
    v_locked uuid[];
    v_late jsonb;
    v_n int;
begin
    -- The roster rows of the district's students not on its list yet, locked
    -- in roster order. A change in flight to one of them (an admin moving the
    -- student out, a teacher archiving them) is waited for.
    select coalesce(array_agg(l.id), '{}') into v_locked
    from (
        select ms.id from public.managed_students ms
        where ms.id in (select ds.id from public.retention_district_students (p_studio) ds)
          and not exists (
              select 1 from public.district_retention_students s
              where s.studio_id = p_studio and s.managed_student_id = ms.id
          )
        order by ms.id
        for update of ms
    ) l;
    if cardinality(v_locked) = 0 then
        return 0;
    end if;

    -- Under those locks, each row as it is now (a new statement, which reads
    -- what the transactions waited for committed): only a student still
    -- attributed to the district (retention_district_students(), the purge's
    -- one scope) is listed, with was_archived as the row is now. One moved
    -- out meanwhile is skipped: not listed, archived or signed out.
    with listed as (
        insert into public.district_retention_students (studio_id, managed_student_id, student_user_id, was_archived)
        select p_studio, ds.id, ds.student_user_id, ds.archived_at is not null
        from public.retention_district_students (p_studio) ds
        where ds.id = any (v_locked)
          and not exists (
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
    -- (student_access_revoked), under the roster rows' locks taken above.
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
-- The run: the soft delete's listing locks first too
-- ---------------------------------------------------------------------------
-- 20261022130300's definition; the soft delete locks the district's roster
-- rows before it lists them, as district_retention_list_late() does. The hard
-- delete's re-list and the sweep call district_retention_list_late(), above.
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
    v_locked uuid[];
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
            -- The district's roster rows locked first, in roster order, then
            -- listed as they are under the locks (20261022130400, as
            -- district_retention_list_late() does): a student moved out while
            -- the soft delete waited for their row is not listed, archived or
            -- signed out.
            select coalesce(array_agg(l.id), '{}') into v_locked
            from (
                select ms.id from public.managed_students ms
                where ms.id in (select ds.id from public.retention_district_students (candidate.studio_id) ds)
                order by ms.id
                for update of ms
            ) l;
            insert into public.district_retention_students (studio_id, managed_student_id, student_user_id, was_archived)
            select candidate.studio_id, ds.id, ds.student_user_id, ds.archived_at is not null
            from public.retention_district_students (candidate.studio_id) ds
            where ds.id = any (v_locked)
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
        'public.managed_students_district_attribution ()',
        'public.admin_set_student_district (uuid, uuid, text)',
        'public.retention_district_run (timestamptz, int)'
    ]
    loop
        execute format('revoke all on function %s from public, anon, authenticated', fn);
        execute format('grant execute on function %s to service_role', fn);
    end loop;
end;
$$;

-- Internal, as in 20261022130300: only the run calls it, under the district's
-- lock. Not even the service role calls it directly.
revoke all on function public.district_retention_list_late (uuid, timestamptz, text)
from public, anon, authenticated, service_role;

-- DEPLOY: apply right after 20261022130300, before deploying student-provision
-- (decision 68(4)'s order, inside the freeze). No edge function changes.
-- retention_district_run() stays unscheduled (20261021120700's DEPLOY note).
```
