# Share v2, PR 2: UI and flows (plan)

Ticket #105 · PR #108 · branch `factory/issue-105` off `dev` (at `e966a8af`, which includes the #104 backend, merged as #107) · risk high · builder claude-bot · reviewer codex.

This plan covers the part of Share v2 that users see: the Share dialog, the `/s` link viewer, the editor join card, `/invite`, presence relabelling, the `UpgradeBanner` age step, and the name-column fix. Everything sits behind `features.shareV2` (`VITE_FEATURE_SHARE_V2`, off by default). With the flag off, the dialog, `/join` and the viewer run exactly the code they run on `dev` today.

The PR touches `hold.paths` (`src/**/*.tsx`, `src/ui/**`). After APPROVE with green CI it waits for Max's `ok`.

## 1. Where the code is today

These facts come from reading `dev` at `e966a8af`. They constrain the design.

**Viewer**

- `PdfViewport` (`src/features/viewer/PdfViewport.tsx`) uses the module singletons in four places:
    - `new AnnotationStore(getDb(), docId)` at `:305`;
    - `SyncEngine({db: getDb(), api: createSupabaseAnnotationsApi(getSupabase())})` at `:1092-1095`;
    - `DocRealtimeChannel({supabase: getSupabase()})` at `:1102`;
    - `fetchTopicEpoch: () => fetchRealtimeTopicEpoch(getSupabase(), docId)` at `:1137`.
- `installSnapshotRetry()` (`:1125,:1146`) reaches `getDb()` and `getSupabase()` on its own (`history/snapshotService.ts:158,256,276`).
- The sync wiring is one effect (`:1087-1178`) that runs only when the `sync` prop is present. There is no sync "mode".
- Live ink comes in through `onRemoteInk → ink.applyRemoteInk` (`:1112`, `ink/InkController.ts:257`). The publisher is attached only when `canWrite` (`:1139`).
- `PdfViewport` never loads PDF bytes itself. `ViewerPage` gives them to `<PdfProvider data>` (`ViewerPage.tsx:1096`), and `cacheDocumentBytes` happens in `ViewerPage.tsx:773`.
- `ScribblerDb` (`src/sync/db.ts:218,233`) is `constructor(name = 'scribbler')` and cannot take Dexie's `indexedDB`/`IDBKeyRange` options. `getDb()` (`:435`) is a lazy singleton.
- `AnnotationStore.applyRemoteBatch(remotes, pendingIds)` is at `annotationStore.ts:633`.
- `viewerPrefs.ts:40,63,88` writes `localStorage` whenever the page layout, cover page or print-handwriting setting changes.

**Realtime**

- `DocRealtimeChannelOptions` is at `realtimeChannel.ts:180-216`.
    - `openLive` (`:699`) joins the private `doc:` topic: `ink:progress`, `membership`, `topic_rotated` and presence. It parses presence with `presenceSchema` and runs `safePresenceName` (`:739-754`).
    - `openDb` (`:792`) is receive-only on `doc-db:` and expects row-change payloads.
    - `fetchTopicEpoch` returns `TopicEpochRead` (`epoch` | `archived` | `denied` | `failed`, `:229`). On `denied` the channel closes and calls `onMembershipChanged`.
- Rotation hints are spread over `ROTATION_JITTER_MAX_MS = 2000` (`:121`).
- `PresencePeer` is `{userId, name, color, page, isAnonymous}` (`wire.ts:196-204`).
- `safePresenceName(name, isAnonymous)` falls back to "Guest" or "Collaborator" (`src/lib/presenceName.ts`).
- `PresenceBar({peers, selfUserId})` leaves self out of the list.
- `ViewerPage` holds `peers` (`:226`, set at `:853`). The header is at `:943-962` and has a "view only" badge.

**Backend contracts from #104** (`plan.md` on `dev`, PR #107)

- **`share-session`** (`verify_jwt=false`). The request is `{token, renew?}`.
    - Live viewer link: `{state:'live', role:'viewer', session_jwt, exp, doc, pdf_url, link_expires_at}`.
    - Live editor link: `{state:'live', role:'editor', link_expires_at}`.
    - Dead link: `{state}`.
    - Too many requests: 429 `{reason:'rate_limited'|'too_many_viewers', retry_after}`.
    - Not a general link (`share_session_resolve`): `{state:'invalid'}`.
- **Spikes (PR #107 body):**
    - Native presence works: the anon viewer can `track()` and receives **no** presence (D13).
    - `setAuth(newJwt)` keeps a joined channel alive.
    - An expired token closes the channel.
    - PostgREST doesn't need `aud`.
- **Anon RPCs** (as the viewer token):
    - `link_view_access()` returns `{status:'open', epoch, doc, link_expires_at}` or `{status:<state>}`;
    - `link_view_snapshot(p_since, p_limit)` returns `{doc, marks, max_seq, more}`.
    - `mark` events on `doc-view:` carry `link_view_mark` JSON: text marks get `x,y,size,text,hw,font,bold,italic`, other marks get `pts,w,sp`, plus `id, seq, page, kind, color`. A tombstone is `{id, seq, deleted:true}`.
- **Owner RPCs:**
    - `set_general_access(p_document, p_mode, p_role, p_expires_in)`;
    - `reset_general_link`;
    - `renew_share_link(p_link, p_expires_in)`;
    - `revoke_share_link(p_token, p_remove_members)`, where a general link always withdraws its members;
    - `my_share_settings()` and `set_link_guest_retention(p_days)`.
    - A bad expiry raises 22023 `{"code":"invalid_link_expiry"}`. A bad retention raises 22023 `{"code":"invalid_retention_days"}`.
- **`share-invite`**: `{action:'invite'|'resend'|'cancel', document_id, email?, role?, invite_id?}`.
    - Success is `{ok:true}`.
    - Errors: 403 `cannot_invite` (D7), 403 `not_owner`, 422 `invalid_email`, 429 `rate_limited`.
    - The owner reads `document_invites` through an RLS select policy.
- **`share-invite-accept`**:
    - `peek` returns `{state, title, inviter_name, role, email_masked}`.
    - `accept`, signed in: `{ok, document_id}`, or 409 `email_mismatch`.
    - `accept`, signed out: 409 `sign_in_required` (checked **before** the age gate), then 400 `age_check_missing` or 403 `below_consent_age`, then 400 `weak_password`, then `{ok, document_id}`.
    - Dead invites return 410 `{state}`.
- **`ShareLinkRow`** in `src/types/database.ts:204` has no `id` and no `general`. `document_invites` is not typed.

**Join, boot and auth**

- `JoinPage.tsx`:
    - peeks the link (`:75-89`) and shows `AgeScreen purpose="join"` (`:169`) and then a name form with `TurnstileField` (`:52-66,:210`);
    - redeems for any session and navigates to `/doc/:id` (`:91-97`; an owner takes the same path);
    - deletes a guest it created itself when the link has died (`:98-112`).
- `main.tsx` calls `captureAttribution()` (`:28`) and `registerServiceWorker()` (`:44`) on every path.
- `webEvents.ts:42` sets `EXCLUDED_PREFIXES = ['/join','/auth','/v','/student','/assignments']`.
- `scrub.ts:95-99` already cuts `?`/`#` from locations, so a `/s#token` URL reaching Sentry loses the token.
- `UpgradeBanner({isGuest})` goes collapsed → details (email + password) → code. It is mounted at `ViewerPage.tsx:1070` and gets no role.
- `confirmGuestEmailUpgrade` (`guestUpgrade.ts:74`) sends no `age_gate`, but #104 made `guest-email-confirm` ask a link guest for one.
- `AgeScreen.tsx:76` still reads the deprecated `features.viewLinks`.
- `signInAnonymouslyWithName(displayName, captcha, ageGate: AgeGate)` is at `session.ts:227`.
- `AgeGate` is `{country, min_age, source:'self', v:1}`.
- `authRedirect.ts` only honours `next` for `/library` and `/assignments`, so a sign-in on `/invite` has to happen inline. The token is in the fragment.

**UI, tests and CI**

- `fieldClassName(size, extra)` builds `w-full` into the `md`, `sm` and `xs` sizes (`src/ui/classNames.ts:44-56`).
    - Four callers ask for `w-auto` through `extra`: `ShareDialog.tsx:272,398`, `LibraryPage.tsx:1097` and `CountryPicker.tsx:23`.
- **No bundle-size check exists** (not in `package.json`, `ci.yml` or `scripts/`).
- `fake-indexeddb ^6.2.5` is a devDependency used by `src/test/setup.ts`.
- `vite.config.ts` drops gated chunks from the service-worker precache through `GATED_CHUNK_IGNORES` (`:29-32`).
- **No Playwright config or E2E folder exists.**
    - `playwright` is a devDependency.
    - Browser-driven checks live in `tests/live/*.live.test.ts`, which skip unless the local stack is pointed at, and in `scripts/ui/uifuzz.mjs`.
    - CI runs no browser.
    - Mailpit is at `127.0.0.1:54424`.

## 2. Two gaps in the #104 backend, fixed here (each called out in the PR body)

The ticket allows backend changes "only for a bug found while wiring". These two block criteria as written.

1. **`share-invite-accept` never returns the email.** The invitee signs in with the password right after their account is created, but peek returns only a masked address and accept returns `{ok, document_id}`. With no email, the client can't sign them in. That blocks the invite criterion.
    - Fix: the signed-out accept that **created** the account returns `{ok, document_id, email}`. The caller has just proved they hold the token and set the password.
    - Deno test added in `share-invite-accept/handler_test.ts`.
2. **An expired link's date never reaches a signed-out visitor.** `share_session_resolve` returns only `{state, link_id}` for a dead link, so "This link expired on <date>" can't be shown.
    - Fix: a new migration `20261114120000_share_v2_resolve_expiry.sql` (`create or replace`, safe to run twice) adds `link_expires_at` to the `expired` answer only, and `share-session` passes it on as `{state:'expired', expired_at}`.
    - A SQL check goes in `tests/sql/share_v2.sql`, and a Deno test in `share-session/handler_test.ts`.
    - Also: the `\ir` line in `migrations_ordered_replay.sql`, and `apply-migrations.sql` regenerated.
    - Legacy (non-general) links get "This link expired. Ask the owner to renew it." without a date, because `peek_share_link` carries none.

Nothing else under `supabase/` changes.

## 3. Shape

### 3.1 Design twice (architect)

Every candidate was checked against the design red flags: hand-synced lists, mode flags threaded through layers, and callers that have to know an abstraction's internals.

- **A. A mode flag inside `PdfViewport`** (the ticket's literal sketch).
    - A `ViewerBackendContext` carries `{db, supabase, syncMode}`, and `PdfViewport` branches `if (syncMode === 'link-viewer')` inside its sync effect.
    - Lost: `PdfViewport` (1683 lines) would have to know both protocols, and every later sync change would need a matching branch.
- **B. A separate light viewer**, like #98's `ViewScore`. It would draw marks from the snapshot with its own renderer and need no Dexie and no `fake-indexeddb`.
    - Lost: it duplicates the page rendering, the mark painter and live-ink previews. Max said "One system, no duplicated code", and live in-progress ink would have to be written a second time.
- **C. Chosen: an injected backend object.**
    - `ViewerBackendContext` provides a `ViewerBackend` with `db`, `supabase` and one method, `connect()`. `connect()` starts whatever keeps the store in step with the server and returns a handle.
    - The member backend is today's effect body (`SyncEngine` plus `DocRealtimeChannel` plus snapshot retry), moved unchanged.
    - The link backend is `LinkViewSync` plus the same `DocRealtimeChannel` with `dbTopic:'doc-view'`.
    - `PdfViewport` loses its singleton imports and never learns which backend it has. The interface is the narrowest of the three (one method), and a change that looks right from `PdfViewport` is right for both backends.

### 3.2 Usage first

```tsx
// LinkViewerPage (the /s chunk)
const backend = useMemo(() => createLinkViewerBackend(session), [session]); // in-memory Dexie and the link client
<ViewerBackendProvider value={backend}>
    <PdfProvider data={pdfBytes}>
        <PdfViewport
            docId={doc.id}
            readOnly
            sync={{ userId: selfId, name: anonName, isAnonymous: true, canWrite: false, onMembershipChanged }}
        />
    </PdfProvider>
</ViewerBackendProvider>;
// The member viewer passes nothing: the default context is memberBackend (getDb(), getSupabase()).
```

### 3.3 Types and signatures (the sketch implementation fills in)

```ts
// src/features/viewer/ViewerBackendContext.tsx
export interface ViewerSyncArgs {
    docId: string; store: AnnotationStore; ink: InkController;
    self: PresencePeer; canWrite: boolean; isOwner?: boolean;
    callbacks: Pick<PdfViewportSync, 'onStatus'|'onRejected'|'onHeld'|'onPeers'|'onDocReplaced'|'onScoreAnalysis'|'onMembershipChanged'>;
}
export interface ViewerSyncHandle { setPage(page: number): void; stop(): void }
export interface ViewerBackend {
    readonly db: ScribblerDb;
    readonly supabase: TypedSupabaseClient;
    connect(args: ViewerSyncArgs): ViewerSyncHandle;
}
export const memberBackend: ViewerBackend;            // getDb()/getSupabase(); connect = today's :1087-1178 body
export const ViewerBackendProvider: React.Provider<ViewerBackend>;
export const useViewerBackend: () => ViewerBackend;

// src/sync/db.ts
constructor(name = 'scribbler', options?: Pick<DexieOptions, 'indexedDB' | 'IDBKeyRange'>)

// src/sync/realtimeChannel.ts (additions)
dbTopic?: 'doc-db' | 'doc-view';                       // default 'doc-db'
onViewMark?: (mark: LinkViewMark) => void;             // doc-view `mark` events
rotationJitterMaxMs?: number;                          // the link viewer passes 250 so a revoke clears in about 2 s
export const docViewTopic: (docId: string, epoch?: number) => string;

// src/features/share/linkSession.ts
export type ShareSessionAnswer =
    | { kind: 'viewer'; jwt: string; exp: number; doc: LinkDoc; pdfUrl: string; linkExpiresAt: string | null }
    | { kind: 'editor'; linkExpiresAt: string | null }
    | { kind: 'dead'; state: 'revoked' | 'expired' | 'unavailable' | 'invalid'; expiredAt?: string | null }
    | { kind: 'busy'; retryAfterSec: number }
    | { kind: 'failed' };
export function requestShareSession(token: string, renewJwt?: string): Promise<ShareSessionAnswer>; // plain fetch, apikey only, no auth client
export function renewDelayMs(exp: number, nowSec: number): number;   // 80% of a 600 s life
export class LinkSession {                                // all state in memory
    constructor(token: string, first: Extract<ShareSessionAnswer, { kind: 'viewer' }>, on: LinkSessionEvents);
    readonly client: TypedSupabaseClient;                 // createClient(url, anon, { accessToken: () => jwt, auth: { persistSession: false, autoRefreshToken: false } })
    start(): void;                                        // renewal timer plus the visibilitychange rule (< 120 s left)
    dispose(): void;                                      // timers off, jwt dropped
}
export interface LinkSessionEvents { onRenewed(jwt: string): void; onDead(a: Extract<ShareSessionAnswer,{kind:'dead'}>): void; onBusy(retryAfterSec: number): void }

// src/features/share/LinkViewSync.ts
export class LinkViewSync {   // takes SyncEngine's place for a link viewer
    constructor(deps: { client: TypedSupabaseClient; store: AnnotationStore });
    pull(): Promise<void>;                     // link_view_snapshot from max_seq until !more
    applyMark(mark: LinkViewMark): void;       // seq-guarded; tombstones kept (port of #98 mergeAnnotations)
}
export function createLinkViewerBackend(session: LinkSession): ViewerBackend & { dispose(): Promise<void> }; // dispose: db.delete()

// src/features/share/anonymousAnimals.ts
export const ANIMALS: readonly string[];       // about 60 names
export function animalFor(id: string): string; // a stable hash of the id
export function anonymousName(id: string): string; // `Anonymous ${animalFor(id)}`

// src/sync/wire.ts: presenceSchema gains  via: z.literal('link').optional()
// src/lib/presenceName.ts
export function presenceLabel(peer: PresencePeer, members: ReadonlySet<string> | null): string; // R4

// src/features/share/shareService.ts (Share v2 additions; the legacy exports stay for the flag-off dialog)
export type LinkExpiryChoice = '1d' | '7d' | '30d' | '90d' | '365d' | 'never';
export const LINK_EXPIRY_CHOICES_V2: ReadonlyArray<{ value: LinkExpiryChoice; label: string; interval: string | null }>; // the one list for create and Renew
export const DEFAULT_LINK_EXPIRY_V2: LinkExpiryChoice = '7d';
export const LINK_GUEST_RETENTION_CHOICES = [7, 14, 30, 60, 90] as const; export const DEFAULT_LINK_GUEST_RETENTION = 30;
export function linkExpiryText(expiresAt: string | null, now?: Date): string; // "Expires 20 Nov 2026 (in 7 days)" | "Expired on 20 Nov 2026" | "Never expires"
export function loadOwnerSharing(docId: string): Promise<{ general: ShareLinkRow | null; older: ShareLinkRow[] }>;
export function setGeneralAccess(docId: string, mode: 'restricted' | 'anyone', role: ShareRole, expiry: LinkExpiryChoice): Promise<GeneralLink | null>;
export function resetGeneralLink(docId: string): Promise<GeneralLink>;
export function renewLink(linkId: string, expiry: LinkExpiryChoice): Promise<string | null>;
export function listPendingInvites(docId: string): Promise<PendingInvite[]>;
export function inviteByEmail(docId: string, email: string, role: ShareRole): Promise<void>;  // throws ShareError('cannot_invite' | 'rate_limited' | 'invalid_email' | …)
export function resendInvite(docId: string, inviteId: string): Promise<void>;
export function cancelInvite(docId: string, inviteId: string): Promise<void>;
export function getLinkGuestRetention(): Promise<number>;
export function setLinkGuestRetention(days: number): Promise<number>;
export function shareUrlFor(token: string): string;  // flag on: `${origin}/s#${token}`; flag off: `/join/${token}` (unchanged)

// src/ui/classNames.ts
export type FieldWidth = 'full' | 'auto';
export const fieldClassName = (size?: FieldSize, extra?: string, opts?: { width?: FieldWidth }) => string;
```

### 3.4 One owner per decision

| Decision                                                 | Owner                                                                     | Readers                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Which backend the viewer talks to                        | `ViewerBackendContext`                                                    | `PdfViewport` (no singleton imports remain)                       |
| Link liveness and expiry bounds                          | SQL (#104)                                                                | `share-session` → `linkSession.ts`; the UI only shows the answer  |
| Expiry choices (create and Renew)                        | `LINK_EXPIRY_CHOICES_V2`                                                  | General access, Renew, Older links                                |
| Retention choices                                        | `LINK_GUEST_RETENTION_CHOICES`                                            | owner settings row                                                |
| A peer's displayed name                                  | `presenceLabel` (`presenceName.ts`)                                       | `PresenceBar`, the viewer-count chip                              |
| "Anonymous <animal>"                                     | `anonymousAnimals.ts`                                                     | link viewer self presence, editor guests with no name, R4 relabel |
| Is this path a link session (no attribution, SW, events) | `isLinkSessionPath(pathname)` in `src/features/share/linkPaths.ts` (tiny) | `main.tsx`, `webEvents.ts`                                        |
| Dead-link copy                                           | `deadLinkMessage(state, expiredAt)` in `ShareLinkPage.tsx`                | `/s`, `/join`, the link viewer when a link dies while open        |

### 3.5 Flows

**`/s#<token>` and `/join/:token` → `ShareLinkPage`** (flag on). With the flag off, `/join` keeps `JoinPage` and `/s` and `/invite` render `LinkUnavailable` ("This link isn't available.").

1. Read the token from the fragment. On `/join/:token`, `history.replaceState` to `/s#<token>` first (D14).
2. **Signed in** (any session, as today, D3): `redeemShareLink` → `/doc/:id`. An owner lands on their own score because redeem returns its id.
    - If the link is dead, ask `share-session` for the state and date. A legacy link falls back to `peek_share_link().state`. Then show the dead-link state.
3. **Signed out:** `requestShareSession(token)`.
    - `viewer` → lazy `LinkViewerPage`.
    - `editor` → `JoinToEditCard`.
    - `dead` → the dead-link state.
    - `busy` → `BusyState` (a countdown from `retry_after` and "Try now").
    - `failed` → "This score isn't available right now." with Try now.
    - `dead/invalid` → `peek_share_link`. A valid **legacy** link gets the same join card, labelled with its role. Otherwise it's the "doesn't work" state.
4. **`JoinToEditCard`:**
    - Title "Join to edit".
    - A "Your name (optional)" field with the hint "Shown to others on this score. Leave it blank to stay anonymous."
    - `TurnstileField`, `AgreementNote`, **Continue**, and **Continue without a name**.
    - It calls `signInAnonymouslyWithName(name | undefined, captcha, {source:'link_guest', v:2})`, then `redeemShareLink`, then `/doc/:id`.
    - No `AgeScreen` is rendered.
    - The `JoinPage.tsx:98-112` dead-link guest deletion is moved here unchanged.
    - With no name, presence shows `anonymousName(userId)`, because `presenceNameOf` falls back to it for an anonymous user with no name (flag on).

**`LinkViewerPage`** (its own lazy chunk, the only importer of `fake-indexeddb`)

- **Opening:**
    - `new LinkSession(token, answer)`;
    - `fetch(pdfUrl, {cache:'no-store', credentials:'omit', referrerPolicy:'no-referrer'})` into an ArrayBuffer, with no `cacheDocumentBytes`;
    - `createLinkViewerBackend(session)`.
- **What it renders:**
    - the `ViewerHeader` title, a "View only" `Badge` and `document.title`;
    - `PdfProvider`, then `PdfViewport readOnly`;
    - a "What we keep" line with a client-side `<Link to="/children-privacy">`.
    - No library, play-along, notes, export, history, `UpgradeBanner`, `ShareDialog`, `PresenceBar` (D13: the viewer receives no presence anyway) or page-layout menu (`viewerPrefs` writes `localStorage`).
- **Self presence:** `{userId: crypto.randomUUID(), name: anonymousName(id), isAnonymous: true, via: 'link', page, color}`.
- **Sync** (the link backend's `connect`):
    - `DocRealtimeChannel` with `dbTopic: 'doc-view'`, `fetchTopicEpoch` = `link_view_access()` mapped `open → epoch` and anything else → `denied`, `onViewMark → LinkViewSync.applyMark`, `canWrite:false`, and `rotationJitterMaxMs: 250`.
    - `LinkViewSync.pull()` runs on start, on `onReconnect` and `onResync`, and after `doc-view` joins (R11).
    - `ink:progress` arrives on `doc:` through the unchanged `onRemoteInk`.
- **Renewal:**
    - `LinkSession` renews at 80% of the token's life, and on `visibilitychange` when under 120 s are left.
    - Then `client.realtime.setAuth(jwt)` (spike c).
    - If the renewal is `busy`, the score stays on screen with a countdown banner. If it's `dead`, the score is torn down.
- **Teardown:**
    - **Triggers:** the channel reports `denied` (revoke or Restricted rotates `doc-view`); the renewal comes back dead; the link-expiry timer at `link_expires_at` fires (re-armed in chunks under 2^31 ms); or the page unloads.
    - **What happens:** `session.dispose()`, `channel.stop()`, the in-memory Dexie `db.delete()`, and the PDF bytes and store references dropped.
    - **What is shown:** a final `link_view_access()` read picks the message, and the expiry timer shows "expired on <date>".

**`/invite#<token>` → `InvitePage`** (flag on)

1. `peek` shows "<inviter> invited you to <title> as <role>". Dead states each get a message: expired, used, cancelled and invalid.
2. **Registered session:** Accept. `ok` → `/doc/:id`. `email_mismatch` → "This invite is for j\*\*\*@e\*\*\*.com. Sign out to accept it." with a Sign out button that returns to the same URL.
3. **No session, or an anonymous guest:**
    - **The account check runs first.** `accept` with no gate and no password asks the server whether an account exists. The handler checks for an account before the age gate, and a new Deno test pins that order. `sign_in_required` brings up an inline sign-in form (`AuthCredentialsForm email password captchaAction="login"`), then a signed-in accept.
    - **New account:** `AgeScreen purpose="join"`. A refusal makes no request and creates no account. Then "Choose a password" (`AuthCredentialsForm password confirm captchaAction="signup"`), with the masked email shown in a locked, read-only field.
    - **Creating it:** `accept {password, age_gate}` → `{ok, document_id, email}` (gap fix 1) → `signInWithPassword` → `/doc/:id`.
    - **Anonymous guest:** a guest session is ended first through the existing guarded sign-out.

**Share dialog** (`role === 'owner'` and flag on: `OwnerSharingV2`; flag off: today's `OwnerSharing`, untouched; non-owners: today's `MemberSharing`, so D6 holds)

The sections are split into files under `src/features/share/owner/` so `ShareDialog.tsx` stays the shell.

- **`InviteRow`:**
    - email, a role `<select>` (`shrink-0`) and Invite;
    - the D7 refusal reads "This address can't be invited here. If they're your student, use Assign.";
    - 429 shows a wait message.
- **`PeopleSection`:**
    - Members show name, detail, role select (`fieldClassName('sm','py-1.5 shrink-0',{width:'auto'})`, so no `w-full`) and Remove. A guest's detail reads "guest, joined by link".
    - Pending invites show `email · Invited · expires <date>` with Resend and Cancel.
- **`GeneralAccessSection`:**
    - `[Restricted | Anyone with the link]` can `[View | Edit]`;
    - on create, an expiry select from `LINK_EXPIRY_CHOICES_V2` (`shrink-0`, default 7 d);
    - the URL with a middle ellipsis, and Copy link (`/s#…`);
    - `linkExpiryText`, a `[Renew ▾]` menu with the same choices, and "Reset link" with a `ConfirmDialog`;
    - "● N viewing now", where N is the number of `peers` with `via === 'link'`, passed from `ViewerPage` as the `linkViewers` prop;
    - `invalid_link_expiry` is shown inline.
- **`OlderLinksSection`** renders only when an unrevoked legacy link exists. It has Copy and Revoke, and Revoke always calls `revoke_share_link(token, true)` (D4). There is no create, and the "remove people who joined" checkbox is gone in v2.
- **`LinkGuestRetentionRow`** (D8): "Remove link guests on your scores after [30 days ▾] without a visit". It loads `my_share_settings`, saves through `set_link_guest_retention`, and shows `invalid_retention_days` inline.

**Owner and editor presence (R4).**

- `ViewerPage` keeps a member-id set for owners and editors from `listDocumentMembers`. It refetches, at most once per 5 s, when a peer with an unknown id appears.
- `PresenceBar` takes `labelOf = presenceLabel(peer, members)`, which returns `anonymousName(peer.userId)` for every non-member whatever name it claims, or the safe name otherwise.
- Viewers aren't given the member list (today's rule), so they keep today's labels.
- The viewer-count chip in the header shows "N viewing" to the owner only.

**Access changes for link members.** A `membership` event already makes `ViewerPage` re-read the role.

- A demotion to viewer shows the banner "Your access changed to view only."
- A removal (Restricted) uses the existing removal handling.

**`UpgradeBanner`:**

- It takes `role`, and returns null when `role === 'viewer'`.
- The details step starts with `AgeScreen purpose="register"`. The resulting gate is passed through `confirmGuestEmailUpgrade({..., ageGate})` into `guest-email-confirm`'s body.

**Boot:**

- `main.tsx` skips `captureAttribution()` and `registerServiceWorker()` when `isLinkSessionPath(location.pathname)` (`/s`, `/join/…`).
- `webEvents` adds `/s` and `/invite` to `EXCLUDED_PREFIXES`.
- `vercel.json` adds `Referrer-Policy: no-referrer` for `/s` and `/invite`.
- The `/s` chunk joins the precache `globIgnores` in `vite.config.ts`, so members don't download `fake-indexeddb`.

**Flag cleanup.** `AgeScreen.tsx:76` switches to `features.shareV2`, and the deprecated `viewLinks` alias and its test are deleted, as #104 planned.

## 4. Work, in order

Each step leaves the tree green (lint, typecheck, test, build). Tests sit beside each file.

1. **`fieldClassName` width option.**
    - `w-full` moves out of `FIELD_SIZE_CLASSES` into the width option.
    - The four `w-auto` callers move to `{width:'auto'}`, and the member and expiry selects get `shrink-0`.
    - A test asserts that `width:'auto'` produces no `w-full`.
2. **`ScribblerDb` options and `ViewerBackendContext`.**
    - The `PdfViewport` sync effect body moves into `memberBackend.connect`, and `PdfViewport` reads `useViewerBackend()`.
    - The existing `PdfViewport` and `ViewerPage` tests pass unchanged. A new test renders `PdfViewport` with a fake backend and asserts `connect` is called with `canWrite` and `self`.
3. **Realtime additions.**
    - `wire.ts` gets `via`; `realtimeChannel.ts` gets `dbTopic`, `onViewMark`, `rotationJitterMaxMs` and `docViewTopic`.
    - Tests: `doc-view` topic naming, the `mark` dispatch, and the default path unchanged.
4. **Presence.**
    - `anonymousAnimals.ts`, with tests that animals are stable and well spread over 1,000 ids.
    - `presenceLabel` and the `presenceNameOf` fallback (flag on).
    - `PresenceBar` labelling and the owner's viewer-count chip.
    - `ViewerPage` member-id set, with a throttled refetch.
5. **Gap fixes in §2.** The migration, the SQL check, the two handlers and their Deno tests, `apply-migrations.sql` regenerated, and the replay `\ir`.
6. **`linkSession.ts`, `LinkViewSync.ts` and `createLinkViewerBackend`.**
    - `fake-indexeddb` moves to `dependencies`.
    - Unit tests use a fake `fetch` and fake timers. They cover:
        - the answer mapping for every status;
        - renewal at 480 s;
        - the visibility rule;
        - 429 keeping the score;
        - the dead answer tearing down;
        - `LinkViewSync`'s seq guard and tombstones, from #98's `mergeAnnotations` cases;
        - paging with `more`.
7. **`ShareLinkPage`, `LinkViewerPage`, `LinkUnavailable`, routes and boot.**
    - `routes.tsx` adds `/s` and `/invite`, and `/join/:token` is switched by the flag.
    - The `main.tsx` and `webEvents` skips, `vercel.json`, and the `vite.config.ts` precache ignore.
    - Component tests cover every branch in §3.5: signed in, owner, viewer, editor, legacy, each dead state, busy, failed, and flag off.
8. **The memory-only test** (`LinkViewerPage.memory.test.tsx`, jsdom with spies, plus the live E2E in step 13).
    - Open, view, renew (fake timers) and close, then assert that `localStorage` and `sessionStorage` are empty, the real `indexedDB.databases()` is `[]`, `caches.keys()` is `[]` and `document.cookie` is `''`.
    - A boot test asserts `captureAttribution` and `registerServiceWorker` aren't called on `/s` and `/join/x`.
    - `webEvents` exclusions have their own test, as does the `<Link>` to `/children-privacy`.
9. **Bundle check.** `scripts/ci/check-bundle.mjs` runs after `vite build` (`"build": "tsc --noEmit && vite build && node scripts/ci/check-bundle.mjs"`), so CI's `checks` runs it with no `ci.yml` change. It reads the Rollup module map, which a small `vite.config.ts` plugin writes to `dist/.bundle-modules.json`, and fails when:
    - any module from `fake-indexeddb` sits in the entry chunk or in a chunk the entry imports statically;
    - `fake-indexeddb` is in any chunk besides the `/s` chunk and its own dynamic imports;
    - the `/s` chunk's gzip size is over its budget. The budget is set from the first build plus 15%, and the number goes in the PR body.

    It has a vitest unit test over a fixture module map.

10. **Share dialog v2.**
    - `shareService` additions with tests covering the RPC arguments, the expiry intervals, `linkExpiryText` (including the 20 Nov 2026 example), and the error-code mapping.
    - `OwnerSharingV2` and its sections, with tests for:
        - Restricted and Anyone; View and Edit;
        - copying an `/s#` URL;
        - Reset with confirm, Renew, and Renew on an expired link;
        - the bounds error, shown inline;
        - invite outcomes (member, pending, roster refused, 429), and Resend and Cancel;
        - Older links shown only while active, revoking with members always removed, and no checkbox;
        - the viewing count;
        - retention load, save and bounds error.
    - The existing `ShareDialog.test.tsx` runs with the flag off and must still pass unchanged.
11. **`InvitePage`** and the `signInAnonymouslyWithName`, `AgeGate` and `confirmGuestEmailUpgrade` type changes.
    - Tests: peek states; signed-in accept; mismatch with sign-out; existing account with inline sign-in; age refusal makes no request; password then sign-in with the returned email; weak password.
12. **`UpgradeBanner`** role and age step, the access-changed banner, and the `AgeScreen` flag cleanup.
    - Tests: hidden for viewers; the age screen comes before email; the gate is sent to confirm.
13. **Live E2E.** `tests/live/shareV2Flows.live.test.ts` drives Playwright Chromium from vitest, like the other live tests. It's skipped unless `CLEFFY_E2E_BASE` is set, and runs once per viewport (1440×900, 820×1180, 390×844). Run on the local stack with `npm run cloud:up`, `SHARE_V2_ENABLED=1`, the local `SHARE_JWT_SECRET` and `VITE_FEATURE_SHARE_V2=1`. It covers:
    - the teacher creates an "anyone, view" link;
    - a fresh context opens `/s#…` and sees a live stroke while it's drawn;
    - the teacher sees "1 viewing now";
    - revoke clears the viewer within 3 s, and the viewer context's storage is empty (the memory check, end to end);
    - an editor link with no name draws as "Anonymous <animal>", and Restricted demotes or removes it;
    - an invite to a new email is read from Mailpit (`127.0.0.1:54424/api/v1/messages`) and accepted with the age screen and a password, landing on `/doc/:id`.

    The command and output go in the PR body.

14. **`ui-check`.** Screenshots of the Share dialog (name column at 1440 px and 390 px), `/s`, the join card and `/invite` at desktop, iPad and phone go in the PR body.
15. **Gate.**
    - Run `npm run lint:check`, `typecheck`, `test` and `build`, which includes the bundle check.
    - Run the CI SQL proof for `share_v2.sql`, including the second migration pass, and `deno test` for the two handlers.
    - Then push, and confirm `checks`, `supabase-local`, `omr-service`, `supabase-drift` and `edge-functions-deno` are green at the head.

## 5. Acceptance criteria → work

| #   | Criterion (short)                                                                                                                                                                                                                                                                            | Work                                                                                                                                                                     | Proof                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Flag unset: the dialog, `/join` and the viewer are unchanged; `/s` and `/invite` show "This link isn't available."                                                                                                                                                                           | Flag switch in `routes.tsx`; `OwnerSharing` and `JoinPage` kept as they are behind the flag; `memberBackend` is the moved effect body (steps 2, 7, 10)                   | Existing `ShareDialog`, `JoinPage`, `PdfViewport` and `ViewerPage` tests unchanged and green; a route test with the flag off for `/s#x` and `/invite#x`           |
| 2   | Signed-out viewer: read-only, "View only" badge and title, live in-progress ink and saved marks; no age screen, name or account; renews at 80%, and on visibility when under 2 min                                                                                                           | `LinkViewerPage`, `LinkSession`, `LinkViewSync`, link backend, `dbTopic:'doc-view'` (steps 3, 6, 7)                                                                      | `linkSession` timer tests; `LinkViewerPage` test (badge, title, no `AgeScreen`, no form); `LinkViewSync` tests; E2E live stroke                                   |
| 3   | Memory-only (five stores empty); no `registerServiceWorker` or `captureAttribution` on `/s` and `/join`; `webEvents` excludes `/s` and `/invite`; the children's link is a `<Link>`                                                                                                          | In-memory Dexie through `ScribblerDb` options; link client with `persistSession:false`; `no-store` fetch; `isLinkSessionPath` skips; `EXCLUDED_PREFIXES` (steps 2, 7, 8) | `LinkViewerPage.memory.test.tsx`; boot test; `webEvents` test; E2E storage assertion in a real browser                                                            |
| 4   | Dead-link messages (revoked, expired with date, invalid, unavailable) with no score; busy or 429 shows a countdown and Try now while a loaded score stays; revoke while open clears in about 2 s; the expiry timer clears                                                                    | `deadLinkMessage`, `BusyState`, teardown path, `rotationJitterMaxMs: 250`, expiry timer; gap fix 2 for the date (steps 5, 6, 7)                                          | Component tests per state, with exact copy; fake-timer tests for busy-with-score and the expiry timer; E2E revoke within 3 s; SQL and Deno tests for `expired_at` |
| 5   | Signed-in visitor redeemed as a member (D3); owner goes to `/doc/:id`                                                                                                                                                                                                                        | `ShareLinkPage` step 2 (step 7)                                                                                                                                          | `ShareLinkPage` tests: signed-in member and owner both navigate to `/doc/:id`                                                                                     |
| 6   | Link editor: "Join to edit" card with an optional name, Continue and Continue without a name; no `AgeScreen`; Turnstile kept; no name gives "Anonymous <animal>"; guest cleanup kept; Restricted or View change gives the right banner                                                       | `JoinToEditCard`, `link_guest` gate, `anonymousName` fallback, the moved cleanup, access-changed banner (steps 4, 7, 12)                                                 | Card tests (both buttons, the gate payload, no `AgeScreen`, Turnstile rendered, cleanup on a dead link); `presenceNameOf` test; banner test; E2E editor link      |
| 7   | Invite page: header line, age screen, password with the email locked, sign in and open; age refusal makes no account; another account gets "Sign out to accept it"; an existing account is asked to sign in                                                                                  | `InvitePage`; gap fix 1; account-first probe (steps 5, 11)                                                                                                               | `InvitePage` tests for each branch (a refusal makes no fetch); Deno tests for the `email` return and the order; E2E Mailpit invite                                |
| 8   | Owner-only dialog: Restricted or Anyone × View or Edit; Copy (`/s#`); Reset with confirm; "N viewing now"; people, roles and Remove; invite for an existing account, a new email or a roster refusal; Resend and Cancel; Older links only while active; revoke always removes; checkbox gone | `OwnerSharingV2` sections and `shareService` v2 (step 10)                                                                                                                | Dialog tests listed in step 10; E2E "1 viewing now"                                                                                                               |
| 9   | D15: 1 d, 7 d (default), 30 d, 90 d, 1 y on create and Renew; absolute date shown; Renew on an expired link makes it live; bounds error inline                                                                                                                                               | `LINK_EXPIRY_CHOICES_V2` (plus "Never", see §6), `linkExpiryText`, Renew menu (step 10)                                                                                  | `shareService` tests for the intervals and "Expires 20 Nov 2026 (in 7 days)"; dialog tests for Renew on an expired link and the 22023 error shown                 |
| 10  | D8: 7, 14, 30 (default), 60 or 90 days; current value shown; saved server-side; bounds error inline                                                                                                                                                                                          | `LinkGuestRetentionRow`, `getLinkGuestRetention` and `setLinkGuestRetention` (step 10)                                                                                   | Dialog tests: load shows 30; the change calls the RPC with the right number of days; a server error is shown inline                                               |
| 11  | Owners and editors label a non-member presence entry "Anonymous <animal>" whatever its name (R4); animals stable per id                                                                                                                                                                      | `presenceLabel`, the member-id set, `animalFor` (step 4)                                                                                                                 | Unit tests: a forged name on a non-member is relabelled; the same id gives the same animal; `PresenceBar` test                                                    |
| 12  | `UpgradeBanner`: age before email; hidden for view-only members                                                                                                                                                                                                                              | Step 12                                                                                                                                                                  | `UpgradeBanner` tests                                                                                                                                             |
| 13  | Name column: no `w-full` on the member `<select>`; visible at 1440 and 390 (`ui-check` in the PR)                                                                                                                                                                                            | Steps 1 and 14                                                                                                                                                           | `classNames` test plus a dialog test asserting the select's class list has no `w-full`; `ui-check` screenshots                                                    |
| 14  | E2E on desktop, iPad and phone: view link with a live stroke, "1 viewing now", revoke clears; editor link with no name draws and Restricted demotes; Mailpit invite accepted                                                                                                                 | Step 13                                                                                                                                                                  | Command and output in the PR body                                                                                                                                 |
| 15  | CI `checks` (with the bundle-size check for the `/s` chunk and `fake-indexeddb`) and the other jobs green at the head                                                                                                                                                                        | Step 9 (the check didn't exist, so it is added and wired into `build`) and step 15                                                                                       | CI at the PR head                                                                                                                                                 |

Every criterion maps to work. **ac=met.**

## 6. Decisions made here (each goes in the PR body)

- **"Never" stays the last expiry choice.** The orchestrator's technical defaults keep it as an explicit owner choice. The AC's five choices are all present, 7 days is the default, and "Never" is not the default.
- **`/s` doesn't render `PresenceBar`.** Spike (b) showed a viewer receives no presence, and D13 says viewers don't see who else is there. The ticket's 8.1 mention of `PresenceBar` would render nothing.
- **The link viewer has no page-layout menu**, because `viewerPrefs` writes `localStorage`. A memory-only preference store is possible later if Max wants the menu on `/s`.
- **The invite's account check uses the server's existing order.** `sign_in_required` is checked before the age gate, so the invitee isn't put through the age screen and a password only to be told to sign in. A Deno test pins that order.
- **The E2E runs as a vitest live test driving Playwright**, the repo's existing pattern, rather than adding `@playwright/test`. CI has no browser, so its output goes in the PR body, as for #104's live test.
- **The legacy `OwnerSharing` and `JoinPage` stay behind the flag**, so flag-off behaviour is byte-for-byte today's. They are deleted when the flag is removed. That's a follow-up and isn't in this PR.

## 7. Risks

- **GoTrue at boot on `/s`.** The app shell creates the auth singleton (`useSession`, `installWebEvents`), and it reads storage. If the memory test shows that supabase-js writes anything for a visitor with no session, `/s` will check for a stored session with a read-only probe (`authStorage` keys or the cookie) and create the singleton only when there is one.
- **`fake-indexeddb` in production.** It loads only in the `/s` chunk, the bundle check enforces that, and the chunk is left out of the service-worker precache.
- **Hold paths.** The PR waits for Max's `ok` after APPROVE.
- **Two small backend changes (§2).** They are inert while `SHARE_V2_ENABLED` is off. The migration is a `create or replace` and safe to run twice.
- **No hosted Supabase project or Vercel env is touched.** PR #98 isn't touched.

## 8. First implementation step

Step 1 (`fieldClassName`), then step 2 (`ViewerBackendContext`). Moving the effect body out of `PdfViewport` with the existing tests green is what everything else builds on.
