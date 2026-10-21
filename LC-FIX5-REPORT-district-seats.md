# LC fix pass round 5: PR #61 (mh/district-seats)

- PR: https://github.com/maxharris1/Cleffy/pull/61 (draft into `dev`; still a draft, no reviewers requested, no new PRs)
- Starting head: `c8a105772e9faaa8c01657acea9a84dc4f150091` (confirmed after `git fetch origin && git checkout -B mh/district-seats origin/mh/district-seats`)
- **New head: `a472674a7d86990642271506bbb8b7c5cc92ac5e`** (fast-forward `c8a1057..a472674`, `git push origin HEAD:mh/district-seats`, no force)
- Environment: **Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2`** (confirmed with `get_session` at the start: `environment_id: env_01WAd3yiz3qpSnsofpyEwCh2`, `environment_kind: anthropic_cloud`). Not Sandbox.
- Commit identity: Max Harris <drumaxter@gmail.com>.

## Commits

| SHA | Summary |
|---|---|
| `a472674a7d86990642271506bbb8b7c5cc92ac5e` | Keep the contract end when a hand-back to Stripe is repeated (new migration 20261020181200, mirror regenerated, SQL + static tests) |

That is the only commit on `mh/district-seats`. This report is one extra commit on the scratch branch `claude/lc-fix5-report-district-seats`, created from `a472674`.

## The fix (Codex round-5 new minor 1)

**Problem.** `20261020181000_district_contract_end_clamp.sql:216-225` cleared `contract_end_learned_at` on every `p_automatic => true` call, then re-derived. The re-derivation found no learned-at time to keep and assigned `now()` (M10:150). So repeating the hand-back after the district already followed Stripe moved the clamped `contract_ends_at`, and with it #64's notice and purge, later each time, though Stripe's data had not changed.

**Fix:** commit `a472674`, new migration `supabase/migrations/20261020181200_district_contract_end_automatic_retry.sql`, which replaces `public.admin_set_district_contract_end` (CREATE OR REPLACE). Only the `p_automatic` branch changes. The pin branch is copied unchanged from M10.

- `:58-75`, **already automatic** (`contract_ends_source` is `'stripe'`, or null with no end): nothing is cleared. The call only runs `district_billing_rederive`, the same idempotent re-derivation every webhook write already runs. While Stripe's data is unchanged it writes nothing, because its `UPDATE … WHERE … is distinct from …` matches no row. The same Stripe date keeps its learned-at time (M10:145-148). So `contract_ends_at`, `contract_end_learned_at`, `contract_end_reported_at` and the source all stay as they are, and no `district_billing_log` row is written (the SQL proof checks for that log row). I kept the re-derivation call rather than returning straight away. Otherwise a billing row that `district_billing_row()` had only just created would never be derived, and M10 did derive it.
- `:59-71`, **a real hand-back** (`contract_ends_source = 'admin'`): the row switches to source `'stripe'` and keeps the pin's `contract_end_reported_at` and `contract_end_learned_at`. A pinned "never" (null end) keeps none of them, because the `district_billing_contract_ends_source_matches` constraint requires null/null. Then the re-derivation runs (`:75`). If Stripe reports the same date, M10's same-date rule keeps the earlier learned-at time, so it never moves later for the same end. A different date is a new end, learned `now()`. No end (the owner pays, nothing is linked, or the subscription is not canceled) clears every column, as before.
- `:77-90`, **no-date edge on a real hand-back.** If Stripe ended the subscription with neither `ended_at` nor `current_period_end`, the re-derivation warns and returns without writing (M10:133-136). That would leave the pin's date labelled as Stripe's. This step clears it, so the result is null, exactly what M10 produced. It applies only to a real hand-back. An already-automatic Stripe end on the no-date warning path is untouched, which is M10's "leave the stored value unchanged".
- `:38`: `set search_path = public`. `:134-137`: the same revoke from public/anon/authenticated and the same `grant execute … to service_role` as M10:266-269.

**Tests covering it:**

- `tests/sql/district_seat_cap.sql:1579-1722` (local stack, `integrity_results` harness):
  - `:1593` is the same hand-back repeated 4 hours later, after the end is already Stripe's. The end, learned-at, reported date and source are unchanged.
  - `:1603` checks the retention deadline (`contract_ends_at + 30 days`) is unchanged.
  - `:1610` checks no `district_billing_log` row was written.
  - `:1619` checks the hourly sweep afterwards leaves it as well.
  - `:1643` is a real admin→automatic switch where Stripe reports the pin's date. It re-derives to source `stripe` and keeps the earlier learned-at time (5 hours ago, not now).
  - `:1672` is a real switch where Stripe reports a different date. It re-derives and learns the end now.
  - `:1689` is a hand-back from a pinned "never". Stripe's end is learned now.
  - `:1718` is a hand-back when Stripe gives no date. The result is null and no end is invented from the pin.
  - The existing initial-handoff check at `:1572` still passes.
- `tests/sql/district_migrations_rerunnable.sql:103/:113` applies 20261020181200 twice. `:251` checks that its definition wins, the pinned `search_path=public`, EXECUTE for service_role only, and none for anon/authenticated.
- `tests/billing/districtSeatCap.test.ts:186`, and `:237-250` (the latest definer of `admin_set_district_contract_end` is now 20261020181200, and the clamp is kept). `:252` is a new static check that only an admin pin is handed over and nothing clears learned-at unconditionally.

### Fail-before / pass-after evidence

The local stack was booted at c8a10577, with migrations through 20261020181100 and without 20261020181200. I ran the new `tests/sql/district_seat_cap.sql` against it first:

```
 174 | the same hand-back, repeated hours later once the district follows Stripe: the end and its learned-at time stay | f | got false
 175 | and so does the retention deadline: the purge is still 30 days after the end first learned                      | f | got false
 176 | the repeated hand-back writes nothing at all (no log row)                                                       | f | got false
 177 | nor does the hourly sweep after it                                                                              | f | got false
 179 | handed back with Stripe reporting that same date: re-derived, the earlier learned-at time kept                  | f | got false
     | 5 OF 192 CHECKS FAILED
```

Then I applied the migration with `npx supabase migration up --local`, which applied `20261020181200_district_contract_end_automatic_retry.sql`, and ran it again: **`ALL 192 CHECKS PASSED`**. The new checks that pass on both versions (other date, from "never", no date) are regression guards for the parts of the hand-back that must not change.

## Migration name and ordering

`20261020181200_district_contract_end_automatic_retry.sql`

- It sorts after #61's previous latest, `20261020181100_read_only_seats_grace_deadline.sql`, and before #64's first, `20261021120000_consent_age.sql`.
- Under the binding merge order #63 (`20261020150*`) → #62 (`20261020160*`) → #61 (`20261020180400`…`20261020181200`) → #64 (`20261021120*`), every PR still introduces only timestamps later than every earlier-merged PR's. "No later-merged PR adds an earlier timestamp" still holds.
- No already-pushed migration was edited (M9, M10, M11, CAP and earlier are untouched: `git diff c8a10577 a472674 --stat` lists only the 5 files below).

**Re-runnable.** The migration only `CREATE OR REPLACE`s one function and resets its privileges to the same end state. It creates, alters, backfills and schedules nothing. `tests/sql/district_migrations_rerunnable.sql` applies all nine district migrations twice inside one transaction: `ALL 20 CHECKS PASSED`.

Files changed in `a472674`:

- `supabase/migrations/20261020181200_district_contract_end_automatic_retry.sql` (new)
- `scripts/apply-migrations.sql` (regenerated with `npm run migrations:mirror`, not hand-edited; #61 is now 76 SQL / 74 mirrored, so the combined total becomes **94 / 92**)
- `tests/sql/district_seat_cap.sql`, `tests/sql/district_migrations_rerunnable.sql`, `tests/billing/districtSeatCap.test.ts`

**`tests/migrationRecoverability.test.ts`:** no change was needed. The new migration adds no cron job and no function from its unmanaged-function list. **It must still be reconciled by hand at merge time**, like `scripts/apply-migrations.sql` (which must be regenerated, never resolved by taking a side). No `cron.schedule` was added or removed, so the combined expectation stays at **10 executable schedules**.

## Tests run

| Check | Result |
|---|---|
| `npm run lint:check` | pass |
| `npm run typecheck` | pass |
| `npm run test` | **199 files / 2924 tests passed, 3 skipped** (see note) |
| `npm run build` | pass |
| prettier | `npx prettier --write tests/billing/districtSeatCap.test.ts`: unchanged. The `.sql` files have no prettier parser in this repo ("No parser could be inferred"), so N/A. |
| `tests/sql/district_seat_cap.sql` | ALL 192 CHECKS PASSED (5 of 192 failed before the fix, above) |
| `tests/sql/district_migrations_rerunnable.sql` | ALL 20 CHECKS PASSED (applied with `psql -v ON_ERROR_STOP=1`, exit 0) |
| `tests/sql/district_billing_canonical.sql` | ALL 12 CHECKS PASSED |
| `tests/sql/district_read_only_seats.sql` | ALL 68 CHECKS PASSED |
| `tests/sql/district_seats.sql` | ALL 58 CHECKS PASSED |
| other `tests/sql/*.sql` | all pass (annotation_payload_shape 57, archived_student_password 13, billing_export_claims 35, column_integrity 113, cross_branch_integration 37, edge_rate_limit_refund 10, guest_email_verification 0/53 failures, qa3_cross_branch 12, share_link_errors 0/26 failures, student_access_revocation 44), except `billing_double_charge.sql`: **3 of 98 failed**. These are checks 89/92/98, anon/authenticated reads of the attempts, write-locks and refund-ledger tables. They are the known pre-existing grants from decision 20, unrelated to this change. |

All SQL ran on the local stack (`npm run cloud:up`, Postgres at 127.0.0.1:54422). Hosted Supabase and Stripe were not touched.

**Note on `npm run test`.** My first full run had 3 failures:

- `tests/billing/districtSeatCap.test.ts`, a static check pinning the latest definer file to M10. It was real, and I fixed it in `a472674`.
- `src/sync/syncEngine.test.ts` "backs off exponentially…" and `tests/auth/turnstileField.test.tsx` "leaves the sign-up form submittable…". Both are caused by the gitignored `.env.local` that `npm run cloud:up` writes (`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`). They pass on a clean c8a10577 worktree, and pass in this checkout with `.env.local` moved aside. CI has no `.env.local`. The full suite without it is green, as in the table above.

The `imslpDownload.test.ts:379` flake did not occur locally.

## CI on the new head

**Green on `a472674`** (checked 2026-10-21 ~22:16 UTC via the GitHub check runs; PR `mergeable_state: clean`, still a draft):

| Check | Run | Result |
|---|---|---|
| checks (lint, typecheck, test, build) | 39684402633 | success |
| checks | 39684408953 | success |
| supabase-drift | both runs | success |
| omr-service | both runs | success |
| Vercel / Vercel Preview Comments | | success (preview deployed) |
| Supabase Preview | | skipped (as before) |

No re-runs were needed; the `imslpDownload.test.ts:379` flake did not recur. As before, CI does not run `tests/sql` against a database, so the SQL proofs above are the local-stack evidence.

## Shared-contract parity

- **mailBudget (#62):** `git diff origin/mh/launch-checkout HEAD -- supabase/functions/_shared/mailBudget.ts tests/security/mailBudget.test.ts` is **empty** (0 bytes). sha256 prefixes are `1676e01b7296156d` (mailBudget.ts) and `42c8eb4aa959ab0b` (mailBudget.test.ts). `origin/mh/launch-checkout` was at `39592f5fd09f123bcc2a27d1756d4dbb8e215d06` when checked, which is newer than the 9c805601 Codex reviewed, and is still identical. Neither file was edited.
- **district_billing canonical block (#64):** the marker-delimited block in `20261020180500_district_seat_cap_and_grace.sql` is unchanged (the file is not in the diff). It is byte-identical to the block in `supabase/migrations/20261021120700_district_retention.sql` at `origin/mh/launch-consent` `82d32c7052846f1b7827cea2eac48e3cd3152ad9`: both are **2,803 bytes**, sha256 **`a3043de59252d4191331b137fedb8192f3cdc206db2a222be8e35d7b913b60be`**. `tests/sql/district_billing_canonical.sql`: ALL 12 CHECKS PASSED. The fix did not need to change the block.

## Skipped minors

None. Codex reported only this one minor for #61 in round 5, and it is fixed.

## Open questions

1. **Branch name.** This cloud session was set up with a default development branch `claude/district-contract-end-retry-48hrs3`. I followed the explicit task instructions instead: push only to `mh/district-seats` and `claude/lc-fix5-report-district-seats`. Nothing was pushed to the default-named branch.
2. **Stripe learned-at lost to an intervening admin pin (pre-existing in M10, not changed here).** Suppose Stripe's end E was learned at T0, then an admin pinned a different date P at T1, then the record was handed back at T2 with Stripe still reporting E. The row no longer holds T0, because the pin overwrote `contract_end_reported_at`/`contract_end_learned_at` in M10. So E is re-learned at T2, and the deadline is later than it would have been from T0. That errs the district's way (data kept longer), and it only happens after a deliberate admin pin with a different date. Same-date pins keep the earlier time, as required. Keeping T0 across a different-date pin would need a separate column for the last Stripe learned-at, which is a schema change beyond this minor. Is that wanted?
3. **"No-op" wording.** An already-automatic hand-back still calls `district_billing_rederive`, the same call every webhook write makes. If Stripe's data really changed and somehow was never derived, the call picks that up, and only then. With Stripe's data unchanged it writes nothing, which the "no log row" check proves. A literally empty call would leave a billing row created on the spot by `district_billing_row()` underived, which would be a regression from M10.
4. **Merge-time reconciliation (for whoever merges):** regenerate `scripts/apply-migrations.sql` with `npm run migrations:mirror` (combined is now 94 SQL / 92 mirrored). Reconcile `tests/migrationRecoverability.test.ts` by hand; the cron map stays at 10.

No other session was messaged. Coordination was only through git.
