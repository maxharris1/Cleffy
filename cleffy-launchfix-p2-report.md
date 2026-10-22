# Launchfix P2 (client safety): report

Packet: BL-5 (sign-out fallback), SF-1 (visible ink save failures), SF-5 (Turnstile CSP), SF-16 (og tags).

## Summary

- **PR:** #68, https://github.com/maxharris1/Cleffy/pull/68
    - Title: "launchfix P2: sign-out fallback, visible ink save failures, Turnstile CSP, og tags"
    - A **draft** from `mh/launchfix-p2-client-safety` into `dev`.
    - No reviewers requested. Nothing merged.
- **Base SHA:** `47e9b38f2dba36fdce852c80948245da344bcc20` (dev at session start; dev had not moved, so there is no second SHA).
- **Final PR head SHA:** `0508174c16f6f5e500e3748ef07724b8aadd54c3`
- **Report branch:** `claude/launchfix-p2-report`. It is cut from that head plus this one commit. The report is not on the PR branch.
- **CI on the final head:** all green. `mergeable_state: clean`.
- **Done-when list:** every item is met.
    - Draft PR open with green CI.
    - Sign-out failure tests pass.
    - The banner shows on a forced failure and clears on retry (ui-check on desktop, iPad portrait and iPhone 14).
    - CSP smoke with the Turnstile test key is clean.
    - og tags point at cleffy.io.
    - `npm run cloud:down` has run.

## Environment confirmation

- This ran in the **Cleffy cloud environment** (`env_01WAd3yiz3qpSnsofpyEwCh2`), confirmed with `get_session` at the start. It did **not** run in Sandbox.
- I used the **local Supabase stack only**: `npm run cloud:up` in the background, then `npm run cloud:down` at the end.
- I made no contact with hosted Supabase (prod `jibgwgosihadbjgxdsfe`, dev `qdbnlrgylelelvwbkvnm`) and none with Stripe.
    - The CSP smoke stubs the dev project's URL with Playwright route handlers, so no request reaches it.
- I printed no keys or secrets, committed no `.env` files, and did not run `playwright install`. The preinstalled Chromium at `/opt/pw-browsers/chromium` was used.
- I sent no messages to other sessions.
- Hard rule 2 (fresh worktree of origin/dev): the session started from a fresh checkout at 47e9b38f, and the branch was cut with `git checkout -B mh/launchfix-p2-client-safety origin/dev`. HEAD was confirmed equal to 47e9b38f.
- **Branch names:** the harness gave this session a default branch, `claude/launchfix-p2-client-safety-honqa3`. I did not use it. Per the task, the work went only to `mh/launchfix-p2-client-safety` and `claude/launchfix-p2-report`.
- **Commit identity:** every commit is authored as Max Harris <drumaxter@gmail.com>.

## Commits (PR branch)

| SHA                                        | Summary                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `6ee39ac24244dd7126011eefb8655a5e54c335f3` | fix(auth): forget this device's session when sign-out cannot reach the server (BL-5) |
| `c8f10c9483a893cd16a095c3f90fd4f6b266484a` | fix(csp): allow the Turnstile challenge in script-src and frame-src (SF-5)           |
| `7d2bee1c28478fe4aaa274fa17ffd0d10c99102c` | fix(meta): point og/twitter url and image at cleffy.io (SF-16)                       |
| `0508174c16f6f5e500e3748ef07724b8aadd54c3` | fix(ink): keep marks the device could not store, and say so (SF-1)                   |

The report branch adds one more commit on top: this file.

## What changed

### BL-5: sign-out fallback

The code was at the lines the packet gave: `session.ts:351`, plus `signOutEndedSignIn` at `:430-435`.

- **New helper, `signOutThisDevice`.** It runs `auth.signOut({ scope: 'local' })` and catches both an `{ error }` result and a throw. On either:
    1. It calls `forgetStoredSessions()` from `authStorage.ts`. That already removes every `*-auth-token` key **and** expires the `cleffy-auth-restore` cookie (`clearRestoreCookie`), so `authStorage.ts` needed no change.
    2. It then runs a second local `signOut`. With storage empty, supabase-js sends no request. It does remove the session from the client, emit `SIGNED_OUT` (so `useSession` and realtime's token update) and leave `getSession()` returning null **without a reload**.
- `signOut()` and `signOutEndedSignIn()` both use the helper now.
- **Behaviour change:** sign-out now resolves instead of throwing when the server can't be reached. This device is signed out either way. The server-side refresh token is left to expire.
- **What supabase-js 2.111 already does:** it removes the stored session when `/logout` answers a 5xx or a network error. It still **keeps** the session in two cases, and those are the real holes:
    - The access token has expired and the refresh it attempts first fails. That is the common case offline: `_signOut` returns the refresh error before removing anything.
    - `signOut` throws (the auth lock, or a rejected initialisation).
- **Tests:** `src/features/auth/signOutFallback.test.ts`, 5 tests. They use the real supabase-js client on the app's own storage adapter, with only the network faked. The cases are:
    - offline with an expired token (network failure)
    - `/logout` answers 503 (5xx)
    - `auth.signOut` throws
    - a restore cookie on its own
    - a normal sign-out, which makes exactly one request

    Each case checks that `getSession()` is null in the same client, then simulates a reload (a brand-new client on the same storage) and checks that it restores nothing. Against the old `session.ts`, the offline and throw cases fail. The 503 case passes on both, because of the supabase-js behaviour above.

### SF-1: visible "couldn't save" state for ink

The code was at the lines the packet gave: InkController `:690, :858, :964, :1011`; annotationStore `persistMany` `:934-951` and `whenSaved` `:566-580`.

- **(a) Store** (`src/sync/annotationStore.ts`):
    - A mirror/outbox write that throws no longer drops the edit. Its ops go into `failedOps`, in order, and the marks into `failedPersist`. The store notifies through the existing meta channel (`subscribeMeta`), and the mark stays drawn.
    - New members: `hasPersistFailure(id)`, `persistFailureCount`, `unsavedAnnotations()` and `retryFailedPersist()`.
    - A later edit of a failed mark is held behind it, not written, so the outbox never has a newer op without the older one.
    - Remote applies, mirror reloads and `dropAbsent` leave failed marks alone.
    - A new stroke whose day-snapshot write fails is held the same way.
    - Undo, redo and bulk-create failures are held too, and the page repaints from memory.
    - Module-level helpers `unsavedMarkCount()` and `unsavedMarksFor(docId)` cover every store with a failure, so sign-out and export can see these marks.
- **(b) `whenSaved`** still only resolves; its doc comment now says callers must check `hasPersistFailure`. The places that treated "saved" as success now check it:
    - **Reconcile and sync** (`src/sync/syncEngine.ts`):
        - A mark with a failed write is held out of the drain: no push of its queued ops, and no reconcile verdict without the edit. Otherwise reconcile could adopt the server row, and a later retry would put the edit onto a tombstone (the QA C1 pattern).
        - Inside the reconcile transaction, a mark whose write failed while reconcile was waiting is left as queued.
        - With anything held, the score shows `error` instead of claiming `synced`.
    - **Export** (`src/features/export/exportAnnotations.ts`): the in-memory versions of failed marks are laid over the mirror's rows, including tombstones, so an erase that failed to save is still honoured.
    - **Sign-out sync** (`syncBeforeSignOut`): failed marks are added to `pending`, so the existing "Sign out with unsynced changes?" dialog warns about them.
- **(c) InkController and other fire-and-forget callers:**
    - The four InkController calls, the text-note and undo/redo calls in `PdfViewport.tsx`, and the toolbar undo/redo go through `settleEdit()`. It catches the rejection and logs it with `console.warn`, so there are no unhandled rejections.
    - **Banner:** `src/features/viewer/InkSaveFailedNotice.tsx`. It is one persistent, non-modal amber strip, the same style and slot as `SyncRejectedNotice` and `SyncHeldNotice`. There is no dismiss button.
        - Text: "Some marks couldn’t be saved on this device."
        - **Retry** re-runs persistence for the held ops. If it fails again, the banner adds: "Retrying didn’t work, so this device may be out of storage. Export a copy to keep them."
        - **Export** opens the existing Export menu, through a new `openSignal` prop on `ShareExportMenu`.
        - It appears in both the cloud viewer and the local-score viewer.
    - No toolbar controls were added (hard rule 6).
- **(d)** The banner clears as soon as a retry succeeds.
- **Tests:**
    - `src/sync/annotationStore.persistFailure.test.ts` (9 tests), with a Dexie write that throws `QuotaExceededError`:
        - the mark is flagged and kept drawn
        - `whenSaved` resolves while `hasPersistFailure` stays true
        - a later edit waits behind the failed one
        - a retry writes the held ops in order and survives a reload
        - a retry that fails again keeps everything held
        - a day-snapshot failure is held the same way
        - a remote row is held back from a failed mark
        - undo/redo writes are held and the page repaints
        - `settleEdit` raises no unhandled rejection
    - `src/features/viewer/ink/InkController.saveFailure.test.ts` (2 tests): a pen stroke and an eraser pass whose writes fail. Both raise no unhandled rejection and are flagged. Negative control: with the catch reverted to `void`, the pen test fails.
    - `src/features/viewer/ViewerPage.test.tsx` (+2 tests): a viewer render showing the banner (persistent, `role=status`, no Dismiss); Export bumps the menu's `openSignal`; Retry while still full keeps the banner; Retry after freeing space clears it. A second test checks there is no banner when nothing failed.
    - Also:
        - `syncEngine.test.ts` (+1): a held mark is neither pushed nor reconciled and the status is `error`; after a retry, everything syncs and the status is `synced`.
        - `exportAnnotations.test.ts` (+1): export includes the unsaved version of a mark.
        - `session.test.ts` (+1): sign-out counts unsaved marks.
        - `ShareExportMenu.test.tsx` (+1): `openSignal` opens the menu.

### SF-5: Turnstile in the CSP

- **`vercel.json`:**
    - `script-src` changes from `'self' 'wasm-unsafe-eval'` to `'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com`.
    - `frame-src` changes from `'none'` to `https://challenges.cloudflare.com`.
    - `connect-src` is unchanged. Cloudflare's reference asks for `connect-src 'self'` only for pre-clearance mode, which the app doesn't use, and `'self'` is already there.
    - Source: https://developers.cloudflare.com/turnstile/reference/content-security-policy/ (also cited in the PR).
- **`tests/security/securityHeaders.test.ts`:** updated for the new script-src, plus a new frame-src invariant.
- **`scripts/csp-smoke.mjs`:**
    - New `CSP_SMOKE_TURNSTILE=1` mode. On /login, /register and /student, the real challenge must load from `challenges.cloudflare.com`, mount its iframe, and return a token via `turnstile.getResponse()`.
    - /register now gets past the age screen first. It had timed out there since the consent age gate merged, which was a gap in the smoke itself.
- **`DEPLOY.md` step 12:** says how to run the new mode.
- No real keys were set. The test key `1x00000000000000000000AA` was passed only as a build-time env var for the local smoke build.

### SF-16: og/twitter tags

- `index.html`: `og:url` is now `https://cleffy.io/`; `og:image` and `twitter:image` are now `https://cleffy.io/marketing/og.jpg`. No `ngrok` reference remains.
- `public/marketing/og.jpg` exists and is 1200×630, matching the declared `og:image:width/height`.

## Local check results

All of these ran on the final head before the push:

| Check                                        | Result                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm run lint:check`                         | pass (exit 0)                                                                     |
| `npm run typecheck`                          | pass (exit 0)                                                                     |
| `npm run test`                               | pass: **222 files passed, 5 skipped (227); 3405 tests passed, 13 skipped (3418)** |
| `npm run build`                              | pass (exit 0)                                                                     |
| `npx prettier --check` on every changed file | pass ("All matched files use Prettier code style!")                               |

How the tests were run: `npm run cloud:up` writes `.env.local` with the local Supabase URL. With that file present, some existing tests send real requests and fail. Examples are `syncEngine.test.ts` "backs off exponentially…" (undici's timers end up in the captured `setTimeout`s) and snapshot pushes that hit local RLS. I confirmed the backoff test also fails without my changes while the file is present. So the full suite and the build ran with `.env.local` moved aside, which matches CI, and the file was put back afterwards. CI has no `.env.local` and passed the same suite.

### CSP smoke

Run from `scripts/csp-smoke.mjs` with `CHROMIUM_PATH=/opt/pw-browsers/chromium`. It can run here without a browser install. The builds were made with `VITE_SUPABASE_URL=` and `VITE_SUPABASE_ANON_KEY=` set empty, so the local `.env.local` URL is not baked in.

| Run                                                                                    | Result                                                                                                                                                                                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build with `VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA`, `CSP_SMOKE_TURNSTILE=1` | **24/24 PASS**, zero CSP violations. The Turnstile challenge loaded and solved on /login, /register and /student.                                                                     |
| Build without a site key (default)                                                     | **21/21 PASS**, zero violations                                                                                                                                                       |
| Negative control: same test-key build against **dev's old** `vercel.json`              | FAIL as expected: `Refused to load the script 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit' … script-src 'self' 'wasm-unsafe-eval'`, and no challenge frame |

### SQL proofs

None. This PR adds no migrations and no `tests/sql/*.sql` proofs, so there is nothing to report as pass/total.

### UI check (ui-check skill), SF-1 banner

- **Script:** a scratch copy of `uifuzz.mjs`. It signs in as the seeded teacher, opens `e2e-fixtures/test-score.pdf` through **"Open locally without uploading"** (a device-only score), and simulates a full disk by making `IDBObjectStore.add` throw `QuotaExceededError` for the `ops` store. It then draws a pen stroke.
- **Viewports and steps:** desktop-1440, ipad-portrait and iphone-14. On each one:
    1. The banner shows.
    2. Retry while still full keeps it and adds the extra line.
    3. Export opens the existing Export menu.
    4. After freeing the disk, Retry clears the banner.
    5. The stroke is undone afterwards.
- **Results:** `audit()` found nothing on any viewport, and there were no console errors.
- **Screenshots:** written in this session's scratchpad. That container is ephemeral, so the images may be gone when you read this, but the script reproduces them.
    - `/tmp/claude-0/-home-user-Cleffy/4afab472-1b20-5a19-83b9-02c8b63440d5/scratchpad/ui/banner-{desktop-1440,ipad-portrait,iphone-14}.png` (banner shown)
    - `…/ui/banner-retry-failed-{…}.png` (Retry while still full)
    - `…/ui/banner-export-{…}.png` (Export menu opened from the banner)
    - `…/ui/banner-cleared-{…}.png` (cleared after a successful Retry)
    - The script itself is `…/ui/banner-check.mjs`.
- **Why a local score:** the seeded cloud scores don't open on the local stack. Storage answers `NoSuchKey` for `scores/b0000000-…/original.pdf`, because the seed creates rows but no PDFs. Rather than upload files into shared seeded data, I used a device-only score. It renders the same `InkSaveFailedNotice` in the same strip position. The cloud viewer's banner is covered by the `ViewerPage.test.tsx` render test.

## CI on the final head (`0508174c16f6f5e500e3748ef07724b8aadd54c3`)

There are two workflow runs: one for the push and one for the pull request.

| Check                   | Run id (job id)            | Result                                    |
| ----------------------- | -------------------------- | ----------------------------------------- |
| checks                  | 39729123527 (119659846005) | success                                   |
| supabase-local          | 39729123527 (119659845790) | success                                   |
| supabase-drift          | 39729123527 (119659846053) | success                                   |
| omr-service             | 39729123527 (119659846073) | success                                   |
| checks                  | 39729087617 (119659726665) | success                                   |
| supabase-local          | 39729087617 (119659726372) | success                                   |
| supabase-drift          | 39729087617 (119659726494) | success                                   |
| omr-service             | 39729087617 (119659726523) | success                                   |
| Vercel Preview Comments | check 119660082635         | success (preview deployed)                |
| Supabase Preview        | check 119659854364         | skipped (integration skip; not a failure) |

There is no Claude Approvals check on this repo. The PR's `mergeable_state` is `clean`.

## Files touched

There are no migrations, and `scripts/apply-migrations.sql` was not regenerated (not needed). No edge functions or CI workflows changed. `src/sync/wire.ts` and `src/sync/remoteInkBuffers.ts` (P3's files) are untouched.

- **Config, page and docs:** `vercel.json`, `index.html`, `DEPLOY.md` (step 12 only), `scripts/csp-smoke.mjs`
- **Auth:** `src/features/auth/session.ts`, `src/features/auth/session.test.ts`, `src/features/auth/signOutFallback.test.ts` (new)
- **Sync:** `src/sync/annotationStore.ts`, `src/sync/annotationStore.persistFailure.test.ts` (new), `src/sync/syncEngine.ts`, `src/sync/syncEngine.test.ts`
- **Export:** `src/features/export/exportAnnotations.ts`, `exportAnnotations.test.ts`, `ShareExportMenu.tsx`, `ShareExportMenu.test.tsx`
- **Viewer:** `src/features/viewer/InkSaveFailedNotice.tsx` (new), `ViewerPage.tsx`, `ViewerPage.test.tsx`, `PdfViewport.tsx`, `toolbar/Toolbar.tsx`, `ink/InkController.ts`, `ink/InkController.saveFailure.test.ts` (new)
- **Security tests:** `tests/security/securityHeaders.test.ts`

## Deviations from the packet

1. **The fix reaches beyond InkController.** SF-1 also changes `syncEngine.ts` (hold and reconcile), `exportAnnotations.ts`, `ShareExportMenu.tsx` (the `openSignal` prop) and the fire-and-forget calls in PdfViewport and Toolbar. This is needed for (b): "anything that treats saved as success … must check it". It also stops the banner's Export from reading a mirror that lacks the marks.
2. **The CSP smoke changed in two ways beyond the Turnstile check.** /register now passes the age screen, a pre-existing gap since the consent gate merged. The smoke also needs `CHROMIUM_PATH` here; that's a run option, not a code change.
3. **The ui-check used a device-only score** because the seeded cloud scores have no PDF in local Storage (see above).
4. **Apostrophe.** The banner uses a typographic apostrophe ("couldn’t") to match the app's existing copy, such as "Couldn’t download this score…". The packet's text uses a straight one.

## Open questions

1. **Sign-out now resolves on a server failure.** The callers (`LibraryShell`, `AccountPage`, `AssignmentsPage`) only ever saw a throw if supabase-js threw. Is it right that the user is told nothing extra beyond being signed out on this device? The server-side refresh token stays valid until it expires, as already happens after an ended sign-in. A "sign out everywhere" control would close that, but it's out of scope here.
2. **A failed day-snapshot write on an erase or edit.** For an erase, update or delete (not a new stroke), a failed day-snapshot write still refuses the edit. It is never applied, so the mark simply stays as it was, with no banner. This matches the code before this PR. Should such edits be applied and held for retry instead, at the cost of possibly missing the day's starting point in History?
3. **Phone layout while the banner shows** (iPhone 14 screenshots). The floating pager/zoom strip sits over the top of the page, as it does whenever the score scrolls under it. The longer "Retrying didn’t work…" text makes the strip about five lines tall on a phone. Is that acceptable, or should it be shorter on narrow screens?
4. **Unsaved marks on a closed viewer.** If the viewer is closed while marks are still unsaved, they stay in that tab's memory until reload. Sign-out keeps counting them, which is accurate, but there's no UI to retry them from another viewer. Is it worth more than the banner's warning?
5. **The evidence files** (`/workspace/cleffy-launch-reaudit-*.md`) weren't available. Everything was settled from the packet's file and line references, which all still matched dev 47e9b38f. Nothing was left that depended only on those documents.

## Hosted steps left for Max (none performed)

1. **Turning Turnstile on** is still your step. Set `VITE_TURNSTILE_SITE_KEY` in the Vercel build and the matching secret server-side, together, as `turnstile.ts` explains. Then run the CSP smoke against that build with `CSP_SMOKE_TURNSTILE=1` (DEPLOY.md step 12), and check the live site's console on /login, /register and /student.
2. **After merge and deploy, check link previews.** A share preview, for example a Slack or iMessage unfurl or a social card debugger, should show `https://cleffy.io/marketing/og.jpg`. Debuggers may cache the old ngrok image.
3. Nothing in this PR touches hosted Supabase or Stripe.

## Expected conflicts with the other launchfix PRs

Checked with `git merge-tree` against the branches pushed at the time of writing:

| Branch                                         | Files in common                                                                       | Merge with P2                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `mh/launchfix-p1-db-release-safety`            | none                                                                                  | clean                                                                                                                           |
| `mh/launchfix-p5-district-retention`           | none                                                                                  | clean                                                                                                                           |
| `mh/launchfix-p6-golive-docs`                  | `DEPLOY.md` (P6 edits around lines 19-43 and ~1636; P2 edits step 12 around line 591) | clean (different hunks)                                                                                                         |
| P3 (`src/sync/wire.ts`, `remoteInkBuffers.ts`) | not pushed yet; P2 touches neither file                                               | none expected. P2 does change `annotationStore.ts` and `syncEngine.ts`; if P3 edits those too, expect a textual conflict there. |
| P4 (realtime)                                  | not pushed yet                                                                        | `syncEngine.ts` or `ViewerPage.tsx` may overlap if P4 changes realtime wiring there                                             |

Merge order per the packet: P2 goes second, after P1, and there is no file overlap with P1.

## Addendum (06:28 UTC): the PR head moved after this report

- **New PR head:** `b3c475738ec8fefc777fb2ecf8bd579b0c734332`, pushed at 06:21 UTC.
    - Commit: "fix(ink): hold unsaved ink per account and score, outside the viewer's store".
    - It came from a **different Claude session** (`Claude-Session: https://claude.ai/code/session_017pX2AtwtqfEAz7JVEUf5bh`), authored as Max Harris, addressing "Codex round 1 on PR #68".
    - It is a fast-forward on top of `0508174`. This session did not write it and pushed nothing to the PR branch after `0508174`.
- **What it changes:** it moves held ink into a new `src/sync/inkRecovery.ts`, keyed by account and score. It also touches:
    - `annotationStore.ts`, `syncEngine.ts`, `session.ts`, `exportAnnotations.ts`, `documentsService.ts`
    - `InkSaveFailedNotice.tsx` (short copy on phones; refused edits also show the banner)
    - `PdfViewport.tsx` and the tests

    Of the open questions above, it addresses #2 (refused edits now show the banner), #3 (phone copy) and #4 (a reopened score brings the held marks and banner back).

- **CI on `b3c4757`:** all green.

    | Check                   | Run id (job id)            | Result  |
    | ----------------------- | -------------------------- | ------- |
    | checks                  | 39733475574 (119673657452) | success |
    | supabase-local          | 39733475574 (119673657080) | success |
    | supabase-drift          | 39733475574 (119673657450) | success |
    | omr-service             | 39733475574 (119673657382) | success |
    | checks                  | 39733468371 (119673633813) | success |
    | supabase-local          | 39733468371 (119673633975) | success |
    | supabase-drift          | 39733468371 (119673633553) | success |
    | omr-service             | 39733468371 (119673633771) | success |
    | Vercel Preview Comments | check 119673890635         | success |
    | Supabase Preview        | check 119673633020         | skipped |

- **PR state:** still a draft, `mergeable_state: clean`, 5 commits, 28 files.
- **Not re-verified:** the local check counts, the CSP smoke and the ui-check screenshots above were all run on `0508174`, not on `b3c4757`.
- **Conflicts:** the follow-up adds `src/sync/inkRecovery.ts` and further edits to `annotationStore.ts` and `syncEngine.ts`. It still leaves `src/sync/wire.ts` and `remoteInkBuffers.ts` alone, so the P3/P4 conflict notes above apply unchanged.

## Addendum 2 (07:38 UTC): head `1ceeb9d`

- **Two more commits from a third Claude session** (`Claude-Session: https://claude.ai/code/session_01RBfRL6C9njE6etzJM2Didg`), both authored as Max Harris and both fast-forwards:
    - `7379a8b`: "fix(ink): bound keep-changes sign-out, cancel recovery writes per account, never drop held ink"
    - `1ceeb9d`: "fix(ink): server rows never overtake on the base seq; guard late snapshot failures after sign-out; tests"

    This session pushed none of them.

- **GitHub Actions on `1ceeb9d`:** all green.

    | Check            | Run id (job id)            | Result  |
    | ---------------- | -------------------------- | ------- |
    | checks           | 39740557187 (119696475850) | success |
    | supabase-local   | 39740557187 (119696475976) | success |
    | supabase-drift   | 39740557187 (119696475779) | success |
    | omr-service      | 39740557187 (119696475530) | success |
    | checks           | 39740551418 (119696456455) | success |
    | supabase-local   | 39740551418 (119696456491) | success |
    | supabase-drift   | 39740551418 (119696457059) | success |
    | omr-service      | 39740551418 (119696456812) | success |
    | Supabase Preview | check 119696448005         | skipped |

- **Vercel (commit status):** failure. It reads "Deployment rate limited — retry in 24 hours" (`api-deployments-free-per-day`, more than 100 a day).
    - This is the Vercel account's daily deployment cap on the free plan, which every branch's preview draws on, including the parallel launchfix PRs. It doesn't come from this PR's code.
    - Earlier previews of this branch (`0508174`, `b3c4757`) built and passed.
    - It can't be re-run from here. It clears on the first push after the limit resets, or when the plan's limit is raised (a Max step).
    - I posted one comment saying so: https://github.com/maxharris1/Cleffy/pull/68#issuecomment-6335245400
- **Not re-verified:** this session has not re-run the local checks, the CSP smoke or the ui-check on `7379a8b` or `1ceeb9d`.

## Addendum 3 (09:08 UTC): head `86f632c`, everything green

- **One more commit from the third session** (`session_01RBfRL6C9njE6etzJM2Didg`), a fast-forward authored as Max Harris:
    - `86f632cec71360dc87dbf4a4626ee9db041d8adc`: "fix(ink): erase-only conflicts offer no Export; keep the export menu in the gutter over a notice"

    This session did not push it.

- **CI on `86f632c`:** all green.

    | Check                   | Run id (job id)                         | Result                               |
    | ----------------------- | --------------------------------------- | ------------------------------------ |
    | checks                  | 39752325276 (119735667624)              | success                              |
    | supabase-local          | 39752325276 (119735668104)              | success                              |
    | supabase-drift          | 39752325276 (119735668217)              | success                              |
    | omr-service             | 39752325276 (119735668065)              | success                              |
    | checks                  | 39752334054 (119735698327)              | success                              |
    | supabase-local          | 39752334054 (119735698272)              | success                              |
    | supabase-drift          | 39752334054 (119735698258)              | success                              |
    | omr-service             | 39752334054 (119735698008)              | success                              |
    | Vercel Preview Comments | check 119736017404                      | success                              |
    | Vercel (commit status)  | deployment BpxaCkocYi9kojtm35dE8yfA5ENz | success ("Deployment has completed") |
    | Supabase Preview        | check 119735659586                      | skipped                              |

- **Vercel:** the rate-limit failure on `1ceeb9d` (Addendum 2) did not recur. The preview built and deployed on this head.
- **Not re-verified:** as before, this session has not re-run the local checks, the CSP smoke or the ui-check on the later heads.

## Addendum 4 (10:16 UTC): head `0ca6c92`, everything green

- **Two commits from a fourth Claude session** (`Claude-Session: https://claude.ai/code/session_01UoMJrKhKrHz5QiAXKAKGP6`), both fast-forwards authored as Max Harris:
    - `db55cab`: "fix(ink): sign-out keeps held ink for Export or Discard; Dismiss only hides; cut-off writes swept"
    - `0ca6c92ec186de1bc0038d4e65cd81f638ee221f`: "fix(ink): fit the conflict notice's three actions on a phone; room for the export menu in the signed-out export dialog"

    This session pushed neither.

- **CI on `0ca6c92`:** all green.

    | Check                   | Run id (job id)                         | Result  |
    | ----------------------- | --------------------------------------- | ------- |
    | checks                  | 39761010499 (119764885658)              | success |
    | supabase-local          | 39761010499 (119764886078)              | success |
    | supabase-drift          | 39761010499 (119764886162)              | success |
    | omr-service             | 39761010499 (119764886241)              | success |
    | checks                  | 39761016648 (119764906571)              | success |
    | supabase-local          | 39761016648 (119764906751)              | success |
    | supabase-drift          | 39761016648 (119764906730)              | success |
    | omr-service             | 39761016648 (119764906838)              | success |
    | Vercel Preview Comments | check 119765202789                      | success |
    | Vercel (commit status)  | deployment GaH7WxjoFU4noCfMf6Y7iEYqah24 | success |
    | Supabase Preview        | check 119764881541                      | skipped |

- **Not re-verified:** as before, this session has not re-run the local checks, the CSP smoke or the ui-check on the heads after `0508174`.

## Addendum 5 (13:19 UTC): rebased onto new dev; head `7c9c350`, everything green

- **Rebase:** at 13:08 UTC the PR branch was **rebased onto the new `dev` and force-pushed**. This session did neither; the committer reads Max Harris.
    - New base: `937c915ba45184455a46fdbd16940ceca964b34b`, "Merge pull request #69 from maxharris1/mh/launchfix-p1-db-release-safety", i.e. P1 merged first, which is the packet's merge order.
    - Old base: `47e9b38f`.
    - New head: `7c9c350484a6bb9e5983f743e97504306787488e`.
- **The rebase changed no content.** `git range-diff 47e9b38..0ca6c92 937c915..7c9c350` shows all 10 patches as identical (`=`).

    | Commit      | Before rebase | After rebase |
    | ----------- | ------------- | ------------ |
    | BL-5        | `6ee39ac`     | `b0bfaad`    |
    | SF-5        | `c8f10c9`     | `c15cdd9`    |
    | SF-16       | `7d2bee1`     | `9b56ff2`    |
    | SF-1        | `0508174`     | `3aa9f22`    |
    | Follow-up 1 | `b3c4757`     | `e6d0613`    |
    | Follow-up 2 | `7379a8b`     | `d3bf7c8`    |
    | Follow-up 3 | `1ceeb9d`     | `a0c7d69`    |
    | Follow-up 4 | `86f632c`     | `935668b`    |
    | Follow-up 5 | `db55cab`     | `03b63f8`    |
    | Follow-up 6 | `0ca6c92`     | `7c9c350`    |

    The SHAs earlier in this report are the pre-rebase ones.

- **CI on `7c9c350`:** all green.

    | Check                   | Run id (job id)            | Result                     |
    | ----------------------- | -------------------------- | -------------------------- |
    | checks                  | 39784936116 (119845499763) | success                    |
    | supabase-local          | 39784936116 (119845500091) | success                    |
    | supabase-drift          | 39784936116 (119845500271) | success                    |
    | omr-service             | 39784936116 (119845500169) | success                    |
    | checks                  | 39784942681 (119845523441) | success                    |
    | supabase-local          | 39784942681 (119845523089) | success                    |
    | supabase-drift          | 39784942681 (119845523270) | success                    |
    | omr-service             | 39784942681 (119845523314) | success                    |
    | Vercel Preview Comments | check 119845944545         | success (preview deployed) |
    | Supabase Preview        | check 119845491250         | skipped                    |

- **PR state:** draft, base `dev` @ `937c915`, `mergeable_state: clean`, 10 commits, 48 files.
- **Comments:** no review comments. The PR's three comments are two from Vercel and this session's rate-limit note.
- **This report branch** still sits on the pre-rebase history (`0508174` + report commits). It is a scratch branch and does not need rebasing.
- **Not re-verified:** as before, this session has not re-run the local checks, the CSP smoke or the ui-check on any head after `0508174`.

## Addendum 6 (13:28 UTC): PR #68 merged into dev

- **Merge:** at 13:25 UTC **maxharris1 marked PR #68 ready for review and merged it into `dev`**.
    - Merge commit: `e55a148da3b0efe3c8ba117975eea5cc94199a9b` ("Merge pull request #68 from maxharris1/mh/launchfix-p2-client-safety").
    - Its parent on the PR side is `7c9c350`, the head whose CI is recorded in Addendum 5 (all green).
- **This session's part:** it did not merge, approve or change the draft state. The merge was Max's.
- **Subscription:** the PR-activity subscription ended automatically when the PR closed.
- **Hosted steps still open** (unchanged from above):
    - Turning Turnstile on (site key and secret together), then running the CSP smoke on that build.
    - Checking link previews for the cleffy.io og image after deploy.
- **Open questions** in the main report that the later commits did not settle remain open, in particular #1 (sign-out resolving on server failure) and #5.
