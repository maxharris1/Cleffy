# Cleffy launch-fix rebase: PR #73 (item 16) onto PR #72's final tip

**Status:** Complete

- PR: https://github.com/maxharris1/Cleffy/pull/73 (draft, base `mh/launchfix-followups`; still a draft, base unchanged, not merged)
- Starting head (`origin/mh/launchfix-item16`): `988377730174f80d76f4ab1c3142a65404b06bef`
- Target base (`origin/mh/launchfix-followups`, PR #72): `86d0e0f2d80f7b493653d43d800db0596519fdfa`
- New rebased head: `adbb7e8768173df6b7c3da50b0e8bd8eab408f2d`
- Environment: Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (confirmed via `get_session` at the start; `environment_kind: anthropic_cloud`), not Sandbox.

## Start-of-session verification

After `git fetch origin`:

| Ref                             | Expected                                   | Actual                                        |
| ------------------------------- | ------------------------------------------ | --------------------------------------------- |
| `origin/mh/launchfix-item16`    | `988377730174f80d76f4ab1c3142a65404b06bef` | `988377730174f80d76f4ab1c3142a65404b06bef` ✅ |
| `origin/mh/launchfix-followups` | `86d0e0f2d80f7b493653d43d800db0596519fdfa` | `86d0e0f2d80f7b493653d43d800db0596519fdfa` ✅ |

`c940b0ca68539e1acfaa0820351f0624b4bac72d` is an ancestor of both. Commit identity was set to `Max Harris <drumaxter@gmail.com>`. All 15 rebased commits have that author and committer.

## Rebase

```
git checkout -B mh/launchfix-item16 origin/mh/launchfix-item16
git rebase --onto 86d0e0f2d80f7b493653d43d800db0596519fdfa c940b0ca68539e1acfaa0820351f0624b4bac72d
```

**Conflicts: none.** The two ranges touch disjoint files. #72's `c940b0ca..86d0e0f2` (5 commits) changes only `src/sync/annotationStore.recovery.test.ts`, `src/sync/annotationStore.ts`, `src/sync/inkRecovery.ts`, `supabase/functions/_shared/accountDeletion.ts`, `supabase/functions/delete-account/index.ts` and `tests/account/accountDeletion.test.ts`. None of the 31 files in #73's range is one of them.

#72's changes are intact:

- `git diff 86d0e0f2..adbb7e87 -- <those 6 files>` is empty.
- `git diff 98837773 adbb7e87 --stat` is exactly those 6 files, 560 insertions and 88 deletions. That is identical to `git diff --stat c940b0ca..86d0e0f2`.

### `git range-diff c940b0ca68539e1acfaa0820351f0624b4bac72d..988377730174f80d76f4ab1c3142a65404b06bef 86d0e0f2d80f7b493653d43d800db0596519fdfa..adbb7e8768173df6b7c3da50b0e8bd8eab408f2d`

Every commit is `=`:

```
 1:  d4a56b4 =  1:  715c7e0 stripe-webhook: 503 and release the claim while the account's deletion is pending (item 16)
 2:  fd4cfd5 =  2:  373bf6d billing-cancel: while the account is being deleted, leave Stripe and the link alone but send the refund request (item 16)
 3:  cbe9b60 =  3:  46085fe queue writers: refuse guest email verification while the account's deletion is pending; pin the per-writer policy (item 16)
 4:  568c310 =  4:  8f3ce6d replay proof: replay every migration from 20261020160300 to the newest, and fail when the list falls behind (decision 70(8))
 5:  57960f9 =  5:  3575ead DEPLOY.md: launch-fix item 16 needs no migration; the four functions and the frontend to redeploy
 6:  ccf1f98 =  6:  1f8d7ed billing-cancel: the refund request is the same email on every send of one link (PR #73 fix 1)
 7:  f5ea3d3 =  7:  1df5625 SQL proof: stripe-webhook release and finish carry the delivery's own claimed_at (PR #73 fix 2)
 8:  fceff21 =  8:  31bfa6a billing-cancel: a deletion that begins after the check neither drops the refund nor spends the link for good (PR #73 fix 3a)
 9:  aa68f1f =  9:  de38b1c stripe-webhook: ask account_deletion_pending() again after Stripe's read, before the row and before the scores (PR #73 fix 3b)
10:  674ac35 = 10:  5740228 stripe-portal: no new portal session while the account is being deleted (PR #73 fix 4)
11:  e91a708 = 11:  59e497c DEPLOY.md: the half-deleted runbook notes Stripe's ~3-day retry window (PR #73 fix 5)
12:  4949d8c = 12:  dadd7e6 stripe-webhook: ask account_deletion_pending() again right before a district's customer link (PR #73 fix2 1)
13:  352002e = 13:  3f616aa billing-cancel: a link's refund request is kept with it, so a retry sends the same email whatever changed (PR #73 fix2 2)
14:  3595382 = 14:  766c626 cancel-link guard: un-spending needs the account's deletion pending, not just the matching setting (PR #73 fix2 3)
15:  9883777 = 15:  adbb7e8 billing-cancel: the refund request kept with a link is read with it, so a retry survives the link's removal (PR #73 fix3 1)
```

## Push

```
git push --force-with-lease=mh/launchfix-item16:988377730174f80d76f4ab1c3142a65404b06bef origin HEAD:mh/launchfix-item16
 + 9883777...adbb7e8 HEAD -> mh/launchfix-item16 (forced update)
```

The lease was accepted and the remote was at the pinned `988377730174f80d76f4ab1c3142a65404b06bef`. A re-fetch afterwards shows `origin/mh/launchfix-item16 = adbb7e8768173df6b7c3da50b0e8bd8eab408f2d`. There were no follow-up commits. No other branch was touched apart from this report branch (`claude/launchfix-rebase-item16-report`, one commit on top of `adbb7e87`).

## Migrations mirror and ordered replay

- `npm run migrations:mirror` on the rebased tree produced **no diff** to `scripts/apply-migrations.sql`. The mirror holds every `supabase/migrations/*.sql` except the two `*_imslp_works_catalog.sql` files, which the generator leaves out on purpose (they exceed the SQL editor's paste limit). That makes 134 of 136.
- `tests/sql/migrations_ordered_replay.sql` lists **64** migrations. They are identical, in order, to every file in `supabase/migrations/` from `20261020160300` to the newest (`20261022160000_cancel_link_release_for_deletion`). `diff` is empty.
- Neither #72's fix2–fix4 nor #73 adds a migration in this range, so nothing needed regenerating.

## Local checks (on `adbb7e87`, local Supabase stack only)

| Check                                                                                                               | Result                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm audit --omit=dev --audit-level=high`                                                                           | 0 vulnerabilities                                                                                                                                                                                           |
| `npm run lint:check`                                                                                                | pass                                                                                                                                                                                                        |
| `npm run typecheck`                                                                                                 | pass                                                                                                                                                                                                        |
| `npm run test` (vitest)                                                                                             | 246 files passed, 6 skipped; 3,902 tests passed, 22 skipped                                                                                                                                                 |
| `npm run build`                                                                                                     | pass                                                                                                                                                                                                        |
| `deno check --config supabase/functions/deno.json supabase/functions/*/index.ts` (Deno 2.1.4)                       | pass                                                                                                                                                                                                        |
| `supabase start` (CLI 2.121.0, CI's `-x` list): applies every migration                                             | pass                                                                                                                                                                                                        |
| Realtime running and today's `realtime.messages` partition exists                                                   | pass                                                                                                                                                                                                        |
| CI re-apply step (cancel-link five, then every migration ≥ `20261022100000`)                                        | pass, no errors                                                                                                                                                                                             |
| `tests/billing/cancelLinkStore.test.ts` against the local stack                                                     | 10/10                                                                                                                                                                                                       |
| `tests/storage/storageLifecycle.test.ts` against the local stack                                                    | 5/5                                                                                                                                                                                                         |
| Every SQL proof via `scripts/ci/sql-proof.sh` (`tests/sql/*.sql` + `supabase/sql-tests/sharing_access_control.sql`) | **69 proofs, 0 failing** (including `migrations_ordered_replay.sql` 10/10, `stripe_webhook_deletion_pending.sql` 24/24, `cancel_link_release_for_deletion.sql` 46/46, `account_deletion_pending.sql` 89/89) |

## CI on the final head `adbb7e8768173df6b7c3da50b0e8bd8eab408f2d`

I waited until every check run and commit status had finished. **All green**, and no red checks needed an exception: Vercel passed too.

| Check                   | Event / run id                                                        | Job id       | Conclusion                                      |
| ----------------------- | --------------------------------------------------------------------- | ------------ | ----------------------------------------------- |
| checks                  | push / 39893939840                                                    | 120219870809 | success                                         |
| supabase-local          | push / 39893939840                                                    | 120219870429 | success                                         |
| edge-functions-deno     | push / 39893939840                                                    | 120219870595 | success                                         |
| omr-service             | push / 39893939840                                                    | 120219870693 | success                                         |
| supabase-drift          | push / 39893939840                                                    | 120219870729 | success (not inert: no "INERT" warning)         |
| checks                  | pull_request / 39893943218                                            | 120219881678 | success                                         |
| supabase-local          | pull_request / 39893943218                                            | 120219882510 | success                                         |
| edge-functions-deno     | pull_request / 39893943218                                            | 120219881767 | success                                         |
| omr-service             | pull_request / 39893943218                                            | 120219881424 | success                                         |
| supabase-drift          | pull_request / 39893943218                                            | 120219881686 | success (not inert)                             |
| Vercel Preview Comments | check run 120220069046                                                |              | success                                         |
| Supabase Preview        | check run 120219865581                                                |              | skipped (integration's own skip; not a failure) |
| Vercel (commit status)  | https://vercel.com/maxs-projectsd/cleffy/EgwYA9TvjysVBVjqJfhXz9TK72aY |              | success ("Deployment has completed")            |

Combined commit status: `success`. The only annotations are GitHub's generic Node 20 deprecation and `ubuntu-latest` migration notices.

PR #73 afterwards: `draft=true`, base `mh/launchfix-followups` @ `86d0e0f2d80f7b493653d43d800db0596519fdfa`, head `adbb7e8768173df6b7c3da50b0e8bd8eab408f2d`.

## Open questions

- PR #73's description still says it stacks on `mh/launchfix-followups` @ `c940b0ca`, and quotes local check counts from `57960f9`. The rebase made those out of date. I left the description unchanged because it was out of scope. The operator may want it updated to `86d0e0f2` / `adbb7e87`.
- As the overrides required, no handoff was sent to anyone and no Codex review was requested. The operator relays.

## Done

`cleffy-launchfix-rebase-item16-done`: rebase of #73 onto `86d0e0f2` complete. The new head is `adbb7e8768173df6b7c3da50b0e8bd8eab408f2d` and CI is fully green.
