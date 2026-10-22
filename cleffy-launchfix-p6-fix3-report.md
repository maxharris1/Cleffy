# Launchfix P6 fix round 3 report: PR #67 (go-live runbook, docs only)

Session: https://claude.ai/code/session_01PH97KGn6k19bp2rf9XHweZ

This report is committed only on the scratch branch `claude/launchfix-p6-fix3-report`, as `cleffy-launchfix-p6-fix3-report.md`. It is one commit on top of PR #67's final head, and it is not on the PR branch. Nothing was written to `/workspace`, and `claude/launchfix-p6-report`, `claude/launchfix-p6-fix1-report` and `claude/launchfix-p6-fix2-report` were not touched.

## Summary

- **PR:** #67, https://github.com/maxharris1/Cleffy/pull/67. Still a **draft**, from `mh/launchfix-p6-golive-docs` into `dev`. No reviewers requested, no labels changed, no comments posted, no new PR opened.
- **Starting SHA:** `beb5c0044472206458ec0c420e408877a3b64bea`. `origin/mh/launchfix-p6-golive-docs` was at exactly this SHA when the session started, and had not moved when I pushed.
- **New PR #67 head:** `7ae2ee5694f720f71738449f9983ef803e9bf8e9`. A fast-forward push (`beb5c00..7ae2ee5`). Nothing was force-pushed.
- **Base:** `origin/dev` = `47e9b38f2dba36fdce852c80948245da344bcc20`, unchanged.
- **Environment:** the **Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2`** (`environment_kind: anthropic_cloud`), **not Sandbox**. Confirmed with `get_session` at the start.
- **Commit identity:** Max Harris <drumaxter@gmail.com>.
- **Scope:** `DEPLOY.md` only. No code, migrations, config or CI.
- **PR #67:** body refreshed (title unchanged). Draft and base `dev` unchanged.
- **PR #54:** not touched. The updated body draft is below.
- **Done-when:** #67 fast-forwarded ✅; new head SHA ✅; each fix with DEPLOY.md line ranges ✅; follow-ups ✅. CI: see _CI on the final head_.

## Commits

| SHA        | Branch                                 | Summary                                                                       |
| ---------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| `7ae2ee56` | `mh/launchfix-p6-golive-docs` (PR #67) | docs(deploy): fail-closed Stripe lists, ban-state-preserving freeze, r3 gates |
| (report)   | `claude/launchfix-p6-fix3-report` only | report: launchfix P6 fix round 3 (this file). Its SHA is the branch head.     |

## Fixes, with DEPLOY.md line ranges (at `7ae2ee56`)

### Packet item 1 / Codex r3 MAJOR 1: Stripe listings fail closed

- **The helper, moved to step 3** (_Listing Stripe, fail-closed_): `DEPLOY.md:325–384`. `stripe_all <out.jsonl> <list> [name=value …]` is a subshell function under `set -euo pipefail`. It deletes any old `<out.jsonl>`, writes each page to a `mktemp` file, and requires HTTP 200, no `error` key, `object == "list"`, an array `data` and a boolean `has_more`. `has_more: true` on an empty page also fails. It appends to a temp file in the same directory, and only after the last page does one `mv` publish the result. On any failure it prints why, leaves no output file and returns 1. Every check is explicit, so it still fails closed if bash ignores `set -e` in a `||`/`&&` context.
- **Every caller is a `( set -euo pipefail … )` block that must print an `OK` line**, and the runbook says not to put `||`/`&&` after the `)` (bash would ignore `set -e` inside): `:378–384`. No count is taken from a pipe any more; counts come from files the helper published.
    - Step 4 filter gate: `:467–516`.
    - Step 6.7 intro: `:823–827`; 6.7.1 (expire open sessions, each expiry checked for HTTP 200 and `status: expired`, then 0 open, then the sessions since `FREEZE_AT`): `:829–859`; 6.7.2 (subscriptions): `:861–883`.
    - Step 8 pre-wipe re-check: `:983–1002`.
    - Step 18 replay listing: `:1672–1707`; final reconciliation: `:1782–1808`.
    - _Abort and recovery_ item 5 (same fail-closed block, `ENABLE_UNIX=$(date +%s)`): `:1919–1924`.

### Packet item 2 / Codex r3 MAJOR 2: the freeze keeps pre-existing bans

`DEPLOY.md:622–758` (step 6.5.1, now parts a, b and c), `:1832–1835` (step 20), `:1911–1916` (_Abort and recovery_ item 2).

- **a. Record first, change nothing** (`:636–674`). Pages the Auth admin API (`PER_PAGE=100`) and stops at the first short page. Writes `id`, the original `banned_until` (or `-`) and the email to a temp file. Then it asserts that the distinct ids equal the rows, and equal `select count(*) from auth.users` (Max included), before `mv` to `freeze-ban-state.tsv`. On a mismatch it writes nothing. The text says what to do if the server caps the page size (`:640–647`).
- **b. Plan, then ban** (`:676–716`). Each account gets one action in `freeze-ban-plan.tsv`: `max` (never banned), `prebanned` (already banned until more than 24 hours from now: **left unchanged**, never touched by the rollback), or `ban`. Only `ban` rows are banned. Each PUT must return 200 or the block stops. The files are kept with the backup, because they hold emails.
- **c. Rollback, abort only** (`:718–758`). Undoes only the `ban` rows: `none` for an account that had no live ban, or the seconds left (`"<N>s"`) for one whose own ban had not yet ended. Then a `psql` check (temp table loaded with `\copy`) compares every account with its recorded state: zero rows is a pass.
- **Step 20** (`:1832–1835`): the wipe removed every old account, so no rollback runs after the wipe. The plan file stays with the backup as the record of who was already banned.
- **Abort item 2** (`:1911–1916`): run 6.5.1c and its check; never unban by looping over every account.

### Packet item 3 / Codex r3 MINOR: renewal replay gate

`DEPLOY.md:1742–1767`. Part 1 checks the original delivery applied (`applied: invoice_recorded`), and records status and period end. Part 2: the resend passes with `{"received":true,"duplicate":true}` (the normal answer, `handleStripeEvent`, `supabase/functions/_shared/stripeEvents.ts:1068–1074`), or with `applied: invoice_recorded` only if no earlier delivery had succeeded. Anything else (`ignored: …`, `409 event_in_flight`, 5xx) fails. Part 3: one `stripe_events` row with `status = 'done'`, and the subscription unchanged. The handler is not changed.

For consistency, the reconciliation table's "applied and verified" also accepts `duplicate: true` once the event's `stripe_events` row is `done` and the subscription matches (`:899–904`, referenced from step 18 at `:1720–1722`).

### Packet item 4 / Codex required addition P3

`DEPLOY.md:1278–1295` (after batch 3) and `:1299` (step 12 now says "after batch 3 and its P3 check"). A `schema_migrations` query must return exactly the three rows `20261022110000 student_claim_reservation`, `20261022110100 account_deletion_pending`, `20261022110200 support_inbound_lease`, before any function is deployed, including `resend-inbound`, `student-provision` and `delete-account`. Fewer means do not deploy. Names verified at P3 `1c9e8512` (`git ls-tree`). Marked "(confirm after P3)".

### Packet item 5 / Codex required addition P1

- **Preflight in step 4** (`DEPLOY.md:451–465`): `select has_table_privilege('postgres', 'storage.objects', 'TRIGGER') as can_create_storage_triggers;` must be `t`, or the sitting does not start. It names P1's two triggers (`storage_objects_enforce_quota`, `thumbnails_record_superseded`), checked at P1 `275b188b`, `20261022100800_storage_quota_and_thumbnail_lifecycle.sql:207–210,285–288`.
- **Again before the wipe** (`:1000–1002`): if `f`, stop and unfreeze; nothing is lost yet.
- **Again before batch 1** (`:1194–1198`): if `f`, stop before applying any migration.

### Packet item 6 / decision 54

1. **Stripe list filters are an explicit go-live checklist step** (`DEPLOY.md:467–516`). Step 4 proves all five filters against the live account, read-only, the day before: `checkout/sessions status=open`, `checkout/sessions created[gte]`, `subscriptions status=all`, `events created[gte]/created[lt]/types[]`, and `events delivery_success=false`. A refused filter fails the helper (Stripe answers 400 to an unknown parameter). An accepted but ignored one is caught by `jq` checks, each with its own error message. Two manual checks follow (canceled subscriptions present; undelivered count matches the Dashboard). If any fails, the sitting does not start, and the fallback is described.
2. **The optional object-bytes download is gone** (`:930–934`, `:953–962`). Only the DB dump and the object list remain, for reference.
3. **The ban loop pages until a short page and asserts the processed count equals `auth.users`** (`:636–674`). The processed count includes Max, because the loop lists every account; only the ban step skips Max.
4. **`jwt_exp` preflight before choosing the slot** (`:246–265`). A read-only `GET` of the Auth config, the arithmetic (`jwt_exp` + 20 minutes before the backup, plus ~2.5 hours for steps 7–21), what to do if it is longer, and that until the wait ends the freeze rests on maintenance mode, closed sign-ups, the bans and session revocation, with the drain check as proof.

### Packet item 7

- **PR #67 body:** refreshed (body only; title kept). Checked after the edit: draft, base `dev`. The body text is the one on the PR.
- **PR #54 body draft:** below, under _Updated PR #54 body draft_. Not committed to the PR branch, and #54 itself was not touched.

### Other change

- **`'<max's address>'` placeholder** (`DEPLOY.md:633`, `:1535`): the apostrophe made an unterminated quote. Pasted as-is, the bash line would leave the shell waiting for a closing quote, and the SQL would fail. Now `'<max-address>'`. Found by `bash -n`.
- `PROD_DB_URL` is now introduced in step 3 (`:285–287`), because steps 4–6 now use `psql` before step 7.

## Shell syntax-check results

All 32 `bash` blocks in the go-live section (`DEPLOY.md:50–2100`) were extracted, de-indented and checked:

- **`bash -n`** (GNU bash 5.2.21): **32/32 pass**.
- **ShellCheck 0.11.0** (`-s bash`, SC2154 "assigned elsewhere" excluded, SC2015 `A && B || C` reviewed as intended): every new or changed block is clean, individually and concatenated in sitting order. Remaining findings are in blocks this round did not change:
    - step 3 `git worktree add … && cd ../cleffy-golive` (SC2164);
    - step 3 `stage()` / `export GOLIVE_STAGE="$(mktemp -d)/stage"` (SC2155 and two info notes).
    - The 6.5.1 variables block alone reports SC2034 (unused), which is resolved by the blocks that follow it.
- **Logic tests with stubs, no network.** `curl` and `psql` were replaced by shell functions in a scratch directory, and the blocks were run exactly as extracted from DEPLOY.md. No call reached Stripe, Supabase or anything else, and no local stack was used.
    - `stripe_all`: 3 pages (100/100/50) → 250 objects, `OK`. HTTP 429 on page 2, a curl failure, a 200 with an `error` key, a non-JSON page, `has_more` on an empty page → each returned 1, the stale output file was deleted, no output and no temp files were left, and the block's `OK` line did not print.
    - Step 4 gate: all filters honoured → `Stripe filters OK`. A non-open session from `status=open`, or an event of another type → stops with its message.
    - 6.5.1a: 205 users → `OK`, 205 recorded. A server cap of 50 (short first page) → "listed 50 … auth.users has 205: stop", nothing written.
    - 6.5.1b: Max → `max`, a 30-day ban → `prebanned` (not touched), a ban ending in 2 hours, a lapsed ban and an anonymous user → `ban`; 203 PUTs, none for Max or the pre-ban. A 500 on one PUT stops the block.
    - 6.5.1c: 203 PUTs; the 2-hour ban got `7198s`, the rest `none`; the pre-ban was not touched.
    - 6.7.1: two sessions expired → `OK`; an expiry answering 400 → stops; a session still open after expiry → stops.

## Local checks (on `7ae2ee56`, before the push)

| Check                            | Result                                          |
| -------------------------------- | ----------------------------------------------- |
| `npx prettier --check DEPLOY.md` | ✅ "All matched files use Prettier code style!" |
| `npm run lint:check`             | ✅ exit 0                                       |

Typecheck, tests and build were not re-run locally: the change is Markdown only, and CI's `checks` job runs them (below).

## CI on the final head (`7ae2ee56`)

GitHub Actions: every job on head `7ae2ee5694f720f71738449f9983ef803e9bf8e9` passed. Two CI workflow runs, both `completed / success`:

- run **39749541889**, the `pull_request` event;
- run **39749537113**, the `push` event.

| Check            | Run 39749541889 (pull_request) | Run 39749537113 (push)        |
| ---------------- | ------------------------------ | ----------------------------- |
| `checks`         | ✅ success (job 119726329551)  | ✅ success (job 119726313612) |
| `supabase-local` | ✅ success (job 119726329775)  | ✅ success (job 119726313595) |
| `supabase-drift` | ✅ success (job 119726329797)  | ✅ success (job 119726313854) |
| `omr-service`    | ✅ success (job 119726329799)  | ✅ success (job 119726313302) |

`checks` runs lint, typecheck, the Vitest suite and the build (its log ends with a clean `vite build`). I did not extract the test totals from the log.

Checks outside GitHub Actions:

- **Supabase Preview:** skipped (119726309292), as on every docs-only push, including `beb5c004`.
- **Vercel** (commit status): ❌ **failure**, "Deployment rate limited — retry in 24 hours." (2026-10-22 08:40:46 UTC), pointing at Vercel's `build-rate-limit` upgrade page. This is the same account-level build quota as on `beb5c004`, not this change: the diff is Markdown only and the build passes in `checks`. I may not touch Vercel, and an empty commit to re-trigger it is not allowed. Open question 4.

No CI fix round was needed.

## Files touched and deviations

**Files:** `DEPLOY.md` only, all inside the "Go-live 2026-10" section: the step 3, 4, 6, 7, 8, 11, 12, 15, 18 and 20 hunks, and _Abort and recovery_. Nothing outside it changed. Prettier made no unrelated changes.

**Deviations and interpretations:**

1. **Report location.** On `claude/launchfix-p6-fix3-report`, as instructed, not `/workspace`.
2. **Harness branch.** The harness pre-assigned `claude/launchfix-p6-fix3-docs-mkl9r7`. Per Max's instructions, I used only `mh/launchfix-p6-golive-docs` and `claude/launchfix-p6-fix3-report`, and pushed nothing to the pre-assigned branch.
3. **"Skip accounts that were already banned" uses a 24-hour threshold.** An account banned until more than 24 hours from now is skipped. One whose own ban ends sooner would otherwise be able to sign in mid-sitting, so it gets the maintenance ban, and the rollback restores its original end time. This keeps both Codex's requirement (never lose an original ban) and the freeze's purpose. Open question 1.
4. **Tests used stubbed `curl`/`psql`**, not only `bash -n`/ShellCheck. No network and no service was involved. I read "syntax-checked locally only" as forbidding hosted runs; tell me if stub tests were also out of bounds.
5. **The helper moved from step 6.7 to step 3**, because step 4's new filter gate needs it the day before the sitting.
6. **The `duplicate: true` acceptance was also added to the reconciliation table's "applied and verified"**, not only to the renewal gate, so that a resend in step 18 of an already-applied event is not misread as needs review.
7. **The privilege preflight runs three times** (step 4, before the wipe, before batch 1) rather than once. The step 4 and pre-wipe runs let a `f` stop the sitting while nothing is lost.
8. **`'<max's address>'` placeholder fixed** in two places. Not in the packet, but `bash -n` failed on it.

## Follow-ups

- Pre-existing ShellCheck warnings in step 3 (`cd` without `|| exit`; `export` with command substitution). Harmless as written, left alone to stay in scope.
- Codex r4 is to be a narrow verification of decision 56's items (per decision 56).
- When P1–P5 merge, re-check the "(confirm after P<N>)" markers, now including P1's storage triggers and P3's three versions.

## Open questions

1. **The 24-hour pre-ban threshold** (deviation 3). Is it acceptable, or should every account with any live ban be skipped, relying on the drain check to catch a ban that lapses mid-sitting?
2. **Hosted Auth behaviours not verified on hosted:** that `GET /admin/users` returns `banned_until`; whether it caps `per_page` below 100 (the count assertion catches it, and the text says what to do); that `ban_duration: "<N>s"` is accepted (Go duration syntax; `876000h` and `none` were checked locally in round 2). Verify at go-live.
3. **Stripe filters:** step 4's gate proves them before the sitting. If `delivery_success=false` is refused, its fallback is the Dashboard's failed-deliveries list. Is that acceptable to Max?
4. **Vercel status** on the new head: see CI. If it is rate-limited again, as on `beb5c004`, the same answer applies as in fix round 2 (redeploy in Vercel once the quota resets, or accept it for a docs-only PR). I did not touch Vercel.
5. Every "(confirm after P<N>)" marker from fix round 2 remains, plus P1's storage-trigger preflight and P3's migration list.

## Updated Max-only steps

I performed none. New or changed in this round are in **bold**.

- **Before the sitting**
    - Step 0: Deploy to production off, and check it.
    - Step 1: land P1–P5, then #67; regenerate the mirror; pin `GOLIVE_SHA`; re-count (111 / 12 at the current heads); replace the "(confirm after P<N>)" names; update #54's body from the draft below.
    - Step 2: legal; tax; Stripe Tax and `configure-tax.mjs`; portal; all 9 webhook events on both endpoints; DNS; Resend quota; the two `dev`-branch test-clock rehearsals; the `dev` project's own `content_strike_pepper`.
    - Step 3: **read prod `jwt_exp` first, then choose a slot of at least `jwt_exp` + 20 minutes + ~2.5 hours**, clear of 03:00–04:30 UTC; the IP addresses; the worktree, CLI and link; **paste the `stage` and `stripe_all` helpers**.
    - Step 4: inventories (Edge secrets, price overrides, Vercel env, Vault names, OMR); **the `storage.objects` TRIGGER privilege preflight (must be `t`)**; **the Stripe list-filter gate (must print `Stripe filters OK`, plus the two manual checks), recorded in the ops log**.
    - Step 5: first snapshot.
- **The sitting (steps 6–20)**
    - Step 6: firewall; sign-ups closed; webhook disabled (`FREEZE_AT`); old crons paused; **6.5.1a record the ban state (`OK`), 6.5.1b plan and ban (`OK`)**; delete sessions (`REVOKE_AT`); wait `jwt_exp` + 5 minutes; 15-minute drain check; snapshot again; **Stripe with fail-closed blocks (6.7.1 `OK`, 6.7.2 `OK`)**; the reconciliation table.
    - Step 7: backup for reference (**no object bytes**) and the file check; keep the ban files with it.
    - Step 8: re-check the freeze, **Stripe (`8 Stripe OK`) and the privilege**; written confirmation; the wipe.
    - Steps 9–10: secrets and Auth.
    - Step 11: **privilege again before batch 1**; three batches with their pauses; **then P3's three versions recorded**.
    - Step 12: functions (only after that check) and buckets.
    - Step 13: checks. Step 14: Vault plus the pepper, then resume `imslp-sync`. Step 15: moderator row. Step 16: merge #54. Step 17: hook and test accounts.
    - Step 18: smoke tests; re-enable the webhook (`ENABLE_AT`); **fail-closed replay list (`OK`)**; dispositions; part B with the **new renewal replay gate (duplicate is the pass)**; **fail-closed final reconcile (`OK`)**.
    - Step 19: integration back on. Step 20: open, only with no needs-review rows; watch.
- **After opening:** step 21's six T-6 counts and named resumes; _Before scheduling `retention-district`_; the PITR decision.
- **On abort before the wipe:** **6.5.1c rollback and its `psql` check**, never a loop over every account.

## Hosted steps left for Max

All of the above. I performed none. Nothing hosted was touched: not `jibgwgosihadbjgxdsfe`, not `qdbnlrgylelelvwbkvnm`, not Vercel, not Stripe (live or test), not Resend, not PR #54. My only GitHub writes were the fast-forward push to `mh/launchfix-p6-golive-docs`, PR #67's body edit, and the push of this report branch.

## Updated PR #54 body draft

The full text follows. It is not committed on the PR branch, and #54 was not edited. Paste it into #54 once P1–P5 land and each "(confirm after …)" is filled in. Changed since the r2 draft: the P1, P3 and P6 lines under _Launchfix P1–P6_, and go-live steps 3, 4, 6, 7, 8, 11, 12 and 18.

---

**Draft. Do not merge outside DEPLOY.md → "Go-live 2026-10: fresh production (wipe first)". Merging this PR is that runbook's step 16. It happens behind a maintenance freeze, after the database and functions are already deployed by hand.**

This PR promotes `dev` to production for the launch. **Production is wiped first, and no data is restored.**

- There is no data-preserving push. Production held nothing material (Max, 2026-10-21, confirmed again in writing at step 8). The pre-wipe backup is kept for reference and forensics only.
- The Supabase GitHub integration's **Deploy to production is turned off** for the go-live (runbook step 0). So this merge applies no migration and deploys no function.
- Vercel builds the new bundle, and only Max can reach it until the runbook opens the site (step 20).

Counts, from the repository at `dev` 47e9b38f:

- **96 migrations** (`ls supabase/migrations | wc -l`). `main` has 26, an unchanged prefix of `dev`'s.
    - The runbook resets production to `main`'s 26 (step 8).
    - It then pushes the rest by hand in three batches (step 11). It pauses `imslp-sync` after the first batch, the five `retention-*` jobs of `20261021120300` after the second, and P5's `retention-content-strikes` after the third.
- **23 Edge Functions**: the directories under `supabase/functions/` other than `_shared`. `main` has 13, all still present. All 23 are deployed by hand (step 12).
- **10 cron jobs**, five of them `retention-*`.

At the P1–P5 branch heads of 2026-10-22, the counts become:

- **111 migrations**, with batches of 4, 60 and **21**. P1 adds 9 (`275b188b`), P3 adds 3 (`1c9e8512`), P4 adds 1 (`a9e98c92`) and P5 adds 2 (`4ffd856d`).
- **12 cron jobs**: P3's `support-inbound-retry` and P5's `retention-content-strikes` (daily, 04:07 UTC), for **six** `retention-*` jobs.
- Still 23 functions.

Re-count on the final head (`GOLIVE_SHA`). (confirm after P1 to P5)

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
    - Retention pg_cron jobs: archived students 12 months, guests 90 days, rate limits 1 day, support mail 24 months, weekly tombstone compaction.
        - The migration creates them **active**.
        - On production, the runbook pauses them with `cron.alter_job` the moment their batch commits (step 11), and requires them paused in the step 13 cron check.
        - It turns each one on, by name, only after its T-6 dry-run count is read (step 21).
        - The sitting is also scheduled clear of their run times, 03:00–04:30 UTC.
    - Presence never shows emails.
    - `VITE_FEATURE_SMART_IMPORT`.
    - Tagged support forwards; no Sentry id for students.
    - District retention, shipped **unscheduled**: `retention-district` is not scheduled. New function: `district-retention-notices`.
- **#65, IMSLP download flake.** An API call that outlasts the download budget now reports `timeout`, not `bot_check`. This fixed the test that failed twice on this PR's CI.

**Launchfix P1–P6** (re-audit 2026-10-22). (confirm after P1 to P5: replace each line with the PR number and a summary of what merged)

- **P1:** the `deployment_config` live-only row, so `entitling_billing_modes()` is `{live}` from data after a fresh replay. A fresh replay otherwise ships `{live,test}`, which is R1's landmine. The runbook runs P1's exact upsert at step 13.2. P1 also creates two triggers on `storage.objects` (`20261022100800`), so the runbook requires `has_table_privilege('postgres', 'storage.objects', 'TRIGGER')` to be `t` before the sitting, before the wipe and before batch 1. (branch head `275b188b`; confirm after P1)
- **P2:** (confirm after P2)
- **P3:** the inbound retry cron, `support-inbound-retry`. Its Vault pair is `support_inbound_url` / `support_inbound_secret`, and its Edge secret is `SUPPORT_RETRY_SECRET`. The runbook requires `20261022110000_student_claim_reservation`, `20261022110100_account_deletion_pending` and `20261022110200_support_inbound_lease` to be recorded remotely before any function is deployed (step 11.3). (branch head `1c9e8512`; confirm after P3)
- **P4:** (confirm after P4)
- **P5:** district retention behaviour, and strikes that survive deletion.
    - `20261022130000_district_retention_reattribution`: a student re-attributed to another district is taken off the old district's purge list, and the hard delete re-checks the attribution.
    - `20261022130100_content_strikes_survive_deletion`: copyright strikes survive account deletion, keyed by an HMAC of the address.
        - The key needs the Vault secret **`content_strike_pepper`**. It is a separate random value per project, created in the database by Max (runbook step 14), and never committed. Without it, deleting an account with an active strike fails.
        - The migration also schedules **`retention-content-strikes`** (daily, 04:07 UTC), the sixth retention job. It is paused and gated like the other five.
    - Proofs: `tests/sql/district_retention_reattribution.sql` and `tests/sql/content_strikes_survive_deletion.sql`.
    - (branch `mh/launchfix-p5-district-retention` at `4ffd856d`; confirm after P5)
- **P6 (#67):** DEPLOY.md's go-live runbook for a fresh production. It covers:
    - a manual, gated deploy (integration off; reset to `main`, then three staged batches);
    - preflights before the slot and the sitting: production's `jwt_exp` (it sets the freeze's length), the `storage.objects` trigger privilege, and **every Stripe list filter proven** against the live account;
    - a freeze before the backup: firewall, sign-ups closed, webhook off, **each account's original ban recorded before any maintenance ban** (accounts already banned are left alone, and an abort lifts only the maintenance bans), **sessions revoked and writes drained**, then Stripe reconciled with **paginated, fail-closed** lists (an API error stops the step and never reads as an empty list);
    - a backup **for reference only**: `public` data, `auth` and `storage` metadata, schemas and the object list, with a file check. No object bytes, and **no restore is supported**. The abort path is to unfreeze before the wipe, and after it to fix forward or re-apply from scratch;
    - the retention and IMSLP pauses, P3's migrations recorded before the functions, Vault withheld until the functions are checked, and the strike pepper;
    - backend-level smoke tests, including `503 ai_unavailable`, a struck-account deletion, and a renewal replay that must answer `duplicate: true` without changing anything;
    - the full 9-event Stripe webhook set (SETUP_SUPABASE.md listed 5). The freeze window's events are listed and each given a recorded disposition, where `ignored: unknown_user` means review, not success;
    - the manual refund-and-cancel step (logged in Max's private ops log), PITR off, and STRIPE_MODES;
    - the env/secret inventory.

    Docs only.

## Verification

- CI on the `dev` head: `checks`, `supabase-drift`, `supabase-local`, `omr-service` and Vercel. (Fill in on the final head.)
- Locally on `dev` 47e9b38f:
    - `npm run lint:check`, `typecheck` and `build` are clean;
    - `npm run test`: 219 files and 3382 tests pass, 13 skipped;
    - the local stack replays all 96 migrations.
- On a local stack with P1, P3, P4 and P5's migrations added (111), the go-live runbook's checks pass:
    - the grants check, with P1–P5's tables added, returns 0 rows;
    - the `cron.job` check finds the 12 expected jobs, and no `retention-district`. On production, it requires `imslp-sync` and the six `retention-*` jobs paused until steps 14 and 21;
    - `entitling_billing_modes()` reads `{live,test}` before P1's row, and `{live}` after step 13.2's upsert;
    - the T-6 retention dry-run counts, six of them, return 0;
    - the struck-account deletion keys the strike with the pepper, and fails without it.
- The runbook's shell blocks pass `bash -n` and ShellCheck. The fail-closed Stripe helper, the ban record/plan/rollback and the Checkout expiry were exercised with stubbed `curl`/`psql` (no network), including HTTP errors, error bodies, malformed pages and a page-size cap.
- SQL proofs from the compliance PRs, each as reported on its PR:
    - `district_seats` 58/58 (#61);
    - `launch_checkout_fixes` 46/46 and `checkout_consents` 24/24 (#62);
    - `content_moderation` 35/35 (#63);
    - `launch_consent`, `district_retention`, `district_student_scope` and `district_billing_canonical` (#64).

    Re-run on the final head (confirm after P1 to P5).

- Not yet exercised against real Stripe or Resend. The go-live smoke tests (step 18) do that, including one real low-price Teacher purchase, refunded and cancelled. Renewal, and district invoice and grace, are rehearsed first on the `dev` branch with Stripe test clocks (step 2).

## Go-live: follow DEPLOY.md → "Go-live 2026-10: fresh production (wipe first)"

In short:

- [ ] 0. Supabase **Deploy to production OFF**, verified (`git_branch` is `""`).
- [ ] 1. P1–P6 landed on `dev`, CI green, `scripts/apply-migrations.sql` regenerated. `GOLIVE_SHA` pinned, and the counts redone (111 migrations and 12 cron jobs at the branch heads).
- [ ] 2. Max's prerequisites:
    - LLC and legal text final;
    - NY/OSS/UK tax;
    - Stripe Tax + `scripts/stripe/configure-tax.mjs`, sandbox then live;
    - portal settings;
    - **all 9 webhook events on both endpoints**;
    - SPF/DKIM/DMARC;
    - the Resend quota against the 300/day budget;
    - **`dev`-branch test-clock rehearsals: renewal; district invoice and grace**.
- [ ] 3. **Read production's `jwt_exp` first**, then choose the sitting: outside lesson hours, clear of 03:00–04:30 UTC, and at least `jwt_exp` + 20 minutes + about 2.5 hours (3–4 hours with the default 3600). One worktree at `GOLIVE_SHA`, CLI 2.121.0, linked to `jibgwgosihadbjgxdsfe`, with the ref checked. The `stage` and fail-closed `stripe_all` helpers.
- [ ] 4. Read-only inventory and gates:
    - Edge secrets;
    - no `STRIPE_PRICE_*` overrides;
    - the Vercel `VITE_*` build env (URL and key are an override only as a pair, and both stay absent);
    - Vault **names** (assume Vault does not survive);
    - OMR;
    - **`has_table_privilege('postgres', 'storage.objects', 'TRIGGER')` is `t`** (P1);
    - **the Stripe list filters, proven** (`Stripe filters OK`, recorded in the ops log).
- [ ] 5. Snapshot counts.
- [ ] 6. **Freeze:**
    - Vercel Firewall deny (Max bypassed);
    - sign-ups closed;
    - live webhook disabled (`FREEZE_AT`);
    - old crons paused;
    - **each account's original ban recorded** (every page, count matched to `auth.users`), then every account but Max's and those already banned past the sitting banned, and every session deleted (`REVOKE_AT`);
    - wait out `jwt_exp`, then a 15-minute **no-writes drain check**;
    - snapshot again;
    - Stripe reconciled directly, **every list paginated and fail-closed**: open Checkout sessions expired first, then subscriptions cancelled. Each one gets a row in the reconciliation table.
- [ ] 7. Backup **for reference only**: public data, auth/storage metadata, schemas, object list, and a file check. No object bytes. No restore.
- [ ] 8. Freeze, **Stripe and the storage privilege** re-checked. **Max confirms in writing**: nothing material, and no data restore. Then empty Storage, reset to `main`'s 26 and withhold the Vault caller secrets. `pd_pdf_store` and `playalong_corpus*` now exist only in the backup.
- [ ] 9. Production Edge secrets, with the AI key, OMR, the Stripe test pair, legacy aliases and price overrides **unset**, and P3's `SUPPORT_RETRY_SECRET` set.
- [ ] 10. Auth: Confirm email ON, password policy, redirect URLs including `www`, SMTP. Sign-ups stay closed, **hook still OFF**.
- [ ] 11. Migrations by hand:
    - **the storage privilege once more**;
    - batch 1 (4), then pause `imslp-sync`;
    - batch 2 (60), then pause the five `retention-*`;
    - batch 3 (the rest, 21 at the heads), then pause `retention-content-strikes`;
    - **P3's `20261022110000`, `110100` and `110200` recorded remotely**.
- [ ] 12. All 23 functions deployed by hand, **only after that check**; buckets checked.
- [ ] 13. Checks:
    - `STRIPE_MODES=live`;
    - P1's upsert, with `entitling_billing_modes()` = `{live}`;
    - the grants check;
    - the 12-job `cron.job` check, with the pauses required;
    - `verify_jwt` per function.
- [ ] 14. Vault secrets (`imslp_sync`, `billing_outbox`, `content_notice`, `district_notice`, `support_inbound`), plus a fresh random **`content_strike_pepper`**. Then resume `imslp-sync`.
- [ ] 15. `content_moderators` row for Max.
- [ ] 16. **Merge this PR**, behind the freeze. Vercel builds; Supabase gets nothing.
- [ ] 17. Before User Created hook ON, sign-ups open, then one sign-up and one share-link join.
- [ ] 18. Smoke tests:
    - part A: includes `503 ai_unavailable`, guest email, alias tagging, and a **struck-account deletion** (the pepper);
    - re-enable the live webhook, then list the freeze window and the earlier undelivered events (paginated, **fail-closed**). Give each a disposition, and treat `ignored: unknown_user` as needs review;
    - part B: a real Teacher purchase, roster and invite mail, **renewal replay (the resend answers `duplicate: true`, one `stripe_events` row, nothing changed)**, refund **and** cancel, delete the throwaway accounts, then reconcile Stripe once more.
- [ ] 19. Deploy to production back ON.
- [ ] 20. Open (no reconciliation row left at needs review): firewall rules off, sign-ups confirmed open, watch for 48 hours.
- [ ] 21. T-6 dry-run counts for all **six** retention jobs, then resume each one by name.

`retention-district` stays unscheduled until the runbook's "Before scheduling `retention-district`" holds.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

---

## Environment confirmation

This session ran in the **Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2`** (`environment_kind: anthropic_cloud`), **not Sandbox**, confirmed with `get_session` at the start. I sent no message to any other session, and did not use `send_message`.
