# PR #78 round 1 fix packet: report

**Status: STOPPED before the push. `mh/try-demo` moved while this session was working.**

- Started from `bec4d7eb` (confirmed with `git rev-parse HEAD`).
- At 14:44 UTC another session (`session_01J1SysPpSyBDX2qjYULv8go`, the one that wrote the PR) pushed
  `bbd8901` "Address factory review round 1 on the /try demo" to `mh/try-demo`. It covers the same
  seven findings in the same 13 files.
- A fast-forward push is no longer possible. Force-push and merge are ruled out, and choosing between
  two competing fixes file by file is Max's call. So nothing was pushed to `mh/try-demo`, and the
  PR description is unchanged. Its `## Follow Up` section has **not** been added.
- This session's fix is kept as one commit, **`028a93b`** (author Max Harris), on branch
  **`claude/cleffy-pr78-r1-fixes-xhf99i`** (parent `bec4d7e`).
- `mh/try-demo` head is still **`bbd8901`**. Its CI was in progress at report time: `checks` and
  `supabase-local` were running; `supabase-drift`, `edge-functions-deno`, `omr-service` and Vercel had passed.

## Checks run on `028a93b` (local)
- `npm run lint:check`: clean
- `npm run typecheck`: clean
- `npm run test`: 267 files passed (6 skipped); **4127 passed**, 22 skipped, 0 failed
- `npm run build`: passes. The built `sw.js` still carries the `demo-score` rule.
- Prettier was run on every changed file.
- One browser pass on `vite preview`, measurements only, no screenshots, iPhone SE (320 px) and iPad
  with a coarse pointer:
  - every header and confirm-strip control has a hit area of at least 44 px;
  - the header doesn't overflow;
  - 0 requests to a Supabase host. The only "supabase" matches are the same-origin
    `supabase-preconnect.js` and the supabase-js chunk (Follow Up #2).

## Per finding (in `028a93b`)
1. **Fixed. A failed wipe mounts nothing.** `DemoViewer.tsx`: `wipeDemoInk` and the `wipeFailed`/`attempt` state.
   - On a new session or Start over, a failed purge with old ink still stored keeps the viewport unmounted.
   - The placeholder is an EmptyState: "Couldn’t clear your markings", with a secondary Try again that re-runs the wipe.
   - Start over stays disabled while that's showing.
   - If storage can't be read at all (nothing to show, e.g. site data blocked), the demo still opens. Without that, those browsers would be locked out of the demo for good.
   - Tests: both failure paths, plus the unreadable case.
2. **Fixed. The keep toggle shows what storage holds.**
   - `writeKeepMarkings` now returns a boolean. `startDemoSession` returns `{ wiped, remembered }` (whether the session marker stuck).
   - A refused keep write leaves the toggle as it was and shows a dismissible notice: "This browser isn’t keeping site data, so your markings clear when you close it." The help text in the header toggle, the lg help line and the phone menu item change to match.
   - A session marker that can't be stored makes the help say "…clear if you reload or leave."
   - Tests: `demoSession.test.ts` (quota error and blocked storage) and `DemoViewer.test.tsx`.
3. **Fixed. 44 px touch targets.**
   - `pointer-coarse:hit-44` on Start over, Keep, the ⋮ trigger, Start free, Clear and Cancel.
   - The ⋮ trigger gets `pointer-coarse:mx-1`, so its 6 px overhang clears Start over.
   - Test: a sweep over every control in the demo nav and confirm strip, plus the hint ✕ (7 controls). Measured in the browser too.
4. **Fixed. No "export" copy without an Export.**
   - `InkSaveFailedNotice.tsx`: `copy()` takes `canExport = onExport !== undefined`.
   - New no-Export copy for held + retry failed, overflow and conflicts. The Dismiss title also drops "Export".
   - Tests: 3 no-`onExport` renders, each checking that "export" appears nowhere in the notice.
5. **Fixed. New `src/features/demo/DemoViewer.test.tsx` (14 tests).**
   - It uses a stub viewport with a real `AnnotationStore` on a test `ScribblerDb`, and the real purge behind a gate.
   - Covered: (a) wipe before mount; (b) the Start over order (unmount → purge → purged → mount), with a fresh store, no undo and empty rows; (c) `fingerDraws` restored from both false and true; (d) the hint on the first stroke and with kept ink. Also the item 1 and 2 failure paths and the touch sweep.
   - The reviewers' mutations each now fail the suite: initial `'ready'`, purge before unmount, dropping the `fingerDraws` restore, the old failure → ready path, and a blind `setKeep`.
6. **Fixed. A missing score doesn't blame the connection.**
   - `demoScore.ts` throws `DemoScoreMissingError` for an HTTP error or a response that isn't a PDF.
   - `DemoPage` then shows "The demo score didn’t load. Try again, or come back in a minute." The connection and offline lines stay for other failures, and "it takes a second" is gone.
   - Tests: a 404 route test, the connection copy, and the error type.
7. **Fixed. The cache test runs real code.**
   - New import-free `demoScoreCache.ts` exports `DEMO_SCORE_URL_PATTERN`, which `vite.config.ts` now uses.
   - The test checks that the pattern matches `DEMO_PDF_REQUEST_URL` and doesn't match `/demo/fur-elise.html`, `/try`, `/try?utm…`, `/demo/` or `/score.pdf`.

No findings were declined.

## Not compared
I haven't reviewed `bbd8901` line by line against this commit. From its message, one behaviour differs:
- **`bbd8901`:** a failed Start over remounts on whatever is left and keeps the confirm strip up. The packet allows this.
- **`028a93b`:** the viewport stays down, with Try again.

Max decides which fix lands. If `bbd8901` stands, the PR's Follow Up section still needs adding.
