**Status:** Complete

# Cleffy: page layout toggle (Single page / Two pages)

- **PR:** https://github.com/maxharris1/Cleffy/pull/83 (draft, `mh/page-layout-toggle` → `dev`)
- **Head SHA:** `54d81346a5b8e8c4aa3b0d061fbeb1a0780f6d89`
- **Base:** `dev` @ `2144872`
- **Environment:** confirmed Claude Code cloud env **Cleffy** (`env_01WAd3yiz3qpSnsofpyEwCh2`), via `get_environment` (`is_current: true`). Not Sandbox.
- **Backend:** local stack only (`npm run cloud:up`, app on http://localhost:5173), stopped with `npm run cloud:down` at the end. No hosted Supabase project was touched.
- **Commit author:** Max Harris <drumaxter@gmail.com>. No force pushes, no merges, nothing pushed to `dev` or `main`. #54, #82 and `src/features/imslp/*` were not touched.

## What changed

| File                                                                                                         | Change                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/features/viewer/PageLayoutControls.tsx` (new)                                                           | `role="radiogroup"` "Page layout" with two `role="radio"` buttons: Single page (`RectangleVertical`) and Two pages side by side (`Columns2`). Only the chosen radio is a tab stop, and the arrow keys move the choice and the focus. In two-page mode only, a separate checkbox-style "Start with cover page" chip (`aria-pressed`) sits below the pair. |
| `src/features/viewer/PdfViewport.tsx`                                                                        | `ZoomControls` renders `PageLayoutControls`. The toggles became value setters (`changePageColumns(columns)`, `changeSpreadCover(cover)`) that both call the unchanged `relayout`. The column right-aligns items so the wider chip doesn't push the round buttons left.                                                                                   |
| `src/ui/icons.tsx`                                                                                           | Added `SinglePageIcon`, `TwoPagesIcon`, `CheckboxIcon` and `CheckboxCheckedIcon`. Removed `Columns2Icon` and `CoverPageIcon` (the book icon); this was their only caller.                                                                                                                                                                                |
| `src/features/viewer/PageLayoutControls.test.tsx` (new), `viewerPrefs.test.ts` (new), `PdfViewport.test.tsx` | Tests listed under point 9.                                                                                                                                                                                                                                                                                                                              |

No store, prefs, layout-math or backend changes.

## Checks (local, at the head SHA)

- `npm run lint:check`: pass
- `npm run typecheck`: pass
- `npm run test`: pass (273 files, 4239 tests, 22 skipped). On the first full run `tests/auth/turnstileField.test.tsx` failed once ("refuses to submit the sign-up form until the check is finished"). It passes on its own, both on this branch and on `dev`, and the full suite was green on the rerun, so it's a timing flake under load and unrelated to this change.
- `npm run build`: pass
- `npx prettier --write` on the changed files: no changes

CI has not been run yet: the PR is a draft and CI runs on GitHub.

## Acceptance points

1. **Two buttons, radio behavior: met.** One `radiogroup` holds both radios inside a single white pill. Clicking one selects it and deselects the other. Clicking the one already selected does nothing (`choose` returns early; tested).
2. **Clear icons and labels: met.** Single page uses the one-page `RectangleVertical` icon and Two pages uses `Columns2`. The book icon is removed from the codebase. `aria-label` and `title` are "Single page" and "Two pages side by side".
3. **Default single page: met.** `readPageColumns` returns 1 when nothing is saved, for any value it doesn't recognise, and when storage throws. The last choice is restored (tested in `viewerPrefs.test.ts` against both the prefs functions and a freshly loaded store). Stale values: only `setPageColumns` writes `cleffy:page-columns`, and only on a user's choice. `DEFAULT_COLUMNS` has been 1 in every revision of `viewerPrefs.ts` (checked with `git log -p`), so no saved value can force two-page on a new user.
4. **Cover option visibly secondary: met.** It only renders when `pageColumns === 2`, and it sits below the pair, outside the radiogroup. It looks different from the round controls: a small text chip with a checkbox icon (checked when on), labelled "Start with cover page". The tooltip reads "Show the first page on its own, so the spreads pair pages 2|3, 4|5 as in a printed score".
5. **Highlight states: met.** The selected radio uses `bg-accent-soft text-accent`; the other is plain white. Single is highlighted on first load (screenshot `after-desktop-1440-1-default.png`). The "on" chip lays its translucent accent tint over white so staff lines don't show through it. I fixed this after seeing it in the iPad screenshot.
6. **Same visibility rules: met.** The pair is hidden when `pageColumns === null` (single-page documents and phones under 640px; tested, and see `after-iphone-14-1-default.png`). Positioning: phone row unchanged, tablet/desktop column at the bottom-right, and a row on short landscape (`after-iphone-landscape-3-cover.png`).
7. **Relayout unchanged: met.** Both controls call the existing `relayout(columns, coverPage)` unchanged. **Fullscreen/stand mode:** there is no fullscreen or stand mode in `src/` on `dev` (nothing matches `requestFullscreen`, "stand mode", "fullscreen" or "immersive", and git log has no such feature), so there was nothing else to keep in sync. The selected layout is the store's `pageColumns`, so any future fullscreen view that reads it will follow automatically.
8. **Keyboard and screen reader: met.** Checked in the real app (desktop, Chromium):
    - focus Single page, press ArrowDown: Two pages is checked and focused, and `cleffy:page-columns` is `2`
    - Tab: focus moves to "Start with cover page"; Space turns it on
    - Shift+Tab: focus goes back to Two pages
    - the focus ring is visible (`after-desktop-focus-ring.png`)
    - arrow keys on the radios don't turn the page: the viewer's page-turn listener already ignores keys aimed at buttons, and the radiogroup also calls `preventDefault`
9. **Tests: met.**
    - `PageLayoutControls.test.tsx`: grouping; single selected by default; mutual exclusion; clicking the selected radio does nothing; one tab stop with arrow keys moving choice and focus; cover only in two-page mode; cover outside the radiogroup and toggles.
    - `viewerPrefs.test.ts`: default single; unrecognised and throwing storage fall back to single; last choice restored; store opens a new reader in single and restores a saved 2.
    - `PdfViewport.test.tsx`: in the full viewer, single is checked by default; switching to two writes the store and localStorage, and the cover chip appears and works; switching back hides it; hidden on a phone.
10. **ui-check: done.** Before (`dev` code) and after shots for desktop-1440, iPad portrait, iPad landscape, iPhone landscape (short-landscape row) and iPhone 14, all in `docs/claude-reports/cleffy-page-layout-toggle/`. I looked at each one. `audit()` flagged nothing new: its only finding was a "small tap target" on the header's "Local score" title button, which is the same before and after. No console errors.

### Screenshots (before → after)

|                               | Before (`dev`)                                                     | After                                                             |
| ----------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Desktop, default              | ![](cleffy-page-layout-toggle/before-desktop-1440-1-default.png)   | ![](cleffy-page-layout-toggle/after-desktop-1440-1-default.png)   |
| Desktop, two pages            | ![](cleffy-page-layout-toggle/before-desktop-1440-2-two.png)       | ![](cleffy-page-layout-toggle/after-desktop-1440-2-two.png)       |
| Desktop, two pages + cover    | ![](cleffy-page-layout-toggle/before-desktop-1440-3-cover.png)     | ![](cleffy-page-layout-toggle/after-desktop-1440-3-cover.png)     |
| iPad portrait, default        | ![](cleffy-page-layout-toggle/before-ipad-portrait-1-default.png)  | ![](cleffy-page-layout-toggle/after-ipad-portrait-1-default.png)  |
| iPad portrait, cover          | ![](cleffy-page-layout-toggle/before-ipad-portrait-3-cover.png)    | ![](cleffy-page-layout-toggle/after-ipad-portrait-3-cover.png)    |
| iPad landscape, default       | ![](cleffy-page-layout-toggle/before-ipad-landscape-1-default.png) | ![](cleffy-page-layout-toggle/after-ipad-landscape-1-default.png) |
| iPad landscape, cover         | ![](cleffy-page-layout-toggle/before-ipad-landscape-3-cover.png)   | ![](cleffy-page-layout-toggle/after-ipad-landscape-3-cover.png)   |
| iPhone landscape (row), cover | ![](cleffy-page-layout-toggle/before-iphone-landscape-3-cover.png) | ![](cleffy-page-layout-toggle/after-iphone-landscape-3-cover.png) |
| iPhone 14 (hidden)            | ![](cleffy-page-layout-toggle/before-iphone-14-1-default.png)      | ![](cleffy-page-layout-toggle/after-iphone-14-1-default.png)      |

Also: `after-ipad-portrait-2-two.png`, `after-ipad-landscape-2-two.png`, `after-iphone-landscape-1-default.png`, `after-desktop-1440-4-reloaded.png` (two pages restored after reopening), `after-desktop-focus-ring.png`.

On `dev`, the default view shows one unhighlighted two-column button, so nothing tells you the current state. In two-page + cover mode, both the two-column and the book buttons are highlighted. After the change, exactly one of Single and Two is always highlighted, and the cover option is a labelled chip below the pair.

## How the UI was checked

The seeded scores don't open on the local stack: their PDF fetches return 400 and the viewer shows "Couldn't open this score". This happens on `dev` too and isn't part of this change. The fixture PDFs in `e2e-fixtures/` are single-page, so they would hide the toggle. I generated a six-page test PDF (reportlab, kept in the session scratchpad and not committed) and opened it with "Open locally without uploading" as the seeded teacher. Before shots were taken with the change stashed so Vite served `dev` code, and after shots with it restored.

## Risk checklist

- **Concurrency:** n/a. The control is client-only UI state. A fast double click on a radio is safe because choosing the selected layout does nothing.
- **Retries / idempotency:** choosing a layout is idempotent: the selected radio does nothing, and `relayout` sets an absolute value instead of toggling, so a repeated event can't flip it back. The old `togglePageColumns` was not idempotent.
- **Silent fallbacks:** the existing ones are kept on purpose. Unreadable or unrecognised storage falls back to single page, and failed writes are swallowed so the layout still switches for the session. Both are documented in `viewerPrefs.ts` and now tested.
- **First-match parsing:** n/a.
- **Row limits:** n/a.
- **Auth / RLS:** n/a. No backend, Supabase, or role changes. The control renders for both edit and view-only roles, as before.
- **Time zones:** n/a.

## Open questions

1. **Visible chip text.** It reads "Start with cover page" in full, which is about 160px wide in the bottom-right column. If that's too wide on smaller iPads, "Cover page" would keep the same accessible name. I left it as the packet specified.
2. **Two-page spread on desktop sits in the left half** of the viewport at the fitted scale (`after-desktop-1440-2-two.png`). `dev` does the same (`before-desktop-1440-2-two.png`). That's the fit or layout math, which was out of scope, so I didn't change it. Worth a separate ticket if it isn't intended.
3. **Seeded scores don't load on the local stack** (PDF fetch 400). This doesn't affect this PR, but it blocks QA click-throughs on seeded scores. Use a local multi-page PDF instead.
4. **`poteto-mode`** isn't vendored in this repo (AGENTS.md says it is "held upstream"), so I followed the task packet and the `principle-*` skills instead.
