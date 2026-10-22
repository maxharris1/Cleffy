# Cleffy PR #72 — fix round 1 (Codex r1 REVISE) report

**Status:** Complete

- PR: https://github.com/maxharris1/Cleffy/pull/72 (still a draft, not merged)
- Branch: `mh/launchfix-followups`, fast-forwarded `fb91497a304c80ebbebafec323ba99891b15a053` → **`c940b0ca68539e1acfaa0820351f0624b4bac72d`** (new head)
- Environment: Cleffy cloud env **`env_01WAd3yiz3qpSnsofpyEwCh2`** (confirmed with `get_session` at the start; `environment_kind: anthropic_cloud`, not Sandbox)
- At the start, `origin/mh/launchfix-followups` was `fb91497a…`, as expected. The push was a plain fast-forward (`fb91497..c940b0c`). No force push, rebase or amend of anything already pushed.
- Every commit is by Max Harris <drumaxter@gmail.com>. I didn't touch main, #54, hosted Supabase or live Stripe. No secrets or .env files were committed. I sent no messages to other sessions and requested no Codex review.

## Commits (one per finding, on top of fb91497)

| #   | Finding                                                         | Commit                                                                          |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | MAJOR: closing held ink doesn't cancel an in-flight Retry       | `a49acaf` ink: closing a score cancels a Retry still on its way                 |
| 2   | MAJOR: marker cleanup can deadlock with Auth account deletion   | `a815c0c` code resets: the marker cleanup never waits for an auth row           |
| 3   | MINOR: an out-of-window email match clears an unresolved intent | `e55e8aa` provisioning intents: an unproven email match keeps its intent        |
| 4   | MINOR: permanent half-deleted markers starve the sweep          | `c940b0c` account deletion: the sweep's limit counts only markers it can act on |

All three migrations edited here (20261022140400, 140700, 141000) were never applied to a hosted project, so I edited them in place. `scripts/apply-migrations.sql` was regenerated in each commit, and `tests/applyMigrationsInSync.test.ts` passes.

## Per-finding fix and proof

### 1. Retry vs closeDocInk (`src/sync/inkRecovery.ts`), commit `a49acaf`

**Fix:** `closeDocInk` and `forgetDocInk` now advance a per-score epoch (`docEpochs`). `retryHeld` binds its writes to two guards: the account's epoch (as before) and the score staying on this device (`openDocBoundTo`). The combined `live()` is the same guard `writeHeld` already checks after every await (`askServer`, `ensureDayStartingSnapshot`). `writeOps` checks it inside the Dexie transaction before and between its writes, and again after commit. When a cancelled Retry ends, it returns `{ ok: false }` without `pruneEntry`, so the closed entry and its ink are kept as they were.

**Tests** (`src/sync/annotationStore.recovery.test.ts`, new describe "a Retry under way when the score is lost to this device (PR #72 fix 1)"):

- _Closed while its server check is out:_ Retry → deferred `serverRows` reply → `closeDocInk` → reply resolves. Nothing is written (`db.ops` is empty and the mirror row is unchanged). The closed ink is still there for Export (`a1:#ff0000`) and is listed by `lostAccessInk()`.
- _Closed while its write waits on storage:_ the transaction is gated, `closeDocInk` runs, then the gate opens. The write rolls back and the closed ink stays.

**Before the fix:** both tests failed, because the Retry wrote the mark: `expected { ok: true, wrote: [ 'a1' ] } to match object { ok: false, wrote: [] }`. **After:** both pass. The related suites (recovery, export, library, SignedOutInkNotice: 19 files, 383 tests) all pass.

### 2. Marker cleanup vs Auth deletion deadlock (`20261022140700`), commit `a815c0c`

**Fix:** `clear_stale_code_reset_markers()` handles each candidate in its own `BEGIN … EXCEPTION` block. It still takes the roster row `SKIP LOCKED`, then the reservation, as before. It now reads and locks the account's `auth.users` row **last, `FOR UPDATE NOWAIT`**. If the row is busy (an Auth deletion or update holds it), `lock_not_available` rolls back that subtransaction. That releases the roster row and reservation lock at once, the student is skipped, and the next call picks it up. The function never waits on an auth row, so the opposite lock order (Auth deletion: auth row, then the roster row via ON DELETE CASCADE) can't deadlock with it. A deletion that starts after the cleanup only waits for it.

**Proof:** new `tests/sql/clear_stale_code_reset_markers_race.sql` (dblink, three backends, committed fixtures cleaned up before and after; local stack and CI only; 11 checks):

- A: the deletion holds student 2's auth row, then the cleanup runs, then the deletion deletes. The cleanup doesn't wait and clears nothing. The delete finishes in about 13 ms with no deadlock, and the account and roster row are gone.
- B: an Auth update holds student 3's auth row while the cleanup runs inside an open transaction. The cleanup passes over it at once, and a third backend can take the roster row `NOWAIT`, which proves the lock was released. The next call clears the marker.
- C: cleanup first, then the deletion. The deletion waits, then deletes after the commit, with no deadlock.
- Plus a structural check: `for update nowait` sits inside the per-candidate exception block.

**Before** (first version of the function installed): 7 of 11 checks fail. Case A ends in `ERROR: deadlock detected … while locking tuple … in relation "users"` (failing: 01 02 03 05 06 07 10). **After:** 11/11 pass on 4 consecutive local runs. The existing `clear_stale_code_reset_markers.sql` still passes 11/11.

This proof uses the uuid prefix `5a140000-0c14-…` so it doesn't overlap with `sweep_stale_account_deletions.sql`'s `5a130000-0c13-…`.

### 3. Unproven email match clears the intent (`20261022140400` + delete-account), commit `e55e8aa`

**Fix:** `student_provision_intents_proven()` returns a new `status` column:

- `proven`: proof (A).
- `unproven`: an account is named, but without proof.
- `unproven_match`: nothing recorded and nothing named in the window, but an account with no roster row sits at the intent's address. This covers accounts outside the window and another intent's account. It is DEPLOY.md case 5.
- `none`: no account to resolve (case 1), or only rostered accounts at the address (case 2).

Because the result type changes, the function is now dropped and recreated. That is still rerunnable, and nothing depends on it. delete-account maps the status to `ProvisionIntent.unprovenMatch`. `purgeManagedStudents()` keeps such an intent, live or expired, and logs it: "names no account, but an account at its address has no roster row (unproven_match); leaving its intent for review". It clears an expired intent that names nothing only when the status is `none`.

**Tests:**

- `tests/account/accountDeletion.test.ts`: "keeps an expired intent that names nothing while an account sits at its address outside the window, for review (PR #72 fix 3)". The `unproven_match` intent is kept and logged, a `none` intent is cleared, and the account is untouched. **Before:** failed with `expected [] to deeply equal [ 'unproven' ]` (the intent was cleared). **After:** passes, along with all 82 tests in tests/account.
- `tests/sql/student_provision_intent_window.sql`, now 17 checks. New cast: `wa` (no account at the address) and `wb` (only a rostered account). Three status checks: w2, w3 and w8 (outside the window) and w4 (another intent's account) are `unproven_match`; wa and wb are `none`; w5 and w6 are `proven`; w1, w7 and w9 are `unproven`. **Before** (first version): those 3 fail (`42703 column i.status does not exist`), so 3 of 17 fail. **After:** 17/17. The migration also applied twice in a row cleanly.

### 4. Sweep starvation (`20261022141000`), commit `c940b0c`

**Fix:** before the limit is applied, the candidate query now selects only markers with something to do. That means a marker with an expired open attempt to close, or a removable marker: no `destructive_started_at` and no live attempt. These are the same tests the loop applies again under the account's lock. Half-deleted markers whose attempts are all closed (report-only) and markers held by a live attempt no longer use up `p_limit`. They are still counted in `half_deleted` and `oldest_half_deleted`.

**Proof:** `tests/sql/sweep_stale_account_deletions.sql`, now 12 checks. The new cast has two half-deleted markers f and g, 30 and 29 days old, whose attempts are already closed; a live marker h, 28 days old; and a crashed, untouched marker i, 1 hour old.

- Check 11: two bounded runs with `p_limit = 1`. The first closes i's attempt and clears i.
- Check 12: f, g and h are left as they were, and the next bounded run has nothing to do (`half_deleted` = baseline + 3).

**Before** (first version): check 11 fails (1 of 12). **After:** 12/12, both locally and in CI.

## Local checks (final head c940b0c)

- `npm run lint:check`: clean
- `npm run typecheck`: clean
- `npm run test`: 243 files passed (6 skipped); 3796 tests passed (20 skipped)
- `npm run build`: OK
- `deno check --config supabase/functions/deno.json supabase/functions/*/index.ts` (Deno 2.1.4, CI's version, via `npx deno@2.1.4`): OK
- Local Supabase stack, after `supabase db reset` (applies every migration fresh), following the CI supabase-local steps in order:
    - Re-applying the five cancel-link migrations and all 39 migrations from 20261022100000 on: clean
    - `cancelLinkStore.test.ts`: 8/8
    - `storageLifecycle.test.ts`: 5/5
    - **All 67 SQL proofs** (`tests/sql/*.sql` + `supabase/sql-tests/sharing_access_control.sql`) via `scripts/ci/sql-proof.sh`: all passed

## CI on c940b0ca68539e1acfaa0820351f0624b4bac72d

Every check completed. No red checks, Vercel included.

| Check               | Run (push)  | Job id       | Result  | Run (pull_request) | Job id       | Result  |
| ------------------- | ----------- | ------------ | ------- | ------------------ | ------------ | ------- |
| checks              | 39865731752 | 120127328714 | success | 39865736930        | 120127346776 | success |
| supabase-local      | 39865731752 | 120127328792 | success | 39865736930        | 120127346760 | success |
| edge-functions-deno | 39865731752 | 120127328794 | success | 39865736930        | 120127346723 | success |
| supabase-drift      | 39865731752 | 120127328383 | success | 39865736930        | 120127346461 | success |
| omr-service         | 39865731752 | 120127328697 | success | 39865736930        | 120127346786 | success |

Other checks on the head:

- Vercel (commit status): **success**, "Deployment has completed". No build-rate-limit failure.
- Vercel Preview Comments (check runs 120127343174, 120127665232): success
- Supabase Preview (120127325805): skipped, as on earlier heads

I checked the supabase-local job log (job 120127346760): the SQL proof step ran the updated proofs, including `sweep_stale_account_deletions.sql: 12 checks passed`.

## Deploy-note changes

- **delete-account must still be deployed after 20261022140400.** That is unchanged, but it matters more now: an older delete-account against the new function ignores `status` and would still clear `unproven_match` intents. Apply the migration, then deploy delete-account. DEPLOY.md's runbook text now says account deletion keeps `unproven_match` intents (case 5) and clears an expired, unnamed intent only on `status = 'none'`.
- 20261022140400 now starts with `drop function if exists public.student_provision_intents_proven (uuid)` before recreating it with the extra `status` column. This is safe because no hosted project has applied it; the grants are restored in the same file.
- DEPLOY.md, stale `code_reset_worker` markers: the cleanup also skips an account Auth is updating or deleting, without waiting, so it can't deadlock with an account deletion.
- DEPLOY.md, account-deletion sweep: its 500-per-run limit counts only rows it can act on, so half-deleted rows waiting for the runbook never hold back newer abandoned ones.
- `tests/sql/README.md` documents the new race proof and the updated check counts.

## Open questions

1. Fix 3, conservative rule: `unproven_match` counts **any** unrostered account at the intent's address, at any time, including one from long before the intent. This matches DEPLOY.md case 5 ("every email candidate on an unrecorded intent … inside the window or not"). It means such intents stay open until someone resolves them by hand. Is that the intended trade-off, or should accounts created long before the intent be ignored?
2. Fix 3, test layers: the cleanup consequence is tested at two layers, the SQL status (local DB proof) and `purgeManagedStudents` with fake ports. No test drives delete-account's RPC adapter end to end against the local stack, because the repo has no harness for running Edge Functions in tests. The adapter change is one line (`unprovenMatch: row.status === 'unproven_match'`). Is that enough for Codex r2?
3. Fix 1 scope: the per-score cancel covers Retry (`retryHeld`), which is what the finding is about. An ordinary store write (`persistOps`) in flight when a score is lost is still bound only to the account's epoch. That path was not flagged. Its rows are removed by `purgeLocalDocument`'s deletes, which queue behind the write's transaction.
4. Branch naming: this session's harness named `claude/launchfix-followups-fix1-fs0150` as its default branch. Per the overrides, nothing was pushed there; only `mh/launchfix-followups` and this report branch, `claude/launchfix-followups-fix1-report`.
5. Item-16 session: `mh/launchfix-item16` was branched off fb91497a and will need to rebase onto `c940b0c`. These four commits touch `src/sync/inkRecovery.ts`, three migrations, `scripts/apply-migrations.sql`, `supabase/functions/_shared/accountDeletion.ts`, `supabase/functions/delete-account/index.ts`, DEPLOY.md, tests/sql/README.md and the tests named above.
