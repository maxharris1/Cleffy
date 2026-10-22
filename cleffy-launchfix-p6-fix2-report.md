# Launchfix P6 fix round 2 report: PR #67 (go-live runbook, docs only)

Session: https://claude.ai/code/session_01BLc3pR8z2Cn6duSfk9U2RU

The packet asks for this report at `/workspace/cleffy-launchfix-p6-fix2-report.md`. That path is on Max's machine, so the report is not written there. It is committed only on the scratch branch `claude/launchfix-p6-fix2-report`, as `cleffy-launchfix-p6-fix2-report.md`. It is one commit on top of PR #67's final head, and it is not on the PR branch.

## Summary

- **PR:** #67, https://github.com/maxharris1/Cleffy/pull/67. It is still a **draft**, from `mh/launchfix-p6-golive-docs` into `dev`. No reviewers were requested, no labels were changed, and no new PR was opened.
- **Starting SHA:** `7bb274d253f43b9c362d0587f38295a602fcbef7`. `origin/mh/launchfix-p6-golive-docs` was at exactly this SHA when the session started, and had not moved when I pushed.
- **New PR #67 head:** `beb5c0044472206458ec0c420e408877a3b64bea`. This was a fast-forward push. Nothing was force-pushed.
- **Base:** `origin/dev` = `47e9b38f2dba36fdce852c80948245da344bcc20`, unchanged.
- **Environment:** the **Cleffy cloud environment** `env_01WAd3yiz3qpSnsofpyEwCh2`, **not Sandbox**. Confirmed at the start with `get_session`: `environment_id: env_01WAd3yiz3qpSnsofpyEwCh2`, `environment_kind: anthropic_cloud`.
- **Commit identity:** every commit is authored by Max Harris <drumaxter@gmail.com>.
- **Scope:** docs only. This round touches `DEPLOY.md` alone. No code, no migrations, no config, no CI.
- **PR #67 body:** refreshed (body only).
- **PR #54:** not touched in any way. Its updated body draft is below.
- **Done-when:**
    - #67 is fast-forwarded ✅;
    - local checks pass ✅;
    - GitHub Actions CI is green on the new head ✅ (see CI);
    - the **Vercel commit status is red**, with "Deployment rate limited — retry in 24 hours". That is Vercel's account-level build quota, not this change, and I cannot clear it without touching Vercel. Open question 1;
    - this report gives the new head and the changes ✅.

## Commits

| SHA        | Branch                                 | Summary                                                                          |
| ---------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| `beb5c004` | `mh/launchfix-p6-golive-docs` (PR #67) | docs(deploy): no data restore, session drain, paginated Stripe replay, P5 pepper |
| (report)   | `claude/launchfix-p6-fix2-report` only | report: launchfix P6 fix round 2 (this file). Its SHA is the branch head.        |

## Retention and cron counts (how I counted)

1. **Static.**
   `git grep -n "cron.schedule" origin/dev -- supabase/migrations` gives 10 jobs at `dev` 47e9b38f:
    - `omr-sweep`;
    - `imslp-sync`;
    - `content-notice-retry`;
    - `billing-mail-outbox`;
    - `district-seat-reconcile`;
    - the five `retention-*` jobs (archived-students 03:17, stale-guests 03:27, rate-limits 03:37, support-messages 03:47, compact-tombstones Sunday 04:23).

    The commented-out `retention-district` example is not counted.

    I then grepped the migrations each P1–P5 branch adds over `dev`, for `cron.schedule|unschedule|alter_job` and Vault:
    - **P1** (`275b188b`, 9 migrations): none;
    - **P3** (`1c9e8512`, 3): `support-inbound-retry`, `2-59/5 * * * *` (`20261022110200_support_inbound_lease.sql:353`), with Vault `support_inbound_url` / `support_inbound_secret`;
    - **P4** (`a9e98c92`, 1): none;
    - **P5** (`4ffd856d`, 2): `retention-content-strikes`, `7 4 * * *`, so 04:07 UTC (`20261022130100_content_strikes_survive_deletion.sql:270`), plus the Vault `content_strike_pepper`.

    No P1–P5 migration re-schedules an existing job.

2. **Live, on a local stack.** I made a scratch worktree at P5's head, added P1's, P3's and P4's migration files, and booted it (`scripts/local-up.sh --no-omr`). It had **111** migrations and **12 jobs, all created active**. **Six** of them are `retention-*`.

**Result:**

- **6 retention jobs.**
- **11 jobs** with P5 alone, which is the packet's figure.
- **12 jobs** with P3's `support-inbound-retry` as well. The runbook uses 12, marked "(confirm after P3)" / "(confirm after P5)".
- **111 migrations**, so step 11's third batch is **21**.
- Still **23** functions.

P2 adds no migration (`b3c47573`: 96).

## Changes, mapped to each finding and decision

### Codex round 2

- **MAJOR 1 (replay can omit paid transactions).**
    - **Pagination.** A tested `stripe_all` helper (step 6.7) follows `starting_after` until `has_more=false`. Every Stripe list in the runbook uses it: subscriptions, Checkout sessions and events.
    - **Order.** Checkout sessions are expired **before** the subscription list, so no purchase can complete after the list is read. Sessions since `FREEZE_AT` are listed with every status, and none may be newer than `REVOKE_AT`.
    - **Expected cancellation events.** They are named (step 6.7.2) and recorded as cancelled, without being resent.
    - **Bounded window.** It runs from `FREEZE_AT` to `ENABLE_AT`, and both are recorded.
    - **What is listed.** All nine types, plus `delivery_success=false` events from the 3 days before the freeze (step 18).
    - **Reconciliation table** (in Max's private ops log). Every object gets one disposition:
        - applied and verified;
        - safely irrelevant;
        - cancelled or refunded;
        - needs review. A 2xx with `ignored: unknown_user` (or any `ignored:`) is needs review, not success.
    - **Re-checks.** Stripe is reconciled again before the wipe (step 8) and after part B (step 18). Step 20 does not open while any row is needs review.
    - **Re-enabling replays nothing.** This is stated at 6.3 and in step 18.
    - **`charge.refunded` is unhandled.** Refunds stay manual (refund + cancel), and the log goes to Max's private ops log.
- **MAJOR 2 (recovery restores data before schema).** Decision 1 removes the data-restore procedure (see below).
- **MAJOR 3 (P5 pepper missing).**
    - Step 14 provisions a per-project random `content_strike_pepper`, generated in the database and never typed or shown. It is verified by length and with `content_strike_pepper(1)`.
    - It is never changed while keyed strikes exist. A re-apply creates a fresh one.
    - Step 18 adds a **struck-account deletion** smoke test, with a rolled-back transaction as the fallback.
    - Step 20 requires that test to pass.
- **MINOR 1 (Vercel override table).** The row now says the URL and key override routing only **as a pair** (`src/lib/supabase.ts:35–45`), and one alone is ignored. Both stay absent.
- **Inventory deltas.**
    - The P5 Vault pepper is in steps 4, 8.4 and 14.
    - P5's 04:07 job is in the timing (step 3: 03:00–04:30 UTC), the pause after batch 3, the 12-job check (13.4), and the sixth T-6 count with its named resume (21).
    - The counts are corrected.
    - The broad `like 'retention-%'` activation is replaced by explicit names.
    - P1's upsert is filled in.
- **r1 MAJOR 2 (freeze drain).** This is decision 4.
- **r1 MAJOR 3 (sixth job's gate).** This is decision 5.

### Cleffy decisions

1. **Simplify recovery.**
    - The intro, step 7, step 8 and _Abort and recovery_ say plainly:
        - prod data is not material (Max, 2026-10-21);
        - the backup (public data, auth and storage metadata, schemas, object list) is **for reference and forensics only**;
        - **no data restore is supported**.
    - Max re-confirms that in writing at step 8, together with "nothing material".
    - **Removed:**
        - step 7.3's local restore check (load and FK re-validation);
        - the "go back to the old data" path (reset, load the data dump and objects, re-create the R2 tables);
        - the object re-upload ("not uploaded… stands in").
    - Step 7.3 is now a **file check**: per-table `COPY` row counts against the snapshot, plus a `sha256` manifest.
    - **Abort paths:**
        - before the wipe: unfreeze and leave it (each part's rollback, listed);
        - after the wipe: fix forward, or re-apply from scratch, with the Vercel Instant Rollback first, the hook turned off, and step 8.1 onwards.
    - The re-create list:
        - Edge secrets;
        - Auth settings;
        - every Vault entry, including `content_strike_pepper`;
        - their cron callers, re-paused;
        - P1's row, Max's moderator row, and the Stripe table.
2. **Stripe replay.** See MAJOR 1 above. Checkout is blocked by the firewall, closed registration, bans and session deletion. `stripe-checkout` calls `getUser()` (`index.ts:85`), so a revoked session is refused at once. The block is verified Stripe-side: zero open sessions, and none created after `REVOKE_AT`.
3. **Pepper.** See MAJOR 3 above.
4. **Freeze drain.**
    - Step 6.4 pauses the old crons.
    - Step 6.5 revokes in three parts:
        - every account except Max's is banned through the admin API (paginated);
        - `delete from auth.sessions` and `auth.refresh_tokens`, with `REVOKE_AT` recorded;
        - a wait of `jwt_exp` + 5 minutes.
    - Step 6.6 is the drain check. Two readings 15 minutes apart must show:
        - no sessions or refresh tokens;
        - an unchanged ban count and `last_sign_in_at`;
        - unchanged `pg_stat_user_tables` write counters for `public` / `auth` / `storage`.

        Only then come the snapshot, Stripe and the backup.

    - JWT secret rotation is not used. The repo does not document it, and rotating the legacy secret would replace the committed anon key.
5. **Retention gate.** `retention-content-strikes` gets:
    - an immediate pause after batch 3;
    - a required-paused row in 13.4;
    - its own T-6 count, with the same predicate as `retention_purge_content_strikes()`;
    - a named resume. The resume SQL lists each job by name, with no pattern.
6. **Other fixes.**
    - **P1 upsert.** P1's exact statement is in 13.2, marked "(confirm after P1)". Note: Codex cited it at P1 `ba53d922`, `20261022100200_deployment_config.sql:19–24`. P1's head is now `275b188b`. `ba53d922` is an ancestor, and that file is unchanged between them.
    - **Vercel table.** Fixed (MINOR 1).
    - **Executable or removed.**
        - 8.1's empty-Storage placeholder (`<bucket>`, `<path>`) is now a tested loop.
        - The object byte download is optional, with `--linked` added, and tested locally.
        - The restore steps are removed.
        - _PITR_ no longer says "prove it restores as in step 7.3".
        - Step 9's "Step 17 checks the refusal" now reads step 18.
        - The R-section reference to "_Abort and restore_" is renamed to "_Abort and recovery_".
7. **#54 body draft.** Updated below:
    - the backup is no longer called auth/storage-complete;
    - retention is "created active, paused at once";
    - P5 is at `4ffd856d`, with the pepper and the sixth job;
    - the new counts.

    It is kept out of the repository. The `.bak-r2` backup was made on Max's machine.

8. **#67 body.** Refreshed, and copied below.

### Requester answers to the fix1 questions

1. **Webhook split.** Kept: part A, then the re-enable and replay, then part B.
2. **The #67 body.** Updated (decision 8).
3. **Stripe test keys on prod.** Unset. Step 9 is unchanged.
4. **Vercel Firewall operators.** Left as the verify-at-go-live steps they were. Step 6.1 says what to check, and the Max-only list marks it.
5. **Vault.**
    - Step 4 records the Vault **names** in the private ops log.
    - Steps 8.4, 14 and _Abort and recovery_ treat Vault as not surviving, and re-create every value.
6. **`storage cp`.** Verify at go-live. It is now optional and was tested locally. See the Max-only list.
7. **Fine as is.** Unchanged.
8. **Refund log.** It is "Max's private ops log, outside the repository" in _Refunds_ and in step 6.7's table. The "(confirm where with Max)" placeholder is removed.
9. **Hook via the API.** Verify at go-live. The dashboard path is unchanged.
10. **Fine as is.** Unchanged.

## Local evidence

All of this ran on a local stack: a scratch worktree at P5 `4ffd856d` plus the migration files of P1, P3 and P4, 111 in all, with CLI 2.121.0. Nothing was pushed from it. Every SQL write was inside a rolled-back transaction. The seeded `teacher@cleffy.local` and `student@cleffy.local` were never changed. The ban and session tests used three throwaway `drain*@example.invalid` users, which were deleted afterwards. The stack was stopped with `scripts/local-down.sh`, and the worktree removed.

- **Cron.**
    - 12 jobs, all active after the replay.
    - Pausing `imslp-sync` and the six `retention-*` jobs makes the new 12-job check (13.4) return 0 rows.
- **Grants check** (13.3), with the P1–P5 tables added:
    - `deployment_config`, `studio_supersede_log`, `student_claim_reservations`, `account_deletions`, `document_realtime_rotation_queue` and `district_retention_restores` as server-only;
    - `thumbnail_storage_cleanup` as client-read.

    It returned 0 rows.

- **P1's upsert:** `entitling_billing_modes()` = `{live}`.
- **Pepper.**
    - `vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), …)` gives a 64-character secret, and `content_strike_pepper(1)` is non-null.
    - A struck account's deletion gives `account_gone t`, `subject_key_version 1`, `keyed_to_address t`.
    - A new account with the same address gives `active_content_strikes = 1`.
    - With no pepper, the deletion fails: "the Vault secret content_strike_pepper is not set".
    - The step 18 fallback transaction, exactly as written, gives `t / 1 / t`.
- **Sixth T-6 count.** All six counts are 0. With two strikes of a deleted account backdated 13 months, the count is 2, and `retention_purge_content_strikes()` purged 2.
- **Revocation.**
    - After a ban, `/auth/v1/user`, refresh and password sign-in are each refused with `user_banned`.
    - After `delete from auth.sessions`, `/auth/v1/user` gives `403 session_not_found`, and the refresh gives `refresh_token_not_found`.
    - A PostgREST read with the same access token still gives `200`. That is why step 6.5.3 waits for `jwt_exp`.
    - `auth.refresh_tokens.session_id` is `ON DELETE CASCADE`.
    - The ban loop walked every page (`per_page=2` in the test) and banned only the selected users.
- **Storage.**
    - 8.1's loop deleted 3 nested objects, leaving `storage.objects` at 0.
    - `supabase storage cp -r ss:///scores … --local --experimental` downloaded a nested object.
    - The flags are accepted by CLI 2.121.0.
- **Dump file check.**
    - `db dump --local --data-only --use-copy --schema public,auth,storage` produced 103 `COPY` blocks.
    - The `awk` counts matched the database: `auth.users` 2, `auth.identities` 2, `public.documents` 3.
- **`stripe_all`.**
    - Run against a local mock of Stripe's list API: 250 objects, 3 pages, `limit=100` and `starting_after` passed through, and all 250 returned.
    - `types[]` was repeated correctly.
    - No call went to Stripe.

## Local checks (on `beb5c004`, before the push)

| Check                                              | Result                                                                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint:check`                               | ✅ exit 0                                                                                                                    |
| `npm run typecheck`                                | ✅ exit 0                                                                                                                    |
| `npm run test` (full suite)                        | ✅ exit 0: **219 files passed, 5 skipped (224); 3382 tests passed, 13 skipped (3395)**. `VITE_SUPABASE_*` blanked, as in CI. |
| `npm run build`                                    | ✅ exit 0                                                                                                                    |
| `npx prettier --check DEPLOY.md SETUP_SUPABASE.md` | ✅ "All matched files use Prettier code style!"                                                                              |

## CI on the final head (`beb5c004`)

GitHub Actions: every job on head `beb5c0044472206458ec0c420e408877a3b64bea` passed. There are two CI workflow runs, both `completed / success`:

- run **39737538437**, the `pull_request` event;
- run **39737529936**, the `push` event.

| Check            | Run 39737538437 (pull_request) | Run 39737529936 (push)        |
| ---------------- | ------------------------------ | ----------------------------- |
| `checks`         | ✅ success (job 119686679250)  | ✅ success (job 119686653880) |
| `supabase-local` | ✅ success (job 119686679028)  | ✅ success (job 119686653693) |
| `supabase-drift` | ✅ success (job 119686679341)  | ✅ success (job 119686653388) |
| `omr-service`    | ✅ success (job 119686679467)  | ✅ success (job 119686653797) |

Checks outside GitHub Actions:

- **Supabase Preview:** skipped (119686647152). It skips on every docs-only PR, as it did on `7bb274d2`.
- **Vercel** (commit status): ❌ **failure**, "Deployment rate limited — retry in 24 hours". The status points at Vercel's `build-rate-limit` upgrade page.
    - This is the account's build quota, not the change. The diff is docs only, and `npm run build` passes both locally and in `checks`.
    - P5's head deployed normally at 06:11 UTC. My push came at 07:00 UTC.
    - Because Vercel did not deploy, **Vercel Preview Comments** did not run.
    - Not fixed: I may not touch Vercel, and the rules forbid an empty commit to re-trigger it. See open question 1.

No fix round was needed for GitHub Actions.

## PR #67 body (refreshed, body only)

The body was replaced with the text below. The title, draft state, base (`dev`), reviewers and labels are unchanged. I checked after the edit: `draft: true`, `base: dev`.

```markdown
Launchfix P6, which covers re-audit BL-1. **Docs only.** It changes no code, no migrations, no `config.toml` and no CI. The diff against `dev` touches only `DEPLOY.md`, `SETUP_SUPABASE.md` and a comment in `.env.example`. Merge order: last, after P1–P5.

## What it adds

DEPLOY.md gets a new section, **"Go-live 2026-10: fresh production (wipe first)"**. It has steps 0–21, then _Abort and recovery_.

| Step  | What                                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Turn Supabase **Deploy to production** off, and check it (`git_branch` is `""`).                                                                                                                                                                                                                                                                                                                  |
| 1     | Land P1–P6 with CI green, and pin `GOLIVE_SHA`. Re-count. At the P1–P5 heads: **111 migrations**, **12 cron jobs** (6 `retention-*`).                                                                                                                                                                                                                                                             |
| 2     | Max's prerequisites, plus two `dev`-branch test-clock rehearsals (renewal; district invoice and grace).                                                                                                                                                                                                                                                                                           |
| 3     | The sitting is clear of 03:00–04:30 UTC. One worktree at `GOLIVE_SHA`, CLI 2.121.0, linked and checked. A `stage()` helper for batches.                                                                                                                                                                                                                                                           |
| 4     | Read-only inventory: Edge secrets, price overrides, Vercel `VITE_*` env, **Vault names** (assume Vault does not survive), OMR.                                                                                                                                                                                                                                                                    |
| 5     | Snapshot counts, taken again after the drain.                                                                                                                                                                                                                                                                                                                                                     |
| 6     | **Freeze:** firewall, sign-ups closed, webhook disabled, old crons paused, **every account but Max's banned and every session deleted**, wait out `jwt_exp`, then a **15-minute no-writes drain check**. Only then Stripe, with **paginated** lists: Checkout sessions expired first, then subscriptions cancelled. Every object gets a row in a reconciliation table (in Max's private ops log). |
| 7     | **Backup, for reference and forensics only:** public data, auth/storage metadata, schemas, object list, and a file check. **No data restore is supported.**                                                                                                                                                                                                                                       |
| 8     | Freeze re-checked. **Max confirms in writing** (nothing material; no restore). Then the wipe: an executable Storage-emptying loop, sequences, reset to `main`'s 26, and Vault callers withheld.                                                                                                                                                                                                   |
| 9–10  | Edge secrets (test pair, aliases, overrides, AI key, OMR unset; P3's `SUPPORT_RETRY_SECRET`), then Auth.                                                                                                                                                                                                                                                                                          |
| 11    | Three staged batches: 4 → pause `imslp-sync`; 60 → pause five `retention-*`; 21 → pause `retention-content-strikes` (P5).                                                                                                                                                                                                                                                                         |
| 12–13 | Functions by hand. Checks: `STRIPE_MODES`, **P1's exact `deployment_config` upsert**, grants (P1–P5 tables), the 12-job cron check, `verify_jwt`.                                                                                                                                                                                                                                                 |
| 14    | Vault: five caller pairs, plus a **per-project random `content_strike_pepper`**, generated in the database. Then `imslp-sync` is resumed.                                                                                                                                                                                                                                                         |
| 15–17 | Moderator row. Max merges #54 behind the freeze. The hook goes on, then one sign-up and one join.                                                                                                                                                                                                                                                                                                 |
| 18    | Smoke tests. Part A includes `503 ai_unavailable` and a **struck-account deletion** (the pepper). Then the webhook is re-enabled, and the bounded window plus earlier undelivered events are **listed and given a disposition** (re-enabling replays nothing; `ignored: unknown_user` = needs review). Then part B with real money, and a final reconciliation.                                   |
| 19–20 | Integration back on. Open only when no reconciliation row says needs review.                                                                                                                                                                                                                                                                                                                      |
| 21    | T-6 dry-run counts for all **six** retention jobs, then a resume of each named job.                                                                                                                                                                                                                                                                                                               |

**Abort and recovery.**

- Before the wipe: unfreeze and leave it.
- After the wipe: fix forward, or re-apply from scratch (with a Vercel rollback). It lists what must be re-created: Edge secrets, Auth settings, every Vault entry (including the pepper), and their cron callers.

**Reference subsections:** _Before scheduling `retention-district`_, _Stripe webhook events_ (9 types), _Refunds_ (manual refund + cancel, logged in Max's private ops log; no `charge.refunded` handler), _PITR_, _STRIPE_MODES_.

**Other edits:**

- The Status rows.
- The old release checklist is marked superseded.
- Recovery is marked historical.
- The Vercel override row: the URL and key override routing only as a pair.
- `SETUP_SUPABASE.md` §6b/§6c.
- `.env.example`: `VITE_STRIPE_PUBLISHABLE_KEY` is marked unused.

## Marked "(confirm after P<N>)"

The names are filled in from the P1–P5 branch heads: P1 `275b188b`, P3 `1c9e8512`, P4 `a9e98c92` and P5 `4ffd856d`. They are still to be confirmed against what merges:

- P1's upsert and tables;
- P3's `support-inbound-retry`, its Vault pair and `SUPPORT_RETRY_SECRET`;
- P4's table;
- P5's job, pepper and count;
- P5's hourly notice-sender cron (not on P5's branch yet).

## Verification

- A local stack with dev + P1/P3/P4/P5's migrations (111):
    - 12 cron jobs, all created active;
    - the 12-job cron check and the extended grants check return 0 rows;
    - P1's upsert gives `{live}`;
    - the pepper SQL creates a 64-character secret;
    - a struck-account deletion keys the strike, and an account with the same address inherits it;
    - without the pepper, the deletion fails;
    - the sixth T-6 count matches `retention_purge_content_strikes()`.
- Session revocation, on the local stack:
    - a ban refuses `/user`, refresh and sign-in;
    - deleted sessions give `403 session_not_found`;
    - PostgREST still accepts the token until it expires.
- The Storage loop, the optional download and the dump file counts.
- The `stripe_all` paging helper, against a mock 250-item list (3 pages).
- `npm run lint:check`, `typecheck`, `test` (219 files / 3382 tests pass, 13 skipped), `build` and prettier: all pass.

Nothing hosted was touched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01BLc3pR8z2Cn6duSfk9U2RU
```

## Updated PR #54 body draft

The full text follows. It is not committed on the PR branch, and #54 was not edited. Paste it into #54 once P1–P5 land and each "(confirm after …)" is filled in.

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

- **P1:** the `deployment_config` live-only row, so `entitling_billing_modes()` is `{live}` from data after a fresh replay. A fresh replay otherwise ships `{live,test}`, which is R1's landmine. The runbook runs P1's exact upsert at step 13.2. (branch head `275b188b`; confirm after P1)
- **P2:** (confirm after P2)
- **P3:** the inbound retry cron, `support-inbound-retry`. Its Vault pair is `support_inbound_url` / `support_inbound_secret`, and its Edge secret is `SUPPORT_RETRY_SECRET`. (branch head `1c9e8512`; confirm after P3)
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
    - a freeze before the backup: firewall, sign-ups closed, webhook off, **sessions revoked and writes drained**, then Stripe reconciled with **paginated** lists;
    - a backup **for reference only**: `public` data, `auth` and `storage` metadata, schemas and the object list, with a file check. Object bytes are optional, and **no restore is supported**. The abort path is to unfreeze before the wipe, and after it to fix forward or re-apply from scratch;
    - the retention and IMSLP pauses, Vault withheld until the functions are checked, and the strike pepper;
    - backend-level smoke tests, including `503 ai_unavailable` and a struck-account deletion;
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
- [ ] 3. The sitting is outside lesson hours, clear of 03:00–04:30 UTC, and allows 3–4 hours. One worktree at `GOLIVE_SHA`, CLI 2.121.0, linked to `jibgwgosihadbjgxdsfe`, with the ref checked.
- [ ] 4. Read-only inventory:
    - Edge secrets;
    - no `STRIPE_PRICE_*` overrides;
    - the Vercel `VITE_*` build env (URL and key are an override only as a pair, and both stay absent);
    - Vault **names** (assume Vault does not survive);
    - OMR.
- [ ] 5. Snapshot counts.
- [ ] 6. **Freeze:**
    - Vercel Firewall deny (Max bypassed);
    - sign-ups closed;
    - live webhook disabled (`FREEZE_AT`);
    - old crons paused;
    - every account but Max's banned, and every session deleted (`REVOKE_AT`);
    - wait out `jwt_exp`, then a 15-minute **no-writes drain check**;
    - snapshot again;
    - Stripe reconciled directly, **every list paginated**: open Checkout sessions expired first, then subscriptions cancelled. Each one gets a row in the reconciliation table.
- [ ] 7. Backup **for reference only**: public data, auth/storage metadata, schemas, object list, and a file check. No restore.
- [ ] 8. Freeze re-checked. **Max confirms in writing**: nothing material, and no data restore. Then empty Storage, reset to `main`'s 26 and withhold the Vault caller secrets. `pd_pdf_store` and `playalong_corpus*` now exist only in the backup.
- [ ] 9. Production Edge secrets, with the AI key, OMR, the Stripe test pair, legacy aliases and price overrides **unset**, and P3's `SUPPORT_RETRY_SECRET` set.
- [ ] 10. Auth: Confirm email ON, password policy, redirect URLs including `www`, SMTP. Sign-ups stay closed, **hook still OFF**.
- [ ] 11. Migrations by hand:
    - batch 1 (4), then pause `imslp-sync`;
    - batch 2 (60), then pause the five `retention-*`;
    - batch 3 (the rest, 21 at the heads), then pause `retention-content-strikes`.
- [ ] 12. All 23 functions deployed by hand; buckets checked.
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
    - re-enable the live webhook, then list the freeze window and the earlier undelivered events (paginated). Give each a disposition, and treat `ignored: unknown_user` as needs review;
    - part B: a real Teacher purchase, roster and invite mail, renewal replay, refund **and** cancel, delete the throwaway accounts, then reconcile Stripe once more.
- [ ] 19. Deploy to production back ON.
- [ ] 20. Open (no reconciliation row left at needs review): firewall rules off, sign-ups confirmed open, watch for 48 hours.
- [ ] 21. T-6 dry-run counts for all **six** retention jobs, then resume each one by name.

`retention-district` stays unscheduled until the runbook's "Before scheduling `retention-district`" holds.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

---

## Files touched and deviations

**Files.** `DEPLOY.md` only, in this round. Every hunk is inside the "Go-live 2026-10" section and its reference subsections:

- the intro;
- steps 1, 3, 4, 5, 6, 7, 8, 9, 11, 13, 14, 17, 18, 20 and 21;
- _Abort and recovery_ (renamed from _Abort and restore_);
- _Before scheduling `retention-district`_ (P5 SHA);
- _Refunds_ (log location);
- _PITR_.

Prettier re-aligned the step 4 Vercel table. `SETUP_SUPABASE.md` and `.env.example` are unchanged since `7bb274d2`. No code, migrations, `config.toml`, CI, `scripts/apply-migrations.sql` or tests were touched.

**Deviations:**

1. **Report location.** `/workspace` is not reachable, so the report is on `claude/launchfix-p6-fix2-report` (as instructed).
2. **Harness branch.** The harness pre-assigned `claude/launchfix-p6-fix2-report-jdjnjr`. Per Max's instructions, I used only `mh/launchfix-p6-golive-docs` and `claude/launchfix-p6-fix2-report`. Nothing was pushed to the pre-assigned branch.
3. **12 jobs, not 11.** The packet says "11 total, or whatever the code shows". The code shows 12 once P3's `support-inbound-retry` is counted, and 11 with P5 alone. The runbook uses 12, with both marked "(confirm after P<N>)".
4. **P3 placeholders filled in.** P3's names were taken from its branch head `1c9e8512`, and are still marked "(confirm after P3)":
    - Vault `support_inbound_url` / `support_inbound_secret`;
    - Edge secret `SUPPORT_RETRY_SECRET`;
    - job `support-inbound-retry`.

    The same applies to the P1–P5 tables in the grants check. These are additions beyond the packet. They follow from "update the inventory", and they make the checks runnable.

5. **Session revocation uses bans, not a "sign out all" call.** I found no Auth admin endpoint that signs out every user by id. A ban (`ban_duration`), plus deleting `auth.sessions`, plus waiting `jwt_exp` does the job, and was verified locally. JWT secret rotation is not used: it is undocumented in the repo, and rotating the legacy secret replaces the committed anon key.
6. **The drain check is stricter than the packet.** It asks for no writes at all in `public`, `auth` and `storage`, measured from `pg_stat_user_tables`, rather than only "no new rows in auth, sessions or activity tables". Old crons are paused first, so the check has nothing to explain away.
7. **Object bytes.** Decision 1 defines the backup as metadata plus the object list. The byte download is therefore **optional** and kept only for forensics. It is not deleted, because a backup of what is about to be erased seemed worth keeping as an option. Open question 3.
8. **The pepper is generated inside the database** with `extensions.gen_random_bytes(32)`. No value is ever typed, copied or stored elsewhere. With no restore supported, nothing needs a copy.
9. **Docs from my own knowledge.** These Stripe API filters are cited from my knowledge of the API, not from a live call (no Stripe was touched):
    - `delivery_success=false` and `types[]` on `GET /v1/events`;
    - `created` on Checkout Sessions list.

    Also the claim that disabling an endpoint stops retries, as Codex's review states. Open question 2.

## Open questions

1. **Vercel status is red on `beb5c004`.** The message is "Deployment rate limited — retry in 24 hours", and the target is `vercel.com/…?upgradeToPro=build-rate-limit`.
    - This is the account's daily build quota, presumably spent by the parallel launchfix pushes. P5's `4ffd856d` deployed fine at 06:11 UTC.
    - It is not caused by this docs-only change.
    - I may not touch Vercel, and an empty commit to re-trigger it is not allowed, so I left it.
    - **Max:** either redeploy that commit in Vercel once the quota resets, or accept it, since the PR is docs-only. Every GitHub Actions check is green.
2. **Stripe API details to verify at go-live.** The step 18 `stripe_all` calls use `delivery_success=false` + `types[]` on events, and `created[gte]` on Checkout Sessions. If one is refused, the helper stops with Stripe's error (it never silently returns a short list). Fall back to listing without that filter and filtering with `jq`.
3. **Object bytes.** Should the optional download (step 7.2) be dropped entirely? Or should it become required, for forensics on user PDFs?
4. **`per_page=500` in the ban loop.** It was tested locally with 2. If hosted Auth caps the page size lower, the loop still walks every page, because it stops on an empty page, not on a short one.
5. **The anon key is still accepted** by PostgREST after a ban plus session deletion, until `jwt_exp`. The runbook waits for it. If production's `jwt_exp` is long, the freeze takes that long. Check `jwt_exp` before choosing the slot (step 3 allows 3–4 hours).
6. **"(confirm after P<N>)" placeholders kept:**
    - P1: the 13.2 upsert, and the grants-list tables (13.3);
    - P3: `SUPPORT_RETRY_SECRET` (9), `support_inbound_*` (8.4 and 14), `support-inbound-retry` (13.4), and the grants tables;
    - P4: `document_realtime_rotation_queue` (13.3);
    - P5: the `retention-content-strikes` pause (11.3), its 13.4 row and T-6 count (21), the grants table, and the hourly notice-sender cron (_Before scheduling `retention-district`_). That cron is still not on P5's branch at `4ffd856d`;
    - the counts as a whole (intro and step 1): 111 / 21 / 12;
    - P2 and P4 lines in the #54 draft;
    - the re-audit T-id mapping (step 18), and re-audit §4 item 8 (step 9).
7. **Still verify-at-go-live, per Max's answers 4/5/6/9:**
    - the Vercel Firewall operator names;
    - whether Vault survives the reset (the runbook assumes not);
    - `supabase storage cp` against hosted (optional now);
    - the hook via the dashboard;
    - plus the hosted Auth endpoints in 6.5 (ban and session deletion), which were verified only on the local Auth server.

## Updated Max-only steps

I performed none of these. Every one is hosted, or touches money or DNS.

- **Before the sitting**
    - Step 0: Deploy to production off, and check it.
    - Step 1:
        - land P1–P5, then #67;
        - regenerate the mirror and pin `GOLIVE_SHA`;
        - re-count: 111 / 12 at the current heads;
        - run `git grep cron.schedule`;
        - replace the "(confirm after P<N>)" names;
        - update #54's body from the draft below.
    - Step 2: legal; tax; Stripe Tax and `configure-tax.mjs`; portal; **all 9 webhook events on both endpoints**; DNS; the Resend quota; the two `dev`-branch test-clock rehearsals. Once P5 is on `dev`, also create the **`dev` project's own `content_strike_pepper`**.
    - Step 3:
        - a slot clear of 03:00–04:30 UTC, of 3–4 hours (check `jwt_exp`);
        - the IP addresses;
        - the worktree, CLI and link.
    - Step 4: inventories (Edge secrets, price overrides, Vercel env, **Vault names into the private ops log**, OMR).
    - Step 5: first snapshot.
- **The sitting (steps 6–20)**
    - Step 6:
        - firewall;
        - sign-ups closed;
        - webhook disabled (`FREEZE_AT`);
        - old crons paused;
        - **ban every account but Max's, delete sessions (`REVOKE_AT`), and wait `jwt_exp` + 5 minutes**;
        - **15-minute drain check**;
        - snapshot again;
        - **Stripe with paginated lists**: expire sessions, then cancel and refund subscriptions;
        - start the **reconciliation table** in the private ops log.
    - Step 7: backup for reference, and the file check.
    - Step 8: re-check the freeze. **Written confirmation: nothing material, and no restore.** Then the wipe.
    - Steps 9–10: secrets (including `SUPPORT_RETRY_SECRET`) and Auth.
    - Step 11: three batches, each with its pauses (including `retention-content-strikes`).
    - Step 12: functions and buckets.
    - Step 13: checks, including P1's upsert and the 12-job cron check.
    - Step 14: Vault (five pairs) **plus the production `content_strike_pepper`**, then resume `imslp-sync`.
    - Step 15: moderator row.
    - Step 16: **merge #54**.
    - Step 17: hook, and the test accounts.
    - Step 18: smoke tests, including the **struck-account deletion**. Then re-enable the webhook (`ENABLE_AT`), list and dispose of every event, run part B, and reconcile once more.
    - Step 19: integration back on.
    - Step 20: open, only with no needs-review rows. Watch.
- **After opening**
    - Step 21: six T-6 counts, then resume each job by name.
    - _Before scheduling `retention-district`_, when its conditions hold.
    - Status rows 22–23, once both endpoints carry 9 events.
    - The PITR decision.
    - The Vercel deployment of `beb5c004`, if a green status is wanted (open question 1).

## Hosted steps left for Max

I performed none, and nothing hosted was touched:

- not `jibgwgosihadbjgxdsfe` or `qdbnlrgylelelvwbkvnm`;
- not Vercel;
- not Stripe (live or test);
- not Resend;
- not PR #54.

My only GitHub writes were:

- the fast-forward push to `mh/launchfix-p6-golive-docs`;
- PR #67's body edit;
- the push of this report branch.

The full list is "Updated Max-only steps" above: the whole runbook, steps 0–21. Also paste the #54 body from this report.

## Expected conflicts with the other launchfix PRs

- **`DEPLOY.md`, inside the go-live section.** It was rewritten again. Any P1–P5 PR that documents itself inside it will conflict: P1's `deployment_config` step, P3's Vault names, or P5's pepper note. Resolve by keeping this version's structure, and checking their names against the "(confirm after P<N>)" spots:
    - 8.4, 9, 11.3, 13.2–13.4, 14 and 21;
    - the intro counts;
    - _Before scheduling `retention-district`_.
- **`DEPLOY.md` outside it.** This round changed nothing there.
- **`SETUP_SUPABASE.md` and `.env.example`.** Unchanged since fix round 1, so the same expectations hold. A PR touching §6b's Stripe secrets table conflicts. P3 adding `SUPPORT_RETRY_SECRET` to §6b would sit beside it.
- **Migrations, `scripts/apply-migrations.sql`, tests.** Not touched. If P1–P5 change what they schedule before they merge, step 11's batches, 13.4's expected list and step 21 need updating.

## Environment confirmation

This session ran in the **Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2`** (`environment_kind: anthropic_cloud`), **not Sandbox**. I confirmed it with `get_session` at the start. I sent no message to any other session, and used no `send_message`.
