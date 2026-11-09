**Status:** Complete

# Find a score: declutter the edition picker (tag `cleffy-search-declutter`)

- **PR:** https://github.com/maxharris1/Cleffy/pull/84 (draft, `mh/search-page-declutter` into `dev`)
- **Head SHA:** `faec29d56941523fd4a06de980ea16df6fb4b6ab`
- **Environment:** Claude Code cloud session in Cleffy (`env_01WAd3yiz3qpSnsofpyEwCh2`), not Sandbox. Local stack only, started with `npm run cloud:up`. No hosted Supabase project was touched.
- **Base:** `origin/dev` at `2144872` (Merge PR #80). PRs #54 and #82 were not touched. Nothing was pushed to `dev` or `main`.
- **Commit author:** Max Harris <drumaxter@gmail.com>

## What shipped

**Files changed:**

- `src/features/imslp/ImslpWorkPanel.tsx`: the work screen.
- `src/features/imslp/imslpDisplay.ts`: label helpers.
- `src/features/library/SearchPage.tsx`: the page h1 becomes a small label while a work is open.
- `src/index.css`: comment only.
- Tests: `src/features/imslp/ImslpBrowser.test.tsx`, `tests/imslp/moonlightRanking.test.ts`.

**Screen, top to bottom:**

1. Back.
2. The piece title (`font-display` h2).
3. The composer, with one quiet "View source page" link.
4. One card with the selected edition, which starts as the recommended one:
    - publisher and year;
    - `Urtext` and `Recommended` badges where they apply;
    - a tag only for files that are not the complete score.
5. A "Choose a different edition (N)" row at the bottom of the card. It opens the radio list.
6. Add to my library.
7. "Public-domain status varies by country. Learn more", where Learn more reveals the full disclaimer.
8. The attribution line.

## Acceptance points

1. **Met.** One recommended edition card: publisher and year, plus a short tag when there is one. Add is directly under it. `recommendEdition` is unchanged.
2. **Met.** "Choose a different edition (N)" is a button with `aria-expanded` and `aria-controls`.
    - N counts the other downloadable editions. The open list shows them all, with the current pick checked.
    - Picking a row replaces the card's edition, and the same Add imports it.
    - Radios are not in the DOM until the list is opened.
3. **Met.** No KB/MB, no per-row "Public domain", no "Complete Score". A tag appears only for parts, movements, other non-complete descriptions and arrangements.
4. **Met.** Rows lead with "Publisher, Year", or "Unknown publisher" when IMSLP lists none.
    - The cleaned file name shows as muted text only when two downloadable editions have the same headline and tag.
    - Example: the "wier ihml 1" and "joined document" pair in the tests.
5. **Met.** One "View source page" link next to the composer. The link next to Add is removed.
6. **Met.**
    - The "Not downloadable here (N)" section and all per-item cards are removed.
    - The open list ends with one muted line: "N more editions can't be downloaded here. View source page", linking to the work page.
    - The line says "can't be downloaded here", not "restricted", because some of these files only failed the license check; see open questions.
    - When nothing is downloadable, the existing guidance box stays, without the per-file list. If every license lookup failed, it now says so ("Couldn't check the licenses just now…").
7. **Met.** The short line is "Public-domain status varies by country." The "Learn more" button (`aria-expanded`) reveals the full current wording, unchanged. Add remains the acknowledgement sent to the edge function as `acceptedDisclaimer: true`.
8. **Met.**
    - No `max-h`/`overflow-y-auto` lists remain.
    - Back is the first element of the panel, at the top left above the title.
    - The title is the largest text: the page "Find a score" h1 becomes a small label while `?work=` is set.
    - "Public-domain scores via IMSLP" is kept, and "Find a score" naming is kept. IMSLP appears only in that attribution line.
9. **Met.**
    - **Viewports:** checked with `scripts/ui/uifuzz.mjs` on desktop-1440, ipad-portrait, ipad-landscape, iphone-14 and iphone-se. I looked at every screenshot. No horizontal overflow.
    - **Keyboard (Playwright on iPhone SE and iPad):** Enter opens the list, Tab lands on the checked radio, and ArrowDown changes the choice, which the card follows.
    - **Phone sticky footer:** keeps Add visible while the open list scrolls.
    - **Audit candidates I checked against the screenshots:**
        - 15–16px "small tap target" text links on iPad: `linkClassName` already extends the tap area on coarse pointers.
        - An "obscured radio" behind the sticky footer on iPhone: this is the intended sticky behaviour.
10. **Met.**
    - The panel tests were rewritten for the new structure. Selection, add, double-click guard, frozen rows during download, queued, cancel, unmount cancel, quota, import limit, all-restricted guidance, license-unknown and license-check-unavailable are still covered.
    - New tests cover the disclosure (keyboard and `aria-controls`), the Learn more disclosure, the naming and tag rules, and Back above the title.
    - When I made the list open by default, 8 tests failed.

## Checks

| Check                                   | Result                                                                                                                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint:check`                    | pass                                                                                                                                                                                                                                    |
| `npm run typecheck`                     | pass                                                                                                                                                                                                                                    |
| `npm run test`                          | 1st full run: 1 failure, and the output was not saved, so I can't say which test. 2nd and 3rd full runs: 271 files passed, 4224 tests passed, 22 skipped. A 4th full run, after the PR was opened, was also green with the same counts. |
| `npm run build`                         | pass                                                                                                                                                                                                                                    |
| `npx prettier --write` on changed files | done, clean                                                                                                                                                                                                                             |

## Screenshots

All are in `docs/claude-reports/cleffy-search-declutter/` on this branch. They use the seeded teacher account, which is at the 3-score free cap, so Add is disabled with the upgrade hint and the page-level amber quota notice shows. That notice is outside this screen's scope.

| Viewport     | Before                                                        | After                                                                                                                       |
| ------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Desktop 1440 | `work-before-desktop-1440-full.png`                           | `work-after-desktop-1440-full.png`, `work-after-desktop-1440-expanded-full.png`                                             |
| iPad         | `work-before-ipad-portrait.png`                               | `work-after-ipad-portrait.png`, `work-after-ipad-portrait-expanded-full.png`, `work-after-ipad-landscape-scrolled-list.png` |
| Phone        | `work-before-iphone-14.png`, `work-before-iphone-14-full.png` | `work-after-iphone-14.png`, `work-after-iphone-se-scrolled-list.png`, `work-after-iphone-se-learn-more.png`                 |

Full-page captures on phones draw the sticky footer at its original viewport position, which is a Playwright stitching artifact. `work-after-iphone-se-scrolled-list.png` is a real scrolled viewport.

**Stubbed call:** the local `imslp-work` edge function fails to boot in this container. Deno can't fetch `npm:@supabase/supabase-js` through the agent proxy (`invalid peer certificate: UnknownIssuer`). The screenshot script therefore served the Moonlight fixture (`tests/imslp/moonlightEditions.ts`, real IMSLP wikitext) for that one request with `page.route`. Login, quota and the rest of the app ran on the real local stack.

## Risk checklist

- **Concurrency:** no change. The reducer still ignores `select` while downloading or queued. Radios are disabled while importing (tested), and the double-click guard (`importInFlightRef`) is unchanged.
- **Retries/idempotency:** n/a. The import and pacing retry code is untouched.
- **Silent fallbacks:**
    - "Unknown publisher" is shown, not hidden, when IMSLP has no publisher.
    - The all-unavailable guidance distinguishes "couldn't check licenses" from "not cleared".
    - Nothing new is swallowed.
- **First-match parsing:**
    - Twin detection keys on headline plus tag across all downloadable editions, not on the first match.
    - `isCompleteScore` stays anchored at the start of the description (`^complete score`).
- **Row limits:** the open list renders every downloadable edition with no cap and no inner scroll. This is fine for IMSLP works (tens of files). A work with hundreds of files would make a long page, but the list is collapsed by default.
- **Auth/RLS:** n/a. UI only, no backend changes.
- **Time zones:** n/a.

## Notes and open questions

1. **`poteto-mode` is not vendored in this repo.** AGENTS.md says it is "held upstream". I followed the packet and the `principle-*` skills: subtract before adding, prove it works, and test behaviour.
2. **Branch.** The harness gave this session `claude/cleffy-search-declutter-5u79s1`. I followed the packet: the PR head is `mh/search-page-declutter`, and this report is on `claude/cleffy-search-declutter-report`. I did not push the harness branch.
3. **Restricted line wording.** The line says "can't be downloaded here", not "are restricted". The unavailable set includes license-unknown and license-check-failed files, and `imslpDisplay` deliberately avoids claiming a restriction IMSLP didn't state. The link reads "View source page", not "View on IMSLP", per the never-label-it-IMSLP rule. Say if you want the packet's exact copy.
4. **Count in the toggle.** N is the number of _other_ downloadable editions (Moonlight: 8 of 9). With only one downloadable edition the toggle is hidden. In that case the "N more can't be downloaded here" line has nowhere to go, and the title's source link is the only way to the restricted files.
5. **Page heading.** "Find a score" stays the h1 but shrinks to a small label while a work is open. This is a small change to `SearchPage.tsx`, outside the main file, made so the piece title is the strongest text.
6. **Duplicate quota messages for the teacher at the cap.** The page-level amber quota notice and the panel's "Cloud-score limit reached" hint both show. The page notice is out of scope. The panel hint is kept because Add needs a visible reason on phones, where the page notice has scrolled away.
7. **Local stack stopped.** `npm run cloud:down` has been run.
