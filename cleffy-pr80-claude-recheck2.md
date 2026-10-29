VERDICT: SHIP

# Cleffy PR #80: re-check of the round-2 fix diff `21a4a376..a33be1c7`

- **PR:** https://github.com/maxharris1/Cleffy/pull/80 (`mh/imslp-shared-cache` into `dev`, still a draft, `mergeable_state: clean`).
- **Head check (2026-10-29):** `git ls-remote` showed `refs/heads/mh/imslp-shared-cache` = `a33be1c7ec7f2c71f78d20d29a9a90f05e21e1c6`. The head has not moved, and the GitHub PR API agrees. `dev` is still `3fd4fbce`.
- **Commit reviewed:** `a33be1c7`, a single commit by Max Harris whose parent is exactly `21a4a376`. It changes 11 files (+235/-59).
- **What I ran locally at `a33be1c7`:**
  - **Local Supabase.** I booted it with CLI 2.121.0 and the same `-x` service set as CI's `supabase-local` job, which applied all migrations.
    - `bash scripts/ci/sql-proof.sh <local DB> tests/sql/imslp_shared_pdf_cache.sql` reported **66 checks passed, 0 failed**.
    - I re-applied the PR migration on top, as CI does. It ran cleanly with NOTICEs only, and the proof still passed 66/66.
  - **SQL mutation tests.** I ran five mutations against the proof, listed under Finding status.
  - **Deno.** I used Deno 2.9.6, an npm-provided binary in my scratchpad; CI pins 2.1.4.
    - `deno test --config supabase/functions/deno.json supabase/functions/_shared/imslpPdfCacheStore_test.ts` reported **8 passed, 0 failed**.
    - I also ran three mutation tests of the new handler regression.
  - **Vitest.** `npx vitest run` on `LibraryShell`, `documentsService`, `ViewerPage`, all of `tests/imslp/` and `applyMigrationsInSync` gave **466 passed in 23 files**. That includes `tests/imslp/seed.test.ts`, which failed only in Codex's sandbox.
    - The account-menu test passed in 5 separate isolated runs.
  - **Typecheck and lint.** `npm run typecheck` and `npm run lint:check` were both clean.
- **What I did not run:**
  - `npm run build`. The diff has no bundling changes.
  - The full Vitest suite.
  - Any hosted Supabase, Stripe or IMSLP requests. The Deno handler test stubs `fetch` and throws on any unexpected request.
- **Nothing was pushed except this report.**

All five round-2 findings are fixed, and the CI flake is addressed. Every fix is pinned by a test that fails when the fix is reverted. CI is green on both the push and `pull_request` runs at `a33be1c7`. The new findings below are all Low, and none blocks a merge.

## Finding status

### N1 (High). Caller-steerable negative license writes: **FIXED**

**Code evidence:**
- `supabase/functions/imslp-download/index.ts:271` derives `licenseFilename = cache.entry?.filename ?? canonicalFilename`. Three places use it:
  - the cached-clearance read (`:292`);
  - the live work-page lookup (`:355`);
  - the positive upsert (`:364`).

  On a hit, the caller's alias filename can no longer select which license row is read or written.
- `not_listed` now returns `{ kind: 'not_listed' }` with **no table write** (`index.ts:356-361`). `downloadable: false` no longer appears anywhere in `index.ts`, and the wiring test asserts that (`tests/imslp/imslpDownloadWiring.test.ts:23`).
- On a hit, the live check still uses the trusted `cache.entry.work_title` (`index.ts:278`).
- The only remaining write is the positive or explicit upsert. It is reached only when the real work page lists the canonical cached filename, so any negative row now reflects a license IMSLP itself publishes for that file.
- The miss variant is closed. A wrong caller `workTitle` produces `not_listed`, and nothing is persisted, so neither the license cache nor the `imslp-work` picker can be poisoned.

**Test evidence:** `supabase/functions/_shared/imslpPdfCacheStore_test.ts:220-336` drives the real handler with stubbed `fetch` through three scenarios:
- a stale hit with the alias absent from the page;
- a miss with the wrong work title;
- a stale hit where the page lists the canonical filename.

It asserts:
- the license query uses the canonical filename;
- the hit uses the trusted work title, and live licensing is paced;
- there are no writes on `not_listed`, and the existing row is unchanged;
- the refusal comes before quota is spent;
- the positive refresh is written to the canonical name.

**Mutation evidence (the test fails each time):**
- reverting `.get(licenseFilename)` to `.get(canonicalFilename)` gives `stale-hit-listed: 409 license_unknown`;
- re-adding a `downloadable: false` upsert on `not_listed` gives `not_listed must not write a license row`;
- reverting the cached read to `canonicalFilename` gives `license cache uses canonical cached filename`.

CI ran the test too: the `edge-functions-deno` job (123469994817) shows the new test `ok`, 8 passed.

### N2 (Medium). A missing or purged license row revoked reads: **FIXED**

- `supabase/migrations/20261028120000_imslp_shared_pdf_cache.sql:107-121`: `can_read_pdf` no longer joins `imslp_file_licenses` in its positive branch. Reads require all of:
  - an unblocked cache entry for the path (`:109-112`);
  - no blocked alias and no alias with an explicit `downloadable = false` (`:112-116`);
  - a referencing document with `document_role` not null (`:116-120`).
- Proof check 28n (`supabase/tests/imslp_shared_pdf_cache.sql:175`) now expects reads to survive a purge. Check 28o (`:188`) still expects an explicit canonical negative to deny reads.
- **Mutation A** restored the round-1 positive-row requirement, and 28n failed. **Mutation C** dropped the negative branch, and 28o failed.
- Safety of relaxing this rests on publication. A cache entry is only published after fresh positive clearance, or after a live parse that wrote a downloadable row (`index.ts:363-378`). An upsert error returns `unavailable` before any download or publish, so no entry can exist without clearance at publish time.

### N3 (Low). Uploader-specific takedowns blocked the bytes everywhere: **FIXED** (but see R2)

- The trigger now blocks only when `new.lifted_at is null and new.ground = 'copyright'` (`migration:150`). Removals on `terms` or `illegal` grounds stay document-scoped through `document_role()`.
- New proofs:
  - 28o2 and 28o3a: the owner of the removed document is denied (`:204`, `:215`);
  - 28o3 and 28o4: another library keeps access (`:209`, `:220`);
  - 28o5: the cache stays hittable (`:223`).

  The existing copyright proofs (28q, 28q4, 28r, 28s, 28t) are unchanged.
- **Mutation B** restored `action = 'remove' or ground = 'copyright'`, and 28o3, 28o4 and 28o5 failed. **Mutation E** (trigger does nothing) failed 28q, 28q4, 28r, 28s and 28t, so the copyright path is still pinned.
- My round-1 suggestion was to block on `ground in ('copyright', 'illegal')`. The fix chose copyright only. See R2.

### N4 (Low). Cold-open prefetch disabled for every document: **FIXED**

- `src/features/library/documentsService.ts:983-986` signs `${id}/original.pdf` speculatively again when no path is known. `ViewerPage.tsx:513` (unchanged call) therefore prefetches again.
- The reuse guard is intact: `documentsService.ts:1008-1009` reuses the prefetched URL only if `prefetch.path === doc.storage_path`. So a speculative private URL is never served for a shared row, and L2 stays fixed.
- Tests:
  - `documentsService.test.ts:657` asserts signing starts before the source load;
  - `:666-677` asserts a shared row discards the speculative URL and signs the real shared path.
- The accepted trade-off: a cold open of a shared row makes one wasted signing request, which fails for a missing object and resolves to `null`.

### N5 (Low). Per-row helper probes on private objects: **FIXED**

`migration:125-127`: the permissive policy is now `bucket_id = 'scores' and name like '00000000-0000-0000-0000-000000000000/%' and imslp_private.can_read_pdf(name)`. The restrictive guard (`:130-132`) is unchanged. All 66 proof checks pass, and the membership mutation (D) still fails the checks below, so the prefix did not weaken the gate:
- 26 and 26b (non-members);
- 28e and 28i (revoked);
- 28o2 and 28o3a (takedown owner).

### CI account-menu flake (`LibraryShell.test.tsx`): **FIXED**

- `src/features/library/LibraryShell.test.tsx:347-353` now:
  1. waits until `menu[name=Account]` has focus, which is the menu's scheduled initial focus;
  2. focuses the Students link;
  3. asserts that the link has focus;
  4. presses Enter.
- The navigation, back, and menu-closed assertions are untouched, and no timeout was raised.
- It passed 5 out of 5 in isolation for me. It also passed in both CI `checks` runs at `a33be1c7`.

### Earlier findings (H1, M1-M4, L1-L5): status unchanged by this diff

| Finding | Status | Why the diff does not affect it |
| --- | --- | --- |
| H1 | **FIXED** | The membership gate, block column and takedown path are intact (`migration:107-160`). Mutation D (membership removed) fails six checks: 26, 26b, 28e, 28i, 28o2, 28o3a. |
| M1 | **FIXED** | The diff does not touch the import-eligibility code, and the Deno eligibility test is still `ok` in CI. |
| M2 | **FIXED** | Listing is still membership-scoped under RLS (proof 17/26b passes; mutation D fails 26b). The oracle ACL is unchanged (`migration:102-103`). |
| M3 | **FIXED** | The diff does not touch `commit_pdf_replacement` or its guard trigger. |
| M4, L1, L3, L5 | **FIXED** | The diff does not touch these. |
| L2 | **FIXED** | It is still protected by the path-equality check at `documentsService.ts:1008-1009` (see N4). |
| L4 | **PARTIAL** | Still documented only (`migration:4-5`); product sign-off is still pending. |

### Were tests weakened? **No.**

- **SQL proof:** it grew from 60 to 66 checks, and none was removed. The six added are 28n2, 28o2, 28o3, 28o3a, 28o4 and 28o5.
  - 28n's polarity was inverted on purpose, because N2 changes the intended semantics.
  - 28o's fixture changed from `('unknown', false)` to `('non-pd', false)`. The assertion (an explicit negative blocks reads) is unchanged, and mutation C proves it still bites.
- **Wiring test:** `toContain('downloadable: false')` was replaced by two positive `toContain` checks plus `not.toContain('downloadable: false')`. This follows the intended N1 change.
- **`documentsService` test:** "defers speculative signing" was replaced by a stronger test. It checks both the speculative URL and the reuse guard on a shared row.
- **`LibraryShell`:** assertions were only added; none was relaxed.
- **Deno:** the existing eligibility test was refactored to share a `getDownloadHandler()` helper. Its assertions are unchanged, and it still passes.

## New findings

No Critical, High or Medium findings.

### Low

#### R1. Proof check 28n2 does not exercise the N1 path it is named for

- **File:** `supabase/tests/imslp_shared_pdf_cache.sql:179-183`.
- **Evidence:**
  - The check inserts a negative license row for `IMSLP51037-attacker.pdf`, a filename that is never an `imslp_pdf_cache.filename`.
  - `can_read_pdf` joins licenses only on `c.filename` (`migration:114`), so this row can never affect reads, with or without the round-2 fix.
  - Under mutation A (the round-1 `can_read_pdf`), 28n2 failed only because 28n had already deleted the canonical positive row, not because of the alias.
  - The real N1 regression lives in the Edge layer, and the Deno test covers it properly. 28n2 is therefore redundant rather than wrong.
- **Fix:** none needed for merge. Optionally rename or comment it as "license rows for non-cached filenames never affect reads", or remove it so the proof count does not overstate N1 coverage.

#### R2. Illegal-content takedowns of a shared IMSLP score no longer stop the identical bytes elsewhere, and the new comment mislabels the ground

- **Files:**
  - `supabase/migrations/20261028120000_imslp_shared_pdf_cache.sql:134-139` (comment) and `:150` (trigger);
  - `supabase/tests/imslp_shared_pdf_cache.sql:220-223` (28o4 and 28o5 lock this in).
- **Evidence:**
  - `content_takedowns.ground = 'illegal'` is the DSA illegal-content ground (`src/features/moderation/moderationApi.ts:13-21`: CSAM, terrorist content, hate speech, privacy, and so on). It is not "illegal conduct", as the new migration comment says (`:135`).
  - For an IMSLP-imported score, the shared original is the same stored object in every library.
  - After a `remove` on `illegal` grounds:
    - every other library keeps reading those bytes (28o4);
    - new imports keep hitting the cache (28o5).
  - The only global remedy is the service-only `block_imslp_pdf` RPC. Moderators have no UI path to it and no indicator that the score's bytes are shared.
- **Mitigation and rationale:**
  - An illegal-content notice can concern a user's annotations or title rather than the PD bytes, so the document-scoped default is defensible.
  - The DSA does not impose a general monitoring duty on other copies.
  - It still needs a moderator decision to reach. So this is a Low operational gap, not a merge blocker.
- **Fix:**
  - Correct the comment to "illegal-content (DSA) notices".
  - In the moderation tool, show "this score's original is a shared IMSLP file", with an explicit option to also call `block_imslp_pdf` when the notice concerns the bytes.
  - Alternatively, block on `illegal` only when `action = 'remove'` and the report targets the original rather than annotations.

#### R3. On a cache hit, the caller's alias filename still appears in the response `openUrl` and `filename`

- **File:** `supabase/functions/imslp-download/index.ts:281` and `:532-533` (`imagefromIndexUrl(canonicalFilename)`).
- **Evidence:**
  - This code is from before round 2. The handler test output shows `openUrl: .../ImagefromIndex/IMSLP51037-attacker.pdf` on a hit.
  - The impact is cosmetic and limited to the caller's own response. Stored provenance comes from `entry.provenance` and `entry.filename` (`index.ts:448`, `:511`), so no shared state is affected.
- **Fix:** optional. Use `licenseFilename` (the cached canonical name) for `openUrl` and `filename` on hits.

## CI

At `a33be1c7ec7f2c71f78d20d29a9a90f05e21e1c6`, read from the GitHub API (read-only):

| Run | Event | Attempt | Conclusion |
| --- | --- | --- | --- |
| 40880372245 | `push` | 1 | **success** |
| 40880382155 | `pull_request` (PR 80) | 1 | **success** |

Jobs, on both runs unless noted:

| Job | Push run | `pull_request` run |
| --- | --- | --- |
| `checks` | success, job 123469959317 | success, job 123469994725 |
| `supabase-local` | success | success |
| `edge-functions-deno` | success | success |
| `omr-service` | success | success |
| `supabase-drift` | success | success |
| Vercel Preview Comments | n/a | success |
| Supabase Preview | n/a | skipped |

- **Requester's claim confirmed:** all of CI is green at `a33be1c7`. The previous `pull_request` failure at `21a4a376` (`LibraryShell` flake) also passed on its rerun (run 40872833138, attempt 2).
- **`edge-functions-deno` log (job 123469994817):** all entry points pass `deno check`. The test run reports `8 passed | 0 failed`, including `real handler keeps not-listed refusals import-only and checks the cached filename on stale alias hits ... ok`.
- **`supabase-local` (job 123469994761):** the job succeeded, and its proof loop (`ci.yml:130`, `for proof in tests/sql/*.sql ...`) runs each proof through `sql-proof.sh`, which fails on any failing check. Within the log tail I fetched, I could not see the `imslp_shared_pdf_cache.sql` line itself. My local run of the same proof against the same migrations gave `OK ... 66 checks passed`.

## Follow Up

- **Not blocking. Optional before merge:**
  - R2: fix the "illegal conduct" wording in the migration comment.
  - R1: rename or drop 28n2.
- **Moderation and operations:**
  - R2: give moderators a "shared IMSLP original" indicator and a path to `block_imslp_pdf`.
  - Add a service-only unblock RPC. Today a copyright block can only be cleared by manual SQL, as the fix report itself notes.
- **Hosted configuration:** confirm the hosted Data API "Exposed schemas" does not include `imslp_private`. `config.toml` only governs local, and I did not check hosted.
- **Before deploying:** confirm no round-1 build of `imslp-download`, which persisted `not_listed` negatives, was ever deployed anywhere it could have written `downloadable = false` rows. The migration header says no hosted migration has been applied, so this is expected to be a no-op.
- **Product:** L4 sign-off on shared originals sitting outside per-user byte quotas.
- **Still deferred from earlier rounds:** GC and a size budget for `imslp_pdf_cache`.
- **Polish:** R3 (use the canonical filename in hit responses).
- **What was not done here:**
  - no `npm run build` and no full Vitest suite;
  - local Deno was 2.9.6, not CI's 2.1.4 (CI's 2.1.4 run is green);
  - no requests to hosted Supabase, Stripe or IMSLP.
