VERDICT: REVISE

Re-check of PR #79 (`mh/generic-score-search` → `dev`). I reviewed only the fix diff `8e29b2044318f926bb9545e76f6316dd15cee695..d6dc9211965f02fabf72984a489d0332708a1226`: 30 files, +198/−116, one commit by Max Harris. `git ls-remote` shows the branch head is still `d6dc9211965f02fabf72984a489d0332708a1226`, so it has not moved.

The copy fixes are good. All four Medium and five Low findings are addressed. M1 is only partly fixed because one of the sentences it cited still reads oddly. The tests got stronger, not weaker (+20 tests), and CI is green.

I'm still asking for a revision, because of one new behaviour regression. M1 led the fix to reword the internal error messages that `mwFetch` throws. The category-sync job decides whether to retry by matching the word `timeout` in those messages. The new message, "The source page timed out", doesn't contain that word, so the sync no longer retries batches that time out. The PR's stated scope excludes "changing search/download behavior". The fix is one line.

## Finding status

**M1. Server text rewritten by the regex reads badly: PARTIAL.**
- Fixed:
  - The server text now uses one provider term, "source page". See `supabase/functions/_shared/imslpImportFlow.ts:114-116,131-132`, `_shared/imslpDownload.ts:464-471`, `imslp-download/index.ts:149`, `_shared/imslpDownloadGate.ts:85` and `imslp-search/index.ts:453,587`.
  - For responses from older function deployments, the client normaliser now rewrites by context (`src/features/imslp/imslpDisplay.ts:92-101`). "Too many IMSLP imports" becomes "Too many score imports", and "open it on IMSLP" becomes "view the source page".
  - "source library" no longer appears in the source or in `dist`. The license-unavailable fallback is checked against its exact string in `tests/imslp/imslpImportFlow.test.ts:168-172`.
- Not fixed: M1 cited `Work not found on IMSLP`. It now reads **"Work not found on the source page"** (`supabase/functions/imslp-work/index.ts:178`, and the client rewrite at `imslpDisplay.ts:99`). That still doesn't make sense: if the work wasn't found, there is no source page. See N2.
- New problems in the same area: the reworded diagnostic strings broke a behaviour contract (N1), and the license fallback box now says "view the source page" three times (N3).

**M2. "Open source page" reads like "open-source page": FIXED.**
- Every external link now says "View source page" or "view source page": `src/features/imslp/ImslpWorkPanel.tsx:153,226,249,309,400`. The instructions say "View the source page…" (`:217,300,324`).
- The list's aria-label is now "Not downloadable here" (`:329`), the same as its visible heading.
- Tests were updated to use role and name queries. Where two links now share the same name, the test expects both (`toHaveLength(2)`, `ImslpBrowser.test.tsx:771,853,952`). That is at least as strict as the old single-link query.

**M3. "Score imports" is ambiguous: FIXED.**
- The account row now reads "Imports from Find a score" (`src/features/account/AccountPage.tsx:58`). The progress bar's aria-label is built from it and becomes "Imports from Find a score used this month".
- The pricing cards read "2 imports a month from Find a score" and "Unlimited imports from Find a score" (`src/features/billing/pricing.ts:178,191`).
- The limit messages use the same wording (`src/features/billing/limitErrors.ts:232-234`).
- Quotas and `smart_imports` are unchanged. The names the new wording uses are on screen, so it doesn't sound like uploads count.

**M4. The Source dialog called CC editions "Public-domain": FIXED, with N5 and one choice for Max.**
- `src/features/viewer/ScoreSourceButton.tsx:74-80` shows "Public-domain scores via IMSLP" only when the recorded license is Public Domain. Anything else shows "Score via IMSLP".
- Tests cover CC-BY-SA (`ScoreSourceButton.test.tsx:45-46`), public domain (`:111`), and CC0, copyright-restricted and null licenses (`:116-126`).
- The match is an exact string comparison. The license classifier accepts more labels than that (N5).

**L1. Two strings for the same search timeout: FIXED.**
- There is now one literal, in `supabase/functions/_shared/scoreSearchCopy.ts:2`. The client imports it at `imslpDisplay.ts:3`, the same way `popularWorks.ts:9` and `searchFacets.ts:19` already import from `_shared`. The server uses it at `imslp-search/index.ts:2,588`.
- `friendlySearchError` also recognises the legacy text "took too long to answer" (`imslpDisplay.ts:109`). The table at `ImslpBrowser.test.tsx:117-126` covers six cases. Deno CI passed with the new import.

**L2. Unused `shortLabel` plumbing: FIXED.** The type member and the render branch are both gone (`src/features/library/LibraryShell.tsx:123,564`). `grep shortLabel src dist` finds nothing.

**L3. Landing-page tile reused the nav label: FIXED.** The tile is now titled "Public-domain library built in" (`src/features/marketing/LandingPage.tsx:38`).

**L4. No direct test for `genericScoreMessage`: FIXED.** Eleven table cases were added (`ImslpBrowser.test.tsx:92-115`). They cover sentence-initial and mid-sentence replacements, the real license-unavailable message, the rate-limit and queued messages, lookup and search failures, and messages that should pass through unchanged.

**L5. Test names and comments still said "IMSLP": FIXED.** See `ImslpBrowser.test.tsx:1242`, `AccountPage.test.tsx:360` and `tests/billing/limitsInSync.test.ts:170,206`. Mentions that are about IMSLP specifically (URLs, the parser, fixtures) are kept on purpose.

**Spec checks**
- **Single IMSLP attribution rule: PASS, with one wording choice for Max.** The fix adds no new user-visible "IMSLP" except the attribution lines. I checked every added line in `git diff … -- src supabase ':!*.test.*'`: the only hits are the normaliser regex and the two attribution strings. In the built bundle, "IMSLP" appears only in `SearchPage-*.js`, `ViewerPage-*.js`, `LegalPage-*.js` (legal text, unchanged) and the regex literal in `imslpApi-*.js`. The Source dialog now has a second wording, "Score via IMSLP", for non-PD editions. That departs from the exact wording the spec asked for, so Max should confirm it (see Follow Up).
- **No changes to identifiers, routes or legal pages: PASS.** The diff doesn't touch `src/features/legal`, `supabase/migrations` or `src/app/routes.tsx`. Response `code` values and response shapes are unchanged. The only changes to exports are the moved `SEARCH_TIMEOUT_COPY` (still re-exported from `imslpDisplay.ts`) and the new `_shared/scoreSearchCopy.ts`. However, internal diagnostic messages were reworded, and one of them is a behaviour contract (N1).
- **Tests not weakened: PASS.**
  - Test counts went up by 20 (4,157 → 4,177).
  - No `.skip`, `.only` or `todo` was added.
  - One assertion got stricter: `imslpImportFlow.test.ts` went from a regex match to an exact string.
  - Assertions that changed from one link to two links still check the exact count.
  - The fixtures in `categorySync.test.ts:557-562`, `imslpDownload.test.ts:399` and `moonlightRanking.test.ts:110-113` only had their message strings updated. None of them tests the retry-on-timeout path, which is why N1 got through.

## New findings

### Critical

None.

### High

None.

### Medium

**N1. The category sync no longer retries batches that time out.**
- **Where:**
  - `supabase/functions/_shared/imslp.ts:84,134`: the message changed from `'IMSLP API timeout'` to `'The source page timed out'`.
  - `supabase/functions/_shared/categorySync.ts:505`: the retry check is `if (attempt < 3 && /HTTP 429|timeout/i.test(message))`.
  - The caller is `supabase/functions/imslp-sync/index.ts:129`, `walkCategoryBatch(mwFetch, …)`.
- **Evidence:**
  - "timed out" doesn't match `/timeout/i`. Before the fix, a timeout that survived `mwFetch`'s own attempts got up to two more tries in `walkCategoryBatch`, each after a back-off. Now it fails the batch straight away.
  - I confirmed this with a throwaway Vitest run at d6dc921. It wasn't committed. A fetcher threw once, then returned `tests/imslp/fixtures/generator-chopin-page1.json`.
    - With `'IMSLP API timeout'`, the sync retried and continued past the failure.
    - With `'The source page timed out'`, it rethrew `The source page timed out` on the first attempt.
  - The HTTP 429 branch still matches, because "The source page returned HTTP 429" still contains `HTTP 429`.
  - The comment at `imslp.ts:102` says the message is unchanged, which is now false.
  - No existing test covers this path.
  - Impact: the nightly index build becomes less tolerant of slow IMSLP responses. The PR's scope says search and download behaviour must not change.
- **Fix (pick one):**
  - (a) Revert the wording of the `mwFetch` diagnostics in `imslp.ts` (lines 84, 104, 111, 116, 128 and 134). They are internal, and the client normaliser already rewrites them for users.
  - (b) Change `categorySync.ts:505` to `/HTTP 429|time(?:d )?out/i`, or better, retry on `ImslpFetchError` codes, and fix the comment at `imslp.ts:102`.
  - Either way, add a `walkCategoryBatch` test where the first fetch throws the real `mwFetch` timeout message and the second succeeds.

### Low

**N2. "Work not found on the source page" doesn't make sense.**
- **Where:** `supabase/functions/imslp-work/index.ts:178`. The client rewrite at `src/features/imslp/imslpDisplay.ts:99` turns any "on IMSLP" into "on the source page", and the test at `ImslpBrowser.test.tsx:94` locks that in.
- **Evidence:** The message is shown through `ImslpBrowser.tsx` `setError(err.message)`. If the work doesn't exist, there is no source page for it to be "not found on". This is the M1 example that is still awkward.
- **Fix:** Use something like "We couldn't find this work. It may have been renamed or removed." in the function, and special-case `Work not found on IMSLP` in `genericScoreMessage` so older deployments show the same text.

**N3. The license-unavailable fallback box says "view the source page" three times.**
- **Where:** `supabase/functions/_shared/imslpImportFlow.ts:116` ("… Try again in a minute — or view the source page."), followed by `ImslpWorkPanel.tsx:300` ("View the source page (verify if asked), save the PDF, then choose it here.") and the button at `:309` ("View source page").
- **Fix:** End the server sentence at "Try again in a minute." The panel line and the button already give the alternative. Update `imslpImportFlow.test.ts:171` and the matching row in `ImslpBrowser.test.tsx:96-99`.

**N4. An empty response from Cleffy's own function is blamed on the source page.**
- **Where:** `src/features/imslp/imslpApi.ts:258`, `throw new Error('The source page returned no editions')`.
- **Evidence:** This branch runs when the `imslp-work` Edge Function returns no `data` body. The source page never answered here; Cleffy's own function did. Also, "returned no editions" is the normal state for a work that has no PDFs.
- **Fix:** Use "Couldn't load this work. Try again." or similar.

**N5. The Source dialog's public-domain check is stricter than the license classifier.**
- **Where:** `src/features/viewer/ScoreSourceButton.tsx:76` checks `trim().toLowerCase() === 'public domain'`. The classifier in `supabase/functions/_shared/imslpLicense.ts:52` treats anything that starts with `public domain` as PD, and `tests/imslp/imslpLicense.test.ts:29` classifies `'Public Domain (dedicated)'` as `'pd'`.
- **Evidence:** A PD edition whose IMSLP label has a qualifier gets the neutral "Score via IMSLP". That fails safe, but it doesn't match how the importer decided the edition was eligible.
- **Fix:** Use `startsWith('public domain')`, or `classifyLicense(doc.source_license) === 'pd'` (`_shared` is already importable from `src`), and add a `'Public Domain (dedicated)'` case to the test.

**N6. Until the functions are redeployed, legacy `IMSLP API …` errors render as "The source page API …".**
- **Where:** `src/features/imslp/imslpDisplay.ts:100-101`.
- **Evidence:** Vercel ships the front end on merge, but Edge Functions need their own deploy. Until then, the old `mwFetch` errors ("IMSLP API timeout", "IMSLP API HTTP 500", "IMSLP API answer too large") reach `imslp-work` through `err.message`. They get rewritten to "The source page API timeout" and so on. Search timeouts are already caught by `friendlySearchError`; the work-lookup path isn't.
- **Fix:** Deploy the functions first, or add `.replace(/^IMSLP API\b/, 'The source page')` before the generic rule. This is gone once the functions are deployed. If N1 is fixed with option (a), the new functions emit these strings again, so this rewrite becomes needed for good.

## CI

At `d6dc9211965f02fabf72984a489d0332708a1226`, read only through the GitHub API:
- Combined status: **success** (Vercel: "Deployment has completed").
- 12 check runs, all completed:
  - `checks`, `supabase-local`, `supabase-drift`, `edge-functions-deno` and `omr-service` passed in both workflow runs (40872829994 and 40872820133).
  - Vercel Preview Comments passed.
  - Supabase Preview was skipped.
- `mergeable_state`: clean.

Locally, on a detached worktree at d6dc921 with Node 22.22.0 and the existing `node_modules` (nothing installed):
- `npm run lint:check`: exit 0.
- `npm run typecheck`: exit 0.
- `npx prettier --check` on all 30 changed files: clean.
- `npm run test`: **268 files passed, 6 skipped; 4,177 tests passed, 22 skipped, 0 failed** (exit 0). This includes `tests/imslp/seed.test.ts`, which was blocked in the fix author's sandbox.
- `npm run build`: exit 0. `dist` has no "source library", "Open source page" or `shortLabel`. It has "Public-domain scores via IMSLP" ×3 and "Score via IMSLP" ×1.
- Deno isn't installed here; CI's `edge-functions-deno` covers it.
- I didn't run any UI or screenshot checks.

## Follow Up

- **Fix N1 before merging.** It's the only blocking item. N2–N6 are one-line copy fixes that could go in the same push.
- **Max to decide on the Source dialog wording.** It now shows a second attribution, "Score via IMSLP", on non-PD scores. That departs from the exact spec wording, as M4 suggested. The PR body (already updated on GitHub) states this; Max should explicitly accept it or ask to go back to a single line.
- **Edge Function deploy.** This PR now changes copy in `imslp-download`, `imslp-search`, `imslp-work` and `imslp-sync` (through `_shared/imslp.ts`), so they need a deploy after merge. The client normaliser covers the gap; see N6 for the leftover case.
- **Phone and visual check.** This is still missing. The account row label ("Imports from Find a score") and the pricing lines are longer now, and nobody has checked them at phone width. The spec's phone screenshots of the search screen are still not in the PR body.
- **Docs, carried over.** `DEPLOY.md` and `SETUP_SUPABASE.md` QA steps quote old UI strings. The empty state is now "Preparing scores", so they are now further out of date.
- **Legal pages:** unchanged, as the spec requires. The earlier legal and naming follow-ups (`smart_imports` vs "Smart import") still stand.
