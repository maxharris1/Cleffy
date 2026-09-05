# Spike: "LLM notes + cheap geometry" as a replacement OMR path

Date: 2026-09-04 · Branch: `spike/llm-notes-cheap-geometry` (off `feat/musical-playback`) · Status: evaluated

## TL;DR

**No-go for LLM note transcription; go for the cheap geometry track, narrowly.**

- A frontier vision model (Claude Sonnet 5, Opus 5) transcribing printed piano music reaches an aligned note F1 of **0.09–0.20** on a 19-score / 81-page ground-truth corpus. Audiveris 5.6.1 (production) reaches **0.82**. This is not a prompt or crop problem: system-band crops, higher reasoning effort and Opus all move the number by a few points, and the model's output is non-deterministic and often hallucinated.
- "LLM notes + cheap geometry + Audiveris fallback" ends up at **0.76** only because the fallback fires on **77 of 81 pages**. It is Audiveris with a $0.06/page pre-pass that makes the result slower and, where the LLM page is kept, worse.
- The cheap geometry track is the one useful result. OpenCV staves/systems/barlines/chord columns: **~0.3 s/page CPU, recall 0.99, x-IoU 0.98** against MuseScore's own measure boxes on typeset scores, plus chord columns on 99% of bars (Audiveris' `.omr` has no slots on ~7% of bars). On scans it drops systems on 3 of 7 scores (recall 0.87); Audiveris `-step GRID` at ~1.3–2.6 s/page finds every system there. Either can supply every geometry field `ScoreData` needs.
- Two side findings matter more for production than the spike question: Audiveris gets **28% of bar durations wrong** (aligned F1 0.82 vs absolute-tick F1 0.31), and **Audiveris 5.11.0** is +0.035 F1 on scans / −0.012 on typeset versus 5.6.1 at the same speed.

Total LLM spend: **$10.37** of the $20 key (cap was set to $18): 593 live calls, 768 cache hits.

## What was built

Everything lives under `services/omr-service/` and is callable from `bench/`; nothing in the production pipeline (`src/job.ts`, `src/buildScoreData.ts`, …) changed, so `ENGINE_VERSION` did not move and the engine-version CI guard is untouched.

| Piece                       | Path                                                                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Track A: CV geometry        | `src/experimental/geometry/cv_geometry.py`, `cvGeometry.ts`, `types.ts`          | OpenCV: deskew, staff-line runs → staves → systems (piano = 2 staves), barlines by vertical-run scan, chord columns by ink projection per bar. Emits the production `OmrGeometry` shape (0–1 page coords, `staves`, `stacks`) plus `columns`.                                                                                                                                                                                              |
| Track A: Audiveris GRID     | `src/experimental/geometry/gridGeometry.ts`                                      | `audiveris -batch -step GRID -save`, parse the intermediate `.omr`. ~4× slower than CV, no chord columns, but finds every system on scans.                                                                                                                                                                                                                                                                                                 |
| Track B: LLM notes          | `src/experimental/llm/{schema,prompt,anthropic,ledger,transcribe,toMusicXml}.ts` | Strict tool-use JSON schema (compact per-bar `rh`/`lh` voice strings), page or system-band crops, concurrency 4 with the first crop seeding key/meter context, retries + timeouts, disk response cache, spend ledger with hard cap. `toMusicXml.ts` turns the compact grammar into MusicXML so the **production** `musicxml.ts` parser and `buildScoreData.ts` do the rest (caps, repeat unrolling, meter correction all apply unchanged). |
| Merge + fallback + pipeline | `src/experimental/{merge,fallback,pipeline}.ts`                                  | Match LLM systems to CV systems, place bars (exact when counts agree, proportional re-split otherwise), emit `sl` slots when chord-column count equals LLM onset count, pick pages to re-run through Audiveris (`-sheets` ranges), stitch.                                                                                                                                                                                                 |
| Benchmark                   | `bench/accuracy/`                                                                | 19-score corpus (`manifest.json`, `fetch.mjs`), engine adapters, metrics, `run.mjs`, `geometry.mjs`, `report.mjs`; results in `bench/accuracy/results/summary.{csv,md,json}` and `geometry.{md,json}`. See `bench/accuracy/README.md` for the one-command setup and runs.                                                                                                                                                                  |
| Tests                       | `src/experimental/llm/toMusicXml.test.ts`, `src/experimental/merge.test.ts`      | Offline vitest (14 tests): grammar parsing, pickup bars, ties/grace/tuplets round-tripping through the production parser, merge placement and slot emission.                                                                                                                                                                                                                                                                               |

## Corpus and method

- **11 typeset scores** (ASAP dataset MusicXML, MuseScore 3 engravings rendered to PDF by `mscore3`, so PDF and ground truth are the same engraving). `mscore3 -o x.mpos` gives reference measure boxes for geometry IoU.
- **8 real IMSLP scans** (page ranges of the same movements; one deliberately hard 19th-century Beethoven scan, `beethoven-8-2-scan-berg`). Ground truth is the ASAP MusicXML of the movement; geometry reference for scans is Audiveris 5.6.1's `.omr`, i.e. "agreement with production", not truth.
- Bach 846/848, Beethoven op. 10/2 ii, Haydn Hob. XVI:39 iii, Mozart K. 331 iii and K. 332 ii, Chopin op. 10/3, Scriabin op. 8/11, Ravel Pavane; 81 pages, 1 401 ground-truth bars.
- **Aligned note F1**: Needleman-Wunsch bar alignment on pitch-set Dice, then a note matches if pitch and hand agree and onsets are within an eighth. **Global F1**: absolute-tick matching, no alignment (what the playhead and audio actually experience). Also onset |Δ|, bar-count error, share of bars with exactly the right duration, geometry recall / x-IoU, wall time, USD from token usage.
- Hardware: 4 vCPU / 15 GB x86 VM; Audiveris in Docker with `--cpus 2`. On an Apple Silicon dev box Audiveris additionally runs under qemu, so treat all wall times as relative.

## Results

### Engines, all 19 scores

| engine                                                   |    ok |   mean F1 | median F1 | global F1 | onset \|Δ\| ticks | bar-count err | bars exact dur | wall/page (median) | $/page | fallback pages |
| -------------------------------------------------------- | ----: | --------: | --------: | --------: | ----------------: | ------------: | -------------: | -----------------: | -----: | -------------: |
| audiveris-5.6.1 (prod)                                   | 18/19 | **0.817** |     0.848 |     0.310 |                11 |          0.9% |          0.715 |             10.6 s |      0 |              — |
| audiveris-5.11.0                                         | 18/19 | **0.823** |     0.823 |     0.313 |                10 |          0.9% |          0.724 |             10.2 s |      0 |              — |
| llm-notes (Sonnet 5, full page)                          | 19/19 |     0.087 |     0.087 |     0.071 |                51 |         10.0% |          0.353 |             33.5 s | $0.034 |              — |
| llm-notes+sys (Sonnet 5, system crops)                   | 19/19 |     0.100 |     0.108 |     0.061 |                53 |         30.2% |          0.363 |             29.6 s | $0.062 |              — |
| llm-notes+sys, effort high (1 score)                     |   1/1 |     0.124 |         — |     0.089 |                72 |          5.7% |          0.351 |             16.5 s | $0.053 |              — |
| llm-notes+sys, Opus 5 (4 scores)                         |   4/4 |     0.202 |     0.208 |     0.152 |                63 |          9.2% |          0.690 |             11.7 s | $0.140 |              — |
| llm-notes+sys, re-run no cache (2 scores)                |   2/2 |     0.103 |         — |     0.079 |                65 |         47.3% |          0.292 |             23.5 s | $0.049 |              — |
| **llm-geo+sys** (LLM + CV geometry + Audiveris fallback) | 19/19 | **0.760** |     0.818 |     0.283 |                15 |          5.8% |          0.679 |             11.5 s | $0.062 |    **77 / 81** |

Typeset vs scan split (mean F1): Audiveris 5.6.1 0.861 / 0.746; 5.11.0 0.849 / 0.781; llm-notes 0.096 / 0.075; llm-notes+sys 0.108 / 0.088; llm-geo+sys 0.844 / 0.645. Full per-score tables: `services/omr-service/bench/accuracy/results/summary.md`.

The one score both Audiveris versions fail on (`beethoven-8-2-scan-berg`, 5.11 exits 1, 5.6.1 produces no MusicXML) is the only page set where `llm-geo` had no fallback; the LLM result there is F1 0.03.

### Structural metadata (opening time signature, opening key, number of backward repeats)

| engine              | scores | opening TS right | opening key right | repeat count right |
| ------------------- | -----: | ---------------: | ----------------: | -----------------: |
| audiveris-5.6.1     |     18 |               16 |                17 |                 18 |
| audiveris-5.11.0    |     18 |               16 |                16 |                 18 |
| llm-notes           |     19 |               12 |                17 |                 17 |
| llm-notes+sys       |     19 |               15 |                16 |                 16 |
| llm-notes+sys, Opus |      4 |                4 |                 4 |                  3 |

The "use the LLM only for metadata" hybrid has no headroom: Audiveris is already at least as good, and the LLM mis-reads the meter on a fifth of scores (it emitted `"C"` for common time, which the grammar does not accept).

### Track A: cheap geometry vs reference boxes (`results/geometry.md`)

| variant                       | kind    | scores with reference | mean recall | mean x-IoU | systems exact | bar count exact | ms/page (render + detect) | chord columns |
| ----------------------------- | ------- | --------------------: | ----------: | ---------: | ------------: | --------------: | ------------------------: | ------------- |
| **cv** (OpenCV)               | typeset |                    11 |   **0.993** |  **0.983** |         11/11 |            5/11 |                  **~330** | 99% of bars   |
| grid (Audiveris `-step GRID`) | typeset |                    11 |       0.997 |      0.968 |         11/11 |            1/11 |                    ~1 260 | none          |
| cv                            | scan    |                     7 |       0.873 |      0.913 |           4/7 |             2/7 |                      ~690 | 97% of bars   |
| grid                          | scan    |                     7 |   **1.000** |  **0.977** |           7/7 |             0/7 |                    ~2 560 | none          |

Typeset (reference = MuseScore's own boxes, the number to trust): CV is within a few pixels of the engraving and ~4× faster than GRID. Where it misses a bar count it is off by 1–5 bars on a 70–140-bar movement (an extra barline at a clef change, a missed thin double bar); GRID systematically over-segments (119 vs 104 bars on Bach 848) and never returns the right bar count.

Scans (reference = Audiveris 5.6.1's own `.omr`, i.e. agreement with production): CV finds every system on the Bach, Beethoven and Scriabin scans but drops 2–5 systems on the Haydn, Mozart and Chopin scans (dense, uneven inter-staff spacing; the staff-grouping heuristic merges neighbours), which is where its recall goes. GRID finds all systems on every scan. The deskew step was needed for the skewed IMSLP Bach scan (before it: 6/12 systems; after: 12/12).

Neither variant is a full replacement for the `.omr` produced by a complete Audiveris run, but both are 4–30× cheaper than it, and CV is the only source of chord columns.

### Merge behaviour on the 4 pages the LLM kept

`llmBars 64, exact 43, resplit 21, slots 4`. Exact placement (LLM bar count = CV barline count in that system) happened on two thirds of the systems; the remaining third fell back to proportional splitting, which is what the playhead already does when `sl` is missing. Slots were emitted for only 4 bars because the LLM's onset count rarely matched the ink columns, another symptom of the rhythm errors.

### Speed and cost

- Audiveris: median 10.6 s/page (8.9 typeset, 16.3 scan), 27–79 s per score, `--cpus 2`. 5.11.0 is within noise of 5.6.1.
- LLM, full-page calls (81 live): median **65 s** per call, median 2 400 output tokens; p90 across all calls 42 s, max 103 s. A 4-page score takes ~3 min wall with concurrency 4 because the first page is sent alone to seed context.
- LLM, system-band calls (512 live): median 7.5 s, ~550 output tokens, 6–7 calls per page → ~30 s/page wall at concurrency 4.
- Cost at list prices: Sonnet 5 **$0.034/page** (page) or **$0.062/page** (system crops: more input tokens, more calls); Opus 5 **$0.14/page**. Spend: Sonnet 523 calls / 1.91 M in / 0.46 M out / $8.41; Opus 70 calls / $1.96. Prompt caching was not used (the system prompt is short relative to the image tokens).
- Audiveris' marginal cost is ~10 s of Cloud Run CPU per page, well under a cent. The LLM path is an order of magnitude more expensive per page and 3× slower, before counting the fallback.

## Failure modes

LLM transcription (both models, both crop modes):

1. **Boilerplate hallucination.** Sonnet's Bach 846 prelude transcription is `r:e gG5:s A5:s G4:e A4:e B4:e …` in the right hand and `r:e G3:s A3:s C4:q. E4:e~ …` in the left, identical for every bar of the page. It is neither the piece nor plausible piano writing. 19 of 35 bars are over-full.
2. **Recall over reading.** Opus produces the correct pitch sets for the same prelude (bar 1 `C4 E4 G4 C5 E5`, bar 2 `C4 D4 A4 D5 F5`) but the wrong rhythm and voicing (it writes a single sixteenth pattern; the piece has a held half note over the arpeggio). It is recognising a famous piece, not transcribing the ink. This inflates any benchmark built from canonical repertoire and cannot be relied on for user uploads.
3. **Bar count drift.** System crops make the model invent bars (Mozart K. 332 ii: 106 bars for 40; Chopin: 124 for 78). Full-page crops drop them. Repeats and volta brackets are frequently placed on the wrong bar.
4. **Rhythm does not add up.** Only 35–36% of LLM bars have the right total duration (Audiveris 72%). Median onset error 50–65 ticks vs 10–11 for Audiveris.
5. **Non-determinism.** Re-running two scores with the cache bypassed gave different bar counts (51 vs 50 bars for a 27-bar fugue) and F1 0.103 vs 0.100. There is no stable output to cache or diff.
6. **Latency.** 65 s median for a full page, 103 s worst case; the current OMR worker budget and the client's progress UI assume ~10 s/page.
7. **Schema friction.** Anthropic's strict tool-use rejects `null` inside an enum; the `rep` field had to become `'none'`. Minor, but it shows the output format has to be co-designed with the API.
8. **Effort and model size do not rescue it.** Effort high: +0.02. Opus: +0.10 at 2.3× the cost, still a quarter of Audiveris.

LLM + geometry + fallback pipeline:

- The fallback decision (bad-bar share from over/under-full bars and merge mismatches) is correct in the sense that it fires on 77/81 pages, but that means the LLM stage is pure overhead. On the 4 pages it kept, accuracy dropped relative to plain Audiveris (Chopin op. 10/3 0.934 → 0.775; Haydn scan 0.723 → 0.624).
- Page-level stitching of Audiveris output works (`-sheets` ranges, measure renumbering through the existing multi-shard `ParseSeed` path) and is reusable for any future page-partial re-run.

Audiveris (production-relevant, found while building the baseline):

- **Aligned F1 0.82 but global F1 0.31.** 28% of bars have a wrong total duration, so absolute tick positions drift after the first wrong bar in a system. The playhead maps by measure index and re-anchors each bar, so users see it as "the audio is rushed/dragged in this bar", not as a global desync, but it is the single largest accuracy loss in the current pipeline and it is fixable without a new engine (bar-duration repair against the time signature, see below).
- Scans lose ~0.1 F1 versus typeset; 5.11.0 recovers a third of that (Mozart K. 331 scan 0.405 → 0.673) while losing a little on typeset (Scriabin 0.919 → 0.784). Both versions fail the same hard scan.

## Client impact

What the client reads from `ScoreData` (`src/features/playback/PlayheadController.ts`, `scoreTime.ts`, `LoopRangeOverlay.tsx`, `src/features/fingering/regionFromScoreData.ts`):

| Field                                                      | Consumer                                                | Who can supply it                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `measures[i].page`, `sys`, `x0`, `x1`                      | playhead, tap-to-seek, loop overlay, fingering region   | Audiveris `.omr` today; **CV geometry** (x-IoU 0.985)                                      |
| `measures[i].sl` (chord-column slots)                      | playhead sub-bar x (falls back to linear interpolation) | Audiveris `.omr` slots (93% of bars); **CV chord columns** when column count = onset count |
| `systems[s].page`, `y0`, `y1`                              | all of the above                                        | Audiveris; **CV** (staff bands directly)                                                   |
| `systems[s].staves[hand]`                                  | fingering `regionFromScoreData` (else vision fallback)  | Audiveris; **CV** (per-staff bands are the primitive it detects)                           |
| `measures[i].tick`, `dTicks`, `srcIndex`                   | everything                                              | MusicXML side (`buildScoreData.ts`), engine-independent                                    |
| `warnings` (`no_geometry`, `measure_geometry_mismatch`, …) | `TransportBar` copy, fingering fallback                 | unchanged; a new code needs a `SCORE_WARNING_COPY` entry                                   |

So Track A can supply every geometry field, including the two the client degrades without (`sl`, `staves`). Nothing in the LLM output feeds the client directly: it goes through `toMusicXml` → production parser → `buildScoreData`, so caps (2 000 measures, size) and `SCORE_DATA_VERSION` apply unchanged, and the client would not need to change for any of the pipelines tested. Staleness (`CURRENT_ENGINE_GENERATION`) is driven by the `+svc-N` suffix, so any pipeline change that alters output still needs one `ENGINE_VERSION` bump.

## Recommendation

**LLM notes: no-go**, as a replacement and as a primary path with fallback. F1 0.09–0.20 versus 0.82, 3× slower, $0.03–0.14/page, non-deterministic, and prone to recalling famous pieces instead of reading them. Re-evaluate only if a model demonstrably reads rhythm (bars-exact-duration ≥ 0.9 on this corpus) — the harness is ready to answer that in one command and ~$5.

**Cheap geometry: go, as an additive sidecar**, not a replacement for `.omr` geometry. CV is ~30× faster than a full Audiveris run, matches MuseScore's boxes to within a few pixels on typeset scores, and is the only source of chord columns; Audiveris `-step GRID` (~5× faster than the full run) is the robust system finder on scans. Use them to (1) fill `no_geometry` / `measure_geometry_mismatch` cases, (2) add `sl` slots where Audiveris has none, and (3) eventually paint a page's system/bar layout before Audiveris finishes. Ship CV first with a system-count sanity check (staff count must be even for piano, systems must not overlap), and fall back to GRID when the check fails.

**Hybrid worth doing instead of any LLM work:** bar-duration repair in `buildScoreData.ts` (the 28% figure), and a decision on Audiveris 5.11.0 for scan-heavy uploads once the Berg-scan failure is understood.

## Integration plan (cheap geometry sidecar)

1. **Promote and gate.** Move `experimental/geometry/{cv_geometry.py,cvGeometry.ts,types.ts}` to `src/geometry/`; add `python3-opencv` (or `opencv-python-headless` in a venv) to `services/omr-service/Dockerfile`; behind `OMR_CV_GEOMETRY=1`. Add `src/geometry/**` to `scripts/check-engine-version.mjs`'s watch list.
2. **Run in parallel with Audiveris** in `src/job.ts` after download: ~0.3 s/page, record `timings.cvGeometryMs`; failures are logged and ignored (Audiveris path unaffected). Reject the CV result when the system-count sanity check fails (odd staff count, overlapping systems) rather than trying GRID inline; GRID only pays off once the full Audiveris run is being skipped, which is not this step.
3. **Repair geometry in `buildScoreData.ts`.** When the `.omr` is missing or its stack count disagrees with the MusicXML measure count for a system, place measures from CV barlines (exact when counts agree, proportional otherwise — the logic in `experimental/merge.ts` minus the LLM inputs). Emit a new warning code `cv_geometry` and add its copy to `SCORE_WARNING_COPY`.
4. **Slots from chord columns.** Where a bar has no `.omr` slots and CV column count equals the bar's distinct onset count from MusicXML, emit `sl`. Measure the hit rate in the bench first (`geometry.mjs` already reports columns per bar); with Audiveris' onsets it should be far above the 4/64 seen with LLM onsets.
5. **Bench as regression gate.** Keep `bench/accuracy` as the place to compare any engine or post-processing change: `node bench/accuracy/run.mjs --engines audiveris-5.6.1 && node bench/accuracy/report.mjs`, and a geometry-only `node bench/accuracy/geometry.mjs`. Add an `audiveris-5.6.1+cv` engine entry that runs the promoted path.
6. **Bump `ENGINE_VERSION`** to `+svc-10` when step 3 or 4 changes output; existing analyses go stale through the normal generation check.

Separately, and higher leverage: a `bench/accuracy` task for bar-duration repair (`overfull`/`underfull` are already reported per bar), then the same bump.

## Risks and notes

- The API key was pasted into the conversation; it lives only in `/home/ubuntu/.cleffy-spike.env` on the sandbox and nowhere in the repo. Rotate it after the spike.
- `results/llm-cache/` and `results/llm-ledger.json` are git-ignored; re-running LLM engines without the cache will re-spend (~$5 for the two Sonnet configurations over the whole corpus).
- Scan geometry IoU is agreement with Audiveris, not truth; typeset IoU is against MuseScore's own layout and is the number to trust. (An earlier draft of `geometry.md` used the unrolled `ScoreData` bars as the scan reference, which doubled the reference bar count on scores with repeats; `geometry.mjs` now dedupes to physical boxes.)
- CV system detection on dense scans needs work before it can be trusted without the sanity check (3 of 7 scans lose systems). GRID is the safe alternative there at ~5× the CV cost.
- Canonical repertoire flatters vision LLMs (see failure mode 2). Any future model evaluation should add unpublished or synthetic scores to the corpus.
- The IMSLP fetch relies on the site's current disclaimer/cookie flow (documented in `bench/accuracy/lib/imslp.mjs`); if it changes, `fetch.mjs` falls back to failing loudly per score rather than silently substituting.
