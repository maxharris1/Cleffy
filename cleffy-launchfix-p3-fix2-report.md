# Launchfix P3 fix round 2 report: PR #70

**Status:** Complete

Written by the P3 fix-round-2 Claude session, 2026-10-22. The packet asked for this report at `/workspace/cleffy-launchfix-p3-fix2-report.md`. `/workspace` is on Max's machine, so per the session brief it is on the scratch branch **`claude/launchfix-p3-fix2-report`**: the final PR #70 head plus one commit adding this file. The earlier report branches (`claude/launchfix-p3-report`, `claude/launchfix-p3-fix1-report`) were not touched.

## Summary

- Codex's round-2 REVISE is addressed: the one MAJOR (same-token reset race), the MINOR (24-hour copy), and packet items 1–7.
- PR #70 was fast-forwarded from `c07fc112` to **`dca83489`**. It is still a draft with base `dev`; only its title and body were edited.
- Local checks are green, and CI is fully green on the final head (push run 39749233142, pull_request run 39749239174), including the new `edge-functions-deno` job.
- `npm run cloud:down` has run.
- Nothing was merged, nothing went to dev or main, and no hosted service was touched.

## Environment

- **Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2`** (environment kind `anthropic_cloud`), **not Sandbox**. Confirmed with `get_session` at the start.
- Started with `git fetch origin && git checkout -B mh/launchfix-p3-edge-hardening origin/mh/launchfix-p3-edge-hardening`. HEAD was `c07fc112a50e21dfc02a9a550cf7e076340424a6` as expected; origin had not moved past it.
- Commit identity: `Max Harris <drumaxter@gmail.com>`. One push to `mh/launchfix-p3-edge-hardening` (`git push origin HEAD:mh/launchfix-p3-edge-hardening`, `c07fc11..dca8348`), a fast-forward. Nothing was force-pushed.
- The harness named `claude/launchfix-p3-fix2-40slz3` as this session's working branch. The explicit brief was followed instead: only `mh/launchfix-p3-edge-hardening` and `claude/launchfix-p3-fix2-report` were written.
- No other session was messaged; `send_message` was not used.

## PR and SHAs

|                     |                                                                            |
| ------------------- | -------------------------------------------------------------------------- |
| PR                  | **#70**, draft, `mh/launchfix-p3-edge-hardening` → `dev` (no new PR)       |
| Starting head       | `c07fc112a50e21dfc02a9a550cf7e076340424a6`                                 |
| **New PR #70 head** | **`dca834899d15878eab409c6eff6b160a01bb4eb8`**                             |
| Base                | `dev` at `47e9b38f2dba36fdce852c80948245da344bcc20` (unchanged)            |
| Report branch       | `claude/launchfix-p3-fix2-report` = new head + one commit adding this file |

## Commits (on top of c07fc112)

| SHA       | Summary                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------- |
| `5689742` | fix(student-provision): a fresh worker lease per reset attempt, fenced before each Auth write (item 1)  |
| `6bfa8a3` | ci: deno check the Edge Function entry points without node_modules (item 5)                             |
| `ad0e63a` | fix(moderation): no fixed deadline in the queued-report copy; accurate starvation comments (items 3, 4) |
| `7565f49` | fix(edge): service-role writers ask account_deletion_pending() before they write (item 2)               |
| `dca8348` | test(account): pin the try-again message for a deletion refused during checkout (decision 58(3))        |

## How each item was addressed

### Item 1 / Codex r2 Part B MAJOR: two retries with one reset token could both write the password

New migration **`20261022110700_student_code_reset_worker.sql`**. The resume token now says only _which_ reset continues. _Who_ may act on it is a separate worker lease.

- **Per-attempt lease.** `student_claim_reservations` gains four columns: `worker uuid`, `worker_epoch bigint` (from the new sequence `student_code_reset_epoch`, which only goes up), `worker_in_auth boolean` and `claimed_at_seen timestamptz`. `reserve_student_code_reset()` keeps its signature and gives every attempt a fresh worker id and epoch, taken under the roster row lock and then the reservation row lock.
    - A retry presenting the token takes a new lease, which fences out the previous worker.
    - The exception: if that previous worker is inside an Auth call (it passed a fence and has not reported back), the retry is told `busy` (409 `reset_in_progress`, "still finishing").
- **Fence before each Auth side effect.** The worker calls `fence_student_code_reset(student, reservation, worker, epoch)` immediately before the password write and again immediately before the session revocation. The fence answers `ok` only when all of these hold:
    - this worker and epoch still own the live reservation;
    - no claim has happened since the reservation was taken (the roster's `login_code_hash` and `claimed_at` still equal the values snapshotted then).

    On `ok` it marks the worker as in an Auth call and renews the 600 s hold. On `lost` the worker stops without touching Auth.

- **Completion and report-back.**
    - `complete_student_code_reset(student, reservation, worker, epoch, hash)` writes only for the current worker, with the same no-claim check. The token-only 3-argument version is dropped; it existed only in this unmerged PR.
    - `stop_student_code_reset_worker(...)` is how a failed worker reports back. The hold stays (the old card stays unclaimable), and the token can resume at once.
    - `release_student_code_reset` now refuses while a worker may be in an Auth call.
- **Why takeover is blocked during an Auth call.** A write already sent to Auth cannot be called back, so taking over then would reopen the race. A worker that died inside an Auth call holds the row until the hold runs out: at most 600 s from its last fence, which is longer than an Edge Function can run (400 s). This is the "held for up to 10 minutes" the roster already shows (decision 49 item 5). The rule follows both the packet (fresh lease, fencing epoch, re-verify before each side effect) and Codex's suggested fix ("allow recovery only after the previous worker has finished or cannot still write").
- **Code.** The code-reset path moved out of `student-provision/index.ts` into a new import-free **`_shared/studentCodeReset.ts`** (`runCodeReset` plus ports), so the tests drive the real worker. `student-provision` binds the ports (`codeResetPorts`) and maps the outcomes to the same responses as before (`reset_in_progress`, `claim_in_progress`, `reset_incomplete` with `resetToken`, `reset_lost`, 404, 502). The `reset_lost` text now reads "This reset was overtaken by a newer one. Try the reset again."
- **Tests.** In `tests/security/studentClaim.test.ts` the in-memory roster now models the lease, and every case drives `runCodeReset`:
    - **"two paused retries of one token: B completes, the student claims, A resumes and does nothing"**. A first try fails and returns token T. Retry A presents T and pauses right before its first fence. Retry B presents T and completes. The student claims B's card, sets a password and signs in. A resumes: `lost`. Asserted: no extra password write, no session revocation, no completion; the student's password, session and claim all stand.
    - "a newer lease fences out an older worker while the hold is still live"
    - "a retry cannot start behind a worker that may be inside an Auth call"
    - "a worker that reported back lets the retry resume its hold at once"
    - "a claim that lands while the hold had run out fences the reset out before any Auth write"
    - The r1 "reset, reset, claim" test, now driven through the worker.
- **SQL proof.** `tests/sql/student_claim_reservation.sql` has a new **section 8** (checks 90–99f) with the same interleavings statement by statement on student 10. It also covers the in-Auth refusal of takeover and of release (student 11), a claim after the hold ran out (student 12), a claim commit under a live hold caught by the no-claim check (student 13), the 3-argument completion being gone, and client roles refused for fence and stop (73c, 73d). The proof went from **73 to 99 checks**.
- **Source guards.**
    - `studentResetWiring.test.ts` (rewritten, 5 tests): every port passes `p_worker`/`p_epoch`; the worker fences before the scramble and again before the sessions.
    - `studentSessions.test.ts`: the code path's sessions are now checked in the worker.

### Item 2: service-role writes and the deletion barrier

- **What was uncovered.** Every DB guard from rounds 0 and 1 is a trigger (on `documents`, `managed_students`, `document_members` and `checkout_attempts`), and triggers fire for the service role too. Only the storage policies are RLS, which the service role bypasses. Some service-role work is also outside the database altogether: Auth, Stripe, an OMR job.
- **The helper.** New import-free **`_shared/deletionPending.ts`**. `accountDeletionPending(client, userId)` calls the same `account_deletion_pending()` predicate the triggers and policies use, and fails closed (`ok: false` on any error). One 409 body with code `account_deletion_pending`.
- **Edge functions that now call it**, each before its first service-role write and refusing with 409 while the deletion is pending (502 if the check cannot be answered):
    - **`student-provision`**: before every action (create, reset, archive, restore, delete). These include Auth writes that no trigger can refuse.
    - **`stripe-checkout`**: first thing in `beginAttempt`, so before the lease and therefore before any Stripe customer, `billing_customers` row or session. The `checkout_attempts` trigger stays the in-transaction backstop.
    - **`imslp-download`**: before the import spends quota, writes the licence cache, inserts the `documents` row or uploads.
    - **`score-analyze`**: for the score's owner, before metering or `omr_enqueue_job`.
- **Share redemption.** No Edge Function redeems share links. `redeem_share_link`'s insert is refused by the `document_members` trigger, which calls the same predicate (fix round 1).
- **Upload signers.** None exists: no `createSignedUploadUrl` in any function. The one Edge upload (`imslp-download`) uses the caller's client, so the restrictive storage policies apply, and it now also checks first.
- **Not wired, with reasons:**
    - `delete-account` (it is the deletion);
    - `stripe-webhook` and `billing-cancel` (cancellation and Stripe's own events must land during a deletion);
    - `content-report` (anyone may report);
    - `guest-email-start` / `guest-email-confirm` (guests never get a marker: `deleteGuest` takes no attempt);
    - `student-claim` / `student-login` (the student's own account, which a teacher-side deletion removes);
    - `analyze-annotations` / `analyze-notes` (they write only rate and quota counters);
    - `stripe-portal` (reads only, no write).
- **Tests.** `tests/account/deletionPendingWiring.test.ts` grew from 9 to 15 tests:
    - the helper (asks the one predicate; only a literal `true` is pending; error and throw fail closed);
    - each of the four functions asks before its first write;
    - a failed check returns instead of passing.

    The checkout flow's 409 mapping is the existing `checkoutFlow.test.ts` case. A live HTTP check of these refusals belongs with the P6 smoke tests (no hosted access here; see "Follow-ups").

### Item 3 / Codex r2 Part A MINOR: ReportContentPage.tsx:195

The queued confirmation now reads: "We've received your report and will email a confirmation to {email} as soon as possible; keep this reference meanwhile." It no longer promises "within 24 hours" or "shortly". `ReportContentPage.test.tsx` pins it and fails on any "N hours".

### Item 4: copy and comment accuracy

- `resend-inbound/handler.ts`: the "no amount of inbound mail can delay them" comment is gone. It now says the separate buckets keep inbound from spending the acknowledgments' share (no starvation through the budget), but both send through one Resend account whose rate limit is shared and has no priority.
- `_shared/mailBudget.ts`: the split comment says the same.
- The contentReports test that read "cannot delay an acknowledgment" was renamed to "…leave the acknowledgment budget untouched".

### Item 5: deno check in CI

- **`supabase/functions/deno.json`** (new): `{ "nodeModulesDir": "none", "lock": false }`.
    - `nodeModulesDir: "none"` makes `npm:` specifiers resolve from Deno's own cache.
    - `lock: false` stops Deno writing a `deno.lock` next to the functions. Without it a `deno.lock` appeared.
- Deno finds a config from the **working directory**, not from the entry file, so the check passes `--config supabase/functions/deno.json` explicitly.
- **Reproduced Codex's failure first.** In a `git archive` copy of the branch with no `node_modules`, `deno check supabase/functions/student-claim/index.ts` failed with `Could not find "@supabase/supabase-js" in a node_modules folder`. With the config, all five named entry points printed `Check …` and exited 0.
- **CI hunk** (flag for the P1 rebase). A new job **`edge-functions-deno`**, appended as one separate hunk at the very end of `.github/workflows/ci.yml`, away from the `supabase-local` hunks that P1 (#69) and P5 (#66) edit:

    ```yaml
    edge-functions-deno:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
            - uses: denoland/setup-deno@v2
              with:
                  deno-version: v2.1.4
            - name: deno check the Edge Function entry points
              run: deno check --config supabase/functions/deno.json $(ls supabase/functions/*/index.ts | grep -v '/score-analyze/')
    ```

    - It checks **22 entry points**, including resend-inbound, delete-account, student-provision, stripe-checkout and student-claim. It needs no `npm ci`.
    - Deno 2.1.4 is the version the local edge runtime (supabase-edge-runtime 1.77.4) reports. 2.5.6 also passed locally.
    - **score-analyze is excluded:** it has 6 type errors (supabase-js client generics, `SupabaseClient<any,"public",…>` vs `never`). The same 6 appear on `dev` (checked on a `git archive` of `origin/dev` with the same config). P3's changes there add none: still 6 after item 2. Follow-up 2.

- **Runtime effect checked.** The local edge runtime picks up the new deno.json. Its function workers fail to boot here either way, with or without the file: it fetches `npm:` packages from registry.npmjs.org and this container's TLS proxy is not trusted inside the runtime container (`invalid peer certificate: UnknownIssuer`). So `nodeModulesDir: "none"` matches what the runtime already does (it never used the repo's `node_modules`). Live function boot with the file is part of the P6 smoke tests.

### Item 6: accepted, docs only

- Orphaned provisioning accounts: exact runbook text is below.
- Apt packages stay unpinned; base images are pinned by digest (unchanged from fix round 1).

### Item 7: PR #70 body refreshed

The title and body were updated through the GitHub API, the equivalent of `gh pr edit 70 --title … --body-file …`:

- **Title:** "launchfix P3: edge hardening (inbound mail, body caps, claim/reset races, deletion barrier)".
- **Body:** the current state across rounds 0–2. It covers all eight migrations, the budget split, the reset worker lease, the barrier and its service-role callers, the deno CI job (flagged for the P1 rebase), tests and hosted steps.

Nothing else about the PR changed: draft state, base `dev`, reviewers, labels and comments are all as they were. No reviewer was requested.

### Codex round-2 findings

| Finding                                                    | Outcome                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Part A: SHIP (r1 items fixed)                              | No change needed                                                                                                          |
| Part A MINOR: unenforced 24-hour promise                   | Fixed (item 3)                                                                                                            |
| Part A: comment overstated ("no amount of inbound mail…")  | Fixed (item 4)                                                                                                            |
| Part B MAJOR: same-token resume admits concurrent writers  | Fixed (item 1), with a two-paused-retries test and SQL proof section 8                                                    |
| Part B MAJOR 3 partial: provisioning orphans / Storage API | Orphans: manual runbook (item 6, text below). Storage API byte lifecycle: unchanged follow-up. Service-role paths: item 2 |
| Part B MINOR partial: apt unpinned                         | Accepted (decision 59)                                                                                                    |
| deno check could not resolve without node_modules          | Fixed (item 5), and now in CI                                                                                             |

### Requester answers (decisions 49 and 58)

- **49(1)** Live HTTP checks stay with the P6 go-live smoke tests. Added below: two same-token reset retries, and a checkout/upload/provision during a deletion.
- **49(2)** Audiveris/tessdata pins: unchanged.
- **49(3)** Inbound budget category: unchanged.
- **49(4)** No requeue: unchanged.
- **49(5)** The "held for up to 10 minutes" UI is unchanged, and still true with the worker lease.
- **49(6)** Runbook now, cron later: see below.
- **49(7)** The pre-existing failing proofs are still P1's.
- **58(1)** Raise `studentAccountMail` before the first district contract: a pre-district follow-up, not this round.
- **58(2)** Per-teacher and per-address student mail limits: unchanged.
- **58(3)** The 409 during a live checkout lease: the UI already shows the server's words, "A checkout is open in another tab or window. Close it, wait a few minutes, and try again. Nothing has been deleted." `DeleteAccountSection` renders the server's `error` text and stays open for a retry. No UI change was needed; it is now pinned server-side (`tests/account/accountDeletion.test.ts`) and UI-side (`DeleteAccountSection.test.tsx`, "a deletion refused during a checkout says to wait a few minutes and try again").
- **58(4)** The three failing proofs are still P1's; same checks fail as before.
- **58(5)** deno check: done this round, locally and in CI (item 5).
- **PR body refresh:** done (item 7).

## Tests and SQL proofs added or changed

- `tests/security/studentClaim.test.ts`: 15 → **19**. New: **"two paused retries of one token: B completes, the student claims, A resumes and does nothing"**, "a newer lease fences out an older worker while the hold is still live", "a retry cannot start behind a worker that may be inside an Auth call", "a worker that reported back lets the retry resume its hold at once", "a claim that lands while the hold had run out fences the reset out before any Auth write". The r1 reset tests were updated to the lease.
- `tests/security/studentResetWiring.test.ts`: 4 → **5** (rewritten for the worker).
- `tests/security/studentSessions.test.ts`: the reset ordering is now checked in the worker.
- `tests/account/deletionPendingWiring.test.ts`: 9 → **15**.
- `tests/account/accountDeletion.test.ts`: the checkout 409 message is pinned (same test count).
- `src/features/account/DeleteAccountSection.test.tsx`: +1.
- `src/features/moderation/ReportContentPage.test.tsx`: queued-copy test rewritten.
- `tests/moderation/contentReports.test.ts`: one test renamed.
- SQL: `tests/sql/student_claim_reservation.sql` +section 8 (73 → 99); `tests/sql/README.md` updated.
- Suite: **3523 → 3535 passed** (+12), 13 skipped.

### Every SQL proof, pass/total

Local runs were against the local stack with all migrations applied. All eight P3 migrations were then re-applied in order (110000 → 110700) with no errors, and 110700 was applied twice on its own before that. CI runs the 12 proofs in its list in `supabase-local`; that step fails on any failing proof.

| Proof                              | Local              | CI (final head)        |
| ---------------------------------- | ------------------ | ---------------------- |
| **student_claim_reservation** (P3) | **99/99**          | **99/99** (blocking)   |
| **account_deletion_pending** (P3)  | **89/89**          | **89/89** (blocking)   |
| **support_inbound_lease** (P3)     | **58/58**          | **58/58** (blocking)   |
| cancel_link_lifetime               | 57/57              | pass (in CI step)      |
| cancel_link_tombstones             | 38/38              | pass (in CI step)      |
| cancel_link_db_clock               | 21/21              | pass (in CI step)      |
| cancel_link_tombstone_race         | 25/25              | pass (in CI step)      |
| cancel_link_read_db_clock          | 10/10              | pass (in CI step)      |
| cancel_link_save_after_insert      | 12/12              | pass (in CI step)      |
| cancel_link_consume_db_clock       | 36/36              | pass (in CI step)      |
| checkout_consents                  | 25/25              | pass (in CI step)      |
| launch_checkout_fixes              | 46/46              | 46/46                  |
| annotation_payload_shape           | 57/57              | not in CI              |
| archived_student_password          | 13/13              | not in CI              |
| billing_export_claims              | 35/35              | not in CI              |
| column_integrity                   | 113/113            | not in CI              |
| content_moderation                 | 99/99              | not in CI              |
| cross_branch_integration           | 37/37              | not in CI              |
| district_billing_canonical         | 12/12              | not in CI              |
| district_migrations_rerunnable     | 20/20              | not in CI              |
| district_retention                 | 28/28              | not in CI              |
| district_seat_cap                  | 192/192            | not in CI              |
| district_seats                     | 58/58              | not in CI              |
| district_student_scope             | 47/47              | not in CI              |
| edge_rate_limit_refund             | 10/10              | not in CI              |
| guest_email_verification           | 53/53              | not in CI              |
| launch_consent                     | 43/43              | not in CI              |
| qa3_cross_branch                   | 12/12              | not in CI              |
| share_link_errors                  | 26/26              | not in CI              |
| billing_double_charge              | **95/98** (3 fail) | excluded (decision 20) |
| district_read_only_seats           | **64/68** (4 fail) | not in CI              |
| student_access_revocation          | **42/44** (2 fail) | not in CI              |

The three failing proofs fail on exactly the checks they failed in rounds 0 and 1: billing_double_charge 89/92/98; district_read_only_seats 49/59/60/62; student_access_revocation 22/24. They predate P3 and belong to P1 (decisions 44 and 49(7)). Nothing in this round changed any other proof's result.

## Local check results (final head `dca83489`)

| Check                                                                                       | Result                                                                                                                                                          |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint:check`                                                                        | pass (exit 0)                                                                                                                                                   |
| `npm run typecheck`                                                                         | pass (exit 0)                                                                                                                                                   |
| `npm run test`                                                                              | pass: **226 files passed, 5 skipped (231); 3535 tests passed, 13 skipped (3548)**                                                                               |
| `npm run build`                                                                             | pass (exit 0)                                                                                                                                                   |
| `deno check --config supabase/functions/deno.json` (22 entry points, all but score-analyze) | pass, exit 0, on **Deno 2.1.4** and **2.5.6** (both downloaded into the session scratchpad, not installed system-wide); also passes in a no-`node_modules` copy |
| `npx prettier --check` on every changed .ts/.tsx/.json/.md/.yml                             | pass (prettier has no SQL parser, so .sql is not checked)                                                                                                       |
| `npm run migrations:mirror`                                                                 | regenerated; clean (no diff after the final run)                                                                                                                |
| SQL proofs                                                                                  | as above                                                                                                                                                        |

As in earlier rounds, the full suite was run with the `cloud:up`-generated `.env.local` moved aside (two unrelated tests read local-stack variables otherwise) and restored afterwards. CI has no `.env.local`.

## CI on the final head

All green on **`dca83489`**, both runs. The same head has a commit status of **Vercel: success** ("Deployment has completed"); last round it was rate-limited.

| Workflow run | Event        | Check                   | Job id       | Result                                 |
| ------------ | ------------ | ----------------------- | ------------ | -------------------------------------- |
| 39749233142  | push         | checks                  | 119725303361 | success                                |
| 39749233142  | push         | supabase-local          | 119725303506 | success                                |
| 39749233142  | push         | omr-service             | 119725303469 | success                                |
| 39749233142  | push         | supabase-drift          | 119725303022 | success                                |
| 39749233142  | push         | **edge-functions-deno** | 119725303375 | success                                |
| 39749239174  | pull_request | checks                  | 119725323566 | success                                |
| 39749239174  | pull_request | supabase-local          | 119725323314 | success                                |
| 39749239174  | pull_request | omr-service             | 119725323187 | success                                |
| 39749239174  | pull_request | supabase-drift          | 119725323500 | success                                |
| 39749239174  | pull_request | **edge-functions-deno** | 119725322914 | success                                |
| n/a          | (app)        | Vercel Preview Comments | 119725625915 | success                                |
| n/a          | (app)        | Supabase Preview        | 119725296017 | skipped (the integration's own choice) |

- **supabase-local, P3 proofs, read from the pull_request job log:** `student_claim_reservation` **99/99** ("OK … 99 checks passed"), `account_deletion_pending` **89/89**, `support_inbound_lease` **58/58**, `launch_checkout_fixes` 46/46.
- The other eight listed proofs are in the same step, which fails on any failing proof, and the job passed. Their files are unchanged (57/38/21/25/10/12/36/25).
- **edge-functions-deno**, read from the log: setup-deno v2.1.4 downloaded the npm packages fresh, then printed `Check` for **22 entry points** (every function except score-analyze) and exited 0. No `npm ci`.
- CI needed no fix on this head: the one push was green on the first run, and nothing was re-run.

## Migrations and files touched

**New migration** (in 2026102211xxxx; no existing migration edited; applied twice, then the whole P3 set replayed in order):

- `supabase/migrations/20261022110700_student_code_reset_worker.sql`

`scripts/apply-migrations.sql` was regenerated with `npm run migrations:mirror`.

**Files (23):**

- `.github/workflows/ci.yml` (one appended job)
- `scripts/apply-migrations.sql`
- `src/features/moderation/ReportContentPage.tsx` (+ its test)
- `src/features/account/DeleteAccountSection.test.tsx`
- `supabase/functions/deno.json` (new)
- `supabase/functions/_shared/{studentCodeReset,deletionPending}.ts` (new) and `_shared/mailBudget.ts` (comment)
- `supabase/functions/{student-provision,stripe-checkout,imslp-download,score-analyze}/index.ts`
- `supabase/functions/resend-inbound/handler.ts` (comment)
- the new migration
- `tests/security/{studentClaim,studentResetWiring,studentSessions}.test.ts`
- `tests/account/{accountDeletion,deletionPendingWiring}.test.ts`
- `tests/moderation/contentReports.test.ts`
- `tests/sql/student_claim_reservation.sql`
- `tests/sql/README.md`

**Not touched:** `session.ts`, `annotationStore.ts`, `InkController.ts`, `realtimeChannel.ts`, `src/sync/*`, existing migrations, `supabase/config.toml`, docs.

### Deviations

1. **Takeover rule.** The packet says each attempt takes a fresh lease and a stale worker aborts. Codex says to reject concurrent execution until the previous worker "cannot still write". This round does both: a same-token retry fences out the previous worker (the packet's test scenario passes), unless that worker is inside an Auth call, in which case the retry waits (409 `reset_in_progress`) until it reports back or the hold runs out. Without that exception, a password write already in flight could land after a newer reset and a claim.
2. **Code-reset path moved.** The code-reset path moved from inline `student-provision` code into `_shared/studentCodeReset.ts` so the paused-retry test drives the real worker instead of a model. In `student-provision` the change is confined to `resetStudentAccess`'s code path, one new ports helper, the dispatcher's deletion check and imports. The email reset path is unchanged.
3. **Dropped function.** `complete_student_code_reset(uuid, uuid, text)` (new in this unmerged PR, never deployed) is dropped and replaced by the worker-checked 5-argument version.
4. **Fail-closed check.** The deletion-pending check in the four functions fails closed (502) when it cannot be answered.
5. **CI scope.** The CI deno check is its own job (`edge-functions-deno`), not a step inside `checks`. It excludes score-analyze (pre-existing errors on dev).

## student-provision/index.ts changes, for the P5 (#66) rebase

On top of rounds 0 and 1 (P5's current head does not touch this file):

1. Imports: `ACCOUNT_DELETION_PENDING`, `accountDeletionPending` from `../_shared/deletionPending.ts`; `type CodeResetPorts`, `type ReserveResetAnswer`, `runCodeReset` from `../_shared/studentCodeReset.ts`.
2. New `codeResetPorts(admin)` helper just above `resetStudentAccess`. It binds `reserve_student_code_reset`, `fence_student_code_reset`, the scramble (`updateUserById` with `generateProvisionPassword()`), `endStudentSessions`, the code mint, `complete_student_code_reset` (now with `p_worker`/`p_epoch`) and `stop_student_code_reset_worker`.
3. `resetStudentAccess`, code path only: the inline reserve / scramble / end sessions / complete block (from `// Reserve the row before anything is revoked` to just before `forgetLoginAccount`) is replaced by `runCodeReset(codeResetPorts(admin), …)` and a `switch` on the outcome. The responses and their codes are unchanged; the `reset_lost` text is new. The email path is unchanged.
4. Dispatcher (`Deno.serve`): after `const userId = auth.caller.userId;` and before the `switch (body.action)`, `accountDeletionPending(admin, userId)` returns 502 if the check fails and 409 `ACCOUNT_DELETION_PENDING` while a deletion is pending.

If P5 adds a district path that writes for a teacher with the service role, it should call `accountDeletionPending` the same way.

## P6 runbook text: orphaned provisioning accounts (packet item 6, exact steps)

> **Orphaned student provisioning accounts**
>
> **What it is.** When a teacher adds a student, student-provision first records an intent (`public.student_provision_intents`), then creates the student's Auth account, then inserts the roster row, and the roster insert clears the intent. If a request dies between creating the Auth account and the roster insert, and its own undo also fails, an Auth account exists with no roster row. Account deletion cleans these up automatically only when the account is flagged as that teacher's student. It leaves two cases for a person: an account whose student flag never landed (an email invite whose `app_metadata` update failed), and a provisioning that was still running when the teacher's deletion swept. Expired intents also remain for teachers who were never deleted.
>
> **Find them** (SQL editor on the project, as `postgres`):
>
> ```sql
> select i.roster_id, i.teacher_id, i.auth_email, i.created_at, i.expires_at,
>        f.student_user_id,
>        u.email, u.created_at as account_created_at, u.last_sign_in_at, u.email_confirmed_at,
>        u.raw_app_meta_data ->> 'user_type'  as user_type,
>        u.raw_app_meta_data ->> 'teacher_id' as flagged_teacher,
>        exists (select 1 from auth.users t where t.id = i.teacher_id) as teacher_exists,
>        exists (select 1 from public.managed_students m where m.student_user_id = f.student_user_id) as has_roster_row
> from public.student_provision_intents i
> left join lateral public.student_provision_intents_for (i.teacher_id) f on f.roster_id = i.roster_id
> left join auth.users u on u.id = f.student_user_id
> where i.expires_at < now()
> order by i.created_at;
> ```
>
> Only rows with `expires_at` in the past are orphans. A live intent belongs to a request that may still be running.
>
> **Resolve each row:**
>
> 1. **`student_user_id` is null** (no account was created, or none can be found by address): nothing to delete. Run `select public.finish_student_provision('<roster_id>');`.
> 2. **`has_roster_row` is true** (the roster insert did land): not an orphan. Run `select public.finish_student_provision('<roster_id>');`.
> 3. **Flagged as this teacher's student** (`user_type = 'student'` and `flagged_teacher = teacher_id`) with **no roster row**: the account belongs to nobody.
>     1. Delete the Auth user (Dashboard → Authentication → Users → the user → Delete, or the admin API `DELETE /auth/v1/admin/users/<student_user_id>` with the service-role key).
>     2. If the deleted account owned any scores, delete their Storage objects under `scores/<student_user_id>/` and `thumbnails/<student_user_id>/`.
>     3. Run `select public.finish_student_provision('<roster_id>');`.
> 4. **Not flagged** (`user_type` null, or `flagged_teacher` differs): an email invite whose student flag never landed. Do **not** delete it blindly; it is a real address.
>     - If `last_sign_in_at` and `email_confirmed_at` are both null (the invite was never accepted), delete the Auth user as in step 3, then finish the intent.
>     - If the person has signed in, they now hold an ordinary (non-student) account. Contact the address, or the teacher if `teacher_exists` is true, before deleting anything. If they keep it, just finish the intent.
> 5. **`teacher_exists` is false** (the teacher's account was deleted while this provisioning was live or unflagged): handle as in steps 1–4. The intent outlives the teacher on purpose (it has no foreign key) so that this case stays findable.
>
> Never delete a `student_provision_intents` row by hand while its account still exists. `finish_student_provision` comes last, after the account is resolved.
>
> **Later:** a scheduled sweep could take over cases 1–3 (decision 49(6) follow-up). Case 4 stays manual.

The fix-round-1 runbook entries (half-deleted accounts, orphaned provisioning intents in short form, `failed` inbound mail) still stand. The entry above replaces fix round 1's short "Orphaned provisioning intents" item.

## Follow-ups

1. **Email-method resets** have no reservation or worker lease (unchanged, pre-existing, not part of the Codex finding). Two concurrent email resets could each scramble the password; a scramble landing after the student set a password from the other link would undo it. The fix would extend the same lease to the email path in a later round. The code path, which has claimable cards, is the one that is fenced now.
2. **score-analyze type errors**: 6 pre-existing `deno check` errors (supabase-js generics). Fix them, then drop the exclusion from `edge-functions-deno`.
3. **Live HTTP smoke tests (P6, decision 49(1))**:
    - two same-token reset retries against hosted Auth;
    - a reset of a student who claims meanwhile;
    - checkout, IMSLP import, OMR run and roster action during a deletion (each should answer 409 `account_deletion_pending`);
    - function boot with `supabase/functions/deno.json` present.
4. **Residual (by design): a failed Auth call counts as finished.** The worker reports back after an Auth call that _returned an error_ (so a retry can resume). If the error was a dropped connection and GoTrue still applied the write afterwards, that write is not fenced. This is bounded to a single in-flight HTTP request; the alternative is a 10-minute wait after every Auth error.
5. Raise `studentAccountMail` before the first district contract (decision 58(1), pre-district).
6. Unchanged from fix round 1:
    - a cron sweep for half-deleted accounts and stale intents;
    - CI does not build the OMR image;
    - the Storage API's byte lifecycle is not verified;
    - `npm audit` registry flakiness.

## Open questions

None blocking. For Max's judgment:

1. **In-Auth refusal.** A same-token retry is refused while the previous worker is inside an Auth call (deviation 1). In practice it only bites when a request died mid-Auth-call, and the retry then waits for the hold, at most 10 minutes. Acceptable? The UI already says "held for up to 10 minutes".
2. **Fail-closed deletion check.** The check in `student-provision` / `stripe-checkout` / `imslp-download` / `score-analyze` fails closed (502 when the RPC cannot answer). Prefer fail-open there, relying on the triggers?

## Hosted steps left for Max (none performed)

1. Apply `20261022110700_student_code_reset_worker.sql` after fix round 1's four migrations. The Supabase GitHub integration applies it on merge: dev, then production.
2. Deploy the Edge Functions **after** the migration:
    - `student-provision` (new RPCs; the old 3-argument completion is dropped, so the old function build would fail resets);
    - `stripe-checkout`, `imslp-download`, `score-analyze`;
    - plus everything earlier rounds listed.
3. When deploying, confirm the functions boot with `supabase/functions/deno.json` present (expected: the runtime already resolves `npm:` from the registry).
4. P6 docs: the runbook entry above; and DEPLOY.md should mention `supabase/functions/deno.json` and the new CI job.
5. Unchanged: `SUPPORT_RETRY_SECRET`; Vault `support_inbound_url` / `support_inbound_secret`.

## Expected conflicts with the other launchfix PRs

| PR                                      | Overlap                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 (#69)                                | `.github/workflows/ci.yml`: P1 replaces the proof list with a `tests/sql/*.sql` glob. This round's hunk is a separate job appended at the end of the file (no textual overlap with P1's hunks); keep both, and drop P3's explicit proof list for P1's glob. `scripts/apply-migrations.sql`: regenerate, never hand-merge. `tests/sql/README.md`: keep both. |
| P2 (#68)                                | None. P2 edits `src/features/account/accountDeletion.ts` and its test; this round touched only `DeleteAccountSection.test.tsx`.                                                                                                                                                                                                                             |
| P4 (#71)                                | None.                                                                                                                                                                                                                                                                                                                                                       |
| P5 (#66)                                | `ci.yml` (P5 adds three proofs to the same `for proof in` line P3 extended in fix round 1; resolve by keeping all names, or by P1's glob). `student-provision/index.ts`: P5's head does not touch it today; see the list above if it does.                                                                                                                  |
| P6 (#67)                                | Docs only: the runbook entry above and the DEPLOY.md lines.                                                                                                                                                                                                                                                                                                 |
| any PR touching `_shared/mailBudget.ts` | Comment-only change this round.                                                                                                                                                                                                                                                                                                                             |

## Housekeeping

- `npm run cloud:down` has run.
- No `.env` file and no secret was committed or printed. `.env.local` (generated by `cloud:up`, gitignored) was moved aside only for the test run and restored.
- The Deno binaries were downloaded into the session scratchpad (GitHub release zips for v2.1.4 and v2.5.6) and used from there. Nothing was installed system-wide; no `playwright install`.
- Hosted Supabase, Vercel, Resend live sending and Stripe were never touched. PR #54 and other sessions' branches were never touched. No PR was opened. PR #70 stays a draft with base `dev`; no reviewer was requested.
- The shared seeded accounts were not changed. The SQL proofs run in rolled-back transactions, and no `db reset` was run.
