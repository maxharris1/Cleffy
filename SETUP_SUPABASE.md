# Supabase setup — one-time checklist

Project: `jibgwgosihadbjgxdsfe` · https://supabase.com/dashboard/project/jibgwgosihadbjgxdsfe

> **STATUS:** Migrations 0001–0003 applied, `scores` bucket created, anonymous
> sign-ins enabled, redirect URLs set. **Auth UI is email/password** (not
> magic-link). Remaining recommendation: custom SMTP for faster auth emails, and
> add `SUPABASE_ACCESS_TOKEN` to the Claude environment's env vars so future
> sessions can run ops without re-pasting.
>
> **PENDING:** `20260811120000_billing.sql` has **not** been applied yet, and no
> Stripe products/prices exist. Until both are done, the app runs exactly as
> before — the pricing dialog reports that billing is unconfigured, and nothing
> is gated. See §1 to apply the migration and §4 for Stripe.

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

## 4. Stripe billing

Teacher-pays, three tiers. Students who join by share link are never gated and
never need an account, on any plan.

| Tier             | Price                            | What it grants                                                                             |
| ---------------- | -------------------------------- | ------------------------------------------------------------------------------------------ |
| Free             | — (no card, no subscription row) | 3 active cloud scores · 3 play-along runs/mo · 1 smart import/mo · 5 AI fingering reads/mo |
| Pro              | $15/mo or $120/yr                | Everything unlimited (vision reads carry a silent 500/mo fair-use ceiling)                 |
| Studio           | $299/yr                          | Pro for up to 5 teachers                                                                   |
| Founding Teacher | $79/yr                           | A second price on the **Pro** product, shown only while the offer flag is on               |

Annotation, the on-device fingering optimizer, manual fingering and PDF export
are unlimited on every plan, including Free.

### 4a. Create the products and prices

Prices are read from env and never hardcoded, so these ids are the only output
that matters. With the [Stripe CLI](https://stripe.com/docs/stripe-cli) logged in
(`stripe login`):

```bash
# Pro — one product, three prices (monthly, annual, and the founding annual).
PRO=$(stripe products create --name="Cleffy Pro" --description="Unlimited scores, analysis and imports" --format=json | jq -r .id)

stripe prices create --product="$PRO" --currency=usd --unit-amount=1500  --recurring.interval=month --nickname="Pro monthly"
stripe prices create --product="$PRO" --currency=usd --unit-amount=12000 --recurring.interval=year  --nickname="Pro annual"
stripe prices create --product="$PRO" --currency=usd --unit-amount=7900  --recurring.interval=year  --nickname="Founding Teacher annual"

# Studio — a flat annual rate covering up to 5 teacher seats.
STUDIO=$(stripe products create --name="Cleffy Studio" --description="Pro for up to 5 teachers" --format=json | jq -r .id)
stripe prices create --product="$STUDIO" --currency=usd --unit-amount=29900 --recurring.interval=year --nickname="Studio annual"
```

Founding Teacher is deliberately a _price_, not a tier: the webhook maps it to
`pro`, so grandfathering needs no code at all — existing subscribers simply keep
renewing at the price they bought, and switching the offer off only hides the
card for new customers.

Then enable the Customer Portal once, at
[Settings → Billing → Customer portal](https://dashboard.stripe.com/test/settings/billing/portal),
so "Manage subscription" works.

### 4b. Edge Function secrets

Server-side values. **Never** give any of these a `VITE_` prefix — that would
ship them to the browser.

```bash
supabase secrets set \
  STRIPE_SECRET_KEY=sk_test_... \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  STRIPE_PRICE_PRO_MONTHLY=price_... \
  STRIPE_PRICE_PRO_ANNUAL=price_... \
  STRIPE_PRICE_STUDIO_ANNUAL=price_... \
  STRIPE_PRICE_FOUNDING_ANNUAL=price_... \
  APP_URL=https://YOUR-APP.vercel.app
```

| Secret                  | Purpose                                                                    |
| ----------------------- | -------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`     | Creating Checkout/Portal sessions and reading subscriptions                |
| `STRIPE_WEBHOOK_SECRET` | Verifying the webhook signature — its own value, not the API key           |
| `STRIPE_PRICE_*`        | The price→tier map. A price id absent from these is refused at checkout    |
| `APP_URL`               | Where Checkout and the Portal return to (falls back to the request Origin) |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided
by the platform — you do not set those.

The client-visible values go in `.env` (see `.env.example`):
`VITE_STRIPE_PUBLISHABLE_KEY`, the four `VITE_STRIPE_PRICE_*` ids, and
`VITE_STRIPE_FOUNDING_OFFER`. Leave them blank to run without billing — the
pricing dialog then says so rather than offering buttons that cannot work.

### 4c. Deploy the functions

The webhook **must** be deployed with JWT verification disabled: Stripe has no
Supabase JWT to present, and authenticates by signature instead. This is already
declared in `supabase/config.toml`, but pass the flag explicitly when deploying
by hand:

```bash
supabase functions deploy stripe-webhook --no-verify-jwt
supabase functions deploy stripe-checkout
supabase functions deploy stripe-portal
supabase functions deploy score-analyze analyze-annotations analyze-notes
supabase functions deploy imslp-download   # now meters smart imports
```

Register the endpoint in Stripe
([Developers → Webhooks](https://dashboard.stripe.com/test/webhooks)) pointing at
`https://<project-ref>.supabase.co/functions/v1/stripe-webhook`, subscribed to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`

### 4d. Local webhook testing

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

### 4e. What is enforced where

Client-side checks are UX only. Every limit is enforced server-side:

| Limit                                   | Enforced by                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 4th active cloud score                  | `documents_enforce_score_cap` trigger — uploads are a direct browser insert, so the cap lives in the database |
| Play-along, vision reads, smart imports | `consume_quota()` called from the Edge Function _before_ any work                                             |
| Writes to an archived score             | `annotations_insert` / `annotations_update` RLS, so it holds for share-link students too                      |
| Studio seat count                       | `studio_members_seat_limit` trigger                                                                           |

On lapse nothing is deleted. `apply_free_tier_archival()` sets `archived_at` on
everything past the free cap; those scores stay fully viewable and exportable
and only become read-only. Restoring a subscription makes them writable again —
un-archiving is a plain `archived_at = null` update, subject to the same cap.

> **Note:** `score-analyze`, `analyze-annotations` and `analyze-notes` currently
> run the complete gate (auth → document access → entitlements → atomic quota
> consume) and then return **501 Not Implemented**, because the analysis
> features themselves do not exist in this repo yet. The metering is real; the
> work is the part that is missing. When it lands, wrap it so failures call
> `refund()` — see `supabase/functions/_shared/analyzeScaffold.ts`.

## 5. (Optional) Let the Claude environment reach Supabase

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
8. Billing: upload a 4th score on a free account → the library shows the
   limit notice with a working **See plans** button. Complete Checkout with
   Stripe's test card `4242 4242 4242 4242` → **Settings** shows the Pro badge
   and the 4th score now uploads. **Manage subscription** opens the Customer
   Portal; cancel there → the account returns to free limits, and scores past
   the cap are archived but still open and export correctly.
