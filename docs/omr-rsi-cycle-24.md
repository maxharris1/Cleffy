# OMR RSI cycle 24 — Invention 1 printed clef/beam crossing

One hypothesis and one implementation contract for Grok. Implementation and
official host validation are pending. Astra inspected existing evidence only;
the [locked split](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/omr-rsi-split-loop.md)
assigns implementation on `mh/omr-rsi-notes-fixes-c12b` / PR 41 to Grok and
all Audiveris, Docker and official benchmark execution to the host.

## Starting truth

Accept the [cycle 23 host verdict](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/omr-rsi-cycle-23-host.md)
and [official table](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/rsi-split-loop-bench.md),
generated **2026-09-14T22:21:02.498Z**: **10/16**, engine
`audiveris-5.11.0+svc-29`, HEAD **`ace14df`**, **5,996 reference notes,
74 missing / 121 extra**. Pitch is 98.24883255503669%, exact
97.33155436957972%, on-grid 96.53102068045364%. The local official
`bench.json` SHA256 is
`7b24d3894c02be78116f278842efeb87747b1ea885ff586e458b52374f5464f3`,
matching the host verdict.

Credit cycle 23's loader-scale correction with **Invention 8's new pass**.
Its m34 now has its printed quarter sound followed by two printed quarter
rests on each staff, at quarter offsets **1 and 2**. Preserve that result,
Air's cycle-22 pass and the previous eight passes. Keep quarter-rest ink
minima **recall outline >=0.90, recall glyph >=0.90, IoU >=0.85** unchanged.

Cycle 24 targets only **Bach Invention 1, BWV 772, page 1, system 5,
lower-staff change to treble within printed m9**. Its current result is
458 reference attacks, 23 missing / 37 extra, pitch and exact
**435/458 = 94.97816593886463%**, on-grid **431/458 = 94.10480349344978%**.
The rounded 95.0% exact display still fails. All 22 printed bar lengths
already pass. The other failures are the missing-note and extra-note checks.

## One hypothesis and ink-level cause

**The real inline G clef crosses a real sixteenth-note beam. The engine
recognizes the named clef in HEADERS, then treats that shared printed ink
as evidence that the clef and beam are mutually exclusive. The stronger
beam survives reduction and the clef disappears.** A narrowly evidenced
coexistence decision for those independently painted objects should retain
both through foundation reduction. This is a prerequisite repair; the
known, separate clef-loop slur prevents a justified piece-pass prediction.

This is a hypothesis about ownership of overlapping source ink. The saved
log proves creation and the final graph proves disappearance; it does
**not** record the removal call or competing inter. The proposed reduction
seam is supported by static code and geometry, and must be confirmed by
the host trace before this candidate can be credited. If the first removal
has another cause, stop this candidate and report it.

The older [Invention 1 localization](omr-rsi-invention1-localization.md)
correctly localizes the pitch cascade but predates the named-clef producer.
Its description of a clef that was never created is superseded for svc-29.
The cycle-17 helper already accepts this exact source glyph; changing
classifier thresholds or repeating clef insertion does not address the
current evidence.

## Rebound source and saved artifacts

The pinned PDF is
`services/omr-service/eval/cache/downloads/bach-invention-01.pdf`, SHA256
`9f31743791c689e7e5f5732e8181c49ba9d546f6a3b2d6cd874e6846d31a77a3`.
Page 1 is object 4, MediaBox `[0 0 612 792]`, rotation zero, content
stream 5. Embedded font object 13 is `ZOZYUG+Emmentaler-20`; encoding
object 35 names code 13 `clefs.G_change`. Stream 5 paints it with `/R13
19.9253 Tf`, text matrix `1 0 0 1 70.1454 188.592 Tm`, and a `TJ` array
whose first character is escaped `\r`. These are fixture locators, never
production selectors.

The same stream separately paints the two sloping beams after that text.
Under the outer `0.06` scale, their four-vertex paths are:

| Beam | Path vertices before the outer scale |
| --- | --- |
| Upper | `(1055.77,3560.04) (1055.77,3526.83) (2061.58,3359) (2061.58,3392.21)` |
| Lower | `(1055.77,3492.79) (1055.77,3459.59) (2061.58,3291.76) (2061.58,3324.96)` |

Each path is stroked and repeated as a fill; the local stroke width is
`6.64176` before the outer scale. Stroke and fill belong to one beam's
painted support, not two different musical beams. The source image shows
the G clef between the first and second lower-staff heads, beneath this
beam pair, with its upper stroke crossing the lower beam. The first G3
sixteenth remains under bass clef. The following G4 begins after the
printed change, at quarter offset **1/4** within m9.

The matching local edition source `/tmp/bach-invention-01.ly` corroborates
the sequence: m9 begins `g,16[ \clef "treble" g' f e]`, then m10 remains
treble. It is explanatory evidence only; recognition must use the pinned
PDF and ink, never this source, reference pitches or MIDI.

Current artifacts are in:

```text
services/omr-service/eval/cache/artifacts/9f31743791c689e7e5f5732e8181c49ba9d546f6a3b2d6cd874e6846d31a77a3-audiveris-5.11.0+svc-29-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/
```

`meta.json` declares and observes svc-29 with the locked options.

| Evidence | SHA256 |
| --- | --- |
| `omr-eval-input.omr` | `f7d5a32f4d5c6e0bc5a45f8694b60dbf86fa37a9b2280d13a27b999c4d827c85` |
| `sheet#1/sheet#1.xml` | `ce4e7379cef18af9f8dc1fc22b6567c4b17de3a04dfea762cc59db8191401f52` |
| `sheet#1/BINARY.png` | `4a4d32d972d4c6fb7354b6459e1a19b74c19c197fa278a929881d813577395c5` |
| `omr-eval-input.mxl` | `468ef4a4a081977e423a271942b476cfd927de31d44e2e3176dabd1b9599d1c2` |
| Root XML inside MXL | `8bd7ed3fd98ea132127e144dca0e83b41ea2505ef8ed0c6974570e1fd5be3531` |
| `audiveris.log` | `1dc0b45497a7bf296319d142d76fb5958875073629b2bc3c70474897b09c5213` |

The log's HEADERS stage records `clefs.G_change accepted staff#10
box=(292,2431,43,127) ink=1603/1748`. Those counts are the existing clef
helper's inside/path counts, **not** a new IoU or proof of crossing
compatibility. The F change on staff 12 is also accepted and survives.

Final system 5 contains only header clefs 227 (G, staff 9) and 239 (F,
staff 10). Its m9 `<clefs>` lists those two; there is no inline G inter.
MusicXML m9 and m10 contain no clef change. The next lower G is emitted
at m11. Both m9/m10 stacks retain `expected="1" duration="1"`.

The neighboring final graph supplies these geometric witnesses:

| Object | ID / glyph | Box `(x,y,w,h)` | Intrinsic / contextual grade |
| --- | --- | --- | --- |
| Upper beam | 1598 / 1599 | `(263,2409,253,53)` | 0.691 / 0.972 |
| Lower beam | 1600 / 1601 | `(263,2426,253,53)` | 0.656 / 0.967 |
| Remaining clef fragment | free SYMBOL glyph 5631 | `(292,2444,43,114)` | no clef inter |
| Curve from the clef's lower loop | slur 5582 / glyph 5565 | inter `(294,2511,39,19)` | 0.694 / 0.952 |

Both beams have ordinary beam/stem relations to the four printed-note
stems 4667, 4687, 4688 and 4668. Their medians extend from approximately
`(263,2414.1)` to `(516,2456.6)` and `(263,2431.3)` to `(516,2473.5)`.
The saved slur links heads 2755 and 2769, while its curve occupies the
clef loop. It is a separate later competitor that this cycle does not
repair. IDs are run-specific locators.

## Responsible seam and implementation contract for Grok

Static inspection of the locally extracted stock 5.11.0 classes shows:

- `SigReducer.detectOverlaps` first checks class compatibility and bounding
  IoU, then calls both inters' `overlaps` methods and inserts an exclusion.
  Beam compatibility does not include clefs. `AbstractInter.overlaps`
  normally checks intersecting glyph ink when both glyphs exist.
- The reducer excludes staff-header inters from this overlap walk; the
  inline clef is deliberately not a header. The current named-clef hook
  creates an ordinary, unfrozen clef with evidence-derived intrinsic grade.
- CURVES' `Skeleton.buildSkeleton` erases heads, beams, lyrics and text as
  non-crossable shapes, and barlines/connectors, ledgers and stems as
  crossable shapes. **Neither set contains clefs.** `PageCleaner.canHide`
  accepting contextually good inters does not help a shape never selected
  for erasure. `SymbolsFilter` can hide clefs later, but SYMBOLS follows
  CURVES. There is therefore no static basis for promising that retaining
  the clef through REDUCTION will prevent slur 5582 naturally.

This limitation is deliberate scope control: the beam and clef are both
printed and must coexist; the loop-slur is a separate false interpretation.
Do not add clef erasure to `Skeleton`, suppress that slur, change slur
linking, or otherwise combine those repairs with this cycle.

The inspected `SigReducer.class` hashes to
`e4be83146ba35a78e47263c87e49b4d1690f89b43c26738e46e6bb5a466f1bfd`.
The current Dockerfile supplies no replacement for that class. This is
static local evidence, not a fresh container inspection; the host must bind
the actual class/configuration and first removal to its svc-29 control.

Implement **one source-confirmed clef/beam coexistence rule**, with this
boundary:

1. Add a small helper, proposed `PdfClefBeamCrossings`, and the narrow
   `SigReducer.detectOverlaps` hook needed to consult it before creating a
   clef/beam overlap exclusion. Permit minimal plumbing from the existing
   named-clef producer to retain the source-paint identity of its ordinary
   inter. Limit applicability to an already accepted, glyph-backed named
   `clefs.G_change` or `clefs.F_change` and an already recognized ordinary
   beam. Neither object may be invented by this rule. Do not add all clefs
   to `beamCompClasses`, alter general overlap thresholds, or add synthetic
   support relations to raise grades.

2. Require independent source proof for **both** objects: the embedded
   named clef outline and a distinct visible PDF path matching the beam's
   actual painted support. Account for path CTM, stroke width, caps/joins,
   fill, clipping and paint visibility; consolidate repeated stroke/fill
   of the same path. Require the ordinary beam's real stem/head support
   outside the clef region, and verify that the source paths explain the
   crossing. A long line, a beam-like bounding box, an existing high grade,
   or a clef's own stroke is insufficient beam evidence. Do not reuse
   paint from another page or treat ambiguous path bindings as proof.

3. Bind the new evidence to the actual source rendering and current sheet.
   Use the loader's effective DPI transform, crop origin and rounding
   semantics; no fitted translation, offset search or best-of-transform
   selection. Keep the existing clef creation/transform and the accepted
   quarter-rest path unchanged. For the new source-to-glyph compatibility
   proof require full-support pixel-center agreement, with symmetric
   exclusion of staff-line pixels: **recall outline >=0.90, recall glyph
   >=0.90, IoU >=0.85**, separately for each bound object. Count over the
   complete union, including glyph ink outside outline bounds. Log exact
   numerators, denominators, excluded pixels and registration provenance.
   These new crossing scores have not been measured here; if either
   object fails, stop rather than relax the proof. No dilation, erosion,
   raster redraw, threshold reduction or per-piece tolerance.

4. For only the individually proven pair, shared source ink means the
   objects coexist; do not introduce the otherwise erroneous exclusion.
   Leave every other exclusion and ordinary reduction decision in force.
   Preserve both glyphs, grades, beam/stem relations and printed positions.
   No manual/frozen clef, blanket cleanup protection, deletion of real
   beam ink, replacement header, change to `staff.setClefStop`, forced
   pitch, or post-reduction reinsertion. Unsupported or unavailable source
   evidence takes the unchanged path. Scope cached evidence to source
   content, page and render configuration; make duplicate processing
   inert, and validate stale/missing-source behavior on reload.

5. Include diagnostic tracing of the named clef from creation through
   HEADS, STEMS, REDUCTION, MEASURES, CURVES, SYMBOLS, LINKS, RHYTHMS and
   export. Log actual pairwise ink intersections, exclusions, grades and
   the first removal reason in the control. The host must first establish
   whether the source-bound beam exclusion is the first cause. Require
   the clef and both beams to survive foundation REDUCTION in the candidate.
   Trace the later loop-slur and report whether it subsequently removes the
   clef; that is an explicitly unresolved blocker, not a reason to expand
   this implementation. If another cause removes the clef before the end
   of foundation reduction, this crossing-only candidate is insufficient.
   Do not append a slur, pitch-cache, duration or exporter repair.

6. Limit implementation to that helper/hook, necessary named-clef evidence
   plumbing, reproducible patch/build wiring and focused controls. Use a
   fresh engine revision, **svc-30 if available**, with matching declared
   and observed provenance. Preserve parser, `buildScoreData`, scorer/eval,
   warnings, corpus/reference pins, floors, allowances and deployed
   generation. **Do not restore patch 0006. Do not touch Schumann pickup/end
   pins.** Preserve Schumann's m8 internal separator and all accepted
   clef, ledger, dot, tuplet and rest work. Keep `lyrics=false`,
   `implicitTuplets=true`, `fingerings=true`.

## Discriminating controls and host acceptance

Grok's focused controls must exercise the actual source reader and saved
ink: the target named clef, both genuine beams and their stem support;
translated equivalent geometry with known rendering metadata; independent
ordinary G/F changes and recognized octave clefs as preservation controls.
Negative controls must retain normal exclusion/fallback for a raster-only
clef, wrong source/page, blank or erased ink, unsupported transforms,
invisible/occluded paint, ambiguous path matches, a spurious beam traced
from the clef itself, and a nearby slur or notehead using clef ink. Verify
that repeated stroke/fill neither duplicates a beam nor creates a second
independent witness. Test duplicate processing and stale cache provenance.
No control may qualify by filename, piece, glyph ID or fixture coordinates.

The host owns all engine lifecycle runs, including the control removal
trace, fresh candidate run and saved-OMR reload/export. The decisive
comparison is the same source-bound clef/beam pair immediately before and
after foundation REDUCTION: control removes the clef by a beam overlap;
candidate retains both independently evidenced objects, with unchanged
grades and all four real-note stems/heads. If that comparison is not
observed, the proposed first blocker is not repaired. A mere `accepted`
log, changed numeric ID or lower exclusion count is insufficient.

Then complete the normal lifecycle and full official bench. **Expected
conservative outcome: still 10/16**, with Invention 1 possibly retaining
all three current gate failures because the later loop-slur remains.
If metrics are unchanged, expect the same 5,996 reference notes, 74 missing
and 121 extra. The host may credit only the directly traced prerequisite;
it must explicitly keep the remaining failure and its later removal seam
open. This document does not predict or credit a new piece pass.

If the clef unexpectedly survives the complete ordinary lifecycle, verify
its exported position before crediting any gain. It belongs between the
first and second lower m9 heads: the G3 at quarter offset 0 remains
unchanged, and the next G4 at offset **1/4** uses treble. The remaining
**11 m9 and 12 m10 lower-staff attacks** are the localized pitch cluster.
Keep the original rhythms/voices, all 22 bar lengths, m11's header G and
the later F change. A clef moved to m9's start is wrong. Report what happened
to the loop-slur and why; do not infer recovery from improved note totals.

Removing exactly that pitch cluster, if actually demonstrated, would mean
0 missing / 14 extra and 458/458 exact on Invention 1: the six existing
ornaments explain 12 extras, with two residual extras within the unchanged
allowance. Those are attribution bounds, not this cycle's forecast or
permission to fix ornaments, durations or residual notes.

Require a newly completed full 16-piece official report with byte-identical
pins, unchanged scorer/options and matched build provenance. Inspect every
changed piece and credit only changes explained by this same crossing rule.
A partial, stale or exceptional run is not acceptance evidence;
`BENCH_EXIT=1` remains expected for the unfinished suite.

Kill the candidate if the control trace falsifies the proposed removal
cause; either independent ink proof fails; either beam or its notes is
damaged; the claimed prerequisite does not survive foundation REDUCTION;
any claimed final recovery is misplaced or fails reload/export; the result
is presented as a pass without clearing the later slur blocker; the change
includes another repair, a grade override, an unsupported overlap
exception or altered pins/floors; or any current passer goes red. Protect
all **ten**: Czerny 821/1, BWV 999, Anh. 114, Anh. 115, Anh. 116,
Burgmuller Op. 100/2, Schumann Op. 68/1, Chopin Op. 28/4, Air Anh. 131
and **Invention 8**.

Astra inspected existing documents, source streams, saved OMR/MusicXML,
logs, an existing page image and static local bytecode. No candidate
recognition or new ink matcher was executed; no engine, parser, scorer,
pin or floor was edited; no Audiveris, Docker, npm eval or implementation
commit was performed. Pre-existing dirty benchmark reports were left
untouched. The only writes are this hypothesis and its identical copy in
the requested host docs store.
