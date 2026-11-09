**Status:** Complete
**Final head:** `c2d3021cd8136d8a2984e417b55a1ff6b3877b0f` (PR #82, `agent/fullscreen-performance-mode`)

# PR #82 round-2 fix (Codex REVISE on a6364529) and merge of dev

- PR: https://github.com/maxharris1/Cleffy/pull/82 (still a draft, base `dev`, not merged)
- Head went `a6364529` → `5a75e57` (F5 fix) → `c2d3021` (merge of dev at 6558414f). Each was a normal push; nothing was force-pushed.
- Environment: Claude Code cloud session in the Cleffy environment (`env_01WAd3yiz3qpSnsofpyEwCh2`), not Sandbox. Only the local stack (`npm run cloud:up`) was used. No hosted Supabase project was touched.
- Commits are authored as Max Harris. Nothing was pushed or merged to `dev` or `main`. #54 and the other PRs were not touched.
- The resume-round report is on `claude/cleffy-pr82-resume-report`. It was pushed late because of three worker restarts.

## F5: spread fit clamped by MIN_SCALE (commit 5a75e57)

**Cause.** `pageFitView` (`src/features/viewer/geometry.ts`) clamped its fit with `Math.max(MIN_SCALE, fit)`. Two 2000×2800 pages side by side (4016 wide) in 800×1000 need ≈0.1912, but the clamp raised that to 0.25, which clipped both outer edges. Stand mode can't pan or zoom, so that content was unreachable.

**Change.**

- The stand fit is `Math.min(MAX_SCALE, fit)`, with no lower floor.
- It returns `null` when `fit <= 0`, which happens when the viewport is no larger than its 2×`PAGE_GAP` margins. The caller already leaves the view alone on `null`.
- `MIN_SCALE` still bounds manual zoom (`zoomAt`, `fitPageWidthScale`, `pageTopView`, rotation and reanchor). None of those run while stand mode holds the view.
- The doc comment says why.

**Test (new file).** `src/features/viewer/stand/standFitBounds.test.ts` crosses:

- layouts: single, two-page spread, cover spread;
- documents: two large pages, five large pages, letter pages, and mixed sizes (2000×2800, letter, a 1400×900 landscape page);
- viewports: 800×1000, 640×360, 1366×1024, 390×844, 320×240.

For every row it asserts that all four corners of every shown page stay inside the viewport. One more case asserts that the F5 example fits below `MIN_SCALE` at exactly (800−32)/4016. That makes 61 cases: **34 fail on a6364529 and all pass after the fix.** The protected baseline tests are unchanged: `geometry.test.ts`, `geometry.stand.test.ts`, `StandMode*.test.tsx` and `standSpread.test.ts` were not edited. F1–F4 were not touched.

## Merge of dev (6558414f)

Per Addendum 2, the merge target was **6558414f** (#86), which supersedes 7960ae3b. I verified it is on `origin/dev`. It brings in #83, #84, #85 and #86.

- **Merge commit:** `c2d3021cd8136d8a2984e417b55a1ff6b3877b0f`, a normal two-parent merge (`git merge --no-ff 6558414f`, parents `5a75e57` and `6558414f`). No rebase, no force-push.
- **Conflicted files:** one, `src/features/viewer/PdfViewport.tsx`, at the `ZoomControls` call in the render.
    - #82 had wrapped the old call (`onTogglePageColumns` / `onToggleSpreadCover`) in `standMode ? null : (…)` and added `&& !standMode` to the `Pager`.
    - #83 replaced those props with `onPageColumnsChange={changePageColumns}` / `onSpreadCoverChange={changeSpreadCover}`.
    - **Resolution:** #83's call exactly as merged, still inside #82's `standMode ? null : (…)`, and the `Pager` still hidden in stand mode. Nothing else in the file conflicted.
- **Auto-merged without conflict:** `src/ui/icons.tsx` (#83's `SinglePageIcon`/`TwoPagesIcon`/`CheckboxIcon`/`CheckboxCheckedIcon` plus #82's `FullScreenIcon`), and the transform writer in `PdfViewport.tsx`.

**Codex FU-1 (one transform writer).** The page wrapper's transform has #86's approach and only #86's writers:

- the live-view store subscription (`wrapper.style.transform = …`, PdfViewport.tsx:881);
- the one layout effect after each commit (PdfViewport.tsx:1378).

There is no `liveTransform` variable and no `transform` style prop on the wrapper, which now carries only `transformOrigin`, width and height. #82 never wrote the transform anywhere else. Stand mode's enter, turns, rotation re-fit and exit all call `useViewerStore.setView` and reach the DOM through #86's writer.

**Invariant 1: #83's toggle UI exactly as merged on dev.** These match `6558414f` exactly (`git diff --quiet 6558414f`): `PageLayoutControls.tsx`, `PageLayoutControls.test.tsx`, `PageLayoutToggle.test.tsx`, `viewerPrefs.test.ts`, `PdfViewport.test.tsx` and `index.css`. The `ZoomControls` and `Pager` definitions (everything from `const roundControlClassName` to the end of PdfViewport.tsx) match dev line for line. `icons.tsx` differs from dev only by #82's `Maximize` import and `FullScreenIcon` export. In the browser the Single page / Two pages radio pair and "Start with cover page" render as on dev, and stay selected after leaving full screen.

**Invariant 2: #82's full screen reads `pageColumns` and `spreadCover` from the store.** The merge didn't change the stand code: `preferredColumns = useViewerStore((s) => s.pageColumns)` and `spreadCover = useViewerStore((s) => s.spreadCover)` feed `pageColumns` and the layout, and the stand fit uses that layout. `StandMode.spread.test.tsx` sets the layout only through the store, and it passes on the merge head. In the browser, picking Two pages / cover with #83's radio and checkbox gives the matching spread in full screen.

## Checks

|                      | F5 head 5a75e57                            | Merge head c2d3021                         |
| -------------------- | ------------------------------------------ | ------------------------------------------ |
| `npm run lint:check` | passed                                     | passed                                     |
| `npm run typecheck`  | passed                                     | passed                                     |
| `npm run test`       | passed (280 files, 4370 tests, 22 skipped) | passed (283 files, 4399 tests, 22 skipped) |
| `npm run build`      | passed                                     | passed                                     |

Prettier was run on every changed file.

CI on c2d3021 when this report was pushed:

- **Passed:** `supabase-local`, `supabase-drift`, `omr-service` and `edge-functions-deno` in both workflow runs; Vercel deploy and Vercel Preview Comments.
- **Skipped:** Supabase Preview, as expected.
- **Still running:** `checks` in both runs. It runs the same four commands that passed locally above.

CI on a6364529 (the resume head) was all green.

## UI check (ui-check skill, every screenshot reviewed)

All runs are on the merge head. I opened files through "Open locally without uploading", because the seeded scores have no local PDF. The layout was chosen with #83's radio and checkbox.

| Run                                | Entered            | After → | Exit lands on | Shown page boxes (px)                                     |
| ---------------------------------- | ------------------ | ------- | ------------- | --------------------------------------------------------- |
| ipad-landscape single              | Page 1 / 4         | page 2  | p. 2 / 4      | 312–868 × 16–804 in 1180×820                              |
| ipad-landscape two                 | Pages 1–2 / 4      | 3–4     | p. 3 / 4      | 26–583, 597–1154                                          |
| ipad-landscape cover               | Page 1 / 4 (right) | 2–3     | p. 2 / 4      | 597–1154 → 26–583, 597–1154                               |
| desktop-1440 single                | Page 1 / 4         | page 2  | p. 2 / 4      | 413–1027 × 16–884 in 1440×900                             |
| desktop-1440 two                   | Pages 1–2 / 4      | 3–4     | p. 3 / 4      | 98–712, 728–1342                                          |
| desktop-1440 cover                 | Page 1 / 4 (right) | 2–3     | p. 2 / 4      | 728–1342 → 98–712, 728–1342                               |
| **800×1000, 2000×2800 pages, two** | Pages 1–2 / 4      | 3–4     | p. 3 / 4      | **16–398, 402–784 × 232–768: both outer edges on screen** |
| 800×1000, 2000×2800 pages, cover   | Page 1 / 4 (right) | 2–3     | p. 2 / 4      | 402–784 → 16–398, 402–784                                 |

There were no console errors. The large-page PDF was generated for the check, with a blue border and "LEFT EDGE" / "RIGHT EDGE" labels on each page, and was not committed. Screenshots are in `docs/claude-reports/cleffy-pr82-r2-fix/` on this branch:

- `small-800x1000-{two,cover}-{1-entered,2-turned,3-exited}.png`
- `ipad-landscape-{single,two,cover}-{0-main,1-entered,2-turned,3-exited}.png`
- `desktop-1440-{single,two,cover}-{1-entered,3-exited}.png`

## Risk checklist

- **Concurrency:** n/a for F5, which is a pure function. For the merge, the single transform writer (FU-1) removes the React-versus-subscription race #86 fixed, and stand mode adds no second writer.
- **Retries/idempotency:** n/a.
- **Silent fallbacks:** `pageFitView` returns `null` for a viewport no larger than its margins, and the view is then left as is. That size is not reachable in practice.
- **First-match parsing:** n/a. Row grouping is unchanged from the resume round.
- **Row limits:** n/a.
- **Auth/RLS:** n/a. The change is client-side only.
- **Time zones:** n/a.

## Open questions

None new. The two from the resume round still stand: landscape phones show spreads as the main viewer does, and the controls pill briefly overlaps the bottom staff on a landscape phone.
