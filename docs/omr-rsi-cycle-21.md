# OMR RSI cycle 21 — Schumann's internal double line at export

**One hypothesis for Grok. Implementation and host validation pending.**
Astra performs thought, read-only localization and documentation only;
Grok implements on `mh/omr-rsi-notes-fixes-c12b` (PR 41); the host runs
Audiveris, Docker and the official suite. The current user instruction and
[split loop](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/omr-rsi-split-loop.md)
override older implementer/bench instructions in the pass-all plan.

## Starting truth and cycle-20 disposition

[Cycle 20](omr-rsi-cycle-20.md#official-result-and-kill-criteria-review--2026-09-14)
records the completed official result at HEAD `62939e8`, engine
`audiveris-5.11.0+svc-26`, container `cleffy-rsi-omr-26`, generated
`2026-09-14T20:57:51.170Z`. `bench.json` SHA256 is
`1900c46cb7aaaa5ea76164951f22d6e19c9a89cf45027c8534d5c157b1c997ca`.
Suite **8/16**, 5,996 notes, pitch **98.182%**, exact **96.831%**, on-grid
**96.181%**, **78 missing / 121 extra**. `BENCH_EXIT=1` means the complete
suite remains unfinished, not an export crash.

Credit **Schumann Op. 68 No. 5: 26 → 25 bars, 279 notes retained,
5/5 → 0/0 missing/extra, exact 94.6% → 98.2%** against svc-24.
The protected eight all remain green. **No pass-count change is accepted.**
Full cycle-20 acceptance is rejected because the exported double line
moves to the start of m8, violating its explicit separator-position kill
criterion. A single saved-sheet reload/export succeeded; repeated engine
processing and actual lifecycle negative controls remain unproven.

## Remaining gate checks: endpoint evidence, not missing ink

Piece: **Schumann — Album für die Jugend, Op. 68 No. 5 (Stückchen),
`schumann-op68-05`**. Read the pinned page, not just the two gate strings.
The PDF is `services/omr-service/eval/cache/downloads/schumann-op68-05.pdf`,
SHA256 `8f56f70d597a838d23590ed5bbc9ecf10b21e77f07620019cdc2d06b931f7c17`.
The source corroboration is `/tmp/schumann-op68-05.ly`, SHA256
`f1f6e3d2a53132bf96e1c703df3131b2d3c34cf43f920fa5bd6088bd691ee8c0`,
already recorded in cycle 18. It is diagnostic evidence, not production input.

| Site in svc-26 | Page/source and exported duration | Existing gate consequence |
| --- | --- | --- |
| Opening m0, `implicit="yes"` | Page has E5/F5 quarters over four eighths: two quarters. XML agrees. Both source staves declare `\partial 2.` followed by **invisible `s4`** before those notes | The corpus expects `pickupQuarters: 3`; the parser keeps two quarters (960 ticks), so the pickup differs from the 1440-tick expectation |
| Terminal printed m24, ordinary numbered measure | Page ends with D5/C5 quarters, F4/E4 quarters and simultaneous C4 half, followed by a real light-heavy final line: two quarters. XML agrees; no following rest is printed | `placeMeasures` pads the non-pickup two-quarter content to four quarters and emits `measure_underfull`; padding makes its `dTicks` agree with the pin's default full bar |

Thus `bar-length (1 of 25)` identifies the **pickup**, while the surviving
`measure_underfull` comes from the **terminal bar**. The repaired m8 has
four quarters and is neither endpoint failure. This attribution follows
the saved XML and existing `src/musicxml.ts::placeMeasures` plus
`src/eval/compare.ts::omrBarList`; no scorer was run or replaced.

The [LilyPond notation reference](https://lilypond.org/doc/v2.24/Documentation/notation/writing-rests#invisible-rests)
defines `s` as an invisible spacer rest. The page supplies no quarter-rest
ink to recover at the opening, and no missing half rest at the end.
Treating a layout spacer as a lost recognized symbol, or inserting time
solely to satisfy these pins, is unsupported. The endpoint discrepancies
need a separate source-versus-reference/policy decision; this round does
not authorize a pin rewrite, a parser exemption, or a fabricated rest.
The earlier shorthand describing the two checks as one bad bar is not a
sufficient localization.

We stay on **the same piece**, using the independently observed export
defect that misplaces the printed separator and already kills cycle 20.
The following is the **only implementation
hypothesis**; endpoint diagnosis above does not authorize a second repair.

## One hypothesis and exact seam

**Schumann's printed double-thin separator at quarter offset 2 inside m8
survives the merge in the saved OMR, but Audiveris exports it before all
voices as a left barline. Preserving the recovered separator's rational
time through reload and emitting one true MusicXML middle barline at that
time will restore the printed separator without changing any musical
event or measure length.**

The svc-26 artifact directory is:

```text
services/omr-service/eval/cache/artifacts/8f56f70d597a838d23590ed5bbc9ecf10b21e77f07620019cdc2d06b931f7c17-audiveris-5.11.0+svc-26-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/
```

| Artifact | SHA256 |
| --- | --- |
| `omr-eval-input.omr` | `2dffbc00aa9479ff08ccbe97fceedba08b8e28e4798499081501463287e029f7` |
| `sheet#1/sheet#1.xml` inside OMR | `6b85023f7b5d270b5277423b2ffc4fe904f9574ecc49c90d850f4ff87e3b9553` |
| `omr-eval-input.mxl` | `c7e7549865a1ef5628043fddcabf720102eefe54cf81913bfd27b6a2e496c392` |
| Root MusicXML inside MXL | `13cd345161c4939fb9ef73b55b2c73fbd916cf8e21a47b4b4fb60da7eff39a1f` |

In saved sheet system 2, stack/measure 8 has `expected="1" duration="1"`,
eleven head chords and a `mid-barline` referencing staff-barline IDs
6088/6089. Its right barline references 6090/6091. These are fixture IDs,
not production selectors. The page shows the internal double line after
upper D5/C5, before B4/C5; the lower C4 half ends there.

The exported measure instead starts:

```xml
<measure number="8" width="206">
  <barline location="left"><bar-style>light-light</bar-style></barline>
  <!-- D5 then C5, followed by the other voices -->
```

There is no `location="middle"`. All eleven notes have the intended
onsets and durations; the internal line's position is the failed invariant.

The pinned [Audiveris 5.11.0 PartwiseBuilder](https://raw.githubusercontent.com/Audiveris/audiveris/5.11.0/app/src/main/java/org/audiveris/omr/score/PartwiseBuilder.java)
explains the seam: `processMeasure` handles `getMidPartBarline()` before
the voice loop; `processBarline` maps every non-RIGHT location to LEFT.
Changing that enum alone would still emit the separator at time zero.
The [MusicXML barline definition](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/barline/)
requires the declared location to agree with its position in the musical
stream. The fix must preserve both location and rational stream position.

## Bounded implementation contract for Grok

1. Implement only the timed export of a **source-verified plain internal
   double-thin separator** produced by the existing guarded recovery.
   Scope: the pinned `PartwiseBuilder` export path, narrowly necessary
   persistent separator-time support at the existing merge boundary,
   focused controls and matching engine patch/build wiring. Do not change
   general mid-bar repeat/ending semantics or reinterpret every existing
   `mid-barline` as this new case.

2. Obtain the separator time from the recognized pre-merge fragment
   timeline, or an equivalently unambiguous source-bound timing relation.
   Preserve it across saved-OMR reload. Validate it strictly inside the
   surviving measure and consistent with the captured fragment boundary
   before mutation. Do not infer it from half the meter, the number 8,
   pitch patterns, piece IDs, hashes, coordinates, the corpus, MIDI or `.ly`.
   At this fixture only, it is 1/2 whole note = two quarters = four XML
   divisions when divisions-per-quarter is 2.

3. Emit exactly one `light-light` middle barline for that part at the
   established musical cursor offset. Account for backups, forwards,
   simultaneous voices and the lower sustained half note. Preserve all
   note/rest/clef/tie/slur/dot/articulation events, onsets, durations and
   the existing voice reconstruction. Do not emit once per voice/staff,
   insert silent padding, split notes, or change durations merely to reach
   the separator. Remove the misplaced duplicate left emission for this
   recovered separator while preserving any distinct real left boundary.

4. Preserve all cycle-19/20 eligibility guards, numbering, source anchors,
   right-fragment shift and ownership. Keep one four-quarter m8, all 25
   measures, the already-correct m16 phrase, the opening clef repair, the
   final light-heavy line, genuine counted bars and repeats. An unsupported
   timing state must not silently export a guessed position or a partial
   mutation; log the exact blocker. Skipping this pinned positive target
   is a failed implementation, not a successful fallback.

5. Keep parser, `buildScoreData`, `services/omr-service/src/eval/`, warnings,
   floors, allowances, source/reference pins, options and deployed
   generation unchanged. Preserve `lyrics=false`, `implicitTuplets=true`,
   `fingerings=true`. Use a fresh engine version (`audiveris-5.11.0+svc-27`
   if available) with matching provenance. No endpoint repair is part of
   this change. If another independent defect appears, record it and stop.

## Controls, host prediction and kill criteria

Require a control through the **real merge → stored OMR → reload →
PartwiseBuilder export** path, not only the pure table planner. Walk the
exported XML cursor through notes, chord members, backups and forwards;
assert one middle separator at two quarters with no spurious left/right
copy. An enum check or a `mid=LIGHT_LIGHT` log alone is insufficient.

Use the existing three-left/two-right voice fixture, the C4 half sounding
through offset 2, overlapping old slot IDs and voices entering only in
the right fragment. Test a valid boundary away from half the meter to
exclude a fixed half-bar rule, missing/ambiguous boundary timing, repeated
recovery and repeated export. Retain negative controls for true counted
bars, 5 → 11, conflicting anchors, multiple eligible pairs, repeats,
endings, signature changes, final/heavy bars and unsupported separators.
Existing left/mid repeat handling and real left barlines must stay intact.

Predicted result: **25 bars, 279 pitched notes, 0/0 miss/extra, exact/on-grid
274/279**, with one correctly positioned internal line. **Schumann should
still FAIL the same two endpoint checks, and the suite should remain
8/16.** This is a required source-fidelity correction to cycle 20's killed
candidate, not a claimed ninth pass. An unexpected gate improvement from
this export-only change requires attribution before acceptance.

The host must use all 16 byte-identical pinned inputs and the unchanged
official scorer. Require a newly completed matching report and successful
export/reload; **do not require exit 0 from an intentionally still-8/16
suite**. Here a complete matching report plus exit 1 is expected. An
exception, missing/stale report or incomplete suite blocks acceptance.
Compare against svc-26 for this change; retain svc-24 to establish the
structural gain. All non-target MusicXML part content and Schumann musical
events should remain unchanged apart from separator serialization and
necessary engine metadata. The host must demonstrate repeated recovery
and export stability, not assume them from one successful reload.

Kill the candidate if the line remains at the left, disappears, duplicates,
moves to a wrong time, or returns to two measures; if any note/event changes
pitch, onset, duration or simultaneity; if filler or invented holds appear;
if ownership/slot state breaks or saved/repeated processing changes the
result; or if unrelated recognition, repeats or true barlines change.
**Any currently passing piece going red kills it.** Specifically preserve
Czerny 821/1, BWV 999, Anh. 114, Anh. 115, Anh. 116, Burgmüller Op. 100/2,
Schumann Op. 68/1 and Chopin Op. 28/4. Reject lower floors, extra allowances,
warning suppression, reference-derived repair and unexplained gains.

## Astra handoff

Only the cycle-20 ledger and this new hypothesis were edited. Existing
dirty bench reports and `controls2.log` remain untouched. Astra ran no
tests, bench, Audiveris or Docker, edited no engine/parser code, and made
no commit. Grok implementation and host validation are pending.
