# Deploying Cleffy — cleffy.io (main) and dev.cleffy.io (dev)

Target end state: `main` builds to **cleffy.io**, `dev` builds to
**dev.cleffy.io**, both served by one Vercel project, with **cleffy.io selling
against the live Stripe account and dev.cleffy.io against the sandbox**.

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
| Stripe **live** catalogue (3 products, 7 prices) | ✅ created |
| Stripe webhook endpoint → `stripe-webhook` (sandbox) | ✅ enabled, 5 events |
| Stripe webhook endpoint → `stripe-webhook` (live) | ✅ enabled, 5 events |
| Price ids: client ↔ Edge Function, both modes | ✅ committed, drift-guarded by tests |
| Stripe Customer portal configuration (sandbox) | ✅ created, `is_default: true` |
| Stripe Customer portal configuration (live) | ⛔ **one dashboard save — see below** |
| Edge secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_URL`) | ✅ set |
| Edge secret `STRIPE_WEBHOOK_SECRET_LIVE` | ✅ set |
| Edge secret `STRIPE_SECRET_KEY_LIVE` | ⛔ **no API mints one — see below** |
| Vercel project, linked to `main`, auto-deploying | ✅ created and verified live |
| `dev` branch deploy config (SPA rewrite + Supabase env) | ✅ pushed, preview verified live |
| cleffy.io / dev.cleffy.io attached, certs issued | ✅ live |
| Separate dev Supabase backend | ⛔ **§5 — blocked on the free-project limit** |

---

## 0. The live flip — cleffy.io on the real Stripe account

cleffy.io transacts against Stripe account **Cleffy** (`acct_1U35FW4eZ6RX0W0g`,
live). dev.cleffy.io and localhost stay on **Cleffy sandbox**
(`acct_1U35Fc9EqxUjgZtn`).

One Supabase project serves both deploys, so a single `STRIPE_SECRET_KEY` would
put both storefronts on the same Stripe account — which is why buying on
cleffy.io reached the sandbox. The Edge Functions now choose the account per
request from the **Origin** header (`supabase/functions/_shared/stripeMode.ts`).
Nothing in a request body influences that choice, and an origin that is not one
of ours is refused rather than guessed.

The webhook has no Origin to sort by — both accounts POST to this project's one
URL — so it verifies the signature against each account's secret in turn, and
whichever secret verifies *is* the account. Mode is a result of authentication
there, never an input to it.

### What is left, in this order

These three land together. Between step 2 and step 3 the currently-deployed
webhook cannot link a new customer (its `onConflict: 'user_id'` no longer matches
the composite key), so do not stop half way.

**1. Set the live secret key.** No API mints one — copy it from the live-mode
dashboard → Developers → API keys.

```bash
npx supabase secrets set --project-ref jibgwgosihadbjgxdsfe \
  STRIPE_SECRET_KEY_LIVE='sk_live_…'
```

`STRIPE_WEBHOOK_SECRET_LIVE` is already set, from the live endpoint's own
signing secret. `STRIPE_SECRET_KEY` keeps its sandbox value and from now on
serves dev only — leave it as it is.

A key pasted into the wrong slot is rejected rather than used: the mode infix
(`sk_live_` / `sk_test_`) has to match the variable it is in.

**2. Apply `supabase/migrations/20260828180000_billing_stripe_mode.sql`** through
the SQL editor or the Management API — *not* `db push`, for the reason in "Known
divergence" at the foot of this file.

It tags `billing_customers` and `subscriptions` with the account that created
them. Both are single-account assumptions that break the moment the two deploys
differ: a Stripe customer id belongs to exactly one account, so the sandbox
`cus_…` a teacher picked up testing on dev would make their live checkout fail
with "No such customer".

It also makes **only live subscriptions entitle**. auth users are shared between
the two deploys, so without that filter anyone could subscribe on dev with
Stripe's published test card and walk onto cleffy.io with a paid plan. The cost
is that dev can no longer *grant* entitlements — it still exercises checkout, the
webhook and the `subscriptions` row. Splitting dev onto its own Supabase project
(§5) removes the trade-off; `public.entitling_billing_modes()` is then the single
line to widen.

**3. Deploy the functions, then merge `dev` → `main`.**

```bash
npx supabase functions deploy stripe-checkout stripe-portal stripe-webhook \
  --project-ref jibgwgosihadbjgxdsfe
```

The frontend can follow at its own pace: the server re-prices whatever the
client names into its own mode, so a bundle cached from before the flip still
buys the right plan on the right account.

### Then, in the **live** dashboard (one click, once)

Settings → Billing → **Customer portal** → Save. `stripe-portal` 500s for every
live caller until a default configuration exists, exactly as it did in the
sandbox (§1). There is still no API for it — `POST
/v1/billing_portal/configurations` is not exposed.

### Verifying

```bash
# Live mode: cleffy.io must reach the live account.
curl -sS -X POST https://jibgwgosihadbjgxdsfe.supabase.co/functions/v1/stripe-checkout \
  -H 'Origin: https://cleffy.io' -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' -d '{"priceId":"price_1U9V7M4eZ6RX0W0glzzjnokr"}'
# -> a checkout.stripe.com URL with no test-mode banner

# An origin we do not publish from buys nothing at all.
curl -sS -X POST … -H 'Origin: https://example.com' …
# -> 400 {"error":"Unrecognised origin","code":"unknown_origin"}
```

The user who bought Personal in the sandbox on 2026-08-28
(`sub_1U9SxH9EqxUjgZtnJvCo0viW`) keeps that row, now tagged `mode='test'`. It
stops entitling at step 2 and should be re-bought on the live account; cancel the
sandbox one so it does not keep renewing in test mode.

---

## 1. Stripe Customer portal (one click, once)

`stripe-portal` returns 500 for every caller until a **default portal
configuration** exists. There is no API for creating one — the Stripe connector
exposes only `GET /v1/billing_portal/configurations`, and that list is currently
empty.

1. Open the **test-mode** dashboard → Settings → Billing → **Customer portal**.
2. Leave the defaults as they are; press **Save**.

Done for the sandbox. The **live** dashboard needs the same single save — see §0.

That single save creates the default configuration. Verify with:

```
GET /v1/billing_portal/configurations   # should return exactly one object
```

Until then `stripe-portal` reaches Stripe and Stripe refuses — the function
itself is healthy, which you can confirm with an `OPTIONS` preflight returning
`200 ok`.

## 2. Edge Function secrets

Five values, and none of them can be committed:

```bash
npx supabase secrets set \
  --project-ref jibgwgosihadbjgxdsfe \
  STRIPE_SECRET_KEY='sk_test_…' \
  STRIPE_WEBHOOK_SECRET='whsec_…' \
  STRIPE_SECRET_KEY_LIVE='sk_live_…' \
  STRIPE_WEBHOOK_SECRET_LIVE='whsec_…' \
  APP_URL='https://cleffy.io'
```

Each mode reads its own pair, most specific name first:

| Mode | Secret key | Webhook secret | Stripe account |
| --- | --- | --- | --- |
| live | `STRIPE_SECRET_KEY_LIVE` | `STRIPE_WEBHOOK_SECRET_LIVE` | Cleffy (`acct_1U35FW4eZ6RX0W0g`) |
| test | `STRIPE_SECRET_KEY_TEST`, else `STRIPE_SECRET_KEY` | `STRIPE_WEBHOOK_SECRET_TEST`, else `STRIPE_WEBHOOK_SECRET` | Cleffy sandbox (`acct_1U35Fc9EqxUjgZtn`) |

- The pre-split names fall through to test mode on purpose: they held the sandbox
  key before there were two accounts, so **adding `STRIPE_SECRET_KEY_LIVE` is by
  itself the whole live flip** and dev keeps the key it already had.
- A key is rejected if its own mode infix (`sk_live_` / `sk_test_`, `rk_` too)
  contradicts the variable holding it. That one paste is what charges a real card
  from a test button, so it fails closed instead.
- Webhook secrets: `we_1U8njJ9EqxUjgZtnfBK3y0XH` is the sandbox endpoint,
  `we_1U9V8T4eZ6RX0W0glk3BZIOi` the live one. Both POST to the same URL — the
  receiver tries each secret and the one that verifies names the account.
- `APP_URL` — where Checkout and the Portal return to when a caller sent no
  `Origin` at all. A recognised `Origin` now wins over it, so a dev.cleffy.io
  tester is returned to dev.cleffy.io instead of being handed to production.

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

**No `STRIPE_PRICE_*` variable is needed.** Both catalogues are committed in
`supabase/functions/_shared/stripeMode.ts` as `PUBLISHED_PRICES`, because a price
id is configuration rather than a secret — the same fourteen values already ship
in `.env.production` and therefore in every browser bundle.
`tests/billing/priceCatalogInSync.test.ts` fails the build if the copies ever
disagree, or if an id ever appears in both catalogues at once.

Overrides are per mode — `STRIPE_PRICE_*` for test, `STRIPE_PRICE_LIVE_*` for
live — and **all-or-nothing within a mode**: one override replaces that whole
catalogue. That is deliberate. A per-key merge would let a half-finished
catalogue change serve two vintages of price from one account, which looks fine
until someone is billed the wrong amount.

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
