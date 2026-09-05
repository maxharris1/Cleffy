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
| Roster       | A provisioned student is a real Supabase auth user (`app_metadata.user_type='student'`, admin-set so policies can trust it) plus a `managed_students` row; seats are a STOCK checked in `student-provision` on create and restore. Two credential methods, fixed per student at creation. **code**: a synthetic `st-<roster-id>@students.cleffy.app` address and a printed ~59-bit code that is a ONE-TIME CLAIM TOKEN — `student-claim` spends it (hash nulled in the same UPDATE that stores a username and stamps `claimed_at`) for a username + password the student chooses, and `student-login` takes those afterwards. **email**: the teacher supplies a real address, GoTrue invites it, the student sets a password from the link and signs in client-side; no code, no username, no synthetic address. Unclaimed accounts hold a generated-and-forgotten scramble, so they have no sign-in path at all. `reset` scrambles the password FIRST (that is the revocation) then returns either row to Invited; archive bans the account for `876000h` on top of the `archived_at` stamp, because the row alone stops only the Edge Functions. The four states are DB-enforced (`managed_students_claim_state`); `student-claim` / `student-login` are `verify_jwt=false` with 60/min per-IP limits and one indistinguishable 401 |
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
3. **Share-link student flow** (anonymous, not a roster student): open the link in an
   incognito window / iPad → enter a name → both sides draw; watch live pen movement
   and presence chips; erase each other's strokes. The roster flow is a different
   thing entirely — see §6f of `SETUP_SUPABASE.md`.
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

**⚠️ Deploy the app before the OMR service.** ScoreData is now **v5**. The app rejects any
payload newer than its own `SCORE_DATA_VERSION` — `parseScoreData` returns null, the row caches
as ready with no score, and the viewer sticks on a generic "internal" failure that Retry cannot
clear. A v5-aware client reads v1–v5 fine, so client-first is safe and service-first is not.

**Musicality (v3).** Dynamics resolve per `(tick, staff)` rather than from one mutable value
walked in document order, so a left-hand `p` no longer overwrites the right hand's `f` from the
next bar on; the part is classified once as staff-split or not, and independence is sticky.
Hairpins (wedges **and** textual `cresc.`/`dim.`) interpolate. Articulation gates sounding
duration — staccato 0.5, portato 0.7, plain 0.9, tenuto/slur 1.0 — applied once per tie chain,
from the marking that closes it. A misread time signature is detected from the over-length bars
and corrected before padding (`meter_corrected` / `meter_suspect`). Tempo is a map, not a
scalar: every printed mark, Italian headings inferred as quarter-BPM and marked `tempo_inferred`,
and rit./accel./a tempo pre-discretized to a point per beat. Fermatas are clock stops
(`holds`), so a note sounding across one rings through it.

**Musicality (v5, svc-11).** _Voices:_ every note carries `vc`, a per-staff slot 0–7 the
parser normalises from Audiveris's unstable `<voice>` ids (an id that vanishes as another
appears is a renumbering and keeps its slot; a link that has to reach over an octave with no
rhythmic hand-over is disclosed as `voices_unstable`); `<direction><voice>` dynamics become a
`staff:voice` curve consulted before the staff's. _Client voice analysis_
(`voiceAnalysis.ts`, pure, index-aligned): successor-in-voice, legato eligibility from
`d / gap ≥ 0.85`, the bar's melody voice over a 9-bar window (stepwise motion, height,
top-of-hand), accompaniment = last bar's figure repeated under another voice, phrase starts
after a beat of rest. `expression.ts` overlaps legato successors by 6 % of the note (≤ 60 ms,
not when the pedal already pools), lifts the melody _voice_ rather than the top note, dips
repeated figures 6/127, leans a phrase toward its peak ±3/127 and tapers a legato run's last two
notes. _Tempo style_ (`Strict` / `Expressive` pill, persisted per device in `localStorage`):
strict is byte-identical to before; expressive composes a per-beat factor curve into
`buildTempoMap` — final rit. to 0.75 over the last 2 bars (4 in long movements), ~8 %
broadening before movement ends / repeat seams / holds, ~4 % agogic on the first downbeat after
a melodic rest — so click, count-in, playhead and loop wrap follow for free. _Auto-pedal_
(service, `autoPedal.ts`): where a score has no pedal edges (or an ≥ 8-bar gap) the job infers
them per beat from the pitch-class set, lifting for rests, staccato beats and harmonic churn;
the era comes from the composer surname in `documents.title` (`era.ts`; unknown → Classical:
re-catch on bass change only; Baroque → none; Romantic/modern → full rule), edges cap at 256 by
coarsening to 1/2/4/8 bars (past that, printed edges only), each inferred edge carries
`src: 'inferred'`, and the score says
`pedal_inferred`. The `Auto-pedal` pill drops the `inferred` edges client-side; engraved edges
(no `src`) are never dropped, even on a score that mixes the two. _Rhythm repair_
(`rhythmRepair.ts`): after meter reconciliation and before padding, a voice that does not sum to
its bar gets ONE edit — dot toggle, halve/double, trailing rest, or duplicated rest removed —
only when the sum becomes exact and either a neighbouring bar's same voice has the same onset
pattern or the note's beam group lands on the beat grid afterwards (`rhythm_repaired`,
`timings.rhythmRepairs`). _Smaller:_ Baroque trills and Pralltriller start on the upper
auxiliary; single-note tremolos, glissandi (chromatic run) and caesura / breath marks (½-beat
hold) are realised. Two more velocity layers were measured and deferred: `public/audio/piano`
is 3.0 MB for three layers (~1.0 MB each), so five would cost ~+2.0 MB. Constants are
uncalibrated (ASAP-style performance data could set the overlap, dips and curve depths); same-PDF
documents share the first job's era through `score_cache`; barline styles are not in ScoreData,
so section broadening uses `srcIndex` seams, movement ends and holds as proxies.

**Repeats and voltas are performed as written.** Barline marks resolve into a performance
order and the score is unrolled in `buildScoreData`, after the geometry zip — a repeated bar is
a clone that keeps its page position, so the playhead sweeps the same printed bar again for
free. `measures[].srcIndex` names the engraved bar, and anything reasoning about the PAGE
rather than the performance must group by it (`regionFromScoreData` does; getting this wrong
silently drops OMR fingering to the paid vision path). Unresolvable structure, or a projected
length past the 2000-measure schema cap, degrades wholesale to linear.

**Known limitations** (surfaced as ScoreData `warnings`, and now shown in the transport):
D.C. / D.S. / Coda / Fine are ignored — they arrive as text Audiveris emits unreliably, and a
wrong repeat misplaces eight bars where a wrong D.S. reorders pages; two-note tremolos and
una-corda / sostenuto pedals are not modelled; grace-note nuance is blocked on
Audiveris emitting `<grace>` at all, which it did not do once across an entire 8198-note score.
OMR accuracy still depends on scan quality — clean typeset PDFs work best, and wrong notes are a
per-measure OMR limitation, not a playback bug. Geometry failures degrade gracefully: audio
still plays with the playhead hidden. **Nothing re-analyzes an existing document automatically** —
the transport compares the stored `svc-<n>` against the client's and offers a regenerate.

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
