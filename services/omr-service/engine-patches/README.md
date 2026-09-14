# Engine patches (Audiveris 5.11.0)

Cleffy ships stock Audiveris 5.11.0 from the official release `.deb` with a small set of
recompiled classes. This directory holds the vendored sources, the diffs against upstream, and
the reasoning. `services/omr-service/Dockerfile` applies them in the `engine` build stage.

## Provenance

| | |
| --- | --- |
| Upstream | <https://github.com/Audiveris/audiveris>, tag `5.11.0` |
| File | `app/src/main/java/org/audiveris/omr/sheet/clef/ClefBuilder.java` |
| Vendored copy | `src/org/audiveris/omr/sheet/clef/ClefBuilder.java` |
| Diff vs upstream | `0001-clefbuilder-octave-g-clef.patch` |
| Engine revision | `audiveris-5.11.0+svc-23` (`src/job.ts` `ENGINE_VERSION`; cycle 17 candidate pending host bench) |

The Czerny ottava recovery adds these engine classes:

| File | Vendored copy |
| --- | --- |
| `app/src/main/java/org/audiveris/omr/text/TextBuilder.java` | `src/org/audiveris/omr/text/TextBuilder.java` |
| `app/src/main/java/org/audiveris/omr/sig/inter/OctaveShiftInter.java` | `src/org/audiveris/omr/sig/inter/OctaveShiftInter.java` |

The combined diff for these two files is `0002-czerny-ottava.patch`. Its rule and artifact
evidence are recorded in the repository's `docs/omr-rsi-czerny-localization.md`.

These files remain pinned to Audiveris 5.11.0 and are compiled together with the existing
`ClefBuilder` patch. Each engine algorithm change receives a new engine revision and a
fresh full-corpus evaluation against the matching image.

Re-fetch the pristine file to re-derive the diff. Upstream ships CRLF and the vendored copy is
LF, so normalize before diffing or every line reads as changed:

```sh
curl -fsSL https://raw.githubusercontent.com/Audiveris/audiveris/5.11.0/app/src/main/java/org/audiveris/omr/sheet/clef/ClefBuilder.java \
    | tr -d '\r' > /tmp/ClefBuilder.upstream.java
diff -u /tmp/ClefBuilder.upstream.java src/org/audiveris/omr/sheet/clef/ClefBuilder.java
```

Patch `0001` is 271 added / 5 removed lines and changes only `ClefBuilder`.

## 0001 — octave G clefs can never win the header (`promoteOctaveClef`)

### The bug

`ClefBuilder.getBestMap()` accumulates header clef candidates into a
`Map<ClefInter.ClefKind, ClefInter>`, keeping the highest-graded candidate per key. But
`ClefInter.kindOf()` maps `G_CLEF`, `G_CLEF_SMALL`, `G_CLEF_8VA` and `G_CLEF_8VB` all onto the
same `ClefKind.TREBLE`. `GlyphCluster` evaluates every sub-combination of the header parts, so
for a staff engraved with an octave clef both readings are produced:

- the clef body alone, classified `G_CLEF`;
- the clef body **plus** the octave digit, classified `G_CLEF_8VB`.

They collide on the single `TREBLE` key, and the plain clef — a cleaner, more canonical glyph —
is always graded higher. The octave reading is therefore discarded on every page, for every
score. No `-option` reaches this: the octave shape is in the trained classifier's vocabulary and
in `HEADER_CLEF_SHAPES`, `ClefInter`'s octave arithmetic and `PartwiseBuilder`'s
`<clef-octave-change>` support it end to end; only the kind-keyed de-duplication is wrong.

Observed on `bach-prelude-bwv999` (solo guitar, G clef with an italic 8 below): all 509 notes
exported exactly +12 semitones, pitch accuracy 15.5%.

### The rule

The classifier cannot arbitrate this on confidence: measured on `bach-prelude-bwv999`, the clef
body alone reads `G_CLEF` at **0.798**, while the body-plus-digit reads `G_CLEF_8VB` at only
**0.035-0.059** — the octave shapes are rare in the training set. Preferring the higher grade is
exactly what produces the bug; preferring the octave shape unconditionally would be a hack.

What arbitrates is the engraving: **ink the plain clef reading cannot account for, sitting exactly
where an octave digit is engraved**. Octave candidates are collected in a second map keyed by
`Shape`, alongside the untouched per-kind map. After clustering, `promoteOctaveClef()` replaces the
`TREBLE` entry only if all four conditions hold:

1. **Same clef body plus extra ink.** The octave candidate's glyph strictly contains the plain
   candidate's glyph and carries strictly more weight — one reading is the other plus something.
2. **The plain reading cannot explain that extra ink.** The classifier's `G_CLEF` grade *for the
   larger glyph* must have collapsed to at most `maxPlainClefDecay` (0.5) of the grade it gave the
   contained clef body. This is the discriminating test: a clean G clef with a speck stuck to it
   still reads as a fine G clef, whereas a clef with a digit under it does not. On BWV 999 the
   plain grade drops 0.798 → 0.059-0.166, a decay of 0.07-0.21.
3. **The extra ink is placed and sized like an octave digit.** It lies beyond the staff (below the
   bottom line for `8VB`, above the top line for `8VA`) and spans between `minOctaveDigitHeight`
   and `maxOctaveDigitHeight` interlines. On BWV 999 it measures 21-22 px against a 21 px
   interline — one interline exactly.
4. **The classifier does offer the octave reading** for that larger glyph, above the usual
   `Grades.clefMinGrade` acceptance floor that `evaluate()` already applies.

This is not "prefer 8vb". A header engraved as a bare G clef produces no containing glyph at all,
condition 1 fails immediately, and the selection is bit-for-bit the stock one.

### The rank probe

Octave clefs are rare shapes, so for one and the same glyph the classifier ranks them below the
plain `G_CLEF`. `evaluateGlyph` therefore requests
`max(maxEvalRank, maxOctaveEvalRank)` = 12 evaluations instead of 3, and feeds everything past
index `maxEvalRank` to the octave map **only**. `AbstractClassifier.evaluate()` walks a sequence
sorted by descending grade and truncates at `count`, so a longer request returns the short one as
its prefix: the plain per-kind selection sees exactly the same first three evaluations it saw
before. Raising `maxEvalRank` globally instead would have changed candidate sets for ordinary
clefs too.

### New constants

| Constant | Default | Meaning |
| --- | --- | --- |
| `maxOctaveEvalRank` | 12 | How deep to look in the classifier ranking for an octave G clef |
| `maxPlainClefDecay` | 0.5 | Plain-clef grade ceiling on the larger glyph, as a ratio of the plain clef grade |
| `minOctaveDigitHeight` | 0.5 interline | Smallest extra extent that can be an octave digit |
| `maxOctaveDigitHeight` | 2.5 interline | Largest extra extent that can be an octave digit |

All four are ordinary Audiveris constants, so they are reachable from
`-option org.audiveris.omr.sheet.clef.ClefBuilder.maxOctaveEvalRank=...` for future triage.

### Logging

`promoteOctaveClef` logs at INFO — one line when an octave clef supersedes the plain one (with the
measured digit height and grade decay), one line per rejected candidate naming the condition that
failed. Both are silent on a score with ordinary clefs: the octave map stays empty and the method
returns immediately. On BWV 999 the promotion line reads

```
Staff#1 octave clef G_CLEF_8VB grade:0.035 supersedes G_CLEF grade:0.798
    (digit 21 px beyond staff, plain grade decays 0.798 -> 0.166)
```

## 0002 — recover an OCR octave mark with its printed dashed span

`TextBuilder` can retain a printed `8va` as direction text while symbol recognition
emits no octave-shift interpretation. Recovery requires the value glyph, an
interline-scaled chain of short dashes anchored beside it above the staff, and a
span reaching the system edge. Detached chains, interior spans, and existing
overlapping octave interpretations are rejected. The measured line is passed to
`OctaveShiftInter.createMeasured()`; the existing chord-linking and export paths
apply the octave. A hook is retained only when source pixels support one.

This first rule recovers Czerny Op. 821/1 measure 6. The misassigned continuation
in measure 7 remains a separate defect; this patch does not move symbols between
systems. Parser behavior, gate floors, and corpus allowances are unchanged.

## 0003 — respect a printed tuplet bracket inside a longer beam

`TupletsBuilder` previously included every chord on the smallest shared beam.
A printed triplet bracket enclosing only the final three notes of a four-note
beam was consequently rejected. The patched builder measures two bracket halves
around the recognized numeral: long horizontal strokes, outward hooks, aligned
sheet ordinates, and exactly the expected number of staff-local chord anchors.
Only that verified span limits beam siblings. Absent, mismatched, or ambiguous
brackets preserve the existing linking path.

The vendored file is `src/org/audiveris/omr/sheet/rhythm/TupletsBuilder.java`,
from the same Audiveris 5.11.0 tag. The reproducible upstream diff is
`0003-tuplet-bracket-span.patch`. Evidence and negative controls are recorded in
`docs/omr-rsi-chopin-symbol-localization.md`. No duration or pitch is inferred
from bar length, and no scoring rule changes. Revision 17 remains reserved for
the rejected option experiment; this change first shipped in revision 18.

## 0004 — retain a ledger supported by attached head and stem ink

`LedgersPostAnalysis` can discard a geometrically accepted first ledger below
a staff because its ordinate lies just beyond the learned delta distribution.
The added check retains only an upper-delta outlier whose height already passes,
whose staff distance is within 0.15 interline of one interline, and whose source
pixels contain a connected filled body with an attached stem at its edge.
Existing extraction, ledger grade, height, and other post-analysis checks remain.
Clef, text, and short-mark controls reject. No head or rhythm is synthesized;
the normal head-recognition pass consumes the retained ledger.

The vendored source is `src/org/audiveris/omr/sheet/ledger/LedgersPostAnalysis.java`
and its upstream diff is `0004-ledger-attached-head.patch`. The Invention 8
localization packet records the target and controls. This change does not fix
the separate final-bar rest omission.

`probes/EvidenceControls.java` checks the final helper on the exact Invention 8
baseline `sheet#1/BINARY.png`: the printed ledger/head, real clef/text strokes,
a short horizontal fragment, and a target copy with its stem erased. Compile
the probe against the patched jar and run its
`org.audiveris.omr.sheet.ledger.EvidenceControls` class with the PNG path.
It fails if any expected positive or negative result changes. This is a manual
engine probe; CI does not run Audiveris.

## 0005 — rejected horizontal slur-head concavity experiment

Cycle 14 changed horizontal slur concavity to use the physical head center.
The official host suite stayed at 7/16 and removed one real BWV 939 A4 extra,
but its incidental Anh. 116 m24 gain depended on reading accidental parentheses
as a musical slur. Visual attribution triggered the no-invented-curves kill
criterion. The override and Docker compilation entry are reverted; commit
`f7211aa` retains the rejected source and patch. Svc-20 remains reserved.
See `docs/omr-rsi-cycle-14.md` for the host numbers, artifact identities, and
rejection. Cycle 15 tested its rest hypothesis on accepted svc-19 recognition behavior
and is also now closed without acceptance.

## 0006 — closed quarter-rest template experiment

Cycle 15 tried corroborating weak quarter-rest classifications using strongly
classified same-page masks. The official result supplied for `98450f5` remains
7/16, with Air still failing `measure_underfull` and attack-grid at 94.8%.
The primary-rest recovery acceptance criterion is unmet. The two source
classes, patch, standalone controls/fixture, and Docker compile entries are
removed; commit `72bd29b` preserves them. Svc-21 remains reserved.

The earlier provenance discrepancy and the final supplied result are recorded
in `docs/omr-rsi-cycle-15.md`. This closes the candidate without acceptance;
it does not claim verified execution disproved the algorithm. The container
and cache provenance checks from `98450f5` remain. The host must select the
new matching image before producing official artifacts, and an engine
mismatch must not be reported using an older suite table.

## 0007 — reject a ledger fragment as an augmentation dot

Anh. 116 m23 contains a false augmentation dot at the left end of the next
note's printed ledger. It makes the preceding eighth dotted, after which the
ordinary tuplet collector rejects the actual printed triplet as too long.
Cycle 16 rejects that dot at `DotFactory.checkDistanceToConcreteLine()` only
when original BINARY pixels establish an uninterrupted ledger through a
neighboring head outside the staff, with thin protrusions on both sides.
The printed tuplet follows the existing symbol and rhythm paths unchanged.

The vendored `sheet/symbol/DotFactory.java` and new dependency-free
`sheet/symbol/LedgerFragmentEvidence.java` are reproduced by
`0007-ledger-fragment-dot.patch` against the same upstream 5.11.0 tag.

This candidate changes neither rhythm arithmetic nor classification grades.
It does not inspect score IDs, reference notes, bar lengths, or desired
outcomes. Real detached dots are required negative controls; a dot removed
without ledger-ink evidence or any protected pass regression kills the
candidate. Source evidence, controls, and pending host attribution are in
`docs/omr-rsi-cycle-16.md`. Svc-22 requires a matching engine build and fresh
host artifacts. The implementer performs source and standalone checks only.

The standalone controls run without engine dependencies from the service
directory; fixtures are committed and need no cached score or engine process:

```sh
javac -d /tmp/cleffy-ledger-dot-controls \
  engine-patches/src/org/audiveris/omr/sheet/symbol/LedgerFragmentEvidence.java \
  engine-patches/probes/LedgerFragmentEvidenceControls.java
java -cp /tmp/cleffy-ledger-dot-controls \
  org.audiveris.omr.sheet.symbol.LedgerFragmentEvidenceControls
```

The target and four real-dot crops live under `probes/fixtures/`;
`ledger-dot-provenance.json` records source hashes, crop origins, actual head
bounds, and exact dot ink counts. Tests verify
nonempty exact dot masks, actual target translation, a cut connector,
detached flat marks, wrong ordinate, absent or thick opposite protrusions,
and rounded dots. The real-dot tests deliberately supply an adverse
hypothetical neighboring head; no artificial ink is added to those crops.

## 0008 — recover a named PDF change-clef before HEADS

LilyPond PDFs name inline change clefs `clefs.G_change` / `clefs.F_change` in the
embedded music font. The raster classifier can miss those fragments, so the
opening staff keeps the header F/G. Cycle 17 reads the book's source page with
the bundled PDFBox API after header selection in `ClefBuilder.Column.selectClefs()`
and before HEADS. Only those two encoding names in an embedded vector font are
admitted. Ordinary header G/F glyphs stay on the existing path. Missing outlines,
invisible text, rotation, shear, reduced clipping and blank ink fall through.

The helper is `sheet/clef/PdfClefHints.java`. The vendored `ClefBuilder` hook
does not call `findClefs()` / `registerClefs()` and does not move `clefStop`.
An existing same-staff `ClefInter`, including G/F octave variants, is never
duplicated, moved, replaced or downgraded. Grade comes from outline-clipped
staff-free ink, not from the weak raster compound. Source evidence, controls
and pending host attribution are in `docs/omr-rsi-cycle-17.md`. Svc-23
requires a matching engine build and fresh host artifacts.

The standalone controls compile the helper against PDFBox 3.0.6 (the version
Audiveris 5.11.0 bundles) from the service directory:

```sh
javac -cp "$PDFBOX:$FONTBOX:$PDFBOX_IO:$COMMONS_LOGGING" \
  -d /tmp/cleffy-pdf-clef-controls \
  engine-patches/src/org/audiveris/omr/sheet/clef/PdfClefHints.java \
  engine-patches/probes/PdfClefHintControls.java
java -cp "/tmp/cleffy-pdf-clef-controls:$PDFBOX:$FONTBOX:$PDFBOX_IO:$COMMONS_LOGGING" \
  org.audiveris.omr.sheet.clef.PdfClefHintControls \
  [optional-schumann.pdf]
```

## How the patches are applied

Two `Dockerfile` stages:

1. Stage `audiveris-dist` (`node:22-bookworm-slim`) — `dpkg -x` the official `.deb` into
   `/opt/audiveris-root`, exactly as the runtime stage used to. It stays on the Debian base
   because the bundled JRE's `legal/` tree is hard-linked and `dpkg -x` on the Ubuntu-noble JDK
   image fails those with ENOSYS when the amd64 build is emulated on an arm64 host.
2. Stage `engine` (`eclipse-temurin:25-jdk`) — the jar's classes are major version 69 (Java 25)
   and the `.deb`'s bundled jpackage runtime is Zulu 25, so the patch is compiled with
   `--release 25`:
   - `javac` the vendored classes against `lib/app/audiveris.jar` plus the rest of `lib/app/*`;
   - `jar uf audiveris.jar org` — the recompiled classes and their inner classes
     replace the shipped ones **inside** the jar;
   - `javap` checks `promoteOctaveClef`, `createMeasured`, `findBracketSpan`,
     `hasAttachedHeadStemInk`, `isUnrecognizedLedgerFragment`, `isFragment`,
     `installPdfChangeClefs`, and `PdfClefHints.scan`,
     failing the build if an update did not land.

The runtime stage then `COPY --from=engine /opt/audiveris-root`. The launcher, its
`Audiveris.cfg` classpath and the bundled JRE are untouched, so nothing here has to be redone
when the classpath changes — but an Audiveris version bump **must** re-derive this patch against
the new upstream file.
