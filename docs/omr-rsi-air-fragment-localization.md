# Air BWV Anh. 131 fragment localization

## Verdict

The pinned Air reference is missing one printed segment and describes the wrong
straight-through bar grid. The page has 17 printed segments and the standard
successive-repeat walk has 34 performed segments. This is a page/source and
parser-boundary issue, separate from the repeat-anchor fix. No score, floor,
allowance, or warning was changed in this packet.

## Page and edition arithmetic

The pinned page is `/tmp/omr-rsi-baseline/air-page.png`; the matching edition is
`/tmp/omr-rsi-baseline/air.ly`. The page reads, in order,

`m1..m8, X8, m9..m16`

where `X8` is the one-quarter implicit continuation after the first ending,
not a displayed m17. The first ending m8 is 3/4, X8 is 1/4, and the terminal
m16 is 3/4. Therefore the printed duration is

`7*4 + 3 + 1 + 7*4 + 3 = 63 quarters`,

which is the 63-quarter extent of the pinned MIDI. The first printed bar is
not a pickup: its upper voice has a three-quarter rest followed by C4, while
the lower voice has a whole-bar rest. The terminal m16 has three quarters of
printed material and no final rest to count as a fourth quarter.

The source has two independent engraving commands,
`\\set Score.repeatCommands = #'((volta) end-repeat)` (upper near the first
ending and lower at the second ending). These commands draw the two backward
signs; they do not create a `\\repeat volta` block in the source MIDI. Thus the
Mutopia MIDI is written as one 63-quarter straight-through stream, which the
old uniform 4/4 placement reports as 16 reference bars.

## Raw artifact evidence

The pinned svc-15 artifact is

`services/omr-service/eval/cache/artifacts/2421e97393ee1b476897314326409e0ea3e25e3ceb6d4bf215342e709be35af5-audiveris-5.11.0+svc-15-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/`

with artifact hash `964096ff5e5a9240392a714c7470f9aeca7d7f3970a6503c5307ee62d5f7a793`.
Its MusicXML (`omr-eval-input.mxl`, extracted for inspection as
`/tmp/air-mxl/omr-eval-input.xml`) contains:

| page segment | XML measure | divisions (divisions=12) | duration |
| --- | --- | ---: | ---: |
| m8 first ending | `8` | 36 | 3/4 |
| implicit continuation | `X8`, `implicit="yes"` | 12 | 1/4 |
| terminal | `16` | 36 | 3/4 |

The XML has a backward repeat at m8 and m16. The parser's frozen score instead
has m8 at `dTicks=1920`, X8 as an `n=9`, `srcIndex=8` measure at `dTicks=480`,
and m16 at `dTicks=1920`: m8 and m16 have been padded to 4/4. It also retains a
real `measure_underfull` warning. That warning must remain visible. A separate
m14 recognition defect encodes the upper tuplets as durations `8,4,4,8,12`
where the printed values are `12,6,6,12,12`; it must be fixed at the engine/XML
recognition layer rather than forgiven by the fragment pin.

## In-memory pin probe

I loaded the frozen `/tmp/omr-rsi-baseline/bach-air-anh131.score.json` and the
pinned `air.mid` without writing either file. In `notesFromMidi`, manifest bar
numbers are one-based, so the page fragments are represented as
`partialBars: [{bar:8,quarters:3}, {bar:9,quarters:1},
{bar:17,quarters:3}]`; these correspond to zero-based source positions 7, 8,
and 16. The proposed movement pin is `printedBars:17, performedBars:34`.

| metric | current pin | proposed fragment pin |
| --- | ---: | ---: |
| reference bars | 16 | 17 |
| OMR printed bars | 17 | 17 |
| OMR performed bars (frozen score) | 25 | 25 |
| reference notes | 97 | 97 |
| pitch match | 97.938% | 100.000% |
| exact onset | 92.784% | 94.845% |
| on-grid | 91.753% | 93.814% |
| missing / extra | 2 / 2 | 0 / 0 |
| imperfect bars | 2 | 0 |
| bars wrong length | 1 | 1 |
| printed-bar match | false | true |
| bar alignment | false | true |
| performed-bar match against 34 | n/a under old pin | false on frozen 25-bar score |

The repeat-only cycle-8 artifact confirms the repeat implementation now emits
34 performed bars; the proposed `performedBars:34` therefore matches that
engine result. With the fragment pin, note presence, extra-note, skipped
passage, and note-length checks pass; printed-bar count and bar alignment also
pass. `bar-length-warning` still fails on `measure_underfull`, `bar-length`
still reports 1/17 because the comparator expects every bar to be a full 4/4,
and the exact-onset result remains 94.845%, just below the unchanged 95% floor.
No gate floor or warning suppression can be used to close those residuals.

## Implemented seam

The cycle-9 change is limited to the generic evidence above:

- `services/omr-service/src/musicxml.ts` now preserves a short bar only when a
  backward repeat is immediately followed by an implicit continuation that
  complements the meter, or when the terminal backward-repeat bar complements
  that same internal implicit fragment with no intervening repeat or meter
  change. An unrelated short final repeat still pads and warns. The malformed
  m14 tuplet source remains disclosed as `measure_underfull`.
- `services/omr-service/src/eval/compare.ts` derives expected printed lengths
  from movement-relative `partialBars`, so the three evidenced segments are
  measured as 1440, 480, and 1440 ticks. Source indices are rebased at each
  movement boundary.
- `services/omr-service/eval/corpus/bach-air-anh131.json` now pins
  `partialBars` 8=3q, 9=1q, 17=3q, `printedBars` 17, and `performedBars` 34.

Focused MusicXML and comparison tests cover paired fragments, terminal
complement evidence, wrong or interrupted complements, arbitrary short final
repeat bars, movement-relative source indices, and wrong declared durations.
No floor, allowance, engine option, or target-output special case was added.
