# Cleffy PR #72 — fix round 4 report (Codex r4 REVISE)

**Status:** Complete

- PR: https://github.com/maxharris1/Cleffy/pull/72 (stays draft, not merged)
- Branch `mh/launchfix-followups`: `18a58715b97d7bdfb3a442cbd9f205e0cb7fbce0` → **`86d0e0f2d80f7b493653d43d800db0596519fdfa`** (one fast-forward push, no force)
- Environment: Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (confirmed via `get_session` at start), not Sandbox
- No messages or handoffs sent to any session, and no Codex review requested (override 2)

## Finding fixed

**1. MAJOR: update compaction breaks the ordering that protects newer ink (`src/sync/inkRecovery.ts`, `appendHeld`).** Fixed in commit `86d0e0f2d80f7b493653d43d800db0596519fdfa` (author Max Harris <drumaxter@gmail.com>).

Cause: when compacting a run of updates to one mark, `appendHeld` wrote the newer update into the older update's slot (`entry.ops[i] = …`). That could leave `entry.ops` out of edit order (`[a1:5, a2:2]`). The insertion scan relies on that order, so a red a1:4 kept late stopped at a2:2 and compacted over green a1:5.

The fix has two parts, both in `appendHeld`:
- **Order kept on replace.** The compacted update is removed from the prior's slot and inserted where its own edit falls (`splice(i, 1)` then `splice(at - 1, 0, …)`), so `entry.ops` stays oldest first. The prior's `prev` is still carried over as before.
- **Candidate's order checked separately.** Before compacting, the code compares the candidate's order with the matching prior op's order, whatever their positions in the array. If the candidate is older (only possible when an op of unknown order stopped the scan), it never replaces the prior. Instead it is inserted before the prior, so the newer op stays the mark's latest held version.

Codex's interleaving after the fix: the closed merge gives `[a2:2, a1:5]`. Red a1:4 then goes in before green as `[a2:2, a1:4, a1:5]`, so Export keeps green.

The round-3 PDF/title retention finding was marked RESOLVED by Codex and was left alone.

## Regression test (fails before the fix, passes after)

`src/sync/annotationStore.recovery.test.ts`: a new test, *"fix round 4: the newer edit compacted over an older held update of its mark is not then replaced by an older edit kept late"*. It sits next to the round-3 regression and extends it with a held yellow a1 update before the held blue a2 update. The steps are Codex's exact interleaving:
1. Hold yellow a1, then blue a2 (full disk).
2. Start a Retry, which waits on the server.
3. Queue red a1 behind the Retry.
4. Close and purge, then reopen.
5. Hold green a1, then close and purge again.
6. Release the Retry, so red is cut off.

It checks that the closed ink is `['a1:#00ff00', 'a2:#0000ff']`, that there are 2 marks, and that no outbox rows remain.

- **Before the fix** (test only, at 18a58715): it FAILS with `AssertionError: expected [ 'a1:#ff0000', 'a2:#0000ff' ] to deeply equal [ 'a1:#00ff00', 'a2:#0000ff' ]`. Export lost green, exactly as Codex reported.
- **After the fix:** it passes, along with the existing round-3 regression.

## Local checks (on 86d0e0f)

| Check | Result |
|---|---|
| `npx prettier --check` (changed files) | pass |
| `npm run lint:check` | pass |
| `npm run typecheck` | pass |
| `npm run test` | pass: 243 files passed, 6 skipped; 3808 tests passed, 20 skipped |
| `npx vitest run src/sync` | pass: 11 files, 369 tests |
| `npm run build` | pass |
| `git diff --check` | pass |
| `deno check` | not run locally (deno is not installed in this VM); covered by CI `edge-functions-deno`, green |
| Full migration replay + SQL proofs | not run locally; covered by CI `supabase-local`, green (TS-only change) |

## CI on the final head `86d0e0f2d80f7b493653d43d800db0596519fdfa`

I waited for every check to finish. **All green.** No Vercel rate-limit exception was needed: Vercel succeeded.

Workflow runs: push run `39883054361` succeeded; pull_request run `39883060554` succeeded.

| Check | Run | Job / check-run id | Conclusion |
|---|---|---|---|
| checks | push 39883054361 | 120184710053 | success |
| supabase-local (migration replay + SQL proofs) | push 39883054361 | 120184709995 | success |
| supabase-drift | push 39883054361 | 120184710043 | success |
| edge-functions-deno | push 39883054361 | 120184709772 | success |
| omr-service | push 39883054361 | 120184709960 | success |
| checks | pull_request 39883060554 | 120184730131 | success |
| supabase-local (migration replay + SQL proofs) | pull_request 39883060554 | 120184729846 | success |
| supabase-drift | pull_request 39883060554 | 120184730021 | success |
| edge-functions-deno | pull_request 39883060554 | 120184730134 | success |
| omr-service | pull_request 39883060554 | 120184730075 | success |
| Vercel Preview Comments | — | 120184912639 | success |
| Supabase Preview | — | 120184705591 | skipped (integration's own skip; not a failure) |
| Vercel (commit status) | — | https://vercel.com/maxs-projectsd/cleffy/28Ne8rSzkH1JiiENpzu43JcqkzV3 | success |

The combined commit status is `success`.

## Open questions

None.

## Scope kept

Nothing touched `main`, PR #54, hosted Supabase, live Stripe, secrets or `.env` files. There was no force-push, rebase, amend or squash. This report lives only on `claude/launchfix-followups-fix4-report`, branched from the final PR head, and not on the PR branch.
