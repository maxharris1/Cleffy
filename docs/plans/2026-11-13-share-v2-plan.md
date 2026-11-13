> **Status:** approved by Max on 2026-11-13 (1:09 PM ET) with the changes in [2026-11-13-share-v2-decisions.md](2026-11-13-share-v2-decisions.md). Where the two differ (D8, D15), the decisions file wins.

# Cleffy sharing: one Google Docs-style share model (plan)

Plan only. Written 2026-11-13 against `origin/dev` @ `25aaefc` (worktree
`/workspace/wt-cleffy-share-plan`) and PR #98's head `4f45bb18`
(`origin/mh/u13-view-links`). Paths are repo-relative. A `file:line` without a
commit is at `25aaefc`; `@98:` means `git show 4f45bb18:<path>`. Inputs:
`/workspace/cleffy-pr98-demos/COMPARE.md` and `INDEX.md`.

Anything about how the hosted Supabase Realtime, GoTrue or the JWT keys behave
that I could not prove from this repo is marked **(spike)**. PR 1 starts by
checking those on the local stack before writing any code.

---

## 0. Summary

- **One model, three ways in**, all from one Share dialog:
  1. **Anyone with the link: Viewer.** No account and no questions. The visitor
     gets a short-lived, read-only, single-score token that lives in memory
     only. It is minted by a new Edge Function and joins the score's existing
     `doc:{id}` topic (live ink) plus a new filtered topic `doc-view:{id}`
     (saved marks with only the fields needed to draw them). Viewers show up in
     presence as "Anonymous <animal>", and the owner sees a live count.
  2. **Anyone with the link: Editor.** An optional name, no age screen, then
     straight into editing as a Supabase anonymous ("guest") user. This is the
     guest path that exists today, without the age screen and with the name
     made optional.
  3. **Specific people.** Invite by email with a role. An existing account gets
     access at once. An email with no account gets a pending invite and an
     email. The invite link goes to a short "create your account" step (age
     screen and password), then into the score. Roster students are unchanged.
- **Revocation is live.** Revoking, resetting or downgrading the link moves the
  score to a new realtime topic generation. That rotation mechanism already
  exists (`20261020150100_takedown_realtime_topics.sql:1-44`,
  `20261022120000_realtime_revocation_rotation.sql:1-45`). Open viewers are
  refused on the new topics, get the reason, and the score is cleared from
  their screen. Their token can't be renewed either, so a client that ignores
  the hint is left on dead topics until its token runs out (10 min at most).
- **Reuse the real viewer.** `PdfViewport` in read-only mode with an in-memory
  store and a link-scoped Supabase client. #98's separate `view.html` / `src/view`
  / `api/view.ts` / `view-link` stack is not carried forward.
- **No age screen on link joins.** It stays only where an account is created
  with an email (register, guest → account upgrade, accepting an invite).
- **#98 is not merged.** No `view_links` table exists on `dev` (only
  `origin/mh/u13-view-links` contains `4f45bb18`, and a grep of `supabase/`,
  `src/` and `tests/` at `25aaefc` finds no `view_links`). There is nothing to
  migrate. **Recommendation: close #98** and port the few parts worth keeping
  (§9).
- **Three PRs:** (1) backend and realtime auth, (2) UI and flows, (3) privacy
  and legal docs. All behind `VITE_FEATURE_SHARE_V2` plus a server switch,
  OFF in production until Max says.

---

## 1. Where things stand

### On `dev` today

| Piece | What it does | Evidence |
| --- | --- | --- |
| `share_links` | Token (22 chars, 128 bits) in the PK, `role` editor/viewer, `expires_at`, `revoked_at`. Several links per score. | `supabase/migrations/20260801160752_schema.sql:26-38` |
| Owner-only link RLS | Select/insert/update/delete only for the score owner. | `supabase/migrations/20260801160754_rls.sql:57-71` |
| Redeem | Needs a session, upserts a `document_members` row and records the source link in `share_link_redemptions`. | `supabase/migrations/20261022120200_realtime_archive_recovery.sql:71-151` |
| Peek | Granted to anon; one answer for unknown, revoked and expired. | `supabase/migrations/20261009120200_share_link_errors_and_peek.sql:120-136` |
| Revoke | `p_remove_members` defaults to false. | `supabase/migrations/20261007120000_sharing_access_control.sql:469-541` |
| Join page | Age screen → required name → `signInAnonymously` with `age_gate` → redeem → `/doc/:id`. | `src/features/share/JoinPage.tsx:119-171`, `src/features/auth/session.ts:227-241` |
| Age gate in the DB | The `before_user_created` hook and the `auth.users` trigger refuse any new user without a valid `age_gate`, guests included. | `supabase/migrations/20261021120000_consent_age.sql:1-28,118-135`, `20261111170000_age_gate_auth_users_insert.sql:21-57`, `20261111180000_age_gate_problem_missing_min_age.sql:31-58` |
| Realtime auth | `doc:{id}[:{n}]` (presence + live ink) and `doc-db:{id}[:{n}]` (receive-only, server-sent rows). Policies call `document_role()`, which only knows `document_members` rows for `auth.uid()`. | `20260801162310_realtime.sql:51-67`, `20261022120100_realtime_revocation_races.sql:259-300`, `20261020150000_content_moderation.sql:967-985` |
| Generation rotation | `rotate_document_realtime` bumps the epoch, the policies admit only the current generation, and `topic_rotated` is sent on the old topics. Membership loss queues a rotation that runs at commit. | `20261020150100_takedown_realtime_topics.sql:193-226`, `20261022120000_realtime_revocation_rotation.sql:59-150` |
| Client channel | `DocRealtimeChannel` with `fetchTopicEpoch`, presence keyed by `userId`, ink only while someone else is present. | `src/sync/realtimeChannel.ts:180-306,700-760,1130-1170` |
| Presence names | Display name, else "Guest" / "Collaborator", never an email. | `src/lib/presenceName.ts:1-30`, `src/sync/wire.ts:196-202` |
| Viewer | `CloudViewer` is tied to the session, Dexie caches (`pdfCache`, annotations, outbox) and the PWA. `PdfViewport` calls `getDb()` / `getSupabase()` directly. | `src/features/viewer/ViewerPage.tsx:198-245,770-800`, `src/features/viewer/PdfViewport.tsx:194-235,305,1089-1140` |
| Boot | Attribution, web events, Sentry and service-worker registration run on every path. | `src/main.tsx:26-44` |
| Share dialog | Role toggle, expiry select, links list, "People with access", revoke dialog with the remove box ticked by default. | `src/features/share/ShareDialog.tsx:250-282,286-358,360-420,485-535` |
| Name-column bug | The member `<select>` gets both `w-full` (from the `sm` size) and `w-auto`, so the flex name column collapses to 0 px. The same pattern is used on the expiry select. | `src/features/share/ShareDialog.tsx:398,272`, `src/ui/classNames.ts:44-56` |
| Feature flag | `features.viewLinks` (`VITE_FEATURE_VIEW_LINKS`) already exists on dev and gates a "View links" section in the children's notice. | `src/lib/features.ts:22-23`, `src/features/legal/childrenNotice.ts:20-40` |
| Realtime budget | Pro: 500 concurrent connections, 500 msg/s, 5 M msg/month. Each broadcast is billed once per recipient. | `DEPLOY.md:4174-4215` |

### PR #98 (`4f45bb18`), in one paragraph

#98 adds a second sharing system: a `view_links` table, owner RPCs, a separate
`view.html` entry (`src/view/*`), a Vercel proxy (`api/view.ts`) and an Edge
Function (`view-link`). The client polls every 2.5 s, so there is no live
in-progress ink. It also adds a whitelist of the mark fields a viewer receives,
tombstones that carry no content, a retention cron, a service-worker denylist
and build checks (COMPARE.md, every row). The demos found these problems: a 429
shows nothing on screen (`@98:src/view/ViewApp.tsx:94-97`); revoked, expired
and invalid links all read "turned off" (`@98:supabase/functions/_shared/viewLink.ts:17-18`);
the children's privacy footer link leaves the memory-only page for the full app
(`@98:src/view/ViewApp.tsx:157-164`); no expiry date is shown (`@98:src/features/share/ShareDialog.tsx:555-563`);
and the name-column bug above (existing, not from #98).

---

## 2. The model and the Share dialog

One dialog for the owner, modelled on Google Docs:

```
Share "Für Elise"
[ Add people by email…          ] [Viewer ▾] [Invite]

People with access
  Max Harris (you)                                   Owner
  Leo · leo@…                               [Editor ▾] Remove
  Sam (guest, joined by link)               [Viewer ▾] Remove
  ana@example.org · Invited · expires 27 Nov  Resend · Cancel
  Assigned student (roster)                 [Viewer ▾] Remove

General access
  [Anyone with the link ▾]  can  [View ▾]
  cleffy.io/s#…k3Q   [Copy link]
  Expires 20 Nov 2026 (in 7 days)  [Renew ▾]  ·  Reset link
  ● 3 people viewing now

Older links (2)        ← only while legacy links are still active
  view · …a9Zq · Expires in 3 days · 1 joined   Copy · Revoke
```

- **General access** is one link per score: Restricted, or "Anyone with the
  link" with View or Edit. Switching to Restricted revokes the link. Reset link
  revokes it and issues a new token. View vs Edit changes the role on the same
  link.
- **Older links** lists the multi-link `share_links` rows created before this
  ships. They can be copied and revoked, but not created. The section
  disappears once none are active. See Decision D2.
- Only the owner manages sharing. This keeps today's rule
  (`20260801160754_rls.sql:61-65`) and Google's "editors can share" is not
  copied (Decision D6). Editors keep their read-only view of the member list
  (`20261007120000_sharing_access_control.sql:255-258`).

---

## 3. User flows

The link is a bearer credential, so a **peer-sent** link (a student forwards the
teacher's link to a friend, or a non-teacher owner shares with a peer) runs
exactly like a teacher-sent one. The only difference is who the owner sees in
presence and in "People with access". The owner is whoever owns the score:
teachers, adult students and any registered account.

New URL: `/s#<token>`. The token is in the fragment, so it is never sent to
Vercel or Supabase, and it isn't in a Referer header. #98 kept the token in the
fragment for the same reason (`@98:src/view/viewToken.ts:7-22`). Old
`/join/<token>` links keep working: the route moves the token into the fragment
with `history.replaceState` and runs the same flow. Vercel will have already
logged the old path, as it does today.

### 3.1 Anyone with the link, Viewer

| Visitor | Flow |
| --- | --- |
| **Signed out** (any device, any age) | `/s#t` → the app boots without SW registration, attribution or web events (§8.4) → `POST share-session {token}` → `{state:'live', role:'viewer', session_jwt, exp, doc, pdf_url, link_expires_at}` → the score renders read-only, with a "View only" badge, the title and a presence bar. Live ink arrives on `doc:{id}` and saved marks on `doc-view:{id}`. Nothing is written to localStorage, sessionStorage, IndexedDB, Cache Storage or cookies. The token renews in memory about every 8 minutes while the tab is open. Closing the tab ends everything. |
| **Signed in** (registered, guest or roster student) | Recommended: redeem as today, giving a viewer membership, adding the score to their library, and showing their name in presence. This is the tested path (`JoinPage.tsx:91-117`). Alternative (Decision D3): open as an ephemeral viewer like a signed-out visitor. |
| **The owner, opening their own link** | Redeem is a no-op, then `/doc/:id` (today's behaviour). |
| **Dead link** | One of these messages, with no score: revoked ("The owner turned off this link."), expired ("This link expired on 20 Nov 2026. Ask the owner to renew it."), invalid ("This link doesn't work. Check you copied all of it."), unavailable (archived or taken down: "This score isn't available right now."). |
| **Busy** | Too many viewers, or rate-limited: "Lots of people are opening this score. Trying again in 8 s…" with a countdown and a "Try now" button. The score stays on screen if it was already loaded. |
| **Revoked while open** | Within about 2 s (rotation hint and jitter, `realtimeChannel.ts:112-121`) the score and its marks are cleared from memory and replaced by the revoked message. |

### 3.2 Anyone with the link, Editor

| Visitor | Flow |
| --- | --- |
| **Signed out** | `/s#t` → `share-session` returns `{state:'live', role:'editor'}` and mints nothing → a "Join to edit" card: "Your name (optional)", **Continue**, and "Continue without a name". There is no age screen. → `signInAnonymously({data:{display_name?, age_gate:{source:'link_guest',v:2}}})` → `redeem_share_link` → `/doc/:id` with editing on. Presence shows the name, or "Anonymous <animal>". This is a normal guest from here on: the session is persisted on the device so they can come back, and there is the offline outbox. |
| **Signed in** | Redeem as today. An existing viewer membership is lifted to editor (`20261022120200_realtime_archive_recovery.sql:118-127`). |
| **Guest later wants an account** | The guest → account upgrade (`UpgradeBanner`, `guest-email-start/confirm`) now asks the age screen first. It is an account registration, so the age gate applies there (§7). |
| **Link turned to View while they edit** | Link-sourced editors are demoted to viewer, the realtime rotation runs, and they rejoin as viewers. This is the existing downgrade path (`20261022120000_realtime_revocation_rotation.sql:146-150`). Their banner reads "Your access changed to view only." |
| **Link revoked** | Link-sourced members are removed (D4) and the rotation runs. The app already handles "removed" (`ViewerPage.tsx:196`, `AccessLoss`). |

### 3.3 Specific people (invite by email)

| Case | Flow |
| --- | --- |
| **Email has a registered account** | The owner types an email and a role → `share-invite` Edge Function → membership added at once, with a role lock so later link redeems don't change it (`document_member_role_locks`, used at `20261022120200_realtime_archive_recovery.sql:109-115`) → a notification email: "Max shared "Für Elise" with you" linking to `/doc/:id`. |
| **No account** | A `document_invites` row is created (pending, 14 days) and an email is sent with `/invite#<token>`. The recipient opens it, sees "Max invited you to "Für Elise" as an editor", then the age screen, then "Choose a password" with the email shown and locked. `share-invite-accept` creates the user through the admin API with `email_confirm:true` (receiving the email proves the address) and the `age_gate` from the screen, adds the membership, and marks the invite accepted. The client signs in and opens `/doc/:id`. If the age screen refuses, no account is made and the invite stays pending, so the owner can cancel it. |
| **No account, already signed in as someone else** | "This invite is for a…@example.org. Sign out to accept it." |
| **Account created meanwhile** | Accept asks them to sign in, then attaches the invite. |
| **Email belongs to a roster (managed) student** | Refused unless the inviter is that student's teacher. The teacher is pointed to Assign instead (D7). |
| **Owner cancels or changes role** | Pending: the row is updated or revoked. Accepted: an ordinary member, managed like today. |
| **Roster students** | Unchanged: assignments, `student-provision`, code login. |

Max suggested auto-creating the account at invite time and setting the password
on first sign-in. That doesn't work cleanly here, for three reasons. The age gate
refuses any new auth user without an `age_gate`, and the inviter can't attest a
stranger's age (`20261111170000_age_gate_auth_users_insert.sql:21-57`). It would
create accounts, which are personal data, for people who never accepted. And it
would turn a stranger's address into a login without their consent. The pending
invite plus account-on-accept gives the same one-click feel (Decision D5).

---

## 4. What each path collects, where it goes, how long it stays

| Who | Stored in Cleffy's database | Seen by processors | On the device | Retention |
| --- | --- | --- | --- | --- |
| **Link viewer** (no account) | Nothing about the viewer. The rate-limit bucket is keyed by link id, never by IP (rows in `edge_rate_buckets`, purged daily: `20261021120300_retention_jobs.sql:194`). | **Vercel**: the page and assets, IP in runtime logs. **Supabase**: the Edge Function (mint and renew), Realtime websocket, PostgREST RPCs and Storage (the PDF through a 5-minute signed URL). The IP is in their logs. Presence state (a random key, "Anonymous <animal>", page number, colour) lives in Realtime memory only. | Nothing. Memory only, no SW registration, no attribution or web events. | Gone when the tab closes. Supabase logs about 7 days (as #98's retention doc, `@98:docs/CHILDREN_DATA_RETENTION.md:34`, to be re-checked). Vercel runtime logs 1 h on the current plan (same row). |
| **Link editor** (guest) | `auth.users` row: `is_anonymous`, optional `display_name`, `age_gate:{source:'link_guest'}`, timestamps. GoTrue sessions and refresh tokens. GoTrue's audit log, which holds the IP **(spike: confirm on the hosted project)**. `document_members` and `share_link_redemptions`. Their marks (`annotations.created_by`). | As above, plus GoTrue. | The normal app: Supabase session in localStorage plus the restore cookie (`src/features/auth/authStorage.ts:1-16`), the Dexie caches (`src/sync/db.ts:218-240`), and the service worker. | Deleted after **30 days** idle (proposed, down from 90: `20261021120500_retention_recheck_under_lock.sql:100-135`, D8) or on "Delete guest profile". Marks stay on the score, no longer attributed, as today (`privacyPolicy.ts:327`). |
| **Invited person, pending** | `document_invites`: the email, the role, who invited them, a token hash, dates. | Resend (the email). | Nothing. | Deleted 30 days after accept, cancel or expiry (expiry is 14 days). |
| **Invited person, accepted** | A normal account (email, password hash, age_gate, display name) and membership. | As any account. | As any account. | Privacy Policy account terms. |
| **Owner** | `share_links` (token, role, expiry, revoked), `document_invites`. | — | — | Revoked or expired links deleted 30 days later (new cron, ported from #98's `view_links_retention_purge`, `@98:supabase/migrations/20261112130000_view_links.sql:359-387`). Today nothing purges `share_links` (COMPARE.md, retention row). |

---

## 5. Realtime for no-account viewers: the mechanism

### Options

| Option | Verdict |
| --- | --- |
| **A. Server-minted, short-lived JWT with `role: anon` and a scoped claim** | **Pick.** |
| B. Supabase anonymous session kept in memory | Rejected. Every view creates an `auth.users` row, so "nothing persisted" means building a purge. It counts toward billed MAU. Anonymous sign-in is limited per IP (30/hour locally, `supabase/config.toml:247-248`), so a classroom behind one NAT stops at about 30. The age gate refuses guests without an `age_gate` (`20261111170000:21-57`), so every anonymous user would need an exemption. Turning captcha on (`config.toml:258-296`) would put a challenge in front of every viewer. |
| C. #98's polling proxy | Rejected by Max. It has no in-progress ink, lags 2.5 s, and is a second stack to keep. |
| D. A server relay (Edge Function SSE or websocket fan-out) | Rejected. Edge Function wall-clock limits, and it re-implements Realtime. |
| E. A public (non-private) channel with a secret topic name | Rejected. Public channels have no RLS, so any viewer could broadcast forged ink to the others. The owner's client would also have to send every ink batch twice. |

### Why A works with what is already there

- Realtime policies are evaluated at join and again when the client hands over a
  new token (`20261020150100_takedown_realtime_topics.sql:4-9`). A short token
  that only renews while the link is live therefore re-checks access at every
  renewal.
- The generation rotation already kicks people off live. Only the current
  generation is admitted, so a revoked viewer is refused on the new topics, and
  whatever stays on the old ones hears nobody
  (`20261022120000_realtime_revocation_rotation.sql:21-28`).
- Using `role: anon` keeps the blast radius small. Every existing table policy
  and member RPC is granted `to authenticated`, so the viewer token reaches
  nothing it isn't explicitly given. Today the only function granted to anon is
  `peek_share_link` (`20261009120200:134-136`), and PR 1 re-checks that list in
  `tests/security/functionGrants.test.ts`.
- No `sub` claim. `auth.uid()` stays null, so no existing policy or `SECURITY
  DEFINER` function can mistake a viewer for a user.

### The token

```jsonc
{
  "iss": "cleffy-share",            // checked by link_view_document(); not a GoTrue token
  "role": "anon",
  "aud": "authenticated",           // (spike) match what PostgREST and Realtime expect
  "iat": 1763030000,
  "exp": 1763030600,                // 10 minutes
  "cleffy_link": { "doc": "<document uuid>", "link": "<share_links.id uuid>", "v": 1 }
}
```

- **Minted by** the new Edge Function `share-session` (`verify_jwt = false`,
  called with the anon key only). It takes `{token}` in a POST body capped at 1
  KB, like `@98:api/view.ts:94-107`.
  1. Rate limit (§5.2).
  2. Look up the link through the service-role RPC `share_session_resolve(token)`,
     which returns `live` / `revoked` / `expired` / `invalid` / `unavailable`,
     plus the link id, document, role and `expires_at`.
  3. If `live` and the role is viewer: sign the JWT and create a 5-minute signed
     URL for the PDF.
  4. Return `{state, role, session_jwt?, exp?, doc:{id,title,page_count,content_rev}, pdf_url?, link_expires_at}`.
- **Signing key (spike, then Decision D9).** The local stack uses the HS256
  project secret (`supabase/config.toml:201-205`, `signing_keys_path`
  commented out). If the hosted project is the same, store it as an Edge
  Function secret `SHARE_JWT_SECRET`. That is no new class of risk: Edge
  Functions already hold `SUPABASE_SERVICE_ROLE_KEY`
  (`supabase/functions/_shared/rateLimit.ts:30-40`), which is just as powerful.
  If the project is on asymmetric signing keys, import a dedicated ES256 key and
  sign with it. Which of the two applies can only be checked on the dashboard;
  that is Max's step, not an agent's.
- **Held in memory** by a link-only Supabase client:
  `createClient(url, anonKey, { accessToken: async () => current.jwt, auth: { persistSession: false } })`.
  supabase-js then sends the token to PostgREST and to Realtime (spike: confirm
  Realtime picks up a renewed token through `setAuth` on heartbeat). A renewal
  timer re-mints at 80% of the token's life. On `visibilitychange`, it renews at
  once if the token has less than 2 minutes left.
- **Expiry of the link itself.** The client sets a timer for
  `link_expires_at`. When it fires, it asks `link_view_access()`, which answers
  `expired`, and the score clears. Renewals are refused after expiry anyway, so
  a viewer that ignores the timer is out within 10 minutes.

### 5.1 What the viewer joins

| Topic | Viewer may | Why |
| --- | --- | --- |
| `doc:{id}[:{n}]` | **read broadcast** (live `ink:progress`, `topic_rotated`, membership hints); **send presence** | In-progress ink, the same as editors get. An ink message carries `strokeId, userId, page, kind, color, w, pts` and no names (`src/sync/wire.ts:30-44`). |
| `doc:{id}[:{n}]` | **not** read presence; **not** send broadcast | Viewers don't see who else is there. A forwarded link must not show children's names to whoever holds it. Viewers can't forge ink (spike: Realtime checks presence read and write separately; if it can't, see risk R5). |
| `doc-db:{id}[:{n}]` | nothing | Those are full `annotations` rows, including `created_by` and the payload of erased marks (COMPARE.md, rows on fields and tombstones). |
| **new** `doc-view:{id}[:{n}]` | **read broadcast** | Saved marks with only the fields needed to draw them, and tombstones as `{id, seq, deleted:true}`. Sent by the annotation trigger only while the score has a live "anyone, viewer" link (§6.4). |

Initial load and gap-fill use the RPC `link_view_snapshot(p_since, p_limit)`
(granted to anon). It is #98's `view_link_poll` (`@98:...view_links.sql:283-336`)
with the link taken from the JWT claim instead of a token argument, and the same
whitelist (`view_mark_for_viewer`, `@98:...view_links.sql:225-273`).

### 5.2 Rate limits and visible state

- `share-session` uses `_shared/rateLimit.ts`, failing closed as #98 did
  (`supabase/functions/_shared/rateLimit.ts:79-82`). Two
  buckets, both keyed by a hash of the link id, never by IP:
  - `share-mint:<link>`: 120 per minute (a class arriving at once).
  - `share-viewers:<link>`: about 40 per 10 minutes. Each open viewer renews
    about once per 8 minutes, so this approximates "at most about 40 people
    watching" (D10). Over the cap: 429 with `{reason:'too_many_viewers', retry_after}`.
- The client shows every 429 (§3.1, Busy) with a countdown. A loaded score stays
  on screen and only renewal is retried, so the token's remaining life is the
  grace period. This fixes the #98 finding that a 429 showed nothing
  (`@98:src/view/ViewApp.tsx:94-97`).
- Realtime's own "too many messages" handling (`realtimeChannel.ts:40-95`,
  `DEPLOY.md:4217-4240`) is reused as is, and its state shows as "Live updates
  paused, catching up…".

---

## 6. Schema and migrations (PR 1)

New migration files, sorted after `20261112120000_web_events.sql`:

### 6.1 `…_share_v2_links.sql`

```sql
alter table public.share_links
    add column if not exists id uuid not null default gen_random_uuid(),
    add column if not exists general boolean not null default false,   -- the score's one "General access" link
    add column if not exists updated_at timestamptz not null default now();
create unique index if not exists share_links_id on public.share_links (id);
create unique index if not exists share_links_one_general
    on public.share_links (document_id) where general and revoked_at is null;
```

- **Existing rows** become `general = false`, the "Older links". Their behaviour
  doesn't change. A legacy viewer link opened by a signed-out visitor takes the
  new viewer path; a legacy editor link takes the new guest path. No backfill
  picks a "general" link for you (D2).
- **Owner RPCs**, all `SECURITY DEFINER`, with the owner check from
  `revoke_share_link` (`20261007120000:478-488`) and the refusals from #98's
  `view_link_assert_owner` (not a guest, not a roster student, live score;
  `@98:...view_links.sql:108-125`):
  - `set_general_access(p_document, p_mode 'restricted'|'anyone', p_role, p_expiry interval|null)`
    creates, updates or revokes the general link. A role change from editor to
    viewer demotes link-sourced editors (`share_link_redemptions` for that token)
    the same way `revoke_share_link` re-roles them (`20261007120000:510-535`).
  - `reset_general_link(p_document)`: revoke and recreate, returns the new token.
  - `renew_share_link(p_link uuid, p_expiry)`: sets a new `expires_at`. An
    expired general link becomes live again.
  - `revoke_share_link`: keeps its signature. Revoking a general link always
    withdraws link-sourced members (D4).
- **Live kick.** Every path that ends or narrows a link (revoke, reset, a role
  drop, Restricted) calls `queue_document_realtime_rotation(doc)`
  (`20261022120000:66-74`). One commit gives one rotation. Membership deletes and
  downgrades already queue through the existing triggers
  (`20261022120000:125-150`).
- **Error split.** `peek_share_link` returns `state text`
  ('live'|'revoked'|'expired'|'invalid'|'unavailable') next to `valid` and
  `role`, so old clients keep working. `redeem_share_link` puts the same code in
  its `detail` (`shareService.ts:186-189` keeps matching `invalid_share_link`).
  The old "one answer to stop probing" reasoning
  (`20261022120200:91-97`) doesn't hold for a 128-bit token: only someone who
  already had a token learns whether it was revoked or has expired.
- **Retention.** A new cron `retention-share-links` deletes rows revoked or
  expired more than 30 days ago, cascading to `share_link_redemptions`
  (`20261007120000:51-64`). It is ported from #98's purge
  (`@98:...view_links.sql:353-387`).

### 6.2 `…_share_v2_viewer_auth.sql`

```sql
-- The score a valid viewer token is for, or null. Fresh on every call.
create or replace function public.link_view_document () returns uuid
language sql stable security definer set search_path = '' as $$
    select sl.document_id
    from public.share_links sl
    where current_setting('role', true) = 'anon'
      and (auth.jwt() ->> 'iss') = 'cleffy-share'
      and (auth.jwt() -> 'cleffy_link' ->> 'link') ~ '^[0-9a-f-]{36}$'
      and sl.id = (auth.jwt() -> 'cleffy_link' ->> 'link')::uuid
      and sl.document_id::text = (auth.jwt() -> 'cleffy_link' ->> 'doc')
      and sl.role = 'viewer'
      and sl.revoked_at is null
      and (sl.expires_at is null or sl.expires_at > now())
      and public.link_view_document_live (sl.document_id);    -- #98's predicate (view_links.sql:85-99), renamed
$$;
revoke all on function public.link_view_document () from public, authenticated;
grant execute on function public.link_view_document () to anon;
```

- `link_view_document_live(doc)` is #98's `view_link_document_live`: not
  archived, and no live takedown of any kind. It is stricter than
  `document_role()`, which still lets a restricted score's owner in
  (`20261020150000:967-985`).
- `link_view_access()` (anon) returns `{status:'open', epoch, doc, link_expires_at}`
  or `{status:'revoked'|'expired'|'unavailable'}`. It reads the claim's link row
  directly, so it can tell the reasons apart. It is the viewer's
  `fetchTopicEpoch` (`realtimeChannel.ts:211-215,278-306`).
- `link_view_snapshot(p_since bigint, p_limit int)` (anon) returns
  `{doc:{title,page_count,content_rev}, marks:[…whitelisted…], max_seq, more}`.
  It refuses with `PT403` and `detail {"code":"<state>"}` when
  `link_view_document()` is null.
- `link_view_mark(...)` is #98's `view_mark_for_viewer`, kept as is (whitelist
  and tombstone shape).
- **Age gate.** `age_gate_problem` (`20261111180000:31-55`) also accepts
  `{"source":"link_guest","v":2}` **only when the new user is anonymous**. The
  trigger checks `new.is_anonymous`; the hook checks
  `event->'user'->>'is_anonymous'` (spike: confirm GoTrue sends it). A
  `link_guest` gate on a non-anonymous user is refused, and so is a guest
  upgrade while the gate still says `link_guest` (§7).
- **Guest retention.** `retention_purge_stale_guests` takes a second idle window
  for `age_gate.source = 'link_guest'` guests: 30 days (D8). Older guests keep
  90 days (`20261021120500:100-135`).

### 6.3 Realtime policies (same migration)

Added beside the `authenticated` policies, which stay as they are
(`20260801162310:51-67`, `20261007120101:53-56`). Policies are permissive per
role, so these touch nothing for members.

```sql
-- 'doc' or 'doc-view' at the CURRENT generation, for the token's score; null otherwise.
create or replace function public.link_view_topic_ok (topic text, prefix text) returns boolean
language sql stable security definer set search_path = '' as $$
    select public.realtime_topic_document (topic, prefix) is not null
       and public.realtime_topic_document (topic, prefix) = public.link_view_document ();
$$;

create policy link_view_receive on realtime.messages for select to anon
using (
    realtime.messages.extension = 'broadcast'
    and (public.link_view_topic_ok (realtime.topic (), 'doc')
         or public.link_view_topic_ok (realtime.topic (), 'doc-view'))
);

create policy link_view_presence on realtime.messages for insert to anon
with check (
    realtime.messages.extension = 'presence'
    and public.link_view_topic_ok (realtime.topic (), 'doc')
);
-- No anon policy on doc-db:*, no anon broadcast insert anywhere.
```

- Members: `topic_document_role` (`20261022120100:264-277`) is unchanged, and
  members may also read `doc-view:*` through a one-line addition to
  `doc_topic_receive` (harmless; the app doesn't join it).
- Viewers' presence is spoofable: the payload is client-asserted. See R4.

### 6.4 Fan-out to `doc-view` (same migration)

- `document_view_topic(doc)` is the `doc-view` twin of `document_db_topic`
  (`20261020150100:76-95`).
- `broadcast_annotation_changes` (`20261020150100:293-310`) adds:
  `if exists (active general viewer link for new.document_id) then perform realtime.send(link_view_mark(new…), 'mark', document_view_topic(new.document_id), true)`.
  That is an index probe on `share_links_one_general`. Scores without a viewer
  link pay nothing extra.
- `broadcast_document_changes` (PDF replaced) sends `{content_rev}` on
  `doc-view` as well. The viewer then asks `share-session` for a fresh
  `pdf_url`.
- `rotate_document_realtime` (`20261020150100:193-222`) also sends
  `topic_rotated` on the old `doc-view` topic.

### 6.5 `…_share_v2_invites.sql`

```sql
create table public.document_invites (
    id uuid primary key default gen_random_uuid(),
    document_id uuid not null references public.documents (id) on delete cascade,
    email text not null check (email = lower(btrim(email)) and length(email) <= 320),
    role text not null check (role in ('viewer', 'editor')),
    invited_by uuid not null references auth.users (id) on delete cascade,
    token_hash bytea not null unique,         -- sha256 of a 32-byte random token; the token only goes in the email
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '14 days',
    accepted_at timestamptz, accepted_by uuid references auth.users (id) on delete set null,
    revoked_at timestamptz
);
create unique index document_invites_one_pending on public.document_invites (document_id, email)
    where accepted_at is null and revoked_at is null;
-- RLS on; owner may SELECT their score's invites; no client writes (Edge Functions use service role).
```

- Edge Function `share-invite`: authenticated as the owner. It checks ownership
  under the caller's JWT, refuses roster-student emails unless the caller is
  their teacher (D7), applies the mail budget (`_shared/mailBudget.ts`), adds a
  membership with a role lock for existing accounts, or creates the invite, and
  sends the email through `_shared/resendDelivery.ts`. It also handles Resend
  and Cancel.
- Edge Function `share-invite-accept`: `peek` returns the score title, the
  inviter's display name, the role and a masked email. `accept` either attaches
  the invite to the signed-in account (if the email matches), or creates the
  account with the admin API (`email_confirm:true`, `age_gate` from the screen,
  password checked with `_shared/passwordPolicy.ts`). The age-gate trigger is
  the backstop (`20261111170000:25-57`).
- The cron `retention-share-invites` deletes rows 30 days after accept, revoke
  or expiry.

### 6.6 #98's `view_links`

#98 isn't merged and `dev` has no `view_links`, so there is nothing to migrate.
If anyone applied #98's migration by hand to a local or dev database, the first
v2 migration should also run `select cron.unschedule('retention-view-links')`
(if it exists) and `drop table if exists public.view_links cascade`, and drop
the `view_link_*` / `*_view_link` functions. All of these are no-ops on a
database that never had them.

---

## 7. Age screen

- **Removed** from both link paths: the viewer path never asks, and the editor
  path drops it from `JoinPage.tsx:168-171`.
- **Kept** wherever an account with an email is created:
  `RegisterPage.tsx:47`, accepting an invite (§3.3), and a **guest → account
  upgrade**. Today the upgrade relies on the age screen the guest saw at join,
  and neither `guest-email-start` nor `guest-email-confirm` checks age (`grep
  age_gate supabase/functions/_shared/guestEmail.ts` finds nothing). In v2,
  `UpgradeBanner` shows the age screen first and sends the result. The confirm
  step writes it to `user_metadata.age_gate` before clearing `is_anonymous`, and
  refuses if the gate is still `link_guest`.
- **Roster students** are unchanged: the teacher's attestation through
  `student-provision`.
- **COPPA consequence.** A child can now open a view link (nothing is collected)
  and can become a link guest who types a name (a name is collected). That is a
  deliberate change from "under-13s have no guest accounts"
  (`privacyPolicy.ts:261`, `childrenNotice.ts:64`). See R7.

---

## 8. Client: reuse the real viewer

### 8.1 New route and component

- `/s` → `LinkViewerPage` (lazy chunk). It renders the same pieces as
  `CloudViewer`: the header with title, "View only" badge (`ViewerPage.tsx:952-962`),
  `PresenceBar` (`ViewerPage.tsx:949`) and `PdfViewport readOnly`
  (`PdfViewport.tsx:194-235`). It leaves out the library, play-along, notes,
  export, history restore, `UpgradeBanner` and `ShareDialog`.
- **Backend injection.** `PdfViewport` reads `db` and `supabase` from a new
  `ViewerBackendContext` instead of calling `getDb()` / `getSupabase()`
  (`PdfViewport.tsx:305,1093-1094,1103,1137`). The defaults are the singletons,
  so the member viewer doesn't change.
  - `db`: a `ScribblerDb` built on an in-memory IndexedDB (`fake-indexeddb`,
    already a devDependency at `package.json:64`, moved to `dependencies` and
    loaded only in the `/s` chunk), passed through Dexie's `indexedDB` /
    `IDBKeyRange` options. `AnnotationStore` (`src/sync/annotationStore.ts:123-126`)
    works unchanged and nothing reaches real storage. The alternative, a
    persistence interface inside `AnnotationStore`, is a bigger refactor of a
    hot file. Not recommended.
  - `supabase`: the link client from §5.
- **Sync.** `sync.mode: 'link-viewer'` in `PdfViewport` swaps `SyncEngine` for a
  small `LinkViewSync`. It pulls `link_view_snapshot`, applies marks from
  `doc-view` (the `mark` event) through `store.applyRemoteBatch`, and keeps
  tombstones so an older row can't bring a mark back (ported from
  `@98:src/view/viewLinkClient.ts:120-144`). `DocRealtimeChannel` is reused with
  `fetchTopicEpoch` = `link_view_access()`, and gets one option,
  `dbTopic: 'doc-view'`. Ink publishing stays off because `canWrite` is false
  (`PdfViewport.tsx:1139-1141`).
- **PDF.** `fetch(pdf_url)` into an `ArrayBuffer` in memory, with no
  `cacheDocumentBytes` (compare `ViewerPage.tsx:770-773`).
- **Presence.** Self is `{userId: crypto.randomUUID(), name: 'Anonymous ' + animalFor(id), isAnonymous: true, via: 'link', page, color}`.
  `presenceSchema` gains an optional `via` (`src/sync/wire.ts:196-202`).
  `safePresenceName`'s fallback "Guest" becomes "Anonymous <animal>" for
  anonymous peers (`src/lib/presenceName.ts:24-30`). The animal is derived
  deterministically from the id, from a fixed list of about 60 animals.

### 8.2 Owner-side presence and viewer count

- `ViewerPage` passes `peers` (`ViewerPage.tsx:226`) to `ShareDialog`, which
  shows "● N viewing now" under General access (the count of `via:'link'` peers).
- The owner and editors label any presence entry whose `userId` is not in
  `list_document_members` as "Anonymous <animal>", whatever name it claims. This
  limits spoofing (R4).

### 8.3 Join / editor path

`JoinPage` becomes `ShareLinkPage` for `/s` and `/join/:token`. It asks
`share-session`, branches by role, and shows the split dead-link and busy
states. The editor card has an optional name and no `AgeScreen`; the
`TurnstileField` stays (`JoinPage.tsx:52-66,210`). The "delete the guest we just
made if the link died" logic is kept (`JoinPage.tsx:98-112`).

### 8.4 Boot on `/s` leaves nothing behind

- `src/main.tsx`: when `location.pathname` is `/s` (or `/join/…`), skip
  `captureAttribution()` (`:28`) and `registerServiceWorker()` (`:44`).
  `webEvents` already excludes `/join` and `/v` (`src/lib/webEvents.ts:42`); add
  `/s` and `/invite`. Sentry only reports when a DSN is built in; it gets no user
  for a link session.
- The children's privacy link on `/s` is a client-side `<Link>`, so the SPA
  navigates without a reload, the boot-time skip still holds, and no SW is ever
  registered. This closes the #98 finding (`@98:src/view/ViewApp.tsx:157-164`).
- A device that already has the app's SW (for example the teacher's own) still
  has it. That is fine: it's their app. The viewer chunk still writes nothing.

### 8.5 Files at a glance

| Reuse (changed) | Why |
| --- | --- |
| `src/features/viewer/PdfViewport.tsx:194-235,305,1089-1170` | backend context, `link-viewer` sync mode |
| `src/sync/realtimeChannel.ts:180-306,790-800` | configurable db topic; viewer `fetchTopicEpoch` |
| `src/sync/wire.ts:196-202`, `src/lib/presenceName.ts` | `via`, anonymous animals |
| `src/features/viewer/presence/PresenceBar` | shows the viewer count chip |
| `src/features/share/ShareDialog.tsx` (whole owner section) | new General access, People, Invite, Older links |
| `src/features/share/shareService.ts:4-233` | new RPCs; `shareUrlFor` → `/s#` (`:231-233`) |
| `src/features/share/JoinPage.tsx` → `ShareLinkPage.tsx` | the flows in §3 |
| `src/features/auth/UpgradeBanner.tsx:41,291` | age screen before upgrade; banner only for guests who can write (demo finding: it shows on view-only members) |
| `src/app/routes.tsx:247-253` | add `/s`, `/invite`; keep `/join/:token` |
| `src/main.tsx:26-44`, `src/lib/webEvents.ts:42` | boot skips |
| `src/ui/classNames.ts:44-56` | `fieldClassName` width option (§9) |
| `src/lib/features.ts:22-23` | `viewLinks` replaced by `shareV2` |

| New | |
| --- | --- |
| `src/features/share/LinkViewerPage.tsx`, `linkSession.ts` (mint, renew, link client), `LinkViewSync.ts`, `InvitePage.tsx`, `anonymousAnimals.ts` | |
| `supabase/functions/share-session/`, `share-invite/`, `share-invite-accept/`; `_shared/shareSession.ts` (JWT signing) | |
| migrations in §6; `tests/sql/share_v2.sql` | |

| Delete / don't carry over from #98 (nothing to delete on dev) | |
| --- | --- |
| `api/view.ts`, `view.html`, `src/view/*` (`ViewApp`, `ViewScore`, `viewLinkClient`, `viewToken`, `main`) | separate stack |
| `supabase/functions/view-link/`, `_shared/viewLink.ts`, `config.toml` `[functions.view-link]` and `VIEW_*` secrets | proxy path |
| `supabase/migrations/20261112130000_view_links.sql`, `tests/sql/view_links.sql`, `tests/viewLinks/*` | replaced by §6 and §11 |
| `vercel.json` `/v` rewrites and headers; `vite.config.ts` second entry, `viewLinkDevPlugin`, `viewPageHtmlPlugin`, `/v` SW denylist; `tsconfig.json` `api` | no second page |
| `ShareDialog` `ViewLinkSection` (`@98:...ShareDialog.tsx:546-720`) | folded into General access |
| `DEPLOY.md` "View links" section | replaced by a "Share v2" section |

---

## 9. What from #98 survives

| #98 piece | Fate |
| --- | --- |
| Mark whitelist `view_mark_for_viewer` (`@98:…view_links.sql:225-273`) and the second copy in the Edge Function (`@98:_shared/viewLink.ts:126-154`) | **Kept** as `link_view_mark`, in SQL only. The Edge Function no longer handles marks. |
| Tombstones `{id,seq,deleted:true}` and keeping them client-side (`@98:viewLinkClient.ts:120-144`) | **Kept** in `LinkViewSync`. |
| `view_link_document_live` (no archive, no takedown of any kind) | **Kept** as `link_view_document_live`. |
| Owner refusals (guest, roster student, dead score) `view_link_assert_owner` | **Kept** in the owner RPCs. |
| Retention purge plus cron (`@98:…:353-387`) | **Kept**, now for `share_links` and `document_invites`. |
| Fail-closed rate limit keyed by link hash, never IP (`@98:_shared/viewLink.ts:14-16,177-181`) | **Kept** in `share-session`. |
| Token in the URL fragment, no-referrer, POST body (`@98:viewToken.ts`, `view.html:8-9`, `viewLinkClient.ts:46-58`) | **Kept**: `/s#`, `Referrer-Policy: no-referrer` on `/s` in `vercel.json`, POST to `share-session`. |
| Memory-only and no-storage tests (`@98:ViewApp.test.tsx:238`, `viewBundle.test.ts`) | **Ported** as LinkViewer tests and an e2e storage check (§11). |
| SW denylist / precache ignores (`@98:vite.config.ts:35-42,366-373`) | **Dropped.** `/s` is the app shell, and not registering is the control (§8.4). |
| 2.5 s polling, `api/view.ts` proxy, `view.html`, `ViewScore` | **Dropped** (Max's decision 2/3). |
| `view_links` table, 90-day fixed expiry, one link per score | **Dropped.** `share_links.general` carries it, and the owner chooses the expiry. |
| Children's notice wording (`@98:childrenNotice.ts:30-35`) | **Reworded** (§10). |

---

## 10. Privacy and legal docs (PR 3)

All new public text appears only when `features.shareV2` is on, the same way
`childrenNotice.ts:20-40` gates view links today ("the notice covers what this
build does"). Bump the versions in `src/features/legal/legalVersions.ts:19-33`
and the `_shared/legalVersions.ts` mirror. Whether a bump needs re-consent is
Max's call (D12).

**Privacy Policy** (`src/features/legal/privacyPolicy.ts`):
- `:101-106`: replace the "join as a guest… name you type" lines with three
  bullets:
  - Viewing by link: "If a score is shared with "anyone with the link" for
    viewing, you can open it without an account. We don't ask you anything and
    don't store anything about you. Our hosting and database providers (Vercel
    and Supabase) process your IP address to deliver the page and keep it
    secure. Their logs keep it for a short time (about 7 days at most). While
    the score is open, others on it see an anonymous viewer, such as
    "Anonymous Otter"."
  - Editing by link: "If the link allows editing, you can add a name or stay
    anonymous. We create a temporary guest profile holding that name (if any)
    and your markings, and delete the profile after 30 days without use. Your
    markings stay on the score."
  - Invites: "If a score owner invites you by email, we store your email
    address and the invitation until you accept it or it expires (14 days),
    then delete it after 30 days."
- `:188-190`: sharing and presence. Add anonymous viewers and the live viewer
  count; the owner sees how many people are viewing, but not who.
- `:261`: "to join a score as a guest, you must be at least 13…" becomes "To
  create an account, you must be at least 13 (or older where…). Opening or
  editing a shared score by link does not create an account; if you later want
  to keep your work in an account, we ask the age question then."
- `:286`: guest retention 90 → 30 days for link guests.

**Children's Privacy Notice** (`src/features/legal/childrenNotice.ts`):
- Replace the `view-links` section (`:20-40`) with "Opening a shared score by
  link". Viewing collects nothing, sets nothing on the device and leaves no
  record. IP processing by Vercel and Supabase, with log windows. The owner sees
  an anonymous count. A link guest who edits may type a name; we suggest a first
  name or nickname, it's optional, and it's deleted after 30 days of inactivity.
  Parents can ask us to delete it at privacy@ (`CHILDREN_DATA_RETENTION.md:43-44`).
- `:64`: drop "or joins a shared score as a guest through a share link" from the
  age-check sentence.
- Keep the "never claim COPPA compliance" test (`childrenNotice.test.ts`).

**`docs/CHILDREN_DATA_RETENTION.md`**:
- `:15-22`: the starting point changes. Link guests no longer pass the age
  screen, so a child can be a link guest.
- Replace rows `:30-33` with: link viewer (nothing; memory only; Realtime
  presence in memory); link guest (auth row, optional name, IP in the GoTrue
  audit log; 30 days idle); `share_links` (30 days after revoke or expiry);
  `document_invites` (30 days after closing); processor logs (Vercel 1 h,
  Supabase about 7 days, Resend per DPA). Remove "only if the signed-URL
  fallback is used": every view now reaches Supabase directly.
- `:46-51`: replace the `view_links` note with "re-read against the v2 schema
  before `VITE_FEATURE_SHARE_V2` is switched on in production".

**`docs/LEGAL_REVIEW.md`**:
- `§4` sub-processors: Resend now also sends invite mail to non-users.
- `§9` minimum age: the age gate now applies to account creation only. Note
  the counsel question in R7.
- `§12`: fix "Anonymous guest accounts… are never cleaned up" (`:190`).
  `retention-stale-guests` exists (`20261021120300_retention_jobs.sql:192`).
  State 30 days for link guests and 90 for the others.
- `§15` cookies and device storage: link viewers store nothing; link guests get
  the normal app storage.
- `§23` (`:299-339`): replace the view-links bullets with the v2 summary and the
  new placeholders.

**In-app copy:** the editor card ("Your name (optional). Shown to others on this
score. Leave it blank to stay anonymous."), a small "What we keep" line on `/s`
linking to the children's notice, the invite email footer ("You got this
because <name> invited this address. Ignore it and we delete the invite in 14
days."), and the `AgreementNote` on the editor card (`JoinPage.tsx:217`).

---

## 11. Test plan

**SQL (`tests/sql/share_v2.sql`, run in the `supabase-local` job), with JWTs
forged locally using the local secret:**
1. A viewer token for doc A: `link_view_snapshot` answers for A. Changing the
   claim to doc B, another link id, an expired link, a revoked link, an archived
   score, a restricted or removed score, or an editor link gives null and the
   right `state`.
2. A viewer token can't `select` from `annotations`, `documents`,
   `document_members`, `share_links` or `storage.objects`, and can't call any
   function granted to `authenticated` (loop over `pg_proc` grants).
3. An `authenticated` token with a forged top-level `cleffy_link` claim gets
   nothing more (the `current_setting('role') = 'anon'` guard).
4. Realtime policies: `set_config('request.jwt.claims', …)` with
   `realtime.topic()` gives select on `doc:`/`doc-view:` for broadcast only, no
   presence select, presence insert on `doc:` only, nothing on `doc-db:`, and
   nothing on an old generation.
5. Revoke, reset, a role drop and Restricted each rotate exactly once per
   commit, and link-sourced members are withdrawn or demoted.
6. `link_view_mark`: #98's whitelist cases (`@98:tests/sql/view_links.sql`),
   including tombstones with no payload.
7. Age gate: a `link_guest` gate is accepted for anonymous users only. A guest
   upgrade with a `link_guest` gate is refused. Invite accept without a gate is
   refused by the trigger.
8. Retention: the share-link and invite purges, and the 30/90-day guest split.
9. Migration replay (`tests/sql/migrations_ordered_replay.sql`) and the explicit
   grants test (`tests/sql/explicit_grants.sql`).

**Edge Functions (Deno, `edge-functions-deno` job):** `share-session` state
mapping, JWT claims and expiry, the body cap, both rate buckets, the switch off
→ 404; `share-invite` ownership, roster refusal, mail budget, existing vs new
email; `share-invite-accept` email match, age gate, the password policy, and an
expired, used or cancelled invite.

**Live Realtime (`tests/live/`, local stack, like `takedownRealtime.live.test.ts`):**
- A viewer with a minted token receives the owner's in-progress ink on `doc:`
  and saved marks on `doc-view:`. It can't send ink, and gets nothing from
  `doc-db:`.
- The owner sees the viewer's presence. The viewer sees no presence (spike
  item).
- Revoke while the viewer is open: the viewer gets `topic_rotated`, is denied,
  and shows "revoked". A modified viewer that ignores the hint receives nothing
  further, and its renewal is refused.
- The token expires without renewal: Realtime drops it (spike: observe the
  exact behaviour).

**Unit and component (vitest):**
- `LinkViewerPage`: each dead state with its message; busy/429 with countdown
  and "Try now"; offline; revoked while open clears the score; link expiry
  timer; renewal schedule.
- A memory-only test: after open, view, renew and close, `localStorage`,
  `sessionStorage`, `indexedDB.databases()`, `caches.keys()` and
  `document.cookie` are empty. Ported from `@98:ViewApp.test.tsx:238`.
- `main.tsx` boot on `/s` doesn't call `registerServiceWorker` or
  `captureAttribution`.
- `ShareDialog`: General access modes, Copy, Reset confirm, Renew showing the
  absolute date, Older links, Invite (existing, new, roster refused),
  pending-invite Resend and Cancel, the live viewer count.
- Name column: assert the member `<select>` class list has no `w-full`, and
  check in the browser at 1440 and 390 with `ui-check`.
- `ShareLinkPage`: editor without a name gets "Anonymous <animal>"; with a name;
  no `AgeScreen` rendered; the Turnstile path; dead-link cleanup of the guest.
- `UpgradeBanner`: the age screen comes before the email step; the banner is
  hidden for view-only members.
- `presenceName`: animals are stable per id; claimed names from non-members are
  ignored on the owner side.

**E2E (Playwright, local stack, `ui-check` viewports):** the teacher creates an
"anyone, view" link; a fresh browser opens it, sees the live stroke while it's
being drawn, and the teacher sees "1 viewing now". Then revoke. Then an editor
link, no name, draws; Restricted demotes. Then an invite to a new email through
Inbucket (`localhost:54424`), accepted with the age screen and a password. Run
on desktop, iPad and phone.

---

## 12. Feature flag and rollout

- **Build flag** `VITE_FEATURE_SHARE_V2` (`src/lib/features.ts`), replacing
  `viewLinks`. When off: the dialog, `/join` and the legal text are exactly as
  today, and `/s` and `/invite` render "This link isn't available."
- **Server switch** `SHARE_V2_ENABLED=1` as an Edge Function secret for
  `share-session`, `share-invite` and `share-invite-accept` (404 when unset), as
  #98 did (`@98:_shared/viewLink.ts:156-165`). The SQL is inert without minted
  tokens and the Edge Functions.
- The migrations ship with PR 1 and reach `dev` on merge. Production gets them
  when `dev` → `main` is merged (`factory.md`, Context: "The Supabase GitHub
  integration deploys migrations on merge to main"). They change nothing
  visible while the switches are off, except two things: the guest-retention
  split, which only matters for `link_guest` users, who can't exist while the
  flag is off; and `peek_share_link`'s extra column, which old clients ignore.
- **Order:** dev on (build flag in the Vercel Preview/dev env, secret on the
  `dev` branch), then Max tests, then counsel review if wanted (D11), then Max
  says go, then prod on. Prod stays OFF until Max says so. **Agents set no
  hosted secrets or env.** Max sets them, as listed in DEPLOY.md.
- **Rollback:** unset the flag and the secret. Open viewers fail their next
  renewal (within 10 minutes) with "isn't available".

---

## 13. Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | **Signing secret exposure.** If `SHARE_JWT_SECRET` is the project JWT secret, a leak can mint any role. | The same class of risk as `SUPABASE_SERVICE_ROLE_KEY`, which every Edge Function already holds. Only `share-session` reads it. Prefer a dedicated imported asymmetric key if the project supports it (D9). |
| R2 | **Viewer token abuse.** A token copied out of memory is a 10-minute read-only pass for one score, the same thing the link itself gives. | Short expiry, scoped claim, re-checked on every request and at renewal. |
| R3 | **Realtime capacity and cost.** Each viewer is 1 connection (Pro: 500 concurrent, `DEPLOY.md:4183`), and each ink batch is billed once per recipient (`DEPLOY.md:4190-4215`). 30 viewers watching a teacher draw roughly multiplies the one-to-one cost by 15. | The per-link viewer cap (§5.2, D10). Ink to viewers follows the existing adaptive throttling (`realtimeChannel.ts:40-95`). `doc-view` sends only when a viewer link is active. Watch Usage for the first weeks; consider an "ink to viewers at pen-up only" mode if needed. |
| R4 | **Presence spoofing.** Payloads are client-asserted, so a viewer could claim a teacher's name. | Viewers can't read presence. The owner and editors label non-members as "Anonymous <animal>" regardless of the claimed name (§8.2). The count could be inflated by one malicious tab per renewal budget, which the viewer cap bounds. |
| R5 | **Realtime might not split presence read from write (spike).** | If it can't, viewers would see presence. Fallback: viewers don't track presence, and the count comes from a `doc:` broadcast heartbeat that viewers may send (one tiny event per 30 s, a broadcast-insert policy for anon limited to the event name `viewer:here`). Realtime authorizes per channel, not per event (`realtimeChannel.ts:246-254`), so a viewer could then also send fake `ink:progress`. Second fallback: let viewers see names, with explicit copy in the notice. Decide after the spike. |
| R6 | **Link leakage.** A forwarded link reaches strangers. | Viewers see no names, the owner sees a live count, Reset link is one click, expiry is shown, and viewer is the default role. |
| R7 | **COPPA / children.** Dropping the age screen from the editor path means an under-13 can become a link guest and type a name. Today's policy says under-13s don't get guest accounts (`privacyPolicy.ts:261`, `childrenNotice.ts:64`). | The name is optional and labelled "first name or nickname". There is no email, contact, profile or tracking. 30-day deletion. Parental deletion by email. A plain notice. This is a legal judgment, not an engineering one: ask counsel whether the internal-operations exception and a "general audience with optional nickname" reading hold (D11). Max has said he accepts the risk; the plan states it plainly. |
| R8 | **Guest-creation abuse** (anonymous editors without an age gate is cheaper). | Turnstile wiring is already in the join path (`JoinPage.tsx:52-66`). The per-IP anonymous sign-in limit stays. A guest can do nothing without a membership: documents insert refuses anonymous users (`20260801160754_rls.sql:36-40`). |
| R9 | **Invite abuse** (spam, or enumerating accounts by email). | Mail budget per owner per day. The response is the same for an existing and a new email ("Invited x@y"). An existing account appears in People with access straight away, which does reveal it, as Google does (D7 note). |
| R10 | **Rotation cost.** Every revoke makes all members rejoin. | Already accepted for member removal (`20261022120000:40-42`). Revoke is rare. |
| R11 | **Viewer misses marks between snapshot and join.** | `LinkViewSync` pulls with `since = max_seq` after `doc-view` joins, as `SyncEngine.noteGap` does for members. |
| R12 | **The `fake-indexeddb` production dependency.** | Loaded only in the `/s` chunk. Pinned version. Bundle size checked in CI with `npm run build`. |

---

## 14. Work packages

**PR 1: Backend and realtime auth** (risky area: migrations, RLS, Edge
Functions; read `supabase-ops` first; high review risk, up to 3 rounds).
0. Spike on the local stack (no hosted access), with results written into the
   PR body:
   - Realtime accepts an anon-role token with a custom claim on a private
     channel.
   - Presence read vs write split.
   - `accessToken` renewal → `setAuth` → policy re-check.
   - Behaviour when the token expires.
   - The `is_anonymous` field in the `before_user_created` payload.
   - PostgREST `aud` handling.
   - The hosted key type, for Max to check on the dashboard (D9).
1. Migrations in §6.1–6.5 and the defensive #98 cleanup in §6.6.
2. Edge Functions `share-session`, `share-invite`, `share-invite-accept`,
   `_shared/shareSession.ts`, and `config.toml` entries.
3. Guest upgrade age check in `guest-email-confirm`.
4. Tests: SQL, Deno, live Realtime, function grants.
5. A DEPLOY.md "Share v2" section: switches, secrets, the cron jobs, the rollout
   steps Max does by hand.

**PR 2: UI and flows** (depends on PR 1 merged to `dev`; touches `src/**/*.tsx`,
so it waits for Max's OK under `hold.paths` in `factory.md`).
1. `ViewerBackendContext`, `LinkViewSync`, `LinkViewerPage`, the realtime
   channel options.
2. `ShareLinkPage` (`/s`, `/join/:token`), `InvitePage` (`/invite`), routes, and
   the boot skips in `main.tsx`.
3. `ShareDialog` rebuild: General access, People with access (with the name
   column fix), Invite, pending invites, Older links, the viewer count, expiry
   date and Renew.
4. Presence: anonymous animals, `via`, the non-member relabel.
5. `UpgradeBanner`: age screen before upgrade; hidden for view-only members.
6. Unit, component and E2E tests; `ui-check` at desktop, iPad and phone.

**PR 3: Privacy and legal docs** (can be drafted in parallel with PR 2, merged
after it, all gated on `features.shareV2`).
1. `privacyPolicy.ts`, `childrenNotice.ts` and their tests; version bumps
   (D12).
2. `docs/CHILDREN_DATA_RETENTION.md`, `docs/LEGAL_REVIEW.md`.
3. In-app copy strings, if not already in PR 2.

The `fieldClassName` name-column fix is a 3-line change that could go out on its
own first as a tiny UI PR, since it's an existing bug. Change
`classNames.ts:44-56` so a caller can ask for `w-auto` without `w-full` (a
`width: 'full' | 'auto'` option), and add `shrink-0` on the select at
`ShareDialog.tsx:398` (and `:272`).

---

## 15. Decisions for Max

| # | Question | Recommendation |
| --- | --- | --- |
| D1 | Close #98 or rework it? | **Close it.** Its architecture (a proxy, polling, a second page) is what this plan replaces. Port the pieces in §9 into PR 1 and PR 2 with credit in the PR bodies. |
| D2 | One "General access" link per score (Google style), or keep several links per score? | **One general link**, with Reset link for leaks. Existing extra links stay working under "Older links" until revoked or expired, with no new ones created. |
| D3 | A signed-in visitor opens a view link: membership (in their library, named), or an anonymous ephemeral viewer? | **Membership**, as today. It keeps the tested path and the "shared with me" behaviour. Signed-out visitors get the ephemeral path. |
| D4 | Revoke or Restricted: always remove the people who joined by that link? | **Yes, always** (Google-like). Drop the checkbox (`ShareDialog.tsx:498-527`). Roster students fall back to their assignment's access as today (`20261007120000:521-535`). Expiry (not revoke) stops new joins and viewer renewals; existing link members keep access until revoke. |
| D5 | Invites to emails with no account: create the account at invite time, or pending invite plus account on accept? | **Pending invite, account on accept** (age screen and password, email pre-verified by the invite). Creating it at invite time fails the age gate and creates accounts for people who never said yes. |
| D6 | Can editors share (invite or change the link)? | **No, owner only**, for now. |
| D7 | Invite to a roster student's email by someone other than their teacher? | **Refuse**, and point the teacher to Assign. |
| D8 | Link-guest idle deletion? | **30 days** (others stay 90). |
| D9 | JWT signing: the project's HS256 secret as an Edge secret, or an imported dedicated asymmetric key? | **Dedicated key if the project is on asymmetric signing keys; otherwise the HS256 secret as `SHARE_JWT_SECRET`.** Max checks Dashboard → JWT Keys and sets the secret. |
| D10 | Cap on simultaneous link viewers per score? | **40**, adjustable without a deploy as an Edge secret. Above it, a friendly "busy" with retry. |
| D11 | Counsel review before prod for the no-age-screen editor path (R7)? | **Yes, a short question to counsel**, but not blocking dev. Max has accepted the risk; the docs say plainly what is collected. |
| D12 | Bump the Privacy Policy and Children's Notice versions (and re-prompt consent)? | **Bump both when the flag goes on in prod.** No re-consent prompt; the change adds disclosures and takes nothing away from users. |
| D13 | Viewers see who else is on the score? | **No.** Viewers see only the score; the owner sees the count. If the spike shows Realtime can't split presence read and write, choose between the heartbeat fallback and letting viewers see names (R5). |
| D14 | Link URL shape? | **`/s#<token>`**. `/join/<token>` keeps working. |
| D15 | Default link expiry? | **7 days**, as now (`shareService.ts:21-22`), with the absolute date shown and one-tap Renew. |

---

## 16. Open items an agent can't settle from the repo

- Hosted JWT key type, the hosted anonymous sign-in limit, the hosted
  `before_user_created` hook payload, and whether hosted GoTrue's audit log
  keeps IPs. These are dashboard reads for Max; agents don't touch hosted
  Supabase.
- Exact Vercel and Supabase log windows on the current plans
  (`CHILDREN_DATA_RETENTION.md:46-49` already says to re-check).
- Realtime behaviours marked (spike), settled at the start of PR 1 on the local
  stack.
