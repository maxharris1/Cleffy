# Seed-only OMR worker pool (`cleffy-omr-seed`)

Runbook for plan Phase 2c. The play-along corpus seed
(`npm run corpus:seed`) inserts `omr_jobs` rows at `priority = -10`. This pool
drains those rows in parallel on the **same image** as the user worker without
ever touching a user job, and scales to zero when the ledger is empty.

```
seed script ──insert omr_jobs (priority -10) + POST /poke──▶ cleffy-omr-seed (N ≤ 5)
pg_cron omr_seed_sweep ── every minute, only while seed rows are queued ──▶ /poke
                                                        │ omr_claim_job(…, p_max_priority = -1)
                                                        │ same pipeline: corpus hash → symbolic → OMR
                                                        ▼ omr_complete_job + playalong_corpus_put
score-analyze / omr_sweep ──▶ cleffy-omr (user; unchanged, claims everything, user rows first)
```

## What isolates it from user traffic

| Layer   | Mechanism                                                                                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claim   | `omr_claim_job(p_worker_id, p_lease_seconds, p_max_priority)` — seed passes `-1`, so only `priority <= -1` rows are visible to it. User worker passes nothing (null) and still claims everything; `order by priority desc` keeps user rows at 0 ahead of seed rows. |
| Fan-out | `hasQueuedWork` applies the same ceiling, so a seed instance only self-pokes while **seed** rows remain.                                                                                                                                                            |
| Wake-up | `omr_seed_sweep` (pg_cron, every minute) pokes **only** `omr_seed_service_url` and **only** when `priority < 0` rows are queued and `playalong_corpus_control.paused` is false. `omr_sweep` is untouched and still pokes the user URL only.                         |
| Traffic | Separate Cloud Run **service**, not a revision of `cleffy-omr`: Edge / vault `omr_service_url` never route to a seed instance.                                                                                                                                      |
| Startup | `CLEFFY_CLAIM_MAX_PRIORITY` set to a non-integer makes the container exit 1 — a typo can never turn the pool into a second user worker.                                                                                                                             |

## Environment (seed service)

| Var                                                               | Value                                        | Why                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| `CLEFFY_CLAIM_MAX_PRIORITY`                                       | `-1`                                         | claim + fan-out ceiling (unset = user worker)                             |
| `CLEFFY_CORPUS_LOOKUP`                                            | `1`                                          | hash / layout lookup before OMR; `corpusPut` on ready                     |
| `CLEFFY_SYMBOLIC_FIRST`                                           | `1`                                          | Mutopia seeds finish in seconds, no JVM                                   |
| `CLEFFY_CORPUS_OWNER_USER_ID`                                     | Secret Manager `cleffy-corpus-owner-user-id` | OMR results for the owner's documents are written to `playalong_corpus`   |
| `OMR_SERVICE_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | same as `cleffy-omr`                         | shared secret is what pg_cron / the seed script poke with                 |
| `SELF_URL`                                                        | the seed service URL                         | drain chain (`pokeSelf`) — set by `deploy-seed.sh` after the first deploy |

Resources: `--memory 4Gi --cpu 2 --timeout 3600 --concurrency 1 --min-instances 0 --max-instances 5 --no-cpu-throttling --cpu-boost`.
4 GiB matches `-Xmx3g` in the Dockerfile; do not go to 16Gi (that only enables `OMR_PARALLEL`, which is a second instance's worth of RAM for one job).

## Deploy

### Prerequisites (one-time, by hand)

1. Migrations `20260916170000_omr_claim_priority_filter.sql` and `20260916170100_omr_seed_sweep.sql` applied (`npx supabase db push` or the `scripts/apply-migrations.sql` tail). Both are safe before the service exists: the claim RPC defaults to today's behaviour and the sweep is a no-op without the vault secret.
2. Corpus owner user exists in prod `auth.users` (`corpus@cleffy.app`) with the academy plan row (`npm run corpus:seed -- --ensure-owner-plan …` does the plan row; the user itself is created in the dashboard / admin API).
3. Secret Manager: `printf '%s' "<corpus owner uuid>" | gcloud secrets create cleffy-corpus-owner-user-id --data-file=-` and grant `roles/secretmanager.secretAccessor` to the Cloud Run runtime service account.

### First deploy

```bash
export OMR_SERVICE_SECRET=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=…   # same values as cleffy-omr
bash services/omr-service/scripts/deploy-seed.sh
```

The script copies the image the live `cleffy-omr` revision runs (so both pools share one `ENGINE_VERSION`), creates `cleffy-omr-seed` with the env above, sets `SELF_URL`, and health-checks `/healthz`. Then:

```sql
-- Supabase SQL editor: lets pg_cron wake the pool while seed rows are queued
select vault.create_secret('https://<cleffy-omr-seed url>', 'omr_seed_service_url');
```

Optionally export `OMR_SEED_SERVICE_URL=<that url>` where the seed script runs; it then pokes after every `--batch` and at exit instead of waiting for the next cron minute.

### Ongoing deploys

Set the GitHub Actions variable `GCP_OMR_SEED_SERVICE=cleffy-omr-seed`. From then on `.github/workflows/deploy-omr.yml` runs a `deploy-seed` job after every `cleffy-omr` deploy that redeploys the seed service on the **same image**, pinned to the resources above, without touching env or IAM. Leave the variable unset and the job is skipped.

## Operate

**Start a crawl:** `npm run corpus:seed -- --limit 2000 --batch 40` (hourly Action or a shell). Rows appear at `-10`; the script's poke and/or the next `omr_seed_sweep` minute wake one instance, which self-pokes until `--max-instances` are busy.

**Pause (soft):**

```sql
update public.playalong_corpus_control set paused = true;
```

The seed script stops at the next batch boundary, `omr_seed_sweep` stops poking, in-flight `/poke`s finish their job, and `--min-instances 0` scales the pool to zero. Queued seed rows stay queued for resume (`paused = false`). The user worker never notices — but note `cleffy-omr` will still pick up seed rows when it is idle (that has always been true and is fine).

**Kill switch (hard):**

```sql
update public.playalong_corpus_control set paused = true;
update public.omr_jobs set status = 'dead' where priority < 0 and status = 'queued';
```

Running leases finish (≤ 1 h); nothing new is claimed anywhere. Re-seed by rerunning the script (`--retry-skipped` is not needed; `dead` jobs are reconciled to `failed` on the ledger and retried up to `attempts < 3`).

**Raise / lower N:** `SEED_MAX_INSTANCES=8 bash services/omr-service/scripts/deploy-seed.sh` for a one-off, or edit `--max-instances` in the `deploy-seed` job (both places if you want it to stick). Never raise `--max-instances` on `cleffy-omr` for the crawl, and never set `--min-instances` to N — `--min-instances 1` only while the crawl is on if the cold start (~8–9 s JVM) matters.

**Check it is alive / draining:**

```sql
select priority, status, count(*) from public.omr_jobs group by 1, 2 order by 1, 2;
select status, count(*) from public.playalong_corpus_seed group by 1;
select count(*) from public.playalong_corpus;
```

Cloud Run logs: `event: 'omr_job'` lines carry `corpusHit`, `source`, timings; startup logs `claims only priority <= -1`.

## Supabase compute

Workers talk PostgREST over HTTPS (no direct PG sessions), so N=5 costs ~5 heartbeats/min plus one ~52 kB `omr_complete_job` upsert per finished piece. The cap on Micro (1 GB) is jsonb RAM, not connections.

- **Crawl month:** bump compute **Micro → Small** (2 GB, +$5/mo after the Pro credit; org total ~$30). Covers N=5–10 plus Storage copies while five JVMs write.
- **Steady state:** back to **Micro** once the pool is scaling to zero (keep Small only if 1k concurrent Storage copies is a launch target).
- Do not buy Medium/Large for this: corpus RPCs are single-row; a list query that `select score`s is the only thing more RAM would "fix" and it must not exist.

## Cost expectations (from the plan)

Cloud Run at 4 GiB / 2 vCPU instance-based billing ≈ **$0.011–0.020 per OMR piece**; Mutopia symbolic accepts are seconds and nearly free. Total $ is ~N-independent — N only changes wall-clock.

- 2k floor: **~$20–40** Cloud Run, **~16–27 h** wall at N=5 (Mutopia mix → all-OMR).
- 5k target: **~$55–100**, **~2–3 d** at N=5.
- **Crawl month budget ≈ $50–130** = Supabase Small $30 + Cloud Run. Steady state ≈ $25–50/mo (Micro + scale-to-zero residual).

## Merge order (flags on in order)

1. `mh/symbolic-first-all` — Max's test merge first; freeze `ENGINE_VERSION` before seeding. Corpus rows are keyed by it, so a later bump orphans every seeded row; `npm run corpus:seed -- --reseed-ready` re-queues the ledger's `ready` rows under the new engine.
2. `mh/corpus-schema-lookup-ab47` — Phase 0+1 schema + lookup, both flags **off**. Deploy `cleffy-omr`. Then `CLEFFY_CORPUS_LOOKUP=1` on the user worker, then `CLEFFY_SYMBOLIC_FIRST=1`.
3. `mh/corpus-seed-script-ab47` — Phase 2+2b seed script and `pd-pdfs` migration. Run `--limit 131` first (drains on `cleffy-omr` alone via `omr_sweep`).
4. `mh/corpus-seed-pool-ab47` (this) — claim-filter + seed-sweep migrations, `deploy-seed.sh`, vault `omr_seed_service_url`, `GCP_OMR_SEED_SERVICE`. Then `--limit 2000`.

Never: scrape IMSLP PDFs, N=20, `--min-instances=N`, GPU, deleting PD PDFs.
