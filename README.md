# Sheet Music Scribbler

Real-time collaborative sheet music annotation — "Google Docs for sheet music."

Download a public-domain score (e.g. from IMSLP), open it on an iPad or computer, annotate with an
Apple Pencil (or mouse/finger), and share a link with a student or teacher. Everyone sees
annotations appear live, and any annotation can be erased or edited by any editor — the PDF itself
is never modified.

## Stack

- **Frontend**: Vite + React 19 + TypeScript (strict), Tailwind CSS 4, PWA (installable, offline-capable)
- **PDF rendering**: pdf.js (`pdfjs-dist`), annotations drawn on overlay canvases (`perfect-freehand`)
- **Backend**: Supabase — Auth, Storage, Postgres, Realtime. No custom server.
- **Offline**: Dexie (IndexedDB) local mirror + op queue; per-stroke last-write-wins sync
- **Export**: `pdf-lib` flattens annotations into a downloadable PDF, client-side

## Development

```bash
npm install
cp .env.example .env   # fill in the Supabase URL + anon/publishable key
npm run dev
```

Test on a real iPad via a tunnel: `npm run dev -- --host` then `ngrok http 5173`
(ngrok domains are pre-allowed in `vite.config.ts`).

## Commands

| Command              | What                         |
| -------------------- | ---------------------------- |
| `npm run dev`        | Dev server                   |
| `npm run build`      | Typecheck + production build |
| `npm run preview`    | Serve the production build   |
| `npm run test`       | Vitest (unit + integration)  |
| `npm run lint`       | ESLint with autofix          |
| `npm run lint:check` | ESLint check only            |
| `npm run typecheck`  | TypeScript check             |

Database migrations live in `supabase/migrations/` and are applied with the Supabase CLI
(`npx supabase link --project-ref <ref>` once, then `npx supabase db push`).
