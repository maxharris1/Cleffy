# Cursor Cloud Agent environment (Cleffy)

Aut0-style Linux VM config so cloud agents can exercise Cleffy against **local**
Supabase (Docker-in-Docker). Committed under `.cursor/` and used when an agent
starts from a commit that includes this tree.

## What boots

1. **`install`** (`environment.json`): `npm ci`, then `.cursor/ensure-omr-image.sh`
   (builds `cleffy-omr` **only if the tag is missing**; never rebuilds a baked image)
2. **`start`**: `.cursor/start.sh`
   - starts Docker (`fuse-overlayfs` / `iptables-legacy` from the Dockerfile)
   - `npx supabase start` (migrations + `supabase/seed.sql`)
   - ensures the private `scores` storage bucket
   - writes **`.env.local`** (Vite) and **`supabase/functions/.env`** with the
     well-known local demo keys — never points at hosted Supabase
   - if image `cleffy-omr` exists: `docker compose … up -d --no-build` for
     `cleffy-local-omr` on host **`:8091→8080`**, and sets `OMR_SERVICE_URL` /
     `OMR_SERVICE_SECRET` the same way as `scripts/local-up.sh`. Missing image
     is logged; Supabase still boots.
3. **Terminals**: wait for health, then `npm run dev:local` (Vite `:5173`) and
   `npm run functions:serve`

## OMR / Audiveris

`start` never rebuilds Audiveris. The cloud snapshot should already contain
image `cleffy-omr` (RSI **svc-15** / Audiveris 5.11.0 when that image was baked).
`main`'s `services/omr-service/Dockerfile` is still 5.6.1 — `ensure-omr-image.sh`
only uses that Dockerfile when the tag is absent.

Health:

```bash
curl -sf http://127.0.0.1:8091/healthz
```

Play-along bench (RSI branch; default container name matches local-up):

```bash
CLEFFY_OMR_CONTAINER=cleffy-local-omr npm run eval -- bench
```

If an RSI agent is missing the baked image, rebuild from that checkout:

```bash
docker build -t cleffy-omr services/omr-service
```

## What stays off

- **Hosted / live Supabase** is never linked or mutated by these scripts.
- **Billing / Stripe** tables and env are not part of current `dev` and are not
  seeded here.

## Local test accounts

Seeded by `supabase/seed.sql` (password for all: **`cleffy-local-test`**):

| Email                 | Role hint                         | Stable user id                         |
| --------------------- | --------------------------------- | -------------------------------------- |
| `teacher@cleffy.local`  | Owns 3 sample library documents | `a0000000-0000-4000-8000-000000000001` |
| `student@cleffy.local`  | Second user for share / RLS     | `a0000000-0000-4000-8000-000000000002` |

Sign in through the app Auth UI (email/password). Sample document rows have
library metadata only — there are no PDF bytes in the `scores` bucket, so open /
download of those seed titles will fail until you upload a real file.

## Generated env files

| File                       | Purpose                                      | Safe to commit? |
| -------------------------- | -------------------------------------------- | --------------- |
| `.env.local`               | Vite `VITE_SUPABASE_*` for local stack       | No (gitignored) |
| `supabase/functions/.env`  | Edge function secrets for `functions:serve`  | No (gitignored) |

Boot writes **`.env.local`**, not `.env`, so a checkout that already has a
production `.env` is not overwritten. Vite loads `.env.local` automatically and
it overrides `.env` for the same keys.

## Health check

```bash
bash .cursor/health-check.sh          # docker + local Supabase API + scores bucket
bash .cursor/health-check.sh --ready  # also Vite :5173 + functions gateway
```
