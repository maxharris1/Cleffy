# Supabase setup — one-time checklist

Project: `jibgwgosihadbjgxdsfe` · https://supabase.com/dashboard/project/jibgwgosihadbjgxdsfe

The app code, migrations, and RLS policies are all in this repo. Because the Claude
environment's network policy currently **blocks \*.supabase.co**, these few one-time
steps need to happen either from your machine or after allowing that domain in the
environment's network settings.

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

[Auth → Sign In / Up](https://supabase.com/dashboard/project/jibgwgosihadbjgxdsfe/auth/providers):

- **Enable anonymous sign-ins** — students joining via share link use these.
- Email provider stays ON (teachers sign in with magic links).

[Auth → URL Configuration](https://supabase.com/dashboard/project/jibgwgosihadbjgxdsfe/auth/url-configuration):

- Site URL: `http://localhost:5173` (change to the ngrok / Vercel URL when you deploy)
- Additional redirect URLs — add every origin you'll open the app from, e.g.:
  - `http://localhost:5173`
  - `https://YOUR-SUBDOMAIN.ngrok-free.app`
  - `https://YOUR-APP.vercel.app`

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

1. `npm run dev`, open http://localhost:5173, sign in with your email (magic link).
2. Upload a PDF — it appears in the library, and in Storage under `scores/{id}/`.
3. Open it, draw — rows appear in the `annotations` table (Data → annotations).
4. Share → create an **edit** link, open it in a private/incognito window, enter a
   name → the same score opens and both windows can annotate.
5. Create a **view** link → that window gets "view only" and no toolbar.
