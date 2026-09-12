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

## Metrics

| Metric | Meaning |
| --- | --- |
| `pitchMatch` | Share of reference notes found at the same MIDI pitch in the aligned bar |
| `exact` | Share of reference notes found at the same pitch *and* quantized onset |
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
   Read the `.ly`: `\time`, `\key`, `\partial`, `\repeat volta`.
   `pickupQuarters` is the anacrusis in quarter-notes. `printedBars` must equal
   the bar count the MIDI produces (verify with `run` — `refBars` in the
   summary). `repeatsUnfoldedInMidi` is almost always `false`. `performedBars`
   is how many bars a correct *performance* of the page should play.
5. `editionNotes` records staff≠hand quirks, missing clefs, dense fingerings.
   Do not embed document UUIDs.
6. `npm run eval -- fetch --piece <slug>` then `run --from artifacts …`.

## Caveats

- Staff is not hand across editions. Mutopia uses track names `up` / `down`.
- Mutopia MIDI does not unfold repeats. Pitch comparison is on printed bars;
  `performedBars` is the separate structural check.
- Grace notes in the MIDI are ordinary short notes; OMR may drop them.
- `eval/cache/` is gitignored. Commit `eval/corpus/`, `eval/fixtures/`, and
  `eval/results/<slug>/baseline-*.json` only when `artifactHash` is non-null
  and `barsAtCorrectLength ≤ omrPrintedBars`.
