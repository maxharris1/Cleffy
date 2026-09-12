---
name: omr-eval
description: Score Cleffy OMR output against a notation-quantized MIDI source of truth (Mutopia). Use when measuring parser or Audiveris accuracy, adding a corpus piece, checking a musicality fix did not regress, or running a hosted-vs-local OMR shootout on identical PDF bytes.
---

# OMR accuracy eval

Objective measurement of `ScoreData` against LilyPond-typeset MIDI. The comparison
is bar-aligned (DTW on pitch multisets). Parser changes re-score from cached
Audiveris artifacts; an Audiveris upgrade or `--force-audiveris` re-runs the
engine.

This is a **measurement** harness (`services/omr-service/src/eval`). Do not
change production parser files from this skill. Sibling PR #31 has a different
Moonlight eval under `services/omr-service/eval/` with incomparable metrics;
do not land both scorers.

CI (`omr-service` job) runs typecheck, vitest (including eval unit tests and a
toy `--from artifacts` CLI exec), and build. It does **not** run Audiveris or
score Moonlight. A green CI job is not an accuracy gate for corpus pieces.

## Prerequisites

```bash
cd services/omr-service
npm run build                    # dist/eval/cli.js
```

`--from document` needs `supabase_db_cleffy` and is local-only (docker exec as
`postgres` after a `documents` join; status must be `ready`). `--from pdf` /
`audiveris` need `cleffy-local-omr` **and** a `pdf.sha256` pin. `--from score`
loads a dumped `score.json`. Override containers with `CLEFFY_DB_CONTAINER` /
`CLEFFY_OMR_CONTAINER`.

Do not embed live `score_analyses` document UUIDs in corpus JSON. `--from
document` cannot write a `baseline-*` oracle. Hosted fixture ids belong only
in the Shootout section below.

## Shootout (hosted prod vs current engine, same PDF)

Apples-to-apples: one **PDF sha256** is the source of truth. Prod ScoreData
comes from hosted project `jibgwgosihadbjgxdsfe` (read-only). Local ScoreData
is the current engine run on **those exact bytes**. Both are scored against
the same Mutopia MIDI with the official eval flags.

`.cursor/start.sh` does **not** start OMR. A cloud agent may `shootout fetch`
and `shootout compare` once both `score.json` files exist. It must **not** run
`shootout local` unless `cleffy-omr` is up. Never mutate prod. Do not point
fetch at `.env.local` (local stack).

```bash
cd services/omr-service
npm run build
npm run eval -- fetch --piece fur-elise

# 1. Any machine with repo-root .env (VITE_SUPABASE_URL = hosted project;
#    SUPABASE_SERVICE_ROLE_KEY for RLS SELECT + storage download only):
npm run eval -- shootout fetch --piece fur-elise \
  --document 9820061e-de3f-493a-96ad-7f965f0200dd

# 2. Machine with cleffy-omr — uses eval/cache/downloads/shootout-fur-elise.pdf
#    (the fetched Mutopia LilyPond bytes). NOT local doc 0f6d9e53-… (different PDF).
npm run eval -- shootout local --piece fur-elise

# 3. Cloud or local, after both score.json exist:
npm run eval -- shootout compare --piece fur-elise
```

Writes `eval/results/fur-elise-prod/`, `eval/results/fur-elise-local/`, and
`eval/results/fur-elise-shootout/` (composite / pitch / exact / missing / extra /
overfull ticks / engines / pdf sha / whether inputs were identical). Exit 2 if
the PDF hashes differ or a hash is missing.

Optional: `npm run eval -- run --piece fur-elise --from score eval/results/fur-elise-prod/score.json`

Für Elise fixture: prod document `9820061e-de3f-493a-96ad-7f965f0200dd` is the
Mutopia LilyPond PDF. A local library scan `0f6d9e53-…` is a **different**
file — never the local half of this shootout.

## Loop

Fetch the Mutopia MIDI zip **once** (hash-pinned). Do not put Audiveris in a
rebuild loop. Do not `--force-audiveris` unless the engine or PDF actually
changed.

```bash
cd services/omr-service
npm run build
npm run eval -- fetch --piece moonlight
# only when the PDF pin or ENGINE_VERSION / options change (~5 min JVM):
# npm run eval -- audiveris --piece moonlight
npm run eval -- run --piece moonlight --from artifacts eval/cache/artifacts/<key> \
  --baseline eval/results/moonlight/baseline-<engine>.json
```

`--from pdf` / `audiveris` refuse an unpinned PDF (Moonlight has no `pdf.sha256`
until you vendor the 14-page extract). IMSLP is not fetched from this CLI.

`--from artifacts` and `--from document` never hit the network. If the Mutopia
zip is missing, run `fetch` first.

`--out <filename>` writes `eval/results/<slug>/<basename>` only (`..` and `/`
are rejected). Refresh a committed oracle **only** from artifacts with a
non-null `artifactHash`:

```bash
npm run eval -- run --piece moonlight --from artifacts eval/cache/artifacts/<key> \
  --out baseline-svc-11.json
```

`--from document <uuid> --out baseline-*.json` is refused. So is any baseline
write whose `artifactHash` is null.

There is no committed Moonlight baseline on this branch until a real artifacts
run produces one (including the `bars` map). The toy piece
`eval/results/toy/baseline.json` is the CI-gated example: it is an output of
this scorer.

Exit code 1 when a headline metric regresses more than `--tolerance` (default
0.5 **percentage points** on rates, and 0.5 on integer counts such as `merge2`),
or when `artifactHash` mismatches (engine/options delta, not parser-only).
Exit code 2 when either hash is null (not a parser-only verdict).

Headlines include composite, overall pitch/exact/missing, `movementCountOk`,
`metersOk`, per-movement pitch, tempo-in-range, wrong-key bars, `merge2`,
`refOnly`, and printed-bar count (absolute).

## Play-along benchmark (`bench`)

The objective stand-in for listening to a score play next to the page. One
number — the **play-along score**, the share of reference notes reproduced on
pitch, on the printed onset, and at the printed length — plus a pass/fail gate
per piece.

```bash
cd services/omr-service
npm run build
npm run eval -- bench                    # whole suite, needs cleffy-omr
npm run eval -- bench --piece fur-elise-mutopia
```

Writes `eval/results/bench/{bench.json,bench.md}`. Exit 1 if any piece fails the
gate. `bench` fetches every piece itself (all bytes sha256-pinned) and reuses the
Audiveris artifact cache, so a re-run on a later branch version is byte-identical
input with whatever the parser does now.

Suite (16 pieces, `BENCH_SUITE` in `bench.ts`, roughly easiest first):

| Group | Slugs |
| --- | --- |
| Printed grid, nothing else | `czerny-op821-01`, `bach-prelude-bwv939`, `bach-air-anh131`, `bach-invention-01`, `bach-invention-08`, `bach-prelude-bwv999`, `wtk1-prelude1` |
| Repeats and voltas | `anna-magdalena-04`, `anna-magdalena-05`, `anna-magdalena-07`, `burgmuller-op100-02` |
| Pickups; one unfolded reference | `schumann-op68-01`, `schumann-op68-05` |
| Wider textures, hard cases | `gymnopedie-2`, `fur-elise-mutopia`, `chopin-prelude-4` |

Every one is a Mutopia LilyPond edition whose PDF, MIDI and `.ly` come from one
source, so the reference agrees with the page it was typeset from, and both
hashes are pinned. Spread is deliberate: 5 meters (4/4, 3/4, 2/4, 2/2, 3/8),
keys from 2 flats to 1 sharp, pickups of 0.5/1/3 quarters, pieces from 8 bars to
105, and repeat shapes from none through equal halves (32→64) to unequal halves
(40→80) to a reference that unfolds its own (20 printed / 24 performed).

`toy` (CI fixture, not a musicality claim) and `moonlight` (hand-vendored IMSLP
extract, not fetchable) are excluded. `bench.test.ts` guards the suite's shape
without network or Audiveris — duplicate slugs, missing hashes, an unfolded
reference with no `performedBars`, and the meter/key/pickup/repeat spread.

### What the gate checks, and what it refuses to

Notes on pitch and on the printed grid. Nothing else.

| Check | Fails when | Stands in for |
| --- | --- | --- |
| `notes-present` / `no-invented-notes` | `missing` or `extraUnexplained` over 1 per 16 printed bars | skipped or hallucinated notes |
| `no-skipped-passage` | 2+ consecutive reference bars unplaced | a missing passage, which a per-note rate dilutes |
| `attack-grid` | `exact` under 95% | right notes, wrong beats |
| `note-length` | `onGrid` under 90% | notes chopped short or held through the next attack |
| `bar-length` / `bar-length-warning` | a bar is not the printed length, or `measure_underfull` / `measure_overfull` | a bar that pauses or rushes |
| `printed-bar-count` / `bar-alignment` | OMR bar count ≠ the pin / the reference | a swallowed or duplicated bar |
| `repeat-walk` / `repeat-structure` | `performedBars` mismatch, or `repeats_ignored` / `jumps_ignored` | a skipped repeat |
| `no-invented-hold` | `holds` over `expectedHolds` | a fermata-length pause the page never printed |
| `reference-pin` | the MIDI bar count ≠ its own pin | nothing — it grades the corpus, so a mis-pinned piece cannot report a clean score |

**Deliberately not gated:** induced jitter, the rit. curve, chord roll, hairpin
interpolation, inferred pedal, voicing, sample quality, wall-clock duration, and
printed tempo. The first seven are not on the page and Strict playback already
opts out of them. Printed tempo *is* computed (`printedTempoBpm`, from a tick-0
`metronome`/`word` point with no `defaultBpm` seed and `ramp` ignored) and
reported, but a piece played at the wrong speed is still on pitch and still on
the printed grid, so it does not fail the gate.

The gate is a pure function of an `EvalResult` and reads the **current** record,
so it fails a piece that is broken today with no baseline to diff against.
`--no-gate` reports it without letting it set the exit code; `--exact-floor` /
`--ongrid-floor` move the two rate floors.

### Two corpus allowances, both derived from the page

Neither is tuned to the parser's output.

- **`expectedHolds`** — printed fermatas, counted as clock stops. Two staves
  marked at one moment is one stop. The check is one-sided: inventing a hold is a
  wonky pause, missing one still plays the printed grid.
- **`expectedExtraNotes`** — notes a *correct* performance adds that the
  reference lacks, because LilyPond's MIDI ignores engraved ornament signs while
  Cleffy realizes them (`src/ornaments.ts`). A `\prall` or `\mordent` on a note
  long enough to host the figure becomes three notes, so +2 each; a `\turn`
  becomes four or five, so +4 at the upper bound. A pin with `\trill` must state
  its own bound. Without this the gate punishes the parser for being right.

`ScoreNote.d` is a **sounding** length (notated × articulation gate, floored at
`MIN_SOUNDING_TICKS`); the reference carries notated lengths because Mutopia does
not run `articulate.ly`. `onGrid` therefore accepts any legal gate (1, 0.9, 0.7,
0.5, 0.25) of the printed length. Known blind spot: a gate and a note value can
collide — a printed quarter read as a slurred eighth sounds for the same ticks as
a staccato quarter. Onsets catch that (a halved value moves every later attack),
which is why `exact` and `onGrid` are both reported. An over-held note has no
escape: no gate exceeds 1.

## Metrics

| Metric | Meaning |
| --- | --- |
| `pitchMatch` | Share of reference notes found at the same MIDI pitch in the aligned bar |
| `exact` | Share of reference notes found at the same pitch *and* quantized onset (1/12 quarter) |
| `onGrid` | …*and* a length consistent with the printed value (1/24 quarter, articulation-gate aware). The play-along headline; `onGrid ≤ exact ≤ pitchMatch` by construction and the record schema enforces it |
| `scoredBars` | Bars actually aligned: the performed list when `repeatsUnfoldedInMidi`, the deduped printed list otherwise |
| `maxRefOnlyRun` | Longest run of consecutive unplaced reference bars |
| `barsWrongLength` | Printed bars whose `dTicks` disagrees with the pickup-aware expectation |
| `holds` / `holdsOk` | Fermata clock-stops in the slice, and whether they stay within `expectedHolds` |
| `extraUnexplained` | `extra` minus the `expectedExtraNotes` ornament allowance |
| `printedTempoBpm` | Opening BPM playback will really use — no `defaultBpm` seed, `ramp` ignored. Reported, not gated |
| `missing` / `extra` | Unpaired pitches after pairing octave (±12) and semitone (±1) errors |
| `melodySurvival` | Reference upper-staff notes ≥ dotted-eighth present in the aligned bar |
| `barsUnderWrongKey` | Printed bars whose active `keySignatures` fifths ≠ `expectedFifths` |
| `tempoInRange` | Opening tempo of the movement inside `expectedTempo` |
| `performedBarsMatch` | `measures` count in the slice equals `performedBars` (repeat/D.C. unrolling) |
| `velocityDistinct` | Distinct note velocities in the slice (1 ⇒ no hairpin interpolation) |
| `composite` | 40% pitch + 20% exact + 15% (1 − missing/ref) + 15% structure + 10% tempo |

Structure is the mean of movement-count match, meter match, per-movement
performed-bar match (when declared), and key stability.

`barsAtCorrectLength` is counted on the **deduped printed-bar** list, so it
cannot exceed `omrPrintedBars`. A baseline that violates that is rejected.

## Failure taxonomy (Moonlight)

**Audiveris** — triplets in I (a whole group dropped per bar; log: `No timeOffset
for HeadChordInter`); hallucinated `ff` from fingering clusters; collapsed bass
tremolos in III; merged barlines.

**Cleffy parser** — `Allegretto da capo` / `3Fine.` rejected by anchored regexes;
`. Presto agitato.` rejected by `^`-anchored tempo heading (96 instead of 172);
ghost Voice parts merged by list index; geometry cursor not re-anchored at a
movement seam.

**Both** — system-start key-signature flicker trusted as real changes.

**Edition** — I bars 42–43: upper staff stays in bass clef; no treble clef printed.

## Adding a corpus entry

1. Prefer Mutopia (LilyPond, CC-licensed, notation-quantized MIDI).
2. Copy `eval/corpus/moonlight.json`. Set `slug` (kebab-case), PDF URL, reference zip URL.
3. `sha256` the zip (required). Pin `pdf.sha256` before `--from pdf`. Place an
   IMSLP scan by hand at `eval/cache/downloads/<slug>.pdf` after accepting their
   terms in a browser — this CLI will not cookie-bypass IMSLP.
4. For each movement, `midi` must be a basename (`moonlight1.mid`, no `..`).
   Read the `.ly`: `\time`, `\key`, `\partial`, `\repeat volta`, `\tempo`,
   `\fermata`, ornament signs, and whether a second `\score` block feeds `\midi`
   through `\unfoldRepeats`.
   `pickupQuarters` is the anacrusis in quarter-notes. `printedBars` is the
   engraved bar count. `performedBars` is how many bars a correct *performance*
   of the page should play — omit it rather than guess; the repeat check then
   skips the movement instead of asserting a number nobody verified.
   `expectedHolds` and `expectedExtraNotes` are the two page-derived allowances
   above. Check `reference-pin` in the gate output: it asserts the MIDI produced
   the bar count its own pin claims, which is the fastest way to catch a bad pin.

   **`repeatsUnfoldedInMidi` is per piece, and the `.ly` is the only way to know.**
   `grep -c unfoldRepeats` the source. With it, the reference MIDI is the
   *performance* and the scorer aligns it against the OMR's performed measure
   list, so a dropped repeat surfaces as bars of missing notes rather than a bar
   count off by N; `printedBars` stays the engraved count and `refBars` should
   equal `performedBars`. Without it the MIDI is printed-once. In this corpus
   only `schumann-op68-01` unfolds.
5. `editionNotes` records staff≠hand quirks, missing clefs, dense fingerings.
   Do not embed document UUIDs.
6. `npm run eval -- fetch --piece <slug>` then `run --from artifacts …`.

## Caveats

- Staff is not hand across editions. Mutopia uses track names `up` / `down`.
- Mutopia MIDI usually does not unfold repeats, so pitch comparison is on printed
  bars and `performedBars` is the separate structural check — but check the `.ly`
  for `\unfoldRepeats` before assuming it (see `repeatsUnfoldedInMidi` above).
- A bare `.mid` `reference.url` is pinned and copied straight into the MIDI dir;
  only a `-mids.zip` URL is unzipped. `reference.sha256` pins whatever the URL
  actually serves, so it must be the hash of the file on the network — not of a
  zip built locally around it, which no clean checkout can reproduce.
- Grace notes in the MIDI are ordinary short notes; OMR may drop them.
- LilyPond's MIDI ignores engraved ornaments, arpeggios and tremolos. Cleffy
  realizes all three, so a correct reading legitimately has more notes and
  (for an arpeggio) different onsets than the reference. `expectedExtraNotes`
  covers the ornament case; an arpeggio costs a few onset matches in its bar.
- Adding a required field to `movementMetricsSchema` invalidates older oracles.
  Re-emit the toy baseline from the committed fixture
  (`run --piece toy --from artifacts eval/fixtures/toy --out baseline.json`).
- `eval/cache/` is gitignored. Commit `eval/corpus/`, `eval/fixtures/`, and
  `eval/results/<slug>/baseline-*.json` only when `artifactHash` is non-null
  and `barsAtCorrectLength ≤ omrPrintedBars`.
