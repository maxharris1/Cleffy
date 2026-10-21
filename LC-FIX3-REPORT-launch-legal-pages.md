# LC fix pass round 3: PR #63 (mh/launch-legal-pages)

- **PR:** https://github.com/maxharris1/Cleffy/pull/63 (still a draft, into `dev`)
- **Start head:** `b8adc513c793cfeceaf65c4fb371ebf65ca0e2b1`, confirmed after `git fetch origin && git checkout -B mh/launch-legal-pages origin/mh/launch-legal-pages`
- **New head:** `c12b0230be6c9b2b14bb8ae8dcd3681e17f0a78a`. Two commits, both fast-forward pushes, neither forced.
- **Environment:** Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (`environment_kind: anthropic_cloud`), confirmed with `get_session` at the start. Not Sandbox.
- **Author:** both commits are authored by `Max Harris <drumaxter@gmail.com>`.

## Commits

| SHA | Summary | Packet item | Tests that cover it |
|---|---|---|---|
| `e1f8c44af8c5a9b62be47c3568c725944be70819` | Takedown: hold the owner's ink until the new generation is read, and close on a denial | **B1** | `src/sync/realtimeChannel.test.ts`: the 9 new tests in the "takedown topics" block (listed below); `tests/live/takedownRealtime.live.test.ts`: the new second `it` |
| `c12b0230be6c9b2b14bb8ae8dcd3681e17f0a78a` | Notices: take the Idempotency-Key from resendIdempotencyKey, not a copy of its format | **Minor** (`contentReports.ts:591`) | `tests/moderation/contentReports.test.ts`: the new test "takes the key from resendDelivery's resendIdempotencyKey, not a copy of its format", plus the existing key-equality and same-key-on-retry tests (still passing) |

## B1: fail-closed epoch hold (`src/sync/realtimeChannel.ts`)

### What changed

1. **Failed and successful reads are now distinct.** `fetchTopicEpoch` and `fetchRealtimeTopicEpoch` return an explicit `TopicEpochRead`:
   - `{ status: 'epoch', epoch }`: the read succeeded
   - `{ status: 'denied' }`: a definite no
   - `{ status: 'failed' }`: no answer

   Nothing collapses to `undefined` any more. A throw from `fetchTopicEpoch` counts as `failed`.
2. **The hold is kept until a read succeeds.** After a `topic_rotated` hint, `inkHeld` is released only in `applyEpochRead` on an `epoch` result. On `failed` it stays on.
   - While held, `send()` refuses, and `publisher.append` buffers nothing.
   - `trackPresence` sends no presence on the old topic either.
   - So a collaborator's presence sync on the old `doc:{id}` can set `hasRemoteAudience` but can't cause a send.
   - If a successful read shows the hint didn't actually move the score (for example a forged hint), the hold lifts on the same topics and presence is re-announced (forced).
3. **Failed reads retry with bounded backoff.** `scheduleEpochRetry` uses `epochRetryDelayMs(attempt)`:
   - The ceiling is `min(30 000, 500 × 2^attempt)` ms, with equal jitter (half the ceiling plus up to half again at random). That is the same shape as the existing `rejoinDelayMs`.
   - With maximum jitter the delays are 0.5, 1, 2, 4, 8, 16, 30, 30… s. It never gives up while held.
   - The attempt counter resets only on a successful read.
4. **Cancellation and staleness:**
   - **Teardown:** `stop()` clears the retry timer. Every await point checks `stopped`, and the retry callback goes through `refreshEpoch`, which also checks it. Tests assert `vi.getTimerCount() === 0` after stop.
   - **A newer hint or a refused join** goes through `refreshEpoch`, which clears any waiting retry timer and reads at once. Only one loop exists.
   - **Stale answers:** if a hint lands while a read is in flight, that read's answer is discarded and the read goes again (`epochCheckAgain`). The server may have answered before the newer rotation, so a stale result can never win over a newer one.
   - A newer hint keeps the attempt counter, so a flood of forged hints can't reset the backoff while the RPC is down.
5. **A denial closes everything.** On `denied`, `closeOnDenial()` runs:
   - It holds ink, then calls `stop()`. That `removeChannel`s (unsubscribes and removes) both `doc:{id}` and `doc-db:{id}` for the current generation, which are the only channels this instance owns. It also clears all re-join, fallback-poll, flush, presence and retry timers, and sets `stopped`, so no re-join, retry or poll ever reopens anything.
   - It then calls `onMembershipChanged`, which `CloudViewer.recheckAccess` turns into the restricted state ("This score is no longer available to you…").
   - A denial on start opens no channels at all. Previously it still opened generation 0.
6. **A failure that isn't after a hint** (start, or a refused join) keeps the old behaviour: open generation 0 if nothing is open yet. This is safe because a *fresh* join is authorized by the server against the current generation, so a wrong guess is refused, never admitted, and the refusal triggers another read. Only an already-joined channel carries cached permissions, and that case is now held.

### Telling a definite denial from a transient failure

This is documented in the comment on `fetchRealtimeTopicEpoch`. `realtime_topic_epoch` runs under the caller's own token and returns SQL `null` exactly when `document_role()` is null:

- the caller is not, or no longer, a member;
- a takedown shuts them out (restricted: everyone but the owner; removed: everyone);
- or the score is gone.

That is the same check RLS makes, read fresh on each request. So **only** a response with no error and a `null` body is `denied`.

Everything else is `failed`:

- a throw (offline, aborted);
- any error object: network, timeout, any HTTP 4xx/5xx, including a 401 for an expired token (fixed by the next refresh) and a 404 or PGRST202 from a server without the function;
- a 2xx body that is not a non-negative integer, such as `1.5` or `undefined`.

When unsure, the code treats the read as transient and keeps holding (fail closed).

### Tests for B1

All are in `src/sync/realtimeChannel.test.ts`. Each new one fails on b8adc513 and passes now.

| Packet test | Test name | Failure on b8adc513 |
|---|---|---|
| (a) fails, then succeeds | `a failed read after the hint keeps the hold, sends nothing on the old topic, and lets go only on success` | the owner's ink is `send`-ed on the old `doc:{id}` 3 times |
| (b) access denied | `a denial closes doc:{id} and doc-db:{id} at once, for good, and a connected collaborator gets no ink`; `a denial on start opens nothing` | old channels never removed; gen-0 channels opened on a denied start |
| (c) presence during the failure window | `a collaborator's presence update during a failing read does not let the owner's ink out` (rotation → RPC failure → presence update → owner draws and turns the page) | the owner's ink is sent after the presence update |
| (d) bounded backoff, stops on teardown | `backs off failed reads to a bound, and stops retrying on teardown` (asserts waits `[500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]`, then no reads and 0 timers after `stop()`); `jitters each retry between half and all of a ceiling that doubles from 0.5 s to 30 s` | no retry ever happens; helper absent |
| cancellation / staleness | `a newer hint replaces the waiting retry, and an answer from before it decides nothing` | no retry, so the timing assertions fail |
| forged hint | `a hint that turns out not to move the score lets go on the same topics, and announces again` | (new path) |
| classification | `reads the generation over PostgREST: only a null answer is a denial, anything unclear a failure` (replaces the old `:1006` conversion test) | old return shape |

**How "fails on b8adc513" was checked.** The new test file was run against the b8adc513 `realtimeChannel.ts` in a scratch worktree. The reads were mapped back to the old `number | null | undefined` contract (`failed→undefined`, `denied→null`, `epoch→number`) and the new exports were stubbed. All 9 new tests fail, each at the behavioural assertion in the table above, and all 48 pre-existing tests pass.

**Live test** (`tests/live/takedownRealtime.live.test.ts`, new second `it`): **added and run.** The harness injects `fetchTopicEpoch`, so the owner's epoch read can be forced to fail on the client while the Realtime server and database stay real. The scenario:

1. An adversarial collaborator, on its own socket, is on the old `doc:{id}`, present, and ignores every hint.
2. The collaborator's app (`DocRealtimeChannel`) is on another socket.
3. The owner's reads are set to fail, then the takedown is applied with `apply_content_takedown` restrict.
4. The test waits for at least 2 failed reads (the hint, then a retry) and checks the owner is still on the old topics.
5. The adversary updates its presence, and the owner draws 5 strokes. **The adversary hears nothing.**
6. The collaborator's app reads `denied`, leaves both topics at once and calls `onMembershipChanged`.
7. The reads are allowed again. The next retry moves the owner to generation 1, and further strokes still never reach the adversary.

Against the b8adc513 implementation (same adapter as above), this test **fails: the adversary receives all 5 `held-*` strokes**, which reproduces B1 live. With the fix, both live tests pass (2/2, about 26 s).

### Restricted state (ui-check)

No UI code changed. The restricted state is the existing `CloudViewer` access-loss screen, reached through `onMembershipChanged`. I still drove it with the ui-check helpers (`scripts/ui/uifuzz.mjs`) on desktop-1440, ipad-portrait and iphone-se:

- Throwaway owner and collaborator accounts, one throwaway score per viewport with the fixture PDF; nothing seeded was touched, and everything was deleted afterwards.
- The collaborator has the score open in the viewer, then the service role applies a restrict takedown.
- The restricted message appeared 61–73 ms later on all three viewports.
- No console errors and no overflow. The audit's only hit is the pre-existing small "Back to library" text link on tablet and phone, outside this change.

## Minor: `contentReports.ts:591`

**Done, through dependency injection rather than a direct import.** The "no runtime imports" constraint is real and enforced in two places:

- `tests/moderation/contentReports.test.ts:245` fails on any non-`import type` line in that file.
- `tsconfig.json` has `allowImportingTsExtensions: false`, and `tests/` (which imports this file) is type-checked. So `import { resendIdempotencyKey } from './resendDelivery.ts'` (the form Deno needs) fails `tsc`, and dropping the `.ts` breaks Deno.

The file's own documented pattern is that "everything the handlers touch arrives in `deps`", so:

- `CommonDeps` gains `idempotencyKey: (outbox, rowId) => string`.
- `deliverNotices` calls `deps.idempotencyKey(CONTENT_NOTICE_OUTBOX, notice.id)`.
- `contentReportsWiring.ts`, which already imports `resendDelivery.ts` at runtime, passes `resendIdempotencyKey`.
- The inline `contentNoticeIdempotencyKey` is removed. No other branch (#61, #62, #64, dev) references it.
- The key value is unchanged (`content-notice-outbox-{uuid}`). The existing equality and same-key-on-retry tests still pass.
- The new test asserts the injected helper is called with `('content-notice-outbox', id)` and that its result is the key sent. It fails on b8adc513.
- The edge runtime can't boot functions in this sandbox (see below), so all three functions (`content-notices`, `content-report`, `content-moderation`) were bundled with esbuild instead. Their `.ts` graphs resolve, including the new named import.

## Checks run

| Check | Result |
|---|---|
| `npm run lint:check` | clean (after each commit) |
| `npm run typecheck` | clean (after each commit) |
| `npm run test` | **199 files passed, 1 skipped; 2893 tests passed, 2 skipped** (the skips are the env-gated live tests). Run with the `cloud:up`-written `.env.local` moved aside, as earlier rounds did. With it present, `tests/auth/turnstileField.test.tsx` and the `syncEngine` backoff test fail. **I confirmed they fail identically on untouched b8adc513 with that file present and pass without it**, so they are not caused by this change. CI has no `.env.local`. |
| `npm run build` | success (after each commit) |
| `npx prettier --write` | applied to every changed file |
| Live: `tests/live/takedownRealtime.live.test.ts` on the local stack (`npm run cloud:up`, `http://127.0.0.1:54421`) | **2/2 passed**; the new test fails against the b8adc513 implementation (5 strokes leak) |
| ui-check, restricted state | see above |
| Edge-function bundle check (esbuild) | all three content functions bundle |
| SQL tests | none needed: no migration or SQL changed |

**Edge runtime caveat.** The local `supabase functions serve` cannot boot any function in this cloud sandbox: its runtime rejects the agent proxy's TLS certificate (`UnknownIssuer`) when fetching `npm:@supabase/supabase-js`. This affects every function, not just the changed ones, and the PR body already records it. Deno isn't installed in this container, so there was no `deno check`; the esbuild bundle stands in for it.

## CI on the new head

**Green on `c12b0230`**, read from the GitHub check runs at about 20:41 UTC on 2026-10-21:

| Check | Result |
|---|---|
| `checks` (lint, typecheck, test, build), run 39671599200 | success |
| `checks`, run 39671606586 | success |
| `omr-service` (both runs) | success |
| `supabase-drift` (both runs) | success |
| Vercel (commit status) | success |
| Vercel Preview Comments | success |
| Supabase Preview | skipped (as in earlier rounds) |

No review threads are open. PR #63 is still a draft. As in Codex's round-3 note, this is green for #63 **on its own**; the combined merge is untested.

## Byte parity (four shared mail files)

`git fetch origin && git diff origin/mh/launch-checkout HEAD -- supabase/functions/_shared/mailBudget.ts supabase/functions/_shared/resendDelivery.ts tests/security/mailBudget.test.ts tests/security/resendDelivery.test.ts` is **empty**.

`origin/mh/launch-checkout` has moved since the packet, from `2ab467bf` to `d9b83e20e37dc041040a9048d5ae895dbe4cb1d8`, but none of the four files changed. The blob hashes are identical on both sides and match Codex's round-3 table:

| File | HEAD | origin/mh/launch-checkout |
|---|---|---|
| `supabase/functions/_shared/mailBudget.ts` | `beb4df8ac36f` | `beb4df8ac36f` |
| `supabase/functions/_shared/resendDelivery.ts` | `6993439d0e19` | `6993439d0e19` |
| `tests/security/mailBudget.test.ts` | `59581e28d486` | `59581e28d486` |
| `tests/security/resendDelivery.test.ts` | `ba320209407f` | `ba320209407f` |

None of them was edited on this branch (`git diff b8adc513 HEAD` on them is empty).

## Migrations

None changed. `scripts/apply-migrations.sql` and `tests/migrationRecoverability.test.ts` are untouched.

## Skipped minors

None. The `contentReports.ts:591` minor is done (through `deps`, as explained above).

## Open questions

1. **Cross-PR merge (for #64).** Codex's round-3 matrix already flags `src/sync/realtimeChannel.test.ts` as a #63/#64 conflict. This round adds more tests to the takedown block of that file and changes the `fetchTopicEpoch` contract to `Promise<TopicEpochRead>`. Whoever rebases #64 should keep #63's `TopicEpochRead` shape. #64 doesn't call `fetchTopicEpoch` or `fetchRealtimeTopicEpoch` as of `origin/mh/launch-consent` (grep shows no references), so no code change is expected there beyond test-file conflict resolution.
2. **Decision 16 vs B1.3.** As the brief says, the client now leaves its channels on an authoritative denial. The server side is unchanged: still no forced disconnect, and the old topic simply goes silent. A client that ignores hints (the adversary) still sits on a silent topic; that is what the live test proves.
3. **Recovery after a denial race.** A denial stops the channel for good. If access comes back between the RPC's `null` and `CloudViewer`'s re-check (for example a lift within milliseconds), the re-check sees the same role, the viewer stays open, and live realtime stays off until the score is reopened. Committed marks still sync through the sync engine's own pulls. This fails closed, and I judged a restart hook not worth its code for this window; flagging it for Max.
4. **Forged hints.** Any editor can send `topic_rotated` on `doc:{id}`. While the epoch RPC is *healthy*, a forged hint costs one read and the hold lifts at once. While the RPC is *down*, it holds the owner's live ink until a read succeeds (fail closed). Each forged hint triggers one immediate read, but backoff isn't reset, and reads are serialized.
5. **`.env.local` and two local test failures.** These are pre-existing and environmental (see Checks). They may be worth fixing so `cloud:up` doesn't break the local suite, but that is outside this PR.

## Housekeeping

- The local stack was stopped with `npm run cloud:down` at the end.
- Pushed only to `mh/launch-legal-pages` (fast-forward) and to this report branch. No PRs created, no reviewers requested, no other session messaged, nothing hosted and no Stripe touched.
