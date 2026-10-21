# Launch report — Session D: district seats (item 21)

Scratch branch: not for merging. The deliverable is the draft PR below.

|               |                                                                                                                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR            | https://github.com/maxharris1/Cleffy/pull/61 (draft, `mh/district-seats` → `dev`, no reviewers requested)                                                                                                                         |
| Head SHA      | `a58b78326216d892f9c02f122f6cacac7782a588`                                                                                                                                                                                        |
| Base          | `dev` @ `282b30a`                                                                                                                                                                                                                 |
| Commit author | Max Harris <drumaxter@gmail.com>                                                                                                                                                                                                  |
| CI on head    | **green**: `checks` (lint, typecheck, test, build, prod-dependency audit), `omr-service` and `supabase-drift` all succeeded. Vercel preview is ready; Supabase Preview was skipped (integration setting). Mergeable state: clean. |

## What was done (item 21)

**Admin-only per-org teacher-seat override above the Academy cap of 5, tied to a
Stripe Invoicing (send_invoice) subscription.** This is migration
`supabase/migrations/20261020180400_district_seat_overrides.sql`.

- `studio_seat_overrides`: one row per studio. `seat_limit` must be above 5
  (max 10000). `stripe_subscription_id` has an FK to `subscriptions`. RLS is on
  with no policies, and every client role's privileges are revoked.
- "Admin" means the service role or the SQL editor; the app has no admin role.
  `admin_set_studio_seat_override` and `admin_clear_studio_seat_override` are
  granted to `service_role` only. They also refuse any caller carrying a user
  JWT, and they refuse anything that would make the override a silent no-op:
    - a count ≤ 5, or no actor;
    - a subscription the webhook hasn't recorded, or one belonging to someone
      else;
    - a card-paid subscription, or one that isn't Academy.
- The tie: `studio_effective_seat_limit()` honours the override only while the
  named subscription is the studio owner's own, `send_invoice`, Academy, in an
  entitling Stripe mode, `active`/`trialing` and inside its period. These are
  the same checks `resolve_entitlements` uses.

**`studios_enforce_seat_limit` honours it.** The trigger now reads the effective
limit. It also takes a per-studio advisory lock before counting, so two invites
in flight together can't both take the last seat.

**The Stripe webhook must not reset it.** The override lives in its own table,
which nothing in the webhook writes. A drift test asserts that the webhook
sources never name the override, its log, the admin functions or `seat_limit`.
What the webhook does do:

- It records the new `subscriptions.collection_method`.
  `write_subscription_under_lock` gains a defaulted `p_collection_method`, and
  on conflict it keeps the stored value when a write leaves it out.
- It maps a subscription that is **send_invoice AND marked `cleffy_plan=district`
  in metadata** to Academy. A custom-quote price is in no catalogue, so it would
  otherwise map to free. Checkout can produce neither condition.
- Past due, cancelled or ended → the studio is back on 5, with the override row
  kept. Paid or renewed → the override applies again with no re-set.

**Change log table.** `studio_seat_override_log` is append-only and written by
trigger on every insert, update and delete. That covers the admin functions,
hand-run SQL and the cascade from a deleted studio. It records actor, reason
and old/new values. It has no FK, so the history outlives the studio.

**UI.** The Account → Academy seats panel shows the effective count, read
through the new owner/member-only `studio_seat_limit()`. If that RPC is
missing, it falls back to the row's own limit.

**Docs.** `docs/DISTRICT_SEATS.md` (admin runbook) and a `tests/sql/README.md`
entry.

**Tests added.**

- `tests/sql/district_seats.sql`: 58 checks against real Postgres.
- `tests/billing/districtSeats.test.ts`: the webhook mapping, a
  `handleStripeEvent` run for `send_invoice`, and the migration grant/drift
  guards.
- `src/features/billing/StudioSeats.test.tsx`.

## Local results

| Check                                                                        | Result                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint:check`                                                         | clean                                                                                                                                                                         |
| `npm run typecheck`                                                          | clean                                                                                                                                                                         |
| `npm run test`                                                               | 195 files / 2762 tests passed (see note)                                                                                                                                      |
| `npm run build`                                                              | passed                                                                                                                                                                        |
| `npx prettier --check` (changed files)                                       | clean                                                                                                                                                                         |
| `tests/sql/district_seats.sql` (local Postgres)                              | ALL 58 CHECKS PASSED                                                                                                                                                          |
| `billing_export_claims.sql` / `cross_branch_integration.sql`                 | 35/35, 37/37                                                                                                                                                                  |
| `billing_double_charge.sql`                                                  | 95/98. The 3 failures are table-read grant checks that fail identically on the base without this migration (local-environment difference), so they are not caused by this PR. |
| Local end-to-end harness (real local DB + the webhook's `handleStripeEvent`) | ALL 21 CHECKS PASSED                                                                                                                                                          |

Test-suite note: with the local stack running, `cloud:up` writes a gitignored
`.env.local`. Two unrelated tests (`src/sync/syncEngine.test.ts` backoff and
`tests/auth/turnstileField.test.tsx`) then fail, on the untouched base commit
too. With `.env.local` moved aside, which is how CI runs, the full suite passes.
This is worth a separate look; it is not touched here.

## Stripe test mode

**Not run against Stripe itself.** This container has no Stripe sandbox key:
`supabase/functions/.env` carries none and none is in the environment. Instead,
the local end-to-end harness ran the same `handleStripeEvent` module the Deno
function runs, wired to the local database through the same RPCs
`stripe-webhook/index.ts` makes. Only the Stripe read-back was stubbed, with a
`send_invoice` subscription object. The harness showed:

- `customer.subscription.created` → tier academy, `collection_method`
  send_invoice, owner entitled;
- cap of 5 enforced, then the admin override to 9; the owner cannot call the
  admin function;
- teachers 5–8 seated, and a seated teacher entitled to Academy;
- an `invoice.paid` renewal keeps 9;
- `past_due` → 5 and teachers free, with the override row intact;
- paid → 9 again;
- the log holds only the admin's set.

The real Stripe test-mode check is hosted step 3 below. The local district test
accounts were deleted afterwards; the seeded teacher and student were not
touched.

## ui-check

`scripts/ui/uifuzz.mjs` across all 9 viewports, signed in as a local district
owner with a 9-seat override and 8 seated teachers:

- Every viewport reads "9 of 9 seats used — you hold one as the owner", and
  "Add teacher" is disabled at the limit.
- I looked at the desktop-1440, iPad-portrait and iPhone-SE screenshots; they
  are in `launch-report-district-seats-shots/` on this branch.
- Audit candidates were all outside the seats section: the sticky header over
  buttons scrolled beneath it, small footer links, and the header overlapping a
  scrolled password field on iPad portrait. All of these are pre-existing and
  heuristic.
- No console errors.

## Hosted steps for Max

1. **Order matters:** apply the migration **before** deploying `stripe-webhook`.
   The new webhook passes `p_collection_method`; migration first is safe.
2. Apply `20261020180400_district_seat_overrides.sql` to dev
   (`qdbnlrgylelelvwbkvnm`), then prod (`jibgwgosihadbjgxdsfe`), through the
   usual merge/deploy path. Then deploy `stripe-webhook`. There are no new
   secrets or env vars.
3. **Stripe test-mode check on dev:**
    1. In _Cleffy sandbox_, create a subscription for a test customer with:
        - a custom price on the Academy product;
        - "Email invoice" (`send_invoice`), `days_until_due` 30;
        - metadata `user_id=<dev user id>` and `cleffy_plan=district`.
    2. Confirm the webhook delivery returns 200, the `subscriptions` row has
       `tier='academy'` and `collection_method='send_invoice'`, and
       `get_entitlements(<user id>)` returns academy.
    3. Create the academy in the UI.
    4. Run `admin_set_studio_seat_override` per `docs/DISTRICT_SEATS.md` and see
       the new count on the Account page.
4. For each real district, follow `docs/DISTRICT_SEATS.md`:
    - The owner must not hold another running subscription in the same Stripe
      account; the duplicate-charge guard would cancel the district one.
    - Set both metadata keys.
    - Set `days_until_due` to the contract's net terms.

## Open questions

- **Lapsed district owner on self-serve.** Teachers seated above 5 keep their
  seats when the override lapses (nobody is removed). A lapsed district owner
  who then buys a $49 card Academy keeps them all entitled. The fix would be
  for `resolve_entitlements` to honour only the first N members. It is left
  out to keep the PR to item 21.
- **Districts paying after the due date.** Should `past_due` on a send_invoice
  subscription keep entitlement for a grace period? Currently it is treated
  like a card plan: it drops to free.
- **Merge order.** `scripts/apply-migrations.sql` is generated and all four
  launch PRs touch it, so re-run `npm run migrations:mirror` on later merges.
  `stripeEvents.ts` / `stripe-webhook/index.ts` changed by a few lines and may
  overlap with Session C.

## Skipped and why

- **Real Stripe test-mode run:** no sandbox key in this container. It is
  covered by the local harness above and listed as hosted step 3.
- **The packet's `/workspace/cleffy-launch-compliance-report.md`:** that path is
  outside this repo and this session's reach. This file is the Session D report
  instead, as the session brief asked.
- **Nothing hosted was touched.** No hosted Supabase and no live Stripe; the
  seeded local accounts were left as they were.
