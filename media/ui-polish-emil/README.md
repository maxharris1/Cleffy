# UI polish (Emil Kowalski pass) — media

Media for the draft PR from `mh/ui-polish-emil` into `dev`. Nothing here is
part of the PR branch.

All captures come from the local stack (`npm run cloud:up`: local Supabase,
Vite on http://localhost:5173). "Before" comes from a `dev` worktree at
4d7d2d3 served on :5174, "after" from `mh/ui-polish-emil`. Seeded teacher and
student logins. The seeded scores have no PDFs in local storage, so each got a
generated staff-paper PDF (local storage only).

## Videos

- `videos/walkthrough-desktop.mp4` — 1440×900, about 73 s
- `videos/walkthrough-ipad.mp4` — Playwright `iPad Pro 11` (`hasTouch`, `isMobile`), taps through the touchscreen, about 68 s

Both are in this order: 1. landing · 2. teacher sign-in · 3. library (entrance, card hover and press, row menu with arrow keys) ·
4. IMSLP search typing · 5. viewer: tool switching, pan/zoom, page turn, a viewer notice ·
6. export menu · 7. share dialog and lesson-history sheet opened and closed · 8. roster, then assignments as the student ·
9. `prefers-reduced-motion: reduce`.

Two responses are stubbed with `page.route`. IMSLP search: the local edge runtime cannot fetch its npm imports through
the sandbox proxy ("Worker failed to boot", identical before and after). The sync refusal: it makes the notice in step 5
appear, and the refused stroke rolls back, so nothing is written. A dot drawn in the page stands in for the pointer.

## Screenshots

- `screenshots/before/`, `screenshots/after/` — landing, login, library, IMSLP search, roster, account, viewer at all
  9 ui-check viewports, plus student assignments at 3. `*-summary.json` holds the `audit()` candidate counts per screen.
- `screenshots/after-interactions/` — the branch only: Base UI menus, share dialog, export popover, lesson-history sheet
  (`p4-*`); the notice over the score with a stubbed refusal, and the expanded viewer title (`p5-*`).
- `screenshots/contact-sheets/` — one JPEG per screen with all viewports, before and after.
