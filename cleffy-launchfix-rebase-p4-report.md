# Cleffy launch-fix rebase pass: PR #71 (P4) onto dev

**Status:** Complete

- Starting head (PR #71): `657d9cdb1d377dd78a7efd27886ec9f442a5be25` (confirmed equal to `origin/mh/launchfix-p4-realtime-revocation` before anything else)
- Rebased onto origin/dev: `7347225922991f3d0b1f28b80d277c28c1d629a2` (the #70 merge, unchanged at fetch time)
- NEW PR #71 head: `43295121f8271a24b4fd73aee4793bf621e0817d`
- Environment: Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (confirmed with this session's own `get_session`; `environment_kind` anthropic_cloud). Not Sandbox.

## Push

```
git push --force-with-lease=mh/launchfix-p4-realtime-revocation:657d9cdb1d377dd78a7efd27886ec9f442a5be25 origin HEAD:mh/launchfix-p4-realtime-revocation
 + 657d9cd...4329512 HEAD -> mh/launchfix-p4-realtime-revocation (forced update)
```

The lease held. That was the only push to the PR branch: the fix-up commit (below) was made locally before it, so I didn't need any later fast-forward push. PR #71 is still a draft with base `dev`. I left its title and body alone, requested no reviewers and posted no comments. I touched no other PR or branch. Every commit (author and committer) is Max Harris <drumaxter@gmail.com>.

## Conflicts and how I resolved them

`git rebase origin/dev` replayed P4's 7 commits. Three commits hit conflicts, all mechanical:

| Commit | File | Resolution |
|---|---|---|
| 1 `ed5c5af` -> `e9e3067` | `scripts/apply-migrations.sql` | Generated file. I regenerated it with `npm run migrations:mirror` (dev's migrations plus P4's, in filename order). I did not hand-merge it. |
| 1 `ed5c5af` -> `e9e3067` | `tests/sql/README.md` | Kept all of dev's text. Put P4's `realtime_revocation_rotation.sql` paragraph after dev's last proof paragraph (support_inbound) and before dev's `## In CI` section. |
| 4 `ce285d9` -> `38cae2e` | `tests/sql/README.md` | Same rule: P4's r1 paragraphs (`Since 20261022120100…`, `realtime_revocation_race.sql…`) go just before `## In CI`. I re-ran the mirror after every conflicted step. |
| 6 `4991da3` -> `418557e` | `tests/sql/README.md` | Same rule for P4's r2 paragraphs (archive recovery, H1/H2, "Both proofs need the Realtime container…"). |

**ViewerPage.tsx versus #68: no conflict.** Git merged it automatically. #68 changed the ink-hold and notice paths (InkSaveFailedNotice / SignedOutInkNotice wiring, held ink per account). P4 changes only the access re-check callback in `CloudViewer`, which now follows archive state even when the role is unchanged. The hunks don't overlap. I checked that P4's ViewerPage diff on top of dev is byte-identical to its diff on the old base `47e9b38f`, so both behaviours are in place unchanged. `src/features/viewer/ViewerPage.test.tsx` also merged automatically: dev's #68 tests plus P4's "follows the score being archived and then restored while the role stays the same".

**ViewerPage.test.tsx result:** `npx vitest run src/features/viewer/ViewerPage.test.tsx`: 1 file, **59/59 passed**.

### ci.yml relative to dev

**`git diff origin/dev 43295121 -- .github` is empty.** ci.yml on the new head is exactly dev's: P1's every-proof `supabase-local` job plus P3's `edge-functions-deno` job. P4 never changed ci.yml (its old series doesn't touch `.github`), so nothing came from an old P4 ci.yml and nothing needed adding. Dev's SQL-proof step loops over every `tests/sql/*.sql` plus `supabase/sql-tests/sharing_access_control.sql`, and its SKIP map is empty. P4's `tests/sql/realtime_revocation_rotation.sql` and `tests/sql/realtime_revocation_race.sql` therefore run in that loop just by existing, as does `tests/sql/district_read_only_seats.sql`. The job already starts Realtime and fails by name unless today's `realtime.messages` partition exists. The CI log on the new head shows all three running and passing there (see CI below). Decision 55's "realtime proofs must run under #69's blocking proof list" is met with no ci.yml change.

## Fix-up commit

One commit on top of the rebased series. It was committed before the single lease push and is part of that push:

- `43295121f8271a24b4fd73aee4793bf621e0817d`: "launchfix P4 rebase: grant service_role the rotation queue explicitly"
  - New `supabase/migrations/20261022120300_realtime_rotation_queue_service_role_grant.sql`: `grant all on table public.document_realtime_rotation_queue to service_role;`
  - `scripts/apply-migrations.sql` (mirror regenerated)
  - Why: #69 (P1) added `tests/security/explicitServiceRoleGrants.test.ts` (BL-3). It requires every public table a migration creates to have an explicit service_role grant. P4's queue table (created in `20261022120000`) predates that rule on this branch, so after the rebase `npm test` failed with `document_realtime_rotation_queue (created in 20261022120000_realtime_revocation_rotation.sql)`. The fix follows #70's style for its own new tables. anon and authenticated stay revoked: proof checks 35/35b still pass, and no client role reaches the queue. It changes nothing under today's default ACL, so it is a rebase-integration fix with no behaviour change. I added a new migration instead of editing `20261022120000` so the already-reviewed migration stays byte-for-byte unchanged.

## Range-diff (`git range-diff origin/dev 657d9cdb1d377dd78a7efd27886ec9f442a5be25 43295121`)

```
1:  ed5c5af ! 1:  e9e3067 launchfix P4: rotate a score's realtime topics when a member loses access
2:  3af3b7a = 2:  c63d29b launchfix P4: unit-test the client through a membership-change rotation
3:  a9e98c9 = 3:  99b581e launchfix P4: live-test revocation rotation against the local Realtime server
4:  ce285d9 ! 4:  38cae2e launchfix P4 fix 1: close the revocation races, no realtime on archived scores
5:  ae770d6 = 5:  06b84c3 launchfix P4 fix 1: leave old topics on a rotation hint; jitter and coalesce the follow-up
6:  4991da3 ! 6:  418557e launchfix P4 fix 2: archived scores answer "archived", redemption locks the roster first
7:  657d9cd = 7:  5cb534f launchfix P4 fix 2: an archived score's open viewer rejoins by itself on restore
-:  ------- > 8:  4329512 launchfix P4 rebase: grant service_role the rotation queue explicitly
```

What the `!` entries contain:

- **1, 4, 6, content:** only the hunk context in `scripts/apply-migrations.sql` (P4's mirror append now follows P3's last migration, not P1's) and in `tests/sql/README.md` (P4's paragraphs now sit before dev's `## In CI` section, which needs one blank separator line). P4's own added lines are unchanged, and so are all P4 migrations, proofs, client code and tests.
- **6, commit message only (unintended):** the rebased `418557e` lost one line of its message, `#71, decision 55):`. It followed "New migration 20261022120200_realtime_archive_recovery (Codex round 2 on". I continued that conflicted step with `GIT_EDITOR=true`, and git's default comment cleanup stripped the line because it starts with `#`. The commit's tree is unaffected. Restoring the line would need a second non-fast-forward push, which the rules don't allow, so I left it. See open questions.

## Migration order (P4's files, final)

After P1's `2026102210xxxx` and P3's `2026102211xxxx` (last on dev: `20261022110800_student_code_reset_quarantine.sql`):

1. `20261022120000_realtime_revocation_rotation.sql`
2. `20261022120100_realtime_revocation_races.sql`
3. `20261022120200_realtime_archive_recovery.sql`
4. `20261022120300_realtime_rotation_queue_service_role_grant.sql` (rebase fix-up)

`npm run migrations:mirror`: I regenerated and committed it at each conflicted step and in the fix-up. Re-running it on the final head changes nothing. **supabase-drift** on the new head: success in both runs, with the token-backed check active (not the inert warning). The log ends "clean: this branch and the live project agree."

## SQL proofs (local stack only)

How I ran them, the way CI does: `npm run cloud:up` (local Supabase, CLI 2.121.0, the version CI pins), then `supabase db reset --local` once the fix-up existed, so every migration applied fresh, in order, including all four P4 files. Then the CI steps against the LOCAL `DB_URL`: the Realtime container is up and today's partition exists, the P1/cancel-link re-apply list applies again cleanly, then `bash scripts/ci/sql-proof.sh "$DB_URL" <proof>` for every `tests/sql/*.sql` and `supabase/sql-tests/sharing_access_control.sql`. **All 45 proofs passed.** None failed.

Called out:

- **`realtime_revocation_rotation.sql`: 88/88 passed**
- **`realtime_revocation_race.sql`: 53/53 passed.** This includes the 2-session `redeem_share_link` lock-order proof:
  - H2a: the hard delete waits to delete the student's account
  - H2b: holding the student's roster row
  - H2c: the redemption waits on the roster row, before it touches the membership
  - H2d: the hard delete goes through, no deadlock
  - H2e: the redemption then fails on the deleted account, not on a deadlock
  - H2f: nothing is left of the student
  - H1b/H1c, D1/D2 and C1 also pass.
- **`district_read_only_seats.sql`: 68/68 passed.** The harness prints only failing rows, so I ran a scratch copy, changed only in its report filter and rolled back as usual, to print checks 49/59/60/62:
  - 49 "the payment's own reconcile clears the record and tells b6's app, without rotating again": t
  - 59 "that join still appears in presence": t
  - 60 "a join whose token expires before the deadline keeps live ink": t
  - 62 "b1's roster student (no seat) keeps live ink on the shared score": t
- The other proofs all passed too, including:
  - sharing_access_control 94
  - content_moderation 99
  - explicit_grants 22
  - student_access_revocation 44
  - storage_* and the P3 proofs

All three named proofs also run and pass in CI's every-proof loop on the new head. From the supabase-local job log (job 119891914388): `OK tests/sql/realtime_revocation_race.sql: 53 checks passed`, `OK tests/sql/realtime_revocation_rotation.sql: 88 checks passed`, `OK tests/sql/district_read_only_seats.sql: 68 checks passed`.

Also against the local stack:

- CI's `tests/billing/cancelLinkStore.test.ts`: 8/8
- `tests/storage/storageLifecycle.test.ts`: 5/5
- P4's `tests/live/takedownRealtime.live.test.ts` against the local Realtime server: 4/4

I ran `npm run cloud:down` at the end and the stack is stopped.

## Local checks (final head 43295121)

- `npm run lint:check`: pass
- `npm run typecheck`: pass
- `npm test`: **238 files passed, 6 skipped; 3718 tests passed, 20 skipped, 0 failed.** I ran it in a clean scratch worktree of the final head with no `.env.local`, as on the CI runner.
  - Runs in the main checkout while `cloud:up` was running showed 2 failures each time, from different tests each run:
    - `tests/auth/turnstileField.test.tsx` (passes alone)
    - `src/sync/syncEngine.test.ts` backoff test (it logged "permission denied for table annotation_snapshots": the generated `.env.local` points the unit run at the live local stack)
    - `tests/security/explicitServiceRoleGrants.test.ts`, the only real failure, fixed by the fix-up above
  - P4 touches none of turnstileField or syncEngine. CI's `checks` job ran `npm run test` green.
- `npm run build`: pass
- `deno check --config supabase/functions/deno.json supabase/functions/*/index.ts`: pass, all 23 entry points. Deno v2.1.4, the version CI pins, downloaded into the session scratchpad.
- prettier:
  - `npx prettier --check tests/sql/README.md src/features/viewer/ViewerPage.tsx src/features/viewer/ViewerPage.test.tsx`: clean
  - The `.sql` files (mirror, new migration) have no Prettier parser, which matches the repo's existing SQL.

## CI on 43295121

Workflow "CI", two runs: push run `39798421645` and pull_request run `39798428931`.

| Check | pull_request run 39798428931 | push run 39798421645 |
|---|---|---|
| checks (audit, lint, typecheck, test, build) | success (job 119891914815) | every step success, "Complete job" success (job 119891889587)\* |
| supabase-local (incl. every SQL proof) | success (job 119891914388) | success (job 119891890275) |
| edge-functions-deno | success (job 119891915064) | every step success, "Complete job" success (job 119891890097)\* |
| omr-service | success (job 119891914189) | success (job 119891889762) |
| supabase-drift | success (job 119891914793), "clean" | success (job 119891889400) |

\* When I last read these two push-run jobs, every step had concluded success, through "Complete job" at 14:49:24 and 14:45:24 UTC, but the API still showed the job status as `in_progress`. That looks like GitHub status lag. Their twins in the pull_request run had already concluded success.

Other checks:

- Vercel (commit status): **success**, "Deployment has completed". No "Deployment rate limited" this time. I took no action on Vercel.
- Vercel Preview Comments: success
- Supabase Preview: skipped (integration, no action taken)

## Follow-ups (out of scope, after all six launch-fix PRs merge; not implemented)

- Superseded studios and archive rotation (superseded studios need their own rotation)
- Recheck on focus and on reconnect
- Test row cleanup
- The #71 body: still says "Base: dev @ 47e9b38f" and "`ci.yml` is not touched here". The second is still true. It doesn't mention the new `20261022120300` grant migration.
- Server-side eviction of malicious sockets (decision 55: accepted post-launch follow-up)

## Open questions

1. The commit message of `418557e` (rebased `4991da3`) lost the line `#71, decision 55):` during the rebase (git comment-stripping, see range-diff). Its content is unaffected. Restoring it needs another history rewrite of the PR branch, which this pass's rules don't allow. Max: is it acceptable as is, or should a later pass restore it, for example when the branch is squash-merged?
2. The fix-up grant migration `20261022120300` is new code that review hasn't seen (one `grant` statement, no behaviour change under today's ACL). Should Codex re-check it before the merge?

## Hosted steps left for Max (I performed none)

- None needed for this rebase. When #71 merges into dev, Supabase's integration applies P4's four migrations as usual. I didn't touch hosted Supabase (prod or dev), Vercel or Stripe.
