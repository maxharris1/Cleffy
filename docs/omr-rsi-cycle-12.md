# OMR RSI cycle 12

**Accepted: 7/16. Chopin now passes; all six earlier passes remain green.**
Luna implements the single `chopin-prelude-4` hypothesis; Astra reviews,
integrates, and runs the full corpus. No currently passing piece may go red.
The accepted baseline entering this cycle is svc-16, 6/16.

## Hypothesis → layer → diff

The m12 numeral is correctly recognized as a triplet, but Audiveris rejects it
when its beam-sibling rule includes a fourth chord outside the printed bracket.
`TupletsBuilder` now uses an unambiguous measured bracket span: aligned horizontal
strokes, outward hooks, and exactly the expected number of staff-local chord
anchors. That span limits shared-beam siblings. Missing, mismatched, and
ambiguous brackets retain the original path. No bar-fill inference, parser,
scorer, pin, floor, or allowance changes are included.

The glyph/classifier and linking trace are recorded in
[the Chopin packet](omr-rsi-chopin-symbol-localization.md). A preliminary theory
that classifier ranking or glyph-cluster size hid the numeral was rejected:
the real compound ranks `TUPLET_THREE` first at 0.960694139, and factory creation
succeeds. It fails later when four beam siblings exceed the triplet count.

Review tightened initial loose ink checks to require outer hooks, compared
stroke ordinates in sheet coordinates, and preserved old behavior when another
staff makes the candidate span ambiguous. The focused saved-artifact probe
accepts the bracketed chords 11051–11053, excluding 11050; the no-bracket and
nearby unrelated-glyph controls reject. Fixture IDs are bound to the exact
svc-15 baseline artifact and are not reused against fresh OMR files.

The target-only end-to-end prototype recovers m12 D5–C5–B4 as eighth-note
triplets (divisions 12, duration 4, 3:2 modification), corrects its single
wrong-length bar, and passes. This is supporting evidence, not a suite verdict.

## Matching engine and validation

The final candidate adds only the vendored `TupletsBuilder.java` and reproducible
upstream patch `0003-tuplet-bracket-span.patch`, plus Docker compilation and
revision svc-18. Revision 17 remains reserved for cycle 11's rejected option
experiment. All live options are the accepted original options, including
`implicitTuplets=true`. `DEPLOYED_ENGINE_GENERATION` remains 15.

Image `cleffy-omr-rsi:svc-18` SHA256:
`270b17ce1aad99c173b52f9527c0672eb533da6970ddc69257b7abae4f729544`.
Final jar SHA256:
`53ea6baa072445332b60bf0ef5aeb68104c26b9fab7a951389c9d983afbac86b`.
Reviewed `TupletsBuilder.java` SHA256:
`aaf655a23041dde7d6b5078dcd8238f2b68148d1fa16426ace11683cb5fbc64b`.

Engine image and service build pass; all **509/509** unit tests pass. Full fresh
command is
`CLEFFY_OMR_CONTAINER=cleffy-rsi-omr-18 npm run eval -- bench --force-audiveris`.
Fresh svc-18 cache entries preserve the accepted svc-16 artifacts and original
option fingerprint. The 16 pinned input/reference hashes remain unchanged.

## Suite delta → verdict

The full fresh benchmark completed all 16 pieces and returned 1 for the nine
remaining failures. Every input/reference hash matches cycle 10. Chopin changes
only in reference bar 12: extent 2160 → 1920 ticks, exact 10 → 12 and on-grid
9 → 12 in that bar. Across the piece, exact 588/600 → 590/600 and on-grid
584/600 → 587/600. Pitch stays 99%, with two missing and one extra note. All
26 bars now have the printed length and the overfull warning clears; every
applicable gate check passes.

Fourteen other piece result rows are unchanged, including all six protected
passes. Für Elise returns from 853/905 to 851/905 on-grid: its D5/F5 chord in
bar 73 is undotted again (ScoreData 648 → 432 ticks), plus the already documented
m81 articulation variation. Its complete ScoreData is identical to the fresh
original svc-15 baseline. Cycle 10's independent original-engine control had
reproduced the other state. This is the known original-engine dot/articulation
variation, not a new tuplet-bracket gain or a newly passing piece.

Suite totals: **7/16**, 5,996 reference notes, 119 missing, 161 extra, pitch
97.46497665110073%, exact 95.98065376917945%, on-grid 95.23015343562375%.
Typecheck and the engine-version check also pass. **Verdict: keep.** The goal
remains 16/16; nine pieces are still red.

## Parallel localization correction

The [Schumann packet](omr-rsi-schumann5-localization.md) now binds every clef
probe to the actual svc-16 cache. Astra caught a stale loose `/tmp` fixture before
its classifier diagnosis was committed. Glyph 266 was unrelated; the actual
inline clef is preserved as glyphs 6606/6607 and its compound scores weakly in
the classifier. The wrong fixture's sharp/key attribution is discarded. The
full benchmark always used pinned cache paths and is unaffected. A separate
PDF-font-identity hypothesis is being tested; no source or pass from it is
included in this cycle.
