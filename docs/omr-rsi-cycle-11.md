# OMR RSI cycle 11

**Rejected: global `implicitTuplets=false` makes a protected piece red.** The
accepted baseline remains cycle 10, **6/16**. Luna implemented the one-option
experiment for `bach-air-anh131`; Astra ran the full suite, attributed the
changes, and reverted it. No currently passing piece may go red.

## Hypothesis → layer → diff

Air's ordinary m14 group has no printed tuplet numeral or bracket, but Audiveris
invents an implicit 3:2 interpretation. The bounded experiment disabled the
Audiveris implicit-tuplet switch globally, retaining explicit symbol recognition.
Only the argv constant, its unit expectation, and candidate engine revision
svc-17 changed. Parser, scorer, pins, floors, and allowances stayed fixed.

The candidate used the same svc-16 Audiveris jar as cycle 10, SHA256
`a4919eb53754c48504e458b373bd2692faab20cebcb08e47fe8a01e1f2a3907e`, in
`cleffy-rsi-omr-16`; only the wrapper revision/options changed. The candidate
cache uses svc-17 plus option hash
`61bed448c1fec6570bdbc2fe8a75019a1b1c6ccc10b3b56ba06281d040777bff`. Its artifacts remain separate
from the accepted svc-16 cache. All 16 PDF/reference hashes are unchanged.

## Full-suite result and attribution

Build and all **509/509** unit tests pass. The full fresh command
`CLEFFY_OMR_CONTAINER=cleffy-rsi-omr-16 npm run eval -- bench --force-audiveris`
completed all 16 pieces and returned 1. The rejected report is retained under
`services/omr-service/eval/results/rsi-cycle-11-no-implicit/`.

| Piece | Change from accepted cycle 10 |
| --- | --- |
| Air | m14 printed durations restored; warning clears; exact 92/97 → 95/97, on-grid 91/97 → 95/97; candidate pass |
| Invention 8 | m19 voice assignment changes; exact/on-grid gain four attacks; m10/m34 blockers remain |
| **BWV 999** | **Four newly missing notes; protected pass turns red** |
| WTC I Prelude 1 | Missing 17 → 50; exact 94.3534% → 88.5246%; wrong-length bars 2 → 1 because notes were lost, not a valid repair |
| Für Elise | Missing 24 → 27; exact 94.5856% → 92.4862%; wrong-length bars 4 → 7 |

The other 11 piece rows have unchanged metrics and checks. Recognized explicit
tuplet-note groups in Anh. 116 remain present in m15 and m24. This does not save
the experiment: preserving printed tuplets alone is insufficient when voice
recovery drops notes elsewhere.

`MeasureRhythm.SlotMapper.mapRookies` uses this switch in voice assignment as
well as tuplet creation: false discards a conflicting active-voice mapping where
true explores synchronization/shrink paths. Thus switching it off is broader
than suppressing the fabricated Air sign. Invention 8's m19 four-note timing gain
is localized in raw XML voice assignment; a separate fresh original-option
svc-15 control reproduces the old exact/on-grid result, artifact hash
`5ff885465030cc05dcec2862739a33aa206a72fa05a8fc359aceb1c72258ed6e`.
The page still shows the missing note and the m10/m34 issues; no complete-piece
recovery is claimed there.

Rejected totals: 6/16 (Air replaces BWV 999), 5,996 reference notes, 159 missing,
161 extra, pitch 96.79786524349566%, exact 95.14676450967312%, on-grid
94.27951967978652%. The equal pass count hides a prohibited regression.
A premature progress update saying the six protected pieces were still passing
was corrected immediately when the per-piece comparison exposed BWV 999.

## Verdict and restoration

**Revert** the option, argv expectation, and candidate version. Restore svc-16,
`implicitTuplets=true`, and the accepted six-piece set. The full cached benchmark
with the restored build returned 1 for the remaining failures and reproduced all
16 accepted piece rows, all 16 artifact hashes, and cycle 10 totals exactly. The Air
localization remains useful, but its candidate pass is not retained. No floors,
allowances, timing tolerance, or warning checks changed.

The completed [Für Elise localization](omr-rsi-furelise-localization.md) also
records cycle 10's original-engine dot/articulation variance and the separate
remaining clef/head clusters; it introduces no source changes.
