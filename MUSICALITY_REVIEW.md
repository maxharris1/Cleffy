# Musicality review — OMR → ScoreData → playback

Review of what Cleffy hears when it looks at a score, and where that diverges from what a
musician reads on the page. Findings below were verified by running the real parser
(`services/omr-service/src/musicxml.ts`) over a grand-staff excerpt carrying ordinary piano
markings — not by reading the code alone.

## Thesis

**ScoreData models pitch, time, and hand. It does not model performance.** It is a MIDI note
list with page geometry attached. Everything a musician would call _interpretation_ —
articulation, phrasing, dynamic shape, tempo shape — is either dropped at the MusicXML parse
step or has no field to live in. The timing/geometry layer is genuinely strong; the
expression layer is largely absent, and the places where it _is_ present (sfz, printed
dynamics) have a bug that actively corrupts the rest.

## The probe

Input: a 3-bar grand-staff excerpt. RH marked **f** with four **staccato** quarters, then an
**accented (>)** note, a **slur**, a **trill**, under a **crescendo**; LH marked **p** with
**pedal**; a **repeat** barline; a **rit.**, a **fermata**, and a second tempo mark (♩=60).

Output (`t` = tick, `d` = duration, `v` = velocity):

```
=== defaultBpm: 120 | totalTicks: 5760
=== warnings: ["repeats_ignored"]
  t=    0  d= 480  C5   RH  v=0.82     <- f, correct
  t=    0  d=1920  C3   LH  v=0.46     <- p, correct
  t=  480  d= 480  D5   RH  v=0.82
  t=  960  d= 480  E5   RH  v=0.82
  t= 1440  d= 480  F5   RH  v=0.82
  t= 1920  d= 480  G5   RH  v=0.46     <- accented, forte melody note. Now PIANO.
  t= 1920  d=1920  G2   LH  v=0.46
  t= 2400  d= 480  A5   RH  v=0.46
  t= 2880  d= 480  B5   RH  v=0.46
  t= 3360  d= 480  C6   RH  v=0.46
  t= 3840  d= 960  C5   RH  v=0.46
  t= 3840  d=1920  C3   LH  v=0.46
  t= 4800  d= 960  E5   RH  v=0.46
```

Every staccato quarter is `d=480` — full length. The accent is inaudible. The crescendo is
flat. The fermata does not hold. The tempo stays 120. And the right hand is playing *piano*
from bar 2 to the end of the piece.

---

## P0 — Dynamics bleed across hands; the melody gets overwritten

**The most damaging finding.** The score says RH _forte_, LH _piano_. From bar 2 onward
**everything plays at piano, including the melody**, and it never recovers.

Root cause (`musicxml.ts:356`, `431-478`): `currentVelocity` is a single variable per part,
and the `<staff>` child of `<direction>` is ignored. Dynamics are applied in **document
order**, not musical time. MusicXML writes a measure as `[staff-1 voices] <backup> [staff-2
voices]`, so the **lower staff's dynamic is always the last one seen in a bar** — and it
governs the next bar's upper staff.

Rule of thumb for the current behavior: _the last dynamic printed in a measure sets the
volume for every note in the next measure, both hands._ For piano writing — melody `f`,
accompaniment `p`, which is most piano writing — this systematically flattens the melody into
the accompaniment.

**Fix:** key the dynamic state by staff, and resolve each note's velocity from a
`(tick, staff)` lookup rather than from a mutable cursor walked in document order. Same
change fixes the `pendingAccent` leak below. No schema change; service-side only.

## P0 — `>` accents are invisible

`<articulations>` is never read — there is not one reference to `notations`, `articulations`,
`staccato`, `accent`, `tenuto`, or `marcato` anywhere in the OMR service. The sforzando
family (`sf`, `sfz`, `fz`, `fp`) _is_ handled, because those arrive as `<dynamics>`.

That is backwards by frequency. In real repertoire `>` is the common accent by a wide margin;
`sfz` is comparatively rare. The net effect is that the accent layer of the music is absent
while a rarer notation works.

**Fix:** read `<notations><articulations>` — `accent` → +0.15 velocity, `strong-accent` →
+0.25, `tenuto` → full gate + slight boost. Service-side; no schema change.

## P0 — Nothing is ever shortened, so everything is legato

Every note sounds its full notated value, and `PlaybackEngine` adds a 60 ms release tail
(`RELEASE_TAU_S`) on top — so consecutive notes in a hand actually **overlap**. There is no
gate, duty cycle, or note-off gap anywhere in the system.

Musically: a staccato Alberti bass and a slurred nocturne line have identical touch. This is
the single thing a musician would notice first, and it reads as "the playback sounds mushy /
smeared" rather than as a missing feature.

**Fix is cheap.** `note.d` is consumed **only** by `PlaybackEngine` (lines 458, 479) —
nothing else in the app reads it, fingering included. So `d` is already a _sounding_ duration
in practice, and the OMR service can shorten it directly:

| marking      | gate         |
| ------------ | ------------ |
| staccatissimo| ~0.25        |
| staccato     | ~0.50        |
| (unmarked)   | ~0.90        |
| tenuto/slur  | 1.0          |

No schema change, no client change.

## P1 — One tempo for the entire piece

`defaultBpm` is a scalar, and the `if (defaultBpm === null)` guards (`musicxml.ts:435, 443`)
capture only the **first** tempo mark in the document. The probe's second mark (♩=60 in bar 3)
was dropped — output stayed 120.

Compounding it: `<words>` is never parsed at all, so **"rit.", "accel.", "a tempo", "Rubato",
"Andante", "Swing"** are all invisible; and `<fermata>` is ignored, so the final chord does not
hold. Playback is metronomic from the first bar to the last.

Also worth knowing: most published scores give a tempo as _words_ ("Allegro"), not a metronome
mark. When Audiveris emits no `<sound tempo>`, `defaultBpm` is null and the app falls back to
`DEFAULT_BPM = 100` (`store.ts:38`) — a flat 100 bpm regardless of what the page says.

**Fix:** ScoreData v3 `tempos: [{tick, bpm}]`, plus a per-note hold for fermatas. The engine's
anchor-swap timebase already re-anchors cleanly on `setBpm`, so it can follow a tempo map with
modest changes — the missing piece is the field, not the machinery.

## P1 — Hairpins are not interpolated

`<wedge>` is never read, so dynamics are step functions. A four-bar `cresc.` from _p_ to _f_
plays as flat _p_ until the _f_ arrives, then jumps. Confirmed in the probe (bar 2, flat).

**Fix:** this needs no schema change and no engine change — interpolate at build time and emit
the ramped value into each note's `v`. Combined with the per-staff fix above, this is the
highest value-per-unit-effort work available.

## P1 — Repeats are dropped, and the user is never told

`repeats_ignored` is correctly produced. **But `score.warnings` is never surfaced anywhere in
the UI.** Its only two consumers in the entire app are the fingering cache key
(`fingering/cache.ts:63`) and a `no_geometry` check (`regionFromScoreData.ts:158`). The
transport's warning banner (`TransportBar.tsx:55`) carries only runtime audio codes
(`samples_unavailable`, `too_many_voices`).

So the following all happen silently: `repeats_ignored`, `measure_underfull`,
`measure_overfull`, `multi_part_collapsed`, `single_staff_all_rh`, `measure_geometry_mismatch`,
`grace_notes_skipped`, `multiple_movements_concatenated`.

Two of those are worse than a missing feature:

- **1st/2nd endings play back-to-back.** That is not "a different form" — it is a wrong note
  sequence presented as correct.
- **`measure_underfull` / `measure_overfull` are OMR rhythm damage** — the strongest available
  signal that a bar was misread — and it is thrown away.

For a practice tool this is a trust problem. A student following the page loses sync and has
no way to know the software, not their reading, is wrong. Surfacing these is a small UI change
against data that already exists.

## P2 — Pedal, ornaments, grace-note nuance, swing

- **Pedal:** `<pedal>` ignored. Romantic repertoire loses all harmonic blend.
- **Ornaments:** trill / mordent / turn / arpeggiate play as plain notes (probe: the trill
  became a plain quarter). Reasonable v1 scope, but a real gap for baroque and classical.
- **Grace notes:** always crushed acciaccatura at a fixed `GRACE_TICKS = 110`. `<grace
  slash="no">` — an appoggiatura, which should take half the principal's value **on** the
  beat — plays identically. `steal-time-following` / `steal-time-previous` ignored. (Minor: the
  comment at `musicxml.ts:43` says "≈55 ms at 120 bpm"; 110/480 quarter at 120 bpm is ~115 ms.)
- **Swing:** no swing flag in ScoreData; eighths are always straight. If charts/lead sheets are
  a target use case, this is a significant feel gap.

## P3 — Smaller items

- **Accent lands on the wrong note.** `pendingAccent` is consumed by the next pitched note in
  _document_ order, which after a `<backup>` may be a lower-staff note or one in the next bar.
  Same root cause as the P0 dynamics bleed; fixed by the same change.
- **Two velocity defaults.** Parser `DEFAULT_VELOCITY = 0.72` vs engine `note.v ?? 0.75`.
  Unmarked notes take 0.75; the 0.72 is only an accent/grace base. Harmless today, but two
  sources of truth.
- **Measure counter jumps backwards** after `multiple_movements_concatenated` — movement 2
  restarts numbering at 1.
- **`totalTicks` is the lead part's last barline.** Secondary-part notes past it exist in
  `notes` but never sound; the engine stops there.

---

## What is genuinely well done

Worth stating plainly, because the weaknesses above are concentrated in one layer and it would
be easy to read this as a broader indictment. It isn't.

- **Tick normalization to 480/quarter** makes triplets (160) and quintuplets (96) exact. Right
  call.
- **Tie merging with a musical-adjacency fallback** (`musicxml.ts:528-544`) for Audiveris
  renumbering voices across system breaks — a thoughtful fix to a real OMR failure mode, and
  the kind of thing that only comes from having been bitten by it.
- **Compound meters click in dotted quarters** (`clickBeatTicks`). Most tools get 6/8 wrong.
- **Count-in handles pickups** by counting the lead-in beats of the entry bar
  (`countInClicks`). Genuinely well done; commonly botched.
- **Beat-unit → quarter-BPM conversion including dots** (`beatUnitToQuarters`) is correct.
- **Attack-lag compensation** — notes start early by the sample's own rise time so the note is
  _heard_ on the beat rather than beginning there. That is a musician's ear in the code, and
  most sequencers do not bother.
- **Perceptual `v^1.6` gain curve** — right instinct; linear gain does flatten dynamics.
- **Playhead rides engraved chord columns** (`measures[].sl`) instead of interpolating linearly
  across the bar. This is the difference between a playhead that looks right and one that
  doesn't.
- **Piano-primary part selection** to dodge Audiveris "Voice" ghost parts, and underfull/overfull
  padding that extends open ties across the inserted gap. Both careful.

## Suggested order of work

Ranked by musical impact per unit of effort. The first three need **no schema change and no
client change** — they are all inside the OMR service.

1. **Per-staff dynamics resolved by `(tick, staff)`** — stops the melody being overwritten.
2. **Articulations → gate + velocity** (`staccato`, `accent`, `strong-accent`, `tenuto`) — gives
   the playback touch, and fixes "everything sounds legato."
3. **Hairpin interpolation baked into `v`** — gives it dynamic shape.
4. **Surface `score.warnings` in the transport.** Small UI change, data already exists,
   converts silent wrongness into honest uncertainty.
5. **ScoreData v3: `tempos[]` + fermata holds** — gives it tempo shape (rit./accel./a tempo).
6. **Repeat/volta unrolling at build time**, with `measures[].srcIndex` so the playhead can
   revisit a printed bar. Keeps the engine linear and the geometry mapping intact.
7. Pedal, ornaments, appoggiatura vs acciaccatura, swing.

## Not yet reviewed: the specific document

This review covers the pipeline, not document `071f3c99-aee2-46cc-a2c5-bbdf22f43781`. The
note-for-note accuracy pass — how well Audiveris read _that_ score's pitches, rhythms, and
hand assignment — still needs the source PDF and its stored ScoreData; neither is reachable
from the review sandbox (no localhost access; the Supabase MCP returns `permission denied`).
