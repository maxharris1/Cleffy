VERDICT: REVISE

PR: maxharris1/Cleffy#78, branch `mh/try-demo` @ `ce7541a967af7d55c6bbd9f450741cdbfc832f16`, base `dev` (`d0f15d13`). This is round 3 of 3 (final), Reviewer B (Claude). It reviews only the diff `886e367b..ce7541a9`: `src/features/demo/DemoViewer.tsx` (+14/−16) and `src/features/demo/DemoViewer.test.tsx` (+42). Every claim below was checked against a fresh worktree at `ce7541a9`. Accepted, not findings: the stand-in PDF, the two-tab shared `DEMO_DOC_ID`, and brief §7.

**Round-2 Introduced #1 (a failed read counts as "nothing left") is fixed.**
- `demoInkRemains` now rejects when the read fails (`DemoViewer.tsx:29-34`). It's an `async` arrow, so a synchronous throw from `getDb()` or the Dexie chain also becomes a rejection.
- `wipeDemoInk` maps that rejection to "ink may remain" and rethrows the purge's own error (`:53`). The viewport then stays unmounted and the session marker stays unset.
- Proof (step 4): I reverted just `.catch(() => true)` → `.catch(() => false)`. Both new tests fail: `2 failed | 15 passed (17)`. With the line restored, they pass.

**The fix's side effect:** it also locks out browsers where IndexedDB is refused outright. The PR discloses this as Follow Up #16. The two Lows below are what that trade-off left wrong around it: the visitor-facing copy and the docs.

CI at `ce7541a9` (local, Node 22, run by me):
- `npm run lint:check`: clean.
- `npm run typecheck`: clean.
- `npm run test`: 268 files, **4130 passed**, 22 skipped, 0 failed.
- `prettier --check` on both changed files: clean.
- `npm run build`: not re-run. The diff changes no imports and no bundling.

## Introduced

### 1. Low: the new fail-closed state tells a visitor whose browser refuses IndexedDB that their markings are "still saved", and offers a Try again that can never work
- **Explanation:** Before `ce7541a9`, IndexedDB refused outright meant this: the purge fails, the read fails, the read counts as 0, and the demo opens. Ink stays in memory, and `InkSaveFailedNotice` explains the failed saves. That's the private-browsing case the brief keeps the notice for (§3.4).
  - Now that same path ends in the `wipeFailed` EmptyState: "Couldn’t clear your markings" / "Your markings are still saved in this browser. Try again to start on a blank score."
  - Neither sentence holds for this visitor. Their browser has never stored anything and can't, and Try again fails every time, because `IDBFactory.open` keeps throwing.
  - The PR accepts the lock-out itself as a fail-closed trade-off (Follow Up #16), and round 2's expected fix prescribed it, so it isn't raised here. The copy is new with this commit, though. The case is now reachable, and it breaks the §5 voice rule ("says what happens next", never misleading): the page states something false and points at an action that can't succeed.
- **File:line:** `src/features/demo/DemoViewer.tsx:53` (an unknown read is now treated as "ink remains"); the copy is at `:258-261`.
- **Repro (I ran this against the real `DemoViewer`, real `purgeLocalDocument` and a real Dexie 4 on fake-indexeddb, using the PR's own test harness):** make `Dexie.dependencies.indexedDB.open` throw `DOMException('The operation is insecure.', 'SecurityError')`, which is what Firefox does when storage is blocked for a site. Then render a first visit (no marker, nothing ever stored) and click Try again three times.
  - At `ce7541a9`: the viewport never mounts, the marker is `null`, the body reads "Your markings are still saved in this browser. Try again to start on a blank score.", and after 3× Try again it's still a dead end.
  - At `886e367b` (same probe): the viewport mounts and the marker is `"1"`.
  - Dexie reports both the purge error and the read error as `DatabaseClosedError` with `inner.name === 'SecurityError'`. The round-2 transient case (a database closed under the page) gives `DatabaseClosedError` with `inner.name === 'DatabaseClosedError'`. These come from fake-indexeddb, not a real browser.
- **Expected fix:** Give the unknown case its own copy, which needs only a few lines.
  - `wipeDemoInk` should tell "ink remains" (the count read worked and found rows) apart from "couldn't check" (the read failed). For example, throw a small tagged error or return a result union, then pick the EmptyState copy from it.
  - For "couldn't check", don't claim anything is saved. Say what happens next, e.g. title "Couldn’t open the demo" with body "This browser isn’t letting the demo use its storage. Try again, or come back in a minute."
  - Add one test: purge and read both refused, then assert that the "still saved" copy isn't shown.
  - Re-opening the demo for storage-refused browsers (open on an in-memory store; Dexie's `inner.name` SecurityError/InvalidStateError is a possible signal) stays Follow Up #16. It isn't needed for this fix.

### 2. Low: the PR description's session-rules table and an existing test name now contradict the behaviour `ce7541a9` introduced
- **Explanation:**
  - The PR body's session-rules table still has the row "The wipe fails and the database can't be read at all | there's no old ink to show either, so the demo opens blank." Since `ce7541a9`, that case shows Try again, which the same description's Follow Up #16 says. The PR description is a §8 deliverable, and the table is where Max will read the session rules.
  - The test name `'a failed wipe with nothing stored to show still opens the demo (a browser that keeps no site data)'` now describes a browser that gets the opposite. A browser that keeps no site data refuses the read too (see the repro in #1), and since this commit it doesn't open. The test only models "deletes refused, reads work". The code wasn't changed in range, but its meaning was.
- **File:line:** PR #78 body, the "Session rules" table, last row; `src/features/demo/DemoViewer.test.tsx:202`.
- **Repro:** Read the table row against `DemoViewer.tsx:41-47` and `:53`. Then run the probe in #1: a no-site-data browser doesn't open.
- **Expected fix:** Change the table row to "…the database can't be read at all → the viewport stays down with Try again (fail closed; see Follow Up 16)". Rename the test to describe what it models, e.g. `'a failed wipe whose check reads no ink left still opens the demo'`.

## Follow Up

1. **Follow Up #16 is confirmed and quantified.** A browser that refuses IndexedDB outright now can't open `/try` at all (probe above; `886e367b` opened it). Modern private modes keep IndexedDB (in memory), so the reach is visitors who block site data for the origin. That's small for in-app ad browsers, and the PR accepts it. If it ever matters, open on an in-memory store that never hydrates from Dexie, keyed on Dexie's open-failure `inner` (SecurityError/InvalidStateError/MissingAPIError). The transient-closed case keeps failing closed, so the round-2 bug stays fixed. The error names above came from fake-indexeddb, so confirm them in Firefox and Chrome with site data blocked first.
2. **The round-2 Follow Ups touched by this diff are still open, and the diff doesn't worsen them.**
   - #14 (a Dexie query lives in a UI component): `demoInkRemains` is still in `DemoViewer.tsx`. Moving it beside `purgeLocalDocument` would also be the natural place to return the "remains vs unknown" result that Introduced #1 needs.
   - #15 (`Phase` × `wipeFailed`): if Introduced #1 adds a failure kind, folding it into the phase (`{ kind: 'preparing' | 'clearing'; failure: null | 'remains' | 'unknown' } | { kind: 'ready' }`) keeps the illegal states out.
3. **The new tests prove the read-failure half on a closed DB, not a refused open.** Both new tests fake the purge failure through the gate (`refuseDeletes`) and make the read fail with `db.close({ disableAutoOpen: true })`. That matches the round-2 repro and is enough for the fix. The "IndexedDB refused outright" path (Introduced #1) has no test, so whatever the PR decides for it, add one with the `Dexie.dependencies.indexedDB.open` spy below.

## Blast radius (step 1)

- **What it does:** Only one decision changes: "a purge failed, and then the leftover check couldn't read". It used to mean nothing is left, so open. Now it means ink may be left, so the viewport stays down. `demoInkRemains`/`wipeDemoInk` have no other callers (`grep -rn` across `src/` finds only `DemoViewer.tsx`). The first-load and Start over effects consume the change through the same `wipeDemoInk`. No imports, bundling, routes, storage keys or Supabase paths changed.
- **The one fact it's safe because of:** a failed read can no longer let a failed purge count as done. **Proven (step 4):** with the mutation `.catch(() => true)` → `.catch(() => false)`, both new tests fail (`2 failed | 15 passed`). Restored, all 17 pass. `async` also turns a sync throw into a rejection. That isn't exercised, because the harness mocks `getDb`, so it's step 3 (by the language).
- **Risks:**
  - IndexedDB refused outright → a permanent dead end with false copy (Introduced #1). Proven at step 4 by the probe, against `886e367b` as the control.
  - The docs drift (Introduced #2). Step 2.
- **Cleared:**
  - Marker handling: a rejection propagates out of `startDemoSession` before `markSessionStarted`, so a reload retries (`demoSession.ts:89-92`). Asserted by the new first-load test (`marker === null`).
  - Start over: the order is still unmount before purge (`h.events` is `['unmount', 'purge']`). After recovery, Try again remounts on an empty store with `canUndo === false` (new test).
  - Idempotence: Try again re-runs the same wipe from current state. It converges once storage works (both new tests, after `db.open()`).
  - The existing "fails with nothing stored → opens" case (the read works and returns 0) is still green.
  - `AnnotationStore.load()` doesn't cache a failed hydration (`annotationStore.ts:141-149`). That's why mounting on an unknown read was unsafe in round 2, and failing closed is the right call for the transient case.
  - Step 3 items (Supabase, bundle, SW, motion, 44px, LocalViewer): untouched by this diff.

## Principles (step 2)

- **fix-root-causes:** Pass. The fault was coercing a failed read into `false`, and the fix is at that decision, not downstream. I searched for the same pattern in the diff and found none. The hint effect's `.load().catch(() => undefined)` (`:196`) only decides whether the hint shows, which is harmless.
- **boundary-discipline:** Unchanged; see Follow Up 2 (#14).
- **test-behavior-not-implementation:** Pass. The new tests assert observable outcomes: the heading shown, no viewport, the marker, an empty store after recovery, and `canUndo`. Each catches the mutation above. `['unmount', 'purge']` pins the order the brief requires, which is the contract, not an internal detail. Introduced #2 covers the test name.
- **prove-it-works:** The author's claims check out: the CI numbers match my run (4130 passed). The mutation and the IndexedDB-refused probe were run by me; the scripts are below.
- **subtract-before-you-add:** Pass. The two-callback `.then` became a plain `async` expression, which is simpler.
- **type-system-discipline:** Follow Up 2 (#15). `wipeDemoInk`'s rejection carries no "remains vs unknown" distinction, and Introduced #1 needs one.
- **make-operations-idempotent:** Pass (see Cleared).

## Probe used (re-runnable)

I put this in `src/features/demo/probe-r3b.test.tsx` in a scratch worktree. It reuses the harness of `DemoViewer.test.tsx`, everything above its first `describe`, plus `import Dexie from 'dexie'`:

```tsx
const breakIndexedDb = () =>
    vi.spyOn(Dexie.dependencies.indexedDB!, 'open').mockImplementation(() => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
    });

it('first visit, IndexedDB refused outright', async () => {
    h.db = new ScribblerDb(`probe-${crypto.randomUUID()}`);
    breakIndexedDb();
    renderDemo();
    await waitFor(() => expect(h.events).toContain('purge'));
    await new Promise((r) => setTimeout(r, 200));
    // ce7541a9: no viewport, heading "Couldn’t clear your markings", marker null,
    //           body "Your markings are still saved in this browser. …"; 3× Try again → still stuck.
    // 886e367b: viewport mounted, marker "1".
});
```

The error names came from a second probe: a delete and the leftover-count read against a `ScribblerDb` with `open` spied to throw both give `DatabaseClosedError` with `inner: SecurityError`. After `close({ disableAutoOpen: true })`, the read gives `DatabaseClosedError` with `inner: DatabaseClosedError`, and after `open()` the count reads `0`.
