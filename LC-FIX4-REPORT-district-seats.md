# LC fix pass round 4: PR #61 (mh/district-seats)

- PR: https://github.com/maxharris1/Cleffy/pull/61 (still a draft into `dev`; no reviewers requested; no new PR)
- Start head: `f91b6c85ed9a423c1c076a71831c7c4a4259496c` (confirmed after `git checkout -B mh/district-seats origin/mh/district-seats`)
- **New head: `c8a10570` (`c8a1057`)**, fast-forward pushes only, no force
- Environment: **Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2`** (confirmed with `get_session`), not Sandbox. Local Supabase stack only (`npm run cloud:up`). I did not touch hosted Supabase, live Stripe, PR #54, `main` or `dev`, or the #62/#63/#64 branches (I only read them). I printed no keys and messaged no other sessions.
- Commit identity: Max Harris <drumaxter@gmail.com>

## Commits

| SHA       | Summary                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------- |
| `5a9feef` | District paying status: one status set for card and invoice Academy billing (Decisions 21, 25) |
| `1d2e229` | District contract end: never earlier than when Cleffy learned of it (Decision 22)              |
| `c8a1057` | Read-only seats: live ink stops at the grace deadline itself (Decision 26)                     |

## Fix 1: paying status (Decisions 21 and 25; Codex new major 1 and the D21 partial). Commit `5a9feef`

New migration `supabase/migrations/20261020180900_district_paying_status.sql`:

- `subscription_is_live()` (`:80`, branch at `:86`) is the one predicate shared by entitlements, the seat limit, `district_billing_rederive`'s `v_paying` (CAP:668) and the billing-record link. A subscription counts as paying if it is `active`/`trialing` inside its period, or `past_due` within 30 days of `past_due_since` (or until an admin's later extension), for Academy billed by card or by Stripe Invoicing (and, as before, any `send_invoice` plan). `unpaid`, `canceled` and `incomplete_expired` never count, inside 30 days or not. This replaces CAP:230/:236. CAP:668 needed no textual change because it calls this predicate.
- `district_grace_ends_at()` (`:47`): the admin's per-district extension now also applies to the owner's card-paid Academy. `admin_extend_district_grace()` (`:145`) accepts a card-paid district and re-derives the contract end.
- `reconcile_district_seats()` (`:107`): the hourly sweep now re-derives **every** district's contract end, not only past admin pins. When grace runs out on the clock alone, the normal lapse rules apply: seats above 5 go read-only from the clock (resolve_entitlements), nothing is deleted, and the Stripe end comes back without waiting for a webhook.
- `supabase/functions/_shared/stripeEvents.ts:47` (`keepsTierWhilePastDue`) and `:541` (the tier line, formerly :540): a card-paid Academy that is `past_due` keeps tier `academy`. `unpaid` is recorded as `free`. A card Personal or Teacher plan that is past due is still `free`, as before. `supabase/functions/_shared/entitlements.ts:337` (`isInPastDueGrace`) mirrors the predicate.
- Tests: `tests/sql/district_seat_cap.sql:1156` ff. covers card-paid past_due within grace: owner stays Academy, no contract end, so no purge; a past admin pin is cleared and logged; the per-district extension reaches the card subscription. It also covers past grace (not paying; the sweep brings the Stripe end back; purgeable), card `unpaid` (not paying) and card `trialing` (paying). The same set runs for invoice (`send_invoice`) billing: trialing and past_due within grace clear a past pin; `unpaid` is not paying even when recorded with its tier inside 30 days; past grace lets a past pin stand. Unit tests: `tests/billing/webhook.test.ts:739` and `:1706`, `tests/billing/districtSeats.test.ts:100` ff., and `tests/billing/districtSeatCap.test.ts` (spec and guard).
- Two existing checks encoded the old status set and were updated. A redelivery that used `unpaid` is now `past_due`. The "card past due gets no grace" check now uses a card Teacher plan.

## Fix 2: clamp `contract_ends_at` (Decision 22; Codex new major 2). Commit `1d2e229`

New migration `supabase/migrations/20261020181000_district_contract_end_clamp.sql`:

- It adds `district_billing.contract_end_reported_at` (the source's own date) and `contract_end_learned_at` (when Cleffy learned of the end: `now()` at event processing or admin write) at `:39`/`:41`. These are added **outside** the canonical block, so that block is unchanged (see parity below).
- The Stripe path (CAP:706/:716) now lives in `district_billing_rederive` (`:71`). It stores `greatest(v_end, v_learned)` (`:152`). If the same source reports the same date again (retry, replay, redelivery, hourly sweep), the existing learned-at time is kept (`:148`), so neither learned-at moves later nor the end moves earlier. A different date counts as a new end, learned now. A missing Stripe date still leaves the stored value unchanged (the warning path is kept).
- The admin path (CAP:981) now lives in `admin_set_district_contract_end` (`:189`). It stores `greatest(p_contract_ends_at, v_learned)` (`:238`), and retrying the same date keeps the first learned-at time (`:231`). A pinned "never" (null) and `p_automatic` are unchanged. Decision 8 still holds: a past pin is clamped to now, which is `<= now()`, so it is cleared at once while the owner pays.
- Clamps are logged with a reason. Existing rows are backfilled once from their last write, which only moves ends later.
- Tests: the expectations at `tests/sql/district_seat_cap.sql:784` ff. are updated (the old stale-period-end check now expects the clamp, with Stripe's date in `contract_end_reported_at`), along with the other stale-date checks. New checks at `:1417` ff.: a late cancel with a 60-day-old `ended_at` (and a period end 90 days old) is clamped to learned_at (`:1443`). A past admin date is clamped too. Both leave the 14-day notice and 30-day window whole. A replay (`:1497`), a re-derivation by the sweep, and an admin retry each keep the learned-at time (time passing is simulated by moving learned_at back). A different admin date counts as a new end; a future date is stored as given; handing back to Stripe re-derives the clamped Stripe end.

## Fix 3: clock-only grace expiry (Decision 26; Codex D2 partial). Commit `c8a1057`

What I found: every per-request check (marks, snapshots, renames, share links, assignments, every write to the `scores` Storage bucket) already compared `now()` against the stored grace deadline: `caller_seat_read_only` → `resolve_entitlements` → `subscription_is_live` → `now() < district_grace_ends_at()`. None of them depended on a flag the sweep sets. Live ink was the gap, because Realtime asks the broadcast policy at a channel's **first send** and caches the answer until the token changes. I reproduced this against the local Realtime server at the fix-2 state: a channel that sent before the deadline was still delivering ink to a peer after it, with no sweep.

New migration `supabase/migrations/20261020181100_read_only_seats_grace_deadline.sql`:

- `seat_grace_deadline(uuid)` (`:53`) returns the earliest grace deadline among the past-due-in-grace subscriptions a studio member's seat or own plan depends on. It returns null for non-members (one index probe) and for districts that pay outright.
- `caller_seat_grace_ends_before_token()` (`:81`) and the restrictive policy `doc_topic_seat_grace_broadcast` on `realtime.messages` (`:109`) refuse a `doc:{id}` broadcast when that deadline is `<=` the `exp` of the token being authorized (a token with no `exp` counts as never expiring). As a result, no answer Realtime caches can outlive the deadline: earlier answers come from tokens that expire before it, and every refresh after that point is refused. Presence, receiving and non-members (roster students included) are untouched. The sweep still records the seat, sends the hint and rotates the topic.
- Tests: `tests/sql/district_read_only_seats.sql:738` ff. Before the deadline the seat still marks and writes its PDF; a broadcast whose token outlives the deadline is refused (`:820`); a broadcast whose token expires first is allowed; a roster student is allowed. Past the deadline with no sweep (nothing recorded, nothing archived), live ink is refused (`:889`) and so is the Storage write (`:897`). There is also a live Realtime and Storage test, `tests/live/readOnlySeatGraceDeadline.live.test.ts`, and CI guards in `tests/billing/readOnlySeats.test.ts`.
- **Cost (please confirm, see open question 1):** a district member loses live ink, but not marks, during the last token lifetime (at most an hour) of grace.

## Migrations: order and re-runnability

- `20261020180900_district_paying_status`, `20261020181000_district_contract_end_clamp` and `20261020181100_read_only_seats_grace_deadline` sort after #61's previous latest (`20261020180800`). They also sort after #62's latest: `20261020160300` named in the packet, and `20261020160400_cancel_link_tombstones_db_clock` at #62's current head `794cd036`, which moved during this session. They sort before #64's `20261021120000`+. So under #63 → #62 → #61 → #64, no later-merged PR adds an earlier timestamp.
- They are re-runnable: functions use `CREATE OR REPLACE`; columns use `ADD COLUMN IF NOT EXISTS`; the policy is `DROP POLICY IF EXISTS` then `CREATE`; the backfill only touches rows it has not touched before. There are no new tables, constraints or cron jobs. `tests/sql/district_migrations_rerunnable.sql` applies all eight district migrations twice (19/19). `tests/billing/districtMigrationsRerunnable.test.ts` lists the three new files.
- Cron: no `cron.schedule` added or removed. This branch has 3 jobs after a clean reset (omr-sweep, imslp-sync, district-seat-reconcile), so the combined expectation of 10 is unchanged.
- `scripts/apply-migrations.sql` was regenerated with `npm run migrations:mirror` in every commit, never hand-edited.
- `tests/migrationRecoverability.test.ts`: **no change was needed**. It only pins cron jobs and other unrelated objects, and I touched no cron. **It must still be reconciled by hand at merge time** (it is not regenerated).

## Tests run (this environment, local stack)

- `npm run lint:check`: clean. `npm run typecheck`: clean. `npm run build`: OK. Prettier was run on every changed TS/MD file.
- `npm run test`: 2921 passed, 3 skipped, **2 failed**: `src/sync/syncEngine.test.ts` ("backs off exponentially with jitter") and `tests/auth/turnstileField.test.tsx` ("leaves the sign-up form submittable"). Both **fail identically at f91b6c85 in this container** (I checked with the changes stashed), and neither touches this PR's code; CI was green on them at f91b6c85. They appear to be container-specific. See the CI section for the result on the new head.
- SQL, all `tests/sql/*.sql` after a clean `supabase db reset` replay of every migration: all pass, except `billing_double_charge.sql` at 3 of 98, which is the known Decision 20 grant issue on dev. District suites: `district_seat_cap` 180/180, `district_read_only_seats` 68/68, `district_seats` 58/58, `district_billing_canonical` 12/12, `district_migrations_rerunnable` 19/19, `column_integrity` 113/113, `cross_branch_integration` 37/37.
- Live (`tests/live/`, local Realtime and Storage): 3/3 pass.

### Fail-before / pass-after evidence

For each fix I first ran the new tests with the DB at the previous state (the district migrations 180400–180800 re-applied, which restores f91b6c85's definitions, plus any earlier fixes of this round). I then ran them again with the fix applied.

| Fix | Before (without the fix)                                                                                                                                                                                                                                                                                                                                            | After                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | `district_seat_cap.sql`: **7 of 163 failed** (card past_due in grace paying, no purge, pin cleared and logged, sweep restoring the end past grace, extension for card, invoice unpaid not paying). Unit: **9 failed** (webhook card past_due → academy, districtSeats card Academy past due / unpaid → free, spec unpaid/card grace, guards)                        | 163/163; unit all pass |
| 2   | `district_seat_cap.sql`: **27 of 180 failed** (including "the retention clock is not already run" for the late cancel and the admin date, replay/rederive/retry keep the clamp). Unit guard "clamps every contract end…" failed                                                                                                                                     | 180/180; unit passes   |
| 3   | `district_read_only_seats.sql`: **2 of 68 failed** (the broadcast whose token outlives the deadline, and the one with no exp). Live test **failed** (`expected 'ok' not to be 'ok'`). A diagnostic variant at the old state logged `POST-DEADLINE SEND ok` / `PEER GOT 1 AFTER DEADLINE true`, which is the leak Codex described. Unit guards failed (file missing) | 68/68; live 3/3        |

Honest note on fix 3: the "past the deadline, with no sweep, broadcast and storage write refused" SQL checks (`:889`, `:897`) **already passed at f91b6c85**. The per-request checks were clock-based, and only the cached Realtime answer was not. The checks that fail without the fix are the cached-channel ones (SQL `:820` and the no-exp check) and the live test.

## CI on the new head

**Green on `c8a1057`.** Both `checks` runs succeeded (runs 39680308206 and 39680301184), as did both `supabase-drift` runs, both `omr-service` runs and Vercel Preview Comments. Supabase Preview was skipped, as before. No re-runs were needed. The known `imslpDownload.test.ts:379` flake did not occur, and the two container-only failures above did not occur in CI. The pushes of `5a9feef` and `1d2e229` were followed by `c8a1057` before I polled, so I report CI on the final head only.

## Parity

- **mailBudget**: `git diff origin/mh/launch-checkout HEAD -- supabase/functions/_shared/mailBudget.ts tests/security/mailBudget.test.ts` is **empty** (#62 at `794cd036`). sha256 `1676e01b7296156d…` / `42c8eb4aa959ab0b…`, unchanged since f91b6c85. I did not edit them.
- **district_billing canonical block**: **unchanged**. CAP was not edited. The marker-to-marker block in CAP and in #64's `20261021120700_district_retention.sql` at `origin/mh/launch-consent` `82d32c70` are byte-identical: sha256 `a3043de59252d4191331b137fedb8192f3cdc206db2a222be8e35d7b913b60be`, 2,803 bytes on both sides (`district_billing_canonical.sql` 12/12). **#64 does not need to sync anything.** Note for #64: the two new columns are added outside the block by `20261020181000`. #64 only reads `contract_ends_at`, which is already clamped, and its `create table if not exists` is a no-op after #61, so the columns survive.

## Skipped minors

None. Codex reported no minors.

## Open questions

1. **The cost of fix 3's live-ink rule (product call).** Realtime caches its broadcast answer until the token changes. The only way the database can make live ink stop at the deadline itself is to refuse it whenever the grace ends before the token expires. So a district member loses live ink (marks still save and sync) during the last token lifetime, at most an hour, of a ≥30-day grace. It also applies to every member of a district in that final hour, not only the seats that will go read-only, because which seats stay active depends on what the owner does in that hour. Is that acceptable? The alternative is to accept up to the sweep interval (1 h) of leak, which is what Codex flagged.
2. **An admin shortening an extension to less than an hour away.** If an admin withdraws or shortens an extension so that the new deadline is under an hour away, a Realtime answer cached under the old, later deadline can outlive the new one until token refresh. `admin_extend_district_grace` reconciles seats (and rotates topics with #63) only once a seat actually flips. I left this alone as rare and admin-driven; say if you want a rotation on every shortening.
3. **Card past_due rows written before the deploy.** Card-paid Academy subscriptions already `past_due` at deploy time were recorded by the old webhook as tier `free`. They are not treated as paying until their next Stripe event rewrites the tier. SQL cannot map price to tier, so there is no backfill.
4. **A behaviour change beyond districts.** Decision 25 applies past_due grace to card Academy generally. An ordinary card Academy subscriber whose card fails now keeps Academy for up to 30 days, where before they dropped to free at once. Card Personal and Teacher plans are unchanged.
5. **A collaborator's marks on a read-only seat's own score** (observation, not changed). These are refused via the plan_lapse archive, which the sweep writes. So between a clock-only deadline and the next sweep, an _active_ collaborator can still add marks to the read-only seat's own scores. Live ink by such collaborators was never gated on the owner's seat. The read-only seat itself is refused everything from the deadline. This is outside the round-4 items; it could be made clock-based with an owner-seat check in the annotation policies if wanted.
6. #62's head moved from `78ee399e` to `794cd036` (new migration `20261020160400`) during this round. Ordering is still correct; the merge-time mirror and `migrationRecoverability.test.ts` reconciliation should use the current heads.
7. The two unit tests that fail in this container at f91b6c85 (syncEngine backoff, turnstileField) are noted above. If they ever fail in CI, they are not caused by this PR.
