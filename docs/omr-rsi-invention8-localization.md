# Invention 8 bar-length localization packet

Cycle target: `bach-invention-08` (Bach, BWV 779), first-cycle hypothesis:
the remaining one-bar length failure is a duration or voice interpretation error
at the page → MusicXML → parser boundary.

## Evidence available

The committed official scorer result at `HEAD dba73df` reports:

- artifact hash: `a51074a88fdd9f483455d10666589a5a33ba8324b63c7ea35a5a02a64eb405f0`
- 34 printed bars; 1 fails `bar-length`
- `measure_underfull` and `measure_overfull` are both present
- 598 reference notes, 2 missing, 0 extra
- pitch 99.6656%, exact 98.6622%, onGrid 97.8261%

The committed `bench.json` and `bench.md` contain no affected bar index, page
crop, MusicXML event list, or ScoreData event list. The artifact cache is
ignored by `services/omr-service/.gitignore` (`eval/cache/`), and this checkout
has no `.mxl`, `.omr`, or ScoreData artifact for the recorded hash. Searches of
the checkout, `/tmp`, `/home/ubuntu`, and the supplied `/cursor` store found no
matching artifact.

Prior cycle evidence narrows history but does not localize this cycle:

- `docs/omr-rsi-cycle-2.md` reports the `rhythmRepair` extent guard changed
  Invention 8 from 2 bad bars to 1 across the cached artifact set.
- `docs/omr-rsi-cycle-5.md` reports the engraving-derived `barRegrid` changed
  WTC I Prelude 1 and BWV 999 while Invention 8 remained at one bad bar.

## Localization after svc-15 artifact recovery

The fresh artifact is at the recorded PDF hash and reproduces the committed
rates exactly. The official per-bar report identifies two distinct raw issues
behind the two warning flags:

- **Measure 10, page 1/system 4:** `ScoreData.dTicks = 1680` (expected 1440),
  and the comparison misses MIDI pitch 60 (C4). The XML has the upper
  sixteenth run, then C5/B4 at `<forward><duration>6</duration>` (quarter 1.5),
  C5 at forward 8 (quarter 2), and E4 at forward 10 (quarter 2.5) with
  `<duration>4</duration>` (a quarter). The pinned MIDI has C4 at quarter 1,
  and E4 at quarter 2.5 for only a half-quarter. Thus the XML is already
  wrong: it drops C4 and over-reads E4 across the barline. `barRegrid` correctly
  refuses this bar because the over-read cannot fill a 3/4 bar without guessing.

- **Measure 34, page 2/end system:** the XML contains the final upper chord and
  one upper rest plus the lower F2 and one lower rest, each only through two
  quarters. The page/source prints `a,c f` quarter followed by two rests, and
  `f` quarter followed by two rests. `ScoreData` therefore pads this terminal
  underfull content to 1440 ticks. The padding preserves silence but the
  `measure_underfull` warning correctly discloses that the XML omitted a
  printed trailing rest. This is not measure 19; measure 19 is metrically full
  and has its own missing E4 comparison note.

Both first divergences are upstream of the parser’s trustworthy interpretation:
measure 10 has an absent note and an explicit wrong duration in MusicXML, while
measure 34 has an omitted rest at the export boundary. A generic parser repair
would either invent C4/E4 content, reinterpret an explicit quarter as an
eighth, or suppress a real underfull warning. Those hit the kill criteria
(XML already wrong requiring unverified upstream repair; invented durations or
notes; warning suppression). No parser files were changed and no pass is
claimed. The appropriate next experiment is a narrow Audiveris/upstream export
fix for m10/m34, followed by a fresh `.mxl` and page comparison; this Luna
cycle is attributed as an engine/export blocker.

## Follow-up: m10 beam/head-link hypothesis

The second bounded hypothesis was that the missing m10 C4 was present as a
glyph but lost while linking a head to a beam or stem. The `.omr` and the
binary page image do not support that seam.

In system 4, stack 10 is explicitly `duration="7/8" excess="1/8"`. Its upper
voice has only head-chords `7276` through `7283` at x positions 264, 313, 362,
421, 568, 627, 675, and 773. The printed C4 position is the clear black head
at approximately x=469, y=1939 in `sheet#1/BINARY.png`, between the recognized
head at x=421 and the recognized head at x=568. There is no `head`,
`head-chord`, stem, or relation at that position in `sheet#1/sheet#1.xml`.
The eight recognized upper chords all have complete `chord-stem` and head
containment relations; in particular E4 chord 7283 is linked to stem 5965 and
head 3467. Therefore there is no failed beam/head relation to repair.

The page image also shows why the head is not reached by the normal head scan:
the C4 head is printed below the treble staff without a surviving ledger line.
The m10 system XML contains no upper-staff ledger near x=469. Audiveris's
`NoteHeadsBuilder.processStaff` scans below the staff through detected ledgers;
the first relevant source seam is ledger retrieval (`LedgersFilter.process`),
not `ChordsBuilder.connectHead` or `HeadLinker`. A parser change would invent a
head and pitch, which violates the evidence and product lock.

The PDF loader's exact default is 300 DPI (`ImageLoading.Constants.pdfResolution`,
default 300). At that resolution the C4 head and its stem are crisp in the
binary artifact; the missing feature is the ledger line itself, not fragmented
ink. A 400 DPI rerun would therefore have no evidence-based mechanism to
create the absent printed ledger and is rejected as an ungrounded sampling
sweep. The beam/head-link hypothesis is killed: no engine file was changed,
no parser or gate allowance was changed, and no pass is claimed. Any future
source experiment must be a generic ledger-recognition investigation and must
be scored across the full bench with the no-green-to-red invariant.
