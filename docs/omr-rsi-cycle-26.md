# OMR RSI cycle 26 — Satie m53's displaced quarter rest loses its staff

**One piece, one ink-level cause, one implementation contract for Grok.**
Implementation and official validation are pending. Under the
[locked split](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/omr-rsi-split-loop.md),
Grok implements on `mh/omr-rsi-notes-fixes-c12b` / PR 41; the host alone
runs Audiveris, Docker and the official benchmark. Astra performs read-only
inspection and writes this packet.

## Starting truth and target

Accept the [official svc-31 table](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/rsi-split-loop-bench.md),
generated **2026-09-14T23:31:18.223Z**, and the
[cycle 25 host verdict](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/omr-rsi-cycle-25-host.md):
**10/16**, engine **`audiveris-5.11.0+svc-31`**, HEAD **`e7726c1`**,
**5,996 reference notes, 74 missing / 121 extra**. Suite pitch is 98.2%,
exact 97.3%, on-grid 96.5%; totals match svc-30 at table precision.
The local official `bench.json` SHA256 is
`92dd37994b13a2539f96a6faf3cc9f237ff597c84aa705bbca36e66bd0acb74e`,
matching the host verdict.

**Cycle 25 is not credited.** Satie still has **4 missing / 4 extra**,
exact **92.99191374663073%**, on-grid **89.75741239892183%**, and four
overfull bars out of 65. No host `PdfHeaderTimeHints` trace confirmed its
proposed key-search boundary. Do not retry or extend the opening-3/4
header-time candidate. Cycle 24's Invention 1 clef/beam coexistence
candidate is also excluded.

Cycle 26 targets only **Satie, Gymnopédie No. 2, page 1, system 6,
printed m53: the accompaniment's quarter rest beneath the dotted-half
C5 melody note on the upper staff**. It is a different source symbol,
bar and processing seam from cycle 25. The expected result is a partial
repair; the suite is expected to remain 10/16.

## One hypothesis

**The printed quarter rest is displaced downward to clear the melody.
Its full silhouette still crosses the upper staff's bottom line, but its
bounding-box center falls outside the PDF quarter-rest helper's narrow
staff window. The helper consequently withholds source recognition
evidence before measuring this intact rest's ink.** Without the rest,
normal rhythm processing serializes the accompaniment after the melody,
making m53 five quarters long.

The proposed change is one narrowly guarded staff-ownership fallback for
this existing named-quarter-rest evidence path: a fully matched rest
silhouette that straddles exactly one staff's lower boundary can belong
to that staff even when its center lies below the current window. Keep
the original ink tests and ordinary rest factory/lifecycle unchanged.
Do not add a meter, voice correction, new rest shape, or inferred silence.

Static source inspection establishes that the current staff predicate
excludes this geometry. The saved log does not record that predicate's
rejection, and it contains no target ink measurement. Thus **the target's
recall/IoU and successful ordinary creation remain unmeasured**. Host
tracing must establish that this guard is the actionable blocker; a
missing log alone is not proof of the entire recognition lifecycle.

## Evidence bound to svc-31

Pinned PDF:
`services/omr-service/eval/cache/downloads/gymnopedie-2.pdf`, SHA256
`d23906c422539128fe0e5106a4ebf8ea7f8273a60c3f2dbcf4c7f5f46363acb6`.
Current artifacts:

```text
services/omr-service/eval/cache/artifacts/d23906c422539128fe0e5106a4ebf8ea7f8273a60c3f2dbcf4c7f5f46363acb6-audiveris-5.11.0+svc-31-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/
```

`meta.json` declares and observes svc-31 with the locked options.

| Evidence | SHA256 |
| --- | --- |
| `omr-eval-input.omr` | `8737ab6f093c085a8029abeabb1b24a6404bc6141b5aeb593f96b9b319111b77` |
| `sheet#1/sheet#1.xml` | `6fbfb0174113a6ecd4c9b1a523aa26142d268cf3fff15916cf6f48fc6939c367` |
| `sheet#1/BINARY.png` | `04d503e2a8922bfff57c9dfbeaabca264d79eb1c5b50f87d0c35a65361020fda` |
| `omr-eval-input.mxl` | `e0b27a95b2ec5cb4fb52681477b1b98b79321aefa49077eb15f122d770cc4715` |
| Root MusicXML inside MXL | `710208bedd6b57b7399c3354de9ed786697d69226b7ffc27ab4b9aa8bcb3da0d` |
| `audiveris.log` | `7230e8a8b913a22905a7320ebf6bafde6e73919c451ca043daec0e9e15db625e` |

The reviewed `/tmp/gym-binary.png` has the exact current BINARY hash.
It shows the rest below the C5, separately from its augmentation dot and
the two flats preceding the accompaniment chord. Page pixels are
2550×3299, with saved skew zero.

### Source paint and staff geometry

PDF page 1 is object 4, MediaBox `[0 0 612 792]`, rotation zero,
content stream 5. Embedded font object 13, `/R13`, is
`RSERWW+Emmentaler-20`; encoding object 35 maps character code 2 to
**`rests.2`**. The target is painted by this stream fragment:

```text
q
16.6667 0 0 16.6667 0 0 cm BT
/R13 19.9253 Tf
1 0 0 1 436.025 94.3561 Tm
(\002)Tj
```

Here `\002` denotes the actual byte 0x02. The stream's enclosing graphics
transform is `0.06 0 0 0.06 0 0 cm`. These are source locators, not
production selectors; the text origin is not the outline's bounding box.

Upper staff 11 has lines at **2803, 2824, 2844, 2865, 2886**, with
interline 21. Lower staff 12 occupies **3004 through 3087**. The target
glyph is **6511**, `groups="SYMBOL"`, bounds **(1815,2874,22,59)**.
It retains the rest's run table but has **no RestInter or RestChord**.
The rest is separate from glyph 6525 (the melody's dot) and glyphs
6527/6535 (the accompaniment's flats).

The current helper accepts an outline center only between
`firstLineY - 0.5 * interline` and `lastLineY + 0.5 * interline`.
For staff 11 the bottom edge of that permitted band is **y=2896.5**.
The target center is about **y=2903.69**, approximately **7.19 pixels
beyond it**, although the silhouette begins above the bottom line.

That outline estimate is a read-only geometry calculation, not a new
matcher run: the same font/size's m46 rest is painted at
`(57.2384,99.3375)`. Its svc-31 log records loader outline
`(236.5843,2853.2159,22.0839,59.4439)`. Applying the two source-origin
differences through the stated transforms and the existing loader scale
`4.166666507720947` gives the target outline approximately
**(1814.865,2873.972,22.084,59.444)**. This identifies the staff-window
failure without borrowing m46's ink or confidence. Grok must extract and
measure the target's own outline; m46 is only a geometry and preservation
control. The rest's entire outline ends well above lower staff 12.

### Current graph and export

| Object in m53 | Current ID | Box `(x,y,w,h)` | Required preservation |
| --- | --- | --- | --- |
| Lost quarter-rest interpretation | glyph 6511 | `(1815,2874,22,59)` | Recover an ordinary rest on this ink |
| Dotted-half melody C5 | chord 5897, head 2689 | chord `(1821,2768,25,76)` | Keep onset 0 and length 3 quarters |
| G3/B-flat3/E-flat4/G4 half chord | chord 5898; heads 2789/2779/2735/2705 | `(1901,2792,25,156)` | Keep four heads and length 2 quarters |
| Dotted-half bass F2 | chord 5910, head 2827 | `(1817,3088,25,60)` | Keep onset 0 and length 3 quarters |

IDs are run-specific locators. In the saved graph stack 53 spans
x1797–2011 and has `duration="5/4"`; its two slots are at offsets
0 and `3/4` whole note. Voice 1 contains melody chord 5897 and then
accompaniment chord 5898. Voice 5 contains bass chord 5910. There is
no accompaniment rest voice.

Raw MusicXML m53 has divisions-per-quarter 1: C5 duration 3 at offset 0,
then the four-note accompaniment duration 2 at offset 3 in the same
voice; a backup of 5 precedes the bass duration 3 at offset 0. The page
instead places the printed quarter rest at offset 0 and the accompaniment
half chord at offset 1, alongside the sustained melody/bass. Six pitched
note elements already exist; the defect here is their accompaniment's
timing after a lost printed rest.

## One implementation contract for Grok

1. **Modify only staff eligibility for the existing named-quarter-rest
   evidence route.** The seam is
   `SymbolsBuilder.withPdfQuarterRest` → `PdfQuarterRestHints.uniqueStaff`,
   before `measure` and source-evaluation merging. Leave the current
   center-window success path intact. Add a fallback only for a named
   `rests.2` outline rejected because its center lies below a staff's
   lower window edge. Do not enlarge the half-interline margin or replace
   staff ownership with unconditional nearest-staff selection.

2. In that fallback, require the actual source outline to **straddle the
   bottom line of exactly one eligible five-line staff**, with matching
   non-staff rest ink both inside its actual first-to-last-line band and
   below its bottom line. A bounding-box intersection or staff-line pixels
   alone is insufficient. Evaluate the staff lines at the relevant x
   positions; require the complete outline inside the staff's horizontal
   extent and one unambiguous existing measure. Require no intersection
   with another staff's band, and agreement with the ordinary closest-staff
   assignments of both the glyph center and ink centroid. Reject ambiguous
   ownership, a rest wholly outside all staff bands, a wrong system/staff,
   or a symbol touching two staff bands. This first scope does not recover
   rests wholly in the interstaff gap or above a staff.

3. Preserve the existing unique **whole-glyph** match, actual PDF/page and
   named embedded-outline identity, visible-paint checks and loader
   registration. Use the target's own paint and untrimmed glyph, with
   actual render metadata; canvas dimensions only validate registration.
   Measure the full union of outline and glyph support with the existing
   symmetric staff-line exclusion and pixel-center sampling. Keep
   **recall outline >=0.90, recall glyph >=0.90, IoU >=0.85** and confidence
   `min(recallOutline, recallGlyph, IoU)` unchanged. No dilation, erosion,
   offset search, fitted transform, clipping unexplained glyph ink,
   component splitting, neighboring-rest template or threshold relaxation.
   Failure of any target ink minimum ends this candidate.

4. A qualified fallback supplies only the existing source-derived
   `QUARTER_REST` evaluation through the existing merge, ordinary
   `InterFactory` / `RestInter.createValid`, exclusions, LINKS cleanup and
   RHYTHMS. Keep the glyph's coordinates and staff-relative rest placement.
   Do not move it into the staff to satisfy another check. No manual/frozen
   rest, forced grade, cleanup exception, direct inter insertion or late
   resurrection. Failed evidence must return the original raster
   evaluations with no graph, bounds or ownership mutation. Already
   recognized rests must remain single, and repeated processing/reload
   must not duplicate the source interpretation.

   Static inspection of the locally extracted stock 5.11.0
   `RestInter.createValid` shows closest-staff selection from the glyph
   centroid, a measure lookup and a stuck-rest/chord conflict check; it
   does not impose this helper's half-interline center window. Its class
   SHA256 is
   `ad3003d5f34eb2c90d54804f5dec842a29adeb3e704cdbd92a0d23b4862fe071`.
   This is static evidence, not a host lifecycle result. Preserve all
   factory checks. If ordinary creation, cleanup or rhythm still fails,
   record that separate blocker and stop; do not append another repair.

5. Limit changes to `PdfQuarterRestHints.java`, the minimally necessary
   `SymbolsBuilder.java` staff-geometry plumbing and rejection/acceptance
   tracing, focused controls, and reproducible patch/build/provenance
   wiring. Use a fresh engine revision, **svc-32 if available**, preserving
   accepted svc-31 work and the deployed generation. Do not select by
   filename, source hash, piece/bar number, coordinates, numeric glyph ID,
   font subset prefix or reference pitches. Evidence must belong to the
   current source/page/render; stale or unavailable evidence leaves the
   ordinary path intact.

6. Leave engine algorithms outside that seam, parser, `buildScoreData`,
   exporter, scorer/eval, warning policy, corpus/reference pins, floors
   and allowances unchanged. **Do not restore patch 0006. Do not touch
   Schumann pickup/end pins or its accepted m8 separator.** Preserve the
   accepted rest loader-scale correction and all original rest ink minima.
   Keep `lyrics=false`, `implicitTuplets=true`, `fingerings=true` and the
   raster resolution/preprocessing unchanged. No header/key/time change,
   clef/beam coexistence change, tie repair, voice/slot heuristic, invisible
   spacer, or padding is authorized by this packet.

## Discriminating controls and host acceptance

Grok's controls must exercise the actual source reader, target embedded
outline and saved ink, not a hand-authored box accepted by a predicate.
Require the m53 target to demonstrate the old staff rejection and the new
unambiguous ownership, followed by all unchanged ink tests. Record source
identity, both center and centroid, staff lines/extents, old window,
non-staff support on both sides of the bottom line, unique-glyph result,
render matrix, full intersection/denominator counts, confidence and the
ordinary factory outcome. A `factory next` log is insufficient.

Use the actual m46 rest and already recognized displaced rests as
preservation/duplicate controls. Include equivalent translated geometry
with known source/render metadata, a lower-staff rest straddling its own
bottom line, conflicting center/centroid staff assignments, two possible
staff bands, erased upper tip, blank/erased rest, wholly interstaff ink,
wrong source/page, unsupported transform, and staff-line-only overlap.
Neither a genuine flat nor a dot may qualify. Removing PDF evidence must
restore the original raster treatment. Preserve Air Anh. 131 and both
recovered first rests of Invention 8 m34 explicitly.

The host must bind a svc-31 control and fresh candidate to the same source,
options and actual loaded classes. Establish that glyph 6511's source-bound
successor reaches `withPdfQuarterRest`, uniquely matches the target paint,
and is rejected by staff eligibility in the control. If an earlier or
different blocker prevents this, do not credit the proposed cause or widen
the implementation. Trace candidate recovery through **SYMBOLS → LINKS →
RHYTHMS → saved OMR → reload/export** with source/object continuity.

Required local result in m53:

- One ordinary upper-staff quarter rest on the printed ink at quarter
  offset **0**, followed in its accompaniment voice by the existing
  G3/B-flat3/E-flat4/G4 half chord at offset **1**, ending at **3**.
- The C5 melody and F2 bass remain at offset **0**, each lasting **3**
  quarters. Preserve all six pitched elements, accidentals, heads, stems,
  dots, genuine barlines and surrounding musical markings.
- Ordinary stack duration becomes **3/4**, with slots at 0 and 1/4 whole
  note. XML cursor extent becomes three quarters through actual events,
  without a forced meter, rewritten offsets or hidden padding. Reload and
  repeated processing retain this result.

**Conservative prediction: Satie remains FAIL and the suite remains
10/16.** A localized success reduces Satie's overfull bars from four to
three: m1, m20 and m32 remain unresolved. Its 4 missing / 4 extra and
the suite's 74 / 121 are expected to remain unchanged. Correcting only
the four accompaniment attacks could move exact from 345/371 to 349/371
(94.07%) and on-grid from 333/371 to 337/371 (90.84%); this is a conditional
estimate, not a measured score or an acceptance substitute. The note-length
gate could clear while attack-grid and bar-length failures persist.

The opening header error, m20/m32 voice/slot faults, m27's missing export
and tie defects are independent and outside scope. Any changes elsewhere
from the same generic staff-ownership rule require separate source/graph
attribution; do not use this packet to implement fixes for those sites.

Require a newly completed **full 16-piece official report** with identical
pins, scorer/options and matched declared/observed engine provenance.
Inspect every changed piece and Satie bar. `BENCH_EXIT=1` remains expected
for an unfinished suite. A stale/partial report, exception, absent trace,
temporary rest, or unexplained aggregate gain is not acceptance.

Kill the candidate if the target lacks the required independent staff/ink
proof, cannot survive the normal lifecycle, remains overfull, or requires
moving/altering real ink, a second repair, lower thresholds, changed pins
or suppressed warnings. Any protected passer turning red kills it.
Protect all **ten**: **Czerny 821/1, Air Anh. 131, BWV 999, Anh. 114,
Anh. 115, Anh. 116, Burgmüller Op. 100/2, Schumann Op. 68/1,
Chopin Op. 28/4 and Invention 8**.

## Astra handoff

Astra inspected existing documents, svc-31 artifacts/logs, the pinned PDF
stream, matching binary page, current helper source and static local
bytecode. No candidate matcher or new rest ink scores, Audiveris, Docker,
npm eval or implementation tests were run. No engine, parser, scorer, pin
or floor was edited; no implementation was committed. Pre-existing dirty
benchmark reports were left untouched. Task writes are this hypothesis
and its identical copy in the requested host docs store.
