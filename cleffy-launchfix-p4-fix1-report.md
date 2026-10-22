# Cleffy launchfix P4 — fix round 1 report (PR #71)

- Date: 2026-10-22
- Environment: **Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2`** (confirmed with `get_session`: `environment_id` = `env_01WAd3yiz3qpSnsofpyEwCh2`, `environment_kind` = `anthropic_cloud`). Not Sandbox.
- Branch: `mh/launchfix-p4-realtime-revocation` (PR #71's existing head branch). Fast-forward push only, no force.
- **Starting SHA:** `a9e98c926bf4fe53866327a95bb27deddbe4e229` (a9e98c92). `origin/mh/launchfix-p4-realtime-revocation` was still at a9e98c92 when I fetched it, and again just before the push, so there was no drift.
- **New PR #71 head:** `ae770d69aa90b2b02d2360dbe6bf3dd382334020` (ae770d6). Pushed `a9e98c9..ae770d6`.
- PR #71 is still a **draft**, with base **dev** (47e9b38f). No new PR was opened. No reviewer was requested, nothing was merged, and nothing was pushed to main or dev. PR #54 and other sessions' branches were not touched.
- Report branch: `claude/launchfix-p4-fix1-report` = the final #71 head plus one commit that adds this file. `claude/launchfix-p4-report` was not touched.

## Commits

All commits are authored as `Max Harris <drumaxter@gmail.com>`.

| SHA | Summary |
|---|---|
| `ce285d96972a18e06457c76b7fee195007b197a6` | launchfix P4 fix 1: close the revocation races, no realtime on archived scores (new migration 20261022120100, mirror, SQL proofs, README, static tests) |
| `ae770d69aa90b2b02d2360dbe6bf3dd382334020` | launchfix P4 fix 1: leave old topics on a rotation hint; jitter and coalesce the follow-up (client, unit tests, live test) |

## How each packet item and Codex finding was handled

The server-side changes are all in the new migration **`supabase/migrations/20261022120100_realtime_revocation_races.sql`**, which is in the P4 range. `20261022120000` was not edited.

### Item 1: MAJOR, a concurrent assignment escapes revocation (Codex MAJOR 1)

- **Lock protocol:** the roster row (`managed_students`) is the lock. Every revocation already holds it FOR (NO KEY) UPDATE from its write through to commit:
  - archive (`archived_at`)
  - `end_student_sessions` (`access_revoked_at`), which is the reset/end-session path
  - the district soft delete's `UPDATE managed_students` in `retention_district_run`
  - `revoke_and_scrub_student`
- **The grant side** now takes the same row FOR SHARE:
  - New `lock_student_for_grant(uuid)` does a locked read, so it sees the latest commit and not the statement's snapshot.
  - BEFORE INSERT triggers run it on **`assignments`** (`assignments_lock_student`, which also refuses with `not on your roster` / P0002 once the student is archived) and on **`document_members`** (`document_members_lock_student`, lock only).
  - Because these are triggers, every grant route is covered: `assign_score`, `redeem_share_link`, a score's owner row, and any later writer. BEFORE INSERT also fires for `INSERT … ON CONFLICT DO UPDATE`.
- **Outcome:** whichever transaction locks first wins.
  - If the grant locks first, the revocation waits, and its trigger then reads afresh (READ COMMITTED) and rotates the newly granted score.
  - If the revocation locks first, the grant waits:
    - After an archive, the assignment is refused.
    - After a reset, the grant goes through, and `document_role()` refuses every token from before the reset ("re-checks against the revoked state").
- **District soft delete:** covered by the same row lock, because the run's UPDATE locks each district student's row.
- **Caveat:** the revoking trigger's enumeration relies on READ COMMITTED (a fresh snapshot per statement). All current callers use it (PostgREST, pg_cron). The migration header documents this.
- **Two-connection proof:** the new **`tests/sql/realtime_revocation_race.sql`**, built on dblink, which the repo already uses (`cancel_link_*` race proofs). It uses 2–3 sessions and polls `pg_locks` until a session is blocked. Scenarios:
  - R1: archive, then assign. The assignment waits, then is refused.
  - R2: assign, then archive. The archive waits, then rotates the new score.
  - R3: reset, then assign. The assignment waits and succeeds. The old token is refused and a fresh token joins.
  - R4: assign, then reset. The reset waits, then rotates.
  - R5: archive, then the student redeems a share link. The redemption waits, and the archived student is refused.
  - R6: one district soft-delete run between an assignment that locked first (the run waits, then rotates that score) and one that came after (it waits, then is refused).

### Item 2: MINOR, deadlock with document deletion (Codex MINOR 1)

- **Change:** the commit-time rotation no longer waits on the score row at all.
  - `rotate_queued_document_realtime` drops its `FOR KEY SHARE` and checks existence with a plain read.
  - `document_realtime_epochs` drops its foreign key to `documents`. The FK's RI check would also have taken FOR KEY SHARE.
  - A new AFTER DELETE trigger, `documents_forget_realtime_epoch`, removes the generation instead. It fires after the RI cascades because AFTER triggers fire in name order and `RI_ConstraintTrigger_*` sorts first, so a deletion touches the generation row only after it has waited on every membership row.
- **Why this approach:** "document first, then membership" cannot be enforced from triggers. `DELETE` and `remove_document_member` (`SELECT … FOR UPDATE`) lock the membership row before any row trigger runs, and a document deletion locks the document before its own triggers run. An advisory lock has the same ordering problem on both sides. Taking the score lock out of the rotation path removes the cycle: the rotation can no longer wait on anything a deletion holds while the deletion waits on the revocation's membership row.
- **Side effect:** a rotation racing a deletion can leave a generation row that names no score. Nothing reads such a row (follow-up below).
- **Proofs:**
  - In the race proof, D1 (remove member, then delete the score) and D2 (editor → viewer, then delete): no deadlock, both commit, and nothing of the score is left.
  - In `realtime_revocation_rotation.sql`, checks 41–41d: no FK, a deleted score's generation is removed at once, and no `FOR (KEY) SHARE` remains in the rotation.
  - Negative control: on the pre-fix definitions, PostgreSQL's deadlock detector aborts the deletion in both D1 and D2.

### Item 3: MINOR, two concurrent rotations announce the wrong old topic (Codex MINOR 3)

- **Change:** `rotate_document_realtime` is redefined to bump first. `INSERT … ON CONFLICT DO UPDATE SET epoch = e.epoch + 1 RETURNING e.epoch` holds the generation row and always bumps the latest committed value. It then announces on generation `v_epoch - 1` through the new `document_topic_at(prefix, doc, epoch)`.
- **Why not old and new in one RETURNING:** PostgreSQL 17 cannot return both, but under the row lock new − 1 is exactly the old generation.
- **Proofs:**
  - Race proof C1: two removals in two sessions. The second's commit-time rotation waits on the first. Generation 0 is told once per topic and generation 1 once per topic, never generation 0 twice. On the pre-fix code this check fails.
  - Rotation proof checks 43/43b cover back-to-back rotations in one session.

### Item 4: MINOR, unbounded rejoin bursts (Codex MINOR 4)

- **Client changes** in `src/sync/realtimeChannel.ts`:
  - New `ROTATION_JITTER_MAX_MS = 2000` and `rotationJitterMs()`. After a `topic_rotated` hint, the generation re-read, and the rejoin and gap-fill that follow it, wait a uniform 0–2 s.
  - Coalesced per document (the `DocRealtimeChannel` instance is per score), with one follow-up timer per burst:
    - Further hints while it waits are absorbed.
    - Hints from a channel already left are ignored.
    - A read already in flight when a hint lands decides nothing.
    - A pending epoch retry is replaced.
  - One rejoin, then one `onReconnect` gap-fill pull.
- **Unit tests:** a new describe block, "rotation follow-ups are jittered and coalesced":
  - jitter bounds
  - a burst of hints → one read, one rejoin, one pull, no fallback pull
  - four devices on one score spread to reads at 0/600/1400/2000 ms
  - late hints from left channels ignored
  - teardown cancels the waiting follow-up
- **Not done:** measuring representative district workloads. Codex suggested it; the packet did not ask for it (see follow-ups).

### Item 5: pre-existing, score archival not covered

- **Change:**
  - `topic_document_role` and `db_topic_document_role` (the resolvers every `realtime.messages` policy calls for receive, presence and live ink) now return null for an archived score (`document_is_archived`).
  - `realtime_topic_epoch` also returns null for an archived score. The app then stops its channels ('denied') instead of retrying a refused join.
  - A new trigger, `documents_rotate_on_archive` (`archived_at` null → set), queues a rotation, so channels that are already joined are told to move.
  - Restoring moves nothing.
- **Proof:** in `realtime_revocation_rotation.sql`, checks 37–40b. On an archived score, the owner and an editor get no generation, no join on either generation, no live ink and no presence. The archive moves the score once. A restore moves nothing and restores join, send and presence.
- **UX note:** `closeOnDenial` calls the viewer's `recheckAccess`. The role is unchanged, so the read-only archived view stays as it is, with no realtime. After a restore, realtime returns when the score is next opened.

### Item 6: pre-existing, already-joined sockets stay authorized (accepted)

- **Documented** in the migration header and in `onTopicRotated`'s doc comment. Realtime keeps join-time permissions until the client hands it a new token, and it cannot evict subscribers. A socket that ignores `topic_rotated` stays on the old generation **for up to about 1 hour** (`jwt_expiry = 3600` s), still able to send and receive there. This is accepted under decisions 23/24/31. The server sends only on the new generation, so all such a socket can reach is other clients that also ignore the hint.
- **Honest client path:** the client now **leaves both old topics as soon as it sees the server's rotation notice**, before re-reading:
  - On the `doc-db:{id}` hint, which no client can forge.
  - On the `doc:{id}` hint while `doc-db:{id}` is not joined, since that is then the device's only signal.
- **Deviation, for Max to confirm:** a `doc:{id}` hint while `doc-db:{id}` is joined still holds ink and presence and re-reads, but does not leave. Any member can forge that hint on `doc:{id}`. If every forged hint made every client leave, rejoin and pull, one editor could keep a whole room churning. A genuine rotation always sends the `doc-db` hint in the same commit, so honest clients leave at once anyway.
- **While left:** if the re-read fails, the device stays off every topic, keeps ink and presence held, and polls committed rows through the existing fallback.
- **Tests:**
  - Unit: "a takedown moves the owner…" asserts the device left before the read; "a doc:{id} hint leaves at once when doc-db:{id} is not joined"; "while a slow read keeps the device off every topic, committed rows are pulled".
  - Live (`tests/live/takedownRealtime.live.test.ts`): the owner is now expected off the old topics while its reads fail.

### Item 7: CI

- `ci.yml` was **not changed**. On this branch's current CI, `realtime_revocation_rotation.sql` and `realtime_revocation_race.sql` **do not run**: the `supabase-local` job runs its fixed list of nine proofs with Realtime excluded.
- **`realtime_revocation_rotation.sql` (and the new `realtime_revocation_race.sql`) must be green after rebasing onto P1 (#69).** #69's `ci.yml` (ba53d922) starts Realtime and runs every `tests/sql/*.sql`.
- The race proof should work there:
  - It uses dblink with the default peer password `postgres`, the same technique as `cancel_link_tombstone_race.sql`, which already runs in CI.
  - It reports `failures | total`.
  - It checks that today's `realtime.messages` partition exists.
  - Its R6 checks first that only its own two districts are due (`retention_district_candidates`); on a fresh CI database that holds.
- **Not verified:** the combined #69 + #71 tree has not been run (I was told not to merge or rebase). See the expected conflicts below.

### Item 8: superseded studios (from #69)

Out of scope, as the packet says. Listed under follow-ups.

## Proofs and tests (local stack, Realtime started)

| Proof / test | Result | Harness |
|---|---|---|
| `tests/sql/realtime_revocation_rotation.sql` | **78/78** (was 59; 19 new checks) | single transaction, rolled back |
| `tests/sql/realtime_revocation_race.sql` (new) | **41/41**, passed on 3 runs | **two-connection concurrency proof: dblink**, 3 sessions (a/b/c) committing their own rows, waits detected via `pg_locks` |
| Negative control: both proofs with the pre-fix definitions restored (local only, committed temporarily, then 20261022120100 re-applied) | rotation 9/78 fail, race 20/41 fail (R1a–b, R2a/c/e, R3a, R4a/c/e, R5a, R6a/b/d/e/f, D1c/d, D2b/c, C1c) | same |
| `src/sync/realtimeChannel.test.ts` | **69/69** (was 62) | vitest, fake timers |
| `tests/realtimeRevocationRotation.test.ts` | 7/7 (was 3) | static |
| `tests/moderation/takedownRealtime.test.ts` | 10/10 (one assertion updated for the new `rotate_document_realtime` shape) | static |
| `tests/realtimeTopicsInSync.test.ts` | 5/5 | static |
| `tests/live/takedownRealtime.live.test.ts` | **3/3**, passed on 3 runs | live, against the local Realtime server |

Other SQL proofs on the same local database, run with the fix applied and again with the pre-fix definitions:

- **Pass with the fix:** `column_integrity` 113, `cross_branch_integration` 37, `content_moderation` 99, `sharing_access_control` 94, `share_link_errors` 26, `guest_email_verification` 53, `district_*` (except read-only seats), `launch_consent` 43, `qa3_cross_branch` 12, the cancel-link family, `checkout_consents`, `launch_checkout_fixes`, and the rest.
- **`content_moderation` caveat:** it passes 99/99 only after removing the notice outbox and log rows that the live takedown test leaves behind. That is pre-existing (follow-up below).
- **Identical with and without the fix (pre-existing):**
  - `billing_double_charge` 3/98 failing (89, 92, 98)
  - `district_read_only_seats` 4/68 failing (49, 59, 60, 62)
  - `student_access_revocation` 2/44 failing (22, 24)
  - #69 already lists the last two groups as KNOWN.

## Local checks (before the push)

- `npm run lint:check`: pass
- `npm run typecheck`: pass
- `npm run test`: **220 files passed, 5 skipped; 3400 tests passed, 14 skipped, 0 failed.** Run in a clean worktree at ae770d6.
  - In the main checkout, `src/sync/syncEngine.test.ts > backs off exponentially…` fails because `npm run cloud:up` writes `.env.local`. The a9e98c92 baseline fails the same way when that file is copied into it, and passes without it. CI has no `.env.local`.
- `npm run build`: pass
- `npx prettier --write` / `--check` on the changed TS and MD files: clean. There is no SQL parser configured, so the SQL files are not formatted by prettier.
- `npm run migrations:mirror`: regenerated. `scripts/apply-migrations.sql` is a pure append of 20261022120100, and re-running it gives no diff.

## CI on the final head (ae770d6)

**Fully green on `ae770d69aa90b2b02d2360dbe6bf3dd382334020`.**

- **pull_request run 39737476681: success**
  - `checks` (job 119686492118): success. npm ci, audit, lint:check, typecheck, test, build.
  - `supabase-local` (job 119686492458): success. Stack started with Realtime excluded, every migration applied (20261022120100 included), the fixed list of nine checkout/cancel-link proofs passed.
  - `omr-service` (job 119686492349): success.
  - `supabase-drift` (job 119686492798): success.
- **push run 39737471687: success**
  - `checks` (job 119686474005): success.
  - `supabase-local` (job 119686474581): success.
  - `omr-service` (job 119686474567): success.
  - `supabase-drift` (job 119686474608): success.
- **Vercel** (commit status): success. "Deployment has completed".
- **Vercel Preview Comments**: success.
- **Supabase Preview**: skipped, as on a9e98c92.
- **As before, this branch's CI does not run either P4 SQL proof** (fixed list, Realtime excluded). See item 7.
- No review comments are open on PR #71. The only new comment is Vercel's bot deployment comment.

## Migrations and files touched

- **New migration:** `supabase/migrations/20261022120100_realtime_revocation_races.sql`
  - new: `lock_student_for_grant`, `assignments_lock_student` (and its trigger), `document_members_lock_student` (and its trigger), `documents_forget_realtime_epoch` (and its trigger), `document_topic_at`, `documents_queue_rotation_on_archive` and trigger `documents_rotate_on_archive`
  - redefines: `rotate_queued_document_realtime`, `rotate_document_realtime`, `topic_document_role`, `db_topic_document_role`, `realtime_topic_epoch`
  - drops: constraint `document_realtime_epochs_document_id_fkey`
- **Mirror:** `scripts/apply-migrations.sql`
- **Client:** `src/sync/realtimeChannel.ts`; tests in `src/sync/realtimeChannel.test.ts`
- **Proofs and docs:** `tests/sql/realtime_revocation_race.sql` (new), `tests/sql/realtime_revocation_rotation.sql`, `tests/sql/README.md`
- **Static and live tests:** `tests/realtimeRevocationRotation.test.ts`, `tests/moderation/takedownRealtime.test.ts`, `tests/live/takedownRealtime.live.test.ts`
- **Not touched:** `ci.yml`, any existing migration, the seeded accounts.

### Deviations from the packet

1. **Item 2:** no "document then membership" lock order and no advisory lock. Neither can be imposed from row triggers (reasons in item 2). The cycle is removed instead by taking the score lock and the generation's FK out of the rotation.
2. **Item 6:** a `doc:{id}` rotation hint received while `doc-db:{id}` is joined does not make the client leave; it holds and re-reads. Reason in item 6. Every genuine rotation also sends the unforgeable `doc-db` hint, and the client leaves on that one at once.
3. **Item 5:** `realtime_topic_epoch` now also answers null for an archived score, and archiving rotates. The packet asked only for the policies. Without this, an open archived score would retry a refused join forever, and already-joined sockets would never be told to move.
4. The live test (`takedownRealtime.live.test.ts`) and one static assertion in `tests/moderation/takedownRealtime.test.ts` were updated because they pinned the behavior that items 3 and 6 change.

## Open questions for Max

1. Is item 6's carve-out acceptable: a forgeable `doc:{id}` hint holds and re-reads without leaving, while `doc-db:{id}` is joined? The alternative is to leave on any hint, at the cost of forged-hint churn.
2. Is it acceptable that an archived score's open viewer gets no realtime until it is reopened after a restore (item 5, via `realtime_topic_epoch` = null)?
3. #69's KNOWN list attributes `district_read_only_seats` checks 49/59/60/62 to "Realtime: launchfix P4". They fail identically with and without this round. They come from #63's real rotation being present, not from P4's triggers. Should P4 own fixing that proof after the rebase? (Not done here; out of the packet's scope.)
4. The district soft delete covers students who are on the roster when the run reads it. A student provisioned into the district by a seated teacher *while* the run is open is not archived by that run. That is a retention-completeness question, not a realtime one, and was not addressed.

## Follow-ups

- **After rebasing onto P1 (#69):**
  - `realtime_revocation_rotation.sql` and `realtime_revocation_race.sql` must be green in #69's every-proof job.
  - **Superseded studios** (`20261022100300_one_studio_per_owner.sql`) change studio entitlement without the writes P4 watches. They need their own rotation, or a hook into the read-only-seat rotation (packet item 8).
- **Orphan generation rows:** without the FK, a rotation racing a score's deletion can leave a `document_realtime_epochs` row for a deleted id. It is harmless because ids are never reused and nothing reads it. An occasional sweep (`delete … where not exists document`) would tidy it.
- **Live test leftovers:** `tests/live/takedownRealtime.live.test.ts` leaves `content_notice_outbox` / `content_notice_log` rows (from `apply_content_takedown`). These make `tests/sql/content_moderation.sql` fail on the same database (checks 24 and the B-section subquery). Pre-existing; the test's cleanup should remove them. I removed this session's leftovers from the local DB.
- **Live test coverage:** it still inserts its marks after the clients rejoin and does not prove gap-fill of marks committed during a rotation (Codex coverage note).
- **Load:** measure rejoin and pull load for a representative district soft delete or plan-lapse archive (Codex MINOR 4); the jitter only spreads it.
- **PR #71's description** still describes round 0 (for example "No change to `src/sync/realtimeChannel.ts`"). I left it unchanged; Max may want to refresh it.

## Expected conflicts with the other launchfix PRs

- **`scripts/apply-migrations.sql`:** P1 (#69), P5 and this PR each append. Mechanical; regenerate with `npm run migrations:mirror` after the rebase.
- **`tests/sql/README.md`:** P1, P3, P5 and this PR each append sections. Mechanical.
- **P1 (#69):** no SQL overlap in the functions this PR redefines. Its `ci.yml` will run both P4 proofs (item 7). The superseded-studio follow-up applies.
- **P5 (`20261022130000_district_retention_reattribution`):** it redefines the district retention run, which R6 of the race proof calls as `retention_district_run(now())`. If P5 changes the signature or the candidate selection, R6 needs updating. P5 inserts no assignments or memberships, so the new grant triggers do not affect it.
- **P2 (client safety):** touches `src/features/viewer/PdfViewport.tsx` and `src/sync/syncEngine.ts`, not `realtimeChannel.ts`. No textual conflict is expected.
- **P3:** edge functions only (including `student-provision`). No overlap with the SQL here.

## Hosted steps left for Max (none performed)

- Apply `20261022120100_realtime_revocation_races.sql` to hosted dev and then prod with the rest of P4, after the merge order (P1–P3 first). Deploy the frontend with the new `realtimeChannel.ts` in the same release, as for 20261020150100.
- Nothing hosted was touched in this session: no hosted Supabase (prod jibgwgosihadbjgxdsfe, dev qdbnlrgylelelvwbkvnm), no Vercel, no Stripe. No keys or secrets were printed or committed.

## Local stack

`npm run cloud:up` (Realtime included: container `supabase_realtime_cleffy`) was used for every proof. It was stopped with `npm run cloud:down` at the end.
