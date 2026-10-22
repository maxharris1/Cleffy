# Cleffy launchfix P6 fix5 report: drop proof B (PR #67)

**Status:** Complete

- Repo: maxharris1/Cleffy, PR #67 (draft, base `dev`), branch `mh/launchfix-p6-golive-docs`
- Starting head: `614824fb759160fc9ffdd0931b3932a3f33a9534` (614824fb; confirmed equal to `origin/mh/launchfix-p6-golive-docs` after `git fetch origin && git checkout -B mh/launchfix-p6-golive-docs origin/mh/launchfix-p6-golive-docs`)
- New PR #67 head: `1cf2c2c9c3ab75672f906fdd4f2902b7dd8b5de3` (1cf2c2c9)
- Environment: Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (`environment_kind: anthropic_cloud`, from `get_session`), not Sandbox.
- Date: 2026-10-22

## Push

- Right before pushing: `git fetch origin mh/launchfix-p6-golive-docs` → `origin/mh/launchfix-p6-golive-docs` was still `614824fb759160fc9ffdd0931b3932a3f33a9534`.
- Command: `git push origin HEAD:mh/launchfix-p6-golive-docs`
- Result: `614824f..1cf2c2c  HEAD -> mh/launchfix-p6-golive-docs`, a fast-forward (no `+`, no forced update). One push to the PR branch in total. No `--force`, no `--force-with-lease`, no rebase, amend or squash.
- PR #67 after the push (REST `GET /pulls/67`): `draft: true`, `base: dev`, `head: 1cf2c2c9…`, open. Title and body untouched. No new PR opened.

## Commit

| SHA                                        | Summary                                                    | Files                      |
| ------------------------------------------ | ---------------------------------------------------------- | -------------------------- |
| `1cf2c2c9c3ab75672f906fdd4f2902b7dd8b5de3` | DEPLOY.md: drop proof B from orphaned provisioning runbook | `DEPLOY.md` only (+30/−27) |

Author/committer: Max Harris <drumaxter@gmail.com>. `git show --stat 1cf2c2c9` lists only `DEPLOY.md`. Every hunk is inside "Recovery runbooks" → "Orphaned student provisioning accounts" (DEPLOY.md:2171–2342 at the new head). Nothing else in the doc moved or was renumbered.

## Diff summary (line numbers at 1cf2c2c9)

Hunks (`git diff -U0 614824fb 1cf2c2c9 -- DEPLOY.md`): `-2188,0 +2189`, `-2214,2 +2215,5`, `-2231,18 +2235,16`, `-2262 +2264`, `-2320,6 +2322,7`.

1. **Find query, email-candidate columns relabelled** (DEPLOY.md:2189): a SQL comment above the three `email_candidate_*` columns:

    > `-- Email candidate columns: information only, never enough to delete.`

    The columns themselves are unchanged (read-only query, no other SQL changed).

2. **Column notes** (DEPLOY.md:2212–2219): "It is a lead, never proof." became
    > "…or the account of another provisioning intent for the same address. It is shown for information only and is never enough to delete anything, whatever its window, flag or sign-in fields show."
3. **Proof rule** (DEPLOY.md:2235–2250): the "(A) recorded / (B) flagged" list is gone. Now:

    > "**Proof that this provisioning created the account.** There is one proof, **(A) recorded:** the account is the intent's `recorded_user_id` (`recorded_account_exists` is true) and it was created inside the window (`recorded_in_window` is true). It is the only proof that permits any deletion."

    followed by "An email candidate is never proof." listing the address, `email_candidate_in_window`, a student flag naming this teacher, and null `email_confirmed_at`/`last_sign_in_at`, with Codex's scenario (a later request for the same teacher and address creates, attaches and flags its own account before its roster insert, so it can sit unrostered inside this intent's window while still live). It ends "Without proof (A), nothing is deleted." The old `email_candidate_in_window` route into the window check and the "unrecorded flagged account is a code student" inference are removed.

4. **Revised case list** (numbering 1–6 unchanged):
    - 1 (:2254) No account to resolve — unchanged.
    - 2 (:2260) Valid roster row confirmed — unchanged (deletes nothing).
    - 3 (:2264) "**Proven (A), flagged as this teacher's student, no roster row:**" (was "Proven (A) or (B)"); Storage steps 1–6 unchanged.
    - 4 (:2312) "**Proven (A), not flagged**" — unchanged.
    - 5 (:2322) "**No proof:** any other account with no roster row: every email candidate on an unrecorded intent (flagged as this teacher's student or not, inside the window or not), a recorded account created outside the window, or one flagged for another teacher. It may be a separate person's signup or another provisioning intent's account that is still live. Delete nothing and do not finish the intent: it stays open. Resolve it by hand and escalate to Max with the row and the account's details."
    - 6 (:2329) `teacher_exists` false, "handle it as in cases 1 to 5" — unchanged.
    - Unresolved-intent rule (:2334–2342) — unchanged; its references (case 1, case 2, cases 3 and 4, case 4, case 5, "cases 1 to 3", "Cases 4 and 5") still match.

Storage cleanup steps (Codex FIXED) and the unresolved-intent rule (Codex FIXED): not changed.

## No proof B references remain

```
$ grep -n -E "\(B\)|proof B|Proof B" DEPLOY.md
$ echo $?
1
```

No matches. Remaining "(A)" references: :2236 (the proof rule), :2249 ("Without proof (A), nothing is deleted."), :2264 (case 3), :2312 and :2314 (case 4).

## Local checks (on 1cf2c2c9's tree, before the push)

- `npm run lint:check` (eslint .): clean.
- `npm run typecheck` (tsc --noEmit): clean.
- `npm test` (vitest): 242 files passed, 6 skipped (248); 3769 tests passed, 20 skipped (3789).
- `npm run build`: succeeded (PWA: 110 precache entries).
- `npx prettier --check DEPLOY.md`: "All matched files use Prettier code style!"
- `npm run format:check`: NOT clean at 614824fb already (pre-existing warnings in `tests/imslp/imslpLicense.test.ts` and `tests/imslp/worksMirrorIsolation.test.ts`, files this PR does not touch), so per the instructions it was not used as a gate. DEPLOY.md itself is Prettier-clean.
- No local Supabase stack was started (docs-only change).

## CI on the final head 1cf2c2c9

All finished and **fully green**, read via the REST API (`gh pr checks` is unavailable: GraphQL returns 403 in Claude Code sessions), `actions/runs?head_sha=…`, `commits/1cf2c2c9…/check-runs` and `commits/1cf2c2c9…/status`:

| Run / check             | Event        | Job id       | Result                              |
| ----------------------- | ------------ | ------------ | ----------------------------------- |
| CI run **39838223334**  | pull_request | —            | completed, success                  |
| ↳ checks                | pull_request | 120032056065 | success                             |
| ↳ supabase-local        | pull_request | 120032055673 | success                             |
| ↳ omr-service           | pull_request | 120032055938 | success                             |
| ↳ supabase-drift        | pull_request | 120032056232 | success                             |
| ↳ edge-functions-deno   | pull_request | 120032056004 | success                             |
| CI run **39838216425**  | push         | —            | completed, success                  |
| ↳ checks                | push         | 120032032259 | success                             |
| ↳ supabase-local        | push         | 120032032324 | success                             |
| ↳ omr-service           | push         | 120032032183 | success                             |
| ↳ supabase-drift        | push         | 120032031831 | success                             |
| ↳ edge-functions-deno   | push         | 120032032138 | success                             |
| Supabase Preview        | check run    | 120032029391 | skipped (as on earlier heads)       |
| Vercel Preview Comments | check run    | 120032272893 | success                             |
| Vercel (commit status)  | status       | —            | success, "Deployment has completed" |

Combined commit status: `success`. No Vercel rate-limit failure this round, so no Vercel action was needed or taken.

## Follow-ups

- **Hard time bound on `student_provision_intents_for()`'s email fallback** (`20261022110600`): it falls back to any account at the intent's address when nothing was recorded, with no upper time bound. Codex marked it pre-existing and out of scope. A migration should bound it (for example to the intent's `expires_at`) and, given Codex r5's scenario, consider excluding accounts recorded on another intent.
- Decision 49(6) scheduled sweep (cases 1 to 3) remains a follow-up, as the doc says.

## Open questions (for Max)

1. **Automatic account-deletion cleanup and Codex r5's scenario.** The runbook's intro (DEPLOY.md:2176–2177) still says account deletion cleans these up automatically when the account is flagged as that teacher's student, via `student_provision_intents_for()`'s email fallback. That is code behaviour, not a runbook proof, so it was left alone (docs-only, change nothing else). Whether the code path can hit the same misattribution (an expired intent's flagged email candidate that is really another live intent's account) was not examined in this round; worth a look alongside the time-bound follow-up.
2. **Intents with several rows.** The find query shows one row per email candidate. Case 2 (a rostered candidate on an unrecorded intent) says to run `finish_student_provision`, while case 5 on another row of the same intent says to keep it open. The unresolved-intent rule implies case 5 wins, but the runbook does not say so explicitly. Left unchanged (outside this round's scope); a one-line clarification ("finish an intent only when every one of its rows is resolved") may be worth adding in a later round.

## Not done / constraints honoured

- No changes outside DEPLOY.md. No SQL, migration, function, code, test, script, `ci.yml`, `.env.example` or `SETUP_SUPABASE.md` changes.
- No Codex review requested or run. No messages or handoffs sent to any session or agent (no send_message). No PR comments.
- No hosted services touched (no Supabase prod/dev, Vercel, Stripe). No merges; nothing pushed to main or dev. PR #54 and other PRs/branches untouched; earlier report branches untouched.

## Hosted steps left for Max (none performed)

- None new for this round. This is a runbook-only change; the runbook is used in production's SQL editor only when an orphaned provisioning actually needs resolving.
