---
name: omr-eval
description: Score Cleffy OMR output against a notation-quantized MIDI source of truth (Mutopia). Use when measuring parser or Audiveris accuracy, adding a corpus piece, or checking a musicality fix did not regress.
---

# OMR accuracy eval

Objective measurement of `ScoreData` against LilyPond-typeset MIDI. The comparison
is bar-aligned (DTW on pitch multisets). Parser changes re-score in seconds from
cached Audiveris artifacts; an Audiveris upgrade or `--force-audiveris` re-runs
the engine.

## Prerequisites

```bash
npm run local:up                 # Supabase + cleffy-local-omr (skip --no-omr if scoring --from pdf)
cd services/omr-service
npm run build                    # dist/eval/cli.js
```

`--from document` needs `supabase_db_cleffy`. `--from pdf` / `audiveris` need
`cleffy-local-omr`. Override with `CLEFFY_DB_CONTAINER` / `CLEFFY_OMR_CONTAINER`.

## Loop

```bash
cd services/omr-service
npm run build
npm run eval -- fetch --piece moonlight
# once per PDF + Audiveris version + option set (~5 min):
npm run eval -- audiveris --piece moonlight
# after every parser edit:
npm run build
npm run eval -- run --piece moonlight --from artifacts eval/cache/artifacts/<key> \
  --baseline eval/results/moonlight/baseline-svc-11.json
```

What is already in local Supabase (the analysis the app stored):

```bash
npm run eval -- run --piece moonlight \
  --from document dcca6082-3b58-42a6-a643-de6f196ef9f9 \
  --baseline eval/results/moonlight/baseline-svc-11.json
```

`--from pdf` runs Audiveris if the cache key misses (or with `--force-audiveris`).
The results JSON records `audiverisCacheHit` and `artifactHash`. Two result files
are a parser-only delta only when their artifact hashes match.

`--out <filename>` writes `eval/results/<slug>/<filename>` instead of the
timestamped default. Use it to refresh the committed baseline:

```bash
npm run eval -- run --piece moonlight \
  --from document dcca6082-3b58-42a6-a643-de6f196ef9f9 \
  --out baseline-svc-11.json
```

`eval/results/moonlight/baseline-svc-11.json` is the 2026-09-07 document
snapshot (I 68.5 / II 92.2 / III 75.5 pitch). This Cloud checkout has no
`score_analyses` row, so that file was written from the audit headlines.
Re-run the command above on a host that has the analysis to replace it with
a live `--from document` result (per-bar detail included).

Exit code 1 when a headline metric regresses more than `--tolerance` (default 0.5).

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
2. Copy `eval/corpus/moonlight.json`. Set `slug`, PDF URL, reference zip URL.
3. `sha256` the zip (required). Pin the PDF hash once you have the file;
   IMSLP often needs a browser. A file already at
   `eval/cache/downloads/<slug>.pdf` is used as-is.
4. For each movement, read the `.ly`: `\time`, `\key`, `\partial`,
   `\repeat volta`. `pickupQuarters` is the anacrusis in quarter-notes.
   `printedBars` must equal the bar count the MIDI produces (verify with
   `run` — `refBars` in the summary). `repeatsUnfoldedInMidi` is almost
   always `false`. `performedBars` is how many bars a correct *performance*
   of the page should play (unfolded repeats + D.C.).
5. `editionNotes` records staff≠hand quirks, missing clefs, dense fingerings.
6. `npm run eval -- fetch --piece <slug>` then `run`.

## Caveats

- Staff is not hand across editions. Mutopia uses track names `up` / `down`.
- Mutopia MIDI does not unfold repeats. Pitch comparison is on printed bars;
  `performedBars` is the separate structural check.
- Grace notes in the MIDI are ordinary short notes; OMR may drop them.
- `eval/cache/` is gitignored. Commit `eval/corpus/` and
  `eval/results/<slug>/baseline-*.json`.
