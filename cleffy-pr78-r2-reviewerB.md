VERDICT: LGTM

PR: maxharris1/Cleffy#78, branch `mh/try-demo` @ `886e367b8215a519aaedb00b44735c6554cb8465`, base `dev` (d0f15d13). Round 2, Reviewer B (Claude). Diff-only: `bec4d7eb..886e367b` (fix commits `bbd89010` + `886e367b`, 13 files, +909/−190). Reviewed in a fresh worktree of the PR head. Steps 1–2 (blast-radius, principle checklist) were the main job; step 3 was checked where the diff touches it. Accepted, not findings: the stand-in PDF, the two-tab shared `DEMO_DOC_ID`, and brief §7.

## Round-1 Introduced findings: verification

| # | Round-1 finding | Status | Evidence (proof level per blast-radius) |
|---|---|---|---|
| 1 | Failed wipe still mounts the viewer (first load, Start over) | **Fixed** | `DemoViewer.tsx:51-60` `wipeDemoInk` rethrows when old ink remains; `:126-150` and `:157-179` set `wipeFailed` and keep `showViewport` false; `:258-267` EmptyState "Couldn’t clear your markings" + Try again (`attempt` re-runs the effect). Session marker stays off on failure (`demoSession.ts:87-93`). Ran: the new tests plus my probes (below) and mutations M3/M4 turn the suite red. Level 4. |
| 2 | Keep toggle shows on when the choice wasn't saved | **Fixed** | `writeKeepMarkings` reads back and returns `boolean` (`demoSession.ts:42-53`); `toggleKeep` sets state from storage on failure and raises a notice (`DemoViewer.tsx:220-230`); help copy switches in both the header toggle and the phone menu (`:240`, `:287-288`). Tests: `DemoViewer.test.tsx:329-361`, `demoSession.test.ts`. Mutation M5 turns the suite red. Level 4. |
| 3 | New controls under 44px on touch | **Fixed** | `hit-44-y` on Start over, Keep, Start free, Clear, Cancel; `hit-44` + `pointer-coarse:mx-1` on the phone menu trigger; the refusal notice uses `CloseButton` (built-in `hit-44`). Measured in headless Chromium (iPhone SE, touch, bounding boxes only, no screenshots): Start over 82×36 with a 44px `::after`, the menu trigger 32×32 with a 44×44 `::after`, Start free 91×36 with a 44px `::after`, Clear/Cancel 64/74×36 with a 44px `::after`; `scrollWidth == innerWidth == 320`, so no overflow. Level 5. |
| 4 | Save-failed notice tells demo visitors to export | **Fixed** | `InkSaveFailedNotice.tsx:48-111` takes `canExport = onExport !== undefined` (`:164`): overflow, held + retry-failed and conflicts all have Export-free copy, and the Dismiss title drops "Export" (`:202`). Discard is already gated on `onExport` (`:208`). Three new tests (`InkSaveFailedNotice.test.tsx:257-319`) assert no `/export/i` text. The cloud viewer's pre-`confirmed` window benefits too (`ViewerPage.tsx:1073-1076`). Level 4. |
| 5 | DemoViewer session behaviour untested | **Fixed** | New `DemoViewer.test.tsx` (15 tests): real `purgeLocalDocument` behind a gate, a stub viewport with a real `AnnotationStore`. Mutation check (each applied alone, then reverted): M1 initial phase `'ready'` → 4 red; M2 drop the `fingerDraws` restore → 1 red; M3 remount on a failed Clear → 1 red; M4 swallow the first-load failure → 2 red; M5 ignore the write result → 1 red; M6 the hint never hides → 2 red. The round-1 repro no longer stays green. Level 4. |
| 6 | Error state blames the connection on a 404 | **Fixed** | `DemoScoreUnavailableError` for HTTP/not-a-PDF (`loadDemoScore.ts:9-11,40-46`); `failureCopy` (`DemoPage.tsx:31-38`) gives "The demo score didn’t load. Try again, or come back in a minute." for `missing`, and an offline or connection line otherwise. "It takes a second" is gone. Test: `routes.test.tsx:167-187`. Level 4. |
| 7 | Test restates the cache-bust constant | **Fixed** | `DEMO_SCORE_CACHE_PATTERN` now lives in `demoScore.ts:85` and `vite.config.ts:306` uses the same object, so the test exercises the regex the worker ships (`demoScore.test.ts:15-31`): it must match the real request URL and must not match `/try`, `/try?utm…`, `.html`, `.pdf.js` or `/doc/local-demo-v1`. Level 4. |

## Blast radius

**What it does.** It moves the fail-closed decision into `wipeDemoInk`, which rejects only when a purge failed *and* undeleted demo rows remain. It holds the viewport unmounted on either wipe path until a wipe succeeds. It makes the keep and session-marker writes report whether they stuck, and makes `InkSaveFailedNotice` copy depend on whether an Export exists. It splits `loadDemoScore` into its own module with a typed "missing" error, and imports the SW cache regex into `vite.config.ts` from a leaf `src` module. The non-obvious part: `wipeDemoInk` deliberately *resolves* a failed purge when nothing remains to show (a browser that keeps no site data fails every IndexedDB op), so the fail-closed rule depends on a second query that mirrors store hydration.

**The one fact it's safe because of.** *A store hydrating `local-demo-v1` after `wipeDemoInk` resolves shows no earlier ink.* Hydration (`annotationStore.ts:152-186`) draws two things: non-tombstoned `annotations` rows by `docId`, and held ink from `inkRecovery`. `purgeLocalDocument` drops held ink synchronously, before any Dexie op (`documentsService.ts:690-694`). `demoInkRemains` (`DemoViewer.tsx:30-39`) counts exactly the non-tombstoned rows by `docId`, and `foreign` rows can only over-count, which fails closed. **Proven at level 4** with a throwaway probe beside the PR's own test (not committed), run against the real `purgeLocalDocument` and `AnnotationStore` on fake-indexeddb:
```
P1 one unrelated table (pdfCache) refuses its delete, annotations deleted → events ["purge","mount"], store.annotatedPages() == []   ✓ (no false alarm, opens blank)
P2 only a tombstoned row left, all deletes refused → viewport mounts, annotatedPages() == []                                          ✓
existing: all deletes refused, live row present → "Couldn’t clear your markings", no mount, session marker null                     ✓
P4 failed Clear → buttons: ["Für Elise — demo","Start over(disabled)","Keep my markings","Demo options","Try again"]              ✓ (see Follow Up 1)
Test Files 1 passed, Tests 4 passed
```
P1 also shows the early-rejecting `Promise.all` doesn't let the count run ahead of the in-flight annotations delete. That holds for fake-indexeddb's transaction ordering; IDB orders a later read-only transaction on the same store after an earlier read-write one, so real browsers should agree. That last step is level 3, not run in a real browser.

**Risks.** No new Introduced risks found. The non-blocking ones are under Follow Up.

**Cleared.**
- *SW cache stores the SPA's index.html under the PDF URL.* `cacheableResponse` requires status 200 **and** `content-type: application/pdf` (`vite.config.ts:310`), so a rewrite to index.html isn't kept. The comment's timing claim (cached from the first *controlled* load) now matches `lib/serviceWorker.ts`, which also closes round-1 Follow Up 3's comment half.
- *`vite.config.ts` importing from `src/`.* `demoScore.ts` has no imports (comment at `:1-5`). Lint, typecheck and build pass, and the build reads the config.
- *Escape on the confirm strip leaking to the viewer.* `ConfirmClear` listens on `document` and calls `stopPropagation`, and `PdfViewport`'s key handler is on `window` (`PdfViewport.tsx:1006`) and skips `defaultPrevented`, so Escape stops there. Test `DemoViewer.test.tsx:271-288`. That closes round-1 Follow Up 10.
- *Shared `attempt` counter between the two wipe effects.* Each effect returns early unless its own phase is current, so a Try again only re-runs the stuck one.
- *Zero Supabase requests on `/try`.* Vite dev, signed out, iPhone SE: 0 requests left the origin. supabase-js is still in the module graph (round-1 Follow Up 2, unchanged), but no request is made.
- *Header fit at 320px.* `scrollWidth` 320 equals viewport width, and the iPad (810) and desktop layouts measured clean. Title "Try Cleffy", and the UTM query is kept on the URL.
- *`InkSaveFailedNotice` callers.* Three call sites (`ViewerPage.tsx:1073`, `:1349`, `DemoViewer.tsx:314`). Only callers without `onExport` see new copy, and LocalViewer always passes one, so its behaviour is unchanged.

**Before you merge.** The probe above is the cheapest guard if hydration ever starts reading another table: add a P1-style case (one unrelated table refuses, annotations deleted → opens blank) to `DemoViewer.test.tsx`.

## Principle checklist (diff only)
- **fix-root-causes:** OK. Round-1 #4 is fixed at the root (`InkSaveFailedNotice` copy), not in a demo-side wrapper. The swallowed purge error in `wipeDemoInk` covers a legitimate state (no site data at all) and is documented.
- **boundary-discipline:** one soft spot. `demoInkRemains` puts a Dexie schema query (table, index, `deletedAt`) in a UI component and duplicates the hydration rule. Follow Up 2.
- **test-behavior-not-implementation:** the new tests assert outcomes (mount order, store contents, `canUndo`, storage, visible copy), and the mutations above prove they bite. The exception is the touch-target test, which is a class-name proxy. Follow Up 3.
- **prove-it-works:** CI ran on the PR head (results below), plus mutations, probes and in-browser measurements.
- **subtract-before-you-add:** `startDemoSession` still returns `wiped`, which only tests read (round-1 Follow Up 7, unchanged). Moving `loadDemoScore` out of `demoScore.ts` is a net subtraction from the leaf.
- **type-system-discipline:** `Phase` + `wipeFailed: boolean` can represent `ready && wipeFailed`. Follow Up 4. `Failure` and `StorageRefused` are good closed unions.
- **make-operations-idempotent:** first-load wipe: the marker goes on only after a successful wipe, so a reload re-runs it and converges. Try again re-runs the same idempotent purge. OK.

## CI on the PR head (fresh worktree, 886e367b)
- `npm run lint:check`: pass
- `npm run typecheck`: pass
- `npm run test`: pass (268 files passed, 6 skipped; 4128 tests passed, 22 skipped). A first run went red in 2 DemoViewer tests only because my mutation M6 was applied while it ran; a clean re-run on an unmodified tree (`git diff` empty at 886e367) is green.
- `npm run build`: pass. Bundle check: the shell `index-*.js` contains neither `local-demo-v1` nor pdf.js; `DemoPage`, `DemoViewer`, `demoScore` and `pdf` are separate chunks.
- Targeted: `src/features/demo`, `InkSaveFailedNotice.test.tsx`, `routes.test.tsx`: 6 files, 61 tests pass.

## Introduced

none

## Follow Up

1. **Low: a failed Start over is a dead end until the wipe works.** After Clear fails, the only controls are a disabled Start over and Try again (probe P4). The visitor's ink is still stored, but there's no way back to it short of a reload, which works because the marker is set, or Back to home. It's rare, since it needs deletes failing while reads work. Consider a "Keep my markings" or Cancel action on that EmptyState that remounts without wiping (`DemoViewer.tsx:258-267`).
2. **Low: `demoInkRemains` duplicates store hydration in the UI layer** (`DemoViewer.tsx:30-39`). If hydration ever reads another table, or held ink outlives the purge, this guard passes silently and the fail-closed promise breaks. Move it next to `purgeLocalDocument`, or into the sync layer, e.g. `purgeLocalDocument(..., { failIfInkRemains: true })` or `hasStoredInk(docId)`, and test it there.
3. **Low: the touch-target test asserts class names, not sizes** (`DemoViewer.test.tsx:364-391`). The regex accepts `pointer-coarse:hit-44-y`, which grows height only, so a control under 44px wide passes (probe P5). It also fails on a refactor to another valid utility. jsdom can't measure, so either keep it as a lint-style guard and say so in its name, or move the check to the ui-check/Playwright pass (the measurements above).
4. **Low: `Phase` × `wipeFailed` can represent `ready` + failed** (`DemoViewer.tsx:67,97`). Folding failure into the phase (`{ kind: 'preparing' | 'clearing'; failed: boolean } | { kind: 'ready' }`) makes it unrepresentable and drops the separate reset in `retryWipe`.
5. **Nit (copy accuracy): "This browser isn’t keeping site data…" also shows for a full `localStorage`** (`QuotaExceededError`, `DemoViewer.tsx:80-83`). That's not quite "not keeping site data". And when IndexedDB is blocked too, the ink clears on reload, not only on close. "This browser couldn’t save that choice, so your markings clear when you close it." covers both.
6. **Carried from round 1, unchanged by this diff:** Follow Ups 1, 2, 4, 5, 6, 7, 8 and 9 (the menu `menuitemcheckbox`; round-1 FU 9's `aria-controls` half is now fixed at `DemoViewer.tsx:282`). Round-1 FU 3's comment half is fixed. Priming the cache on the first visit is still open.
