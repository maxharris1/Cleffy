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
| Stripe functions redeployed at v2 with the self-configuring catalogue | ✅ verified live |
| Stripe sandbox catalogue (3 products, 7 prices) | ✅ created |
| Stripe webhook endpoint → `stripe-webhook` | ✅ enabled, 5 events |
| Price ids: client ↔ Edge Function | ✅ committed, drift-guarded by tests |
| Stripe Customer portal configuration | ✅ created, `is_default: true` |
| Edge secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_URL`) | ✅ set |
| Vercel project, linked to `main`, auto-deploying | ✅ created and verified live |
| `dev` branch deploy config (SPA rewrite + Supabase env) | ✅ pushed, preview verified live |
| cleffy.io / dev.cleffy.io attached, certs issued | ✅ live |
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

Until then `stripe-portal` reaches Stripe and Stripe refuses — the function
itself is healthy, which you can confirm with an `OPTIONS` preflight returning
`200 ok`.

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

To confirm the secrets landed, POST an unsigned body to the webhook:

```bash
curl -i -X POST https://jibgwgosihadbjgxdsfe.supabase.co/functions/v1/stripe-webhook \
  -H 'Content-Type: application/json' -d '{"id":"evt_probe","type":"ping","data":{"object":{}}}'
```

`500 {"error":"Server misconfigured"}` means `STRIPE_WEBHOOK_SECRET` is still
unset — the state as of this writing. Once set, the same call returns
`400 {"error":"Invalid signature","code":"missing_header"}`, which is the
success signal: the function booted, read the secret, and rejected an unsigned
request exactly as it should.

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

### 3c. Domains — the only step left

The project exists: **cleffy** (`prj_aKb8bhLYHDA6P7DFb8F7bENTHUT8`), production
branch `main`, linked to the repo, building on every push. `cleffy.vercel.app`
is live and verified.

`cleffy.io` is already registered to the Vercel account **and already using
Vercel nameservers** (`ns1/ns2.vercel-dns.com`), and `dev.cleffy.io` already
resolves to Vercel's edge. **No registrar or DNS work is required.** What is
missing is only the project assignment — both hostnames currently answer:

```
HTTP 404  The deployment could not be found on Vercel.  DEPLOYMENT_NOT_FOUND
```

and HTTPS fails outright, because Vercel issues a certificate only once a
domain belongs to a project.

In **Project cleffy → Settings → Domains**, add:

| Domain | Assign to |
| --- | --- |
| `cleffy.io` | production (`main`) |
| `www.cleffy.io` | redirect to `cleffy.io` (Vercel offers this when adding) |
| `dev.cleffy.io` | git branch **`dev`** |

Because the nameservers are already Vercel's, the records are created
automatically and certificates issue within a minute or two.

There is no API for this: the Vercel connector exposes domain *purchase* tools
only (`buy_domain`, `check_domain_availability_and_price`, `get_domain_order`),
with nothing to attach an existing domain to a project.

## 3e. The `dev` branch — fixed

`dev` could not have served dev.cleffy.io usefully: built the way Vercel builds
it, the bundle contained no Supabase URL (no `.env.production` on that branch),
and with no `vercel.json` every deep link would have 404d, because Vercel's Vite
preset documents the catch-all rewrite as a step you perform rather than
supplying it.

Commit `710bd73` on `dev` adds both, plus the `!.env.production` exception its
`.gitignore` was missing — the blanket `.env.*` rule had been swallowing the
file. Typecheck and all 466 tests pass on that branch.

dev.cleffy.io shares the production Supabase project for now. To point it at a
separate backend later, override `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` for the Vercel **Preview** environment rather than
editing the committed file — a real environment variable wins under Vite 8,
which was verified rather than assumed.

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

## 6. Smoke test — passed 2026-08-27

Run end to end against the live stack, not simulated:

| Step | Result |
| --- | --- |
| Sign up via the public auth API | user created, session returned |
| `stripe-checkout` with a bogus price | `400 unknown_price` — the allowlist holds |
| `stripe-checkout` with Teacher monthly | Checkout session created; Stripe customer carries `metadata.user_id` |
| `stripe-portal` | returns a portal session URL |
| Subscription created in Stripe | webhook wrote `tier=teacher`, `status=trialing`, correct `price_id` and period end |
| Subscription cancelled | webhook wrote `tier=free`, `status=canceled` |
| `get_entitlements` over PostgREST with the user's JWT | `tier=free` with the free ceilings |
| `stripe_events` | both events recorded — idempotency table working |

The tier mapping is the load-bearing result: **no `STRIPE_PRICE_*` Edge secret is
set**, so `teacher` was resolved purely from `PUBLISHED_PRICES` in
`_shared/stripe.ts`. The committed catalogue works in production.

### Cleaning up the smoke-test rows

The Supabase MCP runs SQL read-only, so these were left behind. Harmless — the
subscription is cancelled and free-tier — but to remove them, run in the SQL
editor:

```sql
delete from subscriptions      where user_id in (select id from auth.users where email like 'cleffy-smoke-%');
delete from billing_customers  where user_id in (select id from auth.users where email like 'cleffy-smoke-%');
delete from stripe_events      where type like 'customer.subscription.%';
delete from auth.users         where email like 'cleffy-smoke-%';
```

The sandbox Stripe customer and its cancelled subscription can stay; they are
test-mode records.

### Still worth doing

The portal's **subscription_update is disabled**, which is Stripe's default. So
customers can cancel and update cards there, but cannot switch plans — despite
`stripe-portal`'s own comment saying plan changes happen in the portal. To close
that gap, enable "Switch plans" in the portal settings and add the three
products.

## Known divergence — read before touching migrations

The production database is **not reproducible from any single git branch**:

- `main` carries 11 migrations, and the billing/roster line only.
- `dev` carries 19, including the OMR/score-analysis line, under **different
  version timestamps** than the ones actually applied.
- Production has 25 applied, of which **16 exist in no branch at this version**.

So `supabase db push` from either branch would try to re-apply work that is
already live. Reconciling this is its own task — do not run `db push` against
production until it is done.
