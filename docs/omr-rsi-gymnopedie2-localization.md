# Gymnopédie 2 localization

The hypothesis that the ten long bars are one parser duration bug is rejected.
The first wrong events are already present in svc-15 MusicXML. No implementation,
pin, floor, allowance, or warning change is justified by this packet. No currently
passing piece may go red.

## Evidence and accounting

`gymnopedie-2` uses the pinned PDF SHA
`d23906c422539128fe0e5106a4ebf8ea7f8273a60c3f2dbcf4c7f5f46363acb6`.
The original 300-dpi artifact hash is
`6e941524dd1cba0b210bcc7a4548cb82802681f896194b3dbd5c0f04b73a0ba6`.
The matching [Mutopia source](https://www.mutopiaproject.org/ftp/SatieE/gymnopedie_2/gymnopedie_2.ly)
declares A minor and 3/4, with independent melody, accompaniment, and bass voices.
The pinned page confirms this notation. Diagnostic copies are
`/tmp/omr-rsi-baseline/gymnopedie-2.ly` and
`/tmp/omr-rsi-baseline/gymnopedie-2-page1.png`.

The frozen official result has 320/371 exact attacks (86.2533692722372%),
318/371 on-grid notes (85.71428571428571%), eight missing, four extra, and five
semitone substitutions. The failed checks are `bar-length-warning`, `bar-length`,
`notes-present`, `attack-grid`, and `note-length`. All gate checks are populated.

## First wrong event in each long bar

MusicXML uses one division per quarter throughout these examples. Every printed
bar is three quarters (1440 ticks).

| Printed bar | First divergence in raw XML | Resulting extent |
| --- | --- | --- |
| 1 | No time signature; an invented lower-staff quarter rest precedes the printed dotted-half G2. The whole-measure upper rest also receives duration 4. | 4 quarters, 1920 ticks |
| 20 | Upper E5 and the accompaniment chord share sequential voice 2: after its quarter rest and E5 quarter, the chord starts at quarter 2 instead of alongside E5 at quarter 1. D5 follows at quarter 4. | 5 quarters, 2400 ticks |
| 22 | F5 and G5 quarters are followed sequentially by the accompaniment half-note chord in voice 1, delaying that chord from quarter 1 to quarter 2 and the final melody note to quarter 4. | 5 quarters, 2400 ticks |
| 25 | Dotted-half F5 is followed sequentially by the accompaniment half-note chord in voice 1; the chord starts at quarter 3 instead of quarter 1. | 5 quarters, 2400 ticks |
| 30 | Dotted-half G5 is followed by the accompaniment half-note chord in voice 1, at quarter 3 instead of quarter 1. | 5 quarters, 2400 ticks |
| 32 | F5 and E5 quarters are followed sequentially by the accompaniment chord in voice 1, then D5 at quarter 4. | 5 quarters, 2400 ticks |
| 33 | Dotted-half F5 is followed by the accompaniment half-note chord in voice 1, at quarter 3 instead of quarter 1. | 5 quarters, 2400 ticks |
| 53 | Dotted-half C5 is followed by the accompaniment half-note chord in voice 1, at quarter 3 instead of quarter 1. | 5 quarters, 2400 ticks |
| 57 | Dotted-half D5 is followed by the accompaniment half-note chord in voice 1, at quarter 3 instead of quarter 1. | 5 quarters, 2400 ticks |
| 60 | Dotted-half B-flat5 is followed by the accompaniment half-note chord in voice 1, at quarter 3 instead of quarter 1. | 5 quarters, 2400 ticks |

None of these events has a MusicXML `time-modification`. Nine bars therefore
share an upstream voice/slot assignment failure, separate from the first bar's
header and rest recognition failure. The exact next inspection is their OMR
rest/head/stem relations and `MeasureRhythm`/`ChordsMapper` assignments; the XML
alone does not yet establish which relation or missing rest initiates that
failure. Do not force sequential XML notes to overlap merely to fit 3/4.

## m25 and m30: the accompaniment rest is present on the page but absent as an inter

The first two representative bars show a lost symbol before any slot mapping. In the
page render, m25 has the ordinary quarter rest at the left onset of the upper staff,
alongside the dotted-half melody note and the lower-staff accompaniment chord. The
300-dpi binary retains that rest as glyph `6514`, with `groups="SYMBOL"` and bounds
`x=1778 y=1363 w=22 h=59`. Its run table is the same quarter-rest silhouette as the
accepted m24 glyph `6451` (`x=1554 y=1363 w=22 h=59`) and accepted m29 glyph `6224`
(`x=745 y=1363 w=22 h=59`). The associated small four-pixel glyph `6515` above it is
also retained, just as the corresponding `6452`/`6225` fragments are retained near
the accepted rests.

The final OMR XML has no `<rest>` or `<rest-chord>` for glyph `6514`, and m25 has no
voice-2 entry. It does have the dotted-half melody head-chord `5823` at
`x=1783 y=1278 w=25 h=66`, the lower accompaniment head-chord `5833` at
`x=1780 y=1627 w=25 h=60`, and augmentation dots `6865` and `6866`. Thus the raw
rest ink is neither assigned to voice 1 nor serialized with the wrong duration: its
rest inter was never produced.

m30 repeats the same boundary failure on the next system. Raw glyph `6232` is a
`groups="SYMBOL"` quarter-rest-shaped component at `x=757 y=1868 w=22 h=59`, but no
rest inter or rest-chord appears in the XML near the m30 head-chord `5842`. The
corresponding m31 rest glyph `6282` at `x=978 y=1868 w=22 h=59` is exported as rest
`6905`/rest-chord `6967`. This matched pair rules out a general absence of printed
rests and points to symbol acceptance or `RestInter.createValid` at the
`SymbolsBuilder.evaluateGlyph` → `InterFactory` → `RestInter` boundary. The raw
artifact does not preserve classifier evaluations, so it cannot distinguish a
below-floor QUARTER_REST result from `createValid` rejecting the candidate; both are
upstream of `MeasureRhythm` and `ChordsMapper`.

The m25 XML voice assignment makes the consequence explicit: voice 1 contains
melody chord `5823` at slot 1 and chord `5824` at slot 2, while voice 5 contains
lower chord `5833` at slot 1. There is no competing rest relation to reassign. The
next implementation hypothesis must therefore target the generic rest-symbol
recognition/validation seam using these surviving glyph geometries, with a negative
control for accepted m24/m29/m31 rests. A parser voice repair would conceal the
missing inter and is killed by this evidence.

## Other failures remain separate

The first XML key has `fifths=-1`, despite the page's empty key signature. This
produces five semitone substitutions in bars 1, 3, 5, 7, and 9. Bars 27 and 39
each contain only the D2 bass note in XML: the printed four-note accompaniment
chord A3/C4/F4/A4 is absent, accounting for all eight missing notes. The four
extra D5 attacks occur in bars 35, 57, 58, and 59, where the source ties the
melody. Those require tie recognition/localization in addition to voice repair.

A future candidate must address the relevant engine evidence, preserve all
current passes, and run the full 16-piece bench. There is no pass claim here.
