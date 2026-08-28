# Cleffy

Real-time collaborative sheet music annotation — "Google Docs for sheet music."

Download a public-domain score (e.g. from IMSLP), open it on an iPad or computer, annotate with an
Apple Pencil (or mouse/finger), and share a link with a student or teacher. Everyone sees
annotations appear live, and any annotation can be erased or edited by any editor — the PDF itself
is never modified.

**Smart import**: scores that already carry handwritten marks (a teacher's colored-ink fingerings,
or real PDF annotations) can be scanned on upload — the marks are detected, classified with Claude
(digits become editable text, brackets become erasable ink), lifted off the page with
background-matched patches, and adopted as native Cleffy annotations. Uploads accept photos and
screenshots (PNG/JPEG/WebP) too; they're wrapped into single-page PDFs client-side.

**Play-along**: uploaded charts are analyzed (optical music recognition) into right-hand /
left-hand piano parts. A transport bar under the score plays them back with a live playhead
sweeping the actual PDF, auto-follow scrolling, tempo control, count-in, metronome, A-B looping,
tap-a-measure-to-seek, and per-hand mute/volume — so a student can practice one hand while
Cleffy plays the other.

**Fingering diagrams**: drag the Fingering tool over a chord or phrase and Cleffy renders a
top-down piano keyboard showing exactly which fingers go on which keys, per hand, with
step-through for phrases. The notes are read from the score with Claude vision (teacher fingering
digits included — annotations are composited into the crop it reads) behind an editable review, or
entered by hand on any score, offline. A built-in optimizer (Parncutt-style ergonomic model +
dynamic programming) suggests fingerings for unmarked passages; suggestions preview on the page
and apply as ordinary teal text annotations that sync, erase, undo, and export like everything
else.

## Stack

- **Frontend**: Vite + React 19 + TypeScript (strict), Tailwind CSS 4, PWA (installable, offline-capable)
- **PDF rendering**: pdf.js (`pdfjs-dist`), annotations drawn on overlay canvases (`perfect-freehand`)
- **Backend**: Supabase — Auth, Storage, Postgres, Realtime. No custom server for the app itself.
- **Play-along analysis**: a small self-hosted [Audiveris](https://github.com/Audiveris/audiveris)
  OMR container (`services/omr-service/`) invoked via the `score-analyze` Edge Function; results
  land in the `score_analyses` table as ScoreData (notes by hand + measure geometry)
- **Playback**: hand-rolled Web Audio engine; bundled Salamander Grand piano samples
  (~0.85 MB, lazy-loaded, offline-cached)
- **Offline**: Dexie (IndexedDB) local mirror + op queue; per-stroke last-write-wins sync
- **Export**: `pdf-lib` flattens annotations into a downloadable PDF, client-side

## Development

### Against a local Supabase stack (recommended)

Needs Docker. Brings up Postgres, Auth, Storage, Realtime, the edge functions
and an OMR worker, runs every migration, and seeds two test accounts:

```bash
npm run local:up
npm run dev:local        # Vite on :5173
npm run functions:serve  # edge functions
```

`dev:local` pins 5173 with `--strictPort`. Without it vite treats `--port` as a
preference and slides to 5174 on one `info` line — while `local:status`,
`.cursor/health-check.sh` and `.claude/launch.json` all keep watching 5173. The
trap is that 5173 is rarely empty when that happens: `docker compose up` below
publishes the _previously built_ `dist/` on that port, so what you are watching
answers, serves the same app, and looks healthy while every edit goes to a server
nobody is pointed at. Failing to start is the cheaper outcome — if it reports the
port in use, find what holds it rather than letting the server move.

`.claude/launch.json` runs this one command. It assumes `local:up` has already
brought the backend up, and it does not start `functions:serve`.

|                          |                                                           |
| ------------------------ | --------------------------------------------------------- |
| App                      | http://localhost:5173                                     |
| Supabase API / functions | http://127.0.0.1:54421                                    |
| Studio                   | http://127.0.0.1:54423                                    |
| Mail (Mailpit)           | http://127.0.0.1:54424                                    |
| Postgres                 | `postgresql://postgres:postgres@127.0.0.1:54422/postgres` |
| OMR worker               | http://127.0.0.1:8091                                     |

Sign in as `teacher@cleffy.local` or `student@cleffy.local`, password
`cleffy-local-test`. The seeded documents carry library metadata only — there
are no PDF bytes in the `scores` bucket, so upload a real file to exercise the
viewer.

These ports are a **+100 offset** from the Supabase defaults on purpose, so this
stack coexists with other local Supabase projects on the same machine. They are
read from `supabase/config.toml`, not hardcoded.

```bash
npm run local:status   # health check
npm run local:down     # stop Supabase + the OMR worker
npm run local:up -- --no-omr
```

### Against hosted Supabase

```bash
npm install
cp .env.example .env   # fill in the Supabase URL + anon/publishable key
npm run dev
```

## Docker

The app is a static bundle (all state lives in Supabase), so the container is
just a build + nginx with an SPA fallback:

```bash
cp .env.example .env          # fill in the Supabase URL + anon/publishable key
docker compose up --build     # → http://localhost:5173
```

Hot-reload dev container instead: `docker compose --profile dev up dev`.
To reach it from an iPad on the same network, open `http://<machine-ip>:5173` —
share links and guest joining work as-is; add that origin (and `/auth/callback`) to the
Supabase Auth redirect allowlist if teachers will sign in from it.

Test on a real iPad via a tunnel: `npm run dev -- --host` then `ngrok http 5173`
(ngrok domains are pre-allowed in `vite.config.ts`).

## Commands

| Command              | What                                |
| -------------------- | ----------------------------------- |
| `npm run dev`        | Dev server                          |
| `npm run dev:local`  | Dev server on :5173, all interfaces |
| `npm run build`      | Typecheck + production build        |
| `npm run preview`    | Serve the production build          |
| `npm run test`       | Vitest (unit + integration)         |
| `npm run lint`       | ESLint with autofix                 |
| `npm run lint:check` | ESLint check only                   |
| `npm run typecheck`  | TypeScript check                    |

Database migrations live in `supabase/migrations/` and are applied with the Supabase CLI
(`npx supabase link --project-ref <ref>` once, then `npx supabase db push`).

## Play-along (OMR) service

The one piece that can't run in the browser or an Edge Function is optical music recognition.
`services/omr-service/` wraps Audiveris in a small container:

```bash
# local, next to the app:
OMR_SERVICE_SECRET=$(openssl rand -hex 32) docker compose --profile omr up --build omr
# or deploy the same image to Cloud Run / Fly (4 GB RAM; scale-to-zero is fine):
gcloud run deploy cleffy-omr --source services/omr-service --memory 4Gi --cpu 2 \
  --timeout 3600 --concurrency 1 --max-instances 1 --no-cpu-throttling
```

Then point the Edge Function at it (see `SETUP_SUPABASE.md` §4) with the
`OMR_SERVICE_URL` / `OMR_SERVICE_SECRET` secrets. Uploads and IMSLP imports trigger analysis
automatically; older scores get a "Generate play-along" button in the viewer. Without the
service configured, everything else works — the transport bar just reports analysis as
unavailable with a retry.

Full service details (env vars, error codes, fixture regeneration): `services/omr-service/README.md`.

## Credits

Piano samples: [Salamander Grand Piano](https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html)
by Alexander Holm, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) — bundled as a
slimmed 29-anchor set in `public/audio/piano/` (regenerate with `scripts/fetch-piano-samples.mjs`).
