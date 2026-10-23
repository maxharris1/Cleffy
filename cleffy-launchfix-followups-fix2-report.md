# Cleffy PR #72 — fix round 2 report (Codex r2 REVISE)

**Status:** Complete

- PR: https://github.com/maxharris1/Cleffy/pull/72 (still a draft, open, not merged)
- Branch: `mh/launchfix-followups`
- Starting head: `c940b0ca68539e1acfaa0820351f0624b4bac72d` (checked equal to `origin/mh/launchfix-followups` before starting)
- **New head: `3b9bbc5f72613b3fc3550e778a977d6cc0ac5a78`** (fast-forward push `c940b0c..3b9bbc5`; no force, rebase or amend)
- Environment: Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (confirmed with `get_session` at the start), not Sandbox.
- Commits are authored by Max Harris <drumaxter@gmail.com>. I did not touch main, PR #54, hosted Supabase or live Stripe. I printed and committed no secrets.

## Findings

### 1. MAJOR — ordinary writes can recreate purged ink → fixed in `3144577`

`ink: an edit under way when its score is lost writes nothing, and is kept (PR #72 fix round 2, 1)`

**The bug.** An ordinary `persistOps()` queued behind Retry kept only the account guard (`boundTo`). This sequence put the mark and its outbox row back into a purged score:

1. Retry awaits the server.
2. An edit queues behind it.
3. `closeDocInk` runs and the purge finishes.
4. The server answers and Retry cancels.
5. The queued edit writes.

An edit waiting on its day snapshot had the same gap.

**The fix** (`src/sync/inkRecovery.ts`, `src/sync/annotationStore.ts`):

- **One guard per edit.** A new `editBoundTo(account, score)` (type `InkWriteGuard`) records both the account epoch and the per-score epoch when each edit begins:
  - `AnnotationStore.commit`
  - `createMany`
  - undo/redo `replayEntry`
  - `retryHeld`, which replaces round 1's local `account() && open()`
  - the default for `persistOps`
- **The guard travels with the edit.** That same guard is passed through:
  - the day-snapshot wait (`captureStartingPoint` → `ensureDayStartingSnapshot`)
  - the queue behind a Retry (`entry.chain`)
  - every check before, between and inside the `writeOps` transaction
- **Where cancelled edits go.** `keepCancelled` (replacing `keepCutOff` at the cut-off points) keeps what the guard cut off:
  - Account signed out: kept as the account's signed-out ink, same as before.
  - Score lost since the edit began: kept as the score's **closed Export ink** (the closed entry, `lostAccessInk`, `heldInkForExport(..., lost=true)`). It is never written into the purged score and never drawn or retried.
  - Score deleted by the user (`forgetDocInk`, which now records `forgottenAt`): the edit is dropped along with the rest of that score's ink. This matches decision 65(1).
- **Error message.** A write cancelled by a closed score now throws `RecoveryCancelled` with the message "The score was closed on this device…".

**Ordering argument (no `cutOffWrites` needed for close).** `closeDocInk` runs synchronously before the purge's deletes.
- A write transaction that has not started yet sees the new epoch at its first in-transaction check and rolls back.
- A write transaction that started earlier was created before the purge's delete transactions. IndexedDB runs overlapping read-write transactions in creation order, so the purge's deletes remove its rows afterwards. Its ops are still kept as closed ink, because the guard fails on the post-commit check.

**`SyncEngine.stop()`** is unchanged. A store mutation that outlives the engine is now cut off by the guard itself.

**Tests** (`src/sync/annotationStore.recovery.test.ts`, new describe block "an ordinary edit under way when the score is lost to this device (PR #72 fix round 2)"):

| Test | What it covers |
|---|---|
| `queued behind a Retry awaiting the server, then the score closed and purged: …` | **The exact interleaving from the review**, steps 1–5 above, with `purgeLocalDocument`'s local half run on the test DB. It asserts: 0 annotation rows, 0 outbox rows, the edit rejects with `/closed/`, both marks kept as closed ink (`a1:#ff0000`, `a2:#111111`; `lostAccessInk` = `[[A, DOC, 2]]`), and nothing drawn or held for Retry. |
| `closed while it waits on its day snapshot: …` | No snapshot, mark or outbox row is written; the edit is kept as closed ink. |
| `the user deleting the score themselves lets a queued edit go with it: …` | `forgetDocInk`: nothing written and nothing kept. |

**Proof that the tests fail before the fix and pass after:**
- Pre-fix source (`inkRecovery.ts` and `annotationStore.ts` from `c940b0c`) with the new tests: **all 3 fail** ("promise resolved instead of rejecting").
- With the rejection assertion stubbed out, all 3 fail with `expected 1 to be +0` on the row count. The old code really does write a row into the purged score.
- With the fix: the file passes 42/42.

### 2. NIT — adapter mapping had no regression coverage → fixed in `3b9bbc5`

`delete-account: the intents RPC rows go through a tested mapper (PR #72 fix round 2, 2)`

**The fix.**
- `provisionIntentFromRow` and the `ProvisionIntentRow` type now live in `supabase/functions/_shared/accountDeletion.ts`.
- `supabase/functions/delete-account/index.ts` maps the RPC rows with `.map(provisionIntentFromRow)`. The mapping is the same as before:
  - `proven` only when `row.proven === true`
  - `unprovenMatch` only when `status === 'unproven_match'`
  - `live` only when `row.live === true`

**Tests** (`tests/account/accountDeletion.test.ts`, describe "the student_provision_intents_proven() row mapper (PR #72 fix round 2, 2)"):
- Maps each status the RPC returns: `proven`, `unproven`, **`unproven_match`**, **`none`**.
- A missing or unknown column (missing `status`/`proven`, `'UNPROVEN_MATCH'`, non-boolean `proven`/`live`) is read as neither proof nor a match.
- An `unproven_match` row, after mapping, keeps its intent through `deleteAccount`.
- `delete-account`'s `provisionIntents` port calls `student_provision_intents_proven` and maps the rows with `provisionIntentFromRow`. This is a source-wiring assertion, following the precedent in `tests/legal/*`. It addresses Codex's point that the fake-port tests would pass even if the adapter mapping disappeared.

**Proof that the tests fail before the fix and pass after:**
- Pre-fix source: **all 4 fail** (`provisionIntentFromRow is not a function`).
- Mutation (the `unproven_match` line replaced with `unprovenMatch: false`): 2 fail.
- With the fix: 62/62 pass.

## Local checks (on `3b9bbc5`)

| Check | Result |
|---|---|
| `npm run lint:check` | clean |
| `npm run typecheck` | clean |
| `npm run test` | 243 files passed, 6 skipped; 3803 tests passed, 20 skipped |
| `npm run build` | OK |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| `deno check --config supabase/functions/deno.json supabase/functions/*/index.ts` (Deno 2.1.4, CI's version) | exit 0 |
| `git diff --check` | clean |
| Local Supabase stack (CI's `supabase start -x …` subset), all migrations | applied |
| CI's full replay: the 5 cancel-link migrations + every migration from `20261022100000` on (39) | all re-applied cleanly |
| Every SQL proof: `tests/sql/*.sql` + `supabase/sql-tests/sharing_access_control.sql` via `scripts/ci/sql-proof.sh` | 67 run, 0 failed |
| `tests/billing/cancelLinkStore.test.ts` + `tests/storage/storageLifecycle.test.ts` against the local stack | 13/13 passed |

This round changed no SQL or migrations.

## CI on the final head `3b9bbc5f72613b3fc3550e778a977d6cc0ac5a78`

I waited for every check to finish. **All green.**

| Workflow run | Event | Job | Result | Job / check-run id |
|---|---|---|---|---|
| CI 39877446057 | push | checks | success | 120166387439 |
| CI 39877446057 | push | supabase-local | success | 120166387662 |
| CI 39877446057 | push | omr-service | success | 120166387690 |
| CI 39877446057 | push | edge-functions-deno | success | 120166387695 |
| CI 39877446057 | push | supabase-drift | success | 120166387701 |
| CI 39877451886 | pull_request | checks | success | 120166406842 |
| CI 39877451886 | pull_request | supabase-local | success | 120166406816 |
| CI 39877451886 | pull_request | omr-service | success | 120166406687 |
| CI 39877451886 | pull_request | edge-functions-deno | success | 120166406653 |
| CI 39877451886 | pull_request | supabase-drift | success | 120166406423 |

Other checks and statuses on the commit:

| Check | Result | Id / target |
|---|---|---|
| Vercel Preview Comments (check run) | success | 120166602095 |
| Supabase Preview (check run) | skipped (not red) | 120166378799 |
| Vercel (commit status) | success | https://vercel.com/maxs-projectsd/cleffy/CQk5hGYWrXzte8K1rQmNLbi2uzXB |

Combined commit status: `success`. There was no Vercel build-rate-limit failure this round.

## Open questions

- None blocking.
- I used one judgement call: an edit cancelled because the **user deleted the score themselves** (`forgetDocInk`) is dropped, not kept. That follows decision 65(1): the user's own delete takes that score's held ink with it. Every other way of losing a score keeps the cancelled edit as closed Export ink.
- Updates and erases that are still waiting on their day snapshot when the score closes are not applied. Nothing was drawn, so nothing is lost; sign-out already handles them the same way. Creates are drawn before the snapshot wait, so they are kept as closed ink.

## Not done, per the overrides

- I sent no handoff or message to any session (Cleffy, Grok Bot or anyone else) and requested no Codex review. The operator relays.
- The report is on branch `claude/launchfix-followups-fix2-report`, created from the final `mh/launchfix-followups` head. It is not on the PR branch.
