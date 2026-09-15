# OMR RSI cycle 19 — Schumann's printed 10 is split across digit runs

**One hypothesis for Grok. Implementation and official host validation pending.**
Astra writes this document only. The split-loop instructions and this round's
user instructions override the older pass-all implementer orchestration.

## Official result and cycle-18 verdict

The supplied host table is authoritative: HEAD `1cf1cb1`, container
`cleffy-rsi-omr-24`. The local report agrees and identifies
`audiveris-5.11.0+svc-24`, generated `2026-09-14T20:11:31.217Z`.
`services/omr-service/eval/results/bench/bench.json` SHA256 is
`04babe585511a0f9bb693db90a8d0f93cb44099a65d063d4fd5d797c45925b43`.

The suite is **8/16**, with 5,996 reference notes, 83 missing, 126 extra,
pitch 98.09873248832555%, exact 96.66444296197464%, and on-grid
96.0140093395597%. It is not the 16/16 goal.

All eight protected passes remain green: **Czerny 821/1, BWV 999, Anh. 114,
Anh. 115, Anh. 116, Arabesque, Schumann 68/1, and Chopin 28/4**. No
pass-to-red kill fires. Floors remain exact **95%**, on-grid **90%**, one
missed/extra note per **16 printed bars**, with existing page-supported
allowances unchanged. The source diff from `0cd7595` to `1cf1cb1` contains
no official scorer, corpus-pin or MusicXML-parser changes. Saved options
remain `lyrics=false`, `implicitTuplets=true`, `fingerings=true`.

**Reject cycle 18 as an effective repair: its explicit “primary producer
split survives” kill criterion fires.** Schumann still has 26 printed,
scored and performed bars versus 25 reference bars, one wrong-length bar,
`measure_underfull`, five missing, five extra, and exact
**264/279 = 94.6236559139785%**. All eight target failures survive. Preserve
earlier accepted repairs. Astra does not revert or edit implementation;
this is one bounded follow-up to the unaccepted cycle-18 candidate.

Use the official svc-23 baseline recorded in [cycle 18](omr-rsi-cycle-18.md).
The bench JSON committed at `0cd7595` is stale svc-21 and is not that baseline.
Against svc-23, on-grid rises from 95.98065376917945% by two length matches
out of 5,996; this is **not credit for the internal-bar repair**. Read-only
comparison of all 16 cached svc-23/svc-24 score XML pairs finds only:

- Czerny m6: articulation reassignment; note pitches/durations unchanged.
- Für Elise m73: upper D5/F5 gain dots, duration 12 → 18 at divisions 12.
- Chopin m13: articulation reassignment; note pitches/durations unchanged.

Their BINARY images are unchanged. No svc-24 suite log reports an internal
double-bar merge. The Für Elise duration change corresponds to the two-match
dashboard increase, but its causal/source attribution is unestablished here;
do not accept an unrelated gain as evidence for this hypothesis. The other
failing pieces remain red. Invention 1's rounded 95.0% is still below the
floor at **435/458 = 94.97816593886463%**.

## One hypothesis and ink-level cause

**Schumann — Album für die Jugend, Op. 68 No. 5 (Stückchen),
`schumann-op68-05`: the adjacent printed digits “1” and “0” above system 3
form measure number 10. The PDF number collector sorts digits from the
entire page by x before grouping them. Digits on other printed baselines
interrupt this run, so it emits 1 and 0 separately. This turns the true
5 → 10 measure-number evidence into 5 → 1 and prevents recovery of the
two thin internal separator strokes inside printed m8. Grouping digits
within their own verified text line should restore the source anchor and
allow the existing, independently guarded separator recovery to be tested.**

This is an engine PDF-number grouping defect. The numeral outlines and
the double-thin separator are present in the source; no rhythm, pitch,
rest, clef, pickup, or reference-derived repair is proposed.

## Evidence bound to the current host artifacts

Pinned source: `services/omr-service/eval/cache/downloads/schumann-op68-05.pdf`,
SHA256 `8f56f70d597a838d23590ed5bbc9ecf10b21e77f07620019cdc2d06b931f7c17`.
The visible page has system-start numbers **5, 10, 15, 20**. The internal
double line is halfway through the two-quarter + two-quarter phrase in m8,
on both staves, without repeat dots; cycle 18 records the individual notes.

Current artifact directory:

`services/omr-service/eval/cache/artifacts/8f56f70d597a838d23590ed5bbc9ecf10b21e77f07620019cdc2d06b931f7c17-audiveris-5.11.0+svc-24-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/`.

Its `meta.json` declares and observes svc-24 with the unchanged options.

| Artifact | SHA256 |
| --- | --- |
| `omr-eval-input.omr` | `9d87156b1690d359a1520327aa8c4b53000d40557e01a0a1d87c149456acca0a` |
| `sheet#1/sheet#1.xml` | `893f4d058013cf2bfe6103ba1087f22d0faec180c8345887d83553e74084d196` |
| `sheet#1/BINARY.png` | `668631f54babe7c9bda6489b1a72e9b3855214d5d15a9b08ec09fe6dffb5e6fa` |
| Score XML inside `omr-eval-input.mxl` | `24f26d8c958b3c2a8d2244956065f53e6ba1d797664567cfd9d23ebde1e207af` |

The target BINARY and score XML are byte-identical to svc-23. The XML
contains 26 measures and 279 note elements. OMR stacks 8 and 9 still span
x1551–1743 and x1743–1984 respectively, both with `expected="1"` and
`duration="1/2"`. The `light-light` remains a right barline of XML m8.

The saved `audiveris.log` supplies the first failing seam:

```text
Internal double-bar anchors system=2 start=5 next=1 rawStacks=6
Internal double-bar skipped system 2: printed 5..1 does not allow an internal bar among 6 stacks
```

The same log sees the separate “1” at sheet box
`(98.65,1585.63,14.35,25.50)`, ignores standalone zeroes, and treats the
later printed 15 as two conflicting numbers 1 and 5. These are diagnostic
coordinates and source values, never production constants. The source-count
rejection is correct given those bad inputs; do not relax it.

Read-only PDF text extraction corroborates the four separate baselines
(points, top-left origin):

| Printed number | `(xMin,yMin,xMax,yMax)` |
| --- | --- |
| 5 | `(27.569155,275.399796,32.403551,283.599141)` |
| 10 | `(22.807046,380.380006,32.403480,388.579351)` |
| 15 | `(22.807046,479.621204,32.403480,487.820549)` |
| 20 | `(22.807046,583.617412,32.403480,591.816757)` |

These text boxes locate the evidence; they do not replace transformed glyph
outlines or ink verification. The tens-column digits precede the units-column
digits in the global x sort despite belonging to different text lines.

In `engine-patches/src/org/audiveris/omr/sheet/rhythm/PdfSystemNumbers.java`,
`groupDigits` (lines 158–185 at this HEAD) globally sorts by `getMinX()`
then compares each glyph only with the immediately preceding run's last
glyph. `sameNumberRun` does check vertical proximity and horizontal gap,
but only after another line's glyph has already broken the run.

`engine-patches/probes/InternalDoubleBarControls.java` has a synthetic 10
containing only its two digits. That case cannot expose cross-line
interleaving. Its actual-PDF scan is optional behind `args.length > 0`
and merely checks whether 5 and 10 occur anywhere. Neither establishes
the required full-page grouping and binding to systems 2/3.

## Bounded implementation contract for Grok

1. Correct grouping in `PdfSystemNumbers` only, with focused controls and
   matching patch/build wiring. Form unambiguous, baseline-consistent digit
   runs before applying left-to-right adjacency. A digit on another text
   line must neither split this run nor join it. Preserve all member
   outlines, page transforms, decimal zeroes and trailing-period exclusion.
   Results must not depend on PDF draw order or input-list order. Do not
   widen the existing gap, vertical, ink or system-binding tolerances to
   make this fixture pass. Ambiguous runs must remain unusable as anchors.

2. Require controls using the **whole pinned PDF**, not a crop or selected
   digit pair. Bind each complete 5/10/15/20 outline to its actual system
   and verify its source ink. Specifically require one complete 10 at
   system 3 and no independent 1/0 there. Also cover shuffled draw order,
   equal/near-equal x on different baselines, translated geometry,
   adjacent digits across separate text-paint operations, distant digits
   on one line, title `5.`, fingerings, missing/blank digit ink, ambiguous
   groups, and unsupported input. A missing member must not become a
   valid truncated anchor. Controls must exercise the actual scan and
   binding path, not merely the numeric source-count predicate.

3. Preserve cycle 18's source-count, unique-pair, separator, repeat,
   ending, signature, polyphony and duration requirements. Restoring 10
   must produce source anchors 5 → 10 with six raw stacks; changing the
   source's following anchor to 11 must still block the merge. No expected
   count, fixture value, title, hash, coordinate, corpus, MIDI or `.ly`
   may supply or correct a production anchor. Leave the existing merge
   lifecycle unchanged in this experiment. If it exposes another defect,
   record that blocker; do not append a second repair.

4. Grok implements on `mh/omr-rsi-notes-fixes-c12b`; the host alone runs
   Audiveris and the official bench. Use a fresh, provenance-matched engine
   revision (svc-25 if available). Keep parser, `buildScoreData`, official
   scorer, warnings policy, floors, allowances, pins, options and deployed
   generation unchanged. Retain the accepted change-clef and earlier fixes.

## Prediction, validation and kill criteria

The first required result is correct ink-supported 5 → 10 binding. The
subsequent host run must demonstrate whether this activates exactly the
documented m8 separator recovery: **26 → 25** logical/printed/performed
bars, all **279** note elements retained, the double line retained internally,
and the two-quarter right fragment moved by exactly two quarters without
altering any note duration or serializing the simultaneous lower C4 half.
Saved OMR reload/export and repeated processing must preserve this result.
No target pass or disappearance of any other failure is assumed.

The host must bench all 16 byte-identical pinned inputs with the unchanged
`services/omr-service/src/eval/` scorer and inspect every changed XML piece
against svc-24, retaining svc-23 for attribution of the incidental changes
above. Keep all surviving failures visible. Focused controls alone establish
no official gate gain.

Kill the candidate if the printed 10 still fragments, grouping combines
different lines, incomplete/ambiguous digits become anchors, the producer
split survives, any real bar/repeat collapses, the internal line disappears,
polyphony or note durations change, or filler is invented. **Any protected
pass going red kills it.** Reject lowered floors/grades, expanded allowances,
warning suppression, reference-derived repair, unexplained gains and unrelated
recognition damage. If downstream checks fail after correct grouping,
report that exact seam instead of relaxing their predicates.

Astra changed only this hypothesis file. Pre-existing dirty bench reports
and `controls2.log` were left untouched. No engine/parser implementation was
edited or committed, and no tests, bench, Audiveris or Docker were run.
