# UI improvement plan — design-engineering pass

A polish pass in the spirit of Emil Kowalski's design-engineering notes: the app
should feel fast, quiet and physical. Motion confirms what the user did and
never makes them wait; touch works as well as a mouse; nothing replays, jumps or
flickers that the user did not cause. Five phases, one commit each, in order.
Every phase must pass `npm run lint:check`, `npm run typecheck`, `npm run test`
and `npm run build`.

Already verified before starting: Tailwind's preflight already removes the tap
highlight; there are exactly five hand-built menus; the toolbar (score-card
action pills) fade is low/medium impact and is removed anyway.

**Out of scope:** new toolbar controls, teacher/student layers, product changes,
Stripe/billing, migrations.

---

## Phase 1 — Foundations

| What                                                                                                                                                                                                                                                                               | Why                                                                                                                       | Files                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `@custom-variant hover` gated on `(hover:hover) and (pointer:fine)`; the raw `:hover` rules on `.landing-cta` and `.library-card` gated the same way                                                                                                                               | Touch browsers fire `:hover` on tap and leave it stuck; hybrids match `(hover:hover)` alone                               | `src/index.css`, `ScoreCard.tsx` (coarse pointers keep the overlay pills visible)                                     |
| Controls get `touch-action: manipulation`, `user-select: none`, `-webkit-touch-callout: none`; text fields stay selectable. `overscroll-behavior: contain` on nested scrollers                                                                                                     | No double-tap delay, no accidental label selection or callout on long press, no scroll chaining from a list into the page | `src/index.css`, dialogs/lists/strips with their own scroll                                                           |
| `@theme` motion tokens: `--ease-out` (.23,1,.32,1), `--ease-drawer` (.32,.72,0,1), `--duration-press` 120ms, `--duration-menu` 150ms, `--duration-dialog` 180ms, `--duration-enter` 220ms; the 13 `cubic-bezier(0.22,1,0.36,1)` literals use the token                             | One vocabulary for motion instead of one-off curves                                                                       | `src/index.css`                                                                                                       |
| No bare `transition`: every one names its properties (`transition-colors` etc.), with a guard test                                                                                                                                                                                 | A bare transition animates whatever changes — layout, shadows, colours meant to be instant                                | 30+ components, `tests/ui/motionGuards.test.ts`                                                                       |
| Reduced motion: spinner pulses instead of spinning; the indeterminate sweep breathes in place (opacity only); auto-follow scroll and moderation `scrollIntoView` jump; ProgressBar drops its own width transition. Reduced transparency / more contrast make blurred chrome opaque | Respect the user's system settings everywhere motion is scripted, not only in CSS                                         | `Loading.tsx`, `ProgressBar.tsx`, `PlayheadController.ts`, `ModerationPage.tsx`, `src/lib/motion.ts`, `src/index.css` |

**Acceptance:** guard test green; hover effects absent on touch emulation; with
`prefers-reduced-motion: reduce` nothing translates or spins.
**Risk:** low. The global hover variant changes every `hover:` utility; coarse
pointers already had no reliable hover.

## Phase 2 — Touch and inputs

| What                                                                                                                                                                                                       | Why                                                                              | Files                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 44px hit areas on coarse pointers via `::after`/`::before` (no layout change, no overlaps): transport steppers/keys/warning ✕, toolbar buttons/swatches/size dots, the shared `CloseButton`, RowMenu items | Apple HIG / WCAG 2.5.5 target size without changing the desktop look             | `TransportBar.tsx`, `Toolbar.tsx`, `ui/CloseButton.tsx`, `RowMenu.tsx`        |
| `sm` fields are `text-base pointer-fine:text-sm`; the tag select fixed; BPM and upgrade-code inputs go through `fieldClassName`                                                                            | iOS zooms the page into any input under 16px; those two inputs had no focus ring | `ui/classNames.ts`, `LibraryPage.tsx`, `TransportBar.tsx`, upgrade code field |
| Remove `maximum-scale` / `user-scalable` from the viewer's viewport lock; `touch-action` on the viewer overlays keeps pinch on the score                                                                   | WCAG 1.4.4 everywhere, including the viewer                                      | `src/lib/viewportZoom.ts` (+test), viewer overlays                            |
| `tabular-nums` on prices, quotas, counts, BPM, pager, export %                                                                                                                                             | Numbers that change should not jitter sideways                                   | various                                                                       |

**Acceptance:** no input under 16px on touch; every listed control ≥44px on a
coarse pointer; page zoom available in the viewer while pinch over the score
still zooms the score. **Risk:** medium for the zoom change — if it regresses,
revert only that item and report it.

## Phase 3 — Feedback and motion

| What                                                                                                                                                                                                                                  | Why                                                               | Files                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Press feedback: `active:scale-[0.97]` on Button variants, CTA, transport, pager; toolbar icons get a background press                                                                                                                 | A press should be felt immediately                                | `ui/classNames.ts`, `TransportBar.tsx`, `PdfViewport.tsx`, `Toolbar.tsx`                   |
| Instant tool switching: no colour transition on tool buttons                                                                                                                                                                          | A tool change is a mode switch, not an animation                  | `Toolbar.tsx`, `PdfViewport.tsx`                                                           |
| No replayed entrances: library layout/shell entrance dropped; cards enter 220ms / 4px once per session; IMSLP results key no longer includes `q`/facets and hits render settled; BrandShell ≤300ms; hero chips start from `scale(.9)` | Animations that replay on every navigation or keystroke feel slow | `index.css`, `scoreRow.ts`, `ImslpSearchPanel.tsx`, `ImslpScoreCard.tsx`, `BrandShell.tsx` |
| Dialog/menu entrances: fade + `scale(.96)`, 180/150ms, from the trigger's origin                                                                                                                                                      | Things appear from where they came from                           | `index.css`, `Dialog.tsx`, menus                                                           |
| ProgressBar animates `transform: translateX(pct − 100%)`, not `width`                                                                                                                                                                 | Compositor-only animation                                         | `ui/ProgressBar.tsx`                                                                       |
| Indeterminate sweep is linear; the playhead's rAF loop stops while paused (+test)                                                                                                                                                     | No idle frame loop                                                | `index.css`, `PlayheadController.ts`                                                       |
| Pan/zoom/follow write the transform to the wrapper through a store `subscribe`; React state only on settle / when the mounted page set changes                                                                                        | No React render per pointer move                                  | `PdfViewport.tsx`, `src/state/store.ts`                                                    |
| Fewer blurs: none on ScoreCard pills, viewer overlays, FingeringSelectionPopover (the header keeps its blur). No `box-shadow` transitions                                                                                             | Blur is expensive per frame; shadows animate on the main thread   | various                                                                                    |

**Acceptance:** tests green; no visible entrance on revisiting the library;
pan/zoom drift-free with ink (else the subscribe change is deferred).
**Risk:** medium (viewport transform path).

## Phase 4 — Primitives

| What                                                                                                                                                                                                                                                                                   | Why                                                                  | Files                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| Scrim fix first: the dialog closes only when both pointerdown and click land on the scrim (+regression test)                                                                                                                                                                           | A text selection dragged out of a dialog closed it                   | `ui/Dialog.tsx`, `ui/Dialog.test.tsx`                       |
| Add `@base-ui/react` (the new name of the deprecated `@base-ui-components/react`)                                                                                                                                                                                                      | Accessible primitives instead of hand-rolled focus/escape/stack code | `package.json`                                              |
| Dialog on Base UI with the same props: portal, focus trap/return, Escape, scroll lock, `inert` outside, stacking, `80dvh` sheets. `ConfirmDialog` becomes an alertdialog. Fix the `ViewerHeader` `[&_button]` style leak into dialogs                                                  |                                                                      | `ui/Dialog.tsx`, `ui/ConfirmDialog.tsx`, `ViewerHeader.tsx` |
| The five hand-built menus move to Base UI Menu/Popover: `RowMenu`, `LibraryShell` account menu, `ShareExportMenu`, `RosterPage` row menu, `FingeringSelectionPopover` — arrow keys, Escape, focus return, collision handling, `--transform-origin`. Fix the Toolbar style-popover ARIA |                                                                      | those files                                                 |
| Phone sheet drag-to-close, only if ≤120 lines and no new dependency; otherwise deferred                                                                                                                                                                                                |                                                                      | `ui/Dialog.tsx`                                             |

**Acceptance:** keyboard and screen-reader behaviour at least as good as before;
existing dialog/menu tests pass. **Risk:** medium-high (shared primitives);
Base UI is the only new UI dependency, and its bundle cost is reported.

## Phase 5 — Layout and robustness

| What                                                                                                                                                                                                                | Why                                                            | Files                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------ |
| Viewer notices overlay the score: a shared `ViewerNotice` in one absolute region for ink-save-failed, sync-rejected, upgrade banner and confirmations; no height animation; `SignedOutInkNotice` clears the toolbar | Notices pushed the score down and made it jump                 | `ViewerPage.tsx`, notice components  |
| Safe areas: `.safe-page` on Assignments/Legal/ReportContent; viewer controls get side insets; `theme-color` matches the header                                                                                      | Notch and home-indicator clearance; status bar matches the app | `index.css`, pages, `index.html`     |
| One grapheme-safe `initialsOf` for PresenceBar, LibraryShell and `account/initials.ts` (+tests)                                                                                                                     | Emoji and combining marks were split                           | `account/initials.ts`                |
| "Copied!" timer held in a ref, cleared on re-click/unmount; stable label widths                                                                                                                                     | Overlapping timers flickered the label                         | `ShareDialog.tsx`                    |
| Titles: `overflow-wrap:anywhere`, `min-w-0` pricing h3, middle-truncated share URLs, full viewer title on tap, "1 score"                                                                                            | Long titles overflowed; plural bug                             | various                              |
| Touch alternatives to `title`: presence chip popover (name, page); archived reason and inferred tempo shown inline                                                                                                  | `title` tooltips do not exist on touch                         | `PresenceBar.tsx`, library/transport |

**Acceptance:** ui-check across all nine viewports shows no new overflow or
obscured controls. **Risk:** low-medium.
