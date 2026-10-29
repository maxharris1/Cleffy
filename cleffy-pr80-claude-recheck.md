VERDICT: REVISE

# Cleffy PR #80 re-check of the fix diff `63e73464..21a4a376`

- PR: https://github.com/maxharris1/Cleffy/pull/80 (`mh/imslp-shared-cache` into `dev`).
- Head check: on 2026-10-29, `git ls-remote` showed `refs/heads/mh/imslp-shared-cache` = `21a4a376afbeb2a2de0003aa911b966910d3fbb4`. The head has not moved. `dev` is still `3fd4fbce`.
- Scope: I reviewed only the fix commit `21a4a376` (17 files, +949/-245), checked against the original review and the fix report.
- What I ran, all locally at `21a4a376`:
  - I booted local Supabase (CLI 2.121.0, the same service set as CI's `supabase-local` job) and applied every migration.
  - I ran `bash scripts/ci/sql-proof.sh <local DB> tests/sql/imslp_shared_pdf_cache.sql`. It reported **60 checks passed, 0 failed**.
  - I ran a mutation test of that proof (below), direct ACL and policy introspection, storage listing probes, and PostgREST RPC probes against the local API.
  - `npx vitest run` on the 4 touched test files plus `LibraryShell.test.tsx`: **158 passed**. `npm run typecheck`: clean.
- What I did not run: Deno is not installed here, so `imslpPdfCacheStore_test.ts` was not run by me (CI ran it; see the CI section). I touched no hosted Supabase and no Stripe. Nothing was pushed except this report.

The fix closes the original findings properly. The membership-gated read path is sound, and the proof really fails when that gate is removed. But the H1 change introduced a new problem. The "persist negative clearance on `not_listed`" step writes a global `downloadable = false` row based on a **filename the caller supplies**. Because cache hits are keyed by the IMSLP number, not by the filename, any registered account can turn off shared-PDF reads for every library holding a score. It costs them no credit. That one is High, so the verdict is REVISE.

## Finding status

### H1. The shared read bypassed `document_role()`, takedown and licensing: **FIXED** (but see N1, introduced by this fix)

- **Membership gate.** `scores_shared_imslp_read` now calls `imslp_private.can_read_pdf(name)` (`supabase/migrations/20261028120000_imslp_shared_pdf_cache.sql:107-128`). That helper requires all three of:
  - a referencing `documents` row where `public.document_role(d.id) is not null` (`:118-122`);
  - at least one cache alias with a `downloadable` license row (`:109-113`);
  - no blocked alias and no alias with `downloadable = false` (`:114-117`).

  So takedown, revocation and membership semantics now carry over through `document_role`.
- **Proof evidence (local run and CI):**
  - 28e: revoked membership loses the bytes.
  - 28i: a revoked managed student loses them despite membership.
  - 28p: the owner loses them after a `remove` takedown.
  - 28q: another library loses them through the block.
  - 13 and 28c: an allowed member still reads them.
- **Restrictive backstop.** `scores_shared_imslp_read_guard` (`:131-133`) re-applies the helper to any future permissive policy on the reserved prefix.
- **Block mechanism:**
  - `blocked_at` column (`:20`).
  - Service-only `block_imslp_pdf` (`:139-145`; live ACL is `{postgres, service_role}`).
  - Takedown trigger `content_takedowns_block_shared_pdf` (`:146-159`).
  - Publication refuses a blocked hash under any file id (`:74-78`; proof 28q4).
  - The Edge store checks the block on every read (`supabase/functions/_shared/imslpPdfCacheStore.ts:15-26`), and `withImslpPdfCache` refuses a blocked entry (`supabase/functions/_shared/imslpPdfCache.ts:94`).
- **Stale or missing license on a hit.** `imslpCachedClearance` (`supabase/functions/_shared/imslpCachedClearance.ts:5-29`) returns null unless the row is fresh. A null now sends the hit through pacing (`supabase/functions/imslp-download/index.ts:343`) and the live work-page check (`runImslpImport` step 4). `not_listed` and `!downloadable` are refused.
- **Caveat (new issue N1 below).** Persisting `not_listed` as `downloadable = false` (`index.ts:354-364`) is keyed off the caller's filename and invalidates every existing reference.

### M1. Anonymous sessions could drive permanent cache writes: **FIXED**

- `index.ts:150-163` refuses anonymous and provisioned-student callers, using Auth-server-verified `getUser()` metadata (`_shared/auth.ts:57-62`). It then calls `can_import_imslp()` through the **user** client and fails closed on error (503) or refusal (403).
- All of this happens before the rate-limit counter, the body parse, `withImslpPdfCache`, any claim and any upstream request.
- The SQL predicate (`migration:163-171`) is a superset of the live `documents_insert` WITH CHECK. I compared it in `pg_policy`: uid, `is_anonymous`, and `user_type <> 'student'`, plus `caller_seat_read_only()`.
- Proof checks 26a and 28g (refused) and 28j (registered owner allowed). Locally, `rpc/can_import_imslp` returned `true` for the seeded teacher.
- Residual, accepted in the fix report: a registered account whose `createDocument` later fails still leaves a validated shared object. `precheckCreate` runs before pacing, so this is narrow.

### M2. Global listing, bulk download, and the presence oracle: **FIXED**

- **Listing.** Under the caller's RLS:
  - a member's `storage.search('00000000-…/', 'scores')` and `storage.list_objects_with_delimiter` returned only the hash their own document references;
  - a second cached and licensed, but unreferenced, hash was **not** returned;
  - a non-member got 0 rows, and a non-member root search did not even show the reserved folder.

  This was a rolled-back probe on the local stack. Proof checks 17 and 26b cover the same thing.
- **Oracle.** `is_shared_imslp_pdf` has EXECUTE revoked from PUBLIC, anon and authenticated (`migration:102-103`); its live ACL is `{postgres, service_role}`.
  - Local PostgREST `POST /rest/v1/rpc/is_shared_imslp_pdf` as a signed-in user returned `42501 permission denied`.
  - `rpc/can_read_pdf` returned `PGRST202` (not in `public`), and with `Content-Profile: imslp_private` it returned `PGRST106 Invalid schema`.
  - `supabase/config.toml:13` exposes only `public, graphql_public`. I could not verify the hosted project's exposed-schemas setting; see Follow Up.

### M3. A stale client `storage_path` lost the replacement: **FIXED**

- `commit_pdf_replacement` (`migration:197-224`) is SECURITY DEFINER with a pinned `search_path`.
  - It takes the deletion barrier first, then `select … for update` on the real row.
  - It requires owner id, `document_role = 'owner'`, a non-read-only seat, not archived, a matching `content_rev`, and an existing `{id}/original.pdf` object.
  - It derives the path from the id. It is granted to authenticated only (anon and PUBLIC revoked).
- The client always calls it (`src/features/library/documentsService.ts:1052-1058`). `confirmedMeta` now carries `storage_path` (`src/features/viewer/ViewerPage.tsx:77`).
- The `documents_guard_shared_revision` trigger (`migration:236-250`) refuses direct `content_rev` bumps on shared rows by `authenticated`/`anon` (proof 28l).
- Proof checks 25, 28d, 28h (non-owner, viewer and editor refused), 28q2 (missing object, `22023`), and 29-31 (stale revision, then success).
- The UI offers Clean only to owners (`ViewerPage.tsx:958`), so making the RPC owner-only is not a behaviour regression.

### M4. Strict `%%EOF` check, and 502 instead of the fallback: **FIXED**

- `imslpPdfCache.ts:67` now accepts `%%EOF` anywhere in the last 1024 bytes.
- A `SharedPdfValidationError` is mapped to `{ ok: false, code: 'incomplete', openUrl }` (`index.ts:425-439`). The flow returns 409, refunds the credit, and creates no document.
- Tests: `tests/imslp/imslpPdfCache.test.ts` (trailing NUL and junk) and `tests/imslp/imslpImportFlow.test.ts` ("PDF validation fallback").

### L1. Unused `signedUrl`: **FIXED**

`createSignedUrl` and the `signedUrl` merge were removed (`index.ts` around `:509-523`), and the wiring test asserts there is no `createSignedUrl`.

### L2. `prefetchScoreUrl` signed the wrong path: **FIXED, with a side effect (N4)**

`documentsService.ts:983-986` signs only when a real path is passed. However, the only production caller still passes no path (`ViewerPage.tsx:513`), so cold-open prefetch is now off for every document; see N4.

### L3. Concurrent identical-byte race: **FIXED**

`imslpPdfCacheStore.ts:52-69` retries a missing duplicate read once after 150 ms, compares against the hash in the path, and keeps the size check. Deno tests cover it (7 passed in CI).

### L4. Shared originals excluded from the byte quota: **PARTIAL (documented, product sign-off still pending)**

This is now documented in the migration header (`migration:4-5`). Product confirmation was not obtained.

### L5. Loser polling ran into the per-user rate limit: **FIXED**

`downloadQueued(30)` (`index.ts:526`). The trade-off is that a fast winner can still make a loser wait up to 30 s.

### Original Checks 8 (test gaps): **mostly FIXED**

The new proof adds:
- client INSERT of a shared path (26d, 28m);
- editor, viewer and missing-object replacement (28d, 28h, 28q2);
- listing (26b; 17 for a member);
- takedown and revoked-member reads (28e, 28i, 28p, 28q);
- anonymous and student import eligibility (26a, 28g).

## New findings

### High

#### N1. Attacker-steerable negative license writes disable shared-PDF reads for every library, and block imports of uncached files

- **Files:**
  - `supabase/functions/imslp-download/index.ts:354-364` (`parseWorkPageLicenses(page.html).get(canonicalFilename)`, then upsert `downloadable: false` for `cache.entry?.filename ?? canonicalFilename`);
  - `supabase/functions/_shared/imslpPdfCache.ts:7-11` (`imslpFileId` keys the cache by the IMSLP number only);
  - `supabase/migrations/20261028120000_imslp_shared_pdf_cache.sql:114-117` (any alias with `downloadable = false` fails `can_read_pdf`).
- **Evidence:**
  1. `imslpFileId('IMSLP51037-anything.pdf')` and `imslpFileId('IMSLP51037-real_name.pdf')` both return `51037`. The request filename only needs to end in `.pdf` and contain no `/`, `\` or `..` (`index.ts:191-208`).
  2. On a hit, `cachedClearance` reads the license row for `cache.entry.filename`. If that row is stale (older than 30 days) or missing, the import is paced and `liveLicense(cache.entry.work_title)` fetches the **real** work page. It then looks up the **caller's** `canonicalFilename`, which that page does not list, and returns `not_listed`.
  3. The new code then upserts `{ filename: cache.entry.filename, downloadable: false, fetched_at: now() }`.
  4. From that moment `imslp_private.can_read_pdf` is false for that hash, so every library that references it loses the score. Proof check 28o shows exactly this effect for a `downloadable = false` row.
  5. All of this happens in `runImslpImport` step 4, before `enforceQuota`, so the attacker spends no credit. The only limits are the per-user rate (10/min) and global pacing.
  6. Recovery is slow. For the next 30 days the row is "fresh", so every later import of that file is refused `non_pd` with no live re-check. No path restores access to existing libraries until an import after the TTL happens to rewrite a positive row.
- **Repro sketch:**
  - Precondition: a cache entry whose license row has gone stale. Every cached file reaches this 30 days after its last check.
  - As any registered, non-student account, loop `POST /functions/v1/imslp-download {filename: "IMSLP<n>-x.pdf", create: true, documentId: uuid(), acceptedDisclaimer: true}` over popular IMSLP numbers.
  - Each stale hit answers 409 `license_unknown`, and every library holding IMSLP#n can no longer sign or download its score.
- **Second variant, on a miss.** For an uncached file, `request.workTitle` is caller-supplied. Requesting the real filename with a work title whose page does not list it writes a fresh `downloadable = false` row for the real filename. For 30 days:
  - every user's import of that file is refused;
  - `imslp-work` treats the fresh row as cached coverage, so the picker shows the file as not downloadable without re-parsing.

  Before this fix, `not_listed` wrote nothing, so the license table only ever held facts read from a page that lists the file.
- **Benign trigger too.** IMSLP renames files and merges work pages. After the TTL, a legitimate request using the old name, or the work page having moved, also globally blacklists a public-domain file.
- **Fix:**
  - On a hit, look the license up by `cache.entry.filename`, not the request filename. Or refuse a request whose canonical filename differs from `cache.entry.filename`.
  - Do not persist `not_listed` as a negative row at all. Keep the pre-fix behaviour of refusing only this import. If a persisted "removed from IMSLP" signal is wanted, write it to a separate column or table that blocks **new imports only**, and gate existing reads on `blocked_at`, which an operator or moderation sets.
  - Optionally, never let a single live parse flip an existing positive row to negative without a second confirmation.
  - Add a Deno regression: alias filename on a stale hit leaves the license row unchanged and reads still allowed; miss with a mismatched work title writes nothing.

### Medium

#### N2. A missing or purged license row now makes existing shared scores unreadable, and only an import repairs it

- **File:** `migration:109-113`. A downloadable row must exist; proof 28n asserts that a missing row blocks reads.
- **Evidence.** `imslp_file_licenses` is a TTL cache with no other role in access control, and nothing today deletes from it. Any future cache reset or cleanup job, or a manual `truncate` during an IMSLP parser fix, would silently make every IMSLP-imported score unopenable across the platform. Nothing refreshes the row except a new import of the same file after the TTL.
- **Fix:** gate existing reads only on positive evidence of a problem (`blocked_at`, or an explicit negative), not on whether a cache row exists. Or record the clearance used at publish time on `imslp_pdf_cache` itself and use that.

### Low

#### N3. Any `remove` takedown, including `terms` or `illegal` grounds about one uploader, blocks the public-domain bytes for every library

`migration:149` blocks when `action = 'remove' or ground = 'copyright'`. A `terms` removal of one user's document (about that user's title, conduct or annotations) turns off the shared score for every other library. Only a manual SQL update of `blocked_at` restores it; there is no operator RPC and no moderator-facing indicator. It needs a moderator to trigger, so it is operational rather than exploitable. Consider blocking only on `ground in ('copyright', 'illegal')`, plus a service-only `unblock_imslp_pdf`.

#### N4. Cold-open prefetch is now disabled for every document, not just shared ones

`ViewerPage.tsx:513` still calls `prefetchScoreUrl(docId)` with no path, which now always resolves `null` (`documentsService.ts:983-986`). Every cold open, private documents included (the large majority), pays the row fetch and the signing round trip in series again. Pass the library row's `storage_path` when the library list has it, or keep speculative `${id}/original.pdf` signing for rows not known to be shared.

#### N5. The restrictive SELECT guard and the permissive policy evaluate a SECURITY DEFINER function per `scores` row

- The guard short-circuits on `name !~~ '00000000-…/%'`.
- The permissive policy `bucket_id = 'scores' and imslp_private.can_read_pdf(name)` has no prefix test, so a large `scores` listing runs one indexed `imslp_pdf_cache` probe per row.
- This is cheap, but adding `name like '00000000-0000-0000-0000-000000000000/%' and` to the permissive USING clause avoids the call entirely for private objects.

### Verified sound (extra scrutiny items)

- **(a) SECURITY DEFINER hygiene.**
  - Every new definer function has `proconfig = {search_path=public}` (from `pg_proc`), and every relation and function inside is schema-qualified. `pg_temp` cannot shadow them; functions and operators never resolve from `pg_temp`.
  - Live ACLs:
    - `imslp_private.can_read_pdf` is `{postgres, authenticated}`. Anon has no EXECUTE, and the policies are `to authenticated`.
    - `block_taken_down_pdf` and `guard_shared_revision` are `{postgres}` only.
    - `is_shared_imslp_pdf`, `block_imslp_pdf`, `claim`, `release` and `publish` are `{postgres, service_role}`.
  - `imslp_private` schema ACL is `{postgres=UC, authenticated=U}`, with no default ACLs on it. Clients cannot CREATE there (proof 28b), and PostgREST does not expose the schema (`PGRST106`).
  - `can_read_pdf(NULL)` returns false. A NULL `name` makes the restrictive guard evaluate to NULL, which denies.
  - The prefix `like` pattern has no `_` wildcard and the UUID is all digits, so there is no case or wildcard bypass.
  - Other buckets are untouched (`bucket_id <> 'scores'` short-circuits the guard; the permissive policy requires `scores`).
  - The path must equal a `documents.storage_path` exactly, and that column is pinned by the `documents_storage_path_derived` CHECK. Users cannot create or repoint shared paths (proofs 24, 26d, 28m).
- **(b) M1** is enforced server-side, as described under M1 above.
- **(c) M2** listing is confirmed with `storage.search` and `list_objects_with_delimiter` under RLS, as described under M2 above.
- **(d) The proof is real.**
  - It runs as `authenticated` with `request.jwt.claims` (registered, anonymous and student) and as `anon`.
  - It checks denial for non-members, anonymous users and revoked users (26, 26b, 28, 28e, 28i), and allowance for members (13, 28c, 28f).
  - **Mutation test.** I replaced `can_read_pdf` with the original broad "is in cache" check inside the proof's own transaction. **8 checks failed** (26, 26b, 28e, 28i, 28n, 28o, 28p, 28q). So the proof detects a regression back to H1.
  - It passed unmodified locally (**60/60**) and in CI.
  - Gaps: no Edge-level test of the N1 alias or `not_listed` path. Check 17 (orphan) passes with or without the membership gate.

## CI

At `21a4a376afbeb2a2de0003aa911b966910d3fbb4` (GitHub check runs for PR 80):

- **Push run 40872824065: all green.** `checks`, `supabase-local`, `edge-functions-deno`, `omr-service` and `supabase-drift` all succeeded.
- **`pull_request` run 40872833138: `checks` FAILED. Everything else succeeded:** `supabase-local`, `edge-functions-deno`, `omr-service`, `supabase-drift`, Vercel Preview Comments. Supabase Preview was skipped.
  - The one failure: `src/features/library/LibraryShell.test.tsx > LibraryShell > keeps the account menu closed after coming back to the route it was opened on` (`TestingLibraryElementError: Unable to find an element with the text: students page`). The summary was 1 failed | 4186 passed | 22 skipped.
  - The fix diff does not touch that file.
  - It passed in the push run on the same SHA. With base `dev` unchanged (`3fd4fbce`), the merge commit's content is effectively identical.
  - It passed locally for me.
  - That points to a timing flake, but it is still red on the PR's check list. It needs one re-run, or a hardening of that test, before merge.
- **SQL proof in CI.** The `supabase-local` log (run 40872833138) shows `OK tests/sql/imslp_shared_pdf_cache.sql: 60 checks passed`. It also shows the migration re-applying cleanly (NOTICEs only, lines 866-872).
- **Deno in CI.** The `edge-functions-deno` log (run 40872824065) shows `imslpPdfCacheStore_test.ts`: 7 passed, 0 failed.
- The host will append the authoritative `gh pr checks 80` output.

## Follow Up

- **Blocking before SHIP:**
  - fix N1 (look up licenses by `cache.entry.filename`, and stop persisting `not_listed` as a read-blocking negative);
  - get the `pull_request` `checks` job green (re-run, or harden `LibraryShell.test.tsx`).
- **Strongly recommended:** N2. Decouple existing-read access from license-row presence.
- **Hosted config:** confirm the hosted project's Data API "Exposed schemas" does not include `imslp_private`. `config.toml` only governs local. Even if exposed, `can_read_pdf` is caller-scoped, so the impact would be small.
- **Product:** L4 sign-off on shared originals being outside per-user byte quotas.
- **Operations:**
  - add a service-only unblock RPC and a moderator-visible indicator when a takedown blocks a shared hash (N3);
  - GC and a size budget for `imslp_pdf_cache` are still absent (accepted in the fix report).
- **Performance:** N4 (restore cold-open prefetch for private rows) and N5 (prefix test in the permissive policy).
- **Not done here:** I did not run Deno locally (not installed), and I did not exercise the Edge function against IMSLP (no upstream network calls by design). N1 is established from code reading plus the SQL effect proven by check 28o.
