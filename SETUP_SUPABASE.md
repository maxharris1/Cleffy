# Supabase setup — one-time checklist

Project: `jibgwgosihadbjgxdsfe` · https://supabase.com/dashboard/project/jibgwgosihadbjgxdsfe

> **STATUS:** Migrations 0001–0003 applied, `scores` bucket created, anonymous
> sign-ins enabled, redirect URLs set. **Auth UI is email/password** (not
> magic-link). Remaining recommendation: custom SMTP for faster auth emails, and
> add `SUPABASE_ACCESS_TOKEN` to the Claude environment's env vars so future
> sessions can run ops without re-pasting.

## 1. Apply the database migrations (pick ONE)

**Option A — SQL editor (fastest):**
Open [SQL Editor](https://supabase.com/dashboard/project/jibgwgosihadbjgxdsfe/sql/new),
paste the contents of **`scripts/apply-migrations.sql`**, run it once.

**Option B — CLI (repeatable, preferred long-term):**
Add these two env vars to the Claude environment (or your shell):

- `SUPABASE_ACCESS_TOKEN` — personal access token (`sbp_…`) from
  [Account → Access Tokens](https://supabase.com/dashboard/account/tokens)
- `SUPABASE_DB_PASSWORD` — the project's database password

then:

```bash
npx supabase link --project-ref jibgwgosihadbjgxdsfe
npx supabase db push
```

## 2. Create the storage bucket

[Storage](https://supabase.com/dashboard/project/jibgwgosihadbjgxdsfe/storage/buckets) → **New bucket**:

- Name: `scores`
- Public: **OFF** (private)
- Allowed MIME types: `application/pdf`
- File size limit: 50 MB (raise the project-wide limit under Settings → Storage if you
  need bigger scans)

(The object-level access policies were already created by the migrations.)

## 3. Auth settings

[Auth → Providers](https://supabase.com/dashboard/project/jibgwgosihadbjgxdsfe/auth/providers):

- **Email** — ON. Enable email/password sign-ups. Prefer **Confirm email** ON in
  production (users land on `/auth/callback` after confirming). Local
  `supabase/config.toml` keeps `enable_confirmations = false` for faster testing.
- **Anonymous sign-ins** — ON (students joining via share link).
- **Google** — leave OFF for now (not exposed in the app UI).

[Auth → URL Configuration](https://supabase.com/dashboard/project/jibgwgosihadbjgxdsfe/auth/url-configuration):

- Site URL: `http://localhost:5173` (change to the ngrok / Vercel URL when you deploy)
- Additional redirect URLs — include every app origin **and** auth landing paths:
    - `http://localhost:5173`
    - `http://localhost:5173/auth/callback`
    - `http://localhost:5173/update-password`
    - `https://YOUR-SUBDOMAIN.ngrok-free.app`
    - `https://YOUR-SUBDOMAIN.ngrok-free.app/auth/callback`
    - `https://YOUR-SUBDOMAIN.ngrok-free.app/update-password`
    - `https://YOUR-APP.vercel.app`
    - `https://YOUR-APP.vercel.app/auth/callback`
    - `https://YOUR-APP.vercel.app/update-password`

App routes that use these redirects:

| Flow                      | Redirect                      |
| ------------------------- | ----------------------------- |
| Email signup confirmation | `/auth/callback` → `/library` |
| Password reset            | `/update-password`            |

**Recommended:** the built-in email service allows only ~2–4 auth emails/hour — fine
for real use, painful for testing. For test iteration either configure custom SMTP
(Auth → SMTP, e.g. a free Resend account), or create a password test user under
Auth → Users.

## 4. (Optional) Let the Claude environment reach Supabase

To let Claude verify against the real backend (and run `db push` itself), allow
`*.supabase.co` in this environment's **network policy** (Claude Code on the web →
environment settings). Without it, everything still works from your machine —
`npm run dev` locally and the app talks to Supabase directly.

## Verifying it worked

1. `npm run dev`, open http://localhost:5173 → **Create account** or **Log in**.
2. Register with email/password.
3. Upload a PDF — it appears in the library, and in Storage under `scores/{id}/`.
4. Open it, draw — rows appear in the `annotations` table (Data → annotations).
5. Share → create an **edit** link, open it in a private/incognito window, enter a
   name → the same score opens and both windows can annotate.
6. Create a **view** link → that window gets "view only" and no toolbar.
7. From login → **Forgot password** → follow the email → set a new password on
   `/update-password`.
