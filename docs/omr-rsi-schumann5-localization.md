# Schumann Op. 68 No. 5 localization

Status: the first divergence is upstream Audiveris pickup timing. The current
MusicXML parser is faithfully consuming an under-specified implicit measure;
there is no safe parser repair that can choose the missing pickup duration from
this XML alone.

## Printed evidence

The pinned page is `services/omr-service/eval/corpus/schumann-op68-05.json` PDF
SHA `8f56f70d597a838d23590ed5bbc9ecf10b21e77f07620019cdc2d06b931f7c17`.
The matching LilyPond source (`schumann-op68-05-petite-piece.ly`) declares
`\partial 2.` (a three-quarter pickup), then writes an invisible `s4` followed
by `e-2 ... ( f |`. Thus the first upper-voice attacks occupy quarters 2 and 3
of a three-quarter pickup. The lower voice similarly begins after `s4` and has
four eighths. The skip is intentionally invisible on the PDF, so its duration
must be carried by the pickup timing rather than a visible rest glyph.

## First machine divergence

In the frozen svc-15 artifact (`8f56f70d.../omr-eval-input.omr` and `.mxl`),
the extracted `/tmp/schumann5-sheet.xml` says:

* sheet line 34: stack `id="0" special="PICKUP" expected="1" duration="1/2"`;
* lines 35–38: only four slots, from time `0` through `3/8`;
* lines 151–197: measure `id="0"` has two upper head chords and four lower
  head chords, with no leading rest/forward event.

The generated MusicXML has `measure number="0" implicit="yes"` at line 105 of
`/tmp/schumann5-omr.xml`, `divisions=2`, and no `<forward>` before the first
upper note (lines 151–178). Each upper quarter has duration `2`, and the lower
four eighths have duration `1`, so both voices end at four divisions = 960
ticks = two quarters. The next measure starts at line 235 and is consequently
placed by the parser at tick 960. The printed source requires three quarters,
1440 ticks, so every subsequent bar is shifted one quarter early.

The frozen ScoreData confirms the same boundary: m0 is `{n:0,tick:0,dTicks:960}`
and m1 is `{n:1,tick:960,dTicks:1920}`. It reports 26 OMR bars against the
25 reference bars, `measure_underfull`, `barsWrongLength:1`, 39 missing and 39
extra notes, and 82.8% exact/on-grid. These are consequences of the first
pickup boundary; they are not evidence for guessing note durations later.

## Layer attribution

Audiveris computes the pickup stack from the actual slot/chord duration. In the
upstream source, `app/src/main/java/org/audiveris/omr/sheet/rhythm/MeasureRhythm.java`
lines 617–645 document and implement `processStartingChords()` by assigning
the first slot's chords time offset zero. `MeasureStack.java` lines 1171–1188
then reports the maximum slot end as actual duration, producing `1/2` here.
`PartwiseBuilder.java` lines 2077–2112 emits a `<forward>` only when a chord's
time offset is greater than its voice counter; with the first chord at zero,
it has no signal from which to emit the invisible first-quarter skip.

The exact upstream file to own for a functional fix is therefore
`MeasureRhythm.java`, at the pickup starting-slot timing seam. A fix would need
to derive the leading one-quarter silence from reliable page/score evidence and
carry it into the pickup's duration/export. `PartwiseBuilder.java` is only the
serialization follow-up once that timing exists. `MeasureFixer.java` merely
recognizes the already-short stack as a pickup and cannot recover the omitted
silent quarter.

`services/omr-service/src/musicxml.ts` deliberately keeps implicit pickup
content length (`placeMeasures`, lines 2151–2178), and the focused unit test
asserts that behavior. Padding every short pickup to the meter would break the
valid one-quarter and other pickups and would invent a duration here without a
source marker. No Cleffy source or test change is justified by this artifact.

## Required next artifact

An upstream experiment must show a pickup representation that carries the
printed three-quarter length, such as a m0 leading `<forward>` of two divisions
before the first notes or equivalent corrected pickup duration in `.omr`. The
same pinned PDF and options should be used, followed by checking that m1 begins
at 1440 ticks and that all five currently passing pieces remain green. Until
that evidence exists, do not alter pickup padding, scorer expectations, warning
gates, floors, allowances, or timing by inferred note edits.
