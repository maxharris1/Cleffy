# Launchfix P1 fix round 2 (PR #69): report

/workspace is on Max's machine and was not available in this session. This
report lives only on the scratch branch `claude/launchfix-p1-fix2-report`,
which is the final PR #69 head plus one commit adding this file. It is never
on the PR branch. `claude/launchfix-p1-report` and
`claude/launchfix-p1-fix1-report` were read, not touched.

## Status

**Done.** Every item on the packet's "Done when" list is met:

- PR #69 was fast-forwarded from `275b188b` to **`d67e7be5`**. It is still a
  draft, still based on `dev`, and has no reviewers.
- Local checks and every SQL proof pass: **38 of 38 proofs, 1,708 checks, 0
  failures**. The new Storage API test passes 4/4.
- PR #69's title and body were rewritten to describe the current state.
- CI on `d67e7be5`: **all green**: both CI runs (push 39742189943 and pull_request 39742193931), Vercel and Vercel Preview Comments. Supabase Preview was skipped, as before.

Nothing was merged. Nothing was pushed to `dev` or `main`, and no PR was
opened. PR #54 and the other sessions' PRs and branches were not touched;
they were only read. Hosted Supabase, Vercel, Resend and Stripe were not
touched. No other session was messaged. `npm run cloud:down` has been run.

## Environment

This ran in the **Cleffy cloud environment, `env_01WAd3yiz3qpSnsofpyEwCh2`**,
not Sandbox. `get_session` reported `environment_id:
env_01WAd3yiz3qpSnsofpyEwCh2` and `environment_kind: anthropic_cloud`.

- Local stack only: started with `npm run cloud:up` in the background and
  stopped with `npm run cloud:down`.
- Supabase CLI 2.121.0 (the version CI pins), PostgreSQL 17.11, storage-api
  v1.82.1.
- **Throwaway local accounts:**
    - Two probe accounts, `p1fix2-probe-…@example.invalid`, remain in the local
      Docker volume. One still has a probe score.
    - Every `storage-lifecycle-…@example.invalid` account the API test created
      was deleted by the test.
    - The seeded accounts, scores, passwords and billing were not touched.
- **Probes:**
    - A temporary local probe trigger on `storage.objects`, with its log table,
      recorded how the Storage API writes. Both were dropped.
    - The proofs' `dblink` extension was dropped after each run.
    - The test's temporary `deployment_config` quota was removed afterwards.
- **Runner check:** at the end, the other packets' migrations (P3 110000–110200,
  P4 120000–120100, P5 130000–130100) were applied to the disposable local DB.
  This was only to run their new proofs through the new runner (see "Expected
  conflicts"). That DB went with `cloud:down`.

## SHAs

| What                      | SHA                                                                     |
| ------------------------- | ----------------------------------------------------------------------- |
| Starting point (#69 head) | `275b188b66a67dcee04c235707239ff391de887c`                              |
| New #69 head              | **`d67e7be5ecf67274d67439bc867de8b1048bea0b`**                          |
| Report branch             | `claude/launchfix-p1-fix2-report` = `d67e7be5` + one commit (this file) |

- At the start, `origin/mh/launchfix-p1-db-release-safety` was at
  `275b188b`, and it had not moved before the push.
- The push was a fast-forward, `275b188..d67e7be`, with no force.
- Every commit is authored by `Max Harris <drumaxter@gmail.com>`.

## Commits on #69 (oldest first)

| SHA        | Summary                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `03379df4` | ci: sql-proof.sh checks the reported total against the printed rows                                                    |
| `62119ec0` | fix(db): cleanup markers are the server's; two covers per score in committed state; claimed cleanup; shrink over quota |
| `d67e7be5` | test(storage): storage accounting and the thumbnail lifecycle through the real Storage API                             |

`62119ec0` adds the migration and regenerates `scripts/apply-migrations.sql`
with `npm run migrations:mirror`.

## How the Storage API writes (checked locally, before designing)

I used a temporary probe trigger on local `storage.objects`, since dropped,
with storage-api v1.82.1.

- **Every committed write and delete runs as `service_role`**, whether the
  request carried a user token or the service key.
    - A user's request carries the claims `{"role":"service_role"}`. A
      service-key request carries the real JWT claims.
    - So a trigger cannot tell a client from the server by role. Every new
      rule here applies to every writer.
- An upload, `upsert` or `update()` is one `INSERT … ON CONFLICT (bucket_id,
name) DO UPDATE`. Over an existing object, the BEFORE INSERT trigger fires
  and then BEFORE UPDATE.
- A move is an `UPDATE … SET name`. A remove is `DELETE … RETURNING *`.
- Policies run only on the Storage API's rolled-back test, as fix1 found.
- **`delete-account`'s `removeFolder` throws "made no progress"** if a remove
  returns nothing. So a delete-side guard that silently skipped the current
  cover would break account deletion. That ruled out protecting the current
  cover at delete time, and led to the claim design below.

## How each item was addressed

New migration: **`20261022100900_storage_cleanup_markers_and_thumbnail_cap.sql`**,
in P1's range. No existing migration was edited.

### Packet 1 / Codex r2 MAJOR 1: deleting a cleanup marker freed quota

- **Clients can't delete markers.**
    - `document_storage_cleanup_delete`, the owner delete policy, is dropped.
    - `DELETE` is revoked from public, anon and authenticated. authenticated
      keeps `SELECT`.
    - Through PostgREST, the delete is refused with `42501`, and usage is
      unchanged.
- **Only the server clears a marker.** New `public.finish_document_storage_cleanup(p_document_id)`:
    - It is SECURITY DEFINER, callable by authenticated and service_role, not
      anon.
    - It takes the owner's quota lock, `cleffy.storage_quota`/owner. Every
      write into the folder takes the same lock.
    - It re-reads the marker `FOR UPDATE`.
    - It deletes the marker only if both the `scores` and `thumbnails` folders
      are empty, or the score is live again (re-created by its owner). It
      returns false while anything is stored.
    - Another user's call clears nothing.
- **The bytes count until then.** `storage_owner_bytes` already counted marker
  folders. The marker can no longer vanish early.
- **Race closed: an upload that waited on that lock while the marker was
  cleared.**
    - `storage_objects_enforce_quota` re-resolves the folder's owner after
      taking the lock.
    - If the owner changed, the upload is refused with `storage_folder_gone`
      (42501), rather than landing in a folder no one accounts for.
- **Unchanged paths:**
    - The service role keeps `DELETE`. `delete-account`'s `clearStorageCleanup`
      runs after `removeFolder` has emptied both folders.
    - The `documents_refuse_tombstoned_id` trigger still retires a marker when
      its owner re-creates the score.
- **Client:** `purgeDocumentStorage` (`documentsService.ts`) calls the RPC, both
  after its empty re-listing and for a re-created id. Anything other than
  `true` keeps the retry.

### Packet 2 / Codex r1 MAJOR 3 remainder: concurrent covers could exceed 2

- **New `thumbnails_enforce_folder_cap`:** an AFTER INSERT OR UPDATE OF
  (name, bucket_id) trigger on `storage.objects`, for the thumbnails bucket.
    - It takes a per-score advisory lock, `thumbnail_folder_lock(doc)`, held to
      commit.
    - It then counts the folder. Under READ COMMITTED, each statement in the
      trigger gets a fresh snapshot, so the count sees every upload committed
      before it, plus its own row.
    - Above 2 objects, it raises `thumbnail_limit` (42501, JSON detail).
- It runs on the Storage API's real service-role write, **and** on its policy
  test. That is how a full folder is refused by name.
- **It holds every writer, including the service role.** Every real write is
  the service role's. Fix1's `storage_quota` check 69 ("service role is held to
  neither…") was split:
    - 69: the service role is still not held to the revision cap.
    - 69b: the service role is held to the folder count.
- `thumbnail_write_allowed`, behind fix1's policy, keeps only its revision cap.
  Its count only ever ran on the rolled-back test, and the trigger now does
  that job.
- The trigger is named to fire before `thumbnails_record_superseded`, so a
  refused write ledgers nothing.
- **Proved with concurrent inserts.** See `storage_thumbnail_concurrency.sql`
  and `storageLifecycle.test.ts` below.

### Packet 3 / Codex r2 MINOR 2: a failed publish blocked the next one; cleanup raced a publish

- **New `public.claim_superseded_thumbnails(p_document_ids uuid[], p_writing_rev int default null)`:**
    - It runs under each score's folder lock, in id order.
    - It returns, and marks with the new `thumbnail_storage_cleanup.claimed_at`,
      the objects the owner may remove:
        - Sweep (`p_writing_rev` null): the superseded objects, meaning those on
          the ledger.
        - Pre-publish: every object except the published revision and the one
          about to be written. This covers an upload whose `thumb_rev` update
          failed: the "stale non-current objects are replaceable" rule.
    - It never returns the published revision (`documents.thumb_rev`, read
      under the lock), and drops that revision's ledger row.
    - It skips scores the caller doesn't own.
    - Limits: at most 100 scores per call; a call with `p_writing_rev` names
      exactly one.
- **New `documents_thumbnail_published`:** a BEFORE UPDATE OF thumb_rev trigger
  on `documents`.
    - It takes the same folder lock.
    - It refuses to publish a claimed cover, with `thumbnail_claimed` (55000).
    - Otherwise it un-ledgers the newly published cover and ledgers every other
      object in the folder.
    - **So cleanup deletes only objects that aren't current, re-checked under
      the same lock.** Once claimed, a cover can't become current, and it
      wasn't current when it was claimed.
- `thumbnails_record_superseded` (fix1) is redefined so that writing an object
  again doesn't lift its claim. Otherwise a re-upload could be published and
  then deleted by the claimed removal.
- **Client (`thumbnailRemote.ts`):**
    - `publishThumbnail`: if the upload is refused with `thumbnail_limit`, it
      calls `claim_superseded_thumbnails([doc], rev)`, removes what comes back,
      and retries once.
        - Other refusals, such as a member or a policy, still cost one request
          and no retry.
        - After the row stamp, it purges with the sweep claim.
    - `purgeSupersededThumbnails`:
        - `{docId}` claims the superseded covers for that score.
        - `{ownerId}` reads the ledger's document ids (100 rows) and claims
          them in one call.
        - Both remove only what the server claimed. The client-side
          "published revision" filter is gone: the server owns that.
- **Tested:**
    - Single-session: SQL checks 40–63.
    - Concurrent: concurrency proof, both orders.
    - Real API with the app's own `publishThumbnail`: API test 4.
    - Unit: `thumbnailPurge.test.ts`.

### Packet 4 / Codex r2 MINOR 3: over-quota accounts couldn't shrink through the API

- `storage_objects_enforce_quota` is redefined to first find the object a
  write replaces:
    - for an UPDATE in place, its old version;
    - for an INSERT, an existing row with the same name, which is the upsert's
      conflict row.
- If the new size is no larger than the replaced object, the write is
  allowed, even over quota. That includes the Storage API's size-less policy
  test, so the replacement reaches the real write.
- The real write, with its size known, is held to the same rule. Growth goes
  through the quota check, under the owner lock as before.
- A size-less test for a **new** object is still refused once the quota is
  used up.
- **Tested:**
    - Through the API: `upload(upsert)` and `update()` shrink while the other
      file alone is over quota; growth gets HTTP 403 `storage_quota_exceeded`.
    - Directly: UPDATE that shrinks, and UPDATE that grows (SQL checks 31–38).

### Packet 5: sql-proof.sh checks totals

- A `failures | total` proof must print exactly `total` check rows, of which
  `failures` fail.
- The harness, which prints only failing rows, must print exactly its `k`
  failing rows.
- A check row is any row above the summary that carries a `| t` or `| f`
  verdict field.
- **Self-test** with 11 synthetic proofs:
    - Pass: a correct table; a correct harness.
    - Fail: a short table; an extra row; a hidden failing row; a real failure;
      a harness failure; a harness stray failing row; a harness undercount;
      zero checks.
    - One edge case: a multi-line detail whose continuation line contains
      `| t |` is overcounted and fails. That fails closed.
- All 38 proofs satisfy it locally, as do P3's and P4's new proofs.

### Packet 6: PR #69 body

PR #69's title and body were replaced with `gh`-equivalent edits through the
GitHub API. **Only the title and body changed**: draft state, base, reviewers,
labels and comments were not touched.

- **New title:** "launchfix P1: DB release safety (BL-2/3/4, SF-3, A2 storage
  quota; decisions 20, 37, 44, 50, 52)".
- **New body:**
    - every migration with its proof and count;
    - the round-2 fixes;
    - the proof totals and the negative controls;
    - local results;
    - hosted steps and follow-ups.
- The round-0 text is gone, including the KNOWN list and the old counts.

### Packet 7: out of scope

Narrowing sequence and default privileges, and verifying hosted ACLs, were
not touched. See Follow-ups.

### Requester answers to the fix1 questions

1. **Quota sizes:** kept at 500 MiB free and 5 GiB per owner for every paid
   tier, academy included. No UI change was made here.
2. **The TRIGGER preflight:** listed in the hosted steps and the PR body for
   the P6 runbook. This round adds triggers on `storage.objects` and on
   `public.documents`.
3. **Over-quota blocking:** kept. Over-quota owners can now also shrink and
   overwrite (item 4).
    - The client message for `storage_quota_exceeded` is fix1's
      `uploadFailureMessage`.
    - Showing the actual usage and cap in the UI is **not** done here. See open
      question 1.
4. **Sequence and function default privileges:** a follow-up, untouched.
5. **No-op revokes on hosted:** fine. Nothing to do.
6. **#69 body:** updated (packet 6).
7. **`content_rev` server-maintained:** a follow-up, untouched. The thumbnail
   revision cap still relies on the 1,000,000 ceiling. The folder count is now
   enforced in committed state.

## Proofs and tests added

| Name                                              | Kind                                    | Count | What                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------- | --------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/sql/storage_cleanup_and_thumbnail_cap.sql` | SQL proof, one transaction, rolled back | 58    | Markers: owner delete refused, no policy or grant, usage unchanged, quota still holds, RPC false until both folders are empty, stranger clears nothing, re-created id. Shrink over quota: the size-less upsert test passes, a new object is refused, shrink/same/grow through upsert and UPDATE. Cap on the service write and on the policy test. Claims, publish refusals and the rerun. |
| `tests/sql/storage_thumbnail_concurrency.sql`     | SQL proof, **concurrent**               | 18    | See below.                                                                                                                                                                                                                                                                                                                                                                                |
| `tests/storage/storageLifecycle.test.ts`          | vitest against the local Storage API    | 4     | The four items through the Storage API and the app's own `publishThumbnail`. Runs in CI's supabase-local job as a new step. Skipped by the root `npm run test` without the env.                                                                                                                                                                                                           |
| `src/features/library/thumbnailPurge.test.ts`     | unit (rewritten)                        | 10    | Claim-based purge (per score and per owner), never throws; publish retries once only on `thumbnail_limit`; refused stamp.                                                                                                                                                                                                                                                                 |
| `src/features/library/documentsService.test.ts`   | unit (adjusted, +1)                     | n/a   | The tombstone is cleared through `finish_document_storage_cleanup`; a `false` answer keeps the retry.                                                                                                                                                                                                                                                                                     |

**The concurrent-insert proof and its harness.**

- **Harness:**
    - `dblink`, created for the run if missing and dropped again if the proof
      created it.
    - The proof opens three extra backends to the same database, connecting
      over TCP to the server's own address (`inet_server_addr()`) as postgres
      with the local default password. Local stack and CI only.
    - Fixtures are committed so those backends can see them, and removed at the
      start and the end.
    - It uses `dblink_send_query` and `dblink_is_busy` to show a writer waiting
      on the lock, then collects the results.
- **What it checks:**
    - 01–03: three uploads into one empty folder at once. Two wait on the
      first; exactly one of them commits and one is refused with
      `thumbnail_limit`. The folder ends with 2 objects.
    - 04–05: the same into a folder that already holds one.
    - 10–13: a claim first, then a publish of the claimed cover. The publish
      waits and is refused with `thumbnail_claimed`; `thumb_rev` is unchanged.
    - 14–16: a publish first, then a sweep's claim. The claim waits, then takes
      the superseded cover and not the just-published one.
    - 20–22: a marker cleared first, then an upload into its folder. The upload
      waits and is refused with `storage_folder_gone`.
    - 23–24: an upload first, then a clear. The clear waits, sees the object
      and keeps the marker.
    - 30: every fixture is gone.

**Negative controls, run locally and then restored:**

- With `thumbnails_enforce_folder_cap` replaced by a no-op (fix1's behaviour),
  the concurrency proof fails checks 02, 03 and 05: three covers land.
- With fix1's `storage_objects_enforce_quota`, the API shrink test fails with
  HTTP 403 `storage_quota_exceeded`.
- Both were restored by re-applying 100900, and the suite passed again.

**Existing proofs adjusted:**

- `cross_branch_integration`: 37 → 39. "Clear the tombstone" by a client
  delete became three checks: the client delete is refused (42501), the server
  clears the tombstone through the RPC, and the tombstone is gone.
- `explicit_grants`: 22. The pinned `document_storage_cleanup` row is now
  `SELECT`.
- `storage_quota`: 62 → 63. Check 69 was split into 69 and 69b, as above.
- `tests/sql/README.md` documents all of this.

## SQL proofs (pass/total)

Local runs were against the local stack after replaying CI's re-apply step:
every listed migration re-applied in order, including 100900, all exit 0.

| Proof                                       | Local   | CI (`d67e7be5`) |
| ------------------------------------------- | ------- | --------------- |
| annotation_payload_shape                    | 57/57   | 57/57           |
| archived_student_password                   | 13/13   | 13/13           |
| billing_double_charge                       | 98/98   | 98/98           |
| billing_export_claims                       | 35/35   | 35/35           |
| cancel_link_consume_db_clock                | 36/36   | 36/36           |
| cancel_link_db_clock                        | 21/21   | 21/21           |
| cancel_link_lifetime                        | 57/57   | 57/57           |
| cancel_link_read_db_clock                   | 10/10   | 10/10           |
| cancel_link_save_after_insert               | 12/12   | 12/12           |
| cancel_link_tombstone_race                  | 25/25   | 25/25           |
| cancel_link_tombstones                      | 38/38   | 38/38           |
| checkout_consents                           | 25/25   | 25/25           |
| column_integrity                            | 113/113 | 113/113         |
| content_moderation                          | 99/99   | 99/99           |
| cross_branch_integration (was 37)           | 39/39   | 39/39           |
| deployment_config                           | 34/34   | 34/34           |
| district_billing_canonical                  | 12/12   | 12/12           |
| district_migrations_rerunnable              | 20/20   | 20/20           |
| district_read_only_seats                    | 68/68   | 68/68           |
| district_retention                          | 28/28   | 28/28           |
| district_seat_cap                           | 192/192 | 192/192         |
| district_seats                              | 58/58   | 58/58           |
| district_student_scope                      | 47/47   | 47/47           |
| edge_rate_limit_refund                      | 10/10   | 10/10           |
| explicit_grants (pinned row changed)        | 22/22   | 22/22           |
| guest_email_verification                    | 53/53   | 53/53           |
| launch_checkout_fixes                       | 46/46   | 46/46           |
| launch_consent                              | 43/43   | 43/43           |
| one_studio_per_owner                        | 30/30   | 30/30           |
| qa3_cross_branch                            | 12/12   | 12/12           |
| share_link_errors                           | 26/26   | 26/26           |
| **storage_cleanup_and_thumbnail_cap** (new) | 58/58   | 58/58           |
| storage_name_limits                         | 32/32   | 32/32           |
| storage_quota (was 62)                      | 63/63   | 63/63           |
| **storage_thumbnail_concurrency** (new)     | 18/18   | 18/18           |
| student_access_revocation                   | 44/44   | 44/44           |
| superseded_studio_members                   | 20/20   | 20/20           |
| sharing_access_control                      | 94/94   | 94/94           |

**Totals:** 38/38 proofs, 1,708 checks, 0 failures, locally. CI: the same in both runs: 38/38 proofs, 1,708 checks, every proof `OK`, counts identical to local.

The store tests: `cancelLinkStore.test.ts` 8/8 and `storageLifecycle.test.ts`
4/4, locally. CI: 8/8 and 4/4 in both runs.

## Local check results (final head `d67e7be5`)

- `npm run lint:check`: pass.
- `npm run typecheck`: pass.
- `npm run test` (full suite): **3403 passed, 17 skipped (3420)**, in 223
  files plus 6 skipped.
    - It ran with the git-ignored `.env.local` set aside, as in earlier rounds,
      because CI has none.
    - The 4 new skips are `storageLifecycle.test.ts` without its env.
- `npm run build`: pass.
- `npx prettier --check` on every changed file prettier can parse: pass. It
  has no parser for `.sql` or `.sh`.
- `npm run migrations:mirror`: rerun on the final head with **no diff**.
- SQL proofs: 38/38, listed above. Store tests: 8/8 and 4/4.

## CI on the final head `d67e7be5`

**Pull-request run 39742193931:**

| Check                                                                                                                 | Job id       | Result  |
| --------------------------------------------------------------------------------------------------------------------- | ------------ | ------- |
| checks (audit, lint:check, typecheck, test 3403 passed / 17 skipped in 223+6 files, build)                            | 119701878386 | success |
| supabase-local (Realtime gate, re-apply incl. 100900, store test 8/8, Storage API test 4/4, 38 proofs / 1,708 checks) | 119701878686 | success |
| omr-service                                                                                                           | 119701878428 | success |
| supabase-drift                                                                                                        | 119701877974 | success |

**Push run 39742189943:**

| Check          | Job id       | Result                                                   |
| -------------- | ------------ | -------------------------------------------------------- |
| checks         | 119701864286 | success                                                  |
| supabase-local | 119701864689 | success: 38 proofs, 1,708 checks, store 8/8, Storage 4/4 |
| omr-service    | 119701864877 | success                                                  |
| supabase-drift | 119701864828 | success                                                  |

**Other checks:**

- Vercel status: success (deployment completed).
- Vercel Preview Comments: success (119702157686).
- Supabase Preview: skipped (119701862427), as before.
- PR #69 is still a draft on `dev`.

The supabase-local logs show:

- the Realtime gate passing ("Realtime is up: today's realtime.messages
  partition exists");
- every proof printing `OK` with exactly the local counts in the table above,
  `storage_thumbnail_concurrency` 18 included, so the `dblink` harness works
  on the CI runner;
- no `::error` other than the script text echoed in the log.

## Files touched

**New migration:**
`supabase/migrations/20261022100900_storage_cleanup_markers_and_thumbnail_cap.sql`.
No existing migration was edited.

**New proofs and tests:**

- `tests/sql/storage_cleanup_and_thumbnail_cap.sql`
- `tests/sql/storage_thumbnail_concurrency.sql`
- `tests/storage/storageLifecycle.test.ts`

**Changed:**

- **CI:**
    - `.github/workflows/ci.yml`: 100900 in the re-apply list, and the new
      "Storage API test" step.
    - `scripts/ci/sql-proof.sh`: the total check.
    - `scripts/apply-migrations.sql`: regenerated.
- **Proofs:**
    - `tests/sql/README.md`
    - `tests/sql/cross_branch_integration.sql`
    - `tests/sql/explicit_grants.sql`
    - `tests/sql/storage_quota.sql`
- **Client:**
    - `src/features/library/thumbnailRemote.ts`
    - `src/features/library/documentsService.ts`: `purgeDocumentStorage` only.
    - `src/types/database.ts`: two RPCs and `claimed_at`.
    - `src/features/library/thumbnailPurge.test.ts`
    - `src/features/library/documentsService.test.ts`

No UI controls were added, and no teacher or student layers. No P2, P3 or P4
file was touched; see the conflicts section for `documentsService.ts`.

## Deviations from the packet

1. **Item 3, "treat stale non-current objects as replaceable", is done by
   claim and remove, not by the server overwriting them.**
    - SQL cannot delete Storage bytes; `storage.protect_delete` blocks it, and
      a row deleted from SQL would orphan its bytes.
    - So the publishing client claims the stale objects under the lock,
      removes them, and retries.
    - The server guarantees the claim never includes the published cover, and
      that a claimed cover is never published.
2. **The "under the same lock" re-check sits on the claim and the publish, not
   on the Storage delete.**
    - Every committed Storage delete runs as `service_role`, and
      `delete-account` treats an empty remove result as an error.
    - So a delete-side "skip the current cover" guard would break account
      deletion.
    - Instead, the claim reads `thumb_rev` under the lock, and publishing a
      claimed cover is refused under the same lock.
3. **The cap holds the service role too.** Unavoidable, since every real write
   is the service role's. Fix1's proof check 69 was split accordingly. No Edge
   Function writes thumbnails.
4. **The fix1 thumbnail policy's folder count was removed.** Its revision cap
   stays. The committed trigger replaces the count, and running on the policy
   test it names the refusal (`thumbnail_limit`) so the client knows to clear
   the folder.
5. **Extra protection: `storage_folder_gone`.** An upload that waited on the
   owner lock while its marker was cleared is refused. The marker change
   opened this race, so it is closed here.
6. **Extra test: a Storage API test in CI.** Item 4 asked for the API path.
   The test also covers items 1–3 through the real API. It adds one CI step.
7. **`publishedMissing` still self-heals.** A publish of a cover whose object
   was already removed, after its claim row went with it, is not refused, so
   `thumb_rev` can name a missing object. The existing 404 republish path
   repairs it. Refusing every missing object would also refuse
   `column_integrity`'s owner `thumb_rev` update with no object.

## Follow-ups (not done; decisions 50 and 52)

1. **Sequence and default privileges:**
    - Sequences still default to `rwU` for anon and authenticated; functions
      default to `EXECUTE`.
    - The `supabase_admin` default ACL in `public` still grants the client
      roles `arwdDxtm`.
    - Post-launch.
2. **Hosted ACL verification:** for the P6 runbook preflight.
    - `has_table_privilege('postgres', 'storage.objects', 'TRIGGER')` must be
      `t`. 100800 and 100900 add triggers on `storage.objects`.
    - Spot-check the client grants after the replay (see the hosted steps).
3. **Make `content_rev` server-maintained.** Post-launch.
4. **Show usage and cap in the over-quota message** (answer 3). The DB error
   carries `limit_bytes` and `used_bytes` in its JSON detail. The client
   message doesn't show them yet. Client work, probably P2's scope.
5. **Orphaned bytes on the Storage backend.** If the backend delete fails
   after the Storage API deleted the row, the bytes stay on disk, with no row
   to count them. This is Storage's own behaviour, unchanged.

## Open questions

1. **Answer 3's UI message:** should "storage full" show current usage and the
   cap (from the error's JSON detail, `limit_bytes` and `used_bytes`)? That is
   client UI, and P2 may own the upload messages. I left fix1's message as is.
2. **The P5 proof conflicts below:** P5 should rebase onto P1, since P1 merges
   first. Is that P5's next round's job?

## Hosted steps left for Max (none performed)

1. **Before applying 20261022100800 or 100900 to any hosted project:** run
   `select has_table_privilege('postgres', 'storage.objects', 'TRIGGER');` and
   expect `t`. 100900 also creates a trigger on `public.documents`, which
   postgres owns.
2. **After the replay, spot checks:**
    - `select has_table_privilege('authenticated', 'public.document_storage_cleanup', 'DELETE');` → `f`.
    - `select has_function_privilege('anon', 'public.finish_document_storage_cleanup(uuid)', 'EXECUTE');` → `f`.
    - `select count(*) from pg_trigger where tgname in ('thumbnails_enforce_folder_cap', 'documents_thumbnail_published');` → `2`.
3. **Existing state on hosted.**
    - Folders with more than two covers stay as they are: the cap refuses only
      new writes.
    - An owner's next publish clears the stale covers itself (claim and
      remove). Library sweeps clear the ledgered ones.
4. **Unchanged from fix1:**
    - `deployment_config` set to live-only.
    - The bucket-limit check.
    - The quota defaults, overridden only if wanted.
    - These are in the PR body and the fix1 report.

## Expected conflicts with the other launchfix PRs

Inspected read-only at P2 `b3c4757`, P3 `1c9e851`, P4 `ae770d6`, P5
`4ffd856` and P6 `beb5c00`.

- **`scripts/apply-migrations.sql`:** P3, P4 and P5 conflict. Regenerate it
  with `npm run migrations:mirror`; never merge it by hand.
- **`tests/sql/README.md`:** P3, P4 and P5 append sections. Keep both sides.
- **`.github/workflows/ci.yml`:** P5 changes one line.
    - This round adds 100900 to the re-apply list, and a "Storage API test"
      step between the cancel-link store test and the SQL proofs.
    - Keep both.
- **`src/features/library/documentsService.ts`:** P2 adds `forgetDocInk` in
  `purgeLocalDocument` and an import.
    - This round changes only `purgeDocumentStorage`, about 150 lines away.
    - Expect a clean merge.
    - P2 should not reintroduce a client `document_storage_cleanup` delete:
      it is refused now.
- **The stricter `sql-proof.sh`:**
    - P3's and P4's new proofs pass it, run locally against their migrations
      applied on top of this head:
        - P3: `account_deletion_pending` 36, `student_claim_reservation` 53,
          `support_inbound_lease` 43.
        - P4: `realtime_revocation_race` 41, `realtime_revocation_rotation` 78.
    - P5's three new proofs abort before their summary, for reasons this
      round did not cause:
        - `district_retention_reattribution` and `migrations_ordered_replay`
          hit `studio_exists`. Their fixtures create a second live studio per
          owner, which P1's 100300 (round 0) refuses.
        - `content_strikes_survive_deletion` needs the Vault secret
          `content_strike_pepper`, which my local stack doesn't have.
        - P5 has to rebase onto P1. See open question 2.
- **New rules any later code meets:**
    - A third thumbnail object is refused for every writer.
    - A `thumb_rev` change takes the folder lock and is refused for a claimed
      cover.
    - Clients can't delete cleanup markers; use
      `finish_document_storage_cleanup`, or the service role.
- **P6 (docs):** the TRIGGER preflight, the spot checks above, and
  `finish_document_storage_cleanup` (for anyone purging by hand: service role,
  after emptying both folders) belong in the runbook.
