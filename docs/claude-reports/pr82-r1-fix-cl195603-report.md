Status: Done
TIP=08c79c420bb4e2e7017d9634e71393d20e1b6f6f

# PR #82 fix round r1 (tag pr82-r1-fix-cl195603) — Claude cloud fixer

- PR head checked before work and before push: `agent/fullscreen-performance-mode` = `e05f94a95b081ff14b89ca44d636eda265142916` (unchanged).
- Staging branch pushed: **`claude/pr82-r1-fix-cl195603-yocqaq`** (harness suffix), fast-forward from `e05f94a`, tip `08c79c420bb4e2e7017d9634e71393d20e1b6f6f`. Nothing pushed to the PR branch, `dev` or `main`; no history rewrite.
- Commits authored as Max Harris <drumaxter@gmail.com>.

## Commits (oldest first)

| SHA | What |
| --- | --- |
| `753ece5` | Test first: new test files only (`StandMode.annotations.test.tsx`, `StandMode.lifecycle.test.tsx`, `StandMode.placement.test.tsx`, `geometry.stand.test.ts`). Fails on the pre-fix head (19 of the new cases). |
| `36be365` | F4: `geometry.test.ts` restored to dev's (merge-base) version byte for byte; its stand cases already live in `geometry.stand.test.ts`. |
| `08c79c4` | F1, F2, F3 fixes (`PdfViewport.tsx`, `PlayheadController.ts`, `StandOverlay.tsx`), plus one extra assertion in the PR-new `StandMode.lifecycle.test.tsx` ("no pager over nothing"). |

## Per-finding fixes

### F1 — Stand-mode pinch edits a selected text note through hidden tools (fixed in `08c79c4`)
- Fix: the stand-mode ink delegate in `PdfViewport.tsx` now gates `canPinch` and `onPinch` the same way as `shouldInk`. While stand mode is on, a two-finger pinch is never claimed by the ink layer, so a text note still selected from before is not resized and no undo batch opens. `onInkDown/Move/Up/Cancel` are reachable only through `shouldInk` (already gated), `onPromoteToPinch` only through `canPinch` (now gated), and `onPinchEnd` only after a claimed pinch.
- Tests (`src/features/viewer/stand/StandMode.annotations.test.tsx`): the real viewport, a note typed and committed with the text tool (so it stays selected), then stand mode and two pinches. Cases: on the note's page and after turning to page 3, each with Finger-draw off and on. Each asserts no `update`, `create`, `delete` or `beginBatch` call, an unchanged payload, the stand view unchanged, and that the newest undo step is still the note's creation (one undo removes it and leaves `canUndo` false). A control case shows the same pinch does resize the note outside stand mode. Pre-fix: the 4 stand cases fail (`update` called 4 times).

### F2 — Loading or failed PDFs leave the phone overlay without Exit (fixed in `08c79c4`)
- Fix: `StandOverlay` now renders outside the document branch of `PdfViewport`. When there is no score to show (`status !== 'ready'` or no `doc`), it stays up permanently with Exit only: no auto-hide, and a middle tap does not hide it. With a score it behaves as before (shown on entry, toggled by a middle tap, hidden after `STAND_MENU_MS`). `StandOverlay` hides the previous/page/next group when `pageCount` is 0, so it never shows "Page 0 / 0". Entry is still allowed while loading (the conservative choice; see Open questions).
- Tests (`src/features/viewer/stand/StandMode.lifecycle.test.tsx`), run at an iPhone size with `document.fullscreenEnabled = false`: entering while loading; entering while loading, then the load fails; entering on a failed load; ready but with no document. Each asserts that Exit is on screen, that no pager shows, that Exit is still there long past the timeout, after a middle tap and after side taps, and that tapping Exit leaves stand mode and drops the overlay. A further case enters while loading and checks that once the score loads, the usual toggle, timeout and page turns work. Pre-fix: the 4 no-score cases fail (no Exit button).

### F3 — Ordinary viewport controllers override stand mode's placement (fixed in `08c79c4`)
- Fix:
  - `settleIntoBounds` returns at once in stand mode and clears pending settle and slack. This covers the pointer-end settle and the notice-inset layout effect.
  - The capture `onPointerDown` no longer marks a settle pending in stand mode.
  - Entering stand mode cancels a settle glide under way and clears pending settle and slack.
  - The page-size reanchor layout effect stands down in stand mode. The stand placement effect already re-fits on a layout change.
  - `PlayheadController` gets a new optional dep, `isViewHeld`, wired to `standModeRef`. While it returns true, `followTo` sets nothing and drops any glide, and `stepFollowAnimation` drops a glide already under way on its next frame. The playhead line and highlight still draw.
- Tests (`src/features/viewer/stand/StandMode.placement.test.tsx`), on a 390×844 phone where the stand view is outside `clampScroll`'s bounds (asserted as a premise). Each case runs with motion and under reduced motion:
  - finger and mouse taps in the middle
  - boundary taps (Previous on page 1, Next on page 3)
  - a drag that turns nothing
  - a notice inset coming and going
  - play-along running with follow on while the tick crosses from page 1 to page 2, plus a seek (`notePlayheadJump`) and a follow resume
  - a follow glide already under way when stand mode starts

  Each asserts the view equals `pageFitView` for the stand page after all frames run. Pre-fix: 11 of 12 fail. The reduced-motion "glide under way" case passes on the pre-fix head as well, because reduced motion never starts a glide; it is kept as a control.

### F4 — New tests appended to an existing test file (fixed in `36be365`)
- Fix: the 7 `pageFitView` / `pageTopView` cases (and their two imports) were moved verbatim into the new file `src/features/viewer/geometry.stand.test.ts` (diffed identical to the originals). `geometry.test.ts` is now exactly its `dev` / merge-base version.
- Audit: `git diff --diff-filter=M --unified=0 2144872 <rev> -- '*test*'`, counting added `it(` / `describe(` / `test(` lines: pre-fix head `e05f94a` = 9; new tip = 0, and there are no modified test files at all. All of the PR's test changes are now new files only (`--diff-filter=A`).

## Sweep

Commands are the packet's, plus two widening sweeps (F1b, F3c). Run on the new tip.

**F1** `rg -n 'controller.setInkDelegate|\.\.\.ink.delegate|shouldInk:|onPinch:|canPinch:' src/features/viewer/PdfViewport.tsx src/features/viewer/ink/InkController.ts`
- PdfViewport.tsx:1069 `controller.setInkDelegate({` — fixed in 08c79c4 (wrapper now gates pinch)
- PdfViewport.tsx:1070 `...ink.delegate` — ok: the members it spreads are either gated below or only reachable through gated ones
- PdfViewport.tsx:1071 `shouldInk:` — ok (already stand-gated by the PR)
- PdfViewport.tsx:1074 `canPinch:` — fixed in 08c79c4
- PdfViewport.tsx:1075 `onPinch:` — fixed in 08c79c4
- InkController.ts:362 / 367 / 369 `shouldInk:` / `onPinch:` / `canPinch:` — ok: InkController stays stand-agnostic, and the viewport's wrapper is the single gate

**F1b** `rg -n 'onInkDown:|onInkMove:|onInkUp:|onInkCancel:|onPinchEnd:|onPromoteToPinch:' …same files`
- InkController.ts:363–366 `onInkDown/Move/Up/Cancel` — ok: GestureController calls them only for a pointer `shouldInk` claimed
- InkController.ts:368 `onPinchEnd` — ok: only after a claimed pinch (`inkPinch`), which `onPinch` can no longer start in stand mode
- InkController.ts:370 `onPromoteToPinch` — ok: only when `canPinch()` is true (gated)

**F2** `rg -n "status === 'loading'|status === 'error'|standMenu.open \?|<StandOverlay|setStandTarget\(containerRef.current\)|if \(!standTarget|<StandModeButton|!scoreShown|standMenu.open \|\|" src/features/viewer/PdfViewport.tsx src/features/viewer/stand/standMode.ts src/features/viewer/ViewerPage.tsx`
- ViewerPage.tsx:947, 1341 `<StandModeButton />` — ok: entry stays possible in every state, and an exit now exists in every state
- PdfViewport.tsx:762 `setStandTarget(containerRef.current)` — ok: the target is registered from mount, so loading and error are enterable, and are now covered
- PdfViewport.tsx:1379 `status === 'loading'` — ok (loading branch; the overlay now renders after the branches)
- PdfViewport.tsx:1383 `!scoreShown` (was `status === 'error' || !doc`) — fixed in 08c79c4 (same condition, shared with the overlay)
- PdfViewport.tsx:1502–1503 `standMode && (standMenu.open || !scoreShown)` / `<StandOverlay` — fixed in 08c79c4 (was `standMenu.open ?` inside the ready branch only)
- standMode.ts:170 `if (!standTarget || …standMode)` — ok (guards double entry only)

**F3a** `rg -n 'const settleIntoBounds|const onPointerDown =|const onPointerEnd =|settleIntoBounds\(\)|new PlayheadController' src/features/viewer/PdfViewport.tsx`
- 403 `const settleIntoBounds` — fixed in 08c79c4 (stand-mode early return)
- 467 `const onPointerDown =` — fixed in 08c79c4 (no settle-pending in stand mode)
- 488 / 490 `onPointerEnd` → `settleIntoBounds()` — fixed in 08c79c4 (through settleIntoBounds)
- 509 `settleIntoBounds()` (notice inset layout effect) — fixed in 08c79c4 (through settleIntoBounds)
- 1179 `new PlayheadController` — fixed in 08c79c4 (`isViewHeld: () => standModeRef.current`)

**F3b** `rg -n 'this.followTo\(rect\)|this.stepFollowAnimation\(\)|store.setView\(' src/features/playback/PlayheadController.ts`
- 164 `this.stepFollowAnimation()` — fixed in 08c79c4 (drops the glide while held)
- 209 `this.followTo(rect)` — fixed in 08c79c4 (returns while held)
- 291 `store.setView(` (reduced-motion jump) — fixed in 08c79c4 (inside followTo)
- 314 `store.setView(` (glide step) — fixed in 08c79c4 (inside stepFollowAnimation)

**F3c** (widened) `rg -n 'setView\(|resetView\(' src/features/viewer/PdfViewport.tsx`: every viewport writer.
- 431, 454 settle jump and glide — fixed in 08c79c4 (settleIntoBounds gated)
- 600 first fit `resetView` — ok: runs once on ready, and the stand placement effect, declared later, re-places in the same commit (the "once the score loads" lifecycle case passes)
- 651 resize / column refit — ok (the PR already returns early in stand mode)
- 704 stand placement — ok (the owner)
- 717 return from stand mode — ok (after exit)
- 795 page-size reanchor — fixed in 08c79c4 (stands down in stand mode)
- 817 `turnPage` — ok, unreachable in stand mode: `standKeyAction` and `pageTurnDirection` map the same keys, so a key the stand handler declines is also declined by the pager; the Pager is hidden and `onTap` takes the stand branch first
- 837 `relayout` — ok (only from ZoomControls, not rendered in stand mode)
- 983 / 992 / 1001 pan, zoom and wheel callbacks — ok (each returns early in stand mode, from the PR)
- 1488 ZoomControls `onZoomBy` — ok (not rendered in stand mode)

**F4** `git diff --diff-filter=M --unified=0 2144872 <rev> -- '*test*'`
- `e05f94a`: geometry.test.ts, two imports plus 7 `it` cases in 2 `describe` blocks — fixed in 36be365 (moved to geometry.stand.test.ts)
- `08c79c4`: no output (no modified test files)

## Tests

All run on the final tip `08c79c4` (lint, typecheck and the full suite ran on the identical working tree just before the commits were made).

| Command | Exit | Result |
| --- | --- | --- |
| `npm run lint:check` | 0 | eslint clean |
| `npm run typecheck` | 0 | tsc clean |
| `npm run test` | 0 | Test Files 277 passed, 6 skipped (283); Tests 4290 passed, 22 skipped (4312) |
| `npm run build` | 0 | vite build and PWA (143 precache entries) |
| `npx vitest run` on the 4 new test files, with the pre-fix `PdfViewport.tsx`, `PlayheadController.ts` and `StandOverlay.tsx` from `e05f94a` | 1 | 19 failed, 11 passed (30): the expected test-first failures |
| same 4 files plus `stand/`, `geometry.test.ts`, `PdfViewport.test.tsx` and `PlayheadController.test.ts` on the fixed code | 0 | 9 files, 154 tests passed |
| F4 audit (count of added `it`/`describe`/`test` lines in modified test files vs merge-base) | — | `e05f94a`: 9; `08c79c4`: 0 |

No package or lockfile changes. No existing assertion, expected value or test description on `dev` was changed: `geometry.test.ts` is back to its dev version, and every other test change is a new file.

## Conflict for Max

None.

## Open questions

1. **F2, entry while loading.** The packet allows either "keep exit controls available" or "prevent entry until ready". I kept entry allowed and made Exit permanent in every no-score state. This is the smaller change, and the header button needs no knowledge of the PDF's status. If Max prefers the button disabled until the score is ready, that can be added on top.
2. **F3, play-along in stand mode.** Following is now suspended while stand mode holds the view, so playback crossing a page boundary does not move or turn the stand page; the playhead still draws on the shown page. An automatic page turn when play-along reaches the next page would be a feature decision, and I left it out of scope. On leaving stand mode, follow resumes at the next measure change.
3. **UI check.** I did not run the `ui-check` skill (`npm run cloud:up` with screenshots) in this round. The F2 overlay reuses the existing StandOverlay styling and position. The factory's QA click-through should confirm the loading and error Exit on a phone viewport.
4. **Report branch.** The report is pushed alone, as a single-file root commit, to `claude/pr82-r1-fix-cl195603-report`. If the harness refuses that name, the actual name is given in the final message.
