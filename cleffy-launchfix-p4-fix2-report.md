# Cleffy launchfix P4: fix round 2 report (PR #71)

- Date: 2026-10-22
- Environment: **Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2`**. Confirmed with `get_session`: `environment_id` = `env_01WAd3yiz3qpSnsofpyEwCh2`, `environment_kind` = `anthropic_cloud`. Not Sandbox.
- Branch: `mh/launchfix-p4-realtime-revocation` (PR #71's existing head branch). Pushed fast-forward only, with no force.
- **Starting SHA:** `ae770d69aa90b2b02d2360dbe6bf3dd382334020` (ae770d69).
    - `origin/mh/launchfix-p4-realtime-revocation` was still at ae770d69 at the start, and again just before the push. There was no drift, so there is only one starting SHA.
- **New PR #71 head:** `657d9cdb1d377dd78a7efd27886ec9f442a5be25` (657d9cd). Pushed `ae770d6..657d9cd`.
- **PR #71 state:**
    - Still a **draft**, base **dev** (47e9b38f).
    - Only the title and body were edited (see "PR #71 title and body").
    - No new PR was opened, no reviewer was requested, nothing was merged, and nothing was pushed to main or dev.
    - PR #54 and other sessions' PRs and branches were not touched. `claude/launchfix-p4-fix1-report` and `claude/launchfix-p4-report` were not touched.
- **Report branch:** `claude/launchfix-p4-fix2-report` = the final #71 head plus one commit that adds this file.
- The session's harness also names an outcome branch, `claude/launchfix-p4-realtime-revocation-fix2-v06cu3`. Per the task's instructions I pushed nothing to it; it still points at ae770d69 as created.

## Commits

Both commits are authored as `Max Harris <drumaxter@gmail.com>`.

| SHA                                        | Summary                                                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4991da30d067d3f8e776ba7152d18a8a963c9afa` | launchfix P4 fix 2: archived scores answer "archived", redemption locks the roster first. New migration 20261022120200, mirror, both SQL proofs extended, README, static tests.       |
| `657d9cdb1d377dd78a7efd27886ec9f442a5be25` | launchfix P4 fix 2: an archived score's open viewer rejoins by itself on restore. `realtimeChannel.ts`, ViewerPage re-check, `database.ts` RPC type, unit, ViewerPage and live tests. |

## How each item was addressed

The server changes are all in the new migration **`supabase/migrations/20261022120200_realtime_archive_recovery.sql`**, inside the 2026102212xxxx range. No existing migration was edited.

### Packet item 1 / Codex r2 MAJOR: realtime stays off after an archived score is restored

This supersedes decision 53(2). Per decision 55 and the requester's override, **53(2) is no longer followed**: an open viewer now auto-resumes after a restore.

**Distinguishable result (server).**

- New `realtime_topic_access(p_document) returns jsonb` (STABLE, SECURITY DEFINER, `authenticated` only). It returns one of three answers:
    - `null`: `document_role()` is null. The caller is not or no longer a member, is removed or restricted by a takedown, holds a revoked student token, or the score is gone. **Permanent.**
    - `{"status":"archived"}`: still a member, but the score is archived. **Temporary.**
    - `{"status":"open","epoch":n}`: join generation n.
- The null case is checked first, so a non-member is told null whether the score is archived or not. No reason leaks.
- What stays the same:
    - `realtime_topic_epoch` is unchanged, so a frontend build from before this migration still works.
    - The realtime policies are unchanged: no join, send or presence on an archived score.
    - The archive rotation (20261022120100) is unchanged. A restore still rotates nothing; waiting members join the current generation.

**Client (`src/sync/realtimeChannel.ts`, which P4 owns).**

- `fetchRealtimeTopicEpoch` calls `realtime_topic_access`. `TopicEpochRead` gains `{ status: 'archived' }`. Unknown shapes, including the old bare integer, are `'failed'`.
- On `'archived'`, `waitWhileArchived()`:
    - leaves both topics (or, if the score was opened while archived, marks the next joins as re-joins);
    - holds ink and presence;
    - stops the committed-row fallback polling (nothing can be written on an archived score);
    - cancels any epoch retry;
    - asks the app to re-check once, on entering;
    - schedules a **low-rate jittered recheck**: `archivedRecheckDelayMs()` = uniform 15–45 s (`ARCHIVED_RECHECK_MS` = 30 s, ×0.5–1.5).
- On each recheck:
    - `'archived'` again: keep waiting.
    - `'failed'`: wait for the next archived recheck, not the fast retry, and open no guessed generation.
    - `'denied'`: stop for good, as before.
    - `'epoch'`: the score was restored. The **same mounted channel** opens both topics at the current generation. Because the joins are re-joins, `onReconnect` runs once both are joined: live ink is cleared and a gap-fill pull runs. Then `onMembershipChanged` lets the viewer re-read.
- A re-join timer or in-flight `rejoin()` opens nothing while archived. `stop()` cancels the recheck.

**ViewerPage reacts when the role is unchanged.**

- `recheckAccess` in `src/features/viewer/ViewerPage.tsx` now updates `doc.archived_at` (badge, read-only, and through `canWrite` the viewport's sync restart) whenever the archive state changed, even if the role did not.
- It shows "your access changed" only when the role changed.
- **Deviation (see below):** P2 also edits `ViewerPage.tsx`, so this touches a file P2 changes. The hunk is limited to `recheckAccess`, which P2 does not touch.

**Tests.**

- **Archive-then-restore viewer test** (unit): `src/sync/realtimeChannel.test.ts`, "an open viewer sees the score archived, then restored, and realtime resumes without a reopen". The sequence:
    - A device joined on generation 0 gets the rotation hint and leaves both topics.
    - Its read says archived: nothing opens, there is one re-check, no ink or presence goes out, and nothing is polled.
    - The next recheck still says archived, and nothing changes.
    - The recheck after that says generation 1. The same instance joins `doc:{id}:1` and `doc-db:{id}:1`, makes one gap-fill pull and a second re-check, and committed rows, live ink both ways and presence flow again.
    - No timers are left after `stop()`.
- Other new unit tests in the new describe block "an archived score waits, and rejoins on restore (20261022120200)":
    - "spreads the rechecks uniformly over 15..45 s"
    - "a score opened while archived joins nothing, then joins on restore and pulls the gap"
    - "a failed read while archived asks again at the archived pace, not the retry pace"
    - "a denial while archived still stops for good"
    - "a device that missed the archive (its re-join refused) waits too, and re-joins nothing meanwhile"
    - "teardown while archived cancels the recheck"
    - The PostgREST parse test is updated for the new RPC and shapes.
- ViewerPage test: `src/features/viewer/ViewerPage.test.tsx`, "follows the score being archived and then restored while the role stays the same". It fails without the ViewerPage change (checked) and passes with it.
- **Live, same mounted sessions:** `tests/live/takedownRealtime.live.test.ts`, "an archived score's open devices leave its topics, and rejoin by themselves once it is restored". It runs against the local Realtime server with owner, editor and viewer devices, each a real `DocRealtimeChannel` on its own socket.
    - On archive, all three leave both topics, read `archived` (never `denied`) and re-check.
    - No ink reaches anyone while archived.
    - After the restore, with no reopen, all three rejoin generation 1 within the 15–45 s recheck. Owner-to-editor/viewer ink, editor-to-owner ink and a committed mark all arrive.
    - Passed 2/2 runs (4/4 tests in the file each run).
- **SQL proof of the restore path**, not only a fresh authorization: `tests/sql/realtime_revocation_rotation.sql`:
    - 37c: before the archive, the owner is told open at 0.
    - 39e/39f: the editor and the owner are told `archived` while archived. 39f uses the owner's token from before the archive.
    - 39g: a non-member is told null.
    - 40c/40d: after the restore, **the same tokens** re-read and are told `{"status":"open","epoch":1}`. The editor joins generation 1 (and is refused generation 0) and sends and tracks there.
    - 40e: no second rotation.

### Packet item 2 / Codex r2 MINOR: share redemption vs district hard delete deadlock

- **Change:** `redeem_share_link` is redefined, copied verbatim from 20261009120200 with one addition. It calls `perform public.lock_student_for_grant (v_uid);` right after the link lookup and **before** the membership `SELECT … FOR UPDATE`.
    - The order is now roster row, then membership: the same as the district hard delete (roster row FOR UPDATE, then `delete from auth.users`, which cascades to memberships) and as `assign_score` (its assignment trigger locks the roster row before its membership insert).
    - The insert's `document_members_lock_student` trigger re-takes the roster lock, which is already held.
    - For an account without a roster row it is a no-op: one index probe.
    - Grants are restated (`revoke` from public and anon, `grant` to authenticated). The repo's grant test requires that.
- **Other paths checked:** nothing else locks a membership row and then inserts one. `set_document_member_role` and `remove_document_member` lock a membership but insert none, so the trigger never fires under them. This is documented in the migration header.
- **Two-session dblink proof**, in `tests/sql/realtime_revocation_race.sql`:
    - **H1, redemption first.** Session a (the student) redeems and holds the transaction open, holding the roster row FOR SHARE and the membership. Session b runs `retention_district_run(now())`, which is due to hard-delete that student's district.
        - H1a: b waits on the roster row.
        - H1b: a commits (granted `editor`).
        - H1c: b's hard delete goes through (`hard_delete` 1, `students_deleted` 1), with no deadlock.
        - H1d: nothing is left of the student.
    - **H2, hard delete first**, the Codex interleaving. Session c holds the student's `auth.users` row FOR KEY SHARE. b's run then stops between its roster lock and the account deletion.
        - H2a: b is blocked.
        - H2b: b holds the roster row, proven with a `FOR SHARE NOWAIT` probe in a rolled-back subtransaction.
        - Then a redeems a link to a score the student is already on.
        - H2c: a waits on the roster row, before it touches the membership.
        - c commits.
        - H2d: b deletes the student and commits, with no deadlock.
        - H2e: a fails on the deleted account (FK `document_members_user_id_fkey`), not on a deadlock.
        - H2f: nothing is left.
    - Each scenario first checks that only its own district is due (H1-, H2-), as R6 does.
    - **Negative control:** with the pre-fix `redeem_share_link` restored (locally only, then 20261022120200 re-applied), **H2e fails with `deadlock detected`**: PostgreSQL aborts the redemption. Result 1/53 failing.

### Packet item 3: CI coverage of the realtime proofs

- `ci.yml` was **not edited** (P1/#69 owns it).
- **Do the proofs need the Realtime service container?** **Yes.** I tested it rather than assume it.
    - The realtime schema, `realtime.messages`, its policies and `realtime.send` exist without the container. This branch's CI applies every migration with Realtime excluded.
    - But **the day's `realtime.messages` partition is created by the Realtime server**, and both proofs write to it (hints, join probes).
    - Experiment: Realtime stopped, and today's partition detached inside a rolled-back transaction, as `supabase_admin` then `SET SESSION AUTHORIZATION postgres`. `realtime_revocation_rotation.sql` then fails **49 of 88** checks: `realtime.send` only warns "no partition", and the join probes raise 23514. Afterwards the partition was back and Realtime was restarted.
    - The race proof's check 00 asserts the partition exists.
    - So the premise "they don't need the container" does not hold, and I am reporting that rather than claiming it.
- **They will still run under #69's blocking proof list**, as decision 55 asks. #69's `supabase-local` job (`origin/mh/launchfix-p1-db-release-safety` @ 275b188b):
    - starts the stack **without** excluding Realtime (`-x studio,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor,postgres-meta`);
    - fails by name unless the Realtime container is running and today's partition exists;
    - runs **every** `tests/sql/*.sql` through `scripts/ci/sql-proof.sh`, with an empty `SKIP` map.
- The race proof's dblink sessions log in with the default peer password `postgres`, as `cancel_link_tombstone_race.sql` does, and that already passes in CI.
- **What the rebase pass must check:**
    1. `realtime_revocation_rotation.sql` (88) and `realtime_revocation_race.sql` (53) appear and pass in #69's every-proof step, and neither is added to its `SKIP` map.
    2. #69 keeps Realtime started and its "Realtime is running and has created today's messages partition" step.
    3. #69's `sql-proof.sh` parses both summaries (`failures | total`). It does: I ran both, and all the other proofs, locally through #69's script.
    4. The race proof's precondition checks (R6-, H1-, H2-) hold on CI's fresh database: only its own districts are due. They hold locally, and the other proofs in #69's job create no due districts that outlive their transactions. If one ever did, those checks fail loudly rather than hard-deleting anything else.
    5. P5's redefinition of `retention_district_run` (20261022130000) keeps the hard delete's order (roster row FOR UPDATE, then `delete from auth.users`) and its result keys `hard_delete` / `students_deleted` / `soft_delete`. In P5's current branch it does (`for update of m` at line 341, `delete from auth.users` at line 378), but H1/H2/R6 must be re-run on the combined tree.
    6. `district_read_only_seats` checks 49/59/60/62 (P4-owned after the rebase, answer 53(3)).
    7. Regenerate the mirror and merge the `tests/sql/README.md` append.

### Packet item 4: malicious sockets are not evicted server-side (decision 45)

Unchanged and accepted. A socket that ignores `topic_rotated` keeps Realtime's join-time permissions on the old generation until its token expires (`jwt_expiry` 3600 s). The server sends only on the new generation. Listed under follow-ups.

### Packet item 5: refresh #71's PR body

Done, see "PR #71 title and body".

### Codex round-2 findings, one by one

- **r1 MAJOR 1, MINOR 1, MINOR 3, MINOR 4: FIXED in r1.** No change, and the proofs still pass (R1–R6, D1/D2, C1).
- **r1 MINOR 2: PARTIAL** (no server eviction). Accepted, decision 45; follow-up.
- **A3: PARTIAL.** Closed for archive recovery and the new inversion. Superseded-studio integration is still open: out of scope this round per the requester; follow-up.
- **New MAJOR (archive denial is permanent): FIXED** (item 1).
- **New MINOR (redemption vs hard delete lock inversion): FIXED** (item 2), with a two-session proof covering both orders and a negative control.
- **"Realtime proofs don't run in CI":** addressed per item 3. They need Realtime and run in #69's job after the rebase. Not runnable on this branch's CI without editing `ci.yml`.
- **"The SQL restore check only proves a fresh authorization":** now covered by 40c/40d (same tokens), the unit test (same instance) and the live test (same mounted sessions).

### Requester answers to the fix1 questions (decision 53)

1. **The `doc:{id}` hint carve-out** is kept. The hint payload is `{document_id}` only, and the client never acts on it beyond checking it names the score.
2. **Superseded** by packet item 1 and decision 55. The open viewer now auto-resumes.
3. **`district_read_only_seats` 49/59/60/62** stay P4's for the rebase pass. Still failing identically, as before this round. Not changed here.
4. **A student provisioned during a district soft delete** is for the P5 rebase pass. Not changed here.
5. **Test-row cleanup** (moved to now by hard rule 5):
    - The live test's `afterAll` now deletes the takedowns, the `content_notice_outbox` and `content_notice_log` rows they queued, and the `document_storage_cleanup` rows of its scores.
    - The race proof's cleanup now also deletes its `document_storage_cleanup`, `district_billing_log` and `realtime.messages` rows (all runs' leftovers, by its id pattern), and its Z check verifies that.
    - **Superseded-studio rotation:** not in scope (follow-up).
    - **#71 body refresh:** done now (item 5).

## Tests and proofs added

| Name                                                                                                                                                                                                                     | Kind                                                    | Result                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------- |
| `realtime_revocation_rotation.sql` 37c, 39e, 39f, 39g, 40c, 40d, 40e, 44, 44b, 44c                                                                                                                                       | SQL, single transaction, rolled back                    | in 88/88                                                              |
| `realtime_revocation_race.sql` H1-, H1a–d, H2-, H2a–f                                                                                                                                                                    | SQL, **two-session dblink deadlock proof** (3 sessions) | in 53/53                                                              |
| "an open viewer sees the score archived, then restored, and realtime resumes without a reopen" (**archive-then-restore viewer test**), plus 6 more in "an archived score waits, and rejoins on restore (20261022120200)" | vitest, fake timers                                     | `realtimeChannel.test.ts` 76/76 (was 69)                              |
| "follows the score being archived and then restored while the role stays the same"                                                                                                                                       | vitest + RTL                                            | `ViewerPage.test.tsx` 56/56                                           |
| "tells a member of an archived score to wait, apart from a lost score (20261022120200)", "redeems a share link with the roster row locked before the membership (20261022120200)"                                        | static                                                  | `realtimeRevocationRotation.test.ts` 9/9 (was 7)                      |
| "an archived score's open devices leave its topics, and rejoin by themselves once it is restored"                                                                                                                        | live, local Realtime                                    | `takedownRealtime.live.test.ts` 4/4 (was 3), on 2 runs; skipped in CI |

## SQL proofs (local stack, Realtime started)

**P4 proofs (pass/total):**

- `realtime_revocation_rotation.sql`: **88/88**.
- `realtime_revocation_race.sql`: **53/53**, on 3 runs after the final edit.
- Negative control: with the pre-fix `redeem_share_link`, 52/53 (H2e: deadlock detected).
- Negative control: without today's partition, the rotation proof gets 39/88.

**Every other proof**, run with #69's `sql-proof.sh` (this branch's script cannot parse the `ALL n CHECKS PASSED` summary):

| Proof                          | Result  | Proof                      | Result  |
| ------------------------------ | ------- | -------------------------- | ------- |
| annotation_payload_shape       | 57/57   | district_retention         | 28/28   |
| archived_student_password      | 13/13   | district_seat_cap          | 192/192 |
| billing_export_claims          | 35/35   | district_seats             | 58/58   |
| cancel_link_consume_db_clock   | 36/36   | district_student_scope     | 47/47   |
| cancel_link_db_clock           | 21/21   | edge_rate_limit_refund     | 10/10   |
| cancel_link_lifetime           | 57/57   | guest_email_verification   | 53/53   |
| cancel_link_read_db_clock      | 10/10   | launch_checkout_fixes      | 46/46   |
| cancel_link_save_after_insert  | 12/12   | launch_consent             | 43/43   |
| cancel_link_tombstone_race     | 25/25   | qa3_cross_branch           | 12/12   |
| cancel_link_tombstones         | 38/38   | share_link_errors          | 26/26   |
| checkout_consents              | 25/25   | sharing_access_control     | 94/94   |
| column_integrity               | 113/113 | content_moderation         | 99/99   |
| cross_branch_integration       | 37/37   | district_billing_canonical | 12/12   |
| district_migrations_rerunnable | 20/20   |                            |         |

**Pre-existing failures**, identical to fix1 and identical with the pre-fix `redeem_share_link` restored:

| Proof                       | Result | Failing checks |
| --------------------------- | ------ | -------------- |
| `billing_double_charge`     | 95/98  | 89, 92, 98     |
| `district_read_only_seats`  | 64/68  | 49, 59, 60, 62 |
| `student_access_revocation` | 42/44  | 22, 24         |

**In CI on this branch:** neither P4 proof runs. The `supabase-local` job excludes Realtime and runs its fixed list of nine checkout and cancel-link proofs (see "CI status").

Rerunnability: 20261022120200 was applied twice in a row with no error. `scripts/apply-migrations.sql` is a pure append (0 removed lines).

## Live-test and proof rows cleaned up (hard rule 5)

- I took row-count snapshots of every table in `public`, `auth`, `storage`, `realtime`, `net` and `cron` before and after each run.
- **Final state vs. the start of the session:** the only differences are:
    - `cron.job_run_details`: the local stack's own schedules.
    - `billing_cancel_token_tombstones`: 0 → 12, see below.
    - Fewer leftovers than at the start: 149 `realtime.messages`, 60 `district_billing_log` and 94 `document_storage_cleanup` rows from this session's earliest race-proof runs are gone.
- **Race proof:** now leaves nothing (verified across consecutive runs).
- **Live test:** its own cleanup removes its accounts, scores, takedowns, notices and storage-cleanup rows. Two things are out of the API's reach, and I deleted them by hand with psql after each run, matched precisely to this run:
    - the `realtime.messages` hints it caused (145 per run): only messages inserted after the run started whose score no longer exists;
    - GoTrue's `auth.audit_log_entries` for its `@takedown.test` accounts (30 per run).
- **Not removed:** the 12 `billing_cancel_token_tombstones` that the cancel-link proofs (not P4's) commit when I ran the full proof set. A trigger makes them permanent by design ("a cancel link's tombstone is permanent"). I did not bypass it. They are local only.
- **Seeded accounts and scores:** `teacher@cleffy.local` / `student@cleffy.local` and their scores were not touched. No passwords or billing were changed.

## Local checks on 657d9cd

- `npm run lint:check`: pass.
- `npm run typecheck`: pass.
- `npm run test`: **220 files passed, 5 skipped; 3410 tests passed, 15 skipped, 0 failed.**
    - The baseline was 3400 / 14. That is +10 tests (7 channel, 1 ViewerPage, 2 static) and +1 skipped (the new live test).
    - Run with `.env.local` moved aside, as fix1 did: `cloud:up` writes it, and it breaks `syncEngine.test.ts`'s real-timer test. CI has no `.env.local`. It was put back afterwards and never committed.
- `npm run build`: pass.
- `npx prettier --write` on every changed TS/TSX/MD file: clean. SQL is not formatted by prettier here.
- `npm run migrations:mirror`: regenerated, as a pure append of 20261022120200. Re-running it gives no diff.
- Dry-run merges (`git merge-tree`) of 657d9cd:
    - With P2 and P6: clean.
    - With P1, P3 and P5: conflicts only in `scripts/apply-migrations.sql` and `tests/sql/README.md` (appends).
    - `src/types/database.ts` auto-merges with P1.

## CI status on 657d9cd

**GitHub Actions: all green on `657d9cdb1d377dd78a7efd27886ec9f442a5be25`.**

**pull_request run 39742959672: success**

| Job              | Job id       | Result  | What ran                                                                                                                                                                                                       |
| ---------------- | ------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checks`         | 119704441245 | success | npm ci, production audit, lint:check, typecheck, test (Vitest **220 files passed, 5 skipped; 3410 passed, 15 skipped** of 3425), build                                                                         |
| `supabase-local` | 119704441169 | success | Stack started with Realtime excluded, every migration applied (20261022120200 included), cancel-link migrations re-applied, cancel-link store test, the fixed list of checkout and cancel-link proofs (all OK) |
| `omr-service`    | 119704440822 | success |                                                                                                                                                                                                                |
| `supabase-drift` | 119704441164 | success |                                                                                                                                                                                                                |

**push run 39742953877: success**

| Job              | Job id       | Result  |
| ---------------- | ------------ | ------- |
| `checks`         | 119704421267 | success |
| `supabase-local` | 119704421349 | success |
| `omr-service`    | 119704420920 | success |
| `supabase-drift` | 119704421187 | success |

**Other checks on the head:**

- **Supabase Preview:** skipped, as on ae770d69.
- **Vercel (commit status): failure, "Deployment rate limited — retry in 24 hours."**
    - This is the Vercel account's build-rate quota (its target URL is Vercel's upgrade page). It is not this PR's code. The app builds in both `checks` jobs, and on ae770d69 the same status was "Deployment has completed".
    - I have no means to re-run it, and touching Vercel or commenting on #71 is outside this session's rules. It should clear by itself once the quota resets. Listed under open questions.
- **Vercel Preview Comments:** no check run was posted on this head (it was on ae770d69). Presumably that follows from the rate-limited deployment.

**As on ae770d69, this branch's CI does not run either P4 SQL proof:** a fixed list, with Realtime excluded. See item 3 for where they run after the rebase.

**Review threads:** I opened no review threads and left no comments on #71.

## Migrations and files touched

- **New migration:** `supabase/migrations/20261022120200_realtime_archive_recovery.sql`
    - New: `realtime_topic_access(uuid)`.
    - Redefines: `redeem_share_link(text)`, with grants restated.
- **Mirror:** `scripts/apply-migrations.sql`.
- **Client:** `src/sync/realtimeChannel.ts`, `src/types/database.ts` (RPC type), `src/features/viewer/ViewerPage.tsx` (`recheckAccess` only).
- **Tests:**
    - `src/sync/realtimeChannel.test.ts`
    - `src/features/viewer/ViewerPage.test.tsx`
    - `tests/realtimeRevocationRotation.test.ts`
    - `tests/live/takedownRealtime.live.test.ts`
    - `tests/sql/realtime_revocation_rotation.sql`
    - `tests/sql/realtime_revocation_race.sql`
    - `tests/sql/README.md`
- **Not touched:** `ci.yml`, any existing migration, P3's edge functions, `src/features/viewer/PdfViewport.tsx`, `src/sync/syncEngine.ts`, `src/sync/wire.ts`, and the seeded accounts.

### Deviations

1. **`src/features/viewer/ViewerPage.tsx` is a file P2 also changes.** The packet requires that "ViewerPage reacts to archive state changes even when the role is unchanged", which can only be done there. The change is confined to `recheckAccess`, P2 does not touch those lines, and `git merge-tree` with P2's branch is clean. The new test sits in `ViewerPage.test.tsx` at a spot P2 does not touch (also clean).
2. **Item 3's premise.** The proofs do need the Realtime container (its daily partition). They still run under #69's blocking list because #69 starts Realtime. Details and evidence in item 3.
3. **Cleanup beyond the packet's list.** I also cleaned the race proof's pre-existing leftovers (`document_storage_cleanup`, `district_billing_log`, `realtime.messages`), not only the live test's, to satisfy hard rule 5.

## Follow-ups

- **Server-side eviction of malicious sockets (decision 45).** Already-joined sockets that ignore `topic_rotated` keep join-time access until JWT expiry (~1 h). Accepted for launch, post-launch follow-up.
- **Superseded-studio rotation** (`20261022100300_one_studio_per_owner.sql` on #69). It changes studio entitlement without the writes P4 watches. It needs its own rotation, or a hook into the read-only-seat rotation. Deferred to the rebase pass, as the requester decided.
- **`district_read_only_seats` 49/59/60/62** after the rebase (P4-owned).
- **Faster resume on restore (optional).** A restored score's open devices resume within 15–45 s. If that feels slow, the recheck could also run on tab focus or `online`. Not done; the packet asked only for low-rate polling.
- **Stale comment.** The doc comment on `TOPIC_ROTATED_EVENT` in `src/sync/wire.ts` still names `realtime_topic_epoch`. Left alone because `wire.ts` is outside this packet's files. The 20261022120100 header's "Restoring moves nothing: the members join again when they next open it" is superseded by 20261022120200's header; existing migrations are never edited.
- **Live-test leftovers outside the API.** `realtime.messages` hints and GoTrue audit entries need psql to remove (I did, per run). A small local cleanup script could do it.
- Carried from fix1:
    - an orphan-generation sweep;
    - live-test gap-fill coverage of marks committed during a rotation;
    - load measurement for a district-wide or plan-lapse rotation.

## Open questions for Max

1. Is touching `ViewerPage.tsx`'s `recheckAccess` acceptable, given that P2 also edits `ViewerPage.tsx`? The hunks are disjoint and the trial merge is clean. The alternative was not meeting the packet's "ViewerPage reacts" requirement.
2. Is a 15–45 s resume after a restore acceptable? Or should the archived recheck also fire on tab focus or reconnect?
3. The Vercel commit status on 657d9cd is red ("Deployment rate limited — retry in 24 hours"): an account-level build quota, not this PR. Once the quota resets, the preview can be redeployed from Vercel or by the next push. I took no action on Vercel.
4. Item 3: the proofs need the Realtime container, which #69 provides. Is the packet's "confirm they don't need it" satisfied by that, or should I make them create the day's partition themselves when it is missing? I did not, because Realtime owns that table's partitions.

## Hosted steps left for Max (none performed)

- Apply `20261022120200_realtime_archive_recovery.sql` to hosted dev and then prod with the rest of P4, in the merge order (P1–P3 first).
- **Apply the migration before (or with) the frontend deploy.**
    - The new `realtimeChannel.ts` calls `realtime_topic_access`. Against a database without it, the read is `'failed'` and the channel falls back to generation 0, the same degraded path as before 20261020150100.
    - An older frontend keeps working against the new database, because `realtime_topic_epoch` is unchanged.
- Nothing hosted was touched in this session: no hosted Supabase (prod jibgwgosihadbjgxdsfe, dev qdbnlrgylelelvwbkvnm), Vercel, Resend or Stripe. No key, token or secret was printed or committed. The local keys were read into the shell for the live test only and never echoed.

## Expected conflicts with the other launchfix PRs

- **`scripts/apply-migrations.sql`:** P1 (#69), P3, P5 and this PR each append. Mechanical; regenerate with `npm run migrations:mirror` after the rebase.
- **`tests/sql/README.md`:** P1, P3, P5 and this PR each append sections. Mechanical.
- **P1 (#69):**
    - `src/types/database.ts` auto-merges.
    - `ci.yml` runs both P4 proofs (item 3).
    - `district_read_only_seats` and superseded studios are follow-ups.
- **P2 (client safety):**
    - `ViewerPage.tsx` and `ViewerPage.test.tsx` merge cleanly (disjoint hunks).
    - P2 does not touch `realtimeChannel.ts`.
- **P3:** edge functions only. No SQL overlap; it does not redefine `redeem_share_link` or the realtime functions.
- **P5 (`20261022130000_district_retention_reattribution`):** redefines `retention_district_run`, which R6, H1 and H2 call. Re-run the race proof on the combined tree (item 3, point 5). It does not redefine `redeem_share_link`.
- **P6:** docs only, clean.

## Local stack

`npm run cloud:up` (Realtime included, container `supabase_realtime_cleffy`) was used for every proof and live run. It was stopped with `npm run cloud:down` at the end.
