# OMR RSI cycle 17 — PDF change-clef identity

**Candidate pending official host bench.** Implemented on `mh/omr-rsi-notes-fixes-c12b`.
Engine `audiveris-5.11.0+svc-23`. No Audiveris run by this implementer.

## Official starting point and cycle-16 attribution

The supplied official result is HEAD `b0acee3`, container
`cleffy-rsi-omr-22`: **8/16 pass**, 5,996 reference notes, 117 missing,
160 extra; pitch 97.498332221481%, exact 96.11407605070046%, on-grid
95.43028685790527%. The local host report agrees, generated
`2026-09-14T19:10:17.626Z`. Its `bench.json` SHA256 is
`c8e6e770ccea21448dbadcd615001ea8f5e8b16f52e0f8c57420df99b105b9bf`.

Against accepted svc-19 (`f796059`), all PDF/reference hashes, options and
limits match. Only Anh. 116's result row changes: exact **300 → 305 / 310**,
on-grid **298 → 304 / 310**, and both bar-length failures disappear. All
other piece metrics and failure lists match svc-19. BWV 939's 16 extras
are the restored baseline after the cycle-14 rollback, not a new regression
from the ledger-dot rule. Preserve cycle 16 and the provenance guard.

The saved svc-22 Anh. 116 log records `DotFactory` rejecting glyph 6268 as
connected ledger ink beside head 2477. Its m23 XML removes the middle
eighth's dot and adds the printed triplet: the first three upper notes are
each 2 divisions with divisions-per-quarter 6, instead of 6/9/6 with
divisions-per-quarter 12. The existing printed slur remains. At m24 the
rejected svc-20 accidental-parenthesis slur is absent; its events retain
svc-19 rational durations and the pre-existing false tuplet. That independent
defect is not silently credited as repaired merely because the piece passes.

Metric equality is not XML equality: the read-only corpus comparison also
finds Czerny m6 articulation reassignment with identical BINARY and unchanged
official metrics/pass. No recognition gain is credited to that incidental
change. Für Elise's score XML is byte-identical to svc-19; its current
four-bar failure is part of this baseline, not a cycle-16 deterioration.

The protected set now has **eight** pieces: Czerny 821/1, BWV 999,
Anh. 114, Anh. 115, **Anh. 116**, Arabesque, Schumann 68/1, and Chopin 28/4.
No currently passing piece may go red. Floors, allowances, pins, options,
parser and scorer stay unchanged.

Cycle 14 remains rejected for the accidental-parenthesis slur. Cycle 15
remains closed without acceptance; its provenance caveat does not authorize
reintroducing the quarter-rest template. Invention 8's remaining rest and
Air's m14 rest still lack an accepted recovery. This cycle chooses a
different, independently evidenced producer defect; it does not reopen those
patches or select a target merely for its reference-note count.

## One hypothesis

**An explicitly named, visibly rendered PDF change-clef glyph can recover a
missing inline G/F clef before note recognition, even when its raster
fragments receive a weak shape-classifier score.** Use the embedded font's
glyph identity, transformed outline and corresponding source ink together.
Do not infer a clef from wrong pitches, bar length or reference MIDI.

Primary target: `schumann-op68-05`, the lower-staff inline G clef before
the opening notes. The earlier [Schumann localization](omr-rsi-schumann5-localization.md)
separates 34 opening pitch substitutions from the independent five-note
eighth-bar split. Its pickup-cascade and missing-fragment explanations were
rejected. Correcting the clef is expected to remove that opening substitution
cluster; it does **not** promise a piece pass or authorize repairing the split.

The [PDF-clef packet](omr-rsi-pdf-clef-localization.md) provides historical
font/outline evidence on Schumann, WTC, Für Elise and Invention 1. Its old
temporary source and candidate artifacts are absent here. Its target-only
numbers are not official results for svc-22, not reproduced in this cycle,
and not acceptance evidence. Grok must reconstruct and review the candidate.

## Rebound evidence from the current artifacts

Schumann PDF SHA256:
`8f56f70d597a838d23590ed5bbc9ecf10b21e77f07620019cdc2d06b931f7c17`.
The checked file is `services/omr-service/eval/cache/downloads/schumann-op68-05.pdf`.
Direct read-only decoding of its PDF objects establishes:

- Encoding object 34 maps code 5 to `/clefs.G_change`; ordinary F and G
  clefs are codes 3 and 4. These codes are fixture facts, never production constants.
- Font object 13 is embedded `SMPQBM+Emmentaler-20`, with encoding 34.
- Page content object 5 draws code 5 with `/R13 19.9253 Tf` and text matrix
  `1 0 0 1 120.334 556.529 Tm`. This is an actual text-paint operation.
- Page object 4 has MediaBox `[0 0 612 792]` and rotation 0.

The current artifact directory is
`services/omr-service/eval/cache/artifacts/8f56f70d597a838d23590ed5bbc9ecf10b21e77f07620019cdc2d06b931f7c17-audiveris-5.11.0+svc-22-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/`.
Its metadata declares and observes `audiveris-5.11.0+svc-22`.

| Current evidence | SHA256 / location |
| --- | --- |
| `omr-eval-input.omr` | `3cf7ae4891111b2073a1a652387909ca4209bbed96b877a381591fbb75ea98e0` |
| `sheet#1/sheet#1.xml` | `9f060ac63a5083d20166bf47ea5f65aaf7ff582364b876f599413144dea35b69` |
| `sheet#1/BINARY.png` | `668631f54babe7c9bda6489b1a72e9b3855214d5d15a9b08ec09fe6dffb5e6fa` |
| XML inside `omr-eval-input.mxl` | `b0ebb26845fb062cbaba1b7e3d064bc949c3558390aa709a22bb933371d68ab8` |
| Clef fragments | SYMBOL glyphs **6637** `(501,898,43,143)` and **6638** `(504,1004,13,19)` |
| Excluded dynamic `p` | SYMBOL glyph **6639** `(527,842,40,37)` |

The BINARY and score XML hashes are identical across svc-16, svc-19 and
svc-22. The three corresponding run tables are also identical; only glyph
IDs changed. The historical classifier evidence therefore binds to the
same masks, although no classifier was executed here. Do not reuse old IDs
6606/6607/6608 or the discarded stale glyph 266 against svc-22.

System 1 staff 2 still has header F clef 206 and header stop x438. The inline
clef at x501 lies beyond it, without a ClefInter. MusicXML measure 0 declares
an F clef on line 4 for staff 2 and emits its opening notes without the printed G change.
The error already exists before the Cleffy parser.

The old PDF outline estimate is `(501.4,898.3,42.6,126.6)` at 300 DPI.
It is an anchor for rechecking the actual outline, not permission to copy
the entire 143-pixel-high fragment box: the mask can include neighboring
ink. Production must use the outline and corroborating pixels.

## Bounded implementation contract for Grok

1. Add one engine helper, proposed
   `engine-patches/src/org/audiveris/omr/sheet/clef/PdfClefHints.java`,
   using the **bundled** PDFBox API and the book's actual source/page.
   Resolve character codes through the embedded font encoding and outline.
   Initially admit only the explicitly named `clefs.G_change` and
   `clefs.F_change` identities in a supported embedded music font. No
   piece-name, code-number, font-subset-prefix, PDF-hash or coordinate rules.
   Unknown identities and ordinary header G/F glyphs remain on the existing path.

2. Validate the PDF-to-sheet transform and visible ink before making an
   interpretation. Account for text/font matrices, page box, raster scale
   and any sheet transform. Unsupported rotation, clipping, text rendering
   modes or transforms must fall through unchanged; a supported upright
   subset is sufficient for the first candidate. Invisible text, missing
   outlines, empty masks and bounding-box overlap alone cannot qualify.
   Extract the glyph from actual staff-free pixels clipped to the verified
   outline; demonstrate agreement rather than treating any dark pixel as proof.

3. Integrate in the existing vendored `sheet/clef/ClefBuilder.java`, at
   `Column.selectClefs()` **after all existing header choices**, before
   HEADS. `findClefs()` and `registerClefs()` own header competition and
   update `staff.setClefStop`; they are not safe inline insertion methods.
   Preserve header bounds, key/time interpretation and accepted octave-clef
   selection. Require one unambiguous staff and clef-line anchor. Register
   an ordinary glyph-backed ClefInter at its printed x position, so normal
   downstream head interpretation and MusicXML export consume it.

4. Reject a hint covered by an existing same-staff clef, including all G/F
   octave variants; never duplicate, move, replace or downgrade that clef.
   Process each source/page hint once, with per-book/page cache scope and
   no cross-book state. Instrument accepted/rejected hint identity, actual
   geometry, staff and ink evidence for host attribution. Any recognition
   confidence must come from the explicit PDF/ink evidence, not a forced
   grade for the old weak raster compound. Existing classifier and contextual
   thresholds remain unchanged.

5. Keep patch 0007 and all accepted recognition changes. Add only the helper,
   narrow hook, reproducible upstream patch, focused controls and necessary
   build/provenance wiring. Use a fresh engine revision (svc-23 if still free),
   leaving deployed generation 15 unchanged. Do not combine rest, slur,
   measure-split, pickup, tuplet or parser repairs with this hypothesis.

## Review controls and host decision

Grok's source/fixture checks must bind to the exact artifacts above and compile
against the pinned release libraries. Test the actual named Schumann glyph,
translated geometry, wrong-staff placement, blank/mismatched ink, its dynamic
`p`, arbitrary font encodings, already recognized inline/header clefs, and
existing octave clefs. Prove duplicate processing is inert and unsupported
inputs retain the old path. In particular, protect BWV 999's octave headers,
Czerny's ottava behavior, Chopin's bracket and both Anh. 116 m23 and m24.
These checks do not establish a piece or suite pass.

The host alone builds the matching image, confirms observed provenance,
exports fresh artifacts for all 16 pinned pieces with the unchanged options,
and runs the official scorer. Compare with this svc-22 report. Inspect the
first changed XML event on **every** changed piece: a supported clef at the
printed location must precede and explain the resulting pitch changes.
WTC, Für Elise and Invention 1 are same-rule observation sites, not promised
gains; rebind their PDF/OMR geometry before crediting any change. Invention 1
still fails exact at **435/458 = 94.97816593886463%**, despite rounded 95.0%.

Kill the candidate if the primary Schumann G change is not recovered at its
producer, if its opening pitch correction lacks matching page/clef evidence,
if a false or duplicate clef appears, if unrelated ink is consumed, or if any
protected pass turns red. Reject unexplained pitch/timing gains, weakened
grades/floors/allowances, warning suppression and reference-based repair.
Missing source or ambiguous evidence must skip recovery, not trigger a guess.

An attributable partial improvement may be kept under these criteria even
while Schumann's independent bar split stays red; record the remaining
failures honestly. **16/16 remains the goal.** This cycle changes only this
hypothesis document. Astra has not edited engine/parser code, committed an
implementation, executed Audiveris/Docker, or run a benchmark.
