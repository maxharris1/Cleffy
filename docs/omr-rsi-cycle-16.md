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

## Hypothesis → layer → diff

`DotFactory.checkDistanceToConcreteLine` rejects a candidate before it is
recorded as a dot when no concrete ledger is present and
`LedgerFragmentEvidence.isFragment` proves leftover neighboring-ledger ink.
The existing `TupletsBuilder` collector is unchanged. Patch 0006 and its
sources, rest-template controls, and Docker entries are removed.
`ENGINE_VERSION` is `audiveris-5.11.0+svc-22`. Parser, scorer, pins, floors,
options, and deployed generation 15 are unchanged.

Landed source SHA256:

| Source | SHA256 |
| --- | --- |
| `DotFactory.java` | `7ac55858af3e80ac100b4f055ada9315ecc2ab342bf07d5204ddd155548de705` |
| `LedgerFragmentEvidence.java` | `c3be888b54d0cdbc12fc749241e19348b49f9ba24e7be97fdf7f530afa289d27` |
| `0007-ledger-fragment-dot.patch` | `be8c8a7c81c8eae5be4141c4a943fac5ba65d6bae613cf1cfbda4c59b9ac5ec1` |

No Docker build, Audiveris execution, or benchmark is run by this implementer.
Service typecheck and **520** fixture/fake-process unit tests pass. These are
source checks, not a piece or suite pass claim.

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
