# Cleffy PR #73 (launch-fix item 16): fix round 3 report

**Status:** Complete

- PR: https://github.com/maxharris1/Cleffy/pull/73 (still a draft, not merged)
- Branch: `mh/launchfix-item16`, fast-forward from `3595382f834448c0c802e9dda4e85de0a7c03117`
- **New head:** `988377730174f80d76f4ab1c3142a65404b06bef` (one commit, Max Harris <drumaxter@gmail.com>)
- Environment: Claude Code cloud session in the **Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2`** (checked with `get_session` at the start), not Sandbox.

## Start-up checks

- After `git fetch origin`, `origin/mh/launchfix-item16` was `3595382f834448c0c802e9dda4e85de0a7c03117`, as expected. I checked out from it and set the commit identity to Max Harris.
- Before pushing I fetched again and it was unchanged. The push `3595382..9883777` was a plain fast-forward: no force, rebase or amend, and no rebase onto `mh/launchfix-followups`.
- I did not touch main, #54, hosted Supabase or live Stripe. I sent no messages or handoffs and requested no Codex review.

## The finding (Codex r3, MINOR, `cancelFlow.ts:870`): fixed

**Cause.** Every press of the link called `keep_cancel_link_refund_request` again. Suppose a refund request had already been kept and sent, and then the deletion removed the link after this press read it but before the keep RPC. The RPC returned `not_found`. The `null` fallback then rebuilt the email from the account's current data, under a Resend key that had already been used. Resend saw a different payload and returned 409, so the buyer got `refundRequested:false, refundRequestFailed:true`.

**Fix (commit `9883777`).** The kept request now travels with the link from the moment it is read.

- `read_cancel_link_token` is redefined in #73's own migration `20261022160000_cancel_link_release_for_deletion.sql`, edited in place because it was never applied to a hosted DB. It keeps the same filter as before: unused, and unexpired on `clock_timestamp()`. Its answer now also includes `refund_request` when the link holds one. A link with none returns the same `{user_id, mode}` as before, so proof `cancel_link_read_db_clock` check 01 is unchanged. It is still service-role only, with `search_path` pinned. `scripts/apply-migrations.sql` was regenerated with `npm run migrations:mirror`.
- In `billing-cancel/index.ts`, `readToken` parses the request with the new `refundRequestOf` in `billingCancelStore.ts`, which `keepRefundRequest` now shares. A malformed stored request causes a throw, which becomes a 503. Nothing is sent that might not be the kept email.
- `cancelFlow.ts`: `LiveCancelToken.refundRequest` carries the request. `requestRefund` sends it exactly as stored and does not call the keep RPC again. The stored request is set once and the guard makes it immutable, so it is what support already received. A new email is built and kept only if nothing was kept when the link was read. The `null` fallback is left only for that case, where no send can have gone under the key before this press. The one exception is two simultaneous presses, which build from the same moment.
- Deploy order is unaffected: either `billing-cancel` works with either version of the function. I added a note to `DEPLOY.md`.

## Regression: fails before the fix, passes after

These tests are in `tests/billing/cancelFlow.test.ts`, in a new describe block called "the link removed by the deletion between the read and the keep". They go through the handler and the repository's `FakeResend`. The fake `readToken` now returns a snapshot (`{userId, mode, refundRequest}`), like the RPC, instead of the live row.

1. **A retry with a new email while the deletion is still pending.** The link is deleted right after it is read, during the deletion check. Expected: `refundRequested:true, refundRequestFailed:false`, one delivered email, one distinct payload, and the original Reply-To.
2. **A retry with a new plan after the deletion was abandoned.** The link is deleted during the Stripe update, after the spend and before the keep. Expected: the same request answered as sent, still naming "Plan: Teacher".
3. **Control: a first press with nothing kept yet.** The link is removed before the keep, and support still gets the request that was built.

Before the fix (test file only, against `3595382`'s code):

```
× a retry with a new email address, deletion still pending: the kept email, answered as sent
× a retry with a new plan after the deletion was abandoned: the kept email, answered as sent
Tests  2 failed | 1 passed | 90 skipped (93)
  -   "refundRequestFailed": false,   -   "refundRequested": true,
  +   "refundRequestFailed": true,    +   "refundRequested": false,
```

This is the symptom Codex reported. The control passed before the fix as well.

After the fix: `Tests 3 passed`, and the whole file passes, 94 of 94 including a new wiring test.

Other coverage added:

- **SQL proof `tests/sql/cancel_link_release_for_deletion.sql`.**
  - Check 40b: a link with no kept request reads as its account and mode alone.
  - Check 45b: `read_cancel_link_token` returns the request that was kept first, next to the account and mode.
  - With `20261020160600`'s definition put back, 45b fails (`1 | 46; failing: 45b`). With the fix, all 46 checks pass.
- **Store test `tests/billing/cancelLinkStore.test.ts`.** Against the real function, the read has no `refund_request` before a keep, and returns the first request after one.
- **Wiring test.** `index.ts` reads `refund_request`, and the migration's redefinition keeps the clock-checked filter.
- **Docs.** `tests/sql/README.md` and `DEPLOY.md` are updated.

## Local checks (all on the final code)

| Check | Result |
|---|---|
| `npm run lint:check` | pass |
| `npm run typecheck` | pass |
| `npm run test` | 246 files passed, 6 skipped; 3890 tests passed, 22 skipped |
| `npm run build` | pass |
| `deno check --config supabase/functions/deno.json supabase/functions/*/index.ts` (Deno 2.1.4, as in CI) | pass |
| Local Supabase stack (same `supabase start -x …` as CI, CLI 2.121.0): every migration applied | pass |
| CI's full replay (the five cancel-link migrations, then every migration from `20261022100000` on) | pass, no errors |
| `cancelLinkStore.test.ts` against the stack (`CLEFFY_REQUIRE_LOCAL_DB=1`) | 10/10 |
| `storageLifecycle.test.ts` against the stack | 5/5 |
| Every SQL proof (`tests/sql/*.sql` + `sharing_access_control.sql`) through `scripts/ci/sql-proof.sh` | 69 run, 0 failed (`cancel_link_release_for_deletion` 46/46, `cancel_link_read_db_clock` 10/10) |

## CI on the final head `988377730174f80d76f4ab1c3142a65404b06bef`

Both CI runs completed with **success**: push run `39888633619` and pull_request run `39888638779`.

| Check | Run | Check-run id | Result |
|---|---|---|---|
| checks | push 39888633619 | 120202723381 | success |
| supabase-local | push 39888633619 | 120202724004 | success |
| edge-functions-deno | push 39888633619 | 120202723705 | success |
| omr-service | push 39888633619 | 120202723749 | success |
| supabase-drift | push 39888633619 | 120202723871 | success |
| checks | pull_request 39888638779 | 120202742352 | success |
| supabase-local | pull_request 39888638779 | 120202742345 | success |
| edge-functions-deno | pull_request 39888638779 | 120202742537 | success |
| omr-service | pull_request 39888638779 | 120202742136 | success |
| supabase-drift | pull_request 39888638779 | 120202742292 | success |
| Vercel Preview Comments | — | 120202947677 | success |
| Supabase Preview | — | 120202721374 | skipped (not red) |
| Vercel (commit status) | — | — | success |

The combined commit status is `success`. There are no red checks, so the Vercel exception was not needed.

## Open questions

- **Remaining narrow case, by design.** If two presses of the same link start at the same moment, neither has seen a kept request, and the deletion removes the link before either one's keep, then each sends the request it built from its own read. Both reads happen within milliseconds of each other, so the payloads differ only if the account's email or plan changed in that window. Even then, the outcome is the safe one: the buyer is told to write in. Closing that too would mean not sending a first refund request when the link vanishes, which drops the legal-right request. I judged that worse and left it as is, but it is the reviewer's call.
- I wrote no `/workspace` done-file and sent no handoff, per the overrides. The operator relays this.
