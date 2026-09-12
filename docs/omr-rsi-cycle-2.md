# OMR RSI cycle 2

Loop A + Loop B against [omr-rsi-plan](omr-rsi-plan.md), continuing the cycle-1 ledger.
Pitch and printed time only. Implementation and verification by a fleet of Opus
subagents; every claim below was measured on the pinned corpus bytes, single-piece
runs only (the full bench is the orchestrator's).

**PR:** https://github.com/maxharris1/Cleffy/pull/41 (`mh/omr-rsi-notes-fixes-c12b` → `mh/omr-objective-musicality-eval`)
**Baseline:** `6a45f97` — suite onGrid 75.6%, 3/16 pass.

## Hypothesis → layer → delta → verdict

| Hypothesis | Layer | Diff | Measured (single-piece) | Verdict |
| --- | --- | --- | --- | --- |
| A voice whose last sound releases on the barline is never "short"; rhythmRepair's `sumOf` misreads a leading `<forward>` (Chopin m16) and a cross-staff chord member mis-grouped into a phantom voice (Chopin m24) as missing time, then pads past the barline | parser (`rhythmRepair.ts`) | `extentOf()` guard: skip repair when max(rel+dur) over principals+members == expected | chopin bar-length 3→1 of 26, onGrid 97.0→97.3; invention-08 bar-length 2→1 of 34; wtk1 bar-length 11→7 of 35; bwv999 bar-length 12→2 of 43; anna-magdalena-04 control byte-identical. A/B across all 17 cached artifacts: every dTicks change moves TO the printed length; 35 of 50 repairs suppressed | attributed |
| Schumann 68/1's 4 extras: 2 are one engraved notehead shared by two voices, exported once per voice at the **identical** `default-x` (m8, m16); 2 are a hairpin pair misread as the file's only `<inverted-mordent>` (m5), realized by `ornaments.ts` | parser (`musicxml.ts`) for the shared head; Audiveris for the false mordent | per-bar `staff:onset:midi → default-x` map; drop a `<note>` within 1 tenth of a head already read (no `default-x` ⇒ never filtered). Criterion fires on exactly 2 notes across all 16 cached `.mxl` | schumann-op68-01 extras 4→2 (= allowance), gate FAIL→**pass**; burgmüller, invention-01, anna-magdalena-05 controls identical | attributed |
| WP1: `performedBars` derivable from the pinned `.ly` | pin (corpus) | fur-elise 126, burgmüller 55 — each by three agreeing routes (LilyPond 2.26.0 `\unfoldRepeats` render bucketed by `midiRef.ts`'s own convention, hand-walk of `\repeat volta`, engraved numbers); folded renders reproduce the pinned reference MIDIs, proving provenance | burgmüller repeat-walk now ACTIVE and passes (parser performs 55); fur-elise composite 61.8→61.9, same 9 failing checks | pins landed |
| BWV 999: raising `ClefBuilder.maxEvalRank` (± `belowStaff`) lets `G_CLEF_8VB` beat plain `G_CLEF` | Audiveris (option vector) | none — both experiments failed kill criteria (no `G_CLEF_8VB` in the `.omr`, no `clef-octave-change` in the `.mxl`) | pitch 15.5% unchanged. Root cause read out of the shipped 5.11.0 jar: `ClefBuilder` keys candidates by `ClefKind`, and `G_CLEF_8VB` maps to the same `TREBLE` key as `G_CLEF`, so the higher-graded plain clef always wins — **no `-option` can reach this**. The "8" glyph survives segmentation, passes every geometric gate, and the classifier's vocabulary contains `G_CLEF_8VB`; only the kind-keyed dedupe is broken | exonerated (option layer exhausted) |

## Notable findings for later cycles

- **BWV 999 (509 notes, ~+8 suite pts)** is *not* a staff collapse: the page is a
  genuine single-staff solo-guitar score; Audiveris' grid/parts/measures are all
  correct and all 509 notes match the reference exactly at −12. The fix is an
  engine patch (the engine is already a patched build, `5.11.0+svc-14`): key
  `ClefBuilder`'s candidate map by `Shape` rather than `ClefKind`, or attach the
  orphaned "8" glyph post-hoc. A Cleffy-side pitch-range heuristic stays forbidden
  (nothing in the `.mxl`/`.omr` records that an "8" was seen).
- **Für Elise repeat-walk passes by two offsetting defects**: parser reads 106
  printed / 126 performed (surplus 20) vs pins 105/126 (surplus 21). The +1
  printed bar (the `measurePosition` second-ending split) cancels a one-bar
  shortfall on the unfold side. `printed-bar-count`/`bar-alignment` remain the
  honest signal; recorded in the corpus editionNotes.
- **Chopin m12** stays wrong at the engine: a bracketed printed triplet flattened
  to nine plain eighths (no `<tuplet>`/`<time-modification>` anywhere in the
  file) despite `implicitTuplets=true`. A tuplet-aware repair candidate (scale a
  3-run inside one beam group by 2/3 when it lands the bar on the grid) is a
  possible parser-side cycle, but is a new repair kind and needs its own bench.
- **Schumann 68/1 passes with zero margin** (2 extras of 2 allowed); the residual
  pair is the false mordent. Bars 6/7/13/14 print the same `<>` figure without
  misreading, so it is a marginal classifier miss, not systematic.
- The rhythmRepair guard deliberately trades repair recall (35 of 50 corpus
  repairs suppressed) for never pushing sound past a barline. If a piece ever
  needs a voice that legitimately ends on the barline repaired, the follow-up is
  the deferred `voicesOf` cross-staff restructuring, not loosening the guard.

## Full-bench outcome (orchestrator run at `fb3dcfe`, no --force-audiveris)

**Suite onGrid 75.6% → 75.7%, pass 3/16 → 4/16.** Every prediction below landed
and nothing else moved: schumann-op68-01 FAIL→pass (extras 4→2); bar-length
chopin 3→1 of 26 (onGrid 97.0→97.3), invention-08 2→1, wtk1 11→7, bwv999 12→2;
extras 409→407; missing unchanged at 365; all previously passing pieces green.
Fully attributed — no unexplained deltas.

## Expected full-bench outcome (to be attributed against)

- schumann-op68-01 flips to pass → **4/16**; no other gate flips expected.
- bar-length improvements in chopin (3→1), invention-08 (2→1), wtk1 (11→7),
  bwv999 (12→2); suite onGrid ≈ unchanged-to-slightly-up (only chopin's onGrid
  rate moved, +0.3 on 600 notes).
- No `--force-audiveris` needed: the option vector is byte-identical; all pieces
  hit the existing artifact cache (the two experiment artifact dirs live under a
  different cache key and are gitignored).
