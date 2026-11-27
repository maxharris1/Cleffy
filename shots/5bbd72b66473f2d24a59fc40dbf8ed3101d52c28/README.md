# Viewer screenshots at dev 5bbd72b66473f2d24a59fc40dbf8ed3101d52c28

Commit: `5bbd72b66473f2d24a59fc40dbf8ed3101d52c28` on `dev`, the merge of #206.
Method: the real app at that commit, served by Vite (`VITE_FEATURE_SHARE_V2=1`), shot with Playwright in headless Chromium.
`capture.mjs` answers the app's Supabase calls with fixtures through `scripts/ui/uifuzz.mjs` `stubApi` and serves `e2e-fixtures/test-score.pdf` as the score.
Viewports: `desktop-1440` (1440 x 900), `ipad-portrait` (820 x 1180), `iphone-14` (390 x 844).

Rerun from a checkout of `5bbd72b66473f2d24a59fc40dbf8ed3101d52c28` with Vite on port 5199:

    UIFUZZ=$PWD/scripts/ui/uifuzz.mjs CLEFFY_UI_BASE=http://127.0.0.1:5199 CLEFFY_UI_SHOTS=out SCORE_PDF=e2e-fixtures/test-score.pdf node capture.mjs

Scenes: `owner`, `student`, `loading`, `error` and `link` (the open `/s` viewer), plus the three viewer notices of #206's set:

- `starting-point`: the owner viewer with the lesson starting point notice, opened through History > View on a fixture `annotation_snapshots` row.
- `signed-out-ink`: the owner viewer with the signed-out ink notice. The page holds three marks with `holdOps` (the path a failed IndexedDB write takes) and gets the `account-signed-out` message on the `cleffy:ink-recovery` BroadcastChannel, as when another tab signs out.
- `link-busy`: the `/s` viewer with the busy countdown. share-session answers `live` with a 3 s token until the viewer is open, then 429 with `retry_after: 45` on the renew.

`check.sh <rev>` fails unless every scene has all three viewports at that revision.
