# Chopin Prelude 4 m12 tuplet symbol localization

This packet tests one hypothesis only: the printed `3` above the m12 upper
staff is split into glyphs which the Audiveris classifier can compose as
`TUPLET_THREE`, but the symbol is lost after classification. It uses the
pinned svc-15 300 dpi artifact for PDF SHA-256
`82c1e275802774095293f83f5ed38720fd5527afcf8e2b1239c70de1ead4b239`:

`services/omr-service/eval/cache/artifacts/82c1e275802774095293f83f5ed38720fd5527afcf8e2b1239c70de1ead4b239-audiveris-5.11.0+svc-15-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/`

The page XML identifies system 4, stack 12 (`expected="1"`,
`duration="9/8"`, `excess="1/8"`) and upper staff 7. The target glyphs are
free `SYMBOL` glyphs at the printed numeral location:

| glyph | box (left, top, width, height) | weight | singleton top result |
| ---: | --- | ---: | --- |
| 11603 | (760, 1629, 8, 7) | 21 | `DOT_set` 0.610882003 |
| 11605 | (764, 1613, 6, 6) | 15 | `NOISE` 2.000000000 |
| 11606 | (766, 1612, 11, 23) | 74 | `DYNAMICS_F` 0.194248305 |

The two bracket fragments are 11591 `(717,1623,37,17)` and 11610
`(790,1623,32,17)`. With the production symbol graph distance of 0.8
interline (16 pixels here), each target is in the same connected component as
the other two targets and both bracket fragments. The component has five
members, so the `maxPartCount=7` cap does not discard it. This was true for
both `System#3` and `System#4`, the systems returned by
`getSystemsOf(glyph)` at the boundary.

## Classifier and factory trace

The read-only harness is `/tmp/omr-rsi-glyph-probe/GlyphProbe.java`, with raw
output at `/tmp/omr-rsi-glyph-probe/out/chopin-m12-glyph-trace.txt`. It loads
the saved OMR through `Book.loadBook`, evaluates each singleton and all seven
target-only subsets using the stock svc-15 `ShapeClassifier`, and checks both
`CHECKED` and empty conditions. The production evaluation limit remains 2;
the diagnostic asks for 20 rows only to make rank visible.

The relevant rows are identical under both conditions and both systems:

| parts | top classifier result |
| --- | --- |
| 11603 + 11606 | `TUPLET_THREE` 0.951751620 (rank 1; `EIGHTH_set` 0.030636538 rank 2) |
| 11603 + 11605 + 11606 | `TUPLET_THREE` 0.960694139 (rank 1) |
| 11605 + 11606 | `DIGIT_5` 0.019365211, `TUPLET_SIX` 0.016729334 |

Thus this is not a top-two ranking failure, and the `CHECKED` condition does
not suppress the primary result. The MXL contains no `<tuplet>` or
`<time-modification>` element. The OMR XML contains no tuplet inter; it does
contain a false `STACCATO` articulation using glyph 11603 at the same box.

The next factory seam was checked directly on the loaded System 4. The
all-three compound is accepted by the guard used by
`InterFactory`/`TupletInter.createValid`: its box is `(760,1612,17,24)`, the
3-interline guard is `(700,1552,137,144)`, and it intersects standard upper
staff chords 11051 `(701,1646,23,64)`, 11052 `(747,1646,23,74)`, and 11053
`(792,1646,23,84)`. The corresponding `TupletsBuilder.getEmbracedChords`
check returns `REJECTED`, so the candidate is removed at the later linking
stage rather than rejected by classifier rank or the nearby-chord factory
guard.

The rejection is explained by the upstream beam-sibling rule. Chords 11050
through 11053 are all eighths on beam 2039. `TupletCollector.include` sees the
candidate on the tail side of chord 11052 and `getBeamSiblings` propagates the
whole beam, including chord 11050 at x=640. That gives more than the three
items required by `TUPLET_THREE`; `getEmbracedChords` returns null and
`TupletsBuilder.linkStackTuplets` removes an unlinked non-manual tuplet.
The bracket boxes span the three chords at x=701, 747, and 792, while the
preceding x=640 chord is outside the bracket. This is a concrete engine seam
to inspect in
`app/src/main/java/org/audiveris/omr/sheet/rhythm/TupletsBuilder.java`,
specifically `TupletCollector.getBeamSiblings` and `include`.

No production source, parser, scorer, threshold, timing allowance, or pin was
changed for this packet. No tuplets were inferred or added. The current
artifact remains a failing baseline (`measure_overfull`, 25 of 26 bars at
correct length), and this diagnostic makes no pass claim. Any future fix must
prove that the bracket-selected three chords can link without changing the
other six currently passing pieces.

## Temporary engine experiment

The exact upstream source was copied to
`/tmp/omr-rsi-chopin-patch/TupletsBuilder.java`. The experimental guard finds
exactly one left and one right bracket half around the tuplet glyph by using
interline-scaled dimensions plus foreground ink occupancy: a broad horizontal
top stroke and a full-height side hook. It then requires exactly the expected
number of same-staff chord tail anchors inside the measured horizontal bracket
span. Only when that evidence is present does `TupletCollector` trim beam
siblings to that span; all other tuplets retain the historical path.

The temporary harness `/tmp/omr-rsi-chopin-patch/PatchProbe.java` compiles this
source against the stock svc-15 jars and loads the saved OMR. Its result is:

```
PATCH_RESULT ACCEPTED
PATCH_CHORD id=11051 x=723
PATCH_CHORD id=11052 x=769
PATCH_CHORD id=11053 x=814
PATCH_NEGATIVE REJECTED
PATCH_NEARBY_BOX java.awt.Rectangle[x=578,y=1935,width=29,height=13]
PATCH_NEARBY_GEOMETRY left=false right=false
PATCH_NEARBY_NEGATIVE REJECTED
```

The positive case therefore links the three bracketed chords and excludes
11050. The negative control uses the same beam and a number-like glyph with no
bracket pair and remains rejected. The nearby glyph is rejected by both
left-half and right-half geometry checks: its inner edge is a full-height
upright, unlike the outer hook of either bracket half. An ambiguous or absent
pair leaves the historical path unchanged.

## Isolated svc16 PDF validation

The strengthened temporary source was compiled into the copied svc16 app jar
only. The jar hash before the final source update was
`3fc4c00f490a3c70ae422a2a4e266871492c84a7a46ba0c33a3118a5da3e03bc`; the
final copied jar is
`5329d6ad5cf3a8c8d23feb46127e6b5d992efd628c70ee4f0d87543e814bac29`.
The pinned Chopin PDF was run with the original options
`lyrics=false implicitTuplets=true fingerings=true`. The preserved output is
at `/tmp/omr-rsi-chopin-patch/svc16-out-final-20260914/`, including
`chopin-prelude-4.mxl`, `chopin-prelude-4.omr`, extracted XML, logs, and the
target score record.

In the generated MusicXML m12, the printed final three upper-staff notes are
D5, C5, B4 with `<duration>4`, `<actual-notes>3`, `<normal-notes>2`, and
`tuplet` start/stop notation. The preceding six upper-staff notes remain
eighths without time modification. The official current dist comparator
reports 26/26 printed bars, 0 wrong-length bars, 600 reference notes, 599 OMR
notes, 99% pitch, 98.333% exact, and 97.833% on-grid; its target play-along
gate is `PASS`. Relative to the cycle10 baseline (98% exact, 97.333% on-grid,
25/26 bars at the printed length), this is +0.333 exact points, +0.5 on-grid
points, and one repaired bar length. This is a target-only validation and is
not a claim about the full 16-piece suite or protected-piece regressions.

## Accepted cycle-12 engine result

Astra reviewed and tightened the final guard: absolute sheet ordinates are used
for the two bracket strokes, and a same-span candidate on another staff makes
the bracket ambiguous, preserving the original linking path. The reviewed
source SHA256 is `aaf655a23041dde7d6b5078dcd8238f2b68148d1fa16426ace11683cb5fbc64b`.
The saved probe's hardcoded diagnostic IDs belong only to the original svc-15
fixture; new engine artifacts receive different IDs.

The matching svc-18 full 16-piece run passes Chopin and preserves all six
previously passing pieces, for 7/16. Only its m12 comparison changes: 2160 →
1920 ticks, exact 10 → 12 and on-grid 9 → 12. No bar-length warnings remain.
See [cycle 12](omr-rsi-cycle-12.md) for image/jar identity, complete totals,
negative controls, and the separately attributed Für Elise run variation.
