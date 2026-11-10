**Status:** Complete
**PR:** https://github.com/maxharris1/Cleffy/pull/87 (draft, into `dev`) · head `e4480d15b0cf66a16e7e76a8db213b6560e789fb` on `mh/layout-controls-declutter`

# Cleffy: page-layout controls off the score

- **Environment:** Claude Code cloud session in the Cleffy environment (`env_01WAd3yiz3qpSnsofpyEwCh2`), repo `maxharris1/Cleffy`. Local stack only (`npm run cloud:up`); hosted Supabase was never touched.
- **Branch:** `mh/layout-controls-declutter` cut from `origin/dev` at `b4bd55f`. Normal pushes only, with no force-push, no merge, and nothing pushed to dev or main. #54 was not touched.
- **Commits** are authored as Max Harris.

## Design chosen
This is the packet's recommended design. Nothing needed changing.

1. **One layout button** (`src/features/viewer/PageLayoutMenu.tsx`) in the existing floating stack. It is 44×44, the same size and style as zoom + / −, and its icon is the current layout (single page or two columns).
   - Pressing it opens a menu with **Single page / Two pages** (`menuitemradio` items in a group labelled "Pages per row").
   - Only in two-page mode, the menu also shows **Start with cover page** (`menuitemcheckbox`).
   - Any choice, an outside press, or Esc closes it, and focus returns to the button.
   - The button's name is `Page layout: Single page` or `Page layout: Two pages`, with `aria-haspopup="menu"` and `aria-expanded`.
2. **Built on the app's existing menu** (`src/ui/Menu` and `src/ui/MenuBase`, Base UI) rather than a new popover. That reuses its keyboard model (arrows, Home/End, typeahead, Esc), its collision flipping and its lazy chunk.
   - Added `MenuRadioGroup`, `MenuRadioItem` and `MenuCheckboxItem`, each with a check mark on the chosen item.
   - Added a `side` prop; the layout menu opens upward from the bottom-right stack.
3. **Where the preference is stored:** in the existing user-preferences mechanism.
   - That is the zustand viewer store (`src/state/store.ts`), which already persisted `pageColumns` and `spreadCover` through `src/features/viewer/viewerPrefs.ts` to localStorage keys `cleffy:page-columns` and `cleffy:spread-cover`.
   - Nothing about the storage format changed. **No migration.** There is no preferences table or column in the DB, so per-account sync across devices would need one; it is listed as a follow-up below rather than done.
   - The preference is therefore per device and browser, not per account, as it was before. Sign-out keeps display preferences and account deletion clears all `cleffy:` keys, both as before.
4. **The same settings in Account → Preferences:** a new "Score layout" section (`src/features/viewer/ScoreLayoutPreferences.tsx`).
   - It has Single page / Two pages side by side radios, and a Start with cover page checkbox with an explanation, shown only for two pages.
   - It uses the same store setters, so the viewer and the account page always agree.
5. **Full-screen stand mode (#82):** unchanged.
   - It reads the layout from the store, and the floating stack, including the new button, is not rendered in stand mode.
   - Verified in screenshots: only the stand pager and Exit appear, and they auto-hide.
6. **#86's single transform writer:** kept.
   - Layout switches still go through `relayout` in `PdfViewport.tsx`.
   - `PageLayoutToggle.test.tsx` is green across all 12 cases, with its refit assertions unchanged.
7. **Phones:** unchanged. Narrow viewports always show a single page and never showed layout controls; the account copy says so.

## Test results
All run on the final tree before pushing:
- `npm run lint:check`: pass
- `npm run typecheck`: pass
- `npm run test`: pass, 284 files (6 skipped), 4402 tests passed, 22 skipped
- `npm run build`: pass
- `npx prettier --check` on the changed files: clean

New and updated tests:
- `src/features/viewer/PageLayoutMenu.test.tsx` (new, 7 tests):
  - one button named for the current layout, `aria-haspopup` / `aria-expanded`
  - the menu's radio group and checked item
  - choosing switches the layout and closes the menu; choosing the current layout changes nothing and still closes
  - the cover option appears only in two-page mode, is a `menuitemcheckbox` outside the radio group, and closes on toggle
  - an outside press closes without changing anything
  - keyboard: Enter opens with focus on the first item, ArrowDown moves, Enter chooses, focus returns to the button, Esc closes
- `src/features/viewer/ScoreLayoutPreferences.test.tsx` (new, 2 tests): the Account section's radios and checkbox, the cover option hidden in Single mode, localStorage writes, following a change made in the viewer, and the setting surviving a fresh store load (a reload).
- `src/features/viewer/PdfViewport.test.tsx`: the layout describe was rewritten. It now checks one button beside the zoom keys, switching and cover through the menu, the button hidden on a phone, and a **new reload test** (choose Two pages + cover, then re-import the store fresh: both restored).

Changes to existing tests, and why:
- `PageLayoutControls.test.tsx`: **deleted** together with `PageLayoutControls.tsx`. It tested only the removed radio pair and pill. Its cases (one tab stop / arrow keys, cover only in two-page mode, cover kept apart from the layout choice) have equivalents in `PageLayoutMenu.test.tsx`.
- `PageLayoutToggle.test.tsx`: helpers only, plus the pill clicks.
  - `singlePage` / `twoPages` / `coverChip` now open the menu, if closed, and return the menu item.
  - `toggleColumns` and the new `toggleCover` look up the item *before* `act`. An open triggered inside the same `act` is not rendered until the `act` exits, so the item would not exist yet.
  - The three `act(() => fireEvent.click(coverChip()))` blocks (the removed pill) became `toggleCover()`.
  - `beforeAll` preloads the menu chunk.
  - Every fit and refit assertion is unchanged.
- `PdfViewport.test.tsx` "page layout controls" describe: it referenced the removed radios and pill, so it was rewritten as described above.

## Screenshots (ui-check, local stack)
Committed on this branch under `docs/claude-reports/cleffy-layout-controls-declutter/`.

Method: a 4-page fixture (`e2e-fixtures/test-score.pdf`) opened locally, with Two pages + cover set (matching Max's screenshot). "Before" is `origin/dev` served from a worktree on :5174; "after" is this branch on :5173.

| Viewport | Before | After |
|---|---|---|
| Desktop 1024×768 | `before-desktop-1024-viewer.png`, `before-desktop-1024-fullscreen.png` | `after-desktop-1024-viewer.png`, `after-desktop-1024-menu-open.png`, `after-desktop-1024-fullscreen.png`, `after-desktop-1024-account-preferences.png` |
| iPad landscape 1180×820 | `before-ipad-landscape-viewer.png`, `before-ipad-landscape-fullscreen.png` | `after-ipad-landscape-viewer.png`, `after-ipad-landscape-menu-open.png`, `after-ipad-landscape-fullscreen.png` |
| iPhone portrait (iPhone 14, 390×844) | `before-iphone-14-viewer.png`, `before-iphone-14-fullscreen.png` | `after-iphone-14-viewer.png`, `after-iphone-14-fullscreen.png` |

What I checked in each one, by eye:
- **Before** (desktop and iPad): the two layout buttons plus the wide cover pill sit on the staves at the bottom right. That reproduces Max's complaint. On iPad landscape the stack measured 165×230 px.
- **After** (desktop and iPad): one 44 px button stacked above + / −. The stack measures 44×148 px, the cover pill is gone, and nothing else floats over the music.
- **After, menu open:** it appears only while in use, opens upward beside the stack, and closes after a choice.
- **Full screen, before and after:** no layout controls; the cover spread is honoured.
- **iPhone, before and after:** identical. Phones never had the layout choice.
- **Console:** no errors in the after runs. The before runs show 403s on resource loads, a side effect of serving the local stack from the extra :5174 origin and unrelated to this change.

## Risk checklist
- **Concurrency:** n/a. The settings are synchronous zustand state; the viewer and the Account page are separate routes and share the store.
- **Retries / idempotency:** choosing the layout already shown is a no-op (guarded), and writes overwrite one key.
- **Silent fallbacks:** this PR adds none. The existing `viewerPrefs` behaviour stays: if storage throws, the default layout is used and the switch still applies for the session. That behaviour is intentional and already tested.
- **First-match parsing:** n/a. Stored values are matched exactly (`'1'` / `'2'`, `'0'` / `'1'`), and anything else falls back to the default (existing tests).
- **Row limits:** n/a. No queries.
- **Auth / RLS:** n/a. No DB or Edge Function changes, and no migration.
- **Time zones:** n/a.

## Notes and follow-ups
- `.claude/skills/poteto-mode/SKILL.md` does not exist in this repo (only `poteto-help` and the `principle-*` skills), so I followed the packet's own steps and AGENTS.md's Factory notes.
- Per-account cross-device sync of the layout would need a new column such as `profiles.preferences jsonb`, which means a migration. Not done, and worth asking Max about if he wants it.
- This report was also written to `/workspace/cleffy-layout-controls-declutter-report.md` inside this cloud container. That is not the Box `/workspace`, which this session cannot reach, and Grok Bot cannot be messaged from here, so both need relaying from this branch.
- Local stack stopped with `npm run cloud:down` after the screenshots.
