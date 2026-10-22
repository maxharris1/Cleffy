# Launchfix P2 fix round 2 (PR #68): report

Packet: fix Codex's round-2 REVISE on PR #68. That covers the new MAJOR (keep-changes sign-out hang), what was left of MAJORs 1–3, and requester decision (c). The fixes are fast-forwarded onto #68's existing branch.

## Summary

- **PR:** #68, https://github.com/maxharris1/Cleffy/pull/68
    - Still a **draft**, base `dev`, head `mh/launchfix-p2-client-safety`.
    - No new PR, no reviewers requested, nothing merged.
- **Starting SHA:** `b3c475738ec8fefc777fb2ecf8bd579b0c734332`
    - That was both the local HEAD and `origin/mh/launchfix-p2-client-safety` at the start.
    - The remote had not moved, so there is only one starting SHA.
- **New PR #68 head:** `86f632cec71360dc87dbf4a4626ee9db041d8adc`
    - Two fast-forward pushes, `b3c4757..1ceeb9d` and then `1ceeb9d..86f632c`, with no force.
- **Report branch:** `claude/launchfix-p2-fix2-report`
    - Cut from `86f632c`, plus one commit holding this file, the screenshots and the UI script. None of these are on the PR branch.
    - `claude/launchfix-p2-report` and `claude/launchfix-p2-fix1-report` were not touched.
- **CI on the new head:** see "CI on the final head" below. CI on the intermediate head `1ceeb9d` was all green: push run 39740551418 and pull_request run 39740557187.
- **Done-when list:**
    - #68 is fast-forwarded and every local check passed.
    - Tests were added for each of Codex's untested cases.
    - This report gives the new head SHA and the follow-ups.
    - `npm run cloud:down` has run.

## Environment confirmation

- This ran in the **Cleffy cloud environment** (`env_01WAd3yiz3qpSnsofpyEwCh2`, `environment_kind: anthropic_cloud`). That was confirmed with `get_session` at the start. It did **not** run in Sandbox.
- **Local Supabase stack only:** `npm run cloud:up`, then `npm run cloud:down` at the end.
    - The worker process restarted three times during the UI check. Each restart stopped Vite, so the stack was booted again (idempotent) and the check rerun.
    - No hosted Supabase (prod `jibgwgosihadbjgxdsfe`, dev `qdbnlrgylelelvwbkvnm`), no Vercel, no Stripe.
- No keys or secrets printed, and no `.env` files committed.
    - `.env.local` is written by `cloud:up` and is gitignored.
- `playwright install` was never run; the UI check used the preinstalled Chromium.
- No messages to other sessions, and `send_message` was never used. The only coordination was through git.
- **Commit identity:** Max Harris <drumaxter@gmail.com> on every commit.
- **Branches:**
    - The harness named a default branch for this session, `claude/launchfix-p2-fix2-6md4w5`. It exists on origin at `b3c4757`; the session's creation made it.
    - I pushed nothing to it. Work went only to `mh/launchfix-p2-client-safety` and `claude/launchfix-p2-fix2-report`.
- Shared local accounts: I only signed in as the seeded teacher and used "Open locally without uploading". No seeded score, account, password or billing setting was changed.

## Commits (PR branch)

| SHA                                        | Summary                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `7379a8b60b442a9a469e518bf95f970d2727ed18` | fix(ink): bound keep-changes sign-out, cancel recovery writes per account, never drop held ink                       |
| `1ceeb9df5544634c23395a792ab7591875196fb4` | fix(ink): server rows never overtake on the base seq; guard late snapshot failures after sign-out; tests             |
| `86f632cec71360dc87dbf4a4626ee9db041d8adc` | fix(ink): erase-only conflicts offer no Export; keep the export menu in the gutter over a notice (from the UI check) |

The report branch adds one commit on top: "docs: launchfix P2 fix round 2 report (+ screenshots)".

## Design in one paragraph

`src/sync/inkRecovery.ts` stays the one place held ink lives, keyed by (account, score). This round adds four things.

1. **An epoch for each account.**
    - Every write captures its account's epoch when the edit is made: `boundTo(author)` in `AnnotationStore.commit`, `createMany` and `replayEntry`, and in `retryHeld`.
    - `writeOps` checks it inside its Dexie transaction, before the mirror write and again before the outbox write.
    - Sign-out (`clearAccountInk(userId)`) moves the epoch on. Any write of that account still on its way then throws `RecoveryCancelled` inside its transaction, rolls back, and holds nothing again. That covers a Retry spanning the sign-out, the later chunks of a long write, and a write stalled behind a blocked database.
2. **Conflicts.**
    - Before a held edit or erase is replayed, Retry asks the server for the mark's current version, through the sync engine's `fetchMany`, bounded to 3 s.
    - It also checks the mirror row inside the write transaction itself.
    - A newer version "overtakes" the held one (`overtakes()`): the held op leaves Retry and is kept for Export as a **conflict**, and the newer version is drawn.
3. **Admission-only memory bounds.**
    - Nothing held is ever evicted.
    - Past either bound, a newly failed edit is not held. It is undone on screen (`HeldInkFull` → `AnnotationStore.rollBack`), and the banner says so, offering Export of what is held.
4. **A time-boxed keep-changes sign-out,** preceded by an Export prompt.

## How each item was addressed

### Packet item 1 / Codex new finding 1 (MAJOR): keep-changes sign-out hang

- **Time box** (`session.ts`, `SIGN_OUT_STORAGE_TIMEOUT_MS = 5000`, helper `within()`):
    - `signOutKeepingChanges` waits at most 5 s for the Retry (`retryAccountInk`).
    - Every later storage step is bounded the same way: stamping the outbox (`stampOwnCloudOps`), and for the deleted-account path `dropOwnCloudOps` and `pendingCloudOpCount`.
    - The cache clear in `signOutEndedSignIn` is waited on for at most 5 s.
    - On a timeout the sign-out goes on: `signOutThisDevice` uninstalls the ended session, then the cleanup runs.
- **Cancellation:**
    - `clearAccountCachesFromDevice({ userId })` calls `clearAccountInk(userId)`. That moves the account's epoch on, so a Retry that was stalled writes nothing when the database answers later.
    - The test opens the stalled database afterwards and checks that no row or op appears.
- **Export before the wait:**
    - The ended-sign-in paths ask first. These are `ViewerPage`'s `accessLoss === 'ended'` effect and `AssignmentsPage`'s revoked branch.
    - The new hook `useEndedSignInInkPrompt.askFirst()` resolves at once when the account holds nothing. Otherwise it shows `EndedSignInInkPrompt`, a card with an Export menu for each score with held ink and a "Sign out now" button.
    - The card stays up, Export and all, until the sign-out completes. Held ink is cleared only after `signOutThisDevice`, so Export still finds it until then.
    - The menu exports **for the ending account** (new `ShareExportMenu` prop `userId`), even if the auth client has already dropped the session.
    - A page that unmounts while the prompt is up goes on with the sign-out.
- **Copy:**
    - Kept changes: "Your teacher changed your access, so you’re being signed out. Some marks you made couldn’t be saved on this device. Signing out tries once more to save them; if that fails, they’re lost. Export a copy first to keep them."
    - Deleted account: "Your account was removed, so you’re being signed out. Some marks you made couldn’t be saved on this device and will be lost. Export a copy first to keep them."

### Packet item 2 / Codex MAJOR 1 remainder (cross-account)

- **Retry bound to the epoch at its start:** `retryHeld` captures `boundTo(userId)` when called. A Retry cancelled by sign-out returns `ok: false` and writes nothing.
- **Queued writes (`persistOps`):**
    - They use the epoch from when the edit was made, not from when the write starts.
    - `writeQueue` holds nothing when it fails after its account's sign-out, so a later failure cannot recreate the entry.
    - The two day-snapshot failure paths in `commit` (a held create, or a refused edit) also record nothing once the account has signed out.
    - The snapshot write itself takes the guard too: `ensureDayStartingSnapshot` gained an optional `live` parameter.
- **Cleanup clears only the signing-out account's entries:**
    - `clearAccountInk(userId)`.
    - `signOut()` reads the account first (new `signedInUserId()`: the stored session, else the last one this tab saw).
    - So does `deleteGuestProfile`, and `signOutEndedSignIn` passes its own.
    - Only when no account can be found at all does it fall back to every account's entries (`clearAccountInk(undefined)`), which keeps sign-out safe.
    - Device-only scores are never cleared.
- **Mounted stores:**
    - When the author changes from one account to another, or to none, `AnnotationStore.setAuthor` now resets memory (`resetMemory`): marks, held overlay, `foreign` and the **undo stack**. It then hydrates again.
    - A clear of the store's own author's ink resets it too: `OpenStore.accountInkCleared()`, called for each open store by `clearAccountInk`.
    - Hydration and ownership passes carry a generation number, so one begun before a reset applies nothing after it. `ensureLoaded` waits past a superseded load.
    - The session resolving on a warm open (null → account) keeps the old reveal path (`applyOwnership`), so there is no flash on open.
- **Other tabs:**
    - `clearAccountInk` posts `{ type: 'account-ink-cleared', userId }` on `BroadcastChannel('cleffy:ink-recovery')`.
    - Where BroadcastChannel is missing, it writes and removes `localStorage['cleffy:ink-recovery:signed-out']` instead (the storage-event fallback).
    - Every tab listens on both and drops that account's entries, moves its epoch on and resets its open stores.

### Packet item 3 / Codex MAJOR 2 remainder (latest wins against the server; memory bounds)

- **Check before replay:**
    - With a sync engine running, Retry fetches the server rows of the held marks it would update, erase or restore. This is `AnnotationStore.setRetryHooks`, set in `SyncEngine.start()`.
    - It waits at most `SERVER_CHECK_TIMEOUT_MS = 3000`. Offline or on an error it goes on from the mirror alone.
    - Each write chunk then reads the mirror rows in its own transaction and leaves overtaken marks out.
- **What "overtakes" means** (`inkRecovery.overtakes`):
    - The held chain's **base** is the version its first held op was made on. It comes from `CommitOp.prev`, which is now also recorded for deletes and restores.
    - A row with the same content as the base, or as the held version, is not newer. Content is compared as canonical JSON, the same way as `syncEngine.isEchoOf`.
    - Otherwise, a row whose seq is past the base's is newer. That covers a collaborator's edit, and another tab's edit once uploaded and pulled.
    - A **mirror** row on the base's seq with other content is another tab's local edit (pending or acked). It is ordered by this device's clock (`updatedAt`).
    - A **server** row on the base's seq is never newer. It is the version the base was made on, or older; this avoids the clock-skew problem from fix1 deviation 2.
- **A newer version does not override or hide.**
    - The held op leaves Retry and is kept as a conflict (`RecoveryEntry.conflicts`).
    - The store draws the newer version: from the mirror (`reloadFromMirror`), and the engine also re-asks the server (`applyDeferred` + `askAgain`).
    - Export bakes in both versions. The held one gets the id `<id>:unsaved`, and the menu says so.
    - A newer edit of a conflicted mark in this tab removes the conflict, because it is the user's latest word.
    - The banner has a conflict state offering Export (when there is a drawable version to keep) and **Dismiss**, but no Retry. Dismiss lets the conflicts go once the user has seen them.
- **Memory bounds.** `MAX_HELD_SCORES = 20` and `MAX_HELD_OPS = 100 000` are unchanged.
    - They apply **uniformly**: open scores count, refused-only scores count, and owed snapshots count, by the number of marks in them. Conflicts count too.
    - They are checked **on admission** (`admits()`), never by eviction. `enforceCap`, the touch clock and the console-warning eviction are gone.
    - Past either bound, the new failed ops are not held. `holdOps` returns them, `persistOps` throws `HeldInkFull`, and the store undoes them on screen (`rollBack`, back to the previous version).
    - The score's banner shows the overflow state, with Export when the score has unsaved marks of its own. The only copies already held are never dropped.
    - A successful Retry, or writing all of the score's held ops, clears the overflow state.
    - The test that expected loss, "is capped: past MAX_HELD_SCORES the oldest score no viewer has open goes", was rewritten as "is bounded without losing anything…".

### Packet item 4 / Codex MAJOR 3 remainder: incomplete export

- `loadExportMarks()` (new, in `exportAnnotations.ts`) returns `{ annotations, incomplete, conflicts }`. `loadExportAnnotations()` is kept as a thin wrapper.
- `exportNotice()` turns that into text naming what is missing, for example:
    > "This export is missing marks. This device’s storage couldn’t be read, so it has only the 1 unsaved mark this tab still holds, not the score’s saved marks."
- Conflicts get their own line:
    > "One of your unsaved marks changed elsewhere before it could be saved here: the export has both versions."
- `buildAnnotatedPdf` and `exportAnnotatedPageImage` pass that text to a new `onNotice`.
- `ShareExportMenu` shows it as an amber `role="status"` notice and keeps the menu open over it after the export, so it is seen and not only logged.
- An export made from an open viewer's memory is complete and shows no notice.

### Packet item 5: previous-day owed snapshot

Accepted, left as is: `owedStartingPoint` still drops yesterday's owed starting point. Listed under follow-ups.

### Packet item 6: tests for every untested case Codex listed

See the next section.

### Packet item 7 / requester answer (c): never drop held ink silently

- Held ink is never dropped by the registry, and the console-warning eviction is removed.
- At the bound, new edits are refused visibly: undone, with the banner and Export first.
- Packet item 3 is the newer decision, and it wins where it differs from (c): "stop accepting new held ops… never evict the only copy".

### Requester answers to the fix1 questions

- **(a) "Document close" = purge:** this was already the reading in fix1 and is unchanged. `forgetDocInk` is called from `purgeLocalDocument`.
- **(b) Refused-edit copy:** unchanged.
- **(c):** done as packet item 3 / item 7 above.
- **P3 note (denying the trigger delete):** nothing in P2. P3's files (`wire.ts`, `remoteInkBuffers.ts`) and P4's (`realtimeChannel.ts`) were not touched.

### Codex's round-2 notes on the other findings

MINOR 1, MINOR 2 (same-day) and C1 (b)/(c)/(d) were FIXED or CLOSED in round 2 and are unchanged. C1 (a)'s "keep-changes wait can block indefinitely" is new finding 1, covered above.

## Tests added (mapped to Codex's "untested cases")

| Codex untested case                                    | Test (file › name)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Newer row already uploaded by another tab              | `src/sync/annotationStore.recovery.test.ts` › "newer row already uploaded by another tab: Retry does not write over it, and keeps the held edit for Export"; "a newer server version pulled by another tab (a higher seq) overtakes the held one on the next open". `src/features/export/exportAnnotations.test.ts` › "newer row already uploaded by another tab: the export has both versions, and says so (MAJOR 2)"                                                                                                                                                                                                                                                                                                                                                      |
| Direct Retry against superseded state                  | `annotationStore.recovery.test.ts` › "Retry against superseded state: the mirror is checked in the write itself, not only on open"; "a failed erase does not hide a newer version a collaborator made on the server"; "the server holding this device’s own earlier write is no conflict: the held edit is written"; "a server still on the version this device’s unsent edit was made on is behind it, whatever its clock says"; "goes on from the mirror alone when the server cannot answer"; "a newer edit of a conflicted mark here is the user’s latest word…"; "Dismiss lets the conflicts go once the user has seen them". `src/sync/syncEngine.test.ts` › "Retry asks the server first: a collaborator’s newer version is neither overridden nor hidden (MAJOR 2)" |
| Recovery clearing during multi-chunk writes            | `annotationStore.recovery.test.ts` › "clear during a multi-chunk write: no chunk after the sign-out writes, and nothing is held again"; "a Retry started before the sign-out writes nothing once it has happened"; "an edit queued behind held ink when the account signs out is neither written nor held again"; "a day-snapshot failure that lands after the sign-out holds nothing for the account again"                                                                                                                                                                                                                                                                                                                                                                |
| Retained stores after cleanup                          | `annotationStore.recovery.test.ts` › "store mounted after cleanup: a retained store forgets the cleared account’s held marks, then draws only B’s"; "a store not open for export still resets when the account changes after the registry cleared"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Indefinitely stalled keep-changes recovery             | `src/features/auth/session.test.ts` › "stalled keep-changes sign-out: a never-settling IndexedDB cannot hold it, and nothing is written after"; "writes the held ink first when storage answers, so it is kept with the account’s queued changes". This test **fails** with the time box removed (checked before pushing)                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Nondestructive memory-limit behaviour                  | `annotationStore.recovery.test.ts` › "memory cap without data loss: past MAX_HELD_SCORES a new score’s failed edit is undone and said so; nothing held goes"; "the ops bound applies to an open score too, and an undone edit of an existing mark goes back to how it was"; "refused-only scores count toward the bound as well"; "a Retry that works clears the notice". `src/sync/annotationStore.persistFailure.test.ts` › "is bounded without losing anything: past MAX_HELD_SCORES no held score goes, the new edit is undone and said so" (replaces the test that expected loss)                                                                                                                                                                                      |
| Cleanup clears only the signing-out account (packet 2) | `annotationStore.recovery.test.ts` › "clears only the signing-out account’s held ink; another account’s, and device-only scores’, stay". `session.test.ts` › "forgets the account’s marks this device could not store, after the warning (SF-1), and no other account’s". `persistFailure.test.ts` › "a sign-out that cannot tell whose session it ended (clearAccountInk()) forgets every account’s held ink…". `accountDeletion.test.ts` (asserts `{ userId: 'guest-1' }`)                                                                                                                                                                                                                                                                                                |
| Other tabs (packet 2)                                  | `annotationStore.recovery.test.ts` › "tells them by BroadcastChannel"; "drops that account’s held ink when another tab signs it out (BroadcastChannel)"; "drops it too on the storage-event fallback"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Export before the wait (packet 1)                      | `src/features/viewer/ViewerPage.test.tsx` › "offers Export of ink this device could not store before signing out, and signs out when asked (new finding 1)". `src/features/student/AssignmentsPage.revoked.test.tsx` › "offers Export of marks this device could not store first, then writes them with the kept changes (new finding 1)" (real sign-out, real Dexie)                                                                                                                                                                                                                                                                                                                                                                                                       |
| Incomplete export shown to the user (packet 4)         | `exportAnnotations.test.ts` › "an incomplete export says so, naming what is missing…"; "an export made from the open viewer’s memory is complete: no notice". `src/features/export/ShareExportMenu.test.tsx` › "shows what an incomplete export is missing, and stays open over it, not just a console warning (MAJOR 3)"; "shows the same notice for a page sent as a photo"                                                                                                                                                                                                                                                                                                                                                                                               |
| Banner states                                          | `src/features/viewer/InkSaveFailedNotice.test.tsx` › "when a newer version overtook the held marks: says so, offers Export and Dismiss, and no Retry (MAJOR 2)"; "when the overtaken change was an erase: says so, with Dismiss and no Export"; "at the memory bound: says the new edits were not made, and offers Export of what is held (decision c)"; "at the memory bound with nothing of this score’s held: no Export, and says to free up storage"                                                                                                                                                                                                                                                                                                                    |

Existing tests changed to match:

- `ShareExportMenu.source.test.tsx` and `ShareExportMenu.test.tsx`: `buildAnnotatedPdf` and `exportAnnotatedPageImage` now also receive `onNotice`.
- `accountDeletion.test.ts`: the session mock gains `signedInUserId`, and the clear is asserted with `{ userId: 'guest-1' }`.
- `InkSaveFailedNotice.test.tsx` "goes when sign-out clears…": now `clearAccountInk(USER)`.
- `session.test.ts` SF-1 sign-out test: it now has a session, and it adds another account's held ink that must stay.

The suite went from 223 files / 3433 tests at `b3c4757` to **224 files / 3470 tests**. That is one new file and 37 more tests.

## Screenshots (report branch only)

They are under `launchfix-p2-fix2-screenshots/` on `claude/launchfix-p2-fix2-report`, one set per viewport: `iphone-14`, `iphone-se`, `android-small` and `desktop-1440`.

- `banner-conflict-erase-<vp>.png`: a stored stroke's erase failed (Undo with storage full), and "another tab" then stored a newer, green version.
    - After Retry, the green version is drawn.
    - The banner says the change was overtaken and offers **Dismiss** only.
- `banner-conflict-exportable-<vp>.png`: a held recolour (red) overtaken by a newer blue version.
    - Blue is drawn. The banner offers **Export** and **Dismiss**, and no Retry.
- `export-conflict-notice-<vp>.png`: that banner's Export → "Send page 1 as photo".
    - The menu stays open with "One of your unsaved marks changed elsewhere before it could be saved here: the export has both versions."
- `banner-overflow-<vp>.png`: the registry at `MAX_HELD_OPS` (filled through the app's own `inkRecovery` module), then a stroke drawn with storage full.
    - The stroke is **not** drawn, and the banner says new ones weren't made.
    - There is no Export, because this score holds nothing of its own.
- `r2-phone.mjs` is the script. It uses the same quota simulation as round 1 (`IDBObjectStore.add` throws for `ops`), plus the app's own Dexie and `inkRecovery` modules to stand in for "another tab" and the filled registry.

Measured banner heights: 52 px for conflict and overflow and 71 px for the exportable conflict on every phone; 53–55 px on desktop. There were no console errors.

The UI check found two real problems, both fixed in `86f632c` and re-shot:

1. **An erase-only conflict offered Export with "Export keeps yours"**, although an erase has nothing of its own to export.
    - It now says "Some changes were overtaken elsewhere before saving." and offers Dismiss only.
    - New store getter: `exportableConflictCount`.
2. **The export menu sat partly off the left edge of the phone** (x ≈ −9 px) when kept open over the new notice.
    - The menu was placed while its button read "Exporting…". When the label went back to "Export", the anchor moved but the menu was not placed again.
    - This was latent before; the error notice could hit it too. The layout effect now also depends on `busy`.
    - After the fix, `audit()` shows no off-screen items, only the expected "obscured" entries for controls under the open menu.

**Not screenshotted:** the ended-sign-in prompt. Reaching it in the running app needs the teacher to archive or reset a seeded student, which the hard rules don't allow on the shared accounts. It is covered by the viewer and assignments tests above; the assignments one runs the real sign-out against real Dexie.

## Local check results (final tree `86f632c`, before its push)

| Check                                        | Result                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm run lint:check`                         | pass (exit 0)                                                                     |
| `npm run typecheck`                          | pass (exit 0)                                                                     |
| `npm run test`                               | pass: **224 files passed, 5 skipped (229); 3470 tests passed, 13 skipped (3483)** |
| `npm run build`                              | pass (built in 3.5 s)                                                             |
| `npx prettier --check` on every touched file | pass ("All matched files use Prettier code style!")                               |

- The same checks passed before each earlier push. At `1ceeb9d` the suite was 3469 tests.
- As in round 1, the final run was made with `.env.local` moved aside, which matches CI. It was put back afterwards; it is gitignored and was never committed.

## CI on the final head (`86f632cec71360dc87dbf4a4626ee9db041d8adc`)

There are two workflow runs, one for the push and one for the pull request. Every job concluded **success**.

| Check                   | Run id (job id)            | Result                                    |
| ----------------------- | -------------------------- | ----------------------------------------- |
| checks                  | 39752334054 (119735698327) | success (lint, typecheck, test, build)    |
| supabase-local          | 39752334054 (119735698272) | success                                   |
| supabase-drift          | 39752334054 (119735698258) | success                                   |
| omr-service             | 39752334054 (119735698008) | success                                   |
| checks                  | 39752325276 (119735667624) | success                                   |
| supabase-local          | 39752325276 (119735668104) | success                                   |
| supabase-drift          | 39752325276 (119735668217) | success                                   |
| omr-service             | 39752325276 (119735668065) | success                                   |
| Vercel Preview Comments | check 119736017404         | success                                   |
| Supabase Preview        | check 119735659586         | skipped (integration skip; not a failure) |

- Run 39752334054 is the pull_request run; 39752325276 is the push run.
- There is no Claude Approvals check on this repo.
- No CI fix pushes were needed: every head of this round (`1ceeb9d`, `86f632c`) was green on its first run. `7379a8b` was never pushed on its own.
- PR #68 remains a draft with base `dev`.

## Files touched (`b3c4757..86f632c`: 26 files, +2201/−207)

- **New:**
    - `src/sync/annotationStore.recovery.test.ts`
    - `src/features/student/EndedSignInInkPrompt.tsx`
    - `src/features/student/useEndedSignInInkPrompt.ts`
- **Sync:**
    - `src/sync/inkRecovery.ts`, `src/sync/annotationStore.ts`
    - `src/sync/syncEngine.ts`: Retry hooks only.
    - Tests: `annotationStore.persistFailure.test.ts`, `syncEngine.test.ts`
- **Auth / account:**
    - `src/features/auth/session.ts`, `session.test.ts`
    - `src/features/account/accountDeletion.ts`, `accountDeletion.test.ts`
- **Export:**
    - `exportAnnotations.ts`, `exportPdf.ts`, `exportPageImage.ts`, `ShareExportMenu.tsx`
    - Tests: `exportAnnotations.test.ts`, `ShareExportMenu.test.tsx`, `ShareExportMenu.source.test.tsx`
- **Viewer / student:**
    - `InkSaveFailedNotice.tsx`, `ViewerPage.tsx`, `AssignmentsPage.tsx`
    - Tests: `InkSaveFailedNotice.test.tsx`, `ViewerPage.test.tsx`, `AssignmentsPage.revoked.test.tsx`
- **History:** `src/features/viewer/history/snapshotService.ts`, one optional `live` parameter.
- **Not touched:**
    - `src/sync/wire.ts`, `src/sync/remoteInkBuffers.ts` (P3) and `src/sync/realtimeChannel.ts` (P4).
    - No migrations, edge functions, CI workflows, toolbar controls or teacher/student layers.

## Deviations and interpretations

1. **"Keep-changes dialog".** No such dialog existed: the ended-sign-in paths signed out at once.
    - I added the smallest one that meets the packet: the `EndedSignInInkPrompt` card, shown only when the ending account holds ink. It appears before the bounded wait and stays up until the sign-out completes.
    - It has no toolbar control and no teacher/student layer.
    - The prompt does not time out on its own, so the sign-out waits on the student's choice. See open question 1.
2. **The 5 s time box covers every storage step of the ended-sign-in sign-out,** not only the Retry: stamping or dropping the outbox, and the cache clear. With a never-answering IndexedDB, any one of them would otherwise hold the sign-out just the same.
    - On a timeout, the count reported to the sign-in page is 0.
    - The deleted-account path keeps the cloud annotations (unknown counts as "something is waiting", as before).
3. **"Check the server row's updated_at/version":**
    - The **version** (`seq`) is compared, together with content. `updated_at` is server-stamped, and comparing it with this device's clock is unreliable (fix1 deviation 2).
    - Same-device ordering (another tab's local edit on the same seq) uses this device's own `updatedAt`.
    - The server check is best effort: 3 s, skipped offline or without a sync engine (device-only scores). The in-transaction mirror check always runs.
4. **"Keep it in Export as a conflict":**
    - The held version is baked in **beside** the newer one, under the id `<id>:unsaved`, and the menu says so.
    - An overtaken **erase** has nothing to draw. It is still kept as a conflict, so the banner can say the change was overtaken, but it is offered without Export.
    - The banner's new **Dismiss** lets conflicts go once seen. That is a banner button, not a toolbar control, and it follows "drop only after the user has been shown it".
5. **"Stop accepting new held ops for that score" = undo them on screen.** An edit neither written nor held would be lost on reload while still drawn, so it is undone visibly, the same way refused edits are.
6. **A store resets on an account change** rather than remounting the viewer.
    - The packet allowed "resets/remounts". Remounting would also have fired on the session resolving at a warm open (null → account), repainting the PDF.
    - That transition keeps the reveal path. Only account → other account, or account → none, resets.
7. **Sign-out finds the account itself** (`signedInUserId()`) to clear only its entries.
    - If neither the stored session nor this tab's last-seen session names one, every account's entries go, as before. Leaving a signed-out account's ink for the next account is the worse failure.
8. **Cross-tab messages carry the account id** (a UUID), and the fallback writes it briefly to `localStorage`, removing it straight away.

## Follow-ups (not done here)

1. **Previous-day owed snapshot (packet item 5, accepted):** a Retry on a later day drops yesterday's owed starting point, as before. Lesson history then lacks that day's start.
2. **Ordinary `signOut()` is not time-boxed.** `syncBeforeSignOut` → `pendingCloudOpCount`, and the cache clear, can still wait on a stalled IndexedDB in the user-initiated sign-out. The packet scoped the time box to keep-changes.
3. **The ended-sign-in prompt's PDF export may be refused.** The pdf_exports claim needs the server, and an ended session cannot claim, so it fails closed with the menu's message. "Send page as photo" (unmetered, works offline from the cached PDF) is the dependable path there. Giving ended students a way to export a PDF would need a server decision.
4. **Held ink is still per tab,** so a crash or OS kill loses it (fix1 follow-up 3, unchanged). The broadcast now clears other tabs on sign-out, but nothing is persisted for recovery.
5. **Two writes in flight for one mark before the first fails** (fix1 follow-up 4, unchanged).
6. **Conflict detection uses content equality.** Two different edits that produce identical content are treated as the same version. That is harmless: the held write is then a no-op.
7. **Export artifact marking:** the incomplete/conflict notice is shown in the UI only. The file name and PDF are not marked.
8. **The UI check still simulates failure** (a throwing `add`) and stands in for "another tab" with direct mirror writes, as in round 1.

## Open questions

1. **Should the ended-sign-in prompt time out on its own?**
    - Example: auto sign-out after N minutes on a shared studio iPad. Today it waits for "Sign out now", or for the page to unmount.
    - Until then, the ended session stays installed, though the server has already refused it, and Export of that account's unsaved marks stays available on the device.
2. **Is Dismiss on the conflict banner acceptable,** or should conflicts stay until sign-out or purge?
3. **Server-check timeout:** is 3 s right for Retry's server check, given it runs only when the user presses Retry?

## Hosted steps left for Max (none performed)

1. None are needed for this round: no migrations, functions, config or secrets changed.
2. The earlier P2 hosted steps still stand, unchanged: turn on Turnstile with the matching site key and secret and then run the CSP smoke, and check the og link previews after deploy.

## Expected conflicts with the other launchfix PRs

Checked with `git merge-tree` of `86f632c` against each launchfix branch on origin at the time of writing:

| Branch (head)                                     | Files in common with #68                                    | Merge |
| ------------------------------------------------- | ----------------------------------------------------------- | ----- |
| `mh/launchfix-p1-db-release-safety` (`3575c73`)   | `src/features/library/documentsService.ts`                  | clean |
| `mh/launchfix-p3-edge-hardening` (`dca8348`)      | none                                                        | clean |
| `mh/launchfix-p4-realtime-revocation` (`657d9cd`) | `src/features/viewer/ViewerPage.tsx`, `ViewerPage.test.tsx` | clean |
| `mh/launchfix-p5-district-retention` (`4ffd856`)  | none                                                        | clean |
| `mh/launchfix-p6-golive-docs` (`7ae2ee5`)         | `DEPLOY.md`                                                 | clean |
| every `claude/launchfix-*-report` branch          | none, or the same files as above                            | clean |

- This round's new overlap is with **P4**, on `ViewerPage.tsx` and its test. The effect for `accessLoss === 'ended'` and the render guard both changed here. `merge-tree` reports no conflict, but whoever merges second should re-run `ViewerPage.test.tsx`.
- P1 shares `documentsService.ts` with #68 from round 1; this round did not change that file.
