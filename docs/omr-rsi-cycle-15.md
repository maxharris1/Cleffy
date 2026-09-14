# OMR RSI cycle 15

**Closed without acceptance.** Cycle 16 removes patch 0006. See
[cycle 16](omr-rsi-cycle-16.md). The supplied official cycle-14 host report is
7/16, 95.41360907271515% on-grid, 117 missing and 159 extra notes. This cycle
reverts cycle 14 under its kill criteria (see the [cycle-14 ledger](omr-rsi-cycle-14.md))
and uses the locked implementer/host split: Astra and Luna implement and validate
source; the host alone runs OMR and `services/omr-service/src/eval/`.

## Supplied host result at `72bd29b`

The next official host table remains **7/16**, 95.41360907271515% on-grid,
117 missing and 159 extra notes. Every piece metric and failed check is
unchanged from the supplied svc-20 table. All seven protected passes remain
green in that official result; Air remains at 92/97 exact notes with
`measure_underfull`. No target recovery or pass flip is credited.

However, the host identifies its container as `cleffy-rsi-omr-20`, while the
new `bench.json` labels itself `audiveris-5.11.0+svc-21`. The report generated
at `2026-09-14T18:25:10.595Z` is preserved unchanged in
`services/omr-service/eval/results/bench/`; its SHA256 is
`b2783a943762f642b094c813f79d2d5fa7a820d75d7aa4d5b9e30e4878f17cc3`.
The earlier cycle-14 report is preserved in commit `72bd29b`.

Read-only extraction of the saved MusicXML confirms the mismatch. Each
svc-21 cache entry below has byte-identical score XML to svc-20, including
the cycle-14 changes that this candidate explicitly rolled back:

| Piece | svc-20 and mislabeled svc-21 score XML SHA256 |
| --- | --- |
| Air | `7f573f6852d8c5d957182ff02eb9907ea7659a81a2bcb4c9493fef665af516a4` |
| Anh. 116 | `fc8caa4a8c03e1317ef2173a603d65f9be853b44085dfefa10c2e90dae857cab` |
| BWV 939 | `4379b1d9a6bb9e8eaee310968a6b09fdbd6ef38fb6fff6a43aabbc93df9c107b` |

The official numbers are accepted as the observed result, but they do not
establish execution of the quarter-rest patch. Cycle 14 stays rejected for
its invented slur. Cycle 15 stays unaccepted and pending; the primary-rest
kill criterion cannot be attributed to code the host has not shown it ran.
No second recognition hypothesis is stacked on it.

The owning bookkeeping seam is `src/eval/candidate.ts`: `fromPdf` previously
used the checkout's `ENGINE_VERSION` for both the cache key and metadata,
while `readAudiverisVersion` checked only the upstream 5.11.0 version. The
host wrapper can fall back to an older running container. The follow-up
therefore checks the selected container's built service revision before
loading or creating artifacts, and requires observed engine provenance for
cache reuse in the new `observedEngineVersion` metadata field. The PDF hash,
options, declared engine, and observed engine must all match. Legacy or
mismatching entries are cleared before regeneration, and failed exports
receive no verification metadata. This changes artifact attribution, not the comparator, gates,
floors, pins, parser, or recognition hypothesis.

The host must select a built svc-21 container and regenerate the unverified
svc-21 cache entries. An error about a mismatching engine is an environment
failure, not a new suite result: do not repost an older `bench.md` as the
result of that attempt. The implementer has not modified or run the host
wrapper, Docker, Audiveris, or a benchmark.

## Hypothesis → layer → diff

One engine hypothesis: a quarter-rest glyph already recognized above the
existing symbol gate can be corroborated by a strongly classified quarter-rest
glyph on the same page. Measured similarity supplies independent ink evidence
before ordinary rest creation and weak-inter cleanup.

The primary target is `bach-air-anh131` m14. Its saved OMR contains the printed
rest glyph between the A2 half note and B2 quarter note, but the normal LINKS
cleanup deletes its weak rest interpretation. The official host result still
fails `bar-length-warning` and `attack-grid` (92/97 exact notes). The
[rest lifecycle packet](omr-rsi-air-rest-localization.md) identifies the owning
seam; the [template packet](omr-rsi-quarter-rest-template-localization.md)
records actual masks and earlier isolated experiments. Invention 8 m34 and
Gymnopédie 2 m25/m30 provide additional same-hypothesis sites and controls.

Only original `CHECKED` classifier results at or above the unchanged
`Grades.validationMinGrade` can supply templates. A candidate must already
have a quarter-rest evaluation above the unchanged `Grades.symbolMinGrade`.
Both glyphs must have an unambiguous staff association, staff interlines within
10%, and normalized staff-relative centers within 0.75 interline. Dimension
and translation tolerance is 0.15 of the smaller interline. Both foreground
recalls must reach 0.90 and intersection-over-union must reach 0.85. Template
confidence is multiplied by measured IoU; no template can use itself or a
previously promoted confidence as supporting evidence.

The ordinary `InterFactory` and weak-inter cleanup retain authority over the
candidate. No rest is derived from bar length or desired timing. Parser,
comparison, options, pins, allowances, gate floors, and deployed generation stay
as before. `ENGINE_VERSION` advances to svc-21 to separate host artifacts.

## Local validation

At candidate preparation (`72bd29b`), service build and typecheck passed with
509 fixture/fake-process unit tests in 29 files. After the provenance fix,
service build and typecheck pass with **520 tests in 29 files**. The added
checks run the version-reading script against fake source (including comments,
missing exports, and read failures), reject an older container before an
engine command, reuse verified cache entries, regenerate each mismatching
metadata field without stale files, and leave failed exports unverified.
All Docker/export operations in these checks are fakes. These are source
checks, not a piece or suite pass claim.

The two rest-template production sources retain their exact `72bd29b`
hashes below. The provenance follow-up does not change the engine revision
or introduce another recognition hypothesis.

All seven active vendored Java sources compile together with `javac --release
25` against the official Audiveris 5.11.0 release libraries, without executing
the engine. Patch 0006 replays against normalized upstream and reproduces both
new production sources byte for byte:

| Source | SHA256 |
| --- | --- |
| Normalized upstream `SymbolsBuilder.java` | `587cf98be6caea3a7d73df62c7bb8df8faf65654c25d59371873afd00c43afb3` |
| Candidate `SymbolsBuilder.java` | `8468b2480c08ebafc03431cd93563a95281ed918565a21432de211ee7e15a4c3` |
| New `QuarterRestTemplateMatcher.java` | `94c897d51850148c2c7eff0c7add0f30f76cf678dcd283892aef181ad809595e` |

The dependency-free production matcher passes standalone controls using saved
run-table masks: Air 2877→2788 has recalls 1.000000/0.997877 and IoU 0.997877;
Invention 5241→5243 has recalls 0.959140/0.931106 and IoU 0.895582. Actual
flag/digit controls reject (IoU below 0.26 against the Air prototype). The
historically below-gate Invention 5242 and a one-interline misplaced copy reject.
Synthetic controls also reject self-matching, weak prototypes, excessive size
or translation differences, and one-sided recall below 0.90 even when IoU passes.
Test grades are explicit inputs; no classifier was executed to obtain them.

The 13-record TSV retains PDF/OMR/XML hashes, staff geometry, and decoded
bitmap rows; each mask was checked against its saved XML run table. Its SHA256
is `e4facd6347482dcfff6171db31425a99b102f508ad2b6af0e25c28a21246074e`.
The [engine patch README](../services/omr-service/engine-patches/README.md)
documents standalone control commands. Root review also removed mutable
prototype exclusion after promotion, keeping evidence independent of cluster
traversal order, and required ambiguous staff association to reject.

The earlier template probe source/jar referenced by the localization packet
is absent from this checkout environment. The cycle-15 source is reconstructed
against the pinned upstream 5.11.0 source and must not be described as the
byte-identical earlier prototype. Historical target-only results are not an
acceptance source for this candidate.

## Host attribution and kill criteria

The host must build the matching svc-21 engine and export fresh artifacts from
all 16 byte-identical pinned inputs before using the official scorer. Compare
against accepted svc-19 (`f796059`) as well as the supplied rejected svc-20
report, including all seven protected passes:
Czerny, BWV 999, Anh. 114, Anh. 115, Arabesque, Mélodie, and Chopin Op. 28/4.
The rollback is expected to restore BWV 939 to 16 extras and remove the false
Anh. 116 m24 slur gain; those differences from svc-20 belong to the rollback,
not to rest-template matching. No new suite result is claimed for the rollback.

Reject if any protected pass turns red; if the primary printed rest is not
recovered through the ordinary producer path; if gains cannot be attributed
to actual rest glyphs; or if any result needs an invented rest, below-gate
evaluation, weakened cleanup, or scorer change. Invention's historically
below-gate glyph 5242 is a required negative control. Inspect any other changed
piece at its first changed XML event before crediting the gain.

No Docker build, Audiveris execution, or benchmark is run by this implementer.
Suite delta and acceptance remain pending the next official host table.
