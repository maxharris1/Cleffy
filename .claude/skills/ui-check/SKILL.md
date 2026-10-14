---
name: ui-check
description: Drive the running Cleffy app in headless Chromium to screenshot and check layout across desktop, iPad and phone viewports — verify a UI change visually, hunt responsive bugs (overflow, obscured or clipped controls, off-screen popovers), or fan out UI fuzzing agents. Use whenever a change touches what the user sees, before claiming it works.
---

# UI checks — Cleffy

## 1. Get the app running

```bash
npm run cloud:up     # Docker -> local Supabase (no OMR) -> functions + Vite; idempotent
```

First boot in a fresh container pulls the Supabase images and applies every
migration: budget several minutes. Later calls return immediately. Logs land in
`/tmp/cleffy-{local-up,functions,vite}.log`; `npm run cloud:down` stops it all.

- App: http://localhost:5173 · API: http://127.0.0.1:54421
- Accounts (seeded): `teacher@cleffy.local` / `student@cleffy.local`, password
  `cleffy-local-test`. The teacher has three seeded scores (and is therefore at the
  free-plan cap — "Open locally without uploading" still works).
  Fixture PDFs: `e2e-fixtures/*.pdf`.
- Stripe and OMR are not configured locally: disabled pricing buttons and a missing
  play-along feature are expected, not bugs.

## 2. Drive it with `scripts/ui/uifuzz.mjs`

```js
// /tmp/my-check.mjs — keep throwaway scripts out of the repo
import { VIEWPORTS, open, login, audit, shot, close } from '/home/user/Cleffy/scripts/ui/uifuzz.mjs';

for (const vp of Object.keys(VIEWPORTS)) {
    const { page, context, consoleErrors } = await open(vp);
    await login(page); // teacher, lands on /library
    console.log(vp, await audit(page), await shot(page, `library-${vp}`), consoleErrors);
    await context.close();
}
await close();
```

- `VIEWPORTS`: `desktop-1440`, `laptop-1280`, `ipad-landscape`, `ipad-portrait`,
  `ipad-mini-portrait`, `iphone-14`, `iphone-se`, `android-small`,
  `iphone-landscape` (touch + DPR set for the mobile ones).
- `login(page)` uses `#login-email` / `#login-password`. Students sign in at
  `/student`, which has its own form.
- `audit(page)` returns heuristic **candidates**: page horizontal overflow,
  off-screen elements, clipped text, small touch targets, obscured and overlapping
  controls. It is noisy — **always look at the screenshot (Read the PNG) before
  calling something a bug.** Visual artifacts it cannot see (misalignment, bad
  wrapping, z-index bleed, sticky bars covering content) are only found by looking.
- `shot()` writes to `$CLEFFY_UI_SHOTS` (default `/tmp/cleffy-ui/shots`). Point it
  at the session scratchpad if the user should be able to open the images.

Playwright is **not** a project dependency in the usual sense: the helper resolves
it from `node_modules` or the container's global install, and falls back to the
preinstalled Chromium (`/opt/pw-browsers/chromium`) when the resolved Playwright
wants a browser build that isn't cached. Never run `playwright install`.

## 3. Fanning out (UI fuzzing)

Split by surface, not by viewport — one agent per surface covering all viewports
keeps one defect seen at several sizes as one bug. Surfaces that worked well:
logged-out (landing, legal, auth forms) · library + IMSLP search · viewer toolbar
and drawing · viewer panels/dialogs · account + roster · student side. Follow each
with an adversarial verifier that re-reproduces every finding and names the
`src/` file:line, then a single dedupe/rank pass.

Agents share the seeded teacher account: tell them not to delete or rename seeded
scores, delete the account, change passwords or touch billing, and to clear any
test annotations.
