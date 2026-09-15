# Chopin Prelude 4 localization

Status: localized to the Audiveris page-to-MusicXML boundary. There is no justified Cleffy parser or scorer change for this piece.

## Reproduction evidence

The pinned Mutopia PDF (`pdfSha` `82c1e275802774095293f83f5ed38720fd5527afcf8e2b1239c70de1ead4b239`) visibly prints a bracketed `3` over the final three right-hand notes of measure 12. The same engraving has the analogous triplet in measure 18. The fresh svc-15 artifact is recorded in `/tmp/omr-rsi-baseline/chopin-prelude-4.json` and its `meta.json`; options include `implicitTuplets=true`.

The generated `omr-eval-input.xml` has no `<tuplet>` or `<time-modification>` element anywhere. In measure 12, lines 4155–4301 contain nine sequential right-hand notes, each `<duration>2</duration>` and `<type>eighth</type>`. Lines 4302–4303 then back up by 18 divisions before the left hand. With divisions 4 and 2/2 meter, the printed bar is 16 divisions, so the MusicXML content is exactly one eighth too long. The fresh score has measure 12 at `dTicks: 2160` (expected 1920) and `measure_overfull`; all other 25 bars have the expected length. The score's m12 matching notes have no pitch loss, which isolates the failure to printed timing.

The intermediate `/tmp/chopin-sheet.xml` is equally conclusive: measure `id="12"` is `abnormal="true"` (line 9566), its voice 1 lists exactly nine head chords (lines 9572–9610), and the voice is marked `excess="1/8"` (line 9574). A search of the extracted sheet XML returns no `TupletInter`, `TUPLET_THREE`, `triplet`, or tuplet relation. The Audiveris log reports `Measure{#13} Voice{#1 excess:1/8} too long`; its internal number is one ahead of the MusicXML printed measure number.

## Layer attribution

`services/omr-service/src/musicxml.ts` correctly consumes the source `<duration>` at lines 1700–1703 and intentionally preserves overfull content at lines 2171–2178 so note onsets remain stable. It cannot recover a missing tuplet marker without inventing timing. `rhythmRepair.ts` has the same limitation: converting the last three eighths to a 3:2 group would be unsupported because neither the `.omr` nor `.mxl` contains a surviving tuplet sign or relation.

The required functional fix is therefore upstream Audiveris symbol recognition, before MusicXML export. The first source file to inspect/change is `app/src/main/java/org/audiveris/omr/sheet/symbol/SymbolsFilter.java` / `SymbolsBuilder.java`: the visible numeral and bracket must survive symbol glyph extraction and classifier evaluation as `TUPLET_THREE`. `InterFactory.java` already maps that classifier shape to `TupletInter`; `TupletsBuilder.java` only links already-created `TupletInter` instances, so it cannot fix this artifact. `PartwiseBuilder.java` is only an export follow-up if a tuplet inter appears in `.omr` but is absent from MusicXML; that condition is not present here.

## Decisive next experiment

Run the same pinned PDF and options once at 400 dpi, then inspect the resulting `.omr`, `.mxl`, and log:

1. If m12 gains a `TUPLET_THREE`/`TupletInter` and the `.mxl` gains `<time-modification>` for the final three notes, the defect is resolution-sensitive symbol extraction/classification; use the smallest upstream symbol-pipeline fix supported by that artifact.
2. If m12 gains a tuplet inter in `.omr` but MusicXML still lacks time modification, inspect `PartwiseBuilder.java`.
3. If no inter appears at 400 dpi, the missing artifact needed to choose between `SymbolsFilter.java` and `SymbolsBuilder.java` is Audiveris symbol-stage diagnostics (saved symbols image or classifier trace) for m12. Do not add parser-side tuplet inference or alter gates/allowances.

No implementation was proposed from the original evidence. Any candidate must preserve all five currently passing pieces and be verified across all 16 pieces by the root agent.
