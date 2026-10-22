# IMSLP download flake fix: report

## PR

- **PR:** [#65](https://github.com/maxharris1/Cleffy/pull/65), `mh/fix-imslp-download-flake` → `dev`, **draft**, no reviewers requested.
- **Final PR head:** `a98e8e856e43d5fc888196a16562a6c3eb658732`
- **Base:** `origin/dev` at `208cb5ffc9e339f15059b1bd07629e9d2cd563ec`, matching the expected 208cb5ff (dev had not moved).
- PR #54 was not touched. Nothing was merged. Nothing was pushed to main or dev. All pushes were fast-forward.

## Commits

| SHA                                        | Branch                               | Summary                                                            |
| ------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------ |
| `a98e8e856e43d5fc888196a16562a6c3eb658732` | `mh/fix-imslp-download-flake`        | fix(imslp): report an API call that outlasts the budget as timeout |
| (this commit)                              | `claude/imslp-flake-fix-report` only | docs: add IMSLP flake fix report                                   |

Both are authored as Max Harris <drumaxter@gmail.com>.

## Root cause: a production bug, not only the test

The failing test is `tests/imslp/imslpDownload.test.ts:379` (line 379 at `208cb5ff`; the test starts at line 372). CI runs 39698705858 and 39699650051 both failed with `expected { ok: false, code: 'bot_check', … } to match object { ok: false, code: 'timeout' }`.

The code is in `tryDownloadPdfWith`, in `supabase/functions/_shared/imslpDownload.ts`. Line numbers below are at `208cb5ff`.

1. The primary path fetches the wait page. The test's mock returns HTML with no CDN link, so the code falls through to the imageinfo fallback.
2. The fallback computes `left = remaining()` (L579). It then races `deps.mwFetch(...)` against a `budgetSpent` promise: `setTimeout(reject(timeout), left)` (L583–600). In the test, `mwFetch` never settles, so the timer wins.
3. The `catch` (L617–628) returned early only for `rate_limited`. A `timeout` was swallowed and fell through to the candidate loop, which fetches `openUrl`.
4. The candidate loop's `fetchWithin` refuses only when `remaining()` (from `now()`, i.e. `Date.now()`) is `<= 0` (L521–523).
5. **The race:** Node, via libuv, schedules a timer from the event loop's _cached_ time, not the current `Date.now()`. Any synchronous work done in that loop iteration makes the timer fire early relative to `Date.now()`, and ms rounding adds to that. So `remaining()` was often still 1–3 ms when the budget timer fired. An isolated measurement saw this in 61/200 trials, with 3 ms of synchronous work before scheduling.
6. One more request then went to `openUrl`. The mock answered `text/html`. `classifyDownloadBody` classifies any HTML as `'bot_check'` (L373–375), so `lastCode` became `'bot_check'` and the attempt ended `fail('bot_check')`, with `fetchImpl` called twice.

When the timer happened to fire at or after the `Date.now()` deadline, `fetchWithin` threw `timeout`, which ends the attempt, and the test passed. That is the flake.

In production the same skew lets one extra request go to IMSLP after the budget has run out. Usually that request just times out within its ~1 ms allowance. But if IMSLP answers HTML in that window, a hang is misreported to the user as a bot check.

## Fix

In `supabase/functions/_shared/imslpDownload.ts`, the budget timer now sets `budgetExpired = true` before it rejects (L582–588 on the PR head). The `catch` returns `fail('timeout')` when `budgetExpired` is set (L628–636). Once the budget timer has fired, the attempt is a timeout, whatever `now()` says.

Behaviour is unchanged when `mwFetch` fails on its own timeout or an API error while budget remains: it still falls through to the ImagefromIndex candidate.

New test: `tests/imslp/imslpDownload.test.ts:384`, "reports a hung API call as timeout even when the clock lags the budget timer". It freezes `now: () => 0` with `budgetMs: 20`, which is the timer/clock skew at its widest. It asserts `code: 'timeout'` and exactly one `fetchImpl` call.

- Before the fix it failed **deterministically**, with the CI symptom (`bot_check`).
- After the fix it passes.

The original test was left unchanged; it is now deterministic as a result of the production fix.

## Tests run

### Repeat runs

Loop command (a shell loop, one fresh vitest process per run):

```bash
for i in $(seq 1 N); do npx vitest run tests/imslp/imslpDownload.test.ts > run-$i.log 2>&1 && pass=$((pass+1)) || fail=$((fail+1)); done
```

"CPU load" means 8 busy-loop processes on 4 cores.

| Phase                   | Condition | Runs | Pass | Fail  |
| ----------------------- | --------- | ---- | ---- | ----- |
| Before fix (`208cb5ff`) | idle      | 20   | 18   | **2** |
| Before fix (`208cb5ff`) | CPU load  | 30   | 29   | **1** |
| After fix (`a98e8e85`)  | idle      | 50   | 50   | **0** |
| After fix (`a98e8e85`)  | CPU load  | 50   | 50   | **0** |

- **Before fix:** 3/50 failed, each with the exact CI assertion.
- **After fix:** 0/100 failed, and every run reported `Tests 30 passed (30)`.

### Other checks (on `a98e8e85`)

| Check                                        | Result                                                           |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `npm run lint:check`                         | pass (exit 0)                                                    |
| `npm run typecheck`                          | pass (exit 0)                                                    |
| `npm run test`                               | pass: 219 files passed, 5 skipped; 3382 tests passed, 13 skipped |
| `npm run build`                              | pass (exit 0)                                                    |
| `npx prettier --check` on both changed files | pass                                                             |

## CI on the final head `a98e8e85`

| Check          | push run 39701210129 | pull_request run 39702198494 |
| -------------- | -------------------- | ---------------------------- |
| checks         | success              | success                      |
| omr-service    | success              | success                      |
| supabase-drift | success              | success                      |
| supabase-local | success              | success                      |

| Other check             | Result                                    |
| ----------------------- | ----------------------------------------- |
| Vercel Preview Comments | success                                   |
| Vercel (commit status)  | success                                   |
| Supabase Preview        | skipped (integration skip, not a failure) |

The PR is still a draft, and GitHub reports `mergeable_state` as `clean`.

## Open questions

1. **Environment ID not verified.** I could not confirm the `env_01WAd3yiz3qpSnsofpyEwCh2` environment ID directly; see the next section.
2. **Same kind of race elsewhere.** The original test now passes deterministically, because the outcome no longer depends on the timer/clock skew; it still uses real timers with a 150 ms budget. Other budget checks that compare a `setTimeout` against `Date.now()` could have the same early-fire skew. I found none in this file that are tested this way. A wider audit is out of scope for this PR.

## Environment

- The container reports `CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE=cloud_default`, a Claude Code cloud (CCR) session. This is a claude.ai/code cloud container, not a local Sandbox.
- The repo's SessionStart hook ran: npm install and Docker came up.
- I did **not** read the environment ID itself. The only tool that reports it (`get_session`) belongs to the claude-code-remote toolset, which the task instructions ruled out, so I did not call it.
- Nothing in the container's environment variables or `/root/.ccr` names the environment ID. Max may want to confirm it from the session page.
- No hosted Supabase, live Stripe, secrets or `.env` files were touched. No other session was messaged.
