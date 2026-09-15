# OMR RSI cycle 27 — BWV 939's printed ties lose their curve, so held notes re-attack

**One piece, one ink-level cause, one implementation contract for Grok.**
Implementation and official host validation are pending. Under the
[locked split](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/omr-rsi-split-loop.md),
Grok implements on `mh/omr-rsi-notes-fixes-c12b` / PR 41; the host alone
runs Audiveris, Docker and the official benchmark. Fable wrote this packet
from the official svc-32 table and the cycle 24–26 record only. No
artifact, log, PDF stream or bytecode was opened for this cycle; every
site-level claim below is therefore a **localization requirement for
Grok and the host**, not measured evidence.

## Starting truth and target

Accept the [official svc-32 table](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/rsi-split-loop-bench.md),
generated **2026-09-15T00:06:22.788Z**, and the
[cycle 26 host verdict](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/omr-rsi-cycle-26-host.md):
**10/16**, engine **`audiveris-5.11.0+svc-32`**, HEAD **`fbb98e1`**,
**5,996 reference notes, 74 missing / 121 extra**, pitch 98.2%, exact
97.4%, on-grid 96.6%. `bench.json` SHA256
`d9d59a63ce494b33cf7d7ba388446a64401d180a67accc405a83fd4cf6370ffd`.
All ten protected passers stayed green.

**Cycle 26 is a partial Satie repair, not a gate flip.** Satie moved to
exact 94.1%, on-grid 90.8%, overfull 3 of 65; it still fails attack-grid
and bar-length. Keep svc-32. Do not retry the m53 last-line staff
fallback, the cycle 25 opening-3/4 header-time reservation, or the
cycle 24 Invention 1 clef/beam coexistence rule. Satie, Invention 1, WTC I
Prelude 1 and Für Elise each carry several independent failures and are
not this cycle's target.

Cycle 27 targets only **Bach, Little Prelude in C, BWV 939 (piece id
`bach-prelude-bwv939`), one page, 179 reference notes.** Its official
svc-32 row is the cleanest fail in the suite:

| Check | svc-32 value | Floor / allowance |
| --- | --- | --- |
| pitch | 100.0% | — |
| attack-grid exact | 100.0% | ≥ 95.0% |
| note-length on-grid | 95.0% | ≥ 90.0% |
| notes-present | 0 missing | 1 allowed |
| no-invented-notes | **16 extra, 12 explained by printed ornaments** | **1 allowed** |
| bar-length | all bars printed length | — |

Exactly one check fails. Twelve of the sixteen extras are already
attributed to printed ornaments and are not a defect. The gap is the
**four residual extra attacks**, against an allowance of one. Removing
three of them flips this piece; removing all four leaves one spare.

## One hypothesis

**Printed ties in BWV 939 are painted as ordinary filled curve paths
between two same-pitch heads. At the sites of the residual extras the
tie curve is not recognized as a tie binding those two heads, so the
second head is exported as a fresh attack. That alone produces an extra
attack with zero missing notes, unchanged pitch, unchanged attack grid,
and a shortened first note.** Every number in the svc-32 row is
consistent with this single cause and inconsistent with the usual
alternatives: a false notehead would need pitch or grid damage; a
missed rest would alter bar lengths; an ornament extra is already
counted as explained. The on-grid deficit of about nine notes out of
179 is the shortened-first-half side of the same tie loss, plus ornament
lengths.

The proposed change is one narrowly guarded **source-confirmed tie
evidence route**, modeled on the accepted named-quarter-rest and
named-clef PDF hint helpers: when the PDF paints a visible filled curve
whose two endpoints land on two already recognized heads of identical
staff step and accidental state, in the same staff, with no head between
them at that pitch, and the raster tie/slur pipeline has produced no
curve owning that ink, supply the ordinary tie evidence for that curve
through the existing slur/tie machinery. Do not merge notes, rewrite
durations, add a tie to the export directly, or infer ties from
same-pitch adjacency without painted curve ink.

Localization precedes implementation. Grok's first deliverable is a
read-only binding of all four residual extras in the current svc-32
BWV 939 artifact to their printed sites. If fewer than three of the four
sit on printed tie ink whose curve is absent from the final graph, this
candidate is killed at that step and the report names the actual cause.

## Evidence to bind (Grok, read-only, before any code)

Pinned PDF: `services/omr-service/eval/cache/downloads/bach-prelude-bwv939.pdf`.
Current artifact directory: the svc-32 entry under
`services/omr-service/eval/cache/artifacts/<pdf-sha256>-audiveris-5.11.0+svc-32-<options-hash>/`
whose `meta.json` declares and observes svc-32 with `lyrics=false`,
`implicitTuplets=true`, `fingerings=true`. Record the PDF SHA256 and the
SHA256 of `omr-eval-input.omr`, `sheet#1/sheet#1.xml`, `sheet#1/BINARY.png`,
`omr-eval-input.mxl`, its root MusicXML and `audiveris.log` in the
implementation report exactly as cycles 24–26 did.

Required localization table, one row per residual extra:

| Column | Content |
| --- | --- |
| Scorer site | printed bar, staff, quarter offset and pitch of the extra attack from the eval's per-note diff (not from MIDI) |
| Reference | the reference note it duplicates and that note's printed length |
| PDF paint | the filled curve path in the page content stream that spans the two heads, with its CTM, fill rule and visibility |
| Raster | the BINARY ink component(s) of that curve and whether CURVES/`SlursBuilder` created any `SlurInter` on them |
| Final graph | both `HeadInter` IDs, their chords, voices, and the absence of a tie relation |
| MusicXML | the two `<note>` elements and the absence of `<tie>` / `<tied>` |

Also record every tie the engine **did** recognize on this page; those
are the preservation controls. Use IDs as run-specific locators only.

Anticipated ink-level shapes of the loss, to be confirmed rather than
assumed: a tie whose arc grazes a staff line and is split into fragments
below the slur builder's minimum arc; a tie whose ends overlap
augmentation dots or the next bar's line; a tie across a barline; or a
tie rejected as a slur because one endpoint bound to a neighboring head.
Whichever shape appears, the repair below is the same, because it binds
on the painted path, not on the raster fragment.

## One implementation contract for Grok

1. **Add one helper, proposed `sheet/curve/PdfTieHints.java`, and the
   minimal hook in the CURVES slur stage** (`SlursBuilder` or the point
   at which slur candidates are finalized, whichever is the single
   existing seam that already owns tie/slur creation). The helper uses
   the bundled PDF reader on the book's actual source and page. It
   yields evidence only for a visible filled curve path with two
   endpoints and a single arc, painted in the same rendering pass as the
   music, under the loader's effective DPI transform, crop origin and
   y inversion exactly as the accepted quarter-rest helper applies them.
   No fitted transform, offset search or best-of-transform selection.

2. **Require both endpoints to bind to already recognized heads.** Each
   endpoint, after transform, must land within the existing slur-to-head
   link tolerance of a `HeadInter` that is already in the SIG. Both heads
   must be on the same staff, have the same staff step and octave, and
   be in consecutive chords of one voice or in adjacent chords with no
   intervening head of that pitch. A same-pitch pair without a painted
   curve is not a tie. A painted curve whose endpoints bind to
   different-pitch heads is a slur and takes the unchanged path.

3. **Prove the source ink against the page before granting evidence.**
   Measure the full painted curve support against the untrimmed
   staff-free raster components it covers, with the existing symmetric
   staff-line exclusion and pixel-center sampling: **recall outline
   ≥ 0.90, recall glyph ≥ 0.90, IoU ≥ 0.85**, confidence
   `min(recallOutline, recallGlyph, IoU)`, unchanged from the accepted
   helpers. Count over the complete union including raster ink outside
   the outline bounds. A tie whose raster ink was partly erased as a
   staff line is expected to pass on the surviving ink only if the
   minima still hold; **if they do not, stop and report; do not lower
   the minima, dilate, erode, clip, or split components.**

4. **A qualified curve supplies only the ordinary `SlurInter` creation
   with tie classification through the existing slur/tie path**, with
   its normal head relations, grade from the measured confidence, and
   normal exclusion, LINKS cleanup, RHYTHMS and export. The exporter
   emits `<tie>` / `<tied>` from the ordinary tie relation. No manual or
   frozen inter, no duration rewrite, no note merge in `buildScoreData`,
   no direct MusicXML edit, no late resurrection. If the ordinary slur
   path refuses the curve for a separate reason, record that blocker
   and stop. Failed or unavailable evidence returns the original CURVES
   result with no graph, bounds or relation mutation. Repeated
   processing or reload must not duplicate a tie. An already recognized
   tie on the same heads must remain single.

5. **Limit changes to the helper, the minimal CURVES hook, tracing,
   focused controls, and reproducible patch/build/provenance wiring.**
   Use a fresh engine revision, **svc-33 if available**, preserving all
   accepted svc-32 work and the deployed generation. Do not select by
   filename, source hash, piece, bar number, coordinates, glyph ID, font
   subset prefix, reference pitch or MIDI. Evidence must belong to the
   current source, page and render.

6. Leave engine algorithms outside that seam, parser, `buildScoreData`,
   exporter, scorer/eval, warning policy, corpus/reference pins, floors
   and allowances unchanged. **Do not restore patch 0006. Do not touch
   Schumann pickup/end pins or its accepted m8 separator.** Keep the
   quarter-rest helper, its loader-scale correction and its ink minima
   unchanged. Keep `lyrics=false`, `implicitTuplets=true`,
   `fingerings=true`, raster resolution and preprocessing unchanged. No
   ornament expansion change, rest, meter, key, clef, beam, voice or
   slot heuristic is authorized by this packet.

## Discriminating controls and host acceptance

Grok's controls must exercise the actual source reader, the real painted
curves and the saved BINARY ink, not hand-authored boxes. Positive
controls: each residual-extra site, showing old absence and new
unambiguous binding, followed by all unchanged ink tests with exact
numerators, denominators, exclusions, both endpoints, bound heads,
confidence and the ordinary slur outcome. Preservation controls: every
tie and every slur the engine already recognizes on the BWV 939 page,
plus at least one recognized tie and one phrasing slur on a protected
passer with ties (Air Anh. 131 or Chopin Op. 28/4). Negative controls:
a slur between different pitches, a curve with one endpoint on nothing,
a curve spanning a third head of the same pitch, erased or blank curve
ink, wrong source or page, unsupported transform, a hairpin or
bracket line, a curve painted but clipped invisible, and the same pair
processed twice. Removing PDF evidence must restore the original
raster treatment.

The host binds a svc-32 control and the fresh candidate to the same
source, options and actual loaded classes. The decisive comparison is
each residual-extra site immediately after CURVES: control has no curve
owning the painted tie ink; candidate has one ordinary tie `SlurInter`
bound to the two heads. Trace SYMBOLS → LINKS → RHYTHMS → saved OMR →
reload/export with source-bound object continuity. A `hint accepted`
log alone is insufficient.

Required local result on BWV 939:

- At each qualified site, the two heads are joined by one ordinary tie;
  MusicXML carries `<tie>`/`<tied>` and the play-along export produces
  one attack of the combined length at the first head's offset.
- Every pitched element, ornament, accidental, dot, stem, beam, barline
  and existing slur/tie on the page is preserved. Bar lengths stay at
  printed length.
- No note is invented, moved or repitched. Missing stays 0.

**Conditional prediction.** If at least three of the four residual
extras are printed-tie continuations and all qualify, BWV 939's
unexplained extras fall to ≤ 1, `no-invented-notes` passes, and the
piece passes: **11/16**, suite extras 121 → ≤ 118, missing 74 unchanged,
on-grid rising slightly with the restored first-note lengths. If only
two qualify, BWV 939 stays FAIL at 10/16 with a documented residual. If
localization shows the residual extras are not tie sites, the candidate
is killed before implementation and the report names the true cause for
cycle 28. Do not credit an unexplained aggregate gain; any change on a
piece other than BWV 939 needs its own source/graph attribution to the
same tie rule.

Require a newly completed **full 16-piece official report** with
identical pins, scorer/options and matched declared/observed engine
provenance. `BENCH_EXIT=1` remains expected for an unfinished suite. A
stale or partial report, exception, absent trace, or forced tie is not
acceptance.

Kill the candidate if fewer than three residual extras localize to
printed tie ink; if any bound curve fails the ink minima; if the
ordinary slur/tie path cannot own the evidence without a grade override
or frozen inter; if any genuine slur becomes a tie or any tie is lost;
if implementation needs a second repair, lower thresholds, changed pins
or suppressed warnings; or if any protected passer turns red. Protect
all **ten**: **Czerny 821/1, Air Anh. 131, BWV 999, Anh. 114, Anh. 115,
Anh. 116, Burgmüller Op. 100/2, Schumann Op. 68/1, Chopin Op. 28/4 and
Invention 8.**

## Fable handoff

Fable read the official svc-32 table, the FAIL extract, the cycle 26
host verdict and the cycle 24–26 packets. No artifact, PDF, log or
bytecode was opened; no matcher, Audiveris, Docker, npm eval or
implementation test was run. No engine, parser, scorer, pin or floor was
edited; nothing was committed. The only task writes are this hypothesis
and its identical copies in the requested host docs stores.
