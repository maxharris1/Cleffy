# Invention 8 m34 printed rests localization

This is a separate bounded comparison for `bach-invention-08`, local measure stack 13 (the score's m34). The page prints a quarter rest at the first lower-staff beat on both staves, followed by the recognized second rests. The saved OMR has only the second rests, so stack 13 reports expected `3/4` and actual `1/2`; this is an actual-symbol omission rather than a bar-duration repair opportunity.

The pinned cycle-12 artifact is:

`services/omr-service/eval/cache/artifacts/5323449d08aa5031e974e275f182bebf8f533ecf62e5f9b0c9c36364f4b66469-audiveris-5.11.0+svc-18-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/omr-eval-input.omr`

In `sheet#2/sheet#2.xml`, stack 13 spans x=2112..2426 with `expected="3/4" duration="1/2"`. Measure 13 has rest-chords 5333 and 5334, which reference only glyphs 5243 and 5244. The free-glyph list retains all four candidate IDs, but glyphs 5241 and 5242 have no `<rest>` inter or rest chord:

```text
5241: x=2228 y=1750 w=22 h=58, staff 7 (first upper-staff rest)
5242: x=2228 y=1958 w=22 h=58, staff 8 (first lower-staff rest)
5243: x=2318 y=1750 w=22 h=59, staff 7 (recognized second rest)
5244: x=2318 y=1958 w=22 h=59, staff 8 (recognized second rest)
```

The read-only [`Invention08RestProbe.java`](/tmp/omr-rsi-air-rest-probe/Invention08RestProbe.java) compared the classifier and existing factory path using stock svc-15 jars. The first rest glyph is a clear classifier candidate but the second is below the existing symbol gate:

```text
5241 QUARTER_REST 0.288493371 (rank 1), FLAG_1_DOWN 0.093677943
5242 QUARTER_REST 0.103955679 (rank 1), FLAG_1_DOWN 0.065484170
5243 QUARTER_REST 0.962591326 (rank 1), existing rest inter
5244 QUARTER_REST 0.924716348 (rank 1), existing rest inter
```

`RestInter.createValid` accepts 5241 at its classifier grade and also accepts 5242 when called directly at its classifier grade. It rejects 5243 and 5244 in this probe because their already saved RestInter instances are present; that is expected and demonstrates that the neighbor glyphs were successfully dispatched in the original run. Re-running `SymbolsBuilder.buildSymbols` on the loaded sheet adds glyph 5241 at grade `0.230794697` and leaves no new 5242 rest; the existing 5243/5244 rests remain. Thus 5242 is concretely explained by the existing `Grades.symbolMinGrade=0.15` gate, while 5241 survives classifier and factory but is absent from the saved SIG, requiring a fresh run trace to distinguish initial symbol dispatch from later removal.

The exact seam to instrument is `app/src/main/java/org/audiveris/omr/sheet/symbol/SymbolsBuilder.java` (`getSymbolsGlyphs` → `processClusters` → `evaluateGlyph`) and then `InterFactory.create` in `app/src/main/java/org/audiveris/omr/sheet/symbol/InterFactory.java`. A permitted future fix would preserve or dispatch only the actual glyph 5241 through that existing QUARTER_REST path, with a regression test for 5242 remaining below the current gate. It must not lower the global gate, insert either rest from timing, or alter tuplets/parser duration. A production run with `evaluateGlyph` and SIG lifecycle logging is required before choosing the owning seam.

## Fresh svc-18 lifecycle trace

Using the same instrumented accepted svc-18 jar as the Air run (SHA-256 `2c06e46b4b5ecaa8fd424675d24e6aba6becbacca1a5a2b26369b5dbbc3bd633`), I ran the pinned two-page PDF (`5323449d08aa5031e974e275f182bebf8f533ecf62e5f9b0c9c36364f4b66469`) with the original lyrics=false, implicitTuplets=true, fingerings=true options. Fresh output hashes are OMR `ef77f3e9af717f76166b2da7c9f174907d00da665b81d387231e5aca3b5abc49` and MXL `ab16624f5c21db1501e7cd12914df96a6557279cbf30825cc8daad4c087fd465`.

Fresh glyph IDs differ from the saved artifact. At the printed first-rest boxes, glyph 5261 (staff 7) is selected as a singleton, evaluates to `QUARTER_REST=0.288493371`, and is inserted as a RestInter. It is removed during LINKS by the same `LinksStep.doSystem` → `SigReducer.reduceLinks` → `SigReducer.contextualizeAndPurge` → `SIGraph.deleteWeakInters` path. Its effective grade is `0.8 * 0.288493371 = 0.230794697`, below `Grades.minContextualGrade=0.5`. The staff 8 candidate glyph 5262 is selected but yields zero evaluations because its `QUARTER_REST=0.103955679` is below the existing `Grades.symbolMinGrade=0.15`; it is never inserted. The recognized neighbor rests 5243/5244 in the saved artifact provide the positive dispatch control.

This fresh trace localizes both outcomes and rejects a classifier/factory repair. Recovering 5241/5261 would require exempting or promoting a low-grade rest at weak-inter cleanup, which would loosen a global acceptance policy. That violates the bounded hypothesis controls, so no implementation is made. No production source, parser, scorer, gate, option, or pinned version was changed. No pass claim is made; the seven protected pieces remain the regression invariant.
