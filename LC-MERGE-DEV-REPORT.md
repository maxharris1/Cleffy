# Launch-compliance merge into dev: progress report

Merging PRs #63, #62, #61 and #64 into `dev`, in that order, as merge commits.
Max authorized this on 2026-10-21. This report is updated after each merge.

- Environment: Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (confirmed with
  `get_session` at the start; type `anthropic_cloud`, not Sandbox).
- `dev` at the start: `282b30ab956a2f6d2dc04d9e1aa7c6477a894ec9`.
- All four PR heads matched their reviewed SHAs on both `origin` and GitHub at the start.

## Continuation run

- Started 2026-10-22 ~00:10Z (2026-10-21 ~8:10 PM ET) in session
  `session_01ErrKnv9K1mRHTRiY4JAUVF`, environment **`env_01WAd3yiz3qpSnsofpyEwCh2`**
  (`anthropic_cloud`, the Cleffy cloud environment, not Sandbox; confirmed with
  `get_session`).
- It continues the stopped run below: #63 and #62 are already merged and are not redone.
  It does #61 and then #64, with Max's approved test-only stub fix (Cleffy decision 41) in
  #61's conflict-resolution merge commit.
- At the start: `dev` = `225bd64afb5a61502f3308c5018b1df0cceab7cd`; `mh/district-seats` =
  `a472674a7d86990642271506bbb8b7c5cc92ac5e` and `mh/launch-consent` =
  `82d32c7052846f1b7827cea2eac48e3cd3152ad9`, both equal to their reviewed SHAs on origin
  and on GitHub (both PRs open, draft, base `dev`).
- The sections for #61 and #64 below are updated after each merge. The earlier run's
  stop line near the end of this file is kept as history.

## 1. #63 `mh/launch-legal-pages`: merged

- Reviewed SHA: `c12b0230be6c9b2b14bb8ae8dcd3681e17f0a78a`. It was still the head on
  origin and on GitHub right before the merge.
- Conflict resolution: none. The PR was cut from `dev` at `282b30a` and `dev` had not
  moved, so GitHub reported it `clean`. Nothing was pushed to the PR branch.
- Local checks on `c12b023`: `lint:check` ✅, `typecheck` ✅, `test` ✅ (199 files
  passed, 1 skipped; 2893 tests passed, 2 skipped), `build` ✅.
- CI on `c12b023` (push and pull_request runs): `checks` ✅, `supabase-drift` ✅,
  `omr-service` ✅, Vercel Preview Comments ✅, Supabase Preview skipped. supabase-local
  doesn't exist yet; it arrives with #62. No flake re-runs were needed.
- Marked ready for review, then merged with `merge_method=merge` at 2026-10-21 23:42:37Z.
- **Merge commit on dev: `9b106e0ccaf9b0e407baab4c04b066ec77a248e5`**, with parents
  `282b30a` (dev) and `c12b023` (the reviewed head). GitHub shows #63 merged into `dev`.

## 2. #62 `mh/launch-checkout`: merged

- Reviewed SHA: `553f5d2544f85bee52034f38859ea762fb9b7a5e`. It was still the head on
  origin and on GitHub before I touched the branch.
- It conflicted with dev after #63, so I merged `origin/dev` (`9b106e0`) into the branch:
    - **Conflict-resolution merge commit `438ad800fd1d07b351db7e15dd25bbff94573efb`**, with
      parents `553f5d2` (the reviewed head, first parent) and `9b106e0`. Authored by Max
      Harris. It went to `mh/launch-checkout` as a fast-forward push.
    - Conflicted files and how I resolved them:
        - `scripts/apply-migrations.sql`: regenerated with `npm run migrations:mirror` (77
          files, 75 mirrored). The output is the same whichever side is checked out first.
        - `tests/migrationRecoverability.test.ts`: the job map is now the union of
          billing-mail-outbox, content-notice-retry, imslp-sync and omr-sweep. #62's static
          replay blocks (160300–160700) are kept.
        - `src/app/routes.tsx`, `supabase/config.toml`, `SETUP_SUPABASE.md`: both sides only
          added entries, so I kept both (`/cancel`, `/refunds`, `/copyright`, `/report`; the
          billing-cancel, billing-mail-outbox, content-report, content-moderation and
          content-notices function blocks; both outbox runbook paragraphs).
          `SETUP_SUPABASE.md` was already not Prettier-formatted on dev, on #62 and at the
          base, so I left its formatting alone.
    - Shared files after the merge are byte-identical to #62's: `_shared/mailBudget.ts`,
      `_shared/resendDelivery.ts`, `_shared/legalVersions.ts`,
      `tests/security/mailBudget.test.ts`, `tests/security/resendDelivery.test.ts`.
- Local checks on `438ad80`: `lint:check` ✅, `typecheck` ✅, `test` ✅ (203 files
  passed, 2 skipped; 3067 tests passed, 10 skipped), `build` ✅.
- CI on `438ad80` (push and pull_request runs): `checks` ✅, **`supabase-local` ✅**,
  `supabase-drift` ✅, `omr-service` ✅, Vercel Preview Comments ✅, Supabase Preview
  skipped. No flake re-runs were needed.
- Marked ready for review, then merged with `merge_method=merge` at 2026-10-21 23:51:38Z.
- **Merge commit on dev: `225bd64afb5a61502f3308c5018b1df0cceab7cd`**, with parents
  `9b106e0` (dev) and `438ad80`. GitHub shows #62 merged into `dev`.

## 3. #61 `mh/district-seats`: merged (continuation run)

- Reviewed SHA: `a472674a7d86990642271506bbb8b7c5cc92ac5e`. It was still the head on
  origin and on GitHub when the continuation run started.
- I merged `origin/dev` (`225bd64`) into the branch:
    - **Conflict-resolution merge commit `8a6022ca72ddd39414e9f53ea1637673d78dc183`**, with
      parents `a472674` (the reviewed head, first parent) and `225bd64`. Authored by Max
      Harris. It went to `mh/district-seats` as a fast-forward push.
    - Conflicted files:
        - `scripts/apply-migrations.sql`: regenerated with `npm run migrations:mirror`
          (86 files, 84 mirrored).
        - `tests/migrationRecoverability.test.ts`: union of the job map, 5 jobs
          (billing-mail-outbox, content-notice-retry, district-seat-reconcile, imslp-sync,
          omr-sweep). #62's static block is kept. The `it(...)` title combines both sides'
          wording.
    - **Approved stub fix (Cleffy decision 41), in the same merge commit:** in
      `tests/billing/districtSeats.test.ts`, `storeFor`'s `WebhookStore` literal got two
      no-op stubs, `recordPurchaseNotice: async () => {},` and
      `recordCancellationNotice: async () => {},`, following
      `tests/billing/resubscribe.test.ts`. It is test-only; nothing else was changed.
- Local checks on `8a6022c`: `lint:check` ✅, `typecheck` ✅ (the earlier TS2739 is gone),
  `test` ✅ (209 files passed, 5 skipped; 3253 tests passed, 13 skipped), `build` ✅.
- CI on `8a6022c` (push and pull_request runs, 39698286379 and 39698292176): `checks` ✅,
  **`supabase-local` ✅**, `supabase-drift` ✅, `omr-service` ✅, Vercel Preview Comments ✅,
  Supabase Preview skipped. No flake re-runs were needed.
- Marked ready for review, then merged with `merge_method=merge` (with
  `expectedHeadSha=8a6022c`) at 2026-10-22 00:16:25Z.
- **Merge commit on dev: `6adde0551a4a882bfd997e7e2b53770fe806939c`**, with parents
  `225bd64` (dev) and `8a6022c`. GitHub shows #61 merged into `dev`. Dev's tree equals
  `8a6022c`'s tree.

### The earlier run's notes on #61 (history)

- **I pushed nothing to `mh/district-seats`** (in the earlier run).
- I merged `origin/dev` (`225bd64`) into it locally. Only two files conflicted:
    - `scripts/apply-migrations.sql`: regenerated (86 files, 84 mirrored).
    - `tests/migrationRecoverability.test.ts`: union of 5 jobs (billing-mail-outbox,
      content-notice-retry, district-seat-reconcile, imslp-sync, omr-sweep).
- **Why I stopped:** the merged tree fails `npm run typecheck`, and CI's `checks` job runs
  that same step:

    ```
    tests/billing/districtSeats.test.ts(147,11): error TS2739: Type '{ claimEvent: ...; ... 14 more ...; log: ... }'
    is missing the following properties from type 'WebhookStore': recordPurchaseNotice, recordCancellationNotice
    ```

    This is a semantic conflict. Git sees no conflicting lines, but the result doesn't
    compile:
    - #62 added two required methods to `WebhookStore` in `_shared/stripeEvents.ts`.
    - #61's new test (`storeFor` in `tests/billing/districtSeats.test.ts`, from commit
      `5a9feef`) builds a `WebhookStore` literal without them.
    - Each PR compiles on its own; the combination does not.
    - Lint passes, and all tests pass, because vitest doesn't typecheck.

    Fixing it means changing code beyond conflict resolution, which the packet rules out
    ("Resolve only the conflicts. Don't make any other code changes."). So I merged nothing
    more, did not push a branch I knew would fail CI, and backed out the local merge.

- **Proposed fix** (not applied). Add two no-op stubs to `storeFor`'s store literal in
  `tests/billing/districtSeats.test.ts`, the way `tests/billing/resubscribe.test.ts` on
  dev already does:

    ```ts
            recordPurchaseNotice: async () => {},
            recordCancellationNotice: async () => {},
    ```

    This is test-only. It goes either in the `origin/dev` → `mh/district-seats` merge commit,
    or on dev in a small PR. It needs Max's (or Codex's) OK, because it is code outside the
    reviewed heads.

## 4. #64 `mh/launch-consent`: merged (continuation run)

- Reviewed SHA: `82d32c7052846f1b7827cea2eac48e3cd3152ad9`. It was still the head on
  origin and on GitHub right before I touched the branch (after #61 merged).
- I merged `origin/dev` (`6adde05`, with #61) into the branch:
    - **Conflict-resolution merge commit `420c19ea6fc3d88e2d3bc839724708f105ff7e63`**, with
      parents `82d32c7` (the reviewed head, first parent) and `6adde05`. Authored by Max
      Harris. It went to `mh/launch-consent` as a fast-forward push.
    - Conflicted files (the same six as the earlier rehearsal) and how I resolved them:
        - `scripts/apply-migrations.sql`: regenerated with `npm run migrations:mirror`
          (**96 files, 94 mirrored**).
        - `tests/migrationRecoverability.test.ts`: union of the job map, **10 jobs**:
          billing-mail-outbox, content-notice-retry, district-seat-reconcile, imslp-sync,
          omr-sweep, retention-archived-students, retention-compact-tombstones,
          retention-rate-limits, retention-stale-guests, retention-support-messages. #62's
          static block is kept; both sides' explanatory comments are kept.
        - `src/sync/syncEngine.ts`: the `applyServerRow` gate is
          `!this.watermarkHeld && state?.checkedSeq !== undefined && row.seq > state.watermarkSeq`,
          writing `{ ...state, docId, watermarkSeq: row.seq }`. Both comments are kept. #63's
          noteGap/hold/release, #64's compaction-floor check and `checkedSeq` saving, and
          #61's read-only-seat hold all came through the auto-merge untouched. Both adapters
          are kept (`fetchResyncFloor`, `fetchSeatReadOnly`).
        - `src/sync/syncEngine.test.ts`: #64's `checkedSeq` assertion is kept, with #63's
          note that the watermark is held until the first pull.
        - `src/sync/realtimeChannel.test.ts`: both sides' tests are kept (#64's presence-names
          test, then #63's takedown-topic tests), with #63's `TopicEpochRead` shape.
        - `src/types/database.ts`: both RPC types (`annotation_resync_floor`,
          `caller_seat_read_only`).
    - No other change. (`src/sync/annotationStore.ts` is not Prettier-formatted, but it is
      byte-identical to #64's reviewed head and CI doesn't check formatting, so I left it.)
- Local checks on `420c19e`: `lint:check` ✅, `typecheck` ✅, `test` ✅ (219 files passed,
  5 skipped; 3381 tests passed, 13 skipped, including both
  `districtBillingCanonical.test.ts` files and the recoverability test), `build` ✅.
- CI on `420c19e` (push and pull_request runs, 39699108773 and 39699111889): `checks` ✅,
  **`supabase-local` ✅**, `supabase-drift` ✅, `omr-service` ✅, Vercel Preview Comments ✅,
  Supabase Preview skipped. No flake re-runs were needed.
- Marked ready for review, then merged with `merge_method=merge` (with
  `expectedHeadSha=420c19e`) at 2026-10-22 00:25:54Z.
- **Merge commit on dev: `208cb5ffc9e339f15059b1bd07629e9d2cd563ec`**, with parents
  `6adde05` (dev) and `420c19e`. GitHub shows #64 merged into `dev`. Dev's tree equals
  `420c19e`'s tree.

### The earlier run's rehearsal of #64 (history)

- To save time later, I rehearsed the final merge in a scratch worktree. #64 at
  `82d32c7` merged with a local, unpushed #61 resolution (`6e7b836`, tree `064d762`, the
  same tree the real #61 merge produced). Nothing from the rehearsal was pushed.
    - Conflicts: `scripts/apply-migrations.sql`, `src/sync/syncEngine.ts`,
      `src/sync/syncEngine.test.ts`, `src/sync/realtimeChannel.test.ts`,
      `src/types/database.ts`, `tests/migrationRecoverability.test.ts`.
    - Resolution, per the packet:
        - The `applyServerRow` gate is
          `!this.watermarkHeld && state?.checkedSeq !== undefined && row.seq > state.watermarkSeq`,
          writing `{ ...state, docId, watermarkSeq: row.seq }`.
        - The rest was a union: both adapters (`fetchResyncFloor`, `fetchSeatReadOnly`); both
          RPC types (`annotation_resync_floor`, `caller_seat_read_only`); #64's presence-names
          test plus #63's takedown-topic tests, with #63's `TopicEpochRead` shape; and #64's
          `checkedSeq` assertion.
    - Result: mirror **96 files, 94 mirrored**. The recoverability map has **10 jobs**:
      billing-mail-outbox, content-notice-retry, district-seat-reconcile, imslp-sync,
      omr-sweep and the 5 retention-* jobs.
    - Checks: lint ✅. Tests ✅: 219 files passed, 5 skipped; 3381 tests passed, 13
      skipped, including `districtBillingCanonical.test.ts`, which pins the district_billing
      sha256 `a3043de5…`.
    - Typecheck ❌, with **only** the same `districtSeats.test.ts` error. So once that is
      fixed at the #61 step, nothing else is expected to block #64.

## Final state

- `dev` is at **`225bd64afb5a61502f3308c5018b1df0cceab7cd`**: #63 and #62 are merged; #61 and
  #64 are not. Migrations on dev: 77 files, 75 mirrored. Recoverability job count on dev: 4. The expected 96/94 and 10 depend on #61 and #64.
- Shared files on dev are byte-identical to #62's version (blob SHAs match):
  `_shared/mailBudget.ts`, `_shared/resendDelivery.ts`, `_shared/legalVersions.ts`, and
  `tests/security/mailBudget.test.ts` / `resendDelivery.test.ts`. The district_billing
  check (sha256 `a3043de5…`) doesn't apply yet, because neither #61 nor #64 is merged.
- Dev CI on `9b106e0` (#63 merge): `checks`, `supabase-drift` and `omr-service` ✅ (push
  and PR runs), Vercel ✅, Supabase Preview ✅.
- **Dev CI on `225bd64` (#62 merge, the latest commit on dev): all green.** `checks` ✅,
  **`supabase-local` ✅**, `supabase-drift` ✅ and `omr-service` ✅ (push and PR runs),
  Vercel Preview Comments ✅, Supabase Preview ✅.

## Automatic deployments (observed only; I applied nothing)

- **Hosted dev Supabase (`qdbnlrgylelelvwbkvnm`): it probably deployed.** The Supabase
  GitHub integration's **"Supabase Preview" check ran and succeeded on both dev merge
  commits**, with links to project `qdbnlrgylelelvwbkvnm`:
    - `9b106e0` at 23:43:10–23:43:39Z
    - `225bd64` at 23:52:13–23:52:47Z

    On the PR heads it was "skipped". Its check output is empty, so I can't tell from GitHub
    exactly what it applied. Most likely it pushed #63's and #62's migrations, and maybe
    `config.toml`, to hosted dev. I did not open the project to check (hosted Supabase is
    off-limits). Max should check the dev project's migration history. #62's hosted steps
    (Stripe Tax, the Vault secrets for `billing_outbox_url` / `billing_outbox_secret`, and
    deploying functions) are still manual. The `billing-mail-outbox` cron posts nowhere until
    the Vault secrets exist.

- **Vercel:** Preview deployments only, from `vercel[bot]`, one per push: `9b106e0`,
  `438ad80`, `225bd64`, and the report branch. There has been no Production deployment
  since 2026-08-29 (`cf1e968`, main). Whether the dev alias (e.g. dev.cleffy.io) now
  serves `225bd64` depends on Vercel's branch-alias settings, which I can't see from here.
- Prod Supabase (`jibgwgosihadbjgxdsfe`), `main`, PR #54 and live Stripe: untouched.

## Open questions for Max

1. **Approve the two-line test fix for #61** (above): put it in the #61 conflict-resolution
   merge commit, or land it on dev first. After that, #61 then #64 should go through as
   rehearsed; the only typecheck error in the four-way rehearsal is this one.
2. **Hosted dev Supabase:** confirm what the integration applied after the #63 and #62
   merges (see above). With #61 and #64 still out, dev now has 77 migrations.
3. `SETUP_SUPABASE.md` is not Prettier-formatted on dev. That predates this work, and CI
   doesn't check it. I left it as it was.

## Environment

- Ran in the Cleffy cloud environment **`env_01WAd3yiz3qpSnsofpyEwCh2`**
  (`anthropic_cloud`), not Sandbox. I confirmed it at the start with `get_session` for this
  session.
- I never started the local Supabase stack: none of the steps here needed it, because CI's
  supabase-local covered the DB proofs. No hosted project, live Stripe or secret was
  touched. I sent no messages to any session or person.
- Pushes made:
    - `mh/launch-checkout`: one fast-forward, to `438ad80`.
    - `claude/lc-merge-dev-report`: fast-forwards only.

    Nothing was force-pushed, and nothing was pushed directly to `dev`.

STATUS: STOPPED typecheck-failed #61 (checks would fail: tests/billing/districtSeats.test.ts WebhookStore mock lacks #62's recordPurchaseNotice/recordCancellationNotice; the fix is a code change beyond conflict resolution and needs approval). #63 and #62 are merged into dev; #61 and #64 are not merged.
