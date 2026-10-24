# Micro-interactions media (PR: mh/micro-interactions)

Captured on the local stack (`npm run cloud:up`), desktop 1440×900, headless
Chromium. Each `.webm` is a real-time recording of one scenario; the PNGs are
key frames. iPad-size captures were not taken (see the PR report's
follow-ups).

| Item | Video | Key frames |
| --- | --- | --- |
| A2 upload bar → toast, A6 "Uploading…" | `desktop-upload.webm` | `desktop-upload-uploading.png`, `desktop-upload-toast.png` |
| B1 sync dot while writing, export menu (Base UI), export toast, Lesson History restore toast | `desktop-viewer.webm` | `desktop-viewer-synced.png`, `desktop-viewer-while-writing.png`, `desktop-viewer-after-writing.png`, `desktop-export-menu.png`, `desktop-export-busy.png`, `desktop-export-toast.png`, `desktop-restore-toast.png` |
| A3 Copy → Copied! | `desktop-copy.webm` | `desktop-copy-copied.png`, `desktop-copy-back.png` |
| A4 assign toast | `desktop-assign.webm` | `desktop-assign-toast.png` |
| D1 wrong setup code shakes | `desktop-claim.webm` | `desktop-claim-shake.png`, `desktop-claim-refused.png` |
| D1 wrong password shakes | `desktop-login.webm` | `desktop-login-refused.png` |
| C1 covers, Segmented view toggle | `desktop-library.webm` | `desktop-library-covers.png`, `desktop-library-list.png` |

Notes: the local edge runtime could not boot functions in the sandbox (it
cannot fetch its npm imports through the egress proxy), so the claim and
student-login captures serve those functions' own refusal bodies
(`invalid_code`, `invalid_credentials`, 401) at the network layer. The local
teacher was given a test Teacher plan and a roster student ("Maya") in the
local database only.
