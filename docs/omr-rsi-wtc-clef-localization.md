# WTC I Prelude 1 inline treble clef localization

Status: the page evidence supports one missing inline G clef, and the
earliest surviving machine evidence is in Audiveris symbol candidate
classification. The parser and MusicXML exporter cannot repair this clef.
No source fix is proposed from this packet.

## Printed evidence

The pinned corpus entry is
`services/omr-service/eval/corpus/wtk1-prelude1.json`, PDF SHA
`0bc884049d69e9d3ec24b133467d8b8bfc0335e169a16cfd1075b329e7278449`.
The matching `/tmp/wtk1-page2.png` shows the final system beginning at
printed measure 33. The matching `/tmp/wtk1.ly` changes the right hand to
`\clef "bass"` immediately before the measure-33 passage (line 92), then
to `\clef "violin"` immediately before measure 34 (line 94). The printed G
clef is visibly just before the m33/m34 barline; it applies to m34 and the
final m35 chord. The lower staff remains bass.

## First machine divergence

In the 300-dpi artifact
`/tmp/wtk-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f-sheet2.xml`,
the final system is `system id="6"` (line 15997). Its m33 is stack/measure
`id="15"`; only the two `F_CLEF` inters `263` and `275` are listed in
`<clefs>` (line 16127 and lines 16689–16694). The inline G clef is absent.
The next stacks, m34 `id="16"` and m35 `id="17"`, have no clef entries.
The corresponding MusicXML has the last `F` clef in measure 32 (lines
9732–9735), then no clef in measures 33–35 (measures begin at lines 9739,
10054, and 10323). Thus the exporter is serializing the upstream clef state
it received.

The candidate is visible in the 400-dpi probe, which used the same pinned
PDF and added only `org.audiveris.omr.image.ImageLoading.pdfResolution=400`.
In `/tmp/wtk-73d09423526056ef9012207d05752df86f9574b7b501aa3235256feb0fd228f9-sheet2.xml`,
the same final system starts at line 16081 and m33 lists only F clefs `261`
and `273` (line 16197; definitions at lines 16768–16773). However, its
`<free-glyphs>` entry (line 16657) retains glyph `6791` at
`x=1514,y=3485,w=45,h=134`. This is immediately before the m33/m34 barline
at `x=1590` and on the upper-staff clef band. It is a `SYMBOL` free glyph,
not an inter. The glyph is the same treble-clef-like candidate position and
shape family as the recognized G clefs on that page (recognized glyph `236`
is `w=71,h=210`); no `G_CLEF` inter is emitted for it. The 300-dpi artifact
has the corresponding region split into smaller free SYMBOL fragments
(`6788` at `x=1146,y=2614,w=23,h=48`, plus `6789`/`6791`) and a low-grade
head-chord `6478` (`grade=0.552`, x=1141), consistent with the clef area
being consumed by symbol fragments rather than promoted to a clef.

The frozen 300-dpi score reports the requested paired cascade: m34 has 11
missing and 11 extra pitches, m35 has 2 missing and 2 extra pitches (13/13
across m34–m35). The score also reports one unrelated m33 extra and m33
duration `2400`; those are not used to infer a timing repair. The m34/m35
pitch pairs are the expected treble notes versus their bass-clef readings.

## Layer attribution

This is before the Cleffy parser boundary. In the pinned upstream source,
`app/src/main/java/org/audiveris/omr/sheet/symbol/SymbolsBuilder.java`
`evaluateGlyph` (lines 188–233) runs the classifier on each `SYMBOL` glyph
and creates an inter only for an acceptable evaluation (the threshold is
`Grades.symbolMinGrade`, lines 207–212). `SymbolsFilter.java` lines 168–180
and 420–467 create and retain these staff-free SYMBOL glyphs. The existing
`InterFactory.java` mapping (lines 285–296) already maps `G_CLEF` to
`ClefInter`; it cannot run when the candidate remains free. Therefore the
first exact upstream class to instrument or own is `SymbolsBuilder.java`,
with `SymbolsFilter.java` as the preceding candidate-extraction seam. No
parser pitch shift, inline XML edit, or clef inference is justified.

The 400-dpi probe also changes unrelated m33 triplet recognition, while the
G clef remains a free glyph and the MusicXML clef output remains unchanged.
That is evidence of a resolution-sensitive symbol candidate, but not proof
that a broad resolution or threshold change is safe.

## Required next artifact and limits

Before implementation, capture an Audiveris symbol-stage classifier trace or
saved staff-free symbols image for 400-dpi glyph `6791`, including its
candidate evaluations and whether `isBigEnough`/`Grades.symbolMinGrade`
rejects it. A narrow fix may be considered only if it promotes this exact
candidate as `G_CLEF` without changing defaults, floors, gates, timing, or
pitch rules, and after root verifies every piece. Do not touch the separate
WTC m6 and m25 blockers; they remain explicit unresolved cases. Preserve the
invariant that all five currently passing pieces stay green while the full
16-piece suite is checked.
