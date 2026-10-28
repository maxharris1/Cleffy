# Cleffy PR #78: post-cap fix for the 2 round-3 Lows (report)

## Commit and push
- **New head of `mh/try-demo`:** `380647317be7bcb9da48ecefea46ce3b7f515119`
- Started from `ce7541a967af7d55c6bbd9f450741cdbfc832f16`. `origin/mh/try-demo` matched it before the push.
- **Fast-forward:** `git merge-base --is-ancestor ce7541a9 HEAD` passed. The push was `git push origin HEAD:mh/try-demo` (`ce7541a..3806473`), with no force.
- **Author / committer:** `Max Harris <drumaxter@gmail.com> / Max Harris <drumaxter@gmail.com>`. There are no trailers.
- **Message:** `demo: say 'couldn't check' when the store can't be read, not 'still saved'`
- **Files changed:** `src/features/demo/DemoViewer.tsx` and `src/features/demo/DemoViewer.test.tsx` only (+71/−20).

## Checks (Node 22.22.0)
| Check | Result |
|---|---|
| `npm run lint:check` | clean |
| `npm run typecheck` | clean |
| `npm run test` | **268 files passed / 6 skipped; 4131 passed / 22 skipped / 0 failed**. That is +1 on `ce7541a`'s 4130, from the new test. |
| `npx vitest run src/features/demo/DemoViewer.test.tsx` | 18 passed (was 17) |
| `npm run build` | passes |
| `npx prettier --check` (both files) | clean |

**GitHub CI on `3806473`: all green.** `checks`, `supabase-local`, `supabase-drift`, `edge-functions-deno` and `omr-service` passed on both the push and pull_request runs. Vercel passed (status and Preview Comments). Supabase Preview was skipped.

## Low 1: how the copy is chosen (`src/features/demo/DemoViewer.tsx`)
I used option (a), a small tagged error. Each rejection handler still needs to know which case it got, so the state also widens from a boolean to `WipeFailure | null`.
- `:43` `class DemoWipeFailedError extends Error` has `readonly inkState: 'remains' | 'unknown'` and keeps the purge's error as `cause`.
- `:71-74` `wipeDemoInk`: `const remains = await demoInkRemains().catch(() => null)`. If `remains !== false`, it throws `new DemoWipeFailedError(remains ? 'remains' : 'unknown', { cause: err })`. The read worked and found rows → `remains`. The read rejected or threw → `unknown`. The read worked and found nothing → resolves, as before.
- `:80` `wipeFailure(err)`: `err.inkState` for a `DemoWipeFailedError`, otherwise `'unknown'`. Only a check that actually found ink may say "still saved".
- `:89` `type WipeFailure = DemoWipeFailedError['inkState']`.
- `:102-105` `WIPE_FAILED_BODY`:
  - `remains` is unchanged: "Your markings are still saved in this browser. Try again to start on a blank score."
  - `unknown`: "This browser isn’t letting the demo use its storage right now. Try again, or come back in a minute."
- `:124` `wipeFailed` is `useState<WipeFailure | null>(null)`. It's set to `wipeFailure(err)` at `:170` (first load) and `:199` (Start over), and cleared to `null` in `retryWipe`.
- `:286` keeps the title "Couldn’t clear your markings" for both cases, with `body={WIPE_FAILED_BODY[wipeFailed]}`.
- The doc comments on `demoInkRemains`, `wipeDemoInk` and the new class now describe the split.

**Fail-closed is unchanged.** Every case that rejected before still rejects: `remains` and `unknown` both throw, so `startDemoSession` rejects, the marker stays unset and the viewport stays unmounted. Only a read that worked and found nothing resolves. Try again works as before. `Phase` and the position of `demoInkRemains` are untouched, and so are Follow Ups 1–19.

**Title:** I kept "Couldn’t clear your markings", as the packet asked. I'd consider "Couldn’t open the demo" for the `unknown` case on first load. A first-time visitor in a site-data-blocked browser has no markings, so "clear your markings" points at something that isn't there. On Start over, though, the current title is right. A split title would have to be chosen from both the phase and the failure kind, and it would move four heading assertions. I didn't make that change.

## Tests (`src/features/demo/DemoViewer.test.tsx`)
- `:2` `import Dexie from 'dexie'`. `:124` adds the helper `stillSaved = () => screen.queryByText(/still saved/)`.
- **New test**, `:218` `'a browser refusing IndexedDB outright is told storage is refused, not that markings are still saved'`. It's a first visit with nothing stored. It uses `vi.spyOn(Dexie.dependencies.indexedDB!, 'open')` to throw `DOMException('The operation is insecure.', 'SecurityError')`, then calls `renderDemo()`. It asserts:
  - the "Couldn’t clear your markings" heading,
  - the "isn’t letting the demo use its storage" body,
  - no "still saved" text,
  - no viewport,
  - `sessionStorage[DEMO_SESSION_KEY]` is `null`.
  The spy is restored with `mockRestore()`, and `afterEach`'s `vi.restoreAllMocks()` is a backstop.
- **Closed-DB tests now also assert there's no "still saved"**: first load at `:195`, Start over at `:324`.
- **Ink-remains tests now assert "still saved" is shown**: first load at `:171`, Start over at `:303`.

**The tests fail when the copy choice is reverted:**
- With the body always `WIPE_FAILED_BODY.remains`: **3 failed | 15 passed**. These are the new SecurityError test and both closed-DB tests.
- In the other direction, with the body always `.unknown`: **2 failed | 16 passed**. These are both ink-remains tests.
- With the copy choice restored: 18 passed.

## Low 2: test rename
`DemoViewer.test.tsx:209` (was `:202`) is now `'a failed wipe whose check reads no ink left still opens the demo'`. The test body is unchanged.

## PR #78 description edits (made with the REST API; the draft state and the `dev` base are unchanged)
- **Session-rules table, the "can't be read at all, or is blocked" row:** I dropped "the copy is wrong for this case, see …". The row now quotes the new body: "This browser isn’t letting the demo use its storage right now. Try again, or come back in a minute." It also says the row never claims the markings are still saved.
- **`## Factory review: cap reached, unresolved`:** Low 1 and Low 2 each end with *Fixed in `3806473` (post-cap, not re-reviewed).*
- **`## CI results`:**
  - added "GitHub CI on `3806473` (post-cap Low fixes, current head): all green" with the job list;
  - the local test line is now `3806473`, 268 files, 4131 passed, 22 skipped, 0 failed;
  - `DemoViewer` (17) → (18).
- Everything else is the same. The only other change is that GitHub re-normalized the blank lines before the trailing footer.
