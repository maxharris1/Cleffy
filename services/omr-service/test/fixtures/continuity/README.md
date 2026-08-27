# Continuity gate fixture

Place a multi-page PDF here as `continuity.pdf` when available, with:

- Time signature printed only on page 1 (not restated later)
- At least one tie that crosses the mid-score page boundary used by
  `splitSheetRangesOverlapping` (for 4 pages: overlap at page 2 → cuts `1-2` /
  `2-4`; for 5 pages: overlap at page 3 → `1-3` / `3-5`)

Until a PDF is checked in, unit tests in `seamCompare.test.ts` and
`mergeScoreData.test.ts` exercise the same musical invariants on synthetic
`ScoreData`.

## Bench (when PDF present)

```bash
npm run build
node bench/run.mjs --pdf test/fixtures/continuity/continuity.pdf --label cont-full
node bench/run.mjs --pdf test/fixtures/continuity/continuity.pdf --sheets 1:3 --label cont-a
node bench/run.mjs --pdf test/fixtures/continuity/continuity.pdf --sheets 3:5 --label cont-b
```

Then merge with overlap drop + inherit and run `compareScoreDataAtSeam`.
