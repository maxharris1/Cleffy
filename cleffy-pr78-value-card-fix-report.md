# PR #78 value card: fix pass report

**Repo:** maxharris1/Cleffy · **Branch:** `mh/try-demo` (draft PR #78)
**Started from:** `0e7e4986b7868891de5a547e183a6c0c7055ea6b` (`git fetch origin mh/try-demo && git rev-parse origin/mh/try-demo` returned exactly this before any work)
**New head:** `9834dd2a674beb9f3c4ae24cd52f18a59660c1b8`, pushed fast-forward (`0e7e498..9834dd2  HEAD -> mh/try-demo`). No force push, no rebase, amend or squash. Nothing pushed to `dev` or `main`. PR draft/base state untouched, no PR comments.

## Commits

| SHA | Subject |
|---|---|
| `9834dd2a674beb9f3c4ae24cd52f18a59660c1b8` | Demo value card: pending-write race, Escape scope, phone placement |

Author and committer are both `Max Harris <drumaxter@gmail.com>`. There are no co-author or Claude trailers.

## `git diff --stat 0e7e4986..HEAD`

```
 src/features/demo/DemoValueCard.css   |  39 +++++++++-
 src/features/demo/DemoValueCard.tsx   |  43 +++++++----
 src/features/demo/DemoViewer.test.tsx | 140 ++++++++++++++++++++++++++++++++--
 src/features/demo/DemoViewer.tsx      |  27 ++++---
 4 files changed, 211 insertions(+), 38 deletions(-)
```

No Supabase, `.env`, package or lockfile changes.

## Local checks (Node v22.22.0, existing node_modules, no install)

| Check | Result |
|---|---|
| `npm run lint:check` | pass (eslint, no output) |
| `npm run typecheck` | pass (`tsc --noEmit`, no output) |
| `npm run test` | pass: **268 test files passed, 6 skipped (274); 4155 tests passed, 22 skipped (4177)** |
| `npx vitest run src/features/demo/DemoViewer.test.tsx` | 39/39 pass (31 before; 8 new) |
| `npm run build` | pass. The card's CSS (`.demo-value-dock`, `.demo-value-card`, `.demo-value-art`) is only in `dist/assets/DemoViewer-*.css`; `grep -c demo-value dist/assets/index-*.css` = 0 |
| `npx prettier --write` + `--check` on the 4 changed files | "All matched files use Prettier code style!" |
| `git diff --check` | clean |

**Regression proof:** I ran the new tests against the original 0e7e498 source, with the source files reverted and the new test file kept. The pending-write race test, all 3 Escape-from-a-header-control cases, the open-menu Escape test and the phone-placement test failed (6 failures). With the original stub (store registered inside the `useState` initializer), the StrictMode test failed with `expected [AnnotationStore, AnnotationStore] to have a length of 1 but got 2`. All of them pass on the new head.

## CI at the new head (`9834dd2`)

All 11 checks at `9834dd2` passed, plus one Supabase Preview check that was skipped as usual. CI ran twice on this head, once from the push and once from the PR (workflow runs 40754229959 and 40754238613), and both were fully green.

| Check | Run 40754229959 | Run 40754238613 |
|---|---|---|
| checks (npm ci, audit, lint:check, typecheck, test, build) | success (test 19:26:59→19:31:06, build →19:31:28) | success (completed 19:31:39) |
| supabase-local | success | success |
| supabase-drift | success | success |
| edge-functions-deno | success | success |
| omr-service | success | success |
| Vercel Preview Comments | success | |
| Supabase Preview | skipped (as on earlier heads) | |

## How each finding was resolved

### Med 1: fallback fired with a stroke's write still pending
- **Fix:** `src/features/demo/DemoViewer.tsx:152`, `:264-298`. The 25 s timer no longer decides anything. It only sets `fallbackReached` (line 296). The counting effect makes the decision (lines 274-290). It re-runs when `fallbackReached` flips and reads `annotationStore.liveAnnotations()` at that moment. `AnnotationStore.commit` applies a create to the live map synchronously, before any IndexedDB yield (`src/sync/annotationStore.ts:1196-1198`), so a stroke whose write is still in flight counts as drawn. The card is due only if `fallbackReached && newMarks.size === 0`. If the deadline passes with no store mounted (a failed wipe), the decision is made when the next store mounts. The existing "comes up once Try again has worked" test still covers this.
- **Test:** `DemoViewer.test.tsx:648`, "counts a first stroke whose write is still pending at the deadline: the clock does not bring the card". It spies on the test database's `transaction` so that every IndexedDB transaction waits on a gate the test holds. It calls `store.create()` without awaiting it, then asserts the mark is live. It then advances the fake clock by the full `VALUE_CARD_FALLBACK_MS` and asserts there is no card. Next it releases the write, awaits it and asserts there is still no card. Finally it draws 2 more marks and asserts the card comes up at the mark count.

### Med 2: Escape ignored on any focused outside button or link
- **Fix:** `src/features/demo/DemoValueCard.tsx:23-42`. The blanket `button, a` exclusion is gone. Escape is left alone only when one of these holds:
  - it was pressed inside an editor (`input, textarea, select, [contenteditable]`) or an open popup (`[role=dialog|alertdialog|menu|listbox]`) outside the card;
  - any control outside the card reports an open popup (`[aria-expanded="true"]`).

  The second rule covers the toolbar's style popover, which leaves focus on its own `aria-expanded` button and does not `preventDefault`. It also covers the demo's overflow Menu trigger. The `defaultPrevented` check is kept: Start over's confirm and the text editor overlay call `preventDefault`. On an ordinary toolbar or header button or link, Escape now closes the card.
- **Tests:** `DemoViewer.test.tsx:680` (`it.each` over the header's Keep my markings button, Start over button and Start free link: focus it, press Escape, the card closes and the dismissal is stored). `:699` "leaves an open menu its Escape, then goes on the next one" uses the real demo Menu through user-event: open it, press Escape, the menu closes and the card stays with nothing stored. Focus is then back on the closed trigger, and a second Escape closes the card. `:719` "leaves a text field its Escape". The existing "Escape puts it away" (from body) and "leaves Start over its Escape" tests are unchanged and pass.
- **Browser:** at all 5 sizes, the real toolbar's Pen button was focused and Escape pressed: the card closed every time. No `[aria-expanded="true"]` element was on the page while the card was up.

### Low 3: StrictMode test stub registered the discarded store
- **Fix:** this is the only change to existing test code, in the `PdfViewport` stub in `DemoViewer.test.tsx` (around lines 55-80). Before, the stub pushed the store into `h.stores` inside the `useState` initializer. Now the initializer only constructs the store (`useState(() => new Store(h.db!, docId))`), and a `useLayoutEffect` pushes the committed store, once (`if (!h.stores.includes(store))`). The layout effect runs before the viewport is in the DOM for `findByTestId`, so the stub's guarantee that the store is registered before a test can find the viewport still holds. The import gained `useLayoutEffect`. No assertion was changed, loosened or removed.
- **Test:** `DemoViewer.test.tsx:731`, "works under StrictMode, on the store the viewer was handed". It renders inside `<StrictMode>` and asserts `h.stores` has length 1. It then draws 3 marks into `latestStore()` and asserts the card comes up and the hint is gone, which only happens if `latestStore()` is the store the viewer subscribed to.

### 4: phone placement
- **Toolbar height, read from the code:** `src/features/viewer/toolbar/Toolbar.tsx:197-199`. Below `sm` the bar is `absolute bottom-[calc(0.75rem+var(--safe-bottom))]`. Its inner bar is `py-1.5` around `h-10` buttons (`BAR_BUTTON`, line 41) with a 1px border, so 40 + 12 + 2 = 54px. The bar already publishes the window strip it occupies as `--toolbar-bottom-clearance` on `<html>` (lines 133-139, = `innerHeight - bar.top`, so bar + 0.75rem gap + safe area). `SignedOutInkNotice` uses the same variable to sit above the toolbar.
- **Fix:** `src/features/demo/DemoValueCard.css:7-27`. The dock's bottom padding is `0.5rem + max(var(--toolbar-bottom-clearance, 0.75rem + 54px + var(--safe-bottom)), var(--safe-bottom))`. That is the toolbar's measured clearance, or its known size plus `env(safe-area-inset-bottom)` until it has measured. From `40rem` (the toolbar's own `sm` switch to the top) the padding is the old `1rem + safe-bottom`. The dock itself is still `pointer-events-none`, so only the card takes taps.
- **Compact on phones:** `DemoValueCard.css:29-51`. Card padding is 12px below `40rem` (16px above). The illustration shrinks to 72×36 below `40rem` and is hidden below `25rem` (400px). Padding moved off the Tailwind `p-4` onto `.demo-value-card` so all of it stays in the demo chunk. `DemoValueCard.tsx` only gained the class names `demo-value-card` and `demo-value-art` and an updated doc comment.
- **Test:** `DemoViewer.test.tsx:749`, "sits above the phone's bottom toolbar…". jsdom does no layout, so this test reads `DemoValueCard.css` from disk the way `src/ui/SwapLabel.test.tsx` does. It asserts the toolbar-offset rule, the `sm` reset and the under-400px hide. Real geometry is in the browser check below.

### 5: copy
Unchanged: "Share one link, and your teacher, students or bandmates draw with you, live — like Google Docs for sheet music." (`DemoValueCard.tsx`, third bullet). The other two bullets and the title are also unchanged.

## 5-size browser check

**Setup:**
- Viewport definitions come from `scripts/ui/uifuzz.mjs` (`open()`, headless Chromium).
- The script loads `/try`, waits for the toolbar, draws 3 strokes with the pointer and waits for the card.
- It records the card's bounding box and the toolbar bar's box (`.chrome-glass` around the Pen button).
- It taps the toolbar's Eraser at its centre while the card is up: a touch tap on touch profiles, a click on desktop. It also checks `elementFromPoint` at that point, whether Eraser became `aria-pressed=true`, and whether the card stayed up.
- Finally it focuses the toolbar's Pen button, presses Escape and checks the card is gone.

**Where it ran:** on the Vercel preview for the new head, https://cleffy-git-mh-try-demo-maxs-projectsd.vercel.app/try, after it redeployed. The preview served `assets/index-CQp4G1XB.js`, the same hash as my local build of `9834dd2`. A local `vite preview` of the same build gave identical numbers.

Boxes are `x, y, w×h` in CSS px (bottom = y + h).

| Size | Card | Toolbar | Card vs toolbar | Illustration | Card padding | Toolbar tap with card up | Escape on toolbar button |
|---|---|---|---|---|---|---|---|
| iPhone SE 375×667 | 8, 336, 359×257 (bottom 593) | 8, 601, 359×54 (bottom 655) | **8px above, no overlap** | hidden (<400px) | 12px | lands on Eraser → pressed; card stays | card closes |
| iPhone 14 390×844 | 8, 513, 374×257 (bottom 770) | 8, 778, 374×54 (bottom 832) | **8px above, no overlap** | hidden (<400px) | 12px | lands on Eraser → pressed; card stays | card closes |
| iPad portrait 820×1180 | 186, 922, 448×242 (bottom 1164) | 144, 99, 533×54 (toolbar at top) | no overlap | 96×48 shown | 16px | lands on Eraser → pressed; card stays | card closes |
| Desktop 1440×900 | 496, 642, 448×242 (bottom 884) | 262, 65, 916×54 (toolbar at top) | no overlap | 96×48 shown | 16px | lands on Eraser → pressed; card stays | card closes |
| iPhone 14 + reduced motion | 8, 513, 374×257 (bottom 770) | 8, 778, 374×54 (bottom 832) | **8px above, no overlap** | hidden (<400px) | 12px | lands on Eraser → pressed; card stays | card closes |

`--toolbar-bottom-clearance` measured 66px on both phones (54px bar + 12px gap, no safe area in headless Chromium), which matches the fallback. There were no console errors at any size.

**Before, for comparison:** the same script ran against the preview while it was still serving 0e7e498. On iPhone SE the card was at y=378-659 over the toolbar at y=601-655, and on iPhone 14 at y=555-836 over the toolbar at 778-832. On both phones `elementFromPoint` at the Eraser's centre was a card element (a card button on SE, a card `div` on iPhone 14), and the tap did not select Eraser. The script also found the card no longer visible after the tap. I did not dig into why on the old build.

## Deviations from the packet, and notes

1. **One commit, not one per finding.** All four fixes touch the same two source files and the same test file, and the sandbox has no interactive `git add -p`. The commit message lists each fix separately.
2. **Phone offset uses the toolbar's own measured variable**, with the code-derived height as the fallback. The packet's literal formula is "toolbar height + `env(safe-area-inset-bottom)`". The fallback is exactly that, plus the toolbar's 0.75rem gap from the bottom edge, which is part of what the toolbar covers. The primary value is `--toolbar-bottom-clearance`, which `Toolbar.tsx` measures from the real bar (safe area included), so the card tracks the bar if its size ever changes.
3. **Phone-placement test is a stylesheet assertion**, because jsdom has no layout. The real geometry is in the 5-size browser check above.
4. **New test infrastructure (no existing assertions touched):** imports of `node:fs`, `StrictMode` and `@testing-library/user-event` were added to `DemoViewer.test.tsx`. The race test uses a per-test `vi.spyOn(db, 'transaction')`, which is restored by the file's existing `vi.restoreAllMocks()` in `afterEach`.
5. **Scope of Med 1:** "pending/in-flight" is read as "drawn, write not yet landed", which is the reviewer's repro. A stroke still under the pen at exactly 25 s (pointer down, not yet released) is not in the store at all. If it is the first stroke, the card can still come up then, as before. It never covers the toolbar on phones, and it never takes focus, so the stroke continues.
6. The Escape rule keys off `[aria-expanded="true"]` anywhere outside the card. On `/try` no such element exists unless a popup is open (verified in the browser at all 5 sizes).
