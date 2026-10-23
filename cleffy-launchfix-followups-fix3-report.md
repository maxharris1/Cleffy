# Cleffy PR #72: fix round 3 report (Codex r3 REVISE)

**Status:** Complete

- PR: https://github.com/maxharris1/Cleffy/pull/72 (still draft, still open, not merged)
- Branch: `mh/launchfix-followups`, fast-forward from `3b9bbc5f72613b3fc3550e778a977d6cc0ac5a78`
- **New head:** `18a58715b97d7bdfb3a442cbd9f205e0cb7fbce0`
- Environment: Cleffy cloud env `env_01WAd3yiz3qpSnsofpyEwCh2` (confirmed with get_session at the start), not Sandbox
- Commit identity: Max Harris <drumaxter@gmail.com> on both commits

## Start checks

- `git fetch origin`: `origin/mh/launchfix-followups` was `3b9bbc5f72613b3fc3550e778a977d6cc0ac5a78`, as expected. Checked out with `git checkout -B mh/launchfix-followups origin/mh/launchfix-followups`.
- Before the push, the remote still pointed at `3b9bbc5`. Pushed `3b9bbc5..18a5871` with `git push origin HEAD:mh/launchfix-followups`. This was a fast-forward: no force, rebase or amend.

## Finding 1 (MAJOR): an older cancelled edit overwrote newer closed ink

**Commit:** `d32e6f612f4ba703a4b0473f8b3673d698f620cc`: ink: an edit kept late never replaces a newer one of its mark (PR #72 fix round 3, 1)

**Fix** (`src/sync/inkRecovery.ts`, plus a one-line change in `src/sync/annotationStore.ts`):
- `editBoundTo` now gives each edit a number when it begins (`InkWriteGuard.order`, a counter for the tab).
- Every held op carries its edit's number (`AuthoredOp.order`). `persistOps` stamps it on fresh ops, and the snapshot-failure path for creates in `AnnotationStore.commit` stamps it on `holdOps` and `keepCancelled` ops.
- `appendHeld` keeps a mark's ops in edit order:
  - An op that is held late (for example cut off behind a Retry, then kept by `keepCancelled`) is inserted before every newer op instead of appended after them.
  - Update compaction only merges into an older update, never a newer one.
- Held conflicts also keep their edit's number (`conflictOrders`, `keepConflict`). An older op can't clear or replace a newer conflict, whether in `appendHeld`, in `moveToConflicts` or in the closed-entry merge in `closeDocInk`.
- Ops without a number keep the old behaviour (appended).

**Regression test:** `src/sync/annotationStore.recovery.test.ts`, test "an older edit cut off after the score closed, reopened and closed again never replaces the newer version of its mark in the closed ink". It runs the reviewer's exact sequence:
1. A Retry is waiting on the server.
2. An ordinary red update of a1 queues behind it.
3. The score is closed and purged.
4. The score reopens and a newer green update of a1 fails storage, so it is held.
5. The score is closed and purged again.
6. The Retry is released, and the red update is cut off.

The test then asserts that the closed ink exports a1 as green, with 2 marks and no outbox rows.

- Before the fix (test file from `d32e6f6` run against the src of `3b9bbc5`): **FAILS** with `expected [ 'a1:#ff0000', 'a2:#0000ff' ] to deeply equal [ 'a1:#00ff00', 'a2:#0000ff' ]`. Red replaced green.
- After the fix: **passes**.

## Finding 2 (MAJOR): a delayed cancellation kept ink without the PDF needed to export it

**Commit:** `18a58715b97d7bdfb3a442cbd9f205e0cb7fbce0`: ink: a score's PDF stays while an edit of it is under way (PR #72 fix round 3, 2)

**Fix** (`src/sync/inkRecovery.ts`, plus `src/sync/annotationStore.ts` call sites):
- `noteEditsInFlight(delta, docId)` now also counts edits per score (`inFlightByDoc`). It covers the same span the store already reported: from the edit applying in memory, or entering its snapshot wait, until its write settles (written, held, or kept by `keepCancelled`).
- `pruneSource` keeps a score's PDF bytes and title while any edit of that score is in flight.
- When the last in-flight edit of a score settles, the PDF is pruned if no viewer and no recovery entry still needs it.
- On cancellation, `keepCancelled` registers the closed entry before the store releases its in-flight count. So the PDF is still there when the entry is created, and from then on the entry keeps it.

**Regression tests** (`src/sync/annotationStore.recovery.test.ts`, "fix round 3"):
- "a first create waiting on its day snapshot when access is lost keeps the PDF for its closed ink, so Export needs no server"
- "a first create waiting on storage when access is lost keeps the PDF for its closed ink, so Export needs no server"

Both tests run this sequence: the viewer registers its PDF, a first create starts, the viewer closes (its `rememberScoreSource` cleanup runs), the score is purged, then the edit is cancelled. They assert that `lostAccessInk()` lists the closed entry with its title and **the same PDF bytes**. Those bytes are what `SignedOutInkNotice` passes to Export, so Export doesn't need to fetch the score from the server.

- Before the fix (test file from `18a5871` run against the src of `d32e6f6`): **both FAIL**. The closed entry is listed with no `title` and no `bytes`.
- After the fix: **both pass**.

A third test, "once the edit under way is saved, the PDF goes with its viewer", guards against a leak: once the edit has saved, the PDF is gone. It passes both before and after the fix.

## Local checks (on `18a5871`)

| Check | Result |
|---|---|
| `npm run lint:check` | pass |
| `npm run typecheck` | pass |
| `npm run test` | pass: 243 files passed, 6 skipped; 3807 tests passed, 20 skipped |
| `npm run build` | pass |
| `deno check --config supabase/functions/deno.json supabase/functions/*/index.ts` (deno 2.1.4, as in CI) | pass |
| Local Supabase stack (`supabase start -x …`, CLI 2.121.0, as in CI) | started; Realtime container running; today's `realtime.messages` partition exists |
| CI's full replay (5 cancel-link migrations, then every migration from 20261022100000 on: 39 files) | pass, `ON_ERROR_STOP=1` |
| `tests/billing/cancelLinkStore.test.ts` against the local stack | pass (8/8) |
| `tests/storage/storageLifecycle.test.ts` against the local stack | pass (5/5) |
| Every SQL proof (`tests/sql/*.sql` plus `supabase/sql-tests/sharing_access_control.sql`, through `scripts/ci/sql-proof.sh`) | 67 run, 0 failed |

## CI on the final head `18a58715b97d7bdfb3a442cbd9f205e0cb7fbce0`

I waited until every check had finished.

Workflow runs:
- CI, `push`: run 39880370817, **success**
- CI, `pull_request`: run 39880375956, **success**

| Check | push run 39880370817 (job id) | pull_request run 39880375956 (job id) |
|---|---|---|
| checks | success (120176046390) | success (120176062960) |
| supabase-local | success (120176046473) | success (120176063238) |
| supabase-drift | success (120176046663) | success (120176063178) |
| edge-functions-deno | success (120176046624) | success (120176063114) |
| omr-service | success (120176046697) | success (120176062754) |

Other checks:
- Vercel Preview Comments: success (check run 120176233752)
- Supabase Preview: skipped (check run 120176042437). It was skipped, not red.
- Commit status `Vercel`: **success** (https://vercel.com/maxs-projectsd/cleffy/Dj7aTPwUF544VESdrYnEcdYwXmZg). No build-rate-limit failure this time.
- Combined commit status: success.

## Open questions

1. **Same race, still open (not reported by Codex):** two edits of one mark that both started while no recovery entry existed can still be held out of order in an *open* entry. For example: an older edit fails late, after a newer edit has been held and a Retry has already started writing it. `appendHeld` now places the older op before the newer one, so the held, drawn and exported version is correct. But if the Retry has already written the newer op, it then writes the older op after it, so the mirror ends on the older version. Before this round the older op also replaced the newer one in memory, so this is no worse than before. A full fix would drop a held op that is older than an op already written for the same mark. Should that go in this PR or a follow-up?
2. As the overrides required, no handoff was sent to Cleffy/Grok Bot or any other session, and no Codex review was requested. The operator relays.
