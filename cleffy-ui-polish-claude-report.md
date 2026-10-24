# Cleffy UI polish (Emil Kowalski pass): report

**Status:** Complete

All five phases are implemented on `mh/ui-polish-emil` and every check passes. The draft PR into `dev` is open, the media branch is pushed, and the local stack is shut down. Nothing was merged, and `main`, `dev` and PR #54 were not touched. Hosted Supabase was not used.

## PR

- **Draft PR:** https://github.com/maxharris1/Cleffy/pull/74 (`mh/ui-polish-emil` → `dev`), titled "UI polish: Emil Kowalski design-engineering pass"
- **Head SHA:** `07dd982ac908112e29055db9d3298766eb19fa63`
- **Base:** `dev` at `4d7d2d3076bee7b3b7836b42d2297a99774075e6`
- **Commits:** one per phase, in order, authored by Max Harris <drumaxter@gmail.com>

| Phase                                           | SHA       | Summary                                                                                                                                                                                                                             |
| ----------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Foundations (+ `docs/ui-improvement-plan.md`) | `c6d477e` | Hover gated on fine pointers; control chrome; overscroll containment; `@theme` motion tokens replace the 13 curve literals; no bare `transition`, with a guard test; reduced motion and reduced transparency                        |
| 2 Touch & inputs                                | `de40000` | `hit-44` / `hit-44-y` coarse-pointer hit areas and a shared `CloseButton`; 16px fields on touch; BPM and upgrade-code inputs go through `fieldClassName`; viewer zoom lock removed; `tabular-nums`                                  |
| 3 Feedback & motion                             | `84d383e` | Press scale; instant tool switching; no replayed entrances; dialog/menu entrances; ProgressBar `translateX`; linear sweep; playhead rAF sleeps while paused (+test); pan/zoom transform written via store `subscribe`; fewer blurs  |
| 4 Primitives                                    | `58bdc9f` | Scrim fix (+regression test); `@base-ui/react`; Dialog and alertdialog on Base UI; sheet drag-to-close (+test); the five menus on Base UI Menu/Popover; `ViewerHeader` leak and Toolbar ARIA fixed                                  |
| 5 Layout & robustness                           | `07dd982` | `ViewerNotice` overlay region; `SignedOutInkNotice` clears the toolbar; safe areas; `theme-color` (+test); grapheme-safe `initialsOf` (+tests); `useFlash` timer for "Copied!" (+tests); title fixes; touch alternatives to `title` |

## Lint, typecheck, test, build

All run on the final head (`07dd982`) and before every push. `npx prettier --write` was run on the changed files each time.

- `npm run lint:check`: pass (0 problems)
- `npm run typecheck`: pass
- `npm run test`: pass — 250 files passed, 6 skipped; 3920 tests passed, 22 skipped. One run during Phase 1 had a single failure in `tests/auth/turnstileField.test.tsx` ("refuses to submit the sign-up form until the check is finished", 52ms, a timing assertion). It passed in three isolated reruns, in the `dev` worktree, and in every later full-suite run. That file is not touched by this branch.
- `npm run build`: pass

Test changes that follow from the new primitives:

- Confirmations are queried as `alertdialog`.
- Menu items are found with `findByRole`, because Base UI mounts the popup a tick after the click.
- Content behind an open modal is queried with `hidden: true`, because it is now inert.
- A disabled menu item is asserted through `aria-disabled`.

## ui-check before/after

I ran `scripts/ui/uifuzz.mjs` at all 9 viewports. Before came from a `dev` worktree at `4d7d2d3` served on :5174; after came from this branch on :5173. The screens were landing, login, library, IMSLP search, roster, account and viewer, plus student assignments at 3 viewports. I looked at every screenshot through contact sheets.

- **`audit()` candidates** (counts identical before and after unless noted):
    - Landing, login, library, IMSLP search, roster and account match at every viewport.
    - Viewer, touch viewports: 0 → 1. The new candidate was the tap-to-expand viewer title (20px tall). It now has a 44px touch hit area, added in the amended Phase 5 commit.
    - Library on iPhone 14: 11 → 12. The extra one is the card title link, which is a stretched link covering the whole card, so it is a heuristic false positive.
- **Console errors per run:** 18 before, 1 after.
- **Checked by hand in the browser:**
    - The ink stroke stays on the music mid-pan, after pan, and during live and settled zoom.
    - Escape returns focus to the menu trigger.
    - A text-selection drag out of a dialog no longer closes it; a scrim click does.
    - The notice region floats over the score without moving it (score top identical before and after the notice).
    - Measured toolbar hit areas are 44px everywhere except the phone toolbar width (see deferred items).
- **Same in before and after:** IMSLP search shows "Worker failed to boot" locally. The student account lands on an empty library.

## Media

- **Branch:** https://github.com/maxharris1/Cleffy/tree/mh/ui-polish-emil-media at `8bbb0e9e8a7c36c46add7e3ee5d415e8763a8cb7`, based on `dev`. It holds media only and was never pushed to the PR branch.
- **Files** (all under `media/ui-polish-emil/`, 168 files, about 38 MB, each under 25 MB):
    - `README.md`: index and capture notes
    - `videos/walkthrough-desktop.mp4`: 1440×900, about 73 s, 1.6 MB
    - `videos/walkthrough-ipad.mp4`: `iPad Pro 11`, `hasTouch`, `isMobile`, real touch taps, about 68 s, 1.8 MB
    - `screenshots/before/` (66 PNG) and `screenshots/after/` (66 PNG): the 7 screens at 9 viewports, plus assignments at 3
    - `screenshots/before-summary.json`, `screenshots/after-summary.json`: audit counts
    - `screenshots/after-interactions/` (16 PNG): Base UI menus, share dialog, export popover, lesson-history sheet, notice overlay, expanded title
    - `screenshots/contact-sheets/` (16 JPEG): before and after, one per screen
- **Raw links:**
    - https://raw.githubusercontent.com/maxharris1/Cleffy/mh/ui-polish-emil-media/media/ui-polish-emil/videos/walkthrough-desktop.mp4
    - https://raw.githubusercontent.com/maxharris1/Cleffy/mh/ui-polish-emil-media/media/ui-polish-emil/videos/walkthrough-ipad.mp4
- **Both videos cover, in order:**
    1. landing
    2. teacher sign-in
    3. library: entrance, hover and press, menu keys
    4. IMSLP typing
    5. viewer: tool switching, pan/zoom, page turn, notice
    6. export menu
    7. share dialog and history sheet, opened and closed
    8. roster, then assignments as the student
    9. `reducedMotion: 'reduce'`
- **Stubs in the recordings** (via `page.route`):
    - IMSLP search results, because the local edge function can't boot.
    - A 403 sync refusal, to raise the notice. The refused stroke rolls back, so nothing is written.
    - A dot drawn in the page stands in for the pointer, since headless video has no cursor.

## Base UI bundle delta

`@base-ui/react@1.9.0`, published 2026-10-09, is the only new dependency. Production build, gzip:

|                                                   | dev       | after phase 3 | after phase 4                 |
| ------------------------------------------------- | --------- | ------------- | ----------------------------- |
| Initial load (index.html script + modulepreloads) | 224.8 kB  | 224.9 kB      | **277.4 kB (+52.5 kB, +23%)** |
| All JS                                            | 1783.7 kB | 1784.4 kB     | 1842.1 kB (+57.7 kB)          |
| CSS                                               | 14.4 kB   | 15.2 kB       | 15.3 kB                       |

Most of the Base UI code sits in the eagerly loaded Dialog chunk (1.2 → 25.2 kB gzip) and a floating/scroll-lock chunk (11.7 kB).

## Deferred items, partial items and why

Nothing in the plan was deferred outright. The pan/zoom subscribe change showed no ink drift. The sheet drag fit in about 55 lines with no new dependency. The zoom-lock removal showed no regression in what I could test. The rest is partial or unverified:

- **Phone toolbar width.** The nine bar buttons sit edge to edge on a 360–390px phone, so each is 37–39px wide. Height reaches 44px through `hit-44-y`, and together the hit areas tile the whole bar, but a wider target would need fewer buttons, which is out of scope.
- **Not verified on real devices:**
    - Pinch over the viewer's header and transport now zooms the page on Android, which is the intended WCAG behaviour. A pinch on the score stays with GestureController through `.ink-surface` `touch-action: none`. Only checked by test and emulation.
    - `SignedOutInkNotice` clearance above the phone toolbar is in place but was not triggered in the browser; it needs a signed-out account holding unsaved ink.
    - `FingeringSelectionPopover` is on Base UI Popover, but the feature flag is off in this release, so only unit tests ran.
- **Not exercisable locally:** live IMSLP search, because the edge runtime cannot fetch npm through the sandbox proxy. A real roster, because the seeded teacher is on the Free plan and the seeded student isn't roster-linked, so `/assignments` redirects to an empty library.
- **"Toolbar fade, remove anyway"** was taken to mean the score-card action pills' 150ms opacity fade (ScoreCard `REVEAL`), which now appears at once. The viewer toolbar itself had no fade.

## Local test data

- **Seeded PDFs.** The local seed has no PDFs for the three seeded scores, so the viewer showed "Couldn't open this score". I generated staff-paper PDFs and uploaded them to local storage at the seeded paths (2, 4 and 1 pages). Nothing was renamed or deleted.
- **Test annotations.** One stroke from a drift test was soft-deleted. The three lesson-history snapshot rows my tests created were deleted. The local DB has no annotations or snapshots left from this session.
- **Stack shutdown.** `npm run cloud:down` was run at the end, and the extra Vite on :5174 was stopped.

## Open questions

1. Is +52.5 kB gzip on the initial load acceptable for Base UI? If not, Dialog and the menus could load lazily: most dialogs are already behind interactions, but `Dialog` is imported eagerly by the library shell and viewer.
2. Confirmations are now alertdialogs that a scrim press does not dismiss (Escape and Cancel still do). Keep that, or restore scrim dismissal?
3. `theme-color` and the manifest `theme_color` changed from indigo to paper. The viewer header is white rather than paper. Paper everywhere, or per route?
4. `initialsOf` is unified on first and last word. The account page used first and second (e.g. "Mary Ann Smith": MA → MS). OK?
5. Disabled menu items stay focusable with `aria-disabled` (Base UI's choice) instead of `disabled`. OK?
6. Should the local seed upload PDFs for the seeded scores, so the viewer works on a fresh `cloud:up`? This PR does not touch the seed.
