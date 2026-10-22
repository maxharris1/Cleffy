# Launchfix P3 fix round 3 report: PR #70

**Status:** Complete

Written by the P3 fix-round-3 Claude session, 2026-10-22. The packet asked for this report at `/workspace/cleffy-launchfix-p3-fix3-report.md`. `/workspace` is on Max's machine, so per the session brief it is on the scratch branch **`claude/launchfix-p3-fix3-report`**: the final PR #70 head plus one commit adding this file. The earlier report branches (`claude/launchfix-p3-report`, `claude/launchfix-p3-fix1-report`, `claude/launchfix-p3-fix2-report`) were not touched.

## Summary

- Codex's round-3 REVISE is addressed: the MAJOR (takeover after an ambiguous Auth failure), plus packet items 1–6 and decisions 60(a), 60(b) and 61.
- PR #70 was fast-forwarded from `dca83489` to **`988926240378f2af41f04424cda5f7f48e82b748`**. It is still a draft with base `dev`; only its body was edited (the title was re-sent unchanged).
- Local checks are green. CI is fully green on the final head (see "CI on the final head").
- `npm run cloud:down` has run.
- Nothing was merged, nothing went to dev or main, and no hosted service was touched.

## Environment

- **Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2`** (environment kind `anthropic_cloud`), **not Sandbox**. Confirmed with `get_session` at the start.
- Started with `git fetch origin && git checkout -B mh/launchfix-p3-edge-hardening origin/mh/launchfix-p3-edge-hardening`. HEAD was `dca834899d15878eab409c6eff6b160a01bb4eb8`, as expected; origin had not moved past it (re-checked just before the push).
- Commit identity: `Max Harris <drumaxter@gmail.com>`. One push to `mh/launchfix-p3-edge-hardening` (`git push origin HEAD:mh/launchfix-p3-edge-hardening`, `dca8348..9889262`), a fast-forward. Nothing was force-pushed.
- The harness named `claude/launchfix-p3-edge-hardening-atfb9m` as this session's working branch. The explicit brief was followed instead: only `mh/launchfix-p3-edge-hardening` and `claude/launchfix-p3-fix3-report` were written.
- No other session was messaged; `send_message` was not used.

## PR and SHAs

|                     |                                                                            |
| ------------------- | -------------------------------------------------------------------------- |
| PR                  | **#70**, draft, `mh/launchfix-p3-edge-hardening` → `dev` (no new PR)       |
| Starting head       | `dca834899d15878eab409c6eff6b160a01bb4eb8`                                 |
| **New PR #70 head** | **`988926240378f2af41f04424cda5f7f48e82b748`**                             |
| Base                | `dev` at `47e9b38f2dba36fdce852c80948245da344bcc20` (unchanged)            |
| Report branch       | `claude/launchfix-p3-fix3-report` = new head + one commit adding this file |

## Commits (on top of dca83489)

| SHA       | Summary                                                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `48aa965` | fix(student-provision): quarantine a reset whose Auth write may still land; deletion checks answer 503 (items 1, 2; 60(a), 60(b)) |
| `9889262` | ci: deno check score-analyze too, now that its client type checks (item 3)                                                        |

The CI change is its own commit, so the `ci.yml` hunk is easy to find for the P1 rebase.

## How each item was addressed

### Item 1 / Codex r3 MAJOR: an ambiguous Auth failure allowed a takeover

New migration **`20261022110800_student_code_reset_quarantine.sql`**, plus changes to `_shared/studentCodeReset.ts`, `_shared/studentSessions.ts` and `student-provision`.

- **Definite vs ambiguous.** After a failed password scramble the worker reports back (`stop_student_code_reset_worker`, which releases the attempt at once) **only for a definite refusal**: an HTTP 4xx other than 408, from the supabase-js `AuthError.status` (`definiteRefusal()` in `_shared/studentCodeReset.ts`).
    - Anything else counts as ambiguous: a transport error (supabase-js reports status 0), a timeout, 408, a 5xx, a missing status, or a throw from the call.
- **Quarantine.** After an ambiguous failure the worker does **not** report back. `worker_in_auth` stays set, so:
    - `reserve_student_code_reset` answers a same-token retry with `busy` (409 `reset_in_progress`);
    - a claim of the old card waits (409 `claim_in_progress`), as under any live hold;
    - `release_student_code_reset` refuses.

    The teacher gets 502 **`reset_unconfirmed`** with the resume token.

- **How the quarantine ends** (packet: "confirmed by re-reading the Auth user's state … or a server-side time limit"):
    1. **Confirmation by a marker.** The scramble writes `app_metadata.code_reset_worker = <this worker's id>` in the **same** `updateUserById` call as the password.
        - I read GoTrue's `adminUserUpdate` (supabase/auth `internal/api/admin.go`): the password and the app_metadata update are inside one `db.Transaction`.
        - `UpdateAppMetaData` merges keys, so `user_type` and `teacher_id` are untouched.
        - Seeing the marker therefore means that write has committed, and nothing of it is still in flight.
        - The marker is read in two places:
            - the worker re-reads the user **straight after** the ambiguous error, and carries on with the reset if its write landed;
            - a **later retry presenting the token** gets the in-flight worker's lease from `reserve_student_code_reset`'s `busy` answer (new in 110800, and only for the token's holder). It re-reads the marker, and if it is there, reports that worker back itself and takes a new lease.
    2. **Server-side time limit.** The hold the fence renewed immediately before the write runs out: at least **600 s from the fence**, longer than an Edge Function can run (400 s). This is the existing hold window, the "held for up to 10 minutes" the roster shows. After that a retry gets a fresh reservation, or the student can claim the old card.
- **`end_student_sessions` now checks worker and epoch.** New **`end_student_sessions_fenced(p_student, p_reservation, p_worker, p_epoch)`** is what the reset worker calls. In its own transaction it:
    - locks the roster row and then the reservation;
    - ends the sessions (through the unchanged `end_student_sessions(uuid)`) only if all of these hold: the hold is live, `worker_in_auth` is set (the worker passed a fence), and `student_code_reset_owned()` holds (same reservation, worker and epoch; code hash and `claimed_at` unchanged since the reservation);
    - otherwise ends nothing and returns NULL, which the worker reads as `lost`.

    So a stale or delayed revocation does nothing. The plain `end_student_sessions(uuid)` is unchanged for archive and the email reset, which hold no lease. It is a separate function, not an overload, because existing source tests (`studentSessions.test.ts`, `takedownRealtime.test.ts`) pin the latest `end_student_sessions` definition, and because an overload would make PostgREST pick between candidates by argument names.

- **Other ambiguous steps.** The fence, the session revocation and the completion are database calls that each check the lease in their own transaction. A failed one can still report back at once: a late commit of it is refused once anyone else holds the lease. The Auth HTTP write is the only step that needed the quarantine.
- **Why this is safe while A is live.** A retry may report back a worker that is still running, once A's marker shows A's one Auth write has landed. Everything A still has to do is a lease-checked database call (fence, `end_student_sessions_fenced`, complete), so A gets `lost`. The test "a worker fenced out after its last fence ends no sessions" covers exactly this.
- **Residual (accepted, decision 61).** A write that neither lands nor fails within the 600 s window, and lands after it, is not covered. The time limit is the bound the packet accepted.

### Decision 60(a): the UI tells the user to try again in a few minutes

- The same-token retry refused while a worker is inside an Auth call (including a quarantined one) gets 409 `reset_in_progress`: "Another reset of this student is still finishing. Try again in a few minutes." This is unchanged from fix round 2. The roster shows the server's words (`failFrom`), so the UI already said this.
- **New, small, in P3's own files:**
    - The quarantined attempt's own answer is `reset_unconfirmed`, and the roster (`rosterService.ts`) maps it to `RESET_UNCONFIRMED_MESSAGE`: "The reset did not finish, and we could not confirm whether the student's password was changed. Their current card is held for up to 10 minutes. Try the reset again in a few minutes."
    - The roster now keeps a `resetToken` from **any** failure body that carries one (`reset_unconfirmed`, and the new 503 below), not only from `reset_incomplete`.
- The claim's "busy" copy is "This card is being set up right now. Wait a minute, then try again." (unchanged).

### Item 2: deletion checks

- Check-then-write is accepted by design; the DB triggers and RLS barrier stay the backstop (decision 61).
- **student-claim** (new). After the reservation and the account checks, and **immediately before the password write**, the new backend port `teacherDeletionPending(studentId)` asks `account_deletion_pending()` for the card's teacher. It reads `managed_students.teacher_id`, then calls `accountDeletionPending`.
    - Pending: 409 `account_deletion_pending` ("This card can no longer be set up. Ask your teacher for help."), and the reservation is released.
    - Unanswered: **503** `deletion_check_unavailable` ("We could not check this card just now. Wait a minute, then try again.", `retryAfterSec: 30`), released.
- **student-provision, later Auth calls** (new). The dispatcher check stays. A new helper `deletionRefusal()` asks again immediately before:
    - the **code reset's scramble**: the worker's `deletionPending` port, called after the reservation and before the first fence;
    - the **email reset's scramble** (the mail slot is released on a refusal);
    - the **restore's unban**.

    These are the Auth writes that give a student access back. Not re-asked:
    - the archive's ban: a revocation, which a deletion makes moot;
    - creation (`createUser`, `inviteUserByEmail`): already behind the provisioning intent, which the deletion sees and which is refused in-transaction during a deletion;
    - the post-invite metadata update: it must land so the deletion can find the account;
    - deleteStudent: it is what the deletion does anyway.

- **Unchanged, listed as follow-ups:** stripe-webhook, billing-cancel, and the queue and cache writers.

### Decision 60(b): fail closed, but 503 with a clear retry message

`_shared/deletionPending.ts` gains `DELETION_CHECK_UNAVAILABLE`: `{ error: 'We could not check your account just now, so nothing was changed. Please try again in a minute.', code: 'deletion_check_unavailable', retryAfterSec: 30 }`.

Every function that calls the deletion-pending check now answers **503** with a retry message when the check cannot be answered:

| Function            | Where it asks                                                                            | Pending                        | Unanswered (was)                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `student-provision` | before every action; again before the reset scrambles (both paths) and the restore unban | 409 `account_deletion_pending` | **503** `DELETION_CHECK_UNAVAILABLE` (was 502); a code reset also returns its `resetToken`                                                                                            |
| `stripe-checkout`   | first thing in `beginAttempt` (new reason `deletion_check_failed`)                       | 409                            | **503** `CHECKOUT_DELETION_CHECK_UNAVAILABLE` ("…so checkout did not start. Please try again in a minute.") (was 502 `checkout_unavailable`)                                          |
| `imslp-download`    | before the import                                                                        | 409                            | **503** `DELETION_CHECK_UNAVAILABLE` (was 502)                                                                                                                                        |
| `score-analyze`     | for the owner, before metering / enqueue                                                 | 409                            | **503** `{ ok: false, ...DELETION_CHECK_UNAVAILABLE }` (was 502 `service_unreachable`); the player shows "We could not check your account just now — try Generate again in a minute." |
| `student-claim`     | for the card's teacher, before the password write (new)                                  | 409 (`CLAIM_DELETION_PENDING`) | **503** `CLAIM_CHECK_UNAVAILABLE` (new)                                                                                                                                               |

The roster, checkout and IMSLP clients show the server's `error` text. The player maps by code, so one copy line was added to `TransportBar.tsx`'s `ERROR_COPY`.

### Item 3: deno check for score-analyze

- **Fixed, and included in CI.**
- All 6 errors came from one line: `type UserClient = ReturnType<typeof createClient>`, whose schema generics resolve to `never` under deno check. It is now `type UserClient = SupabaseClient`, as student-provision uses, with a two-line comment. The diff is about 5 lines.
- `deno check --config supabase/functions/deno.json supabase/functions/score-analyze/index.ts` is clean on Deno 2.1.4.
- **ci.yml hunk (flag for the P1 rebase).** It is in the separate `edge-functions-deno` job at the end of the file, committed alone in `9889262`:

    ```diff
    -    # score-analyze is left out: 6 type errors in it predate launchfix P3
    -    # (supabase-js client generics), a follow-up.
    +    # Every entry point, score-analyze included since its client type was fixed
    +    # (P3 fix round 3).
    ...
    -              run: deno check --config supabase/functions/deno.json $(ls supabase/functions/*/index.ts | grep -v '/score-analyze/')
    +              run: deno check --config supabase/functions/deno.json supabase/functions/*/index.ts
    ```

- CI's `edge-functions-deno` log on the final head prints `Check` for all **23** entry points, `score-analyze/index.ts` included, and passes.

### Item 4: deploy order. Exact runbook text for P6

> **Migration 20261022110700 / 110800 and the student-provision deploy (do these back to back inside the maintenance freeze)**
>
> Migration `20261022110700_student_code_reset_worker.sql` **drops** the old 3-argument RPC `public.complete_student_code_reset(uuid, uuid, text)` and replaces it with the 5-argument, worker-checked version. Migration `20261022110800_student_code_reset_quarantine.sql` adds `public.end_student_sessions_fenced(uuid, uuid, uuid, bigint)`, which the new `student-provision` calls. A `student-provision` build from before PR #70's fix round 2 calls the dropped RPC, so between applying 110700 and deploying the new function **every code-method student reset fails** (the teacher sees "The reset did not finish…", and the student's card is held for up to 10 minutes). A new `student-provision` deployed **before** the migrations fails resets too (its RPCs do not exist yet).
>
> 1. Start the maintenance freeze (no teacher resets in flight).
> 2. Apply `20261022110700_student_code_reset_worker.sql`, then `20261022110800_student_code_reset_quarantine.sql` (after all earlier P3 migrations, 110000–110600).
> 3. **Immediately** deploy `student-provision` from the same commit: `supabase functions deploy student-provision`.
> 4. Then deploy `student-claim`, `stripe-checkout`, `imslp-download` and `score-analyze` from the same commit (their deletion-check changes need no new SQL, but deploy them in the same window).
> 5. Smoke-check: reset one test code student from the roster. Expect a new card, with no "did not finish" message.
> 6. End the freeze.
>
> If step 3 fails, do not end the freeze: retry the deploy. Rolling the function back to the old build does not help, because the RPC it calls is gone.

### Item 5: accepted, out of scope

- **Email reset path unfenced:** unchanged, pre-existing (follow-up 1). The only change on that path is the deletion re-check before its scramble (item 2).
- **OMR apt pins:** unchanged; apt packages stay unpinned (decision 59). Base images and the Audiveris/tessdata downloads stay pinned.

### Item 6: PR #70 body refreshed

Updated through the GitHub API (`update_pull_request` with only `title` and `body`; the equivalent of `gh pr edit 70 --title … --body-file …`).

- **Title** (re-sent unchanged): "launchfix P3: edge hardening (inbound mail, body caps, claim/reset races, deletion barrier)".
- **Body:** current through fix round 3 (head `98892624`). It covers all nine migrations, with the 110700 drop and the deploy order called out; the reset quarantine and fenced session revocation; the new deletion checks and the 503s; the deno job now covering all 23 entry points (still flagged for the P1 rebase); tests; hosted steps; and follow-ups.

Nothing else about the PR changed: draft state, base `dev`, reviewers, labels and comments are all as they were. No reviewer was requested.

### Codex round-3 findings

| Finding                                                                                            | Outcome                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| r2 MAJOR PARTIAL / **new MAJOR**: stop-worker after an ambiguous Auth failure permits takeover     | **Fixed** (item 1): quarantine, marker confirmation or the 600 s limit, definite-4xx-only release; the requested test was added                                                        |
| `end_student_sessions` does not check the reset worker or epoch                                    | **Fixed**: `end_student_sessions_fenced` checks worker, epoch, live hold, fence and no-claim in its own transaction                                                                    |
| r2 MINOR (24-hour copy): FIXED                                                                     | No change needed                                                                                                                                                                       |
| r1 deletion barrier PARTIAL: check-then-write; student-claim unchecked; later Auth calls unchecked | Accepted as residual (decision 61). student-claim and the later student-provision Auth writes are now checked (item 2). Webhook, billing-cancel and queue/cache writers are follow-ups |
| score-analyze excluded from deno check; new code there unchecked                                   | **Fixed**: errors fixed, included in CI (item 3)                                                                                                                                       |
| Deploy ordering: 110700 drops the 3-argument RPC                                                   | Runbook text above (item 4)                                                                                                                                                            |
| Email reset path unfenced (pre-existing)                                                           | Follow-up (item 5)                                                                                                                                                                     |
| OMR apt pins (pre-existing)                                                                        | Accepted (item 5)                                                                                                                                                                      |

### Requester answers

- **49(1)** Live HTTP checks stay with the P6 smoke tests. Added below: an ambiguous reset failure, and the 503 path.
- **49(2)–(4), (6), (7):** unchanged.
- **49(5)** "Held for up to 10 minutes": still true. The quarantine uses the same window.
- **58(1)** Raise `studentAccountMail`: pre-district follow-up, not this round.
- **58(2)–(5):** unchanged; 58(5) deno check now includes score-analyze.
- **58: refresh #70's body:** done (item 6).
- **60(a):** addressed. The UI says "Try again in a few minutes" for a refused retry (existing), and now also for the quarantined attempt itself (`reset_unconfirmed`, new copy).
- **60(b):** addressed. All four named functions, plus the new student-claim check, return 503 with a retry message (table above).

## Tests and SQL proofs added or changed

- `tests/security/studentClaim.test.ts`: 19 → **27**. New describe "a reset whose password write comes back ambiguous (Codex r3 on #70)":
    - **"the error returns, the write commits later: a retry and a claim both wait until it is confirmed"**. A's scramble returns a connection error without writing; A ends `unconfirmed` with no report-back and `inAuth` still true. A retry with the token is `busy`, and a claim of the old card is 409. Then the remote write lands (password and marker). The next retry sees the marker, reports A back, takes a newer lease and completes. The student claims the new card, and their password stands.
    - **"the error returns, the write commits later, never confirmed: both wait until the hold runs out"**. The user cannot be re-read. A retry and a claim are still blocked at TTL−1 ms. At TTL+1 ms the old card can be claimed, and the student's password stands (A's write landed earlier).
    - "the worker re-reads straight after the error, and carries on when its write did land"
    - "a throw from the password write is ambiguous too"
    - "only a definite 4xx refusal reports back at once" (also tests `definiteRefusal` on 400/401/403/404/409/422/429 vs 408/5xx/0/undefined/null/'400')
    - "a worker fenced out after its last fence ends no sessions: the revocation checks the lease itself"
    - New describe "deletion checks right before the Auth writes (decision 61)": the reset worker (pending gives no fence and no scramble; unknown hands back a resumable token) and the claim (409 / 503, released, no password write; checked before `setPassword`).
    - The in-memory roster now models the marker, the in-flight lease on `busy`, and `end_student_sessions_fenced`. The two fix-round-2 tests that fail a scramble now mark it `definite`, which keeps their meaning.
    - **Mutation check:** with the worker reverted to "report back on any failed scramble", 4 of the new tests fail; restored afterwards.
- `tests/security/studentResetWiring.test.ts`: 5 → **7**. The scramble carries the marker; only `definiteRefusal` counts as definite; the re-read reads the marker; ambiguous failures are quarantined (`unconfirmed`, one `incomplete()` only, in the definite branch); `reset_unconfirmed` and its message; the worker's session revocation is `endStudentSessionsFenced`.
- `tests/security/studentSessions.test.ts`: +3 (`endStudentSessionsFenced`: the RPC and its arguments; NULL is `lost`; an error or throw is a refusal). The reset-ordering check now pins `endStudentSessionsFenced(admin, studentId, lease)`.
- `tests/account/deletionPendingWiring.test.ts`: 15 → **18**:
    - every `!pending.ok` branch in student-provision, imslp-download and score-analyze returns the 503 (or a port's `'unknown'` that is answered with one), and none returns 502;
    - checkout maps `deletion_check_failed` to 503; student-claim's handler answers 503;
    - re-asks before the reset scrambles and the restore unban;
    - the student-claim teacher check comes after the reservation and before `setPassword`;
    - student-claim is added to "a failed check is a refusal".
- `tests/billing/checkoutFlow.test.ts`: +1 ("refuses, as a 503 retry prompt, when it cannot tell whether the account is being deleted").
- `src/features/roster/rosterService.test.ts`: +2 (`reset_unconfirmed` message and token kept, with the refused retry saying "Try again in a few minutes"; the 503's token kept).
- SQL: `tests/sql/student_claim_reservation.sql` gains **section 9** (checks 100–104e) on students 14–17, plus 73e/75a (client roles refused for `end_student_sessions_fenced`). The proof went from **99 to 125 checks**. `tests/sql/README.md` is updated.
- Suite: **3535 → 3554 passed** (+19), 13 skipped.

### Every SQL proof, pass/total

Local runs were against the local stack after `cloud:up` (all migrations applied). 110800 was applied twice on its own. Then all nine P3 migrations were replayed in order (110000 → 110800) with no errors, and every proof was run again on the final tree. CI runs the 12 proofs in its list in `supabase-local`, a step that fails on any failing proof.

| Proof                              | Local              | CI (final head)        |
| ---------------------------------- | ------------------ | ---------------------- |
| **student_claim_reservation** (P3) | **125/125**        | **125/125** (blocking) |
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

The three failing proofs fail on exactly the checks they failed in rounds 0–2: billing_double_charge 89/92/98; district_read_only_seats 49/59/60/62; student_access_revocation 22/24. They predate P3 and belong to P1 (decisions 44, 49(7), 58(4)). `student_access_revocation` exercises `end_student_sessions(uuid)`, which is unchanged, and its result is unchanged. Nothing in this round changed any other proof's result.

## Local check results (final head `98892624`)

| Check                                                                            | Result                                                                                                         |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `npm run lint:check`                                                             | pass (exit 0)                                                                                                  |
| `npm run typecheck`                                                              | pass (exit 0)                                                                                                  |
| `npm run test`                                                                   | pass: **226 files passed, 5 skipped (231); 3554 tests passed, 13 skipped (3567)**                              |
| `npm run build`                                                                  | pass (exit 0)                                                                                                  |
| `deno check --config supabase/functions/deno.json supabase/functions/*/index.ts` | pass, exit 0, **23 entry points including score-analyze**, Deno 2.1.4 (downloaded into the session scratchpad) |
| `npx prettier --check` on every changed .ts/.tsx/.md/.yml                        | pass (prettier has no SQL parser, so .sql is not checked)                                                      |
| `npm run migrations:mirror`                                                      | regenerated; clean (no diff after the final run)                                                               |
| SQL proofs                                                                       | as above                                                                                                       |

As in earlier rounds, the full suite was run with the `cloud:up`-generated `.env.local` moved aside and restored afterwards. CI has no `.env.local`.

## CI on the final head

All green on **`98892624`**, both runs, with no re-runs and no fixes needed. The same head has commit status **Vercel: success** ("Deployment has completed").

| Workflow run | Event        | Check                   | Job id       | Result                                 |
| ------------ | ------------ | ----------------------- | ------------ | -------------------------------------- |
| 39757054346  | push         | checks                  | 119751602536 | success                                |
| 39757054346  | push         | supabase-local          | 119751602563 | success                                |
| 39757054346  | push         | omr-service             | 119751602933 | success                                |
| 39757054346  | push         | supabase-drift          | 119751602595 | success                                |
| 39757054346  | push         | edge-functions-deno     | 119751602260 | success                                |
| 39757060689  | pull_request | checks                  | 119751625137 | success                                |
| 39757060689  | pull_request | supabase-local          | 119751625037 | success                                |
| 39757060689  | pull_request | omr-service             | 119751625243 | success                                |
| 39757060689  | pull_request | supabase-drift          | 119751624938 | success                                |
| 39757060689  | pull_request | edge-functions-deno     | 119751625286 | success                                |
| n/a          | (app)        | Vercel Preview Comments | 119751903699 | success                                |
| n/a          | (status)     | Vercel                  | n/a          | success ("Deployment has completed")   |
| n/a          | (app)        | Supabase Preview        | 119751600543 | skipped (the integration's own choice) |

- **supabase-local** (pull_request job log): `OK tests/sql/student_claim_reservation.sql: 125 checks passed` (section 9's checks 100–104e and 73e/75a all `t`), and `OK tests/sql/account_deletion_pending.sql: 89 checks passed`. The other ten listed proofs are in the same step, which fails on any failing proof, and the job passed.
- **edge-functions-deno** (pull_request job log): `Check` printed for all **23** entry points, including `supabase/functions/score-analyze/index.ts`, and the job passed.
- **checks**: `npm ci`, the dependency audit, lint:check, typecheck, test and build all passed.

## Migrations and files touched

**New migration** (in 2026102211xxxx; no existing migration edited; applied twice, then the whole P3 set replayed in order):

- `supabase/migrations/20261022110800_student_code_reset_quarantine.sql`. It replaces `reserve_student_code_reset` (same signature; the `busy` answer for the token's holder adds `worker`/`epoch`) and adds `end_student_sessions_fenced`.

`scripts/apply-migrations.sql` was regenerated with `npm run migrations:mirror`.

**Files (23):**

- `.github/workflows/ci.yml` (the `edge-functions-deno` job only: comment and run line)
- `scripts/apply-migrations.sql`
- the new migration
- `supabase/functions/_shared/{studentCodeReset,studentSessions,deletionPending,checkoutFlow}.ts`
- `supabase/functions/{student-provision,imslp-download,score-analyze,stripe-checkout}/index.ts`
- `supabase/functions/student-claim/{handler,index}.ts`
- `src/features/roster/rosterService.ts` (+ test)
- `src/features/playback/TransportBar.tsx` (one `ERROR_COPY` line)
- `tests/security/{studentClaim,studentResetWiring,studentSessions}.test.ts`
- `tests/account/deletionPendingWiring.test.ts`
- `tests/billing/checkoutFlow.test.ts`
- `tests/sql/student_claim_reservation.sql`
- `tests/sql/README.md`

**Not touched:** `session.ts`, `annotationStore.ts`, `InkController.ts`, `realtimeChannel.ts`, `src/sync/*`, existing migrations, `supabase/config.toml`, docs.

### Deviations

1. **`end_student_sessions` check as a new function.** The packet says "end_student_sessions must check the worker id and epoch". The check lives in a new `end_student_sessions_fenced(…)`, which the reset worker calls and which ends sessions only for the current worker and epoch. The unchanged `end_student_sessions(uuid)` stays for archive and the email reset, which have no lease. Reasons: existing source tests pin the latest `end_student_sessions` definition, and an overload would make PostgREST pick between candidates by argument names.
2. **Confirmation by a marker in app_metadata.** The packet suggested "updated_at or a marker". A marker (`app_metadata.code_reset_worker`) was used, because `updated_at` also moves for unrelated writes. The student's JWT `app_metadata` therefore carries one more key (an opaque worker UUID).
3. **TransportBar.tsx.** `prettier --write` on this file (required for changed files) also reformatted three pre-existing, over-long lines that `dev` already has. The change is formatting only, with no behaviour change. No other launchfix branch touches this file.
4. **reset_unconfirmed is a 502**, like `reset_incomplete` (a server-side failure part-way). The 503 is kept for the deletion check (decision 60(b)).

## student-provision and student-claim changes, for the P5 (#66) rebase

P5's current head touches neither file.

**student-provision/index.ts** (on top of rounds 0–2):

1. Imports: `DELETION_CHECK_UNAVAILABLE` added to the deletionPending import; `definiteRefusal`, `MARKER_KEY` added to the studentCodeReset import; `endStudentSessionsFenced` added to the studentSessions import.
2. New constant `RESET_UNCONFIRMED_MESSAGE` and new helper `deletionRefusal(admin, userId)`, just below `RESET_INCOMPLETE_MESSAGE`.
3. `codeResetPorts(admin, userId)` (new `userId` parameter):
    - new `deletionPending` port;
    - the `scramblePassword` port now takes `(studentUserId, lease)`, adds `app_metadata: { [MARKER_KEY]: lease.worker }` and sets `definite` from `error.status`;
    - new `passwordWriteLanded` port (`getUserById`);
    - the `endSessions` port now takes `(studentId, lease)` and calls `endStudentSessionsFenced`.
4. `resetStudentAccess`:
    - email path: `deletionRefusal` before the scramble (the mail slot is released on a refusal);
    - code path: `codeResetPorts(admin, userId)`, and three new outcome cases (`unconfirmed` → 502 `reset_unconfirmed` + token; `deletion_pending` → 409; `deletion_unknown` → 503 + token).
5. `restoreStudent`: `deletionRefusal` before the unban.
6. Dispatcher: a failed deletion check returns `jsonResponse(DELETION_CHECK_UNAVAILABLE, 503)` (was 502).

**student-claim** (minimal):

1. `handler.ts`:
    - new exported `CLAIM_DELETION_PENDING` and `CLAIM_CHECK_UNAVAILABLE`;
    - a new `teacherDeletionPending(studentId)` member on `StudentClaimBackend`;
    - one block before the password write: release, then 409 / 503.
2. `index.ts`: imports `accountDeletionPending`, and the backend binds `teacherDeletionPending` (reads `teacher_id`, then asks the predicate).

If P5 adds a district path that writes Auth state for a teacher's student with the service role, it should call `deletionRefusal` (provision) or the same port (claim) the same way.

## Follow-ups

1. **Email reset path unfenced** (pre-existing; decision 61). There is no reservation or worker lease on the email path, so two concurrent email resets could each scramble. Extend the lease and quarantine to it later.
2. **Deletion checks not added (by decision):**
    - `stripe-webhook` (customer/subscription writes, document archival/restoration);
    - `billing-cancel`;
    - the queue and cache writers: moderation/support queues, billing mail outbox, retention notices, IMSLP catalog caches, quota/rate counters, guest verification.

    These need their own lifecycle policy.

3. **Edge deletion checks are check-then-write** (accepted). The triggers and RLS are the backstop; the Storage API byte lifecycle is still unverified.
4. **Quarantine residual:** a password write that lands more than 600 s after its fence is not covered (accepted bound).
5. **OMR apt packages** stay unpinned (decision 59).
6. **Raise `studentAccountMail`** before the first district contract (decision 58(1), pre-district).
7. **Live HTTP smoke tests (P6, decision 49(1)):**
    - a reset whose Auth call times out (expect `reset_unconfirmed`, then a retry that succeeds once the write is visible, or after 10 minutes);
    - a confirmation via `app_metadata.code_reset_worker` against hosted GoTrue;
    - the 503 `deletion_check_unavailable` path (hard to provoke on hosted; at least confirm the 409 path);
    - the function boot with `deno.json`;
    - the fix-round-2 items.
8. Unchanged from earlier rounds: a cron sweep for half-deleted accounts and stale intents; CI does not build the OMR image; `npm audit` registry flakiness.

## Open questions

None blocking. For Max's judgment:

1. **Marker in app_metadata.** `code_reset_worker` (an opaque UUID) stays in the student's `app_metadata`, and so in their JWT, after a reset. It is harmless and admin-only, but if you prefer, a later round could clear it on completion. That would be another Auth write, with its own failure handling.
2. **The P6 freeze step.** The runbook above assumes P6 has a "maintenance freeze" step that stops teacher resets. If P6's freeze is defined differently, the wording of steps 1 and 6 should follow it.

## Hosted steps left for Max (none performed)

1. Apply `20261022110700_student_code_reset_worker.sql` and `20261022110800_student_code_reset_quarantine.sql` after the earlier P3 migrations. The Supabase GitHub integration applies them on merge: dev, then production. **Deploy `student-provision` immediately after, inside the freeze** (runbook above).
2. Deploy `student-claim`, `stripe-checkout`, `imslp-download` and `score-analyze` in the same window. Also deploy everything earlier rounds listed (`resend-inbound`, `delete-account`, the body-cap changes).
3. P6 docs: the deploy-order runbook entry above, plus the fix-round-2 entries (orphaned provisioning accounts, half-deleted accounts, `failed` inbound mail) and the DEPLOY.md note on `supabase/functions/deno.json`.
4. Unchanged: `SUPPORT_RETRY_SECRET`; Vault `support_inbound_url` / `support_inbound_secret`.
5. P6 smoke tests (follow-up 7).

## Expected conflicts with the other launchfix PRs

Checked against the current `origin/mh/launchfix-p{1,2,4,5,6}-*` heads: none of them touches any file this round changed except, potentially, `ci.yml` and the generated mirror.

| PR       | Overlap                                                                                                                                                                                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 (#69) | `.github/workflows/ci.yml`: this round only edits the `edge-functions-deno` job at the end of the file (comment and run line), away from P1's proof-step hunks; keep both. `scripts/apply-migrations.sql`: regenerate, never hand-merge. `tests/sql/README.md`: keep both. |
| P2 (#68) | None.                                                                                                                                                                                                                                                                      |
| P4 (#71) | None.                                                                                                                                                                                                                                                                      |
| P5 (#66) | `ci.yml` proof list, as in earlier rounds. `student-provision/index.ts` and `student-claim/*`: P5's head does not touch them today; see the list above if it does.                                                                                                         |
| P6 (#67) | Docs only: the deploy-order runbook entry above.                                                                                                                                                                                                                           |

## Housekeeping

- `npm run cloud:down` has run.
- No `.env` file and no secret was committed or printed. `.env.local` (generated by `cloud:up`, gitignored) was moved aside only for the test runs and restored.
- Deno 2.1.4 was downloaded into the session scratchpad and used from there. Nothing was installed system-wide; `playwright install` was not run. The GoTrue source was read from GitHub (read-only) to confirm the update is one transaction.
- Hosted Supabase, Vercel, Resend live sending and Stripe were never touched. PR #54 and other sessions' branches were never touched. No PR was opened. PR #70 stays a draft with base `dev`; no reviewer was requested.
- The shared seeded accounts were not changed. The SQL proofs run in rolled-back transactions, and no `db reset` was run.
