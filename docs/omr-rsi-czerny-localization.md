# Czerny Op. 821 No. 1 octave-shift localization

Slug: `czerny-op821-01`

## Hypothesis

The 12 pitch substitutions are caused by a printed upper-staff ottava being retained only as OCR text and never becoming an Audiveris `OctaveShiftInter`. They are not caused by parser pitch arithmetic.

## Baseline accounting

The frozen svc-15 baseline is 152 reference notes and 152 OMR notes: `missing=0`, `extra=0`, `octave=12`, `semitone=0`, with 92.1053% exact pitch. The 12 octave substitutions therefore are one-to-one notes whose pitches differ by exactly one octave. They account for the final eight sixteenths of m6 and the first four sixteenths of m7. The note count and all bar lengths remain correct.

Evidence: `/tmp/omr-rsi-baseline/czerny-op821-01.json`, its `.score.json`, and the svc-15 artifacts under `services/omr-service/eval/cache/artifacts/657707b2e7e771eab728833f317d6de2b0f6fcba0787cf9a990aa757cbb73765-audiveris-5.11.0+svc-15-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/` (the same PDF hash also has a later probe artifact with suffix `73d09423526056ef9012207d05752df86f9574b7b501aa3235256feb0fd228f9`).

## Page to OMR to MusicXML

The page image shows a clean `8va----` above the upper staff beginning over the late part of m6 and continuing across the system break over the first four notes of m7. The OMR binary preserves the mark and its long horizontal extension; this is not a DPI or fragmented-ink failure.

In `/tmp/czerny-sheet.xml`, system 3 contains:

- sentence `id=3467`, role `Direction`, staff `5`, bounds `x=1850 y=1206 w=127 h=33`;
- word `id=3469`, value `811a`, shape `TEXT`, glyph `3453`, staff `5`, bounds `x=1905 y=1206 w=72 h=33`.

This is the upper m6 mark. There is no `OctaveShiftInter` for it, and system 4 has no continuation object. Consequently `/tmp/czerny.xml` has no `octave-shift` direction for the 12 affected notes. It has only the unrelated lower-staff shift in m5:

```xml
<octave-shift kind="BASSA" ... staff="6" id="4193" .../>
```

That object is at `x=191..265`, below the lower staff, and is linked to chord `3829`. Reassigning it to the upper m6 mark would be incorrect and risks changing the already-correct m5 pitches.

## First upstream seam

The existing semantic path is:

1. `TextBuilder.createSystemInters()` (`/tmp/omr-rsi-audiveris-upstream/app/src/main/java/org/audiveris/omr/text/TextBuilder.java:206-269`) creates a `WordInter` for every default-role text word, including this Direction word.
2. `InterFactory.doCreate()` (`.../sheet/symbol/InterFactory.java:259-269`) creates an `OctaveShiftInter` only when the classifier supplies `Shape.OTTAVA`, `QUINDICESIMA`, or `VENTIDUESIMA`.
3. `SymbolsLinker.linkOctaveShifts()` (`.../sheet/symbol/SymbolsLinker.java:235-264`) links only existing `OctaveShiftInter` objects to chords.

The m6 glyph is serialized as `TEXT`/`WordInter` with OCR `811a`, so the defect is the text/symbol recognition-to-inter conversion seam, before octave linking and MusicXML export. `OctaveShiftInter.searchLinks()` would correctly select the staff-5 chords within the ottava line once such an inter exists, including the system-local endpoints.

## One bounded proposed rule

If an implementation is attempted, the single candidate is a generic conversion in `TextBuilder.java` (with the existing `InterFactory.java` path reused): recognize a Direction `WordInter` whose normalized OCR is an `8va` variant, only when its underlying glyph is above exactly one staff at the ottava gap and a surviving horizontal dash run continues from the glyph toward the system boundary. Convert that glyph through the existing `Shape.OTTAVA` factory and let `SymbolsLinker` perform normal chord linking. The rule must reject words without the dash evidence, words between/inside staves, and words with an existing octave-shift overlap; it must not use piece or coordinate special cases.

This is a proposed source experiment, not an implementation. Before editing, ownership of `/tmp/omr-rsi-audiveris-upstream/app/src/main/java/org/audiveris/omr/text/TextBuilder.java` and the related symbol conversion path must be explicitly assigned. No parser, gate, floor, allowance, or pitch-shift heuristic is justified by this packet.

## Kill criteria

Kill this hypothesis if the dash cannot be associated with the `811a` glyph and one staff, if conversion requires inventing an ottava from text alone, if the rule needs piece/coordinate special-casing, or if any currently passing piece goes red. Do not alter the existing lower m5 `BASSA` object.

## Implementation audit

The required dash geometry does survive independently in the OMR glyph index, even though it is not represented as an inter. On the m6 upper staff, the binary image has 21 two-pixel dash runs at `y=1221..1222`, beginning at `x=1985` and continuing through `x=2414` (glyphs `4033, 4035, 4041, 4045, 4047, 4048, 4051, 4052, 4054, 4057, 4059, 4060, 4062, 4064, 4065, 4067, 4068, 4069, 4071, 4072, 4073`; widths 9–10 px). This starts 8 px after the `811a` value box at `x=1905..1977` and ends 15 px before the system edge at `x=2429`. The continuation survives above system 4 staff 7 as 11 two-pixel runs at `y=1663..1664`, `x=271..484` (glyphs `3891, 3892, 3896, 3902, 3904, 3906, 3907, 3910, 3911, 3914, 3915`). Those runs span the first four m7 upper chord centers `x=252,332,404,476` and sit above the staff whose top line is `y=1756`. The staff and extents are therefore unambiguous.

The source constructor plan cannot be implemented safely in the permitted `TextBuilder.java` patch alone. `OctaveShiftInter.create()` (`/tmp/omr-rsi-audiveris-upstream/app/src/main/java/org/audiveris/omr/sig/inter/OctaveShiftInter.java:875-908`) creates a line from the glyph center for exactly the fixed default length of 3 interlines; it has no public line setter. At this score's 21 px interline, that is about 63 px, while the surviving m6 span is 429 px. A `TextBuilder` conversion of `glyph 3453` through `OctaveShiftInter.create(glyph, Shape.OTTAVA, grade, staff5)` would thus link only the first one or two m6 chords, and cannot represent the m7 continuation. Splitting the dash into multiple synthetic octave inters or fabricating a longer glyph would invent semantics and fail the bounded hypothesis.

**Disposition:** kill the implementation hypothesis under the exclusive TextBuilder source path. The raster and glyph evidence proves the recognition loss, but a correct generic repair requires an additional owned change to the octave-shift geometry/linking class (or an existing API that can set the measured line), followed by a serialized full bench. No source was copied or edited and no engine run was performed.
