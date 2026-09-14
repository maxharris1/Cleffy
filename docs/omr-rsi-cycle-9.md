# OMR RSI cycle 9

**Attributed Air fragment/parser and reference-accounting fixes. The suite remains
5/16; the goal is not complete.** Luna implemented and Astra reviewed, tested,
and attributed the result against the accepted cycle-8 svc-15 artifacts.

## Hypothesis → layer → diff

`bach-air-anh131` has explicitly engraved short segments that the parser pads
and the existing reference pin places on a uniform grid. The page, matching
source, and XML prove 17 printed segments, including m8=3 quarters, X8=1 quarter,
and terminal m16=3 quarters. The two repeats give 34 performed segments. See
[the fragment evidence](omr-rsi-air-fragment-localization.md).

The parser retains a short backward-repeat ending when its immediately following
implicit measure completes the meter. A terminal backward-repeat ending can also
complete the internal implicit section pickup when no repeat or meter change
intervenes. Arbitrary short final bars still pad and warn. Underfull source
tuplets retain their warning even if regridding changes the resulting extent;
Air's malformed m14 is not excused by fixing the legitimate fragments.

The official comparator now checks declared `partialBars` lengths, using
movement-relative source positions and the MIDI convention of pickup bar zero.
The Air pin changes only its evidenced printed/performed counts and three partial
lengths. Floors and note/ornament allowances are unchanged.

## Review and validation

Review rejected an early rule accepting every short final repeat bar and a
comparator origin that incorrectly counted a pickup as bar one. Positive and
negative fixtures cover paired fragments, unmatched/truncated endings,
intervening repeats, wrong partial lengths, nonzero movement source indices, and
pickup numbering. The full unit suite passes **509/509**; build, typecheck,
ESLint, and the engine-version check pass.

The final full command was
`CLEFFY_OMR_CONTAINER=cleffy-rsi-omr npm run eval -- bench`, exit 1 for the
remaining failures. Every one of the 16 artifact hashes matches cycle 8.
The five previously passing pieces remain green.

## Suite delta and attribution

Air's printed count, alignment, partial lengths, and 34-segment repeat walk now
pass. Correct reference placement changes pitch to 100%, missing/extra from 2/2
to 0/0, exact from 90/97 to 92/97 (94.84536082474227%), and on-grid from 89/97 to
91/97 (93.8144329896907%). These note-accounting gains come from the page-derived
reference grid, not improved image recognition. The surviving failures are
`bar-length-warning (measure_underfull)` and `attack-grid`, both retained for
the m14 recognition defect.

The same comparator fix exposes an existing Für Elise padding error: its already
declared first ending at bar 8 is two eighths (480 ticks), while ScoreData has
720 ticks. Its wrong-length count becomes 4 instead of 3; notes, timing metrics,
artifact bytes, and failing status are unchanged. This is newly enforced existing
page evidence, not a new transcription regression or a reason to relax the check.
The other 14 piece rows are identical.

Suite totals are 5/16, 5,996 reference notes, 119 missing, 161 extra, pitch
97.33155436957972%, exact 95.81387591727818%, and on-grid 95.04669779853235%.

**Verdict: keep.** Air remains red until its printed m14 rhythm is recovered at
the engine/XML layer. No additional pass is claimed in this cycle.
