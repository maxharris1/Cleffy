# LC fix pass round 3: #62 `mh/launch-checkout`

- **PR:** https://github.com/maxharris1/Cleffy/pull/62 (still a draft, into `dev`; no reviewers requested)
- **Start head:** `664ab41ceca3d9e5a6644e284a46ff94dcf33437`, confirmed before any change.
- **New head:** `d9b83e20e37dc041040a9048d5ae895dbe4cb1d8` (3 commits, fast-forward pushes only, no force pushes)
- **Environment:** Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (kind `anthropic_cloud`), confirmed with `get_session` at the start. Not Sandbox.
- **Commit identity:** every commit is authored as `Max Harris <drumaxter@gmail.com>`.
- **Branches pushed:** only `mh/launch-checkout` and this report branch, `claude/lc-fix3-report-launch-checkout`. This session's default branch (`claude/billing-outbox-idempotency-n66tyr`) was not used, per the packet. No other session was messaged.

## The shared helper (for #63 and #64 to copy byte for byte)

**Path:** `supabase/functions/_shared/resendDelivery.ts`
**Tests:** `tests/security/resendDelivery.test.ts`
**Commit:** `c209c3577ecf2c83867c739f88b8ea61cc4371ed`. It was pushed as its own commit before it was wired in. Blobs at the new head: `resendDelivery.ts` `6993439d0e191c28a8bfecb13769ca55220419e4`, `resendDelivery.test.ts` `ba320209407fbc4892dc67d255381f3e25217bfa`. Neither has changed since `c209c357`.

The file has no imports and no Deno globals; the caller passes in the API key and `fetch`. Vitest therefore loads the same file Deno runs, and the file can be copied unchanged. The test file is self-contained too: it includes its own fake Resend and imports nothing but the helper.

It provides:

- **`resendIdempotencyKey(outbox, rowId)`** builds `<outbox>-<row id>`, e.g. `billing-outbox-<uuid>`.
  - It is the same on every retry of a row and different for every other row or outbox.
  - Both parts are limited to `[A-Za-z0-9_-]`, and the outbox name must be lower-case words joined by `-`. An `@`, `.` or space throws, so an address can never end up in a key.
  - It throws above Resend's 256-character limit.
- **`sendViaResend({ apiKey, idempotencyKey, email, fetch?, timeoutMs?, url? })`** POSTs to `https://api.resend.com/emails` with the `Idempotency-Key` header and a 10 s timeout. It never throws. It returns `{ outcome, reason, status, id?, errorName?, retryAfterMs?, detail? }`, where `outcome` is exactly one of the three below.
- **`classifyResendStatus(status)`** is the status table on its own.

### The three outcomes

| outcome | when | outbox action |
|---|---|---|
| `sent` | 2xx whose body has a string `id` | keep the reservation |
| `rejected` | 4xx other than 408/409 (400, 401, 403, 404, 405, 413, 422 and **429**); or a failure before any request: no API key (`reason: 'unconfigured'`), an empty, over-256 or non-ASCII key, no recipient, no sender, or a payload that can't be serialised | refund the reservation, then retry or fail as before |
| `unknown` | `fetch` threw after the request was attempted (network or connection reset → `network`; abort or our timeout → `timeout`); any 5xx; 408; **409**; 3xx/1xx; a 2xx with no `id`, non-JSON, or a body cut off mid-read (`unparseable_response`) | **keep** the reservation and retry with the **same** key |

Anything that isn't certain is classified `unknown`, so nothing is refunded on doubt.

### Decisions (documented in the module comment)

- **429 → `rejected`.** Resend rate-limits before it accepts anything, so this attempt sent nothing and its own reservation is handed back. `retryAfterMs` carries `Retry-After`, and the billing outbox waits `max(60 s, Retry-After)`. A 429 says nothing about an earlier attempt with the same key, and that attempt's kept reservation is not touched.
- **409 → `unknown`.** Resend uses 409 for `concurrent_idempotent_requests` (the first request with this key is still in flight and may yet send) and for `invalid_idempotent_request` (same key, different payload). Both mean an earlier request with this key reached Resend and may have sent. Senders keep a row's payload byte-identical across retries so the second case doesn't arise; see the cancel-link token below.
- **408 → `unknown`.** A proxy in front of Resend can answer 408 after Resend had the request.
- **Resend's behaviour was checked against its docs** (resend.com/docs/dashboard/emails/idempotency-keys, read in this session). Keys are 1–256 characters and kept for 24 h. A replay with the same key and payload returns the first answer without sending. A different payload gets 409 `invalid_idempotent_request`; an in-flight duplicate gets 409 `concurrent_idempotent_requests`; a malformed key gets 400 `invalid_idempotency_key`.

## Findings → commits → tests

### 1. Round-3 new major: ambiguous Resend failures refunded the budget, and retries could send duplicates

Codex's finding was that `billingOutbox.ts:205-208` refunded on every non-sent result, `billingMail.ts:33` sent no key, and `billingMail.ts:52` turned doubt into `failed`.

- **`c209c357`: the shared helper**, above.
  - Tests in `tests/security/resendDelivery.test.ts`: 30 tests. They cover key stability, distinctness, PII refusal and the 256 limit; that the header is sent; each status and error class mapped; an abort and our own timeout; failures before fetch that never call `fetch`; never throwing; and an accepted-then-connection-reset email whose retry Resend answers without a second email.
- **`2ab467bf`: wired into every Resend sender on this branch.**
  - `billingMail.ts sendBillingEmail` now uses `sendViaResend`, so there is no raw `fetch` left in billing code.
  - **`billingOutbox.ts sendWithinBudget`** (purchase and cancellation confirmations):
    - `rejected`: refunds the hour and day reservations, then `retry`, honouring `Retry-After` on a 429.
    - `unknown`: keeps both reservations and answers `retry` with `uncertain: true`.
    - Key: `billing-outbox-<row id>`, built by `deps.idempotencyKey`, which is `resendIdempotencyKey` passed in so this module keeps no runtime imports.
  - **`cancelFlow.ts deliverCancelLink`** (`billingCancelLink`): same rules, same `billing-outbox-<row id>` key.
    - **Stable payload.** The link's token used to be random on every attempt, which would make a retry's body differ and draw a 409 forever. It is now `HMAC-SHA256(cancel secret, "billing-cancel-link:<row id>")`, base64url, 256 bits (`billingCancelStore.ts cancelLinkToken`). A retry's email is therefore byte-identical, and a link that did go out is the link that works.
    - **`saveToken` is now an upsert** on `token_hash`. It refreshes the expiry and doesn't write `used_at`, so a spent link stays spent. This was checked against local Postgres and PostgREST (below).
    - **Per-recipient count.** On `unknown` only the per-recipient count is handed back. The mail budget stays spent. The row's own retry recounts the recipient, and the same key and link mean the row can only ever be one email. If the count were kept, three lost answers would use up the address's hour and drop the row as `recipient_limited` before its link ever went out.
  - **billing-cancel's refund request to support** goes through Resend via `sendBillingEmailWithinBudget`, now `billingOutbox.ts sendRequestMailWithinBudget`.
    - Key: `billing-refund-request-<token hash>`, one per spent link, never the address.
    - `unknown` keeps the reservation. The buyer is still told to write in (`refundRequestFailed: true`): a second note to support is harmless, while a lost 14-day refund request is not. There is no automatic retry because the token is consumed.
  - **`billing-cancel/index.ts`** passes `idempotencyKey: resendIdempotencyKey`. `deno check` caught this one missing before the push.
  - Tests:
    - `tests/billing/billingOutbox.test.ts`, new describe block "a confirmation Resend accepted but whose answer was lost". The full path (drain → deliverer → budget → real `sendViaResend` → fake Resend with Resend's idempotency rules) covers:
      - accepted then connection reset: the reservation is kept, the retry reuses `billing-outbox-<id>`, and there is exactly one email;
      - 5xx kept and retried under the same key, stable per row and distinct between rows;
      - a definite 422 refunded, then the retry counted once.
    - Unit tests in the same file:
      - "hands back what it counted when Resend certainly sent nothing" replaces the old `:342` test, which assumed every `failed` deserved a refund;
      - "KEEPS what it counted when Resend may have sent it" (network, timeout, 500, 503, 409, unparseable);
      - "waits as long as a 429 asks";
      - "sends each confirmation under its outbox row's Idempotency-Key";
      - the refund-request mapping;
      - wiring assertions on `billingMailWorker.ts`, `billingMail.ts` and `billing-cancel/index.ts`.
    - `tests/billing/cancelFlow.test.ts`, describe block "a link Resend may have sent":
      - the budget is kept and only the recipient count handed back;
      - accepted then dropped: the retry is byte-identical under the same key, one email, and the mailed link works;
      - several lost answers don't drop the row;
      - different requests get different links and keys;
      - the refund request is keyed by the link hash;
      - an unknown refund request still tells the buyer to write in.
    - Shared fake: `tests/billing/fakeResend.ts`.

**Fails without the fix.** With the new tests in place and the five billing sources reverted to `664ab41c`, 35 tests in `billingOutbox.test.ts` and `cancelFlow.test.ts` fail, including every new regression. All pass with the fix. The helper's tests can't run on `664ab41c` because the module doesn't exist there.

**Counting decision: each attempt reserves its own place**, including a retry after `unknown`.

- **Trade-off.** One email can be counted twice in the 60/300; a real send is never counted zero times.
- **Why I chose it.**
  - The budget uses fixed hour and day windows (`check_edge_rate_limit`). A retry whose first attempt never reached Resend sends now, in the current window, and only a reservation made now keeps that window under its ceiling.
  - Skipping the reservation on a retry would need a per-row record of which window the earlier hold sits in. There's nowhere to keep one without a migration, and the packet said this fix shouldn't need one.
- **Cost.** During a Resend 5xx outage, retries spend the hourly share faster. Mail is delayed, never lost and never over the ceiling.
- This is pinned in a test: "this one email is counted twice, never zero times". See open question 1.

### 2. Added by Cleffy during this pass: `guestEmail.ts` onto the shared helper

**Commit:** `d9b83e20e37dc041040a9048d5ae895dbe4cb1d8`

- **Key.** `guestEmailWiring.ts sendEmail` now uses `sendViaResend`. `guestEmail.ts handleGuestEmailStart` passes a key per code send: `guest-email-code-<guestEmailSendId>`, the first 40 hex characters of `HMAC(secret, "guest-email-send\0<userId>\0<stored code hash>")`.
  - It is the same for every attempt at this code and different for any other code or guest.
  - It contains no address, no code, and not the stored hash.
- **`sent`:** 200 as before.
- **`rejected`:** refunds all four reservations (mailbox hour/day, `guest-email-start:global`/`global-day`) and deletes the pending code, as before. The answer is 502, or 503 when the key is unconfigured.
- **`unknown`:** keeps all four reservations, keeps the pending code redeemable in case the email arrives, and logs. It still answers the existing `502 send_failed`, so there is no client or UI change. Asking again mails a **new** code under a new key, which replaces this one and is counted anew. That second email is a different message, not a retry of the first.
- `guest-email-start/index.ts` passes `idempotencyKey: resendIdempotencyKey`.
- Tests in `tests/auth/guestEmail.test.ts`, describe block "a send Resend may have taken":
  - unknown → no refund, no delete, 502 (**fails on the old code**);
  - definite rejection → all four refunded and the code deleted;
  - accepted then connection reset through the real helper and fake Resend → the reservations stay spent, and the key is the expected `guest-email-code-…` with no address or code in it (**fails on the old code**);
  - key stability: same code → same key, a different code or guest → a different key, never the stored hash (**fails on the old code**);
  - wiring: `guestEmailWiring.ts` uses `sendViaResend` with no raw `fetch`, and `guest-email-start` passes the key (**fails on the old code**).
  - The existing tests were adapted to the new result shape: `failed` → `rejected/http_422`, `unconfigured` → `rejected/unconfigured`.
  - With the new tests and the old guest sources, 9 tests fail; all 36 pass with the fix.
- **Cross-PR:** as of this push, none of #63 (`4e90848`), #61 (`85cf571`) or #64 (`2208740`) touches `guestEmail.ts`, `guestEmailWiring.ts`, `guest-email-start` or `tests/auth/guestEmail.test.ts`, and none has a `resendDelivery.ts` yet. So nothing conflicts here, and this PR is the one place that fixes guestEmail.

## mailBudget byte identity

`git diff 664ab41ceca3d9e5a6644e284a46ff94dcf33437 -- supabase/functions/_shared/mailBudget.ts tests/security/mailBudget.test.ts` is **empty** (0 bytes) at the new head. `git hash-object supabase/functions/_shared/mailBudget.ts` = `beb4df8ac36f6625601d732ebb1d630d5702e551` (expected `beb4df8ac36f`). `LAUNCH_MAIL_SPLIT` and the 60/300 totals are unchanged. No migration changed, so `scripts/apply-migrations.sql` and `tests/migrationRecoverability.test.ts` are untouched.

## Tests run (in the cloud session)

| Check | Result |
|---|---|
| `npm run lint:check` | ✅ clean (after each of the 3 commits) |
| `npm run typecheck` | ✅ clean (after each commit) |
| `npm run test` | ✅ final: **198 files / 2900 tests**. After commits 1 and 2: 2883, then 2895, all passing |
| `npm run build` | ✅ (after each commit) |
| prettier on changed files | ✅ |
| `deno check` (Deno 2.9.6, in a scratch copy with `nodeModulesDir: auto`) on `billing-mail-outbox`, `billing-cancel`, `stripe-webhook`, `stripe-checkout`, `guest-email-start`, `guest-email-confirm`, `_shared/resendDelivery.ts` | ✅. It first caught a missing `idempotencyKey` in `billing-cancel/index.ts`, fixed before the push. CI doesn't run `deno check`; `tsc` doesn't cover the Deno-only wiring files. |
| `cancelLinkToken` under Deno | ✅ 43-character base64url, deterministic per (secret, row), different across rows and secrets |
| Local stack (`npm run cloud:up`, then `cloud:down`) SQL proofs | ✅ `tests/sql/launch_checkout_fixes.sql` **46/46**, `checkout_consents.sql` **24/24**, `edge_rate_limit_refund.sql` **10/10** |
| | ⚠️ `billing_double_charge.sql` 95/98. Open question 3. |
| `saveToken` upsert against local PostgREST (service role, seeded teacher) | ✅ First insert ok. A retry upsert refreshes `expires_at` and keeps `used_at` null. After `used_at` is set, a further upsert keeps it set. The temporary row was deleted afterwards; no seeded data was touched. |

**Environment note.** `cloud:up` writes a gitignored `.env.local`. With it present, two unrelated suites fail locally: `src/sync/syncEngine.test.ts` (backoff timing) and `tests/auth/turnstileField.test.tsx` (no-site-key case). Moved aside, all 2900 pass. CI has no such file.

Not exercised: real Resend or Stripe. There are no keys in cloud sessions, and hosted Supabase and live Stripe were not touched.

## CI on the new head

**Green on `d9b83e20`**, read via the GitHub API at about 20:15 UTC on 2026-10-21:

| Check | Result |
|---|---|
| `checks` (both workflow runs: lint, typecheck, test, build) | ✅ success |
| `supabase-drift` (both runs) | ✅ success |
| `omr-service` (both runs) | ✅ success |
| Vercel and Vercel Preview Comments | ✅ success (preview Ready) |
| Supabase Preview | skipped, as on every earlier head |

The intermediate head `2ab467bf` was also fully green. No review comments arrived during this pass. The PR is still a draft, with `mergeable_state` reported as `unstable` only while checks were running.

## Skipped minors

None. Codex reported no new minors for #62.

## Open questions

1. **Re-reserving on retry after `unknown`.** I chose "every attempt reserves its own place", which can double-count but never under-count, for the reasons above. If you'd rather never double-count, it needs a per-row "held in window W" marker, meaning a migration or a rate-limit-key trick. I didn't do that without a decision.
2. **Cancel-link secret rotation.** The link token is now `HMAC(BILLING_CANCEL_SECRET or service-role key, row id)`.
   - Rotating that secret while a cancel-link row is still mid-retry changes the email body. Resend then answers 409 (`unknown`) for that key until it expires after 24 h, and then sends.
   - This is rare: a row is normally sent within minutes and then deleted.
   - Rotation already voids in-flight per-recipient keys.
3. **`tests/sql/billing_double_charge.sql` fails 3/98 on the local stack:** "or read the attempts table", "or read the write locks table", "nor read the refund ledger".
   - These tables (`checkout_attempts`, `subscription_writes`, `duplicate_refunds`) come from **dev** migrations `20261012120103`, `20261012120105` and `20261013120102`. Each grants `service_role` but never revokes the local stack's default `anon`/`authenticated` table grants.
   - Nothing on this branch touches those grants, and the SQL file is identical to dev's. So it predates this PR, and RLS still hides the rows.
   - Worth a separate `revoke all … from anon, authenticated` follow-up on dev, and a check of the hosted grants.
4. **Other Resend senders on `dev`, out of scope here:** `resend-inbound` forwarding is the known post-launch follow-up. #63 and #64 can now copy `resendDelivery.ts` for their own senders (#64's `districtNotice.ts` already reserves before sending, with its own key).
5. **Merge note.** `tests/billing/fakeResend.ts` is new here. If #63 or #64 copy the helper's test file, it is self-contained and doesn't need `fakeResend.ts`.

## Not done / not touched

- No merges.
- Nothing pushed to `main` or `dev`, or to #61, #63 or #64.
- PR #54 not touched.
- Hosted Supabase and live Stripe not touched.
- No `.env` files or secrets committed, and no keys printed.
- `playwright install` not run.
- No UI changes.
- No migrations.
- No other session messaged.
