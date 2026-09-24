# Engine patches (Audiveris 5.11.0)

Product OMR image: raster-honest patches **0001, 0002, 0003, 0004, 0007** only.
`services/omr-service/Dockerfile` recompiles the classes those five diffs touch
and injects them into the official 5.11.0 `audiveris.jar`. Vector-hint patches
(`Pdf*Hints` 0008/0010/0013–0018) and the internal-double-bar family (0009–0012)
are not in this image.

Engine revision: `audiveris-5.11.0+svc-34` (`src/job.ts` `ENGINE_VERSION`).

## Provenance

| | |
| --- | --- |
| Upstream | <https://github.com/Audiveris/audiveris>, tag `5.11.0` |

Re-fetch a pristine file to re-derive a diff. Upstream ships CRLF and the vendored
copy is LF, so normalize before diffing:

```sh
curl -fsSL https://raw.githubusercontent.com/Audiveris/audiveris/5.11.0/app/src/main/java/org/audiveris/omr/sheet/clef/ClefBuilder.java \
    | tr -d '\r' > /tmp/ClefBuilder.upstream.java
diff -u /tmp/ClefBuilder.upstream.java src/org/audiveris/omr/sheet/clef/ClefBuilder.java
```

## 0001 — octave G clefs can never win the header (`promoteOctaveClef`)

`ClefBuilder.getBestMap()` keys header candidates by `ClefKind`. `ClefInter.kindOf()`
maps `G_CLEF`, `G_CLEF_8VA` and `G_CLEF_8VB` onto `TREBLE`, so the cleaner plain
clef always wins. `promoteOctaveClef` lets the octave reading supersede only when
the larger glyph strictly contains the plain clef, the plain grade collapses on
that extra ink, and the extra ink sits beyond the staff at octave-digit size.

Vendored: `src/org/audiveris/omr/sheet/clef/ClefBuilder.java`
Diff: `0001-clefbuilder-octave-g-clef.patch`

## 0002 — recover an OCR octave mark with its printed dashed span

`TextBuilder` can retain printed `8va` as direction text with no octave-shift
interpretation. Recovery requires the value glyph, an interline-scaled dashed
chain above the staff, and a span to the system edge. The measured line goes to
`OctaveShiftInter.createMeasured()`.

Vendored: `src/org/audiveris/omr/text/TextBuilder.java`,
`src/org/audiveris/omr/sig/inter/OctaveShiftInter.java`
Diff: `0002-czerny-ottava.patch`

## 0003 — respect a printed tuplet bracket inside a longer beam

`TupletsBuilder` used every chord on the smallest shared beam. The patched
builder measures two bracket halves around the numeral and, when that span is
unambiguous, limits anchors to it. Absent or mismatched brackets keep the
historical path.

Vendored: `src/org/audiveris/omr/sheet/rhythm/TupletsBuilder.java`
Diff: `0003-tuplet-bracket-span.patch`

## 0004 — retain a ledger supported by attached head and stem ink

`LedgersPostAnalysis` can discard a geometrically accepted first ledger below a
staff. The added check retains an upper-delta outlier only when BINARY pixels
contain a connected filled body with an attached stem. No head or rhythm is
synthesized.

Vendored: `src/org/audiveris/omr/sheet/ledger/LedgersPostAnalysis.java`
Diff: `0004-ledger-attached-head.patch`

## 0007 — reject a ledger fragment as an augmentation dot

A leftover ledger fragment can be classified as a dot and break the following
tuplet. `DotFactory` rejects that candidate only when BINARY pixels establish an
uninterrupted ledger through a neighboring head, with thin protrusions on both
sides. Detached dots cannot satisfy the test.

Vendored: `src/org/audiveris/omr/sheet/symbol/DotFactory.java`,
`src/org/audiveris/omr/sheet/symbol/LedgerFragmentEvidence.java`
Diff: `0007-ledger-fragment-dot.patch`

## How the patches are applied

Two `Dockerfile` stages:

1. Stage `audiveris-dist` (`node:22-bookworm-slim`) — `dpkg -x` the official `.deb`.
2. Stage `engine` (`eclipse-temurin:25-jdk`) — `javac --release 25` only the seven
   classes listed above against `lib/app/audiveris.jar`, then `jar uf` them into
   the jar. `javap` checks `promoteOctaveClef`, `createMeasured`, `findBracketSpan`,
   `hasAttachedHeadStemInk`, `isUnrecognizedLedgerFragment`, and `isFragment`.

The runtime stage `COPY --from=engine /opt/audiveris-root`. An Audiveris version
bump must re-derive these diffs against the new upstream files.
