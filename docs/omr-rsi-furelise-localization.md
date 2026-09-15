# Für Elise (`fur-elise-mutopia`) localization

This packet uses the frozen 300 dpi baseline:

- report: `/tmp/omr-rsi-baseline/fur-elise-mutopia.json`
- ScoreData: `/tmp/omr-rsi-baseline/fur-elise-mutopia.score.json`
- page image: `/tmp/furelise-page/page-1.png`, `/tmp/furelise-page/page-2.png`, and `/tmp/furelise-page/page-3.png`
- raw OMR: `services/omr-service/eval/cache/artifacts/c5b64f7ad614e8737ed4710e8b7ebeb8359e85c64935767b9e49bfd164b3eba4-audiveris-5.11.0+svc-15-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/omr-eval-input.omr`
- emitted MusicXML: `/tmp/furelise-mxl/omr-eval-input.xml`
- edition source: `/tmp/fur-elise.ly`

The frozen report has 24 missing and 24 extra pitches. It lists three wrong engraved lengths: m13 (1560 ticks versus 720), m25 (1200 versus 720), and m31 (1680 versus 720). After the pickup-origin correction in the comparator, m8 is also exposed as wrong (OMR 720 versus its declared 480-tick partial). The errors are localized as follows; pitch values are MIDI numbers from the report.

| bars | missing | extra | raw boundary evidence |
| --- | --- | --- | --- |
| 13 | `64` | `41,43` | OMR stack 13 is `duration="13/16"`, `excess="7/16"`; XML m13 has a lower voice-5 F2 half note (duration 16) and a voice-6 G2 at the tail. |
| 14–15 | m14 `76,76,75`; m15 `76,75` | m14 `55,55,54`; m15 `54,55` | XML m14/m15 have no clef attributes and carry the lower notes as G3/F#3/G3 and F#3/G3. |
| 24 | `69,65` | — | Dense chord passage; normal 720-tick measure and no clef change. |
| 25 | — | `65` | XML/OMR m25 is overfull at 1200 ticks, with an extra F4 in the ending figure; no clef change. |
| 28 | `70` | — | One omitted pitch in a dense 32nd-note figure; normal 720-tick measure and no clef change. |
| 31 | — | `41` | The OMR stack containing source m31 has a lower voice-5 F2 half note beginning after the nominal bar; XML m31 is 1680 ticks and has no clef attribute. |
| 32–33 | m32 `67,67,67,60,64,64,65,65,62`; m33 `60,64,67` | m32 `40,43,43,45,45,47,47,47,41`; m33 `40,43,47` | XML m32 has no clef and reads the lower staff as E2/G2/A2/B2/F2; m33 records a lower G clef but still emits E2/G2/B2/F3/A3/G3/B3. |
| 81 | `93,96,100` | `69,72,76` | Page 3 visibly carries the `8` ottava bracket over this rapid figure; XML has no octave-shift element, so this is an independent ottava-recognition fault. |

The counts in the table are 24 missing and 24 extra. The report independently classifies nine octave and five semitone errors in addition to those counts; neither category is used as a scorer allowance.

## Clef-boundary hypothesis

The page supports the paired-cluster trigger. On page 1, the lower staff has a printed inline G clef immediately before the high lower-staff figure spanning m14–15. The edition source has the matching `\\clef treble` transition in the second repeated lower-staff passage (`/tmp/fur-elise.ly`, lines 96–99). The OMR sheet contains the ordinary system clefs but no clef inter for this inline glyph; MusicXML m14 and m15 contain no `<attributes><clef>` element. The preceding m13 is independently marked abnormal and overfull because the lower voice has acquired a spurious long F2 and a trailing G2.

Page 2 shows the same layout at the m31→m32 boundary: an inline lower-staff G clef is printed at the boundary before the high lower-staff cluster. The edition source contains the corresponding transition in the later repeated passage (lines 123–126). The OMR record for the m31/m32 boundary has no inline clef entry, and XML m31/m32 have no clef attributes. XML m33's lower G clef is a later recognized clef; it does not repair the already emitted low pitches in m32, and the m33 notes remain low despite that attribute. This is a bounded OMR symbol-recognition/clef-propagation failure with a visible page trigger and a pitch/duration cascade across each pair.

The engine source narrows the seam further. `app/src/main/java/org/audiveris/omr/sheet/clef/ClefBuilder.java` explicitly extracts clefs at the beginning of a staff: `HeadersStep` calls it while processing the header. It is therefore not the inline-clef caller. The inline path is `SymbolsStep` → `SymbolsFilter` → `SymbolsBuilder` → `InterFactory`, whose clef cases create `ClefInter`; however, these false noteheads are first created by the earlier `HEADS` step and then grouped by `CHORDS`, before `SYMBOLS` runs. The first consumer to fix or arbitrate is consequently `app/src/main/java/org/audiveris/omr/sheet/note/NoteHeadsBuilder.java` (or its symbol/head conflict handoff), with `SymbolsBuilder.java` as the place that should receive a surviving inline clef candidate. `ClefInter.java` is downstream interpretation only. The emitted XML already contains the wrong pitches and durations, so `musicxml.ts`, rhythm repair, and scoring cannot prove or safely correct this hypothesis. No parser or corpus change is justified by this packet.

The m24/m25/m28 omissions/overfull bar and m81 ottava loss are separate faults. They do not establish a generic clef rule and must remain visible in any later engine experiment. Any candidate change must preserve the currently passing pieces and must not add a floor, allowance, or pitch correction.

## False-F2 provenance

The raw OMR graph shows that the length failures are literal clef ink consumed as note material, rather than invented pitches in MusicXML:

- In sheet 1, source m13 voice 5 slot 6 is `head-chord` **5690** (staff 6, grade 0.596, bounds `x=863,y=1791,w=25,h=119`). Its relations target stem **4384** (glyph 502, grade 0.619, bounds `x=869,y=1791,w=6,h=101`) and head **2694** (glyph 2673, `NOTEHEAD_VOID`, pitch position 5, grade 0.311, bounds `x=863,y=1888,w=25,h=22`). MusicXML serializes this as the false F2 half note, duration 16. The adjacent voice 6 G2 is a separate low-grade head-chord 5691, so the two extra pitches are not being conflated.
- In sheet 2, source m31 voice 5's excess final slot (sheet-2 measure id 3) is `head-chord` **7894** (staff 2, grade 0.597, bounds `x=1308,y=526,w=25,h=60`). Its relations target stem **5363** (glyph 460, grade 0.643, bounds `x=1327,y=526,w=5,h=42`) and head **3293** (glyph 3229, `NOTEHEAD_VOID`, pitch position 5, grade 0.318, bounds `x=1308,y=564,w=25,h=22`). MusicXML serializes this as the false F2 half note, duration 16.

The corresponding binary crops show each low-grade void-head/stem pair occupying the loop and vertical stroke of the printed inline G clef at the m13→14 and m31→32 boundaries. This is the causal link to the paired pitch cascades: the clef is not present as a `ClefInter`, while its ink has already become a `NOTEHEAD_VOID` plus stem in `HEADS`, then a half-note chord in `CHORDS`. The early phase must preserve or reject that candidate before the normal symbol pass erases or reuses it. A viable engine experiment should prove the same IDs disappear as note material and reappear as a staff-6/staff-2 inline G clef, with no coordinate or piece-specific exception.

## Engine repeat-run variance

The two duration/voice differences seen between the frozen svc-15 baseline and the cycle-10 packet are emitted by Audiveris before the parser. Their pitch and attack identities are unchanged across all 905 notes; only the following raw MusicXML fields differ:

- In m73 at the upper-staff onset corresponding to ScoreData tick 69840, baseline emits D5 and F5 as undotted quarter notes with duration 12 (432 ScoreData ticks). Cycle 10 emits both as dotted quarters with duration 18 (648 ScoreData ticks). The lower sixteenth-note B-flat run is identical.
- In m81's upper-staff 3:2 figure, the note durations remain identical, but Audiveris relocates staccato/tenuto articulation elements among the C6/A5/E6/B5 notes. This changes the derived velocity metadata and the duration records at the nearby onsets (baseline ScoreData durations 60/72/60; cycle 10 72/60/80).

The original-engine svc-15 control is preserved at `/tmp/omr-rsi-fur-control-15` (raw XML extracted at `/tmp/fur-control-mxl/omr-eval-input.xml`, SHA-256 `07e977d45776c326a8c784675c7601c09959941ad9bfe8113443f4e20cdda689`). It independently emits the same m73 dotted D5/F5 duration-18 pair and a different m81 articulation assignment. Evaluating that control through the frozen comparator gives 905/905 notes, 24 missing and 24 extra pitches, `onGrid=94.25414364640883`, `exact=94.58563535911603`, 102 correct-length and 4 wrong-length bars, with one distinct velocity. Cycle 10 has the same pitch/grid/length totals and two distinct velocities; the baseline has `onGrid=94.03314917127074`, 103 correct-length and 3 wrong-length bars, and no dotted m73 pair. The control therefore reproduces the material score change without a parser or scorer modification.

This is a reproducibility attribution, not a fix proposal: the m73 and m81 variation is an engine-output difference between independent runs, while the inline-clef false-F2 evidence above remains the separate causal hypothesis for the paired pitch clusters. No parser correction or engine patch is justified by this variance alone.

## Comparator accounting note

The frozen report predates the pickup-origin correction. With the corrected movement-relative walk, corpus `partialBars` entry m8=1 quarter applies to source m8 (source index 8), whose ScoreData duration is 720 ticks; the declared expected duration is 480. This fourth length failure is an existing comparator/parser accounting defect exposed by the corrected bar origin. It is separate from the engine clef evidence and must not be repaired with a pin, floor, allowance, or this clef experiment.
