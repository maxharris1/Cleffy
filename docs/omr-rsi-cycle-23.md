# OMR RSI cycle 23 — Invention 8 quarter-rest outline coordinates

One hypothesis for Grok, pending implementation and official host validation.
Astra's work is read-only evidence inspection and this writeup. The
[locked split](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/omr-rsi-split-loop.md)
assigns implementation on `mh/omr-rsi-notes-fixes-c12b` / PR 41 to Grok;
only the host runs Audiveris, Docker and the official benchmark.

The starting truth is the [official svc-28 table](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/rsi-split-loop-bench.md),
generated **2026-09-14T21:58:56.097Z**: **9/16**, engine
`audiveris-5.11.0+svc-28`, HEAD `c9cfb2f148f52d7b408437a622d0210c0a194ffe`,
**5,996 reference notes, 78 missing / 121 extra**. Pitch is 98.182%,
exact 97.148%, on-grid 96.348%. The local official `bench.json` hashes to
`ab14226a1fc90652690751740c0d2f5e6974085451b2f893923650db7ee8d326`,
matching the [cycle 22 host verdict](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/omr-rsi-cycle-22-host.md).

Accept cycle 22's 8→9 gain as **Air Anh. 131**, through the same named
`rests.2` rule: 100% pitch/exact/on-grid, zero missing/extra. Its original
eight protected passes stayed green. Invention 8 was **not repaired**:
598 notes, 1 missing / 0 extra, 592/598 exact, 590/598 on-grid, sole failure
`bar-length-warning (measure_underfull)`. Cycle 23 targets only
**Bach Invention 8, BWV 779, page 2, final system, printed m34**.

**Hypothesis.** The named quarter-rest helper derives its PDF-to-sheet
scale from the rounded raster canvas dimensions, although the PDF loader
draws with the original DPI scale. On this 2550×3299 page that compresses
the helper's vertical coordinates, moving its outline roughly half a
pixel above the actual first-rest ink. Reconstructing the loader's exact
transform for this existing quarter-rest evidence path should let both
printed first rests meet the unchanged ink minima and enter normal rest
recognition. This is one coordinate-registration cause. It is not yet a
measured recovery, and success at the locked minima is not assumed.

The source is unchanged from [cycle 22](omr-rsi-cycle-22.md):
`services/omr-service/eval/cache/downloads/bach-invention-08.pdf`, SHA256
`5323449d08aa5031e974e275f182bebf8f533ecf62e5f9b0c9c36364f4b66469`.
Page 2 is object 21, MediaBox `[0 0 612 792]`, rotation zero; stream 22
paints two quarter rests after the opening sound on each staff. Embedded
`PERCJM+Emmentaler-20`, resource `/R13`, encoding object 38 names the
painted character `rests.2`. The first lower/upper text origins are
approximately `(535.1566,314.1486)` and `(535.1566,364.2109)` PDF points.
These are fixture locators, not recognition selectors or outline bounds.

Current evidence comes from this saved artifact directory:

```text
services/omr-service/eval/cache/artifacts/5323449d08aa5031e974e275f182bebf8f533ecf62e5f9b0c9c36364f4b66469-audiveris-5.11.0+svc-28-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/
```

Its metadata declares and observes svc-28. Read-only checks give:

| Artifact | SHA256 |
| --- | --- |
| `omr-eval-input.omr` | `5cd4dcac0c0e7211ab9c13aefde534815c2e2554c0db0b642c2017e049615163` |
| `sheet#2/sheet#2.xml` | `b85d4832be05c6faf4ab493180208802e361eb5485e1c83e569bb1028a70291c` |
| `sheet#2/BINARY.png` | `17813a8cf6a4426a998c2003e58ea9f9f09d1df214899febae23d0695077d22c` |
| `omr-eval-input.mxl` | `fd1741233ead13e67c261074067202221908dfcc40cf7994fbb072f0e544fbcc` |
| Root `omr-eval-input.xml` inside MXL | `b85b19342cc16311aa6db7ffe599854a0fde9ce79b56caeb90e8505cbeefd24f` |
| `audiveris.log` | `db0229ccf0702c218b1bf7bb265daef81d82eb61ac25d54069c00e2a41c6d0af` |

The PNG header and saved `<picture>` both report **2550×3299**; saved
skew is zero. Local stack 13 still has `expected="3/4" duration="1/2"`,
with slot offsets 0 and 1/4 whole note. Exported m34 still has A3/C4/F4
as a quarter chord on the upper staff and F2 as a quarter on the lower,
each followed by just one quarter rest. The final `light-heavy` is real.
The root MusicXML hash is identical to cycle 22's recorded svc-27 export.

The svc-28 log and saved glyph geometry bind the four rest sites as follows.
Recall columns and IoU are the existing helper's logged measurements,
rounded here; `skip` is its staff-exclusion count.

| Actual site in saved sheet | Glyph; box (x,y,w,h) | Recall outline | Recall glyph | IoU | skip | svc-28 outcome |
| --- | --- | --- | --- | --- | --- | --- |
| First upper, staff 7 | 5241; (2228,1750,22,58) | 0.883721 | 0.898925 | 0.803846 | 98 | PDF evidence rejected; no saved RestInter |
| First lower, staff 8 | 5242; (2228,1958,22,58) | 0.907368 | 0.909283 | 0.832046 | 98 | PDF evidence rejected; no saved RestInter |
| Second upper, staff 7 | 5243; (2318,1750,22,59) | 0.921277 | 0.903967 | 0.839147 | 98 | PDF evidence rejected; ordinary rest 5330 survives |
| Second lower, staff 8 | 5244; (2318,1958,22,59) | 0.946921 | 0.912065 | 0.867704 | 96 | `factory next`; ordinary rest 5331 survives |

There is a locator-label discrepancy in the host prose: it calls rejected
5241 the first lower rest. In this exact saved XML, 5241 is upper and 5242
is lower. The log's rejection values and the host's failure verdict stand;
bind the next run by source paint and actual box/staff, never by a reused
numeric ID. The accepted 5244 remains the already recognized second lower
rest and is not evidence of either missing first rest being recovered.

The concrete mismatch is visible in current source:
`PdfQuarterRestHints.toSheetPath` calls `PdfClefHints.pdfToSheet`, which
sets `sx = sheetWidth / pageBox.width` and
`sy = sheetHeight / pageBox.height`. For this page those are
**4.1666666667** and **4.1654040404** pixels/point.
`PdfQuarterRestHints.measure` then uses strict pixel-center containment
with no dilation. The small geometric displacement therefore changes
foreground intersections directly.

Static `javap -c -p` inspection of the locally extracted stock 5.11.0
distribution establishes the other side of the mismatch. No recognition
was executed. `ImageLoading$PdfboxLoader.getImage` passes the configured
DPI to PDFBox's `renderImageWithDPI` with antialiasing off; the default
`pdfResolution` is 300. PDFBox 3.0.6 divides by `72.0f`, floors the
float dimension products to allocate the image, but uses the original
float scale in `Graphics2D.scale`. `PageDrawer.drawPage` translates by
the PDF crop height, flips y and subtracts the crop origin.

At 300 DPI the drawing scale is **4.166666507720947**. The float canvas
products are **2550.0** and **3299.999755859375**, explaining the
2550×3299 allocation without a corresponding change in drawing scale.
For this zero-origin, unrotated page:

```text
current hint y = (792 - pdfY) * (3299 / 792)
loader      y = (792 - pdfY) * float(300 / 72.0f)
```

At the first upper text origin, loader y exceeds hint y by approximately
**0.5401 px**; at the lower origin, by **0.6033 px**. The difference varies
with page ordinate, so a universal half-pixel shift is not the correction.
These are transform calculations, not new recall/IoU measurements. The
static distribution was extracted during cycle 15; its inspected
`ImageLoading$PdfboxLoader.class` SHA256 is
`d0e3e8202fcfc5e5a5008ad9d681f2dbfa0dc61bd09aaf5324eba6fff97698ef`,
and `pdfbox-3.0.6.jar` SHA256 is
`87b9122b78f521fef83e2806d98e7e483e049f087ea6267b72d319f672019101`.
The current Dockerfile does not replace this loader. The host must still
confirm the actual svc-28 loader/configuration binding; these local
inspections do not claim fresh container provenance.

Grok's implementation contract is bounded to the following work:

1. Correct **only the named-quarter-rest evidence transform**, principally
   in `PdfQuarterRestHints.java`, with the smallest necessary input plumbing
   in `SymbolsBuilder.java`, matching patch/build/provenance wiring and
   focused controls. Reconstruct or obtain the actual loader transform from
   the source page and effective rendering configuration. Preserve float
   DPI-scale semantics, crop origin, y inversion and rounding semantics.
   Use image dimensions to verify the expected canvas, not to estimate the
   drawing scale. Do not hardcode 3299, 3300, page dimensions, coordinates,
   glyph IDs, piece names, or a fitted translation. Do not alter
   `PdfClefHints.pdfToSheet` or its existing clef callers. Keep the actual
   PDF loader, page pixels, resolution and binarization unchanged.

2. Require demonstrated correspondence between that source render and the
   current sheet. Missing effective configuration, unsupported crop/rotation,
   resampling or preprocessing transforms must not trigger a guessed
   registration or a search for a passing alignment. Keep existing named
   `rests.2`, embedded outline, visible-paint, staff and unique-glyph
   requirements. Geometry supported by this correction must follow from
   rendering provenance, independently of the candidate's desired score.
   Reuse no evidence from another source/page or rendering configuration.

3. Keep pixel-center sampling, existing staff exclusion and all agreement
   minima unchanged: **recall outline ≥0.90, recall glyph ≥0.90,
   IoU ≥0.85**. No dilation, erosion, blur, neighbor-rest template, raster
   offset sweep, best-of-transform selection or per-piece tolerance.
   Log old versus corrected matrices, both outline bounds, actual glyph
   bounds, counts, exclusions and exact ratios for all four target sites.
   A verification calculation must also cover the full union of outline
   and glyph support, with the same symmetric staff exclusion: current
   `measure` visits only the outline bounding box and must not hide glyph
   ink outside it in the evidence report. Both first rests must clear the
   locked minima on that complete accounting as well. This is a check on
   the claimed evidence, not permission for a second recognition repair.
   If the coordinate correction alone is insufficient, report the residual
   disagreement and stop this candidate; do not change sampling or thresholds.

4. Retain the current evidence confidence
   `min(recallOutline, recallGlyph, IoU)` without clamping. Feed a qualifying
   evaluation through the existing SYMBOLS producer, ordinary factory,
   intrinsic scaling, exclusions, LINKS cleanup and RHYTHMS. Leave
   `Grades.symbolMinGrade`, `Grades.minContextualGrade` and every other
   acceptance policy unchanged. No manual/frozen rest, cleanup exemption,
   direct insertion or post-cleanup resurrection. No source evidence means
   the original raster treatment, including the historical below-gate first
   lower rest. Preserve competitors and single interpretations for the
   second rests; a `factory next` log alone is insufficient proof.

5. Keep the parser, `buildScoreData`, scorer/eval code, warnings, reference
   and corpus pins, floors, allowances and deployed generation unchanged.
   **Do not restore patch 0006. Do not touch Schumann pickup/end pins.**
   Preserve accepted clef, ledger, dot, tuplet and internal-barline work,
   including Schumann Op. 68/5's correctly timed m8 separator. Keep
   `lyrics=false`, `implicitTuplets=true`, `fingerings=true`. Use a fresh
   engine version, svc-29 if available, with matching declared/observed
   provenance. Do not add another piece target or a duration/voice repair.

Focused controls must discriminate rounded-canvas scaling from actual
render scaling, including this 612×792 page and a case with exactly
integral canvas dimensions. Include supported crop translation with known
render metadata and rejection of inconsistent dimensions/configuration.
Use the actual source reader, embedded outline and saved ink for the two
first rests; keep both second rests as preservation/duplicate controls.
Wrong-page/outline, blank or erased rest ink, non-rest shapes, invisible or
occluded paint and unsupported transforms must not gain evidence. Keep
the cycle 22 source-identity and ambiguity protections. Air's accepted
rests are regression controls for the same rule, not a second target.
Grok may implement static/helper controls; the host owns all Audiveris
lifecycle runs, including repeated processing and saved-OMR reload/export.

The host must trace both first rests through **SYMBOLS → LINKS → RHYTHMS
→ saved OMR → reload/export**. Their printed quarter offsets are **1**
(beat 2). The already recognized second rests then belong at offset **2**
(beat 3). At divisions-per-quarter 4, each staff must have its unchanged
quarter sound at cursor 0, two ordinary quarter rests at cursors 4 and 8,
and extent 12. Retain all four pitched note elements and the real final
barline. Require source-correct m34 and clearing of `measure_underfull`;
parser padding to three quarters, an invented trailing rest, or recovering
only one staff does not satisfy this contract. If both rests survive but
ordinary rhythm still fails, stop and record that separate blocker.

Prediction, contingent on the evidence gates and normal lifecycle:
Invention 8 becomes **PASS**, retains 34 bars, 1 missing / 0 extra,
592/598 exact and 590/598 on-grid. With other pieces unchanged, the suite
becomes **10/16**, with the same 5,996 notes and 78 missing / 121 extra.
This document accepts no new pass. Require a newly completed full
16-piece official report on byte-identical pins and unchanged scorer,
matching source/build provenance. `BENCH_EXIT=1` remains expected for an
unfinished 10/16 suite; a partial, stale or exceptional run is not evidence.
Inspect and attribute every other changed piece to this same transform
rule before crediting a gain.

Kill the candidate if either first rest misses any locked ink minimum,
fails normal creation/cleanup, or fails to survive at its correct printed
position through reload/export; if rests duplicate or existing symbols
change without matching source evidence; if the result needs altered
sampling, thresholds, fabricated timing, warning suppression or pin changes;
or if any current passer goes red. Protect all **nine** current passes:
Czerny 821/1, BWV 999, Anh. 114, Anh. 115, Anh. 116, Burgmüller Op. 100/2,
Schumann Op. 68/1, Chopin Op. 28/4, and newly green Air Anh. 131.

Astra inspected existing documents, source, PDF streams, PNG dimensions,
saved OMR/MusicXML, logs and local bytecode. No candidate matcher or new
ink scores were run; no engine/parser/scorer/pin/floor file was edited;
no Audiveris, Docker, npm eval or implementation commit was performed.
Pre-existing dirty benchmark reports were left untouched. The only new
deliverable is this hypothesis and its identical copy in the host docs store.
