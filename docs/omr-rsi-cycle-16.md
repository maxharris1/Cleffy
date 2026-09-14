# OMR RSI cycle 16

**Candidate pending official host bench.** The supplied host result for
`98450f5`, container `cleffy-rsi-omr-20`, is **7/16**, 95.4% on-grid,
117 missing and 159 extra notes. All seven protected passes remain green.
This implementer accepts those observations and has not repeated scoring.

## Previous candidate verdict

Cycle 14 remains rejected and reverted: the real BWV 939 A4 gain was coupled
to interpreting cautionary-accidental parentheses as an invented slur in
Anh. 116 m24. Its documented kill criterion applies even though all seven
protected passes remained green. BWV 939 still fails with 15 extras in the
supplied result; its remaining failure alone was not cycle 14's kill criterion.

Cycle 15 is closed without acceptance. Air's primary printed rest has no
credited recovery in the new official result: `measure_underfull` and 94.8%
exact attacks remain. Remove patch 0006 and its sources, controls/fixture,
and Docker entries before introducing this candidate. The engine provenance
caveat and explicit conservative verdict are preserved in
[cycle 15](omr-rsi-cycle-15.md). The provenance checks remain active. Neither
rejected recognition patch is carried forward.

## Hypothesis and localization

One engine hypothesis: a small leftover piece of a neighboring note's ledger
is incorrectly admitted as an augmentation dot. Reject only a mark proven by
source ink to be part of that ledger, before ordinary augmentation linking.
The existing tuplet collector can then consume the printed triplet normally;
no tuplet, duration, note, or rest is synthesized from expected bar length.

The primary site is `anna-magdalena-07` m23. The actual page prints three
beamed eighths under a slur with a triplet numeral. The second note has no
augmentation dot. The candidate dot is the left protruding ledger of the
third head, not a piece of the numeral. This corrects the initial overlap
proposal before implementation; numeral-overlap logic is not introduced.

Pinned PDF SHA256:
`9d53fe19d452a7e601e45786ecf860f30d45398912b1a6d47b656bcb96b4b86e`.
Accepted svc-19 artifact evidence:

- OMR SHA256: `940f392eb03269b507a8bf954bddeded7d18acb90986a99251e44aaa0ccc52c5`.
- `sheet#1/sheet#1.xml` SHA256: `2a779872a3f703ddeff289019389b082bfc75c235ef4b627505457b6b120e378`.
- `sheet#1/BINARY.png` SHA256: `a98917764e50ae8466cdf89672cd25441b1fce2c7594a5f070f0344fb53dcc6c`.
- Dot glyph 6332, inter 6528: `(1315,1589,6,4)`, attached to head 2346.
- Following head 2477, glyph 2347: `(1322,1586,25,20)`.

The svc-20 artifact has the same binary hash and false dot at the same box
(glyph 6365, inter 6504, still attached to head 2346). This defect persists in
the official candidate output and is independent of the rolled-back m24 slur.
The earlier [symbol localization](omr-rsi-anh116-symbol-localization.md)
records why the actual triplet sign is rejected after the false dot makes the
middle duration too long. Glyph IDs vary between revisions; production uses
no IDs, piece names, page coordinates, references, or expected durations.

## Implementation and source verification

`DotFactory.checkDistanceToConcreteLine()` already rejects dots too close to a
recognized ledger. Its outside-staff `ledger == null` branch previously
accepted the mark. The candidate adds source-ink corroboration only to that
branch, before any dot interpretation is dispatched. The concrete-ledger,
inside-staff, one-line-staff, and tablature behavior stays intact.

`LedgerFragmentEvidence` is dependency-free. A small, thin fragment must
align with an outside-staff ledger ordinate and sit immediately to the left
of a recognized same-staff head. Original BINARY pixels must contain an
uninterrupted horizontal run from the fragment's left edge through the head
and at least 0.25 interline beyond its opposite edge (minimum 2 pixels).
Both protrusions must remain thin in the original source. Bounding-box
adjacency, desired duration, or a dot's shape alone is insufficient. Missing
source evidence fails closed; out-of-image samples are white. An INFO line
identifies each rejected glyph and neighboring head for host attribution.

At the saved target the horizontal source runs are:

| y | Inclusive black x interval |
| --- | --- |
| 1589 | 1317–1354 |
| 1590 | 1316–1355 |
| 1591 | 1315–1355 |
| 1592 | 1316–1354 |

The 41-pixel y1591 run reaches across the head bounds 1322–1346 and beyond
both sides. The final helper accepts this exact full BINARY source. A
read-only glyph-mask scan of all 69 accepted svc-19 augmentation dots in the
protected pieces found no overlap or one-pixel contact with recognized head
or ledger masks: Anh. 114 has 16, Anh. 115 has 20, Arabesque has 8, Chopin
has 23, and Mélodie has 2. Czerny and BWV 999 have none. This is an artifact
control, not a new recognition run or full-suite regression claim.

The standalone controls ship the target crop and four real-dot crops from
Anh. 114, Anh. 115, Chopin, and Arabesque. Every crop was independently
compared pixel for pixel with the exact svc-19 embedded BINARY; dot ink
counts are 20, 64, 64, 58, and 39 respectively. Blank controls fail. Full source and crop hashes, crop origins, and actual
head bounds are recorded in
`engine-patches/probes/fixtures/ledger-dot-provenance.json`. The
actual target and its translated copy accept; erasing a connecting column
rejects. Detached flat marks, a wrong ordinate, no opposite protrusion, a
thick opposite protrusion, and rounded dots reject. Real dot pixels also
reject with an adverse hypothetical neighboring-head placement; those test
boxes are explicit synthetic inputs, not recovered head interpretations.

All seven active vendored production sources compile together with Java 25
against the official Audiveris 5.11.0 release libraries. The classpath jar
SHA256 is `9b35257edea808ec80a8bcd48882d174b107152d9640b5ca33e1365593cff2a5`,
verified against the jar inside the saved official release package. Patch
0007 replays against LF-normalized upstream and reproduces both production
sources byte for byte:

| Source | SHA256 |
| --- | --- |
| Normalized upstream `DotFactory.java` | `834b5a1076cf67de9134f24f55847ab1be9eafd445858035bd4fc92719ea8811` |
| Candidate `DotFactory.java` | `7ac55858af3e80ac100b4f055ada9315ecc2ab342bf07d5204ddd155548de705` |
| New `LedgerFragmentEvidence.java` | `c3be888b54d0cdbc12fc749241e19348b49f9ba24e7be97fdf7f530afa289d27` |

Service build and typecheck pass, with **520 tests in 29 files** passing.
These use fixtures and fake processes; no official scorer or engine was run
on the pinned pieces. The generated toy-test summary was restored. Parser,
scorer, corpus pins, and the official bench report have no diff.

## Host attribution and kill criteria

The host owns the fresh full 16-piece export and official
`services/omr-service/src/eval/` scoring using matching svc-22. Compare with
accepted svc-19 (`f796059`) as well as the supplied svc-20 result: restoration
of BWV 939's 16 extras and loss of the false Anh. 116 m24 slur gain belong to
the explicit cycle-14 rollback. Do not credit those differences to this patch.

Reject if any protected pass becomes red, a real printed dot is removed, a
rejected dot lacks connected ledger ink, the target dot is not rejected at
its producer, or improvement requires invented rhythm, weaker grades, or
scorer changes. Inspect the first changed XML event on every changed piece.
A possible Anh. 116 pass is a host hypothesis, not a local validation claim.
Protected pieces are Czerny, BWV 999, Anh. 114, Anh. 115, Arabesque, Mélodie,
and Chopin Op. 28/4. Floors, allowances, pins, parser, options, scorer, and
deployed generation are unchanged. Svc-20 and svc-21 remain reserved; the
new revision separates future host artifacts from both rejected candidates.

No Docker build, Audiveris execution, or benchmark is run by this implementer.
