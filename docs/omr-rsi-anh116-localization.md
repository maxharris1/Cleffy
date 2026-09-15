# Anh.116 (anna-magdalena-07) localization

## Verdict

The sole bad-length site is printed m23, causing both `bar-length` and
`bar-length-warning` gate failures. This is
an Audiveris recognition/rhythm-layer defect. The parser consumes the
MusicXML durations faithfully; no Cleffy parser change is justified by this
artifact.

The exact engine-side file to investigate is Audiveris' implicit-tuplet
rhythm path:

`/tmp/omr-rsi-audiveris-upstream/app/src/main/java/org/audiveris/omr/sheet/rhythm/MeasureRhythm.java`

with `TupletGenerator.java` as the directly related helper. A parser-only fix
would invent a tuplet and violate the XML/page boundary kill criterion.

## Evidence

The committed official result (`services/omr-service/eval/results/bench/bench.json`)
reports `anna-magdalena-07: bar-length-warning (measure_overfull)`, one wrong
bar out of 40, with 310 reference notes, 3 missing, and 2 extra. The fresh
svc-15 artifact is:

`services/omr-service/eval/cache/artifacts/9d53fe19d452a7e601e45786ecf860f30d45398912b1a6d47b656bcb96b4b86e-audiveris-5.11.0+svc-15-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/`

Its `.mxl` and `.omr` reproduce the committed failure. The pinned PDF and
MIDI hashes match `services/omr-service/eval/corpus/anna-magdalena-07.json`:

* PDF: `9d53fe19d452a7e601e45786ecf860f30d45398912b1a6d47b656bcb96b4b86e`
* MIDI: `d304586f42030116f2996a140022dc4b93eee63f12226a337c6f29117441dc7c`

The matching edition’s LilyPond source has the page’s m23 notation at line 54:

```lilypond
\times 2/3 {  fis8[( g  a)] } b,4 dis |
```

The rendered page in `sheet#1/BINARY.png` shows the `3` under the first three
upper-staff heads in printed m23. The Audiveris `.omr` `system id="4"`,
`stack id="23"` records `expected="3/4" duration="15/16" excess="3/16"`
(the same overfull amount emitted by the MusicXML).

The `.mxl` `measure number="23"` has divisions 12 and upper voice events:

| event | XML duration | expected from page |
| --- | ---: | ---: |
| F# eighth | 6 | 4 |
| G dotted eighth | 9 | 4 |
| G eighth | 6 | 4 |
| B quarter | 12 | 12 |
| D# quarter | 12 | 12 |

Thus the XML totals 45 divisions (`15/16`) while 3/4 is 36 divisions. The
triplet's `<time-modification>` is absent, and the middle G has a spurious
`<dot>`. For comparison, m24 has `<time-modification>` elements, confirming
that this is a local recognition failure rather than an unsupported XML
feature.

The `.omr` contains a `TUPLET_THREE` inter for the first triplet elsewhere
(system 3, the first repeat), but none attached to m23's three heads. Its only
system-4 tuplet is at x=1580, outside stack 23's x=1210..1513 range, while
m23's heads are at x=1235, 1279, and 1322. This is consistent with a missed
m23 tuplet and a misplaced/false system-4 tuplet, alongside the false dot.

## Parser boundary check

`scanPart` stores each XML `<duration>` as `dur` and advances the measure
cursor (`services/omr-service/src/musicxml.ts:1751` and `:1778`).
`placeMeasures` emits `measure_overfull` and intentionally keeps the real
content length when it exceeds the expected meter
(`services/omr-service/src/musicxml.ts:2171-2178`). The reported warning is
therefore the correct result for this XML.

The existing `barRegrid` guard also refuses to force an answer when its onset
bounds do not meet (`services/omr-service/src/barRegrid.ts:360-363`). Loosening
that guard or inserting a parser-side tuplet would be an invented timing
repair and is rejected by the product lock.

## Kill criteria / regression

This packet has actual pinned page, `.omr`, `.mxl`, and reference evidence, so
the missing-artifact kill criterion is cleared. The XML-already-wrong kill
criterion applies: fix and rerun the engine's tuplet/dot recognition before
considering a parser change. No source or test implementation was made here;
the parser remains unchanged and all currently passing pieces retain their
committed baseline.
