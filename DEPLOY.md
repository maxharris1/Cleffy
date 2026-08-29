# Deploying Cleffy — cleffy.io (main) and dev.cleffy.io (dev)

Target end state: `main` builds to **cleffy.io**, `dev` builds to
**dev.cleffy.io**, both served by one Vercel project, with Stripe running in
sandbox (test) mode until the live flip.

Everything in this file that could be automated **has been**. What remains are
the steps that need a human because no API exposes them — each one says why.

---

## Status

| Piece                                                                  | State                                                                   |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Billing schema (`billing`, `roster` migrations)                        | ✅ applied to production                                                |
| Edge Functions (checkout, portal, webhook, student ×2, metered imslp)  | ✅ deployed, ACTIVE                                                     |
| Stripe functions redeployed at v2 with the self-configuring catalogue  | ✅ verified live                                                        |
| Stripe sandbox catalogue (3 products, 7 prices)                        | ✅ created                                                              |
| Stripe **live** catalogue (3 products, 7 prices)                       | ✅ created                                                              |
| Stripe webhook endpoint → `stripe-webhook` (sandbox)                   | ✅ enabled, 5 events                                                    |
| Stripe webhook endpoint → `stripe-webhook` (live)                      | ✅ enabled, 5 events                                                    |
| Price ids: client ↔ Edge Function, both modes                          | ✅ committed, drift-guarded by tests                                    |
| Stripe Customer portal configuration (sandbox)                         | ✅ created, `is_default: true`                                          |
| Stripe Customer portal configuration (live)                            | ⛔ **one dashboard save — §0**                                          |
| Edge secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_URL`) | ✅ set on production                                                    |
| Edge secret `STRIPE_WEBHOOK_SECRET_LIVE` (production)                  | ✅ set                                                                  |
| Edge secret `STRIPE_SECRET_KEY_LIVE` (production)                      | ✅ set 2026-08-28                                                       |
| Stripe secrets on the `dev` branch project                             | ⛔ **key + webhook secret still needed — §0 step 5**                    |
| Vercel project, linked to `main`, auto-deploying                       | ✅ created and verified live                                            |
| `dev` branch deploy config (SPA rewrite + Supabase env)                | ✅ pushed, preview verified live                                        |
| cleffy.io / dev.cleffy.io attached, certs issued                       | ✅ live                                                                 |
| Separate dev Supabase backend                                          | ✅ persistent `dev` branch, `qdbnlrgylelelvwbkvnm` (§5)                 |
| dev.cleffy.io actually pointed at that backend                         | ✅ by hostname in the bundle — **was production until 2026-08-28 (§5)** |
| Edge secret `STRIPE_MODES` (both projects)                             | ⛔ **§0 — what refuses a sandbox caller on production**                 |
| Sandbox webhook endpoint retargeted to the branch                      | ✅ now posts to `qdbnlrgylelelvwbkvnm`                                  |
| Billing migration `20260828180000` applied to production               | ✅ applied and recorded                                                 |
| `entitling_billing_modes()` narrowed on production                     | ✅ `{live}`                                                             |
| Stripe functions redeployed mode-aware                                 | ✅ v7 ACTIVE on production                                              |
| Migrations `20260827150000` + `20260828120000` on production           | ⛔ **not applied — blocks the dev → main merge (§0)**                   |

---

## 0. The live flip — cleffy.io on the real Stripe account

cleffy.io transacts against Stripe account **Cleffy** (`acct_1U35FW4eZ6RX0W0g`,
live). dev.cleffy.io and localhost stay on **Cleffy sandbox**
(`acct_1U35Fc9EqxUjgZtn`).

Which account a checkout reaches is decided by `STRIPE_SECRET_KEY` — an Edge
Function secret. The two deploys have separate Supabase projects (§5), so in
principle that is one live key on production, one test key on the `dev` branch,
and nothing else to say.

It is not enough on its own, because "which project a deploy talks to" is itself
just configuration, and §5 records what happened the last time that was the only
safeguard: dev.cleffy.io was believed to be on the branch project and was in fact
on production for its entire existence. A live key alone would have meant real
cards behind dev's buttons for exactly as long as nobody checked.

So the account is chosen per request, from the **Origin** header
(`supabase/functions/_shared/stripeMode.ts`), and `STRIPE_MODES` lets each
backend refuse the origins that are not its own:

| Origin                                       | Account                        |
| -------------------------------------------- | ------------------------------ |
| `https://cleffy.io`, `https://www.cleffy.io` | live                           |
| `https://dev.cleffy.io`                      | sandbox                        |
| any plain-`http://` origin                   | sandbox                        |
| anything else                                | refused — `400 unknown_origin` |

Development is matched by scheme rather than hostname because `dev:local` binds
every interface for iPad testing, so its origin is as often a LAN address as
localhost. Both storefronts are https and Vercel serves them no other way, so
nothing reachable over http can be the live shop.

Nothing in a request body influences that choice, so no crafted payload moves a
caller between accounts, and an origin we do not publish from is refused rather
than guessed. `STRIPE_LIVE_ORIGINS` / `STRIPE_TEST_ORIGINS` (comma-separated)
extend the lists without a deploy.

`STRIPE_MODES` then narrows it per backend: production serves `live` only, so a
sandbox caller reaching it — dev, a preview, a laptop with the wrong `.env` —
gets `400 unknown_origin` rather than a test-mode row in the production
database. The `dev` branch serves `test` only, the mirror of it. Unset means
both, which is what a single-project setup wants.

The webhook has no Origin to sort by — both accounts POST to one URL per project
— so it verifies the signature against each account's secret in turn, and
whichever secret verifies _is_ the account. Mode is a result of authentication
there, never an input to it.

### Done — production is on the live account (2026-08-28)

| Step                                                            | State                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY_LIVE` on `jibgwgosihadbjgxdsfe`              | ✅ set; Stripe accepts it and it returns the live catalogue            |
| `20260828180000_billing_stripe_mode.sql` applied                | ✅ `mode` on both tables, `billing_customers` PK now `(user_id, mode)` |
| `entitling_billing_modes()` narrowed on production              | ✅ returns `{live}`                                                    |
| `stripe-checkout` / `stripe-portal` / `stripe-webhook` deployed | ✅ ACTIVE at v7, `verify_jwt` preserved (webhook `false`)              |

Verified after deploying: the deployed bundles carry `modeForRequest`,
`servedModes`, `resolvePrice`, both price catalogues and the dual webhook
secrets; `stripe-checkout` answers `401` without a JWT; the webhook answers
`400 {"code":"missing_header"}` to an unsigned POST, which is the signal that it
booted and read a secret.

**Not exercised: a signed-in checkout against the live account.** That needs a
real user, and creating one on production was out of scope for the flip. Do it
once from cleffy.io after §0's remaining work — buy Personal, confirm the
Checkout page carries no test-mode banner, and confirm the webhook writes a
`subscriptions` row with `mode = 'live'`.

### What is left

**1. Merge `dev` → `main`** for the frontend — but see the blocker below first.
Until it merges, cleffy.io still ships the old bundle naming sandbox price ids;
checkout re-prices those into live mode, so it sells correctly either way.

**2. Give the `dev` branch project its sandbox secrets.** It has only
`STRIPE_MODES` so far, so billing on dev.cleffy.io fails until the key and the
webhook secret land (§5).

```bash
supabase branches unpause dev --project-ref jibgwgosihadbjgxdsfe
npx supabase secrets set --project-ref qdbnlrgylelelvwbkvnm \
  STRIPE_SECRET_KEY='sk_test_…' STRIPE_WEBHOOK_SECRET='whsec_…' \
  APP_URL='https://dev.cleffy.io'
```

`STRIPE_WEBHOOK_SECRET` here is the **sandbox** endpoint's signing secret
(`we_1U8njJ9EqxUjgZtnfBK3y0XH`), which now posts to this project. `STRIPE_MODES`
is already `test`, the mirror of production's: the branch refuses a cleffy.io
caller, so the two backends cannot serve each other's storefront even if a build
or a DNS entry is wrong.

**3. Create the live Customer portal configuration.** Live dashboard → Settings →
Billing → **Customer portal** → Save. `stripe-portal` 500s for every live caller
until a default configuration exists, exactly as it did in the sandbox (§1).
There is still no API for it.

**4. Rotate `sk_live_…`** if it has been pasted anywhere it should not persist.

### ⛔ Blocker for merging `dev` → `main`

Two migrations `dev` carries have **not** been applied to production, and both
back features in that merge:

| Migration                                  | What breaks without it                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260827150000_student_credentials.sql`   | Student sign-in. `mark_student_claimed()` and the `managed_students` credential columns do not exist on production — verified, not assumed. |
| `20260828120000_free_tier_no_students.sql` | Free-tier roster gating. Production's `tier_limits('free')` still reports `students: 3` while the merged client hides the roster.           |

Apply both before merging, the same way §0 step 2 was applied — SQL editor or
the Management API, not `db push`. The Stripe flip above does not depend on
either; they are the rest of the release.

### Webhook endpoints — already retargeted

| Endpoint                      | Account | Posts to                            |
| ----------------------------- | ------- | ----------------------------------- |
| `we_1U9V8T4eZ6RX0W0glk3BZIOi` | live    | `jibgwgosihadbjgxdsfe` (production) |
| `we_1U8njJ9EqxUjgZtnfBK3y0XH` | sandbox | `qdbnlrgylelelvwbkvnm` (dev branch) |

The sandbox endpoint posted to production until 2026-08-28, from when dev shared
that backend — so a purchase on dev.cleffy.io wrote its subscription row into
production. It now posts to the branch.

One consequence to expect: the branch is paused most of the time and Stripe gives
up after retrying a dead endpoint, so sandbox events raised while it is paused
are dropped. That is the cost of a paused dev backend, and it is the right side
of the trade — a lost test event beats a real one in the wrong database.

### Verifying

```bash
# Live mode: cleffy.io must reach the live account.
curl -sS -X POST https://jibgwgosihadbjgxdsfe.supabase.co/functions/v1/stripe-checkout \
  -H 'Origin: https://cleffy.io' -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' -d '{"priceId":"price_1U9V7M4eZ6RX0W0glzzjnokr"}'
# -> a checkout.stripe.com URL, live mode, no test-mode banner

# An origin we do not publish from buys nothing at all.
curl -sS -X POST … -H 'Origin: https://example.com' …
# -> 400 {"error":"Unrecognised origin","code":"unknown_origin"}
```

Note that a `curl` with no `Origin` header now gets `400 unknown_origin` — the
smoke test in §6 predates this and needs the header added.

The Personal subscription bought in the sandbox on 2026-08-28
(`sub_1U9SxH9EqxUjgZtnJvCo0viW`, in production's database) keeps entitling until
step 3, then stops. Re-buy it on the live account and cancel the sandbox one so
it does not keep renewing in test mode.

---

## 1. Stripe Customer portal (one click, once)

`stripe-portal` returns 500 for every caller until a **default portal
configuration** exists. There is no API for creating one — the Stripe connector
exposes only `GET /v1/billing_portal/configurations`, and that list is currently
empty.

1. Open the **test-mode** dashboard → Settings → Billing → **Customer portal**.
2. Leave the defaults as they are; press **Save**.

Done for the sandbox; the **live** dashboard needs the same single save (§0).

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

| Mode | Secret key                                         | Webhook secret                                             | Stripe account                           |
| ---- | -------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| live | `STRIPE_SECRET_KEY_LIVE`                           | `STRIPE_WEBHOOK_SECRET_LIVE`                               | Cleffy (`acct_1U35FW4eZ6RX0W0g`)         |
| test | `STRIPE_SECRET_KEY_TEST`, else `STRIPE_SECRET_KEY` | `STRIPE_WEBHOOK_SECRET_TEST`, else `STRIPE_WEBHOOK_SECRET` | Cleffy sandbox (`acct_1U35Fc9EqxUjgZtn`) |

- Set them **per project**. The table above is production's; the `dev` branch
  project (`qdbnlrgylelelvwbkvnm`) needs only the sandbox pair, since no
  cleffy.io origin ever reaches it.
- The pre-split names fall through to test mode on purpose: they held the sandbox
  key before there were two accounts, so **adding `STRIPE_SECRET_KEY_LIVE` is by
  itself the whole live flip**. On production the old `STRIPE_SECRET_KEY` then
  serves localhost and nothing else.
- A key is rejected if its own mode infix (`sk_live_` / `sk_test_`, `rk_` too)
  contradicts the variable holding it. That one paste is what charges a real card
  from a test button, so it fails closed instead. A key shape Stripe has not
  shipped yet is passed through — this is a swap check, not an allowlist.
- Webhook secrets: `we_1U8njJ9EqxUjgZtnfBK3y0XH` is the sandbox endpoint,
  `we_1U9V8T4eZ6RX0W0glk3BZIOi` the live one, and both currently post to
  production. A receiver tries each secret it has and the one that verifies names
  the account — see §0 on whether the sandbox endpoint should move to the branch.
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

| Domain          | Assign to                                                |
| --------------- | -------------------------------------------------------- |
| `cleffy.io`     | production (`main`)                                      |
| `www.cleffy.io` | redirect to `cleffy.io` (Vercel offers this when adding) |
| `dev.cleffy.io` | git branch **`dev`**                                     |

Because the nameservers are already Vercel's, the records are created
automatically and certificates issue within a minute or two.

There is no API for this: the Vercel connector exposes domain _purchase_ tools
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
these for the _Preview_ environment is enough to repoint the dev deploy.

```
VITE_SUPABASE_URL       = https://<dev-ref>.supabase.co
VITE_SUPABASE_ANON_KEY  = sb_publishable_…
```

## 5. A separate dev Supabase backend — done

`dev.cleffy.io` runs on its own Supabase project: the persistent branch **`dev`**
(`qdbnlrgylelelvwbkvnm`), a child of `jibgwgosihadbjgxdsfe`.

### It was not actually pointed there until 2026-08-28

This section previously said dev testing no longer wrote production rows. It
did. The repoint was supposed to come from `VITE_SUPABASE_*` overrides in the
Vercel **Preview** environment (§4), and those were never set — every
dev.cleffy.io deploy, up to and including the one built minutes before this was
written, shipped `https://jibgwgosihadbjgxdsfe.supabase.co` in its bundle.
Verify the claim rather than trusting it:

```bash
curl -s https://dev.cleffy.io/ | grep -o '/assets/index-[A-Za-z0-9_-]*\.js'
curl -s "https://dev.cleffy.io/assets/index-<hash>.js" | grep -o 'https://[a-z]\{20\}\.supabase\.co' | sort -u
```

Nothing failed while it was wrong, which is the point: a rule kept in a
dashboard is invisible to review, to CI, and to the repo. So the choice now
lives in the bundle — `supabaseConfig()` in `src/lib/supabase.ts` picks the
project from the hostname, cleffy.io and www.cleffy.io get production and every
other host gets the branch, with `src/lib/supabaseConfig.test.ts` holding it
there. An explicit `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` still wins,
which is what a local `.env` and the local stack set — and what a Vercel
environment variable would set if one is ever added.

The Edge Functions enforce the same rule independently, so it does not rest on
the client being right: production sets `STRIPE_MODES=live`, and its billing
functions refuse a sandbox caller outright (§0).

|                    |                                                         |
| ------------------ | ------------------------------------------------------- |
| Branch project ref | `qdbnlrgylelelvwbkvnm`                                  |
| URL                | `https://qdbnlrgylelelvwbkvnm.supabase.co`              |
| Git branch         | `dev`                                                   |
| Persistent         | yes — not auto-paused, not deleted when a PR closes     |
| Data               | none cloned from production; **not seeded** (see below) |
| Cost               | $0.01344/hr while running (~$9.80/mo), $0 while paused  |

Branch compute is **not covered by the Spend Cap**, so a branch left running
bills silently. Pausing is a deliberate act — see the release loop below.

### Configuration lives in `config.toml`

The branch deploy applies `config.toml` to the branch, so the `[remotes.dev]`
block at the bottom of that file is load-bearing: without it the branch would
inherit `auth.site_url = http://localhost:5173` and every auth redirect on
dev.cleffy.io would land on localhost.

Seeding is **off** for the branch. `seed.sql` creates `teacher@cleffy.local`
and `student@cleffy.local` with the password `cleffy-local-test`, which is
written down in `.cursor/README.md` — fine on a local stack, not on an
internet-facing host. Sign up a real account on dev.cleffy.io instead.

Because the branch is unseeded, the `scores` bucket can no longer come from
`seed.sql`; it is declared in `[storage.buckets.scores]` in `config.toml`, which
creates it on any environment built from that config.

### The release-test loop

The branch is tied to git `dev`, so a push to `dev` triggers a branch deploy.
That deploy's health step waits for branch services, so **a push while the
branch is paused will fail** — cosmetic, but expect it. Unpausing does not
retroactively apply migrations that landed while paused; a deploy has to run
after it is up.

```bash
supabase branches unpause dev --project-ref jibgwgosihadbjgxdsfe   # ~1 min
git push origin dev            # or re-run the deploy from the dashboard
# ...test dev.cleffy.io...
supabase branches pause dev --project-ref jibgwgosihadbjgxdsfe
```

### Edge Function secrets do not inherit

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_URL`, `ANTHROPIC_API_KEY`
and the `OMR_SERVICE_*` pair are set on production and are **not** copied to the
branch. Until they are set, billing / AI / OMR paths on dev.cleffy.io fail:

```bash
supabase secrets set --project-ref qdbnlrgylelelvwbkvnm STRIPE_SECRET_KEY=... APP_URL=https://dev.cleffy.io
```

### GitHub integration

Connected to `maxharris1/sheet_music_scribbler`, working directory `.`, with
**automatic branching off** (otherwise every feature branch spawns its own
billed Supabase branch) and **deploy-to-production off** (see the divergence
section — auto-deploying `main` could re-apply work that is already live).

## 6. Smoke test — passed 2026-08-27

Run end to end against the live stack, not simulated:

| Step                                                  | Result                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Sign up via the public auth API                       | user created, session returned                                                     |
| `stripe-checkout` with a bogus price                  | `400 unknown_price` — the allowlist holds                                          |
| `stripe-checkout` with Teacher monthly                | Checkout session created; Stripe customer carries `metadata.user_id`               |
| `stripe-portal`                                       | returns a portal session URL                                                       |
| Subscription created in Stripe                        | webhook wrote `tier=teacher`, `status=trialing`, correct `price_id` and period end |
| Subscription cancelled                                | webhook wrote `tier=free`, `status=canceled`                                       |
| `get_entitlements` over PostgREST with the user's JWT | `tier=free` with the free ceilings                                                 |
| `stripe_events`                                       | both events recorded — idempotency table working                                   |

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

## Migration history — reconciled 2026-08-27

Production and the `dev` branch were both hard-reset and rebuilt from
`supabase/migrations/`. They now carry the **same 22 migrations** — verified by
identical fingerprints (`md5` over the ordered version list):

|                                     | migrations | tables | users | storage objects | fingerprint |
| ----------------------------------- | ---------- | ------ | ----- | --------------- | ----------- |
| production `jibgwgosihadbjgxdsfe`   | 22         | 22     | 0     | 0               | `4f0bca6b…` |
| `dev` branch `qdbnlrgylelelvwbkvnm` | 22         | 22     | 0     | 0               | `4f0bca6b…` |

The previous divergence (25 applied in production, 4 at versions in no branch, 8
under different timestamps) is gone. `supabase db push` is safe again, and the
GitHub integration's "deploy to production" can be turned on when wanted.

All prior data was intentionally discarded in the reset: 40 users, 46 documents,
1,063 annotations and 47 uploaded PDFs. The Stripe sandbox subscription that
existed was **not** cancelled — it lives in Stripe, and the database row backing
it is gone, so clean it up in the Stripe dashboard if it still matters.

### Resetting a remote database — two traps

`supabase db reset --linked --project-ref <ref>` is the tool, but as of CLI
2.115.0:

1. **It drops tables but not sequences**, so the re-apply dies on
   `relation "annotations_seq" already exists (SQLSTATE 42P07)` — leaving the
   database empty and half-built. Drop the leftovers first, then re-run:

    ```sql
    do $$ declare r record; begin
      for r in select sequencename from pg_sequences where schemaname='public' loop
        execute format('drop sequence if exists public.%I cascade', r.sequencename);
      end loop;
    end $$;
    ```

2. **`supabase storage rm` silently no-ops** — it returns `{"deleted":[]}` and
   removes nothing, for a bucket path or a single explicit object. Use the
   Storage API instead:

    ```bash
    curl -X DELETE "$URL/storage/v1/object/scores" -H "Authorization: Bearer $SERVICE_KEY" \
         -H 'Content-Type: application/json' -d '{"prefixes":["<path>","<path>"]}'
    ```

Note `db reset --linked` **does** clear `auth.users`, but does **not** touch
storage. Pass `--no-seed` against any hosted environment: `seed.sql` creates
accounts whose password is documented in `.cursor/README.md`.

### Why `core_table_grants` exists

On the **local** Docker Postgres image, the default ACL depends on who creates
the object: tables created by `supabase_admin` grant `arwdDxtm` to
anon/authenticated, tables created by `postgres` grant only `Dxtm`. Migrations
run as `postgres`, so every table `schema.sql` created was unreadable and
PostgREST answered `42501 permission denied for table documents` before RLS was
ever consulted.

The hosted images do **not** behave that way — a rebuilt branch shows
`authenticated=arwdDxtm` on every table from the default ACL alone. So
`20260827140000_core_table_grants.sql` is load-bearing locally and a no-op
hosted, which the rebuild confirmed. Keep it: it makes the grant explicit rather
than dependent on which image an environment happens to run, and any new table
should grant explicitly for the same reason.
