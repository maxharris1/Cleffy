# Cleffy OMR service

Turns an uploaded chart PDF into **ScoreData** — note events split right/left
hand plus measure/system geometry in normalized page coordinates — using
[Audiveris](https://github.com/Audiveris/audiveris) for optical music
recognition, and writes the result into the `score_analyses` table.

```
score-analyze Edge Fn ──POST /jobs {documentId, pdfSignedUrl, pageCount}──▶ this service
                                                                              │ 1. download PDF (signed URL)
                                                                              │ 2. Audiveris -batch -export
                                                                              │ 3. parse .mxl (notes/hands/ties)
                                                                              │    + .omr (measure pixel geometry)
                                                                              │ 4. buildScoreData → self-check
                                                                              ▼
                                                        Supabase score_analyses (service-role upsert)
```

## Environment

| Var                         | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `OMR_SERVICE_SECRET`        | shared secret; the Edge Function sends it as `x-omr-secret`             |
| `SUPABASE_URL`              | project URL (also the SSRF allowlist prefix for PDF downloads)          |
| `SUPABASE_SERVICE_ROLE_KEY` | write-back credentials (server-side only, never in the app)             |
| `PORT`                      | default 8080                                                            |
| `AUDIVERIS_BIN`             | default `/opt/audiveris/bin/Audiveris` (Docker image sets its own path) |

## Run locally

```bash
# from the repo root
docker compose --profile omr up --build omr
# or without Docker (needs a local Audiveris install):
cd services/omr-service && npm ci && npm run build && \
  OMR_SERVICE_SECRET=dev AUDIVERIS_BIN=/path/to/Audiveris node dist/server.js
```

Smoke test: `curl localhost:8090/healthz`.

## Deploy (Cloud Run example)

```bash
gcloud run deploy cleffy-omr --source services/omr-service \
  --memory 4Gi --cpu 2 --timeout 3600 --concurrency 1 \
  --min-instances 0 --max-instances 1 --no-cpu-throttling \
  --set-env-vars OMR_SERVICE_SECRET=...,SUPABASE_URL=...,SUPABASE_SERVICE_ROLE_KEY=...
```

Then point the Edge Function at it (see `SETUP_SUPABASE.md`): secrets
`OMR_SERVICE_URL` + `OMR_SERVICE_SECRET`. Scale-to-zero is fine — the first
job after idle just pays a cold start. Fly.io / any container host works the
same; give the JVM ~4 GB (`JAVA_TOOL_OPTIONS=-Xmx3g` is set in the image).

## Behavior notes

- Queue: in-process FIFO, concurrency 1, depth 4 (then HTTP 429 →
  `queue_full`). Jobs lost to an instance restart surface in the app as a
  stale `processing` row → Retry button; nothing spins forever.
- Status/error codes written to `score_analyses`: see `src/errors.ts`.
- Degradations are graceful: unusable `.omr` geometry → audio-only ScoreData
  (`no_geometry`); count mismatches degrade only the tail
  (`measure_geometry_mismatch`); repeats are ignored (`repeats_ignored`).
- The contract file `src/scoreData.ts` must stay in lockstep with the app's
  `src/types/scoreData.ts`. Writer version is **2** (per-staff bands, key
  signatures, clefs); the app still accepts v1 caches. Re-run Generate
  play-along on older scores to pick up v2 fields used by fingering apply.

## Test fixtures

`test/fixtures/` contains REAL Audiveris 5.6.1 artifacts: `tiny.musicxml`
(source) was rendered to `tiny.pdf` (verovio + headless Chromium print) and
transcribed with `Audiveris -batch -export`, producing `tiny.mxl` +
`tiny.omr`. Regenerate after an Audiveris upgrade and re-verify
`test/fixtures.test.ts` — the `.omr` layout is undocumented and
version-coupled (that test failing loudly after an upgrade is by design).
Known quirk baked into the fixture: Audiveris reads the metronome mark's
note glyph as a real note in the pickup measure.
