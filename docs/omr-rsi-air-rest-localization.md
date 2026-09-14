# Air m14 printed quarter rest localization

This packet covers the single hypothesis `bach-air-anh131`: the lower-staff quarter rest printed between the A2 half note and B2 quarter note in m14 is present in the page but is omitted before MusicXML export. It does not insert a rest from timing or infer a tuplet.

## Pinned evidence

The pinned input is the svc-15 artifact at:

`services/omr-service/eval/cache/artifacts/2421e97393ee1b476897314326409e0ea3e25e3ceb6d4bf215342e709be35af5-audiveris-5.11.0+svc-15-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/omr-eval-input.omr`

Its metadata records PDF hash `2421e97393ee1b476897314326409e0ea3e25e3ceb6d4bf215342e709be35af5`, Audiveris 5.11.0 svc-15, and `implicitTuplets=true`, with lyrics disabled and fingerings enabled. The matching source is [`air.ly`](/tmp/omr-rsi-baseline/air.ly) in the frozen baseline area; its lower voice at source line 15 contains `r1 r4 ...`, and contains no tuplets.

The pinned page image [`air-page.png`](/tmp/omr-rsi-baseline/air-page.png) shows the second-system lower staff of m14 as A2 half note, quarter rest, then B2 quarter note. In the saved OMR XML (`sheet#1/sheet#1.xml`), stack/measure 14 has lower voice 5 with only chord IDs `2708` and `2709`. Chord 2708 is the A2 half and chord 2709 is the B2 quarter; there is no lower-staff rest inter or rest chord. The same measure has implicit tuplet `3014` on upper chords `2680`–`2683`, which is an existing engine interpretation and is not used as evidence to add timing.

## Surviving glyph and trace

The expected rest survives as free SYMBOL glyph `2877`:

```text
box x=1719 y=1443 w=21 h=59, weight=470, centroid=(1729,1472)
```

This is exactly between lower chord 2708 (`x=1584..1610`) and chord 2709 (`x=1773..1799`) on staff 4. Its dimensions and run-table profile match accepted quarter-rest glyph 2788 (`x=277 y=1443 w=21 h=59`), while 2877 has no `<rest>` inter in the saved SIG.

The read-only harness [`AirRestProbe.java`](/tmp/omr-rsi-air-rest-probe/AirRestProbe.java) loads the saved OMR with the stock svc-15 jars, suppresses engine logging, and evaluates the actual glyph:

```text
CHECKED: QUARTER_REST grade=0.563631396 rank 1; next FLAG_1_DOWN=0.072313183
NONE:    QUARTER_REST grade=0.563631396 rank 1; next FLAG_1_DOWN=0.072313183
```

There is no classifier failure. `RestInter.createValid(glyph2877, QUARTER_REST, 0.563631396, System#2, heads)` returns `ACCEPTED` and selects staff 4. The m14 head bounds supplied to the factory are the two lower chords above plus the five upper chords. Re-running `SymbolsBuilder.buildSymbols` on the loaded sheet creates a RestInter for glyph 2877 (`restsBefore=3`, `restsAfter=7`, `glyph2877Rest=PRESENT`); rebuilding the all-SYMBOL proximity graph places glyph 2877 in a singleton component (`size=1`).

These observations reject loss in page ink, classifier ranking, connected-component truncation, and `RestInter.createValid` geometry. They also show why a parser-side rest insertion would be unsupported: the glyph is already available to the engine at the printed location.

## First seam and bounded proposal

The exact production seam to instrument is `app/src/main/java/org/audiveris/omr/sheet/symbol/SymbolsBuilder.java`, at `getSymbolsGlyphs` → `processClusters` → private `evaluateGlyph`, followed by `InterFactory.create` in `app/src/main/java/org/audiveris/omr/sheet/symbol/InterFactory.java`. The saved artifact proves that the post-step SIG lacks the candidate, while the isolated stock rebuild proves the candidate path accepts it. A production diagnostic should log glyph 2877 at each of those boundaries during a fresh run; only a missing `evaluateGlyph`/`factory.create` event or a later SIG removal would distinguish the remaining two possibilities.

If that trace confirms omission in the original symbol pass, the minimal engine change is a narrowly tested preservation/dispatch fix in `SymbolsBuilder` or its caller, retaining this actual `QUARTER_REST` candidate and passing its classifier grade through the existing `InterFactory` path. It must not add a rest from bar duration, lower a global grade, alter implicit-tuplet behavior, or modify parser timing. If the trace instead shows creation followed by removal, the owning removal seam must be reviewed with the same glyph and m14 geometry before any change.

## Fresh svc-18 lifecycle trace

To locate the rejection rather than infer it from a reloaded artifact, I copied the accepted svc-18 `audiveris.jar` and temporarily instrumented `SymbolsBuilder` and `AbstractInter.remove`. Instrumented jar SHA-256: `2c06e46b4b5ecaa8fd424675d24e6aba6becbacca1a5a2b26369b5dbbc3bd633`. The run used the pinned PDF (`2421e97393ee1b476897314326409e0ea3e25e3ceb6d4bf215342e709be35af5`) and the original lyrics=false, implicitTuplets=true, fingerings=true options. Fresh output hashes are OMR `25f9a4f4839dd67717b4e6e26db39bc667d098b31bcfc9a3582c0ae2b757f37d` and MXL `681ec947645820c9733ffdeaf3a274496408e0f889aa4c916fc5832540ac05da`.

Glyph IDs are run-specific; the fresh target at the same printed box is glyph 2831. The lifecycle is decisive:

```text
SYMBOLS: selected id=2831 weight=470 normalized=1.065759637
SYMBOLS: singleton component id=2831
SYMBOLS: evaluate id=2831 -> QUARTER_REST grade=0.563631396
SYMBOLS: InterFactory -> RestInter (inserted in SIG)
LINKS: SigReducer.deleteWeakInters -> RestInter.remove(extensive=true)
```

The removal stack is `LinksStep.doSystem` → `SigReducer.reduceLinks` → `SigReducer.contextualizeAndPurge` → `SIGraph.deleteWeakInters`. The rest's effective intrinsic grade is `0.8 * 0.563631396 = 0.450905117`, below the existing `Grades.minContextualGrade=0.5`; the removal is therefore an existing weak-inter policy decision. The trace does not justify lowering that global floor or inventing a rest. The responsible seam is clear, but this bounded hypothesis is killed for implementation under the no-floor-loosening and regression controls.

No production source, scorer, gate, option, or pinned version was changed for this packet. No benchmark or pass claim is made. The seven currently protected pieces remain the regression invariant for any future experiment.
