# Viewer screenshots at dev 5bbd72b66473f2d24a59fc40dbf8ed3101d52c28

Commit: `5bbd72b66473f2d24a59fc40dbf8ed3101d52c28` on `dev`, the merge of #206.
Method: the real app at that commit, served by Vite (`VITE_FEATURE_SHARE_V2=1`), shot with Playwright in headless Chromium.
`capture.mjs` answers the app's Supabase calls with fixtures through `scripts/ui/uifuzz.mjs` `stubApi` and serves `e2e-fixtures/test-score.pdf` as the score.
Viewports: `desktop-1440` (1440 x 900), `ipad-portrait` (820 x 1180), `iphone-14` (390 x 844).

Rerun from a checkout of `5bbd72b66473f2d24a59fc40dbf8ed3101d52c28` with Vite on port 5199:

    UIFUZZ=$PWD/scripts/ui/uifuzz.mjs CLEFFY_UI_BASE=http://127.0.0.1:5199 CLEFFY_UI_SHOTS=out SCORE_PDF=e2e-fixtures/test-score.pdf node capture.mjs
