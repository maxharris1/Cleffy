# LC fix pass round 3 — Session D report: PR #61 (district seats)

- **PR:** https://github.com/maxharris1/Cleffy/pull/61 (draft into `dev`; still a draft, no reviewers requested)
- **Branch:** `mh/district-seats`
- **Start head:** `85cf5719d0e1650a86f883c05de50a55b7fa6838` (confirmed before any change)
- **New head:** `f91b6c85ed9a423c1c076a71831c7c4a4259496c` (7 commits, every push fast-forward, no force pushes)
- **Commit identity:** every commit authored as `Max Harris <drumaxter@gmail.com>`
- **Environment:** Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (`anthropic_cloud`), **not Sandbox**. Confirmed with `get_session` at the start.
- **Scope kept:** pushed only to `mh/district-seats` and to this report branch. Nothing touched #54, #62, #63 or #64, hosted Supabase or live Stripe. No merges, no messages to other sessions. All SQL and live tests ran on the local stack (`npm run cloud:up`).

## Findings → commits → tests

"Fails without / passes with" was checked for every item. The before run used the previous code, or the previous function definitions applied to the local DB; the after run used the new ones.

| #     | Round-3 item                                                                                                                                                                                     | Commit    | Tests (fail without → pass with)                                                                                                                                                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D4    | Mail split: copy `mailBudget.ts` + `mailBudget.test.ts` byte for byte from `origin/mh/launch-checkout`                                                                                           | `3c72615` | `tests/security/mailBudget.test.ts`: 3 failures against the old file → 15/15                                                                                                                                                                                                                                                |
| D3    | `contract_ends_at` only from Stripe `ended_at` / `cancel_at` / `current_period_end` or an admin's date; no stored/event/`now()` fallback; warn and keep otherwise; migration-before-webhook case | `8d35760` | `tests/sql/district_seat_cap.sql`: 2 of 115 fail → 115/115; `tests/billing/districtSeatCap.test.ts` (CI shape check): fails → passes                                                                                                                                                                                        |
| Max 7 | Card-paid Academy counts as paying for purge purposes (`rederive` → null); seats above 5 still read-only                                                                                         | `5179e7e` | `district_seat_cap.sql`: 1 of 119 fails → 119/119; `districtSeatCap.test.ts` updated                                                                                                                                                                                                                                        |
| Max 6 | An admin pin already in the past is cleared and logged while the owner pays on a live subscription; a future pin is kept                                                                         | `5b8faa3` | `district_seat_cap.sql`: 4 of 130 fail → 130/130; `districtSeatCap.test.ts`: fails → passes                                                                                                                                                                                                                                 |
| D5    | Whole district migration rerunnable (`IF NOT EXISTS`, `DROP TRIGGER IF EXISTS` before `CREATE`, guarded `ADD COLUMN`)                                                                            | `b1ea9ed` | **Apply-twice test** `tests/sql/district_migrations_rerunnable.sql`: the old files stop at the first statement (`column "collection_method" … already exists`, psql exit 3) → 15/15, now 17/17 including the two new migrations; `tests/billing/districtMigrationsRerunnable.test.ts`: 6 failures → 18/18, now 30/30        |
| D1    | Storage: `storage.objects` INSERT/UPDATE/DELETE on score files require a writable seat (same helper); read and download unchanged                                                                | `94390c9` | `tests/sql/district_read_only_seats.sql`: 5 of 45 fail → 45/45; `tests/live/readOnlySeatStorage.live.test.ts` (real Storage API over HTTP): fails with the policies dropped → passes; `tests/billing/readOnlySeats.test.ts` (CI shape check)                                                                                |
| D2    | Live ink after the grace period: server acts on the seat change; client drops to view-only                                                                                                       | `f91b6c8` | `district_read_only_seats.sql`: 8 of 55 fail → 55/55; `tests/live/readOnlySeatLiveInk.live.test.ts` (real Realtime server): fails without the migration (no hint arrives) → passes; `src/features/viewer/ViewerPage.test.tsx`: 4 new tests fail without the viewer change → 53/53; `readOnlySeats.test.ts` (CI shape check) |

Cross-PR points that apply to #61: the mail split (D4) and the rerunnable migration (D5) are above. Also: `migrations:mirror` regenerated `scripts/apply-migrations.sql` after every migration change, and `migrationRecoverability.test.ts` is covered under its own heading below.

### What each fix does

- **D4.** `supabase/functions/_shared/mailBudget.ts` and `tests/security/mailBudget.test.ts` were copied from `origin/mh/launch-checkout` at `664ab41`. Neither file was edited, and prettier was run only in `--check` mode (clean), so the copies stay byte-identical. The registered split is 28/150, 8/35, 4/20, 8/40, 7/30, 5/25 = 60/300.
- **D3.** In `district_billing_rederive` (20261020180500), the derived end is now `coalesce(ended_at, current_period_end)`. The webhook's `endedAtOf` already fills `ended_at` from Stripe's `ended_at`, or the `cancel_at` the subscription ended on, so all three Stripe sources are covered.
    - With no date at all, the function changes nothing (the existing value, null included, stays) and raises `WARNING district_billing: studio … subscription … ended with no Stripe end date; contract_ends_at left at …`.
    - The test runs the pre-20261020180400 webhook's 10-argument `write_subscription_under_lock` call. Without a period end, the end stays null. The new webhook's `ended_at` then lands. An existing end is kept rather than being replaced by the event time.
- **Max 7.** "Paying" is now any live Academy subscription of the owner. `district_billing_follow` re-derives on card subscription writes too (a card subscription never becomes the record's link). In the test, a card Academy makes the end null while the seats stay `AARRRRRAA`; when the card plan ends, the Invoicing end comes back. A card Teacher plan does not count.
- **Max 6.** If the owner pays and an admin pin is at or before `now()`, the pin is cleared and logged in `district_billing_log`. The logged reason is `admin pin <date> had passed while the owner pays on a live subscription: cleared`. This runs:
    - on every subscription write;
    - right after `admin_set_district_contract_end` pins a date;
    - hourly in `reconcile_district_seats`, for a future pin the clock carries into the past.

    A future pin, a pinned null ("never") and a past pin for a district that does not pay all stand.

- **D5.** Guards were added to 20261020180400 and 20261020180500. 20261020180600 was already rerunnable. `cron.schedule` upserts by job name, and the `insert … on conflict do nothing` statements are already safe.
    - The three migrations were applied twice for real on the local stack, and all four existing proofs still passed.
    - At the end, all five district migrations were applied twice again: 58/130/55/12, plus the rerun proof 17/17.
- **D1.** New migration `20261020180700_read_only_seats_storage.sql` adds restrictive policies with `(select public.caller_seat_read_only())` for bucket `scores` only.
    - UPDATE has both USING and WITH CHECK, so the Storage API's upsert is refused with an error.
    - DELETE still allows `document_storage_cleanup_pending`, so a read-only seat can delete its own score and then clean up its files.
    - The thumbnails bucket is not restricted (see skipped minors).
- **D2.** New migration `20261020180800_read_only_seats_live_ink.sql`, plus client changes. The details are in the next section.

### D2 in detail: what is and is not enforced server-side

I measured this on the local Realtime server (v2.143.4), first with a scratch probe and now in `readOnlySeatLiveInk.live.test.ts`. A channel that joined while the seat was active **kept broadcasting after the seat turned read-only**: Realtime caches the channel's write permission from the join. After the client refreshed its token (`setAuth`), every send was refused. Realtime has no per-send re-check and no way to evict one subscriber. So:

- **Server (20261020180800).**
    - `public.seat_read_only_since` records read-only seats. It has RLS on and no client grants. It is maintained by `reconcile_studio_seats`, which is redefined here and runs on every seat-moving event and in the hourly sweep, and by `studio_members_release_seat`, redefined for a removed member.
    - When a seat **changes** to read-only, `seat_live_ink_notify` sends the existing membership hint on the live topic of every score the account owns or edits. It also calls **PR #63's `rotate_document_realtime(uuid)` when that function exists**. #63 merges before #61 in the binding order. Rotation moves those scores to fresh topics, which cuts off a client that ignores the hint.
    - When the seat becomes active again, it sends the hint only.
- **Client.** `ViewerPage` asks `caller_seat_read_only` on open, on every access re-check (membership hint, reconnect, refused join) and when sync holds a change as `seat-read-only`. While the seat is read-only the viewer is view only. That restarts sync without the live-ink publisher and rejoins the channel, and Realtime authorizes the rejoin afresh, so it cannot broadcast. The only visible change is the existing "view only" badge with a title ("View only — your Academy seat is read-only"). No new controls were added.
- **Residual window (#61 alone, without #63).** A modified client that ignores the hint keeps Realtime's cached send permission until its next token refresh or expiry (`jwt_expiry` = 3600 s). The live test proves sends are refused from the refresh onward. With #63 merged first, rotation closes this window: immediately for event-driven changes, and at the hourly sweep for a grace period that only the clock ended. See open questions 1 and 2.
- **UI check** (ui-check skill, `scripts/ui/uifuzz.mjs`, throwaway accounts, cleaned up). The viewer for a read-only seat at `desktop-1440` and `iphone-14` shows "view only" with the seat tooltip and no drawing tools. The audit returned nothing and there were no console errors. On the seat's _own_ score, the existing "Archived" badge takes precedence because the lapse archives those scores; that is pre-existing behavior.

## Tests run and results

Final runs on head `f91b6c8`:

| Check                                                                                                                        | Result                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint:check`                                                                                                         | clean                                                                                                                                          |
| `npm run typecheck`                                                                                                          | clean                                                                                                                                          |
| `npm run test`                                                                                                               | 198 files; **2893 passed, 2 skipped** (the two live tests skip without a local stack)                                                          |
| `npm run build`                                                                                                              | success                                                                                                                                        |
| prettier                                                                                                                     | `--write` on changed TS/MD files; `--check` only on the two byte-identical mail files (clean). SQL files have no prettier parser in this repo. |
| `tests/sql/district_seats.sql`                                                                                               | ALL 58 CHECKS PASSED                                                                                                                           |
| `tests/sql/district_seat_cap.sql`                                                                                            | ALL 130 CHECKS PASSED                                                                                                                          |
| `tests/sql/district_read_only_seats.sql`                                                                                     | ALL 55 CHECKS PASSED                                                                                                                           |
| `tests/sql/district_billing_canonical.sql`                                                                                   | ALL 12 CHECKS PASSED                                                                                                                           |
| **Apply-twice** `tests/sql/district_migrations_rerunnable.sql` (psql `\ir`, all five district migrations twice, rolled back) | ALL 17 CHECKS PASSED                                                                                                                           |
| Real apply-twice on the local DB (all five district migrations, each twice, committed), then all of the above                | all pass                                                                                                                                       |
| `tests/live/readOnlySeatStorage.live.test.ts` (Storage API)                                                                  | 1/1                                                                                                                                            |
| `tests/live/readOnlySeatLiveInk.live.test.ts` (Realtime)                                                                     | 1/1                                                                                                                                            |

Notes:

- The local runs of `npm run test` set aside `.env.local` (written by `cloud:up`, gitignored). Otherwise `VITE_SUPABASE_URL` from it makes two unrelated tests fail locally (`syncEngine.test.ts` backoff and `turnstileField.test.tsx`), and both pass without it. CI has no `.env.local`.
- Run the live tests with `CLEFFY_LIVE_SUPABASE_URL=http://127.0.0.1:54421 CLEFFY_LIVE_ANON_KEY=… CLEFFY_LIVE_SERVICE_ROLE_KEY=… npx vitest run tests/live/`. The keys come from `scripts/supabase.sh status -o env` and were never printed.

## CI on the new head

**Green on `f91b6c85ed9a423c1c076a71831c7c4a4259496c`**, in both CI runs for the head:

- push run [39671206327](https://github.com/maxharris1/Cleffy/actions/runs/39671206327) and pull_request run [39671214583](https://github.com/maxharris1/Cleffy/actions/runs/39671214583): `checks` (npm ci, audit, lint:check, typecheck, test, build), `omr-service` and `supabase-drift` all **success**;
- Vercel Preview Comments: **success**;
- Supabase Preview: **skipped**, as on every earlier round.

Earlier intermediate heads had two failed runs:

- the `pull_request` run on `3c72615`;
- the `push` run on `5179e7e`.

Both failed in the same pre-existing, timing-sensitive test, `tests/imslp/imslpDownload.test.ts:379`: it received `bot_check` instead of `timeout`. This PR does not touch that test or the IMSLP code, and the other run on each of those SHAs passed. I did not change the test (see open question 6).

## district_billing and mailBudget identity

- **district_billing canonical block: unchanged.** SHA-256 `a3043de59252d4191331b137fedb8192f3cdc206db2a222be8e35d7b913b60be`, **2,803 bytes**. It is the marker line to the closing marker line in `supabase/migrations/20261020180500_district_seat_cap_and_grace.sql`, re-hashed after every commit.
    - Items D3, D5 and Max 6/7 changed only code _outside_ the block: `district_billing_rederive`, `district_billing_follow`, `admin_set_district_contract_end`, `reconcile_district_seats`, and the guards on other statements.
    - **Session A (#64) needs no copy.** The block in `origin/mh/district-seats` is byte-identical to what #64 already carries.
- **mailBudget:** `supabase/functions/_shared/mailBudget.ts` SHA-256 `1676e01b7296156d9de9dfa7c85af4cef5fb8ae81c8db8becae9c535974abcdb` and `tests/security/mailBudget.test.ts` SHA-256 `42c8eb4aa959ab0ba2bfd7c8681c63fb2e5a3d3a4d64ba7918c48f662b29c574`. **Both are byte-identical** to `origin/mh/launch-checkout` at `664ab41` (hashes compared file against `git show`).

## migrationRecoverability and the mirror (correction to round 2)

- **Correction:** the round-2 report said `npm run migrations:mirror` regenerates both `scripts/apply-migrations.sql` and `tests/migrationRecoverability.test.ts`. **That was wrong.** `migrations:mirror` (`scripts/build-apply-migrations.mjs`) regenerates **only `scripts/apply-migrations.sql`**. This round regenerated it after every migration change, and it now includes `20261020180700` and `20261020180800`. It was never hand-edited.
- `tests/migrationRecoverability.test.ts` is maintained by hand. It is correct on this branch: this round added no cron job, so #61's entry is still `'district-seat-reconcile': ['20261020180500_district_seat_cap_and_grace.sql']` next to `imslp-sync` and `omr-sweep`. It passes in the full run.
- **It must be reconciled by hand at merge time.** The combined job map has to include every job from #62, #63, #61 and #64:
    - content-moderation retry (#63);
    - billing mail outbox (#62);
    - `district-seat-reconcile` (#61);
    - the five retention jobs (#64);
    - the existing `imslp-sync` and `omr-sweep`.

    Run the test after resolving it. Regenerate `apply-migrations.sql` from the sorted set of all migrations, never by taking one side of a conflict.

## Skipped minors (with reasons)

- **Thumbnails bucket not restricted for read-only seats.** A cover is the viewer's own backfill from opening a score, like `thumb_rev`, which 20261020180600 already lets through for the same reason. Restricting it would break covers for a seat that may still view. The PDF itself (`scores`) is fully restricted.
- **The hourly sweep is still the only server-side signal for a grace period the clock alone ended.** RLS, Storage and the rejoin are right immediately. An honest client also goes view only on its first refused mark, before the sweep. Only the hint and rotation wait for the sweep, by up to an hour. This matches Q4, which Max said is fine as designed. I did not make the sweep more frequent.
- **Q5** (owner role changes and share-link joins still allowed): left as designed, per Max.

## Open questions

1. **D2 eviction depends on #63.** `20261020180800` calls `public.rotate_document_realtime(uuid)` and `public.document_live_topic(uuid)` dynamically when they exist. Those are #63's functions as of `origin/mh/launch-legal-pages` @ `4e90848`. If #63 renames them or changes their signatures before merging, #61's call silently does nothing; it falls back to hint-only, with the token-refresh bound. Please confirm the names stay, or have whoever rebases #61 onto `dev` after #63 merges check that `seat_live_ink_notify` still finds them. The SQL proof uses #63's epochs table when it exists, so running `district_read_only_seats.sql` after the merge will show whether rotation fires.
2. **Without #63 (if the merge order changes):** a modified client that ignores the hint can keep sending ephemeral live ink for up to one token lifetime (`jwt_expiry` 3600 s) after its seat turns read-only. Nothing it sends is persisted: marks, Storage and every table write are refused at once. Is that bound acceptable if #63 does not land first?
3. **Max 6 interpretation.** I read "a live replacement subscription exists" as "the owner has any live Academy subscription". That is the same test as Max 7's "paying district", and it includes the originally linked subscription if Stripe still bills it. So a past pin is cleared whenever the district pays. A pinned null ("never") is never cleared. Confirm, or narrow it to "a live subscription other than the linked one".
4. **Max 7 and trialing.** "Live paid Academy" uses the existing `subscription_is_live`, so a **trialing** Academy also counts as paying (which errs toward keeping data). Confirm.
5. **D3 and a stale period end.** When Stripe's `ended_at` is absent (only during the migrations-first rollout window), `current_period_end` is used as the packet directs. If the stored period end is months old, the contract end is backdated by that much. #64's 14-day export notice still comes first, and the new webhook's `ended_at`, once delivered, replaces it. Flagging it in case a backfill of `ended_at` from Stripe should run before the first retention purge, along with the dry run already in decision 7.
6. **Flaky `tests/imslp/imslpDownload.test.ts:379`.** This is a timing test outside this PR. It failed twice across this round's CI runs on intermediate heads (`bot_check` vs `timeout`). It probably wants its own fix; I did not touch it.
7. **Nothing to ask Session A.** The district_billing block did not change, and #64's `retentionNotice` share comes from the canonical mail file, which this branch now carries too.
