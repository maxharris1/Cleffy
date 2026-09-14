# Engine patches (Audiveris 5.11.0)

Cleffy ships stock Audiveris 5.11.0 from the official release `.deb` with exactly one
recompiled class. This directory holds the vendored source, the diff against upstream, and
the reasoning. `services/omr-service/Dockerfile` applies it in the `engine` build stage.

## Provenance

| | |
| --- | --- |
| Upstream | <https://github.com/Audiveris/audiveris>, tag `5.11.0` |
| File | `app/src/main/java/org/audiveris/omr/sheet/clef/ClefBuilder.java` |
| Vendored copy | `src/org/audiveris/omr/sheet/clef/ClefBuilder.java` |
| Diff vs upstream | `0001-clefbuilder-octave-g-clef.patch` |
| Engine revision | `audiveris-5.11.0+svc-15` (`src/job.ts` `ENGINE_VERSION`) |

Re-fetch the pristine file to re-derive the diff. Upstream ships CRLF and the vendored copy is
LF, so normalize before diffing or every line reads as changed:

```sh
curl -fsSL https://raw.githubusercontent.com/Audiveris/audiveris/5.11.0/app/src/main/java/org/audiveris/omr/sheet/clef/ClefBuilder.java \
    | tr -d '\r' > /tmp/ClefBuilder.upstream.java
diff -u /tmp/ClefBuilder.upstream.java src/org/audiveris/omr/sheet/clef/ClefBuilder.java
```

The checked-in diff is 271 added / 5 removed lines; nothing outside `ClefBuilder` is touched.

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

## How the patch is applied

Two `Dockerfile` stages:

1. Stage `audiveris-dist` (`node:22-bookworm-slim`) — `dpkg -x` the official `.deb` into
   `/opt/audiveris-root`, exactly as the runtime stage used to. It stays on the Debian base
   because the bundled JRE's `legal/` tree is hard-linked and `dpkg -x` on the Ubuntu-noble JDK
   image fails those with ENOSYS when the amd64 build is emulated on an arm64 host.
2. Stage `engine` (`eclipse-temurin:25-jdk`) — the jar's classes are major version 69 (Java 25)
   and the `.deb`'s bundled jpackage runtime is Zulu 25, so the patch is compiled with
   `--release 25`:
   - `javac` the vendored file against `lib/app/audiveris.jar` plus the rest of `lib/app/*`;
   - `jar uf audiveris.jar org` — the recompiled `ClefBuilder.class` and its four inner classes
     replace the shipped ones **inside** the jar;
   - `javap | grep promoteOctaveClef` — the build fails loudly if the update did not land.

The runtime stage then `COPY --from=engine /opt/audiveris-root`. The launcher, its
`Audiveris.cfg` classpath and the bundled JRE are untouched, so nothing here has to be redone
when the classpath changes — but an Audiveris version bump **must** re-derive this patch against
the new upstream file.
