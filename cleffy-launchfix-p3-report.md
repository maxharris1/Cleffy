# Launchfix P3 report: edge hardening

Written by the P3 Claude session, 2026-10-22. The packet asked for this report at `/workspace/cleffy-launchfix-p3-edge-hardening-report.md`. `/workspace` is on Max's machine and not reachable from this session, so the report is committed here, on `claude/launchfix-p3-report`, as the packet allows.

## Status

**Done.** All six scope items are implemented and tested. Draft PR #70 is open into dev, and CI is green on its final head. `npm run cloud:down` has run. Nothing was merged, nothing was pushed to dev or main, and nothing hosted was touched.

## PR, base and head

|               |                                                                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR            | **#70**, https://github.com/maxharris1/Cleffy/pull/70 (draft, `mh/launchfix-p3-edge-hardening` → `dev`, title "launchfix P3: edge hardening", no reviewers requested) |
| Base          | `47e9b38f2dba36fdce852c80948245da344bcc20` (dev at the start). origin/dev was re-checked at the end and had not moved; the PR merges cleanly into it.                 |
| Final PR head | `1c9e8512c115533298983654e949fca21fe0ddb9`                                                                                                                            |
| Report branch | `claude/launchfix-p3-report` = the final PR head plus one commit adding this file                                                                                     |

## Environment

- Ran in the **Cleffy cloud environment** `env_01WAd3yiz3qpSnsofpyEwCh2` (environment kind `anthropic_cloud`), **not Sandbox**. This was confirmed with `get_session` at the start.
- Hard rule 2 (launch with `--branch dev`) was met the way the brief describes: the session started from a fresh `origin/dev` checkout at 47e9b38f, and the branch was cut with `git checkout -B mh/launchfix-p3-edge-hardening origin/dev`.
- The session's harness had named `claude/launchfix-p3-edge-hardening-5ramge` as its working branch. I followed the explicit instruction instead and used only `mh/launchfix-p3-edge-hardening` and `claude/launchfix-p3-report`.
- Every commit is authored by Max Harris <drumaxter@gmail.com>. All pushes were fast-forward; nothing was force-pushed.

## Commits

| SHA       | Summary                                                                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `872009c` | fix(sync): bound live-ink batches, strokes, peers and stroke lifetime                                                                  |
| `5f9423b` | fix(omr): pin Audiveris and tessdata downloads by SHA-256                                                                              |
| `98b630a` | fix(edge): cap every request body as it streams                                                                                        |
| `dcce6f9` | fix(student-claim): reserve the card before any password write                                                                         |
| `e5f6665` | fix(delete-account): mark the deletion pending before anything else                                                                    |
| `3bf77b4` | fix(resend-inbound): lease, dedup, budget and deferral for inbound mail                                                                |
| `7b9fd9d` | test(migrations): register the support-inbound-retry cron job                                                                          |
| `1c9e851` | fix(p3): close the races a review of this branch found (an independent review pass of the branch; details under item 1, 3 and 4 below) |

## What was done, by item

### 1. Inbound mail: budget and dedup (SF-2 / Codex B1)

Migration `20261022110200_support_inbound_lease.sql`.

**State and lease**

- `support_messages` gains a `status` column: `processing`, `forward_deferred` or `completed`. Existing rows become `completed`; new rows default to `processing`.
- It also gains a reclaimable lease (`lease_holder`, `lease_until`), plus `attempts`, `next_attempt_at`, `completed_at`, `forward_resend_id` and `forward_budget_held`.
- New RPCs, service role only: `claim_support_message`, `claim_due_support_messages`, `save_support_message_body` and `finish_support_message`.

**Webhook behaviour**

- Only a **completed** row counts as a duplicate (200).
- A row another delivery holds, or one still backing off, answers 503. A redelivery during the backoff is not counted as an attempt.
- Otherwise the delivery claims the row and resumes it. A body that was already stored is not fetched again.
- If the body cannot be fetched (502) or stored (500), the webhook answers 5xx, so Resend retries. Before, a body-persist error was ignored and a failed fetch answered 200.

**Budget (decision 14)**

- Each forward reserves one unit of `contentReportAck` in every window **before** sending. It uses the same edge rate-limit buckets as content-report acknowledgments (`mail:content-report-ack:{hour,day}`, through the new exported `mailBudgetKey` in `contentReports.ts`).
- The split is unchanged: 60/300, and `contentReportAck` is still 8/35.

**Sending**

- Forwards go through `_shared/resendDelivery.ts` with the Idempotency-Key `support-forward-<Resend email id>`.
- A send with an unknown outcome keeps its reservation, answers 502, and is retried with the same key without reserving again (`forward_budget_held`).
- A Resend 401 or 403 (bad key or unverified domain) is retried, not recorded as refused.
- A 429 refunds the reservation and defers. Any other 4xx refunds and is recorded as refused.

**Budget exhausted**

- The message is stored as `forward_deferred` (200).
- `support_inbound_retry_tick()` uses the content-notice pattern: pg_cron every 5 minutes (`2-59/5`) plus Vault secrets `support_inbound_url` and `support_inbound_secret`.
- When rows are due, the tick POSTs to `resend-inbound` with the header `x-support-retry-secret`. That request is a secret-gated retry run, compared in constant time with `SUPPORT_RETRY_SECRET`.
- Failed attempts back off exponentially, up to 6 hours. After 16 attempts the row is completed with its error. Budget deferrals do not count as attempts.

**Kept unchanged:** the loop guard, the `[privacy]` / `[legal]` / `[support]` subject tags, reply-to the sender, and the `X-Cleffy-Inbound-Id` header.

**Code layout:** the flow moved to `resend-inbound/handler.ts`, which is deps-injected and import-free like `student-login/handler.ts`. `index.ts` is now wiring only.

**Tests**

- `tests/support/resendInbound.test.ts` covers:
    - duplicates, and busy (503) rows;
    - an interrupted first delivery that is resumed: killed mid-send, then taken over after its lease expires, with the same key and one email;
    - an unknown outcome that is retried without re-reserving;
    - body fetch failure and body persist failure;
    - budget exhausted, deferred, then forwarded by the retry run;
    - retry-run authentication;
    - rejected, 401/403 and 429 responses;
    - that the budget uses the same buckets as acknowledgments;
    - the stable idempotency key;
    - the loop guard and tags, store-only mode, no body, bad signature, other event types, a chunked 413, and an unconfigured function.
- SQL proof `tests/sql/support_inbound_lease.sql`.

### 2. Body caps (SF-10)

**The reader.** `_shared/readCappedJson.ts` now provides `readCappedBytes`, `readCappedText`, `readCappedJson` and `readCappedJsonObject`.

- The cap is enforced on the bytes as they stream. Content-Length is never consulted.
- The stream is cancelled at the first byte past the cap.
- Text is decoded exactly as `Request.text()` decodes it.

**Caps applied**

- Control requests: `CONTROL_BODY_MAX_BYTES` = 16 KiB.
- Vision: `analyze-notes` and `analyze-annotations` use their existing explicit 8 MiB `MAX_BODY_BYTES`. Their early Content-Length refusal is kept, but the streamed cap is what enforces.
- Webhooks: `WEBHOOK_BODY_MAX_BYTES` = 256 KiB raw, for `stripe-webhook` and `resend-inbound`. Signatures are verified over exactly the capped text.

**Answers.** Over the cap is 413 `{ error: 'Request body too large', code: 'payload_too_large' }`. A body that is not a JSON object gets 400, so the shape is checked before any field is read.

**Every listed reader is capped:**

- `analyze-notes`, `analyze-annotations`, `student-login/handler.ts`, `student-claim`, `student-provision`, `stripe-webhook`, `resend-inbound`, `score-analyze`;
- `imslp-search`, `imslp-work`, `imslp-download`, `delete-account`;
- `_shared/guestEmail.ts`, `contentReports.ts`, `checkoutFlow.ts`, `cancelFlow.ts`;
- also `_shared/analyzeScaffold.ts`, which was not in the packet's list.

The import-free shared handlers receive the reader through a new `readJson` dep, wired in each `index.ts` and wiring file.

**Deviation:** `content-report` and `content-moderation` are capped at **128 KiB**, not 16 KiB. `REPORT_FIELD_LIMITS` allow about 20,000 characters, which can need several bytes each once UTF-8 encoded and JSON-escaped. A test pins this reasoning.

**Tests**

- `tests/security/bodyCaps.test.ts`:
    - the reader: chunked oversize body, understated and overstated Content-Length, exact cap, JSON shape, decoding parity;
    - webhook signature parity for chunked, multi-byte Stripe and Svix bodies;
    - the 256 KiB and 8 MiB caps;
    - a source guard per Deno entry point;
    - a guard that **no function reads a request body any other way**.
- One chunked-413 test per handler family in its own test file:
    - control: student-login, student-claim, stripe-checkout, billing-cancel, guest-email start and confirm;
    - content report and moderation;
    - webhook: resend-inbound.

### 3. Student-claim race (SF-11)

Migration `20261022110000_student_claim_reservation.sql`.

**The reservation**

- New table `student_claim_reservations`: service role only, row-level security on, every grant revoked.
- Before any password write, `reserve_student_claim(hash)` does the lookup and takes a reservation bound to that `login_code_hash`.
- It returns `reserved`, `busy`, or `not_found`.
- The TTL is 600 s, longer than an Edge Function's 400 s wall clock.

**Commit and conflicts**

- `complete_student_claim` commits only if the row still has that hash, is unarchived and unclaimed, and the reservation still belongs to the caller. It returns `claimed` or `lost`; a 23505 means the username is taken.
- A second claim on the same card gets 409 `claim_in_progress` and never touches the password. This fixes the loser overwriting the winner's password.

**Teacher actions**

- **Reset:** `student-provision` calls `begin_student_code_reset` before it scrambles the password (409 `claim_in_progress` while a claim holds the row). A claim during a reset is `busy`, so claim and reset always serialize.
- **Other code rotation:** any other change to the code under a live claim is refused by trigger (55006).
- **Archive:** archiving **blocks** the claim, because the commit refuses an archived row. The reservation stays until the claim releases it, so a reset of the archived student waits for it.

**Cleanup:** every early exit releases the reservation: captcha failure, password-write error, username taken, wrong account type, or a lost commit. A release only ever removes the caller's own reservation.

**Code layout:** the flow moved to `student-claim/handler.ts` (deps-injected); `index.ts` is now wiring only.

**Tests**

- `tests/security/studentClaim.test.ts` uses pausable fakes:
    - two concurrent claims;
    - takeover of an expired holder;
    - claim against reset, both orders;
    - archive during a claim;
    - release on every failure path;
    -   413.
- `tests/billing/studentClaimCommit.test.ts` and `tests/security/loginThrottle.test.ts` were updated to the new structure.
- SQL proof `tests/sql/student_claim_reservation.sql`.

### 4. Deletion guard (SF-13)

Migration `20261022110100_account_deletion_pending.sql`.

**The marker**

- New table `account_deletions`: service role only, with a foreign key to `auth.users` that cascades on delete.
- `begin_account_deletion` takes a per-account advisory lock exclusively, so it waits for any score or roster insert still in flight. It then writes or counts the marker. It returns 0 and writes nothing for an account that is already gone.

**The refusal**

- `BEFORE INSERT` triggers on `documents` (by `owner_id`) and `managed_students` (by `teacher_id`) take the shared lock and refuse with 55000 `account_deletion_pending` while the marker exists.
- This applies whoever inserts: the owner's own tab, the service role, or `student-provision`.

**`accountDeletion.ts`**

- The marker is written first, before billing. If it cannot be written, the answer is 502 `deletion_unavailable` and nothing is touched.
- The cleanup sweeps until a pass finds nothing. It replaces the two fixed passes, with `MAX_SWEEP_PASSES` = 4 as a logged backstop.
- On failure, `settle_account_deletion` clears or keeps the marker:
    - `abandoned` (billing could not be stopped, nothing deleted) clears it, but only for a lone first attempt with no recorded failure. A retry that deletes nothing, or one tab abandoning while another sweeps, keeps it.
    - `failed` (stopped part-way) keeps it and records the error code.
- Completion removes the marker through the auth user's cascade.

**`student-provision`**

- `create` refuses up front with 409 `account_deletion_pending`, before any auth account is created.
- The trigger's refusal of the insert is mapped to the same 409, after the existing undo of the just-created account.

**Tests**

- `tests/account/accountDeletion.test.ts`:
    - the marker is written first;
    - a score uploaded or a student provisioned mid-delete is refused;
    - the sweep stops at the first empty pass, and at the bound;
    - billing failure clears the marker;
    - a part-way failure keeps it, and a retry finishes;
    - a failed marker write stops the deletion;
    - an abandoned retry keeps an earlier marker.
- `tests/account/deletionPendingWiring.test.ts`.
- SQL proof `tests/sql/account_deletion_pending.sql`.

### 5. OMR Dockerfile pins (Codex C-SF2)

- In `services/omr-service/Dockerfile`, both downloads are checked with `sha256sum -c` against ARG pins before use. `set -eu` is on, so a mismatch fails the build. The tessdata file is downloaded to `/tmp` and moved into place only after its check passes.
    - `AUDIVERIS_DEB_SHA256=3f05c33fe65a5fced51718bdafde9ed989528b882cf3297d4c72b588ef04a656`, for `Audiveris-5.6.1-ubuntu22.04-x86_64.deb`. It is a valid .deb, package `audiveris` version `5.6.1`.
    - `TESSDATA_ENG_SHA256=c0515c9f1e0c79e1069fcc05c2b2f6a6841fb5e1082d695db160333c1154f06d`, for tessdata `3.04.00/eng.traineddata`. The file was downloaded twice with an identical hash; its git blob SHA-1 is `9f4704c9c54910e0953fd9a7e34a1a3f18829664`.
- **Deviation:** `TESSDATA_ENG_URL` now points straight at `raw.githubusercontent.com/tesseract-ocr/tessdata/3.04.00/eng.traineddata`, which is where the old `github.com/.../raw/...` URL redirects. The content is pinned by the hash either way.
- Both mismatch and match were checked with the exact `sha256sum -c` form the Dockerfile uses.
- `tests/security/omrDockerfilePins.test.ts` fails if any `curl` download in the Dockerfile is used before a `sha256sum -c` check.

### 6. Live-ink bounds (Codex C-SF1)

Only `src/sync/wire.ts` and `src/sync/remoteInkBuffers.ts` were changed, plus their test.

**Limits**

| Limit                        | Value                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------- |
| Points per batch             | 2048 (the sender's largest batch is a 1500-point pen-up)                         |
| `strokeId` / `userId` length | 64 characters                                                                    |
| `color` length               | 64 characters (a small extra beyond the packet's list, in the same schema block) |
| Points per stroke            | 10,000 (further points are ignored)                                              |
| In-flight strokes per peer   | 8 (a new one evicts that peer's oldest)                                          |
| In-flight strokes overall    | 64                                                                               |
| Stroke lifetime              | 60 s from its first batch, however busy                                          |
| Remembered retired keys      | 256                                                                              |

**Behaviour**

- Retired and evicted keys are remembered, so a late batch cannot revive a stroke.
- Evicted pages are repainted on the next `expire()` sweep, so `InkController.ts` needed no change.
- Points are appended by index, never by spread.
- Committed annotations are unaffected.

**Tests:** 8 new tests in `src/sync/remoteInkBuffers.test.ts`.

## Local check results (final head 1c9e851)

| Check                                                                         | Result                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint:check`                                                          | pass (exit 0)                                                                                                                                                                     |
| `npm run typecheck`                                                           | pass (exit 0)                                                                                                                                                                     |
| `npm run test`                                                                | pass: **224 files passed, 5 skipped; 3478 tests passed, 13 skipped** (3491)                                                                                                       |
| `npm run build`                                                               | pass (exit 0)                                                                                                                                                                     |
| `npx prettier --check` (every changed .ts/.tsx/.js/.mjs/.json/.md)            | pass. Prettier has no SQL parser, so the .sql files (migrations, proofs) cannot be checked with it.                                                                               |
| `deno check` of the touched function entry points (`--node-modules-dir=none`) | no new errors. All `*/index.ts` were compared at base and at head: the same 7 errors exist in both, all in `score-analyze` and a few other untouched spots (supabase-js typings). |

**Test-run note.** The full suite passes only with the `.env.local` that `cloud:up` generates moved aside. With it present, two **unrelated** tests fail both on this branch and with the file moved back: `src/sync/syncEngine.test.ts` (backoff) and `tests/auth/turnstileField.test.tsx`. That is because they then see local-stack variables. CI has no `.env.local`. Every recorded run was made with the file moved aside, and it was restored afterwards.

## SQL proofs

All on the local stack.

**New proofs (all pass):**

| Proof                                     | Result    |
| ----------------------------------------- | --------- |
| `tests/sql/student_claim_reservation.sql` | **53/53** |
| `tests/sql/account_deletion_pending.sql`  | **36/36** |
| `tests/sql/support_inbound_lease.sql`     | **43/43** |

These are in the `failures | total` format that `scripts/ci/sql-proof.sh` reads, with README entries in `tests/sql/README.md`. They are **not yet run by CI**: `ci.yml` was left to P1, whose `tests/sql/*.sql` glob will pick them up.

**Every existing proof** was also run against the local DB with P3's migrations applied.

- **These pass:**
    - `annotation_payload_shape` 57, `archived_student_password` 13, `billing_export_claims` 35;
    - `cancel_link_consume_db_clock` 36/36, `cancel_link_db_clock` 21/21, `cancel_link_lifetime` 57/57, `cancel_link_read_db_clock` 10/10, `cancel_link_save_after_insert` 12/12, `cancel_link_tombstone_race` 25/25, `cancel_link_tombstones` 38/38;
    - `checkout_consents` 25/25, `column_integrity` 113, `content_moderation` 99/99, `cross_branch_integration` 37;
    - `district_billing_canonical` 12, `district_migrations_rerunnable` 20, `district_retention` 28, `district_seat_cap` 192, `district_seats` 58, `district_student_scope` 47;
    - `edge_rate_limit_refund` 10, `guest_email_verification` 53/53, `launch_checkout_fixes` 46/46, `launch_consent` 43, `qa3_cross_branch` 12, `share_link_errors` 26/26.
- **These three fail. The failures predate P3; they are not caused by it:**
    - `billing_double_charge`: 3 of 98 fail (checks 89, 92, 98: a client can read three tables). This is a grants issue, and CI excludes this proof under decision 20.
    - `district_read_only_seats`: 4 of 68 fail (49, 59, 60, 62: a realtime.messages RLS refusal, and a rotation read).
    - `student_access_revocation`: 2 of 44 fail (22, 24: a 42501 "access withdrawn" refusal where the proof expects a no-row write).

    All three fail identically with P3's three new triggers disabled inside the same rolled-back transaction. The remaining P3 objects are new tables and functions these proofs never reference. The failures look like P1 (grants) and P4 (realtime) territory; they are not in today's CI list, and they will turn red once P1's glob lands unless P1, P4 or dev fixes them.

## CI on the final head 1c9e851

Every check succeeded.

| Workflow run | Event        | Check                   | Job id       | Result                                 |
| ------------ | ------------ | ----------------------- | ------------ | -------------------------------------- |
| 39733202495  | push         | checks                  | 119672770627 | success                                |
| 39733202495  | push         | supabase-local          | 119672770846 | success                                |
| 39733202495  | push         | omr-service             | 119672770942 | success                                |
| 39733202495  | push         | supabase-drift          | 119672770945 | success                                |
| 39733205934  | pull_request | checks                  | 119672781562 | success                                |
| 39733205934  | pull_request | supabase-local          | 119672781351 | success                                |
| 39733205934  | pull_request | omr-service             | 119672781548 | success                                |
| 39733205934  | pull_request | supabase-drift          | 119672781504 | success                                |
| n/a          | (app)        | Vercel Preview Comments | 119673011949 | success                                |
| n/a          | (app)        | Supabase Preview        | 119672768790 | skipped (the integration's own choice) |

`supabase-drift` passes either way. Its log was not inspected, so it may be inert here because `SUPABASE_ACCESS_TOKEN` is unset.

**Earlier heads, also green:**

- dcce6f9: push run 39729923570, PR run 39729945547.
- 7b9fd9d: push run 39731899078, PR run 39731903287.

## Migrations and files touched

**New migrations**, in P3's range, with no existing migration edited:

- `20261022110000_student_claim_reservation.sql`
- `20261022110100_account_deletion_pending.sql`
- `20261022110200_support_inbound_lease.sql`

All three apply twice cleanly. `scripts/apply-migrations.sql` was regenerated with `npm run migrations:mirror`.

**New cron job:** `support-inbound-retry`. It is registered in `tests/migrationRecoverability.test.ts`'s job map, with the reason it is safe to leave running across a push.

**Files (53)**

- Edge functions:
    - `_shared/` accountDeletion, analyzeScaffold, cancelFlow, checkoutFlow, contentReports, contentReportsWiring, guestEmail, guestEmailWiring, readCappedJson;
    - analyze-annotations, analyze-notes, billing-cancel, delete-account, imslp-download, imslp-search, imslp-work;
    - resend-inbound (index, and new handler), score-analyze, stripe-checkout, stripe-webhook;
    - student-claim (index, and new handler), student-login (index, handler), student-provision.
- Front end: `src/sync/wire.ts`, `src/sync/remoteInkBuffers.ts` and its test.
- OMR: `services/omr-service/Dockerfile`.
- New tests:
    - `tests/security/` bodyCaps, chunkedBody (helper), studentClaim, omrDockerfilePins;
    - `tests/support/resendInbound`;
    - `tests/account/deletionPendingWiring`;
    - three SQL proofs.
- Updated tests: guestEmail, cancelFlow, checkoutFlow, contentReports, studentLogin, studentClaimCommit, loginThrottle, accountDeletion, migrationRecoverability, and `tests/sql/README.md`.

**Not touched:** `ci.yml`, P1's migrations, `realtimeChannel.ts`, `session.ts`, `annotationStore.ts`, `InkController.ts`, `DEPLOY.md` and other docs, `supabase/config.toml`, `mailBudget.ts`.

## Deviations, recorded in one place

1. Content report and moderation bodies are capped at 128 KiB, not 16 KiB.
2. The tessdata URL points at `raw.githubusercontent.com` directly.
3. `color` length is also bounded in the live-ink schema.
4. `_shared/analyzeScaffold.ts` is capped too.
5. **Archive blocks rather than clears.** The packet said reset or archive "clears or blocks"; here both block. Reset takes its own reservation, and archive keeps the claim's reservation until the claim lets go. Clearing on archive turned out to let a stale claim's password write land after a later reset's scramble.
6. `contentReports.ts` gains an exported `mailBudgetKey`, so inbound forwards provably share the acknowledgment buckets.
7. `resend-inbound` and `student-claim` were refactored into `handler.ts` and `index.ts` so they can be unit-tested.

## Open questions

1. **Live HTTP checks of the functions were not possible here.** The local edge runtime (`supabase_edge_runtime_cleffy`) cannot download npm packages through this sandbox's TLS-intercepting proxy, so every request answers 503 `BOOT_ERROR`. Appending the proxy CA to the container's trust store did not help, because the roots are cached at runtime start. Coverage is therefore the unit tests against injected deps, the SQL proofs on the real local Postgres, and a `deno check` with no new errors. A two-claim HTTP race script was written but could not run. Should someone run the claim race, a chunked 413 per function, and a duplicate or deferred inbound delivery against `npm run local:up` on a laptop, or against the dev branch project?
    - Side effect of that attempt: it left two throwaway **local-only** auth users (`p3-claim-teacher-*@example.invalid` and its `st-…@students.cleffy.app` student) and one Invited `managed_students` row in the local stack's database. The shared seeded accounts were not touched.
2. **The Audiveris pin was not cross-checked upstream.** This session's proxy blocks the GitHub API and release pages for repos outside `maxharris1/Cleffy`. The tessdata repo publishes no checksums at all. Both pins are `sha256sum` of what was downloaded here. Please run `gh api repos/Audiveris/audiveris/releases/tags/5.6.1 --jq '.assets[] | select(.name=="Audiveris-5.6.1-ubuntu22.04-x86_64.deb") | .digest'` and compare it with `sha256:3f05c33f…a656`.
3. **Inbound forwards share `contentReportAck` (8/hour, 35/day) with legally required report acknowledgments**, as decision 14 says. Every message to support@, privacy@ or legal@ now spends that share. About 35 inbound messages a day, or a flood aimed at support@, would defer the day's report acknowledgments; they wait in their outbox and are not lost. Is that acceptable, or should inbound get its own category? A category of its own means a split change, which the packet ruled out.
4. **Rows from before the migration** in `support_messages` were set to `completed`, including any that never forwarded (`forwarded_at` is null). Does Max want those requeued? If so: `update public.support_messages set status = 'forward_deferred', next_attempt_at = now() where forwarded_at is null and forward_error is distinct from '<loop guard text>';` (run by hand, once the retry secrets exist).
5. **A failed teacher reset holds a reservation for up to 10 minutes.** If `begin_student_code_reset` succeeds and the reset then fails (GoTrue down), the student's still-valid old card answers `claim_in_progress` until the reset is retried or the reservation expires. This affects availability only. Should the UI say so?
6. **An abandoned half-deleted account has no automatic retry.** If a deletion stops part-way and the person never retries, the account stays half-deleted and refuses new scores and roster rows indefinitely. Should a support runbook or a cron sweep pick up stale `account_deletions` rows (`last_error` is not null, `updated_at` is old)?
7. **Three existing SQL proofs fail locally, and the failures predate P3** (see the SQL proofs section). Who owns them once P1's CI glob makes them blocking?

## Hosted steps left for Max

None of these were performed.

1. **Apply the migrations:** `20261022110000_student_claim_reservation.sql`, `20261022110100_account_deletion_pending.sql` and `20261022110200_support_inbound_lease.sql`. On merge, the Supabase GitHub integration applies them to dev, then to production. The third schedules the `support-inbound-retry` cron job, which is inert until step 3.
2. **Set an Edge Function secret `SUPPORT_RETRY_SECRET`**: a long random value, on the dev and production projects.
3. **Create Vault secrets** on each project, following the content-notice pattern in DEPLOY.md:
    - `support_inbound_url` = the project's `/functions/v1/resend-inbound` URL;
    - `support_inbound_secret` = the same value as `SUPPORT_RETRY_SECRET`.

    Without them, deferred forwards resume only when Svix redelivers.

4. **Deploy the Edge Functions** this PR changes. Every function's body read changed, and `resend-inbound`, `student-claim`, `student-provision` and `delete-account` changed behaviour. Deploy the functions only after the migrations are live: the new `student-claim`, `delete-account` and `resend-inbound` call RPCs that only exist once the migrations are applied.
5. **OMR image:** the next build of `services/omr-service` uses the pins (open question 2 first).
6. **Docs (P6):** DEPLOY.md should gain the two new secrets and the cron job, and should say that inbound forwards spend `contentReportAck`. I did not edit docs, since they are out of scope.

## Expected conflicts with the other launchfix PRs

| Packet                                                                                                                             | Expected overlap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** (grants, storage, CI glob)                                                                                                  | `scripts/apply-migrations.sql`: regenerate with `npm run migrations:mirror` after rebasing; never hand-merge. Both sides likely append to `tests/sql/README.md`; keep both. `tests/migrationRecoverability.test.ts` conflicts if P1 also schedules cron jobs; keep both map entries. Once P1's glob lands, P3's three proofs run in CI (all pass locally), and so do the three failing proofs listed above. If P1 changes grants on `support_messages`, `managed_students` or `documents`, re-run P3's proofs. P3's new tables revoke everything from client roles and grant to `service_role`, matching the house pattern. |
| **P2** (`session.ts`, `annotationStore.ts`, `InkController.ts`)                                                                    | None expected: P3 did not touch those files. `remoteInkBuffers.ts` keeps its public API (`apply` / `expire` / `forPage` / `clear` / `removeByStrokeId` / `size`).                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **P4** (`realtimeChannel.ts`, rotation)                                                                                            | `src/sync/wire.ts`: P3 changed only the ink-progress block (lines 11–40). If P4 edits the rotation or membership schemas lower in the file, a textual merge should be clean. The sender limits in `realtimeChannel.ts` (`FLUSH_MAX_POINTS` 150, `PEN_UP_MAX_POINTS` 1500) must stay at or below `INK_LIMITS.maxBatchPoints` (2048).                                                                                                                                                                                                                                                                                         |
| **P5** (district)                                                                                                                  | `supabase/functions/student-provision/index.ts`: P3 changed `readBody`, the start of `createStudent` (deletion-pending check), the two roster-insert error branches, and the code-reset path (`begin_student_code_reset` before the scramble). P5's district provisioning edits in the same file may conflict textually. Also `_shared/accountDeletion.ts`, if P5 touches deletion.                                                                                                                                                                                                                                         |
| **P6** (docs)                                                                                                                      | No file overlap. P6 should document the hosted steps above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Any packet touching `_shared/contentReports.ts`, `guestEmail.ts`, `checkoutFlow.ts`, `cancelFlow.ts` or `student-login/handler.ts` | Every deps interface gained a required `readJson`, and every test deps factory gained `readJson: readCappedJson`. A branch adding a new test factory needs that one line.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Housekeeping

- `npm run cloud:down` has run. It stopped the stack before a worker restart; rerun afterwards, it confirmed that nothing was running.
- The temporary base worktree was removed. The stray `deno.lock` files that `deno check` created were deleted and never committed.
- No `.env` file and no secret was committed or printed.
- Hosted Supabase and Stripe were never touched.
- PR #54 and other sessions' branches were never touched. No other session was messaged.
- A safety-net check-in scheduled by this session (`trig_01RVrkPZyJUa5RozEdRqc9jx`, "P3: check CI and reviewer") was left in place as instructed; Max's side will remove it.
