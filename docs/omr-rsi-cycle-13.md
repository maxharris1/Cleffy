# OMR RSI cycle 13

**Accepted: 7/16; all seven passes remain green.** Baseline: svc-18. Luna implements
the single `bach-invention-08` m10 ledger hypothesis; Astra reviews and runs the
full corpus. No currently passing piece may go red.

## Hypothesis → layer → diff

The printed C4 ledger survives extraction and the geometric check suite, but
`LedgersPostAnalysis` removes it as an upper delta outlier: 20.0131 pixels
against the learned [15..19] range at interline 21. Its height already passes.
Without the first ledger, the head search never reaches this printed C4.

The candidate retains only a first-below-staff ledger rejected for `DELTA`
alone, with distance within 0.15 interline of one interline. Source pixels must
contain a connected filled component, excluding the ledger stroke, and a
vertical stem at its edge touching that component. All existing extraction,
grade, height, and other post-analysis checks remain. Normal head recognition
and rhythm interpretation then consume the ledger; no note is inserted by the
parser and no duration is inferred from the desired bar length.

Review rejected the initial loose ink-count/nearby-stem test, required the
height check to remain, required component connectivity and edge attachment,
and removed piece coordinates and diagnostic logging from the final source.
The [Invention 8 packet](omr-rsi-invention8-localization.md) records target and
negative-control evidence. The isolated candidate recovers C4 at the printed
eighth duration and corrects the neighboring E4 duration. It still fails only
the independent m34 `measure_underfull` warning; its one remaining missing
note is within the existing allowance.

## Matching engine and validation

The source adds `LedgersPostAnalysis.java`, reproducible upstream patch
`0004-ledger-attached-head.patch`, Docker compilation, and engine revision 19.
No option, parser, scorer, pin, floor, or allowance changes. The deployed
generation remains 15. The patch reproduces the vendored source exactly.

Source SHA256:
`4fbf22735723669f51ac341eb8772c101203defcca7b27079a7f0cbc9ea37f22`.
Image `cleffy-omr-rsi:svc-19` SHA256:
`f366510318c9c313a7fb4f1772d10539c0ddca1a57ec08eb26b8c3422faea6c8`.
Final jar SHA256:
`04e60de5dbd946fe60c071a3284e7111abb9e2fa369d93f04a511c43636179a3`.

Service/image builds, typecheck, and all 509 unit tests pass. Full fresh command:
`CLEFFY_OMR_CONTAINER=cleffy-rsi-omr-19 npm run eval -- bench --force-audiveris`.
Fresh cache entries preserve the accepted svc-18 artifacts.

## Suite delta → verdict

The full fresh benchmark completes all 16 pieces and returns 1 for the nine
remaining failures. Every PDF and reference hash matches cycle 12. Fourteen
piece result rows and complete ScoreData are unchanged. The two changes have
direct page/XML evidence:

* Invention 8 changes only m10. One new staff-7 ledger appears at
  `(462,1936,41,4)`. C4 is recovered, the bar extent changes 1680 → 1440 ticks,
  local exact changes 18 → 20, and local on-grid changes 15 → 20. Overall exact
  is 592/598 and on-grid 590/598, with one allowed missing note and zero extras.
  All 34 lengths now match, but the independent m34 underfull warning remains.
* Anh. 116 changes only m18. One new staff-6 ledger at `(1999,1464,41,4)`
  restores the printed E2 instead of F#2. Its paired missing/extra substitution
  disappears; exact and on-grid each gain one note. The m23 triplet/overfull
  defect remains. This is an incidental result of the same first-ledger rule.

The isolated prototype's additional m19 timing gain is absent from this
original-option full run and is not credited to the ledger patch. The accepted
Invention 8 note comparison changes only m10; later notes, including m19,
retain their positions within their bars as the removed excess shifts the
following bar starts by 240 ticks. Anh. 116's corrected pitch also changes
the existing automatic pedal inference; no other note event changes.

Astra reran the focused controls against the actual svc-19 jar. The printed
head/ledger passes; real short-stroke windows in a clef and title, plus the
nearby horizontal fragment, reject. Erasing the target's stem also rejects.
The executable probe is `engine-patches/probes/EvidenceControls.java`; input
is the exact Invention 8 baseline `sheet#1/BINARY.png` from the packet. The
checks assert their expected results rather than merely printing them.

Suite totals: **7/16**, 5,996 reference notes, 117 missing, 160 extra, pitch
97.498332221481%, exact 96.03068712474983%, on-grid 95.3302201467645%.
The seven protected passes remain unchanged. **Verdict: keep the attributable
ledger fix; continue toward 16/16.**

## Parallel localization

Fresh Air/Invention 8 rest tracing rejects a dispatch omission: both eligible
rests are created and later deleted by the existing weak-inter cleanup. The
[Air packet](omr-rsi-air-rest-localization.md) and
[Invention 8 rest packet](omr-rsi-invention8-rest-localization.md) retain the
failed hypothesis. No grade exemption is included. A separate image-template
hypothesis is being tested.

The [BWV 939 packet](omr-rsi-bwv939-localization.md) corrects a mislabeled
head: the lower curve is an E4 tie and exports correctly. Both upper curves
are assigned to C5, leaving A4 untied. The next experiment belongs in head
selection, not serialization. No tie change is included here.
