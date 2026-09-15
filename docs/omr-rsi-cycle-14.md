# OMR RSI cycle 14

**Rejected and reverted after attribution of the supplied official host bench.**
The host scored `f7211aa` with svc-20 in `cleffy-rsi-omr-20`, generated
`2026-09-14T17:06:12.817Z`: **7/16**, 95.41360907271515% on-grid, no pass flip.
All seven protected passes stayed green. However, an incidental gain depends
on classifying accidental parentheses as a musical slur, triggering the
recorded no-invented-curves kill criterion. The accepted engine baseline
therefore remains svc-19 at `f796059`.

## Hypothesis → layer → diff

One hypothesis: `bach-prelude-bwv939` has two horizontal upper ties assigned
to C5 because `SlurLinker` tests the far head edge against curve concavity.
The lower curve belongs to the printed A4. The candidate uses the physical
head center for horizontal concavity and retains the original bounds-edge
rule for nonhorizontal slurs. Distance ranking and tie/pitch checks remain.

Recorded kill criteria: any protected pass turns red, any accepted tie is lost
without page evidence, or gains require invented curves or altered scoring.
A full-piece pass was not itself an acceptance criterion. BWV 939 remaining
red is not the reason for this rejection; the false Anh. 116 slur is.

The candidate source, reproducible patch, and Docker wiring are preserved in
commit `f7211aa`. Source SHA256:
`463c486183d85a64e295acac2fe0d411711b73a080c39e8ee2434bb843494c10`.
The [tie-head localization packet](omr-rsi-bwv939-tie-head-localization.md)
retains the target and earlier experiment. That experiment is historical
context, not a substitute for the supplied host result.

## Official host delta and artifact attribution

The official report is preserved in `services/omr-service/eval/results/bench/`.
Its JSON SHA256 is
`d71aec0401e9770088b8e5ce8080967a9b573cc30ca4daafb7b57d08a54ff94c`.
Against the svc-19 report in `f796059`, all PDF/reference hashes and gate
limits match. Fourteen piece rows have identical metrics, including all seven
protected passes. Only two pieces change:

* BWV 939: extras 16 → 15; on-grid 170/179 → 171/179; exact remains 100%.
  The lower upper curve `(1702.5,1320.3)` → `(1825.5,1320.4)` changes
  from C5 heads 1443→1447 to the printed A4 heads 1494→1498. The upper
  curve remains C5→C5 and the lower curve remains E4→E4. MusicXML gains
  the A4 tie in m7–8 and removes the duplicate C5 markers while preserving
  its actual tie. This local gain is supported. The three other missing
  C3/C3/F3 ties remain; BWV 939 still fails with 15 extras, 12 explained
  by ornaments, 1 allowed.
* Anh. 116: exact 300/310 → 303/310; on-grid 298/310 → 302/310.
  At m24, glyph bounds `(1576,1630,43,25)` change from a false
  `TUPLET_THREE` to a false `SLUR_BELOW`, linking heads 2408→2432.
  Its curve `(1576.7,1631)` → `(1618.1,1645)` has slope about 0.34,
  within the candidate's horizontal threshold. The upper voice is
  E5, D#5, E5, F#5; MusicXML duration divisions change from 8,4,6,12
  to 12,6,6,12, and false tuplet markers become slur markers. This explains
  the numeric gain but does not establish a correct musical symbol.

Visual inspection of the actual m24 binary raster identifies a parenthesized
sharp between the first two heads, with no printed musical slur. Identical
input rasters prove that the ink was already present; they do **not** prove
that the new slur interpretation is valid. The preliminary XML-only audit
mistook those two facts. Root's visual review rejects that attribution.

The matching LilyPond edition confirms m24 as `e dis?8[ e] fis4 |`:
the question mark marks the cautionary accidental, brackets mark beaming,
and no slur is specified. Source SHA256:
`8fbbf2f3f69454c29e6171c046d07c46ee7c44a9f47653e10811fc4b9890a020`.

The unchanged Anh. 116 BINARY raster SHA256 is
`a98917764e50ae8466cdf89672cd25441b1fce2c7594a5f070f0344fb53dcc6c`.
The svc-19 OMR/MXL hashes are
`940f392eb03269b507a8bf954bddeded7d18acb90986a99251e44aaa0ccc52c5` /
`5e88eb167b1e7930feef0c03b1872c6e62b7b70788d774b4ef572bc2fab68632`.
The svc-20 OMR/MXL hashes are
`ab7d24042bec53af377ea86ebf67b667acbfd6fbd8427c96414649fc6f5ccd16` /
`028d724a8c6463534b392359d5bb2eb9d1c65d8fac151b1a250f1c69b7b0fb89`.
Artifacts are under the pinned PDF hash
`9d53fe19d452a7e601e45786ecf860f30d45398912b1a6d47b656bcb96b4b86e`
and respective svc-19/svc-20 cache keys. The root review crop covers
`(1450,1500)` through `(1750,1800)` in the embedded page.

## Verdict and rollback

**Revert cycle 14.** The A4 fix is real, but the patch also lets accidental
parentheses win as an invented musical slur. Keeping that gain would violate
the recorded criterion. The `SlurLinker` override, patch 0005, and its Docker
compilation entry are removed. Svc-20 remains reserved as a rejected revision;
cycle 15 introduces its single rest-template hypothesis on the accepted
svc-19 engine behavior, with a new svc-21 artifact key.

The official svc-20 totals remain recorded honestly: 7/16, 5,996 reference
notes, 117 missing, 159 extra; pitch 97.498332221481%, exact
96.08072048032021%, on-grid 95.41360907271515%. No new suite result is
claimed for the rollback. The next host comparison must attribute the expected
loss of the cycle-14 BWV 939 and Anh. 116 gains to this explicit rollback.

This audit used the supplied report, cached OMR/MXL, and page images. No cached
ScoreData JSON was present and no new scoring was run. Service build,
typecheck, and all 509 fixture/fake-process unit tests passed. No Docker build,
Audiveris execution, or benchmark was run by this implementer.
