# PR #78: round 3 fix report (Introduced #1)

## Push
- **New head of `mh/try-demo`:** `ce7541a967af7d55c6bbd9f450741cdbfc832f16`, pushed to **mh/try-demo** as a fast-forward from `886e367b8215a519aaedb00b44735c6554cb8465`. Before the push, `git ls-remote` showed `886e367b`. The push was a plain `git push origin HEAD:mh/try-demo` with no force.
- **Author / committer:** `Max Harris <drumaxter@gmail.com> / Max Harris <drumaxter@gmail.com>`. There is no Claude or noreply author, and no co-author trailer.
- **Files changed:** only `src/features/demo/DemoViewer.tsx` (+15/−15) and `src/features/demo/DemoViewer.test.tsx` (+42).
- The PR is still a draft into `dev`. Nothing was merged or rebased, no review was posted, and nothing in Supabase changed.

## Introduced #1: **fixed**
- **The fix is in `src/features/demo/DemoViewer.tsx:23-58`.**
  - `demoInkRemains` is now an `async` arrow with no rejection handler. A failed `.count()` rejects, and so does a synchronous throw from `getDb()` or the `.where(...)` chain, because the `async` body turns the throw into a rejection.
  - In `wipeDemoInk`, when the purge has failed, `await demoInkRemains().catch(() => true)` treats a failed read as ink remaining and rethrows the **original purge error**.
  - A failed purge is still swallowed only when a read succeeds and returns 0.
- **Doc comments:** the old "One that cannot read either finds nothing… must still get the demo" is gone. The comment now says plainly that a browser where IndexedDB fails outright gets Try again rather than the demo, because failing closed wins.
- **Effect:** on both first load and Start over, the viewport stays unmounted and the existing "Couldn’t clear your markings" EmptyState shows with Try again. On first load, `startDemoSession` rejects, so the session marker is not set and a reload retries.
- **Tests added (`src/features/demo/DemoViewer.test.tsx`):**
  - `a failed wipe whose check cannot read either shows Try again, never the old ink` (first load, `:180-200`). It calls `seedInk()`, `refuseDeletes()` and `h.db.close({ disableAutoOpen: true })`, then renders. It asserts the heading, no `viewport`, no `mount` event, and `sessionStorage[DEMO_SESSION_KEY] === null`. Then `await h.db.open()`, `h.gate = null`, Try again: the viewport mounts and `annotatedPages()` is `[]`.
  - `a failed Clear whose check cannot read either keeps the viewport unmounted, rather than bringing the ink back` (Start over, `:293-311`). Clear runs with the purge refused and the database closed. It asserts the heading, no `viewport`, and events `['unmount', 'purge']`, so no remount and no old ink. After the database reopens, Try again remounts a blank store with `canUndo === false`.
- **The tests bite:** with `DemoViewer.tsx` reverted to `886e367`, both new tests fail (2 failed, 15 passed). With the fix, all 17 pass. The existing test `a failed wipe with nothing stored to show still opens the demo` still passes, because its read succeeds with 0.

## CI checks (local, Node 22.22.0)
- `npm run lint:check`: pass (exit 0)
- `npm run typecheck`: pass (exit 0)
- `npm run test`: pass. 268 files passed, 6 skipped. **4130 tests passed, 22 skipped, 0 failed.**
- `npm run build`: pass (exit 0)
- `npx prettier --write` on both changed files: no changes needed.
- **GitHub CI on `ce7541a`: all green.** `checks`, `supabase-local`, `supabase-drift`, `edge-functions-deno` and `omr-service` passed on both the push and pull_request runs. Vercel and Vercel Preview Comments passed, and Supabase Preview was skipped.

## PR description
- **Follow Up 11–15** are appended verbatim after item 10. Items 1–10 are untouched.
- **New item 16:** a browser where IndexedDB fails outright can no longer open the demo. This is the intended fail-closed trade-off. A possible later fix is an in-memory store that never hydrates from Dexie.
- **`## CI results`:** the head SHA is now `ce7541a` (all green), the test counts are 4130 passed / 22 skipped, and the `DemoViewer` count went from 15 to 17. The `886e367` result is kept as history. The rest of the description is unchanged; GitHub rewrote the attribution footer into its own format.
- Fetched and saved through the REST API, since `gh pr view/edit` fails because GraphQL is blocked in this session. The live body was checked unchanged before the edit.
