Status: Done
TIP=e05f94a95b081ff14b89ca44d636eda265142916 PR=https://github.com/maxharris1/Cleffy/pull/82

# Cleffy: fullscreen "on the stand" score mode (pstack factory ticket #1): report

- **PR:** https://github.com/maxharris1/Cleffy/pull/82 (draft, `agent/fullscreen-performance-mode` → `dev`, label `factory`). It was opened through the GitHub MCP tools because `gh` in this container has no valid token. No comments, reviewers or merges.
- **Head SHA:** `e05f94a95b081ff14b89ca44d636eda265142916`. One commit on top of `origin/dev` `214487230f70ac1fd0c2447cbc9fb42fbbfe7264`, authored as Max Harris <drumaxter@gmail.com>, pushed fast-forward. No force-push, no other branches touched (only this report branch), and #54 not touched.
- **Environment:** Claude Code cloud session `session_01J1SysPrTWyaihxjQQDBFeq`, environment **Cleffy `env_01WAd3yiz3qpSnsofpyEwCh2`** (anthropic_cloud), confirmed with `get_session`. It is not Sandbox. Local stack only: `npm run cloud:up` gave the app on http://localhost:5173 and the API on http://127.0.0.1:54421, and `npm run cloud:down` ran at the end (exit 0). No hosted Supabase and no Stripe. No `.env` or secrets committed or printed.

## What shipped

There is one new control: **Full screen** in the viewer header (cloud viewer and local viewer). It sits on the title row (`ViewerHeader` `titleAction`) so the header keeps the same height at every width. It turns on *stand mode*, where all viewer chrome is hidden: the header, annotation toolbar, pager, zoom and columns controls, notices, play-along bar and history pill. The score shows one whole page at a time, fitted and centred, as a single column.

- The Fullscreen API runs on the score element, with `webkitRequestFullscreen` / `webkitExitFullscreen` / `webkitfullscreenchange` for older iPadOS. Without the API (iPhone), the viewport is a fixed `inset-x-0 top-0 h-dvh z-[60]` overlay, and the viewer frame lifts itself with `has-[[data-stand-mode]]:z-[60]`. If the browser refuses full screen, the mode falls back to the overlay.
- Taps: the left 35% goes to the previous page, the right 35% to the next, and the middle toggles a controls pill (Prev, "Page X / Y", Next, Exit) for 3 s. The pill also shows on entry, so the way out is visible. Keys: ArrowRight, PageDown and Space (and ArrowDown) go forward; ArrowLeft, PageUp and Shift+Space (and ArrowUp) go back. Escape exits, and so does leaving full screen the browser's way. A horizontal swipe of 60px or more also turns the page.
- Guard: pages don't turn while the ink layer holds a pointer (stroke, erase or note drag), a text-note editor is open, or a dialog is open. In stand mode only `pointerType === 'pen'` draws (pen, highlighter or eraser). Fingers and the mouse always turn pages, even with Finger-draw on. Pages never wrap at either end.
- Screen Wake Lock: requested on entry, requested again on `visibilitychange` back to visible, released on exit or unmount. It does nothing where the API is missing or refused.
- Exit: the viewer returns to the page last shown, at its top, at the previous zoom relative to fit-width. If the page never changed, it restores the exact previous view. It holds through the resizes that leaving full screen causes. The controls' fade is `motion-safe` only.

Files: `src/features/viewer/stand/{standMode.ts,StandOverlay.tsx,standMode.test.ts,StandMode.test.tsx}`, `PdfViewport.tsx`, `geometry.ts` (+`pageFitView`, `pageTopView`), `geometry.test.ts`, `ink/GestureController.ts` (+`inkActive`), `state/store.ts` (+`standMode`), `ViewerHeader.tsx` (+`titleAction`), `ViewerPage.tsx`, `LocalViewerFrame.tsx`, `ui/icons.tsx` (+`FullScreenIcon`).

## Checks (on the pushed tree)

| Check | Exit | Result |
| --- | --- | --- |
| `npx prettier --check <changed files>` (after `--write`) | 0 | all formatted |
| `npm run lint:check` | 0 | clean |
| `npm run typecheck` | 0 | clean |
| `npm run test` | 0 | 273 files passed (6 skipped); 4267 tests passed (22 skipped) |
| `npm run build` | 0 | built |

The first full test run had two failures:
- `src/lib/viewportZoom.test.tsx` failed because it matches the literal `className="ink-surface ` in `PdfViewport.tsx`. I fixed this by moving the stand classes to `data-stand-mode:` variants.
- `tests/auth/turnstileField.test.tsx` passed when rerun alone and in the next full run. It is a timing flake under full-suite load and unrelated to this change.

The final full run above is green.

New tests: 23 unit tests (tap zones at 35%, every key mapping, modifiers ignored, no wrap, the input guard, pen-only inking, Fullscreen API / webkit prefix / no-API fallback / refusal, wake lock acquire, late-grant release, refusal, and Escape-from-fullscreen exit). 14 component tests through `PdfViewport` (chrome hidden and page fitted; pedal keys with no wrap; tap zones and controls; 3 s timeout; finger tap with Finger-draw on; no turn mid-Pencil-stroke; Esc and Exit; return to the page; exact view restore; starting on the page being read; focus on the header button; wake lock; view-only member; unmount ends the mode). 7 geometry tests.

## ui-check (`scripts/ui/uifuzz.mjs`, headless Chromium, screenshots reviewed)

Viewports: desktop-1440, ipad-landscape, ipad-portrait, iphone-14, iphone-se and iphone-landscape. The flow on each, all passing: open the cloud viewer → Full screen → ArrowRight → wait 3.5 s → tap/click at 85% width → tap the middle → tap at 10% width → Exit. Each viewport went into full screen (or the fixed 100dvh overlay with the Fullscreen API stubbed out on iPhone/Android), showed one page, turned pages, showed and hid the controls, and exited with the pager reading **p. 2 / 4** (the last page shown). No console errors.

Extra runs:
- iPad portrait with `reducedMotion: 'reduce'`: no animation (`animation-name: none`) vs `ui-fade-in 0.18s` without it.
- A synthetic Pencil stroke on the page with ArrowRight/PageDown pressed mid-stroke: the page held (Page 1/4) and the stroke drew. After the pen lifted, ArrowRight turned to 2/4. I undid the test mark; the local DB shows 0 live annotations on that score.
- Local (on-device) viewer on iPhone SE without the Fullscreen API: it entered, turned pages and exited.

Screenshots (session scratchpad, ephemeral): `/tmp/claude-0/-home-user-Cleffy/88d2326e-2679-5387-8694-01e9bdf91ade/scratchpad/shots/`. Names follow `<viewport>-1-normal`, `-2-stand-entered`, `-3-stand-page2-clean`, `-4-stand-controls` and `-5-exited`, plus `ipad-portrait-6-stand-pencil-mark`, `ipad-portrait-7-exited-with-mark` and `iphone-se-local-stand-controls`.

### Bugs found during ui-check (both fixed before push)

1. **The header grew a row on iPhone 14.** Viewport iphone-14 (390×844), route `/doc/b0000000-0000-4000-8000-000000000002`. Steps: open the score and look at the header. With the toggle in the action row, Share wrapped to a third row: the header went from 87px to 127px, so the score lost 40px. Screenshot `iphone-14-1-normal.png` (first run). Fix: the toggle moved to the title row with `-my-1`. The header height is now identical with and without it at all 7 widths measured (87/127/53px, unchanged from before).
2. **The controls' fade ignored reduced motion.** Viewport ipad-portrait with `reducedMotion: 'reduce'`, same route. Steps: Full screen, then read the computed `animation-name` of the controls pill. It was `ui-fade-in`, because the unlayered `.ui-scrim-fade` rule beats Tailwind's `motion-reduce:animate-none`. Fix: `motion-safe:animate-[ui-fade-in_…]`. Verified `none` under reduce.

### Environment notes (not bugs in this change)

- The seeded local scores have **no PDF in local storage**, so every seeded score opens as "Couldn't open this score" in the local stack. To exercise the cloud viewer, I uploaded generated 2- and 4-page staff-paper PDFs to the *local* storage paths of seeded scores 1 and 2 (`scores/b0000000-…-000000000001/original.pdf`, `…-000000000002/original.pdf`) with the local service role. No rows were renamed or deleted, and no hosted project was touched. It may be worth adding fixture PDFs to the seed.
- Headless Chromium mobile emulation still has the Fullscreen API. The iPhone fallback was exercised by deleting `Element.prototype.requestFullscreen` and forcing `fullscreenEnabled = false` in an init script. Real iPhone and iPad Safari (the webkit path, the dvh overlay, the Pencil and the Wake Lock) were **not** tested on hardware.
- The seeded student has no score memberships, so view-only was covered by a component test, not a live click-through.

## Acceptance criteria

- [x] **1.** One toolbar toggle ("Full screen", header title row; no other controls added) enters a mode that hides all app chrome; only the score shows.
- [x] **2.** Fullscreen API including the webkit prefix, with a 100dvh fixed-overlay fallback where the API is missing or refused.
- [x] **3.** Right 35% next, left 35% previous; a centre tap shows Exit, "Page X / Y" and prev/next for about 3 s; ArrowRight/PageDown/Space next, ArrowLeft/PageUp/Shift+Space previous; Esc exits; swipe is included.
- [x] **4.** No paging while annotating or drawing (the ink pointer is held, a text note is open, or a dialog is up; on the stand only a pen inks, so a finger never becomes a mark); no wrap at either end.
- [x] **5.** Screen Wake Lock held while in the mode (graceful if unsupported), released on exit.
- [x] **6.** Exit returns to the same page; the only transition (the controls' fade) respects prefers-reduced-motion.
- [x] **7.** Unit and component tests for the paging and input-guard logic; ui-check at desktop, iPad and phone with screenshots reviewed.
- Out of scope, untouched: two-page spreads, auto-scroll, backend and Supabase.

## Open questions

1. **What does "return to the same page" mean?** I took it as *the page last shown on the stand* (if you paged to p. 5, exit leaves you on p. 5). If Max meant *the page you entered from*, that is a one-line change in `PdfViewport` (`standReturnRef`).
2. **The `/try` demo has no toggle.** It is a marketing surface; it would take one prop (`titleAction={<StandModeButton />}`) in `DemoViewer.tsx`. Should it get one?
3. **Pen taps in stand mode.** On the page they draw; in the grey margin they turn pages. Is that right for Pencil users, or should the pen never turn pages?
4. **Unhandled report step.** The packet asks that the result be sent to Cleffy (556e14b2-f903-48fc-aca8-b60bfbedde75). That id is not a session id this session can address, so it was not sent from here; this report and the PR are the hand-off.
5. **Hardware check.** Recommend a real iPad + Pencil + Bluetooth pedal and an iPhone check in QA, since headless Chromium can't fully reproduce WebKit.
