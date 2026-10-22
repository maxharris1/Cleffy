# Launchfix P1 fix round 1 (PR #69): report

/workspace is on Max's machine and was not available in this session. This
report lives only on the scratch branch `claude/launchfix-p1-fix1-report`,
which is the final PR #69 head plus one commit adding this file. It is never
on the PR branch. `claude/launchfix-p1-report` was read, not touched.

## Status

**Done.** Every item on the packet's "Done when" list is met:

- PR #69 was fast-forwarded from `ba53d922` to **`275b188b`**. It is still a
  draft, still based on `dev`, and has no reviewers.
- Local checks and every SQL proof pass: **36 of 36 proofs, 1,629 checks, 0
  failures**.
- The KNOWN list is gone from `ci.yml` and `sql-proof.sh`. Any failing check
  now fails CI.
- CI on `275b188b`: **all green**: both CI runs (push 39735162127 and pull_request
  39735168646), Vercel, and Vercel Preview Comments. Supabase Preview was
  skipped, as before.

Nothing was merged. Nothing was pushed to `dev` or `main`, and no PR was
opened. PR #54 and the other sessions' PRs and branches were not touched.
Hosted Supabase, Vercel and Stripe were not touched. No other session was
messaged. `npm run cloud:down` has been run.

## Environment

This ran in the **Cleffy cloud environment, `env_01WAd3yiz3qpSnsofpyEwCh2`**,
not Sandbox. `get_session` reported `environment_id:
env_01WAd3yiz3qpSnsofpyEwCh2` and `environment_kind: anthropic_cloud`.

- Local stack only, started with `npm run cloud:up` and stopped with `npm run
cloud:down`.
- Supabase CLI 2.121.0 (the version CI pins) and PostgreSQL 17.11.
- Two throwaway local accounts remain in the local stack's Docker volume:
  `p1fix-probe-…@example.invalid` and `p1fix-smoke-…@example.invalid`. Their
  documents, objects and tags were removed. The seeded accounts, scores,
  passwords and billing were not touched.
- A temporary probe trigger on local `storage.objects` was used to see how the
  Storage API writes. It was dropped, as was the temporary local
  `deployment_config` row from the smoke test.

## SHAs

| What                      | SHA                                                                     |
| ------------------------- | ----------------------------------------------------------------------- |
| Starting point (#69 head) | `ba53d92274b2d696dc1d183d7c9be24d8d6748ac`                              |
| New #69 head              | **`275b188b66a67dcee04c235707239ff391de887c`**                          |
| Report branch             | `claude/launchfix-p1-fix1-report` = `275b188b` + one commit (this file) |

- At the start, `origin/mh/launchfix-p1-db-release-safety` was at
  `ba53d922`. It had not moved before the push either.
- The push was a fast-forward, `ba53d92..275b188`, with no force.
- Every commit is authored by `Max Harris <drumaxter@gmail.com>`.

## Commits on #69 (oldest first)

| SHA        | Summary                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `f887dce8` | docs(district): step 5 picks the owner's live studio, not a superseded one                             |
| `47333b33` | ci: fix the six stale proof checks, drop the KNOWN list, require Realtime                              |
| `f35af111` | fix(db): superseded studios' members follow their final entitlement; grace ink reads live studios only |
| `f63df515` | fix(db): client roles keep only the table privileges the app uses                                      |
| `275b188b` | fix(db): per-owner storage quota and one thumbnail per score (A2)                                      |

Each migration commit regenerated `scripts/apply-migrations.sql` with
`npm run migrations:mirror`.

## How each item was addressed

### 1. MAJOR: superseded members over the cap (Codex MAJOR 1)

New migration: `20261022100600_superseded_studio_followups.sql`.

- `superseded_studio_member_follow(user)` (service role only) resolves the
  member's **final** entitlement with P1's `resolve_entitlements`.
    - A member still entitled (unlimited cloud scores) is skipped. That covers
      their own plan, a seat in another owner's live studio, or a seat in the
      owner's kept studio.
    - Anyone else gets `apply_free_tier_archival`. That archives past the cap
      as `plan_lapse` and deletes nothing. Every restore path already undoes
      it.
    - It also records the member's read-only state with
      `seat_live_ink_follow`, as `reconcile_studio_seats` does.
- A one-off pass visits every member of every studio 20261022100300
  superseded, once each, in user id order. That is the lock order
  `reconcile_studio_seats` uses.
- New trigger `studios_follow_superseded`:
    - A studio superseded later is followed the same way.
    - A studio brought back (`superseded_at` cleared) goes to
      `reconcile_studio_seats`.
- Proof `tests/sql/superseded_studio_members.sql`, **20/20**:
    - It recreates the pre-migration state and shows the gap: after 100300
      alone, a now-free member keeps 5 active scores.
    - After 100600, that member keeps the 3 most recently updated scores active
      and 2 are archived as `plan_lapse`. All 5 still exist.
    - Three members are skipped and keep 5 active each: one entitled through
      another owner's studio, one with their own Teacher plan, and one with a
      seat in the kept studio.
    - A free member under the cap loses nothing.
    - An archived score can't be brought back past the cap.
    - A rerun changes nothing.
    - With the trigger: a later supersede archives down to 3, and bringing the
      studio back restores the score.

### 2. MAJOR: `seat_grace_deadline` (Codex MAJOR 2)

Done in the same migration.

- `seat_grace_deadline` is redefined to read live studios only, in both the
  early exit and the owner lookup.
- `doc_topic_seat_grace_broadcast` follows unchanged, through
  `caller_seat_grace_ends_before_token()`.
- A header comment records that `subscriptions_follow_district` and the
  retention functions (20261021120700, 20261021120800) deliberately still
  process superseded studios. Superseding retires seats, not billing history
  or retention duties.
- Proof checks 40–44 (same file):
    - The 20261020181100 reading would have given a member of the owner's
      **retired** studio the owner's deadline.
    - Now that member has none. Their live-ink broadcast join on their own
      score, current-generation topic, with a token that outlives the owner's
      deadline, is **admitted**.
    - A member of the owner's live studio is still refused by
      `doc_topic_seat_grace_broadcast`.

### 3. MAJOR: client table privileges (Codex MAJOR 4)

New migration: `20261022100700_client_table_privileges.sql`. See "Grant
changes" below for the full list.

- TRUNCATE, REFERENCES, TRIGGER and MAINTAIN are revoked from anon and
  authenticated on every public table. MAINTAIN is revoked only on
  PostgreSQL 17+, guarded by `server_version_num`.
- SELECT/INSERT/UPDATE/DELETE stay only where an RLS policy lets that role use
  the command.
- The service-only tables are revoked entirely. The default ACL is fixed.
- `explicit_grants.sql` now asserts the reduced set, **22/22**. The pinned
  list covers all eight privileges, column grants included. New checks:
    - 30: no TRUNCATE, REFERENCES, TRIGGER or MAINTAIN for any client role,
      at table or column level.
    - 31: anon holds nothing.
    - 32/33: the four service-only tables are no client's, and the service
      role keeps them.
    - 34: every client privilege is backed by a permissive RLS policy for
      that role and command.
    - 35/36: the default ACL gives the client roles nothing, checked with a
      probe table.
    - 37: a rerun changes nothing.
- `column_integrity.sql` checks 58, 76 and 80 used to expect a client UPDATE
  on snapshots, document tags and favourites to touch 0 rows. They now expect
  the stricter `42501 permission denied`.

### 4. MAJOR: storage abuse (re-audit A2, Codex MAJOR 3)

New migration: `20261022100800_storage_quota_and_thumbnail_lifecycle.sql`,
plus small client changes.

- **How the Storage API writes**, checked against the local stack with a
  probe trigger that has since been removed:
    - It checks policies on a test insert as the user and rolls it back. No
      size is known at that point.
    - It then writes the real row on its service path, with
      `request.jwt.claims.role = service_role` and `metadata.size` set.
    - So a policy cannot enforce a byte quota. It is a **BEFORE INSERT OR
      UPDATE trigger on `storage.objects`**.
- **Quota.**
    - The owner is the owner of the score whose `{document_id}/` folder holds
      the object. For a deleted score whose bytes await cleanup, it is the
      `document_storage_cleanup` owner.
    - Usage is everything in both buckets: archived scores' PDFs, the
      pre-import backup, every stored thumbnail revision, and unpurged
      leftovers.
    - Each folder is one range probe on Storage's `(bucket_id, name COLLATE
"C")` index.
    - A per-owner advisory lock is held to commit, and usage is re-read under
      it, so concurrent uploads can't both fit into the same space.
    - An upsert doesn't count the object it replaces twice.
    - A write that does not grow an object is never refused.
    - A size-less test insert is refused once nothing is left.
    - The error is `42501 storage_quota_exceeded` with JSON detail. Through
      the real API it is **HTTP 403 `storage_quota_exceeded`**, verified
      locally.
    - `src/lib/storageUpload.ts` turns that into "Upload failed: your storage
      is full. Delete scores you no longer need (archived ones count too) or
      upgrade for more space." This covers both the standard and TUS paths.
- **Thumbnails: only the latest revision.**
    - Writing a cover records every **other** object in its folder in the new
      `public.thumbnail_storage_cleanup` ledger. RLS is on, the owner can
      SELECT, and rows are written only by the trigger.
    - Removing an object deletes its ledger row, so the ledger clears itself.
      This follows the established `document_storage_cleanup` tombstone path:
      SQL cannot delete Storage bytes.
    - The client purges the ledger after each successful publish
      (`publishThumbnail` → `purgeSupersededThumbnails`). It also purges in
      the library sweep (`sweepPendingStorageCleanup`). It never removes a
      score's published `thumb_rev`.
- **Revision cap.** A new restrictive policy pair,
  `thumbnails_revision_insert` and `thumbnails_revision_update`, applies to
  authenticated only. A client may write a cover only when both hold:
    - the revision is between 0 and the score's `content_rev`, capped at
      1,000,000;
    - the folder holds at most one other object, the latest, which the write
      replaces.
- **Backfill.** Covers superseded before the migration go on the ledger. The
  published revision is kept when it is stored; otherwise the newest object
  is kept.
- **Proof** `tests/sql/storage_quota.sql`, **62/62**:
    - Limits: the defaults, the per-tier config, and the constraint refusing
      unknown tiers, zero, negative, string, fractional and non-object values.
    - Usage: archived scores count, and a deleted score's files count until
      purged.
    - Refusals: over-quota writes are refused through the real-write path, a
      client test insert and an upsert. The JSON detail carries
      `storage_quota_exceeded`.
    - Allowed: rewriting or shrinking an object, even over quota.
    - Per tier and per owner: a Teacher owner gets 5 GB, and one owner's
      bytes don't count against another's.
    - The trigger takes the advisory lock.
    - Thumbnails, step by step:
        - publishing revision 1 ledgers revision 0;
        - revision 2 is refused while 0 is still stored;
        - removing 0 clears its ledger row;
        - revision 2 then lands and ledgers 1.
    - Revision cap: a revision past `content_rev` is refused, by insert or
      by move, and so is one past 1,000,000.
    - Ledger access: other users read none, and clients can't write or
      delete rows.
    - The service role is held to neither the revision cap nor the folder
      count.
    - The backfill, a rerun, and grants and RLS on the ledger.
- **Existing proofs adjusted:**
    - `storage_name_limits` 06: the largest int revision is a valid name but
      is now refused by the cap. The fixture score is at `content_rev` 17.
    - `district_read_only_seats` 30: the viewer's cover backfill writes
      `0.jpg`, the score's actual revision.
- **End to end against the local stack**, through supabase-js and the real
  Storage API, with a throwaway `p1fix-smoke-…@example.invalid` account:
    - Allowed: `0.jpg`, then `1.jpg` (which ledgered `0.jpg`), then `2.jpg`
      after `0.jpg` was removed and its ledger row went with it.
    - Refused with HTTP 403: `2.jpg` while two covers existed, `9.jpg` (past
      the revision cap), and a 1,000-byte PDF over a lowered 2,500-byte quota.
    - A 100-byte PDF under the quota was allowed.
    - The temporary local `deployment_config` row was deleted afterwards.

### 5. MINOR: DISTRICT_SEATS.md step 5

`and st.superseded_at is null` was added to the scalar subquery.

### 6. MINOR: the KNOWN list

- **district_read_only_seats 49/59/60/62:**
    - `seat_hints()` now counts the membership hint on every generation of
      the live topic (`doc:{id}` and `doc:{id}:{n}`). The rotating hint goes
      to the old topic and the recovery hint to the current one, so check 49
      sees 2, as it should.
    - The grace-deadline section's joins (59, 60 and 62, and the
      refusal checks around them) now use `public.document_live_topic(d1)`,
      the current generation, stored as a fixture. That is the topic a real
      client joins after re-reading `realtime_topic_epoch`.
    - Result: 68/68. The refusal checks around them now ask the current
      topic, so they test the grace policy rather than the generation check.
      Check 44 in the new proof confirms that refusal names
      `doc_topic_seat_grace_broadcast`.
- **student_access_revocation 22/24:** these now expect 20261021120400's
  outright `42501 … access has been withdrawn` for both the PostgREST update
  and `patch_annotations_batch`. Result: 44/44.
- **KNOWN mechanism removed.**
    - `ci.yml`: the `declare -A KNOWN` block is gone, and the runner is called
      with two arguments.
    - `sql-proof.sh`: the third argument, the known-list matching and its
      notices are gone.
    - The runner no longer trusts the summary. A `| f` row above it fails the
      proof even if the summary claims 0 failures.
    - A `grep || true` keeps `set -e` from tripping when nothing failed.
    - Self-test locally: failing summary → exit 1; a summary of 0 with a
      failing row → exit 1 (two shapes); clean → 0; zero checks → 1.
- `grep -rn KNOWN .github scripts` finds nothing. Only the `SKIP` map (whole
  proofs, with reasons) remains, and it is empty.

### 7. supabase-local starts Realtime

- Realtime was already started: it is not in the `-x` list.
- A new step after `supabase start`, "Realtime is running and has created
  today's messages partition", fails the job by name if either of these is
  missing:
    - the `supabase_realtime_*` container;
    - today's `realtime.messages_YYYY_MM_DD` partition (polled for up to
      60 s).
- So P4's `realtime_revocation_rotation.sql` and `content_moderation.sql`
  get a live Realtime.
- CI result for this step: passed in both runs. The log shows "Realtime is up: today's
  realtime.messages partition exists".

## SQL proofs (pass/total)

Local runs were against the local stack after CI's re-apply step had been
replayed locally: every listed migration re-applied in order, all exit 0.

| Proof                               | Local   | CI (`275b188b`) |
| ----------------------------------- | ------- | --------------- |
| annotation_payload_shape            | 57/57   | 57/57           |
| archived_student_password           | 13/13   | 13/13           |
| billing_double_charge               | 98/98   | 98/98           |
| billing_export_claims               | 35/35   | 35/35           |
| cancel_link_consume_db_clock        | 36/36   | 36/36           |
| cancel_link_db_clock                | 21/21   | 21/21           |
| cancel_link_lifetime                | 57/57   | 57/57           |
| cancel_link_read_db_clock           | 10/10   | 10/10           |
| cancel_link_save_after_insert       | 12/12   | 12/12           |
| cancel_link_tombstone_race          | 25/25   | 25/25           |
| cancel_link_tombstones              | 38/38   | 38/38           |
| checkout_consents                   | 25/25   | 25/25           |
| column_integrity                    | 113/113 | 113/113         |
| content_moderation                  | 99/99   | 99/99           |
| cross_branch_integration            | 37/37   | 37/37           |
| deployment_config                   | 34/34   | 34/34           |
| district_billing_canonical          | 12/12   | 12/12           |
| district_migrations_rerunnable      | 20/20   | 20/20           |
| district_read_only_seats            | 68/68   | 68/68           |
| district_retention                  | 28/28   | 28/28           |
| district_seat_cap                   | 192/192 | 192/192         |
| district_seats                      | 58/58   | 58/58           |
| district_student_scope              | 47/47   | 47/47           |
| edge_rate_limit_refund              | 10/10   | 10/10           |
| explicit_grants                     | 22/22   | 22/22           |
| guest_email_verification            | 53/53   | 53/53           |
| launch_checkout_fixes               | 46/46   | 46/46           |
| launch_consent                      | 43/43   | 43/43           |
| one_studio_per_owner                | 30/30   | 30/30           |
| qa3_cross_branch                    | 12/12   | 12/12           |
| share_link_errors                   | 26/26   | 26/26           |
| storage_name_limits                 | 32/32   | 32/32           |
| **storage_quota** (new)             | 62/62   | 62/62           |
| student_access_revocation           | 44/44   | 44/44           |
| **superseded_studio_members** (new) | 20/20   | 20/20           |
| sharing_access_control              | 94/94   | 94/94           |

**New:** `superseded_studio_members` (20), `storage_quota` (62).
**Changed:**

- `explicit_grants`: 14 → 22.
- `district_read_only_seats`: 64/68 → 68/68.
- `student_access_revocation`: 42/44 → 44/44.

Other checks:

- **Store test:** `tests/billing/cancelLinkStore.test.ts` against local
  PostgREST passed, 8/8.
- **Rerunnable:** all three new migrations were applied twice over the
  applied state, all exit 0, and each proof also reruns them.

## Grant changes (20261022100700)

**Every public table, both client roles (and PUBLIC):** TRUNCATE,
REFERENCES, TRIGGER and MAINTAIN are revoked.

**anon:** no public table has an RLS policy for anon or PUBLIC, so anon now
holds **nothing** on any public table. SELECT/INSERT/UPDATE/DELETE were
revoked on these, which had held the full default set:

- `annotation_snapshots`, `annotations`
- `document_favorites`, `document_imports`, `document_members`,
  `document_tags`, `documents`
- `library_tags`, `share_links`, `score_analyses`
- `omr_jobs`, `score_cache`, `imslp_category_sync`, `imslp_file_licenses`

**authenticated, before → after (`Policies` is the commands its RLS
policies allow):**

| Table                     | Before                | After                       | Policies |
| ------------------------- | --------------------- | --------------------------- | -------- |
| annotation_snapshots      | all 8                 | SELECT INSERT               | S I      |
| annotations               | all 8                 | SELECT INSERT UPDATE        | S I U    |
| document_favorites        | all 8                 | SELECT INSERT DELETE        | S I D    |
| document_imports          | all 8                 | SELECT INSERT UPDATE        | S I U    |
| document_members          | all 8                 | SELECT                      | S        |
| document_tags             | all 8                 | SELECT INSERT DELETE        | S I D    |
| documents                 | all 8                 | SELECT INSERT UPDATE DELETE | S I U D  |
| library_tags              | all 8                 | SELECT INSERT UPDATE DELETE | S I U D  |
| share_links               | all 8                 | SELECT INSERT UPDATE DELETE | S I U D  |
| score_analyses            | all 8                 | SELECT INSERT UPDATE        | S I U    |
| omr_jobs                  | all 8                 | **nothing**                 | none     |
| score_cache               | all 8                 | **nothing**                 | none     |
| imslp_category_sync       | all 8                 | **nothing**                 | none     |
| imslp_file_licenses       | all 8                 | **nothing**                 | none     |
| thumbnail_storage_cleanup | (new, 20261022100800) | SELECT                      | S        |

- "All 8" means SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES,
  TRIGGER and MAINTAIN.
- Unchanged, and already narrow:
    - SELECT only: `assignments`, `billing_customers`, `studio_members`,
      `subscriptions`, `teacher_attestations` and `usage_counters`.
    - `document_storage_cleanup`: SELECT DELETE.
    - Column grants:
        - `studios`: SELECT, INSERT(id,name,owner_id), UPDATE(name).
        - `practice_notes`: SELECT INSERT UPDATE(body,noted_on,shared) DELETE.
        - `managed_students`: SELECT on 15 columns.
- The client upserts into `annotation_snapshots`, `document_favorites` and
  `document_tags` all use `ignoreDuplicates` (ON CONFLICT DO NOTHING), which
  needs no UPDATE privilege.
- The two client-callable SECURITY INVOKER RPCs that write,
  `insert_annotations_batch` and `patch_annotations_batch`, only INSERT and
  UPDATE annotations.

**src/ grep evidence for the five named tables:**

| Table               | `src/` (excluding tests and types)                                | Writer                                                                                                                                   | Result                                                   |
| ------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| omr_jobs            | no match                                                          | `services/omr-service/src/jobStore.ts` (service key); `delete-account` (admin)                                                           | revoked entirely                                         |
| score_cache         | no match                                                          | `services/omr-service/src/jobStore.ts` (service key)                                                                                     | revoked entirely                                         |
| imslp_category_sync | no match                                                          | `supabase/functions/imslp-sync` (`admin`)                                                                                                | revoked entirely                                         |
| imslp_file_licenses | no match                                                          | `imslp-download`, `imslp-work`, `_shared/imslpImportFlow.ts` (`admin`)                                                                   | revoked entirely                                         |
| score_analyses      | `src/features/playback/scoreAnalysisService.ts:57,73` (`.select`) | `supabase/functions/score-analyze/index.ts:157` upserts with the **user's** client; OMR service and `delete-account` use the service key | authenticated keeps SELECT INSERT UPDATE; DELETE revoked |

**Default privileges:**

- `alter default privileges for role postgres in schema public revoke all on
tables from anon, authenticated`.
- The local default ACL for `postgres` in `public` was
  `{postgres=arwdDxtm, anon=arwdDxtm, authenticated=arwdDxtm,
service_role=arwdDxtm}`. It is now `{postgres=arwdDxtm,
service_role=arwdDxtm}`.
- The service role's default is kept. Every table also grants it explicitly,
  enforced by `tests/security/explicitServiceRoleGrants.test.ts`.
- Not changed: the defaults for sequences and functions, and the
  `supabase_admin` default ACL in `public`. `postgres` cannot alter another
  role's default privileges. See the open questions.

**Smoke test through PostgREST,** with a throwaway local account:

- These all worked: document insert, update, select and delete;
  favourite upsert and delete; tag insert, upsert and delete; annotation
  upsert and tombstone update; snapshot upsert; `score_analyses` select;
  `document_members` select; the ledger select; and `library_bootstrap`.
- `omr_jobs` select was refused with 42501.

## Storage quota defaults: **for Max to confirm**

| Tier                                                                   | Default                         |
| ---------------------------------------------------------------------- | ------------------------------- |
| free (also a roster `student`, a read-only seat, and any unknown tier) | **500 MiB** (524,288,000 bytes) |
| personal, teacher, academy                                             | **5 GiB** (5,368,709,120 bytes) |

- These are binary units: 500 MiB and 5 GiB, matching the bucket limits'
  MiB. The packet said "500 MB" and "5 GB". Say if you want decimal
  (500,000,000 and 5,000,000,000).
- **Where they live:**
    - Defaults: `public.storage_quota_bytes(tier)` in
      `20261022100800_storage_quota_and_thumbnail_lifecycle.sql`.
    - Override: `public.deployment_config.storage_quota_bytes`, a jsonb of
      tier to bytes. Null means the defaults, and a tier left out keeps its
      default.
- To change them on a deployment, run as the service role or in the SQL
  editor:

    ```sql
    insert into public.deployment_config (id, storage_quota_bytes, updated_by)
    values (true, '{"free": 524288000, "teacher": 10737418240}', 'Max')
    on conflict (id) do update
    set storage_quota_bytes = excluded.storage_quota_bytes, updated_by = excluded.updated_by, updated_at = now();
    ```

- Per-tier file limits are unchanged: 50 MiB per PDF and 2 MiB per thumbnail
  (20261022100500).

## Local check results (final head `275b188b`)

- `npm run lint:check`: pass.
- `npm run typecheck`: pass.
- `npm run test` (full suite): pass, with **3396 passed and 13 skipped
  (3409)**, in 223 files plus 5 skipped.
    - It ran with the git-ignored `.env.local` set aside, as in round 0,
      because CI has none.
    - An earlier run, while I was writing 20261022100700, failed
      `applyMigrationsInSync` only because the new file wasn't mirrored yet.
      It passes on the final head.
- `npm run build`: pass.
- `npx prettier --check --ignore-unknown` on every file changed since
  `ba53d922`: pass.
- `npm run migrations:mirror`: rerun on the final head with **no diff**.
- SQL proofs: 36/36, listed above. Store test: 8/8.

## CI on the final head `275b188b`

**Pull-request run 39735168646:**

| Check                                                               | Job id       | Result  |
| ------------------------------------------------------------------- | ------------ | ------- |
| checks (audit, lint:check, typecheck, test, build)                  | 119679046374 | success |
| supabase-local (Realtime step, re-apply, store test, all 36 proofs) | 119679046679 | success |
| omr-service                                                         | 119679046764 | success |
| supabase-drift                                                      | 119679046609 | success |

**Push run 39735162127:**

| Check          | Job id       | Result                                                                    |
| -------------- | ------------ | ------------------------------------------------------------------------- |
| checks         | 119679025010 | success: every step (audit, lint:check, typecheck, test, build) succeeded |
| supabase-local | 119679025947 | success                                                                   |
| omr-service    | 119679025168 | success                                                                   |
| supabase-drift | 119679024776 | success                                                                   |

**Other checks:**

- Vercel status: success (deployment completed).
- Vercel Preview Comments: success (119679260386).
- Supabase Preview: skipped (119679105689).
- PR #69 is `mergeable_state: clean`, draft, base `dev`.

**What job 119679046679's log shows:**

- The Realtime step passed.
- All 36 proofs printed `OK` with exactly the local counts in the proof table
  above, and none failed.
- There is no KNOWN list any more, so nothing was tolerated.

## Files touched

**New migrations,** all in P1's range; no existing migration edited:

- `supabase/migrations/20261022100600_superseded_studio_followups.sql`
- `supabase/migrations/20261022100700_client_table_privileges.sql`
- `supabase/migrations/20261022100800_storage_quota_and_thumbnail_lifecycle.sql`

**New proofs and tests:**

- `tests/sql/superseded_studio_members.sql`
- `tests/sql/storage_quota.sql`
- `src/features/library/thumbnailPurge.test.ts`
- `src/lib/storageUpload.test.ts`

**Changed:**

- `.github/workflows/ci.yml`: KNOWN removed, Realtime step added, the three
  migrations added to the re-apply list.
- `scripts/ci/sql-proof.sh`
- `scripts/apply-migrations.sql`: regenerated.
- `docs/DISTRICT_SEATS.md`
- Proofs:
    - `tests/sql/README.md`
    - `tests/sql/explicit_grants.sql`
    - `tests/sql/column_integrity.sql`
    - `tests/sql/district_read_only_seats.sql`
    - `tests/sql/student_access_revocation.sql`
    - `tests/sql/storage_name_limits.sql`
- Client:
    - `src/features/library/thumbnailRemote.ts`: `purgeSupersededThumbnails`,
      called after publish.
    - `src/features/library/documentsService.ts`: the sweep also purges.
    - `src/lib/storageUpload.ts`: `uploadFailureMessage`.
    - `src/types/database.ts`: `ThumbnailStorageCleanupRow`.

No UI controls were added, and no teacher or student layers.

## Deviations from the packet

1. **Item 1 adds a trigger.** Besides the one-off pass after the backfill,
   `studios_follow_superseded` does the same for a studio superseded later.
   It hands a studio brought back to `reconcile_studio_seats`. Without it,
   an admin supersede would reopen MAJOR 1.
2. **Item 1 also follows read-only state.** It calls `seat_live_ink_follow`
   with the member's final read-only state, so a stale `seat_read_only_since`
   row from the retired studio doesn't linger.
3. **Item 3 removes more than the packet's four.** Beyond TRUNCATE,
   REFERENCES, TRIGGER and MAINTAIN, the DML privileges with no RLS policy
   were revoked too: "keep only what RLS policies need". Three
   `column_integrity` checks change from "0 rows" to "42501".
4. **Item 4, thumbnails.** Besides cleanup, the server enforces that a
   client's thumbnail folder holds at most two objects: the latest plus the
   one being written. If a predecessor's removal fails, the next publish
   waits until the library sweep removes it.
    - The revision cap is "0 to the score's `content_rev`, at most
      1,000,000". `content_rev` is client-writable, so the hard 1,000,000
      ceiling and the two-object limit are what bound it.
5. **Item 4, quota applies to the service role.** It applies to every
   writer, service role included, because the Storage API's real write is
   always on its service path. An Edge Function writing into a user's score
   folder, such as an IMSLP import, is held to that user's quota.
6. **Item 6, runner.** `sql-proof.sh` now also fails a proof whose summary
   claims 0 failures while a failing row is printed. This addresses Codex's
   "trusts the summary".

## Open questions

1. **Quota units and sizes:** 500 MiB/5 GiB (binary) or 500 MB/5 GB
   (decimal)? Should academy be larger than teacher? Today all paid tiers
   are 5 GiB.
2. **Hosted `storage.objects` TRIGGER privilege.**
    - 20261022100800 creates two triggers on `storage.objects`. Locally,
      `postgres` holds `TRIGGER` with grant option there (`t*`).
    - I believe hosted Supabase grants `postgres` the same, but did not
      verify it.
    - If hosted refuses, the migration **fails loudly** rather than skipping
      the quota.
    - Pre-check for Max: `select has_table_privilege('postgres',
'storage.objects', 'TRIGGER');` must be `t`.
3. **Users already over quota.** No one's data is touched. An owner already
   past their quota (unlikely on a wiped prod) can still read, rewrite and
   shrink, but can't add bytes until they delete something. Is that the
   intended UX?
4. **Default privileges beyond tables.**
    - Sequences still default to `rwU` for anon and authenticated, which
      allows `setval` through any SQL path a client reaches. Functions
      default to `EXECUTE`. I left both, as the packet named tables.
    - The `supabase_admin` default ACL in `public` also still grants
      clients `arwdDxtm`. `postgres` cannot alter it, and our migrations
      don't create tables as `supabase_admin`.
    - Should a later PR narrow sequences and functions?
5. **Hosted ACL equivalence.** Hosted's default ACL may already be narrower,
   which would leave the revokes as no-ops there. Run `explicit_grants.sql`
   against the local stack only, as before.
6. **PR #69's description still describes round 0.** It mentions the KNOWN
   list and the old proof counts. I did not edit it, because only pushes to
   the branch were asked for. Update it, or ask, before review.
7. **The client's `content_rev` is writable.** The thumbnail cap relies on
   the 1,000,000 ceiling and the two-object limit, not on `content_rev`
   being honest. Should `content_rev` become server-maintained? That is out
   of P1's scope.

## Hosted steps left for Max (none performed)

1. **Before applying 20261022100800 to any hosted project:** run `select
has_table_privilege('postgres', 'storage.objects', 'TRIGGER');` and
   expect `t` (open question 2).
2. **Quota.** Decide the defaults (open question 1). Only if they differ,
   set `deployment_config.storage_quota_bytes` (SQL above). Check with
   `select public.storage_quota_bytes('free'), public.storage_quota_bytes('teacher');`.
3. **After the replay,** spot-check the grants: `select
has_table_privilege('anon', 'public.documents', 'SELECT'),
has_table_privilege('authenticated', 'public.documents', 'TRUNCATE');`
   should be `f, f`.
4. **Superseded studios** (only if some exist): the 100600 NOTICE reports
   members followed and scores archived. Check `select count(*) from
public.documents where archived_reason = 'plan_lapse';` before and after.
5. **Existing thumbnails:** the 100800 backfill ledgers superseded covers.
   Owners' clients remove them on their next library visit. Check `select
count(*) from public.thumbnail_storage_cleanup;`, which should fall over
   time.
6. **Unchanged from round 0:** the `deployment_config` live-only step, the
   bucket-limit check, and the supersede-log review. Those are in
   `claude/launchfix-p1-report`, "Hosted steps".

## Expected conflicts with the other launchfix PRs

Inspected read-only at P3 `7b9fd9d`, P4 `a9e98c9`, P5 `00f48a6`, P6
`4ca5287` and P2 `0508174`.

- **`scripts/apply-migrations.sql`:** every migration PR (P3, P4, P5)
  conflicts. Regenerate it with `npm run migrations:mirror`; never merge it
  by hand.
- **`tests/sql/README.md`:** P3, P4 and P5 append sections. Keep both sides.
- **New default ACL: any later migration's new table gets no anon or
  authenticated privileges.**
    - P3 (`student_claim_reservations`, `account_deletions`) and P4
      (`document_realtime_rotation_queue`) already revoke all client
      privileges, so they are unaffected.
    - A future table the app reads through PostgREST must `grant` it
      explicitly, next to its policy.
    - `explicit_grants.sql` check 34 fails if a client privilege lacks a
      policy. Check 05 fails for any new client grant until it is added to
      `t_client_expected`.
- **`.github/workflows/ci.yml`:** the KNOWN block is gone.
    - P4's report expected to remove the `district_read_only_seats` KNOWN
      entry. It no longer exists, so drop that edit.
    - P4's proofs now run with any failure fatal.
    - If P4 changes `district_read_only_seats.sql` too, re-check checks
      45–49 and the grace section, which now use `document_live_topic`.
- **P4 (realtime):**
    - P1 now redefines `seat_grace_deadline`. A P4 redefinition must keep
      both `st.superseded_at is null` filters.
    - If P4 changes realtime policies, `superseded_studio_members.sql`
      checks 43 and 44 exercise `doc_topic_seat_grace_broadcast` on the
      current topic.
- **P5 (retention):** untouched. Retention still visits superseded studios
  by design, as the 100600 header says.
- **P6 (docs):**
    - DEPLOY.md should gain the quota defaults and override SQL, and the
      `storage.objects` TRIGGER pre-check.
    - P6's DISTRICT_SEATS.md step 5 edit, if any, now matches this one:
      `and st.superseded_at is null`.
- **P2 (client):** P2 touches no file this round changes.
    - If P2 edits `thumbnailRemote.ts`, `documentsService.ts` or
      `storageUpload.ts`, expect a textual conflict around
      `publishThumbnail`, `sweepPendingStorageCleanup` or
      `uploadPdfToStorage`.
    - The last diff check showed P2 does not touch them.
- **Any later `storage.objects` policy or trigger:**
    - The restrictive `thumbnails_revision_*` policies AND with everything.
    - `storage_objects_enforce_quota` runs on every write to the scores and
      thumbnails buckets.
