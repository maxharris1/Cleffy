# PR #78 value card, fix 2: card vs. the toolbar's colour/size popup

**Result: fixed and pushed to the staging branch. CI is green and the browser check passes at every size.**

- Base check: `git rev-parse origin/mh/try-demo` returned `9834dd2a674beb9f3c4ae24cd52f18a59660c1b8`, as expected.
- Staging branch: `claude/cleffy-pr78-value-card-fix2`
- **New staging head: `5b32a9e1deecdc46f104491f4ea2a523055b1189`.** It is a fast-forward of 9834dd2a: `git merge-base --is-ancestor` passes.
- Nothing was pushed to `mh/try-demo`, `dev` or `main`. No PR was opened or commented on, and PR #78's draft/base state is unchanged.

## Commits (9834dd2a..HEAD)

| SHA | Subject |
|---|---|
| `5b32a9e1deecdc46f104491f4ea2a523055b1189` | Demo value card: step aside while a toolbar popup is open |

Author and committer are both `Max Harris <drumaxter@gmail.com>`. There are no co-author or Claude trailers.

```
$ git diff --stat 9834dd2a..HEAD
 src/features/demo/DemoViewer.test.tsx        | 45 +++++++++++++++++++++++++++-
 src/features/demo/DemoViewer.tsx             | 15 ++++++++--
 src/features/viewer/LocalViewerFrame.tsx     |  6 +++-
 src/features/viewer/toolbar/Toolbar.test.tsx | 21 +++++++++++++
 src/features/viewer/toolbar/Toolbar.tsx      |  4 +++
 src/features/viewer/toolbar/toolbarPopup.ts  | 38 +++++++++++++++++++++++
 6 files changed, 124 insertions(+), 5 deletions(-)
```

No Supabase, `.env`, package or lockfile changes. The "like Google Docs for sheet music" copy is unchanged, and no toolbar controls were added.

## Checks (Node v22.22.0)

| Check | Result |
|---|---|
| `npm run lint:check` | pass (eslint, 0 problems) |
| `npm run typecheck` | pass (`tsc --noEmit`) |
| `npm run test` | pass: **268 test files passed, 6 skipped (274); 4157 tests passed, 22 skipped (4179)** |
| `src/features/demo/DemoViewer.test.tsx` | 40 passed (was 39; +1 new) |
| `src/features/viewer/toolbar/Toolbar.test.tsx` | 7 passed (was 6; +1 new) |
| demo + toolbar dirs (`npx vitest run src/features/demo src/features/viewer/toolbar`) | 5 files, 70 tests passed |
| `npm run build` | pass |
| `npx prettier --write` / `--check` on the 6 changed files | all files already formatted; check passes |
| GitHub CI run [40776296817](https://github.com/maxharris1/Cleffy/actions/runs/40776296817) on `5b32a9e` | **success**: checks, supabase-local, supabase-drift, edge-functions-deno, omr-service |

No existing test assertion was changed, loosened or removed. The demo test's stubbed viewport gained an opt-in `h.withToolbar` flag. It defaults to `false` and is reset in `beforeEach`, so every existing test renders exactly what it did before.

## How the fix works

1. **A shared "toolbar popup open" signal.** `src/features/viewer/toolbar/toolbarPopup.ts`:
   - It keeps a module-level count (`:9`). Using a count means a StrictMode re-run or two toolbars overlapping during a remount can't clear each other.
   - The Toolbar reports its own state with `useReportToolbarPopup(open)` (`:24`), which increments the count while `open` holds and decrements it on close or unmount.
   - Consumers read it with `useToolbarPopupOpen()` (`:38`), a `useSyncExternalStore` hook.
   - The Toolbar reports its colour/size popover: `Toolbar.tsx:77` (`useReportToolbarPopup(styleOpen)`). A future toolbar popover would make the same call.
2. **The card steps aside, without being dismissed.** `DemoViewer.tsx:162` reads the signal, and `showValueCard` gains `&& !toolbarPopupOpen` (`DemoViewer.tsx:355`). This is the same "wait, then come back" path the Start over question already uses.
   - Opening the popup doesn't write a dismissal. `dismissValueCard` / `writeValueCardDismissed` are not called, so `valueCardDismissed` and the sessionStorage key are untouched.
   - The once-per-session state is unchanged.
   - When the popup closes (Escape, the style button again, a tap outside it, a tool change, or the toolbar unmounting), the card comes back.
3. **Belt and braces: the open popup paints above the card regardless.**
   - Raising the toolbar's own z-index can't do this. `LocalViewerFrame`'s root is `position: fixed`, so the whole viewer, toolbar included, is one stacking context. The card's `fixed z-40` dock is a sibling outside it, so it always painted over the whole viewer.
   - The popover now carries `data-toolbar-popup` (`Toolbar.tsx:262`).
   - The frame root gets `has-[[data-toolbar-popup]]:z-50` (`LocalViewerFrame.tsx:60`). While a popup is open, the viewer lifts above z-40 floating UI and drops back as soon as it closes.
   - This is pure CSS and independent of the JS signal.

### Tests that cover it

- `DemoViewer.test.tsx:723`, "steps aside while a toolbar popup is open, and comes back when it closes, without being dismissed". It renders the real Toolbar in the stub viewport, brings the card up after 3 marks, then:
  - opens "Pen colour and size" → the card is gone, the popup carries `data-toolbar-popup`, and its frame ancestor has the `has-[[data-toolbar-popup]]:z-50` class;
  - picks red and Thick → the store has `#dc2626` / `thick`, and the card is still away;
  - presses Escape → the popup closes and the card is back;
  - toggles the style button and taps outside (pointerdown on the viewport) → the card hides and returns each time;
  - checks that `sessionStorage['cleffy:demo-value-card']` stays `null` throughout.
  - Mutation check: with the `!toolbarPopupOpen` condition neutralised, this test fails.
- `Toolbar.test.tsx:131`, "says while its popup is open…". `isToolbarPopupOpen()` is false at first, true while the popover is open, false after Escape, and false again when the toolbar unmounts with the popover still open.

## Browser check

**Method:** headless Chromium via `scripts/ui/uifuzz.mjs` `open()`. No `playwright install`. Each run:

1. Load `/try` and draw 3 marks with the default pen; wait for the card.
2. Tap "Pen colour and size". Record whether the card is in the DOM, the popup's box, and `elementFromPoint` at the centre of the blue swatch (`Color #2563eb`) and of the `Pen size Thick` button.
3. Run a z-40 probe: inject an opaque `position:fixed; inset:0; z-index:40` layer at `<body>` level (standing in for a card that failed to hide), and count popup buttons still hit-testable through `elementFromPoint`.
4. Pick blue + Thick, close the popup with the style button, and draw a stroke.
5. Read the newest annotation from IndexedDB (`scribbler.annotations`) and check sessionStorage.

All screenshots were looked at.

### 1. Local `vite preview` of the build (`http://localhost:4173/try`)

| Size | Card box (x,y,w,h) | Toolbar box | Popup open: card in DOM | Popup box | elementFromPoint swatch / size | Frame z | z-40 probe | After close: card back | New stroke colour / w | Dismissal key |
|---|---|---|---|---|---|---|---|---|---|---|
| iPhone 14, 390×844 | 8,513,374,257 | 8,778,374,54 | **0** | 34,643,322,128 | Color #2563eb ✓ / Pen size Thick ✓ | 50 | 10/10 buttons hit-testable | **yes** (same box) | **#2563eb / 0.01 (thick)** | not set (null) |
| iPhone SE, 375×667 | 8,336,359,257 | 8,601,359,54 | **0** | 27,466,322,128 | ✓ / ✓ | 50 | 10/10 | **yes** | **#2563eb / 0.01** | null |
| iPad portrait, 820×1180 | 186,922,448,242 | 144,99,533,54 (top) | **0** | 249,160,322,128 (below the top bar) | ✓ / ✓ | 50 | 10/10 | **yes** | **#2563eb / 0.01** | null |
| Desktop 1440×900 | 496,642,448,242 | 262,65,916,54 | n/a: colours and sizes are inline from `lg`, so there is no popup | — | — | — | — | card stayed up | **#2563eb / 0.01** (inline picks) | null |

- No console errors at any size.
- After every picks step, the popup was still open and the card still out of the DOM.
- The annotation count was 4 (3 marks + 1 check stroke) at every size.

**Control for the z-index lift** (iPhone 14, same build): with the lift in place the frame is `z-index: 50` and 10/10 popup buttons are hit-testable above a z-40 cover. With the `has-[…]:z-50` class removed from the frame, it is `z=auto` and **0/10**. So without the lift, a card that stayed up would take every tap, which is the bug Codex reported. With it, the popup wins.

**Screenshots (looked at):**
- 390 and 375 with the popup open: the swatches and size dots are clear, there is no card, and the popup sits just above the bottom bar.
- After closing: the card is back above the toolbar, the new stroke is visibly blue and thicker than the first three dark marks, and the style button shows the blue swatch.
- iPad: the popup sits below the top toolbar.
- Desktop: the card sits centred at the bottom, with the inline colours in the top bar.

### 2. Vercel preview for the staging branch

- URL: `https://cleffy-git-claude-cleffy-pr78-value-card-fix2-maxs-projectsd.vercel.app/try`
- For about the first 30 s after the push, the URL served Vercel's "instant preview" placeholder. It then served the app.
- **Served asset hashes match my build exactly:** `/assets/index-CKlBjteG.js` and `/assets/index-CHJwBlSv.css`, the same as the local `dist/assets`.

**Results match the local run number for number:**

| Size | Card box | Popup open: card in DOM | Popup box | swatch / size hit | Frame z | z-40 probe | Card back after close | New stroke | Dismissal key | Console errors |
|---|---|---|---|---|---|---|---|---|---|---|
| 390×844 | 8,513,374,257 | **0** | 34,643,322,128 | ✓ / ✓ | 50 | 10/10 | **yes** | **#2563eb / 0.01** | null | none |
| 375×667 | 8,336,359,257 | **0** | 27,466,322,128 | ✓ / ✓ | 50 | 10/10 | **yes** | **#2563eb / 0.01** | null | none |
| iPad portrait 820×1180 | 186,922,448,242 | **0** | 249,160,322,128 | ✓ / ✓ | 50 | 10/10 | **yes** | **#2563eb / 0.01** | null | none |
| Desktop 1440 | 496,642,448,242 | n/a (inline) | — | — | — | — | card stayed up | **#2563eb / 0.01** | null | none |

The preview screenshots at 390 (popup open) and 375 (after the stroke, card back) were looked at and match the local ones.

## Deviations from the packet, and notes

- **Branch.** This session was created on `claude/value-card-zindex-fix-yime39`. Per the dispatch rules, the work is pushed only to `claude/cleffy-pr78-value-card-fix2` (code) and `claude/cleffy-pr78-value-card-fix2-report` (this report). Nothing was pushed to the session branch.
- **How "hide" is implemented.** The card is unmounted while a popup is open, not visually hidden, so it re-enters with its normal entrance animation when the popup closes.
- **The belt-and-braces lift is on `LocalViewerFrame`, not the toolbar.** The packet said "make sure the open popup paints above the card regardless (z-index)". Raising the toolbar's z-index alone cannot do that, because the frame's `position: fixed` root is its own stacking context below the card (see "How the fix works", item 3). So the frame lifts itself while a popup is in it. Only `LocalViewerFrame` (the local viewer and `/try`) has this; the cloud `ViewerPage` has no value card and is unchanged.
- **Signal over DOM watching.** I used an explicit shared signal rather than having the card watch `aria-expanded`. It is scoped to toolbar popups: a stray always-expanded disclosure elsewhere can't keep the card away. It is also cheap, with no document-wide MutationObserver.
- **Edge case, not changed.** If a visitor opens the popup below `lg` and then widens the window past `lg` without closing it, the popup is CSS-hidden (`lg:hidden`) but still counts as open. The card then stays away until any tap closes it, which the toolbar's outside-pointerdown handler does. It is never dismissed.
- **Browser drawing input.** Strokes were drawn with Playwright's mouse on touch-enabled phone/iPad contexts. The demo turns finger drawing on, and the mouse draws ink either way.
- **iPad landscape and the other viewports** were not run. The packet asked for 390×844, 375×667, iPad portrait and desktop 1440.
