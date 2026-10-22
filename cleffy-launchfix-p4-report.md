# Launchfix P4 report: rotate realtime topics when access is revoked

**Status: done.** Draft PR open into `dev`, CI green on its head, every SQL proof check passes, `npm run cloud:down` has run.

This report lives only on the scratch branch `claude/launchfix-p4-report`, one commit on top of the final PR head. It is not on the PR branch. `/workspace` is on Max's machine, so nothing was written there.

## PR

- **PR:** #71, https://github.com/maxharris1/Cleffy/pull/71. It is a draft, from `mh/launchfix-p4-realtime-revocation` into `dev`, titled "launchfix P4: rotate realtime topics when access is revoked". No reviewers were requested.
- **Base SHA:** `47e9b38f2dba36fdce852c80948245da344bcc20` (origin/dev). I checked it again before pushing and it had not moved.
- **Final PR head SHA:** `a9e98c926bf4fe53866327a95bb27deddbe4e229`.
- **Merge state:** clean (mergeable). Nothing was merged, and nothing was pushed to `dev` or `main`.

## Environment

- This ran in the **Cleffy cloud environment, `env_01WAd3yiz3qpSnsofpyEwCh2`**, not Sandbox. I confirmed it with `get_session` at the start.
- The session was started from origin/dev at 47e9b38f. I cut the branch with `git checkout -B mh/launchfix-p4-realtime-revocation origin/dev`, so HEAD was 47e9b38f. That satisfies hard rule 2.
- Every commit is authored as Max Harris <drumaxter@gmail.com>.
- The session's harness had a default branch, `claude/launchfix-p4-realtime-revocation-tn9bjy`. I left it unused, because the task explicitly named the two branches to use.

## Commits (PR branch)

| SHA                                        | Summary                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `ed5c5afc5b937aa1ea51600c1bfb0c6204b83204` | launchfix P4: rotate a score's realtime topics when a member loses access     |
| `3af3b7aa78cac13f1a71298149cce87115e3cd68` | launchfix P4: unit-test the client through a membership-change rotation       |
| `a9e98c926bf4fe53866327a95bb27deddbe4e229` | launchfix P4: live-test revocation rotation against the local Realtime server |

The report branch adds one more commit on top of these: the commit that adds this file.

## What changed

### Migration `supabase/migrations/20261022120000_realtime_revocation_rotation.sql` (new, in the P4 range)

It reuses the takedown's existing rotation: `rotate_document_realtime`, `document_realtime_epochs` and `topic_rotated`, from 20261020150100. No existing migration or function was edited.

**Where it hooks in.** Every revocation path in the packet ends in a write to one of two tables. The new triggers sit on those writes, so they catch every path without redefining functions that other migrations, or P5, own.

- **`document_members`:**
    - `AFTER DELETE` covers remove, leave, revoke with removal, unassign, and the cascades from account or student deletion.
    - `AFTER UPDATE OF role WHEN old.role in (owner, editor) and new.role not in (owner, editor)` covers a downgrade that removes write. That includes `assign_score` flipping to view-only, and a link revoke that steps a roster student down to their assignment's view access.
- **`managed_students`:** `AFTER UPDATE OF archived_at, access_revoked_at`, but only for a student who was not already archived. It fires when `archived_at` gets set, or when `access_revoked_at` changes. That covers:
    - `end_student_sessions`, which the reset and archive paths call;
    - the archive stamp itself;
    - the district soft delete in `retention_district_run`.

    It queues every score the student is a member of or assigned to.

**Batching: one rotation per score per transaction.**

- The triggers only insert into `document_realtime_rotation_queue`. That table's key is the transaction id (`pg_current_xact_id()`) plus the document, so concurrent revocations never block on each other's queue rows.
- A `DEFERRABLE INITIALLY DEFERRED` constraint trigger on the queue runs at commit. Its first firing takes the whole transaction's queue, deletes it, and calls `rotate_document_realtime` once per score, in `document_id` order so two commits cannot deadlock.
- Before rotating, it takes `FOR KEY SHARE` on the score's `documents` row, and skips scores that no longer exist.
- Because the rotation runs at commit, every membership hint the transaction sent goes out first, on the topic the affected member is still on.

**No double rotation on archive.** Archive stamps `archived_at`, then calls `end_student_sessions` in a separate request. The trigger ignores `access_revoked_at` changes on a student who is already archived, so an archive rotates once.

**Grants.**

- Queue table: RLS on, every privilege revoked from public, anon and authenticated.
- New functions: execute revoked from public, anon and authenticated.

**Rerunnable.** The migration applied twice in a row cleanly on the local stack. It uses `create table if not exists`, `create or replace` and `drop trigger if exists`.

### Client (`src/sync/realtimeChannel.ts`): no change

The packet says to adjust the client only if tests show a gap. The new unit tests and the live test show none:

- **A member who keeps access:**
    - Ink is held from the first `topic_rotated` hint.
    - The client does 2 generation reads, one per old-topic hint and never two in flight. Then it makes 1 move (2 new joins) and 1 gap-fill pull, `onReconnect`.
    - The pull waits until both new topics have joined, so a mark committed in between is pulled with the pull's overlap rather than lost.
    - In the live test, all 60 committed marks reached the member who stays. 60 is more than the 50-seq pull overlap.
- **A removed member:** it re-checks on its membership hint and is denied by `realtime_topic_epoch`. It then leaves both topics for good: no new channels, no timers, no pulls.
- **An editor made viewer:** it re-checks its role, follows the rotation, and joins the new generation as a viewer.
- **Cost of one rotation for each member who stays:**
    - 2 epoch RPCs, coalesced so never two in flight;
    - 2 channel joins;
    - 1 pull;
    - presence re-announced after the existing presence minimum gap.

    Refused joins go through the existing jittered rejoin backoff. Rotations back to back are followed one read at a time.

### Files touched

- `supabase/migrations/20261022120000_realtime_revocation_rotation.sql`: new.
- `scripts/apply-migrations.sql`: regenerated with `npm run migrations:mirror`, not hand-edited.
- `tests/sql/realtime_revocation_rotation.sql`: new SQL proof.
- `tests/sql/README.md`: a new section appended at the end.
- `tests/realtimeRevocationRotation.test.ts`: new static guard on the triggers. It runs in CI's unit job, which runs no SQL.
- `src/sync/realtimeChannel.test.ts`: 4 new unit tests.
- `tests/live/takedownRealtime.live.test.ts`:
    - a third scenario for revocation;
    - the shared device helper now also records remote ink.

Not touched: `ci.yml`, `src/sync/wire.ts`, `remoteInkBuffers.ts`, takedown logic, grants (P1), district purge logic (P5).

### Deviations

- **No client code change.** The tests showed no gap, as described above.
- **Triggers instead of edits to each path.** Hooking the row writes covers all six paths in the packet without redefining their functions. The packet's line references held at 47e9b38f with no drift:
    - `20261007120000:298` (downgrade), `:368` (remove), `:470` (revoke);
    - `20260826194426:179` (unassign);
    - `20261020150100:444` (end_student_sessions);
    - `20261021120700:387` (district soft delete).
- **Proof style.** The SQL proof fires the deferred rotation with `SET CONSTRAINTS … IMMEDIATE`, which does what COMMIT does, because a rolled-back proof never reaches COMMIT.

## Local check results (final tree, before push)

| Check                                                                                                                                                                   | Result                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run lint:check`                                                                                                                                                    | pass                                                                                                                                                                           |
| `npm run typecheck`                                                                                                                                                     | pass                                                                                                                                                                           |
| `npm run test`                                                                                                                                                          | pass: 220 files passed, 5 skipped (the live files); 3389 tests passed, 14 skipped, 0 failed                                                                                    |
| `npm run build`                                                                                                                                                         | pass                                                                                                                                                                           |
| prettier                                                                                                                                                                | `--check` passes on the changed TS/MD files. Prettier has no SQL parser configured in this repo, so the three `.sql` files can't be checked, same as every existing migration. |
| `src/sync/realtimeChannel.test.ts`                                                                                                                                      | 62/62 (4 new)                                                                                                                                                                  |
| `tests/realtimeRevocationRotation.test.ts`, `tests/migrationRecoverability.test.ts`, `tests/applyMigrationsInSync.test.ts`, `tests/moderation/takedownRealtime.test.ts` | 44/44                                                                                                                                                                          |

**Note on the test suite: run it without `.env.local`.**

- `npm run cloud:up` writes `.env.local`, which is gitignored.
- With that file present, `src/sync/syncEngine.test.ts > backs off exponentially with jitter, capped at a minute` fails, and so does an unhandled `unref` error.
- The same test passes 127/127 on clean origin/dev, and in this tree with `.env.local` moved aside.
- CI has no `.env.local`, so the suite numbers above were run with it moved aside. This comes from the local environment, not this change.

## SQL proofs (local stack, pass/total)

| Proof                                                                              | Result                                                                                                                                      |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/sql/realtime_revocation_rotation.sql` (new)                                 | **59/59**                                                                                                                                   |
| same, negative control: the three queueing triggers dropped inside the transaction | 27 of 59 fail, so the proof detects a missing fix                                                                                           |
| `cancel_link_lifetime`                                                             | 57/57                                                                                                                                       |
| `cancel_link_tombstones`                                                           | 38/38                                                                                                                                       |
| `cancel_link_db_clock`                                                             | 21/21                                                                                                                                       |
| `cancel_link_tombstone_race`                                                       | 25/25                                                                                                                                       |
| `cancel_link_read_db_clock`                                                        | 10/10                                                                                                                                       |
| `cancel_link_save_after_insert`                                                    | 12/12                                                                                                                                       |
| `cancel_link_consume_db_clock`                                                     | 36/36                                                                                                                                       |
| `checkout_consents`                                                                | 25/25                                                                                                                                       |
| `launch_checkout_fixes`                                                            | 46/46                                                                                                                                       |
| `content_moderation`                                                               | 99/99, with rows left on the shared local DB by earlier committed live-test takedowns hidden inside the rolled-back transaction (see below) |
| `column_integrity`                                                                 | 113/113                                                                                                                                     |
| `district_retention`                                                               | 28/28                                                                                                                                       |
| `district_student_scope`                                                           | 47/47                                                                                                                                       |
| `share_link_errors`                                                                | 26/26                                                                                                                                       |
| `student_access_revocation`                                                        | 42/44: checks 22 and 24 fail, **identically with my triggers dropped**, so this predates P4                                                 |
| `district_read_only_seats`                                                         | 64/68: checks 49, 59, 60 and 62 fail, **identically with my triggers dropped**, so this predates P4                                         |

**What `realtime_revocation_rotation.sql` covers.** For each path below, the score moves exactly once, at commit. Both old topics get `topic_rotated`. The member who lost access is refused both new topics and the old ones. Members who keep access join the new generation, and a viewer joins it without being able to send live ink. The paths:

- editor → viewer;
- `assign_score` flipping to view-only;
- remove plus leave in one transaction (one rotation);
- link revoke withdrawing two members (one rotation);
- unassign;
- `end_student_sessions`, a reset, across two scores;
- archive: the stamp, then the session end, which does not move it again;
- district soft delete through the real `retention_district_run`, with two students sharing a score (one rotation).

It also checks:

- Membership hints go out on the old topic before the move.
- A mark committed after the move goes only to the new `doc-db` topic.
- These move nothing: gaining write, setting the same role, a plain revoke, restoring an archived student.
- A reset student who signs in again rejoins.
- A score deleted in the same transaction is skipped cleanly.
- No client role can reach the queue or the rotation functions.

**Why `content_moderation` needed rows hidden.** The live takedown tests commit takedowns on the shared local DB, which leaves 4 `content_notice_log` takedown rows and 6 `content_notice_outbox` rows (`@takedown.test`). The proof assumes neither table has such rows. With only the outbox rows hidden it reads 98/99, and fails check 24 the same way with or without my triggers.

## Live test

`tests/live/takedownRealtime.live.test.ts` **ran** against the local stack started with `cloud:up`, on the real local Realtime server: **3/3 passed**. That is the 2 existing takedown scenarios plus the new revocation scenario.

The new scenario:

- **Removed member.** Its raw channels joined before the change and ignore every hint. After the owner calls `remove_document_member`:
    - it hears none of the owner's new ink;
    - it gets none of 60 committed marks;
    - its epoch read is `denied`;
    - its join on generation 1 is refused.
- **Member who stays.** It runs the app's own channel class, follows the rotation, and gets all 60 marks plus the owner's ink.
- **Editor made viewer.** Its old channel joined as an editor. After `set_document_member_role(…, 'viewer')` the owner moves to generation 2, and nothing the demoted user sends reaches anyone. That holds for the stale channel and for a fresh viewer join on generation 2.
- **Negative control.** With the three triggers dropped, the new scenario fails: the owner never moves to generation 1. The triggers were reapplied afterwards and verified.

The live tests create their own throwaway accounts and scores and delete them afterwards. No seeded data, accounts, passwords or billing were touched.

## CI on the final head (`a9e98c9`)

Two workflow runs: `39729945750` (push) and `39729978088` (pull_request).

| Check                   | Run                            | Result                                 |
| ----------------------- | ------------------------------ | -------------------------------------- |
| checks                  | 39729945750 / job 119662434477 | success                                |
| supabase-local          | 39729945750 / job 119662434467 | success                                |
| omr-service             | 39729945750 / job 119662434317 | success                                |
| supabase-drift          | 39729945750 / job 119662434548 | success                                |
| checks                  | 39729978088 / job 119662535652 | success                                |
| supabase-local          | 39729978088 / job 119662536132 | success                                |
| omr-service             | 39729978088 / job 119662536234 | success                                |
| supabase-drift          | 39729978088 / job 119662535484 | success                                |
| Vercel Preview Comments | —                              | success (preview Ready)                |
| Supabase Preview        | —                              | skipped (integration, as on other PRs) |

CI was green on the first push, so no fix-up commits were needed.

## Open questions

1. **P1's SQL-proof glob in CI vs. Realtime.** `realtime_revocation_rotation.sql` needs today's `realtime.messages` partition, which only exists while the Realtime service runs. The current `supabase-local` CI job starts Supabase with `-x realtime`.
    - If P1's new glob runs every `tests/sql/*.sql` proof there, this proof fails check `00` and the hint checks. So would the existing `content_moderation.sql`.
    - I could not create the partition from the proof: `permission denied for schema realtime`.
    - I did not touch `ci.yml`. **Decision for Max/P1:** start Realtime in that job, or leave the Realtime-dependent proofs out of the glob.
2. **Pre-existing local proof failures.** These are not in CI, and are identical with and without this PR:
    - `student_access_revocation.sql` checks 22 and 24 ("reset: … nor change one / nor erase one through patch_annotations_batch (no row matches)", now refused with 42501);
    - `district_read_only_seats.sql` checks 49, 59, 60 and 62.

    They look like proofs that later migrations made stale. I left them alone (out of scope). Are they known?

3. **Rejoin burst at scale.** One rotation makes every connected member who keeps access do 2 epoch RPCs and 2 channel joins at once. A district soft delete rotates every score any of its students is on, in one commit. Each score's remaining audience is usually small (its teacher), but a large district could produce a short burst of joins against the Realtime tenant's join rate limit.
    - Refused joins already back off with jitter.
    - The move itself is immediate: ink stays held until the move, so a delay costs only latency.

    Should I add a small jittered delay before the post-rotation epoch read? It is not needed for correctness, so I did not add it.

4. **Extra rotation in mixed transactions.** If a takedown, or a read-only seat change (`seat_live_ink_notify`), rotates a score in the same transaction as a revocation, the deferred trigger rotates it once more at commit. The members who stay go through one extra rejoin. This is harmless and I left it as is.
5. **Evidence documents.** The two `/workspace` evidence files were not available. Nothing needed them: every file/line reference in the packet was verified in the repo at 47e9b38f.

## Hosted steps left for Max (none performed)

1. Merge order: P1 → P2 → P3 → **P4**. If earlier PRs land first, rebase P4 onto the new dev and regenerate `scripts/apply-migrations.sql` with `npm run migrations:mirror`.
2. Apply `20261022120000_realtime_revocation_rotation.sql` to the hosted dev project (`qdbnlrgylelelvwbkvnm`) through the usual path. If wanted, run `tests/sql/realtime_revocation_rotation.sql` there; it rolls back and needs Realtime running on the project.
3. Production (`jibgwgosihadbjgxdsfe`) gets the migration through the normal merge/deploy integration.
    - No frontend deploy is coupled to it: the app already follows `topic_rotated` (20261020150100's frontend).
    - Tabs on a bundle older than that frontend would stay on generation 0 after a rotation. They still converge by pulling, the same caveat the takedown migration documents.
4. Optional: run `tests/live/takedownRealtime.live.test.ts` again on a laptop stack (`npm run local:up`). It is local-only by design.

No hosted Supabase project, Stripe or secrets were touched. No keys were printed.

## Expected conflicts with the other launchfix PRs

- **`scripts/apply-migrations.sql`.** Every PR that adds a migration regenerates it, so it will conflict textually. Resolve by regenerating (`npm run migrations:mirror`) after rebasing, never by hand-merging.
- **`tests/sql/README.md`.** P4 appends a section at the end. Other PRs that add proofs and append there will conflict trivially; keep both sections.
- **P1 (grants, CI glob).** No file overlap, since `ci.yml` is untouched. See open question 1 about the glob and Realtime. If P1 tightens grants on `realtime.messages` or the topic functions, rerun this proof after rebasing.
- **P3 (live ink, `wire.ts`, `remoteInkBuffers.ts`).** No file overlap. If P3 changes the `realtime.messages` broadcast policies or the ink wire format, rerun this proof's `can_send` checks and the live test, which sends `ink:progress`. P3 might also extend `tests/live/takedownRealtime.live.test.ts`; P4 changed its device helper (it records remote ink) and appended one test.
- **P5 (district purge).** No overlap: the trigger is on `managed_students`, not in `retention_district_run`. But the proof calls `retention_district_run(now())`, `claim_district_retention_notices(50)` and `finish_district_retention_notice(id)`. If P5 changes their signatures or the soft-delete step, update proof check 30.
- **Migration order.** 20261022120000 sorts after P1's (100000+) and P3's (110000+), and before P5's (130000+), which matches the merge order.

## Housekeeping

- **`npm run cloud:down` has run.** The local stack is stopped and no containers are left.
- **Safety-net check-in.** I scheduled a one-time check of PR #71's CI for 2026-10-22T06:38Z (trigger `trig_015umco4SJ5fy3quBMFztyAg`). It only re-reads CI. It pushes nothing unless CI has gone red.
- **Messaging.** No other session was messaged, and PR #54 and the other release PRs were not touched.
