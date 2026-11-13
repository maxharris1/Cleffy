# Share v2, PR 1: backend and realtime auth (plan)

Ticket #104 · PR #107 · branch `factory/issue-104` off `dev` · risk high · builder claude-bot.

This plan covers the backend and Realtime auth half of Share v2. The UI ("Share v2: UI and flows") and the privacy/legal docs come in later issues. Everything here stays inert while `VITE_FEATURE_SHARE_V2` and `SHARE_V2_ENABLED` are unset, and both are off by default.

## 1. Where the code is today

These facts come from reading `dev` at `25aaefc0`. They constrain the design. Paths are relative to `supabase/migrations/` unless they start with another folder.

- **Share links**
    - `share_links` is keyed by `token` (22-char base64url), with `role` (`editor`|`viewer`), `expires_at` (null means never) and `revoked_at` (`20260801160752_schema.sql:26-40`).
    - Owners insert links directly from `src/features/share/shareService.ts:56-71`. The client computes expiry (`7d`, `30d` or `never`). There is no create RPC.
    - The `share_links_guard_columns` trigger (`20261007120100:235-273`) makes the token and creator immutable for clients.
- **Link-sourced members** don't have a column on `document_members`. They live in side tables:
    - `share_link_redemptions(document_id, user_id, token)`, with the token referencing `share_links` on delete cascade;
    - `document_member_role_locks` (`20261007120000:51-93`).
    - `revoke_share_link(p_token, p_remove_members)` already withdraws link-sourced members, and resets roster students to their assignment role (`20261007120000:469-546`).
- **`peek_share_link`** returns `(valid, role)` and is granted to anon (`20261009120200:120-136`).
    - **`redeem_share_link`** raises PT404 with detail `{"code":"invalid_share_link"}` (`20261022120200:71-151`).
    - The client matches on that code (`shareService.ts:180-189`).
- **Realtime generations**
    - `document_realtime_epochs` holds the generation. `realtime_topic_document(topic, prefix)` returns the document only at the current generation.
    - `rotate_document_realtime` sends `topic_rotated` on the old `doc:` and `doc-db:` topics.
    - Rotations are queued with `queue_document_realtime_rotation(doc)` into a per-transaction table. A deferred constraint trigger drains it at commit, so each score rotates **at most once per commit** (`20261022120000:54-119`).
    - Deleting a member and an editor→viewer downgrade already queue a rotation.
    - Every `realtime.messages` policy is `to authenticated` today.
- **Age gate**
    - `age_gate_problem(jsonb)` needs a two-letter `country` and `min_age >= consent_age(country)`. It never reads `source` or `v` (`20261111180000:31-55`).
    - The same check runs twice: in `hook_before_user_created` (`20261021120000:118-141`), and in the BEFORE INSERT trigger `enforce_age_gate_on_user`, which covers admin `createUser`, the path that skips the hook (`20261111180000:60-91`).
    - Neither check looks at `is_anonymous`.
- **Guest upgrade**
    - `_shared/guestEmail.ts` (confirm at :604-702) calls `admin.updateUserById(id, {email, password, email_confirm:true})` and never touches `age_gate`.
    - The `guard_guest_email` trigger (`20261010120200:180-230`) guards the `is_anonymous` → false flip.
- **Guest retention**
    - `retention_purge_stale_guests(p_idle default '90 days')` (`20261021120500:100-135`) deletes idle anonymous users.
    - The `retention-stale-guests` cron runs it at `27 3 * * *`. There is no per-owner setting.
- **Shared Edge helpers**
    - `_shared/rateLimit.ts` `checkRateLimit` fails closed on an RPC error.
    - `_shared/mailBudget.ts` `LAUNCH_MAIL_SPLIT` already spends the whole 60/300 non-auth budget, so a new mail category has to be carved out of the existing caps.
    - Also reused: `_shared/passwordPolicy.ts`, `_shared/resendDelivery.ts`, `_shared/readCappedJson.ts`, and `_shared/auth.ts` (`requireUser`, `rejectAnonymous`, `rejectStudent`).
- **Roster students** are `managed_students(teacher_id, student_user_id unique, student_email)`. The trusted marker is `app_metadata.user_type = 'student'`.
- **Feature flag**
    - `src/lib/features.ts:23` defines `viewLinks` (`VITE_FEATURE_VIEW_LINKS`, from #95).
    - It is read by `src/features/legal/childrenNotice.ts:21`, `src/features/legal/termsOfService.ts:65` and **`src/features/auth/AgeScreen.tsx:76`**, which is a hold path this PR may not touch.
- **CI** (`.github/workflows/ci.yml`)
    - `supabase-local` runs every `tests/sql/*.sql` through `scripts/ci/sql-proof.sh`.
    - It applies every migration from `20261022100000` on **a second time**, so every new migration must be safe to run twice.
    - `edge-functions-deno` runs `deno test` on **one explicitly named file**, so new Deno tests have to be added to that line.
    - Edge Functions never run in CI.
- **Guard tests a new migration must satisfy**
    - `tests/sql/migrations_ordered_replay.sql`: append an `\ir` line. `tests/legal/districtReattribution.test.ts` checks that list against the directory.
    - `tests/sql/explicit_grants.sql`: `t_client_expected`, and anon holds nothing on tables.
    - `tests/security/explicitServiceRoleGrants.test.ts`.
    - `tests/applyMigrationsInSync.test.ts`: regenerate `scripts/apply-migrations.sql` with `scripts/build-apply-migrations.mjs`.
    - `tests/migrationRecoverability.test.ts`: an exact map of every `cron.schedule` and `cron.unschedule` job name.
- **PR #98** (not merged, not touched) names its pieces differently from the ticket:
    - `view_mark_for_viewer` becomes `link_view_mark`;
    - `view_link_document_live` becomes `link_view_document_live`;
    - `view_link_assert_owner` becomes `share_assert_owner`;
    - `view_links_retention_purge` and `retention-view-links` become `retention_purge_share_links` and `retention-share-links`;
    - its rate limit keyed by a link hash, and its `{id, seq, deleted:true}` tombstone, are reused as they are.

## 2. Shape

### 2.1 One owner per decision

| Decision                                                                                | Single owner                                                  | Everyone else                                                                                                            |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Is a link live, and if not, why (`live`/`revoked`/`expired`/`unavailable`/`invalid`)    | SQL `share_link_state(link)`                                  | `peek_share_link`, `redeem_share_link` detail, `share_session_resolve`, `link_view_access`, `link_view_document` call it |
| Is this score shareable by this user (owner, not guest, not roster student, live score) | SQL `share_assert_owner(doc, uid)`                            | the 4 owner RPCs and the invite RPCs call it                                                                             |
| Expiry bounds (1 h to 365 d, or never; default 7 d)                                     | SQL `share_link_expiry(p_expires_in interval)`                | the owner RPCs, plus the `share_links_expiry_bounds` trigger for legacy direct inserts                                   |
| Which marks fields a signed-out viewer may see                                          | SQL `link_view_mark(...)`                                     | snapshot RPC, the `doc-view` fan-out trigger                                                                             |
| Who a viewer token is for                                                               | SQL `link_view_document()` (reads the JWT claim)              | Realtime policies via `link_view_topic_ok`, the `link_view_*` RPCs                                                       |
| Viewer JWT signing key                                                                  | `_shared/shareSession.ts` (the only reader of the secret, R1) | `share-session` only                                                                                                     |
| Link-guest idle window                                                                  | SQL `retention_guest_idle_window(uid, default)`               | `retention_purge_stale_guests`                                                                                           |
| Age gate acceptance                                                                     | SQL `age_gate_problem_for(meta jsonb, is_anonymous boolean)`  | the hook, the insert trigger, the `guest-email-confirm` pre-check (by RPC)                                               |

There is no TypeScript mirror of link state, expiry bounds or the whitelist. The Edge Functions ask SQL for these answers instead of keeping their own copies of the rules.

### 2.2 Migrations

All four migrations sort after `20261112120000_web_events.sql`, and all must be safe to run twice. To make sure of that, each one uses:

- `if not exists`;
- `create or replace`;
- `drop ... if exists` before any function whose return type changes;
- `drop policy if exists` before `create policy`;
- `cron.unschedule` before `cron.schedule`.

Each new function sets `search_path = ''`, and its grants follow the repo pattern (`revoke all from public, anon, authenticated`, then grant explicitly).

**`20261113120000_share_v2_links.sql`** covers plan 6.1, the 6.6 cleanup and D15.

- **6.6 cleanup** runs first. On a clean database every step is a no-op:
    - `cron.unschedule('retention-view-links')` if the job exists;
    - `drop table if exists public.view_links cascade`;
    - drop every `view_link_*`, `*_view_link` and `view_mark_for_viewer` function, through a `pg_proc` loop.
- **New `share_links` columns:**
    - `id uuid not null default gen_random_uuid()` with a unique index (existing rows get ids when the column is added);
    - `general boolean not null default false`;
    - `updated_at timestamptz`.
    - Unique partial index `share_links_one_general (document_id) where general and revoked_at is null`.
- **`share_links_guard_columns` is extended.** For client roles:
    - `id` and `general` cannot be set or changed;
    - a `general` row cannot be updated at all, so its changes must go through the RPCs (otherwise rotation and member handling would be skipped).
    - Legacy rows keep today's behaviour: owners may update `role`, `expires_at` and `revoked_at`.
- **New trigger `share_links_expiry_bounds`**, BEFORE INSERT or UPDATE OF `expires_at`, for client roles:
    - `expires_at` must be null, or between `now() + 1 h` and `now() + 365 d`, with 5 minutes of slack for client clocks;
    - otherwise it raises `22023` with detail `{"code":"invalid_link_expiry"}`;
    - the column default becomes `now() + interval '7 days'`.
    - Today's client choices (7 d, 30 d, never) all pass, so `/join` sharing doesn't change.
- **Internal helpers:**
    - `share_link_state(share_links) returns text`;
    - `link_view_document_live(doc) returns boolean`: not archived and no live takedown (from #98);
    - `share_assert_owner(p_document uuid, p_uid uuid)`. It raises 28000 for no user and 42501 otherwise. It refuses anonymous users (`auth.users.is_anonymous`), managed students, anyone whose `documents.owner_id` is not `p_uid`, and dead scores. It takes `p_uid` so the service-role invite RPCs can reuse it;
    - `share_link_expiry(interval) returns timestamptz`, where null means never;
    - `share_link_withdraw_members(token)`, extracted unchanged from today's `revoke_share_link` loop (roster students go back to their assignment role);
    - `share_link_demote_members(token)`: link-sourced editors without a role lock become viewers, owners are skipped, and roster students are handled as in the withdraw loop;
    - `share_link_repoint(old_token, new_token)`: moves `share_link_redemptions` to the new link.
- **Owner RPCs.** All are SECURITY DEFINER, granted to authenticated only, and take a `for update` lock on the score's general link before changing it.
    - `set_general_access(p_document uuid, p_mode text, p_role text default 'viewer', p_expires_in interval default '7 days') returns table(link_id uuid, token text, role text, expires_at timestamptz)`.
    - The `p_mode` values:
        - `'restricted'` revokes the general link, withdraws its members and queues a rotation.
        - `'anyone'` with no general link creates one.
        - `'anyone'` with an existing link updates its role and expiry:
            - editor→viewer demotes members and queues a rotation;
            - viewer→editor queues a rotation too, which ends signed-out viewer sessions (see 3.4);
            - an expiry change alone doesn't rotate.
    - `reset_general_link(p_document) returns` the same row. It revokes the old general link without removing members, creates a new token with the same role and the same expiry (7 d if the old one has lapsed), repoints redemptions and queues a rotation.
    - `renew_share_link(p_link uuid, p_expires_in interval default '7 days') returns timestamptz`. It works on general and legacy links, refuses revoked links (`link_revoked`), and makes an expired link live again. It doesn't rotate, because renewing only widens access.
    - `revoke_share_link(p_token text, p_remove_members boolean default false)` keeps its signature. For a general link, members are always withdrawn. A first revoke queues a rotation; a second one is idempotent and doesn't.
- **`peek_share_link`** is dropped and recreated as `returns table(valid boolean, role text, state text)`, still granted to anon and authenticated:
    - `valid` keeps exactly today's meaning (not revoked and not expired), so old callers don't change;
    - `state` comes from `share_link_state`.
- **`redeem_share_link`** keeps its message and SQLSTATE. Its detail becomes `{"code":"invalid_share_link","state":"<state>"}`, so `isDeadLinkError` still matches.

**`20261113120100_share_v2_viewer_auth.sql`** covers plan 6.2 to 6.4 and the anon EXECUTE cleanup.

- **Internal function `link_view_claims() returns table(doc uuid, link uuid)`.** It returns nothing unless:
    - `current_setting('role', true) = 'anon'`;
    - `auth.jwt()->>'role' = 'anon'`;
    - `iss = 'cleffy-share'`;
    - `cleffy_link.v = 1`;
    - and both ids parse as uuids. Parsing never throws.
- **`link_view_link()` (internal)** returns the `share_links` row matching the claim's `id` and `document_id` where `role = 'viewer'` and `general`. Its state is computed by `share_link_state`.
- **`link_view_document() returns uuid`** returns the doc when that state is `live`, and null otherwise.
- **`link_view_access() returns jsonb`** is granted to **anon**. It returns either:
    - `{status:'open', epoch, doc, link_expires_at}`;
    - or `{status:'revoked'|'expired'|'unavailable'|'invalid'}`.
- **`link_view_snapshot(p_since bigint default 0, p_limit int default 500) returns jsonb`** is granted to **anon**, with `p_limit` capped at 1000.
    - It returns `{doc:{title,page_count,content_rev}, marks:[link_view_mark(...)], max_seq, more}`.
    - A dead state raises `PT403` with detail `{"code":"<state>"}`.
- **`link_view_mark(id, seq, page, kind, color, payload, deleted_at) returns jsonb`** is #98's whitelist, unchanged, and is not executable by any client role:
    - text marks get `x,y,size,text,hw,font,bold,italic`;
    - other marks get `pts,w,sp`;
    - tombstones are `{id,seq,deleted:true}`.
- **`link_view_topic_ok(topic, prefix) returns boolean`** follows plan 6.3 and is granted to **anon**, because the policy expression runs with the caller's privileges.
- **Policies on `realtime.messages`, verbatim from plan 6.3:**
    - `link_view_receive` (select, to anon): broadcast on `doc:` or `doc-view:`;
    - `link_view_presence` (insert, to anon): presence on `doc:` only;
    - no anon policy on `doc-db:` and no anon broadcast insert anywhere;
    - member policies are unchanged. Members don't get `doc-view:` (subtracted: nothing reads it).
    - If spike (b) fails, R5 applies: no `link_view_presence`, plus an anon broadcast insert limited to event `viewer:here`, but only if spike (b) shows the event can be constrained. See 4.
- **Fan-out:**
    - `document_view_topic(doc)`, the twin of `document_db_topic`;
    - `document_has_live_viewer_link(doc)`, internal;
    - `broadcast_annotation_changes` also sends `link_view_mark(new...)` as event `mark` on `doc-view` when that function returns true and the content isn't removed;
    - `broadcast_document_changes` sends `{content_rev}` there under the same condition;
    - `rotate_document_realtime` also sends `topic_rotated` on the old `doc-view` topic.
- **`share_session_resolve(p_token text) returns jsonb`** is granted to service_role only. It returns `{state, role, link_id, doc:{id,title,page_count,content_rev}, pdf_path, link_expires_at}`, and only `{state}` when the link is not live.
- **Anon EXECUTE cleanup.** First, list the `public` non-trigger functions that anon can execute on the local stack. Every one outside the allow-list below gets an explicit `revoke execute ... from anon`, after `rg` over `src/` and `api/` confirms no signed-out code path calls it. Each one is listed in the PR body.
    - Supabase's default privileges grant EXECUTE to anon on every new function, so this list probably isn't empty.
    - Add `alter default privileges ... revoke execute on functions from anon`, if it applies cleanly on the local stack, so the list can't grow again without anyone noticing.
    - **Final anon allow-list:** `consent_age`, `peek_share_link`, `record_web_events`, `link_view_access`, `link_view_snapshot`, `link_view_topic_ok`.

**`20261113120200_share_v2_invites.sql`** covers plan 6.5 and the retention crons.

- **New table `document_invites`:**
    - columns `id uuid pk`, `document_id` (references documents, on delete cascade), `email`, `role`, `invited_by`, `token_hash bytea unique`, `created_at`, `expires_at default now()+14 d`, `accepted_at`, `accepted_by`, `revoked_at`;
    - `email` has a check that it equals `lower(btrim(email))` and is at most 320 characters; `role` is `viewer` or `editor`; `invited_by` references `auth.users` on delete cascade;
    - a unique partial index `(document_id, email) where accepted_at is null and revoked_at is null`.
    - RLS is on, with an owner `select` policy using `documents.owner_id = auth.uid()`.
    - Grants: `select` to authenticated (added to `t_client_expected`), all to service_role, nothing to anon.
- **Service-role RPCs.** Each takes `p_caller` and starts with `share_assert_owner`.
    - `share_invite_create(p_caller, p_document, p_email, p_role, p_token_hash) returns jsonb`. It returns one of:
        - `{kind:'roster_refused'}` when the email belongs to a managed student whose `teacher_id` isn't `p_caller` (D7);
        - `{kind:'member', title, inviter_name}` for an existing non-anonymous account. That account gets a membership (an existing owner is never changed) plus a `document_member_role_locks` row. A roster student invited by their own teacher goes through `lock_student_for_grant`, as `redeem_share_link` does;
        - `{kind:'invite', invite_id, title, inviter_name}`, which upserts the pending row (a new hash and expiry, so a re-invite reissues the token).
    - `share_invite_reissue(p_caller, p_invite, p_token_hash)` handles Resend. It only works on pending invites, and resets the expiry to 14 days.
    - `share_invite_cancel(p_caller, p_invite)` sets `revoked_at`.
    - `share_invite_peek(p_token_hash) returns jsonb` returns `{state:'pending'|'expired'|'used'|'cancelled'|'invalid', title, inviter_name, role, email}`. The Edge Function masks the email.
    - `share_invite_consume(p_token_hash, p_user)` locks the row `for update`. It refuses anything that isn't pending, then inserts the membership and role lock and sets `accepted_at` and `accepted_by`.
- **Authenticated RPC `share_owner_ready(p_document) returns boolean`.** It calls `share_assert_owner(p_document, auth.uid())`. The Edge Function uses it to check ownership under the caller's own JWT.
- **Retention** (both functions granted to service_role only):
    - `retention_purge_share_links(p_batch)` deletes links whose `revoked_at` or `expires_at` is more than 30 days ago. `share_link_redemptions` cascades.
    - `retention_purge_share_invites(p_batch)` deletes invites more than 30 days past their accept, revoke or expiry, whichever happened.
    - The crons are `retention-share-links` at `53 3 * * *` and `retention-share-invites` at `3 4 * * *`, each unscheduled first.

**`20261113120300_share_v2_link_guests.sql`** covers the age gate and D8. It's a fourth file so that the auth changes can be reviewed on their own; the ticket's list doesn't forbid one, and the PR body will say so.

- **`age_gate_problem_for(p_meta jsonb, p_is_anonymous boolean) returns text`.**
    - When `age_gate` is exactly `{source:'link_guest', v:2}`, it returns NULL only if `p_is_anonymous` is true, and `'age_check_missing'` otherwise.
    - Otherwise it calls `age_gate_problem`.
    - It's granted to service_role for the Edge pre-checks.
- **Callers:**
    - `enforce_age_gate_on_user` passes `NEW.is_anonymous`;
    - `hook_before_user_created` passes `event->'user'->>'is_anonymous'` (spike e). If the payload doesn't carry that field, the fallback is "no email and no phone", and the trigger stays the authoritative check because it sees the real column.
- **`guard_guest_email` is extended:** flipping `is_anonymous` from true to false raises 42501 while `raw_user_meta_data->'age_gate'->>'source' = 'link_guest'`. The database therefore enforces "new gate before clearing `is_anonymous`".
- **D8 storage:**
    - Table `share_owner_settings(owner_id uuid pk references auth.users on delete cascade, link_guest_idle_days int not null default 30 check (between 1 and 90), updated_at)`. RLS is on, there are no client grants, and service_role gets all.
    - `set_link_guest_retention(p_days int) returns int` is granted to authenticated. It refuses anonymous users and students, and raises 22023 `{"code":"invalid_retention_days"}` outside 1 to 90.
    - `my_share_settings() returns jsonb` is granted to authenticated and returns `{link_guest_idle_days}`, with the default of 30 when there is no row.
- **`retention_guest_idle_window(p_user, p_default) returns interval`.**
    - For a link guest it returns `least(90 d, coalesce(max(per-owner setting or 30) over the owners of the guest's member scores, 30) days)`.
    - Any other guest gets `p_default` (90 d).
- **`retention_purge_stale_guests`** keeps its signature and cron. Inside, `now() - p_idle` becomes `now() - retention_guest_idle_window(id, p_idle)`. The candidate scan uses `least(p_idle, 1 day)` as its prefilter, and the lock-time re-check uses the per-guest window.

### 2.3 Edge Functions

All three functions are POST only. When `SHARE_V2_ENABLED !== '1'` they return 404 before doing anything else.

The repo splits a function into logic and wiring in `guestEmail.ts`/`guestEmailWiring.ts`. These functions follow that pattern so Deno can test them without a stack:

- `index.ts` holds the wiring;
- `handler.ts` is pure, with injected deps;
- `handler_test.ts` sits beside it.

**`supabase/functions/_shared/shareSession.ts`**

```ts
export type ViewerClaims = { doc: string; link: string; v: 1 };
export type ShareSigningKey =
    { alg: 'HS256'; secret: Uint8Array } | { alg: 'ES256' | 'RS256'; kid: string; key: CryptoKey };
export function shareSigningKey(env: (k: string) => string | undefined): Promise<ShareSigningKey | null>; // SHARE_JWT_SECRET or SHARE_JWT_PRIVATE_JWK (D9)
export function signViewerJwt(
    key: ShareSigningKey,
    claims: ViewerClaims,
    now: number,
): Promise<{ jwt: string; exp: number }>;
// payload: { iss:'cleffy-share', role:'anon', aud?: 'authenticated' (spike f), iat, exp: iat+600, cleffy_link } — no sub
export function verifyViewerJwt(
    key: ShareSigningKey,
    jwt: string,
    now: number,
    graceSec: number,
): Promise<ViewerClaims | null>; // renewal only
```

**`share-session`** (`verify_jwt = false`)

- **Request:** `{token, renew?}`, with a body cap of 1 KB. A token that doesn't match `^[A-Za-z0-9_-]{22}$` gets `{state:'invalid'}`.
- **Steps:**
    1. `share_session_resolve(token)`, a read-only call. If nothing is found, it returns `{state:'invalid'}`.
    2. `linkKey = sha256hex(link_id)`.
    3. `share-mint:<linkKey>`: 120 per minute. It fails closed with 429 `{reason:'rate_limited', retry_after}`.
    4. A non-live link returns `{state}` and no document fields.
    5. An editor link returns `{state:'live', role:'editor', link_expires_at}` and mints nothing.
    6. For a viewer link, if `renew` verifies (same link, expired at most 15 min ago), it skips the viewers bucket. Otherwise `share-viewers:<linkKey>` applies, at `SHARE_VIEWER_CAP` (default 40) per 10 minutes, failing closed with 429 `{reason:'too_many_viewers', retry_after}`.
    7. It signs the JWT and a 5-minute signed PDF URL.
    8. It returns `{state, role, session_jwt, exp, doc:{id,title,page_count,content_rev}, pdf_url, link_expires_at}`.
- It stores no IP, and no row per viewer (the buckets are per link).
- **Why the renewal skips the viewers bucket:** each viewer renews every ~8 minutes. With the existing fixed window, renewals would otherwise make 20 to 25 real viewers look like 40 (D10 is about _simultaneous_ viewers).

**`share-invite`** (`verify_jwt = true`)

- **Request:** `{action:'invite'|'resend'|'cancel', document_id, email?, role?, invite_id?}`.
- **Before any action:**
    - `requireUser`, then `rejectAnonymous` and `rejectStudent`;
    - `userClient.rpc('share_owner_ready')`, which is the ownership check under the caller's JWT.
- **`invite`:**
    1. Normalise the email.
    2. Buckets, all failing closed: per caller `share-invite:user:<id>` (30/h), per recipient HMAC(email) (3/day), and the global mail budget `mailLimit('share-invite', ...)`.
    3. Generate a 32-byte token and its sha256.
    4. Call `share_invite_create`.
    5. Then:
        - `roster_refused` returns 403 `{error:'cannot_invite', hint:'assign'}`. The wording is generic so it doesn't name the account type; see 6.
        - `member` sends the "shared with you" mail with a `/doc/<id>` link.
        - `invite` sends the mail with `/invite#<token>`.
    6. The response is `{ok:true}` in both cases.
- **`resend`** and **`cancel`** call `share_invite_reissue` and `share_invite_cancel`.
- **Mail budget:** `share-invite` gets 10/h and 50/day, carved out of `LAUNCH_MAIL_SPLIT` (the categories it takes from are named in the PR body), and `tests/security/mailBudget.test.ts` is updated.
- A `rejected` send refunds its reservations, as in `guestEmail.ts`.

**`share-invite-accept`** (`verify_jwt = false`)

- **Request:** `{action:'peek'|'accept', token, password?, age_gate?}`.
- **Rate limit:** the bucket is `share-invite-accept:<sha256(token)>`, 20 per 10 minutes, failing closed.
- **`peek`:** `share_invite_peek` returns `{state, title, inviter_name, role, email_masked}`, with the email masked as `j***@e***.com`.
- **`accept`:**
    - If the caller is signed in, not anonymous, and their email matches the invite, it calls `share_invite_consume` and returns `{ok, document_id}`.
    - If the caller is signed in with another email, it returns 409 `email_mismatch`.
    - An anonymous caller is treated as signed out.
- **`accept` while signed out:**
    1. Check that the invite is pending.
    2. An existing account returns 409 `sign_in_required`.
    3. `age_gate_problem_for(age_gate, false)` returns 400 `age_check_missing` or 403 `below_consent_age`.
    4. `passwordProblem` returns 400 `weak_password`.
    5. `admin.createUser({email, password, email_confirm:true, user_metadata:{age_gate}})`. The insert trigger is a second check here.
    6. Then `share_invite_consume`. If that fails, the user just created is deleted.
    7. Return `{ok, document_id}`. The client signs in with the password.

**`guest-email-confirm` and `_shared/guestEmail.ts`**

- Confirm reads the guest's current `age_gate`. If `source === 'link_guest'`:
    - the body must carry a new `age_gate`, which must pass `age_gate_problem_for(gate, false)`, or confirm refuses with 400 `age_check_required` or 403 `below_consent_age`;
    - before `attach`, it runs `updateUserById(id, {user_metadata:{age_gate: new}})`.
- The DB guard in 2.2 backs this ordering up.
- Other guests don't change.

**`supabase/config.toml`**

- `[functions.share-session] verify_jwt = false`
- `[functions.share-invite] verify_jwt = true`
- `[functions.share-invite-accept] verify_jwt = false`

Each entry gets a comment.

### 2.4 Front-end flag (no `.tsx`)

`src/lib/features.ts`:

```ts
/** Share v2 (Google-Docs-style sharing). Off until Max turns it on. */
shareV2: flag(import.meta.env.VITE_FEATURE_SHARE_V2),
/** @deprecated Read `shareV2`. Kept only because AgeScreen.tsx (a hold path) reads it; the Share v2 UI PR deletes it. */
viewLinks: flag(import.meta.env.VITE_FEATURE_SHARE_V2),
```

- `childrenNotice.ts` and `termsOfService.ts` switch to `features.shareV2`, with the text unchanged. With the flag off, the output is identical to `dev`.
- The comments and test that name `VITE_FEATURE_VIEW_LINKS` (`childrenNotice.ts:14`, `childrenNotice.test.ts:33`) switch to `VITE_FEATURE_SHARE_V2`. The repo has no `vite-env.d.ts` to update.
- A test asserts `features.viewLinks === features.shareV2`, so the alias can't drift.
- `DEPLOY.md` notes that `VITE_FEATURE_VIEW_LINKS` is retired.

## 3. Work, in order

Each step leaves the tree green, and the PR body is updated as the steps land.

1. **Spike, on the local stack only** (`npm run cloud:up`, with `SHARE_V2_ENABLED=1` and the local HS256 secret in the git-ignored `supabase/functions/.env`).
    - Write scratch scripts outside the repo. They'll mint a test JWT with the local stack's public HS256 secret, subscribe with supabase-js, and write the results for (a) to (g) into the PR body:

        |     | Spike                                                                                                           | Pass condition                                                                                                          |
        | --- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
        | (a) | Can an anon-role JWT with `iss=cleffy-share`, no `sub` and a `cleffy_link` claim join a private `doc:` channel? | `link_view_receive` admits it, and a JWT with the claim stripped is refused                                             |
        | (b) | Can anon `track()` with only an insert-presence policy and no select-presence policy?                           | Presence write works without presence read. If not, the R5 fallback applies                                             |
        | (c) | What happens on `setAuth(newJwt)` on a joined channel?                                                          | Policies are re-checked: a token for another doc is refused                                                             |
        | (d) | What happens on a joined channel when the token expires?                                                        | Record the server event and close behaviour                                                                             |
        | (e) | Is `is_anonymous` in the `before_user_created` payload?                                                         | Record the payload keys                                                                                                 |
        | (f) | Does PostgREST accept the minted token with no `aud`, or need `aud=authenticated`?                              | Record which                                                                                                            |
        | (g) | Key-type note for Max (D9)                                                                                      | Local is HS256; how to check Dashboard → JWT Keys; asymmetric means an imported standby key and `SHARE_JWT_PRIVATE_JWK` |

    - If (a) fails and R5 can't cover it, post a questions handoff and stop.
2. **Migration `share_v2_links`**, and the `share_v2.sql` sections for links.
    - Add the `\ir` line to `migrations_ordered_replay.sql` and regenerate `scripts/apply-migrations.sql`.
    - Add `retention-view-links` (unschedule) to the recoverability map.
    - Update `functionGrants.test.ts` for the new owner RPCs.
3. **Migration `share_v2_viewer_auth`**, its SQL tests, the anon-function allow-list (SQL and vitest), and the anon EXECUTE cleanup.
4. **Migration `share_v2_invites`** and its tests.
    - Add the `explicit_grants.sql` row `('document_invites','authenticated','SELECT')`.
    - Add the two cron names to the recoverability map.
5. **Migration `share_v2_link_guests`** and its tests.
    - Add `share_owner_settings` to the service-role grants.
    - Re-run the existing age-gate tests (`tests/sql/age_gate_admin_backstop.sql`, `tests/auth/ageGateAdminCreateUser.test.ts`).
6. **`_shared/shareSession.ts`**, `share-session` (handler and Deno test), and its `config.toml` entry.
7. **`share-invite`** (handler and Deno test), plus the mail-budget category.
8. **`share-invite-accept`** (handler and Deno test).
9. **`guest-email-confirm` and `_shared/guestEmail.ts`**: the age-gate step and its Deno and vitest tests (wherever `guestEmail` tests live today).
10. **`features.ts`**, `childrenNotice.ts`, `termsOfService.ts` and their tests.
11. **`tests/live/shareV2Realtime.live.test.ts`**, run by hand against the local stack, with `functions:serve` and the switch on. The PR body records the command and its output.
12. **`DEPLOY.md` "Share v2" section**, the new Deno test files on the `edge-functions-deno` line in `ci.yml`, and regenerated `src/types/database.ts` from the local stack.
13. **Gate:** `npm run lint:check`, `npm run typecheck`, `npm run test`, `npm run build`, plus the CI SQL proofs locally (`scripts/ci/sql-proof.sh` over `tests/sql/*.sql`, including the second migration pass) and `deno check` / `deno test` for the functions.

## 4. Acceptance criteria → work

| #   | Criterion (short)                                                                                                                                                                                                                                                        | Work that meets it                                                                                                                                                                                                        | Proof                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | PR body has spike (a)-(g) and the chosen presence path                                                                                                                                                                                                                   | Step 1                                                                                                                                                                                                                    | PR body table; native split if (b) passes, else R5 (2.2 viewer_auth)                                                                                                                                                                                                                                                                                                                                        |
| 2   | Migrations apply locally; `migrations_ordered_replay.sql`, `explicit_grants.sql` pass; `supabase-drift` green                                                                                                                                                            | Steps 2-5, all four migrations safe to run twice, `\ir` lines, `t_client_expected` row, `apply-migrations.sql` regenerated; drift only compares hosted state against the repo, and nothing is applied to a hosted project | `supabase-local` second pass; the two SQL proofs; CI                                                                                                                                                                                                                                                                                                                                                        |
| 3   | Viewer token for A gets A's snapshot; B, another link, expired, revoked, archived, restricted, removed or editor link gets null with the right `state`                                                                                                                   | `link_view_claims` / `link_view_link` / `share_link_state` / `link_view_document` / `link_view_access` / `link_view_snapshot` (step 3)                                                                                    | `tests/sql/share_v2.sql` section "viewer claim matrix": one row per case, asserting `link_view_document()` is null and `link_view_access()->>'status'`                                                                                                                                                                                                                                                      |
| 4   | Viewer token can't select `annotations`, `documents`, `document_members`, `share_links`, `document_invites`, `storage.objects`; can't call any function granted to authenticated; `functionGrants.test.ts` lists exactly the anon functions                              | Anon has no table privileges (existing check 31) plus the anon EXECUTE cleanup (step 3)                                                                                                                                   | SQL: the six selects as the viewer, each `42501` or 0 rows; a `pg_proc` loop over `public` functions executable by authenticated asserts `has_function_privilege('anon', …)` is false outside the allow-list, and that the anon-executable set equals the allow-list. Vitest: `functionGrants.test.ts` walks every migration's grants and revokes and asserts the final anon set equals the same allow-list |
| 5   | `authenticated` token with a forged top-level `cleffy_link` gets nothing more                                                                                                                                                                                            | `link_view_claims` requires `role` setting = `anon` and claim role = `anon`                                                                                                                                               | SQL: `as_jwt({sub, cleffy_link:{…}, iss:'cleffy-share'})` gets a null document, `invalid` access, and the policy check false                                                                                                                                                                                                                                                                                |
| 6   | Realtime policies: anon reads broadcast on `doc:` / `doc-view:` at the current generation for its own score only; inserts presence on `doc:` only; nothing on `doc-db:` or an old generation; no broadcast send                                                          | Policies `link_view_receive` and `link_view_presence` and `link_view_topic_ok` (step 3)                                                                                                                                   | SQL: evaluates `link_view_topic_ok` and the policy predicates over a topic matrix (prefix × generation × doc × extension) as the viewer. Live test (row 16)                                                                                                                                                                                                                                                 |
| 7   | Revoke, reset, role drop and Restricted each rotate exactly once per commit; link members withdrawn (revoke, Restricted) or demoted (editor→viewer)                                                                                                                      | `queue_document_realtime_rotation` in each RPC, deduped with the existing member/role triggers; withdraw, demote and repoint helpers (step 2)                                                                             | SQL: for each operation, `set constraints … immediate`, then assert the epoch went up by exactly 1, plus member rows and roles after. Reset keeps members and repoints redemptions                                                                                                                                                                                                                          |
| 8   | `link_view_mark` passes #98's whitelist cases, including tombstones; the annotation trigger sends to `doc-view` only while a live general viewer link exists                                                                                                             | `link_view_mark` (port), `document_has_live_viewer_link`, trigger change (step 3)                                                                                                                                         | SQL: #98's whitelist cases ported. Trigger: count `realtime.messages` rows on the `doc-view` topic with no link, a live viewer link, an editor link, and revoked and expired links                                                                                                                                                                                                                          |
| 9   | Owner RPCs refuse non-owners, guests, roster students and dead scores; at most one live general link; `peek_share_link` gains `state` and old callers still work                                                                                                         | `share_assert_owner`; `share_links_one_general` index plus guard trigger; drop and recreate peek with `valid` unchanged (step 2)                                                                                          | SQL: refusal matrix 4 RPCs × 4 callers or states; a second insert with `general=true` as owner is refused; peek `valid` and `role` unchanged for today's cases, with `state` for each. `shareService` tests pass unchanged                                                                                                                                                                                  |
| 10  | `share-session`: state mapping, JWT shape, 1 KB cap, two link-hash buckets failing closed, 429 `too_many_viewers`, editor mints nothing, 404 when off                                                                                                                    | `share-session/handler.ts` plus `_shared/shareSession.ts` (step 6)                                                                                                                                                        | `share-session/handler_test.ts`: one test per clause; decodes the JWT (`iss`, `role`, no `sub`, `cleffy_link`, `exp - iat = 600`); a rate-limit RPC error gives 429; buckets never see an IP                                                                                                                                                                                                                |
| 11  | `share-invite`: caller-JWT ownership; roster-student refusal unless their teacher; mail budget; existing account gets a membership and role lock; new email gets a pending row (14 d, hash only); same response; Resend and Cancel; 404 when off                         | handler plus `share_owner_ready` and the `share_invite_*` RPCs plus the mail category (steps 4 and 7)                                                                                                                     | Deno: same-response assertion, refusal paths, budget exhausted gives 429, mail refunded on reject. SQL: create, reissue and cancel; hash only (no token column); `expires_at ≈ +14 d`; role lock row                                                                                                                                                                                                        |
| 12  | `share-invite-accept`: peek (title, inviter, role, masked email); accept attaches a signed-in matching account or creates one (admin API, `email_confirm`, `age_gate`, password policy); refuses expired, used and cancelled invites, a missing gate and a weak password | handler plus `share_invite_peek` and `share_invite_consume` (steps 4 and 8)                                                                                                                                               | Deno: each branch, including deleting the new user when consume fails. SQL: consume refuses each dead state and double accepts                                                                                                                                                                                                                                                                              |
| 13  | `{"source":"link_guest","v":2}` accepted only for anonymous new users in both the trigger and the hook; `guest-email-confirm` refuses while the gate is `link_guest` and writes the new gate before clearing `is_anonymous`                                              | `age_gate_problem_for`, hook and trigger callers, guard extension, confirm step (steps 5 and 9)                                                                                                                           | SQL: hook with anonymous and non-anonymous events; `auth.users` insert as `supabase_auth_admin` with both; the guard refuses the flip while `link_guest`. Deno/vitest: confirm refuses with no gate, writes metadata before attach (call order recorded)                                                                                                                                                    |
| 14  | D8: setting stored server-side, default 30, rejected outside 1-90; purge honours it for link guests, others stay at 90; SQL tests cover default, custom value, bounds and multi-owner                                                                                    | `share_owner_settings`, `set_link_guest_retention`, `my_share_settings`, `retention_guest_idle_window`, purge change (step 5)                                                                                             | SQL: default 30; set 7 then 0 and 91 refused; a link guest idle 10 d on a 7-day owner is purged; on two owners (7 and 60) idle 30 d it is kept and idle 61 d purged; a regular guest idle 60 d is kept and idle 91 d purged                                                                                                                                                                                 |
| 15  | D15: default 7 days; only 1 h to 365 d accepted, with a clear error; an expired general link renewed becomes live; SQL tests                                                                                                                                             | `share_link_expiry`, RPC defaults, `share_links_expiry_bounds` trigger, `renew_share_link` (step 2)                                                                                                                       | SQL: default ≈ +7 d; 59 min and 366 d refused with `invalid_link_expiry`; 1 h, 365 d and never accepted; renew an expired general link then peek `state='live'`; renew a revoked link is refused                                                                                                                                                                                                            |
| 16  | Retention crons for share links and invites, tested                                                                                                                                                                                                                      | `retention_purge_share_links` and `retention_purge_share_invites` plus the crons (step 4)                                                                                                                                 | SQL: boundary rows at 29 and 31 days for each condition; the redemptions cascade; `cron.job` has both names. Recoverability map updated                                                                                                                                                                                                                                                                     |
| 17  | Live Realtime test: viewer gets ink on `doc:` and marks on `doc-view:`, can't send ink, gets nothing from `doc-db:`; owner sees viewer presence; after revoke, `topic_rotated`, then denied, then renewal refused                                                        | `tests/live/shareV2Realtime.live.test.ts` (step 11)                                                                                                                                                                       | Run against the local stack; output in the PR body (CI skips live tests, as it does `takedownRealtime.live.test.ts`)                                                                                                                                                                                                                                                                                        |
| 18  | With the flag and switch off, sharing, `/join` and legal text behave as on `dev`                                                                                                                                                                                         | All changes are additive or keep their signatures (2.2); Edge 404s; flag alias                                                                                                                                            | Existing `shareService`, `sharing_access_control.sql` and legal tests unchanged and green; a new vitest renders `CHILDREN_NOTICE` and the terms with the flag off and compares them to snapshots taken on `dev`                                                                                                                                                                                             |
| 19  | `DEPLOY.md` Share v2 section; CI `checks`, `supabase-local`, `supabase-drift` and `edge-functions-deno` green at the head                                                                                                                                                | Step 12; `ci.yml` Deno line                                                                                                                                                                                               | CI at the PR head                                                                                                                                                                                                                                                                                                                                                                                           |

Every criterion maps to work. **ac=met.**

## 5. Alternatives considered

- **Edge-owned link policy.** `share-session` and `share-invite` would compute state, expiry bounds and owner checks in TypeScript, and SQL would only store data.
    - It lost because the same rules are also needed in RLS, the realtime policies, `peek_share_link` and `redeem_share_link`, so there would be two copies of each rule (the "hand-synced list" red flag).
    - The SQL-owned shape gives the Edge Functions a small surface: one resolve call and one owner check.
- **A `source`/`link_id` column on `document_members`** instead of the existing `share_link_redemptions` side table.
    - It lost because the side table already carries provenance, cascades and the revoke loop.
    - A second record of provenance would split ownership of the same fact.
- **Viewer tokens for legacy (non-general) viewer links.** Rejected because criterion 8 limits the `doc-view` fan-out to the general link, so legacy-link viewers would receive no saved marks.
    - Legacy links keep today's `/join` path (D2, "copy/revoke only").
    - `share_session_resolve` reports them as `invalid` for the viewer path, and the UI PR sends them to `/join`.
- **Rate-limiting `share-session` by a hash of the token before resolving.** Rejected because it writes one bucket row per random token: an unauthenticated write-amplification path.
    - Resolving first is one indexed read, and the buckets are keyed by `sha256(link uuid)` as the criterion says.

## 6. Risks and open points (none blocks the plan)

- **D7 refusal leaks account type.**
    - Refusing a roster student's email tells a non-teacher owner that the address belongs to a Cleffy student.
    - The wording is generic (`cannot_invite`, "this address can't be invited here; if they're your student, use Assign"). That makes the leak smaller but doesn't remove it.
    - Max decided D7. The PR body will call out the residual leak for the privacy-docs issue.
- **Owners can tell whether an email has an account.** An invited existing account shows up as a member right away, while a new email shows as pending. This matches Google Docs; the response itself is the same (R9).
- **The 30-day link purge removes provenance.** Deleting a general link that expired more than 30 days ago (criterion 16) cascades its redemptions. Its members keep access as ordinary members, and Restricted can no longer withdraw them.
- **Viewer→editor also rotates.** This isn't in the rotation criterion, but without it signed-out viewers would keep receiving updates on an editor-only link until their token expires.
- **The anon EXECUTE cleanup may touch existing functions.** Each one gets a `src/` check and is listed in the PR body. If a signed-out path needs one, it joins the allow-list and the PR body says why.
- **The renewal JWT is checked only by signature and link match.** A leaked expired token can skip the viewers bucket for 15 minutes but still uses the mint bucket. Accepted.
- **R5:** if (b) fails and anon broadcast can't be limited to `viewer:here`, a viewer could send fake `ink:progress`. In that case, post a questions handoff rather than ship it.
- **Hold paths:** the plan touches no `hold.paths` glob, so it isn't held.

## 7. Rollout (DEPLOY.md "Share v2")

- **Secrets:** `SHARE_V2_ENABLED=1`, `SHARE_JWT_SECRET` (HS256 project secret) or `SHARE_JWT_PRIVATE_JWK` (imported standby key, D9), and `SHARE_VIEWER_CAP` (default 40).
- **Front end:** `VITE_FEATURE_SHARE_V2=1` on Vercel. `VITE_FEATURE_VIEW_LINKS` is retired.
- **Crons:** `retention-share-links` and `retention-share-invites`; `retention-stale-guests` now honours D8.
- **Order:** Max merges `dev` into `main` (the migrations go out inert), checks Dashboard → JWT Keys, sets the secrets, deploys the three functions, smoke-tests, then sets the Vercel flag.
- **Rollback:** unset the flag and `SHARE_V2_ENABLED`. Optionally rotate `SHARE_JWT_SECRET`, which invalidates outstanding viewer tokens within 10 minutes anyway.
- No hosted Supabase project or Vercel env is changed from an agent session.

## 8. First implementation step

Boot the local stack and run spike (a)/(b) with a hand-minted HS256 anon JWT against a private `doc:` channel. The presence path in 2.2 depends on that result.
