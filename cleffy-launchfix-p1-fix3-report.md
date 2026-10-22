# Launchfix P1 fix round 3 (PR #69): report

**Status:** Complete

/workspace is on Max's machine and was not available in this session. This
report lives only on the scratch branch `claude/launchfix-p1-fix3-report`,
which is the final PR #69 head plus one commit adding this file. It is never
on the PR branch. The earlier report branches (`claude/launchfix-p1-report`,
`claude/launchfix-p1-fix1-report`, `claude/launchfix-p1-fix2-report`) were
read, not touched.

## Summary

- PR #69 was fast-forwarded from `d67e7be5` to **`3575c733`**. It is still a
  draft, still based on `dev`, with no reviewers and no labels.
- New migration `20261022101000_storage_quota_lock_and_cover_reuse.sql`
  addresses all three Codex round-3 findings and packet items 1–4. No
  existing migration was edited.
- Local checks and every SQL proof pass: **40 of 40 proofs, 1,779 checks, 0
  failures**. The Storage API test passes 5/5 and the cancel-link store test
  8/8.
- PR #69's title and body were rewritten for round 3 (packet item 5). Only the
  title and body changed.
- CI on `3575c733`: **all green**: both CI runs (push 39748891498 and pull_request 39748895592: checks, supabase-local, omr-service and supabase-drift), Vercel and Vercel Preview Comments. Supabase Preview was skipped, as before.

Nothing was merged. Nothing was pushed to `dev` or `main`, and no PR was
opened. PR #54 and the other sessions' PRs and branches were not touched;
they were only read. Hosted Supabase, Vercel, Resend and Stripe were not
touched. No other session was messaged. `npm run cloud:down` has been run.

## Environment

This ran in the **Cleffy cloud environment, `env_01WAd3yiz3qpSnsofpyEwCh2`**,
not Sandbox. `get_session` reported `environment_id:
env_01WAd3yiz3qpSnsofpyEwCh2` and `environment_kind: anthropic_cloud`.

- Local stack only: started with `npm run cloud:up` in the background and
  stopped with `npm run cloud:down`. PostgreSQL 17.11, storage-api v1.82.1.
- Locally, `postgres` is not a superuser, has `BYPASSRLS`, and holds `UPDATE`
  and `TRIGGER` on `storage.objects` (see the hosted steps).
- **Throwaway local data:**
    - Every proof fixture was removed: the concurrency proofs delete theirs, and
      the single-transaction proof rolls back.
    - Every `storage-lifecycle-…@example.invalid` account the API test created
      was deleted by the test, and its temporary `deployment_config` quota was
      restored.
    - The proofs' `dblink` extension was dropped after each run, including the
      debugging runs.
    - The seeded accounts, scores, passwords and billing were not touched.
- The harness also created a branch named
  `claude/launchfix-p1-fix3-report-h7796g` on origin, pointing at `d67e7be`,
  before this session started. I did not push to it; the report is on
  `claude/launchfix-p1-fix3-report`, as the task asked.

## SHAs

| What                      | SHA                                                                     |
| ------------------------- | ----------------------------------------------------------------------- |
| Starting point (#69 head) | `d67e7be5ecf67274d67439bc867de8b1048bea0b`                              |
| New #69 head              | **`3575c73320c5202629ff1bb69bde358ad9ea4974`**                          |
| Report branch             | `claude/launchfix-p1-fix3-report` = `3575c733` + one commit (this file) |

- At the start, `origin/mh/launchfix-p1-db-release-safety` was at
  `d67e7be5`. It had not moved before the push.
- The push was a fast-forward, `d67e7be..3575c73`, with no force.
- Every commit is authored by `Max Harris <drumaxter@gmail.com>`.

## Commits on #69 (oldest first)

| SHA        | Summary                                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| `64c7da8f` | fix(db): quota exemption under the owner lock; a late removal never takes the published cover; one folder-lock order |
| `3575c733` | test(db): proofs for the round-3 quota, cover-reuse and lock-order fixes                                             |

`64c7da8f` adds the migration, adds it to CI's re-apply list, updates a
comment in `thumbnailRemote.ts`, and regenerates `scripts/apply-migrations.sql`
with `npm run migrations:mirror`.

## How each finding and packet item was addressed

New migration: **`20261022101000_storage_quota_lock_and_cover_reuse.sql`**, in
P1's range. No existing migration was edited. It is rerunnable: functions are
replaced and triggers dropped before they are created. A proof check reruns it.

### Packet 1 / Codex r3 MAJOR: a replacement could bypass the quota during a concurrent delete

`storage_objects_enforce_quota` (BEFORE INSERT OR UPDATE) is redefined:

1. It resolves the folder's owner. Objects outside a score folder still pass.
2. **For an INSERT, it locks the predecessor**, meaning the row with the same
   name that an upsert would meet, `FOR UPDATE`. A delete of it that is under
   way finishes first, and then there is no predecessor.
3. **It takes the owner's quota lock.** Every write does now, including a
   non-growing rewrite. 100900 skipped the lock for those.
4. It re-checks that the folder still has an owner (`storage_folder_gone`,
   unchanged).
5. **Under the lock, it reads the predecessor `FOR UPDATE` again.** This also
   catches a predecessor committed while the write waited. Only then does it
   weigh the no-growth exemption. The predecessor stays locked by this
   transaction, so it cannot be deleted or renamed before the write commits,
   and the write really does replace it.
6. If there is no predecessor, the write is charged as a new object, as
   before.

**New AFTER INSERT trigger `storage_objects_charge_insert`.** This fires after
unique-conflict resolution, and only for a row that was actually inserted. An
upsert that met an existing row fires AFTER UPDATE instead. Under the owner
lock, with the row now in the usage, it charges the row in full, using the
same rule as the BEFORE trigger, including the size-less policy-test rule.
That holds whatever the BEFORE trigger concluded.

**Lock order:** the object row is locked before the owner lock. An UPDATE
already holds its row before its BEFORE trigger runs, so every writer now
takes the row first and then the owner lock. Taking the owner lock first and
then waiting on the row would deadlock against a move (`UPDATE … SET name`) of
the same object. This is a small deviation from the packet's literal wording;
see Deviations 1.

The over-quota shrink rules from round 2 still hold: the size-less policy test
for a replacement passes, growth is refused, and a new object at the cap is
refused. The existing proofs (`storage_cleanup_and_thumbnail_cap` 31–38) and
API test 2 confirm this.

**Proof (two- and three-session, `storage_quota_lock_concurrency.sql` 01–10):**

- **Three sessions, the review's interleaving:**
    1. Session a deletes X (uncommitted).
    2. b upserts X at the same size; it waits on X's row (02).
    3. c takes the owner lock with a same-size rewrite.
    4. a commits; b, finding X gone, now waits on the owner lock (03).
    5. c uploads Z into the freed space and commits.
    6. b is charged as a new object and refused with `storage_quota_exceeded`
       (04). The owner ends at exactly the cap, never over it (05).
- **Two sessions:** a deletes Z and uploads W in one transaction while b
  upserts Z. b is refused, and the owner stays at the cap (06–08).
- **Delete rolled back:** b's upsert is the non-growing replacement it was,
  and lands at the cap (09–10).
- **Single-session (`storage_quota_lock_and_cover_reuse.sql` 01–13):**
    - the lock order in the function text;
    - the AFTER INSERT trigger's type;
    - the owner lock held after a non-growing rewrite (checked in `pg_locks`);
    - with the BEFORE trigger dropped (inside the rolled-back transaction),
      the AFTER INSERT charge alone refuses a new object over the quota;
    - a name this transaction deleted is charged as new when written again.

### Packet 2 / r2 MINOR 2 remainder: a delayed second cleanup could delete a re-uploaded, published cover

**New BEFORE DELETE row trigger `thumbnails_keep_published_cover` on
`storage.objects`:**

- It applies only to a signed-in user's delete (`auth.uid()` set). That is the
  Storage API's policy test for a removal (`testPermission`, rolled back),
  whose returned rows decide which names its real service-path delete removes.
  I read this in storage-api v1.82.1's `deleteObjects`.
- **Under the score's folder lock, it re-reads `documents.thumb_rev`.** If the
  object is a live score's published cover, the row is skipped (`return
null`): the removal reports it not removed and the real delete leaves it.
  This does not depend on a claim row, so it holds after the first removal
  has deleted the claim.
- It does not apply to the service role's removals (no `auth.uid()`).
  `delete-account`'s `removeFolder` empties a live score's folders, current
  cover included, before deleting the row, and throws on a remove that makes
  no progress. That is why the guard is limited to user requests.
- A deleted score's former covers (`purgeDocumentStorage`) and non-current
  covers are removed as before.

**Publishing (`documents_thumbnail_published`) takes its object's row lock
(`FOR KEY SHARE`) before the folder lock.** This closes the window between
the policy test and the real delete:

- A removal already under way holds the row from before its policy test until
  commit. The publish waits for it and is then refused (`thumbnail_gone`, 55000) instead of naming a removed cover.
- A removal that starts after the publish waits for the publish to commit,
  and its policy test then sees the cover as published and skips it.
- A revision with **no** stored object can still be published, as before
  (round 2's deviation 7: `column_integrity` and the client's 404 republish
  path rely on it).

**Proofs:**

- **Two-session (`storage_quota_lock_concurrency.sql` 20–29):**
    1. Two devices' claims both name 1 (20). The first removes 1 and its claim
       row goes with it (21).
    2. A third device writes 1 again and publishes it (22).
    3. The second device's late removal removes nothing; 1 stays stored and
       published (23).
    4. A removal under way makes a publish of the same object wait, then
       refuses it with `thumbnail_gone` (25–26).
    5. A publish under way makes the removal wait; the removal then removes
       nothing (27–28).
    6. The service role's removal still takes a published cover (29).
- **Single-session (`storage_quota_lock_and_cover_reuse.sql` 20–36):**
    - the published cover is skipped and a superseded cover is removed;
    - the reused-name sequence;
    - a stranger removes nothing;
    - the service role and the server remove;
    - a deleted score's former cover is removed by its owner;
    - the trigger's type and lock order.
- **Real Storage API (`storageLifecycle.test.ts`, new test 5):** the same
  reused-name sequence through supabase-js and the app's `publishThumbnail`.
  The late `remove()` returns `[]` with no error, and the cover still
  downloads. The service key (as `delete-account`) then removes both covers of
  the live score. **Negative control:** with the trigger dropped, this test
  fails ("expected length 0 but got 1").

### Packet 3 / Codex r3 MINOR: bulk publish vs a batched cleanup claim could deadlock

**Fix: one lock order, document UUID ascending, enforced in
`thumbnail_folder_lock` itself.**

- The function records the highest score id the transaction has locked, in a
  transaction-local setting, `cleffy.thumbnail_folder_max`. A rolled-back
  savepoint reverts it together with its locks; I checked both locally.
- A request for a **lower** id never waits. It takes the lock with
  `pg_try_advisory_xact_lock` if the lock is free (or already held), and
  otherwise is refused at once with `thumbnail_folder_busy` (55P03, retryable).
- Since no transaction ever waits for a folder lock below one it holds, no
  cycle of folder-lock waits can form.
- `claim_superseded_thumbnails` already went in id order. The cap trigger
  takes one lock per upload. The new delete guard and the publish trigger go
  through the same function.
- A publish that already holds another score's folder lock (a bulk update)
  also never waits on an object row (`SKIP LOCKED`, then
  `thumbnail_folder_busy` if the row is busy). So there are no folder → row
  waits either.

**Lock order everywhere:** documents row → Storage object row → owner quota
lock → folder lock (ascending) → cleanup ledger. The migration header states
it.

**Proof (`storage_quota_lock_concurrency.sql` 30–35):**

1. b publishes B and holds B's folder lock.
2. a's batched claim over [B, A] takes A, then waits for B (30).
3. b then publishes A, out of order. It is refused **at once** with
   `thumbnail_folder_busy`, in 5 ms locally, rather than by a deadlock (31).
4. After b rolls back, a's claim completes (32), and nothing was published
   (33).
5. In order (A, then B), the claim only waits, and both commit (34–35).
6. **Negative control:** with 100900's functions, check 31 shows `UPDATE 1
after 702 ms` and check 32 shows `ERROR: deadlock detected`.

The single-session checks (`storage_quota_lock_and_cover_reuse.sql` 40–44)
cover the try-lock path, re-locking a lock already held, the in-order path,
and the function text.

### Packet 4: folders already over the cap: **done** (small)

- The **next publish** already trimmed them. An upload into a full folder is
  refused with `thumbnail_limit`, and `publishThumbnail` then claims
  everything but the published cover and the revision being written, removes
  it, and retries.
- The **next cleanup** now trims them too. `claim_superseded_thumbnails`
  (sweep mode) is redefined: in a folder of **more than two** objects, it also
  claims every object except the published cover and the newest other one.
  That one may be an upload on its way to being published, so it is kept.
  Behaviour at or under the cap is unchanged.
- **Proof (`storage_quota_lock_and_cover_reuse.sql` 50–54):**
    1. A folder with four pre-cap objects and none on the ledger, written with
       triggers off, as before 100900.
    2. A sweep claims the two extras.
    3. At the cap, a sweep claims nothing more.
    4. The next publish claims the last non-current one.

### Packet 5: PR #69 body: **done**

- Updated through the REST API (`PATCH /repos/maxharris1/Cleffy/pulls/69`, the
  `gh pr edit` equivalent). `gh pr edit` itself goes through GraphQL, which is
  blocked in this environment.
- **Only the title and body were sent.** Afterwards the PR was still a draft,
  base `dev`, with 0 requested reviewers and 0 labels. No comment was posted.
- **New title:** "launchfix P1: DB release safety (BL-2/3/4, SF-3, A2 storage
  quota; decisions 20, 37, 44, 50, 52, 57)".
- **New body:**
    - every migration with its proof and count, 101000 added;
    - a "Round 3" section;
    - the lock order;
    - 40 proofs and 1,779 checks;
    - the negative controls;
    - local results;
    - hosted steps, with the new preflight lines;
    - follow-ups.
- A second body-only edit, after CI finished, added the CI result line. Title, draft state, base, reviewers and labels were unchanged by both edits.

### Requester answers

The packet wins where they differ.

- **Fix1 answer 6** (body in the rebase pass) is superseded by packet item 5.
  Done now.
- **Fix1 answers 1, 3, 4, 5 and 7, and fix2 answers 1 and 2:** unchanged from
  round 2.
    - The storage-full UI message (usage and cap) and the P5 rebase with its
      `content_strike_pepper` seed belong to the rebase pass. They are not in
      this round; see Follow-ups.
- **Fix1 answer 2:** the TRIGGER preflight is in the hosted steps for the P6
  runbook. This round adds two more preflight lines there.

## Proofs and tests added

| Name                                               | Kind                                           | Count | What                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/sql/storage_quota_lock_and_cover_reuse.sql` | SQL proof, one transaction, rolled back        | 45    | Quota trigger lock order; AFTER INSERT charge alone; owner lock on a non-growing rewrite; a deleted-then-rewritten name charged as new; the published-cover guard by caller (owner, stranger, service role, server, deleted score); the reused-name sequence; ordered folder lock; over-cap sweep trim; rerun and grants. |
| `tests/sql/storage_quota_lock_concurrency.sql`     | SQL proof, **concurrent** (dblink, 3 backends) | 26    | See items 1–3 above.                                                                                                                                                                                                                                                                                                      |
| `tests/storage/storageLifecycle.test.ts`           | vitest against the local Storage API (+1 test) | 5     | New test 5: reused cover name vs a late removal through the real API; the service key still empties a live score's folder. `createScore` now archives the account's earlier test scores first (free tier: 3 live scores).                                                                                                 |

**The two-session proofs and their harness (`storage_quota_lock_concurrency.sql`).**

- **Harness:** the same as round 2's `storage_thumbnail_concurrency.sql`.
    - `dblink`, created for the run if missing and dropped again if the proof
      created it.
    - Three extra backends (a, b, c) connect over TCP to `inet_server_addr()`
      as postgres with the local default password. Local stack and CI only.
    - Fixtures are committed so those backends see them, and removed at the
      start and the end (check 40).
    - It uses `dblink_send_query` and `dblink_is_busy` to show a backend
      waiting, `dblink_get_result` to collect results or errors, and
      `set role authenticated` plus JWT claims for an owner's claims, removals
      and publishes.
- **Fail-closed:** under 100900's functions, the three-session case aborts the
  run at c's upload, because b lands uncharged first. The SQL proof runner
  then fails it.

**Negative controls (run locally, then restored by re-applying 100900 and
101000):**

- **The concurrency proof with 100900's functions** and the two new triggers
  dropped. I ran it as a variant without the three-session case, which aborts
  the run as described above. **11 of 22 checks fail**:
    - 07/08: the upsert lands, and the owner ends at **524,288,100 bytes**,
      over the 524,288,000 cap.
    - 23: the late removal deletes the re-published cover.
    - 25–26: the publish does not wait for the removal, and publishes the
      removed cover (`UPDATE 1`).
    - 27–29: the removal does not wait for the publish, and removes the
      just-published cover.
    - 31/32: `deadlock detected` after about 700 ms, instead of an immediate
      refusal.
- **The single-transaction proof with 100900's functions:** 15 of 45 fail.
- **The Storage API test without `thumbnails_keep_published_cover`:** test 5
  fails.

**Existing proofs:** none changed. All 38 still pass with 101000 applied.

## SQL proofs (pass/total)

Local runs were against the local stack after replaying CI's re-apply step:
all 16 listed migrations re-applied in order, 101000 included, all exit 0.

| Proof                                        | Local   | CI pull_request run | CI push run |
| -------------------------------------------- | ------- | ------------------- | ----------- |
| annotation_payload_shape                     | 57/57   | 57/57               | 57/57       |
| archived_student_password                    | 13/13   | 13/13               | 13/13       |
| billing_double_charge                        | 98/98   | 98/98               | 98/98       |
| billing_export_claims                        | 35/35   | 35/35               | 35/35       |
| cancel_link_consume_db_clock                 | 36/36   | 36/36               | 36/36       |
| cancel_link_db_clock                         | 21/21   | 21/21               | 21/21       |
| cancel_link_lifetime                         | 57/57   | 57/57               | 57/57       |
| cancel_link_read_db_clock                    | 10/10   | 10/10               | 10/10       |
| cancel_link_save_after_insert                | 12/12   | 12/12               | 12/12       |
| cancel_link_tombstone_race                   | 25/25   | 25/25               | 25/25       |
| cancel_link_tombstones                       | 38/38   | 38/38               | 38/38       |
| checkout_consents                            | 25/25   | 25/25               | 25/25       |
| column_integrity                             | 113/113 | 113/113             | 113/113     |
| content_moderation                           | 99/99   | 99/99               | 99/99       |
| cross_branch_integration                     | 39/39   | 39/39               | 39/39       |
| deployment_config                            | 34/34   | 34/34               | 34/34       |
| district_billing_canonical                   | 12/12   | 12/12               | 12/12       |
| district_migrations_rerunnable               | 20/20   | 20/20               | 20/20       |
| district_read_only_seats                     | 68/68   | 68/68               | 68/68       |
| district_retention                           | 28/28   | 28/28               | 28/28       |
| district_seat_cap                            | 192/192 | 192/192             | 192/192     |
| district_seats                               | 58/58   | 58/58               | 58/58       |
| district_student_scope                       | 47/47   | 47/47               | 47/47       |
| edge_rate_limit_refund                       | 10/10   | 10/10               | 10/10       |
| explicit_grants                              | 22/22   | 22/22               | 22/22       |
| guest_email_verification                     | 53/53   | 53/53               | 53/53       |
| launch_checkout_fixes                        | 46/46   | 46/46               | 46/46       |
| launch_consent                               | 43/43   | 43/43               | 43/43       |
| one_studio_per_owner                         | 30/30   | 30/30               | 30/30       |
| qa3_cross_branch                             | 12/12   | 12/12               | 12/12       |
| share_link_errors                            | 26/26   | 26/26               | 26/26       |
| storage_cleanup_and_thumbnail_cap            | 58/58   | 58/58               | 58/58       |
| storage_name_limits                          | 32/32   | 32/32               | 32/32       |
| storage_quota                                | 63/63   | 63/63               | 63/63       |
| **storage_quota_lock_and_cover_reuse** (new) | 45/45   | 45/45               | 45/45       |
| **storage_quota_lock_concurrency** (new)     | 26/26   | 26/26               | 26/26       |
| storage_thumbnail_concurrency                | 18/18   | 18/18               | 18/18       |
| student_access_revocation                    | 44/44   | 44/44               | 44/44       |
| superseded_studio_members                    | 20/20   | 20/20               | 20/20       |
| sharing_access_control                       | 94/94   | 94/94               | 94/94       |

**Totals:** 40/40 proofs, 1,779 checks, 0 failures, locally. CI: the same in both runs: 40/40 proofs, 1,779 checks, every proof passing, counts identical to local.

The store tests: `cancelLinkStore.test.ts` 8/8 and `storageLifecycle.test.ts`
5/5, locally. CI: 8/8 and 5/5 in both runs.

## Local check results (final head `3575c733`)

- `npm run lint:check`: pass.
- `npm run typecheck`: pass.
- `npm run test` (full suite): **3403 passed, 18 skipped (3421)**, in 223
  files plus 6 skipped.
    - It ran with the git-ignored `.env.local` set aside, as in earlier
      rounds, because CI has none.
    - The new skip is test 5 of `storageLifecycle.test.ts`, without its env.
- `npm run build`: pass.
- `npx prettier --write`, then `--check`, on every changed file prettier can
  parse: pass, with no changes. It has no parser for `.sql`.
- `npm run migrations:mirror`: regenerated in `64c7da8f`; rerun on the final
  head with **no diff**.
- SQL proofs: 40/40, listed above. Store tests: 8/8 and 5/5.

## CI on the final head `3575c733`

**All green.** Every check on `3575c733` passed (Supabase Preview skipped, as
in every round).

**Pull-request run 39748895592:**

| Check                                                                                                | Job id       | Result  |
| ---------------------------------------------------------------------------------------------------- | ------------ | ------- |
| checks (audit, lint:check, typecheck, test 3403 passed / 18 skipped in 223+6 files, build)           | 119724168344 | success |
| supabase-local (Realtime gate, re-apply incl. 101000, store 8/8, Storage API 5/5, 40 proofs / 1,779) | 119724168079 | success |
| omr-service                                                                                          | 119724168389 | success |
| supabase-drift                                                                                       | 119724168321 | success |

**Push run 39748891498:**

| Check                                                                                        | Job id       | Result  |
| -------------------------------------------------------------------------------------------- | ------------ | ------- |
| checks (test 3403 passed / 18 skipped)                                                       | 119724154960 | success |
| supabase-local (re-apply incl. 101000, store 8/8, Storage API 5/5, 40 proofs / 1,779 checks) | 119724154650 | success |
| omr-service                                                                                  | 119724155131 | success |
| supabase-drift                                                                               | 119724154923 | success |

**Other checks:**

- Vercel status: success ("Deployment has completed").
- Vercel Preview Comments: success (check run 119724461875).
- Supabase Preview: skipped (check run 119724145183), as before.
- PR #69 is still a draft on `dev`.

From the supabase-local logs:

- The Realtime gate passed ("Realtime is up: today's realtime.messages
  partition exists").
- The re-apply step ran 101000.
- Every proof printed its summary with exactly the local counts in the table
  above. Both new proofs are included, so the three-backend `dblink` harness
  works on the runner.
- No proof row failed, and there was no `::error` beyond the script text
  echoed in the log.
- No CI fix round was needed: the first push was green.

## Files touched

**New migration:**
`supabase/migrations/20261022101000_storage_quota_lock_and_cover_reuse.sql`.
No existing migration was edited.

**New proofs:**

- `tests/sql/storage_quota_lock_and_cover_reuse.sql`
- `tests/sql/storage_quota_lock_concurrency.sql`

**Changed:**

- `.github/workflows/ci.yml`: 101000 in the re-apply list, and a comment.
- `scripts/apply-migrations.sql`: regenerated.
- `tests/sql/README.md`: the two new proofs.
- `tests/storage/storageLifecycle.test.ts`: test 5, and `createScore` archives
  earlier scores.
- `src/features/library/thumbnailRemote.ts`: one doc comment only. No code
  change. The client needed none: the new refusals (`thumbnail_gone`,
  `thumbnail_folder_busy`) already make `publishThumbnail` return false, and
  purges never throw.

No UI controls were added, and no teacher or student layers. No P2, P3 or P4
file was touched.

## Deviations from the packet

1. **Item 1's lock order.** The packet says "take the owner quota lock before
   evaluating the non-growth exemption, and read the existing row FOR UPDATE
   under that lock".
    - What it does: it locks the predecessor row first, then takes the owner
      lock, then reads the row `FOR UPDATE` again under the lock before
      weighing the exemption.
    - So the exemption is still evaluated under the owner lock, with the row
      read `FOR UPDATE`, as decision 57 states. The extra row lock up front
      only fixes the order.
    - Reason: an UPDATE (a move) holds its row before its BEFORE trigger takes
      the owner lock. Owner lock → row in the INSERT path would deadlock
      against it.
2. **Item 2 also guards the publish side.**
    - The delete-time re-check runs in the Storage API's policy test, a
      savepoint that is rolled back, which releases the folder lock before
      the real delete.
    - To close that window, a publish takes its object's row lock first and is
      refused (`thumbnail_gone`) if a removal under way takes the object.
    - This is new behaviour. Before, the publish named a removed cover and
      relied on the 404 republish path.
3. **Item 2's guard applies to signed-in users' removals only, not the
   service role's.** `delete-account` must still empty a live score's folders
   (see above).
4. **Item 3 combines both of the packet's options in one mechanism.** There is
   one lock order, and an out-of-order request fails fast instead of waiting.
   A multi-document publish still works when nothing contends, so publishing
   is not limited to one document per transaction.

## Follow-ups (not done)

1. **Rebase pass** (requester answers):
    - The storage-full message shows usage and cap (decision 50(3)); the DB
      error carries `limit_bytes` and `used_bytes`.
    - P5 rebases onto P1, with its proofs seeding a local
      `content_strike_pepper`.
2. **Sequence and default privileges** (decision 50(4)): post-launch.
3. **Make `content_rev` server-maintained** (decision 50(7)): post-launch.
4. **Hosted ACL verification:** for the P6 runbook preflight; see the hosted
   steps.
5. **A move within one owner's folders is charged as a new object.** So a move
   is refused at the cap. This is unchanged from 100800. The app never moves
   objects; noted only for completeness.
6. **Remaining deadlock edges PostgreSQL resolves rather than prevents.** For
   example, an insert holding the owner lock waits on unique-conflict
   resolution with a concurrent move of the same new name. These are
   inherent to a BEFORE trigger and very unlikely; PostgreSQL aborts one side
   with 40P01.

## Open questions

None blocking. One for Max to confirm, since it is new behaviour:

1. **Publishing a revision whose object a removal took while the publish
   waited is now refused (`thumbnail_gone`).** The client's `publishThumbnail`
   returns false and the next session retries. A revision whose object was
   never stored can still be published, as before. Is that split right?

## Hosted steps left for Max (none performed)

1. **Before applying 20261022100800, 100900 or 101000 to any hosted project**
   (P6 runbook preflight):
    - `select has_table_privilege('postgres', 'storage.objects', 'TRIGGER');`
      → `t`. All three create triggers on `storage.objects`.
    - `select has_table_privilege('postgres', 'storage.objects', 'UPDATE');`
      → `t`. **New:** 101000's quota trigger and publish trigger lock
      `storage.objects` rows (`FOR UPDATE` / `FOR KEY SHARE`), which needs
      `UPDATE`.
    - `select rolbypassrls from pg_roles where rolname = 'postgres';` → `t`,
      as locally. The storage functions read `storage.objects` as their owner.
2. **After the replay, spot checks:**
    - `select count(*) from pg_trigger where tgname in ('thumbnails_enforce_folder_cap', 'documents_thumbnail_published', 'storage_objects_charge_insert', 'thumbnails_keep_published_cover');` → `4`.
    - `select has_table_privilege('authenticated', 'public.document_storage_cleanup', 'DELETE');` → `f`.
    - `select has_function_privilege('anon', 'public.finish_document_storage_cleanup(uuid)', 'EXECUTE');` → `f`.
3. **Unchanged from earlier rounds:**
    - `deployment_config` set to live-only.
    - The bucket-limit check.
    - The quota defaults, overridden only if wanted.
    - These are in the PR body.
4. **Existing state:** folders over the cap are now trimmed by the next library
   sweep or publish. Nothing to run by hand.

## Expected conflicts with the other launchfix PRs

Inspected read-only at P2 `1ceeb9d`, P3 `c07fc11`, P4 `657d9cd`, P5
`4ffd856` and P6 `beb5c00`. All are based on `dev` @ `47e9b38f`.

- **`scripts/apply-migrations.sql`:** P3, P4 and P5 conflict. Regenerate it
  with `npm run migrations:mirror`; never merge it by hand.
- **`tests/sql/README.md`:** P3, P4 and P5 append sections. Keep both sides.
  This round adds two paragraphs to the P1 section.
- **`.github/workflows/ci.yml`:**
    - P3 and P5 each edit the old "Checkout and cancel-link SQL proofs" step's
      list. P1 replaced that step with the every-proof loop in round 0, so
      their edit there should be dropped: P1's loop runs their proofs.
    - This round adds 101000 to the re-apply list, a separate hunk. P3, P4 and
      P5 should add their own migrations to that list if they want them
      re-applied.
- **`src/features/library/thumbnailRemote.ts`:** no other packet touches it.
- **`src/features/library/documentsService.ts`:** not touched this round. P2's
  `forgetDocInk` change merges as before.
- **New rules any later code meets:**
    - A signed-in user's removal never deletes a live score's published cover.
      The service role's removals do.
    - Folder locks go in score-id order. A lower id after a higher one is
      refused with `thumbnail_folder_busy` (55P03) if contended.
    - Every write into a score's folders takes the owner's quota lock.
- **P3** changes `delete-account` but keeps its service-key `removeFolder`, so
  the new delete guard does not affect it. P3's migrations don't touch
  `storage.objects` or `thumb_rev`.
- **P5** still needs the rebase-pass work listed above; its proofs were not
  re-run this round.
- **P6 (docs):** the preflight lines and spot checks above belong in the
  runbook.
