# Cleffy micro-interactions PR: Claude report

**Status:** Complete
**PR:** https://github.com/maxharris1/Cleffy/pull/76 (draft, `mh/micro-interactions` → `dev`)
**Branch / head SHA:** `mh/micro-interactions` @ `6f143f84e6a2d92715f7e026a96d9a481f1d70ce` (base `origin/dev` @ `3c0e8cb8ffc5f878dcad7ea3ab35a334a2f4868c`)
**Checks (local, on the head):** lint:check ✅ · typecheck ✅ · test ✅ (264 files, 4070 passed, 22 skipped) · build ✅ · prettier ✅ (all changed files)
**GitHub CI on the PR head (when this was written):** supabase-drift ✅, edge-functions-deno ✅, omr-service ✅, Vercel Preview Comments ✅, Supabase Preview skipped; **`checks` and `supabase-local` still in progress.** Not yet confirmed fully green: see open questions.

## Open questions / follow-ups
1. **CI not yet confirmed green.** `checks` and `supabase-local` were still running when this report was pushed. The same lint, typecheck, test and build all pass locally on this SHA.
2. **iPad-size media not captured.** The user said to stop capturing, so only desktop (1440×900) media exists. Follow-up: capture the same scenarios at `ipad-landscape` / `ipad-portrait` (the script is ready: `capture.mjs <viewport>`).
3. **Edge functions could not boot locally** in this sandbox: the edge runtime can't fetch its npm imports through the egress proxy (UnknownIssuer; Deno uses its own roots). For the D1 media, the claim and student-login captures serve those functions' own 401 refusal bodies at the network layer. The real server paths are covered by unit tests.
4. **"A5" is referenced in A1's adopter list but not defined in the packet.** I treated the listed adopters (A2, A4, IMSLP, export, actionError, restore) as the scope.
5. **Deviations from the packet, for Max to confirm:**
   - `sonner/dist/styles.css` is imported in the lazy toast chunk, not `main.tsx`. The CSS stays off the first paint, and a Vite plugin strips Sonner's CSP-blocked inline `<style>` injection.
   - The reduced-motion toast override keeps the 200ms opacity fade but does not force `transform: none`. Sonner positions stacked toasts with transforms, so transform changes simply land at once.
   - The SyncDot crossfades six stacked dots (one per state), not two. It is still opacity-only and retargetable.
   - C1's "URL available on first render" never happens (blob URLs are always async), so "settled" means "this page already showed this cover". That covers library → score → back.
   - Export menu → Base UI Menu: notices (failures, limit + upgrade, marks) moved to a popover panel under the button, with a **Try again** for failures. The trigger stays enabled during an export (its items are disabled instead), so focus is not dropped onto a disabled button when the menu closes.
   - Page turns: `turnFromPageIndex` treats a row as top-visible when at least half of it is in the uncovered view. Previous still goes to the previous row; I kept that because existing fit-width paging tests require it.
6. **Local DB only:** for media, the local teacher got a test Teacher subscription and a roster student "Maya", inserted with psql into the local Supabase. Nothing hosted was touched.

## Cloud environment
Ran in the **Cleffy** cloud environment (`env_01WAd3yiz3qpSnsofpyEwCh2`, anthropic_cloud), confirmed via `get_session` / `list_environments`. Local stack only (`npm run cloud:up`). No hosted Supabase, no Stripe, no `playwright install`. Commits authored as Max Harris <drumaxter@gmail.com>. No force-push, no merges, nothing pushed to main/dev, #54 untouched.

## Commits (oldest first)
1. `01d9604` Add one Sonner toast system, lazy-loaded outside the shell bundle
2. `55038af` Add SwapLabel, Segmented, useDelayedFlag and shake primitives
3. `bc35310` Toast export done, Lesson History restore and library row failures (A1)
4. `0e6b1cc` Busy labels crossfade at a fixed width with SwapLabel (A6)
5. `d32de1f` Finish the upload bar before opening the score, then toast (A2)
6. `a14e5cd` Copy becomes Copied! as a blur crossfade at a fixed width (A3)
7. `bd0dccf` Assigning a score confirms itself with a toast (A4)
8. `29a772a` Wrong codes shake (D1)
9. `697af8e` Score covers fade in when their image arrives (C1)
10. `c54d1b7` A calmer sync indicator (B1)
11. `68df1cd` Separate presence chips' tap areas on touch, and stop the sheet springing back under reduced motion
12. `77c758a` Read VITE_ variables by name, not by computed key
13. `f564671` Step page turns from the row at the top of the view
14. `3bcd575` Move the Export menu onto the app's Base UI Menu
15. `b8f6e52` Slide the library view toggle's selection (Segmented)
16. `6f143f8` Key the refused-code error line apart from the robot check (D1 fix; found on the local stack)

## Per-item summary
- **A1 toasts:** `ui/toast.ts` (success/saved/shared/error/promise) over a lazy Sonner chunk, mounted once in `App.tsx` and portalled to `<body>`. Bottom-centre from sm up, top-centre below the header on phones. richColors off. Adopted by:
  - export done
  - Lesson History restore
  - library favorite/delete/leave failures
  - upload and IMSLP import (success and failure)
  - assign
- **A6 SwapLabel:** fixed-width crossfade (opacity + 2px blur, 150ms; reduced motion is 120ms opacity only). Used on:
  - the Export trigger (with a fixed 4ch % slot)
  - Save name and Change password
  - AuthCredentialsForm
  - the UpgradeBanner submits
  - the top-bar Upload caption
  - the Copy button
  - the SyncDot label
- **A2 upload finish:** the bar fills to 100% (200ms, skipped if already full or under reduced motion), holds 120ms, then fades out over 150ms; navigate and "Score uploaded" fire together. It skips the wait if the teacher navigated away. The IMSLP sweep becomes a determinate 100% bar for the same beat, then "Imported from IMSLP". A failure does not fill: the bar fades and a toast.error appears. The quota notice stays inline, and the unused `uploadError` outlet field was removed.
- **A3 Copy → Copied!:** built on SwapLabel with a 0.96 scale and a 12px check. Transitions, so a double tap retargets.
- **A4 assign:** "Assigned to Maya" for one student, "Assigned to N students" for more, with the score title as description, fired in the same tick as the close.
- **D1 shake:** WAAPI 280ms, only on a server refusal (claim `invalid_code`, login `invalid_credentials`, guest upgrade `invalid_code`). The field gets a red border until edited and is refocused with its text selected. ErrorText fades in over 150ms. Under reduced motion there is no shake.
- **C1 cover fade:** opacity 0 → 1 after `decode()` (200ms; 150ms under reduced motion) over the kept placeholder. The placeholder is dropped after the fade, and covers already shown are settled.
- **B1 SyncDot:**
  - "syncing" only shows after 600ms (`useDelayedFlag`)
  - stacked-dot opacity crossfade, 200ms (instant under reduced motion)
  - no pulse
  - the label sits on SwapLabel at the width of "Waiting for server"
- **Minors:**
  - PresenceBar coarse-pointer spacing
  - sheet snap-back respects reduced motion
  - Export menu moved onto Base UI Menu
  - `turnFromPageIndex` page turns
  - explicit `VITE_` reads, plus a guard test
- **Extra:** Segmented adopted by the view toggle; `ui/Menu` now loads its chunk for a controlled open; the unused `menuKeyboard` helper was removed.

## Tests added or updated
New test files:
- `src/ui/toast.test.tsx`
- `SwapLabel.test.tsx`
- `Segmented.test.tsx`
- `ProgressBar.test.tsx`
- `src/lib/useDelayedFlag.test.ts`
- `shake.test.ts`
- `envReads.test.ts`
- `src/features/library/CoverImage.test.tsx`
- `src/features/viewer/history/LessonHistoryButton.test.tsx`
- `src/features/viewer/presence/PresenceBar.test.tsx`

New cases in:
- LibraryShell: upload timing with fake timers, reduced motion, navigated away, failure, IMSLP
- LibraryPage
- ShareExportMenu (both files): export toasts, notice panel and Try again, Base UI keyboard
- ShareDialog: copy swap
- AssignDialog
- AccountPage, AuthPages, UpgradeBanner: busy labels and shake
- StudentClaimPage, StudentLoginPage, studentApi
- ViewerPage: SyncDot hysteresis, crossfade, label
- Dialog: snap-back reduced motion
- Menu: controlled cold open
- geometry: `turnFromPageIndex`
- lazyPrimitives

Shared helper: `src/test/animate.ts`.

## Bundle size (gzip; entry chunk plus its modulepreloads from `dist/index.html`)
| | dev baseline 3c0e8cb | PR head |
| --- | --- | --- |
| Entry chunk (`index-*.js`) | 93,717 B (Vite: 94.58 kB) | 94,570 B (+853 B; Vite: 95.47 kB) |
| Initial JS (entry + preloads) | 235,294 B | 236,516 B (+1,222 B) |
| Entry CSS | 15,804 B | 16,321 B |

Sonner lives in a lazy `toastChunk` (6.66 kB JS + 2.95 kB CSS gz). DialogPanel and MenuBase are still not in `index.html`, so the lazy behavior from #74 is intact. The explicit env reads saved about 0.4 kB of the entry.

## Media
Branch `mh/micro-interactions-media` @ `2d86053`: https://github.com/maxharris1/Cleffy/tree/mh/micro-interactions-media/docs/media/micro-interactions (the README there indexes them). Desktop 1440×900 only; each scenario has a `.webm` plus PNG key frames:
- upload
- viewer: sync dot while writing, export menu, export toast, restore toast
- copy
- assign
- claim shake
- login shake
- library: covers and Segmented

iPad-size captures are a follow-up (item 2 above).
