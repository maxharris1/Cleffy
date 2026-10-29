VERDICT: REVISE

Review of PR #79 (`mh/generic-score-search` → `dev`), commit `8e29b2044318f926bb9545e76f6316dd15cee695`. The branch head was checked with `git ls-remote` and has not moved. The base is `dev` @ `3fd4fbce`. The diff covers 22 files (+136/−127).

The PR meets the spec's main requirement. After this PR, the only user-visible "IMSLP" outside the legal pages is the attribution line, in both the source and the built bundle. No identifiers, routes, columns, Edge Functions or legal pages changed. Tests were updated properly, and CI is green. I'm asking for a revision only because of copy problems, which check 2 covers: one sentence users can see reads wrong, one button label is ambiguous, and the allowance name is unclear on the pricing card. Each fix is a one-line copy change. There are no Critical or High findings.

## Findings

### Critical

None.

### High

None.

### Medium

**M1. The regex that rewrites server messages produces broken English in a fallback users can see.**
`genericScoreMessage` replaces every `IMSLP` with "the source library". Server sentences that say "on IMSLP" turn into "on the source library", which doesn't read naturally. The worst case is the "license check unavailable" fallback, which is shown in the amber fallback box on the edition panel.

- Where: `src/features/imslp/imslpDisplay.ts:89-90` (the helper); `src/features/imslp/imslpApi.ts:145` (where it's applied to the fallback message). The source strings are in `supabase/functions/_shared/imslpImportFlow.ts:113-116,131-132`, `supabase/functions/_shared/imslpDownload.ts:459-467` and `supabase/functions/imslp-work/index.ts:178`.
- Evidence: I ran the helper's regex on the real server strings:
  - `Cleffy couldn't reach IMSLP … — or open it on IMSLP.` becomes `Cleffy couldn't reach the source library to check this edition's license, so it wasn't imported. Try again in a minute — or open it on the source library.` The next line in the same box says "Open the source page (verify if asked)…", so two different terms appear one line apart.
  - `Work not found on IMSLP` becomes `Work not found on the source library`. It is shown through `ImslpBrowser.tsx:153` `setError(err.message)`.
  - `Too many IMSLP imports at once — …` becomes `Too many the source library imports at once — …`. This one is not reachable today, because `caller_rate_limited` is in `RETRY_LATER_CODES` (`imslpApi.ts:340`) and gets retried. It shows that the blanket regex can produce ungrammatical text.
- Suggested fix: Map the few known server messages, keyed by fallback `code`, to client-side copy, the same way `IMSLP_DOWNLOAD_BUSY_MESSAGE` is already handled. Keep the regex only as a last resort. At minimum, rewrite "on IMSLP" as "on its source page". Alternatively, rephrase the server strings in a follow-up deploy, though that would expand the PR's scope.

**M2. "Open source page" reads like "open-source page".**
In this button label and inline link, "Open source" looks like the compound adjective "open-source". The unlabelled `<ul>` name "Editions to open at source" is also awkward when a screen reader announces it.

- Where: `src/features/imslp/ImslpWorkPanel.tsx:226,249,309` ("Open source page"), `:400` ("open source page" / "check source page") and `:329` (`aria-label="Editions to open at source"`).
- Evidence: Pick a restricted edition on any work. The primary button reads **Open source page**, right next to **Choose downloaded PDF**.
- Suggested fix: Use one verb for every external link, the same one the header and the Source dialog already use: **View source page**. For the inline links, use "view source page" / "check on source page". Change the list's aria-label to "Editions you can view on the source page", or "Not downloadable here" to match the visible heading. Then update the matching test queries in `ImslpBrowser.test.tsx`.

**M3. "Score imports" is ambiguous on the pricing card and account page.**
`smart_imports` is spent only by imports through Find a score. Uploading your own PDF ("Score uploaded" toast) does not count against it. The pricing card now lists "3 active cloud scores", "2 score imports a month" and "5 AI page reads for Import marks a month" one after another. Readers can reasonably think that uploading a score uses up a "score import". That is exactly the confusion the old "IMSLP imports" label avoided. Check 3 asks whether the rename reads well here, and this is where it doesn't.

- Where: `src/features/billing/pricing.ts:178,191`; `src/features/account/AccountPage.tsx:58` (meter label and the generated progress-bar aria-label "Score imports used this month"); `src/features/billing/limitErrors.ts:232-234`.
- Evidence: On the Free card, a user who has just uploaded two PDFs sees "2 score imports a month". Nothing tells them uploads are not included.
- Suggested fix: Name what is being imported, for example **"2 public-domain score imports a month"** / **"Unlimited public-domain score imports"** / account row **"Public-domain imports"**, and use the same wording in `limitErrors`. If the extra length is a problem, keep "score imports" and add a short qualifier on the card ("from Find a score; uploads don't count").

**M4. The Source dialog calls a Creative Commons edition "Public-domain".**
The Source dialog now opens every IMSLP-sourced score with "Public-domain scores via IMSLP". That includes CC-BY / CC-BY-SA editions, and the dialog exists because those editions require attribution. The old line, "Imported from IMSLP, the Petrucci Music Library.", made no claim about public domain. The PR body notes this choice ("Keep the exact requested attribution wording, including on editions with Creative Commons…"), so this is something Max should decide on, not an oversight.

- Where: `src/features/viewer/ScoreSourceButton.tsx:74`.
- Evidence: The test fixture `ScoreSourceButton.test.tsx:42-49` renders "Public-domain scores via IMSLP" directly above "License: Creative Commons Attribution-ShareAlike 4.0" in the same dialog.
- Suggested fix: Show the spec wording only for PD-licensed scores. For other licenses, show a neutral variant such as "Score via IMSLP" or "Source: IMSLP". The other option is for Max to explicitly accept the spec wording for all licenses.

### Low

**L1. Two different strings for the same search timeout.**
A client-side timeout shows `SEARCH_TIMEOUT_COPY` = "The score search took too long to answer." (`imslpDisplay.ts:87`). The server's statement timeout (`supabase/functions/imslp-search/index.ts:587`) sends "IMSLP took too long to answer.". That message doesn't match the `friendlySearchError` regex (`imslpDisplay.ts:99`), so it goes through the generic rewrite and appears as "The source library took too long to answer.". Before this PR, both strings were identical. Fix: add `took too long` to the regex at `imslpDisplay.ts:99`, or compare against the server string.

**L2. The phone nav no longer uses `shortLabel`, but the plumbing is still there.**
`LibraryShell.tsx:123` still declares `shortLabel?`, and `:564-571` still has the branch that renders it. No nav item sets it any more. Either remove both, or keep them on purpose. "Find a score" is shorter than "Find on IMSLP", and the phone nav strip scrolls sideways (`:551`), so overflow is unlikely. This still hasn't been checked visually; see Checks.

**L3. The landing-page feature tile reuses the nav label as its title.**
`LandingPage.tsx:37` `title: 'Find a score'` sits among descriptive tiles ("Live ink", "Works offline", "The PDF stays pristine"). As a tile heading it reads like a button. Something like "Public-domain library built in" or "Thousands of scores built in" would read better. Optional.

**L4. `genericScoreMessage` has no direct unit test.**
The helper is covered only indirectly: `ImslpBrowser.test.tsx:132` and `imslpApi.test.ts:248` test the sentence-initial case. The lowercase mid-sentence replacement has no test, so the M1 problem would not be caught. Add a small table test in `ImslpBrowser.test.tsx` ("imslp display helpers"), or replace the helper as M1 suggests.

**L5. Some test names and comments still say "IMSLP".**
For example, `ImslpBrowser.test.tsx:1207` "says the month's IMSLP imports are spent…", `tests/billing/limitsInSync.test.ts:206`, and `AccountPage.test.tsx:358` comment. None of these are user-visible, and the PR body says so. Optional tidy-up.

## Checks

1. **No user-visible "IMSLP" except attribution: PASS.**
   - Commands run on a worktree at `8e29b204`:
     - `grep -rn "IMSLP" src --include=*.ts --include=*.tsx --include=*.css | grep -v '\.test\.' | grep -v src/features/legal`, followed by a manual review of every hit. There were 84 lines. All were comments, internal constant names (`IMSLP_DOWNLOAD_*`), or the helper regex, except for three.
     - `grep -rniE "imslp|petrucci" index.html public vite.config.ts vercel.json supabase/templates` found nothing user-visible. The only hits were comments and function sections in `supabase/config.toml`.
     - `npm run build` (exit 0), then `grep -rl IMSLP dist`.
   - The three user-visible source hits, all attribution:
     - `src/features/imslp/ImslpSearchPanel.tsx:728`
     - `src/features/imslp/ImslpWorkPanel.tsx:342`
     - `src/features/viewer/ScoreSourceButton.tsx:74`
   - Built output: the attribution line appears in `SearchPage-*.js` (×2: search panel and work panel) and `ViewerPage-*.js` (×1). There is also the regex literal in `imslpApi-*.js`, which is not shown to users, and the legal text in `LegalPage-*.js`, which is out of scope and left unchanged. There were no hits in `dist/index.html`, the manifest or `sw.js`.
   - Edition filenames shown in the picker are `PMLP…` wiki names; the `IMSLP#####-` prefix appears only on CDN URLs. `displayEditionName` strips the `PMLP` prefix, so no "IMSLP" leaks through filenames.
   - Server error text is rewritten on the client by `genericScoreMessage`, so "IMSLP" doesn't leak there either, but the wording it produces is poor (M1).
   - The search panel is wrapped in `hidden` while a work is open (`ImslpBrowser.tsx:255`), so only one attribution is visible at a time in the picker.
2. **Copy is consistent and natural: REVISE.** "Find a score" and "Search thousands of public-domain scores." are used consistently across the nav, the h1, the empty library, the landing page and `/try`. Capitalisation is consistent: sentence case for headings and buttons, lowercase for inline links. Problems: the rewritten server text is awkward (M1), "Open source page" is ambiguous (M2), there are three terms for the provider ("source page", "source library", "score search/index/lookup") (M1/L1), and there are two timeout strings (L1).
3. **"Score imports" on pricing and account: PARTIAL.** The wording is consistent across `pricing.ts`, `AccountPage.tsx`, `limitErrors.ts` and the progress-bar aria-label, but it's ambiguous next to "cloud scores" and "Import marks" (M3).
4. **No internal identifiers, routes, URLs, DB columns, analytics events or legal pages changed: PASS.** The diff touches only string literals, plus one new exported helper (`genericScoreMessage`) and its import. Every exported name (`IMSLP_DOWNLOAD_*`, `ImslpImportCancelledError`, `smart_imports`), the `/search` route, `functions/v1/imslp-download`, the `source: 'imslp'` check and the `imslp.org` URLs are unchanged. `src/features/legal/*` and `supabase/` are not in the diff, and no analytics calls were touched. I checked that no code matches on the old strings: `grep -rnE "import cancelled|Imported from|Find on IMSLP|More from IMSLP"` over `src`, `tests` and `scripts` finds only comments and test names. `scripts/csp-smoke.mjs:522` checks for "Public Domain", which still matches the License row.
5. **Tests are sound: PASS** (with L4). The number of `it(`/`test(` blocks is unchanged in all 8 changed files (for example, ImslpBrowser 70→70 and LibraryShell 36→36). No `.skip`, `.only`, `todo` or snapshots were added; `grep` over the diff for these finds nothing. All assertions are behavioural (role/name queries, toast arguments, aria-valuenow), and the expected strings match the new copy. Two attribution-count assertions were added (`ImslpBrowser.test.tsx:461,709-711`), and the second filters out `[hidden]` correctly.
   - The 8 changed suites, run locally on Node 22.22.0: **206/206 passed**.
   - `npm run lint:check`: exit 0. `npm run typecheck`: exit 0. `npm run build`: exit 0.
   - Full `npm run test` on Node 22.22.0: **268 test files passed, 6 skipped; 4,157 tests passed, 22 skipped, 0 failed** (exit 0). The 2 `tests/imslp/seed.test.ts` failures reported in the PR body came from the author's sandbox (child-process `EPERM`) and do not reproduce here.
   - PR CI on `8e29b204`: all checks passed (checks, supabase-local, supabase-drift, edge-functions-deno and omr-service, ×2 runs each; Vercel Preview Comments passed; Supabase Preview skipped).
6. **a11y labels updated: PASS** (with M2 wording).
   - Updated: sr-only `<label>` "Search scores by composer or piece" (`ImslpSearchPanel.tsx:522`), the `ProgressBar` label "Importing score" (`LibraryShell.tsx:606`), the account meter aria-label "Score imports used this month" (generated at `AccountPage.tsx:515`), the list aria-label "Editions to open at source" (`ImslpWorkPanel.tsx:329`, awkward, see M2) and the aria-live status lines.
   - No `alt`, `title` or `aria-label` containing "IMSLP" remains (grep of non-test `src`).
   - Not done: no visual or phone layout check. Screenshots were not allowed for this review, and the PR body also says none were taken. The phone nav strip scrolls sideways (`LibraryShell.tsx:551`), so overflow is unlikely, but it hasn't been checked visually.

## Follow Up

These are non-blocking and were not introduced by this PR.

- **Legal and docs.** The terms (`termsOfService.ts:84,88,103`), copyright policy (`copyrightPolicy.ts:161-165`) and privacy policy (`privacyPolicy.ts:113,218`) still name IMSLP. That is correct for disclosure, and the PR body lists them for Max. The `README.md:5` and `.claude/skills/ui-check/SKILL.md:63` mentions are harmless.
- **Server-side copy.** The Edge Function messages (`_shared/imslpImportFlow.ts`, `_shared/imslpDownload.ts:459-467`, `imslp-work/index.ts:178,273`, `imslp-search/index.ts:587`, `imslp-download/index.ts:149`) still say IMSLP and rely on the client rewrite. Rewording them, or returning only codes and letting the client own the copy, would remove the need for the regex in M1. Doing that requires an Edge Function deploy.
- **`smart_imports` naming.** The privacy policy (`privacyPolicy.ts:30`) uses "Smart import" for the AI mark-reading feature (vision_reads), and `features.smartImport` gates Import marks. Meanwhile, the `smart_imports` meter counts score-library imports. This internal naming clash predates the PR and adds to the M3 confusion.
- **Docs.** `DEPLOY.md:3254` and `SETUP_SUPABASE.md:508` quote the old UI strings ("IMSLP index is still being built", "Queued for IMSLP…") in QA and runbook steps. They should be updated so QA checklists match the UI.
- **Phone screenshots.** The spec asks for phone screenshots of the search screen in the PR body. They are still missing.
