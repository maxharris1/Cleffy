# Deploying Cleffy — cleffy.io (main) and dev.cleffy.io (dev)

Target end state: `main` builds to **cleffy.io**, `dev` builds to
**dev.cleffy.io**, both served by one Vercel project, with Stripe running in
sandbox (test) mode until the live flip.

Everything in this file that could be automated **has been**. What remains are
the steps that need a human because no API exposes them — each one says why.

---

## Status

| Piece | State |
| --- | --- |
| Billing schema (`billing`, `roster` migrations) | ✅ applied to production |
| Edge Functions (checkout, portal, webhook, student ×2, metered imslp) | ✅ deployed, ACTIVE |
| Stripe sandbox catalogue (3 products, 7 prices) | ✅ created |
| Stripe webhook endpoint → `stripe-webhook` | ✅ enabled, 5 events |
| Price ids: client ↔ Edge Function | ✅ committed, drift-guarded by tests |
| Stripe Customer portal configuration | ⛔ **§1 — human only** |
| Edge secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_URL`) | ⛔ **§2 — human only** |
| Vercel project + domains | ⛔ **§3 — starts with a human step** |
| Separate dev Supabase backend | ⛔ **§5 — blocked on the free-project limit** |

---

## 1. Stripe Customer portal (one click, once)

`stripe-portal` returns 500 for every caller until a **default portal
configuration** exists. There is no API for creating one — the Stripe connector
exposes only `GET /v1/billing_portal/configurations`, and that list is currently
empty.

1. Open the **test-mode** dashboard → Settings → Billing → **Customer portal**.
2. Leave the defaults as they are; press **Save**.

That single save creates the default configuration. Verify with:

```
GET /v1/billing_portal/configurations   # should return exactly one object
```

## 2. Edge Function secrets

Only three values, and none of them can be committed:

```bash
npx supabase secrets set \
  --project-ref jibgwgosihadbjgxdsfe \
  STRIPE_SECRET_KEY='sk_test_…' \
  STRIPE_WEBHOOK_SECRET='whsec_…' \
  APP_URL='https://cleffy.io'
```

- `STRIPE_SECRET_KEY` — sandbox account **Cleffy sandbox**, test-mode secret key.
- `STRIPE_WEBHOOK_SECRET` — the signing secret of endpoint
  `we_1U8njJ9EqxUjgZtnfBK3y0XH`, shown once when the endpoint is created and
  re-revealable in the dashboard.
- `APP_URL` — where Checkout and the Portal return to. Without it the functions
  fall back to the request `Origin`, which is fine locally and wrong in prod.

**The seven `STRIPE_PRICE_*` variables are no longer needed.** They are
committed in `supabase/functions/_shared/stripe.ts` as `PUBLISHED_PRICES`,
because a price id is configuration rather than a secret — the same seven values
already ship in `.env.production` and therefore in every browser bundle.
`tests/billing/priceCatalogInSync.test.ts` fails the build if the two copies
ever disagree.

Setting any `STRIPE_PRICE_*` still overrides the catalogue, but
**all-or-nothing**: one override replaces all seven. That is deliberate — a
half-finished live-mode flip would otherwise serve live and sandbox ids from the
same catalogue, which looks fine until a real card meets a test price.

## 3. Vercel project

### 3a. Add a GitHub Login Connection (human only)

Creating a git-linked project fails at the API with:

> Failed to link maxharris1/sheet_music_scribbler. You need to add a Login
> Connection to your GitHub account first.

Fix it once at **vercel.com/account/login-connections** → connect GitHub. This
is an account-level auth setting; no token or API call can substitute for it.

### 3b. Create the project

Team `maxharris1's projects` (`team_Ucc421wJMOxuAagxXETuQp13`), repo
`maxharris1/sheet_music_scribbler`, project name **cleffy**. Vercel
auto-detects Vite; `vercel.json` already supplies the SPA rewrite.

Production branch must be **main**.

### 3c. Domains

| Domain | Git branch |
| --- | --- |
| `cleffy.io` (+ `www`) | `main` (production) |
| `dev.cleffy.io` | `dev` |

`dev.cleffy.io` is a **branch domain**: Project → Settings → Domains → add the
domain, then assign it to the `dev` branch so every push to `dev` redeploys it.

### 3d. DNS

Add at whoever hosts cleffy.io's DNS. Vercel prints the authoritative values
when the domain is added — prefer those over the table if they differ:

| Record | Name | Value |
| --- | --- | --- |
| `A` | `@` | `76.76.21.21` |
| `CNAME` | `www` | `cname.vercel-dns.com` |
| `CNAME` | `dev` | `cname.vercel-dns.com` |

## 4. Environment variables on Vercel

**Production needs none.** `.env.production` is committed and client-safe by
design, so the production build is self-configuring.

Preview/dev only needs variables once `dev.cleffy.io` points at a different
Supabase backend (§5). This was verified empirically rather than assumed: a real
environment variable **does** beat `.env.production` under Vite 8, so setting
these for the *Preview* environment is enough to repoint the dev deploy.

```
VITE_SUPABASE_URL       = https://<dev-ref>.supabase.co
VITE_SUPABASE_ANON_KEY  = sb_publishable_…
```

## 5. A separate dev Supabase backend

Not created — the API refuses:

> maxharris1 (2 project limit) … reached their maximum limits for the number of
> active free projects

The `aut0` org is on the **team** plan, which is how it affords persistent
`development` and `staging` branches. Cleffy's org (**Sheet Music Scraper**,
`hgiyoueenqqdfhqgilsp`) is on **free**, where branching is unavailable and the
second free project is one over the per-user cap.

Three ways forward, cheapest first:

1. **Pause or delete an unused free project** — frees the slot at $0. A second
   free project can then be created and migrated in minutes.
2. **Upgrade Cleffy's org to Pro** — $25/mo, then persistent branches at
   ~$9.81/mo each, matching the `aut0` layout exactly.
3. **Point `dev.cleffy.io` at production** — $0 and instant, but dev testing
   writes production rows. Fine before launch, not after.

Until one is chosen, `dev.cleffy.io` shares the production backend (case 3 by
default, since no Preview env vars are set).

## 6. Smoke test

1. Sign up on cleffy.io, confirm the free tier works with no Stripe config.
2. Upgrade → Stripe Checkout → card `4242 4242 4242 4242`, any future expiry.
3. Confirm `subscriptions` gains a row with `status = 'active'` (the webhook
   wrote it) and the plan badge updates.
4. Settings → Manage billing → the Customer portal opens (proves §1).
5. Cancel in the portal; confirm the row flips to `cancel_at_period_end`.

---

## Known divergence — read before touching migrations

The production database is **not reproducible from any single git branch**:

- `main` carries 11 migrations, and the billing/roster line only.
- `dev` carries 19, including the OMR/score-analysis line, under **different
  version timestamps** than the ones actually applied.
- Production has 25 applied, of which **16 exist in no branch at this version**.

So `supabase db push` from either branch would try to re-apply work that is
already live. Reconciling this is its own task — do not run `db push` against
production until it is done.
