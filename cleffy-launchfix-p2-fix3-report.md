# Launchfix P2 fix round 3 (PR #68): report

**Status:** Complete

Packet: fix Codex's round-3 REVISE on PR #68 (head `86f632ce`). Core rule (decision 63): held ink is never destroyed without the user seeing an explicit choice that offers Export first. The fixes are fast-forwarded onto #68's existing branch; no new PR.

## Summary

- **PR:** #68, https://github.com/maxharris1/Cleffy/pull/68
    - Still a **draft**, base `dev`, head `mh/launchfix-p2-client-safety`. No new PR, no reviewers requested, nothing merged.
- **Starting SHA:** `86f632cec71360dc87dbf4a4626ee9db041d8adc`. It was both the checkout and `origin/mh/launchfix-p2-client-safety` at the start, and the remote had not moved when I pushed, so there is only one starting SHA.
- **New PR #68 head:** `0ca6c92ec186de1bc0038d4e65cd81f638ee221f`
    - One fast-forward push, `86f632c..0ca6c92`. No force, no `--force-with-lease`.
- **Report branch:** `claude/launchfix-p2-fix3-report`
    - Cut from `0ca6c92`, plus one commit with this file, the screenshots and the UI script. None of these are on the PR branch.
    - The earlier report branches (`claude/launchfix-p2-report`, `-fix1-report`, `-fix2-report`) were only read, never written.
- **CI on the new head:** green on every check; see "CI on the final head".
- **Done-when:**
    - #68 is fast-forwarded and every local check passed.
    - The new head, the tests added, the screenshot paths and the follow-ups are below.
    - `npm run cloud:down` has run.

## Environment confirmation

- This ran in the **Cleffy cloud environment** (`env_01WAd3yiz3qpSnsofpyEwCh2`, `environment_kind: anthropic_cloud`), confirmed with `get_session` at the start. It did **not** run in Sandbox.
- **Local Supabase stack only:** `npm run cloud:up` in the background, `npm run cloud:down` at the end. No hosted Supabase (prod `jibgwgosihadbjgxdsfe`, dev `qdbnlrgylelelvwbkvnm`), no Vercel, no Stripe.
- No keys or secrets printed; no `.env` files committed. `.env.local` (written by `cloud:up`, gitignored) was moved aside for the final local test run, to match CI, and put back.
- `playwright install` was never run; the UI check used the preinstalled Chromium.
- No messages to other sessions; `send_message` was never used. Coordination was only through git.
- **Commit identity:** Max Harris <drumaxter@gmail.com> on every commit.
- **Branches:** the harness named a default branch for this session, `claude/launchfix-p2-held-ink-ssi06h`. I pushed nothing to it. Work went only to `mh/launchfix-p2-client-safety` and `claude/launchfix-p2-fix3-report`.
- **Shared local accounts:** I only signed in as the seeded teacher. I used "Open locally without uploading" for the device-only score, and held ink in memory only (with the outbox write failing) on a seeded cloud score, so nothing reached the server. No seeded score, account, password or billing setting changed.

## Commits (PR branch)

| SHA | Summary |
| --- | --- |
| `db55cab6d21f9291bab5bb2322f8a2216a737268` | fix(ink): sign-out keeps held ink for Export or Discard; Dismiss only hides; cut-off writes swept |
| `0ca6c92ec186de1bc0038d4e65cd81f638ee221f` | fix(ink): fit the conflict notice's three actions on a phone; room for the export menu in the signed-out export dialog (from the phone UI check) |

The report branch adds one commit on top: "docs: launchfix P2 fix round 3 report (+ screenshots)".

## Design in one paragraph

Sign-out now separates **cutting off writes** from **discarding recovery**.

- `inkRecovery.retireAccountInk(userId, reason)` replaces `clearAccountInk`. It:
    - moves the account's epoch on, so no write of the account's lands;
    - records the account as signed out (`retired`), which takes its entries out of every viewer, Retry, the sign-out count and the ended-sign-in prompt;
    - resets open stores drawing for it;
    - broadcasts to the other tabs when the sign-out was local.
- It **keeps** the held ink, conflicts included.
- That ink is reachable only through a new app-wide banner, `SignedOutInkNotice`, which offers Export and Discard (with a confirmation that offers Export first).
- It goes only on that Discard, on tab close (the existing unload guard asks first), or when another account signs in on the tab (`accountSignedIn`, fed by `session.ts` through a dependency-free `inkRecoverySignal`). The same account signing in again gets it back: drawn and retryable.

For transactions already running, every mirror + outbox write (`writeOps`) now does three things:

1. Checks the epoch after the outbox write, inside its transaction.
2. Counts as done only if the epoch still holds when the tab sees the transaction complete.
3. Stamps its outbox rows with a random write id (`PendingOp.inkWrite`).

At sign-out, the ids of the account's writes still on their way are recorded as cut off (`cutOffWrites`, in localStorage, random ids only). Their ops stay held in memory. If such a transaction commits after all, its rows are stale:

- `opOwnerFor` treats them as nobody's, so they are not drawn, uploaded, exported or adopted.
- `sweepCutOffWrites` deletes them on every store load and attach, along with the mirror row they wrote and the score's pull watermark, so the next pull restores the server's version.

## How each item was addressed

### Packet item 1 / Codex new finding 1 (MAJOR): Dismiss destroyed the only conflict copy

- **Dismiss only hides.**
    - `hideConflictNotice` sets `RecoveryEntry.conflictNoticeHidden`, and the banner renders nothing in the conflicts state while it is set.
    - Conflicts stay in `conflicts`, so they are still in Export (`heldInkForExport`) and still in `hasUnsavedInk`, which keeps the leave-page guard on.
    - A newly overtaken mark clears the flag, so the notice comes back.
- **Discard is new.**
    - The banner's Discard opens a dialog: "Discard your unsaved versions? … Discarding deletes it/them for good. Export a copy first to keep it/them." Its buttons are Cancel, **Export first** (opens the viewer's Export menu) and Discard.
    - Only the dialog's Discard calls `discardConflicts`.
    - Discard is shown only where Export can be offered (the viewer passes `onExport` once confirmed). Without it, the banner offers Dismiss only.
- **Erase-only conflicts get Export.**
    - Export shows the score as it is, with the newer version drawn.
    - The export notice says "One of your unsaved erases was overtaken by a newer version made elsewhere: the export shows that version." (`ExportMarks.erasedConflicts`).
- **Phones:** Dismiss is an × button (`aria-label="Dismiss"`, with a title explaining it keeps the versions for Export), and the phone copy is shorter, so the three actions fit beside two lines of text at 360 px.

### Packet item 2 / Codex new finding 2 (MAJOR): sign-out in one tab wiped another tab's held ink

- **Receiving tab** (`BroadcastChannel` message `account-signed-out`, or the storage-event fallback):
    - `retire(userId, 'other-tab')` moves the epoch on at once and cuts off in-flight writes. `boundTo` returns an always-false guard for a retired account, so Retry and new writes stop.
    - Held ink stays in memory.
- **Banner:** "You were signed out in another tab. You have unsaved ink." with **Export** and **Discard** (`SignedOutInkNotice`, mounted under every route by `SignedOutInkGate` and lazy-loaded only when needed).
    - **Export** opens a dialog with one row per score: title, mark count and the Export menu, exporting **for the signed-out account**. That export has only that account's held marks and conflicts, never another account's (fix1 rule), and says "You're signed out, so this export has only the N unsaved marks this tab still holds, not the score's saved marks."
    - The score's PDF and title are kept from its viewer (`rememberScoreSource`, registered by `ViewerPage`) while ink of it is held, so Export works after sign-out has cleared the device's PDF cache.
    - **Discard** asks: "N unsaved marks on M scores are only in this tab. Discarding deletes them for good. Export a copy first to keep them." Its buttons are Cancel, **Export first** and Discard.
- **Discarded only** on explicit Discard, tab close, or a different account signing in on the tab (`accountSignedIn`). The same account signing in again re-adopts it.
- **The test that asserted deletion was fixed.** It was "drops that account's held ink when another tab signs it out (BroadcastChannel)"; now it is "cross-tab sign-out while this tab holds ink: writes stop at once, the ink stays for Export or Discard, and the notice says so". See the test list below for every test that asserted deletion.
- **Interpretation:** the same now holds for **every** sign-out path, not only the broadcast. Ordinary `signOut()`, guest-profile deletion, and the ended sign-in's keep-changes and deleted-account paths all go through `clearAccountCachesFromDevice` → `retireAccountInk(userId, 'here')`.
    - The banner then reads "You're signed out. You have unsaved ink."
    - Reason: the ordinary sign-out confirmation ("Sign out anyway") does not offer Export, so dropping held ink there would break the core rule.

### Packet item 3: keep-changes sign-out

- **One 5 s deadline overall.**
    - `signOutEndedSignIn` builds one deadline (`deadlineOf(SIGN_OUT_STORAGE_TIMEOUT_MS)`) and passes it to `settle`.
    - Every storage wait takes what is left of it: the Retry, stamping (or dropping and counting the outbox), and the cache clear.
    - Before, each step had its own 5 s, so up to 15 s.
- **The prompt never proceeds by itself on unmount.**
    - `useEndedSignInInkPrompt.askFirst` now resolves `true` (the student chose "Sign out now", or nothing is held) or `false` (the page unmounted with the prompt up).
    - On `false`, `ViewerPage` and `AssignmentsPage` do not sign out. The ink stays held, and the next page that finds the sign-in ended asks again.
    - There is still no time limit (decision 62, answer 1).
- **After a time-limited sign-out,** anything still held goes through the item-2 path: retired, kept in memory, banner, not a silent clear.
    - The prompt copy now says so: "Signing out tries once more to save them; any it can't stay only in this tab until you close it. Export a copy first to keep them."

### Packet item 4: partials

| Partial | Fix |
| --- | --- |
| r2 MAJOR 1(ii): `createMany` applies marks after a cancelled await | `createMany` captures epoch and generation, and after its snapshot await throws `RecoveryCancelled` without applying anything if either changed. The same check was added to: the update/delete/restore path of `commit` (after its snapshot await: not applied, returns false); `replayEntry` (undo/redo; before every chunk after the first); and `restoreFromSnapshot` (stops when memory was reset). |
| r2 MAJOR 1(ii): `persistMany` rolls back only `HeldInkFull` | It now also rolls back on `RecoveryCancelled`. The cancelled ops are held as the signed-out account's ink (`keepCutOff`), not drawn by the store. |
| r2 MAJOR 2(iv): `noteRefusedEdit` creates entries and counts refusals when admission fails | When admission fails it now makes no entry and counts no refusal. It notes an overflow instead, in `overflowNotes`, a counter map kept apart from the entries; the banner says the change wasn't made. `holdOps` does the same for refused ops (before, it made an overflow-only entry). The new test calls `noteRefusedEdit` itself. |
| r2 MAJOR 1(i): a running transaction can commit after cancellation | Three layers. (a) A final `live()` check after `bulkAdd` inside the transaction, so a sign-out during the outbox write, or a stall in it, rolls everything back, mirror row included. (b) A write counts as done only if `live()` still holds when its completion is seen; otherwise its ops stay held. (c) The ids of writes in flight at sign-out are recorded as cut off; their rows, should they commit anyway, are ignored by `opOwnerFor` and swept by `sweepCutOffWrites` on every `load()` (hydrate) and `attach()`. Tested. |

### Packet item 5: tests

All listed below. They include the three the packet names: a stall **inside** the transaction, a cross-tab sign-out while the other tab holds ink, and Dismiss followed by Export.

### Codex round-3 findings

| Finding | Status in this round |
| --- | --- |
| NEW MAJOR 1: Dismiss destroys the only conflict copy | Fixed (item 1) |
| NEW MAJOR 2: cross-tab cleanup discards another tab's held ink | Fixed (item 2) |
| PARTIAL r2 MAJOR 1(i): active transaction can commit after cancellation | Fixed (item 4, three layers) |
| PARTIAL r2 MAJOR 1(ii): unguarded editing continuations; `persistMany` without `RecoveryCancelled` rollback | Fixed (item 4) |
| PARTIAL r2 MAJOR 2(iv): `noteRefusedEdit` admission | Fixed (item 4) |
| r2 "stalled keep-changes" FIXED but per step | Now one 5 s deadline overall (item 3) |
| Silent-drop: ended-sign-in hook proceeds on unmount | Fixed (item 3) |
| Silent-drop: keep-changes timeout outcome not reported | What remains is no longer dropped: it is kept and shown in the signed-out banner (item 3) |
| Untested 3: test permitted the first chunk to commit after clearing | Replaced: the multi-chunk test now asserts exactly the chunk before the sign-out is written and the rest kept; a new test stalls inside the transaction and asserts the whole transaction rolls back |
| Untested 4: no editing continuation after reset | Added (createMany, update) |
| Untested 5: stall occurred before the transaction | Added a stall inside it (session-level and registry-level) |
| Untested 6: "refused-only" test did not call `noteRefusedEdit` | Added a test that does |

### Requester answers and decisions 62/63

- **Fix1 (a)** "document close" = purge: unchanged. `forgetDocInk` still drops a purged score's held ink (deleted, left, access lost). See open question 1.
- **Fix1 (b):** unchanged.
- **Fix1 (c):** superseded by the core rule as instructed. At the memory bounds, new failed edits are still refused visibly (undone, with the banner). Nothing already held is ever dropped by the registry, and held ink now leaves only by Discard (with confirmation), tab close, or another account signing in.
- **Decision 62.1**, no auto timeout on the prompt: kept. Combined with item 3, it also never proceeds on unmount.
- **Decision 62.2**, superseded: Dismiss only hides (item 1).
- **Decision 62.3**, the 3 s Retry server check: unchanged.
- **Decision 63:** every point above (Dismiss hides; Discard confirms; the broadcast keeps ink with the banner until Discard, tab close or another account; 5 s overall; no proceeding on unmount; stale rows swept on load).

## How the core rule is enforced: every path that can remove held ink

| Path | What removes it now | Explicit choice that guards it |
| --- | --- | --- |
| Conflict banner Dismiss | Nothing: it only hides the notice | n/a |
| Conflict banner Discard → `discardConflicts` | The held versions of overtaken marks | Confirmation dialog with **Export first**; shown only where Export is available |
| Signed-out banner Discard → `discardSignedOutInk` | The signed-out account's held ink | Confirmation dialog with **Export first** |
| Sign-out here or in another tab, any flavour (`retireAccountInk`) | Nothing: writes cut off, ink kept | n/a |
| Another account signs in on the tab (`accountSignedIn`) | The signed-out accounts' ink | Allowed by the packet. The banner (with Export) is up from the sign-out until then |
| Tab close | Everything in memory | The browser's leave-page prompt (`hasUnsavedInk` includes signed-out ink and conflicts) |
| A later edit of a conflicted mark (`appendHeld`) | The older held version of that mark | The user's own newer edit of it (unchanged; Codex: "treated as new user intent") |
| Successful write or Retry (`releaseHeld`) | Held ops, now durable | n/a (saved, not lost) |
| Compaction of consecutive held updates | Superseded versions of one mark | n/a (latest intent kept) |
| Cut-off write (`keepCutOff`) after another account signed in meanwhile | That write's ops | The other account's sign-in, as above |
| `forgetDocInk` (score purged) | That score's held ink | **Not guarded by an Export choice**; unchanged by the packet. See open question 1 |
| Previous-day owed snapshot | Yesterday's starting point (not ink) | Accepted follow-up |
| `resetInkRecoveryForTests` | Everything | Tests only |

## Tests added or changed

New test files:

- `src/features/student/useEndedSignInInkPrompt.test.tsx`
- `src/features/viewer/SignedOutInkNotice.test.tsx`

The suite went from 224 files / 3470 tests at `86f632c` to **226 files / 3497 tests** (13 skipped as before).

| Case (Codex untested / packet item) | Test (file › name) |
| --- | --- |
| **Stall inside the transaction** (item 5) | `src/features/auth/session.test.ts` › "stalled inside the transaction, with every later step stalled too: signed out within one 5 s deadline, and the write rolls back when storage answers". The outbox write hangs inside a live transaction (`Dexie.waitFor`), stamping and the cache clear hang too, and sign-out settles at 5 s (asserted 4.95–7 s, not 15). When storage answers, the transaction's last check rolls it back (no op, mirror row unchanged), and the ink is still held for Export. `src/sync/annotationStore.recovery.test.ts` › "a stall inside the transaction: the sign-out cuts the write off, which then rolls back whole when storage answers" |
| **Cross-tab sign-out while the other tab holds ink** (item 2) | `annotationStore.recovery.test.ts` › "cross-tab sign-out while this tab holds ink: writes stop at once, the ink stays for Export or Discard, and the notice says so"; "keeps it too on the storage-event fallback"; "tells them by BroadcastChannel" |
| **Dismiss followed by Export** (item 1) | `src/features/export/exportAnnotations.test.ts` › "Dismiss followed by Export: the hidden conflict is still in the export (round 3, item 1)"; `InkSaveFailedNotice.test.tsx` › "when a newer version overtook the held marks: says so, offers Export, Dismiss and Discard, and no Retry (MAJOR 2)" (Dismiss, then the conflict is still in `heldInkForExport`) |
| Discard with confirmation offering Export (item 1) | `InkSaveFailedNotice.test.tsx` › "Discard asks first, offering Export, and only its confirm lets the conflicts go (round 3, item 1)"; "offers no Discard where Export cannot be offered first". `annotationStore.recovery.test.ts` › "Dismiss only hides the notice: the conflict stays for Export; Discard lets it go (round 3, item 1)"; "a newly overtaken mark shows the hidden conflict notice again" |
| Erase-only conflicts get Export (item 1) | `InkSaveFailedNotice.test.tsx` › "when the overtaken change was an erase: says so, and offers Export too (round 3, item 1)"; `exportAnnotations.test.ts` › "an overtaken erase: the export shows the newer version, and says the erase was overtaken (round 3, item 1)" |
| Signed-out banner: Export / Discard (items 2–3) | `SignedOutInkNotice.test.tsx` › "is not there while nothing of a signed-out account is held"; "after a sign-out in another tab: says so, with Export and Discard"; "Export lists each score, exported for the account that made the marks"; "Discard asks first and offers Export; only its confirm discards" |
| Signed-out ink lifecycle (item 2) | `annotationStore.recovery.test.ts` › "is out of Retry and of every write: the account's writes are cut off at once"; "is listed for the notice, and goes only on Discard"; "comes back to the same account signing in again: drawn and retried as before"; "goes when another account signs in here"; "keeps the score's PDF and title from its viewer for Export, after the viewer has closed". `exportAnnotations.test.ts` › "signed out with ink still held here: the export has only that account's unsaved marks, and says so (round 3, item 2)" |
| Prompt never proceeds on unmount (item 3) | `useEndedSignInInkPrompt.test.tsx` › "goes straight on when the account holds nothing"; "waits on the student, then goes on when they choose to sign out"; "never goes on by itself when the page unmounts: no sign-out, and the ink stays" |
| 5 s overall (item 3) | The session test in the first row (all three storage steps stalled; settles at one deadline) |
| **Stale-epoch sweep on load/attach** (item 4) | `annotationStore.recovery.test.ts` › "a write whose transaction commits after the sign-out cut it off: kept in memory, and its rows swept as stale on the next load". It checks that the committed op is a cut-off write, that `opOwnerFor` says nobody owns it, and that the edit is kept for Export and not drawn. On the next load the op, the mirror row it wrote and the watermark are gone, and the following pull draws the server's version. Also "a store attached after a late commit sweeps it too" |
| **`noteRefusedEdit` admission failure** (item 4) | `annotationStore.recovery.test.ts` › "noteRefusedEdit past the bounds makes no entry and counts no refusal: said as overflow instead" (calls `noteRefusedEdit` directly) |
| **`createMany` after a cancelled await** (item 4) | `annotationStore.recovery.test.ts` › "createMany applies nothing after a cancelled await (sign-out during its day-snapshot check)"; "createMany applies nothing once memory was reset for another account while it waited"; "an edit of an existing mark resuming after the reset is not applied to the next account's memory" |
| **`persistMany` rollback on `RecoveryCancelled`** (item 4) | `annotationStore.recovery.test.ts` › "persistMany rolls back on RecoveryCancelled: a cancelled create is not left drawn" (store not attached, so only the rollback hides it); "an edit queued behind held ink when the account signs out is not written, and is kept with it (persistMany rolls it back)" |
| Multi-chunk write (Codex untested 3) | `annotationStore.recovery.test.ts` › "sign-out between the chunks of a long write: no later chunk writes, and what was not written is kept" |

**Existing tests that asserted deletion, and how they changed.** Each now asserts that the ink is kept for Export (`heldInkForExport`) and is out of every viewer and Retry.

- `annotationStore.recovery.test.ts`:
    - "drops that account's held ink when another tab signs it out (BroadcastChannel)" became the cross-tab test above (Codex cited it at `:366`).
    - "drops it too on the storage-event fallback" became "keeps it too…".
    - "clears only the signing-out account's held ink…" became "cuts off only the signing-out account…".
    - "clear during a multi-chunk write…", "a Retry started before the sign-out…", "an edit queued behind held ink…", "a day-snapshot failure that lands after the sign-out…" and the two retained-store tests now assert retention.
    - "Dismiss lets the conflicts go…" became "Dismiss only hides the notice…".
- `annotationStore.persistFailure.test.ts` › "a sign-out that cannot tell whose session it ended (retireAccountInk()) cuts off every account's held ink, keeps it for Export, …". Before, it asserted every account's ink was forgotten. It now also asserts that another account signing in lets it go.
- `session.test.ts`:
    - "cuts off the account's marks this device could not store (SF-1), keeping them in this tab…", which before asserted `signOut()` forgot them.
    - "stalled keep-changes sign-out…" now asserts the ink is kept after the timeout and after the stall ends.
- `InkSaveFailedNotice.test.tsx` › "leaves the viewer when its account signs out; the ink stays for the signed-out notice (round 3)". It was "goes when sign-out clears the account's held ink".
- `InkSaveFailedNotice.test.tsx` erase-conflict test: it asserted no Export; erase-only conflicts now get Export, per item 1.

## Screenshots (report branch only)

They are under `launchfix-p2-fix3-screenshots/` on `claude/launchfix-p2-fix3-report`. Each name has a `<vp>` suffix for `iphone-14`, `iphone-se`, `android-small` and `desktop-1440`. The script is `launchfix-p2-fix3-screenshots/r3-phone.mjs`, using `scripts/ui/uifuzz.mjs` from the ui-check skill.

- `banner-signed-out-other-tab-<vp>.png`: **the new banner** (phones and desktop).
    - A second tab of the same browser called the app's own `signOut()`, while this tab held two unsaved marks on a seeded cloud score.
    - This tab, now on the landing page, shows "You were signed out in another tab. You have unsaved ink." with Export and Discard.
- `signed-out-export-<vp>.png`: the banner's Export dialog, with the score row and its Export menu.
- `signed-out-export-notice-<vp>.png`: after "Send page 1 as photo". The menu stays open with "You're signed out, so this export has only the 2 unsaved marks this tab still holds, not the score's saved marks."
- `signed-out-discard-confirm-<vp>.png`: the banner's Discard confirmation (Cancel / Export first / Discard). Confirming removed the banner.
- `banner-conflict-erase-<vp>.png`: an overtaken erase on a device-only score, now with Export, × (Dismiss) and Discard.
- `conflict-discard-confirm-<vp>.png`: the conflict Discard confirmation.

Results from the check:

- Banner heights:
    - Conflict strip: 52 px (iPhone 14), 71 px (iPhone SE, Android small), 53 px desktop.
    - Signed-out strip: 52 / 71 / 71 / 55 px.
- After Dismiss, the strip is gone and the conflict is still held (`conflictsKept: 1`).
- No console errors in any viewport.
- `audit()` showed no off-screen or clipped items on the strips. It listed only the expected "obscured" entries under open dialogs, and the landing footer's small links (unchanged by this PR).
- The check found two layout problems, both fixed in `0ca6c92` and re-shot:
    1. At 360 px the conflict strip squeezed its copy to five lines beside three text buttons. Dismiss is now an × and the phone copy is shorter.
    2. The Export menu's notice was clipped inside the export dialog. The dialog now leaves room under its rows.
- **Not reached through a real viewer:** the seeded cloud scores' PDFs don't load on the local stack (storage answers 400, "Couldn't open this score"). So for the signed-out banner the two held marks were put on a seeded score through the app's own `inkRecovery` module, with the fixture PDF registered as its viewer would (the same approach as round 2). The sign-out itself was real, in the other tab.
- The ended-sign-in prompt was not screenshotted, for the same reason as round 2: reaching it needs the teacher to archive or reset a seeded student. It is covered by the hook tests and the existing viewer and assignments tests.

## Local check results (final tree `0ca6c92`, before its push)

| Check | Result |
| --- | --- |
| `npm run lint:check` | pass (exit 0) |
| `npm run typecheck` | pass (exit 0) |
| `npm run test` | pass: **226 files passed, 5 skipped (231); 3497 tests passed, 13 skipped (3510)** |
| `npm run build` | pass (built in 2.9 s) |
| `npx prettier --check` on every touched `.ts`/`.tsx` | pass ("All matched files use Prettier code style!") |

The test run was made with `.env.local` moved aside, as in CI. With it in place, an unrelated `syncEngine.test.ts` test hit the local Supabase over undici, an environment artefact.

## CI on the final head (`0ca6c92ec186de1bc0038d4e65cd81f638ee221f`)

Runs: push 39761010499, pull_request 39761016648. Still running at the time of this commit; the final table follows in the next commit on this branch.

## Files touched (`86f632c..0ca6c92`: 23 files, +1865/−230)

- **New:**
    - `src/sync/cutOffWrites.ts`, `src/sync/inkRecoverySignal.ts`
    - `src/app/SignedOutInkGate.tsx`, `src/features/viewer/SignedOutInkNotice.tsx`
    - Tests: `src/features/viewer/SignedOutInkNotice.test.tsx`, `src/features/student/useEndedSignInInkPrompt.test.tsx`
- **Sync:**
    - `src/sync/inkRecovery.ts`, `src/sync/annotationStore.ts`
    - `src/sync/opOwnership.ts`: cut-off writes are nobody's.
    - `src/sync/db.ts`: a plain `PendingOp.inkWrite` field, no Dexie version bump.
- **Auth:** `src/features/auth/session.ts`
- **Export:** `src/features/export/exportAnnotations.ts`
- **UI:**
    - `src/app/App.tsx` (mounts the gate)
    - `src/features/viewer/InkSaveFailedNotice.tsx`, `src/features/viewer/ViewerPage.tsx`
    - `src/features/student/useEndedSignInInkPrompt.ts`, `EndedSignInInkPrompt.tsx`, `AssignmentsPage.tsx`
- **Tests changed:** `annotationStore.recovery.test.ts`, `annotationStore.persistFailure.test.ts`, `session.test.ts`, `InkSaveFailedNotice.test.tsx`, `exportAnnotations.test.ts`
- **Not touched:**
    - `src/sync/wire.ts`, `src/sync/remoteInkBuffers.ts` (P3), `src/sync/realtimeChannel.ts` (P4).
    - No migrations, edge functions, CI workflows, toolbar controls or teacher/student layers.
    - `InkController.ts` needed no change: its fire-and-forget edits already go through `settleEdit`, which catches the new `RecoveryCancelled` the same way.

## Deviations and interpretations

1. **Every sign-out keeps held ink, not only the broadcast** (item 2). Ordinary `signOut()`'s confirmation offers no Export, so clearing there would break the core rule. All sign-outs now cut off and keep.
    - Side effect, by design: on a shared device, whoever uses the tab next can Export or Discard the signed-out account's unsaved marks (and only those) until another account signs in or the tab closes. See open question 2.
2. **"Ignore and sweep rows whose account epoch is stale"** is implemented with **per-write ids** rather than an epoch number stamped on rows.
    - An epoch number on its own can't tell a row committed just before the sign-out (legitimate, and kept by keep-changes) from one committed just after (stale).
    - The tab knows exactly which of its writes were still on their way when the epoch moved; those ids are recorded as cut off (`cutOffWrites`).
    - A row is "stale" when its write's epoch was cut off before its completion was seen. Such a write's ink is still held in memory, so the sweep never loses anything.
    - The ids are random and stored in localStorage (no account ids), capped at 500.
3. **The sweep resets the score's pull watermark** when it deletes a stale mirror row, so the next pull brings the server's version back. Without that, a delta pull past the row's seq would leave the mark missing.
4. **Discard on the conflict banner appears only where Export can be offered.** On an unconfirmed (cache-painted) cloud viewer there is no Export menu yet, so only Dismiss is shown there.
5. **Dismiss is an × icon** (with an accessible name and a title), so three actions fit on a phone.
6. **Edits of an existing mark cut off before they were drawn** (sign-out during their snapshot check) are dropped, as a peer erase in that window already was. The user never saw them applied. A drawn mark cut off (a stroke, or an edit already drawn) is kept.
7. **Cut-off ops bypass the memory bounds.** They are at most the writes under way at sign-out, and refusing them would lose drawn ink without the user seeing the overflow banner (the store is reset at sign-out).
8. **`retire` with no known account** (`retireAccountInk()`) retires every account seen in the tab, as `clearAccountInk(undefined)` cleared them all before.

## Follow-ups (not done here)

Accepted in decision 62:

1. **Per-tab held ink.** A crash or OS kill still loses it. The signed-out ink is per tab too.
2. **The prior-day snapshot.** A Retry on a later day still drops yesterday's owed starting point.
3. **Ordinary `signOut()` with no time limit.** Its storage waits (`syncBeforeSignOut`, the cache clear) are still unbounded. Network waits in `signOutThisDevice` are unbounded on both paths; the 5 s deadline covers storage only.
4. **PDF export from the ended-sign-in prompt.** The same limit now applies to the signed-out banner: a PDF export needs a server claim, which a signed-out tab cannot make, so it fails closed with the menu's message. "Send page N as photo" works offline from the kept PDF.

New:

5. **The signed-out Export dialog exports the focused page** (`focusedPageIndex` from the last viewer), like the ended-sign-in prompt. A per-page picker, or a multi-page photo export, would let the user reach marks on other pages without a PDF claim.
6. **The signed-out strip is fixed to the bottom of the screen** and can cover the last ~55–70 px of a long page (the landing footer) until Export or Discard. A page-level inset could avoid that.
7. **`forgetDocInk` on purge** still drops held ink without an Export choice. See open question 1.
8. **The UI check simulates the failure** (a throwing `add`) and held the signed-out ink through `inkRecovery`, because the seeded cloud PDFs don't load locally.

## Open questions

1. **Should a purged score's held ink (`forgetDocInk`: score deleted, left, or access lost) also go through an explicit Export/Discard choice?**
    - The requester's fix1 answer (a) accepted dropping it, Codex did not charge it, and the packet does not list it, so I left it unchanged.
    - Decision 63's wording is categorical, though.
    - Note: when access was revoked, exporting would mean keeping the owner's PDF on a device that lost access.
2. **Shared devices:** after any sign-out, the signed-out account's unsaved marks stay exportable in that tab until another account signs in, Discard, or tab close. Is that acceptable for a studio iPad, or should the banner also require a sign-in (or time out) before Export?
    - This is what the packet specifies for the broadcast case. I extended it to every sign-out (deviation 1).

## Hosted steps left for Max (none performed)

1. None are needed for this round: no migrations, functions, config or secrets changed.
2. The earlier P2 hosted steps still stand, unchanged: turn on Turnstile with the matching site key and secret and then run the CSP smoke, and check the og link previews after deploy.

## Expected conflicts with the other launchfix PRs

Checked with `git merge-tree` of `0ca6c92` against each launchfix branch on origin at the time of writing:

| Branch (head) | Files in common with #68 | Merge |
| --- | --- | --- |
| `mh/launchfix-p1-db-release-safety` (`3575c73`) | `src/features/library/documentsService.ts` | clean |
| `mh/launchfix-p3-edge-hardening` (`9889262`) | none | clean |
| `mh/launchfix-p4-realtime-revocation` (`657d9cd`) | `src/features/viewer/ViewerPage.tsx`, `ViewerPage.test.tsx` | clean |
| `mh/launchfix-p5-district-retention` (`4ffd856`) | none | clean |
| `mh/launchfix-p6-golive-docs` (`7ae2ee5`) | `DEPLOY.md` | clean |

- This round touched `ViewerPage.tsx` again: the `rememberScoreSource` effect, and the ended-sign-in effect, which no longer signs out when the prompt unmounts. That file is shared with **P4**.
- `merge-tree` reports no conflict, but whoever merges second should re-run `ViewerPage.test.tsx`.
- `src/app/App.tsx`, `src/sync/db.ts` and `src/sync/opOwnership.ts` are new overlaps with dev, but no other launchfix branch touches them.
