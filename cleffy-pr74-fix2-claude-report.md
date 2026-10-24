# Cleffy PR #74 fix pass 2 (majors only): Claude report

**Status:** Complete
**Branch:** `mh/ui-polish-emil` (draft PR #74, base `dev`). It is still a draft and not merged. Nothing was pushed to `dev` or `main`, and PR #54 was not touched.

## Environment

- This ran in a Claude Code cloud session (`environment_kind: anthropic_cloud`, env `env_01WAd3yiz3qpSnsofpyEwCh2`, session `session_01STQv8WbFthM2rSxtwdb3Ti`). The repo was cloned fresh into an ephemeral container.
- Only the local stack was used. `npm run cloud:up` booted local Supabase, the Edge Functions and Vite on http://localhost:5173, and `npm run cloud:down` stopped them at the end. Hosted Supabase (prod/dev) and Stripe were not touched. No `.env` files or secrets were used, and `playwright install` was not run: the preinstalled Chromium in `/opt/pw-browsers` was used.
- Commits are authored as Max Harris <drumaxter@gmail.com>.

## Heads

- Old head: `e0208659ae81d694439fbe06472011a2e7fc0514`. `git pull --rebase` found the branch already at this commit.
- New head: `0bfdfa2f108b0c47c2ce2121033a1b29be3232c2`. The push was a fast-forward (`e020865..0bfdfa2`), with no force and no merge. `git pull --rebase` ran again right before the push and reported the branch up to date.

| SHA | Message |
| --- | --- |
| `35a0023c1765a39cfdfb1e49937347946a4dcb11` | Page turns and the pager read the page below a tall notice stack (PR #74 fix2 1) |
| `c92446bb73086079233edc36f1005f12e07b3537` | A dismissed or shrunk notice lets the score settle up at once (PR #74 fix2 2) |
| `0bfdfa2f108b0c47c2ce2121033a1b29be3232c2` | Test that closing a nested confirm keeps viewer keys off under its dialog (PR #74 fix2 3) |

Files changed: `src/features/viewer/geometry.ts`, `geometry.test.ts`, `PdfViewport.tsx`, `PdfViewport.test.tsx`, `ink/GestureController.ts`.

## Major fix: a tall notice inset stalled page navigation (commit 35a0023)

The bug: `focusedPageIndex` counted any `scrollY <= 0` as page 1 and otherwise used the centre of the whole viewport. Page turns, however, already subtracted the top inset. In the repro, turning from page 1 to page 2 lands at scrollY −22, which still read as page 1, so navigation stalled.

What changed:

- **`focusedPageIndex(view, viewportHeight, layouts, obscured)`** (`geometry.ts`)
  - It now takes the covered strips.
  - Page 1 is returned only at the real top scroll bound, `−top inset`, which can be negative. It is no longer returned for any `scrollY <= 0`.
  - The last row is returned at the bottom scroll bound. Nothing more can come into view there, so it is where Next stops.
  - Otherwise it returns the page under the middle of the uncovered part of the viewport: below the top inset and above any bottom inset.
- **`pageTurnView`**
  - It skips rows that the scroll bounds swallow. Zoomed out, several rows near the end clamp to the same view.
  - It returns a turn only when the view actually moves in the requested direction. It returns null only when no turn would move the view, so Previous and Next are enabled exactly when a press does something.
  - Past the last row, Next goes on to the end of the last page.
  - On the first row, Previous goes back to page 1's top. I added this after the browser check: zoomed out, a stack that came up over page 1 left its top hidden while Previous was disabled.
- **Callers** (`PdfViewport.tsx`) all pass the same edges: `turnPage` (pager buttons, keyboard and pedal keys, edge taps), the Pager, the debounced store index, relayout, the rotation re-fit, and `reanchorView` (which now centres on the uncovered area).
  - The Pager now reads the focused page from the live view, not the 400 ms debounced store value. Its enablement can no longer lag a turn.

## Follow-up: re-clamp when a notice is dismissed or shrinks (commit c92446b)

- When `noticeInset` changes, `settleIntoBounds()` brings a view the bounds no longer allow back inside them, so no blank band is left above page 1.
  - **Motion:** a 180 ms ease-out cubic glide, or an immediate jump under `prefers-reduced-motion` (`lib/motion`).
  - **Other moves win:** if anything else moves the view (a pan, a turn or the follow glide), the glide stops.
  - **When it does nothing:** a growing notice never moves the view, and neither does a dismissal when the view is already clear of the freed space.
- **Mid-pan:** a new `GestureController.pointerActive` reports a finger, pen or mouse button down.
  - While a pointer is down, the settle is deferred and the pan clamp keeps the old room as slack: the view can never move further out than it was, can move back in freely, and nothing jumps under the finger.
  - When the last pointer lifts (a window `pointerup` or `pointercancel`), it settles.

## Nice-to-have (commit 0bfdfa2)

- A test opens a ConfirmDialog over a Dialog, cancels the confirm, and checks that with the parent still open, ArrowRight, Space and Ctrl+Z still do nothing.
- This is a regression guard. It passes on e0208659 too, because the behaviour was already correct.

## Tests added

All of these were run against e0208659's source with the new test files in place. **All 14 fail there**, and all pass at the new head. The two exceptions are the nested-confirm guard and a control case, both of which pass on both.

`PdfViewport.test.tsx` (integration; these drive the real ViewerNoticeRegion, Pager and keyboard):

- **Minimum zoom, short phone viewport**, run once through the Pager buttons and once through the arrow keys: three 612×792 pages, a 390×480 viewport, a 224 px stack, zoom 0.25.
  - Next goes 1 → 2 (scrollY −22 now reads p. 2) → 3. Page 3 ends up fully visible below the stack, and Next is disabled with no further movement.
  - Back goes 3 → 2 → 1, with Previous disabled at −224.
  - The label and Previous/Next enablement are checked at every step.
- **Fit width, stack past the viewport middle**, run through the pager and through the keys: a 390×400 viewport.
  - Forward to page 3. Each turn starts the next page just below the stack.
  - Next continues to the end of page 3, then is disabled.
  - Back to page 1, with the label and enablement checked at every step.
- **Zoomed out, notices came up over page 1:** Previous is enabled and brings page 1's top out from under the stack.
- **Dismissal:** each case clicks Dismiss on the real `SyncRejectedNotice`, then calls the ResizeObserver callbacks so the region re-measures and calls `onInsetChange`.
  - Under reduced motion the view settles to the new stack bottom at once.
  - Without it, the rAF glide is midway after 90 ms and at rest afterwards.
  - With a touch pointer down, the view does not move: a drag further out is held and a drag back in moves 1:1. It settles on `pointerup`.
  - Control case: a view already clear of the freed space is left alone.
- **Nested confirm** (the nice-to-have above).

`geometry.test.ts`:

- Under a 224 px stack:
  - The −22 view after turning page 1 → 2 at minimum zoom is page 2, and −224 is page 1.
  - Uncovered centre versus whole-viewport centre at fit width.
  - The bottom bound is the last page.
- `pageTurnView`:
  - Whole score fits: no turn either way.
  - Ten pages at minimum zoom: Previous from the end skips the swallowed rows and lands its row just below the top strip.
  - It goes on to the end of the last page and back to the top of the first.
- I updated the existing `pageTurnView` tests to pass a view consistent with the page they turn from. Some of them turned back from page 2 with the view at scrollY 0, which is now correctly "no movement". I also changed the "short last page" test from a viewport where everything fits, which is now no turn, to one where the clamp bites.

## Checks before push (on the final tree)

| Check | Result |
| --- | --- |
| `npm run lint:check` | pass |
| `npm run typecheck` | pass |
| `npm run test` | pass: 251 files passed, 6 skipped; 3939 tests passed, 22 skipped |
| `npm run build` | pass |
| `npx prettier --check` on every changed file | clean (`--write` was applied first) |

**One unexplained failure:** one earlier full-suite run, made before the end-of-score fallback was added, reported 1 failed test, and I did not capture which one. The next four full runs and six repeated runs of the two touched test files were all green. I could not attribute it to these changes.

## Real-browser verification (local stack, headless Chromium)

**Setup:**

- Generated 3-page and 6-page letter PDFs, each page labelled "PAGE n TOP / n / PAGE n BOTTOM".
- Signed in as teacher and opened them with "Open locally without uploading". Nothing was uploaded, and no seeded data was changed.
- **Simulated notices:** I could not trigger real notices non-destructively, so I injected notice cards (the notices' own classes, with fixed heights) into the real `[data-viewer-notices]` region. Its ResizeObserver then fed the inset to the viewer exactly as in the app.
- Zoomed to the minimum, went back to the top, paged forward with Next until it was disabled, then back with Previous until it was disabled. Each page's position was recorded from the DOM, and screenshots were checked by eye.

Results:

| Viewport | PDF | Stack bottom / viewport | Forward | Last page fully in view below the stack | Back | Dismiss |
| --- | --- | --- | --- | --- | --- | --- |
| iPhone SE (375×667) | 3 pp | 224 / 580 | p.1→2→3, Next off | yes (312–510, toolbar clear) | 3→2→1, Previous off | stack 224→108, page 1 top 228→112 |
| iPhone SE | 6 pp | 224 / 580 | p.1→…→6, one page per press | yes (312–510) | 6→…→1 | 224→108, page 1 top 228→112 |
| iPad mini portrait (768×1024) | 6 pp | 416 / 937 | p.1→3→5→6 | yes (735–933) | 6→5→4→3→1 | 416→152 |
| iPad landscape (1180×820) | 6 pp | 456 / 767 (past the middle) | p.1→…→6, one page per press | yes (565–763) | 6→…→1 | 456→162 |

- In every run, Previous was disabled exactly at page 1 (top bound) and Next exactly at the last page. There were no console errors.
- Before the start-of-score fallback was added, the iPhone SE run showed page 1's top under the stack with Previous disabled (zoom-out after the notices came up). Commit 35a0023 includes the fix and a test, and the re-run started cleanly at the top.

## GitHub CI

Both runs on head `0bfdfa2` finished green:

- **push run, CI #1044: success.** https://github.com/maxharris1/Cleffy/actions/runs/40054922033
- **pull_request run, CI #1045: success.** https://github.com/maxharris1/Cleffy/actions/runs/40054924998

All five jobs passed in both runs: checks (audit, lint, typecheck, test, build), supabase-local, supabase-drift, edge-functions-deno and omr-service.

## Open questions

1. **Minimum zoom on a tall iPad skips page numbers.** When two or three pages fit in the uncovered area, the focused page is the one in the middle of what is visible, so Next can step the label 1 → 3 → 5 (iPad mini). Every page still comes fully into view, and this "page under the centre" behaviour predates this PR and happens without notices too. Would you rather have turns step from the page at the top of the uncovered area (always exactly one row per press), with the label staying centre-based?
2. **Next now goes on to the end of the last page** (when its bottom is out of sight) instead of being disabled as soon as the last page is the focused one. This matches "Next is enabled while there is more score below" and fixes reaching the end. OK to keep?
3. **The re-clamp only follows notice changes.** It does not run when the toolbar or the phone's control strip changes the top edge. Do you want it there too?
