# OMR benchmark harness

Answers Workstream C gating questions on **x86** (Apple Silicon numbers are
qemu-emulated and not decision-grade).

## Gates

1. Does `Audiveris -sheets N M` on 5.6.1 load only those sheets and export valid `.omr`/`.mxl`?
2. Share of TEXTS/OCR in per-sheet time (from `timings.steps`)?
3. JVM start → first-sheet time (`timings.jvmStartToFirstSheetMs`)?
4. Photo-PDF raster cost as-is vs ~300 DPI page-box scale?
5. Does **2 → 4 → 8 vCPU** materially cut per-page wall time on a single JVM?

Record answers in this file before building page-range sharding.

## Fixtures

Place PDFs under `fixtures/`:

- `tiny.pdf` — symlink or copy from `../test/fixtures/tiny.pdf`
- Optional: born-digital 2/8/20-page IMSLP PDFs; photo-wrapped 1- and 4-page PDFs

## Run

```bash
# Inside the omr-service image (or a host with Audiveris installed):
node bench/run.mjs --pdf fixtures/tiny.pdf --out /tmp/omr-bench.csv

# Sweep vCPU on Cloud Run / GCE by changing instance shape and re-running.
# Optional env:
#   AUDIVERIS_BIN, AUDIVERIS_EXTRA_OPTS, JAVA_TOOL_OPTIONS
```

`run.mjs` invokes `runAudiveris` directly (no writeback), prints timings JSON,
and appends a CSV row.
