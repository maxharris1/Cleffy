# Launchfix P2 fix round 1 (PR #68): report

Packet: fix Codex's round-1 REVISE on PR #68 (3 MAJOR and 2 MINOR findings, all in ink recovery) and close re-audit C1.

## Summary

- **PR:** #68, https://github.com/maxharris1/Cleffy/pull/68
    - Still a **draft**, base `dev`, head `mh/launchfix-p2-client-safety`.
    - No new PR, no reviewers requested, nothing merged.
- **Starting SHA:** `0508174c16f6f5e500e3748ef07724b8aadd54c3`
    - Confirmed as both the local HEAD and `origin/mh/launchfix-p2-client-safety` at the start. The remote had not moved, so there is only one starting SHA.
- **New PR #68 head:** `b3c475738ec8fefc777fb2ecf8bd579b0c734332`
    - Pushed fast-forward (`0508174..b3c4757`), with no force.
- **Report branch:** `claude/launchfix-p2-fix1-report`
    - Cut from `b3c4757`, plus one commit holding this file and the screenshots. Neither is on the PR branch.
    - `claude/launchfix-p2-report` was not touched.
- **CI on the new head:** **all green** on both workflow runs: push 39733468371 and pull_request 39733475574. Supabase Preview skipped itself (the integration skip, not a failure).
- **Done-when list:**
    - #68 is fast-forwarded, and every local check passed.
    - This report gives the new head SHA, the tests added, the screenshot paths and the follow-ups.
    - `npm run cloud:down` has run.

## Environment confirmation

- This ran in the **Cleffy cloud environment** (`env_01WAd3yiz3qpSnsofpyEwCh2`, `environment_kind: anthropic_cloud`). That was confirmed with `get_session` at the start. It did **not** run in Sandbox.
- **Local Supabase stack only:** `npm run cloud:up` in the background, then `npm run cloud:down` at the end.
    - No hosted Supabase (prod `jibgwgosihadbjgxdsfe`, dev `qdbnlrgylelelvwbkvnm`), no Vercel, no Stripe.
    - The "Supabase Preview" check that lists the prod project is GitHub's integration, which skipped itself. Nothing in this session called it.
- No keys or secrets printed, no `.env` files committed, and `playwright install` was never run. The UI check used the preinstalled Chromium.
- No messages to other sessions, and the `send_message` tool was not used. The only coordination was through git.
- **Commit identity:** Max Harris <drumaxter@gmail.com>.
- **Branches:**
    - The harness named a default branch for this session, `claude/launchfix-p2-ink-recovery-fix1-mz8xqp`. Following the task, I did not push work to it.
    - A branch with that name exists on origin. It came from the session's creation, not from this work.
    - Work went only to `mh/launchfix-p2-client-safety` and `claude/launchfix-p2-fix1-report`.

## Commits

PR branch (`mh/launchfix-p2-client-safety`):

| SHA                                        | Summary                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `b3c475738ec8fefc777fb2ecf8bd579b0c734332` | fix(ink): hold unsaved ink per account and score, outside the viewer's store |

Report branch: one more commit on top, "docs: launchfix P2 fix round 1 report (+ phone screenshots)".

Everything is in one commit because the registry change runs through all five findings and C1. The store, engine, export and sign-out changes depend on one another, and none of them builds or passes its tests on its own.

## Design in one paragraph

Ink this device could not store used to live in the `AnnotationStore` that made it. It now lives in a new module, **`src/sync/inkRecovery.ts`**, keyed by **(account, score)**:

- **Account:** each held op records the account it was made under (`AuthoredOp`).
- **Lifetime:** the module outlives any one store, so viewer mounts, headless sync engines, export, sign-out and the unload guard all see the same state.
- **Store:** the store asks the registry (`hasPersistFailure`, `persistFailureCount`, `refusedEditCount`). On hydrate it draws its author's held marks.
- **Writes:** `persistOps` writes an edit of a held mark _behind_ that mark's held ops, in the same transaction. The outbox never gets a newer op without the one it builds on, and once the write lands nothing older is left to override it.
- **Serialisation:** while a score has held ink, its writes run one at a time (`entry.chain`), so a held op can never be in two writes at once.

## How each finding and packet item was addressed

### 1. MAJOR: ink crossing accounts

- **Registry keyed by (user, document):** `inkRecovery.ts`, `keyOf(userId, docId)`. A store reads only `(this.author, docId)`.
- **Export:**
    - `loadExportAnnotations` overlays only `heldMarksFor(userId, docId)`, so another account's held ink never reaches the export.
    - A device-only score's viewer draws for no account, so its held ink is looked up under `null`, whoever is signed in. That is `isCloudDocId` in `exportAnnotations.ts`, and it is a gap I found and fixed while reviewing.
- **Retry:**
    - `retryHeld(author, docId)` writes only that author's entry.
    - `writeOps` stamps each op with **its own** `author` (`PendingOp.userId`), never the current store author.
    - A store whose author changes hides the previous author's held marks and draws the new author's (`AnnotationStore.swapHeldInk`, run from `applyOwnership`).
    - The author is captured when each mutation starts (`commit`, `createMany`, `replayEntry`).
- **Sign-out:**
    - The existing warn-before-clearing flow is unchanged. `syncBeforeSignOut` still adds held marks to `pending`, now counting only account entries, since sign-out doesn't clear device-only scores.
    - `clearAccountCachesFromDevice` then calls `clearAccountInk()`. That function is the tail of `signOut()`, `signOutKeepingChanges()`, `signOutDeletedAccount()` and guest-profile deletion.
    - `signOutKeepingChanges` first tries to write the account's held ink (`retryAccountInk`), so it is kept with the rest of the account's queued changes where possible.
- **Tests:** the A-then-B account switch on a shared score is covered in four ways: a new store as B, the same store still mounted across the switch, Retry from another mount, and export as B. They are listed below.

### 2. MAJOR: recovery lost on navigation; stale edits winning

- **The registry outlives the store:**
    - `AnnotationStore.hydrate` calls `overlayHeld`, so a reopened score's new store draws the held marks.
    - The banner reads them through the same store API and also subscribes to registry changes (`subscribeInkRecovery`), so Retry is offered again.
    - The UI check shows the banner and the stroke come back after leaving the score and reopening it.
- **Latest wins per mark id:**
    - **Newer write in the same tab:** an edit of a held mark carries its held ops into the same write, and on success they leave the registry. So "red fails, then blue succeeds" stores, outboxes and exports blue, with nothing held. The red update goes out before blue, behind the create.
    - **Newer write in another tab:** a newer write of the same mark from another tab of this device evicts the held one, both on reattach and in export (`supersededBy`: a mirror row with `pending === 1` and a later `updatedAt`).
    - **Failed delete then a newer mark:** an Undo that restores the mark evicts the held tombstone, and so does a newer local mirror row. Either way the tombstone never hides the newer mark.
- **Eviction:**
    - On success: carried ops are released by identity.
    - On sign-out: `clearAccountInk`.
    - On document close: `forgetDocInk(docId)`, called from `purgeLocalDocument`. That function runs on delete, on leaving a score and when access is lost.
- **Cap:**
    - A run of updates to one mark keeps only the newest, which bounds text-note drags.
    - At most `MAX_HELD_SCORES = 20` scores and `MAX_HELD_OPS = 100 000` ops are held. Past either limit, the score touched longest ago that no viewer has open is dropped, with a `console.warn`.
    - Stores themselves are no longer retained. Codex flagged that "repeated visits retain entire stores"; the registry now holds ops only, plus an open-store reference that is removed on unmount (`AnnotationStore.attach`, called from a `PdfViewport` effect).
- **Headless stores:** stores in `backgroundDrain.ts` and `signOutSync.ts`, and the engine's reconcile, now see held marks for their author. They hold those marks back instead of draining or reconciling without the held edit, which was the instance-boundary point in Codex finding 2.

### 3. MAJOR: Export depending on the failed IndexedDB

`loadExportAnnotations` catches a failed mirror or ownership read and falls back as follows:

1. The open viewer's memory for that account and score (`openMarksFor`). This is every mark the viewer draws, held ones included, with tombstones and foreign marks already left out.
2. With no viewer open, the held marks alone, with a warning.

The test closes the Dexie database and checks that the export still works.

### 4. MINOR: a failed create must never show "synced"

- `SyncEngine.drain` treats `store.persistFailureCount > 0` as held, as well as held outbox rows.
- The store pokes the engine through a new `setHeldHook` whenever held ink changes. The engine sets the hook in `start()` and clears it in `stop()`.

### 5. MINOR: Retry replays a failed day-start snapshot

- **Recording:** a create whose snapshot write fails is held together with its pre-edit live set and the day (`RecoveryEntry.startingPoint`).
- **Retry:** `retryHeld` writes that snapshot first and fails, keeping everything held, if it can't.
- **Later edits:** while the snapshot is owed, later edits take the starting point from the owed set, not from a live set that already contains the held stroke (`AnnotationStore.startingPointFor`). A starting point from an earlier day is dropped.

### 6. Pre-existing C1 gaps

- **`hasUnsavedEdit()`** now covers held marks: `isWriting(id) || hasPersistFailure(id)`.
- **`whenSaved()`** now returns `Promise<boolean>`. It settles once nothing of the mark is in flight: `true` when everything reached the outbox (or was refused as no longer applying), `false` when an edit is held.
    - **Caller updated:** `SyncEngine.reconcileGroup` checks the held state first and, after waiting on `whenSaved`, leaves the mark queued on `false`.
    - The waiters are now released on "not in flight" rather than "not unsaved"; otherwise a held mark would never release them.
    - **Sign-out's warn path** doesn't use `whenSaved`. It counts held marks directly, so it still warns about them, and its test still passes.
- **`beforeunload` guard:** attached while any edit is in flight (`noteEditsInFlight`) or any ink is held, and detached otherwise. Detaching keeps the page eligible for the back-forward cache.
- **Snapshot failure on update/delete:** still refused (never applied), as before. It now records a "refused edit" (`noteRefusedEdit`), and the same banner shows:
    - Long copy: "A change couldn’t be saved on this device, so it wasn’t made. Retry, then make it again."
    - It offers Retry, which writes the owed snapshot, and no Export, since nothing is unsaved.
    - The flag clears on the next successful snapshot or a successful Retry.

### 7. UI: a compact banner on phones

- Below `sm`, the strip shows short copy on one row beside its buttons, so the text stays at 2 lines:
    - "Some marks aren’t saved on this device."
    - After a failed Retry: "Still not saved. Storage may be full: export a copy."
- From `sm` up, the long copy is unchanged.
- The pager/zoom strip below it stays one row of controls.
- **Measured with the ui-check skill** (`scripts/ui/uifuzz.mjs`, preinstalled Chromium) on iphone-14 (390×844), iphone-se (375×667) and android-small (360×740):
    - The banner was **52 px, 2 text lines** in every state on every viewport: shown, after a failed Retry, and after reopening.
    - `audit()` found nothing, with no console errors.
    - The previous round reported about five lines on iPhone 14 after a failed Retry.
- **Screenshots:** see the next section.

### 8. Sign-out

- The current behaviour is accepted as is, with no change to `signOutThisDevice`.
- A refresh token staying valid after a failed logout is accepted for now.
- Multi-tab sign-out and sign-out everywhere are listed under follow-ups.

## Screenshots (report branch only)

They are under `launchfix-p2-fix1-screenshots/` at the root of `claude/launchfix-p2-fix1-report`, one set per viewport (`iphone-14`, `iphone-se`, `android-small`):

- `banner-<vp>.png`: the banner right after a pen stroke whose write failed.
- `banner-retry-failed-<vp>.png`: after Retry while storage is still full.
- `banner-reopened-<vp>.png`: after leaving the score and opening it again in the same tab (a new viewer and store). The held stroke is drawn and the banner is back.
- `banner-cleared-<vp>.png`: after freeing storage and pressing Retry on the reopened viewer. The banner is gone.

**How:** I signed in as the seeded teacher and opened `e2e-fixtures/test-score.pdf` through "Open locally without uploading", a device-only score, in a fresh browser context. A full disk was simulated by making `IDBObjectStore.add` throw `QuotaExceededError` for the `ops` store. I then drew a pen stroke. No seeded data was changed, and the local score lived only in that throwaway context.

The script is `/tmp/claude-0/-home-user-Cleffy/ef16dc09-cf4b-51bd-946b-4b85f649cd36/scratchpad/ui/banner-phone.mjs`. It is ephemeral, but a copy is committed next to the screenshots as `launchfix-p2-fix1-screenshots/banner-phone.mjs`.

## Tests added or changed

New tests, by file:

- `src/sync/annotationStore.persistFailure.test.ts`:
    - Finding 1:
        - "A’s failed mark on a shared score is not B’s: B neither draws, counts nor retries it"
        - "a store still mounted when the account changes hides A’s held mark and never stamps it as B’s"
        - "Retry writes each op under the account that made it, whoever retries"
        - "sign-out (clearAccountInk) forgets every account’s held ink, and keeps device-only scores’"
    - Finding 2:
        - "a reopened score’s new store draws the held mark and retries it"
        - "red fails, then blue succeeds in a new mount: blue is what is stored and exported, and nothing stays held"
        - "a failed erase never hides the mark once a newer edit of it is stored"
        - "a failed erase gives way to a newer mark another tab of this device stored"
        - "closing a score for good (purge) forgets its held ink"
        - "keeps one held update per run of updates to a mark"
        - "is capped: past MAX_HELD_SCORES the oldest score no viewer has open goes"
    - Minor 2: "a later edit, while that snapshot is still owed, takes the starting point from before the held stroke"
    - C1:
        - "refuses an update whose day snapshot fails, as before, but says so until a retry writes the snapshot"
        - "asks before the tab unloads while a mark is held, and stops once it is written"
        - "asks while an edit is still on its way"
- `src/features/export/exportAnnotations.test.ts`:
    - "leaves out another account’s unsaved marks: A’s failed mark never reaches B’s export (finding 1)"
    - "red fails, then blue is stored: the export has blue (finding 2)"
    - "a failed erase does not hide the mark once another tab of this device stored a newer one (finding 2)"
    - "works from memory when the database is closed: the open viewer’s marks, unsaved ones included (finding 3)"
    - "bakes in a device-only score’s unsaved marks whoever is signed in: its viewer draws for no account"
- `src/sync/syncEngine.test.ts`:
    - "never reads synced while a new mark is held, though nothing of it is queued (minor 1)"
    - "hears of a failed write at once, so the status changes without another edit (minor 1)"
    - "a reconcile waiting on an edit whose write then fails leaves the mark queued (C1 whenSaved)"
- `src/features/auth/session.test.ts`: "forgets the account’s marks this device could not store, after the warning (SF-1)", which goes through the real `signOut()`.
- `src/features/viewer/InkSaveFailedNotice.test.tsx` (new file):
    - "comes back on the next open of the score, and its Retry there saves the marks (finding 2)"
    - "goes when sign-out clears the account’s held ink"
    - "says so when an edit was refused for want of the day’s snapshot, with Retry and no Export (C1)"
    - "has short copy for phones beside the long copy for wider screens"

Existing tests changed to match the new contracts:

- In `annotationStore.persistFailure.test.ts`:
    - "whenSaved still resolves…" is now "whenSaved reports the failure, and the mark still counts as unsaved (C1)".
    - "queues a later edit of a failed mark behind it, unwritten…" is now "writes a later edit of a failed mark behind its held ops, never without them". That is the latest-wins behaviour.
    - "flags a new stroke whose day snapshot could not be written either" now also checks that Retry writes the snapshot (minor 2).
- `annotationStore.test.ts`: the three `whenSaved` tests now assert `true`, and the snapshot-throws case also asserts `refusedEditCount`.
- `session.test.ts`: the SF-1 count test sets an author, because device-only entries are no longer counted.
- `syncEngine.test.ts` and `reconcileInterleaving.test.ts`: the private `writeMany` seam now takes `(ops, author)`, and the spies forward all arguments.
- Files that create held ink reset the module registry in `afterEach` (`resetInkRecoveryForTests`): `ViewerPage.test.tsx`, `InkController.saveFailure.test.ts` and the files above.

## Local check results (on `b3c4757`, before the push)

| Check                                        | Result                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm run lint:check`                         | pass (exit 0, no output)                                                          |
| `npm run typecheck`                          | pass (exit 0)                                                                     |
| `npm run test`                               | pass: **223 files passed, 5 skipped (228); 3433 tests passed, 13 skipped (3446)** |
| `npm run build`                              | pass (built in about 2.9 s)                                                       |
| `npx prettier --check` on every touched file | pass ("All matched files use Prettier code style!")                               |

At `0508174` the suite was 222 files and 3405 tests, so this round adds 1 file and 28 tests.

As in the previous round, `npm run cloud:up` writes `.env.local`, and with it present undici's real timers break `syncEngine.test.ts` "backs off exponentially…". So the suite and build ran with `.env.local` moved aside, which matches CI. It was put back for the UI check, and `cloud:down` ran afterwards. The file is gitignored and was never committed.

## CI on the final head (`b3c475738ec8fefc777fb2ecf8bd579b0c734332`)

There are two workflow runs, one for the push and one for the pull request. Every job concluded **success**.

| Check                   | Run id (job id)            | Result                                    |
| ----------------------- | -------------------------- | ----------------------------------------- |
| checks                  | 39733475574 (119673657452) | success (lint, typecheck, test, build)    |
| supabase-local          | 39733475574 (119673657080) | success                                   |
| supabase-drift          | 39733475574 (119673657450) | success                                   |
| omr-service             | 39733475574 (119673657382) | success                                   |
| checks                  | 39733468371 (119673633813) | success                                   |
| supabase-local          | 39733468371 (119673633975) | success                                   |
| supabase-drift          | 39733468371 (119673633553) | success                                   |
| omr-service             | 39733468371 (119673633771) | success                                   |
| Vercel Preview Comments | check 119673890635         | success                                   |
| Supabase Preview        | check 119673633020         | skipped (integration skip; not a failure) |

- There is no Claude Approvals check on this repo.
- `mergeable_state` read `unstable` while jobs were still running.
- No fix pushes were needed; CI was green on the first push.

## Files touched (`0508174..b3c4757`, 17 files, +1626/−251)

- **New:**
    - `src/sync/inkRecovery.ts`
    - `src/features/viewer/InkSaveFailedNotice.test.tsx`
- **Sync:**
    - `src/sync/annotationStore.ts`, `src/sync/syncEngine.ts`
    - Tests: `src/sync/annotationStore.persistFailure.test.ts`, `src/sync/annotationStore.test.ts`, `src/sync/syncEngine.test.ts`, `src/sync/reconcileInterleaving.test.ts`
- **Viewer:**
    - `src/features/viewer/InkSaveFailedNotice.tsx`, `src/features/viewer/PdfViewport.tsx` (one effect: `annotationStore.attach()`)
    - Tests: `src/features/viewer/ViewerPage.test.tsx`, `src/features/viewer/ink/InkController.saveFailure.test.ts`
- **Export:** `src/features/export/exportAnnotations.ts`, `exportAnnotations.test.ts`
- **Auth:** `src/features/auth/session.ts`, `session.test.ts`
- **Library:** `src/features/library/documentsService.ts` (`purgeLocalDocument` calls `forgetDocInk`)
- **Not touched:**
    - `src/sync/wire.ts`, `src/sync/remoteInkBuffers.ts` (P3) and `src/sync/realtimeChannel.ts` (P4).
    - No migrations, edge functions, CI workflows, toolbar controls or teacher/student layers.

## Deviations and interpretations

1. **"Evict entries on … document close".** I read "document close" as the score being closed **for good** on this device: deleted, left, or access lost. All of those go through `purgeLocalDocument`. Evicting when the viewer unmounts would contradict "a reopened score's new store reattaches the banner and Retry", so ordinary navigation keeps the entry. See open question 1.
2. **"Latest wins" carries held ops instead of dropping them.**
    - In the same tab, a newer edit of a held mark writes the held ops first, in the same transaction. A held create can't be dropped without leaving an orphan update in the outbox.
    - A newer mirror row from **another tab of this device** (`pending === 1`, later `updatedAt`) evicts the held version.
    - A newer **server** row does not. Local intent wins until it uploads, as `applyRemoteBatch` already rules. The server stamps `updated_at` itself, so clock skew would make that comparison unreliable.
3. **Refused edits get a separate banner state.** The packet says to keep the refusal but show "the same couldn't-save banner". A refused edit has nothing to export, so that state shows Retry only, with copy saying the change wasn't made.
4. **Sign-out clears every account's held ink, not just the signed-out account's.** Only one account is signed in per tab, so any other account's entries are left over and must go too. Device-only scores keep theirs, as their marks are kept.
5. **`signOutKeepingChanges` also tries a Retry first,** so held ink is kept with the account's queued changes where storage allows. This follows Codex's "integrate … the explicit keep-changes path".
6. **`whenSaved` returns a boolean instead of rejecting,** which avoids new unhandled-rejection paths. `false` means "not saved".

## Follow-ups (not done here)

1. **Multi-tab sign-out:** signing out in one tab doesn't sign out or clear the other tabs' memory, held ink included. Out of scope per packet item 8.
2. **Sign out everywhere:** global refresh-token revocation after a failed logout. Out of scope per packet item 8; the token staying valid is accepted for now.
3. **Held ink is per tab.** Another tab of the same browser can't see this tab's held ink. The beforeunload guard covers closing the tab, but not a crash or an OS kill. A persisted recovery marker, such as the localStorage note Codex mentioned, would need a storage path that is still writable when IndexedDB is not.
4. **Two writes in flight for one mark before the first fails.** If one write is already in flight when an earlier one fails, the later one can still land (for example an update before its create). This existed before this round; the registry only serialises writes once a score has held ink. It only matters if quota failures are intermittent.
5. **The nginx headers MINOR** from Codex (`docker/nginx.conf`) is still pre-existing and not charged to P2.
6. **The persistence tests and the UI check still simulate failure** (a mocked `bulkAdd`, or an `add` that throws). They don't use native transaction aborts or a real quota. The export fallback test does use a really closed Dexie database.

## Open questions

1. Is "document close" = closed for good (purge) the intended reading? Evicting on every viewer unmount would break reattach. See deviation 1.
2. Is the refused-edit copy acceptable? "A change couldn’t be saved on this device, so it wasn’t made. Retry, then make it again." On phones: "A change couldn’t be saved, so it wasn’t made."
3. Are the cap values right: 20 scores and 100 000 held ops, dropping the oldest score no viewer has open, with a console warning only? A dropped score's banner can't come back, because its entry is gone.

## Hosted steps left for Max (none performed)

1. None are needed for this round: no migrations, functions, config or secrets changed.
2. The earlier P2 hosted steps still stand, unchanged: turn on Turnstile with the matching site key and secret and then run the CSP smoke, and check the og link previews after deploy.

## Expected conflicts with the other launchfix PRs

Checked with `git merge-tree` of `b3c4757` against each branch on origin at the time of writing:

| Branch                                             | Files in common with #68 | Merge                   |
| -------------------------------------------------- | ------------------------ | ----------------------- |
| `mh/launchfix-p1-db-release-safety`                | none                     | clean                   |
| `mh/launchfix-p3-edge-hardening`                   | none                     | clean                   |
| `mh/launchfix-p4-realtime-revocation`              | none                     | clean                   |
| `mh/launchfix-p5-district-retention`               | none                     | clean                   |
| `mh/launchfix-p6-golive-docs`                      | `DEPLOY.md`              | clean (different hunks) |
| report branches (p1, p4, p5, p5-fix1, p6, p6-fix1) | none, or `DEPLOY.md`     | clean                   |

This round added `src/features/library/documentsService.ts` and `src/sync/inkRecovery.ts` to #68. No other launchfix branch touches either one.
