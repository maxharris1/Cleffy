VERDICT: REVISE

# Cleffy PR #80 adversarial review: shared IMSLP PDF cache

- PR: https://github.com/maxharris1/Cleffy/pull/80 (`mh/imslp-shared-cache` into `dev`)
- Reviewed: `63e7346439882707c99c16ac3ee4bc603aaff451`. `git ls-remote` on 2026-10-29 shows the head has not moved. Base `dev` is `3fd4fbce`. The diff is one commit, 16 files, +1160/-208.
- CI on 63e73464: all 12 check runs are green (`checks`, `supabase-local`, `edge-functions-deno`, `omr-service`, `supabase-drift`, Vercel). The `supabase-local` job log shows `tests/sql/imslp_shared_pdf_cache.sql: 33 checks passed`. The same job re-applies every migration from 20261022100000 on, so it also showed this migration can be re-run.
- Run locally at the PR head: `npx vitest run` on the four touched test files passed (145 tests), and `npm run typecheck` is clean. I did not boot local Supabase because there is no Supabase CLI in this environment and installing one was out of scope. For the SQL I relied on reading it plus the CI pgTAP output above. No hosted Supabase was touched.

The core design is sound. Private uploads, annotations and library rows stay isolated. Clients cannot write, overwrite or delete the shared object. Delete paths never remove it. Publishing is lease-fenced and checks the object's size and mimetype. The blocking problems are about what the shared read path skips: takedown and license enforcement. There are also two abuse and robustness gaps.

## Findings

### Critical

None found.

### High

#### H1. The shared-object read policy bypasses `document_role()`, so takedown, revocation and license changes no longer reach IMSLP-imported PDFs

**Explanation.** Every content-control mechanism in the schema runs through `public.document_role()`:
- content-moderation `restrict` and `remove` takedowns (20261020150000_content_moderation.sql:17-31: "Both are enforced in document_role(), which already gates … the scores and thumbnails storage policies");
- student access revocation (20261010120300);
- the per-document membership model.

The new policy `scores_shared_imslp_read` grants SELECT on any published shared object to every `authenticated` role, anonymous sessions included. Its only test is "is this path in `imslp_pdf_cache`?". It never checks whether the caller can see any document that references the path. Three things follow:

1. A `remove` takedown is meant to make the score unopenable for everyone, its owner included. That no longer holds for the bytes. Anyone holding the path (the owner and former members had it in the row, and it is simply the SHA-256 of the IMSLP file) can still sign or download it.
2. The same bytes stay available to every other library that references them. Future imports of that file id are served from the cache (cache-hit path below), so a copyright takedown against one IMSLP file can't stop Cleffy redistributing it.
3. On a cache hit the license backstop is weaker than before. At `supabase/functions/imslp-download/index.ts:280`, a hit is cleared unless a *fresh* `imslp_file_licenses` row says `downloadable === false`. If the row is stale or missing, the hit is accepted without the live work-page check that a pre-PR import always ran once the 30-day TTL lapsed. If IMSLP later restricts or removes the file (`not_listed`), Cleffy keeps importing it from its own cache. No server path ever refreshes that license row for a cached file, and no table, column or RPC exists to evict or block a cache entry.

**Files:**
- `supabase/migrations/20261028120000_imslp_shared_pdf_cache.sql:79-87` (`is_shared_imslp_pdf` and `scores_shared_imslp_read`)
- `supabase/functions/imslp-download/index.ts:271-299` (cache-hit clearance)
- `supabase/functions/_shared/imslpPdfCacheStore.ts` (no evict or block operation)

**Repro sketch.**
- (a) User A imports IMSLP file F, so the doc row has storage_path `00000000-…/<sha>.pdf`. A moderator applies a `remove` takedown to A's document, so `document_role` returns null. A calls `supabase.storage.from('scores').createSignedUrl('00000000-0000-0000-0000-000000000000/<sha>.pdf', 3600)`. It succeeds via `scores_shared_imslp_read`.
- (b) User B imports F afterwards. `withImslpPdfCache` gets a hit. `cachedClearance` returns `downloadable: true` because the license row for F is more than 30 days old. B gets F with no IMSLP request and no license re-check.

**Suggested fix:**
- Gate shared reads on membership, not cache presence:
  `using (bucket_id = 'scores' and exists (select 1 from public.documents d where d.storage_path = name and public.document_role(d.id) is not null))`.
  Wrap it in a SECURITY DEFINER helper and add an index on `documents(storage_path)` for shared paths. This automatically carries over takedown, revocation, read-only and cleanup semantics. The edge function already signs with the service role on import, so nothing else needs the broad grant.
- Add `blocked_at timestamptz` to `imslp_pdf_cache`, plus a service-role `block_imslp_pdf(file_id)`. Honour it in `is_shared_imslp_pdf`, in the hit path, and in moderation's takedown action when the document's path is shared.
- On a hit whose license row is stale or missing, run the paced live `liveLicense` check, or at least treat it like the pre-PR miss path. Refuse `not_listed` and `!downloadable`.

### Medium

#### M1. Any anonymous session can drive unbounded, permanent writes to the shared cache with no credit spent

**Explanation.** `imslp-download` accepts any Auth user, anonymous sessions included (no `rejectAnonymous`; `_shared/auth.ts:31`). In `runImslpImport` the order is:
1. precheck
2. pace
3. license
4. `enforceQuota`
5. `downloadPdf`, which now calls `cache.store`, uploads and **publishes** the shared original (`index.ts:408-433`)
6. `createDocument`

For an anonymous caller, step 6 fails under the `documents_insert` policy (`is_anonymous` = false required). The flow then refunds the `smart_imports` credit (`imslpImportFlow.ts` `giveBack`). The published object stays, because shared objects are never collected.

So one anonymous sign-in (30 per hour per IP; `config.toml:248`) can loop over IMSLP filenames at the per-user rate (10/min). Many sessions can do it up to the global pacing rate (default 2 per second, `imslpDownloadGate.ts:35-36`). Each file is up to 50 MB and is stored forever, owned by nobody, and outside every storage quota (`storage_object_owner` returns null for the `00000000-…` folder). Before this PR the same requests burned IMSLP pacing but left nothing behind.

**File:** `supabase/functions/imslp-download/index.ts:252-510`, together with `_shared/imslpImportFlow.ts` steps 5-7.

**Repro sketch.** `signInAnonymously()`, then loop `POST /functions/v1/imslp-download {filename: <any downloadable IMSLP pdf>, create: true, documentId: uuid(), acceptedDisclaimer: true, workTitle}`. Each request returns 403 "This account cannot add scores", and `imslp_pdf_cache` and `scores/00000000-…/` grow by one file.

**Suggested fix.** Refuse anonymous callers and any caller who could not insert a document before claiming, pacing or fetching (the same `documents_insert` predicates). Optionally publish to the cache only after `createDocument` succeeds. Optionally add a cache size or count budget with an alert.

#### M2. Every authenticated user can list and bulk-download the whole shared cache

**Explanation.** Because `scores_shared_imslp_read` is broad (see H1), `storage.from('scores').list('00000000-0000-0000-0000-000000000000')` returns every published hash with its size and mimetype. Any anonymous session can then download them all directly. The direct downloads bypass `smart_imports`, the per-user and per-address limits, and the global pacing. Cleffy becomes an open, unmetered mirror paid for in its storage egress, and the listing exposes the platform's aggregate repertoire. `is_shared_imslp_pdf(text)` is also granted to `authenticated`, so it works as a PostgREST RPC oracle for "has anyone on Cleffy imported this file?". No per-user data leaks.

**File:** `supabase/migrations/20261028120000_imslp_shared_pdf_cache.sql:79-87`.

**Repro sketch.** Anonymous sign-in, then `list(...)`, then `download(...)` for each name.

**Suggested fix.** The membership-gated policy from H1 fixes this. Also revoke EXECUTE on `is_shared_imslp_pdf` from `authenticated`; the policies can call a definer helper that isn't exposed as an RPC.

#### M3. Copy-on-write detach depends on the client's copy of `storage_path`, so a stale row silently loses the replacement

**Explanation.** `replaceDocumentPdf` picks between `detach_imslp_pdf` and a plain `content_rev` bump based on `isSharedImslpPath(doc.storage_path)` in the client's row (`src/features/library/documentsService.ts:1058`). Rows synthesized from the offline cache always carry `${id}/original.pdf` (`documentsService.ts:188`). The viewer's confirm path can keep that synthesized row after the server confirms the role: when `loadDocumentSource` throws, it merges only `confirmedMeta` (no `storage_path`) into `held.doc` (`src/features/viewer/ViewerPage.tsx:76-82` and `:672`), and `confirmed` then becomes true, so the owner sees Clean.

In that state the cleaned PDF uploads to `${id}/original.pdf` and `content_rev` is bumped, but the row still points at the shared original. Collaborators then re-download the *uncleaned* shared PDF at the new revision, while the owner's local cache holds the cleaned bytes under the same revision. The two sides diverge, and a private object is charged to quota but never referenced. The shared object itself is never mutated, so this is a correctness problem, not a security one. (`features.smartImport` is off at launch, which limits exposure today.)

**Suggested fix.** Make the server decide. Either use one owner-only RPC, `commit_pdf_replacement(doc_id, content_rev)`, that detaches when the row is shared and otherwise bumps `content_rev`, or add a guard trigger that refuses a client `content_rev` bump on a shared-path row. Also add `storage_path` to `confirmedMeta`.

#### M4. The new `%%EOF` tail check rejects real PDFs and turns them into 502s instead of the open-on-IMSLP fallback

**Explanation.** `validateSharedPdf` requires `%%EOF` followed only by whitespace in the last 1024 bytes (`supabase/functions/_shared/imslpPdfCache.ts:60-66`). Readers, pdf.js included, accept trailing junk after `%%EOF`, such as NUL padding or appended bytes from some scanners and upload tools. Before this PR those files imported fine. Now `downloadPdf` throws (`index.ts:415`), which `runImslpImport` catches and returns as **502** "IMSLP did not deliver a complete PDF". That answer is logged as a server failure, and the client gets no 409 `openUrl` fallback. The size and Content-Length checks already cover truncation.

**Suggested fix.**
- Look for `%%EOF` anywhere in the last 1024 bytes and allow trailing bytes, matching reader behaviour.
- Return validation failures as `{ ok: false, code: 'not_pdf' | 'incomplete', openUrl }`, so the user still gets the open-on-IMSLP path and the failure isn't counted as a 5xx.
- Add a unit test with a trailing-NUL PDF.

### Low

#### L1. `signedUrl` is minted on every import, is required for success, and is never used

At `imslp-download/index.ts:489-497`, a failed `createSignedUrl` fails the import (and refunds), although the client (`src/features/imslp/imslpApi.ts:505-525`) ignores `signedUrl`. The result is an extra failure mode, plus a one-hour bearer URL in the response. Either drop it, or make it best-effort and consume it in the client.

#### L2. `prefetchScoreUrl` always signs `${id}/original.pdf`

For shared-backed documents, `src/features/library/documentsService.ts` (`prefetchScoreUrl`) wastes one failing Storage request on every cold open, plus the latency of falling back. Skip the prefetch, or prefetch from the library row's `storage_path`.

#### L3. Concurrent misses for two different file ids with identical bytes

If the second upload lands before the first upload's object is committed, the duplicate-verify branch's `download` fails (`_shared/imslpPdfCacheStore.ts:30-49`). That surfaces as a 502 for one user. The same branch also buffers up to two more 50 MB copies in the worker. This is rare. Retrying once or queueing (`busy`) on a not-found would be enough.

#### L4. Shared imports no longer count toward the importer's storage quota

`storage_object_owner` returns null for the reserved folder, so `my_storage_usage` and the quota triggers ignore these PDFs, which a pre-PR import did charge. This is probably intended because the bytes are shared, but it is an unannounced change to plan limits. Confirm with product and document it in the migration header.

#### L5. Loser polling vs. the per-user rate limit

Losers get `downloadQueued(2)` and poll every 2 s, and each poll counts against the 10/min per-user limit (`index.ts:510`, `:140-152`). A cold miss that takes 60-90 s will push a waiting user into `caller_rate_limited`. Use a `retryAfterSec` of about the remaining lease or expected download time, or exempt the queued answer from the per-user counter.

## Checks

1. **RLS and storage policies:** PARTIAL. There are no cross-user leaks of private uploads, annotations or library rows (pgTAP checks 14-16 and 27 are real, running as `authenticated` with `request.jwt.claims`). Clients cannot insert, update, delete or upsert under the reserved prefix (existing name and owner policies plus the new restrictive ones; checks 21-23). The cache and claim tables and the claim/publish/release RPCs are service-only (checks 18-20). Clients cannot insert or repoint a document to a shared path (the restrictive insert policy and `documents_guard_columns`; check 24). Hash poisoning is blocked: the path is derived from a server-computed SHA-256, the CHECK pins the path to the hash, `upsert: false`, and an existing object is reused only after byte-hash verification. The read policy is too broad, though (H1, M2).
2. **Delete paths:** PASS. Nothing ever deletes shared objects. The client purge now filters to `${docId}/` (`documentsService.ts:510-519`). `delete-account` removes by document folder (`accountDeletion.ts:506-515`). The district hard delete only cascades rows (`20261021120700_district_retention.sql:411-436`). Old clients' `remove([sharedPath])` is denied by RLS. There are no reference counts, so there are no double-decrement races, and orphan cleanup is "never": a bounded leak, but see M1.
3. **Replacement flow:** PASS with M3. The private copy goes to `${id}/original.pdf` and the backup to `pre-import-original.pdf`. `detach_imslp_pdf` is owner-only, fenced on `content_rev`, and checks the deletion barrier and seat. The shared object is never mutated, and old clients that write to the shared path are refused by RLS. The choice to detach still belongs to the client (M3).
4. **Concurrent misses and integrity:** PASS with M4 and L3. A unique-row lease (4 min, longer than the 90 s download budget) and a re-read after claim mean losers queue without downloading again. Publishing is fenced on the token and requires the Storage object's size and `application/pdf` mimetype. Failed or partial downloads never publish (unit tests cover fetch, invalid, upload, publish and read failures). The SHA-256 is computed before publishing, and size is capped at 50 MB. A Content-Length mismatch check was added for unencoded bodies. The EOF check is too strict (M4).
5. **Migration safety:** PASS. Existing `{id}/original.pdf` rows still satisfy the widened CHECK, so no backfill is needed (existing duplicate copies simply stay). The migration is re-runnable (`if not exists`, `drop … if exists`, `create or replace`; CI re-applies it). There is no down migration. Once any shared reference exists, restoring the old CHECK needs a copy-and-repoint script. The two `add constraint` CHECKs take a validating scan under an exclusive lock on `documents`, which is fine at current size; `NOT VALID` plus `VALIDATE` would avoid it.
6. **Edge-function auth and service role:** PARTIAL. The JWT is verified with the Auth server (`requireUser`). The service role is used only for cache read/claim/publish, the shared upload and the signed URL, and none of those take a user-supplied path: the path is `prefix + sha256(bytes)` and the file id is parsed from the canonicalized filename. The filename is validated (length ≤ 512, `.pdf`, no `/`, `\`, `..`). Download URLs come from the existing IMSLP host allowlist (`imslpDownload.ts`), and no new SSRF surface was found. Anonymous sessions can trigger cache writes (M1).
7. **Quotas and import counting:** PASS with caveats. Cache hits still go through precheck, `enforceQuota` (`smart_imports`) and the score-cap trigger on `createDocument`, so hits count as imports and failures refund. Hits skip pacing and live IMSLP calls, as intended. Two ways around metering: direct shared-object downloads (M2), and refunded anonymous imports that still warm the cache (M1). Storage quota no longer applies to these PDFs (L4).
8. **Test coverage:** PARTIAL. The pgTAP proof is real: 33/33 in CI, run as `authenticated` and anonymous roles with JWT claims, with cross-user negative cases for read, write, delete and detach, and lease fencing. Missing:
   - client INSERT of a document with a shared `storage_path` (the new restrictive policy isn't exercised);
   - an editor or viewer calling `detach`, and detach when the replacement object is missing (`22023`);
   - storage `list` of the reserved prefix;
   - takedown and revoked-member reads of the shared path (would fail today, H1);
   - an anonymous caller hitting the import path.

   Checks 21 and 33 pass without the new restrictive policies (permissive policies already deny, and nothing deletes from SQL), so they don't prove those policies. The unit tests use in-memory fakes. The real `imslpPdfCacheStore` (duplicate-verify branch) and the `imslp-download` wiring (hit-path license logic, pacing skip, storage_path switch in `recordProvenance`) have no tests. No test covers a stale license row on a hit, or a PDF with trailing bytes.

## Follow Up

Non-blocking, or not introduced here:
- **Pre-existing:** `imslp-download` has always accepted anonymous Auth sessions and let them burn global IMSLP pacing before `createDocument` refuses them. M1 is that gap made persistent. Fix the early refusal regardless of this PR.
- **Garbage collection:** no GC or size budget for `imslp_pdf_cache`. Consider a periodic service job that removes entries no live document or tombstone references after N days, run under the claim lease to avoid racing a new import.
- **Dedupe existing copies:** an optional backfill could hash existing IMSLP-provenance `{id}/original.pdf` objects and repoint them. Not required.
- **Provenance freshness:** provenance is now fixed at first fetch (`imslp_pdf_cache.provenance`). If IMSLP corrects credits, later importers inherit the old ones. That is acceptable, but a refresh would come for free with the H1 license re-check on stale hits.
- **No `NOT VALID` on the CHECKs:** the two new `documents` CHECK constraints validate in place (see Checks 5).
- **`scripts/apply-migrations.sql`:** the bundle is updated consistently, and `supabase-drift` is green.
