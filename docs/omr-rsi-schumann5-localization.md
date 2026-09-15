# Schumann Op. 68 No. 5 localization

Status: the saved cycle-10 result has 39 missing and 39 extra notes, with
34/34 lower-staff pitch substitutions in the opening printed bars and a
separate five-note split around the eighth printed bar. The earlier pickup
cascade attribution remains rejected. This packet now uses only the exact
cycle-10 artifact; an earlier classifier probe used a stale fixture and its
claims are discarded.

## Provenance

The exact artifact is the svc-16 OMR at
`services/omr-service/eval/cache/artifacts/8f56f70d597a838d23590ed5bbc9ecf10b21e77f07620019cdc2d06b931f7c17-audiveris-5.11.0+svc-16-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/omr-eval-input.omr`,
copied to `/tmp/omr-rsi-schumann-clef-probe/exact/input.omr`. Its sheet XML
has `last-persistent-id="6887"`. The stale fixture previously used in this
packet had last ID 4563 and must not be used for attribution.

The pinned PDF is corpus SHA
`8f56f70d597a838d23590ed5bbc9ecf10b21e77f07620019cdc2d06b931f7c17`. Its
native 300-dpi rendering is `/tmp/omr-rsi-schumann-clef-probe/source-300.png`;
the exact OMR includes native `2550x3299` BINARY data at
`/tmp/omr-rsi-schumann-clef-probe/exact/BINARY.png`.

## Printed and scored evidence

The matching LilyPond source declares `\partial 2.` and an explicit inline
`\clef treble` on the lower staff before its first visible notes. The eighth
printed bar contains `d c \bar "||" b c`, a visual separator inside one 4/4
measure. The frozen official result is 25 reference bars versus 26 OMR bars,
279 notes on each side, 39 missing and 39 extra, and 82.7957% exact/on-grid.
The opening lower-staff substitutions are independent bar-local pitch errors;
the five-note eighth-bar discrepancy is a separate measure split. The pickup
skip omission remains a separate timing question and does not explain the
opening pitch substitutions.

## Exact clef glyph audit

In the exact XML, the initial header contains G clef inter 194 from glyph 193
(`x=313 y=700 w=56 h=148`) and F clef inter 206 from glyph 202
(`x=314 y=911 w=58 h=75`). The page's inline lower-staff G clef is visible in
the BINARY crop and occupies approximately `x=501..544, y=898..1041`. The
nearby upper ink at `x=527..567, y=842..878` is the printed dynamic `p`, not
part of the clef.

The saved glyph index retains that printed clef as two symbol fragments:

* glyph 6606: `x=501 y=898 w=43 h=143`, weight 1551;
* glyph 6607: `x=504 y=1004 w=13 h=19`, weight 162.

The two fragments are linked in the symbol graph. A read-only probe using
exactly those two IDs, ROOT logger at ERROR, and the exact cycle-10 OMR
produced a compound box `x=501..544 y=898..1041`, weight `1713`. It ranked
`G_CLEF_8VA` first at only `0.039511984` under both classifier conditions;
plain `G_CLEF` was not in the top 20. The nearby glyph 6608 is the dynamic
`p`, ranking `DYNAMICS_P 0.938319751`, and is intentionally excluded.

This proves the current hypothesis is bounded at the actual glyph boundary:
the complete printed clef ink is present as two fragments, but the classifier
does not recognize the compound strongly as a plain G clef. There is no
evidence that a top or bottom crop must be restored. The source probe and output are
kept under `/tmp/omr-rsi-schumann-clef-probe/`, with the exact artifact path in
the command fixture.

Glyph 266 in the exact artifact is unrelated: it is a vertical seed at
`x=1411 y=913 w=3 h=133`, later serialized as stem 3795. The prior claim that
glyph 266 was a 24x65 SHARP in the inline clef was caused by the stale fixture
and is removed from this localization.

## Layer attribution and kill decision

The exact compound fails the actual shape-classifier probe before a strong
plain-G interpretation can be created. The header builder's clef-before-key
ordering does not prove that it processed this inline candidate; the stale
fixture's key-signature attribution is discarded. A generic recovery needs an
independent glyph-shape or font-identity signal and must preserve existing clefs
and other printed symbols. Position, dimensions, or downstream pitch differences
alone do not justify forcing a G-clef label.

The missing-clef-fragment hypothesis is killed for this cycle: both printed
fragments are present, but their complete compound does not classify
strongly as G clef, and no safe generic recovery rule is evidenced. No source,
parser, gate, floor, allowance, or pin change is justified. The opening pitch
error remains an upstream classifier/clef-selection issue requiring a separate
positive and negative control.

The eighth-bar split and pickup omission remain separate upstream seam
investigations. Their exact glyph/bar IDs must be rebound from the cycle-10
artifact before any implementation claim; the IDs from the stale fixture are
intentionally omitted.
