# Cleffy PR #74 fix pass 1 (majors only): report

**Status:** Complete

Both major findings are fixed and pushed to `mh/ui-polish-emil` as a fast-forward (no force-push). GitHub CI on the new head is green. There are no CSP violations, so no CSP fix was needed.

## Environment
- Cloud environment: **Cleffy** (`env_01WAd3yiz3qpSnsofpyEwCh2`, anthropic_cloud). Not Sandbox.
- Local stack only. `npm run cloud:up` ran in the background, and `npm run cloud:down` stopped it at the end. Hosted Supabase was never contacted. No .env files or secrets were committed. `playwright install` was never run; the preinstalled `/opt/pw-browsers/chromium` was used.
- Commits were authored as Max Harris <drumaxter@gmail.com>.

## Heads and commits
- **Old head** when I started: `07dd982` (UI polish phase 5: layout and robustness).
- The zod commit was **not** in the history at the start. It landed while I worked: `a95c2ce` Bump zod to ^4.6.7 to clear GHSA-mrhx-c7xc-m3w5, from the other session. I rebased onto it with `pull --rebase` before committing, ran `npm ci`, and re-ran all the checks.
- **New head:** `e0208659ae81d694439fbe06472011a2e7fc0514`

| SHA | Message |
| --- | --- |
| `cdfc653` | Viewer keys stand down while a dialog or confirm is open (PR #74 fix1 1) |
| `e020865` | Notices over the score push followed systems and page turns below them (PR #74 fix1 2) |

Each commit passes lint, typecheck and tests on its own; I checked the fix-1 commit separately.

## Fix 1: viewer shortcuts under confirmations
- `src/ui/dialogStack.ts` (new): the module-level stack of open app dialogs moved here from `Dialog.tsx`, plus `isDialogOpen()`. Lint's react-refresh rule requires `Dialog.tsx` to export only components. `Dialog.tsx` now imports the stack; its Escape logic is unchanged.
- `src/features/viewer/PdfViewport.tsx`: the window keydown handler returns early when `isDialogOpen()` is true, so it ignores every key while any app modal (dialog or alertdialog) is open, wherever focus is. This is the packet's preferred fix. As a fallback, the `keyTargetsControl` selector also matches `[role="alertdialog"]`.
- Tests (`src/features/viewer/PdfViewport.test.tsx`, which renders the real `PdfViewport` and a real `ConfirmDialog`):
  - Control case: with no dialog open, ArrowRight and Space turn pages and Ctrl+Z calls `undoLast`.
  - With an alertdialog open, ArrowRight, Space, PageDown, Ctrl+Z, Cmd+Z and Ctrl+Shift+Z do nothing (no scroll change, no undo or redo). Each key is sent both inside the confirm and on `document.body`. Once the confirm closes, the keys work again.
  - On the old code this test fails: the view scrolled to 2028px under the confirm.

## Fix 2: notices covering the followed system
- `ViewerNoticeRegion` (`src/features/viewer/ViewerNotice.tsx`) takes a new `onInsetChange` callback. It uses a ResizeObserver on the region and its container to report how far down the notice stack reaches, in px from the container's top, or 0 when no notice is showing.
- `ViewerPage` passes that value to `PdfViewport` as `noticeInset`, in both the cloud and local viewers. `PdfViewport` folds it into the obscured top edge (`max(toolbar, phone controls strip, notice inset)`). That one edge already drives:
  - the follow band and its clamp (`PlayheadController`)
  - page turns
  - the first fit, relayout and zoom clamp
- The view does not move when a notice appears or goes away. Only the edge changes, and the next follow step or page turn lands clear of the stack. This keeps the existing rule that "nothing moves when a notice comes or goes".
- Compact form at phone sizes:
  - The card has tighter padding and line height below `sm`, and the region gap shrinks from 8px to 6px.
  - `SyncRejectedNotice` and the non-dismissible `SyncHeldNotice` get short copy below `sm`, keeping the long copy from `sm` up. This follows the pattern `InkSaveFailedNotice` already uses.
- Test: at a 390×664 phone viewport, three notices are showing (access changed, sync refused, sync held).
  - The first fit starts page 1 below the stack.
  - Following the first system, a page-2 system and the last system each leaves the whole system visible between the stack's bottom (224px) and the viewport's bottom.
  - jsdom can't lay out, so the test supplies the notice cards' heights; the geometry and wiring are real. On the old code the system sits at 65px, under the stack, and the test fails.
- Real-browser check on the local stack (scratch script, not committed): I opened a fixture PDF in the local viewer and put three phone-copy notice cards into the real region on iPhone SE, iPhone 14 and iPad portrait. ArrowRight landed page 2 at 338px against a stack bottom of 328px (iPad: 329 against 308). No console errors.

## Checks before each push
`npm run lint:check` passed, `npm run typecheck` passed, `npm run test` passed (251 files, 3923 tests, 22 skipped) and `npm run build` passed. `npx prettier` reported no changes, and `npm audit --omit=dev --audit-level=high` found 0 vulnerabilities after the zod bump. One earlier full-suite run had a failure in `tests/auth/turnstileField.test.tsx`. It passed alone with and without my changes and on every later full run; this diff doesn't touch it.

## GitHub CI on e020865
- push run: **success**, https://github.com/maxharris1/Cleffy/actions/runs/40050942915
- pull_request run: **success**, https://github.com/maxharris1/Cleffy/actions/runs/40050945627 (all jobs green: checks with the npm audit, supabase-local, supabase-drift, edge-functions-deno, omr-service)

## CSP check (report only)
**No violations, so no fix needed.** Base UI 1.9.0 injects `<style>` elements only from Select and ScrollArea, and the app uses neither. Its inline styles are set through React's CSSOM, which `style-src 'self'` allows. There was nothing to import.

1. **App production bundle.** `dist` served with every header from `vercel.json`. The only change is that `connect-src` also allows the local API (`127.0.0.1:54421`) and `upgrade-insecure-requests` is dropped for http localhost; neither affects styles or scripts. As the seeded teacher I opened:
   - the library score menu (Menu)
   - the viewer Export menu (Menu)
   - the viewer History dialog (Dialog)
   - the Account delete-account dialog, cancelled and never confirmed (Dialog)

   **0 CSP violations, 0 console errors.**
2. **Popover and AlertDialog.** The real `PresenceBar` Popover needs a live peer, which the local stack can't provide, so I made a scratch production build of the app's own `Dialog` (sheet), `ConfirmDialog` (alertdialog), `Menu` and `PresenceBar` (Popover). It was served with the **exact** `vercel.json` CSP, and all four opened with **0 violations**.

The repo's `scripts/csp-smoke.mjs` was not used: it targets the hosted dev project's host name (only through route handlers), and these rules keep this session off hosted Supabase.

## Open questions
1. **A small catch-up after a dismissal.** If the reader is scrolled to the very top while a tall notice is up (page 1 sits below it) and then dismisses it, the extra space stays until the next pan, which then catches up by the notice's height. I left it alone so a notice's coming or going never moves the music. If you'd rather the view re-clamp when the inset shrinks, that's a one-line follow-up.
2. **First open for guests.** The inset also applies to the first open, so a guest whose upgrade banner is up sees page 1 start below the banner, not under it. I think that's right, but it is a visible change.
3. **Base UI menus (not in scope).** The viewer's key handler still doesn't exclude `role="menu"`/`menuitem` targets. Base UI's menu keyboard handling probably calls preventDefault, which the handler already respects, but I didn't verify this.
4. **Local seeded scores.** On the local stack the seeded cloud scores fail to open ("Couldn't open this score", storage returns 400), so I used "Open locally" with `e2e-fixtures/test-score.pdf` instead. This isn't caused by this change, but it's worth knowing for future UI checks.
