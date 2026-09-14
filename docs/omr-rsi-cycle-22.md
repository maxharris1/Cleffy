# OMR RSI cycle 22 — Invention 8's printed quarter rests

**One hypothesis for Grok; implementation and official host validation
pending.** Astra performs read-only localization and documentation only.
Grok implements on `mh/omr-rsi-notes-fixes-c12b` (PR 41); the host alone
runs Audiveris, Docker and the official bench. The current user instruction
and [split loop](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/omr-rsi-split-loop.md)
override the older pass-all plan's implementer orchestration.

## Starting truth and target

[Cycle 21](omr-rsi-cycle-21.md#official-result-and-evidence-bounded-verdict--2026-09-14)
credits Schumann's single middle `light-light` at two quarters in m8.
HEAD `5fded59`, engine `audiveris-5.11.0+svc-27`, container
`cleffy-rsi-omr-27`, report generated `2026-09-14T21:23:59.559Z`:
**8/16**, **5,996 notes**, pitch **98.182%**, exact **96.831%**, on-grid
**96.181%**, **78 missing / 121 extra**. `bench.json` SHA256:
`0ffbd4224c6ab1f3c99a2c95b299a8b6a65e68a935830ad898592e4b0164af0a`.
All eight protected passes remain green; **no pass-count change is
accepted for cycle 21**. Its repeated lifecycle controls remain unproven
by the supplied report. `BENCH_EXIT=1` means the complete suite is unfinished.

Target: **Bach — Invention 8 in F, BWV 779, `bach-invention-08`, printed
m34 on page 2, final system**. Its sole current failed check is
`bar-length-warning (measure_underfull)`. It has 598 reference notes,
**1 missing / 0 extra**, pitch **597/598**, exact **592/598 = 98.9967%**,
and on-grid **590/598 = 98.6622%**. This is a source-symbol omission with
visible ink, unlike Schumann's source-versus-reference endpoint mismatch.
Schumann's pickup/end pins are outside this cycle; no pin rewrite,
endpoint exception or fabricated rest is authorized.

## One hypothesis and ink-level cause

**The first printed quarter rest after the final chord/note on each staff
of Invention 8 m34 survives in the source image but is lost in raster
symbol recognition and weak-inter cleanup. The source PDF's explicitly
named quarter-rest glyph, its painted outline and the corresponding
visible sheet ink can jointly supply recognition evidence independent of
the raster classifier
at the ordinary symbol producer, recovering both rests before rhythm
construction without lowering any classifier or cleanup threshold.**

This is one engine symbol-recognition hypothesis, restricted to the named
quarter-rest identity. It does not infer missing time from the meter or
repair the terminal measure downstream. Both staves instantiate the same
rule; recovering only one is not a complete target repair.

The [Invention 8 localization](omr-rsi-invention8-localization.md) and
[rest lifecycle packet](omr-rsi-invention8-rest-localization.md) identify
the first rest after the opening sound, **at quarter offset 1 (beat 2)**,
as omitted on each staff. The second printed rests survive but export
too early at offset 1. They should follow the recovered rests at offset 2.
Do not describe this as an absent trailing rest or insert one at the end.

The current svc-27 m34 XML, divisions-per-quarter 4, has:

| Staff | Current exported events | Printed sequence to recover |
| --- | --- | --- |
| Upper | A3/C4/F4 quarter chord at 0; one quarter rest at 1 | Same chord at 0; printed quarter rests at 1 and 2 |
| Lower | F2 quarter at 0; one quarter rest at 1 | Same F2 at 0; printed quarter rests at 1 and 2 |

The XML reaches only two quarters per staff before a genuine final
`light-heavy` line. The parser's existing padding produces a three-quarter
measure while retaining `measure_underfull`. The warning correctly
discloses an upstream defect. A three-quarter `dTicks` alone cannot prove
the rests were recovered.

The historical fresh svc-18 lifecycle trace is specific: the first upper
rest evaluates as `QUARTER_REST=0.288493371`, creates a RestInter with
intrinsic grade `0.230794697`, then is deleted during LINKS by ordinary
weak-inter cleanup (`Grades.minContextualGrade=0.5`). The lower rest's
`0.103955679` lies below `Grades.symbolMinGrade=0.15` and never creates
an inter. These are recorded historical classifier results, not a new
classifier run. They establish why dispatch-only recovery or exempting
rests from cleanup is the wrong seam.

Cycle 15's same-page quarter-rest template candidate remains **closed
without acceptance and reverted**; its provenance caveat and historical
target-only observations remain as recorded. Do not restore patch 0006
or its promotion rule. This hypothesis requires a visibly painted PDF
glyph's own identity and outline, independent of another recognized rest
or the weak classifier result. The accepted PDF change-clef approach is
prior art for source evidence, not permission to reinterpret other symbols.

## Rebound source evidence

Pinned input:
`services/omr-service/eval/cache/downloads/bach-invention-08.pdf`, SHA256
`5323449d08aa5031e974e275f182bebf8f533ecf62e5f9b0c9c36364f4b66469`.
Direct read-only decoding of this PDF establishes:

- Page 2 is object 21, MediaBox `[0 0 612 792]`, rotation 0, content
  stream 22. Font resource `/R13` is object 13, embedded
  `PERCJM+Emmentaler-20`; encoding object 38 maps character code 10 to
  **`/rests.2`**. These are fixture facts, not production selectors.
- The first lower rest is painted by a `Tj` at text origin approximately
  **(535.1566, 314.1486)** points, followed by a `Td` of `(0, 50.0623)`
  and the first upper rest at **(535.1566, 364.2109)**. The active font
  size is 19.9253. The second lower/upper pair is painted separately at
  x=556.846, y=314.148/364.2103. Text origins are not glyph bounding boxes.
- The source page visibly shows the final upper quarter chord and lower
  quarter note, each followed by **two** quarter-rest shapes before the
  final line. The named PDF paints therefore correspond to actual
  rest ink at the missing and surviving sites, not an invisible spacer.

Grok must extract the actual embedded outlines, bind their transformed
masks to the current sheet pixels and record quantitative agreement.
The paint/encoding evidence is established here; no new outline matcher,
confidence measurement or engine recovery is claimed by Astra.

Current artifact directory:

```text
services/omr-service/eval/cache/artifacts/5323449d08aa5031e974e275f182bebf8f533ecf62e5f9b0c9c36364f4b66469-audiveris-5.11.0+svc-27-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/
```

Metadata declares and observes `audiveris-5.11.0+svc-27`, with unchanged
options. Read-only hashes:

| Current artifact | SHA256 |
| --- | --- |
| `omr-eval-input.omr` | `e8a5815efb6aab34e9471e53f6d42e71abe553a847c3ca6076110ef9701a0c08` |
| `sheet#2/sheet#2.xml` | `c8a814baec4f2dd10c1f92f670929a01c0dd08872e8d4998fe68b60063e08b74` |
| `sheet#2/BINARY.png` | `17813a8cf6a4426a998c2003e58ea9f9f09d1df214899febae23d0695077d22c` |
| `omr-eval-input.mxl` | `d730de222fa7b49c9b8d73a08fe5d2d15145e8434fa37880010b34377f71479f` |
| Root MusicXML | `b85b19342cc16311aa6db7ffe599854a0fde9ce79b56caeb90e8505cbeefd24f` |

In this saved sheet, local stack 13 (printed m34) still has
`expected="3/4" duration="1/2"`. Its two slots have time offsets 0
and 1/4 whole note. The source glyphs are:

| Site | Current glyph | Sheet box (x, y, w, h) | Saved interpretation |
| --- | --- | --- | --- |
| First upper rest, staff 7 | 5240 | (2228, 1750, 22, 58) | No RestInter |
| First lower rest, staff 8 | 5241 | (2228, 1958, 22, 58) | No RestInter |
| Second upper rest, staff 7 | 5242 | (2318, 1750, 22, 59) | RestInter 5329 |
| Second lower rest, staff 8 | 5243 | (2318, 1958, 22, 59) | RestInter 5330 |

IDs differ from the historical lifecycle packet: bind controls by the
current file and actual ink, never transplant the old numeric IDs. These
coordinates and IDs are fixture locators only.
The svc-18 and svc-27 sheet-2 BINARY hashes match, and all four rest
run tables are identical after XML formatting is removed. This binds the
historical mask/classifier evidence to the current ink without claiming
that the classifier or full lifecycle was rerun this round.

## Bounded implementation contract for Grok

1. Add narrowly scoped named-quarter-rest evidence in the Audiveris
   **SYMBOLS** producer, before normal LINKS cleanup and RHYTHMS.
   Proposed helper:
   `services/omr-service/engine-patches/src/org/audiveris/omr/sheet/symbol/PdfQuarterRestHints.java`.
   Inspect the pinned 5.11.0 `SymbolsBuilder.evaluateGlyph` →
   `InterFactory.create` → `RestInter.createValid` path. A narrow hook in
   `SymbolsBuilder` may supply one source-derived ordinary `QUARTER_REST`
   evaluation for a glyph matched to a verified visible PDF paint, even
   when the raster classifier supplies no quarter-rest evaluation. This
   is necessary for the lower target. The source-derived evaluation must
   itself clear the unchanged `Grades.symbolMinGrade` before ordinary
   factory dispatch, then pass ordinary intrinsic scaling and cleanup.
   With no valid PDF evidence, do not add or promote an evaluation. Keep the current
   raster evaluations, competing interpretations and exclusion handling.
   Add only necessary source, reproducible upstream patch, focused
   controls and build/provenance wiring. Keep accepted clef, ledger, dot,
   tuplet-bracket and internal-barline repairs intact.

2. Read only the book's actual source PDF/page through bundled PDFBox.
   Resolve the embedded music font's character encoding and outline;
   initially admit only the explicitly named `rests.2` quarter-rest
   identity in the supported font family. A glyph name alone is insufficient.
   Require an actual visible paint operation, nonempty corresponding
   outline, valid PDF-to-sheet transform and agreement with the original
   sheet's rest-shaped ink. Support only transformations whose alignment
   is demonstrated; unsupported rotation, clipping, rendering modes,
   missing outlines, unresolved encodings and invisible/occluded text must
   fall through unchanged. Do not use font subset prefixes, character
   codes, fixture coordinates or IDs as recognition rules.

3. Match the outline to one unambiguous staff-local glyph/ink component.
   Measure foreground agreement in both directions, accounting explicitly
   and symmetrically for known staff-line removal. Require at least **0.90
   recall in each direction and 0.85 intersection-over-union** between
   the transformed outline mask and actual glyph ink. Document the
   rasterization and any bounded pixel tolerance; do not weaken these
   minima or tune them per piece to admit the target. A bounding-box
   overlap, a few dark pixels or a
   generously expanded mask cannot establish identity. Preserve the
   source glyph and its actual location. Require an unambiguous system,
   staff and measure association; leave rests to the ordinary rest/voice
   machinery for temporal placement. Never select an insertion site from
   a short bar, expected duration, neighboring pitches or desired note count.

4. Feed independently measured PDF/outline/ink confidence through normal
   rest creation and reduction. Document the numerical evidence-to-confidence rule
   and its positive/negative controls. Keep `Grades.symbolMinGrade`,
   `Grades.minContextualGrade`, intrinsic scaling and all other thresholds
   unchanged. Do not clamp confidence to a passing minimum, assign an
   unconditional perfect grade, mark the rest manual/frozen, bypass
   factory rejection, exempt it from LINKS, or resurrect it after cleanup.
   A weak raster result without valid PDF evidence must behave exactly
   as before; the historical below-gate lower rest is still a negative
   control in that absence-of-evidence case.

5. Prevent duplicate interpretations for a single source paint/glyph and
   preserve the already recognized second rests. Reconcile any existing
   weak interpretation before dispatch rather than creating overlapping
   RestInters or silently discarding competitors. Scope caches to the
   actual book/page/content; processing another book or a modified source
   at the same path must not reuse old evidence. Normal stored-OMR reload
   must retain the recovered ordinary glyph-backed rests without another
   insertion. Log identity, geometry, ink measurements, confidence and
   factory/cleanup outcome so the host can attribute each recovery.

6. Keep parser, `buildScoreData`, `services/omr-service/src/eval/`, warning
   policy, corpus/reference pins, allowances, floors and deployed generation
   unchanged. Preserve `lyrics=false`, `implicitTuplets=true`,
   `fingerings=true` and the existing raster resolution. Use a fresh engine
   version (`audiveris-5.11.0+svc-28` if available) with matching provenance.
   Do not add implicit-tuplet, bar-length, rest-duration or voice-repair
   logic. If normal rhythm reconstruction fails after both evidenced
   rests survive, record that independent blocker and stop.

## Controls, host prediction and kill criteria

Require both real target glyphs as positives through the actual source
reader and factory path, with the already recognized second rests as
duplicate controls. Demonstrate measured source-outline alignment rather
than passing hand-authored identity/grade inputs to a helper only.
Include supported translated/scaled geometry, wrong-page/staff matches,
blank or erased ink, incorrect outlines, non-rest glyphs, invisible or
occluded paint, unsupported transforms, competing interpretations,
duplicate processing and stored-OMR reload. A copy of the lower target
with the PDF evidence removed must still receive the original below-gate
raster treatment. Ordinary quarter rests on protected pieces must remain
single, with their printed durations and placements.

The host must show both m34 rests surviving **SYMBOLS → LINKS → RHYTHMS
→ saved OMR → reload/export**, not just a helper acceptance or a temporary
RestInter. In the export each staff must contain its unchanged quarter
sound at offset 0 and two genuine quarter rests at offsets 1 and 2,
with total extent three quarters. At divisions-per-quarter 4 those are
cursor offsets 0, 4 and 8, ending at 12. Preserve all four pitched note
elements and the final barline. Recovery of the earlier rests necessarily
repositions the surviving second rests; no pitched onset or duration
change is expected from this final-bar repair.

Predicted target result: **34 bars, unchanged 1 missing / 0 extra,
592/598 exact and 590/598 on-grid**, with `measure_underfull` cleared by
the corrected source export. If every other result is unchanged, this
would make Invention 8 a ninth pass and the suite **9/16**, still unfinished.
This is a prediction, not an accepted result. A passing gate with only one
recovered staff, an invented trailing rest or hidden padding fails the
source-fidelity contract. Other named-quarter-rest sites are observations
of this same rule, not permission for another repair; inspect and attribute
every changed piece before crediting any gain.

Only the host runs the fresh **full 16-piece** suite, with byte-identical
pinned PDFs/references and the unchanged official scorer. Require matching
declared/observed engine provenance and newly completed reports. A complete
9/16 report with `BENCH_EXIT=1` is compatible with this prediction; an
exception, stale report or partial suite is not acceptance. Do not demand
exit 0 until all 16 pieces pass, and do not claim 16/16 from this local fix.

**Kill the candidate if either primary rest is not recovered at its
producer and retained through export; if a new rest lacks matching visible
source ink; if existing rests duplicate, move incorrectly or change
duration; if pitched events, repeats, clefs, genuine bars or other markings
change without this rule's source evidence; or if reload/repeated processing
is unstable. Any currently passing piece going red kills it.** Explicitly
protect Czerny 821/1, BWV 999, Anh. 114, Anh. 115, Anh. 116,
Burgmüller Op. 100/2, Schumann Op. 68/1 and Chopin Op. 28/4, and retain
Schumann Op. 68/5's correctly timed m8 separator. Reject lowered thresholds,
floors or expanded allowances, warning suppression, pin/reference-derived
repair, invented holds/tuplets/rests and unexplained metric gains.

## Astra handoff

Astra records cycle 21 and writes this one new hypothesis. Pre-existing
dirty bench reports and `controls2.log` are left untouched. No engine or
parser code is edited; no implementation is committed; no tests, benchmark,
Audiveris or Docker are run. Grok implementation and host validation are pending.
