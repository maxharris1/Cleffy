# Cleffy OMR service

Turns an uploaded chart PDF into **ScoreData** — note events split right/left
hand plus measure/system geometry in normalized page coordinates — using
[Audiveris](https://github.com/Audiveris/audiveris) for optical music
recognition, and writes the result into the `score_analyses` table via a
durable `omr_jobs` claim queue.

```
score-analyze Edge Fn ──insert omr_jobs + POST /poke──▶ this service
                                                         │ claim (SKIP LOCKED)
                                                         │ download (self-minted signed URL)
                                                         │ Audiveris -batch -export
                                                         │ parse .mxl + .omr (+ content-hash cache)
                                                         ▼
                                   omr_complete_job (atomic job + score_analyses)
```

## Environment

| Var                         | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `OMR_SERVICE_SECRET`        | shared secret; Edge / sweeper send it as `x-omr-secret`                 |
| `SUPABASE_URL`              | project URL (SSRF allowlist for push-mode URLs; writeback target)       |
| `SUPABASE_SERVICE_ROLE_KEY` | write-back, claim RPCs, worker-minted signed URLs                       |
| `SELF_URL`                  | public base URL of this service (drain-chain self-poke)                 |
| `PORT`                      | default 8080                                                            |
| `AUDIVERIS_BIN`             | default `/opt/audiveris/bin/Audiveris` (Docker image sets its own path) |
| `DEV_POLL_MS`               | **local only** — self-claim interval. NEVER set in production.          |
| `OMR_PARALLEL`              | `0`/`off` forces one JVM. Unset: parallel only if container RAM > 8Gi.  |

## Run locally

Hosted `pg_cron` pokes **production** Cloud Run — a local docker-compose
worker never hears from the sweeper. Drain locally with:

```bash
# from the repo root
docker compose up --build omr
# edge poke (after score-analyze enqueue) or manual:
curl -X POST localhost:8090/poke -H "x-omr-secret: $OMR_SERVICE_SECRET" -H 'Content-Type: application/json' -d '{}'
```

Optional local self-claim (reintroduces background work — **dev only**):

```bash
DEV_POLL_MS=5000 SELF_URL=http://127.0.0.1:8090 …
```

Smoke test: `curl localhost:8090/healthz`.

## Deploy (Cloud Run)

```bash
gcloud run deploy cleffy-omr --source services/omr-service \
  --memory 4Gi --cpu 2 --timeout 3600 \
  --concurrency 1 --min-instances 0 --max-instances 3 \
  --no-cpu-throttling \
  --set-env-vars OMR_SERVICE_SECRET=…,SUPABASE_URL=…,SUPABASE_SERVICE_ROLE_KEY=…,SELF_URL=https://… \
```

Merges to `main` that touch this directory (or `.github/workflows/deploy-omr.yml`)
auto-deploy via that workflow. CI does not pass `--set-env-vars`, so existing
Cloud Run env stays in place; the command above is for a one-off manual deploy.

- **1 JVM per instance** (`--concurrency 1`). Throughput knob = `--max-instances`.
- `/tmp` is tmpfs and counts against memory alongside `-Xmx3g`.
- Point the Edge Function at it (`OMR_SERVICE_URL` + `OMR_SERVICE_SECRET`).
- Set `OMR_QUEUE_MODE=pull` on the Edge Function **after** worker v2 + sweeper
  are live (code defaults to `push` until then).
- Vault secrets for the sweeper (see `SETUP_SUPABASE.md`): `omr_service_url`, `omr_service_secret`.

### Cutover

1. Deploy worker v2 (dual-mode: `/poke` + legacy `/jobs`)
2. Ensure sweeper live (pg_cron or Cloud Scheduler → `/poke`)
3. Flip `OMR_QUEUE_MODE=pull`
4. Confirm drain
5. Remove push path (`/jobs`, `queue.ts`) in a follow-up

Rollback: set `OMR_QUEUE_MODE=push`. Queued `omr_jobs` rows simply wait.

## Behavior notes

- Pull mode: request-anchored `POST /poke` holds the HTTP request for the whole
  job (Cloud Run will not reclaim mid-JVM). Self-poke **before** 200 fans out
  under `--concurrency 1`.
- Per-user backlog cap 10 → `429 backlog_full` with **no** `score_analyses` row
  (not-started UX). Files 11+ in a bulk upload skip auto-analysis until Generate.
- Content-hash cache (`score_cache`) keyed by sha256 + `ENGINE_VERSION`.
- Play-along defaults: `Book.Lyrics=false` (less OCR). Multi-page (`≥4` pages)
  runs two overlapping Audiveris `-sheets` JVMs **only when container RAM is
  above 8Gi**. Cloud Run 4Gi and typical Docker stay on one JVM. A parallel
  `omr_crash` retries once serial. Merge still falls back to a full JVM if the
  seam is unsafe.
- Status/error codes: see `src/errors.ts`.
- The contract file `src/scoreData.ts` must stay in lockstep with the app's
  `src/types/scoreData.ts`. Bump `ENGINE_VERSION` (`audiveris-…+svc-N`) when
  parsers/geometry/flags change — CI enforces it.

## Benchmarks

See [`bench/README.md`](bench/README.md) for the x86 harness and Workstream C gates
(including 2→4→8 vCPU before page-range sharding).

## Test fixtures

The Docker image ships Audiveris 5.11.0. `test/fixtures/` contains REAL Audiveris 5.6.1 artifacts: `tiny.musicxml`
(source) was rendered to `tiny.pdf` (verovio + headless Chromium print) and
transcribed with `Audiveris -batch -export`, producing `tiny.mxl` +
`tiny.omr`. Regenerate after an Audiveris upgrade and re-verify
`test/fixtures.test.ts`.
