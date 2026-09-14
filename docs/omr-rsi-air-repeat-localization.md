# Air BWV Anh. 131 repeat localization

## Page-derived walk

The pinned page is `/tmp/omr-rsi-baseline/air-page.png`. It has 17 printed
measures on two systems. The first system ends with a backward repeat sign at
m8 and the second system ends with another at m16. There are no volta endings,
D.C./D.S. jumps, or coda/fine instructions. Reading each successive bare
backward repeat as the end of its current section gives

`m1..m8, m1..m8, X8+m9..m16, X8+m9..m16`

or 34 performed measure segments. This is independent of the corpus metadata,
which currently says 16 printed/performed bars and “no repeats.” The source
edition `/tmp/omr-rsi-baseline/air.ly` contains two
`((volta) end-repeat)` commands, matching the two printed signs.

The baseline raw MusicXML has 17 measures and backward-repeat marks at m8 and
m16. Its old plan is 25 segments: m1..m8 twice, then X8+m9..m16 once. The
failure is in `planRepeats`: after the first bare repeat is exhausted,
`lastForward` remains the top anchor and `passOf` remains at the exhausted pass,
so the second bare repeat cannot open a new section.

## Repeat semantics check

The 34-segment reading is supported by the ABC 2.1 music standard's playback
recommendation: when an end-of-repeated-section mark has no earlier start mark,
playback restarts from the beginning *or from the latest double bar line or end
of repeated section*. Thus the second unmatched end mark can anchor at the
section boundary after m8. The W3C MusicXML reference also defines
`sound@forward-repeat` for “two-part forms with repeats, such as a minuet and
trio where no repeat is displayed at the start of the trio,” confirming that an
omitted start marker can be structurally meaningful. The page and LilyPond
source provide the independent section boundary and two explicit end-repeat
commands. This is a standard implicit-start case, rather than a timing or
allowance inference.

Sources: [ABC 2.1 Music Standard, repeat playback recommendation](https://michaeleskin.com/documents/abc_standard_v2.1.pdf),
[W3C MusicXML `sound` reference](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/sound/),
and [LilyPond repeat reference](https://lilypond.org/doc/v2.24/Documentation/notation/repeats).

## Fix

`planRepeats` now starts a fresh section after an exhausted backward repeat by
setting the next measure as the anchor with pass 1. When a first volta ending
contains the only backward sign and is skipped on the second pass, the reset is
deferred until the matching ending closes; the current volta still sees pass 2.
Explicit `|:` anchors continue to replace this state normally, and post-jump
passes still suppress repeats.

Focused tests in `services/omr-service/src/repeats.test.ts` cover the 17-measure
successive-bare-repeat walk, a later bare repeat after an explicit volta, and
successive bare repeats before a D.C. Existing repeat, volta, jump, pickup, and
termination tests remain green.

No corpus pin, floor, allowance, engine option, or note duration was changed.
