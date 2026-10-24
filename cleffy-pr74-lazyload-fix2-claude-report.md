# Cleffy PR #74 lazy-load fix pass 2 — Claude report

**Status:** Complete
PR: https://github.com/maxharris1/Cleffy/pull/74 (draft, base `dev`) · Branch: `mh/ui-polish-emil` · New head: `d806e7c089918bb9e7d181592631511ac6954acf`
Checks: lint:check ✅ · typecheck ✅ · test ✅ (254 files, 3988 passed, 22 skipped) · build ✅ · prettier ✅ (no changes) · GitHub CI on d806e7c: ✅ all green, supabase-local included
Open questions: see "Open questions" below (2, both minor)

## Environment

- Cleffy cloud environment: `env_01WAd3yiz3qpSnsofpyEwCh2` ("Cleffy", anthropic_cloud), confirmed with `get_session` + `list_environments`.
- Local stack only: `npm run cloud:up` (local Supabase + functions + Vite), then `npm run cloud:down` at the end. I didn't touch hosted Supabase or Stripe, and didn't run `playwright install`.

## Heads

- Old head of `mh/ui-polish-emil`: `c52c708fbaf968ab60c2b3265cc4fffac7c0874e` (matched the expected start).
- New head: `d806e7c089918bb9e7d181592631511ac6954acf`. It was a fast-forward push (`c52c708..d806e7c`). I didn't force-push or merge anything. PR #74 is still a draft.

## Commits

- `d806e7c` — Keep a held Space's open, and keep the load notice on screen (PR #74 lazy-load fix 2 pass 2)

Only two files changed: `src/ui/Menu.tsx` and `src/ui/Menu.test.tsx`.

## Item 1 — Space activation lost when the chunk lands mid-key (Menu.tsx ~L192)

- **Change:** Enter and Space on the stand-in now take the open on **keydown**. They `preventDefault()` the native activation and call `openOnKey('ArrowDown')`, which records `openKey` and loads the chunk for the open. Repeats from a held key are ignored. Preventing the keydown cancels the button's native click (Space's would have come on keyup). Once the chunk is in, the loaded branch opens through the recorded intent: `openWithKey` replays ArrowDown on the real trigger, so focus lands on the first item, as before.
- The `keyPress` ref and the keyboard branch in `onClick` are gone. `onClick` is now `openWhenLoaded`, used only for pointer and assistive-tech clicks, which arrive without a keydown.
- **Releasing the key after the swap is safe.** The keyup lands on the focused Base UI menu item, and Base UI's `useButton` cancels a Space keyup on composite native-button items. A native button doesn't activate on a keyup alone anyway.
- **Tests:** `opens on Space|Enter when the chunk comes in while the key is still down`. The test holds the key (`[Space>]`), resolves the import, and asserts the menu is open with focus on "Rename" and the stand-in swapped out. It then releases the key (`[/Space]`) and asserts the menu is still open with focus still on "Rename". The Space case fails on c52c708 and passes now. The Enter case passed before too; it guards against regressions. The existing Enter/Space, ArrowUp/Down and pointer-press tests all still pass.
- **Real Chromium** (dev server, MenuBase request held back by a route): focused a library row's "Score actions" stand-in and held Space. The menu was not open before the chunk loaded. After release of the route, it was open with focus on the `menuitem` "Rename" while Space was still down. After keyup it was still open on "Rename", and the URL was unchanged.

## Item 2 — chunk-failure notice below the fold (Menu.tsx ~L77)

- **Change:** `MenuLoadFailed` measures itself in a `useLayoutEffect` before it paints, using its own `getBoundingClientRect().height`.
    - It sits at `anchor.bottom + 4` when that fits above `innerHeight − 16`.
    - Otherwise it flips to `anchor.top − 4 − height`, above the trigger, as the menu does, if that keeps the 16px gutter.
    - When it fits neither way, it is clamped to `[16, innerHeight − 16 − height]`.
    - Horizontal placement is unchanged: end-aligned to the trigger, clamped to `[16, innerWidth − 16 − width]`, width `min(240, innerWidth − 32)`.
    - The `createPortal` notice, the `onClose`/onDismiss handling and the wording are unchanged.
- **Tests** (`it.each`; `innerWidth` 1024, mocked rects, trigger right edge at 1024, notice 60px tall):
    - Trigger at the bottom of a 768px screen (top 720 / bottom 752): flips above it, `top: 656px`.
    - A 120px screen too short for it either way: clamped, `top: 44px`.
    - A trigger with room below: under it, `top: 136px`.
    - All three also check `left: 768px`, the horizontal gutter clamp.
    - The first two fail on c52c708 and pass now.
- **Real Chromium:** a desktop viewport sized so the last library card's "Score actions" trigger sat at the bottom edge, the MenuBase chunk aborted, and the reload guard set. The notice rendered above the trigger: notice y 648 to 706, trigger y 710, viewport 750. It was fully inside the gutter on all sides and end-aligned to the trigger.

## Sizes (gzip, from the `npm run build` log + `dist/index.html`, same method as the previous reports)

|                                          | c52c708 (previous report) | d806e7c                  |
| ---------------------------------------- | ------------------------- | ------------------------ |
| Entry chunk (`index-*.js`)               | 94.49 kB                  | **94.58 kB**             |
| Initial JS (entry + every modulepreload) | 236.87 kB (37 files)      | **236.96 kB** (37 files) |
| MenuBase lazy chunk                      | 14.19 kB                  | 14.19 kB                 |

The +0.09 kB is the notice's measuring code in the Menu shell, which is part of the entry. No Base UI code is in an initial chunk.

## Checks run before the push

- `npm run lint:check` ✅
- `npm run typecheck` ✅
- `npm run test` ✅: 254 files passed, 6 skipped; 3988 tests passed, 22 skipped. The first full run, made while `cloud:up` was still booting the Docker stack in parallel, had 1 failing test; I didn't capture its name. Two reruns of the full suite passed with no failures. I treat that first failure as a load-timing flake, but I haven't identified it.
- `npm run build` ✅
- `npx prettier --write src/ui/Menu.tsx src/ui/Menu.test.tsx` ✅ (unchanged)
- `npx vitest run src/ui/Menu.test.tsx`: 27/27.

## GitHub CI on d806e7c (final)

Both runs (push 40105873101 and pull_request 40105877300) are all success:

- checks ✅ ✅
- supabase-local ✅ ✅
- supabase-drift ✅ ✅
- edge-functions-deno ✅ ✅
- omr-service ✅ ✅
- Vercel Preview Comments ✅
- Supabase Preview: skipped (as usual for this branch).

## Open questions

1. On a screen too short for the notice above or below its trigger (e.g. a phone in landscape with the keyboard up), it is clamped inside the gutter and can overlap the trigger. Is that acceptable, or should it go beside the trigger instead?
2. Enter/Space now open the stand-in on keydown, including with modifier keys held, which matches the old click-based path. Base UI's loaded trigger opens Space on keyup, so a cold menu opens a key-release earlier than a warm one. I left this alone because it is invisible in practice (the chunk usually takes longer than a keypress). Flag it if you want exact parity.
