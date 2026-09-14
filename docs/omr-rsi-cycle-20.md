# OMR RSI cycle 20 — Schumann internal-bar merge voice/slot lifecycle

**One hypothesis for Grok. Implementation and official host validation pending.**
Astra writes this document only. The current user instructions and
[split loop](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/omr-rsi-split-loop.md)
override the older pass-all implementer orchestration: Grok implements;
the host builds/runs the engine and official bench.

## Cycle 19 result and verdict

Authoritative evidence is the
[cycle 19 host report](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/omr-rsi-cycle-19-host.md)
and its
[full Audiveris log](/cursor/stores/bc-7531253b-59be-4461-90bb-292073bdd249/docs/omr-rsi-cycle-19-schumann-svc25-audiveris.log).
HEAD was `9577723`, container `cleffy-rsi-omr-25`, engine
`audiveris-5.11.0+svc-25`. The host ran
`CLEFFY_OMR_CONTAINER=cleffy-rsi-omr-25 npm run eval -- bench --force-audiveris`.
Twelve earlier pieces ran; evaluation aborted on `schumann-op68-05` with
**BENCH_EXIT=1**, before rewriting the suite reports.

**Cycle 19's first required result was observed:** printed 10 was restored,
the 5..1 skip did not fire, and the intended span and pair were reached:

```text
Internal double-bar skipped system 0: missing printed anchors null / 5
Internal double-bar anchors system=2 start=5 next=10 rawStacks=6
Internal double-bar candidate pair 3+4 durations 1/2+1/2 expected=1
Internal double-bar merging system=2 pair 3+4 leftDur=1/2 rightDur=1/2 expected=1 separator=LIGHT_LIGHT
```

The merge then crashed:

```text
java.lang.NullPointerException: Cannot read field "status" because "chordInfo" is null
    at org.audiveris.omr.sheet.rhythm.Voice.putSlotInfo(Voice.java:872)
    at org.audiveris.omr.sheet.rhythm.InternalDoubleBars.rebuildVoiceSlots(InternalDoubleBars.java:445)
    at org.audiveris.omr.sheet.rhythm.InternalDoubleBars.mergePair(InternalDoubleBars.java:430)
    at org.audiveris.omr.sheet.rhythm.InternalDoubleBars.recoverSpan(InternalDoubleBars.java:258)
```

**No MusicXML was exported. 26 → 25 bars was not measured. No gate flip
or pass-count change is accepted. There is no complete svc-25 suite table,
and protected-set svc-25 gates are unknown.** A merge-attempt log is not
evidence of a completed structural repair; twelve completed pieces do not
establish the full protected set.

The last complete official suite remains **svc-24, 8/16**, generated
`2026-09-14T20:11:31.217Z`. The local
`services/omr-service/eval/results/bench/bench.md` is that stale svc-24
report, not svc-25. Its companion `bench.json` SHA256 is
`04babe585511a0f9bb693db90a8d0f93cb44099a65d063d4fd5d797c45925b43`.
The eight protected passes are **Czerny 821/1, BWV 999, Anh. 114, Anh. 115,
Anh. 116, Burgmüller Op. 100/2 (Arabesque), Schumann Op. 68/1, and
Chopin Op. 28/4**; their green status is historical until the next complete
official run verifies it.

Verdict: credit the observed grouping prerequisite, but do not accept
cycle 19 as a completed internal-bar repair or suite improvement. Its
contract explicitly left the merge lifecycle unchanged and required a
new blocker to be recorded. This crash closes that experiment with the
blocker recorded here; the lifecycle repair belongs to cycle 20 only.

## One hypothesis and source cause

**Schumann — Album für die Jugend, Op. 68 No. 5 (Stückchen),
`schumann-op68-05`: the double-thin ink halfway through printed m8 is a
noncounting section separator, supported by the now-observed printed
5 → 10 span containing six raw stacks. The selected complementary-pair
merge fails because its post-merge voice-table rebuild uses null as a
slot-clearing operation in an API that dereferences that null. Rebuilding
coherent voice/slot state from the already recognized fragment timelines,
without null slot records or stale slot IDs, should let this same guarded
merge survive export while preserving every original note and onset.**

This is one engine merge-lifecycle hypothesis. Source localization remains
the pinned PDF in [cycle 18](omr-rsi-cycle-18.md),
`services/omr-service/eval/cache/downloads/schumann-op68-05.pdf`, SHA256
`8f56f70d597a838d23590ed5bbc9ecf10b21e77f07620019cdc2d06b931f7c17`.
The separator has two thin strokes on both staves and no repeat dots.
Nothing in this hypothesis changes number grouping, symbol recognition,
the opening pickup, or the source-supported merge eligibility.

At HEAD `9577723`,
`services/omr-service/engine-patches/src/org/audiveris/omr/sheet/rhythm/InternalDoubleBars.java`
shifts right-fragment chord/slot offsets, calls `left.mergeWithRight(right)`,
sorts and renumbers slots, then rebuilds each voice. Lines 444–445 call
`voice.putSlotInfo(slot, null)` for every merged stack slot. The later
loop inserts BEGIN records only for chords whose slot is non-null, then
calls `completeSlotTable`. The exception stops this sequence before it
can establish a valid merged timeline.

The pinned [Audiveris 5.11.0 Voice implementation](https://raw.githubusercontent.com/Audiveris/audiveris/5.11.0/app/src/main/java/org/audiveris/omr/sheet/rhythm/Voice.java)
stores slot information by integer slot ID. Despite its null-permitting
comment, `putSlotInfo` stores the value and then reads `chordInfo.status`.
Thus catching the exception could leave null records behind. Renumbering
Slot objects alone also cannot rekey existing voice tables.
The pinned [Measure merge](https://raw.githubusercontent.com/Audiveris/audiveris/5.11.0/app/src/main/java/org/audiveris/omr/sheet/rhythm/Measure.java)
preserves the former right barline internally and appends voices, with a
comment expecting rhythm reconstruction after barline removal.
The [MeasureStack merge](https://raw.githubusercontent.com/Audiveris/audiveris/5.11.0/app/src/main/java/org/audiveris/omr/sheet/rhythm/MeasureStack.java)
combines slot collections and changes their stack ownership. These APIs
require a coherent integration at this post-rhythm hook. The null call is
the observed fault; dropped chords, stale records, or further faults are
validation risks, not additional host-observed results.

## Bounded implementation contract for Grok

1. Implement only this merge-lifecycle repair on
   `mh/omr-rsi-notes-fixes-c12b` (PR 41). Keep the change in
   `InternalDoubleBars` and narrowly necessary lifecycle support, focused
   controls, and matching patch/build wiring. Inspect the actual pinned
   APIs before choosing a clearing or reconstruction method; do not assume
   an unverified reset API. Prefer a local reconstruction of valid tables
   over changing `Voice.putSlotInfo` semantics globally.

2. Capture the recognized chord identities, voice memberships, slots and
   rational timing from both fragments before mutations can invalidate
   them. Clear/recreate the affected voice tables through a valid lifecycle;
   never pass null to `putSlotInfo`, retain null entries, catch-and-continue
   the NPE, or merely delete the clearing loop and reuse old keyed tables.
   Rebind each retained chord and voice to its surviving measure, each slot
   to the surviving stack, and each BEGIN record to the correct renumbered
   slot. Complete CONTINUE records only from the unchanged chord durations.
   Every originally slotted chord must remain represented exactly once as
   an onset in its voice; a missing post-merge slot must not silently omit it.
   Preserve simultaneous voices without assuming left/right voice IDs or
   populations match. Do not rerun broad rhythm recognition to invent a
   different voice assignment or duration solution.

3. Apply the pre-merge left duration to right-fragment onsets exactly once;
   leave left-fragment onsets and all durations unchanged. At this source,
   the shift is 1/2 whole note = two quarters. Require consistent ownership,
   unique slot IDs, clean tables and valid duration accounting before the
   result proceeds to numbering/export. Required preconditions must be
   checked before destructive mutation; an unsupported state must not
   export a partly merged structure. Skipping the pinned target remains
   a failed repair, not a successful crash workaround.

4. Preserve cycle 19's grouping and all existing source-count, unique-pair,
   source-ink, separator, repeat, ending, signature, polyphony and duration
   guards. The same 5 → 10/six-stack span must select only pair 3+4;
   changing the following printed anchor to 11 must still reject it.
   Keep the separator as an internal `light-light` at its original position.
   Keep all accepted clef and earlier repairs. No production piece names,
   hashes, bar numbers, coordinates, corpus, MIDI or `.ly` may supply timing,
   eligibility, or the desired count.

5. Keep parser, `buildScoreData`, official scorer, warning policy, floors,
   allowances, pins, engine options and deployed generation unchanged.
   Floors remain exact >=95%, on-grid >=90%, and one missed/extra note per
   16 printed bars, with existing page-supported allowances unchanged.
   Preserve `lyrics=false`, `implicitTuplets=true`, `fingerings=true`.
   Use a fresh engine version (`audiveris-5.11.0+svc-26` if available) and
   matching build provenance. Grok implements; only the host runs Audiveris,
   Docker and the official suite. If another independent defect appears,
   record its exact seam and stop; do not append a second repair hypothesis.

## Controls, host prediction and kill criteria

Controls must exercise the real merge and voice-table path with populated
left/right slots, overlapping pre-merge slot IDs, and the documented three
left voices/two right voices. A predicate-only control or a mock accepting
null cannot catch this failure. Verify no null/stale table entries, complete
chord ownership, correct BEGIN/CONTINUE records, and unchanged event identity,
duration and simultaneity after slot renumbering. Include the sustained
lower C4 half across the second left-fragment onset, a voice entering only
in the right fragment, unsupported/missing required timing, and a second
application of recovery. Preserve negative controls for genuine counted
bars, 5 → 11, ambiguous anchors/pairs, repeats, endings, signature changes,
and non-double-thin boundaries.

The host must require successful MusicXML export, saved-OMR reload/export,
and repeated processing with stable musical structure and timing. Predicted
target result: **26 → 25 logical/printed/performed bars**, all **279 note
elements** retained, one merged 4/4 m8 and the internal double line retained.
The eleven source notes across the seam must have these quarter-note offsets:

| Staff/content | Before internal line | After internal line in merged m8 |
| --- | --- | --- |
| Upper | D5 at 0, C5 at 1, both quarters | B4 at 2, C5 at 3, both quarters |
| Lower moving voice | F4 at 0, E4 at 1, both quarters | G3 at 2, G4 at 2.5, A3 at 3, G4 at 3.5, all eighths |
| Lower simultaneous voice | C4 half at 0, sounding through 2 | No invented continuation or filler |

These offsets are fixture assertions, not production constants. At the
svc-24 divisions value 2, right-fragment offsets are 4/5/6/7 as applicable.
Preserve pitches, rests, clefs, ties/slurs, dots and articulations. Keep the
opening pickup, the already-correct repeated phrase at printed m16, Air's
accepted repeat fragments, and Schumann's real final light-heavy bar intact.
Do not assume this structural repair clears every surviving target failure.

Host acceptance requires **all 16 byte-identical pinned inputs**, unchanged
`services/omr-service/src/eval/` scoring, **BENCH_EXIT=0**, and a newly
completed `bench.json`/`bench.md` whose engine version and provenance match
the candidate. Compare every changed XML piece and raw gate check with the
last complete svc-24 baseline; retain svc-23 for the incidental XML changes
already recorded in cycle 19. Partial svc-25 artifacts are diagnostic only;
its failed Schumann OMR is not a completed export baseline. Inspect and
attribute changes before accepting any gate flip or pass-count change.

Kill the candidate if export still crashes, the producer split survives,
slot/chord/voice ownership is inconsistent, notes disappear or duplicate,
any onset shifts incorrectly, durations or lower-staff polyphony change,
the internal line disappears/moves, a true bar or repeat collapses, filler
or invented holds appear, or reload/reprocessing changes the result.
**Any protected pass going red kills it; every currently passing piece
must remain green.** Reject lowered floors, expanded allowances, warning
suppression, reference-derived repairs, unexplained gains and unrelated
recognition damage. An incomplete or mismatched suite leaves acceptance
blocked; absence of a table is never evidence that protection succeeded.

## This handoff

Astra created only this hypothesis file. Pre-existing dirty bench reports
and `controls2.log` were left untouched. No engine/parser code was edited,
no implementation was committed, and no tests, bench, Audiveris or Docker
were run by Astra. Cycle 20 implementation, export evidence, suite delta
and acceptance remain pending.
