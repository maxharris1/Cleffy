# Launchfix P5 report: district retention safety and copyright strikes

## Status

The draft PR is open and CI is fully green on its head. The local stack has been stopped (`npm run cloud:down`).

- **PR:** #66, https://github.com/maxharris1/Cleffy/pull/66. It is a draft from `mh/launchfix-p5-district-retention` into `dev`, titled "launchfix P5: recheck district attribution before hard delete; keep copyright strikes after account deletion". No reviewers were requested.
- **Base SHA:** `47e9b38f2dba36fdce852c80948245da344bcc20`. This is dev at the packet's base, and `origin/dev` had not moved when I checked again at the end.
- **Final PR head SHA:** `00f48a658ef691398599ec12b2fea27cde743389`.
- **Mergeable state:** clean.
- **This report:** committed only on `claude/launchfix-p5-report`, which was cut from the PR head. /workspace is not available in this environment, so the report is not there.

## Environment

- This ran in the **Cleffy cloud environment** (`env_01WAd3yiz3qpSnsofpyEwCh2`, `anthropic_cloud`), not Sandbox. The environment ID comes from the session's `get_session`.
- The session was launched from a fresh checkout of origin/dev at 47e9b38f. The branch was then cut with `git checkout -B mh/launchfix-p5-district-retention origin/dev`. Per your note, that satisfies hard rule 2.
- The session's own default outcome branch was `claude/launchfix-p5-district-retention-d9vzda`. I did not use it. Per your instructions, I pushed only to `mh/launchfix-p5-district-retention` and `claude/launchfix-p5-report`.
- Everything ran against the local stack only (PostgreSQL 17.11).
- I did not touch hosted Supabase or Stripe, did not print any secret, and did not message any other session.

## Commits

All commits are authored as Max Harris <drumaxter@gmail.com>.

| SHA                | Summary                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `1372669`          | District retention: recheck attribution before the hard delete (migration 20261022130000, proof, CI guards, README, mirror) |
| `00f48a6`          | Content moderation: copyright strikes survive account deletion (migration 20261022130100, proof, CI guards, README, mirror) |
| report branch only | Adds this report                                                                                                            |

## What changed

### 1. The hard delete rechecks attribution (Codex A4)

These changes are in `20261022130000_district_retention_reattribution.sql`.

**`retention_district_run()`**

- Redefined with `create or replace` and the same signature. Only the hard-delete loop changes.
- The loop takes the same row lock as before: `select … from managed_students m where m.id = … for update of m`.
- Under that lock it now also requires:
    - `m.district_studio_id = candidate.studio_id`, which is the scope `retention_district_students()` uses since 120800;
    - `m.student_user_id = v_student.student_user_id`.
- A student that doesn't match is:
    - skipped (not scrubbed, not deleted);
    - removed from `district_retention_students`;
    - logged once per hard delete as `skipped_reattributed`, with `{students_skipped, students:[{managed_student_id, student_user_id, was_archived, now_district_studio_id}], by:'retention_district_run'}`.
- The archived and `user_type='student'` recheck is unchanged.
- The `hard_deleted` log counts are unchanged.
- The run's result gains `students_skipped_reattributed`.

**`admin_set_student_district()`**

- After the update, under the roster row lock it already takes, it deletes every `district_retention_students` entry for that student whose studio differs from the new `p_studio`.
- Each dropped entry is logged as `skipped_reattributed` under the studio the student left, with `managed_student_id`, `student_user_id`, `was_archived`, `to`, `actor` and `by:'admin_set_student_district'`.
- If an admin re-confirms the same district, that entry stays.
- The existing `attribution_changed` log row is unchanged.

**Log constraint and privileges**

- `district_retention_log_step_check` is rebuilt to also allow `'skipped_reattributed'`. The drop and add happen inside a DO block, so the migration can be rerun; I applied it three times locally.
- Both functions are revoked from public, anon and authenticated, and granted to service_role.

**Unchanged on purpose**

- Decision 1 (soft then hard delete, with logged counts).
- Decisions 8–10: nothing here attributes a student.
- Decisions 21–22.
- Nothing is scheduled.

### 2. Strikes survive account deletion (SF-15)

These changes are in `20261022130100_content_strikes_survive_deletion.sql`.

- **(a) Foreign key.** `content_strikes.user_id` is now nullable, and `content_strikes_user_id_fkey` is `ON DELETE SET NULL`. The swap is guarded on `confdeltype`, so the migration can be rerun.
- **(b) `subject_key`.** A new column holding hex `sha256(lower(email))`, with no HMAC, computed by `content_strike_subject_key(text)`.
    - It is set by a `BEFORE INSERT` security-definer trigger that reads `auth.users` and overrides any value the insert supplied.
    - The trigger is insert-only, so the foreign key's `SET NULL` update keeps the key.
    - Existing strikes are backfilled from `auth.users`.
    - Guests have no address, so they get no key.
    - A partial index covers orphaned keys.
- **(c) `active_content_strikes()`.** It also counts strikes with `user_id is null` whose `subject_key` equals the digest of the user's current address. The 12-month window and the voided-strike rule are unchanged.
- **(d) Takedowns.** `content_takedowns.uploader_id` stays `ON DELETE SET NULL`; it is not touched.
- **Grants.** No table grant is added. P1 is not merged yet (dev is still at 47e9b38f), so `content_strikes` keeps 20261020150000's privileges until P1 lands. Function privileges were reset: count is service-role only, and the helper and trigger function are not callable by any client.
- **Other delete paths.** I checked `_shared/accountDeletion.ts`, delete-account, `retention_purge_archived_students`, `retention_purge_stale_guests` and the district hard delete. Every one of them removes accounts with `delete from auth.users`, and nothing deletes `content_strikes` or `content_takedowns` directly. The foreign key change therefore covers all of them.

### 3. Copy

No copy change.

- `copyrightPolicy.ts` ("Repeat infringers") says strikes count within 12 months and are withdrawn on a successful counter-notice. It does not say they end with the account.
- `privacyPolicy.ts` does not say strikes or reports end with the account either. Its "Deleting your account" list doesn't mention strikes.
- No version bump was needed, and no legalVersions test is affected.

There is still something for counsel; see the open questions.

## Files touched

- `supabase/migrations/20261022130000_district_retention_reattribution.sql` (new)
- `supabase/migrations/20261022130100_content_strikes_survive_deletion.sql` (new)
- `tests/sql/district_retention_reattribution.sql` (new proof)
- `tests/sql/content_strikes_survive_deletion.sql` (new proof)
- `tests/legal/districtReattribution.test.ts` (new; CI-side static guards)
- `tests/moderation/contentStrikesSurviveDeletion.test.ts` (new; CI-side static guards)
- `tests/sql/README.md` (two paragraphs appended at the end)
- `scripts/apply-migrations.sql` (regenerated with `npm run migrations:mirror`; not hand-edited)

I did not touch `ci.yml` or any existing migration.

## Local checks (before the push)

**Repo checks**

| Check                | Result                                                                         |
| -------------------- | ------------------------------------------------------------------------------ |
| `npm run lint:check` | pass                                                                           |
| `npm run typecheck`  | pass                                                                           |
| `npm run build`      | pass                                                                           |
| `npm run test`       | 221 files passed, 2 failed, 5 skipped; 3397 tests passed, 2 failed, 13 skipped |
| prettier             | `--write` run on the changed TS and MD files; no changes needed after          |

Notes on the two test failures and prettier:

- **`tests/auth/turnstileField.test.tsx`:** failed once under full-suite load, then passed on rerun.
- **`src/sync/syncEngine.test.ts` ("backs off exponentially with jitter, capped at a minute"):** fails every time in this container, including on untouched dev at 47e9b38f (checked with my changes stashed).
    - It passes in GitHub CI: dev's own run 39717432722 and both runs on this PR.
    - My diff doesn't touch `src/`, so this is an environment-only failure, not caused by this PR. I left it alone.
    - Strictly, "push only when all pass" wasn't met locally because of this pre-existing container failure. I pushed because the same failure happens on dev here and CI is the gate.
- **Prettier and SQL:** prettier has no SQL parser in this repo ("No parser could be inferred"), so the `.sql` files are not prettier-formatted. Existing SQL files aren't either.

The five related unit test files (the two new ones, `districtRetention`, `contentReports` and `migrationRecoverability`) passed 149/149.

**SQL proofs** (local stack, run through `scripts/ci/sql-proof.sh` where the proof uses the `failures | total` format)

| Proof                                        | Result    |
| -------------------------------------------- | --------- |
| `district_retention_reattribution.sql` (new) | **16/16** |
| `content_strikes_survive_deletion.sql` (new) | **22/22** |
| `district_retention.sql`                     | 28/28     |
| `district_student_scope.sql`                 | 47/47     |
| `district_migrations_rerunnable.sql`         | 20/20     |
| `district_billing_canonical.sql`             | 12/12     |
| `launch_consent.sql`                         | 43/43     |
| `content_moderation.sql`                     | 99/99     |

Negative controls, run against the old definitions inside a rolled-back transaction:

- **Re-attribution proof** against 20261021120700's `retention_district_run` and 20261021120800's `admin_set_student_district`: 9 of the 16 checks fail. r1, r2 and r3 are deleted, and so is the unrelated account x, which a stale list entry named.
- **Strikes proof** against the cascading foreign key and 20261020150000's count, with no trigger (rerun section left out): 8 of 18 checks fail.

What the proofs cover:

- **Re-attribution:**
    - students moved under A to a private roster or to B survive with their markings;
    - one moved by the old correction path, which left the purge list alone, survives because the hard delete rechecks;
    - a stale list entry whose account differs from the roster row deletes neither account;
    - the log rows are correct;
    - controls: an unchanged student and a student re-confirmed for A are still scrubbed and deleted;
    - grants are unchanged.
- **Strikes:**
    - the key equals `sha256(lower(email))`, and a forged key is replaced;
    - deleting the account keeps the strike with `user_id` null, and the takedown stays with uploader null;
    - a mixed-case re-registration inherits the active strike, and `apply_content_takedown` and `moderation_takedowns` show the inherited count;
    - a withdrawn strike, a 13-month-old strike and another address don't count;
    - an address freed by an email change hands nothing on;
    - the backfill fills an existing strike, and two reruns via `\ir` work;
    - no client access.

## CI on the final head (00f48a6)

There were two runs: **39728151111** (push) and **39728183201** (pull_request).

| Check                                                                          | Result                                  |
| ------------------------------------------------------------------------------ | --------------------------------------- |
| checks (lint, typecheck, full vitest, build)                                   | success, both runs                      |
| supabase-local (`supabase start` applies every migration fresh, mine included) | success, both runs                      |
| supabase-drift                                                                 | success, both runs                      |
| omr-service                                                                    | success, both runs                      |
| Vercel Preview Comments                                                        | success                                 |
| Supabase Preview                                                               | skipped (the integration's own setting) |

CI does not run either new SQL proof yet. `supabase-local` runs a fixed list of proofs, and P1 adds the glob over `tests/sql/*.sql`. Both new proofs end with a `failures | total` line, so `sql-proof.sh` reads them once the glob lands. The existing `district_*` proofs print `ALL n CHECKS PASSED` instead, which `sql-proof.sh` will not parse; that's P1's to handle.

## Deviations and judgement calls

1. **Strikes are inherited only from deleted accounts.** `active_content_strikes()` counts a matching `subject_key` only when the strike's `user_id is null`, meaning its account is gone. The packet says "also counts strikes whose subject_key matches". Without this restriction, a live user who changes their address would hand their strikes to whoever registers the old one, while still being counted for them by `user_id`. A re-registered address of a deleted account still inherits, as the packet wants.
2. **The key follows the address at strike time.** It is not updated when the account changes email. A strike counts by `user_id` while the account exists; after deletion it matches the address the account had when the strike was given. The backfill, for strikes from before this migration, uses the address at migration time.
3. **One log step name for both cases.** The admin-side drop (packet item 1c) is logged with the same step `skipped_reattributed`, under the studio whose purge list the student left. `by` tells it apart from the hard delete's skip, so there is no second new step name.
4. **The stale-account case is also a skip.** A list entry whose `student_user_id` differs from the roster row's is skipped and logged as `skipped_reattributed`, as packet item 1a/b asks. Before the fix, the old loop would have deleted the account the list named, even if it belonged to someone else.
5. **No un-archiving.** A skipped or dropped student stays archived, with access revoked, as the soft delete left them. The packet lists skip, remove and log, not restore. `was_archived` is logged so a human can decide. See open question 1.
6. **The constraint rebuild is in a DO block.** This follows the repo's rerunnability guard style (`tests/billing/districtMigrationsRerunnable.test.ts`). I did not add my migrations to that test's list or to `district_migrations_rerunnable.sql`, to stay out of files other packets may touch. My own CI test applies the same statement rules to both new migrations instead.

## Open questions

1. **Should a re-attributed student be un-archived?** The soft delete archived the student and revoked their tokens because A's contract ended.
    - Today, after an admin correction or a hard-delete skip, they stay archived. The teacher can restore them, and otherwise the 12-month archived-student purge applies from `archived_at`.
    - There is also an inconsistency: once admin_set_student_district drops an entry, a later cancellation (contract renewed) no longer un-archives that student, because they are no longer on the list.
    - Option: un-archive on drop or skip when `not was_archived`, mirroring the cancel path.
    - This changes access, so it's your call.
2. **Replaying 20261021120800 can fail once a `skipped_reattributed` row exists.** 120800 drops and re-adds `district_retention_log_step_check` with its own 8-step list. Replaying it in order over a database that already holds such a row would fail on its `add constraint`. This is inherent to adding any new step value, and it can't be avoided without editing 120800.
    - It only bites once a re-attribution has happened after `retention-district` is scheduled.
    - A recovery replay should skip 120800, or rerun 130000 first.
    - Should DEPLOY.md's recovery section say so?
3. **Counsel: the email digest kept after deletion.** `sha256(lower(email))` is pseudonymous personal data, kept after the account is deleted to enforce the repeat-infringer policy. The privacy policy doesn't say so. No sentence currently claims strikes end with the account, so per the packet I changed nothing.
    - Proposed addition to `privacyPolicy.ts`, "Deleting your account" (keep `-draft`): _"If a score you uploaded was taken down for copyright infringement, we keep a record of the strike, and a one-way digest of your email address, for as long as the strike counts under our Copyright and Content Policy, so that the repeat-infringer policy still applies if the address is used again."_
    - The existing placeholder ("Counsel to set how long reports about content … are kept …") already flags retention of these records.
4. **Strikes past the 12-month window.** They stay forever, as they did before for live accounts. Should they be purged after the window, especially orphaned ones with a key? This is counsel's retention call.
5. **The P1 dependency.** P1 isn't merged, so this PR adds no `content_strikes` table grant. Once P1 merges, please check that its explicit grants still give service_role what it needs on the new `subject_key` column; table-level grants cover new columns. No action is expected.

## Hosted steps left for Max (I performed none)

1. After P1–P4, merge #66 into dev. Supabase's GitHub integration applies `20261022130000` and `20261022130100` to the hosted dev and prod projects when it deploys.
2. Only after #66 is on prod, and after reading `retention_district_dry_run()`'s counts, schedule the district purge with `select cron.schedule ('retention-district', '57 3 * * *', $$select public.retention_district_run ()$$);`. Also set the vault secrets `district_notice_url` and `district_notice_secret` (unchanged from 120700's DEPLOY note).
3. Optionally, on prod after the deploy: `select count(*) from public.content_strikes where subject_key is null and user_id is not null;` should return 0. A non-zero count means accounts with no email, which is expected for guests only.

## Expected conflicts with the other launchfix PRs

- **`scripts/apply-migrations.sql`:** every launchfix PR regenerates it, so it will conflict. Resolve by rerunning `npm run migrations:mirror` after merging. Never hand-merge it.
- **`tests/sql/README.md`:** I appended two paragraphs at the end. If another packet also appends there, it's a trivial textual conflict; keep both.
- **P1 (seat caps, explicit grants, CI glob over SQL proofs):**
    - If P1 grants `content_strikes` in 20261022100000+, it sorts before 130100. The foreign key and column changes don't touch grants, so I expect no semantic conflict.
    - P1's glob will start running both new proofs in CI. They use the `failures | total` format and set up their own fixtures.
    - If P1 changes `district_retention_log_step_check` or redefines `retention_district_run` / `admin_set_student_district`, the later migration (mine, 130000) wins. That would need a manual merge of the step list or function body. I don't expect it, since P1's scope is seat caps.
- **P3 / P4:** no overlap expected. P4 is realtime and neither migration of mine touches realtime. P3's scope isn't visible from here, so it is unknown.
- **Any packet that redefines `active_content_strikes()`, `retention_district_run()` or `admin_set_student_district()`:** mine sorts last (130000+), so I would win silently. Worth a check during merge review.
