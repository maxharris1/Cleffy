# Launchfix P1: DB release safety, report

/workspace is on Max's machine and was not available in this session, so this
report lives only here, on `claude/launchfix-p1-report` (never on the PR
branch), for Max's machine to copy.

## Status

**Done.** Every item on the packet's "Done when" list is met:

- Draft PR **#69** is open from `mh/launchfix-p1-db-release-safety` into
  `dev`: https://github.com/maxharris1/Cleffy/pull/69. CI is green on its head.
- explicit_grants, one_studio_per_owner, storage_name_limits and
  deployment_config pass. billing_double_charge is 98/98.
- CI loops over every proof, with a skip list whose entries all carry reasons.
- `npm run cloud:down` has run, and this report is written.

Nothing was merged. Nothing was pushed to `dev` or `main`. PR #54 and the
other sessions' PRs and branches were not touched. Hosted Supabase and Stripe
were not touched, and no other session was messaged.

## Environment

This ran in the **Cleffy cloud environment, `env_01WAd3yiz3qpSnsofpyEwCh2`**,
not Sandbox. `get_session` reported `environment_id: env_01WAd3yiz3qpSnsofpyEwCh2`
and `environment_kind: anthropic_cloud`.

- Local stack only: Supabase CLI 2.121.0, Postgres image 17.11.0.004 (the
  same CLI version CI pins).
- Hard rule 2: the session started from a fresh origin/dev checkout at
  47e9b38f, and the branch was cut with
  `git checkout -B mh/launchfix-p1-db-release-safety origin/dev`.

## Branches and SHAs

- **Base:** `origin/dev` = `47e9b38f2dba36fdce852c80948245da344bcc20`. It had
  not moved when the branch was cut.
- **Final PR head:** `ba53d92274b2d696dc1d183d7c9be24d8d6748ac`
- **PR:** #69, draft, base `dev`. No reviewers were requested.
- **Report branch:** `claude/launchfix-p1-report`, which is the PR head plus
  one commit adding this file.
- **Session tooling branch:** the session tooling also named a branch
  `claude/launchfix-p1-db-safety-jyllaf`. It exists on origin at 47e9b38f
  with no commits from me. I did nothing with it; delete it if unwanted.
- **Commit identity:** every commit is authored by
  `Max Harris <drumaxter@gmail.com>`. Pushes were fast-forward only, with no
  force-push.

## Commits on the PR (oldest first)

| SHA                                        | Summary                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `4cf1cce984b95dc6404afac3bc5ae4b3b3738bb0` | fix(db): explicit service_role grants on the BL-3 tables; client revokes on billing lock tables |
| `47db93594fe91b7028b0fa56fab46a18f1cf11a3` | fix(db): read the entitling Stripe modes from deployment_config                                 |
| `e087c41a524529ebc0053e59c953f377567a6227` | fix(db): one live studio per owner                                                              |
| `e3bd9a0f9bbf81e3863a01f1dd5fa644a7d77502` | fix(db): storage object names, bucket limits, no archived client inserts                        |
| `ba53d92274b2d696dc1d183d7c9be24d8d6748ac` | ci: run every SQL proof in supabase-local, with a reasoned skip list                            |

Each commit regenerated `scripts/apply-migrations.sql` with
`npm run migrations:mirror` for exactly the migrations it carries, so every
commit is self-consistent.

## What was done, per scope item

### 1. BL-3: explicit grants

**Migration:** `20261022100000_explicit_service_role_grants.sql`

- Runs `grant all ... to service_role` on all 15 tables the packet names.
- A static scan of every migration found exactly those 15 public tables with
  no explicit service_role grant, so none were added or removed from the list.
- No grant or revoke in it names anon or authenticated. The column grants on
  studios and practice_notes, and every revoke, stand.

**Proof:** `tests/sql/explicit_grants.sql`, 14 checks.

- service_role holds SELECT on every public table.
- service_role holds SELECT/INSERT/UPDATE/DELETE on all of them except five
  deliberate narrowings, which are pinned: `billing_cancel_token_tombstones`,
  `billing_cancel_tokens`, `district_billing`, `district_student_evidence` and
  `studio_seat_tenures`.
- anon and authenticated match a pinned list exactly, column grants included.
- **No-default-grants simulation:** inside the transaction it runs
  `alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role`.
  A probe table then shows the simulation holds. The 15 tables are stripped
  of service_role, and `\ir` of the migration alone gives it back, with the
  client roles unchanged. Both P1 grant migrations are then re-run.

**Static guard:** `tests/security/explicitServiceRoleGrants.test.ts`. Every
public table any migration creates must name service_role in an explicit
grant. I checked that it fails without the new migration.

### 2. BL-2: live-only Stripe mode from config

**Migration:** `20261022100200_deployment_config.sql`

- **Table:** `public.deployment_config` is a singleton. Its key
  `id boolean primary key default true check (id)`.
  `entitling_billing_modes text[]` is null for "unset", or a non-empty
  subset of `{live,test}` with no null element. RLS is on, there are no client
  grants, and service_role holds all.
- **Function:** `entitling_billing_modes()` is now
  `stable security definer set search_path = public`. It reads the row and
  falls back to `{live,test}`. Grants are as before: revoked from public and
  anon.
- **Immutable to stable:** before the change I checked that nothing indexes
  on it and nothing calls it from a constraint, default, policy, view or
  trigger, using pg_depend, pg_index, pg_constraint and pg_policy on the local
  stack. The proof re-checks this.
- **Extra safety (not asked for by the packet):** before replacing the body,
  a DO block checks whether the current body returns something other than
  `{live,test}`. If so, and no config row exists, it carries that value into
  the table. Applying the migration in place over today's hand-narrowed
  production therefore keeps test mode out. On a fresh replay it writes
  nothing.
- **Test pin:** the migrationRecoverability "defined once" pin now expects
  exactly two definitions, 20260828180000 and 20261022100200, with the reason
  in the test. Two new tests pin what the second must keep: it is STABLE, it
  reads deployment_config with the both-modes fallback, and the carry-over
  runs before the replace.

**Proof:** `tests/sql/deployment_config.sql`, 34 checks.

- Unset: test-mode and live-mode Teacher subscriptions both entitle, and so
  do seats under a test-mode or a live Academy.
- With `{live}`: the test-mode subscription resolves `free` through
  `get_entitlements`, both as the service role and for the signed-in user. The
  live one stays `teacher`. A seat under the test-mode Academy gets nothing.
  All of this happens in the same session.
- A null column or no row restores both modes.
- The table refuses a second row, an empty list, an unknown mode and a null
  element. Clients get 42501.
- The carry-over is exercised over a hand-narrowed body. A rerun leaves an
  existing row alone, and over the stock body no row is written.

### 3. BL-4: one studio per owner

**Migration:** `20261022100300_one_studio_per_owner.sql`

- **(a) Which studio is kept:** the one with a `district_billing` or
  `studio_seat_overrides` row, else the oldest. Ties go by id.
- **(b) The others** get the new nullable `studios.superseded_at`. Nothing is
  deleted.
- **(c) Logging:** each superseded studio goes into the new
  `public.studio_supersede_log` (service role only, no foreign keys) with its
  member count, the kept studio and the reason. Each is also raised as a
  NOTICE.
- **(d) Unique index:** partial unique index
  `studios_one_live_per_owner on studios (owner_id) where superseded_at is null`.
- **(e) Refusals:**
    - The `studios_refuse_second_live` BEFORE INSERT/UPDATE trigger, with a
      per-owner advisory lock, raises `P0001 studio_exists` with detail
      `{"code":"studio_exists"}`.
    - `studio_invite_member` refuses a superseded studio with `42501` and
      detail `{"code":"studio_superseded"}`. It is otherwise verbatim from 20260826193902.
    - `resolve_entitlements` is verbatim from 20261020180500, except that both
      seat lookups (the active seat and the read-only seat) skip superseded
      studios.
- **Client:** `src/features/billing/studiosService.ts` shows "You already have
  an academy. Reload the page to see it." for `studio_exists`, and also for the
  index's 23505 if two creates race. There are no new controls.
  `fetchOwnedStudio` now filters `superseded_at is null`, because the kept
  studio is not always the oldest.
- **Supporting changes:** `StudioRow` gains `superseded_at`, with a one-line
  fixture update in `StudioSeats.test.tsx`. New
  `src/features/billing/studiosService.test.ts` has 4 tests.
  `tests/billing/districtSeatCap.test.ts` now checks the cap properties on
  the latest `resolve_entitlements`, P1's included, and requires the
  superseded filter there.

**Proof:** `tests/sql/one_studio_per_owner.sql`, 30 checks. It recreates the
pre-migration state in-transaction (trigger and index removed, multi-studio
owners inserted), then runs `\ir` on the migration.

- **Before:** a member of a second studio gets Academy through it, and a
  5-member studio has a read-only seat.
- **After:**
    - The district studio is kept over an older one, the oldest wins otherwise,
      and a seat override wins over an older studio.
    - Nothing is deleted.
    - The log holds the exact member counts (2, 5, 1, 0) and reasons.
    - A rerun changes nothing.
    - Superseded members resolve `free` and are not read-only.
    - The kept studio's member still resolves Academy.
    - A second live studio is refused with `studio_exists` for a signed-in
      owner, for the server, on un-superseding and on an owner change. With
      triggers off, the index alone refuses it (23505).
    - Clients cannot set `superseded_at`.
    - A superseded studio takes no invite, and the kept studio still does.

**District assumptions checked:** see the open questions.

### 4. SF-3: storage name and size limits

**Grep of the client:**

- `scores` takes `{uuid}/original.pdf` (`storageUpload.ts`, standard and TUS
  upload).
- `scores` also takes **`{uuid}/pre-import-original.pdf`**
  (`documentsService.replaceDocumentPdf`, the smart-import backup).
  `document_imports.backup_path` is pinned to it.
- `thumbnails` takes `{uuid}/{rev}.jpg` (`thumbnailRemote.ts`).
- Edge functions write as service_role, which these policies do not reach.

**Deviation:** the packet's expected list missed the pre-import backup, so
it is allowed.

**Migration:** `20261022100400_storage_object_names.sql`

- Adds RESTRICTIVE insert and update (USING + WITH CHECK) policies on
  `storage.objects` for authenticated, following the
  `20261020180700_read_only_seats_storage.sql:30-47` pattern.
- Patterns: `^<uuid>/(original|pre-import-original)\.pdf$` for scores, and
  `^<uuid>/(0|[1-9][0-9]{0,9})\.jpg$` for thumbnails, where `<uuid>` is a
  lower-case uuid, as the app makes them.
- Reads and deletes are unchanged.
- Also adds `documents_insert_active_only`, a RESTRICTIVE insert on
  `public.documents` that requires `archived_at is null`. This covers
  `20261007120300_billing_correctness.sql:261`, where the cap trigger skips
  archived rows. The app never inserts archived rows.

**Migration:** `20261022100500_storage_bucket_limits.sql`

- Upserts both buckets: scores 52428800 / `{application/pdf}`, thumbnails
  2097152 / `{image/jpeg}`. A missing bucket is created private, and an
  existing bucket keeps its `public` flag.
- Each bucket is written in its own DO block that catches
  `insufficient_privilege` and `raise_exception` and raises a NOTICE saying
  whether the write applied.
- **Locally it applied**: "scores bucket limits applied: 50 MiB,
  application/pdf" and "thumbnails bucket limits applied: 2 MiB, image/jpeg".
- On hosted it is untested. See the hosted steps.

**Proof:** `tests/sql/storage_name_limits.sql`, 32 checks.

- **Allowed:** the three names by insert and by upsert, and the max int rev.
- **Refused:**
    - In `scores`: other names, another `.pdf` name, deeper paths, a suffix,
      another case, an upper-case folder and a bare folder.
    - In `thumbnails`: a non-rev name, a leading zero, a negative rev, a rev
      past int range, a `.png` and a deeper path.
    - In both buckets, a move to another name.
- **Old objects:** a pre-existing odd object cannot be rewritten but can be
  removed. service_role is not held to the names.
- **Documents:** a client archived insert is refused and an active insert
  works. The server can still insert an archived row.
- **Buckets:** limits are set, the migration re-applies them, and the names
  migration reruns with each policy once, restrictive, for authenticated.

**Real Storage API check (extra):** run against the local stack with a
throwaway signup, `p1-storage-…@example.invalid`, through supabase-js.

- These went through: an upsert of `original.pdf` twice,
  `pre-import-original.pdf` and `thumbnails/{id}/3.jpg`.
- These were refused: `scores/{id}/evil.pdf`, a move from original to
  `evil.pdf`, `thumbnails/{id}/cover.jpg`, a `text/plain` upload ("mime type
  text/plain is not supported") and an archived document insert.
- The objects and document were cleaned up. The throwaway account remains in
  the local volume only. No seeded account or score was touched.

### 5. Decision 20

**Migration:** `20261022100100_billing_lock_tables_client_revoke.sql`

- **Cause:** `checkout_attempts`, `subscription_writes` and
  `duplicate_refunds` enabled RLS and granted service_role, but never revoked
  from the client roles. On the local stack the default ACL for `postgres`
  in `public` gives anon and authenticated `arwdDxtm`, so checks 89 ("or read
  the attempts table"), 92 ("or read the write locks table") and 98 ("nor read
  the refund ledger") got a row count instead of 42501.
- **Fix:** `revoke all ... from public, anon, authenticated` on those three.
  service_role keeps its grant. No client or edge code reads them except as
  the service role.
- **Result:** `billing_double_charge.sql` is **98/98** locally and in CI. It
  was 95/98 at base.

### 6. Decision 37 / SF-16: all proofs in CI

**`.github/workflows/ci.yml` (job `supabase-local`):**

- The hard-coded list of 9 is now a loop over `tests/sql/*.sql` plus
  `supabase/sql-tests/sharing_access_control.sql`.
- Every proof runs even after one fails, and the step fails at the end.
- `SKIP` (whole proofs) is empty. `KNOWN` (failing checks by number) has two
  entries, both failing on dev 47e9b38f before P1 and both with reasons in
  `ci.yml`:
    - `district_read_only_seats` checks **49, 59, 60, 62**. The proof was
      written against a stand-in for #63's `rotate_document_realtime`. With
      #63 merged, the sweep really rotates topics: check 49 sees the
      rotation, and the later generation-0 `doc:{id}` presence and live-ink
      joins are refused by the current-generation policy. This is realtime,
      so P4.
    - `student_access_revocation` checks **22, 24**. They expect a reset
      student's write to match no row, but 20261021120400's statement trigger
      now refuses it with 42501 ("access has been withdrawn"), which is
      stricter.
- **Deviation:** the stack now also starts **Realtime and Storage** (removed
  from `-x`). That gives CI the day's `realtime.messages` partition, so the
  sharing broadcast checks 80-82, 85 and 87 run rather than being skipped,
  and Storage's own `storage.objects` migrations, which the storage proofs
  write against (the upsert's `on conflict ... where archived_at is null`).
  CI's database now matches a developer's stack. The job took about 2 min
  15 s.
- The re-apply step now also replays P1's six migrations.

**`scripts/ci/sql-proof.sh`:**

- It now reads both summary shapes the proofs print: `failures | total`, and
  `ALL n CHECKS PASSED` / `k OF n CHECKS FAILED`.
- It takes an optional comma list of known-failing check numbers. It passes
  only if every failing check is on the list, and it emits a notice when a
  listed check starts passing.
- I tested it locally against passing, failing, partially allowed and
  wrongly allowed cases.

**`tests/sql/README.md`:** documents the four new proofs and the CI loop.

## Local check results (final head `ba53d92`)

- `npm run lint:check`: pass (exit 0).
- `npm run typecheck`: pass (exit 0).
- `npm run test` (full suite): pass. **3390 passed, 13 skipped (3403);
  221 files passed, 5 skipped.**
    - This was run with the git-ignored `.env.local` that `cloud:up` writes
      set aside, because CI has none.
    - With `.env.local` present, `src/sync/syncEngine.test.ts` "backs off
      exponentially with jitter" fails. It fails identically on an unmodified
      origin/dev worktree given the same `.env.local`, and passes on both
      without it, so this PR did not cause it.
    - `tests/auth/turnstileField.test.tsx` failed once under full-suite load
      with the stack running, and passed when re-run alone.
- `npm run build`: pass.
- `npx prettier --check --ignore-unknown` on every changed file: pass.
  `.sql` and `.sh` files have no prettier parser, and the repo does not
  format them.

**Rerunnable:** this PR's six migrations were each re-applied twice more over
the applied state, all exit 0: once by the CI "Re-apply" step run locally,
and once explicitly. The four P1 proofs and `billing_double_charge` then
still passed.

### SQL proofs, local stack (pass/total), with P1 applied

| Proof                          | Result                                            |
| ------------------------------ | ------------------------------------------------- |
| annotation_payload_shape       | 57/57                                             |
| archived_student_password      | 13/13                                             |
| billing_double_charge          | **98/98** (95/98 at base)                         |
| billing_export_claims          | 35/35                                             |
| cancel_link_consume_db_clock   | 36/36                                             |
| cancel_link_db_clock           | 21/21                                             |
| cancel_link_lifetime           | 57/57                                             |
| cancel_link_read_db_clock      | 10/10                                             |
| cancel_link_save_after_insert  | 12/12                                             |
| cancel_link_tombstone_race     | 25/25                                             |
| cancel_link_tombstones         | 38/38                                             |
| checkout_consents              | 25/25                                             |
| column_integrity               | 113/113                                           |
| content_moderation             | 99/99                                             |
| cross_branch_integration       | 37/37                                             |
| **deployment_config** (new)    | **34/34**                                         |
| district_billing_canonical     | 12/12                                             |
| district_migrations_rerunnable | 20/20                                             |
| district_read_only_seats       | 64/68 (known 49, 59, 60, 62; same 4 fail at base) |
| district_retention             | 28/28                                             |
| district_seat_cap              | 192/192                                           |
| district_seats                 | 58/58                                             |
| district_student_scope         | 47/47                                             |
| edge_rate_limit_refund         | 10/10                                             |
| **explicit_grants** (new)      | **14/14**                                         |
| guest_email_verification       | 53/53                                             |
| launch_checkout_fixes          | 46/46                                             |
| launch_consent                 | 43/43                                             |
| **one_studio_per_owner** (new) | **30/30**                                         |
| qa3_cross_branch               | 12/12                                             |
| share_link_errors              | 26/26                                             |
| **storage_name_limits** (new)  | **32/32**                                         |
| student_access_revocation      | 42/44 (known 22, 24; same 2 fail at base)         |
| sharing_access_control         | 94/94                                             |

`launch_consent_concurrency.mjs` is not a `.sql` proof and is not part of the
loop. It was not run.

## CI on the final head `ba53d92`: all green

**Push run 39729366010:**

| Check                                              | Job id       | Result  |
| -------------------------------------------------- | ------------ | ------- |
| checks (audit, lint:check, typecheck, test, build) | 119660623338 | success |
| supabase-local (all proofs)                        | 119660623117 | success |
| omr-service                                        | 119660625101 | success |
| supabase-drift                                     | 119660623339 | success |

**Pull-request run 39729403851:**

| Check          | Job id       | Result  |
| -------------- | ------------ | ------- |
| checks         | 119660744303 | success |
| supabase-local | 119660744310 | success |
| omr-service    | 119660744008 | success |
| supabase-drift | 119660744181 | success |

**Other checks:**

- Vercel Preview Comments: success (119660876229).
- Supabase Preview: skipped (119660750757).
- Vercel preview: Ready.

**What job 119660744310's log shows:** every one of the 34 proofs ran. Each
passed, with district_read_only_seats at 64/68 and student_access_revocation
at 42/44, on their known checks only. billing_double_charge is 98/98, and the
four new proofs pass at 14, 34, 30 and 32. The supabase-drift job only checks
read-only against the live project with the repo's token (it touched nothing
itself).

## Files touched

**New migrations, all in P1's range:**

- `supabase/migrations/20261022100000_explicit_service_role_grants.sql`
- `supabase/migrations/20261022100100_billing_lock_tables_client_revoke.sql`
- `supabase/migrations/20261022100200_deployment_config.sql`
- `supabase/migrations/20261022100300_one_studio_per_owner.sql`
- `supabase/migrations/20261022100400_storage_object_names.sql`
- `supabase/migrations/20261022100500_storage_bucket_limits.sql`

**New proofs and tests:**

- `tests/sql/explicit_grants.sql`
- `tests/sql/deployment_config.sql`
- `tests/sql/one_studio_per_owner.sql`
- `tests/sql/storage_name_limits.sql`
- `tests/security/explicitServiceRoleGrants.test.ts`
- `src/features/billing/studiosService.test.ts`

**Changed:**

- `scripts/apply-migrations.sql`: regenerated with `npm run migrations:mirror`,
  never hand-edited.
- `.github/workflows/ci.yml`
- `scripts/ci/sql-proof.sh`
- `tests/sql/README.md`
- `tests/migrationRecoverability.test.ts`
- `tests/billing/districtSeatCap.test.ts`
- `src/features/billing/studiosService.ts`
- `src/types/database.ts`
- `src/features/billing/StudioSeats.test.tsx`

No existing migration was edited.

## Deviations from the packet

1. **SF-3:** `scores/{uuid}/pre-import-original.pdf` is allowed besides
   `original.pdf`. The client writes it, and refusing it would break the
   smart-import cleaner's backup.
2. **SF-3:** the same migration also refuses archived document inserts, as
   the packet's item 4 asked, through a RESTRICTIVE policy on `documents`.
   Bucket limits are a separate migration so their exception handling stays
   isolated.
3. **CI:** Realtime and Storage now start in `supabase-local`. Without them
   the sharing broadcast checks would need skipping and the storage proofs
   would run against a different `storage.objects` schema.
4. **BL-2:** the in-place carry-over of a hand-narrowed body is extra safety
   the packet did not ask for.
5. **BL-4:** `fetchOwnedStudio` filters superseded studios. This is not a new
   control: without it the Account page could show a superseded studio.
6. **BL-3:** the explicit_grants pinned client list includes the local stack's
   permissive default-ACL grants. See open question 1.

## Open questions (nothing below was guessed into code)

1. **Permissive client grants on the local default ACL.** On the local stack,
   anon and authenticated hold SELECT/INSERT/UPDATE/DELETE/TRUNCATE on every
   public table no migration revoked on:
    - the core tables
    - `omr_jobs`, `score_cache` and `score_analyses`
    - `imslp_category_sync` and `imslp_file_licenses`

    `20260827140000_core_table_grants.sql` says `omr_jobs` and `score_cache`
    "stay service_role-only". RLS still hides every row, but TRUNCATE ignores
    RLS (and is not reachable through PostgREST). `explicit_grants.sql` pins
    today's state, as the packet said to keep anon/authenticated exactly as
    they are. Should a later PR revoke these? Hosted's default ACL differs (the
    0827 comment says Dxtm only), and I did not verify it.

2. **Supabase's 2026-10-30 default-grant change** is still unverified. P1
   makes the service role's grants explicit regardless, and the static guard
   enforces it for future tables.
3. **District code still visits superseded studios (BL-4).** I left these
   alone so as not to widen P1 into P4/P5's areas:
    - `subscriptions_follow_district` (20261020180500)
    - the retention candidate and run functions (20261021120700, and P5's
      `20261022130000_district_retention_reattribution.sql:155`)
    - `seat_grace_deadline` (20261020181100, the live-ink deadline)

    A superseded studio only reaches the district paths if it has its own
    `district_billing` row, which is possible only for an owner who had two
    districts. Should P5 or P4 add `superseded_at is null` there?

4. **Scores of superseded members (BL-4).** A member whose only seat was in a
   superseded studio now resolves `free`. Their scores beyond the free cap are
   not archived; new ones are capped by the trigger. Should the backfill run
   `apply_free_tier_archival` for them, as a lapse does? I did not, because
   the packet said delete nothing and change nothing beyond the listed
   behaviour.
5. **Admin snippet in `docs/DISTRICT_SEATS.md` (step 5).** It selects the
   studio by owner email with a scalar subquery
   `(select st.id from public.studios st join auth.users ...)`. It now errors
   ("more than one row") for an owner with a superseded studio, and needs
   `and st.superseded_at is null`. Docs are P6's scope.
6. **Owners of the two known-failing proofs.** Should P4 fix or update
   `district_read_only_seats` 49/59/60/62, and who should update
   `student_access_revocation` 22/24 to expect 42501? Either way, remove the
   `KNOWN` entries when they pass; the runner says so in a notice.
7. **Evidence files.** The evidence files (`/workspace/cleffy-launch-reaudit-*.md`)
   were not available. Every packet line reference was re-located at
   47e9b38f and matched (billing.sql 52-60, 542, 643-648; rls.sql 130,
   139-149; thumbnails 158-170; content_moderation revoke lines 50, 116, 148,
   166, 217 and 273; 20261020180400:304; 20261020180500:310;
   billing_correctness:261; billing_stripe_mode:46-60). Nothing else depended
   on the documents.
8. **Throwaway local account.** The local Storage API check left one
   throwaway account (`p1-storage-…@example.invalid`) in the local stack's
   Docker volume. It is local only and separate from the seeded accounts.

## Hosted steps left for Max (none performed)

1. **After the prod replay**, against `jibgwgosihadbjgxdsfe` only, set the
   live-only config. This is the exact SQL P6's DEPLOY.md placeholder asks
   for:

    ```sql
    insert into public.deployment_config (id, entitling_billing_modes, updated_by)
    values (true, array['live'], 'Max')
    on conflict (id) do update
    set entitling_billing_modes = excluded.entitling_billing_modes,
        updated_by = excluded.updated_by,
        updated_at = now();

    select public.entitling_billing_modes ();  -- must be {live}
    ```

    On the `dev` project (`qdbnlrgylelelvwbkvnm`), leave it unset, which means
    `{live,test}`.

    If P1 is instead applied in place over today's production, whose body
    was hand-narrowed, the migration carries `{live}` into the table itself.
    Verify with the `select` above either way.

2. **Bucket limits.** Check the migration output for
   `20261022100500_storage_bucket_limits.sql`. "...limits applied" means
   done. "...limits NOT applied here" means set them in the dashboard: scores
   50 MiB, `application/pdf`; thumbnails 2 MiB, `image/jpeg`. Then confirm
   with:

    ```sql
    select id, public, file_size_limit, allowed_mime_types from storage.buckets;
    ```

3. **Superseded studios.** Review the backfill's NOTICEs and
   `select * from public.studio_supersede_log;` on any environment that had
   owners with several studios. A wiped prod has none.
4. **Optional:** run `tests/sql/explicit_grants.sql` only on the local stack.
   Its client list is pinned to the local default ACL, and the dev project
   will differ.

## Expected conflicts with the other launchfix PRs

Inspected read-only from origin at the time of writing:
`mh/launchfix-p2-client-safety`, `mh/launchfix-p5-district-retention` and
`mh/launchfix-p6-golive-docs`. No P3 or P4 branch existed yet.

- **`scripts/apply-migrations.sql`:** every migration PR (P3, P4, P5)
  conflicts. Regenerate with `npm run migrations:mirror` after merging; never
  hand-merge.
- **`tests/sql/README.md`:** P5 also appends sections, so a textual conflict
  at the end of the file is likely. Keep both.
- **`.github/workflows/ci.yml`:** P1 rewrites the `supabase-local` proof
  step.
    - A PR that added its proof to the old hard-coded list conflicts: drop the
      list edit, since the loop picks the proof up.
    - P4: if it fixes `district_read_only_seats`, remove that `KNOWN` entry.
- **`tests/sql/explicit_grants.sql` pinned lists:** any later migration that
  creates a public table or changes a client grant changes the result.
    - On the local stack, the default ACL gives a new table anon/authenticated
      full privileges. Add a `t_client_expected` row for the table, or better,
      revoke from the client roles in the migration.
    - The new table also needs an explicit service_role grant, or
      `tests/security/explicitServiceRoleGrants.test.ts` fails.
    - P5's two migrations add no table and no client grant.
      `20261022130100_content_strikes_survive_deletion.sql` already says
      "launchfix P1 grants content_strikes explicitly", so nothing is expected
      there.
- **`resolve_entitlements` and `studio_invite_member`:** P1 redefines both.
  Any later redefinition must keep the two `st.superseded_at is null`
  filters; `districtSeatCap.test.ts` checks them when P1's file is the
  latest.
    - P5's `retention_district_run` reads `studios` (see open question 3).
      There is no textual conflict.
- **`entitling_billing_modes()`:** must not be redefined by any other PR;
  migrationRecoverability pins it to two definitions.
- **`tests/migrationRecoverability.test.ts`:** P1 edits only the
  `entitling_billing_modes` block. A PR editing the cron-job map merges
  cleanly.
- **P6 (docs):**
    - Fill the DEPLOY.md `deployment_config` placeholder with the SQL in
      "Hosted steps" above.
    - Add `superseded_at is null` to `docs/DISTRICT_SEATS.md` step 5 (open
      question 5).
    - P6 does not touch files P1 changes.
- **P2 (client safety):** no overlap with P1's files. P2 edits
  `src/sync/syncEngine.test.ts`; P1 does not touch it.
