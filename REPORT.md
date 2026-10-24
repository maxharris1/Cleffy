# Cleffy PR #76 fix pass (Codex REVISE): report

**Status:** Complete

**New head of mh/micro-interactions:** `20fb86886cb75484983b1effa70dd3db9dd806ca` (fast-forward from `6f143f84e6a2d92715f7e026a96d9a481f1d70ce`)

**GitHub CI on that head:** green. All 10 GitHub Actions jobs passed: `checks`, `supabase-local`, `supabase-drift`, `edge-functions-deno` and `omr-service`, each in both workflow runs. Vercel Preview Comments passed and the Vercel preview deployed (Ready). Supabase Preview was skipped, as usual. GitHub reports the PR as mergeable (`clean`), and it is still a draft.

## Commits (author Max Harris <drumaxter@gmail.com>)

| SHA | Fix | Change |
| --- | --- | --- |
| `6635c58` | 1 (MAJOR) | `LibraryShell.tsx`: after `await settleBar(...)` in `onImportImslp`, the score opens only if the signal is not aborted and `pathnameRef.current === startedAt`. Otherwise it stays where the teacher went; the score is still saved, the cached list still gets it, and the "Imported from IMSLP" toast still shows. Two new tests cover leaving Search for the Library during the 120ms hold and during the 150ms fade. To make them realistic, the test's Search page now aborts its import when it unmounts, as `ImslpBrowser` does. Both tests fail without the fix. |
| `1eca792` | 2 (MINOR) | `CoverImage.tsx`: `noteCoverShown(cacheKey)` moved from mount into `reveal()`, inside the existing `current` guard. Two new tests: a cover unmounted while its decode is still pending fades in on remount, and a decode that finishes after unmount does not count as shown. Both fail without the fix. |
| `20fb868` | 3 (MINOR) | `ShareExportMenu.tsx`: the `w-[4ch]` percentage slot is always rendered, empty while the size is unknown. The existing download test now checks that the empty slot is there before the size is known and that the same element then shows `25%`. It fails without the fix. |

## Checks run locally on `20fb868`

- `npm run lint:check`: pass
- `npm run typecheck`: pass. The startup install ran on dev and lacked this branch's `sonner` package, so I ran `npm ci` first.
- `npm run test`: 4074 passed and 22 skipped (264 test files passed, 6 skipped). That is 5 more passing tests than the previous head; the 6th new assertion set is inside an existing test.
- `npm run build`: pass
- `npx prettier --check` on the 6 changed files: clean

## Entry chunk size (gzip -9 of the entry `index-*.js` from `dist/index.html`; all three built in this session with the same script)

| Build | Entry gz | Δ vs dev | Initial JS (entry + 36 preloads) gz |
| --- | --- | --- | --- |
| dev `3c0e8cb` | 93,369 B | — | 234,531 B |
| old head `6f143f8` | 94,374 B | +1,005 B | 235,887 B |
| **new head `20fb868`** | **94,397 B** | **+1,028 B** | 235,912 B |

Vite's own gzip figures: dev 94.41 kB, new head 95.48 kB (+1.07 kB). My three fixes add 23 B. The total delta is well under the ~3 kB limit. The packet's +853 B figure came from a different measurement, so it doesn't compare directly with these numbers; same-method builds of dev and the old head are in the table instead.

The #74 lazy loading still works: the new head's `index.html` lists exactly the same preloads and stylesheets as dev's, and DialogPanel, MenuBase, toastChunk and sonner are not in it.

## Cloud environment

This session ran in the claude.ai cloud environment **"Cleffy"** (`env_01WAd3yiz3qpSnsofpyEwCh2`, kind `anthropic_cloud`), as confirmed by `get_session` and `list_environments`. I didn't use hosted Supabase, live Stripe or the local stack, and didn't need to (unit tests covered everything). I captured no media, ran no `rm -rf`, force-pushed nothing, merged nothing, didn't touch main, dev or PR #54, and left PR #76 as a draft.

## Open questions

1. Regular PDF uploads have a similar issue: a teacher who leaves the page during the finish delay is still taken to the viewer. The existing test "skips the hold for a teacher who has moved to another page" expects this, so I left it alone. The packet scoped this pass to IMSLP. Should uploads also respect leaving the page?
