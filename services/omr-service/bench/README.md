# OMR benchmark harness

Answers Workstream C gating questions. **Timing** gates (2/3/5) need **x86**
(Apple Silicon/qemu is not decision-grade). **Gate 1** is functional and may
run in local Docker under qemu.

## Cost-neutral pass (current)

Keep production at **2 vCPU / 4 GiB / min-instances 0**. Shipped without raising
Cloud Run cost:

- `AUDIVERIS_EXTRA_OPTS` + `--sheets N:M` harness support
- Step **durations** (`stepDurationsMs`) for OCR share
- Play-along default `Book.Lyrics=false` (less TEXTS/OCR work → fewer CPU-seconds)
- Multi-JVM N=2 with **1-page overlap**, attribute inherit at merge, and
  **serial full-JVM fallback** when open ties or meter disagreement at the seam

Deferred: progressive page-1 delivery, bigger vCPU, warm instances, resident JVM.

## Gates

1. Does `Audiveris -sheets N M` on 5.6.1 load only those sheets and export valid `.omr`/`.mxl`?
   **Plus continuity:** sharded vs full `ScoreData` at seams (time sig inheritance,
   cross-cut ties, measure identity) on a multi-page fixture whose time signature
   appears only on page 1 — see `test/fixtures/continuity/README.md` and
   `seamCompare.ts` / unit tests.
2. Share of TEXTS/OCR in per-sheet time (from `stepDurationsMs` / `timings.steps`)?
3. JVM start → first-sheet time (`timings.jvmStartToFirstSheetMs`)?
4. Photo-PDF raster cost as-is vs ~300 DPI page-box scale?
5. Does **2 → 4 → 8 vCPU** materially cut per-page wall time on a single JVM?
   (Also record $/job: 2× vCPU breaks even near ~50% wall cut.)

### Gate answers

| Gate | Result | Notes |
|------|--------|-------|
| 1 `-sheets` artifact smoke | **PASS** (2026-08-06) | `tiny.pdf`: full + `--sheets 1:1` + `2:2` each produced `.mxl`+`.omr`. |
| 1 continuity (seam) | **Logic shipped** | Overlap + inherit + `seamIsUnsafe` → serial fallback; synthetic unit tests in `seamCompare` / `mergeScoreData`. PDF fixture optional under `test/fixtures/continuity/`. |
| 2 TEXTS share | *informational* | On tiny, TEXTS ~1% of step durations after `Book.Lyrics=false`. |
| 3 JVM_fixed | *observed* | ~8–9s of ~11–15s on tiny (qemu amd64) — material; resident JVM deferred. |
| 4 Photo DPI | *pending* | |
| 5 vCPU sweep | *deferred* | out of cost-neutral pass |

**Production path (`pageCount >= 4`):** `splitSheetRangesOverlapping` → parallel Audiveris → merge (drop overlap, inherit attrs) → if open ties / meter seam unsafe → full serial re-run (`timings.parallelPath`).


## Fixtures

- `fixtures/tiny.pdf` — symlink to `../test/fixtures/tiny.pdf` (2 pages; smoke for `-sheets`)
- Continuity fixture (TODO): multi-page, time sig on page 1 only, tie across shard cut

## Run

```bash
npm run build

# Host with Audiveris, or Docker (amd64 image):
docker run --rm --platform linux/amd64 \
  -v "$PWD/dist:/svc/dist:ro" \
  -v "$PWD/bench:/svc/bench:ro" \
  -v "$PWD/test/fixtures:/svc/test/fixtures:ro" \
  -v "$PWD/bench/results:/out" \
  -w /svc -e TESSDATA_PREFIX=/opt/tesseract-ocr/ \
  sheet_music_scribbler-omr:latest \
  node bench/run.mjs --pdf test/fixtures/tiny.pdf --out /out/gate1.csv --label gate1-full

docker run --rm --platform linux/amd64 \
  -v "$PWD/dist:/svc/dist:ro" -v "$PWD/bench:/svc/bench:ro" \
  -v "$PWD/test/fixtures:/svc/test/fixtures:ro" -v "$PWD/bench/results:/out" \
  -w /svc -e TESSDATA_PREFIX=/opt/tesseract-ocr/ \
  sheet_music_scribbler-omr:latest \
  node bench/run.mjs --pdf test/fixtures/tiny.pdf --out /out/gate1.csv --label gate1-s1 --sheets 1:1

# Optional env: AUDIVERIS_BIN, AUDIVERIS_EXTRA_OPTS, JAVA_TOOL_OPTIONS
```

`run.mjs` invokes `runAudiveris` directly (no writeback), prints timings JSON,
and appends a CSV row. Pass `--sheets N:M` for range-limited runs.
