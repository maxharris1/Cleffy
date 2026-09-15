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
  `f` quarter followed by two rests. The exact cycle-12 sheet-2 OMR (last
  persistent id `5334`) identifies the first printed quarter rests at
  `x=2228` (glyphs `5241/5242`) as missed, while the second rests at `x=2318`
  (glyphs `5243/5244`, exported as inters `5330/5331`) survive and are placed
  at beat 1. `ScoreData` therefore pads this terminal underfull content to 1440
  ticks. The warning remains evidence of the first-rest recognition problem;
  it does not establish a missing trailing rest. This is not measure 19;
  measure 19 is metrically full and has its own missing E4 comparison note.

Both first divergences are upstream of the parser’s trustworthy interpretation:
measure 10 has an absent note and an explicit wrong duration in MusicXML, while
measure 34 misses the first printed quarter rests and misplaces the surviving
second rests. A generic parser repair would either invent C4/E4 content,
reinterpret an explicit quarter as an eighth, or suppress a real underfull
warning. Those hit the kill criteria (XML already wrong requiring unverified
upstream repair; invented durations or notes; warning suppression). No parser
files were changed and no pass is claimed. The m34 rest issue remains a
separate upstream engine hypothesis.

## Follow-up: m10 ledger/head gate hypothesis

The second bounded hypothesis was that the missing m10 C4 was present as a
glyph but lost while linking a head to a beam or stem. The `.omr` and the
binary page image do not support a failed surviving head/beam relation; the
new raster check instead localizes the loss to ledger recognition.

In system 4, stack 10 is explicitly `duration="7/8" excess="1/8"`. Its upper
voice has only head-chords `7276` through `7283` at x positions 264, 313, 362,
421, 568, 627, 675, and 773. The printed C4 position is the clear black head
at approximately x=469, y=1939 in `sheet#1/BINARY.png`, between the recognized
head at x=421 and the recognized head at x=568. There is no `head`,
`head-chord`, stem, or relation at that position in `sheet#1/sheet#1.xml`.
The eight recognized upper chords all have complete `chord-stem` and head
containment relations; in particular E4 chord 7283 is linked to stem 5965 and
head 3467. Therefore there is no failed beam/head relation to repair.

The raster evidence corrects the earlier “no printed ledger” wording. In the
300-dpi `sheet#1/BINARY.png`, the C4 event has a strong black head around
`x=462..489, y=1928..1949`, a short stem at `x=493..495, y=1919..1935`, and a
horizontal ledger core at `x=462..501, y=1936..1939`. The staff-7 bottom line is
at `y=1918`, with an interline of about 21 pixels, so this is the first ledger
below the treble staff at the requested `x≈469, y≈1939` location. It is not a
bar fill, text, or a pitch-only inference. The OMR has no `<ledger>` object for
staff 7 and no head/stem object at this location; the neighboring recognized
upper heads are at x=421 (head 3475) and x=568 (head 3409). The system-4 staff
map contains only the lower staff's `ledgers-entry index="-1"` objects 2398 and
2400.

The first proven downstream gate is therefore the ledger map. In upstream
5.11, `NoteHeadsBuilder.processStaff` scans the staff lines, then asks
`staff.getLedgers(+1)` while walking the virtual ledger lines
(`NoteHeadsBuilder.java:861–900`); an empty set breaks that walk at lines
879–883. C4's ledger ordinate is consequently never passed to a scanner, so
the strong head/stem cannot become a `HeadInter`. The preceding producer is
`LedgersFilter.process` → `LedgersBuilder.lookupLine` (`LedgersFilter.java:193–240`,
`LedgersBuilder.java:432–518`), which builds candidates from `NO_STAFF` and
accepts them only after the geometric/check-suite threshold. The serialized
OMR retains accepted objects but not rejected `StraightFilament` candidates or
their individual check impacts, so this artifact cannot truthfully distinguish
candidate extraction from a later thickness/length/convexity rejection. The
first attributable seam is ledger recognition, not `ChordsBuilder.connectHead`
or `HeadLinker`.

A temporary svc-16 engine trace against the exact PDF and the matching source
OMR now observes that candidate. The source artifact directory is
`services/omr-service/eval/cache/artifacts/5323449d08aa5031e974e275f182bebf8f533ecf62e5f9b0c9c36364f4b66469-audiveris-5.11.0+svc-15-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f`;
the source `.omr` SHA-256 is
`35da78b691eb915315492ff3ce279876f0a8de83200126fa2ff9c9a2cbc892f8`, and its
`sheet#1/sheet#1.xml` has `last-persistent-id="7732"`. The exact PDF SHA-256 is
`5323449d08aa5031e974e275f182bebf8f533ecf62e5f9b0c9c36364f4b66469`.

The printed ledger is extracted as `StraightFilament 2601` with bounds
`x=462,y=1936,w=41,h=4` and thickness `3.8537`. It survives factory, beam
overlap, and length purges. `LedgersBuilder.lookupLine` accepts it on virtual
line `+1` with impacts grade `0.7477815` against threshold `0.08`; reduction
retains it as `LedgerInter 2386` and adds it to staff 7. `LedgersPostAnalysis`
then measures delta `20.0131` pixels and height `3.8537`; the learned ranges are
delta `[15..19]` and height `[3..5]`, so only the `DELTA` check rejects this
candidate. The output OMR still has no staff-7 target ledger. A separate
overlapping fragment (`x=421,y=1932,w=22,h=3`) is discarded for `height` and
`delta`; other nearby fragments fail impacts grade or virtual-line containment.

This is a concrete engine boundary: the ledger is extracted and passes the
geometric check suite, then the generic `LedgersPostAnalysis.filter` removes it
as an ordinate outlier (`LedgersPostAnalysis.java:282–315` in the temporary
source). The next engine experiment should be a bounded retention rule in
`LedgersPostAnalysis.java` or its ledger-recognition seam: retain a first-below-
staff candidate that is physically attached to notehead/stem-shaped ink at that
ordinate (the ledger step precedes head construction), while preserving all
existing candidate checks. It must include negative controls for clef loops,
text strokes, and short horizontal marks, and must show those controls remain
absent from the staff ledger map. A global delta threshold change is unsupported
by this trace and is not proposed. No production source, parser, scorer, pin, or
gate was changed.

The PDF loader's exact default is 300 DPI (`ImageLoading.Constants.pdfResolution`,
default 300). At that resolution the C4 head, stem, and ledger are crisp in the
binary artifact; the missing feature is the accepted ledger interpretation, not
the printed ink. A 400 DPI rerun would therefore be an ungrounded sampling
sweep. The beam/head-link hypothesis is killed: no engine file was changed, no
parser or gate allowance was changed, and no pass is claimed. Any future source
experiment must be a generic ledger-recognition investigation and must be
scored across the full bench with the no-green-to-red invariant.

## Temporary bounded retention result

The temporary rule was implemented only in
`/tmp/omr-rsi-inv8-head-probe/LedgersPostAnalysis.java`. It is restricted to
`DELTA` with height already passing, virtual line `+1`, and
`abs(delta - interline) <= 0.15 * interline`. Its page test finds an 8-connected
filled component after excluding the candidate ledger, requiring occupancy
`>=0.20`, width `>=0.9 * interline`, height `>=0.5 * interline`, and an
edge-positioned vertical run of `>=0.5 * interline` that touches the same
component. On the exact artifact, candidate 2601 / `LedgerInter 2386` was
retained despite the learned `DELTA` outlier. The `ink=366`, `27x27` body, and
`stem run=19` values belong to the earlier broad instrumented diagnostic; the
clean source emits no diagnostic measurements. The overlapping short candidate
2392 failed the connected-body test and was discarded.

The retained ledger is serialized at `x=462,y=1936,w=41,h=4`, and
`NoteHeadsBuilder` now exports the missing m10 upper C4 at the correct eighth
duration. The prior m10 E4 over-read is also reduced to an eighth by the same
rhythm interpretation. Running the current parser comparator on this temporary
artifact gives 597 OMR notes versus 598 reference, one missing, zero extra,
pitch `99.8328%`, exact `99.6656%`, onGrid `99.3311%`, and all 34 bars at the
correct length. The one missing m19 note is within the note allowance. The sole
official gate failure is m34's independent `measure_underfull` warning from
first-quarter-rest recognition, outside this hypothesis.

The retained output files from the clean final run hash to OMR
`a543c70da0f029fbe7b775b69b7177823b5e0ce2a70719e6a7a999f354c92308` and MXL
`a31ce893c2fe73e71b44b7a5016b2bccd12412df7a08930bef2898356cbc933d`. The
actual-page evidence controls accepted the printed ledger head
(`x=462,y=1936,w=41,h=4`) and rejected the short horizontal fragment
(`x=421,y=1932,w=22,h=3`), clef-loop ink (`x=130..186,y=1798..1946`), and
title-text stroke (`x=1042,y=186,w=41,h=4`). The clean source SHA-256 is
`70a046ea263be88ec89cd032a4e20c8d896e5bd2860317111a0a792b2ff8ef88`; image
`cleffy-omr-rsi:inv8-final` has digest
`sha256:71cd591e5122a58211cef0e419213fc967d9d63d3d8eb7007e8ff11a0287dba2`.
The final run log is `/tmp/omr-rsi-inv8-final-run.log`; controls and their
command/output are in `/tmp/omr-rsi-inv8-evidence-final-build.log` and the
associated run log. The final official grader reported combined artifact hash
`a792de0a29afe66d240b15fed6f6cf92234db9c1ff0e7cfe559f85313133b817`, 597 OMR
notes versus 598 reference, one missing within allowance, zero extra, and the
sole gate failure `measure_underfull` from m34. The target m10 C4 is recovered.
