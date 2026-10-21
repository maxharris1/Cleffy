# LC fix pass round 2: Session B, `mh/launch-legal-pages` (PR #63)

- **PR:** https://github.com/maxharris1/Cleffy/pull/63 (still draft into `dev`, no reviewers requested)
- **Start head:** `650972657cc810013b9f7cbe50df2d1e94b268c6` (the round-1 head Codex reviewed; origin had not moved)
- **New head:** `95c3fd05f80927efb88de354feaac1641dd3bb2b`
- **Environment:** Cleffy cloud environment (`env_01WAd3yiz3qpSnsofpyEwCh2`, named "Cleffy"), not Sandbox. Only the local Supabase stack was used (`npm run cloud:up`). No hosted Supabase, no Stripe, no secrets committed or printed.
- **Commits:** all authored as Max Harris <drumaxter@gmail.com>, pushed fast-forward only to `mh/launch-legal-pages`.

## Findings → commits → tests

| #                                                                                                         | Finding (Codex r2)                                                                                                                                                        | Commit                                                                     | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1                                                                                                        | Takedown realtime: a connected collaborator that ignores the hint kept `doc:{id}` and the owner's live ink (r1 major 1, partly fixed)                                     | `7b37524`                                                                  | `tests/live/takedownRealtime.live.test.ts`; `tests/sql/content_moderation.sql` checks 73–85, 43b, 47; `src/sync/realtimeChannel.test.ts` "takedown topics"; drift guards in `tests/moderation/takedownRealtime.test.ts` and `tests/realtimeTopicsInSync.test.ts`                                                                                                                                                                                                   |
| B2                                                                                                        | Suppressed owner broadcasts let a device skip >50 marks after a lift (r2 new major 1)                                                                                     | `7b37524` (fan-out to the owner keeps flowing), `1989928` (watermark hold) | `src/sync/syncEngine.test.ts` "watermark hold across a gap" (4 tests; all 4 fail with the hold disabled); SQL check 84 (60 marks while restricted all reach `doc-db:{id}:1`); live test (owner's other device receives all 60 committed marks while restricted); viewer wiring guard in `tests/moderation/takedownRealtime.test.ts`                                                                                                                                |
| Cross-PR                                                                                                  | Mail budget: canonical `LAUNCH_MAIL_SPLIT`, byte-identical to #62                                                                                                         | `4e90848`                                                                  | `tests/security/mailBudget.test.ts` (copied from #62, asserts each category and the 60/300 totals); `tests/moderation/contentReports.test.ts` (over-budget cases now derived from the split)                                                                                                                                                                                                                                                                       |
| Cross-PR minor 2                                                                                          | `mailBudget.test.ts` asserting 75/360 after merge                                                                                                                         | `4e90848`                                                                  | The canonical test derives totals from the shared constants, with no hypothetical additions                                                                                                                                                                                                                                                                                                                                                                        |
| Added item (Max): unknown send outcome must keep the budget; stable key; refund only a definite rejection | Kept the reservation on timeout, network error, 5xx, 408, 409 and 429; refunds only on another 4xx or no key; key `content_notice_outbox/{id}`, the same on every attempt | `95c3fd0`                                                                  | `tests/moderation/contentReports.test.ts` "the mail budget across uncertain sends": unknown keeps, a definite rejection refunds in every window, no key refunds, retry with the same key, a refusing window hands back the other's reservation, refund rule pinned to the shared contract. `tests/security/mailDelivery.test.ts`: status classification, the same key on every attempt, network error and timeout as unknown, 5xx vs 4xx, no request without a key |

### B1: how it works

New forward migration `supabase/migrations/20261020150100_takedown_realtime_topics.sql`. The round-1 draft migration is not rewritten again, apart from one comment pointing at the new file.

- A score's realtime topics carry a **generation**: `doc:{id}` / `doc-db:{id}` at generation 0, so nothing changes for a score that has never been taken down, then `doc:{id}:{n}` / `doc-db:{id}:{n}`. The table is `document_realtime_epochs`, with RLS on and no client access.
- `topic_document_role` and `db_topic_document_role` (which the `realtime.messages` policies call) admit a join **only on the current generation**, for a member `document_role()` still answers for. Malformed generations (`:0`, `:01`, `:x`, `:1:1`) resolve to nothing.
- `apply_content_takedown` → `content_takedown_notify_viewers` sends the membership hint on the current topic. It then calls `rotate_document_realtime`, which bumps the generation and sends `topic_rotated` on both old topics.
- Client (`src/sync/realtimeChannel.ts`): asks `realtime_topic_epoch` before joining. On `topic_rotated` it holds live ink immediately, re-reads the generation over PostgREST, and moves both channels. The move counts as a re-join, so it runs a gap-fill pull. A refused join (a stale generation) also triggers a re-read.
- Result: the old `doc:{id}` has nobody talking on it, whatever the adversarial client does. The shut-out member is refused the new topics, and `realtime_topic_epoch` returns null to them. Membership hints from sharing and `end_student_sessions` follow the current generation.
- **Live proof** (real Realtime server, local stack):
    - A collaborator that joined before the takedown and ignores every hint received **zero** live-ink batches after it. It was still subscribed to the old topics.
    - Its join on generation 1 was refused.
    - After the lift it joined generation 1 and heard the owner again.

### B2: how it works

- With rotation, a restricted score's committed changes go to `doc-db:{id}:{n}`, which only the owner can join. **The owner's devices are no longer cut off.** A removed score still sends nothing.
- `SyncEngine` holds the watermark against live rows from start, and again after every `noteGap()`. A live row is applied but does not advance `syncState.watermarkSeq` until a successful pull _that began after the latest gap_ completes. `PdfViewport` calls `noteGap()` before every reconnect and resync pull, and a topic move is a reconnect.
- Per Max, this stays scoped to #63's sync gating. #64's tombstone work should build on `noteGap()` / `watermarkHeld` rather than duplicate them. Expect a textual conflict in `applyServerRow` and `pullOnce` on rebase: keep both the hold check and #64's `...state` / `checkedSeq` spread.

### Added item: send outcome and the mail budget (`95c3fd0`)

Max's added requirement: Codex found this bug in #62, and the same contract applies to `content_notice_outbox`.

- **Before:** the content-notice path never refunded anything. An unknown outcome kept its reservation, so that half was already right. A definite rejection (and the hour unit taken when the day window then refused) was never handed back. The wiring could not tell the two apart: both came back as `'failed'`. The key was `content-notice/{id}`: stable, but not derived from the table.
- **Now:** `_shared/mailDelivery.ts` classifies each send:
    - `sent`: 2xx.
    - `unknown`: timeout (10 s `AbortSignal`), network error, 5xx, 408, 409 or 429. The reservation is **kept**.
    - `rejected`: any other 4xx. The reservation is **refunded**.
    - `unconfigured`: no API key, so no request was made. The reservation is refunded.
- **Idempotency key:** `outboxIdempotencyKey('content_notice_outbox', id)`, which is attempt-independent. A retry after an unknown outcome gets Resend's first answer instead of sending a second mail. Each attempt reserves budget again, so an uncertain send over-counts rather than under-counts.
- **Outbox status:** unknown and rejected both still record `failed`, which keeps the row pending with backoff. The SQL outbox is unchanged.
- **Shared helper:** #62's helper was **not yet on `origin/mh/launch-checkout`** (latest checked: `664ab41`). `mailDelivery.ts` implements the same contract. When #62's file lands, it replaces this one byte for byte, after adjusting the import name in `contentReportsWiring.ts` if theirs differs.
- **Edge-function load check:** the local functions runtime could not boot any function in this sandbox. Its container does not trust the session's TLS proxy CA when it fetches `npm:@supabase/supabase-js`, and every function fails the same way, not only these. Instead, `content-report`, `content-moderation` and `content-notices` were each bundled with esbuild. esbuild fails on an unresolved import or a missing named export, which I confirmed with a deliberate bad import.

## Checks run (on the final head, `95c3fd0`)

| Check                                                                                          | Result                                                                    |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `npm run lint:check`                                                                           | pass                                                                      |
| `npm run typecheck`                                                                            | pass                                                                      |
| `npm run test`                                                                                 | 199 files passed, 1 skipped (the live test, env-gated); 2867 tests passed |
| `npm run build`                                                                                | pass                                                                      |
| `npx prettier --check` (changed files)                                                         | pass                                                                      |
| `git diff --check`                                                                             | clean                                                                     |
| SQL `tests/sql/content_moderation.sql` (local stack, on `1989928`; later commits touch no SQL) | 0 failures / 99                                                           |
| SQL `column_integrity.sql`                                                                     | ALL 113 CHECKS PASSED                                                     |
| SQL `cross_branch_integration.sql`                                                             | ALL 37 CHECKS PASSED                                                      |
| SQL `student_access_revocation.sql`                                                            | ALL 44 CHECKS PASSED                                                      |
| SQL `share_link_errors.sql`                                                                    | 0 failures / 26                                                           |
| Live `tests/live/takedownRealtime.live.test.ts` (local stack, real Realtime)                   | 1 passed                                                                  |
| esbuild bundle of `content-report`, `content-moderation`, `content-notices`                    | pass (see the added item above)                                           |
| ui-check                                                                                       | not applicable: no UI changed                                             |

Notes:

- `npm run test` was run with the cloud session's generated, git-ignored `.env.local` moved aside. With it present, two tests fail on the **unchanged base head too**: `syncEngine` backoff and `turnstileField` "no site key". The cause is local env leaking into the build defines, not this PR. CI has no `.env.local`.
- To run the live test: `CLEFFY_LIVE_SUPABASE_URL=http://127.0.0.1:54421 CLEFFY_LIVE_ANON_KEY=… CLEFFY_LIVE_SERVICE_ROLE_KEY=… npx vitest run tests/live/takedownRealtime.live.test.ts`. It refuses any non-localhost URL, creates throwaway accounts and a score, and deletes them afterwards.

## CI on the new head

See "CI status" at the end.

See the "CI status" section at the end. It is updated after the run completes.

## Mail budget (final, binding: Max)

`supabase/functions/_shared/mailBudget.ts` and `tests/security/mailBudget.test.ts` are **byte-identical** to `origin/mh/launch-checkout` at `bbd71d2`. They were copied, not edited.

| Category            |   Hour |     Day | Branch with the sender                         |
| ------------------- | -----: | ------: | ---------------------------------------------- |
| guestEmailCode      |     28 |     150 | base (all)                                     |
| contentReportAck    |      8 |      35 | #63                                            |
| moderationNotice    |      4 |      20 | #63                                            |
| billingCancelLink   |      8 |      40 | #62                                            |
| billingConfirmation |      7 |      30 | #62                                            |
| retentionNotice     |      5 |      25 | #64                                            |
| **Total**           | **60** | **300** | = budget 100/500 minus the 40/200 auth reserve |

No disagreement on the numbers. Before Max locked the split I sent the other sessions a different proposal by session message. I then withdrew it in a follow-up message and stopped messaging, as instructed.

## Resend call sites on this branch

| Call site                                                                                                   | What it sends                                                                                                                                                     | Through the shared mail budget?                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase/functions/_shared/mailDelivery.ts:71` (`POST /emails`), called from `contentReportsWiring.ts:123` | Report acknowledgments (BCC legal) and moderation notices (statements of reasons, outcomes, lifts), via `content-report`, `content-moderation`, `content-notices` | **Yes.** `deliverNotices` (`_shared/contentReports.ts:653`) reserves the `contentReportAck` / `moderationNotice` budget before every send, keeps it on an unknown outcome, and refunds it only on a definite rejection (`:681`). The key is the outbox row's. When the budget is spent the notice is deferred in the outbox, never dropped. |
| `supabase/functions/_shared/guestEmailWiring.ts:74` (`POST /emails`)                                        | Guest share-link verification code (`guest-email-start`)                                                                                                          | **Yes.** `mailLimit('guestEmailCode', …)` (`guest-email-start/index.ts:28`)                                                                                                                                                                                                                                                                 |
| `supabase/functions/resend-inbound/index.ts:208` (`POST /emails`)                                           | Forwards inbound support mail to the team inbox                                                                                                                   | **No.** Pre-existing on `dev` (not added by #63), and it has no category in the locked split. See open questions.                                                                                                                                                                                                                           |
| `supabase/functions/resend-inbound/index.ts:158` (`GET /emails/receiving/{id}`)                             | Reads an inbound message body                                                                                                                                     | Not a send                                                                                                                                                                                                                                                                                                                                  |

GoTrue's auth mail goes over Resend SMTP. It is covered by the 40/200 reserve, not by a category.

## Skipped Codex minors

- **#63 minors 1–2:** already marked resolved by Codex. Nothing to do.
- **Cross-PR minor 3** (`billingTerms.ts` third legal-version authority): this is #62's file, and C's packet item 4 covers it. Checkout has since pushed `d5c006d` ("read policy versions from the one shared legal-versions source").
- **"Draft migration rewritten, already-applied installs need a forward upgrade":** round 2 adds a new forward migration (`20261020150100`) and does not rewrite again. The only edit to `20261020150000` is a comment. It has never been applied to hosted environments.

## Open questions

1. **`resend-inbound` forward bypasses the budget.** Anyone who emails the support address triggers one forward, so 61/hour is reachable. It predates #63, and the locked split has no category for it. Options: register a `supportForward` category (this needs Max to re-open the split, and the file is owned by #62), or count it against an existing share.
2. **Deploy ordering for `20261020150100`.** Ship it with the frontend that follows `topic_rotated`. A tab on the old bundle stays on generation 0 after a takedown. It receives nothing live (it still converges by pulling) until it reloads. An _owner's_ old tab would keep streaming live ink on the old topic. Noted in the migration header.
3. **Realtime eviction.** Supabase Realtime has no API to kick one subscriber. The fix makes the old topic silent rather than disconnecting it, and the stale channel still closes when that client's token expires. If Max wants a hard disconnect as well, that needs a Realtime-side change.
4. **Guest code mail refunds on an unknown outcome (pre-existing on `dev`).** `_shared/guestEmail.ts:469-471` hands back the guest share's budget whenever a send is not `sent`, which includes a timeout or 5xx that may have delivered. `guestEmailWiring.ts:74` sends no Idempotency-Key. It is base code that every branch shares, and not an outbox row, so it is not changed on #63. The same contract would apply: keep on unknown, and key by the pending-code row. It should be fixed once, in one PR, to avoid three-way conflicts.
5. **Swap in #62's send helper** when it is on `origin/mh/launch-checkout`: copy it byte for byte over `_shared/mailDelivery.ts` (or replace the import if the file name differs). The contract tests in `tests/security/mailDelivery.test.ts` should then be replaced by #62's.
6. **#64 rebase:** `src/sync/syncEngine.ts` `applyServerRow` / `pullOnce` will conflict textually with #64's tombstone floor. Keep both (details under B2).

## Migration mirror

`scripts/apply-migrations.sql` was regenerated on this branch with `npm run migrations:mirror`. `tests/migrationRecoverability.test.ts` needed no change: the generator left it untouched, and its test passes. **Max regenerates `scripts/apply-migrations.sql` and `tests/migrationRecoverability.test.ts` with `npm run migrations:mirror` after each merge.** Never hand-merge either file.

## CI status

Head `95c3fd0`, CI workflow runs 39664303628 and 39664294347 (the push and pull_request runs for the same head), all green on the first attempt:

- **checks** (`npm audit`, `lint:check`, `typecheck`, `test`, `build`): success on both runs
- **supabase-drift**: success on both runs
- **omr-service**: success on both runs
- **Vercel Preview Comments**: success. **Supabase Preview**: skipped (as on earlier heads).

The earlier head `4e90848` was also green, after re-running one `supabase-drift` job per run once: Supabase's Management API returned an HTTP 502, which is unrelated to the diff.
