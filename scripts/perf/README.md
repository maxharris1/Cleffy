# Performance benchmarks

Repeatable load-time and smoothness measurements for the library and the score
viewer: a production build, served the way Vercel serves it, against the local
Supabase stack seeded with a production-shaped dataset, in headless Chromium
throttled like a mid-range tablet on 4G (4x CPU, 100 ms RTT, 10 Mbit down,
1180x820 @2x touch viewport).

Everything here runs against the **local** stack only.

## Setup (once per container)

```bash
npm run cloud:up                                      # local Supabase + functions
psql postgresql://postgres:postgres@127.0.0.1:54422/postgres -f scripts/perf/seed.sql
node scripts/perf/fixtures.mjs                        # scan/vector PDFs + covers
node scripts/perf/seed-storage.mjs                    # upload them
```

`seed.sql` adds 40,000 scores across 400 other accounts, and gives
`teacher@cleffy.local` 650 more (600 own, every one with a published cover, and
50 shared), tags, favorites and 2,000 strokes on the newest score, which
`seed-storage.mjs` backs with a 24-page, 23 MB scanned PDF.

## Measure a build

```bash
npx vite build --outDir /tmp/cleffy-perf/builds/after   # .env.local points it at the local stack
node scripts/perf/serve.mjs /tmp/cleffy-perf/builds/after 4173 &
node scripts/perf/bench.mjs after                       # every scenario, 5 runs each
node scripts/perf/bench.mjs after libraryCold,libraryScroll --runs 3
node scripts/perf/report.mjs before after               # median tables, before vs after
```

To compare commits, build each one (a `git worktree` per commit with
`node_modules` symlinked and `.env.local` copied works) and serve them one at a
time on the same port: the signed-in state the runner saves on first use is
tied to the origin. Interleave the builds (A, B, A, B) — runs drift by ~10%
over an hour on a shared machine.

Results append to `$CLEFFY_PERF_DIR/results.jsonl` (default `/tmp/cleffy-perf`).

## Scenarios

| scenario                                              | what it measures                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `landingCold`                                         | Storefront, first visit: FCP, LCP, JS transferred, blocking time                                                                                  |
| `libraryCold` / `libraryColdSW`                       | Signed in, nothing on the device: list paint, every visible cover loaded, LCP (`SW`: service worker allowed, as on a real first visit)            |
| `libraryWarm`                                         | Return visit: snapshot paint, network paint, covers                                                                                               |
| `libraryScroll`                                       | Scroll through all 653 scores: time for each older page to appear, frame rate, long tasks, a favorite tap and a search keystroke on the long list |
| `libraryFling`                                        | Fling down the shelf at 3000 px/s: time spent waiting at the bottom for older scores                                                              |
| `openNewestCold` / `openOldCold` / `openNewestBrowse` | Tap a score (immediately, or after 3 s on the shelf): first page painted, role confirmed                                                          |
| `openNewestWarm` / `openNewestWarmBrowse`             | The same with the score already downloaded to the device                                                                                          |
| `openNewestColdSW`                                    | First visit with the service worker installing meanwhile                                                                                          |
| `accountWithCache`                                    | Account page with three scores downloaded: offline-storage summary shown                                                                          |
| `viewerScroll`                                        | Wheel through the 24-page scan and back: frame rate, blank pages                                                                                  |

Headless Chromium composites in software, so `viewerScroll` mostly measures
canvas compositing and does not predict a GPU-backed iPad. DevTools network
emulation does not reach the pdf.js worker's own requests, so viewer open
times are slightly optimistic. `scripts/bench-first-page.mjs` measures the
streamed first open of a large scan against a fully local stand-in instead.
