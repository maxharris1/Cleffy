# Cleffy — implementation notes

Real-time collaborative sheet music annotation ("Google Docs for sheet music").
Built across six milestones, one commit each (M0–M6 in `git log`).

## What was built

| Area         | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PDF viewing  | pdf.js v5 (broad browser support + upsert polyfill), virtualized pages (visible ±1), 4096px bitmap caps for iOS canvas limits, pan/pinch/wheel zoom with crisp settle re-render                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Ink          | Pointer Events pipeline: Apple Pencil pressure, coalesced + predicted events, palm rejection (touch never inks). perfect-freehand rendering; pen / highlighter (0.35 alpha, multiply) / stroke-eraser / text notes; 7 colors × 3 widths; batched undo/redo (Cmd/Ctrl+Z)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Data model   | The PDF is immutable; annotations are vector rows normalized to the rotated page viewport (all scalars / page width). Soft-delete tombstones only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Sync         | Local-first: in-memory Map → Dexie mirror + outbox → Supabase. Server-stamped `seq` gives deterministic LWW immune to device clocks. Watermark pulls with 50-seq overlap; offline queue with exponential backoff; RLS rejections repair from server truth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Realtime     | One private channel per doc: broadcast-from-database for committed strokes, 50ms-batched `ink:progress` streaming for live pen movement (the live strokeId _is_ the annotation id — commit atomically replaces preview), presence with per-user colors + page hints. All wire data zod-validated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Sharing      | Owner creates edit/view links (server-generated tokens); students join via anonymous auth + display name; SECURITY DEFINER redemption never downgrades roles; viewers get read-only UI backstopped by RLS + realtime send policies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Offline      | PDFs cached as Dexie blobs (survives Safari cache eviction better than SW cache), cached opens with last-known role, offline library fallback, `storage.persist()`, offline→queue→flush→converge covered by integration tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Export       | pdf-lib in a Web Worker; rotation-aware coordinate mapping (0/90/180/270 fixture-tested); identical perfect-freehand geometry as on screen (explicit-Q SVG paths — pdf-lib mangles `T` commands); WinAnsi-sanitized text; share sheet on mobile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| PWA          | Installable, app-shell precache, iOS safe-areas, responsive layout (bottom toolbar on phones)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Smart import | Uploads accept images (magic-byte sniffed, wrapped into single-page PDFs via pdf-lib). A free client-side chroma pass finds colored-ink handwriting (connected components → glyph clusters → fingering-run hints, RLE masks); the `analyze-annotations` edge function classifies clusters with claude-sonnet-5 (strict forced tool; owner-only, rate-limited, degrades to strokes-only when unavailable); real PDF FreeText/Ink annotations convert exactly. Review previews through the history overlay; accepting commits native annotations in one undo batch and can rebuild the PDF with paper-colored patches (rotation-mapped, worker-side), replacing `{id}/original.pdf` with the untouched original kept as `pre-import-original.pdf`. `documents.content_rev` + a broadcast trigger keep caches and open collaborator tabs consistent |
| Fingering diagrams | A Fingering tool (marquee on the live canvas; usable by view-only students, single-finger draggable) selects a chord/phrase; `src/features/fingering/` (lazy chunk) renders a top-down keyboard diagram — pressed keys tinted per hand with finger badges, phrase step-through — through ONE pure `KeyboardDiagram`, whatever populated the data. **Note source order**: Dexie-corrected cache → ScoreData (`regionFromScoreData`, when play-along analysis covers the selection fully) → `analyze-notes` vision → manual. OMR path is instant/offline/deterministic and shares pitches with playback; Phase-1 zero-bbox regions gate apply-to-score, ScoreData v2 staff bands synthesize notehead bboxes to unlock it. Vision remains the fallback (and the only reader for ink digits). Suggestion engine is Parncutt-subset + Viterbi; apply places teal `sf` text annotations. |

### Fingering accuracy (educator review, 2026-08-05)

The suggestion engine was audited against standard editions (RCM/ABRSM/Hanon conventions) and
re-tuned; the canon is pinned by 27 golden/property tests in `engine/suggest.test.ts`: major and
harmonic-minor scales in white- and black-key tonalities both hands, TWO-octave forms (the loop
crossings, never a pass around 5), flat-key block chords (thumb-on-black is a passing-motion rule,
not a held-shape rule — B♭ major is 1-3-5), arpeggios, Alberti bass (5-1-3-1), octave = 1-5, and a
hand-size setting (small/standard/large scales the Parncutt span tables; unreachable spans render
an honest "?" rather than a strained stretch). **Known, disclosed deviations**: chromatic runs come
out as the sequential legato fingering rather than the mainstream 1-3 pattern; terminal notes of a
fragment may take an end-of-phrase finger where prints show the loop finger (the UI tells users to
select through the end of the phrase); LH 2-octave C major aligns one thumb on D instead of C
(equal-cost tie). The panel frames every suggestion as "one good option — editions differ." When
ScoreData covers the selection, notes come from play-along analysis (review label: "From play-along
analysis"); vision is the silent fallthrough for empty/partial coverage. Unplayable same-onset packs
are redistributed (low→L / high→R, melody peel) before Viterbi; the review modal shows live
suggestions; the diagram labels notes moved for reach. Soft phrase resets discount transitions
across ≥12-semitone leaps; monophonic 2nd-order history is a Viterbi tie-break; the diagram offers
top-k Option 1/2/3 when distinct alternates exist. **Eval**: `engine/evalMetrics.ts` (match rate +
IFR) runs on committed fixtures in CI. Optional `PIG_DIR=… node scripts/eval-fingering-pig.mjs` only
inventories the [PIG dataset](https://beam.kisarazu.ac.jp/research/PianoFingeringDataset/) (register;
research/non-profit; cite Nakamura, Saito & Yoshii 2020) — it does not run the fingering engine or
compute IFR; not vendored, not required for CI.
**Defer the vision ground-truth eval set** until usage shows how often vision still fires on clean
analyzed scores — if unexpected vision traffic appears there, check the `measure_geometry_mismatch`
warning rate before blaming the mapper. Vision remains required for phone-photo / failed-OMR docs and
for reading Pencil ink digits.

## How to test (once Supabase setup from SETUP_SUPABASE.md is done)

1. **Local-only** (works with zero backend): `npm run dev` → "Open a PDF" → draw with
   mouse/pen, switch tools, undo, reload + reopen the same file → annotations restore.
2. **Teacher flow**: sign in via magic link → Upload a score → annotate → Share →
   "Can edit" link → copy.
3. **Student flow**: open the link in an incognito window / iPad → enter a name → both
   sides draw; watch live pen movement and presence chips; erase each other's strokes.
4. **View-only**: create a "View only" link → that session shows no toolbar and can't ink.
5. **Offline**: airplane-mode a device mid-session → keep annotating → reconnect →
   both sides converge (status dot: amber → gray → green).
6. **Export**: Export button → open the downloaded PDF anywhere → ink is baked in.
7. **iPad specifics**: pinch zoom, two-finger pan, Pencil pressure, palm on screen
   while writing, install to home screen.

## Verification status

- 63 unit/integration tests, ESLint, strict tsc, production build: all green (CI runs the same).
- Browser-verified in Chromium: viewing, all tools, undo/redo, persistence,
  role-gated UI, export round-trip (including rotated-page mapping fixtures), phone layout.
- **Live-verified against the real Supabase project (2026-08-01)** via
  `node --env-file=.env live-e2e.mjs` — all 13 checks pass: teacher auth,
  upload, stroke sync, share link, anonymous student join, persistence pull,
  mid-stroke live ink streaming, broadcast-from-database fan-out, presence,
  cross-user erase convergence, zero page errors. (The harness bridges browser
  traffic through Node because the sandbox egress gateway TLS-fingerprints
  browsers — see `.claude/skills/supabase-ops/SKILL.md`.)
- Magic-link email round-trip remains untested (headless email); password-grant
  sessions exercise the same authenticated paths.

## Deploy

- **Now**: `npm run dev -- --host` + `ngrok http 5173` (ngrok hosts pre-allowed in
  `vite.config.ts`; add the URL to Supabase Auth redirect URLs).
- **Later**: Vercel — static build (`npm run build` → `dist/`), SPA rewrite to
  `/index.html`, `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` env vars.

## Play-along (M-playback)

| Piece         | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Analysis      | `services/omr-service/` (Audiveris 5.6.1 in Docker + Node wrapper) turns the PDF into **ScoreData** (v2): notes split RH/LH by staff, ties merged, measure x-ranges, system y-bands **and per-staff bands**, key signatures, and clefs — normalized to the same 0–1 page coords annotations use. v1 caches still parse. Re-run "Generate play-along" to pick up v2 fields. |
| Orchestration | Upload/IMSLP import fire the `score-analyze` Edge Function (role check, page cap, stale-run guard, signed PDF URL) → OMR service queue → service-role write-back into `score_analyses` (status/progress/error lifecycle). Client polls lifecycle columns only; ScoreData travels once                                                                                                                                                   |
| Playback      | Hand-rolled Web Audio engine: 25ms/120ms lookahead scheduler, 29 bundled Salamander anchors (nearest-anchor playbackRate pitch shift), per-hand gain buses (mute keeps scheduling → instant unmute), synthesized click bus, anchor-swap timebase for bpm/seek/count-in/gapless A-B loops                                                                                                                                                |
| Playhead      | Imperative rAF controller inside the viewer's transformed wrapper: sweeping line + measure highlight, auto-follow with glide + suspend-on-gesture, tap-a-measure-to-seek (pan tool / read-only), loop-range tint. Rides the engraved chord columns (Audiveris slot data in `measures[].sl`) so the line sits on each chord as it sounds; linear fallback without slots. Measure number is the only per-frame state that touches React   |
| Transport     | Docked bar for every role (playback is per-device); Generate/Retry owner-editor-gated to match RLS. Explicit rewind / play / pause keys on the left, measure counter, live time signature, ±1 BPM steppers with a typable tempo field (persisted per score in Dexie), count-in + metronome toggles, per-hand volume, offline replay from the scoreCache + CacheFirst-cached samples; compound meters also show the dotted-quarter tempo |
| Looping       | One on/off toggle — no arming. Switching it on lays a four-bar range at the playhead, drawn on the score as an amber band with end brackets and a "Loop" tag; a range row in the transport nudges either end by a bar or snaps the start to the playhead                                                                                                                                                                                |
| Musicality    | Printed dynamics (pp…fff, sfz accents, `<sound dynamics>`) drive velocities through a perceptual v^1.6 gain curve; grace notes play as crushed acciaccaturas; metronome marks convert beat-unit → quarter-BPM; each sample's codec padding **and** its attack rise time are measured at decode time, and notes start early by that rise so the note is _heard_ on the click rather than beginning there (bass anchors need up to 25 ms) |

**Known v1 limitations** (all surfaced as ScoreData `warnings` where applicable): repeats /
D.C. / D.S. are ignored (linear playthrough); one global tempo (score tempo marks beyond the
first are not followed); hairpin crescendos are not interpolated (stepwise dynamics only);
OMR accuracy depends on scan quality — clean typeset PDFs work best, and wrong notes are a
per-measure OMR limitation, not a playback bug. Geometry failures degrade gracefully: audio
still plays with the playhead hidden. Re-run "Generate play-along" on older scores to pick up
slot/dynamics data produced by the updated OMR service.

### Play-along test script

1. Run the OMR service (`docker compose --profile omr up`), set the Edge Function secrets,
   apply the `score_analyses` migration, deploy `score-analyze`.
2. Upload a clean typeset piano PDF → transport shows "Analyzing… n/N pages" → ready.
3. Play on an iPad: first tap unlocks audio + loads samples; playhead sweeps measures,
   auto-follow crosses systems and pages.
4. Pan mid-playback → follow suspends (amber Re-follow pill) → tap it → view glides back.
5. Mute LH and play the left hand yourself; drag LH volume instead for "quiet guide" mode.
6. Change BPM 60→160 mid-playback → no position jump; count-in gives one bar of clicks —
   plus the lead-in beats when the piece opens with a pickup ("ONE two three four, ONE two
   three…" → you enter on 4); metronome accents real downbeats only (never the pickup) and
   feels 6/8 in dotted-quarter beats.
7. Loop: tap Loop → four amber bars appear from the playhead, seamless wrap; nudge either
   end a bar at a time, "Start here" snaps the start to the playhead, Rewind returns to A.
8. Tap a measure (pan tool) → seek; steppers land on barlines (‹ returns to measure start
   when >20% in).
9. Title-page-first PDF → playhead starts on the first musical page; single-staff score →
   LH controls disabled with an explanatory tooltip.
10. Airplane mode after one playback → cached ScoreData + samples still play offline.
11. Viewer-role invitee: full transport, no Generate/Retry.
12. Leave a score and reopen it (cached analysis, so ScoreData beats the PDF to the screen)
    → playhead line and measure highlight are there on arrival, not just on the first open.
