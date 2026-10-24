# Cleffy PR #74 pass 5: lazy-load the Base UI dialog and menu

**Status:** Complete
**PR:** https://github.com/maxharris1/Cleffy/pull/74 (still a draft, base `dev`, not merged) · **Branch:** `mh/ui-polish-emil` · **New head:** `5f96e3c7e79354180a0bbed989035b62b40c56a6`
**Checks on the new head (local):** lint:check ✅ · typecheck ✅ · test ✅ (254 files; 3967 passed, 22 skipped) · build ✅ · prettier ✅ (all changed files)
**GitHub CI on the new head:** ✅ all green on 5f96e3c — checks ✅, supabase-local ✅, supabase-drift ✅, edge-functions-deno ✅, omr-service ✅ (push and pull_request runs), Vercel Preview Comments ✅, Supabase Preview skipped
**Open questions:** see [Open questions](#open-questions) (4 items, none blocking).

## Environment

- Ran in the **Cleffy** cloud environment (`env_01WAd3yiz3qpSnsofpyEwCh2`, anthropic_cloud), confirmed with `get_session` and `list_environments`.
- Local stack only: `npm run cloud:up`, with local Supabase at 127.0.0.1:54421. Browser checks ran against `vite preview` of the production build (port 4173), plus a second preview of the old head for comparison. `npm run cloud:down` was run at the end. I made no hosted Supabase calls, used no Stripe, and did not run `playwright install`.
- Git: started on `dev`, then `git fetch origin && git checkout mh/ui-polish-emil`. I ran `git pull --rebase` before starting and again before the push; both were already up to date. The push was fast-forward only, with no force-push and no merges. PR #54, `main` and `dev` were not touched. Commits are authored as Max Harris <drumaxter@gmail.com>.

## Heads and commits

- Old head of `mh/ui-polish-emil`: `b7162c9e146c03f78f786484b942bccf9bc330d7` (as expected)
- New head: `5f96e3c7e79354180a0bbed989035b62b40c56a6`
- Commit: `5f96e3c` **Load the Base UI dialog and menu on demand (PR #74 pass 5)**, with 27 files changed (+1095 / −346).

## What changed

- **`src/ui/Dialog.tsx`** is now a thin wrapper with no Base UI import.
    - In a layout effect, it adds itself to `dialogStack` in the same commit it mounts, before the panel has loaded. A key pressed while the chunk is still on its way therefore already sees `isDialogOpen()` as true.
    - It renders the panel through `React.lazy` with `<Suspense fallback={null}>`.
    - Once the chunk has loaded, later dialogs render the panel directly, without suspending a frame. Each dialog picks its component once, so it is never remounted.
- **`src/ui/DialogPanel.tsx`** (new lazy chunk) is the previous Base UI implementation, moved with `git mv`. It is unchanged except that its stack id now comes from the wrapper.
    - Focus trap, return focus, Escape on the top dialog only, the scrim rule, the alertdialog scrim not closing it, sheet drag and reduced motion (CSS) are all as before.
- **`src/ui/Menu.tsx`** is a wrapper with no Base UI import.
    - Until `ui/MenuBase` has loaded, it renders a stand-in `<button>` with the same classes, `aria-label`, `title`, `disabled`, `aria-haspopup="menu"` and `aria-expanded`.
    - Pointerenter, focus and pointerdown on the stand-in warm the chunk. A press made before the chunk arrives opens the menu once it does; a controlled menu (the account menu) gets `onOpenChange(true)`.
    - The swap to the real trigger never happens under a pointer that is over or pressing the stand-in. That would drop the hover style in Safari until the mouse moves, or lose a touch's click. When the swap does happen, focus is carried over.
    - `MenuItem` and `MenuSeparator` render the loaded parts. Disabled items are still `aria-disabled` and focusable.
- **`src/ui/MenuBase.tsx`** (new lazy chunk) is the previous Base UI menu, moved with `git mv`. It gains `defaultOpen` (for a press that came before the chunk) and `focusTrigger`.
- **`src/ui/lazyModule.ts`** is a small loader:
    - it imports once, retries after a failure, and can be read synchronously and subscribed to once loaded;
    - prefetches go through `loadAsPrefetch`, so a stale chunk met during a prefetch does not reload the page.
- **`src/ui/lazyPrimitives.ts`** holds the two lazy modules and `installPrimitivesPrefetch()`, called from `main.tsx`. It warms both chunks on idle (`prefetchWhenIdle`), or on the first `pointerover` or `focusin` of a button, whichever comes first. The service worker precaches these chunks anyway, so warming them costs no extra download.
- Not changed, as asked:
    - theme-color stays paper `#f7f5ef`;
    - initials come from the first and last word;
    - menu items stay aria-disabled but focusable;
    - the alertdialog scrim does not close it.

## Bundle sizes (from `npm run build` output, gzip)

|                                                                | Before (b7162c9)                       | After (5f96e3c)                        | Δ                         | `dev` (4d7d2d3), for reference |
| -------------------------------------------------------------- | -------------------------------------- | -------------------------------------- | ------------------------- | ------------------------------ |
| **Entry chunk** (`index-*.js`)                                 | 350.75 kB raw / **110.65 kB**          | 307.04 kB raw / **94.85 kB**           | **−15.80 kB (−14.3%)**    | 100.05 kB                      |
| **Initial JS** (entry + every `modulepreload` in `index.html`) | 899.14 kB / **287.10 kB** (36 files)   | 753.71 kB / **236.19 kB** (36 files)   | **−50.91 kB (−17.7%)**    | 232.39 kB (25 files)           |
| **Total JS** (every chunk with a gzip column)                  | 2531.67 kB / **851.13 kB** (92 chunks) | 2538.69 kB / **855.71 kB** (99 chunks) | +4.58 kB (split overhead) | 781.49 kB                      |

- The four workers have no gzip column in the build output. They are the same files and sizes before and after: detect 7.87 kB, rebuild 423.82 kB, export 1143.78 kB and pdfWorkerEntry 1190.27 kB raw.
- The modulepreloaded `Dialog-*.js` chunk was **25.49 kB** gzip and held Base UI Dialog, AlertDialog and the shared floating/scroll-lock code. It is now the 2.23 kB wrapper. Base UI Menu was about 16 kB of the entry chunk.
- Sourcemaps confirm that no `@base-ui` or `@floating-ui` module is left in any initial chunk.
- What a first open now loads (all lazy):
    - a dialog: `DialogPanel` 4.87 kB + shared `composite` 18.98 kB + `useOpenInteractionType` 2.04 kB, about **26 kB**;
    - a menu: `MenuBase` 14.14 kB + `ToolbarRootContext` 11.71 kB + `useTriggerFocusGuards` 2.94 kB, plus the same shared chunks.
- Measured the same way, PR #74 had added **+54.71 kB** to initial load over `dev`. It now adds **+3.80 kB**, and the entry chunk is 5.2 kB smaller than `dev`'s.
- These numbers come from my own measurement (a script over the build log and `index.html`). The PR description's 224.9 → 277.4 kB came from an earlier run with a different method, so compare within one column set only.

## Tests

- **New tests** (19 new test cases; suite 3948 → 3967 passed):
    - `src/features/viewer/PdfViewport.test.tsx`, _"stands the keys down on the very first open of a lazy dialog, before its chunk has loaded"_. This is the requested test. It loads fresh modules so the chunk is cold, then opens a `ConfirmDialog` over the viewer. While the panel is not yet rendered, it checks that ArrowRight, Space, PageDown and Ctrl+Z do nothing. Once the alertdialog arrives the keys stay suppressed, and after Cancel the pages turn again.
    - `src/ui/Dialog.test.tsx`, a new _"Dialog, lazily loaded"_ block:
        - the dialog is on the stack before the panel loads, with an empty container and no portal (fallback null);
        - focus moves in and returns to the opener on a lazy first open;
        - once the chunk is loaded, the dialog renders in the same commit.
    - `src/ui/Menu.test.tsx` (new, 9 tests): the stand-in's attributes and the swap; warming on hover and focus; focus carried over on the swap; a press before the chunk opens the menu, with a disabled item still `aria-disabled`; a controlled menu gets `onOpenChange(true)`; the swap is held mid-press and while hovered; a hover-and-click first use, then Escape returns focus to the real trigger; a disabled menu does not open.
    - `src/ui/lazyModule.test.ts` (4 tests) and `src/ui/lazyPrimitives.test.ts` (2 tests).
- **Updated tests** (sync mount → `await` / `findBy`, no assertion removed or weakened): Dialog, PricingDialog, DeleteAccountSection, AccountPage, AuthLinkErrorNotice, AddToHomeScreenDialog, LibraryPage (a small `openScoreMenu` helper), RosterPage, AssignDialog, ShareDialog, FingeringReviewPanel (an `openPanel` helper), InkSaveFailedNotice, ScoreSourceButton, SignedOutInkNotice and ViewerPage.
    - Some absence checks (`queryBy… .not`) used to pass before the dialog had even mounted. They now wait for the dialog first, so they actually test something.
- **How I made the tests order-independent:**
    - I temporarily patched `Dialog`/`Menu` so that _every_ mount took a cold lazy path. I fixed every test that broke (98 under that simulation), then reverted the patch.
    - `src/test/setup.ts` warms vitest's module cache for the two chunks in a `beforeAll`. It does not mark them loaded, so components still take the lazy path. This keeps a cold transform (about 330 ms) from running past `findBy`'s 1 s timeout on a busy CI runner.

## Verified in a real browser

- **Setup:** headless Chromium via `scripts/ui/uifuzz.mjs`, against the **production build** (`vite preview`) and the local stack, logged in as the seeded teacher.
- **Viewports:** iPhone SE (375×667, touch), iPad portrait (820×1180, touch) and iPad landscape (1180×820, touch).
- **Modes:**
    - _warm_: the normal page, with idle prefetch;
    - _cold_: the chunks delayed 400 ms by the network and a fresh page load straight onto /library, tapping straight away;
    - _reduced motion_: iPhone SE.
- **Latency** is measured in the page, from pointerdown to the surface's role appearing in the DOM.

| Surface                        | iPhone SE warm | iPhone SE cold | iPad portrait warm | iPad portrait cold | iPad landscape warm | iPhone SE reduced motion |
| ------------------------------ | -------------- | -------------- | ------------------ | ------------------ | ------------------- | ------------------------ |
| Account menu (first open)      | 40 ms          | 385 ms*        | 38 ms              | 413 ms*            | 47 ms               | 33 ms                    |
| Score actions menu             | 18 ms          | 23 ms          | 25 ms              | 22 ms              | 23 ms               | 18 ms                    |
| Rename dialog                  | 22 ms          | 23 ms          | 21 ms              | 22 ms              | 27 ms               | 36 ms                    |
| Share dialog                   | 13 ms          | 14 ms          | 12 ms              | 13 ms              | 12 ms               | 13 ms                    |
| Delete alertdialog             | 11 ms          | 12 ms          | 10 ms              | 11 ms              | 11 ms               | 10 ms                    |
| Lesson history (sheet, viewer) | 7 ms           | 9 ms           | 9 ms               | 11 ms              | 11 ms               | 11 ms                    |

\*The cold first open waits for the 400 ms artificial delay, as intended: the menu opens as soon as the chunk arrives. In normal use the chunks are prefetched at idle long before anyone opens a menu. On the warm runs they were fetched about 0.4 s after the login page rendered, not with the initial load.

On every run:

- **No layout shift:** the account trigger moves 0 px between the stand-in and the real trigger, and nothing flashes before a dialog appears (fallback null; screenshots checked).
- **Focus:** focus moves into the dialog. Escape on a menu returns focus to its trigger.
- **Alertdialog:** a tap on the scrim leaves "Delete this score?" open, and Cancel closes it.
- **Page turns:** in the viewer, ArrowRight and ArrowLeft turn pages (p. 1/4 → 2/4 → 1/4). With Lesson history open, ArrowRight and Space do nothing; after it closes, the keys turn pages again.
- **Cold viewer dialog:** I held the `DialogPanel` chunk in the network on iPhone SE and on iPad portrait, then tapped Lesson history. No dialog was on screen yet, and ArrowRight, Space and PageDown did **not** turn the page. When I released the chunk, the sheet opened and the keys stayed suppressed. After Escape they worked again.
- **Console:** no errors on any run (apart from the storage 404s noted below).
- **One behaviour checked against the old head:** after a dialog closes, focus is (correctly) back on its trigger button, and the viewer ignores arrows aimed at a button. Pages turn again once focus leaves it. I built and served b7162c9 and saw identical behaviour, so this is not a regression.
- **The viewer used a local fixture PDF.** I opened `e2e-fixtures/test-score.pdf` (4 pages) with "Open locally without uploading" because the seeded scores' PDFs are missing from local storage (`NoSuchKey`, 400). That happens on the dev server too and is not related to this change.

## Open questions

1. **Menu first use without prefetch** (only if a press comes before the chunk has loaded, which idle prefetch makes rare):
    - the menu opens on click (after release) rather than on Base UI's mousedown;
    - press-drag-release selection is not available on that one first use;
    - keyboard Enter opens it without highlighting the first item.

    Every open after that is pure Base UI. Is that acceptable, or should the stand-in also imitate the mousedown open?

2. **Popover is still eager on the viewer route.** `PresenceBar`'s Base UI Popover is in the viewer route chunk (lazy already, but loaded with the viewer). `ShareExportMenu` and `FingeringSelectionPopover` are already in lazy chunks. Should PresenceBar's popover get the same lazy treatment in a follow-up?
3. **Local build inlines extra env values.** `src/lib/supabase.ts` and `src/features/billing/pricing.ts` read `import.meta.env[key]` with a dynamic key, so Vite inlines the whole `VITE_*` env object. In this container's local build, that included the hosted dev/prod URLs and anon keys from the local env file (pre-existing on `dev`, not this change).
    - While checking that the build targeted the local stack, I printed the tail ends of those two anon keys into my session's tool output. They are public client keys, and nothing was committed or sent anywhere.
    - Worth checking that production builds only carry the intended vars.
4. **Seeded score PDFs are missing from local storage** (`NoSuchKey`), so seeded scores cannot be opened in the local viewer. Should the seed upload them?
