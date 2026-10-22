# Launchfix P6 fix round 1 report: PR #67 (go-live runbook, docs only)

Session: https://claude.ai/code/session_01L1e851aCDgTPixtnpLLFcB

The packet's report path, `/workspace/cleffy-launchfix-p6-fix1-report.md`, is on Max's machine, so this report is not written there. It is committed only on the scratch branch `claude/launchfix-p6-fix1-report`, as `cleffy-launchfix-p6-fix1-report.md`, one commit on top of PR #67's final head. It is not on the PR branch.

## Summary

- **PR:** #67, https://github.com/maxharris1/Cleffy/pull/67. It is still a **draft**, from `mh/launchfix-p6-golive-docs` into `dev`. No reviewers were requested, and no new PR was opened.
- **Starting SHA:** `4ca528742b2fd2624672f35e49248652edfde7b0`. `origin/mh/launchfix-p6-golive-docs` was at exactly this SHA when the session started, and had not moved when I pushed.
- **New PR #67 head:** `7bb274d253f43b9c362d0587f38295a602fcbef7`. This was a fast-forward push. Nothing was force-pushed.
- **Base:** `origin/dev` = `47e9b38f2dba36fdce852c80948245da344bcc20`, unchanged.
- **Environment:** the **Cleffy cloud environment** `env_01WAd3yiz3qpSnsofpyEwCh2`, **not Sandbox**. Confirmed at the start with `get_session`: `environment_id: env_01WAd3yiz3qpSnsofpyEwCh2`, `environment_kind: anthropic_cloud`.
- **Commit identity:** every commit is authored by Max Harris <drumaxter@gmail.com>.
- **Scope:** docs only. The diff touches `DEPLOY.md`, `SETUP_SUPABASE.md` and a comment in `.env.example`. No code, no migrations, no config, no CI.
- **Done-when:**
    - #67 is fast-forwarded;
    - local checks pass;
    - CI is green on the new head (see the CI section);
    - this report gives the new head, the runbook changes, the Max-only steps and the open questions.

## Commits

| SHA        | Branch                                 | Summary                                                                      |
| ---------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| `7bb274d2` | `mh/launchfix-p6-golive-docs` (PR #67) | docs(deploy): gated manual go-live, traffic freeze, backup, retention pauses |
| (report)   | `claude/launchfix-p6-fix1-report` only | report: launchfix P6 fix round 1 (this file). Its SHA is the branch head.    |

## The new runbook, in order

DEPLOY.md → "Go-live 2026-10: fresh production (wipe first)" now has steps 0–21, plus _Abort and restore_. The reference subsections after it are kept and their step references updated: _Before scheduling `retention-district`_, _Stripe webhook events_, _Refunds_, _PITR_ and _STRIPE_MODES_.

| Step | What                                                                                                                                                                                                                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Turn **Deploy to production** off (integration) before anything else. Check that `git_branch` is `""` via `GET /v1/projects/…/branches`.                                                                                                                               |
| 1    | Land P1–P6 and get CI green. **Pin `GOLIVE_SHA`.** Re-count the migrations and functions. `git grep cron.schedule` for new jobs.                                                                                                                                       |
| 2    | Max's prerequisites (unchanged). **New:** two rehearsals on the `dev` branch with Stripe test clocks, which gate the sitting: renewal, and district invoice and grace.                                                                                                 |
| 3    | Pick a time outside lesson hours, clear of 03:00–03:50 UTC (and 04:23 UTC on a Sunday). Note Max's IPs. **One worktree at `GOLIVE_SHA`, CLI 2.121.0, `supabase link`, `test` of `supabase/.temp/project-ref`.** A `stage()` helper copies `supabase/` up to a version. |
| 4    | Read-only inventory: Edge secret names, a leftover `STRIPE_PRICE_*` audit, the Vercel `VITE_*` build env table, and the OMR settings.                                                                                                                                  |
| 5    | Snapshot counts (users, identities, tables, objects per bucket, `pg_policies` per schema, live subscriptions), taken again after the freeze.                                                                                                                           |
| 6    | **Freeze:** Vercel Firewall allow/deny rules, sign-ups closed, live webhook disabled (`FREEZE_AT` recorded), Stripe reconciled directly, open Checkout sessions expired.                                                                                               |
| 7    | **Backup:** roles, the default schema, the `auth,storage,realtime` schemas, `public,auth,storage` data, history. Object list and download. **Restore check** on a clean local baseline with FK re-validation.                                                          |
| 8    | **Max confirms in writing**, then the wipe: empty Storage, drop sequences, `db reset --linked --no-seed --workdir` with `main`'s 26 staged, **delete the caller Vault secrets**, then checks.                                                                          |
| 9    | Edge secrets: the required list, plus test pair, legacy aliases, price overrides, the AI key and OMR **unset**.                                                                                                                                                        |
| 10   | Auth settings, with sign-ups kept closed.                                                                                                                                                                                                                              |
| 11   | **Migrations by hand in three staged batches:** 4 (to `20260902120000`, then pause `imslp-sync`), 60 (to `20261021120300`, then pause the five `retention-*`), then the rest (6 + P1–P5). `--dry-run` before each.                                                     |
| 12   | `supabase functions deploy --project-ref jibgwgosihadbjgxdsfe` (all 23, `verify_jwt` from config), then a bucket check.                                                                                                                                                |
| 13   | Backend checks: `STRIPE_MODES`, P1's row, grants, **cron with the paused state required**, `verify_jwt`, history, advisor.                                                                                                                                             |
| 14   | Vault created fresh, then `imslp-sync` resumed.                                                                                                                                                                                                                        |
| 15   | `content_moderators` row for Max.                                                                                                                                                                                                                                      |
| 16   | Vercel env audit done, then **Max merges #54**. Vercel builds it behind the freeze, and Supabase gets nothing. Bundle check.                                                                                                                                           |
| 17   | Before User Created hook ON, sign-ups open, one sign-up and one share-link join.                                                                                                                                                                                       |
| 18   | Smoke part A (no Stripe, includes T-11). Then **re-enable the live webhook and replay the freeze window**. Then part B (real purchase, roster and invite, renewal replay, refund and cancel, deletes).                                                                 |
| 19   | **Re-enable Deploy to production**, and check `git_branch="main"`.                                                                                                                                                                                                     |
| 20   | Open when the listed criteria hold: firewall rules off, sign-ups confirmed open, watch for 48 hours.                                                                                                                                                                   |
| 21   | T-6 dry-run counts, then `retention-*` resumed, then the cron check re-run.                                                                                                                                                                                            |

## Codex findings → changes

- **MAJOR 1: the backup omits auth and Storage.**
    - Step 7.1 dumps `--schema auth,storage,realtime` (schema) and `--data-only --schema public,auth,storage` (data) explicitly.
    - Verified on the local stack with CLI 2.121.0. The default schema dump leaves out the **15 storage and 5 realtime RLS policies**. The explicit data dump carries 26 `auth` and 9 `storage` tables, `auth.users` and `storage.objects` among them.
    - Step 7.2 lists the objects to CSV before downloading, and checks count and bytes per bucket.
    - Step 7.3 restore check:
        - restores into a clean baseline: a scratch worktree with its own `project_id`, seeding off and no migrations;
        - gives the restore order (roles, schema, managed-schema policies, data);
        - notes that the data dump runs in `replica` mode, so it **re-validates every `public` FK** afterwards. That pass was tested on the local stack: 72 keys re-added in a rolled-back transaction. The two storage links are checked by query, because `storage` is owned by `supabase_storage_admin`, and an `alter table` there was refused ("must be owner of table objects");
        - compares the counts, including `auth.identities` and `pg_policies`;
        - keeps the `omr_jobs` setval check.
    - Kept short, per decision 3.
- **MAJOR 2: traffic stays open.**
    - Step 6 freezes before the backup:
        - a Vercel Firewall custom rule pair. Bypass for Max's IPs and Deny for everyone else on `cleffy.io` / `www.cleffy.io`. It needs no code and no deploy, takes effect at once, is available on all plans per Vercel's docs, and is rolled back by disabling it;
        - sign-ups closed;
        - the live webhook disabled.
    - Stripe is reconciled from Stripe, not the DB: every status except `canceled` / `incomplete_expired`, plus open Checkout sessions expired. The DB query was widened to the same statuses.
    - The webhook replay since `FREEZE_AT` is step 18. The reopen criteria are step 20.
    - The frontend merge (step 16) happens behind the freeze. The new bundle is served on the real hostname to Max only, so it is smoke-tested against the real origin/hostname rules.
- **MAJOR 3: retention activation.**
    - Each `retention-*` job is paused with `cron.alter_job` immediately after batch 2, which ends at `20261021120300_retention_jobs`.
    - The sitting avoids 03:00–03:50 UTC and Sunday 04:23.
    - The step 13.4 cron check **requires** the paused state: an expected `active` column, and "should be paused" is reported as a failure.
    - Step 21 runs T-6 dry-run counts, written to match each job's predicate, then resumes the jobs explicitly. The counts were checked on the local stack: all 0.
- **MAJOR 4: IMSLP pause under automatic migration.**
    - Under decision 1 there is no automatic migration. Batch 1 ends exactly at `20260902120000`, and `imslp-sync` is paused right after it. It stays paused through all 60 of batch 2, including `20260910160001`.
    - Step 8.4 **deletes every caller Vault secret** right after the reset, so any tick before the pause, or any other caller cron, only logs "missing — skip". Verified on the local stack, which has no Vault: `imslp-sync`, `billing-mail-outbox` and `omr-sweep` ran as succeeded no-ops.
    - Vault is created fresh in step 14, only after functions, schema and secrets are checked. Then `imslp-sync` is resumed.
    - **Survives job recreation:** each scheduling migration unschedules and then reschedules, so a later migration that reschedules a job would re-activate it. At 47e9b38f no later migration reschedules `imslp-sync` or any `retention-*`. Step 1's `git grep` re-checks this on `GOLIVE_SHA`.
    - On the local stack (pg_cron 1.6.4), a plain `cron.schedule` over a paused job's name **kept it paused**.
- **MAJOR 5: smoke coverage and backend disablement.**
    - Step 9 makes `ANTHROPIC_API_KEY` / `ANALYZE_NOTES_MODEL` **unset**, citing `analyze-annotations/index.ts:185–188`. OMR is unset too.
    - Step 18 adds:
        - **T-11**: an authenticated `analyze-annotations` request, valid up to the key check, must answer `503 ai_unavailable`;
        - **guest email attachment**;
        - **invite mail**: student by email, then `/student/welcome`;
        - **inbound alias tagging**: `[privacy]` / `[legal]` / `[support]`, plus `support_messages` rows;
        - **renewal webhook replay**: resend `invoice.paid`, one `stripe_events` row, period end unchanged;
        - **district invoice and grace**, as a concrete gate on the `dev` branch with test clocks (step 2), plus a refusal check on production.
    - The real purchase is now **Teacher** monthly, because the roster and the invite need Teacher: since `20260828120000`, free has `students: 0`. The old runbook's roster test on a free account could not have passed.
    - I could **not** run the T-11 request locally. The cloud container's edge runtime failed to boot `analyze-annotations`: its `npm:@anthropic-ai/sdk` import hit the agent proxy's TLS (`invalid peer certificate: UnknownIssuer`). The check rests on the code.
- **MINOR: pin the target.**
    - Step 3 sets up one worktree at the pinned `GOLIVE_SHA` with CLI 2.121.0 (CI's pin), then `supabase link --project-ref jibgwgosihadbjgxdsfe`, then `test "$(cat supabase/.temp/project-ref)" = jibgwgosihadbjgxdsfe`. The test is repeated before every destructive command. Then `migration list --linked`.
    - There is one wipe method, written out: empty Storage, drop sequences, then `db reset --linked --no-seed --workdir <stage of main's 26>`. `main`'s 26 files were verified to be an unchanged prefix of `dev`'s, so no second checkout is needed.
    - Abort and restore steps are given per phase.
    - Fixed the `supabase db reset --linked --project-ref <ref>` example in _Resetting a remote database_: link, check, then `--linked`. R4's `update cron.job` became `cron.alter_job`.
    - CLI 2.121.0's help does list `--project-ref` on `db push` / `db reset` / `db dump`. The runbook still never passes it to `db` commands, per decision 6.
    - The staged `--workdir` approach was proven on the local stack: a stage with only 30 files gave `DbPushMissingLocalError` against the 96-migration DB. That shows the CLI reads the stage. The runbook says to stop on that error and never run the suggested `migration repair`.
- **Inventory gaps:** all addressed in steps 4 and 9 (decision 7 below).
- **Push-to-main behaviour:** answered by decision 1. The integration is off from step 0 to step 19. The order is manual and strict, and the merge (step 16) deploys only the frontend, behind the freeze.

## Cleffy decisions → where they are

1. **Manual, gated deploy.**
    - Step 0: integration off, before anything else.
    - Steps 3, 8 and 11–12: everything by hand against the linked, checked ref.
    - Step 11: IMSLP pause between the named migrations.
    - Step 8.4: Vault withheld. Step 14: Vault reconciled before `imslp-sync` resumes.
    - Step 19: re-enabled after the smoke tests.
2. **Freeze first.** Step 6:
    - the Vercel Firewall rules, with exact steps, a check and a rollback;
    - the live webhook disabled, then re-enabled in step 18 (see deviation 1);
    - "nothing material per Max on 10/21" stated in the intro;
    - Max's written confirmation at the top of step 8, right before the wipe.
3. **Backup.** Step 7: public, auth and storage explicit (plus realtime policies), object list, and a local restore check.
4. **Retention crons.** Pause right after batch 2 (step 11.2). The time window is in step 3. T-6 counts, then re-enable as step 21.
5. **Smoke tests.** Key unset (step 9), the T-11 503 check, and the five added flows (step 18; district via the step 2 gate).
6. **Pin the target.** `supabase link` plus the `.temp/project-ref` check (step 3), one wipe method (step 8), and the `--project-ref` example fixed.
7. **Inventory.**
    - The `STRIPE_*_TEST` aliases and the legacy unsuffixed aliases are in step 9 (unset on prod) and SETUP_SUPABASE.md §6b.
    - The `STRIPE_PRICE_*` / `STRIPE_PRICE_LIVE_*` audit, including "one override replaces the whole catalogue", is in steps 4 and 9 and §6b.
    - The full Vercel `VITE_*` table is in step 4: Supabase (explicit, PROD, DEV), Stripe (explicit, LIVE, TEST, founding), the four flags, Turnstile, Sentry, and `VERCEL_GIT_COMMIT_SHA`.
    - The OMR env list is in step 4: Edge, Vault and the service.
    - `.env.example` marks `VITE_STRIPE_PUBLISHABLE_KEY` unused, and SETUP_SUPABASE.md no longer lists it as needed.
8. **PR #54 body draft.** Below. It is not committed to the PR branch, and #54 is not touched.

## Updated Max-only steps

I performed none of these. Every one is hosted, or touches money or DNS.

- **Before the sitting**
    - Step 0: Deploy to production off, and check it.
    - Step 1: land P1–P5, then #67. Regenerate the mirror, pin `GOLIVE_SHA`, re-count, `git grep cron.schedule`, and update #54's body from the draft below.
    - Step 2:
        - legal;
        - tax registrations;
        - Stripe Tax and `configure-tax.mjs` (sandbox, then live);
        - portal;
        - **all 9 webhook events on both endpoints**;
        - DNS;
        - the Resend quota;
        - the **two `dev`-branch rehearsals with test clocks** (renewal; district invoice and grace).
    - Step 3: the time slot, the IP addresses, and the worktree, CLI and link.
    - Step 4: the read-only inventories (Edge secrets, price overrides, Vercel env, OMR). Fix the Vercel env.
    - Step 5: first snapshot.
- **The sitting (steps 6–20)**
    - Step 6: freeze.
    - Step 5: snapshot again.
    - Step 7: backup and restore check.
    - Step 8: **written confirmation**, then the wipe.
    - Steps 9–10: secrets and Auth.
    - Step 11: three batches with the pauses.
    - Step 12: functions and buckets.
    - Steps 13–14: checks, then Vault and the `imslp-sync` resume.
    - Step 15: moderator row.
    - Step 16: **merge #54**.
    - Step 17: hook and test accounts.
    - Step 18: smoke tests, including the webhook re-enable and replay, the real Teacher purchase, and refund and cancel.
    - Step 19: integration back on.
    - Step 20: open and watch.
- **After opening**
    - Step 21: T-6 counts, then resume `retention-*`.
    - _Before scheduling `retention-district`_ when its conditions hold.
    - Update DEPLOY.md's Status rows 22–23 once both endpoints carry 9 events.
    - The PITR decision.
- Replace each "(confirm after P<N>)" once P1–P5 land.

## Updated PR #54 body draft

The full text follows. It is not committed on the PR branch, and #54 was not edited. Paste it into #54 once P1–P5 land and each "(confirm after …)" is filled in.

---

**Draft. Do not merge outside DEPLOY.md → "Go-live 2026-10: fresh production (wipe first)". Merging this PR is that runbook's step 16, behind a maintenance freeze, after the database and functions are already deployed by hand.**

This PR promotes `dev` to production for the launch. **Production is wiped first.** There is no data-preserving push. The Supabase GitHub integration's **Deploy to production is turned off** for the go-live (runbook step 0), so this merge applies no migration and deploys no function. Vercel builds the new bundle, and only Max can reach it until the runbook opens the site (step 20).

Counts, from the repository at `dev` 47e9b38f:

- **96 migrations** (`ls supabase/migrations | wc -l`). `main` has 26, an unchanged prefix of `dev`'s.
    - The runbook resets production to `main`'s 26 (step 8).
    - It then pushes the other **70** by hand in three batches (step 11): 4, 60 and 6, pausing `imslp-sync` after the first and the five `retention-*` jobs after the second.
- **23 Edge Functions**, the directories under `supabase/functions/` other than `_shared`. `main` has 13, all still present. All 23 are deployed by hand (step 12).

Re-count on the final head (`GOLIVE_SHA`): P1, P3, P4 and P5 add migrations, which land in the third batch unless one of them schedules a cron job. (confirm after P1 to P5)

## What ships

**From before the launch-compliance round.** This is the old body's scope, still true:

- **Scope (owner decisions).**
    - One shared annotation layer. There are no teacher/student layers, hairpins or reading mode.
    - The markup toolbar keeps production's simple layout.
    - Play-along, fingering, print-handwriting and smart import are built but off by default build flags (`src/lib/features.ts`). The flags hide the UI only. AI recognition is off on the backend because `ANTHROPIC_API_KEY` is unset on production (runbook step 9).
    - IMSLP edition picker.
- **Sharing.** Collaborator list, re-role and remove; revoke with removal; view-only 7-day links by default; leave a score; live updates.
- **Integrity.** Immutable authorship columns, and the receive-only `doc-db:{id}` topic.
- **Sync.** No dropped edits on 401/408/429. Refusals are shown. Sign-out uploads or warns. No undo resurrection. Randomized interleaving fixes (QA round 4).
- **Billing.** Live-state webhook application, so out-of-order events are harmless. Server-side PDF export claims. One entitling subscription per user. Webhook claim recovery and a subscription write lock (2026-10-12/13).
- **Library.** Keyset pagination and server search. Row-first delete with storage tombstones. Indexed visibility (2026-10-14).
- **Security.** pdf.js 6.4.299. CSP and headers. Password policy. Student-login throttle. Hardened `search_path` and grants. Turnstile hooks (inert until keyed). Guest email verification.
- **Compliance.** Self-serve account deletion, optional Sentry.
- **IMSLP.** Timeouts, size cap, host allowlist, provenance, deployment-wide pacing.
- **Perf and UI.** #59 and #60.

**Launch compliance, PRs #61–#65.**

- **#61, district seats (item 21).**
    - An admin-only per-studio seat override above Academy's 5, tied to a `send_invoice` Academy subscription, with an append-only change log.
    - The webhook records `collection_method` and maps `send_invoice` + `cleffy_plan=district` to Academy.
    - Seat count shown on the Account page.
    - Read-only seats and the grace deadline.
    - Runbook: `docs/DISTRICT_SEATS.md`.
- **#62, checkout compliance (items 13–19).**
    - Unticked auto-renewal consent and a pre-payment review step.
    - `checkout_consents`, kept 3 years.
    - Stripe Tax, with `automatic_tax` and required billing address.
    - EUR/GBP prices with VAT included.
    - Purchase and cancellation confirmations through a durable `billing_mail_outbox`.
    - Signed-out `/cancel` with a one-time link.
    - The shared mail budget `LAUNCH_MAIL_SPLIT` (60/hour, 300/day).
    - New functions: `billing-cancel` and `billing-mail-outbox`.
- **#63, legal pages and notice-and-action (items 11–12).**
    - `/privacy`, `/terms` (with the School Use Addendum), `/refunds` (14-day full refund, EU/UK withdrawal, model form) and `/copyright`. All carry "draft" banners pending counsel.
    - Public `/report` (DMCA/DSA).
    - `/admin/reports` for `content_moderators`: restrict or remove takedowns, strikes, statements of reasons, notice log.
    - New functions: `content-report`, `content-moderation` and `content-notices`.
- **#64, launch consent (items 1–10).**
    - The consent-age table and age screen on `/register` and `/join`.
    - The `before_user_created` Auth hook (switched on by hand).
    - Teacher attestation; Delete student, in one transaction.
    - Retention pg_cron jobs: archived students 12 months, guests 90 days, rate limits 1 day, support mail 24 months, weekly tombstone compaction. They ship **paused on production** until the runbook's T-6 dry-run counts are read (step 21).
    - Presence never shows emails.
    - `VITE_FEATURE_SMART_IMPORT`.
    - Tagged support forwards; no Sentry id for students.
    - District retention, shipped **paused**: `retention-district` is not scheduled. New function: `district-retention-notices`.
- **#65, IMSLP download flake.** An API call that outlasts the download budget now reports `timeout`, not `bot_check`. This fixed the test that failed twice on this PR's CI.

**Launchfix P1–P6** (re-audit 2026-10-22). (confirm after P1 to P5: replace each line with the PR number and a summary of what merged)

- **P1:** the `deployment_config` live-only row, so `entitling_billing_modes()` is `{live}` from data after a fresh replay. A fresh replay otherwise ships `{live,test}`, which is R1's landmine.
- **P2:** (confirm after P2)
- **P3:** the inbound retry cron and its Vault secrets.
- **P4:** (confirm after P4)
- **P5:** district retention behaviour. `20261022130000_district_retention_reattribution`: a student re-attributed to another district is taken off the old district's purge list, and the hard delete re-checks the attribution. `20261022130100_content_strikes_survive_deletion`: copyright strikes survive account deletion, keyed by address digest. Proofs: `tests/sql/district_retention_reattribution.sql` and `tests/sql/content_strikes_survive_deletion.sql`. (branch `mh/launchfix-p5-district-retention` at 00f48a6; confirm after P5)
- **P6 (#67):** DEPLOY.md's go-live runbook for a fresh production. It covers:
    - a manual, gated deploy (integration off; reset to `main`, then three staged batches);
    - a traffic freeze before the backup;
    - an auth/storage-complete backup with a local restore check;
    - retention and IMSLP pauses, and Vault withheld until the functions are checked;
    - backend-level smoke tests, including `503 ai_unavailable`;
    - the full 9-event Stripe webhook set (SETUP_SUPABASE.md listed 5);
    - the manual refund-and-cancel step, PITR off, and STRIPE_MODES;
    - the env/secret inventory.

    Docs only.

## Verification

- CI on the `dev` head: `checks`, `supabase-drift`, `supabase-local`, `omr-service` and Vercel. (Fill in on the final head.)
- Locally on `dev` 47e9b38f:
    - `npm run lint:check`, `typecheck` and `build` are clean;
    - `npm run test`: 219 files and 3382 tests pass, 13 skipped;
    - the local stack replays all 96 migrations.
- On that replay, the go-live runbook's checks pass:
    - the grants check returns 0 rows;
    - the `cron.job` check finds the 10 expected jobs and no `retention-district`. On production it requires `imslp-sync` and the five `retention-*` paused until steps 14 and 21;
    - `entitling_billing_modes()` reads `{live,test}` before P1's row, which is what step 13.2 corrects;
    - the T-6 retention dry-run counts return 0.
- SQL proofs from the compliance PRs, each as reported on its PR:
    - `district_seats` 58/58 (#61);
    - `launch_checkout_fixes` 46/46 and `checkout_consents` 24/24 (#62);
    - `content_moderation` 35/35 (#63);
    - `launch_consent`, `district_retention`, `district_student_scope` and `district_billing_canonical` (#64).

    Re-run on the final head (confirm after P1 to P5).

- Not yet exercised against real Stripe or Resend. The go-live smoke (step 18) does that, including one real low-price Teacher purchase, refunded and cancelled. Renewal and district invoice and grace are rehearsed on the `dev` branch with Stripe test clocks first (step 2).

## Go-live: follow DEPLOY.md → "Go-live 2026-10: fresh production (wipe first)"

In short:

- [ ] 0. Supabase **Deploy to production OFF**, verified (`git_branch` is `""`).
- [ ] 1. P1–P6 landed on `dev`, CI green, `scripts/apply-migrations.sql` regenerated. `GOLIVE_SHA` pinned and counts redone.
- [ ] 2. Max's prerequisites:
    - LLC and legal text final;
    - NY/OSS/UK tax;
    - Stripe Tax + `scripts/stripe/configure-tax.mjs`, sandbox then live;
    - portal settings;
    - **all 9 webhook events on both endpoints**;
    - SPF/DKIM/DMARC;
    - the Resend quota against the 300/day budget;
    - **`dev`-branch test-clock rehearsals: renewal; district invoice and grace**.
- [ ] 3. The sitting is outside lesson hours and clear of 03:00–03:50 UTC. One worktree at `GOLIVE_SHA`, CLI 2.121.0, linked to `jibgwgosihadbjgxdsfe`, with the ref checked.
- [ ] 4. Read-only inventory:
    - Edge secrets;
    - no `STRIPE_PRICE_*` overrides;
    - the Vercel `VITE_*` build env;
    - OMR.
- [ ] 5. Snapshot counts.
- [ ] 6. **Freeze:**
    - Vercel Firewall deny (Max bypassed);
    - sign-ups closed;
    - live webhook disabled;
    - Stripe reconciled directly;
    - open Checkout sessions expired.
- [ ] 7. Backup of public, auth, storage (and realtime policies), object list and download, **restore check** on a local baseline.
- [ ] 8. **Max confirms in writing.** Then empty Storage, reset to `main`'s 26 and withhold the Vault caller secrets. `pd_pdf_store` and `playalong_corpus*` now exist only in the backup.
- [ ] 9. Production Edge secrets, with the AI key, OMR, the Stripe test pair, legacy aliases and price overrides **unset**.
- [ ] 10. Auth: Confirm email ON, password policy, redirect URLs including `www`, SMTP. Sign-ups stay closed, **hook still OFF**.
- [ ] 11. Migrations by hand: batch 1 (4), pause `imslp-sync`; batch 2 (60), pause `retention-*`; batch 3 (the rest).
- [ ] 12. All 23 functions deployed by hand; buckets checked.
- [ ] 13. Checks:
    - `STRIPE_MODES=live`;
    - P1's row, with `entitling_billing_modes()` = `{live}`;
    - the grants check;
    - the `cron.job` check, with the pauses required;
    - `verify_jwt` per function.
- [ ] 14. Vault secrets (`imslp_sync`, `billing_outbox`, `content_notice`, `district_notice`, + P3's), then resume `imslp-sync`.
- [ ] 15. `content_moderators` row for Max.
- [ ] 16. **Merge this PR**, behind the freeze. Vercel builds; Supabase gets nothing.
- [ ] 17. Before User Created hook ON, sign-ups open, then one sign-up and one share-link join.
- [ ] 18. Smoke tests:
    - part A: includes `503 ai_unavailable`, guest email, alias tagging;
    - re-enable the live webhook and replay the freeze window;
    - part B: a real Teacher purchase, roster and invite mail, renewal replay, refund **and** cancel, delete the throwaway accounts.
- [ ] 19. Deploy to production back ON.
- [ ] 20. Open: firewall rules off, sign-ups confirmed open, watch for 48 hours.
- [ ] 21. T-6 retention dry-run counts, then resume `retention-*`.

`retention-district` stays unscheduled until the runbook's "Before scheduling `retention-district`" holds.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

---

## Local checks

Run on `7bb274d2` before the push, in the Cleffy environment.

| Check                                              | Result                                                                                                                                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint:check`                               | ✅ exit 0                                                                                                                                                                                                 |
| `npm run typecheck`                                | ✅ exit 0                                                                                                                                                                                                 |
| `npm run test` (full suite)                        | ✅ exit 0: **219 files passed, 5 skipped (224); 3382 tests passed, 13 skipped (3395)**. `VITE_SUPABASE_URL=` / `VITE_SUPABASE_ANON_KEY=` were blanked as in CI, because `cloud:up` writes a `.env.local`. |
| `npm run build`                                    | ✅ exit 0                                                                                                                                                                                                 |
| `npx prettier --check DEPLOY.md SETUP_SUPABASE.md` | ✅ "All matched files use Prettier code style!"                                                                                                                                                           |

Prettier has no parser for `.env.example`, so it was not run on it. The change there is a comment plus an emptied example value.

## Local-stack evidence (`npm run cloud:up`, dev 47e9b38f, CLI 2.121.0)

The stack was stopped with `npm run cloud:down` afterwards. No seeded account or score was changed. Every write was inside a rolled-back transaction.

- **Pause.** `cron.alter_job(jobid, active := false)` paused `imslp-sync` and all five `retention-*`, and a rollback restored them. pg_cron is 1.6.4. A plain `cron.schedule` over a paused job's name kept it paused.
- **Vault.** `delete from vault.secrets … returning name` works as `postgres`.
- **Ticks without Vault.** With no Vault secrets, `cron.job_run_details` shows `imslp-sync`, `billing-mail-outbox` and `omr-sweep` as `succeeded`. `content_notice_retry_tick` has the same "missing — skip" branch (`20261020150000_content_moderation.sql:473`).
- **Default schema dump.** It has 50 policies and none on `storage.objects`. The live database has `public` 50, `storage` 15, `realtime` 5 and `cron` 2. The `--schema public,storage` dump has 65.
- **Data dumps.** The `--data-only --schema public,auth,storage` dump COPYs 61 public, 26 auth and 9 storage tables.
- **FK re-validation.** 72 public keys re-added cleanly. On `storage`, it was refused with "must be owner" (so the runbook checks storage's two links by query: 0 and 0).
- **T-6 dry-run counts:** 0 / 0 / 0 / 0 / 0.
- **Staged push.** A 30-file `--workdir` stage gave `DbPushMissingLocalError` against the full DB, which proves the stage is read. The worktree dry-run said "up to date".
- **Batch sizes at 47e9b38f:** 4 / 60 / 6. `main`'s 26 migrations are an unchanged prefix (`git diff --name-status origin/main origin/dev -- supabase/migrations` shows only `A`), and none of `main`'s functions were removed on `dev`.
- **T-11.** Could not be exercised. The local edge runtime cannot fetch `npm:@anthropic-ai/sdk` through the container's proxy (TLS `UnknownIssuer`), so the worker fails to boot (`BOOT_ERROR` 503, not the app's 503).

## CI on the final head (`7bb274d2`)

All checks on head `7bb274d253f43b9c362d0587f38295a602fcbef7` are green. Two CI workflow runs, both `completed / success`:

- run **39732642683**, the `pull_request` event;
- run **39732637032**, the `push` event.

| Check            | Run 39732642683 (pull_request) | Run 39732637032 (push)        |
| ---------------- | ------------------------------ | ----------------------------- |
| `checks`         | ✅ success (job 119670959466)  | ✅ success (job 119670942271) |
| `supabase-local` | ✅ success (job 119670960064)  | ✅ success (job 119670942507) |
| `supabase-drift` | ✅ success (job 119670959710)  | ✅ success (job 119670942451) |
| `omr-service`    | ✅ success (job 119670959737)  | ✅ success (job 119670942425) |

Checks outside GitHub Actions:

- **Vercel** (commit status): ✅ success, "Deployment has completed".
- **Vercel Preview Comments:** ✅ success (119671156916).
- **Supabase Preview:** skipped (119670939064). It is skipped on every docs-only PR, as it was on 4ca52874.

No fix round was needed.

## Files touched

- `DEPLOY.md`:
    - the "Go-live 2026-10" section rewritten as steps 0–21 plus _Abort and restore_;
    - the go-live Status row reworded, with the same column widths, so the table is otherwise untouched;
    - references fixed in _Before scheduling `retention-district`_ (steps 14 and 13.4), _PITR_ (steps 7.1 and 7.3) and _STRIPE_MODES_ (step 13.2);
    - the "superseded" note under the old release checklist and the "historical" note under Recovery reworded (no "replays every migration");
    - a go-live note above the GitHub integration's **Gate**;
    - the `db reset --project-ref` example fixed;
    - R4 uses `cron.alter_job`, with a note.
- `SETUP_SUPABASE.md` §6b:
    - the secrets table adds `STRIPE_*_TEST`, marks the legacy aliases, and makes `STRIPE_PRICE_*` / `STRIPE_PRICE_LIVE_*` optional overrides that are normally unset (all-or-nothing per mode);
    - `VITE_STRIPE_PUBLISHABLE_KEY` is marked unused.
- `.env.example`: a comment marks `VITE_STRIPE_PUBLISHABLE_KEY` as unused, and the example value is emptied.
- **No** code, migrations, `config.toml`, CI, `scripts/apply-migrations.sql` or tests.

## Deviations

1. **Webhook re-enable timing (decision 2).** The packet says to re-enable the Stripe webhooks "after the smoke tests". The real purchase, the refund and cancel, and the renewal replay are smoke tests that need the webhook. So step 18 splits the smoke tests: part A runs with the webhook still disabled, then the webhook is re-enabled and the freeze window replayed, then part B runs the billing tests. Everything else stays frozen through step 20. Open question 1.
2. **Wider retention window.** The packet names 03:00–03:40 UTC. The runbook says 03:00–03:50 UTC plus Sunday 04:23, because `retention-support-messages` runs at 03:47 and `retention-compact-tombstones` at 04:23 on Sundays.
3. **Teacher instead of Personal** for the real purchase. The roster and the invite-mail tests need Teacher, because free and Personal have `students: 0`.
4. **District invoice and grace** is a gate run on the `dev` branch (sandbox, test clocks) in step 2, not a live-money run on production. Codex's fix allows "make their successful prior execution a concrete gate". Production gets only a refusal check.
5. **Branch name.** The harness pre-assigned `claude/launchfix-p6-fix1-docs-80oez9`. Per Max's instructions I used only `mh/launchfix-p6-golive-docs` (PR #67) and `claude/launchfix-p6-fix1-report`. Nothing was pushed to the pre-assigned branch.
6. **Sources.** `/workspace` was not available. I used the Codex review and the #54 draft reproduced in my prompt, the earlier report on `claude/launchfix-p6-report` (read only), the repo, the local stack, and public Vercel and Supabase docs. From the docs: Vercel WAF custom rules (actions, Hostname and IP Address parameters, all plans, immediate effect) and Instant Rollback; Supabase's GitHub integration (what Deploy to production deploys). No hosted account was touched.
7. **PR #67's description is stale.** It describes the old 12 steps. I did not edit it, because the instructions only covered keeping it a draft. Open question 2.

## Open questions

1. **Webhook re-enable timing** (deviation 1): is re-enabling before the billing smoke tests what decision 2 intends?
2. **PR #67 body:** should it be updated to describe steps 0–21? I can do that in a follow-up if you want.
3. **Unsetting the Stripe test pair and legacy aliases on production** (step 9). This is my call, as defence in depth with `STRIPE_MODES=live`. `delete-account` and the other functions read only `STRIPE_SECRET_KEY_LIVE` in live mode. Confirm.
4. **Vercel Firewall Hostname condition.** Vercel's docs list Hostname and IP Address as rule parameters, but I could not see the operator names (for example "is any of") in the rendered docs. If the form differs, the intent is: Bypass for Max's IPs on `cleffy.io` / `www.cleffy.io`, and Deny for everyone else on those hosts.
5. **Does `db reset --linked` keep Vault?** Step 8.4 deletes the caller secrets either way, and step 14 creates them fresh. Unverified on hosted.
6. **`supabase storage cp -r ss:///<bucket>`** for the download was carried over from the earlier runbook, and is not re-verified here (experimental flag). The CSV list check catches a short download.
7. **"(confirm after P<N>)" placeholders kept:**
    - P1's `deployment_config` insert (step 13.2) and any P1–P5 tables for the grants list (13.3);
    - P3's inbound-retry job (13.4), Edge secret (9) and Vault names (8.4, 14);
    - any P1–P5 migration that schedules a cron job (steps 1 and 11.3);
    - P5's hourly notice-sender cron (_Before scheduling `retention-district`_);
    - P2 and P4 in the #54 draft;
    - the re-audit T-id mapping (step 18), and re-audit §4 item 8 for the required/optional split (step 9).
8. **Refund log location** (still "(confirm where with Max)" in _Refunds_).
9. **Hook via the Management API**, from the earlier report and still open. The runbook uses the dashboard path.
10. **The local T-11 probe** could not run in this container (proxy TLS). Max could run step 18's `curl` against a local stack on a normal network before the sitting.

## Hosted steps left for Max

I performed none. Nothing hosted was touched:

- not `jibgwgosihadbjgxdsfe` or `qdbnlrgylelelvwbkvnm`;
- not Vercel;
- not Stripe (live or test);
- not Resend;
- not PR #54.

The list is "Updated Max-only steps" above: the whole runbook, steps 0–21. Also:

- subscribe both Stripe endpoints to all nine events (possible now);
- the PITR decision;
- replace each placeholder once P1–P5 land;
- paste the #54 body from this report.

## Expected conflicts with the other launchfix PRs

- **`DEPLOY.md`.**
    - The go-live section (lines ~50–1165) was rewritten wholesale. Any P1–P5 PR that edits text inside it will conflict. An example is P1 documenting its `deployment_config` step, or P3 its Vault names. Resolve by keeping this version's structure and moving their names into the "(confirm after P<N>)" spots: steps 8.4, 9, 11.3, 13.2–13.4 and 14.
    - Smaller hunks: one Status row (same width, so no table realignment), the notes under the old release checklist and Recovery, _GitHub integration_'s Gate, _Resetting a remote database_, and R4's SQL.
- **`SETUP_SUPABASE.md` §6b:** the secrets table and two paragraphs. A PR touching the Stripe secrets table conflicts. Resolve by keeping both, then run prettier.
- **`.env.example`:** only the Stripe comment block above `VITE_STRIPE_PUBLISHABLE_KEY`. A PR adding env vars elsewhere in the file merges cleanly.
- **Migrations, `scripts/apply-migrations.sql`, tests:** not touched, so no conflict from this PR. If P1–P5 add a migration that schedules a cron job, the runbook's batch boundaries (step 11) and the expected cron list (13.4) need updating when they land.

## Environment confirmation

This session ran in the **Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2`** (`environment_kind: anthropic_cloud`), **not Sandbox**, confirmed with `get_session` at the start. I sent no message to any other session.
