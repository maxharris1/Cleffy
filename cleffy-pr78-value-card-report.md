# Cleffy PR #78: the "what Cleffy does" value card on /try

**Status: done and pushed.** Asked by Max on 2026-10-28 at 1:03 PM ET.

## Head
- **Base:** `origin/mh/try-demo` was at `34a0981484af6b265a2d983d78c4cc8720178b72` when I started, as expected.
- **New head:** **`0e7e4986b7868891de5a547e183a6c0c7055ea6b`** on `mh/try-demo`, a fast-forward push of one commit.
- **Author and committer:** Max Harris `<drumaxter@gmail.com>`, with no co-author trailers.
- **Untouched:** no force-push, merge or rebase. Nothing went to `dev` or `main`, and there were no Supabase or hosted changes. The PR's draft and base state weren't changed.

## CI on `0e7e498` (GitHub checks)
| Check | push run | pull_request run |
|---|---|---|
| checks | ✅ success | ✅ success |
| supabase-local | ✅ success | ✅ success |
| supabase-drift | ✅ success | ✅ success |
| edge-functions-deno | ✅ success | ✅ success |
| omr-service | ✅ success | ✅ success |
| Vercel Preview Comments | ✅ success | |
| Supabase Preview | skipped, as on every earlier head | |

## Local runs on `0e7e498`, Node v22.22.0
- `npm run lint:check`: clean.
- `npm run typecheck`: clean.
- `npm run test`: **268 files passed, 6 skipped. 4147 tests passed, 22 skipped, 0 failed.**
  - It passed 3 runs in a row.
  - That's 16 tests more than the 4131 on `3806473`.
- Demo tests:
  - 4 files, **54 tests** in total.
  - `demoSession` 16 (+3).
  - `DemoViewer` 31 (+13).
  - `demoScore` 3.
  - `loadDemoScore` 4.
- `npm run build`: passes.
  - The `DemoViewer` chunk is 11.5 kB JS and 1.1 kB CSS (raw).
  - The **app shell's `index-*.css` is byte-identical to `34a0981`'s build.**
  - `index-*.js` has the same byte count, and differs only in chunk-name hashes.
- `npx prettier --write` was run on all six changed files, and `--check` is clean.

## Final copy
> **What Cleffy does**
> - Bring any score — upload your own PDF, or find one in IMSLP’s public-domain library.
> - Mark it up, and it’s saved to your library on every device.
> - Share one link, and your teacher, students or bandmates draw with you, live — like Google Docs for sheet music.
>
> **Keep playing** (ghost) · **Start free** (primary, links to `/register`)

## Trigger constants and rules
- `VALUE_CARD_AFTER_MARKS = 3` (`src/features/demo/DemoValueCard.tsx:15`).
  - The card shows after 3 new marks on this visit, counted by annotation id. An undo and redo of the same stroke counts once.
  - Only marks whose `createdAt` is at or after the time the demo opened count (`DemoViewer.tsx:158`, `:270`). Ink kept from an earlier session doesn't count, and neither does an erased mark that undo brings back.
  - The count carries across Start over.
- `VALUE_CARD_FALLBACK_MS = 25_000` (`DemoValueCard.tsx:18`).
  - The timer is in `DemoViewer.tsx:~286-295`. It shows the card only if the visitor has made **no** marks.
- **Once per session.** Close, Escape, Keep playing and Start free all dismiss it and write `sessionStorage['cleffy:demo-value-card'] = '1'`.
  - Helpers: `demoSession.ts:27` (key), `:34` (read), `:43` (write), with guards.
  - Blocked storage reads as "not dismissed", and the write fails quietly.
- **Never shown** while a wipe has failed, a clear is in progress, or the Start over question is up. The condition is `DemoViewer.tsx:342`, and the card renders at `:417`.

## Where the card lives
- **Component:** `src/features/demo/DemoValueCard.tsx`.
  - `DemoValueCard` at `:100`, with `role="dialog"` and `aria-modal="false"` at `:125`.
  - The Escape guard is `keyTargetsOtherControl` at `:27`.
  - The illustration is `LiveInkIllustration` at `:44`. The reduced-motion read is at `:104`.
- **Styles:** `src/features/demo/DemoValueCard.css`. It holds the dock padding, the 44px close ring, and the illustration keyframes. The `prefers-reduced-motion` block is at `:98`.
- **Wiring:** `src/features/demo/DemoViewer.tsx`, including `SIGN_UP_TO = '/register'` at `:110`. The header's Start free now uses the same constant.
- **Tests:**
  - `src/features/demo/DemoViewer.test.tsx:469`, the "the value card" describe block.
  - `src/features/demo/demoSession.test.ts:167`, "the value card’s dismissal".

## Verification in a browser
I used headless Chromium with `scripts/ui/uifuzz.mjs` viewports, on a local `vite preview` of the build and on the **Vercel preview of `0e7e498`** (https://cleffy-git-mh-try-demo-maxs-projectsd.vercel.app/try). I checked five setups: iPhone SE, iPhone 14, iPad portrait, desktop 1440, and iPhone 14 with reduced motion. In all five:
- The card came up after 3 strokes.
- Focus never moved into the card.
- The ✕ hit ring measured 44×44.
- Escape closed it and stored the dismissal.
- There were **0 requests off the page's origin** and no console errors.
- The card is 281px tall at phone width and 242px from `sm` up.
- With reduced motion there were 0 animations, against 4 otherwise.

**Screenshot:** I captured the iPhone SE shot from the Vercel preview but couldn't attach it to the PR (see choice 7 below).

## Where I chose differently from the packet, and why
1. **The card counts "marks", not only pen strokes.** A text note or highlighter stroke also counts towards the 3. Each one is a deliberate thing the visitor made, and it keeps the counter simple: any new annotation id.
2. **The timer fallback fires only for a visitor who has made no marks**, as "if they never draw" says. Someone with 1–2 strokes gets the card at their 3rd mark rather than mid-phrase. If Max wants the timer to fire regardless, it's a one-line change.
3. **The dismissal is stored when the card is put away, not when it's shown**, following "store the dismissal in sessionStorage". If a visitor reloads before acting on it, they'll see it again after 3 marks. If "once" should mean "once shown", call `writeValueCardDismissed()` on show instead.
4. **On phones the card covers the toolbar while it's up**, as the packet places it. It's kept compact (281px on iPhone SE) and is opaque. The first version was 95% white, like the hint, and the score and toolbar icons showed through the text. Keep playing, ✕ and Escape all bring the toolbar back.
5. **The card is hidden, not dismissed, while the Start over question is up.** That question owns Escape, so the two never compete for the key. The card comes back once the question is answered.
6. **Escape is ignored when it's aimed at another control.** That covers an open menu, a text field, and the toolbar's style popover, so one Escape doesn't close the popover and the card together. Escape from the score or the card itself closes it. It doesn't call `preventDefault`, so nothing else's Escape is swallowed.
7. **There's no screenshot in the PR.** This round could push only to `mh/try-demo` and this report branch. The PR's images live on `mh/try-demo-media`, and committing an image to `mh/try-demo` itself would ship it in the feature branch. I can add it on `mh/try-demo-media` if Max says so.
8. **I kept "like Google Docs for sheet music."** It's Max's comparison, and the repo describes itself as "Google Docs for Sheet Music". The landing page doesn't name third-party products, though. If that should hold here too, a neutral variant is "…draw with you, live, as they mark it up."
9. **The close button is a 32px ✕ with an invisible 44px ring on every pointer.** It doesn't use the usual touch-only `hit-44`, because the packet asked for "at least 44px" outright. Keep playing and Start free use the house `pointer-coarse:hit-44-y`.
10. **Motion:**
    - The illustration plays 3 passes, about 10 s, then rests drawn, rather than looping forever.
    - It moves only transform and opacity: a clip rect scales out from the left, and its cursor translates with it.
    - The card's entrance reuses the existing `.ui-sheet-pop`, which is a plain fade under reduced motion, as the app's sheets do.
    - Under reduced motion, the illustration renders with **no animation class at all**, and the stylesheet's media query also covers a setting changed while the card is up.
11. **The card's styles are in `DemoValueCard.css`, not Tailwind utilities.** Tailwind compiles every utility in `src/` into the shell's `index.css`. My first version added about 0.5 kB of new utilities there. Moving them into the demo chunk's stylesheet made the shell CSS byte-identical. This follows the `StudentCodeCard.css` precedent.
12. **One test-harness fix.**
    - Under the new tests, a pre-existing Start over test ("a failed Clear keeps the viewport unmounted…") failed once in 20 runs of the whole file.
    - The cause was that the viewport stub registered its store in `useEffect`. `findByTestId('viewport')` could resolve before the effect ran, so the test read the previous store, which still held the stroke.
    - The stub now registers each store as it's created. After that, 0 failures in 30 runs.
    - A first version of my counter had a similar race: a stroke committed as hydration settled could be folded into the baseline. That's why counting now goes by `createdAt` instead of a snapshot.
