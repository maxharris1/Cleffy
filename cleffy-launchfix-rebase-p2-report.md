# Cleffy launch-fix rebase pass: PR #68 (P2) onto dev after #69

**Status:** Complete

- Starting head: `0ca6c92ec186de1bc0038d4e65cd81f638ee221f` (0ca6c92e). Verified that `origin/mh/launchfix-p2-client-safety` was exactly this SHA before rebasing.
- Rebased onto origin/dev at `937c915ba45184455a46fdbd16940ceca964b34b` (the #69 merge; dev had not moved).
- **New PR #68 head: `7c9c350484a6bb9e5983f743e97504306787488e` (7c9c3504)**
- CI on 7c9c3504 is all green (details below). PR #68 is still a draft with base `dev`. Its title and body were not edited.

## Environment

Ran in the Cleffy cloud environment (`env_01WAd3yiz3qpSnsofpyEwCh2`, `environment_kind: anthropic_cloud`), confirmed with the session's own `get_session` at the start. This is not Sandbox. No other session was messaged and no handoff was sent.

## Push

```
git push --force-with-lease=mh/launchfix-p2-client-safety:0ca6c92ec186de1bc0038d4e65cd81f638ee221f origin HEAD:mh/launchfix-p2-client-safety
 + 0ca6c92...7c9c350 HEAD -> mh/launchfix-p2-client-safety (forced update)
```

The lease held. That was the only non-fast-forward push. No fix-up commits or other pushes were made to the PR branch. Commit identity: all 10 rebased commits have author and committer Max Harris <drumaxter@gmail.com>.

## Conflicts

There were none. `git rebase origin/dev` applied all 10 commits cleanly.

- Only one file is changed on both sides: `src/features/library/documentsService.ts`.
    - P2 adds an import of `forgetDocInk` and one call in `purgeLocalDocument`.
    - P1 changed other parts of the file, and git merged the two automatically.
    - The rebased file is dev's file plus exactly P2's three lines (verified by diffing the old and new file pairs).
- `.github/workflows/ci.yml`: P2 never touched it, so dev's (P1's) ci.yml is kept unchanged and nothing was re-added. P2 does not need any CI lines.
- No files were edited by hand to resolve anything.

## Range-diff (`git range-diff origin/dev 0ca6c92ec186de1bc0038d4e65cd81f638ee221f 7c9c3504`)

```
 1:  6ee39ac =  1:  b0bfaad fix(auth): forget this device's session when sign-out cannot reach the server (BL-5)
 2:  c8f10c9 =  2:  c15cdd9 fix(csp): allow the Turnstile challenge in script-src and frame-src (SF-5)
 3:  7d2bee1 =  3:  9b56ff2 fix(meta): point og/twitter url and image at cleffy.io (SF-16)
 4:  0508174 =  4:  3aa9f22 fix(ink): keep marks the device could not store, and say so (SF-1)
 5:  b3c4757 =  5:  e6d0613 fix(ink): hold unsaved ink per account and score, outside the viewer's store
 6:  7379a8b =  6:  d3bf7c8 fix(ink): bound keep-changes sign-out, cancel recovery writes per account, never drop held ink
 7:  1ceeb9d =  7:  a0c7d69 fix(ink): server rows never overtake on the base seq; guard late snapshot failures after sign-out; tests
 8:  86f632c =  8:  935668b fix(ink): erase-only conflicts offer no Export; keep the export menu in the gutter over a notice
 9:  db55cab =  9:  03b63f8 fix(ink): sign-out keeps held ink for Export or Discard; Dismiss only hides; cut-off writes swept
10:  0ca6c92 = 10:  7c9c350 fix(ink): fit the conflict notice's three actions on a phone; room for the export menu in the signed-out export dialog
```

All 10 patches are `=` (identical). There is no non-trivial change compared with 0ca6c92e.

Cross-check: outside `documentsService.ts`, `git diff 0ca6c92e 7c9c3504` is byte-identical to `git diff 47e9b38f origin/dev`, meaning the only tree change is dev's own P1 delta. In `documentsService.ts` the only difference is P2's three lines, as above.

## Migrations

None. The P2 series adds or touches no files under `supabase/`, so `npm run migrations:mirror` was not needed and was not run.

## Local checks (on 7c9c3504, before the push)

| Check                                     | Result                                                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint:check`                      | pass (exit 0)                                                                                                                                 |
| `npm run typecheck`                       | pass (exit 0)                                                                                                                                 |
| `npm test` (vitest run, full suite)       | pass: **230 files passed, 6 skipped (236); 3518 tests passed, 18 skipped (3536)**                                                             |
| `src/features/viewer/ViewerPage.test.tsx` | ran and passed: **58/58**                                                                                                                     |
| `npm run build`                           | pass (exit 0; PWA `generateSW`, 110 precache entries)                                                                                         |
| prettier                                  | no files were changed while resolving conflicts (there were none). `npx prettier --check` on every file the series adds or modifies is clean. |

- The 6 skipped files are gated on environment: `tests/live/*.live.test.ts` (4), `tests/billing/cancelLinkStore.test.ts` and `tests/storage/storageLifecycle.test.ts`. They need a running local stack, and CI's `supabase-local` job covers them.
- None of the required checks needed the local stack, so `cloud:up` was not started. `npm run cloud:down` was run at the end anyway: "Stopped."
- No hosted Supabase, Vercel or Stripe was touched.

## CI on the final head 7c9c3504

Two CI workflow runs ran, both `success` at attempt 1:

- [39784936116](https://github.com/maxharris1/Cleffy/actions/runs/39784936116) (push)
- [39784942681](https://github.com/maxharris1/Cleffy/actions/runs/39784942681) (pull_request)

| Check          | Run 39784936116 (push)     | Run 39784942681 (pull_request) |
| -------------- | -------------------------- | ------------------------------ |
| checks         | success (job 119845499763) | success (job 119845523441)     |
| supabase-local | success (job 119845500091) | success (job 119845523089)     |
| supabase-drift | success (job 119845500271) | success (job 119845523270)     |
| omr-service    | success (job 119845500169) | success (job 119845523314)     |

Other checks and statuses:

- Vercel Preview Comments: success
- Vercel commit status: success (preview deployment completed; created automatically by Vercel, not touched by this session)
- Supabase Preview: skipped, as before

No Claude Approvals check is reported on this head. Combined commit status: success.

## Fix-up commits

None.

## Follow-ups (out of scope; for the separate PR after all six launch-fix PRs merge)

- Decision 65(1): an Export/Discard notice for held ink when access to a score is lost.
- Any other deferred minors from the P2 review rounds, as already tracked in the decisions file. None were implemented here.

## Open questions

- The harness that launched this session also named a designated branch, `claude/launchfix-p2-rebase-3pdwun`. Per Max's instructions (touch only PR #68's branch and this report branch), nothing was pushed to it. Flagging this only in case anything expects it.

## Hosted steps left for Max (none were performed)

- None are required for P2: there are no migrations, edge functions or config changes.
- Next step in the pass, for Grok Bot or Max: merge #68 per the agreed order (#69 ✓, then #68, #70, #71, #66, #67), then rebase the next PR.
- Leave the CSP change in `vercel.json` (Turnstile) and the og tags to the normal Vercel deploy from dev and main.
