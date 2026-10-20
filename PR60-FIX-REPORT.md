# PR #60 fix pass: report

- **Branch:** `claude/perf-library-viewer` (base `dev`)
- **Was:** `2c519e6`
- **New head:** `38ac4b148f888cb3ba6353cb59dd1a6a6b03aab4` (`38ac4b1`)
- **How it was pushed:** a normal push with no rebase and no force. Nothing was merged, approved or opened, and no reviewers were requested.

All five commits are authored by Max Harris <drumaxter@gmail.com>. Each one is a single item:

| Commit    | Item                                                       |
| --------- | ---------------------------------------------------------- |
| `9f919ff` | 1: tests for the cached-PDF metadata table (`pdfMeta`)     |
| `ee19b22` | 2: Safari/iPad `content-visibility` clipping               |
| `14cd0ca` | 3: idle prefetch no longer triggers the stale-chunk reload |
| `0f961e0` | 4: the flaky viewer test (a real race, fixed)              |
| `38ac4b1` | 5: only a 404 makes a published cover "missing"            |

This file lives only on the scratch branch `claude/pr60-fix-report`. It is not on the PR branch.

## What changed

### 1. MAJOR #1: `pdfMeta` tests (`src/sync/pdfCache.test.ts`)

I added seven fake-indexeddb tests:

- **(a) A copy cached before v10.**
    - The test opens a real **v9** Dexie database: same name, the v9 schema, a 1234-byte row, and no `pdfMeta`. It then reopens the database as `ScribblerDb`, which upgrades it to v10.
    - `getCachedPdfMeta` backfills the metadata: the right `size`, role and `userId`, and no `bytes`.
    - A second read doesn't call `pdfCache.get` at all (checked with a spy).
- **(b) The role written to the metadata wins.**
    - `updateCachedPdfMeta({ myRole: 'viewer', archivedAt })` leaves the `pdfCache` row untouched.
    - `getCachedPdf` returns the new role and archive state with the bytes byte-for-byte unchanged, and no stray `size` field.
    - Updating with no cached copy returns `false` and writes nothing.
- **(c) Metadata whose file is gone.**
    - `getCachedPdf` and `getCachedPdfMeta` both return `null`.
    - The leftover `pdfMeta` row is deleted.
    - `updateCachedPdfMeta` returns `false` and doesn't recreate it.
- **(d) Old ops when the copy changes hands.**
    - `updateCachedPdfMeta({ userId: C })` stamps unstamped ops with A, the previous account.
    - `opOwnerFor` then agrees: C owns none of them and A keeps them.
    - A change that keeps the same account leaves the ops unstamped.
- **(e) Storage totals.** `readOfflineStorage` totals 1000 + 500 bytes over two scores without calling `pdfCache.get`, `toArray` or `each`.

**Bugs found:** none. Every test passed against the existing code, so there is no product change for this item.

**Thumbnails left out of (e):** under jsdom, fake-indexeddb's structured clone loses a `Blob`'s size, so the thumbnail part of the total can't be tested meaningfully here.

### 2. MINOR #2: Safari/iPad clipping (`src/index.css`)

- **Change:** the whole containment block now sits under `@supports (overflow-clip-margin: 12px)`. That covers `content-visibility: auto`, the clip margin, `contain-intrinsic-block-size`, and the `:has([aria-expanded='true'])` override.
- **Effect:** Safari has `content-visibility` but not `overflow-clip-margin`, so it (and every iPad browser) now renders every card in full, as before the PR. Chromium and Firefox keep the optimisation.
- **Build:** the built CSS keeps the `@supports` wrapper.

### 3. MINOR #3: the prefetch can no longer reload the page

- **`src/lib/staleChunk.ts`:**
    - New `loadAsPrefetch(load)`. It counts prefetches in flight and adds any error a prefetch ends in to a `WeakSet`.
    - The `vite:preloadError` handler reloads straight away as before when no prefetch is in flight.
    - While one is in flight, it waits one task. If the event's payload turns out to be that prefetch's own rejection, it does nothing. Otherwise it reloads.
- **Why this works:**
    - Vite's `handlePreloadError` dispatches the event and then throws the **same** error object. I checked this in `node_modules/vite` and in the built bundle.
    - The prefetch's `catch` runs in microtasks before that one-task wait ends.
- **`src/lib/idlePrefetch.ts`:** `prefetchWhenIdle` runs its loader through `loadAsPrefetch`. Failures are still swallowed silently.
- **What still reloads:**
    - Navigation recovers exactly as before: the tap imports the chunk again outside any prefetch, so the event reloads the page, and `ErrorBoundary` still catches it at route level.
    - Any other import that fails while a prefetch is in flight still reloads.
- **Tests (`src/lib/staleChunk.test.ts`):**
    - "leaves the page alone when only a prefetch met a stale chunk, and reloads on the navigation".
    - "still reloads for another import that fails while a prefetch is in flight".
    - With the `WeakSet` marking removed, the first test fails, so it does catch the regression.

### 4. The flaky test: a real race, fixed (`src/features/viewer/ViewerPage.tsx`)

- **Diagnosis:**
    - In the CI log for run 38758422316 the viewport was still `data-readonly="true"` and there was **no** "you can now edit" banner. So the role re-check ran and bailed out. It wasn't slow.
    - `recheckAccess` reads `stateRef.current`, which was synced in a **passive** `useEffect`.
    - While RTL's `waitFor` runs, React commits the viewport and runs passive effects in a later task. `openAs()` could therefore see `data-sync="on"`, fire `onMembershipChanged`, and have `recheckAccess` find `stateRef.current === null`. It returns early and the change is dropped.
    - The same window exists in production too: a Realtime message could land between the commit and the passive-effect flush.
- **Reproduction:** delaying the ref sync by 30 ms locally gives exactly the CI failure: read-only stays `true` and no banner appears.
- **Fix:** sync `stateRef` in a `useLayoutEffect`, so it is current whenever the committed DOM is.
    - It only runs earlier than before. Readers in the load effect already saw the updated value, because the sync effect is declared first.
    - There is no other behaviour change.
- **Test file (`ViewerPage.test.tsx`):** the two role-change `waitFor`s ("raises" and "lowers") now allow `{ timeout: 5000 }`, in case a CI runner is very busy.
- **20× loop results:**
    - The single test (`-t "opens for writing when the owner raises the role"`), 20 runs: **20/20 passed**.
    - The whole `ViewerPage.test.tsx` file with all 4 cores busy-looping, 20 runs: **20/20 passed**.
- **Caveat:** the original code without the fix _also_ passed 20/20 under the same CPU load here. I couldn't reproduce the flake naturally in this container. The case for the fix rests on the CI log plus the forced-delay reproduction, not on a before/after flake rate.

### 5. MINOR #4: a 400 is not "missing" (`src/features/library/thumbnailRemote.ts`)

- **Change:** `probePublishedThumbnail` now reads the status from the error `exists()` returns. That is `error.status` for a `StorageApiError`, or `error.originalError.status` for a `StorageUnknownError`, matching storage-js's own `exists()`.
- **Mapping:**
    - **404** becomes `'missing'`.
    - A **400** or anything else that comes back `false` becomes `'unavailable'`.
    - A thrown error stays `'unavailable'`.
- **Tests:** found, 404 (both error shapes) → missing, 400 → unavailable, thrown → unavailable.

## Checks (run on the final tree before pushing)

| Check                               | Result                                                            |
| ----------------------------------- | ----------------------------------------------------------------- |
| `npm run lint:check`                | ✅ exit 0                                                         |
| `npm run typecheck`                 | ✅ exit 0                                                         |
| `npm run test`                      | ✅ 193 files, **2736 tests passed** (2723 before, plus 13 new)    |
| `npm run build`                     | ✅ exit 0 (tsc and vite build; the service worker was generated)  |
| Prettier on every file I changed    | ✅ "All matched files use Prettier code style!"                   |
| `npm run format:check` (whole repo) | ❌ exit 2, **already failing on `dev`/`2c519e6`** (details below) |

**Why the whole-repo prettier check fails:**

- It warns on 66 files and can't parse `tests/imslp/fixtures/moonlight-excerpt.html` at all.
- None of those files are mine.
- CI doesn't run `format:check`; it runs only lint and typecheck.
- The one PR-touched file it flags is `src/features/fingering/FingeringFlow.tsx`. The flagged lines (a long import and a long destructured parameter list) are already unformatted on `dev`, and the PR doesn't touch them.
- I left it alone rather than widen the PR.

## ui-check on iPad (`scripts/ui/uifuzz.mjs`, local stack via `npm run cloud:up`)

**Setup:**

- Seeded teacher, grid and list views.
- Viewports: `ipad-portrait`, `ipad-landscape` and `ipad-mini-portrait`. `pointer: coarse` matched on all three, so the touch rings were active.

**Simulating Safari:** the harness is Chromium, which _does_ support `overflow-clip-margin`, so it takes the `@supports` branch. To cover Safari, each view was also run with a forced stylesheet:

- **safari-now** is what Safari gets after this fix: the gate is false, so there is no containment.
- **safari-before** is what Safari got at `2c519e6`: `content-visibility: auto` with no clip margin.

**Probe:** `elementFromPoint` on the first card's "Score actions" button, at a point inside its touch ring but **outside** the card's box. The ring reaches 2 px past a grid card and 12 px past a list row.

| Viewport / view                | Chromium (gated) | Safari after fix | Safari before fix |
| ------------------------------ | ---------------- | ---------------- | ----------------- |
| ipad-portrait grid / list      | ✅ / ✅          | ✅ / ✅          | ❌ / ❌           |
| ipad-landscape grid / list     | ✅ / ✅          | ✅ / ✅          | ❌ / ❌           |
| ipad-mini-portrait grid / list | ✅ / ✅          | ✅ / ✅          | ❌ / ❌           |

✅ means the tap reaches the button.

- **The bug and the fix:** in the before-fix column, taps in the ring are swallowed by the clip, which is the reported bug. In both fixed configurations they reach the button.
- **Screenshots:** grid cards and list rows render normally, with no clipping or layout change, and there were no console errors.
- **Audit:** `audit()` flagged the same small-tap-target candidates (10–12) in Chromium and in Safari-after-fix. They come from the heuristic measuring button boxes without their `::before` touch rings, not from this change.
- **Not covered:** this was not run on real WebKit, because the container has only Chromium.

## Skipped, and why

- **Review findings #5–#7** (library test timing seams, the `useScoreThumbnail` observer reset, and the `seed.sql` local-only guard): the packet said to skip them.
- **Whole-repo prettier:** already failing on the base, as described above. I fixed nothing outside this PR's scope.
- **Item 4's flake reproduction:** I couldn't reproduce it naturally in this container, even with the old code, so the fix is backed by the CI log and the forced-delay reproduction.
