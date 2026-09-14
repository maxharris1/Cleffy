# OMR RSI cycle 25 — Satie's time numerals consumed as key/rest ink

**One piece, one ink-level cause, one implementation contract for Grok.**
Implementation and official host validation are pending. Under the
[locked split](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/omr-rsi-split-loop.md),
Grok implements on `mh/omr-rsi-notes-fixes-c12b` / PR 41; the host alone
runs Audiveris, Docker and the official benchmark. Astra writes this packet
from existing evidence.

## Starting truth and target

Accept the [official table](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/rsi-split-loop-bench.md)
generated **2026-09-14T22:57:10.330Z** and the
[Cycle 24 host verdict](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/omr-rsi-cycle-24-host.md):
**10/16**, engine **`audiveris-5.11.0+svc-30`**, HEAD **`d596b1c`**,
**5,996 reference notes, 74 missing / 121 extra**. Pitch is
98.24883255503669%, exact 97.33155436957972%, on-grid
96.53102068045364%. The local official `bench.json` SHA256 is
`786941626af1eabc6f5db371a09f746bdafa09a5902d4982c4e99b8863c7fc74`,
matching the host verdict.

Cycle 24 is **not credited**: Invention 1 remains FAIL with 23 missing /
37 extra, and neither a changed export nor a host coexistence trace
confirmed its proposed removal seam. Do not retry that clef/beam rule,
extend it, or include a clef-loop/slur repair here.

Cycle 25 targets only **Satie, Gymnopédie No. 2, page 1, first system,
the printed opening 3/4 on both staves**. Its official svc-30 result is
371 reference notes, 4 missing / 4 extra, pitch 97.57412398921834%,
exact 92.99191374663073%, on-grid 89.75741239892183%. It fails
`measure_overfull`, bar length in 4 of 65 bars, attack-grid and note-length.

## One hypothesis

**The opening time-signature numeral ink is claimed by key recognition
before the time signature is established. The remaining numeral fragments
then become quarter rests.** The page prints a 3 above a 4, with no key
accidental, on each staff. The saved graph instead contains frozen flat
key signatures made from that column, two narrow false quarter rests,
and no time signature. This one ownership error explains the wrong opening
key, the extra leading rest slot and the missing printed meter.

The proposed repair is an early, source-confirmed numerical time column:
bind the two visibly painted numeral outlines to the original sheet ink,
keep that proven column out of key extraction, and let the ordinary header
time machinery own it. This is a recognition decision before note/rhythm
processing. Do not infer a meter from bar totals, the corpus or MIDI.

The frozen graph establishes the wrong ink ownership, but does not retain
the rejected header-time candidates or every intermediate key decision.
Host tracing must establish that the candidate preserves and recognizes
the original digits at this boundary. A source-hint acceptance log alone
will not establish recovery.

## Evidence bound to svc-30

Pinned source:
`services/omr-service/eval/cache/downloads/gymnopedie-2.pdf`, SHA256
`d23906c422539128fe0e5106a4ebf8ea7f8273a60c3f2dbcf4c7f5f46363acb6`.
Page 1 is object 4, MediaBox `[0 0 612 792]`, rotation zero, content
stream 5. Font object 13 is embedded `RSERWW+Emmentaler-20`, resource
`/R13`, with encoding object 35. The encoding inherits `three` and `four`
from WinAnsi; its Differences array assigns other musical names at codes
0–7 and 67. Thus these are **numeral glyphs in the music font**, not
`rests.2`, not a text-OCR guess, and not glyphs named `time.3`/`time.4`.

Stream 5 visibly paints `(4)Tj` and `(3)Tj` at font size 19.9256 on
each staff. The lower pair follows text origin `(425.32,702.748)` with
`-329.547 -62.8462 Td`, `(4)Tj`, then `0.680391 10.0343 Td`, `(3)Tj`.
The upper pair follows the intervening F clef, with `20.9215 30.3241 Td`,
`(4)Tj`, then `0.680391 10.0345 Td`, `(3)Tj`. Account for the complete
graphics/text matrices, including the enclosing scales; these stream
coordinates and character codes are fixture locators, never selectors.

Saved artifacts are in:

```text
services/omr-service/eval/cache/artifacts/d23906c422539128fe0e5106a4ebf8ea7f8273a60c3f2dbcf4c7f5f46363acb6-audiveris-5.11.0+svc-30-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/
```

`meta.json` declares and observes svc-30 with the locked options.

| Evidence | SHA256 |
| --- | --- |
| `omr-eval-input.omr` | `0046bf2eac011aa7cb69cdc79bcad5f3f1a35159b24502c2be28264df42ea1ad` |
| `sheet#1/sheet#1.xml` | `09357b5c85f689ffe3412bbbec429cf7c774e7e0a880aa084b6479ab011eb3a3` |
| `sheet#1/BINARY.png` | `04d503e2a8922bfff57c9dfbeaabca264d79eb1c5b50f87d0c35a65361020fda` |
| `omr-eval-input.mxl` | `e926aa0d56fb15e48d7b0222beac83679a347897618dfd3f737b5765cf46f208` |
| Root XML inside MXL | `710208bedd6b57b7399c3354de9ed786697d69226b7ffc27ab4b9aa8bcb3da0d` |
| `audiveris.log` | `66900dbec2408b25937d323ad46fed94b070460ac7fb3986e8c9420fc1362f77` |

The reviewed `/tmp/gym-binary.png` has the exact svc-30 BINARY hash above.
It visibly shows 3/4 on both staves, an ordinary upper quarter rest to its
right, an upper whole-measure rest, and the opening dotted-half bass G2.
The saved picture is 2550×3299 with zero skew.

Both staff headers stop at x419 and contain a clef and key, but no time.
Upper staff lines are y361, 382, 403, 424, 444; lower lines are y550,
571, 592, 612, 633. The wrong and real objects are separately identifiable:

| Object in final graph | Inter / glyph | Box `(x,y,w,h)` | Evidence |
| --- | --- | --- | --- |
| False upper key alter / key | 339 / 336; key 340 | `(403,363,17,67)` | `FLAT`, frozen, key fifths -1 |
| False lower key alter / key | 359 / 356; key 360 | `(403,577,17,41)` | `FLAT`, frozen, key fifths -1 |
| False upper quarter rest | 6666 / 6102; chord 6694 | `(420,363,9,47)` | numeral-column fragment |
| False lower quarter rest | 6669 / 6104; chord 6696 | `(420,552,9,47)` | numeral-column fragment |
| Real upper quarter rest | 6674 / 6114; chord 6698 | `(472,371,22,58)` | distinct printed rest; preserve |
| Real upper whole-measure rest | 6682 / 6140; chord 6699 | `(530,381,31,14)` | distinct printed rest; preserve |
| Real upper half-note chord | chord 5718 | `(552,351,25,135)` | three printed heads; preserve |
| Real dotted-half bass | chord 5736 | `(475,623,27,65)` | printed G2; preserve |

The narrow false rests are ordinary raster interpretations, not recoveries
of named `rests.2` evidence. Source-confirmed time ownership must prevent
these interpretations; changing the accepted quarter-rest helper is not
part of this repair. All numeric IDs are run-specific locators.

The existing log also records source numeral outlines around x399–432,
y361–445 on staff 1 and y550–634 on staff 2 while scanning printed
system numbers; it rejects their binding as system numbers. Those logged
coordinates use that helper's existing transform and its ink counts are
not the new time-column agreement test. Do not relabel those logs as a
successful time match or modify the system-number helper.

In raw MusicXML m1, divisions-per-quarter is 1. Upper voice 1 has the
false rest at 0, the real rest at 1, then the B-flat3/E4/G4 half-note
chord at 2. Upper voice 2 has its measure rest with duration 4. Lower
voice 5 has the false rest at 0, followed by the dotted-half G2 at 1.
The stack duration is `1` whole note, not the printed `3/4`. There is
no `<time>` anywhere in the export. `MeasureFixer` reports no target
duration for every system and asks for time-signature checking.

The fictitious -1 key also changes the unaltered B3 in m3, m5, m7 and m9;
m10 explicitly returns to zero fifths. This is a consequence of the same
opening ink error, not permission for a pitch correction.

Read-only cursor accounting of the **current** svc-30 XML finds only
four overlong measures: **m1 = 4 quarters; m20, m32 and m53 = 5 quarters**.
The older [Satie localization](omr-rsi-gymnopedie2-localization.md) predates
accepted rest work; its longer list of missing-rest bars is not the
current baseline. The remaining m20/m32/m53 voice/slot faults, m27 missing
chord and tie errors are separate unresolved findings. Do not append
repairs for them.

## One implementation contract for Grok

Static inspection of the locally extracted stock 5.11.0 bytecode gives
the responsible seam. `HeaderBuilder.processHeader()` computes header
starts, retrieves clefs, calls `setSystemClefStop()`, then runs
`KeyColumn.retrieveKeys(maxHeaderWidth)` and `setSystemKeyStop()` **before**
`HeaderTimeColumn.retrieveTime()`. Final clef selection and header freezing
follow. `HeaderTimeColumn.allocateBuilder()` passes `staff.getHeaderStop()`
as the time builder's starting boundary. The false key therefore advances
that boundary into the printed numeral column. Suppressing that erroneous
key claim should let ordinary time retrieval see the intact pair.

`KeyColumn` constructs per-staff key builders but returns a maximum key
width, which header processing applies across the system. A blanket change
to `maxHeaderWidth` is therefore unsafe. The reservation must account for
both per-staff extraction and the shared key-stop calculation. The inspected
`HeaderTimeColumn.class` SHA256 is
`ed56d3a690dd9f1a0ddb062d4fb8b6b583d7408831eb45a8179f1d31decca316`;
`KeyColumn.class` is
`698707ea5e49642f6168b470f7edad4eccfad18c3ef12deafb8ed766c73d4a7d`.
These are static local witnesses, not fresh container provenance; the host
must bind the actual classes used by its control and candidate.

Implement **source-confirmed ownership of an opening numerical time
column before key extraction**, with only the evidence helper and narrow
header/key/time plumbing necessary for that rule.

1. Add a helper, proposed `sheet/time/PdfHeaderTimeHints.java`, using the
   bundled PDF reader and the book's actual source/page. Resolve numeral
   names through the embedded music-font encoding and nonempty outlines.
   A supported first scope is one numerator digit over one denominator
   digit in an ordinary staff header. Require one unambiguous staff,
   vertical numerator/denominator placement, a shared horizontal column
   after the clef, and an ordinary supported time value. Bind both printed
   staff instances independently; do not copy an unverified pair to the
   other staff. For this first scope, arm only when every relevant staff
   in the affected system has its own proven, mutually consistent time
   pair and compatible header-column alignment. Title numbers, fingerings,
   tuplets, bar numbers and lone
   digits cannot qualify. No literal 3/4, filename, hash, subset prefix,
   character-code, coordinate, glyph-ID or reference-pitch selection.

2. Prove the source registration and visible ink **before** granting
   ownership. Use the actual loader's effective DPI scale, crop origin,
   y inversion and float/rounding semantics. The 2550×3299 canvas must
   validate the transform, not define its scale. Preserve page pixels,
   resolution and preprocessing. Require pixel-center agreement on the
   complete numeral-pair outline and untrimmed corresponding staff-free
   ink components, including support outside the outline bounds, with
   symmetric staff-line exclusion: **recall outline >=0.90, recall glyph
   >=0.90, IoU >=0.85**. Each numeral must have its own visible support;
   one intact numeral cannot stand in for an erased partner. Report exact
   intersections, denominators, exclusions, both outlines and registration
   provenance. These new scores have **not** been measured here. If the
   pair fails, stop rather than alter the test. No clipping away unexplained
   component ink to make agreement pass, morphology, offset search, fitted
   transform, neighboring-template match or threshold relaxation.

3. In `HeaderBuilder.processHeader()`, prepare the verified reservation
   after the ordinary clef boundary is available and before key retrieval.
   Pass a per-staff browse-end constraint into key extraction: its ROI and
   candidate projection must end before the complete time-pair union's
   left boundary. Preserve all genuine key-signature ink before it. Do
   not change the global `maxHeaderWidth`; ensure the system-wide selected
   key stop cannot advance into any reserved pair. If staff geometry or
   an actual key makes those constraints inconsistent, reject the whole
   provisional reservation and take the unchanged path.

   Preserve the ordinary clef → key → time order. Let
   `HeaderTimeColumn.retrieveTime()` / `HeaderTimeBuilder` see the unchanged,
   complete raster pair from the corrected header boundary, then use their
   existing extraction, classifier, time-number/pair creation, relations,
   consistency checks and finalization. **This candidate corrects the key
   search boundary only; it does not add source-backed time evaluations or
   insert time inters.** If intact-digit access is insufficient for ordinary
   time recognition, record that separate blocker and stop. No classifier
   threshold/grade change, manual time object, forced freeze or later key
   deletion. Normal header finalization owns selected inters and ranges.

4. The same ownership decision must prevent the two numeral fragments
   from becoming rests: normal time-header bounds and symbol exclusion
   must cover the recognized time pair. Do not add a second late rest
   suppression rule, erase source pixels, repair slot offsets, or force a
   key value. Do not remove the real quarter or whole-measure rest to the
   right. Any new reservation must be conditional on a fully validated
   time pair and inert if it cannot be committed through normal header
   recognition; failed or unavailable evidence must retain the old path,
   including original key-search bounds. Validate a clean fallback for
   ordinary time-retrieval failure: restoring only a bound after key/graph
   mutation is insufficient. Discard provisional state and complete the
   original header path without residual candidates, range changes or
   exclusions. Do not leave a rejected hint masking genuine notation.

5. Scope evidence and processing to source content, page, render metadata
   and the current header; no cross-book cache reuse. Repeated processing
   must neither duplicate a time pair nor progressively shrink a key range.
   Preserve recognized numerical/common/cut-time signatures, ordinary
   and octave clefs, and existing headers. Unsupported source formats,
   encodings, transforms, clipping/visibility or ambiguous component
   ownership must fall through unchanged. Support only cases whose visible
   paint can actually be established; invisible or subsequently occluded
   numerals are not evidence.

6. Limit changes to this helper, its required header/key/time hooks,
   reproducible patch/build/provenance wiring and focused controls. Use a
   fresh engine revision, **svc-31 if available**, with matching declared
   and observed provenance. Preserve engine svc-30's accepted work and
   deployed generation. Leave parser, `buildScoreData`, rhythm/voice
   algorithms, exporter, scorer/eval, warnings, corpus/reference pins,
   floors and allowances unchanged. **Do not restore patch 0006. Do not
   touch Schumann pickup/end pins or its accepted m8 internal separator.**
   Keep quarter-rest minima and implementation unchanged, including the
   loader-scale correction that protected Air and Invention 8. Keep
   `lyrics=false`, `implicitTuplets=true`, `fingerings=true`.

## Discriminating controls and host acceptance

Grok's focused controls must use the actual source reader, source outlines
and saved sheet ink for both opening pairs. Include translated equivalent
geometry with known render metadata, the fractional canvas-height case,
an already recognized time pair, a real key signature immediately before
a time pair, and ordinary/octave-clef preservation. Negative controls
include wrong source/page, erased numerator or denominator, lone or
nonaligned digits, title/tuplet/fingering numerals, a genuine flat,
ordinary quarter rests, invisible/occluded paint, unsupported transforms
and ambiguous touching ink. Verify original behavior after rejected
evidence, duplicate processing and stale provenance. The actual first
upper quarter rest and whole-measure rest are explicit preservation
controls. A synthetic pair at fixture coordinates is insufficient.

The host owns all engine runs. Bind a svc-30 control and fresh candidate
to the pinned source, configuration and actual loaded classes. Trace the
digit pair before key extraction, key bounds/candidates and chosen key,
ordinary time candidates/pair and header stop, then SYMBOLS, RHYTHMS,
saved OMR and reload/export. Show source-bound object continuity rather
than depending on numeric IDs. Required local outcomes:

- Both printed time signatures become ordinary 3/4 header time objects
  at their actual positions, surviving normal processing and reload.
- The false key alters/keys and two numeral-fragment rests are absent
  because their source ink belongs to those time objects. The effective
  opening key is neutral; no fictitious -1 key remains. All real key ink
  elsewhere and m10's neutral-key behavior are preserved.
- MusicXML states 3/4. In m1 the real upper quarter rest starts at quarter
  offset **0**, its B3/E4/G4 half-note chord at **1**, and the upper
  measure rest spans **3** quarters. The dotted-half G2 starts at **0**
  and lasts **3**. Preserve all four pitched note elements, head/stem/dot
  evidence, and the real barline. The normal opening stack has expected
  and actual duration `3/4`, with no invented leading rest or padding.
- The five source-unmodified B3 notes in m1/m3/m5/m7/m9 are interpreted
  under the corrected header, without rewriting head pitch or XML notes.

**Conservative prediction: a partial Satie repair, still 10/16.** The
opening bar and key should be corrected; no pass is promised while the
other three overlong bars and independent defects remain. Missing/extra
counts are expected to remain 4/4 for Satie and 74/121 for the suite if
only this localized header effect occurs. Exact/on-grid may improve, but
new meter information can affect normal rhythm processing, so any wider
change needs source/graph attribution. Do not force unchanged downstream
output, and do not credit an unexplained improvement.

Require a newly completed **full 16-piece official report** on identical
pins, scorer/options and matched build provenance. A partial/stale report
or an exception is not acceptance. `BENCH_EXIT=1` remains expected for
the unfinished suite. Inspect every changed piece and every changed
Satie bar. Any claimed pass must clear every existing gate and have a
source-correct export; a header log or higher aggregate percentage is
insufficient.

Kill this candidate if either source/ink proof fails; the original digits
do not survive normal header recognition; a reservation persists after
failure; genuine key, clef, rest or note ink is lost; the opening remains
wrong or only export/reload conceals it; implementation requires a second
rest/key/rhythm repair, relaxed thresholds, fabricated timing or changed
pins; or any protected passer goes red. Protect all **ten**:
**Czerny 821/1, Air Anh. 131, BWV 999, Anh. 114, Anh. 115, Anh. 116,
Burgmüller Op. 100/2, Schumann Op. 68/1, Chopin Op. 28/4 and Invention 8**.

## Astra handoff

Astra inspected existing documents, the pinned PDF stream, the saved
svc-30 graph/MusicXML/log, matching binary page and static local bytecode.
No candidate matcher,
Audiveris, Docker or npm eval was run. No engine, parser, scorer, pin or
floor was edited and no implementation commit was made. Pre-existing
dirty benchmark reports were left untouched. The only task writes are
this hypothesis and its identical copy in the requested host docs store.
