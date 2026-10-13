---
name: supabase-ops
description: Operate this project's Supabase backend (project jibgwgosihadbjgxdsfe) — where credentials live, how to apply migrations from the Claude sandbox, auth/bucket configuration, and how to run the live two-browser E2E test despite the sandbox's TLS-fingerprinting egress gateway. Use when changing the database schema, RLS, auth settings, storage, or verifying against the live backend.
---

# Supabase operations — Cleffy

## Environments

| Environment                                          | Ref                    | Notes                                                                |
| ---------------------------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| Production (`cleffy.io`, git `main`)                 | `jibgwgosihadbjgxdsfe` | GitHub integration deploys on merge to `main`; do not also `db push` |
| Persistent `dev` branch (`dev.cleffy.io`, git `dev`) | `qdbnlrgylelelvwbkvnm` | **paused most of the time**; unpause to test a release               |
| Local                                                | —                      | `npm run local:up`, API on :54421                                    |

Production dashboard: https://supabase.com/dashboard/project/jibgwgosihadbjgxdsfe

## Local development — prefer this

```bash
npm run local:up          # Supabase + OMR worker; --no-omr to skip OMR
npm run dev:local         # Vite :5173
npm run functions:serve   # edge functions
npm run imslp:seed        # load the committed IMSLP catalog (no IMSLP network)
npm run local:status      # health check
npm run local:down
```

`.claude/launch.json` is not a shortcut around this list: it runs `dev:local`
alone, so the backend must already be up, and edge functions are still served by
`functions:serve` — which passes `--no-verify-jwt`, unlike the runtime
`supabase start` boots. `dev:local` pins 5173 with `--strictPort`, so it fails
loudly rather than sliding to 5174 while the health check still watches 5173.

Ports are a **+100 offset** from Supabase defaults (API 54421, db 54422, studio
54423, mail 54424) so the stack coexists with the other Supabase projects on a
dev machine, which all claim the default 5432x block. They are read from
`supabase/config.toml` — never hardcode them. Everything is scoped to
`project_id = "cleffy"`; a bare `docker ps --filter name=supabase_` would match
other projects' containers, and `cleanup_supabase_state` would delete them.

Accounts: `teacher@cleffy.local` / `student@cleffy.local`, password
`cleffy-local-test`.

Local OMR joins the Supabase docker network on purpose: the edge runtime's
`SUPABASE_URL` is `http://kong:8000`, so the signed storage URLs `score-analyze`
mints are only fetchable from inside that network. The edge runtime reaches the
worker at `http://cleffy-local-omr:8080`. Note the CLI **refuses any
`SUPABASE_*` name** in `supabase/functions/.env` and injects its own.

## The dev branch

```bash
supabase branches unpause dev --project-ref jibgwgosihadbjgxdsfe
git push origin dev          # a deploy must run; unpause alone applies nothing
# ...test dev.cleffy.io...
supabase branches pause dev --project-ref jibgwgosihadbjgxdsfe
```

A push to `dev` while the branch is paused fails at the health step — cosmetic,
expected. Branch config lives in `[remotes.dev]` in `config.toml`; the branch is
**not seeded** (seed.sql's accounts have a documented password and this host is
public), so the `scores` bucket comes from `[storage.buckets.scores]`. Edge
function secrets do **not** inherit from production.

## Migration history — reconciled 2026-08-27

Production and the `dev` branch were hard-reset and rebuilt from
`supabase/migrations/`. Both now carry the same 22 migrations (identical
fingerprints), so `db push` is safe again and the earlier divergence is gone.
All data was intentionally discarded.

Resetting a hosted database has two traps (CLI 2.115.0), both hit in practice:

- `db reset --linked` drops tables but **not sequences**, so the re-apply fails
  with `annotations_seq already exists (42P07)` and leaves the database empty
  and half-built. Drop leftover sequences/enums in `public`, then re-run.
- `supabase storage rm` **silently no-ops** (`{"deleted":[]}`). Delete via the
  Storage API: `DELETE /storage/v1/object/<bucket>` with `{"prefixes":[...]}`
  and a service key.

`db reset --linked` clears `auth.users` but not storage. Always pass `--no-seed`
against a hosted environment — `seed.sql`'s accounts use a password documented
in `.cursor/README.md`.

## Grants — do not rely on default privileges

The **local** Docker image gives anon/authenticated only `Dxtm` on tables
created by `postgres` (which is what migrations run as), so a table with no
explicit grant answers `42501 permission denied` before RLS is consulted.
Hosted images give the full `arwdDxtm` from the default ACL, so
`20260827140000_core_table_grants.sql` is load-bearing locally and a no-op
hosted. **Every new table needs an explicit grant** matching its RLS policies.

## Credentials — where they live (NEVER commit any of these)

| Credential                                        | Purpose                                        | Location                                                                                                                                            |
| ------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`    | app (client-safe)                              | `.env` (gitignored)                                                                                                                                 |
| `SUPABASE_ACCESS_TOKEN` (`sbp_…`, account-scoped) | CLI + Management API (migrations, auth config) | `.env`; ask the user to add it to the Claude **environment settings** env vars so fresh sessions inherit it                                         |
| `sb_secret_…` (project secret key)                | admin API (create test users, storage admin)   | ask the user; use transiently, never write to a committed file                                                                                      |
| `SUPABASE_DB_PASSWORD`                            | direct Postgres (`psql`, `db push`, `repair`)  | not in `.env`. For a **branch**, `GET /v1/branches/{branch_id}` returns `db_pass` in plaintext; production's own branch record does not (see below) |

Load them with `node --env-file=.env …` or `export $(grep -v '^#' .env | xargs)`.

## Applying migrations

Migrations live in `supabase/migrations/`. `scripts/apply-migrations.sql` is the
combined file for the dashboard SQL editor — regenerate it after editing migrations.

- **From a normal machine:** `npx supabase link --project-ref jibgwgosihadbjgxdsfe && npx supabase db push`.
- **From the Claude sandbox, small DDL — the default:** the Management API.
  HTTPS, no database password needed, one statement batch per call:

```bash
# body: {"query": "<full SQL>"} ; token from SUPABASE_ACCESS_TOKEN
POST https://api.supabase.com/v1/projects/jibgwgosihadbjgxdsfe/database/query
Authorization: Bearer $SUPABASE_ACCESS_TOKEN
```

After applying, insert the version into `supabase_migrations.schema_migrations`
(same endpoint) so a future `db push` skips it. Auth settings are
`PATCH /v1/projects/{ref}/config/auth` (e.g. `external_anonymous_users_enabled`,
`site_url`, `uri_allow_list`).

- **From the Claude sandbox, large or transactional work: `psql` / `db push`.**
  Raw Postgres over TCP _does_ traverse the egress proxy — `CONNECT host:5432`
  answers `HTTP/1.1 200 Connection established`, exactly as port 443 does
  (re-checked 2026-10-12 against both `db.<ref>.supabase.co:5432` and the
  pooler). This file used to say the opposite, and the false claim cost the
  Phase 1 migration rehearsal real time: a 42 MB migration first looked
  untestable from here and was then applied over `psql` without trouble,
  including a `--single-transaction` run that rolled back cleanly through a
  transient connection drop.

    Prefer it to the API when:
    - **the SQL is large.** The API call is a single HTTP body; 40 MB of catalog
      inserts wants a stream, and sandbox egress measured ~530 KB/s, so budget
      minutes and plan a retry.
    - **it has to be one transaction.** `psql -v ON_ERROR_STOP=1
--single-transaction` is the only way to get all-or-nothing across
      statements — what the rolled-back proofs in `tests/sql/` and any risky DDL
      need.
    - **the command only speaks Postgres.** `supabase db push` and
      `supabase migration repair` want a direct connection and the project
      password; an access token is not enough.

    Getting the password: for the `dev` branch — and any preview branch —
    `GET /v1/branches/{branch_id}` returns `db_pass` and `db_user` in plaintext.
    Write it to a mode-600 file, never a committed one, and never echo it.
    **Production is the exception**: its own branch record carries only `db_host`,
    `db_port`, `postgres_engine`, `postgres_version`, `ref`, `release_channel` and
    `status` — no `db_pass`, no `db_user` — so production's password comes from the
    dashboard (Settings → Database) or a reset, and the API will not read it back.

## Sandbox network rules (hard-won — do not rediscover)

- All egress goes through `$HTTPS_PROXY` with TLS re-termination
  (CA: `/root/.ccr/ca-bundle.crt`).
- **Node**: set `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`
  (or pass an undici `EnvHttpProxyAgent` dispatcher explicitly). supabase-js
  needs `global: { fetch: <undici fetch with dispatcher> }` in Node scripts.
- **Chromium CANNOT reach Supabase directly**: the egress gateway
  TLS-fingerprints browser ClientHellos and resets them post-handshake. No
  Chromium flag fixes this. Bridge instead (see live-e2e.mjs):
    - HTTPS: `context.route('https://<project>.supabase.co/**')` →
      `route.fetch()` → `route.fulfill({response})`, with the proxy set as a
      context option (route.fetch runs Node-side).
    - **Binary request bodies are lost over CDP** (uploads arrive body-less) —
      the bridge substitutes the known file's bytes for storage PUT/POSTs.
    - WSS (realtime): `context.routeWebSocket` hangs in current Playwright here;
      instead run a local plain-`ws://` relay (`ws` npm package → undici
      WebSocket with the proxy dispatcher) and rewrite the page's WebSocket URL
      via `context.addInitScript`.

## Live E2E verification

`node --env-file=.env live-e2e.mjs` (dev server on :5199 first). It creates a
throwaway teacher (admin API + password grant — magic-link email is untestable
headlessly), uploads, draws, shares, joins as an anonymous student, and asserts:
persistence pull, mid-stroke live ink, broadcast-from-database fan-out, presence,
and cross-user erase convergence. All 13 checks passed 2026-08-01.

## Schema/RLS gotchas already fixed — keep them fixed

- `documents_select` policy must include `owner_id = auth.uid()` OR-branch:
  `INSERT … RETURNING` (PostgREST `.select()`) evaluates before the
  owner-membership AFTER-trigger row exists.
- `redeem_share_link` needs `#variable_conflict use_column`: its
  `RETURNS TABLE (document_id …)` OUT param collides with column names in the
  `ON CONFLICT (document_id, user_id)` target (SQLSTATE 42702).
- Never hard-delete annotations (tombstones only); `seq` is trigger-set —
  don't write it from clients.
