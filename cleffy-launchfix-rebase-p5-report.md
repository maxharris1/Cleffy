# Cleffy launch-fix rebase pass: PR #66 (P5) onto dev

**Status:** Complete

> **DECISION 53(4) VERIFICATION FAILED (3 of 6 checks).** A student provisioned into a district after its
> soft delete has listed the students is **not** caught by the next retention run. They are not listed,
> archived or signed out, and they are **not deleted** by the district's hard delete. Their roster row and
> account outlive the district, still attributed to the deleted studio id. As decision 66 instructed, I changed
> no behaviour and still pushed the rebase. The proof is **not** on the PR branch, because a failing proof in
> dev's every-proof loop would turn `supabase-local` red. Its full SQL and output are in §9 below. See open question 1.

- Starting head (PR #66): `4ffd856d767d7da26f2d0b1ce2e78e243e03ae2c` (confirmed: local HEAD and `origin/mh/launchfix-p5-district-retention` both matched before anything was done)
- Rebased onto origin/dev: `6629a93b30ac715642f0c4c8c47deaf5405a4d79` (#71's merge, unchanged since launch; `6629a93b` confirmed an ancestor of origin/dev, in fact equal)
- **New PR #66 head: `d9c1fbfe18b9be399f4bfc423c4e306b5acac0d8`**
- Environment: Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (environment_kind `anthropic_cloud`), confirmed with `get_session` at the start. Not Sandbox.
- Commit identity: every commit in the new series has author and committer `Max Harris <drumaxter@gmail.com>`.

## 1. Push

```
git push --force-with-lease=mh/launchfix-p5-district-retention:4ffd856d767d7da26f2d0b1ce2e78e243e03ae2c origin HEAD:mh/launchfix-p5-district-retention
 + 4ffd856...d9c1fbf HEAD -> mh/launchfix-p5-district-retention (forced update)
```

The lease held. That was the only non-fast-forward push. No other push went to the PR branch.
PR #66 is still a draft with base `dev`. I did not touch its title, body or reviewers, and opened no new PR.

## 2. New series (origin/dev..d9c1fbf)

| #   | SHA       | Subject                                                                                                 |
| --- | --------- | ------------------------------------------------------------------------------------------------------- |
| 1   | `56ef3b7` | District retention: recheck attribution before the hard delete (was `1372669`)                          |
| 2   | `fbbabcc` | Content moderation: copyright strikes survive account deletion (was `00f48a6`)                          |
| 3   | `132f741` | launchfix P5 fix 1: key strikes at deletion with a Vault-peppered HMAC; … (was `da0efd7`)               |
| 4   | `bc10196` | launchfix P5 rebase: P5's proofs under dev's proof harness and one studio per owner (**fix-up**)        |
| 5   | `d9c1fbf` | launchfix P5 rebase: explicit service_role grant migration for district_retention_restores (**fix-up**) |

`4ffd856` ("CI: run the P5 proofs in supabase-local") was **dropped**. Section 3 explains why.

## 3. Conflicts and how they were resolved

1. **`scripts/apply-migrations.sql`** (commit 1; generated). I took dev's copy and regenerated it with
   `npm run migrations:mirror`. Commits 2 and 3 auto-merged it, and re-running the mirror at each of those
   steps produced no further change. Fix-up 5 regenerated it once more to add the grant migration.
2. **`tests/sql/README.md`** (commits 1, 2 and 3). I kept both sides. Dev's P1–P4 sections and its closing
   `## In CI` section stay as they were. P5's three proof descriptions sit under a new heading,
   `## Launchfix P5: district retention and content strikes`, placed just before `## In CI`. In commit 3
   I took P5's revised text for its own paragraphs (content strikes, ordered replay), as the old series had it.
3. **`.github/workflows/ci.yml`** (commit 4). I took dev's file unchanged. P5's only CI change was to add
   `district_retention_reattribution content_strikes_survive_deletion migrations_ordered_replay` to the old
   hand-written proof list. #69 replaced that list with the every-proof loop over `tests/sql/*.sql`, so P5's
   proofs run there by existing and the commit became empty. I dropped it with `git rebase --skip`.

**ci.yml relative to origin/dev: identical.** `git diff origin/dev d9c1fbf -- .github/workflows/ci.yml` is
empty. I kept nothing from P5's old ci.yml and added nothing, because P5 needs nothing extra:

- its proofs run in dev's `SQL proofs (tests/sql/*.sql …)` step, and its SKIP map stays empty;
- the fake pepper reaches CI through `supabase start` applying `supabase/seed.sql` (§6);
- Realtime is not needed by P5's proofs.

The rebase left all of P5's own files byte-identical: both migrations, `supabase/seed.sql`, the two policy
drafts, the vitest files, its 4-line change to `tests/migrationRecoverability.test.ts` and its three proof
files. (`git diff 4ffd856 132f741` on those paths shows only dev's own changes to other parts of
`migrationRecoverability.test.ts`.)

## 4. Range-diff (`git range-diff origin/dev 4ffd856d767d7da26f2d0b1ce2e78e243e03ae2c d9c1fbf`)

Summary:

```
1:  1372669 ! 1:  56ef3b7 District retention: recheck attribution before the hard delete
2:  00f48a6 ! 2:  fbbabcc Content moderation: copyright strikes survive account deletion
3:  da0efd7 ! 3:  132f741 launchfix P5 fix 1: key strikes at deletion with a Vault-peppered HMAC; restore re-attributed students; replay-safe skip log
4:  4ffd856 < -:  ------- CI: run the P5 proofs in supabase-local
-:  ------- > 4:  bc10196 launchfix P5 rebase: P5's proofs under dev's proof harness and one studio per owner
-:  ------- > 5:  d9c1fbf launchfix P5 rebase: explicit service_role grant migration for district_retention_restores
```

What the `!` entries contain:

- **1, 2, 3:** only context changes. The `scripts/apply-migrations.sql` hunks now anchor after
  dev's last migration (`20261022120300`'s `grant all on table public.document_realtime_rotation_queue`)
  instead of after `defer_district_retention_notice`. The `tests/sql/README.md` hunks now sit before dev's
  `## In CI` section, and commit 1 adds the `## Launchfix P5 …` heading. No migration, source or test logic differs.
- **4 (dropped):** superseded by dev's every-proof loop (§3).
- **4, 5 (new):** the rebase fix-ups (§5).

## 5. Fix-up commits

### `bc10196`: P5's proofs under dev's proof harness and one studio per owner

Files: `tests/sql/content_strikes_survive_deletion.sql`, `tests/sql/district_retention_reattribution.sql`,
`tests/sql/migrations_ordered_replay.sql`. These are test-only changes, and no check changes. They were needed for two reasons:

- Dev's `scripts/ci/sql-proof.sh` (#69, `03379df`) now requires a `failures | total` proof to print
  **every** check row. P5's proofs printed only the failing rows, so a green run failed with "printed 0 check
  rows (expected 42 rows)".
- P1's `20261022100300_one_studio_per_owner` refuses a second live studio per owner (`studio_exists`).
  The reattribution proof had one owner for districts A and B, and the replay proof one owner for A and D.
  Each second district now has its own owner. D's students are provisioned by D's owner, because
  `district_provisionable` requires the teacher to own or sit in the district.

```diff
diff --git a/tests/sql/content_strikes_survive_deletion.sql b/tests/sql/content_strikes_survive_deletion.sql
@@ -423,9 +423,9 @@
 -- ---------------------------------------------------------------------------
--- Report: failing checks, then `failures | total`
+-- Report: every check, then `failures | total`
 -- ---------------------------------------------------------------------------
-select name, ok, detail from t_results where not ok order by name;
+select name, ok, detail from t_results order by name;

 select count(*) filter (where not ok) as failures, count(*) as total from t_results;
diff --git a/tests/sql/district_retention_reattribution.sql b/tests/sql/district_retention_reattribution.sql
@@ -11,8 +11,9 @@
--- Cast: O owns district A (contract ended 17 days ago) and district B (no
--- contract end), and has no plan of their own (free: no roster). T teaches in
+-- Cast: O owns district A (contract ended 17 days ago) and has no plan of
+-- their own (free: no roster); Q owns district B (no contract end; one live
+-- studio per owner since 20261022100300). T teaches in
@@ -147,11 +148,11 @@
-from unnest(array['a2', 'a3']) as s;
+from unnest(array['a2', 'a3', 'a4']) as s;

 insert into public.studios (id, owner_id, name)
 values ('d5000000-0000-4000-8000-0000000005da', pg_temp.account ('a1'), 'District A'),
-       ('d5000000-0000-4000-8000-0000000005db', pg_temp.account ('a1'), 'District B'),
+       ('d5000000-0000-4000-8000-0000000005db', pg_temp.account ('a4'), 'District B'),
@@ -451,9 +452,9 @@
--- Report: failing checks, then `failures | total`
+-- Report: every check, then `failures | total`
-select n, check_name, detail from integrity_results where not passed order by n;
+select n, check_name, passed, detail from integrity_results order by n;
diff --git a/tests/sql/migrations_ordered_replay.sql b/tests/sql/migrations_ordered_replay.sql
@@ -63,18 +63,21 @@
--- O owns districts A and D (contracts ended 17 days ago) and has no plan of
--- their own, so a moved student's restore is carried over rather than done.
+-- O owns district A and Q owns district D (contracts ended 17 days ago; one
+-- live studio per owner since 20261022100300); neither has a plan of their
+-- own, so a moved student's restore is carried over rather than done.
 insert into auth.users (id, aud, role, email, raw_app_meta_data)
 select pg_temp.u ('a1'), 'authenticated', 'authenticated', 'replay-owner@example.invalid', '{}'::jsonb
 union all
+select pg_temp.u ('a2'), 'authenticated', 'authenticated', 'replay-owner-d@example.invalid', '{}'::jsonb
+union all
@@
-       ('d5200000-0000-4000-8000-0000000005dd', pg_temp.u ('a1'), 'Replay district D');
+       ('d5200000-0000-4000-8000-0000000005dd', pg_temp.u ('a2'), 'Replay district D');
@@ -82,7 +85,7 @@
-select pg_temp.roster (s), pg_temp.u ('a1'), pg_temp.u (s), 'Student ' || s, null, 'code', 'replay_' || s, now(),
+select pg_temp.roster (s), pg_temp.u (case when s = 'b1' then 'a1' else 'a2' end), pg_temp.u (s), 'Student ' || s, null, 'code', 'replay_' || s, now(),
@@ -236,9 +239,9 @@
--- Report: failing checks, then `failures | total`
+-- Report: every check, then `failures | total`
-select name, ok, detail from t_results where not ok order by name;
+select name, ok, detail from t_results order by name;
```

(Hunk context trimmed. The full patch is `git show bc10196`.)

### `d9c1fbf`: explicit service_role grant migration

Files: `supabase/migrations/20261022130200_district_retention_restores_service_role_grant.sql` (new) and
`scripts/apply-migrations.sql` (regenerated, +13 lines). See §6.

## 6. Service_role grants, the pepper seed and migrations

**Public tables P5 creates:** one, `public.district_retention_restores` (in `20261022130000`). That migration
already revokes everything from `public, anon, authenticated` and grants `all … to service_role` where it
creates the table. As instructed, the rebase pass also adds the grant in its own new migration, the way
`20261022120300` did. Nothing changes on any project: the grant is idempotent and anon and authenticated stay
revoked. Locally after applying it: service_role insert/select/update/delete = `t`; anon select = `f`;
authenticated select = `f`.

**Tables granted: `public.district_retention_restores` (only).**

Full SQL of `supabase/migrations/20261022130200_district_retention_restores_service_role_grant.sql`:

```sql
-- launchfix P5 rebase onto #69: district_retention_restores
-- (20261022130000) names service_role in a grant of its own, like every
-- public table since 20261022100000_explicit_service_role_grants.sql
-- (launch re-audit BL-3; tests/security/explicitServiceRoleGrants.test.ts).
--
-- 20261022130000 already grants it where it creates the table; this repeats
-- that grant in the rebase pass's own migration, as 20261022120300 did for
-- launchfix P4's table. No change on any project: the service role keeps the
-- access it has, and anon and authenticated stay revoked.

grant all on table public.district_retention_restores to service_role;
```

`tests/security/explicitServiceRoleGrants.test.ts`: **passed** (run on its own with
`tests/migrationRecoverability.test.ts`: 2 files, 34 tests passed; also passed in the full suite).
`tests/sql/explicit_grants.sql` (22 checks) passes too.

**Fake `content_strike_pepper` seed.** It already lived in P5's `supabase/seed.sql` (from `da0efd7`), so I
added nothing new; it stays unchanged. It is a `do $$ … $$` block that, only if no Vault secret named
`content_strike_pepper` exists, calls
`vault.create_secret('cleffy-local-dev-content-strike-pepper-not-a-secret', 'content_strike_pepper', 'Local development only (supabase/seed.sql)')`.

- How local and CI pick it up: `supabase/config.toml` has `[db.seed] enabled = true` and
  `sql_paths = ["./seed.sql"]`. `supabase start` (CI's `supabase-local` job), `npm run cloud:up` and
  `supabase db reset` apply it after the migrations. I checked locally after `supabase db reset`:
  one `content_strike_pepper` row in `vault.secrets`.
- The value appears only in `supabase/seed.sql` and `tests/moderation/contentStrikesSurviveDeletion.test.ts`.
  It is not in any migration, not in `scripts/apply-migrations.sql`, and not in any hosted config.
  Hosted projects never run `seed.sql`. If Supabase Preview branches ever run with seeding, they would get
  this obviously fake value; production would not. The "Supabase Preview" check is skipped on this PR.
- **Hosted production still needs Max to set the real pepper** (decision 42; the migration's DEPLOY note).
  I did not perform it and touched no hosted service.

**Migration order (P5's files, last in the tree):**

1. `20261022130000_district_retention_reattribution.sql`
2. `20261022130100_content_strikes_survive_deletion.sql`
3. `20261022130200_district_retention_restores_service_role_grant.sql` (new, rebase pass)

They come after P1's `2026102210xxxx`, P3's `2026102211xxxx` and P4's `2026102212xxxx`; the last before them
is `20261022120300_realtime_rotation_queue_service_role_grant.sql`. Local `supabase_migrations.schema_migrations`
ends at `20261022130200`.

**`npm run migrations:mirror`:** regenerated during conflict resolution and in fix-up 5, both committed.
Running it again on the final head changes nothing. **supabase-drift on `d9c1fbf`: success, and a real check**
(the token is set): "clean: this branch and the live project agree", with P5's three migrations listed as
"pending, will apply on merge".

## 7. SQL proofs (local stack, run the way CI does)

Method: `npm run cloud:up`, then `supabase db reset` on the final tree (all migrations plus seed). Then
CI's re-apply step (the cancel-link and P1 migrations, all applied cleanly). Then
`bash scripts/ci/sql-proof.sh "$DB_URL" <proof>` for each `tests/sql/*.sql` and
`supabase/sql-tests/sharing_access_control.sql`. This ran twice; the second pass was over a database the
first pass had already run on. Finally `npm run cloud:down`.

**48 of 48 proofs passed, both passes.** P5's proofs:

| Proof                                            | Result                                         |
| ------------------------------------------------ | ---------------------------------------------- |
| `tests/sql/district_retention_reattribution.sql` | **24/24 passed**                               |
| `tests/sql/content_strikes_survive_deletion.sql` | **42/42 passed** (with the fake pepper seeded) |
| `tests/sql/migrations_ordered_replay.sql`        | **8/8 passed**                                 |

All of them run in dev's every-proof loop (`for proof in tests/sql/*.sql supabase/sql-tests/sharing_access_control.sql`;
SKIP map empty). Before fix-up `bc10196` the reattribution and replay proofs stopped on `studio_exists`, and
the strike proof was rejected by the row-count rule, as described in §5.

All proofs:

```
account_deletion_pending 89 · annotation_payload_shape 57 · archived_student_password 13 · billing_double_charge 98
billing_export_claims 35 · cancel_link_consume_db_clock 36 · cancel_link_db_clock 21 · cancel_link_lifetime 57
cancel_link_read_db_clock 10 · cancel_link_save_after_insert 12 · cancel_link_tombstone_race 25 · cancel_link_tombstones 38
checkout_consents 25 · column_integrity 113 · content_moderation 99 · content_strikes_survive_deletion 42
cross_branch_integration 39 · deployment_config 34 · district_billing_canonical 12 · district_migrations_rerunnable 20
district_read_only_seats 68 · district_retention 28 · district_retention_reattribution 24 · district_seat_cap 192
district_seats 58 · district_student_scope 47 · edge_rate_limit_refund 10 · explicit_grants 22
guest_email_verification 53 · launch_checkout_fixes 46 · launch_consent 43 · migrations_ordered_replay 8
one_studio_per_owner 30 · qa3_cross_branch 12 · realtime_revocation_race 53 · realtime_revocation_rotation 88
share_link_errors 26 · storage_cleanup_and_thumbnail_cap 58 · storage_name_limits 32 · storage_quota 63
storage_quota_lock_and_cover_reuse 45 · storage_quota_lock_concurrency 26 · storage_thumbnail_concurrency 18
student_access_revocation 44 · student_claim_reservation 125 · superseded_studio_members 20 · support_inbound_lease 58
supabase/sql-tests/sharing_access_control 94
```

(each is "N checks passed", 0 failing)

## 8. Local checks (final tree `d9c1fbf`)

| Check                                                                            | Result                                                                                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run lint:check`                                                             | pass                                                                                                                                       |
| `npm run typecheck`                                                              | pass                                                                                                                                       |
| `npm run test`                                                                   | **pass: 240 files passed, 6 skipped (246); 3745 tests passed, 20 skipped (3765)**                                                          |
| `npm run build`                                                                  | pass                                                                                                                                       |
| `deno check --config supabase/functions/deno.json supabase/functions/*/index.ts` | pass (23 entry points; Deno 2.1.4, CI's version, downloaded to the session scratchpad because the container had no deno)                   |
| `npx prettier --check tests/sql/README.md`                                       | pass                                                                                                                                       |
| prettier on SQL                                                                  | not applicable: the repo's prettier has no SQL parser (`No parser could be inferred`), and the changed SQL keeps the files' existing style |

Note on vitest: two earlier full runs, made while the local Supabase stack, Edge Functions and Vite were
running on this 4-core container, each had 1–2 timing failures in tests P5 does not touch:
`tests/auth/turnstileField.test.tsx` (sign-up age screen) and `src/sync/syncEngine.test.ts` (backoff timing).
`turnstileField.test.tsx` passed 11/11 when run alone. With the stack stopped, the full suite passed (above).
CI's `checks` job runs the same suite (§10).

## 9. Decision 53(4) verification proof: FAILED, not committed to the PR branch

Per decision 66(2) this was verification only, and behaviour is unchanged. The proof
(`tests/sql/district_retention_late_student.sql`, same harness as `district_retention_reattribution.sql`)
ran against the local stack after the full migration set and seed. Result: **3 failing of 6**.

```
1 | control: the soft delete lists and archives e1, L's one student | t | got true
2 | e2 is provisioned into L after the soft delete, and is not on its list | t | got true
3 | the next retention run catches e2: listed for L's purge, archived and signed out like the others | f | got false
4 | control: the hard delete scrubs and deletes e1 and removes L | t | got true
5 | by L's hard delete at the latest, e2 is scrubbed and deleted too | f | got false
6 | no roster student attributed to L outlives its hard delete | f | got false
3 | 6
::error … did not pass (failures | total: 3 | 6; failing: 3 5 6)
```

Why, from the code (`20261022130000` `retention_district_run`): the `soft_delete` step lists the
district's students once (`insert into district_retention_students … from retention_district_students()`) and
sets `soft_deleted_at`. No later step lists again. `retention_district_next_step` returns nothing until
`soft_deleted_at + 7 days`, and the `hard_delete` step works only from that list before deleting the studio.
`managed_students.district_studio_id` has no foreign key (by design, 20261021120800), so the late student
keeps a dangling attribution, is never archived, and keeps their account and markings. Meanwhile
`district_provisionable` still lets the owner or a seated teacher provision into a district between its soft
and hard delete. A single session cannot interleave two transactions, so the proof models "while the soft
delete is running" as "after the soft delete's list snapshot, before the next run". To every later run, an
insert that commits after the soft delete's statement snapshot looks exactly like this case.

**Why it is not on the PR branch:** dev's every-proof loop runs every `tests/sql/*.sql` with no tolerated
failures. Committing it would turn `supabase-local` red on PR #66. Skipping it would need a ci.yml SKIP entry,
which this pass may not add. Decision 66 says "if it passes, keep it", so I kept the failing proof out of the
branch and preserved it here in full, so the follow-up PR that fixes the behaviour can add it as-is.

<details><summary>Full SQL of tests/sql/district_retention_late_student.sql (verification proof)</summary>

```sql
-- District retention: a student provisioned while the district's purge is
-- running (decision 53(4), verification only). LOCAL STACK or the dev branch
-- project only. Same harness as district_retention_reattribution.sql: one
-- transaction ending in ROLLBACK, time moved by the functions' p_now; the last
-- line is `failures | total` (scripts/ci/sql-proof.sh reads it), after any
-- failing checks.
--
-- The soft delete lists the district's students once (INSERT ... SELECT from
-- retention_district_students()), and the hard delete works from that list.
-- A student provisioned into the district while the soft delete runs -- a
-- roster insert that commits after the soft delete's statement snapshot -- is,
-- to every later run, the same as one provisioned just after it: in the
-- district, not on the list. A single session cannot interleave two
-- transactions, so this proof provisions the late student right after the soft
-- delete, before the next run, and asks whether that run catches them.
--
-- Cast: O owns district L (contract ended 17 days ago). e1 is provisioned for
-- L before the purge began (the control); e2 is provisioned for L after the
-- soft delete. Each has a mark on O's score.

begin;

create temp table integrity_results (
    n serial primary key,
    check_name text not null,
    passed boolean not null,
    detail text
);

grant all on integrity_results to public;

grant usage on sequence integrity_results_n_seq to public;

create function pg_temp.holds (p_name text, p_sql text) returns void language plpgsql as $$
declare
    v boolean;
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql into v;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (p_name, false, 'error: ' || v_state || ' ' || v_msg);
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, coalesce(v, false), 'got ' || coalesce(v::text, 'null'));
end;
$$;

create temp table ran (k text primary key, v jsonb);

grant all on ran to public;

-- e1, e2: roster ids d5300000...05e<n>, accounts d5300000...00e<n>, marks d5300000...a00e<n>.
create function pg_temp.roster (p text) returns uuid language sql immutable as $$
    select ('d5300000-0000-4000-8000-0000000005' || p)::uuid;
$$;

create function pg_temp.account (p text) returns uuid language sql immutable as $$
    select ('d5300000-0000-4000-8000-0000000000' || p)::uuid;
$$;

create function pg_temp.mark (p text) returns uuid language sql immutable as $$
    select ('d5300000-0000-4000-8000-0000000a00' || p)::uuid;
$$;

-- Gone as Delete student leaves them: no account, no roster row, the mark
-- scrubbed.
create function pg_temp.purged (p text) returns boolean language sql as $$
    select not exists (select 1 from auth.users where id = pg_temp.account (p))
       and not exists (select 1 from public.managed_students where id = pg_temp.roster (p))
       and coalesce((select deleted_at is not null and payload ->> 'text' = '' from public.annotations
                     where id = pg_temp.mark (p)), true);
$$;

create function pg_temp.archived (p text) returns boolean language sql as $$
    select archived_at is not null and access_revoked_at is not null
    from public.managed_students where id = pg_temp.roster (p);
$$;

create function pg_temp.listed (p text) returns boolean language sql as $$
    select exists (select 1 from public.district_retention_students
                   where studio_id = 'd5300000-0000-4000-8000-0000000005d1' and managed_student_id = pg_temp.roster (p));
$$;

create function pg_temp.provision (p text) returns void language sql as $$
    insert into public.managed_students
        (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at,
         district_studio_id)
    values (pg_temp.roster (p), pg_temp.account ('a1'), pg_temp.account (p), 'Student ' || p, null, 'code',
            'ls_' || p, now(), 'd5300000-0000-4000-8000-0000000005d1');
    insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
    values (pg_temp.mark (p), 'd5300000-0000-4000-8000-00000000d001', 0, 'text', '#112233',
            jsonb_build_object('x', 0.3, 'y', 0.3, 'size', 0.02, 'text', 'work of ' || p), pg_temp.account (p));
$$;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email, raw_app_meta_data)
select pg_temp.account ('a1'), 'authenticated', 'authenticated', 'ls-owner@example.invalid', '{}'::jsonb
union all
select pg_temp.account (s), 'authenticated', 'authenticated', 'ls-' || s || '@students.cleffy.app',
       '{"user_type":"student"}'::jsonb
from unnest(array['e1', 'e2']) as s;

insert into public.studios (id, owner_id, name)
values ('d5300000-0000-4000-8000-0000000005d1', pg_temp.account ('a1'), 'District L');

insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
values ('d5300000-0000-4000-8000-0000000005d1', now() - interval '17 days', 'admin', 'test');

insert into public.documents (id, owner_id, title, storage_path)
values ('d5300000-0000-4000-8000-00000000d001', pg_temp.account ('a1'), 'Score',
        'd5300000-0000-4000-8000-00000000d001/original.pdf');

select pg_temp.provision ('e1');

-- ===========================================================================
-- Notice, sent, soft delete
-- ===========================================================================
select public.retention_district_run (now());

select public.finish_district_retention_notice (id) from public.claim_district_retention_notices (20);

insert into ran select 'soft', public.retention_district_run (now() + interval '14 days 1 minute');

select pg_temp.holds (
    'control: the soft delete lists and archives e1, L''s one student',
    $q$select (select (v ->> 'soft_delete')::int = 1 and (v ->> 'students_archived')::int = 1 from ran where k = 'soft')
       and pg_temp.listed ('e1') and pg_temp.archived ('e1')$q$
);

-- ===========================================================================
-- e2 is provisioned for L while its purge is under way
-- ===========================================================================
select pg_temp.provision ('e2');

select pg_temp.holds (
    'e2 is provisioned into L after the soft delete, and is not on its list',
    $q$select exists (select 1 from public.managed_students
                      where id = pg_temp.roster ('e2') and district_studio_id = 'd5300000-0000-4000-8000-0000000005d1')
          and not pg_temp.listed ('e2')$q$
);

-- The next daily run, before the hard delete is due.
insert into ran select 'next', public.retention_district_run (now() + interval '15 days 1 minute');

select pg_temp.holds (
    'the next retention run catches e2: listed for L''s purge, archived and signed out like the others',
    $q$select pg_temp.listed ('e2') and coalesce(pg_temp.archived ('e2'), false)$q$
);

-- ===========================================================================
-- The hard delete
-- ===========================================================================
insert into ran select 'hard', public.retention_district_run (now() + interval '21 days 2 minutes');

select pg_temp.holds (
    'control: the hard delete scrubs and deletes e1 and removes L',
    $q$select (select (v ->> 'hard_delete')::int = 1 from ran where k = 'hard')
          and pg_temp.purged ('e1')
          and not exists (select 1 from public.studios where id = 'd5300000-0000-4000-8000-0000000005d1')$q$
);

select pg_temp.holds (
    'by L''s hard delete at the latest, e2 is scrubbed and deleted too',
    $q$select pg_temp.purged ('e2')$q$
);

select pg_temp.holds (
    'no roster student attributed to L outlives its hard delete',
    $q$select not exists (select 1 from public.managed_students
                          where district_studio_id = 'd5300000-0000-4000-8000-0000000005d1')$q$
);

-- ---------------------------------------------------------------------------
-- Report: every check, then `failures | total`
-- ---------------------------------------------------------------------------
select n, check_name, passed, detail from integrity_results order by n;

select count(*) filter (where not passed) as failures, count(*) as total from integrity_results;

rollback;
```

</details>

## 10. CI on the final head `d9c1fbf`

All green. Two workflow runs fired on the head: run `39803824215` (push) and run `39803834021` (pull_request).
Checked with a fresh fetch of PR #66's check runs and combined status after both runs completed.

| Check                                                                         | push run 39803824215       | pull_request run 39803834021                                                |
| ----------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------- |
| checks (audit, lint, typecheck, vitest, build)                                | success (job 119911604587) | success (job 119911635614)                                                  |
| supabase-local (re-apply step, store test, storage API test, every SQL proof) | success (job 119911605159) | success (job 119911634830)                                                  |
| supabase-drift                                                                | success (job 119911605110) | success (job 119911635997): "clean: this branch and the live project agree" |
| edge-functions-deno                                                           | success (job 119911604978) | success (job 119911635226)                                                  |
| omr-service                                                                   | success (job 119911605640) | success (job 119911635085)                                                  |

| Other check             | Result                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| Vercel (commit status)  | success: "Deployment has completed". **Not rate limited** on this head. No Vercel action taken. |
| Vercel Preview Comments | success (119911973375)                                                                          |
| Supabase Preview        | skipped (119911601705)                                                                          |

PR #66 after CI: open, **draft**, base `dev` (`6629a93b`), head `d9c1fbf`, mergeable_state `clean`. No fix-up
pushes were needed after the rebase push.

## 11. Follow-ups (out of scope for this pass; separate PR after all six launch-fix PRs merge)

1. **Decision 53(4) gap (§9):** students provisioned into a district after its soft delete are neither caught
   by the next run nor deleted by the hard delete. Possible fixes, for a decision: re-list (and archive) at
   each run while a cycle is soft-deleted, or re-select `retention_district_students()` at the hard delete;
   and/or refuse provisioning into a district with an open purge cycle. Then add the §9 proof.
2. **Overlapping district purges delete each other's restore record** (decision 47 residual). This stays a follow-up per
   decision 66(1) and the packet's "Out of scope". Not implemented.
3. `tests/sql/migrations_ordered_replay.sql` says it replays "every migration from 20261020160300 on". Its
   hand-written `\ir` list still ends at P5's own two migrations and does not include P1–P4's
   `2026102210xxxx`–`2026102212xxxx` migrations, nor `20261022130200`, which now sort before or after them.
   It still passes. Extending it to the full ordered set was left alone as out of scope for a rebase.
4. Other deferred minors and follow-ups from the earlier P5 rounds are unchanged by this pass.

## 12. Open questions

1. **Decision 53(4):** should the failing verification proof go in with the behaviour fix in the follow-up
   PR (my recommendation), or does Max want the gap fixed before PR #66 merges?
2. Migration `20261022130200` repeats a grant that `20261022130000` already makes. I added it because the
   instructions asked for a new 2026102213xxxx grant migration for every new public table. If Max prefers no
   redundant migration, it can be dropped in a fast-forward commit; the explicit-grants test passes either way.

3. **Handoff:** a later message in this session asked me to "send the handoff". The launch instructions say
   never to use send_message or message any other session, and never to send a handoff to Grok Bot or anyone
   else, with coordination through git only. I have not sent one. This report on
   `claude/launchfix-rebase-p5-report` is the handoff. If Max wants a message sent, please confirm explicitly
   and name the recipient.

## 13. Hosted steps left for Max (none performed)

- **Set the real Vault secret `content_strike_pepper` on production** (decision 42; DEPLOY note in
  `20261022130100`) before these migrations' account-deletion path runs there. Without it, deleting an account
  with strikes to key fails closed (55000).
- `retention_district_run()` stays unscheduled (20261021120700 and 20261022130000 DEPLOY notes). Scheduling it is Max's call.
- No hosted Supabase, Vercel or Stripe action was taken by this session, and no secret was printed.

## 14. Environment

Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (anthropic_cloud). Not Sandbox. The local Supabase stack
was used only for proofs, and `npm run cloud:down` was run at the end. No messages were sent to any other
session or agent; coordination is through git only.
