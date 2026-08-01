---
name: supabase-ops
description: Operate this project's Supabase backend (project jibgwgosihadbjgxdsfe) — where credentials live, how to apply migrations from the Claude sandbox, auth/bucket configuration, and how to run the live two-browser E2E test despite the sandbox's TLS-fingerprinting egress gateway. Use when changing the database schema, RLS, auth settings, storage, or verifying against the live backend.
---

# Supabase operations — Sheet Music Scribbler

Project ref: `jibgwgosihadbjgxdsfe` · https://supabase.com/dashboard/project/jibgwgosihadbjgxdsfe
Current state: migrations 0001–0003 applied, `scores` bucket created (private, 50 MB,
pdf-only), anonymous sign-ins enabled, site URL `http://localhost:5173`, redirect
allowlist includes localhost + `*.ngrok-free.app`.

## Credentials — where they live (NEVER commit any of these)

| Credential                                        | Purpose                                        | Location                                                                                                    |
| ------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`    | app (client-safe)                              | `.env` (gitignored)                                                                                         |
| `SUPABASE_ACCESS_TOKEN` (`sbp_…`, account-scoped) | CLI + Management API (migrations, auth config) | `.env`; ask the user to add it to the Claude **environment settings** env vars so fresh sessions inherit it |
| `sb_secret_…` (project secret key)                | admin API (create test users, storage admin)   | ask the user; use transiently, never write to a committed file                                              |
| `SUPABASE_DB_PASSWORD`                            | direct Postgres / `db push`                    | not available; not needed (see below)                                                                       |

Load them with `node --env-file=.env …` or `export $(grep -v '^#' .env | xargs)`.

## Applying migrations

Migrations live in `supabase/migrations/`. `scripts/apply-migrations.sql` is the
combined file for the dashboard SQL editor — regenerate it after editing migrations.

- **From a normal machine:** `npx supabase link --project-ref jibgwgosihadbjgxdsfe && npx supabase db push`.
- **From the Claude sandbox:** `db push` is impossible (raw Postgres TCP cannot
  traverse the HTTP-CONNECT egress proxy). Use the Management API instead —
  HTTPS, works through the proxy:

```bash
# body: {"query": "<full SQL>"} ; token from SUPABASE_ACCESS_TOKEN
POST https://api.supabase.com/v1/projects/jibgwgosihadbjgxdsfe/database/query
Authorization: Bearer $SUPABASE_ACCESS_TOKEN
```

After applying, insert the version into `supabase_migrations.schema_migrations`
(same endpoint) so a future `db push` skips it. Auth settings are
`PATCH /v1/projects/{ref}/config/auth` (e.g. `external_anonymous_users_enabled`,
`site_url`, `uri_allow_list`).

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
