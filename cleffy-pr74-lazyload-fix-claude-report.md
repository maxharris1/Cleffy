# Cleffy PR #74 lazy-load fix pass (narrow): report
**Status:** Complete
**PR:** https://github.com/maxharris1/Cleffy/pull/74 (draft, base `dev`, left draft and unmerged) · **Branch:** `mh/ui-polish-emil` · **New head:** `c52c708fbaf968ab60c2b3265cc4fffac7c0874e`
**Checks (local, on c52c708):** lint:check ✅ · typecheck ✅ · test ✅ (254 files / 3983 passed, 22 skipped) · build ✅ · prettier ✅ (`--check` clean on every changed file) · **GitHub CI on c52c708:** ⏳ pending at report time: `omr-service`, `edge-functions-deno`, `supabase-drift` and Vercel Preview Comments passed; `checks` and `supabase-local` still running (this report will be updated when they finish)
**Open questions:** see the "Open questions" section below (4 items: bundle +~0.7 kB, a dropped keyboard open after blur, `onClose` vs `onOpenChange`, the notice's copy and design).

## Environment
- Ran in the **Cleffy** cloud environment (`env_01WAd3yiz3qpSnsofpyEwCh2`, kind `anthropic_cloud`), confirmed with `get_session` + `list_environments`.
- Local stack only: `npm run cloud:up` (background) for the browser check, `npm run cloud:down` at the end. Hosted Supabase and Stripe were not touched. `playwright install` was not run (used the preinstalled Chromium through `scripts/ui/uifuzz.mjs`).
- Commits authored as Max Harris <drumaxter@gmail.com>. One fast-forward push (`5f96e3c..c52c708`). No force-push, no merges, nothing pushed to main or dev, #54 not touched.

## Heads
- Old head of `mh/ui-polish-emil`: `5f96e3c7e79354180a0bbed989035b62b40c56a6` (matches the expected start; `git pull --rebase` before work and before push both said up to date).
- New head: `c52c708fbaf968ab60c2b3265cc4fffac7c0874e`.

## Commits
| SHA | Message |
| --- | --- |
| `b53165d` | Open a cold menu from the keyboard, and recover when its chunk fails (PR #74 lazy-load fix 1, 2) |
| `c52c708` | Close a dialog on Escape while its panel is still loading (PR #74 lazy-load fix 3) |

Findings 1 and 2 share one commit because both change the same stand-in trigger in `src/ui/Menu.tsx`.

## What changed, per finding
Files: `src/ui/Menu.tsx`, `src/ui/MenuBase.tsx`, `src/ui/Dialog.tsx`, plus `src/ui/Menu.test.tsx` and `src/ui/Dialog.test.tsx`. Nothing else changed.

### 1. Menu: a foreground open whose chunk import fails was swallowed (Menu.tsx ~L70)
- The open's `menuBase.load().catch(() => undefined)` is replaced by `loadForOpen`. When the open's import rejects, including when the open joined a prefetch that was already in flight (the same `pending` promise, whose error `loadAsPrefetch` marks so the global `vite:preloadError` handler skips the reload):
  - **Chunk error** (`isChunkLoadError`): goes to `reloadForStaleChunk()`, the guarded path ErrorBoundary already uses (online, sessionStorage guard, once per 60 s). If a reload starts, or one is already under way, nothing else happens.
  - **Reload not possible** (offline, a reload moments ago, unusable storage) **or a non-chunk error**: the open is taken back (`openOnLoad` reset; a controlled menu gets `onOpenChange(false)` after the early `onOpenChange(true)`). A `role="alert"` notice is portalled under the trigger, where the menu would have opened and inside the 16 px gutter: "This menu couldn’t open. Check your connection, then try again." (offline: "You’re offline, so this menu couldn’t open. Reconnect, then try again."). Pressing the trigger again retries the import; any press elsewhere, a scroll or Escape dismisses the notice.
- Prefetch-only failures (hover, focus, idle) are still silent, as before.

### 2. Menu: the stand-in ignored ArrowDown/ArrowUp, and Enter/Space did not land on an item (Menu.tsx ~L73)
- The stand-in now handles `onKeyDown`. ArrowDown and ArrowUp are captured (with `preventDefault`, as Base UI's trigger does). Enter and Space are recognised by a keydown flag that the click they produce consumes; that click opens as ArrowDown. A pointer press (or a click with no key before it) opens exactly as before.
- Once the chunk is in, `MenuBase` gets a new `openWithKey` prop. In a layout effect it replays that key as a `keydown` on the real Base UI trigger, after `focusTrigger` has moved focus there. Base UI then opens the menu through its own list-navigation path, as a keyboard open: **first item focused for ArrowDown/Enter/Space, last item for ArrowUp.** That matches Base UI by construction, and a parity test checks it against an already-loaded menu. A controlled menu is asked to open through Base UI's `onOpenChange(true)`.
- A keyboard open whose stand-in lost focus before the chunk arrived is dropped (see Open questions).

### 3. Dialog: Escape while the panel chunk is loading did not cancel (Dialog.tsx ~L57)
- While its panel is pending, the eager `Dialog` wrapper listens for Escape on `document` (registered in a layout effect, in the same commit as its stack entry). If the dialog is the **top of `dialogStack`**, it calls `onClose()`. This applies to dialogs and alertdialogs alike, as in the loaded panel, where an alertdialog ignores only the scrim and Escape still closes it. It also mirrors Base UI's handling: no close mid-IME-composition, and `preventDefault` + `stopPropagation`, so the key does not reach window shortcuts.
- The caller unmounts on `onClose`, so the existing layout-effect cleanup removes the stack entry and the panel never appears when the chunk lands.
- An `OnPanelCommit` marker renders beside the panel inside the Suspense boundary. It commits only with the panel, and its passive effect runs after the panel's own effects, Base UI's Escape listener included. From then on the wrapper stands down, so Escape is never handled twice. A dialog whose chunk was already loaded at mount adds no listener at all.
- Note: this codebase's Dialog API is `onClose` (there is no `onOpenChange` prop); `onClose` is what the loaded panel calls on Escape.

## Tests added (all fail on 5f96e3c and pass on c52c708; checked by stashing the source changes)
`src/ui/Menu.test.tsx`: 12 new tests, using a deferred menu import (`vi.doMock('@/ui/lazyPrimitives')` with a real `lazyModule` whose imports resolve or reject on demand).
- *Reloads for the current build when an open joins a prefetch that meets a stale chunk.* Hover starts the prefetch, the press joins it, the import rejects with Chromium's chunk error, and the reload guard is set. No notice is shown.
- *Says the menu could not open when it cannot reload, and opens on a press once the chunk loads.* This is the rejection sequence: the prefetch rejects on its own, then the press re-imports and that rejects too, with a reload already spent. The notice shows, no reload starts and no menu opens. A further press retries and opens the menu.
- *Says so offline, and takes back a controlled menu's open.* Checks the offline copy and the `onOpenChange(true)` then `(false)` sequence; Escape dismisses the notice.
- *Opens on ArrowDown / ArrowUp / Enter / Space, landing where Base UI does* (×4). Nothing opens while the chunk is held. After it lands, focus is on Rename / Delete / Rename / Rename, and Escape returns focus to the real trigger.
- *Lands as an already-loaded menu does on each key* (×4): a parity check against Base UI itself.
- *Asks a controlled menu to open on an early ArrowDown, once the chunk is in.*
- *Opens a pointer press as before, without moving to an item.*

`src/ui/Dialog.test.tsx`: 3 new tests, using a deferred panel import.
- *Closes a dialog, which then never shows up* and *closes an alertdialog, which then never shows up*. Each checks: `onClose` called once, the key not seen by a window listener, `isDialogOpen()` false, and no dialog rendered after the chunk lands.
- *Closes only the top dialog, and hands Escape to the panel once it is in.* With two pending dialogs, Escape closes only the top one. The remaining one loads and then handles Escape through Base UI, exactly once.

**Real-browser check** (local stack, Chromium, desktop-1440 and iphone-se), with the dev server's `MenuBase` / `DialogPanel` requests held or aborted through Playwright routes:
- ArrowUp on a cold "Score actions" menu: no menu while held; after release, focus is on the last item (Delete). ArrowDown then focused Rename.
- With the DialogPanel request held, Delete opened the confirm, and Escape before the chunk landed meant no alertdialog or dialog ever rendered. No console errors.
- Aborted MenuBase: the first press reloaded the page and set the guard. The second press showed the notice, clamped inside the gutter on both viewports, and Escape dismissed it.

## Sizes (gzip, from the `npm run build` log + `dist/index.html`, same method as the lazy-load report)
| | Reported for 5f96e3c | 5f96e3c rebuilt here | c52c708 |
| --- | --- | --- | --- |
| Entry chunk (`index-*.js`) | 94.85 kB | 94.69 kB | **94.49 kB** |
| Initial JS (entry + every modulepreload) | 236.19 kB (36 files) | 235.89 kB (36 files) | **236.87 kB** (37 files) |
| Total JS | 855.71 kB | 855.46 kB | 856.43 kB |

- The entry chunk is about the same (−0.20 kB vs the same-machine rebuild, −0.36 kB vs the reported figure). Initial JS is about the same: +0.98 kB vs the rebuild, +0.68 kB vs the reported figure (+0.4%).
- Most of that is a chunking side effect. `Menu.tsx` (shell) now imports `createPortal` from `react-dom` for the notice, and rolldown moved `react` (2.88 kB gzip) into its own modulepreloaded chunk; the shared `Dialog` wrapper chunk shrank from 2.23 to 1.91 kB. Lazy chunks: MenuBase 14.14 → 14.19 kB and DialogPanel 4.87 kB (unchanged). No Base UI code is in an initial chunk.

## GitHub CI on c52c708
Two workflow runs (push + pull_request), both on c52c708. At the time of writing: `omr-service` ✅, `edge-functions-deno` ✅, `supabase-drift` ✅, Vercel Preview Comments ✅, Supabase Preview skipped; `checks` and `supabase-local` in progress.

## Open questions
1. **Bundle (+~0.7–1.0 kB initial).** The notice needs `createPortal`: menus sit under the `backdrop-blur` sticky header, where a `position: fixed` child would be placed against the header rather than the viewport. That import caused the `react` chunk split above. If even this is too much, the notice could become an absolutely positioned element in a wrapper span (with a small risk of clipping in scroll containers). Keep as is?
2. **Keyboard open after blur.** If the stand-in loses focus (Tab away) before the chunk lands, the captured ArrowDown/ArrowUp/Enter/Space open is dropped instead of pulling focus back into a menu. A pointer press still opens on load, as before. OK?
3. **`onOpenChange(false)` vs `onClose`.** The packet says to call `onOpenChange(false)` for the pending dialog, but `Dialog`'s API is `onClose`, so the wrapper calls `onClose()`, the same callback the loaded panel's Escape uses.
4. **Notice copy and design.** "This menu couldn’t open. Check your connection, then try again." (and an offline variant), in a white rounded card under the trigger, dismissed by any press, scroll or Escape. Happy to change the wording or styling.
