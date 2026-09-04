# OMR accuracy benchmark

Ground-truth benchmark for the OMR engines behind play-along: Audiveris 5.6.1
(production), Audiveris 5.11.0, and the experimental "LLM notes (+ cheap
geometry + fallback)" pipeline in `src/experimental/`.

Everything here runs locally against fixtures; nothing touches Cloud Run or
hosted Supabase.

## Corpus

`manifest.json` lists 19 scores (81 pages):

- 11 **typeset** scores — MusicXML ground truth from the
  [ASAP dataset](https://github.com/fosfrancesco/asap-dataset) (MuseScore
  engravings, public domain), rendered to PDF with MuseScore 3 so the PDF and
  the ground truth are the same engraving. `mscore3 -o x.mpos` gives
  reference measure boxes for geometry IoU.
- 8 **scans** — real IMSLP scans (page ranges), ground truth = the ASAP
  MusicXML of the same movement. Reference geometry for scans is Audiveris
  5.6.1's `.omr` (the best available), so scan IoU is "agreement with the
  production engine", not truth.

## One-command setup

```sh
cd services/omr-service
npm ci && npm run build
sudo apt-get install -y poppler-utils musescore3 python3-opencv
docker build -t cleffy-omr:5.6.1 --build-arg AUDIVERIS_VERSION=5.6.1 .        # see Dockerfile
docker build -t cleffy-omr:5.11.0 --build-arg AUDIVERIS_VERSION=5.11.0 .
docker build -t cleffy-omr:5.11.0-bench -f bench/accuracy/docker/Dockerfile.5.11 .   # 5.11 needs libgtk-3 even headless
node bench/accuracy/fetch.mjs        # ASAP MusicXML, MuseScore renders, IMSLP scans → data/
```

## Run

```sh
# Audiveris baselines (Docker, via lib/audiveris-docker.sh)
node bench/accuracy/run.mjs --engines audiveris-5.6.1,audiveris-5.11.0

# Track A alone: CV vs Audiveris GRID geometry, IoU vs reference boxes
node bench/accuracy/geometry.mjs                     # → results/geometry.{md,json}

# Track B / merged pipeline (needs ANTHROPIC_API_KEY; spend is capped and cached)
node bench/accuracy/run.mjs --engines llm-notes                                  # full-page images
node bench/accuracy/run.mjs --engines llm-notes --variant cv-system --tag sys    # one call per system band
node bench/accuracy/run.mjs --engines llm-geo   --variant cv-system --tag sys    # + geometry merge + Audiveris fallback
node bench/accuracy/run.mjs --engines llm-notes --variant cv-system --model claude-opus-5 --tag sys-opus --scores bach-prelude-846

node bench/accuracy/report.mjs                        # → results/summary.{csv,md,json}
```

Flags: `--scores a,b` / `--kind typeset|scan` subset; `--force` re-run;
`--model`, `--effort low|medium|high`, `--variant cv|grid|cv-system|grid-system`,
`--spend-cap-usd` (default $20, ledger in `results/llm-ledger.json`),
`--keep-work` keeps rendered pages/crops under `results/work/`.
`LLM_NO_CACHE=1` bypasses the response cache (`results/llm-cache/`) for
determinism checks.

## Metrics (`lib/metrics.mjs`)

- **Measure alignment**: Needleman-Wunsch over bars using pitch-set Dice
  similarity, so a dropped or invented bar does not cascade into every later
  note being "wrong".
- **Aligned note F1**: a note matches if pitch and hand agree and onsets are
  within an eighth (120 ticks) after alignment. `anyHandF1` ignores hand.
- **Global F1**: absolute-tick matching without alignment — what the playhead
  and the audio would actually experience.
- **Onset |Δ|**, **duration accuracy**, bar counts (gt/engine/aligned,
  over/underfull, exact-duration bars).
- **Geometry**: recall and 1-D x-IoU of engine measure boxes vs reference
  boxes on the same page/system.
- **Cost/speed**: wall ms, ms/page, USD from token usage (prices in
  `src/experimental/llm/anthropic.ts`).

Timings are relative: Audiveris runs in Docker with `--cpus 2`; on an Apple
Silicon host it additionally runs under qemu.

## Layout

```
manifest.json        corpus
fetch.mjs            corpus download / render
run.mjs              engines → results/raw/<engine>/<score>.json
geometry.mjs         Track A only
report.mjs           results/summary.{csv,md,json}
lib/engines/         audiveris.mjs (Docker shim), llm.mjs (dist/experimental/pipeline.js)
lib/metrics.mjs      alignment, F1, geometry IoU
lib/groundTruth.mjs  ASAP MusicXML → MusicalScore via the production parser; .mpos boxes
results/             committed: geometry.md/json, summary.*; ignored: raw/, work/, llm-cache/, llm-ledger.json
```
