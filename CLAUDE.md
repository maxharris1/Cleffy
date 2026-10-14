# Cleffy — agent notes

React 19 + Vite + Tailwind front end (`src/`), Supabase backend (`supabase/`:
migrations, RLS, Edge Functions). Routes: `src/app/routes.tsx`.

## Before pushing

Run what CI runs: `npm run lint:check`, `npm run typecheck`, `npm run test`
(`npx vitest run <path>` for one file), and `npm run build` for anything touching
bundling. Format with `npx prettier --write <files>`.

## Running the app

- **Cloud sessions** (claude.ai/code, `claude --remote`): the SessionStart hook
  installs dependencies and starts Docker. `npm run cloud:up` then boots local
  Supabase + Edge Functions + Vite on http://localhost:5173 (first boot: several
  minutes). Seeded logins: `teacher@cleffy.local` / `student@cleffy.local`,
  password `cleffy-local-test`.
- **Laptop**: `npm run local:up`, `npm run dev:local`, `npm run functions:serve`.

## Skills

- `supabase-ops` — environments, migrations, auth/storage config, sandbox network
  rules, live E2E against hosted Supabase.
- `ui-check` — screenshot and layout-check the running app across desktop, iPad and
  phone viewports (`scripts/ui/uifuzz.mjs`).
