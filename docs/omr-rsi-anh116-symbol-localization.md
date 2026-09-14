# Anh. 116 m23 tuplet symbol localization

## Scope and verdict

This packet tests one hypothesis for `anna-magdalena-07`: the printed m23
triplet numeral survives as fragmented `SYMBOL` glyphs but is lost at symbol
dispatch or tuplet linking. The exact pinned svc18 artifact was used:

`services/omr-service/eval/cache/artifacts/9d53fe19d452a7e601e45786ecf860f30d45398912b1a6d47b656bcb96b4b86e-audiveris-5.11.0+svc-18-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/`

The symbol-dispatch part of the hypothesis is supported, but the saved
failure is at the later link stage. A read-only engine probe rebuilt system 4
symbols: it created a `TUPLET_THREE` for the m23 compound, then
`TupletsBuilder.linkStackTuplets()` removed it because `lookupLinks()` returned
no links. No production source was changed.

## Page and XML evidence

The exact page crop `/tmp/omr-rsi-anh116-root/m23.png` shows a printed `3`
under the first three beamed upper-staff heads. The XML
`/tmp/omr-rsi-anh116-root/sheet.xml` records the fragments as free glyphs in
system 4 / stack 23:

| glyph | bounds | weight |
| --- | --- | ---: |
| 6334 | x1270 y1693 w4 h9 | 20 |
| 6335 | x1272 y1702 w1 h1 | 1 |
| 6336 | x1274 y1678 w14 h26 | 123 |
| 6337 | x1276 y1691 w2 h1 | 2 |

All four have `groups="SYMBOL"`, but none is referenced by an XML tuplet
inter. The m23 upper voice is marked `excess="3/16"`; its durations are
6, 9, 6, 12, 12 divisions (45 against the expected 36), with no
`time-modification`. The false augmentation dot `6545` is linked to middle
head `2343` at x1279, producing the 9-division event. The existing tuplets
are in other locations: `6326`→`6398` and `6531`→`6532` (the latter starts at
x1580, outside m23's heads at x1235, x1279, x1322).

## Probe results and first rejection

The engine's symbol candidate threshold is 3% of interline area. With
interline 21, `minWeight` is 13; the two one- and two-pixel fragments are
therefore excluded from the normal candidate list and are not in a
`SmallChordInter` fine box. The two substantial fragments 6334 and 6336 are
nevertheless joined by the normal 0.8-interline glyph link. Their compound
(x1270 y1678 w18 h26, weight 143) evaluates as `TUPLET_THREE` at grade
0.823177188, above the symbol minimum. The all-four compound evaluates at
0.850914929. Thus the tiny fragments are not required to recognize the
printed numeral.

With the actual m23 chords 6099, 6100, and 6101, `TupletInter.createValid`
returns an accepted candidate. Direct `TupletsBuilder.lookupLinks()` returns
zero links, and `getEmbracedChords()` returns null. Re-running
`SymbolsBuilder.buildSymbols()` on the loaded artifact changes the system
 tuplet count from 1 to 2 and creates:

`TupletInter#6645`, compound glyph `#6644`, bounds x1270 y1678 w18 h26.

Calling `linkStackTuplets()` then returns the count to 1: the newly created
m23 candidate is removed. This establishes the first responsible seam as
`TupletsBuilder` linking, after `InterFactory` dispatch, rather than failure
to classify or dispatch the fragmented numeral.

The linker rejection is consistent with the existing wrong duration: the
three target chords currently have sans-tuplet durations 1/8, 3/16, and 1/8.
`TupletCollector.include()` establishes a 1/8 base and a 3/8 expected total;
a 3/16 middle event makes the collected sequence too long, so no
`ChordTupletRelation` is returned. The 3/16 value is independently explained
by the false dot relation above.

Relevant upstream methods are:

- `SymbolsBuilder.evaluateGlyph()` → `InterFactory.create()`;
- `InterFactory.create()` `TUPLET_THREE` case, which calls
  `TupletInter.createValid()`;
- `TupletsBuilder.lookupLinks()` and `getEmbracedChords()`;
- `TupletCollector.include()`, where `total > expectedTotal` sets
  `TOO_LONG`.

## Disposition and bounded next proposal

The “fragmented numeral is not dispatched” claim is killed by the rebuild
probe. A parser repair remains unjustified. A future engine cycle may test the
separate, narrower false-dot/tuplet ordering hypothesis: remove or reject the
specific dot relation only when its surviving ink is disproven and a verified
three-chord tuplet sign is present, then let normal `TupletCollector` linking
run. That requires its own page/ink evidence and negative controls; this
packet does not implement it. No floors, allowances, pitch inference, or
currently passing piece were changed.
