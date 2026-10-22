# Launchfix P6 report: DEPLOY.md go-live runbook (docs only)

Session: https://claude.ai/code/session_01JpqtVJ4dvHMWR6g94QLnqG

The packet's report path, `/workspace/cleffy-launchfix-p6-golive-docs-report.md`, is on Max's machine, so this report was not written there. It is committed only here, on `claude/launchfix-p6-report`, as `cleffy-launchfix-p6-report.md`, so that Max's machine can copy it.

## Summary

- **PR:** #67, https://github.com/maxharris1/Cleffy/pull/67. It is a **draft**, from `mh/launchfix-p6-golive-docs` into `dev`, titled "launchfix P6: DEPLOY.md go-live runbook (fresh prod), webhook events, refunds, PITR, STRIPE_MODES". No reviewers were requested.
- **Base:** `origin/dev` = `47e9b38f2dba36fdce852c80948245da344bcc20`. It had not moved at the start or at the end of the session (re-fetched before the report).
- **Final PR head:** `4ca528742b2fd2624672f35e49248652edfde7b0`.
- **Environment:** the **Cleffy cloud environment** `env_01WAd3yiz3qpSnsofpyEwCh2`, not Sandbox. Confirmed with `get_session` at the start: `environment_id: env_01WAd3yiz3qpSnsofpyEwCh2`, `environment_kind: anthropic_cloud`, and the source revision was 47e9b38f.
- **Commit identity:** every commit is authored by Max Harris <drumaxter@gmail.com>.
- **Done-when:**
    - draft PR open, CI green on its head (see the CI section);
    - the runbook and the SETUP_SUPABASE.md fix are in;
    - `git diff --stat origin/dev` shows only `DEPLOY.md` and `SETUP_SUPABASE.md`;
    - `npm run cloud:down` has run;
    - this report is written.
- **Deviation from "Done when":** per the packet's 2026-10-22 override, there is **no** `docs/drafts/pr54-body.md`. The #54 body draft is only in this report (below).

## Commits (PR branch)

| SHA        | Summary                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------- |
| `472747b3` | docs(deploy): go-live runbook for a fresh production, webhook events, refunds, PITR, STRIPE_MODES |
| `4ca52874` | docs(deploy): name P5's district retention migrations in the go-live runbook                      |

The report branch adds one more commit on top of `4ca52874`, which adds this file. That commit is not on the PR branch.

## Files touched

- `DEPLOY.md`, +703/−8 lines:
    - the new section "Go-live 2026-10: fresh production (wipe first)", right after the Status table;
    - Status rows 22–23 ("5 events") rewritten, plus one new Status row for the go-live;
    - a "superseded for the fresh-production path" note under the old "Release checklist — launch fixes (20261007\*)" heading;
    - a "historical once production is rebuilt" note (R1–R4) under "Recovery and disaster recovery".
- `SETUP_SUPABASE.md`:
    - §6c: the webhook event list goes from 5 to all 9, plus a note that there is no `charge.refunded` handler.
- **No** code, migrations, `config.toml`, CI, `scripts/apply-migrations.sql` or tests changed.

**Migrations touched:** none. This PR adds no migrations.

**Deviations:**

1. **Prettier side effect.** Running `npx prettier --write SETUP_SUPABASE.md`, which the rules require on changed files, also re-aligned three existing Markdown tables in that file and removed one double blank line. This is whitespace only: §6b's secret table, §6f's method table and §6f's state table. I kept it so that `prettier --check` passes on the changed files. If you want a minimal diff, revert those hunks; nothing reads them.
2. **Status rows 22–23.** These were not changed to "9 events". They now say "⚠️ enabled with 5 events; needs all 9". Subscribing the endpoints is a hosted step that has not been done, and the table records state.
3. **Branch names.** The session's harness pre-assigned `claude/launchfix-p6-golive-docs-g7jflp`. That branch exists on origin from session setup, and I never pushed to it. Per Max's instructions I used `mh/launchfix-p6-golive-docs` for the PR and `claude/launchfix-p6-report` for this report.
4. **Sources used.** The re-audit documents in `/workspace` were not available. Everything here comes from the repo at 47e9b38f, PRs #54 and #61–#65 (read only), the P5 branch, and the local stack. The open questions list what this could not settle.

## Local checks

Run on the PR head before each push (both pushes), on the Cleffy environment.

| Check                                              | Result                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run lint:check`                               | ✅ exit 0                                                                                                                                              |
| `npm run typecheck`                                | ✅ exit 0                                                                                                                                              |
| `npm run test` (full suite)                        | ✅ **219 files passed, 5 skipped (224); 3382 tests passed, 13 skipped (3395)**, with `VITE_SUPABASE_URL=` / `VITE_SUPABASE_ANON_KEY=` blanked as in CI |
| `npm run build`                                    | ✅ exit 0                                                                                                                                              |
| `npx prettier --check DEPLOY.md SETUP_SUPABASE.md` | ✅ "All matched files use Prettier code style!"                                                                                                        |

**Note on `npm run test`.** I also ran it with `cloud:up`'s `.env.local` in place (it sets `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`): 2 failed, 3380 passed. The two failures were:

- `src/sync/syncEngine.test.ts` › backs off exponentially with jitter, capped at a minute;
- `tests/auth/turnstileField.test.tsx` › refuses to submit the sign-up form until the check is finished.

These are the same two failures that PRs #63 and #64 report on untouched `dev` with that file present. This PR changes no code, and CI has no `.env.local`.

## SQL proofs

This PR adds no `tests/sql/*.sql` files, because it is docs only. The runbook's new post-merge queries were run against the local stack instead (`npm run cloud:up`, dev 47e9b38f, all 96 migrations replayed):

| Query (DEPLOY.md step)                                                                                                     | Clean replay                                                              | Negative control (one rolled-back transaction)                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 7.3 grants check (`has_table_privilege`, zero rows = pass)                                                                 | **pass**: 0 rows, 61 public tables, all with RLS on                       | **2/2 faults reported**: `grant select on content_moderators to anon` gave "anon has select"; RLS off on `stripe_events` gave "RLS is off" |
| 7.4 `cron.job` check (zero rows = pass)                                                                                    | **pass**: 0 rows, the 10 expected jobs all active                         | **2/2 faults reported**: `retention-district` scheduled gave "not expected"; `imslp-sync` paused with `cron.alter_job` gave "inactive"     |
| 7.2 `select public.entitling_billing_modes()`                                                                              | `{live,test}` on a fresh replay: the R1 landmine that P1's row must close | n/a                                                                                                                                        |
| 3 "what is lost": `to_regclass` of `pd_pdf_store`, `playalong_corpus`, `playalong_corpus_seed`, `playalong_corpus_control` | all null: no migration on `dev` creates them                              | n/a                                                                                                                                        |
| `schema_migrations` count                                                                                                  | 96                                                                        | n/a                                                                                                                                        |

Every negative-control transaction was rolled back. A re-read after the rollback showed `imslp-sync` active and no `retention-district` job.

**Finding.** On the local stack, `update cron.job set active = false …`, the statement R4 gives, was refused with `ERROR: permission denied for table job` for `postgres`. The runbook's step 6 therefore uses `cron.alter_job(jobid, active := false)`, which worked. I left R4's own text unchanged, because the packet said to fix nothing else (open question 7).

## CI on the final head

All checks on head `4ca528742b2fd2624672f35e49248652edfde7b0` are green. Two CI workflow runs, both `completed / success`:

- run **39729037673**, the `pull_request` event;
- run **39729033073**, the `push` event.

| Check            | Run 39729037673 (pull_request) | Run 39729033073 (push)        |
| ---------------- | ------------------------------ | ----------------------------- |
| `checks`         | ✅ success (job 119659569433)  | ✅ success (job 119659554421) |
| `supabase-local` | ✅ success (job 119659569663)  | ✅ success (job 119659554041) |
| `supabase-drift` | ✅ success (job 119659569653)  | ✅ success (job 119659554225) |
| `omr-service`    | ✅ success (job 119659569734)  | ✅ success (job 119659554543) |

Checks outside GitHub Actions:

- **Vercel Preview Comments:** ✅ success (119659849552).
- **Supabase Preview:** skipped (119659549225). It is skipped on every docs-only PR, as on #61–#64.

The first head `472747b3` was also fully green, on runs 39728455821 (push) and 39728496837 (pull_request).

## Open questions

1. **Wipe mechanism (re-audit §8).** The runbook resets production to `main`: it runs `supabase db reset --linked --no-seed` from a checkout of `origin/main`. Production then holds `main`'s 26 migrations, and the merge applies the other 70. This uses the documented tool and its known traps, and it rewrites the history with every body, which retires R1's NULL row. The alternative is an empty history, so that the merge's integration replays all 96. I could not see which of the two §8 intends. Steps 7 onward hold either way.
2. **Sign-ups closed between the merge and the hook.** The runbook sets `disable_signup: true` in step 5, re-opens it in step 10 after the hook is on, and treats step 12's "open sign-ups" as the final open. This is my design, not taken from the re-audit. It also blocks anonymous share-link guests. If §8 keeps sign-ups open, drop it. Step 9 then creates Max's account through the dashboard ("Add user"), because public sign-up is closed.
3. **P1–P4 names.** No `mh/launchfix-p1…p4` branch existed while I worked, so the following stay marked "(confirm after P<N>)":
    - P1's `deployment_config` insert (step 7.2);
    - P1's tables, if any, for the grants list. Note P5's comment "launchfix P1 grants content_strikes explicitly": if P1 grants `content_strikes` to a client role, remove it from the runbook's `server_only` list;
    - P3's inbound-retry cron job, Edge secret and Vault names (steps 4, 7.4 and 8);
    - P2's and P4's behaviour, for the #54 draft.
4. **P5's hourly notice-sender cron (decision 11).** It is not on `mh/launchfix-p5-district-retention` at 00f48a6, which carries only `20261022130000` and `20261022130100`. Its job name and schedule stay "(confirm after P5)". If P5 schedules it in a migration, add it to step 7.4's expected list.
5. **Re-audit §4 item 8 (required versus optional secrets).** The runbook's table is built from every `Deno.env.get` in `supabase/functions`. Please check it against §4 item 8. My calls were:
    - `RESEND_WEBHOOK_SECRET` and `SUPPORT_FORWARD_TO` are required, because inbound support is live;
    - `DISTRICT_NOTICE_SECRET` is needed only once district retention starts.
6. **Smoke-test mapping.** I could not map step 11's tests to re-audit T-3…T-7 and T-11 one by one. Confirm each T-id is covered.
7. **R4's `update cron.job` statement.** It was refused locally with `permission denied for table job`. Hosted `postgres` may differ, but `cron.alter_job` is the supported call. Should R4's text be corrected in a follow-up? It is unchanged here.
8. **Refund log location.** The runbook asks for a log entry for each refund but does not know where Max keeps support records. It says "(confirm where with Max)".
9. **Live subscriptions in the old production.** The runbook makes listing them (step 3.1) and handling them (step 2) a gate before the wipe. Whether any exist is a hosted read that I did not do.
10. **Before User Created hook via the Management API.** The runbook uses the dashboard path from PR #64. I did not check whether the Management API's auth config exposes `hook_before_user_created_*` fields.
11. **SETUP_SUPABASE.md whitespace hunks** (deviation 1): keep or revert?

## Hosted steps left for Max

I performed none of these. Nothing hosted (`jibgwgosihadbjgxdsfe`, `qdbnlrgylelelvwbkvnm`), no Stripe account and no Resend account was touched.

- **The whole DEPLOY.md runbook, "Go-live 2026-10: fresh production (wipe first)", steps 1–12**, and the "Before scheduling `retention-district`" note.
- **Update PR #54's body** with the draft below. I did not edit #54.
- **Subscribe both Stripe webhook endpoints to all nine events**: `we_1U9V8T4eZ6RX0W0glk3BZIOi` (live) and `we_1U9fnx9EqxUjgZtnXnAvtJH3` (sandbox). This can be done now, before the go-live. Then update DEPLOY.md's Status rows 22–23.
- **The PITR decision** (Pro add-on), before launch.
- Replace each "(confirm after P<N>)" in DEPLOY.md once P1–P5 land.

## Expected conflicts with the other launchfix PRs

- **`DEPLOY.md`.** This PR adds ~700 lines between the Status table and the old release checklist. It also edits Status rows 22–23 and adds one Status row, and adds a note under "## Release checklist — launch fixes (20261007\*)" and under "## Recovery and disaster recovery". Any P1–P5 PR that edits the Status table, those two headings, or the lines right after the Status table will conflict textually. Resolve by keeping both. P6 merges last by design, and its "(confirm after P<N>)" placeholders should be replaced with the real names at that point. Example: P1 documenting its `deployment_config` step in DEPLOY.md.
- **`SETUP_SUPABASE.md`.** §6c's event list, and prettier's re-alignment of the §6b secret table and the two §6f tables. A PR that edits those tables, or the Vault section (§5, which P3 may extend), may conflict. Resolve by keeping both, then run prettier.
- **`scripts/apply-migrations.sql` and `tests/migrationRecoverability.test.ts`.** Not touched here, so no conflict from P6.
- **P5 (`mh/launchfix-p5-district-retention`).** Touches no `.md` file this PR touches (its `tests/sql/README.md` is not touched here), so no textual conflict.

## PR #54 body draft

The full text follows. It is not committed on the PR branch (packet override). Paste it into #54 once P1–P5 land and each "(confirm after …)" is filled in.

---

**Draft. Do not merge until every step of DEPLOY.md → "Go-live 2026-10: fresh production (wipe first)" before the merge is done.**

This PR promotes `dev` to production for the launch. **Production is wiped first**, and then every migration replays onto it. There is no data-preserving push.

Counts, from the repository at `dev` 47e9b38f:

- **96 migrations** (`ls supabase/migrations | wc -l`). `main` has 26, so the merge applies 70 on top of the step-3 reset to `main`.
- **23 Edge Functions**, the directories under `supabase/functions/` other than `_shared`. `main` has 13.

Re-count on the final head. P1, P3, P4 and P5 add migrations. (confirm after P1 to P5)

## What ships

**From before the launch-compliance round.** This is the old body's scope, still true:

- **Scope (owner decisions).**
    - One shared annotation layer. There are no teacher/student layers, hairpins or reading mode.
    - The markup toolbar keeps production's simple layout.
    - Play-along, fingering, print-handwriting and smart import are built but off by default build flags (`src/lib/features.ts`).
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
    - Retention pg_cron jobs: archived students 12 months, guests 90 days, rate limits 1 day, support mail 24 months, weekly tombstone compaction.
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
- **P6 (#67):** DEPLOY.md's go-live runbook for a fresh production. Also: the full 9-event Stripe webhook set (SETUP_SUPABASE.md listed 5), the manual refund-and-cancel step, PITR off, and STRIPE_MODES. Docs only.

## Verification

- CI on the `dev` head: `checks`, `supabase-drift`, `supabase-local`, `omr-service` and Vercel. (Fill in on the final head.)
- Locally on `dev` 47e9b38f:
    - `npm run lint:check`, `typecheck` and `build` are clean;
    - `npm run test`: 219 files and 3382 tests pass, 13 skipped;
    - the local stack replays all 96 migrations.
- On that replay, the go-live runbook's post-merge queries pass:
    - the grants check returns 0 rows;
    - the `cron.job` check returns 0 rows: 10 jobs, no `retention-district`;
    - `entitling_billing_modes()` reads `{live,test}` before P1's row, which is what step 7.2 corrects.
- SQL proofs from the compliance PRs, each as reported on its PR:
    - `district_seats` 58/58 (#61);
    - `launch_checkout_fixes` 46/46 and `checkout_consents` 24/24 (#62);
    - `content_moderation` 35/35 (#63);
    - `launch_consent`, `district_retention`, `district_student_scope` and `district_billing_canonical` (#64).

    Re-run on the final head (confirm after P1 to P5).

- Not yet exercised against real Stripe or Resend. The go-live smoke (step 11) does that, including one real low-price purchase, refunded and cancelled.

## Before merging: follow DEPLOY.md → "Go-live 2026-10: fresh production (wipe first)"

In short:

- [ ] 1. P1–P6 landed on `dev`, CI green, `scripts/apply-migrations.sql` regenerated.
- [ ] 2. Max's prerequisites:
    - LLC and legal text final;
    - NY/OSS/UK tax;
    - Stripe Tax + `scripts/stripe/configure-tax.mjs`, sandbox then live;
    - portal settings;
    - **all 9 webhook events on both endpoints**;
    - live subscriptions handled;
    - SPF/DKIM/DMARC;
    - Resend quota against the 300/day budget.
- [ ] 3. Logical dump of production, restore-tested, then the wipe. **Max confirms first.** `pd_pdf_store` and `playalong_corpus*` exist only in the dump.
- [ ] 4. Production Edge secrets (required list).
- [ ] 5. Auth: Confirm email ON, password policy, redirect URLs including `www`, SMTP, sign-ups closed. **Hook still OFF.**
- [ ] 6. **Merge this PR outside lesson hours.** The integration applies the migrations and deploys the functions; Vercel builds.
- [ ] 7. Right after the merge:
    - `STRIPE_MODES=live`;
    - P1's row, with `entitling_billing_modes()` = `{live}`;
    - the grants check;
    - the `cron.job` list;
    - `verify_jwt` per function.
- [ ] 8. Vault secrets: `imslp_sync`, `billing_outbox`, `content_notice`, `district_notice` (+ P3's).
- [ ] 9. `content_moderators` row for Max.
- [ ] 10. Before User Created hook ON, then one sign-up and one share-link join.
- [ ] 11. Smoke tests, including a real purchase, then refund **and** cancel, then delete the throwaway accounts.
- [ ] 12. Open sign-ups, then watch for 48 hours.

`retention-district` stays unscheduled until the runbook's "Before scheduling `retention-district`" holds.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
