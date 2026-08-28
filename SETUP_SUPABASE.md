# Supabase setup — one-time checklist

Project: `jibgwgosihadbjgxdsfe` · https://supabase.com/dashboard/project/jibgwgosihadbjgxdsfe

> **STATUS:** Migrations 0001–0003 applied, `scores` bucket created, anonymous
> sign-ins enabled, redirect URLs set. **Auth UI is email/password** (not
> magic-link). Remaining recommendation: custom SMTP for faster auth emails, and
> add `SUPABASE_ACCESS_TOKEN` to the Claude environment's env vars so future
> sessions can run ops without re-pasting.
>
> **BILLING IS LIVE (2026-08-27).** Both `20260826193902_billing.sql` and
> `20260826194426_roster.sql` are applied; `stripe-checkout`, `stripe-portal`,
> `stripe-webhook`, `student-provision`, `student-login` and the metered
> `imslp-download` are deployed (the webhook and student-login with
> `--no-verify-jwt`). The Stripe SANDBOX catalogue exists — 3 products, 7
> prices, webhook endpoint `we_1U8njJ9EqxUjgZtnfBK3y0XH` — the Customer portal
> has a default configuration, and `STRIPE_SECRET_KEY`,
> `STRIPE_WEBHOOK_SECRET` and `APP_URL` are set as Edge secrets.
>
> Verified end to end: a checkout session issues, a bogus price id is refused,
> a subscription created in Stripe arrives through the webhook as
> `tier=teacher`, and cancelling it returns the account to `free`. The seven
> `STRIPE_PRICE_*` secrets are deliberately NOT set — the Edge Functions read
> `PUBLISHED_PRICES` in `_shared/stripe.ts`, guarded against drift by
> `tests/billing/priceCatalogInSync.test.ts`.
>
> cleffy.io (main) and dev.cleffy.io (dev) both deploy from Vercel project
> `cleffy` on every push. See `DEPLOY.md` for the full runbook.

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

## 4. Smart import (adopt pre-existing annotations)

The "Import marks" feature detects handwriting already on uploaded scores and
turns it into editable Cleffy annotations. Its parts:

- **Migration** `supabase/migrations/20260802180000_smart_import.sql`
  (`documents.content_rev`, `document_imports`, the documents broadcast
  trigger) — included in `scripts/apply-migrations.sql`.
- **Edge function** `analyze-annotations` — classifies detected ink with
  Claude. Deploy it like the IMSLP functions:

    ```bash
    npx supabase functions deploy analyze-annotations --project-ref jibgwgosihadbjgxdsfe
    ```

- **Secret** — the function needs an Anthropic API key
  (https://console.anthropic.com → API keys):

    ```bash
    npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref jibgwgosihadbjgxdsfe
    ```

    Without the key everything still works — detected marks import as erasable
    ink strokes instead of editable text (the function answers
    `code: "ai_unavailable"` and the app degrades gracefully). Cost is roughly
    $0.03–0.08 per scanned page (claude-sonnet-5, one call per page that has
    colored ink).

- **Edge function** `analyze-notes` — reads the pitches (and any visible
  fingering digits) of a region the user selects with the Fingering tool, so
  the app can render the piano-keyboard fingering diagram. Same secret, same
  degrade behavior (no key → the flow falls back to manual note entry):

    ```bash
    npx supabase functions deploy analyze-notes --project-ref jibgwgosihadbjgxdsfe
    ```

    Defaults to `claude-opus-5` (accuracy-sensitive vision; roughly $0.05–0.15
    per selection, rate-limited to 40/user/hour, and readings are cached
    locally per region). To trade accuracy for cost:

    ```bash
    npx supabase secrets set ANALYZE_NOTES_MODEL=claude-sonnet-5 --project-ref jibgwgosihadbjgxdsfe
    ```

## 5. Play-along analysis (OMR service + Edge Function)

The play-along feature converts uploaded PDFs to notes + measure positions via
a self-hosted [Audiveris](https://github.com/Audiveris/audiveris) container
(`services/omr-service/` — see the README for build/deploy). Once the
container is reachable somewhere (Cloud Run / Fly.io / your own box):

1. Apply migrations through `20260806140000_omr_cron` (`omr_jobs`, `score_cache`,
   timings, realtime broadcast, pg_cron sweeper).
2. Deploy the Edge Function: `npx supabase functions deploy score-analyze --project-ref jibgwgosihadbjgxdsfe`
3. Set its secrets (generate the shared secret with `openssl rand -hex 32` and
   give the same value to the container's `OMR_SERVICE_SECRET` env):

```bash
npx supabase secrets set --project-ref jibgwgosihadbjgxdsfe \
  OMR_SERVICE_URL=https://your-omr-service.example.com \
  OMR_SERVICE_SECRET=<shared secret> \
  OMR_QUEUE_MODE=pull
```

4. Store the same URL/secret in Vault so `omr_sweep` can poke workers:

```sql
select vault.create_secret('https://your-omr-service.example.com', 'omr_service_url');
select vault.create_secret('<shared secret>', 'omr_service_secret');
```

If `pg_cron` / `pg_net` are unavailable, schedule Cloud Scheduler to
`POST /poke` every minute instead; the worker calls `omr_reap_expired_leases`
at the top of each poke.

The OMR service also needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`SELF_URL` (its public base URL for drain-chain self-pokes). Without any of
this configured the app still works — the transport bar just reports analysis
as unavailable and offers a retry once the service exists.

**Cutover:** deploy worker dual-mode → sweeper live → `OMR_QUEUE_MODE=pull` →
confirm drain → remove push path later. Rollback = `OMR_QUEUE_MODE=push`.


## 6. Stripe billing

**The teacher pays; the student never does.** Nobody who plays from a score they
were given is billed for it, on any plan: share-link visitors need no account at
all, and provisioned students get a real account that is permanently free — it
holds no subscription, is never metered, and is refused at checkout. There is no
per-seat price to add up, which is the whole point of the Teacher plan: a class
of twenty works out at **under $1 per student**.

Two personas, four tiers. Personal is the practice tool for one player; Teacher
is the same app plus a roster; Academy is Teacher for a team.

| Tier             | Price               | What it grants                                                                                                                  |
| ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Free             | — (no card, no row) | 3 active cloud scores · 3 play-along runs/mo · 5 AI fingering reads/mo · 2 smart imports/mo · 1 PDF export/mo · 3 student seats |
| Personal         | $7/mo or $70/yr     | Everything unlimited for one player — and no roster at all (`students` is 0, not 3)                                             |
| Teacher          | $19/mo or $190/yr   | Personal plus **unlimited students**, one roster, practice notes                                                                |
| Academy          | $49/mo or $490/yr   | Teacher for up to **5 teacher seats**, on one invoice                                                                           |
| Founding Teacher | $99/yr              | A second price on the **Teacher** product, shown only while the offer flag is on                                                |

Unlimited is unlimited except for AI fingering reads, which carry a silent
500/mo fair-use ceiling on every paid tier.

Annotation, the on-device fingering optimizer and manual fingering are unlimited
on every plan, including Free. PDF export is the one on-device feature that is
metered — 1/mo on Free, unlimited everywhere else, and never counted for guests
or students (§6e).

### 6a. Create the products and prices

Three products, seven prices. Prices are read from env and never hardcoded, so
these ids are the only output that matters. With the
[Stripe CLI](https://stripe.com/docs/stripe-cli) logged in (`stripe login`):

```bash
# Personal — the practice tool for one player.
PERSONAL=$(stripe products create --name="Cleffy Personal" --description="Unlimited scores, analysis and imports for one player" --format=json | jq -r .id)

stripe prices create --product="$PERSONAL" --currency=usd --unit-amount=700  --recurring.interval=month --nickname="Personal monthly"
stripe prices create --product="$PERSONAL" --currency=usd --unit-amount=7000 --recurring.interval=year  --nickname="Personal annual"

# Teacher — one product, THREE prices: monthly, annual, and the founding annual.
TEACHER=$(stripe products create --name="Cleffy Teacher" --description="Everything in Personal, plus an unlimited student roster" --format=json | jq -r .id)

stripe prices create --product="$TEACHER" --currency=usd --unit-amount=1900  --recurring.interval=month --nickname="Teacher monthly"
stripe prices create --product="$TEACHER" --currency=usd --unit-amount=19000 --recurring.interval=year  --nickname="Teacher annual"
stripe prices create --product="$TEACHER" --currency=usd --unit-amount=9900  --recurring.interval=year  --nickname="Founding Teacher annual"

# Academy — Teacher for a team of up to 5 instructors, on one invoice.
ACADEMY=$(stripe products create --name="Cleffy Academy" --description="Teacher for up to 5 instructors" --format=json | jq -r .id)

stripe prices create --product="$ACADEMY" --currency=usd --unit-amount=4900  --recurring.interval=month --nickname="Academy monthly"
stripe prices create --product="$ACADEMY" --currency=usd --unit-amount=49000 --recurring.interval=year  --nickname="Academy annual"
```

Founding Teacher is deliberately a _price_ on the Teacher product, not a tier or
a product of its own: `priceTiers()` in `_shared/stripe.ts` maps it to `teacher`
alongside the two full-price ids, so grandfathering needs no code at all —
existing subscribers simply keep renewing at the price they bought, and switching
the offer off only hides the card for new customers.

Then enable the Customer Portal once, at
[Settings → Billing → Customer portal](https://dashboard.stripe.com/test/settings/billing/portal),
so "Manage subscription" works.

### 6b. Edge Function secrets

Server-side values. **Never** give any of these a `VITE_` prefix — that would
ship them to the browser.

```bash
# Pre-filled with the real SANDBOX price ids (test mode). Paste your sandbox
# secret key (Dashboard, test mode → Developers → API keys) and the webhook
# signing secret from the rollout notes; swap all of these at the live flip.
supabase secrets set \
  STRIPE_SECRET_KEY=sk_test_PASTE_ME \
  STRIPE_WEBHOOK_SECRET=whsec_PASTE_ME \
  STRIPE_PRICE_PERSONAL_MONTHLY=price_1U8nin9EqxUjgZtnTC00MEwP \
  STRIPE_PRICE_PERSONAL_ANNUAL=price_1U8niu9EqxUjgZtn3fGKope8 \
  STRIPE_PRICE_TEACHER_MONTHLY=price_1U8niw9EqxUjgZtnSqC3tsTx \
  STRIPE_PRICE_TEACHER_ANNUAL=price_1U8niy9EqxUjgZtn7TBy8cdn \
  STRIPE_PRICE_ACADEMY_MONTHLY=price_1U8nj49EqxUjgZtnlVhAVP4P \
  STRIPE_PRICE_ACADEMY_ANNUAL=price_1U8nj69EqxUjgZtnNZv0nUMq \
  STRIPE_PRICE_FOUNDING_ANNUAL=price_1U8nj19EqxUjgZtnhcbeO9ct \
  APP_URL=https://cleffy.io
```

Those seven `STRIPE_PRICE_*` names are exactly the seven `priceCatalog()` reads
in `supabase/functions/_shared/stripe.ts`. A name that is unset is simply a price
that does not exist: it maps to no tier, and checkout refuses it.

| Secret                       | Purpose                                                                     |
| ---------------------------- | --------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`          | Sandbox: creating Checkout/Portal sessions and reading subscriptions        |
| `STRIPE_WEBHOOK_SECRET`      | Sandbox: verifying the webhook signature — its own value, not the API key   |
| `STRIPE_SECRET_KEY_LIVE`     | The same, for the live account. Setting it is what puts cleffy.io on live   |
| `STRIPE_WEBHOOK_SECRET_LIVE` | The live endpoint's signing secret                                          |
| `STRIPE_PRICE_*`             | The price→tier map. A price id absent from these is refused at checkout     |
| `APP_URL`                    | Return URL when a caller sent no Origin (a known Origin wins over it)       |

cleffy.io and dev.cleffy.io share this one project, so the Edge Functions pick
the account per request from the `Origin` header — live for cleffy.io, sandbox
for dev.cleffy.io and localhost. `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
keep their pre-split meaning as the **sandbox** pair. See
`supabase/functions/_shared/stripeMode.ts` and DEPLOY.md §0.

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided
by the platform — you do not set those.

The client-visible values go in `.env` (see `.env.example`):
`VITE_STRIPE_PUBLISHABLE_KEY`, the seven `VITE_STRIPE_PRICE_*` ids mirroring the
secrets above, and `VITE_STRIPE_FOUNDING_OFFER`. Leave them blank to run without
billing — the pricing dialog then says so rather than offering buttons that
cannot work. The dialog considers billing configured once both Personal and both
Teacher ids are present; the two Academy ids are optional, and an Academy card
with no id keeps its description but offers no button. Founding is optional
twice over — it needs its id **and** `VITE_STRIPE_FOUNDING_OFFER=true`, or the
card is not rendered at all.

### 6c. Deploy the functions

Two functions **must** be deployed with JWT verification disabled, for the same
structural reason: their caller has no Supabase JWT to present. Stripe
authenticates by signature; a student typing the code off their card is not
signed in yet, and `student-login` is the endpoint that trades that code for a
session. Both are already declared in `supabase/config.toml`, but pass the flag
explicitly when deploying by hand:

```bash
supabase functions deploy stripe-webhook --no-verify-jwt
supabase functions deploy student-login  --no-verify-jwt
supabase functions deploy stripe-checkout
supabase functions deploy stripe-portal
supabase functions deploy student-provision   # roster create/rotate/archive/restore
supabase functions deploy score-analyze analyze-annotations analyze-notes
supabase functions deploy imslp-download   # now meters smart imports
```

Open is not the same as an oracle: `student-login` is hard rate-limited (60/min
per IP, against the ~59-bit code space of `_shared/studentCodes.ts`) and answers
every failure — bad shape, no such code, archived student, refused password —
with one indistinguishable 401. See §6f. The ceiling is sized for a classroom
arriving behind one school NAT rather than for a person, which costs nothing
against 59 bits; the bucket key is `cf-connecting-ip`, or the LAST
`x-forwarded-for` hop, because proxies append to that header and only its last
entry is one a caller cannot choose.

Register the endpoint in Stripe
([Developers → Webhooks](https://dashboard.stripe.com/test/webhooks)) pointing at
`https://<project-ref>.supabase.co/functions/v1/stripe-webhook`, subscribed to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`

### 6d. Local webhook testing

```bash
# Terminal 1 — serve the function without JWT verification.
supabase functions serve stripe-webhook --no-verify-jwt

# Terminal 2 — forward live events. This prints the whsec_… signing secret to
# use as STRIPE_WEBHOOK_SECRET locally; it differs from the dashboard one.
stripe listen --forward-to http://127.0.0.1:54321/functions/v1/stripe-webhook

# Terminal 3 — fire events at it.
stripe trigger checkout.session.completed
stripe trigger customer.subscription.deleted
stripe trigger invoice.payment_failed
```

What to check: a `subscriptions` row appears with the resolved tier, a
`stripe_events` row records the event id, and re-delivering the same event from
the Stripe dashboard is a no-op (the handler reports `duplicate: true`).

### 6e. What is enforced where

Client-side checks are UX only. Every limit is enforced server-side:

| Limit                                   | Enforced by                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4th active cloud score                  | `documents_enforce_score_cap` trigger — uploads are a direct browser insert, so the cap lives in the database                                                                  |
| Play-along, vision reads, smart imports | `consume_quota()` called from the Edge Function _before_ any work                                                                                                              |
| PDF export                              | `consume_pdf_export()` — the export runs on-device, so this is an honest-UI counter, not a hard gate. It exempts anonymous share-link guests and provisioned students outright |
| Student seats                           | Stock check in `student-provision`, on both `create` and `restore` — a seat is claimed where the row is written, so archive+restore cannot launder the cap                     |
| Writes to an archived score             | `annotations_insert` / `annotations_update` RLS, so it holds for share-link students too                                                                                       |
| Practice-note visibility                | `practice_notes_select` RLS — a note is private to its author until `shared` is set, and then only to the student it is about                                                  |
| Academy seat count                      | `studio_members_seat_limit` trigger (the v1 `studios` / `studio_members` table names are kept; only the tier they entitle was renamed)                                         |

`students` and `cloud_scores` are **stocks** — a live count of rows, checked
where the row is written — so neither ever reaches `usage_counters`. Everything
else in that table is a monthly flow.

A provisioned student is not a customer, and the endpoints that only make sense
for one say so: `stripe-checkout`, `stripe-portal`, `student-provision` and the
three metered analyze endpoints all answer **403 `student_account`** for a
student account, ahead of any other work. `rejectAnonymous` does not cover this —
a student is a registered, non-anonymous user — which is why `rejectStudent` is a
separate gate.

On lapse nothing is deleted. `apply_free_tier_archival()` sets `archived_at` on
everything past the free cap; those scores stay fully viewable and exportable
and only become read-only. Restoring a subscription makes them writable again —
un-archiving is a plain `archived_at = null` update, subject to the same cap.
Students are never touched by a lapse at all; see the end of §6f.

> **Note:** `score-analyze`, `analyze-annotations` and `analyze-notes` currently
> run the complete gate (auth → document access → entitlements → atomic quota
> consume) and then return **501 Not Implemented**, because the analysis
> features themselves do not exist in this repo yet. The metering is real; the
> work is the part that is missing. When it lands, wrap it so failures call
> `refund()` — see `supabase/functions/_shared/analyzeScaffold.ts`.

### 6f. Student accounts

A provisioned student is a **real Supabase auth user** — not a share link, not a
row pretending to be a login. `student-provision` (`action: 'create'`) creates it
under the service role, because no client may create a user: a synthetic address
`st-<roster-id>@students.cleffy.app` with **no inbox behind it**, marked
`app_metadata.user_type = 'student'`. That flag is admin-set and therefore not
something the account can write, which is what lets `get_entitlements()` and the
`documents_insert` policy trust it. Alongside it goes a `managed_students` row:
the teacher's side of the account — display name, the hash of the login code, and
the archive flag. The two share one uuid, so the roster id names the address.

**The code is the whole credential.** Twelve characters from a 31-symbol
alphabet — ~59 bits, rejection-sampled so every code is uniform, with `0/O` and
`1/I/L` dropped so a code read off a card over a music stand cannot be mistyped
into ambiguity. It does two jobs at once: its SHA-256 selects the roster row, and
it _is_ the password of the synthetic user. The teacher prints it on a card
(`XXXX-XXXX-XXXX`; the dashes are cosmetic, and `student-login` normalizes
whatever the child types). It is shown **exactly once**, at creation. Neither
Supabase nor `managed_students` stores anything but a hash, so a lost code is
never recovered — it is replaced with `action: 'rotate'`, which mints a new one
and invalidates the old.

**Archive frees the seat and revokes access, and deletes nothing.** Archiving
does two things, because the roster row and the auth account are two halves of
one student: it stamps `archived_at`, which is what frees the seat and stops
`student-login` matching, and it **bans the account**, which is the actual
revocation. The stamp alone would not be one — the code on the card is also the
account's Supabase password, and the synthetic address is derived from the roster
id the student can read off their own row, so they could sign straight back in at
`/auth/v1/token` without ever touching `student-login`. The ban refuses that and
every token refresh, so a session already open dies with its current access
token. Nothing is deleted: assignments, annotations and practice notes all stay,
and `action: 'restore'` lifts the ban and gives a student their history back. A
restore re-runs the same stock check a create does, so a teacher at their cap
cannot archive-and-restore their way past it.

**COPPA posture: no student email address and no student-chosen password is ever
collected.** There is no inbox to confirm, no address to mail, and no
self-service reset to phish — the printed card is the entire enrolment, and
replacing it is the teacher's `rotate`. The synthetic address is an
implementation detail that never leaves the server and is never shown to anyone,
teacher included. The one address that may exist is the **parent's**, optional,
stored on the teacher's roster row (`managed_students.parent_email`) for the
teacher's records and for sending the card home.

**A lapse never locks a student out.** Nothing about a subscription is consulted
when a student signs in or opens what they were assigned, so if a teacher's plan
ends, their existing students keep working exactly as before. What stops is
_provisioning_: the next `create` — or `restore` — past the free cap of 3 seats
is refused. (Personal is the sharper case: `students` is 0 there, so it refuses
without even counting.) The one thing a lapse does reach a student through is the
score itself — a document archived past the free cap becomes read-only for
everybody who can see it, its assigned students included.

## 7. Deploy the app to Vercel (cleffy.io)

The repo ships `vercel.json` with the SPA rewrite react-router needs, and
Vercel auto-detects Vite (`npm run build`, output `dist/`).

1. [vercel.com/new](https://vercel.com/new) → import the GitHub repo, keep the
   detected settings, and set the **production branch to `main`** — every push
   to main then deploys automatically.
2. Project → Settings → **Environment Variables** (Production): paste
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, plus the `VITE_STRIPE_*`
   values once §6a has produced the price ids. Missing Stripe values are safe —
   the pricing dialog says billing is unconfigured instead of breaking.
3. Project → Settings → **Domains** → add `cleffy.io` (and `www.cleffy.io`
   redirecting to it). The domain is already registered on Vercel, so it
   attaches without DNS work.
4. Back in Supabase [Auth → URL Configuration](https://supabase.com/dashboard/project/jibgwgosihadbjgxdsfe/auth/url-configuration):
   set the Site URL to `https://cleffy.io` and add `https://cleffy.io`,
   `https://cleffy.io/auth/callback` and `https://cleffy.io/update-password`
   to the redirect list (keep the localhost entries for dev).
5. When setting the Edge secrets in §6b, use `APP_URL=https://cleffy.io` so
   Checkout and the Customer Portal return to production.

## 8. (Optional) Let the Claude environment reach Supabase

To let Claude verify against the real backend (and run `db push` itself), allow
`*.supabase.co` in this environment's **network policy** (Claude Code on the web →
environment settings). Without it, everything still works from your machine —
`npm run dev` locally and the app talks to Supabase directly.

## Verifying it worked

1. `npm run dev`, open http://localhost:5173 → **Create account** or **Log in**.
2. Register with email/password.
3. Upload a PDF — it appears in the library, and in Storage under `scores/{id}/`.
   Uploading a photo/screenshot (PNG/JPEG) works too — it becomes a one-page PDF.
   A score that already carries colored-ink marks triggers the "Existing marks
   found" offer; accepting opens the review panel (`node scripts/generate-annotated-fixture.mjs`
   produces `e2e-fixtures/test-score-annotated.pdf` for trying this).
4. Open it, draw — rows appear in the `annotations` table (Data → annotations).
5. Share → create an **edit** link, open it in a private/incognito window, enter a
   name → the same score opens and both windows can annotate.
6. Create a **view** link → that window gets "view only" and no toolbar.
7. From login → **Forgot password** → follow the email → set a new password on
   `/update-password`.
8. Billing: upload a 4th score on a free account → the library shows the
   limit notice with a working **See plans** button. Complete Checkout with
   Stripe's test card `4242 4242 4242 4242` → **Settings** shows the plan badge
   for the tier you bought and the 4th score now uploads. **Manage subscription**
   opens the Customer Portal; cancel there → the account returns to free limits,
   and scores past the cap are archived but still open and export correctly.
9. Roster, on a free teacher account: **Students** → **Add student** → a code
   appears with a **Print card** button. Note it down — this is the only time it
   is readable — then reload the page and confirm it is gone for good.
10. Open a score's menu in the library → **Assign to student…** → pick that
    student, leave the access on **Edit**.
11. In a private/incognito window open `/student`, type the code (dashes,
    spaces and lower case are all fine) → **Open my music** lands on
    `/assignments` with the assigned score listed. Open it and **draw** — the
    strokes save, and rows appear in `annotations` with the student's user id.
12. Back in the teacher's window, flip that assignment's toggle to **View** →
    in the student's window the next stroke is refused (the toggle demoted their
    `document_members` row from editor to viewer, and RLS is what stops the
    write, not the toolbar).
13. Practice notes, in that score's notes panel: save one note about the student
    with **Visible to …** left unticked, and a second with it ticked. The
    teacher sees both — the **Students** page badges them **Private** and
    **Shared** — while the student's window shows only the shared one, read-only.
    Confirm the private note is absent from the student's panel, not merely
    hidden: `practice_notes_select` never returns it.
14. Still on free: add a 4th student → refused with the seat-limit notice. Buy
    **Teacher** with the test card → adding students is now uncapped, and every
    student provisioned before the upgrade signs in exactly as before.
