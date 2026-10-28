VERDICT: REVISE

# PR #78 round 1, Reviewer B (blast radius and principles)

PR: maxharris1/Cleffy#78, `mh/try-demo` @ `bec4d7e`, base `dev` @ `d0f15d1`. Read-only review. Nothing was posted to the PR.

**Checks run on the PR head:** `npm run lint:check`, `npm run typecheck`, `npm run build` and `npm run test` all pass (266 test files passed, 6 skipped; 4106 tests passed, 22 skipped).

**What I ran beyond reading:**
- **Proof tests** (vitest, with a scratch config outside the repo, not committed): the real `purgeLocalDocument` against the real `AnnotationStore` on `local-demo-v1`, and a render of `InkSaveFailedNotice` the way the demo uses it.
- **Playwright run** against a local production build. `VITE_SUPABASE_URL` pointed at an unused `127.0.0.1` port, and every request to that port or off localhost was aborted and logged. No screenshots or recordings.
- **Chunk comparison:** a `dev` build in a worktree against the PR build.

## Blast radius

**What it does:**
- **New route.** A lazy `/try` route (`DemoPage`) fetches `/demo/fur-elise.pdf?v=local-demo-v1`, checks the PDF magic, and registers the bytes under `DEMO_DOC_ID` in `localDocs`.
- **Lazy viewer.** It then lazy-loads `DemoViewer`. That gates the viewport on `startDemoSession`, which wipes via `purgeLocalDocument(DEMO_DOC_ID, { heldInk: 'discard' })`.
- **Shared frame.** `LocalViewer`'s body moves into `LocalViewerFrame`, which `DemoViewer` also uses.
- **Service worker.** A new `demo-score` CacheFirst rule.
- **Landing page.** A new "Try it — no sign-up" link.
- **The part the diff doesn't spell out.** The wipe calls `forgetDocInk`, which moves `local-demo-v1`'s doc epoch in `inkRecovery` and drops any held ink for the demo in this tab.

**The one fact it's safe because of:** Start over and the first-visit wipe can't be beaten by a stroke whose write is still in flight. `purgeLocalDocument(..., { heldInk: 'discard' })` calls `forgetDocInk` *synchronously, before any delete*. That moves the doc epoch (`src/sync/inkRecovery.ts:1444-1447`, `closeDocEpoch` at :217). Every edit captured `editBoundTo(author, docId)` at its start (`src/sync/annotationStore.ts:1189`), and `writeQueue` checks it before the write and again on failure (`inkRecovery.ts:1006`, `:1021`), with further checks inside the transaction (`:906-924`). So a cut-off write lands nothing. The new store on the same id can still draw, because each edit takes the *current* epoch.

**Proven to level 4 and level 5:**
- **Level 4 (script).** A stroke's mirror+outbox transaction was held open, the real `purgeLocalDocument(DEMO_DOC_ID, { heldInk: 'discard' })` ran, then the gate was released. Result: the in-flight `create` settled with `RecoveryCancelled`. `annotations` and `ops` for `local-demo-v1` both had 0 rows. A fresh `AnnotationStore` hydrated with `annotatedPages() = []` and `canUndo = false`, and could then store a new stroke (1 row).
- **Level 5 (running app).** iPhone SE context with touch, prod build:

```
1 url after load: /try?utm_source=tiktok&utm_campaign=x      (URL and UTMs kept)
1 title: Try Cleffy
1 finger toggle pressed: true
1 ink rows after touch swipe: 1                              (finger draws)
1 hint visible after stroke: false
1 header overflow (scrollWidth, innerWidth): 320,320
2 refresh, ink rows: 1                                       (refresh keeps)
3 new tab (keep off), ink rows: 0                            (new session wipes)
5 new tab (keep on), ink rows: 1                             (keep survives)
6 after Start over, ink rows: 0 ; undo disabled: true
finger: local doc off -> demo on -> local doc off ; local doc on -> demo on (user turns off) -> local doc on
supabase-host requests: 0   other off-host requests: 0       (signed-out visitor)
```

**Cleared (checked and fine):**
- **Wipe before mount.** The viewport doesn't render until the wipe settles: `showViewport={phase === 'ready'}`, phase starts `'preparing'` and becomes `'ready'` only in `startDemoSession(...).finally` (`DemoViewer.tsx:67-82`, `:160`). Under StrictMode a double run wipes twice, which is harmless because the purge is idempotent. The marker is set only after the wipe resolves (`demoSession.ts:78-85`).
- **Start over order.** The purge runs in an effect *after* the commit that unmounted the viewport (`DemoViewer.tsx:87-103`). A new `viewportKey` gives a new `AnnotationStore` and an empty `UndoStack`, as proven above.
- **Supabase in the demo chunk.** `DemoViewer` imports `documentsService`, which imports `@/lib/supabase`. `getSupabase()` is lazy (`src/lib/supabase.ts:92`), and that chunk was already in the shell's preload list on `dev`. No new module-init client or request; 0 Supabase requests observed.
- **Shell bundle.** `index-*.js` grew from 308,070 to 308,703 bytes (+633: the route stub). The preload list gains two tiny re-split chunks, `lazyModule` (1.5 KB, really `staleChunk`) and `presenceName` (126 B), and `Dialog` shrank to match. Net +828 bytes across the shell. pdf.js (`pdf-*.js`) is not in the shell. The viewer body moved from `ViewerPage` (188 KB → 86 KB) into a shared chunk named `ViewerHeader-*.js` (104 KB) that both the doc viewer and the demo load.
- **LocalViewer behaviour.** `ViewerPage.tsx:1327-1350`'s JSX is identical apart from where the `noticeInset` state lives. It still uses `key={docId}`, and its early-return branches are unchanged. A local open via the landing input still mounts the viewer with finger drawing off.
- **Finger-draw restore.** `useViewerStore` has no reset path that touches `fingerDraws` (`src/state/store.ts:149,161`). The only readers are `Toolbar.tsx:69` and `InkController.ts:410`, both live. The restore works in both directions in the browser (see the log above).
- **SW rule.** `CacheableResponse` requires exact header equality (`node_modules/workbox-cacheable-response/CacheableResponse.js:88-90`). Vercel serves `.pdf` as exactly `application/pdf`. An SPA-rewrite HTML 200 can't be cached as the score, and if the header ever differs, the rule fails safe (no offline copy). The `?v=` query is part of the cache key, so bumping `DEMO_DOC_ID` busts it.
- **Background drain.** It filters `isCloudDocId` (`src/sync/backgroundDrain.ts:267`), so demo ops are never uploaded for a signed-in visitor. `signOutSync` leaves `local-` ids alone.
- **Hint motion.** `library-row-in` animates transform and opacity at 220 ms with the house ease-out, and falls back to `ui-fade-in` under reduced motion (`src/index.css:634`, `:405`, `:40`, `:45`).

## Introduced

### Medium: the demo's "couldn't save" notice tells the visitor to "export a copy", and the demo has no Export
- **Explanation:** `DemoViewer` renders `<InkSaveFailedNotice store={annotationStore} />` with no `onExport`. The notice hides the Export *button* in that case, but its *copy* is chosen by `copy(state, retryFailed, exportable)`, and `exportable` comes from held-ink counts, not from whether `onExport` exists (`InkSaveFailedNotice.tsx:133`, `:142`).
  - **Two states the demo can reach:**
    - Held ink plus a failed Retry: "Still not saved. Storage may be full: export a copy." / "…Export a copy to keep them."
    - Overflow: "Too many unsaved marks: new ones weren't made. Export a copy."
  - **Why it matters here:** the brief keeps this notice in the demo for exactly the IndexedDB-failure/private-browsing case, so this is the path it exists for. The copy sends the visitor to an action that isn't there, which breaks the voice rule "says what happens next". On `dev` the cloud viewer only hits this briefly, until `confirmed`; this branch is the first caller that omits `onExport` permanently.
  - **Principles:** fix-root-causes (the copy decision ignores whether Export exists; dropping the button treated the symptom) and prove-it-works.
- **File:line:** `src/features/demo/DemoViewer.tsx:193`; root cause in `src/features/viewer/InkSaveFailedNotice.tsx:133,142`, with copy at `:46-50`, `:70-74`.
- **Repro (ran it):** render `<InkSaveFailedNotice store={store} />` with a `local-demo-v1` store whose `db.ops.bulkAdd` rejects with `QuotaExceededError`, call `store.create(stroke)`, then click Retry. Output:
  `PROOF notice copy: ["Still not saved. Storage may be full: export a copy.","Some marks couldn't be saved on this device. Retrying didn't work, so this device may be out of storage. Export a copy to keep them."]` and `PROOF Export button present: false`.
- **Expected fix:**
  - **Gate the copy.** Use `exportable && onExport !== undefined` (and the same for the conflicts branch) as `copy`'s third argument.
  - **Add a no-export variant for held + retry-failed**, in the voice of the overflow one, e.g. "Some marks couldn't be saved on this device, and retrying didn't work. Free up storage, then Retry."
  - **Add a unit test** for the no-`onExport` render. This also fixes the cloud viewer's pre-`confirmed` window.

### Medium: the demo's core session behaviour has no automated test; only `demoSession`'s decision is covered
- **Explanation:** The brief calls the wipe-before-mount gate and Start over "the core logic". `demoSession.test.ts` covers the decision table (good, behaviour-level), but these live in `DemoViewer` effects and nothing in CI exercises them:
  - **(a)** No viewport, and so no `AnnotationStore` hydration, until the wipe resolves.
  - **(b)** Start over unmounts the viewport *before* the purge runs, then remounts with a fresh key, giving an empty store with no undo.
  - **(c)** `fingerDraws` is restored on unmount.
  - **(d)** The hint hides on the first committed stroke, and stays hidden for kept ink.

  Break-the-behaviour check: initialise `phase` to `'ready'`, call `wipeDemoInk()` in `startOver` before `setPhase('clearing')`, or drop the restore in the `fingerDraws` cleanup. All 4106 tests still pass. I verified (a)–(c) by hand in the browser (see the log above), but that proof isn't in the repo. The routes test mocks `DemoViewer` out entirely (`src/app/routes.test.tsx`). Principles: test-behavior-not-implementation and prove-it-works.
- **File:line:** `src/features/demo/DemoViewer.tsx:53-103`, `:135-140` (no `DemoViewer.test.tsx`).
- **Repro:** change `useState<Phase>('preparing')` to `useState<Phase>('ready')` at `DemoViewer.tsx:43`, then run `npm run test`. It's green.
- **Expected fix:** add `src/features/demo/DemoViewer.test.tsx`:
  - **Setup:** mock `PdfViewport` with a stub that records mounts and calls `onStoreReady` with a real `AnnotationStore` on a test `ScribblerDb`, and mock `purgeLocalDocument` with a deferred promise.
  - **Assert (a):** no viewport is mounted while the purge is pending, and it mounts after it resolves.
  - **Assert (b):** after Start over → Clear, the stub unmounts before `purgeLocalDocument` is called, then remounts once, and the new store has `canUndo === false`.
  - **Assert (c):** unmounting `DemoViewer` restores the previous `fingerDraws` (test both `false` and `true` as the prior value).
  - **Test the outcome, not the internals:** keep these on what the visitor sees, i.e. the mount order and the store state.

### Low: "Keep my markings" can show on while nothing was saved
- **Explanation:** `toggleKeep` calls `writeKeepMarkings(!keep)` and then `setKeep(!keep)` whether or not the write landed. `writeKeepMarkings` swallows the failure (`demoSession.ts:39-49`). Where `localStorage` throws (site data blocked, some private modes), the box shows ticked and the "Saved in this browser only." help sits beside it, but the next session wipes anyway. The UI says the opposite of what will happen. Principle: boundary-discipline (the boundary swallows the result that the caller needs).
- **File:line:** `src/features/demo/DemoViewer.tsx:142-145`; `src/features/demo/demoSession.ts:39-49`.
- **Repro:** block `localStorage` (`vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw … })`), render `DemoViewer` and click "Keep my markings": `aria-pressed` becomes `true`, and `readKeepMarkings()` is still `false`.
- **Expected fix:** set the state from storage after the write: `writeKeepMarkings(next); setKeep(readKeepMarkings());`. Or have `writeKeepMarkings` return whether it stuck, and keep the toggle off (optionally with a short line such as "This browser isn't keeping site data, so markings clear when you close it.").

### Low: a failed Start over looks like it worked, then the old ink comes back with no word
- **Explanation:** If `wipeDemoInk()` rejects, the effect only `console.warn`s. It still bumps `viewportKey` and returns to `'ready'`, so the visitor sees "Clearing your markings…" and then the same ink again, with no message. Copy voice asks the UI to say what happens next. Principle: fix-root-causes (an error swallowed into an ordinary success state).
- **File:line:** `src/features/demo/DemoViewer.tsx:92-99`.
- **Repro:** make `purgeLocalDocument` reject (e.g. `vi.spyOn(db.annotations, 'where')` to throw), then Start over → Clear: the ink reappears and no notice shows.
- **Expected fix:** on rejection, show a `ViewerNotice` such as "Couldn't clear your markings. Try again." with a Try again action, or keep the confirm strip open with that line.

### Low: the error state blames the connection when the score itself is missing
- **Explanation:** `loadDemoScore` rejects for a 404 or for the SPA rewrite's `index.html` (a deploy fault the visitor can't fix). The copy is still "Check your connection, then try again — it takes a second." The brief lists 404 as one of this state's causes. "It takes a second" also promises something a 404 won't keep.
- **File:line:** `src/features/demo/DemoPage.tsx:96-97`.
- **Repro:** `routes.test`-style render with `fetch` resolving `new Response('Not found', { status: 404 })`: the body reads "Check your connection…".
- **Expected fix:** keep the offline line for `navigator.onLine === false` or a `TypeError` from fetch. For an HTTP or not-a-PDF failure, use something like "The demo score didn't load. Try again, or come back in a minute." and drop "it takes a second".

### Low: a test restates a constant
- **Explanation:** `expect(DEMO_PDF_REQUEST_URL).toBe(`${DEMO_PDF_URL}?v=${DEMO_DOC_ID}`)` rebuilds the expected value with the same template literal the module uses. It can't catch a broken cache-bust: for example, a service-worker `urlPattern` that stops matching `?v=`, or a fetch that drops the query, would both pass. The fetch test at `:31-44` already asserts `fetch` was called with `DEMO_PDF_REQUEST_URL`. Principle: test-behavior-not-implementation ("a restated constant").
- **File:line:** `src/features/demo/demoScore.test.ts:24-26`.
- **Repro:** change `DEMO_PDF_REQUEST_URL` to `DEMO_PDF_URL` and the SW `urlPattern` to anything at all: this test still passes, and nothing checks the pairing.
- **Expected fix:** delete it, or replace it with an invariant that runs real code: the `vite.config.ts` `demo-score` `urlPattern` matches `DEMO_PDF_REQUEST_URL` and does not match `/demo/fur-elise.html`.

## Follow Up

- **If the wipe on mount fails, the viewer opens on leftover ink** (`DemoViewer.tsx:63-78`). This is a deliberate trade-off, documented in the comment, but it contradicts `demoSession.ts`'s own docstring ("a visitor must never land on someone's leftover ink"). It's unlikely in practice: a delete that fails on the same connection usually means the read fails too. Consider failing closed only when the wipe was *required* (`wiped: true`) by showing a blank, read-only state, or at least logging it so it's visible.
- **The marketing guardrail rests on production flags.** The demo reuses `PdfViewport`/`Toolbar` unchanged, so turning on `VITE_FEATURE_PLAYALONG` or `VITE_FEATURE_FINGERING` for a release would surface play-along and the Fingering tool *inside the demo*, which the brief's §5 rules out. There's no demo-specific suppression. Worth a `demo`/`minimalChrome` prop on the viewport before either flag ships. This is out of scope per the brief ("just don't add new entry points").
- **Signed-in visitor on `/try`.** The app shell's `BackgroundSync` and supabase-js token refresh still run for a signed-in session on any route, `/try` included (`src/app/BackgroundSync.tsx:15-52`, `src/main.tsx:30`). That predates this PR and isn't the demo's own traffic. I verified "zero Supabase requests" only for a signed-out visitor.
- **Tool and zoom carry over from in-app navigation.** `tool` is shared zustand state and the demo doesn't reset it, so a user who arrives at `/try` from a score with the eraser or highlighter selected lands without the pen. An ad visitor on a fresh load gets the pen. If "pen ready" should hold for in-app arrivals too, do the same remember/restore as `fingerDraws`.
- **subtract-before-you-add nit.** `startDemoSession` returns `{ wiped }`, which only tests read (the caller at `DemoViewer.tsx:72` ignores it). The tests already assert the wipe through the spy. Return `void` and drop the redundant assertions, or use `wiped` for the fail-closed idea above.
- **type-system-discipline nit.** `LocalViewerFrame` takes `showViewport?: boolean` plus a `placeholder?: ReactNode` that only means something when `showViewport` is false (`LocalViewerFrame.tsx:33-34`). A single `placeholder?: ReactNode` (rendered in place of the viewport when present), or a discriminated prop, would make the illegal combinations unrepresentable.
- **A11y nits.** "Start over" has `aria-expanded` with no `aria-controls` or popup (`DemoViewer.tsx:173`). The phone menu's keep item is a plain `menuitem` with sr-only "(on)/(off)" text; `menuitemcheckbox` with `aria-checked` would be the native pattern.
- **ConfirmClear Escape.** It listens on `document` with no `stopPropagation` (`DemoViewer.tsx:273-281`). Any other document-level Escape handler (`PdfViewport.tsx:1007`) also fires. Harmless today; worth checking if the viewport ever binds Escape to something destructive.
- **Already accepted:** the stand-in PDF, the shared `DEMO_DOC_ID` across two tabs, and everything in brief §7.

## Proof script (re-runnable, not committed to the PR)

```ts
// Run with a vitest config whose include points at this file; the alias '@' maps to src.
const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/sync/db', async (orig) => ({ ...(await orig<typeof import('@/sync/db')>()), getDb: () => h.db }));
// db = new ScribblerDb(random); h.db = db; store = new AnnotationStore(db, DEMO_DOC_ID); setAuthor(null); await load();
// gate db.transaction calls that include db.ops; const inflight = store.create(stroke('late')).catch(e => e);
// await purgeLocalDocument(DEMO_DOC_ID, { heldInk: 'discard' }); release();
// expect(await inflight).toBeInstanceOf(RecoveryCancelled-like);  // logged: RecoveryCancelled
// expect annotations/ops count 0; new store: annotatedPages() == [], canUndo false; new create → 1 row.
```
