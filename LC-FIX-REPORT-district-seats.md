# LC fix pass: Session D, PR #61 (district seats)

- **PR:** https://github.com/maxharris1/Cleffy/pull/61 (draft, into `dev`; still draft, no new PR)
- **Branch:** `mh/district-seats`, fast-forwarded only: `a58b783` → **`4dd6f4ae6764e1df8b46a1213dec9106b0dc6cf9`**
- **Cloud environment:** Cleffy (`env_01WAd3yiz3qpSnsofpyEwCh2`). Checked with `get_session` / `list_environments`; this is not Sandbox.
- **Base:** `dev` @ `282b30a` (unchanged since the Codex review).
- **Nothing touched outside this branch** apart from this report branch. No hosted Supabase, no Stripe, no `.env` files committed, and only throwaway local accounts.

## Commits on `mh/district-seats`

| Commit    | What                                                                                                                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `210387e` | D1 + D2 + D3 backend: migration `20261020180500_district_seat_cap_and_grace.sql`, webhook tier mapping, TS entitlement spec, SQL proof, unit and drift tests, regenerated `scripts/apply-migrations.sql` |
| `a537c1e` | D1 client: owner's read-only seat list and pick, read-only teacher's Account copy (ui-checked)                                                                                                           |
| `8dfb452` | Codex #61 minor 1: invoice-created district links its billing customer (portal 404)                                                                                                                      |
| `c8a34bb` | Runbook `docs/DISTRICT_SEATS.md`: read-only seats, grace, Stripe reminders, contract end                                                                                                                 |
| `4dd6f4a` | `district_billing` declared with `create table if not exists`, matching #64's identical declaration, so either order applies cleanly                                                                     |

D1–D3 share one migration on purpose. Grace (D3) changes what "live" means for the cap (D1), and the cap's reconcile is what the grace expiry and contract writes (D2) trigger. Splitting them would have meant redefining `resolve_entitlements` three times in three files.

## Findings → commit → test

### Codex #61 major 1 / packet D1: `resolve_entitlements()` enforces the cap — `210387e`, `a537c1e`

- A seat entitles only if it ranks inside the studio's effective limit. `studio_seat_is_active()` puts the owner's kept seats first, then the oldest (`studio_members.created_at`), then the id. The owner holds seat 1, so limit − 1 members are active.
- A seat past the limit is **read-only**. `resolve_entitlements` returns tier `free`, source `studio_member`, `seat_read_only: true` and `tier_limits('student')`, which is zero on everything created (scores, imports, analyses, vision, students) and unlimited on export. Their scores are archived as `plan_lapse` by `reconcile_studio_seats()`. Existing annotation RLS (`document_is_archived`) already refuses writes on those, and view and export keep working. **Nothing is deleted.** Invites are refused while over the limit (the existing seat trigger).
- The owner picks with `studio_set_active_seats(studio, members[])`, which refuses more than limit − 1 and refuses non-members. `studio_seat_status(studio)` reads the result. Both are owner-checked.
- Restoring payment, or the override returning, makes every seat active again, and the reconcile restores every score.
- Reconcile runs on override set/change/clear, subscription writes (trigger), the owner's pick, and member removal (a removed read-only teacher becomes ordinary free and gets scores back up to the free cap). An hourly `district-seat-reconcile` cron covers clock-only changes. Entitlements are derived on every read, so only the archive can lag, by at most an hour.
- **Tests:**
    - `tests/sql/district_seat_cap.sql` (74 checks): override lowered 10 → 6, the owner's pick, too many or non-member picks, member and non-owner refused, cleared → 5, re-set → all restored, past grace → read-only, card-Academy switch (the Codex scenario), the release on removal, no deletes, the upload, un-archive and invite refusals, export still unlimited, view still allowed, and the two seat functions agree.
    - `tests/billing/districtSeatCap.test.ts`: the TS spec, plus drift guards on the migration.
    - `src/features/billing/StudioSeats.test.tsx`: read-only badges, the tick limit, the save payload, the lapsed owner, and the read-only teacher copy.

### Packet D2: `contract_ends_at timestamptz null` — `210387e`

- New `public.district_billing` (one row per studio): `stripe_subscription_id`, `contract_ends_at` (null means never auto-purge), `contract_ends_source` (`admin`/`stripe`), and `grace_extended_until`. RLS is on with no policies. Service role only. Every change goes to `district_billing_log` with the actor.
- It's a separate table, not a column on `studio_seat_overrides`, so clearing an override at contract end does not take the purge anchor with it.
- **Auto-set from Stripe** (trigger on `subscriptions`, send_invoice only):
    - the scheduled cancel date while `cancel_at_period_end`;
    - the day it ended on `canceled`/`incomplete_expired`, never moved later by a redelivery;
    - null again on resume.
    - An unrelated card subscription never touches it.
- **Admin-settable:** `admin_set_district_contract_end(studio, date|null, actor, reason, p_automatic)`. A date pins it, null pins "never", and `p_automatic` hands it back to Stripe.
- **Session A** (PR #64 retention purge) confirmed it declares the identical `district_billing` in `20261021120700_district_retention.sql` (`create table if not exists`, purge re-reads `contract_ends_at` under `FOR UPDATE SKIP LOCKED`). `4dd6f4a` makes this side idempotent too.
- Session A was sent the exact schema by `send_message`: the table, columns, the purge predicate `contract_ends_at < now() - interval '30 days'`, and a note to re-read the row inside the delete.
- **Tests:** the contract-end section of `tests/sql/district_seat_cap.sql`, and the drift guards in `districtSeatCap.test.ts`.

### Packet D3: past-due invoices, 30-day grace — `210387e`, `c8a34bb`

- `subscriptions.past_due_since` is stamped by trigger on the first `past_due`/`unpaid` write and kept through `past_due` → `unpaid`. Stripe flips an invoiced subscription to past due at the due date, so this stands in for the due date. A late webhook only lengthens the grace, never shortens it.
- `subscription_is_live()` is the one shared predicate: `active`/`trialing` in period, or `send_invoice` + `past_due`/`unpaid` + `now() < greatest(past_due_since + 30 days, grace_extended_until)`. It's used by `resolve_entitlements` (owner and seats) and `studio_effective_seat_limit` (override).
- The webhook now stores the plan's tier on `send_invoice` rows in `past_due`/`unpaid`; it used to store `free`. Card subscriptions are unchanged and get no grace.
- After grace, the D1 rules apply.
- The admin per-org extension is `admin_extend_district_grace(studio, until|null, actor, reason)`, which reconciles seats at once.
- **Stripe Invoicing reminders** (due, +7, +21) are a Stripe account setting with no API. The Dashboard steps, and the warning not to let Stripe cancel inside the grace period, are in `docs/DISTRICT_SEATS.md`.
- **Tests:**
    - `tests/sql/district_seat_cap.sql`: day 29 full, day 31 lapsed (clock-only, then the cron sweep), an `unpaid` redelivery that doesn't restart the clock, extension and withdrawal, payment restores all and clears `past_due_since`, and a card past-due gets no grace.
    - `tests/billing/districtSeatCap.test.ts` and `tests/billing/districtSeats.test.ts`: the webhook keeps Academy for past-due/unpaid `send_invoice`, `free` for card and ended, and the 30-day constant is drift-guarded against the SQL.

### Codex #61 minor 1: invoice-only district never links its billing customer — `8dfb452`

When a district subscription is written, its customer is linked to the owner if that customer is unmapped. This replaces the owner's older mapping in that Stripe mode, which is the right portal account. A customer already linked to another user is never moved; the webhook logs it instead.

**Tests** (`tests/billing/districtSeats.test.ts`): portal lookup after `customer.subscription.created`, the replaced mapping, the refusal, and a non-district no-op.

## Local results (final head `4dd6f4a`)

- `npm run lint:check`: clean.
- `npm run typecheck`: clean.
- `npm run test`: **196 files / 2804 tests pass.**
    - Run with the local stack's generated `.env.local` moved aside, as CI has none.
    - With it present, `src/sync/syncEngine.test.ts` (backoff) and `tests/auth/turnstileField.test.tsx` fail identically on the untouched `a58b783`. That's an environment artifact, not this change.
- `npm run build`: clean.
- `npx prettier --check`: clean on every changed TS/TSX/MD file. Prettier has no SQL parser here, and the repo's SQL isn't prettier-formatted.
- **SQL proofs**, against local Supabase with the new migration in one rolled-back transaction each:

| Proof                           | Checks | Result     |
| ------------------------------- | ------ | ---------- |
| `district_seat_cap.sql` (new)   | 74     | ALL PASSED |
| `district_seats.sql`            | 58     | ALL PASSED |
| `column_integrity.sql`          | 113    | ALL PASSED |
| `cross_branch_integration.sql`  | 37     | ALL PASSED |
| `billing_export_claims.sql`     | 35     | ALL PASSED |
| `annotation_payload_shape.sql`  | 57     | ALL PASSED |
| `student_access_revocation.sql` | 44     | ALL PASSED |
| `archived_student_password.sql` | 13     | ALL PASSED |
| `qa3_cross_branch.sql`          | 12     | ALL PASSED |
| `edge_rate_limit_refund.sql`    | 10     | ALL PASSED |
| `guest_email_verification.sql`  | 53     | 0 failures |
| `share_link_errors.sql`         | 26     | 0 failures |
| `billing_double_charge.sql`     | 98     | 3 failed   |

The 3 `billing_double_charge.sql` failures ("or read the attempts table", "write locks table", "refund ledger") are identical without this migration. They're a pre-existing local-stack grant difference, already noted in the original #61 report.

## CI on the new head

**Green on `4dd6f4a`.** Every job passed in both runs, push [39625539098](https://github.com/maxharris1/Cleffy/actions/runs/39625539098) and pull_request [39625545692](https://github.com/maxharris1/Cleffy/actions/runs/39625545692):

- `checks` (audit, lint, typecheck, test, build)
- `omr-service`
- `supabase-drift`

CI was also green on every intermediate head (`210387e`, `a537c1e`, `8dfb452`, `c8a34bb`). The Vercel preview deployed. PR #61 is still a draft into `dev`, and the base is unchanged.

## ui-check

On the local stack, I added throwaway `@cleffy.local` accounts: a district owner on a `send_invoice` Academy with an override of 10, and 7 teachers, with the override then cleared so teachers 5–7 were read-only. I checked all nine viewports (desktop-1440, laptop-1280, iPad landscape/portrait/mini, iPhone 14/SE, android-small, iPhone landscape):

- **Owner, Account → Academy seats:** "8 of 5 seats used", the read-only explanation, Read-only badges, a tick list and "Save active seats".
    - Unticking teacher1 and ticking teacher5 and saving round-tripped. The server ranked teacher1 read-only, archived their score, and restored teacher5's.
    - The tick list blocks a 5th tick ("5 of 4 ticked", save disabled), and tapping the address toggles the box.
- **Read-only teacher:** the Account page shows the amber read-only explanation and "read-only academy seat" next to the plan badge. The library shows the existing "cannot add cloud scores" banner, and the score is still listed.
- **One defect, fixed before commit:** the Read-only badge wrapped onto two lines at android-small; it's now `whitespace-nowrap`.
- **Remaining audit hits are pre-existing:** footer links under 44px, and buttons scrolled beneath the sticky header at capture time. There is no horizontal overflow.
- **Rule 6 is respected:** no new toolbar controls, and no teacher/student layers; the UI is on the Account page only.

## Skipped minors, with reasons

- **"Required Stripe test-mode verification remains unmet"** (Codex #61 acceptance gap). Hard rule 3 forbids touching live Stripe, and this container has no Stripe sandbox key. The real test-mode run is still Max's hosted step 3 in the PR body, now extended in `docs/DISTRICT_SEATS.md` (reminder settings, grace).
- **"Cross-PR: reconcile webhook edits with #62."** This isn't mine to resolve: it's merge-time, after #62 lands. This pass touches `stripeEvents.ts` in `subscriptionRowFrom` (the tier for past-due invoices) and `applySubscription` (one call). Expect a small textual merge against #62's webhook work.
- **PR #61 body.** I didn't rewrite it, since the packet asks for this report instead. Its "Open questions" about lapsed-district seats and the past-due grace are now answered by this pass (see above).

## Open questions for Max

1. **Read-only = tier `free` with zero creation limits.** A read-only teacher sees the Free badge plus "read-only academy seat", and can still buy their own plan, which takes precedence and restores everything at once. Is that the upgrade path you want shown to them?
2. **Past-grace kept seats.** After the 30-day grace, the override lapses and the seats past 5 go read-only. But the district's subscription itself is no longer live, so the owner and the 4 kept teachers resolve to **free** (editable, free caps). They are not on Academy. I read "the owner picks which 5 stay active" as "not read-only", not "keep paid Academy while unpaid". If you meant the 5 keep Academy until Stripe cancels, it's a one-line change in `subscription_is_live`.
3. **Grace anchor.** It's the first past-due write (`past_due_since`), not the invoice's `due_date`. Stripe flips an invoiced subscription to past due at the due date, so they agree to within webhook latency, and any error favours the district. Reading `latest_invoice.due_date` would need an expanded Stripe read in the webhook.
4. **Stripe "after due date" action.** It must not cancel inside 30 days plus any extension, or the grace ends early, because cancelled is not live. The runbook says so; please set it when configuring reminders.
5. **A read-only seat in a studio that stopped paying entirely** stays read-only until the owner removes the teacher, or the teacher buys their own plan. There's no member "leave academy" action today. Should there be one?
6. **Lapsed-owner panel.** A free account that owns a studio now sees its Academy seats panel (no add form) so the owner can pick seats after a lapse. Before, a non-Academy owner saw nothing.

## Cross-PR notes

- **Migration order:** `20261020180500` sorts after `20261020180400` and before #64's `20261021*`, so #64's purge can reference `district_billing`. The union now has **eight** timestamps (Codex listed seven).
- **Shared test file:** this PR adds a third cron job (`district-seat-reconcile`) to the pinned map in `tests/migrationRecoverability.test.ts`. If #64 schedules its retention cron there too, merging is a union of the two entries.
- **Generated mirror:** `scripts/apply-migrations.sql` was regenerated with `npm run migrations:mirror` from this branch's migrations. Per decision 6, re-run it after each merge; never hand-merge it.
- **Local stack:** I stopped it with `npm run cloud:down` when finished.
