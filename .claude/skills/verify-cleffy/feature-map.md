# Feature map

One row per area of the code. Pick the rows whose area contains a path the pull request changed, then drive each row's smoke check. `tests/qa/verifyCleffyFeatureMap.test.ts` fails when an area on disk has no row, so a new folder under `src/`, `src/features/` or `supabase/functions/` needs a row here.

"Signed in as X" means the Drive section's sign-in as that seeded account. "Upload" means the Drive section's upload of `e2e-fixtures/test-score.pdf`. A smoke check that starts with "needs a human check" names the outside service the lane cannot reach; the rest of that cell is the part a lane can still check.

| Area | Journey | Smoke check |
| --- | --- | --- |
| `src/app` | Every page: routing, route guards, the error boundary and background sync. | Signed out, `/` shows the landing page and `/library` redirects to `/login`. Signed in as `qa-new`, `/library` shows `No scores yet`. An unknown path such as `/no-such-page` shows the not-found page. |
| `src/assets` | Fonts on every page. | `npm run build` passes. The after screenshot of any journey shows the app's fonts, not a fallback serif. |
| `src/features` | The container for the `src/features/*` rows below. | Drive the row of each changed `src/features/<name>` folder. |
| `src/lib` | Shared helpers every journey uses: the Supabase client, uploads, the service worker, motion and media queries. | Signed in as `qa-new`, upload a score; it opens at `/doc/<id>` and its page renders. |
| `src/state` | The app-wide store behind the library and the viewer. | Signed in as `qa-one-score`, the library lists `Satie — Gymnopédie No. 1`; open it and go back, and the library still lists it. |
| `src/sync` | Saving ink and annotations, the offline queue and the PDF cache. | Signed in as `qa-new`, upload a score, draw one stroke on its page, reload; the stroke is still there. |
| `src/test` | Test helpers only. No user journey. | `npm run test` passes. |
| `src/types` | Types shared by every journey. No runtime behavior. | `npm run typecheck` passes. |
| `src/ui` | Shared buttons, dialogs, menus, toasts and empty states. | Signed in as `qa-new`, the library's empty state shows `No scores yet`; open `Account menu (qa-new@cleffy.test)` and the menu lists the email; press Escape and it closes. |
| `src/features/account` | The account page, offline storage and account deletion. | Signed in as `qa-lapsed`, open `/account`; it shows the email and the Free plan. Deleting the account is driven only with `qa-new` on a lane you will reboot. |
| `src/features/auth` | Sign up, log in, forgot and update password, the age screen and the auth callback. | Log in as `qa-new` with `node scripts/qa/drive-example.mjs`. `/register` shows its form. Needs a human check for the confirmation and reset emails. |
| `src/features/billing` | Plans, the pricing dialog, checkout review, the plan badge, limits and cancel. | Signed in as `qa-subscribed`, the account menu shows `Personal`; signed in as `qa-lapsed`, it shows `Free`. Needs a human check for Stripe checkout and the Stripe portal. |
| `src/features/demo` | The signed-out demo at `/try`. | Signed out, open `/try`; the demo score renders and the page can be marked up. |
| `src/features/export` | Exporting a score as a PDF or a page image, and the share menu. | Signed in as `qa-new`, upload a score, open its share or export menu and export a PDF; the download event fires with a `.pdf` file. |
| `src/features/fingering` | The fingering suggestion flow on an open score. | Needs a human check: suggestions read the scanned notes, and a lane cannot scan a score (see What cannot be driven). In a lane, signed in as `qa-new` with an uploaded score, the viewer opens without an error. |
| `src/features/import` | Scanning a score's marks and the import review panel. | Needs a human check: scanning needs the OMR service. In a lane, signed in as `qa-new` with an uploaded score, starting a scan shows a failure message, not a hang. |
| `src/features/imslp` | Searching IMSLP and adding a public-domain score at `/search`. | Signed in as `qa-new`, open `/search` and search `Satie`; results or a clear error message appear. The lane reaches the real IMSLP, so a network block is reported, not counted as a failure. |
| `src/features/install` | The add-to-home-screen prompt and its preferences. | Signed in as `qa-new` at a phone viewport (390x844), the library loads and any home-screen banner can be dismissed. Real installation needs a human check. |
| `src/features/legal` | The privacy, children's privacy, terms, cancel, refunds and copyright pages, and the agreement note. | Signed out, open `/privacy`, `/terms` and `/copyright`; each shows its heading. |
| `src/features/library` | The library home screen: score cards, upload, drop zone, row menu and the score limit. | Signed in as `qa-new`, the library shows `No scores yet`; upload a score and it appears in the library. |
| `src/features/marketing` | The landing page at `/` and the not-found page. | Signed out, `/` shows the hero with the `Try it now` button; `/no-such-page` shows the not-found page. |
| `src/features/moderation` | Reporting content at `/report` and the admin queue at `/admin/reports`. | Signed out, `/report` shows the report form. No seeded account is an admin, so `/admin/reports` needs a human check. |
| `src/features/notes` | The notes panel on an open score. | Signed in as `qa-new`, upload a score, open the notes panel, type a note, reload; the note is still there. |
| `src/features/playback` | Playing a score and the transport bar. | Needs a human check: playback reads the scanned notes. In a lane, signed in as `qa-new` with an uploaded score, the viewer opens without an error. |
| `src/features/roster` | A teacher's students at `/students` and assigning scores. | Signed in as `qa-subscribed`, open `/students`; the page loads or names the plan it needs. |
| `src/features/share` | Share links, live sessions at `/s` and `/join/<token>`, and invites at `/invite`. | Signed in as `qa-new`, upload a score, open the share dialog and create a link; open the link in a second, signed-out context and the score renders. |
| `src/features/student` | Student sign-in at `/student`, claim, welcome and assignments. | Signed out, `/student` shows the student sign-in form. A full student journey needs a teacher with a provisioned student, which the seed does not create. |
| `src/features/viewer` | The score viewer at `/doc/<id>`: pages, layout menu, ink and its notices. | Signed in as `qa-new`, upload a score; `/doc/<id>` renders page 1 and the layout menu opens. |
| `supabase/functions/analyze-annotations` | Reading the marks on a scanned page (the import flow). | Needs a human check: it calls Anthropic on a scanned page. In a lane, `OPTIONS` on the function answers 2xx. |
| `supabase/functions/analyze-notes` | Reading the notes for fingering. | Needs a human check: it needs a scanned score. In a lane, `OPTIONS` on the function answers 2xx. |
| `supabase/functions/billing-cancel` | Cancelling a subscription from the cancel page. | Needs a human check: it calls Stripe. In a lane, signed in as `qa-lapsed`, the cancel page shows no active subscription. |
| `supabase/functions/billing-mail-outbox` | Billing emails sent from the outbox. | Needs a human check: it sends mail through Resend. In a lane, `OPTIONS` on the function answers 2xx. |
| `supabase/functions/content-moderation` | Automatic checks on reported content. | In a lane, report a shared score through `/report`; the report is accepted. Its outside checks need a human check. |
| `supabase/functions/content-notices` | Notices to owners of reported content. | Needs a human check: it sends mail. In a lane, `OPTIONS` on the function answers 2xx. |
| `supabase/functions/content-report` | Submitting the form at `/report`. | Signed out, fill and submit the report form; it shows its confirmation. |
| `supabase/functions/delete-account` | Deleting an account from `/account`. | Signed in as `qa-new` on a lane you will reboot, delete the account; the app lands on `/account-deleted` and logging in again fails. |
| `supabase/functions/district-retention-notices` | Scheduled data-retention notices to districts. | Needs a human check: a scheduled job that sends mail. In a lane, `OPTIONS` on the function answers 2xx. |
| `supabase/functions/guest-email-confirm` | Confirming a guest's email address. | Needs a human check: the link arrives by real email. In a lane, `OPTIONS` on the function answers 2xx. |
| `supabase/functions/guest-email-start` | Starting a guest's email confirmation. | Needs a human check: it sends mail and checks Turnstile. In a lane, `OPTIONS` on the function answers 2xx. |
| `supabase/functions/imslp-download` | Adding an IMSLP score to the library. | Signed in as `qa-new`, add a result from `/search`; the score appears in the library. A network block to IMSLP is reported, not counted as a failure. |
| `supabase/functions/imslp-search` | Searching at `/search`. | `npm run qa:doctor` checks it answers `OPTIONS`. Signed in as `qa-new`, search `Satie` at `/search`; results or a clear error appear. |
| `supabase/functions/imslp-sync` | Background sync of the IMSLP catalog. | In a lane, `OPTIONS` on the function answers 2xx. Its full sync needs a human check. |
| `supabase/functions/imslp-work` | Opening a work's details from the search results. | Signed in as `qa-new`, open a work from `/search` results; its files list appears. |
| `supabase/functions/resend-inbound` | Inbound email handling. | Needs a human check: it receives real email. In a lane, `OPTIONS` on the function answers 2xx. |
| `supabase/functions/score-analyze` | Scanning a score (OMR). | Needs a human check: a lane runs no OMR service. In a lane, a scan request answers `502 service_unreachable` and the app shows the scan as failed. |
| `supabase/functions/share-invite` | Inviting someone to a score by email. | Needs a human check: the invite arrives by email. In a lane, the share dialog's invite form opens. |
| `supabase/functions/share-invite-accept` | Accepting an invite at `/invite`. | Needs a human check: the invite link arrives by email. In a lane, `/invite` without a token shows an invalid-invite message. |
| `supabase/functions/share-session` | Live share sessions at `/s` and `/join/<token>`. | Signed in as `qa-new`, upload a score and start a share link; a second signed-out context joins and sees the score. |
| `supabase/functions/stripe-checkout` | Buying a plan from the pricing dialog. | Needs a human check: it opens Stripe checkout. In a lane, signed in as `qa-new`, the pricing dialog opens and lists the plans. |
| `supabase/functions/stripe-portal` | Managing a subscription in the Stripe portal. | Needs a human check: it opens the Stripe portal. In a lane, signed in as `qa-subscribed`, `/account` shows the Personal plan. |
| `supabase/functions/stripe-webhook` | Plan changes that Stripe reports. | Needs a human check: only Stripe sends its events. In a lane, signed in as `qa-subscribed` and `qa-lapsed`, the account menu shows `Personal` and `Free`. |
| `supabase/functions/student-claim` | A student claiming an account at `/student/claim`. | Signed out, `/student/claim` shows its form. A full claim needs a provisioned student, which the seed does not create. |
| `supabase/functions/student-login` | Student sign-in at `/student`. | Signed out, submit `/student` with a made-up code; it shows a sign-in error, not a crash. |
| `supabase/functions/student-provision` | A teacher creating student accounts at `/students`. | Signed in as `qa-subscribed`, open `/students`; adding a student works or names the plan it needs. |
