# Deploying Cleffy — cleffy.io (main) and dev.cleffy.io (dev)

`main` builds to **cleffy.io**, `dev` builds to **dev.cleffy.io**, both served by
one Vercel project over two Supabase projects. **The live flip is done:**
cleffy.io sells from the real Stripe account and dev.cleffy.io from the sandbox,
each against its own database.

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
| Stripe Customer portal configuration (live)                            | ✅ `bpc_1U9juu4eZ6RX0W0gPrUkrH6S`, default + active, plan switching on  |
| Edge secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_URL`) | ✅ set on production                                                    |
| Edge secret `STRIPE_WEBHOOK_SECRET_LIVE` (production)                  | ✅ set                                                                  |
| Edge secret `STRIPE_SECRET_KEY_LIVE` (production)                      | ✅ set 2026-08-28                                                       |
| Stripe secrets on the `dev` branch project                             | ✅ key, webhook secret and `APP_URL` set 2026-08-29                     |
| Vercel project, linked to `main`, auto-deploying                       | ✅ created and verified live                                            |
| `dev` branch deploy config (SPA rewrite + Supabase env)                | ✅ pushed, preview verified live                                        |
| cleffy.io / dev.cleffy.io attached, certs issued                       | ✅ live                                                                 |
| Separate dev Supabase backend                                          | ✅ persistent `dev` branch, `qdbnlrgylelelvwbkvnm` (§5)                 |
| dev.cleffy.io actually pointed at that backend                         | ✅ by hostname in the bundle — **was production until 2026-08-28 (§5)** |
| Edge secret `STRIPE_MODES` (both projects)                             | ✅ `live` on production, `test` on the branch                           |
| Sandbox webhook endpoint retargeted to the branch                      | ✅ `we_1U9fnx9EqxUjgZtnXnAvtJH3`; the superseded one is disabled        |
| Billing migration `20260828180000` applied to production               | ✅ applied and recorded                                                 |
| `entitling_billing_modes()` narrowed on production                     | ✅ `{live}`                                                             |
| Stripe functions redeployed mode-aware                                 | ✅ v7 ACTIVE on production                                              |
| Migrations `20260827150000` + `20260828120000` on production           | ✅ applied 2026-08-29 (history drift repaired again 2026-10-08, step 1) |

---

## Release checklist — launch fixes (20261007\*)

One ordered list for the integrated `fix/*` branches (integrity, sharing, sync,
billing, library, security, compliance, scope-imslp) shipping on one `dev` →
`main` merge. Steps are in the order to do them; each says what breaks if it is
skipped or reordered. Reference detail stays in the sections it links to.

**What ships.** Eleven migrations, applied in filename order by the Supabase
GitHub integration on the merge (migrations before functions):

| Migration                                                | Branch      | Order constraint                                                                                                                                                                       |
| -------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261007120000_sharing_access_control`                  | sharing     | Before the bundle: the new Share dialog, member roles, revoke-with-removal and Leave call its RPCs. Old bundles are unaffected (links still default to the role they send).            |
| `20261007120100_column_integrity`                        | integrity   | Any order. Holds only for client roles; service role, definer functions and FK actions pass.                                                                                           |
| `20261007120101_realtime_db_topic`                       | integrity   | Either order is safe but not seamless — step 9.                                                                                                                                        |
| `20261007120200_patch_annotations_batch_returns_ids`     | sync        | Any order: the client treats the old void answer as "applied".                                                                                                                         |
| `20261007120300_billing_correctness`                     | billing     | Any order: the export claim falls back to `consume_pdf_export` until it exists. Backfills `archived_reason` (production holds 0 archived scores) and restores already-entitled owners. |
| `20261007120400_library_pagination`                      | library     | Before the bundle for search / tag / A–Z paging; without it only the plain recent list pages (REST fallback).                                                                          |
| `20261007120401_document_storage_cleanup`                | library     | **Before the bundle**: the new delete removes the row first and purges Storage through these tombstone policies; without them the purge is refused and the bytes are orphaned.         |
| `20261007120500_function_search_path_and_execute_grants` | security    | Any order. Restates `guard_score_analyses_client_write` with the 120100 body (role-keyed) — do not "restore" the 20260803 body, it breaks account deletion.                            |
| `20261007120501_student_login_throttle`                  | security    | **Before** `student-login` / `student-claim` / `student-provision`: the limiter fails closed (§9).                                                                                     |
| `20261007120600_account_deletion`                        | compliance  | **Before** `delete-account`, with the updated `stripe-webhook` (§2, _Account deletion_).                                                                                               |
| `20261007120700_document_provenance`                     | scope-imslp | **Before** `imslp-download` / `imslp-work`: imports fail at the provenance write without it (and are refunded).                                                                        |

Functions changed: `delete-account` (new), `imslp-download`, `imslp-work`,
`imslp-sync`, `stripe-webhook`, `stripe-checkout`, `stripe-portal`,
`student-login`, `student-claim`, `student-provision`, `resend-inbound`,
`analyze-annotations`, and `_shared/` (so redeploy every function that imports
it — the merge deploys all of them).

`stripe-webhook` now applies `customer.subscription.created` / `.updated` from
the subscription as Stripe holds it **now** (`subscriptions.retrieve`), not from
the copy embedded in the event: Stripe does not deliver in order, and a retried
older event (every transient failure here is a 500 that Stripe retries) would
otherwise overwrite a newer state — a late `unpaid` after the customer paid
archived their scores, a late `active` after `unpaid` restored them unpaid.
`.deleted` still applies as `canceled` without a read. One Stripe API call per
subscription event; a failed read is a released claim and a 500, which Stripe
retries.

The smart-import refund ledger that fix/billing first proposed
(`smart_import_charges`, `refund_smart_import`) was dropped in integration and
never applied anywhere: `imslp-download` now creates the score itself and
refunds every failure before it answers, so there is no client rollback left
to refund (comment at the end of `20261007120300`).

### Before the merge

1. **Production is further behind than this release.** Its migration history
   ends at `20260830101624` (checked 2026-10-08): the merge also applies
   `20260830120000` … `20260910160001` (library bootstrap, thumbnails, the IMSLP
   works mirror and its two catalog data files, ~48 MB). Those two catalog
   files are not in `scripts/apply-migrations.sql`; only `db push` / the
   integration applies them. Expect the migration step to take minutes, and
   confirm the Supabase check on the merge commit is green before announcing.
   **Migration-history repairs, 2026-10-08.** Both projects carried history
   rows the repo has no file for, which made `db push` and the integration
   refuse. Only the history rows were removed; no schema changed.
    - Production: `20260918042925_tmp_ledger_cleanup`, a hand-run statement
      whose only effect was to delete other history rows. Newer than every
      pending `dev` migration, it made all ten "out of order".
    - `dev` branch: the five `20260921141103` … `20260921141127`
      `playalong_corpus*` rows, applied by hand from
      `mh/playalong-on-dev-ab47`, which made Supabase Preview fail with
      "Remote migration versions not found in local migrations directory".

    The `playalong_corpus*` tables, the `pd_pdf_store` table and the `pd-pdfs`
    bucket remain on both projects without history rows; no fix here touches
    them, and that branch's migrations guard their creates so they re-apply
    over the existing objects when it merges.

2. **Prove the set on the `dev` branch first.** Push `dev` (unpause the branch
   first, §5), then run, against `qdbnlrgylelelvwbkvnm` only, each rolled-back
   proof: `tests/sql/column_integrity.sql`, `tests/sql/cross_branch_integration.sql`
   and `supabase/sql-tests/sharing_access_control.sql` (how: `tests/sql/README.md`).
   All three must report no failures except the sharing file's realtime checks
   80–82, 85 and 87, which need today's `realtime.messages` partition and fail
   on an idle project. (Run on 2026-10-08 before merge, as one rolled-back
   transaction per file with every 20261007 migration applied first: 113/113,
   37/37 and 89/94 with exactly those five.)
   Then the out-of-order webhook check, in the Stripe sandbox against the dev
   endpoint (Workbench → Events): make any two `customer.subscription.updated`
   events on a test subscription (e.g. turn cancel-at-period-end on, then
   off), then **Resend** the older one. The `subscriptions` row must keep the
   newer state (there: `cancel_at_period_end = false`), and the function log
   must show the resent event applied, not refused and not a 500.
3. **Auth password policy on both projects** — 8+ characters, letters and
   digits, via the Management API (§8). `config.toml` only covers the local
   stack. Existing passwords keep working.
4. **Edge secrets.**
    - `STRIPE_SECRET_KEY_LIVE` must be set on production (it is, since
      2026-08-28): `delete-account` refuses with `503 billing_unavailable` and
      deletes nothing for any live customer it cannot reach (§2), and
      `stripe-webhook` reads every subscription event back from Stripe, so
      without the key each one is a 500 until it is set (Stripe keeps retrying
      for three days; nothing is lost if it is set within that window). The
      dev branch needs its sandbox key the same way (`STRIPE_SECRET_KEY_TEST`,
      or the older `STRIPE_SECRET_KEY`; set 2026-08-29).
    - `LOGIN_THROTTLE_SECRET` (recommended, optional): HMAC key for the
      student-login limiter (§9); unset falls back to the service-role key.
    - Optional: `SENTRY_DSN` (+ `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`) for edge
      error reports (§2, _Error monitoring_).
    - Optional tuning: `IMSLP_DOWNLOAD_GLOBAL_MAX` / `IMSLP_DOWNLOAD_GLOBAL_SPACING_MS`
      (deployment-wide IMSLP pacing, defaults 2 per 1000 ms — SETUP_SUPABASE.md).
5. **Vercel env (build time).** Leave `VITE_FEATURE_PLAYALONG`,
   `VITE_FEATURE_FINGERING` and `VITE_FEATURE_PRINT_HANDWRITING` unset (or `0`):
   play-along and fingering are not part of this release and the pricing copy
   no longer sells them. Optional `VITE_SENTRY_DSN` / `VITE_SENTRY_RELEASE` (§4).
   The `vercel.json` security headers (CSP, HSTS, frame, referrer, permissions)
   ship with the bundle; the CSP already allows both Supabase projects and
   `*.ingest.sentry.io`, `*.ingest.us.sentry.io`, `*.ingest.de.sentry.io`.
6. **Legal.** `/privacy` and `/terms` go live with this merge. Settle every open
   item in `docs/LEGAL_REVIEW.md` (operator entity, hosting region, refunds,
   governing law, processors including Sentry) with counsel first. Two
   statements changed on 2026-10-08 to match the integrated code, flagged for
   counsel in §7 and §15: the Terms now say scores past a smaller plan's limits
   stay read-only "until you upgrade again" (there is no owner unarchive), and
   the Privacy Policy now says sign-out uploads pending changes, warns about
   any it could not upload, then removes the account's markings from the
   device (it used to say unsynced markings were kept).
7. **CI is green**, including the new `npm audit --omit=dev --audit-level=high`
   step (pdf.js 6.4.299 fixes GHSA-hq66-cqwq-w95j).

### The merge

8. Merge `dev` → `main` outside lesson hours. The integration applies the
   migrations, then deploys the functions; Vercel builds the bundle in parallel.
   For the minutes in between:
    - a new bundle against the old `imslp-download` gets 403 on IMSLP imports
      (it no longer creates the row first) — the function must win this race,
      so if the function deploy fails, redeploy it before anything else;
    - old bundles against the new `imslp-download` are still served (they
      create the row themselves), but show a busy queue as an error.
9. **Realtime topic split** (`20261007120101`). Committed annotation rows, PDF
   replacement and play-along status move from `doc:{id}` to the receive-only
   `doc-db:{id}`; presence, live ink and the sharing `membership` event stay on
   `doc:{id}`. _Bundle first_: the new client cannot join `doc-db:{id}` yet;
   after 4 s it pulls every 15 s (and 1.5 s after a peer's stroke) and once more
   when the join succeeds — late, never lost. _Migration first_: tabs on the old
   bundle stop receiving committed rows live; a peer's live preview fades after
   10 s and the mark appears on the next pull (reconnect, `online`, reload).
   Expect open tabs to need one reload.
10. **Clients upgrade their local database** on first load (Dexie v8 removes
    duplicate lesson snapshots, v9 makes one per score-day unique) — nothing to
    do, but a device that cannot open IndexedDB keeps working without it.

### After the merge

11. Supabase check on the merge commit green; `list_migrations` on production
    ends at `20261007120700`; security advisor: no new
    `function_search_path_mutable` / `anon_security_definer_function_executable`.
12. Run the CSP smoke against the production build
    (`npm run build && node scripts/csp-smoke.mjs`; with a Sentry DSN build also
    `CSP_SMOKE_SENTRY=1`) — zero violations, legal pages, Account page, Source
    dialog and both exports included. Then open cleffy.io with the console open:
    no CSP or header errors.
13. Smoke on production with throwaway accounts: share a score, change a
    member's role and watch the other tab follow live, revoke a link with
    removal, leave a score; draw offline and come back online; export a PDF on
    a free account twice (second is refused, nothing built); import from IMSLP
    and open its Source dialog; delete a score and check the library and
    Storage; delete a throwaway account from the Account page (needs the live
    key) and confirm it is gone from Auth, Storage and Stripe.
14. **Leftover Storage of accounts deleted any other way.** `delete-account`
    empties both buckets for every `document_storage_cleanup` tombstone the
    account owns before it deletes the auth user. An account removed from the
    dashboard skips that and leaves tombstones whose owner no longer exists;
    list them with
    `select c.* from public.document_storage_cleanup c left join auth.users u on u.id = c.owner_id where u.id is null`
    and remove `{document_id}/` from the `scores` and `thumbnails` buckets
    (Storage API, service key), then the rows.
15. If monitoring is on: trigger a test error on dev.cleffy.io and confirm it
    arrives in Sentry scrubbed (no emails, tokens or annotation content).
16. **IMSLP Piano chip now covers keyboard works** (qa/polish). Five new
    taxonomy categories — `For keyboard`, `For keyboard (arr)`,
    `For harpsichord`, `For harpsichord (arr)`, `For clavichord` — have no
    `imslp_category_sync` row on either project, so the `imslp-sync` cron
    (every 2 min) walks them next, one per tick, about 10 minutes in all; no
    migration. Until then typed search checks them live, but browsing by
    chip with no query is affected: Piano alone (or with chips whose
    categories aren't walked yet either) shows "IMSLP index is still being
    built for Piano", and Piano with another walked chip (e.g. Baroque) lists
    only the `For piano` side, missing keyboard- and harpsichord-only works.
    Check:
    `select category, state, pages_done from imslp_category_sync where category ~ 'keyboard|harpsichord|clavichord'`
    shows five `ok` rows. Then search "BWV 846" on cleffy.io: "Prelude and
    Fugue in C major, BWV 846" first.

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

**2. ~~Give the `dev` branch project its sandbox secrets.~~ Done 2026-08-29.**
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `APP_URL=https://dev.cleffy.io`
are set on `qdbnlrgylelelvwbkvnm`, alongside the `STRIPE_MODES=test` that was
already there. Verified: the branch webhook answers `400 missing_header` to an
unsigned POST rather than `500 Server misconfigured`, and `stripe-checkout`
answers `401` without a JWT.

`STRIPE_MODES=test` is the mirror of production's: the branch refuses a
cleffy.io caller, so the two backends cannot serve each other's storefront even
if a build or a DNS entry is wrong.

**Loose end — two sandbox webhook endpoints now point at the branch.** The
original (`we_1U8njJ9EqxUjgZtnfBK3y0XH`) only reveals its signing secret at
creation, so a replacement (`we_1U9fnx9EqxUjgZtnXnAvtJH3`) was created to obtain
one. Only the replacement's secret is configured, so the original's deliveries
fail signature verification and Stripe will eventually disable it and email about
it. **Delete `we_1U8njJ9EqxUjgZtnfBK3y0XH`** in the sandbox dashboard. Nothing is
double-processed meanwhile: both deliveries carry the same event id and
`stripe_events` drops the replay.

**3. Create the live Customer portal configuration.** Live dashboard → Settings →
Billing → **Customer portal** → Save. `stripe-portal` 500s for every live caller
until a default configuration exists, exactly as it did in the sandbox (§1).
There is still no API for it.

**4. Rotate `sk_live_…`** if it has been pasted anywhere it should not persist.

### ~~Blocker for merging `dev` → `main`~~ — cleared 2026-08-29

Two migrations `dev` carried were missing from production. Both are now applied,
and `supabase/migrations/` and production's history match exactly — no version in
the repo is missing from `schema_migrations`.

**A trap worth knowing.** These went in through the Supabase MCP's
`apply_migration`, which records the migration under a **fresh timestamp of its
own** rather than the repo filename's version. Left alone that reads as two
unapplied migrations, and the next `db push` would try to re-run them and fail on
a duplicate column. The history rows were renamed to `20260827150000` and
`20260828120000` afterwards to match the repo. Check `schema_migrations` after
any `apply_migration`, not just that the DDL succeeded.

What each one did:

| Migration                                  | What breaks without it                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260827150000_student_credentials.sql`   | Student sign-in. `mark_student_claimed()` and the `managed_students` credential columns do not exist on production — verified, not assumed. |
| `20260828120000_free_tier_no_students.sql` | Free-tier roster gating. Production's `tier_limits('free')` still reports `students: 3` while the merged client hides the roster.           |

Neither touched the Stripe flip; they were the rest of the release.

### Webhook endpoints — already retargeted

| Endpoint                      | Account | Posts to                            |
| ----------------------------- | ------- | ----------------------------------- |
| `we_1U9V8T4eZ6RX0W0glk3BZIOi` | live    | `jibgwgosihadbjgxdsfe` (production) |
| `we_1U9fnx9EqxUjgZtnXnAvtJH3` | sandbox | `qdbnlrgylelelvwbkvnm` (dev branch) |

The sandbox endpoint posted to production until 2026-08-28, from when dev shared
that backend — so a purchase on dev.cleffy.io wrote its subscription row into
production. It now posts to the branch.

The sandbox row is a **replacement**. Stripe reveals a signing secret only at
creation and the original (`we_1U8njJ9EqxUjgZtnfBK3y0XH`) predated this work, so
a new endpoint was created to obtain one. The original is now **disabled** and
labelled `SUPERSEDED` — disabled rather than deleted because no DELETE is exposed
through the connector; remove it from the sandbox dashboard whenever convenient.
While it was enabled nothing was double-processed: both deliveries carried the
same event id and `stripe_events` dropped the replay.

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

## 1. Stripe Customer portal — configured in both modes

`stripe-portal` returns 500 for every caller until a **default portal
configuration** exists for that mode. Both modes now have one; live is
`bpc_1U9juu4eZ6RX0W0gPrUkrH6S` (default, active), verified by creating a real
live portal session against a throwaway customer and then deleting it.

Intended shape, live and sandbox alike:

| Feature                              | Setting                                                              |
| ------------------------------------ | -------------------------------------------------------------------- |
| Cancel subscription                  | on                                                                   |
| Update payment method                | on                                                                   |
| Invoice history                      | on                                                                   |
| Switch plans (`subscription_update`) | on, `default_allowed_updates: ['price']`                             |
| Proration                            | `always_invoice` — charge the difference at the moment of the switch |
| Switchable products                  | Personal, Teacher, Academy — monthly and annual each                 |
| **Excluded**                         | **the $99 Founding Teacher annual price**                            |

`always_invoice` is what makes an upgrade bill correctly mid-cycle: Stripe
credits the unused remainder of the old plan and charges the new one only from
the switch forward, then invoices the net difference immediately. Nobody pays the
upgraded rate for days already elapsed. Its cost is that a failing card surfaces
as a failed invoice during the upgrade rather than quietly on the next cycle.

Two things the UI does not warn about:

- **Founding Teacher is a second annual price on the Teacher product**, so it sits
  next to the $190 one in the product picker. Listing it would let anyone switch
  _into_ a grandfathered launch price and keep it indefinitely.
- **The portal has no direction control.** Listing the products enables downgrades
  as well as upgrades; under `always_invoice` a downgrade yields a credit balance
  against future invoices, not a refund.

### This is dashboard-only — the API cannot do it

There is no create endpoint exposed here, and **`features[subscription_update][products]`
is silently ignored on write and absent on read**, at every API version this
account accepts (2020-08-27 through 2025-03-31.basil were all tried). A write can
therefore turn `subscription_update` _on_ while leaving the product list null —
switching enabled with an unverifiable scope, which is worse than off. Do it in
**Settings → Billing → Customer portal**, in each mode, and treat the dashboard as
the only source of truth for which prices are switchable.

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

### Account deletion — `delete-account`

Self-serve deletion (Account page → Delete account) is a new function,
declared in `supabase/config.toml` with `verify_jwt = true`, so the Supabase
GitHub integration deploys it on the `dev` → `main` merge like every other
function (§5) — no manual `functions deploy`, no second `db push`. The same
merge must carry migration `20261007120600_account_deletion.sql` and the updated
`stripe-webhook`; they ship together on that merge. Without the migration,
deleting someone who drew on another person's score would cascade-delete those
marks from the owner's copy; without the webhook change, a Checkout completed in
another tab during a deletion could keep billing an account that is gone.

It needs no new secret, but it depends on the Stripe ones above:

- **`STRIPE_SECRET_KEY_LIVE` must be set wherever a live `billing_customers`
  row can exist.** Deletion cancels every subscription before it deletes
  anything, and refuses with `503 billing_unavailable` — deleting nothing — for
  any user with a live customer when it cannot reach the live account. That is
  the intended fail-closed behaviour, but it means a missing live key blocks
  every paying customer from deleting their account.
- A missing **test** key is skipped with a log line: sandbox subscriptions never
  charge a card, so they are no reason to keep someone's data.
- It also uses `SUPABASE_URL`, `SUPABASE_ANON_KEY` (to re-check the password)
  and `SUPABASE_SERVICE_ROLE_KEY`, which every project has already.

What it deletes and in which order is documented at the top of
`supabase/functions/_shared/accountDeletion.ts` — including the
`document_storage_cleanup` tombstones (`20261007120401`): before the auth user
goes, it empties both buckets' `{document_id}/` folders for every tombstone the
account owns (its own score deletes, and library deletes whose Storage purge
never finished) and drops the rows, failing the request if it cannot.

### Error monitoring — optional

All of it is off until a DSN is set, and costs nothing while off.

| Where                   | Variable              | What it does                                                                                                                       |
| ----------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Edge Function secret    | `SENTRY_DSN`          | Also post every `logError` record (`_shared/errorLog.ts`) to Sentry. Unset: the JSON line in the function logs is the only record. |
| Edge Function secret    | `SENTRY_ENVIRONMENT`  | Optional. Defaults from the project ref: `production` for `jibgwgosihadbjgxdsfe`, `development` for `qdbnlrgylelelvwbkvnm`.        |
| Edge Function secret    | `SENTRY_RELEASE`      | Optional release tag for edge events.                                                                                              |
| Vercel env (build time) | `VITE_SENTRY_DSN`     | DSN of a Sentry **browser** project. Unset: the SDK is not even emitted into the bundle. Environment comes from the hostname.      |
| Vercel env (build time) | `VITE_SENTRY_RELEASE` | Optional. Defaults to `cleffy@<VERCEL_GIT_COMMIT_SHA>`; set it only to match a release that source maps were uploaded under.       |

```bash
npx supabase secrets set --project-ref jibgwgosihadbjgxdsfe SENTRY_DSN='https://<key>@<org>.ingest.sentry.io/<project>'
```

- Use one Sentry project for the browser and one for the functions, or one for
  both; the environment tag keeps production and dev apart either way.
- Both sides scrub before sending: no annotation contents, no emails, no tokens,
  no URL query strings (`src/lib/monitoring/scrub.ts`, `_shared/errorLog.ts`).
  Keep it that way — the privacy policy promises it.
- `vercel.json`'s Content-Security-Policy already allows the ingest hosts
  (`https://*.ingest.sentry.io`, `*.ingest.us.sentry.io`, `*.ingest.de.sentry.io`);
  a DSN on any other host needs adding to `connect-src`, or browser reports are
  silently blocked (`tests/security/securityHeaders.test.ts` pins these).
- `VITE_SENTRY_DSN` is read at build time: redeploy after setting it.
- Sentry is a new processor of personal data (account ids, IP addresses at
  ingest); `docs/LEGAL_REVIEW.md` lists it.

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

**The redirect runs the other way in practice.** `https://cleffy.io/` answers
`308` to `https://www.cleffy.io/`, so **www is the canonical production origin**,
not the apex. Both are in the live-origin list in
`supabase/functions/_shared/stripeMode.ts` and in `PRODUCTION_HOSTS` in
`src/lib/supabase.ts`, so billing and the backend choice are correct either way —
but anything that assumes the apex is what a buyer's browser sends is wrong.

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

Optional on either environment: `VITE_SENTRY_DSN` (and `VITE_SENTRY_RELEASE`)
to turn on browser error monitoring — see §2, _Error monitoring_.

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

GitHub App `supabase` is installed on **`maxharris1/Cleffy`** (working
directory `.`). The dashboard still used the pre-rename repo name in older
notes; the App follows the repo id, and checks/`supabase[bot]` comments land
on Cleffy.

**Deploy to production is ON.** Verified 2026-09-10 via
`GET /v1/projects/jibgwgosihadbjgxdsfe/branches`: the default branch
(`is_default`, project `jibgwgosihadbjgxdsfe`) has `git_branch: "main"`. That
field _is_ the dashboard **Deploy to production** switch (empty string = off).
There is no public Management API field named `deploy_to_production`; the
Studio form PATCHes `/v1/branches/{id}` with `git_branch`. Do not also add a
GitHub Action `db push` — two appliers would fight.

On merge to `main` the integration applies: pending SQL migrations, Edge
Functions declared in `config.toml` (including `imslp-sync` with
`verify_jwt = false`), and storage buckets from `config.toml`. Auth/API/seed
are ignored.

**Gate:** open a PR `dev` → `main`, approve it, merge with a **merge commit**
(not squash). That merge is the full deploy: Vercel already auto-deploys
`main` → cleffy.io; Supabase applies backend on the same merge. Do not merge
that PR until you intend to ship production.

The October launch-fix release has its own ordered checklist — see
[Release checklist](#release-checklist--launch-fixes-20261007) above.

**Automatic branching must stay OFF** (`new_branch_per_pr`). Confirm at
[Project Settings → Integrations](https://supabase.com/dashboard/project/jibgwgosihadbjgxdsfe/settings/integrations)
— toggle **Automatic branching**. The public API can _list_ GitHub connections
(`GET /v2/organizations/{slug}/integrations/github/connections`) but cannot
update them; Studio uses `/platform/integrations/github/connections/{id}`.
PR #32 spawned preview `cwxkhoqeqbhgakfafthd` (deleted after merge). If that
toggle is on, turn it off so feature branches do not bill.

**Still human:**

1. **Automatic branching** — confirm OFF on the Integrations page (above).
2. **Require a PR into `main`** — this sandbox cannot write rulesets
   (`403 Resource not accessible by integration`). From a PAT with
   `administration:write`:
   `GH_TOKEN=ghp_… bash scripts/protect-main.sh --require-pr --require-ci`
3. Vault `imslp_sync_url` / `imslp_sync_secret` are **not** created by GitHub.
   Chip browse works without them; cron refresh is a silent no-op until they
   exist (see SETUP_SUPABASE.md).

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

## 7. Inbound support mail (Resend) — live

`support@cleffy.io` is meant to reach a human and, later, feed agentic triage.
Resend can receive on a custom domain, but **it cannot forward** — its own
[forwarding guide](https://resend.com/docs/knowledge-base/forward-emails-with-resend-inbound)
is webhook-plus-code, because the `email.received` webhook carries metadata only
and the body must be fetched from the Received Emails API. So forwarding is ours
to write, which is fine: the same endpoint is the triage entry point later.

Live as of 2026-08-29 and proven end to end: an email to `support@cleffy.io` is
received by Resend, signed with Svix, verified here, stored in
`support_messages` with its body, and forwarded to the mailbox in
`SUPPORT_FORWARD_TO`. Verified by sending a real message through it and reading
the resulting row (`has_body: true, forwarded: true, forward_error: null`); the
test rows were then deleted.

What exists:

| Piece                                 | What it does                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_shared/svixSignature.ts`            | Svix HMAC verification, import-free like `stripeSignature.ts` so vitest and Deno load the same file. Resend signs with Svix: `svix-id` / `svix-timestamp` / `svix-signature`, signed content `id.timestamp.body`, base64 digests, and the secret is the **base64-decoded** body of `whsec_…` — not its ASCII. |
| `resend-inbound/index.ts`             | Verifies, claims by `resend_email_id`, fetches the body, stores, then forwards. `verify_jwt = false`, like `stripe-webhook`.                                                                                                                                                                                  |
| `20260829130000_support_messages.sql` | The durable record. RLS on with no policy and every grant revoked — support mail is stranger-written and never belongs in a browser.                                                                                                                                                                          |
| `tests/support/svixSignature.test.ts` | 18 cases: round-trip, rotation, replay window, tampered body, wrong secret, wrong id.                                                                                                                                                                                                                         |

Order inside the handler is deliberate: **persist, then forward.** A forward that
fails leaves `forwarded_at` null — visible and replayable. Forwarding first and
failing to store would lose the message on the retry that then no-ops.

### ⚠️ Never call `POST /domains/{id}/verify` on a working domain

This cost a live outage on 2026-08-29. Enabling receiving adds a required MX
record, which moves the domain to `pending`; calling `/verify` then reset
**DKIM and SPF to pending as well**, and those had been verified for months.
Resend refuses to send from a domain that is not `verified`, so:

```
The cleffy.io domain is not verified.
```

**Supabase Auth sends through `smtp.resend.com` as `noreply@cleffy.io`** — check
`GET /v1/projects/{ref}/config/auth` before touching this domain. Password resets
and student email invites stop working while it is pending. Signups survive only
because `mailer_autoconfirm` is on.

Every DNS record was verified byte-for-byte against Resend's expected values
throughout; nothing in DNS was wrong, and no pre-existing record was altered.
Recovery is Resend's async re-check, which the dashboard's **Verify DNS Records**
button drives harder than the API does. Receiving was rolled back to `disabled`
to return the required set to its original three records.

The apex `MX inbound-smtp.us-east-1.amazonaws.com` (priority 10) is still in
Vercel DNS and inert while receiving is off. Re-enabling receiving is what makes
it live — and note Resend requires it to be the **lowest-priority** MX on the
domain.

### Two API traps this cost, both worth remembering

**The receive endpoint is `GET /emails/receiving/{id}`, not `/emails/received/{id}`.**
The wrong spelling returns `405`, not `404`, so it reads like a method problem
rather than a wrong path. With no body fetched, the forward then fails
`422 Missing \`html\` or \`text\` field` — a message that blames the send when the
fault is upstream. The handler now records the fetch failure on the row and
refuses to attempt a bodyless forward, so the row names the real cause.

**`support_email` cannot be set through the Stripe API.** `POST /v1/accounts/{id}`
answers _"You cannot use this method on your own account: you may only use it on
connected accounts."_ It is a dashboard field, like the portal configuration —
live dashboard → Settings → Business → Public business information.

### State

| Piece                     | Where                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| Resend domain `cleffy.io` | verified, sending **and** receiving enabled                                               |
| Inbound MX (apex)         | `inbound-smtp.us-east-1.amazonaws.com` priority 10, in Vercel DNS                         |
| Webhook                   | `ea73d8be-19ec-45f9-9cd8-ebf4a2ff681f` → `/functions/v1/resend-inbound`, `email.received` |
| Edge secrets              | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SUPPORT_FORWARD_TO`, `SUPPORT_FORWARD_FROM`   |
| `resend-inbound`          | ACTIVE on production, `verify_jwt = false`                                                |
| `support_messages`        | applied to production and the `dev` branch                                                |

The signature gate was checked against the deployed endpoint, not only in tests:
unsigned → `missing_header`, forged → `signature_mismatch`, stale timestamp →
`timestamp_out_of_tolerance`, and no row was written by any of them.

## 8. Auth password policy — must be set on both projects

Every new password is checked in the browser (and in `student-claim`) against
`supabase/functions/_shared/passwordPolicy.ts`: at least 8 characters, at least
one ASCII letter and one digit, at most 72 bytes. GoTrue is the authority, and
`config.toml` only configures the local stack (and the `dev` branch, if its
deploy applies config). Set the hosted projects explicitly, production AND the
`dev` branch, with a Management API token:

```bash
for ref in jibgwgosihadbjgxdsfe qdbnlrgylelelvwbkvnm; do
  curl -sS -X PATCH "https://api.supabase.com/v1/projects/$ref/config/auth" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"password_min_length": 8, "password_required_characters": "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789"}'
done
```

`password_required_characters` takes the character SETS, colon-separated: the
string above is the API's enum value for "letters and digits" (one set of
letters, one of digits) — the same value the CLI writes for
`password_requirements = "letters_digits"`. Check it with a `GET` on the same
path before and after; the dashboard (Authentication → Policies → Password
strength) shows it as "Letters and digits". Existing accounts keep working:
GoTrue checks strength only where a password is set, never at sign-in, and the
app does the same.

Leaked-password protection (`"password_hibp_enabled": true` in the same
payload) is flagged by the security advisor on both projects. It needs a paid
plan; when it is on, a breached password is refused with
`weak_password`/`reasons: ["pwned"]`, which `mapAuthError` already words.

## 9. Student sign-in limiter — migration BEFORE the functions

`student-login` now limits attempts per username
(`supabase/functions/_shared/loginThrottle.ts`) through the
`begin_login_attempt` / `clear_login_attempts` / `clear_login_account` RPCs
created by `20261007120501_student_login_throttle.sql`. Two limits:

- **Per username + address**: 5 tries, then locks of 30 s doubling to 15 min
  for that address only. Someone hammering a classmate's username locks out
  their own address, not the classmate signing in from elsewhere.
- **Per username, all addresses**: 30 attempts per hour, to cap guessing from
  many addresses. No real student gets near it.

The limiter fails CLOSED: if the RPCs are missing, every username sign-in is
refused with "Too many sign-in attempts". So on each project, apply the
migration first, then deploy all three functions that use it
(`student-provision` and `student-claim` clear a username's limits on a
teacher's reset and on a successful claim):

```bash
supabase functions deploy student-login --no-verify-jwt
supabase functions deploy student-claim --no-verify-jwt
supabase functions deploy student-provision
```

Keys are HMAC-SHA-256 of the username (and of the client address) under
`LOGIN_THROTTLE_SECRET` if that function secret is set, otherwise under the
service-role key, so the table holds neither names nor addresses. A dedicated
secret is optional and recommended
(`supabase secrets set LOGIN_THROTTLE_SECRET=$(openssl rand -hex 32)`); setting
or rotating it, or rotating the service-role key while it is unset, simply
resets all counters.

A student locked out at the account ceiling waits for the hour to end, or the
teacher issues a fresh setup card ('reset'), which clears every limit on that
username; claiming the card clears them again for the name the student picks.
Because the keys are HMAC'd, a lock cannot be lifted by hand from the table
without the secret; use the reset.

## Migration history — reconciled 2026-08-27

Production and the `dev` branch were both hard-reset and rebuilt from
`supabase/migrations/`. They now carry the **same 22 migrations** — verified by
identical fingerprints (`md5` over the ordered version list):

|                                     | migrations | tables | users | storage objects | fingerprint |
| ----------------------------------- | ---------- | ------ | ----- | --------------- | ----------- |
| production `jibgwgosihadbjgxdsfe`   | 22         | 22     | 0     | 0               | `4f0bca6b…` |
| `dev` branch `qdbnlrgylelelvwbkvnm` | 22         | 22     | 0     | 0               | `4f0bca6b…` |

The previous divergence (25 applied in production, 4 at versions in no branch, 8
under different timestamps) is gone. Deploy-to-production is on (§5); apply
production by merging `dev` → `main`, not a second `db push`.

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
