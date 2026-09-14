# BWV 939 tie localization (piece hypothesis)

## Baseline evidence

The official baseline result is `services/omr-service/eval/results/bench/bench.json`
for `bach-prelude-bwv939`: 179 reference notes, 195 MusicXML-derived notes,
16 extras, of which 12 are the six printed mordents and four remain
unexplained.  The four residual pitches are C3 in measures 2 and 3, A4 in
measure 8, and F3 in measure 15.

The pinned page is `/tmp/omr-rsi-baseline/bwv939-page.png`.  The page shows
the octave ties across measures 1--2--3, the paired treble ties at 7--8, and
the bass tie at 14--15.  The reference MIDI has one sustained C2 and one
sustained C3 from tick 0 through tick 4608; it has no C3 attacks at ticks
1920 or 3840.

## Layer localization

The 300 dpi artifact is

`services/omr-service/eval/cache/artifacts/4439ba40ce7916009c0c46186c1e3c71ec3ff16940926ddc8222f6f23a9f86f3-audiveris-5.11.0+svc-15-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/`.

Its `sheet#1/sheet#1.xml` contains:

* m1--2 and m2--3 tie curves 4378 and 4380, each linked only to the lower
  C2 heads 1396/1400/1404.  There is no surviving curve or relation for the
  upper C3 heads.  The MusicXML therefore correctly carries the C2 tie and
  repeats C3 as attacks.  A linker or parser change cannot safely recreate
  the C3 ties from this artifact: the curve evidence is absent at the OMR
  boundary.
* For m7--8, curve 4383 survives on the A4 heads 1538/1546, while curves
  4386 and 4389 both link to the C5 heads 1443/1447.  The emitted MusicXML
  has the two C5 stop ties and no A4 stop tie.  This is an engine-side
  tie-state/serialization discrepancy, not a `musicxml.ts` parser defect.
* The 300 dpi OMR has no slur object for the printed m14--15 F3 tie, so this
  site is also lost before MusicXML parsing.

As a controlled resolution comparison, the fresh 400 dpi artifact is

`services/omr-service/eval/cache/artifacts/4439ba40ce7916009c0c46186c1e3c71ec3ff16940926ddc8222f6f23a9f86f3-audiveris-5.11.0+svc-15-73d09423526056ef9012207d05752df86f9574b7b501aa3235256feb0fd228f9/`.

It produces 14 extras (only the 12 ornament extras plus the two C3 attacks),
and its OMR/XML retains the A4 tie at m7--8 and the F3 tie at m14--15.  The
same source code at higher raster resolution changes curve detection and tie
state; this is evidence for an engine image/curve-detection sensitivity, not
for a parser rule.  The upper C3 ties remain absent even at 400 dpi.

## Proposed rule and disposition

If an engine patch is attempted, the only defensible generic rule is in the
Audiveris tie-link path (`SlurLinker.selectBestHead` / `lookupLinkPair`, with
`SlurInter.checkStaffTie` as the tie-state gate): for a physical tie between
multi-head chords, retain the head whose staff pitch is continuous across the
two endpoints, and preserve separate curves as separate head relations.  Do
not copy a tie to every chord member.  This would be testable on the m8 case,
where a surviving below curve is associated with A4 while duplicate above
curves are associated with C5.

The 300-to-400 dpi comparison does not establish that this source rule is the
cause, and it cannot recover m2/m3 C3 without inventing missing curve evidence.
Consequently no parser/scorer change is justified and no engine source patch
was made.  A candidate fix must first demonstrate recovery of at least three
of the four residual extras and retain all currently passing pieces; otherwise
the hypothesis is killed.  The next artifact needed for a source attribution
is a fresh OMR run at a fixed raster resolution with tie-link diagnostics (or
an OMR containing the missing upper C3 curves), not a downstream timing or
allowance change.
