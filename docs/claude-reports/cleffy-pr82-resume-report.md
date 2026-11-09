**Status:** Complete

# PR #82 resume: full-screen stand mode with two-page spreads

- PR: https://github.com/maxharris1/Cleffy/pull/82 (still a draft, base `dev`, not merged)
- Branch: `agent/fullscreen-performance-mode`
- **New head: `a6364529124c69716601bdad76803cf5ee09b72c`** (was `e05f94a`)
- Environment: Claude Code cloud session in the Cleffy environment (`env_01WAd3yiz3qpSnsofpyEwCh2`), not Sandbox. Only the local stack (`npm run cloud:up`) was used. No hosted Supabase project was touched.
- Commits are authored as Max Harris. Pushes were normal (no force). Nothing was pushed to `dev` or `main`, and #54 was not touched.
- `poteto-mode` is not vendored in this repo: `.claude/skills/poteto-mode/SKILL.md` does not exist, and AGENTS.md:58 says it is held upstream. I followed the packet and the `principle-*` skills instead.

## Step 1: fast-forward to the round-one fix

**The fast-forward worked.** `git merge --ff-only origin/claude/pr82-r1-fix-cl195603-yocqaq` moved the branch `e05f94a..08c79c4` (commits 753ece5, 36be365, 08c79c4). Nothing was re-created by hand.

| Finding                                                  | Status              | Where                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1: a stand-mode pinch could resize a selected text note | **Fixed** (08c79c4) | `PdfViewport.tsx` ink delegate: `canPinch` and `onPinch` are gated on `standModeRef` the same way `shouldInk` is. Test: `stand/StandMode.annotations.test.tsx`.                                                                                                                                                                                                    |
| F2: no Exit while loading or after an error              | **Fixed** (08c79c4) | `StandOverlay` renders outside the document branch. While `!scoreShown` it stays up with Exit only. Test: `stand/StandMode.lifecycle.test.tsx`.                                                                                                                                                                                                                    |
| F3: settle and playhead follow moved the stand view      | **Fixed** (08c79c4) | `settleIntoBounds`, the pointer settle and the page-size reanchor all return early in stand mode, and entry cancels any settle in progress. `PlayheadController` checks `isViewHeld` before following and on each glide frame. Test: `stand/StandMode.placement.test.tsx`.                                                                                         |
| F4: new tests added to an existing file                  | **Fixed** (36be365) | Stand geometry cases moved to `geometry.stand.test.ts`, and `geometry.test.ts` is back to its merge-base content. This round's new tests are also in new files. The `standPageAfter` call signature changed, so its two existing cases in `stand/standMode.test.ts` were updated (no cases added). That file is new in this PR and is not in merge-base `2144872`. |

## Step 2: two-page full screen (commit a636452)

Full screen now uses the same layout as the main viewer, instead of always forcing one column.

| #   | Acceptance point                                                                    | Status  | How                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Shows the main viewer's selection; honours `spreadCover`                            | **Met** | `pageColumns` comes from `useViewerStore` (`narrow ? 1 : preferredColumns`, the same rule the main viewer uses). `pageFitView(layout, page, w, h, columns)` fits the page's whole row. In two columns the box is the full spread width, so a cover page stays on the right, an odd last page stays on the left, and the zoom is the same on every turn. Cover pairing is 1 \| 2-3 \| 4-5.                |
| 2   | Taps, keys and pedals turn a whole spread and never strand half of one              | **Met** | `standPageAfter(layouts, page, dir)` steps through rows (`pageRow`). A turn from either half of a spread lands on the next or previous whole row. Taps, keys, swipes and the overlay buttons all go through it.                                                                                                                                                                                          |
| 3   | Exit returns to the same spread                                                     | **Met** | The existing return path is used. If the spread never changed, the exact pre-entry view comes back. Otherwise `pageTopView` puts the spread's row at the top.                                                                                                                                                                                                                                            |
| 4   | Rotation or resize keeps the reader's place; falls back where the main viewer would | **Met** | `standPage` is kept across layout changes and the shown row is derived from it. Below `sm` (phone portrait) one page shows; widening shows that page's spread. A one-page score shows as a single page.                                                                                                                                                                                                  |
| 5   | Tests                                                                               | **Met** | New files: `stand/standSpread.test.ts` (rows, spread fit, cover pairing, turns from either half) and `stand/StandMode.spread.test.tsx` (two-page entry, spread turns by key, tap and control, cover pairing, single stays single, start and exit on the spread, exact restore, rotation to a phone and back). 6 of the 8 component tests fail on the pre-change code. The other 2 are regression guards. |

Coordination with `mh/page-layout-toggle`: layout state is only read from the store, and `ZoomControls` is unchanged.

## Checks (on a6364529)

- Local: `npm run lint:check` passed, `npm run typecheck` passed, `npm run test` passed (279 files, 4309 tests, 22 skipped), `npm run build` passed. Prettier was run on the changed files.
    - On the first full run, `tests/auth/turnstileField.test.tsx` failed once. It passed 3 of 3 times on its own and the full suite was green on the rerun. It is a timing flake under load, unrelated to this PR.
- CI on a6364529: all green. `checks`, `supabase-local`, `supabase-drift`, `omr-service` and `edge-functions-deno` passed in both workflow runs, and Vercel Preview Comments passed. Supabase Preview was skipped, as expected.

## UI check (ui-check skill, every screenshot reviewed)

The seeded scores had no PDF in local storage (HTTP 400), so I opened `e2e-fixtures/test-score.pdf` (4 A4 pages) through "Open locally without uploading". The layout was picked with the real toggle.

| Viewport                             | Single                                 | Two-page                                                                                           | Cover                                                     |
| ------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| ipad-landscape                       | Page 1/4, then 2/4; exit lands on p. 2 | Pages 1–2, then 3–4; exit lands on p. 3                                                            | Page 1 (on the right), then Pages 2–3; exit lands on p. 2 |
| desktop-1440                         | same                                   | same                                                                                               | same                                                      |
| iphone-14 (two-page and cover saved) | n/a                                    | Page 1, then 2 (single, as in the main viewer); rotating to landscape shows Pages 2–3              |                                                           |
| iphone-landscape (saved)             | n/a                                    | Page 1, then Pages 2–3 (the main viewer shows two up at 844 px); rotating to portrait shows Page 2 |                                                           |

Screenshots are in `docs/claude-reports/cleffy-pr82-resume/` on this branch: `ipad-landscape-{single,two,cover}-{1-entered,2-turned,3-exited}.png`, `desktop-1440-{single,two,cover}-{1-entered,2-turned}.png`, `iphone-14-stored-two-cover-{turned,rotated}.png`, `iphone-landscape-stored-two-cover-{turned,rotated}.png`. No console errors.

## Risk checklist

- **Concurrency:** turns read live refs (`standPageRef`, `layoutRef`), as before. A rotation in the middle of a turn re-derives the row from the page index, so it cannot land on a stale row.
- **Retries/idempotency:** n/a. There is no network or persistence; entering or exiting twice is a no-op, as before.
- **Silent fallbacks:** deliberate and documented. Below `sm`, and for one-page scores, stand mode shows single pages even with two-page selected. `pageFitView` returns null for zero-size pages, as before.
- **First-match parsing:** rows are grouped by exact `top` equality. `computeDocumentLayout` gives every page in a row the same `top` (the same assumption `pageTurnView` already relied on, and it now shares `pageRow`).
- **Row limits:** n/a.
- **Auth/RLS:** n/a. The change is client-side only.
- **Time zones:** n/a.

## Open questions

1. A phone in landscape (≥640 px wide) shows spreads, because that is what the main viewer shows there. If Max wants phones to always be single in full screen, that would be a separate rule from the main viewer's.
2. On a landscape phone, the controls pill covers the bottom staff for about 3 s after a middle tap. Single-page mode already did this before this round.
