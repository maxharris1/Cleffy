# OMR RSI cycle 18 — Schumann's internal double barline

**One hypothesis for Grok; implementation and host bench pending.** Astra's
work in this round is read-only localization and this document. The current
split-loop instructions override the older pass-all implementer orchestration.

## Official starting point and cycle-17 verdict

Accept cycle 17 as the host's **attributable partial improvement**, not a gate
flip. The authoritative supplied result is HEAD `0cd7595`, container
`cleffy-rsi-omr-23`, engine `audiveris-5.11.0+svc-23`, generated
`2026-09-14T19:36:29.456Z`. The local host reports agree. Current `bench.json`
SHA256: `33e3482f5adef01ee3ada567fc149ff7a2010cb021aa59106cc739e2ee97cc58`.

The suite remains **8/16**: 5,996 reference notes, 83 missing, 126 extra;
pitch 98.09873248832555%, exact 96.66444296197464%, on-grid
95.98065376917945%. Against the official svc-22 starting point recorded in
[cycle 17](omr-rsi-cycle-17.md), missing and extra each fall by 34.
Schumann 68/5 moves from 39/39 to **5/5**, and exact/on-grid from 82.8% to
**264/279 = 94.6236559139785%**. Its note-length check now clears 90%.

All eight protected pieces remain green: **Czerny 821/1, BWV 999, Anh. 114,
Anh. 115, Anh. 116, Arabesque, Schumann 68/1, Chopin 28/4**. The official
limits are unchanged: exact **95%**, on-grid **90%**, one missed/extra note
per 16 printed bars. There is no cycle-17 diff to the official scorer,
corpus pins or MusicXML parser against `b0acee3`. No metric-based kill
criterion fires. Preserve cycle 17 and all earlier accepted patches.

The saved Schumann log accepts `clefs.G_change` on staff 2 at
`(501,898,43,127)`, with ink `1631/1755`. Its XML now places the lower-staff
G change before the opening notes; changed measures are 0–5. The exact
BINARY remains unchanged. Across the 16 saved svc-22/svc-23 score XML pairs,
the only other changed piece is Czerny m6, with articulation reassignment
and unchanged note pitch/duration sequence and official pass. Credit no
clef or timing gain to that incidental difference. WTC, Für Elise and
Invention 1 have unchanged score XML; historical isolated probe gains are
not official gains. Invention 1 still fails at unrounded 435/458 exact.

Schumann remains red on all eight reported failures: `measure_underfull`,
26 printed bars, 26 scored versus 25 reference bars, one incorrect bar
length, 26 performed bars, five missing, five extra, and exact below 95%.
The stale “pending” wording in cycle 17 is superseded by this verdict.

## One hypothesis and ink-level cause

**Schumann — Album für die Jugend, Op. 68 No. 5 (Stückchen),
`schumann-op68-05`: the two thin vertical strokes halfway through printed
measure 8 are a noncounting section separator. Audiveris recognizes their
ink correctly as a double barline but incorrectly makes that separator a
logical measure boundary. Recovering its internal-barline role, with
independent printed measure-number corroboration, will remove the extra
bar without changing any note or inventing rhythm.**

This is an engine measure-structure hypothesis. It does not reopen the
clef, pickup, rest, slur or tuplet hypotheses. In particular, merely finding
two short bars whose durations sum to the meter is insufficient evidence.

## Evidence rebound to svc-23

Pinned PDF:
`services/omr-service/eval/cache/downloads/schumann-op68-05.pdf`, SHA256
`8f56f70d597a838d23590ed5bbc9ecf10b21e77f07620019cdc2d06b931f7c17`.
The current artifact directory is:

`services/omr-service/eval/cache/artifacts/8f56f70d597a838d23590ed5bbc9ecf10b21e77f07620019cdc2d06b931f7c17-audiveris-5.11.0+svc-23-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/`.

Its metadata declares and observes svc-23 with the three unchanged official
options. Evidence hashes:

| Artifact | SHA256 |
| --- | --- |
| `omr-eval-input.omr` | `4e1c762ee19704a0d88ade06b6da98b22c7b55d574ab0cfe70ea9ad618e90e53` |
| `sheet#1/sheet#1.xml` | `c59c245ecf080d5dd2bfb09324e81a9fa61bdb19e8064daf6ed103071c402266` |
| `sheet#1/BINARY.png` | `668631f54babe7c9bda6489b1a72e9b3855214d5d15a9b08ec09fe6dffb5e6fa` |
| XML inside `omr-eval-input.mxl` | `24f26d8c958b3c2a8d2244956065f53e6ba1d797664567cfd9d23ebde1e207af` |

On page 1, system 2, global staves 3/4, stack 8 spans x1551–1743 and
stack 9 spans x1743–1984. Both have `expected="1" duration="1/2"`, no
repeat or implicit designation. Their separator is staff-barline **6071**
`(1731,1195,15,85)` and **6072** `(1731,1377,15,87)`. Upper-staff thin
barline inters are 38/40; lower-staff inters are 49/50. These are fixture
identifiers, never production constants. The native PDF crop visibly
contains both strokes and no repeat dots.

MusicXML has divisions-per-quarter 2, ordinary numbered m8 and m9, and
`<barline location="right"><bar-style>light-light</bar-style></barline>`
at the end of m8. Each fragment contains two quarters of real content:

| Fragment | Upper staff | Lower staff |
| --- | --- | --- |
| XML m8, before the double line | D5 quarter, C5 quarter | F4 quarter, E4 quarter, with simultaneous C4 half |
| XML m9, after the double line | B4 quarter, C5 quarter | G3, G4, A3, G4 eighths |

The page shows these eleven notes in one 4/4 measure. The matching local
LilyPond source `/tmp/schumann-op68-05.ly` explicitly has
`d-3 c) \bar "||" b( c |`; its SHA256 is
`f1f6e3d2a53132bf96e1c703df3131b2d3c34cf43f920fa5bd6088bd691ee8c0`.
That temporary source is supporting evidence, not a new corpus pin or a
production input. The same phrase returns in printed m16 without an
internal double line and is already exported as one measure (XML m17).

There is independent evidence on the pinned PDF itself: system 2 starts at
printed **5**, system 3 at **10**, then systems 4/5 at **15/20**. Counting
the internal double as a boundary produces six stacks between 5 and 10.
The two-quarter pair is the unique complementary pair at a plain internal
double in that span. Read-only `pdftotext -bbox` extracts these source text
boxes in points, using a top-left origin:

| Printed number | `(xMin,yMin,xMax,yMax)` |
| --- | --- |
| 5 | `(27.569155,275.399796,32.403551,283.599141)` |
| 10 | `(22.807046,380.380006,32.403480,388.579351)` |

These are text boxes, not verified glyph-outline masks. Reconstruct the
outlines and corroborate visible source ink before using them in recovery.
Current OMR word **5595** reads `10` at `(98,1586,35,26)` but has
`UnknownRole`; system 2's printed 5 has no corresponding header word.
The later printed 15 is OCR `l5`. Do not silently substitute those OCR
values, use the title's `5.`, or promote fingering digits into bar numbers.

The error already exists in OMR stacks and exported MusicXML, before
`src/musicxml.ts` pads short numbered bars. Suppressing its warning or
merging its raw measures from duration alone would leave the producer wrong.

## Bounded implementation contract for Grok

1. Work on this hypothesis only on `mh/omr-rsi-notes-fixes-c12b`. Add a
   conservative engine helper for internal-double-bar evidence. Obtain
   printed system-number anchors from actual visible PDF text, with font
   decoding, transformed outlines, ink corroboration and unique association
   above the top staff at the system's left edge. Reuse the accepted PDF
   transform conventions where suitable; preserve the clef helper's behavior.
   Unsupported sources, transforms, encodings, or ambiguous numbers skip
   recovery. Do not add broad digit-classifier or OCR-threshold changes.

2. Require both anchors to bind one system span. The source-number difference
   must be exactly one less than its otherwise valid raw measure count,
   with exactly one eligible adjacent pair. Both fragments must have
   internally consistent recognized rhythm across the staves, positive
   content shorter than the unchanged meter, and complementary durations.
   At this site the three left voices and two right voices have different
   populations; preserve the simultaneous C4 half rather than requiring
   identical voice IDs across the separator. No note/rest/dot/tuplet edit
   may be used to make the pair qualify.

3. Require the actual same-system double-thin separator ink on every
   participating staff. Exclude repeats, endings, final/heavy bars, system
   boundaries, signature changes, cautionary/implicit measures, missing or
   conflicting staff boundaries, and any second eligible pair in the span.
   Neither an expected bar count nor a duration sum can override contrary
   source evidence. Never read the corpus, reference MIDI, `.ly`, piece
   names, hashes, fixed bar numbers or coordinates in production.

4. Correct the engine's logical measure structure after initial rhythm is
   available and before final numbering/export. Preserve the separator as
   an internal barline and preserve every original note, rational duration,
   clef, slur and articulation. The relevant upstream model already has
   `Measure.midBarline`, and `Measure.mergeWithRight` retains the previous
   right barline there. Its voice handling assumes rhythm reconstruction;
   a blind merge is insufficient. Review the pinned
   [Measure implementation](https://raw.githubusercontent.com/Audiveris/audiveris/5.11.0/app/src/main/java/org/audiveris/omr/sheet/rhythm/Measure.java)
   and
   [MeasureStack merge](https://raw.githubusercontent.com/Audiveris/audiveris/5.11.0/app/src/main/java/org/audiveris/omr/sheet/rhythm/MeasureStack.java).
   Bind the hook to the actual 5.11.0 rhythm/numbering lifecycle, keep stack,
   part, slot and voice ownership consistent, and verify export through
   `score/PartwiseBuilder.java`. The output must be one logical m8 with the
   light-light barline at its middle, then correctly numbered later bars.

5. At divisions 2, the right fragment's events move to offsets 4,5,6,7 as
   applicable; left-fragment events and all note durations remain unchanged.
   Reconstruct voice timelines without serializing the simultaneous lower
   half note or creating sounding filler. Repeated processing and saved
   OMR reload/export must be inert. Log source anchor values, geometry and
   ink checks, the selected separator, original durations and rejection
   reasons so the host can attribute every changed measure.

6. Keep the parser, `buildScoreData`, scorer, warnings policy, corpus pins,
   allowances, options and deployed generation unchanged. Use a fresh
   engine revision, svc-24 if still free, with reproducible patch/build
   wiring and matching provenance. Leave the opening pickup untouched:
   the source's `s4` is invisible and this hypothesis does not authorize
   inventing its missing initial silence or changing `pickupQuarters`.

## Controls, predicted delta and kill criteria

Grok's focused controls must cover this exact source and OMR evidence,
translated geometry, the already-correct repeated phrase, preserved lower
polyphony, wrong/blank/ambiguous number ink, title and fingering digits,
wrong-staff anchors, two eligible pairs, a genuine numbered short-bar pair,
ordinary full bars around a double, repeats and endings, meter changes,
and unsupported/raster input. They must show that changing the following
printed anchor to count both fragments prevents recovery, even though the
durations still sum to 4/4. Preserve Air's accepted repeat fragments and
Schumann's actual final light-heavy bar. Fixture checks establish no suite pass.

The host alone builds/runs the matching engine and benches all 16 pinned
pieces with the unchanged official `services/omr-service/src/eval/` scorer.
Compare against the supplied svc-23 result, inspect every changed XML
piece, and bind any gain to the source. The predicted target change is
**26 → 25 logical/printed/performed bars**, removal of the spurious m8/m9
split and its downstream timing gap, with all 279 emitted note elements
retained. Missing/extra and exact must be measured by the host; a Schumann
pass is a prediction to test, not an achieved result. Remaining failures
stay reported and do not authorize a second repair in this cycle.

Kill the candidate if either printed number cannot be independently bound
to visible ink, the pair is ambiguous, the primary producer split survives,
the double line is deleted instead of retained internally, a real measure
or repeat is collapsed, polyphony or note durations change, filler is
invented, or any of the eight protected passes goes red. Reject unexplained
gains, new unrelated recognition damage, lowered floors/grades, expanded
allowances, warning suppression, or reference-derived repair. If evidence
is insufficient, leave the site unchanged and report that blocker.

Only this hypothesis file is changed by Astra. Pre-existing dirty bench
reports and `controls2.log` are left untouched; no engine/parser code was
edited, no implementation committed, and no benchmark, Audiveris or Docker
run was performed. **16/16 remains the goal.**
