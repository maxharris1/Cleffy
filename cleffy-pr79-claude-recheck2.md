VERDICT: SHIP

Second re-check of PR #79 (`mh/generic-score-search` → `dev`). I reviewed only the fix diff `d6dc9211965f02fabf72984a489d0332708a1226..c38fc4dcd64e92d9f31ddc15d3e2c297e7d7870c`: one commit by Max Harris, 16 files, +203/−38. `git ls-remote` shows the branch head is still `c38fc4dcd64e92d9f31ddc15d3e2c297e7d7870c`, so it has not moved. The base, `dev`, is at `3fd4fbcef13f1c7b17c6b75e443f5b664e1a498d`, which is the merge base.

All seven prior findings (M1-partial and N1–N6) are fixed.
- The blocking item, N1, is fixed properly. The category sync now decides whether to retry from the typed error code, not from the message text.
- I checked that the new tests guard it. I put the old regex check back in temporarily, and six of the new tests failed.
- Tests got stronger, not weaker: +16 tests, with nothing skipped and no assertions loosened.
- CI is green on the head commit, and my local full run is green.

The only new issues are two Low copy and behaviour nits. Neither blocks merging.

## Finding status

**N1 (Medium). The category sync stopped retrying batches that time out: FIXED.**
- How the fix works:
  - `supabase/functions/_shared/imslp.ts:84` now throws `new ImslpFetchError('timeout', 'The source page timed out', { cause: err })`.
  - The final fallback at `:132` is typed the same way. The 429 error at `:102` was already typed as `rate_limited`.
  - `supabase/functions/_shared/categorySync.ts:504-506` retries only when `err.code` is `'rate_limited'` or `'timeout'`. The wording of the message no longer matters.
  - `ImslpFetchError` takes an optional `cause` and passes it on to `Error` (`supabase/functions/_shared/imslpDownload.ts:135-137`).
  - The out-of-date comment that said "message is unchanged … categorySync retries on /HTTP 429/" is gone.
- Both callers of `walkCategoryBatch` are covered:
  - `supabase/functions/imslp-sync/index.ts:129` passes in the shared `mwFetch`.
  - `scripts/imslp-export-catalog.mjs` has its own fetcher. It now throws a typed `ImslpFetchError` for HTTP errors (`:95`), with `rate_limited` for 429 and `http_error` otherwise. It wraps a `TimeoutError` as code `timeout` (`:110-111`).
  - In Node 22, `AbortSignal.timeout`'s reason is `instanceof Error` and has the name `TimeoutError`, so that check matches.
  - Before this fix, the exporter's timeout message was "The operation was aborted due to timeout". It matched the old regex, so the batch-level retry behaves as it did before.
- Compared with `dev`, nothing changes for the shared `mwFetch`. Before, it threw 'IMSLP API timeout' and 'IMSLP API HTTP 429', and only those two matched the regex. Both now carry codes. Other HTTP errors weren't retried before and still aren't.
- Evidence it works:
  - `tests/imslp/mwFetch.test.ts:26` drives the real `mwFetch`. Its fetch throws a `DOMException` timeout whose message has no keyword in it. The test then checks that `walkCategoryBatch` waits 2 s and retries successfully.
  - `:39` checks the code, message and cause, and `:51` checks a 429 followed by a retry.
  - `tests/imslp/categorySync.test.ts:206` checks a retry triggered by the code alone, with exact back-off timing. `:224` checks the three-attempt cap and that the last error is kept. `:240` checks that misleading "HTTP 429 timeout" text alone does not trigger a retry.
  - Mutation check, run locally and not committed: I put back `/HTTP 429|timeout/i.test(err.message)` at `categorySync.ts:506`. Six tests failed, including the real-`mwFetch` timeout test. After I restored the file, all of them passed.
  - Node check of the exporter path: `node --experimental-strip-types` imports `imslpDownload.ts` and `categorySync.ts` cleanly, because `imslpDownload.ts` has no imports of its own. An exporter-style wrapped Node `TimeoutError` was retried by `walkCategoryBatch`: 2 calls, code `timeout`.

**M1 (PARTIAL last time). Awkward server text from the regex rewrite: FIXED.**
- The part still open last time was "Work not found on the source page". It is now the shared constant `WORK_NOT_FOUND_COPY`, "We couldn't find this work. It may have been renamed or removed." (`supabase/functions/_shared/scoreSearchCopy.ts:3`).
- `imslp-work/index.ts:179` uses it.
- The client maps both older strings to it: "Work not found on IMSLP" (from `dev`) and "Work not found on the source page" (from round 1) (`src/features/imslp/imslpDisplay.ts:94`). The match is anchored, with an optional trailing period.
- Both are tested at `ImslpBrowser.test.tsx:94-95`.

**N2 (Low). "Work not found on the source page" doesn't make sense: FIXED.** It is the same change as M1 above, with the same lines and tests.

**N3 (Low). The license fallback box said "view the source page" three times: FIXED.**
- The server message now ends at "Try again in a minute." (`supabase/functions/_shared/imslpImportFlow.ts:116`).
- The client trims the trailing alternative from older responses (`imslpDisplay.ts:95-98`). It handles both the `dev` wording ("— or open it on IMSLP.") and the round-1 wording ("— or view the source page.").
- I checked the `dev` source string, and the em dash and wording match the regex exactly.
- The exact-string server assertion is at `tests/imslp/imslpImportFlow.test.ts:171`. Both older-response rows are at `ImslpBrowser.test.tsx:100-107`.
- The manual alternative is still offered by the panel's instruction line and the "View source page" button.

**N4 (Low). An empty response from Cleffy's own function was blamed on the source page: FIXED.**
- The message is now "Couldn't load this work. Try again." (`src/features/imslp/imslpApi.ts:258`).
- New tests: `imslpApi.test.ts:261-264` covers the empty-data case. `:266-270` covers a work that loads but has no editions, which still resolves normally rather than being treated as an error.

**N5 (Low). The Source dialog's public-domain check was stricter than the license classifier: FIXED.**
- The check is now `source_license?.trim().toLowerCase().startsWith('public domain')` (`src/features/viewer/ScoreSourceButton.tsx:76`). That is the same prefix rule the classifier uses (`tests/imslp/imslpLicense.test.ts:29` classifies `'Public Domain (dedicated)'` as `pd`).
- The old single public-domain test became `it.each(['Public Domain', 'Public Domain (dedicated)'])` (`ScoreSourceButton.test.tsx:99`), with all three original assertions kept.
- The neutral cases are unchanged (`:119`).

**N6 (Low). Older `IMSLP API …` errors rendered as "The source page API …": FIXED, with one leftover (see NF2).**
- `imslpDisplay.ts:99-101` maps the three cited messages:
  - "IMSLP API timeout" becomes "The source page timed out".
  - "IMSLP API HTTP 500" becomes "The source page returned HTTP 500".
  - "IMSLP API answer too large" becomes "The source page response is too large".
- `:102` strips the `IMSLP API` prefix from anything else, before the general rewrite rules run.
- Tests: `ImslpBrowser.test.tsx:96-98`.

**Earlier fixes (M2–M4, L1–L5): no change.** The fix diff touches none of those lines except the M4 public-domain test, which was extended (see N5).

**Spec checks**
- **Single IMSLP attribution rule: PASS.** The fix adds no user-visible "IMSLP". The new uses are compatibility regexes, a test fixture and the exporter's internal diagnostic text. `dist` contains the new work-not-found copy, and no longer contains the "— or" license tail.
- **No changes to identifiers, routes, legal pages or migrations: PASS.**
  - The diff touches none of `src/features/legal`, `supabase/migrations` or `src/app/routes.tsx`.
  - Response `code` values and response shapes are unchanged. The 404 from `imslp-work` still has the same `{ error }` shape.
  - The `ImslpFetchError` constructor change is additive: `cause` is optional.
- **Tests not weakened: PASS.**
  - Totals went from 4,177 to 4,193 passed (+16), and test files from 268 to 269 (the new `mwFetch.test.ts`).
  - Where the +16 tests come from:
    - Net +5 table rows in `ImslpBrowser.test.tsx`.
    - +2 in `imslpApi.test.ts`.
    - +1 in `ScoreSourceButton.test.tsx`, from the `it.each`.
    - +5 in `categorySync.test.ts`.
    - +3 in `mwFetch.test.ts`.
  - The added lines contain no `.skip`, `.only`, `.todo` or `it.fails`.
  - Two expectations were changed, not dropped:
    - The `Work not found on IMSLP` row now expects the new copy.
    - The license row now expects the shortened sentence.
  - Both still check exact strings.

## New findings

### Critical

None.

### High

None.

### Medium

None.

### Low

**NF1. A MediaWiki error whose text mentions a timeout is no longer retried at the batch level.**
- **Where:** `supabase/functions/_shared/categorySync.ts:504-506`, together with `supabase/functions/_shared/imslp.ts:117-127`.
- **Evidence:**
  - When the MediaWiki API answers with `{error:{info}}`, `mwFetch` rethrows `info` as a plain `Error`.
  - On `dev`, the regex `/HTTP 429|timeout/i` would retry that error if `info` happened to contain "timeout".
  - With the code check, it never retries. The new test at `categorySync.test.ts:240` locks in "never".
- **Impact:** Very small, and arguably the intended behaviour, because only typed failures should trigger a retry. I'm noting it because the PR's scope says behaviour must not change.
- **Fix, if wanted:** No action needed. Or, if `mwFetch` should treat a MediaWiki timeout code as retryable, map that API error code to `ImslpFetchError('timeout', …)` at `imslp.ts:125`.

**NF2. The older fallback "IMSLP API error" renders as "The source page error".**
- **Where:** `src/features/imslp/imslpDisplay.ts:102`.
- **Evidence:**
  - On `dev`, `mwFetch` used 'IMSLP API error' as its fallback when MediaWiki returned an error with no `info`. It is row 5 of the PR body's string table.
  - Until the Edge Functions are redeployed, that text gets through the generic prefix rewrite as "The source page error". The current server text is "The source page returned an error".
  - This is rare (it needs an error with no `info`), and it goes away once the functions are deployed.
- **Fix:** Add `.replace(/^IMSLP API error$/, 'The source page returned an error')` next to `:99-101`, with a table row. Optional.

**Checked and found fine:**
- Passing `cause: undefined` creates an own property `cause` set to `undefined` on errors that have no cause. Nothing reads it, so it does no harm.
- `mwFetch.test.ts` uses fake timers with a 1-attempt `mwFetch`, while production uses 3 attempts. That's fine, because the batch-level retry is what the test is checking.

## CI

GitHub API at `c38fc4dcd64e92d9f31ddc15d3e2c297e7d7870c`, read only:
- Combined status: **success**. Vercel reports "Deployment has completed" at 2026-10-29T13:16:49Z.
- 12 check runs, all completed:
  - `checks`, `supabase-local`, `supabase-drift`, `edge-functions-deno` and `omr-service` passed in both workflow runs, 40880356931 and 40880364435.
  - Vercel Preview Comments passed.
  - Supabase Preview was **skipped**, the same as last round.
- PR state: open, **draft**, `mergeable_state: clean`.
- This matches the requester's report that CI is all green.

Locally, on a detached worktree at c38fc4d with Node 22.22.0 and the existing `node_modules` (nothing installed):
- `npm run lint:check`: exit 0.
- `npm run typecheck`: exit 0.
- `npx prettier --check` on all 16 changed files: clean. `git diff --check`: clean.
- `npm run test`: **269 files passed, 6 skipped; 4,193 tests passed, 22 skipped, 0 failed** (exit 0). This includes `tests/imslp/seed.test.ts`, which the fix author could not run in their sandbox; it passes here.
- `npm run build`: exit 0.
- `node --check scripts/imslp-export-catalog.mjs`: OK.
- Not run:
  - Deno isn't installed here. CI's `edge-functions-deno` covers it, and it passed.
  - No UI or screenshot checks.
  - No live IMSLP, hosted Supabase or Stripe calls.

## Follow Up

- **Nothing blocks merging.** NF2 is a one-line optional cleanup. NF1 needs no action unless Max wants a MediaWiki timeout error retried.
- **The PR body is out of date.** The body on GitHub still describes round 1:
  - Its "Files changed" list leaves out `scripts/imslp-export-catalog.mjs`, `supabase/functions/_shared/categorySync.ts` and `tests/imslp/mwFetch.test.ts`.
  - The string table still shows the round-1 copy: "Work not found on the source page", the "— or view the source page." tail, and "The source page returned no editions".
  - The fix report says a revised body exists at `/tmp/cleffy79fix2-body.md`. It hasn't been applied.
- **The PR is still a draft.** It needs to be marked ready for review before it can merge.
- **Max to decide on the Source dialog wording, carried over.** Non-public-domain scores show "Score via IMSLP" instead of the exact spec line.
- **Edge Function deploy.** After merge, deploy `imslp-download`, `imslp-search`, `imslp-work` and `imslp-sync`. `imslp-sync` changed because of `_shared/imslp.ts` and `_shared/categorySync.ts`. No migration is needed.
- **Existing issue, not introduced by this PR.** In `mwFetch`, a timeout while the response body is being read (`imslp.ts:116`, `readBodyCapped`) is outside the typed timeout wrapper. It surfaces as a raw `DOMException`, so the batch doesn't retry it. That was also true on `dev`, because "Signal timed out." never matched `/timeout/`. Worth a follow-up if slow, large responses turn out to be common.
- **Phone and visual check, carried over.** Still not done. The fix author's Chromium was blocked, and I didn't run UI checks either. Still missing:
  - The longer account and pricing labels haven't been checked at phone width.
  - The phone screenshots of the search screen that the spec asks for are not in the PR body.
- **Docs and legal, carried over.** `DEPLOY.md` and `SETUP_SUPABASE.md` QA steps still quote old UI strings. Legal pages are unchanged, as the spec requires.
