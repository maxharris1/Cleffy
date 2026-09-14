# OMR RSI cycle 8

**Attributed repeat-walk fix; suite remains 5/16, not complete.** Baseline is
the accepted 300-dpi svc-15 cache from cycle 6. Cycle 7's 400-dpi option and test
were reverted before this build. Astra reviewed and evaluated; Luna implemented.

## Hypothesis → layer → diff → suite delta → verdict

- **Named piece / one hypothesis:** `bach-air-anh131` skips its second printed
  repeat because `planRepeats` retains the first section's exhausted pass
  counter and anchor. No currently passing piece may go red.
- **Layer / evidence:** the pinned page and MusicXML both have two section-end
  repeat signs. The page is represented by 17 segments: m1–8, X8, m9–16. The
  old parser walks positions 0–7 twice and 8–16 once (25), silently skipping
  the second retake. The convention of returning to the preceding repeated
  section boundary is supported by the ABC 2.1 repeat-playback recommendation;
  MusicXML also explicitly models omitted forward signs in two-part forms.
  See [the localization packet and primary references](omr-rsi-air-repeat-localization.md).
- **Diff:** `src/repeats.ts` starts a fresh anchor/pass after a completed
  repeated section. It defers that reset through skipped volta endings so
  their current pass still selects the right ending. Explicit forward markers
  continue to govern, and repeats remain suppressed after D.C./D.S. traversal.
- **Tests:** three behavioral fixtures cover successive bare repeats, a later
  bare repeat after an explicit volta, and successive repeats followed by D.C.
  All 68 repeat tests and the full **501/501** unit suite pass. Build and
  typecheck pass.
- **Full suite:** `CLEFFY_OMR_CONTAINER=cleffy-rsi-omr npm run eval -- bench`
  completed, exit 1 for the remaining 11 failing pieces. All 16 artifact hashes
  match the frozen 300-dpi baseline. Air's performed walk changes **25 → 34**;
  its existing `performedBars: 16` pin still fails. Every other piece row is
  identical. All note counts/rates and suite totals are identical. The five
  protected passes remain green.
- **Verdict:** keep the repeat traversal fix. No pin, scoring floor, allowance,
  note duration, warning gate, or engine option changed. No additional pass
  is claimed.

The independent next investigation is Air's reference/bar-fragment accounting:
the current pin incorrectly describes a repeat-free 16-bar page, while the
engraving contains two repeat signs and an internal short fragment. Any pin
correction must follow the page and matching source, not this parser's output.
The source's note attacks and the parser's underfull warnings must still be
checked after the reference grid is corrected.
