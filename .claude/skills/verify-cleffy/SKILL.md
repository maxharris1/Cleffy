---
name: verify-cleffy
description: Boot Cleffy's web app on a QA lane, check it is healthy, drive a named user journey in headless Playwright and save evidence that it passed. Use when you must prove a Cleffy pull request works in the real UI, or must pick which journeys a change affects.
---

# Verify Cleffy

Cleffy is a web app for musicians to keep and mark up their scores. Users touch one surface, the browser UI, a React app served by Vite. Behind it run a local Supabase stack (database, auth, storage) and a Deno server for the edge functions. On a QA lane all of it runs as plain processes on one machine: no Docker, nothing hosted.

You read this cold. Follow the sections in order: Launch, Doctor, Drive, Evidence, Cleanup. Use the Feature map to choose what to drive. This skill never asks you to edit, commit or push. You drive and report.

`docs/qa-lane.md` is the reference behind every step here. Read it when a step fails in a way this file does not cover.

## Launch

From the repo root:

```bash
npm run qa:boot
```

It runs `scripts/qa/boot-lane.sh`. That starts Supabase on the CLI's native runtime, then the edge-functions server, then Vite. The tools it needs (Supabase CLI 3.2.0, Deno 2.7.14, Playwright's Chromium) come from `scripts/qa/cloud-setup.sh`, which the lane image already ran.

It prints one `[boot-lane] <step>` line per step, then:

```
READY http://127.0.0.1:5173 http://127.0.0.1:<api port>
```

- `READY` means usable, not just started. The boot printed it only after the functions server answered `OPTIONS /functions/v1/imslp-search` with a 2xx and Vite answered `GET /` with a 2xx. Migrations ran and the seed accounts exist.
- The first URL is the app. It is always `http://127.0.0.1:5173`. Drive only that address.
- The second URL is the Supabase API. A drive does not need it.
- A step that fails prints `FAILED <step> (log: <path>)` and the log's last 30 lines, and the boot exits non-zero. No `READY` line means no lane. Run Doctor, then follow its failure path.
- Lane state lives in `${CLEFFY_QA_LANE_DIR:-/tmp/cleffy-qa-lane}`: `start.json`, `functions.url`, `functions.pid`, `vite.pid` and one log per step under `logs/`.
- Booting again on a healthy lane prints `READY` and exits without restarting anything. A boot is safe to repeat.
- One lane per machine. The app port 5173 is fixed, so never start a second lane beside a running one.

## Doctor

```bash
npm run qa:doctor
```

It is read-only. It prints one line per check and exits 0 only when every line is `OK`:

```
OK app
OK api
OK function
OK setting ANTHROPIC_API_KEY
```

- Run it before the first drive and again after any failed drive.
- Never drive a lane that has not passed it. A failed drive on an unhealthy lane proves nothing about the pull request.
- On a `FAIL` line, run `npm run qa:recover`. It stops the lane's Vite, its functions server and Supabase, then boots again. Then run the doctor again. If it still fails, stop and report the lane as BLOCKED, with the doctor output and the log named in the failing step.
- `FAIL setting <NAME>: unset` means the machine lacks a setting that the lane passes to the edge functions. Your brief supplies it in the environment. Never invent a value, and never print one.

## Drive

Drive headless Chromium with Playwright, from Node, at the app URL `READY` printed. `scripts/qa/drive-example.mjs` is the template. It signs in as a new user and saves evidence for the library home screen. Run it first to prove your driving works:

```bash
CLEFFY_QA_EVIDENCE_DIR=<evidence folder>/sign-in-new-user node scripts/qa/drive-example.mjs
```

It exits 0 and prints the paths it wrote. For a new scenario, copy it into `scripts/qa/scratch/`, change the steps after sign-in, and run the copy from the repo root:

```bash
mkdir -p scripts/qa/scratch
cp scripts/qa/drive-example.mjs scripts/qa/scratch/<scenario>.mjs
CLEFFY_QA_EVIDENCE_DIR=<evidence folder>/<scenario> node scripts/qa/scratch/<scenario>.mjs
```

Git ignores `scripts/qa/scratch/`, so a copy there is never committed. Keep copies inside the repo. Node finds `playwright` by looking for `node_modules` above the script's own file, so a copy in `/tmp` fails with `ERR_MODULE_NOT_FOUND` wherever you run it from. The script reads:

- `CLEFFY_QA_APP_URL`, the app URL. The default is `http://127.0.0.1:5173`.
- `CLEFFY_QA_EVIDENCE_DIR`, the folder for this scenario's evidence. The default is `/tmp/cleffy-qa-evidence/drive-example`.
- `CLEFFY_UI_CHROMIUM`, a Chromium binary to use in place of Playwright's own.

**Sign in.** Every account comes from `supabase/seed.sql` and is reset on each fresh lane. All of them use the shared local-only seed password that `docs/qa-lane.md` gives under "Seeded states". The `cleffy.test` addresses are reserved for testing, so none is a real person's. Pick the account whose starting state your scenario needs:

| Account | Starting state |
| --- | --- |
| `qa-new@cleffy.test` | Free plan, no scores. First-run flows and first upload. |
| `qa-one-score@cleffy.test` | Free plan, one score, "Satie — Gymnopédie No. 1 (seed)". Its row exists but its PDF does not, so a scenario that opens the PDF uploads one. |
| `qa-subscribed@cleffy.test` | Personal plan from an active subscription. Paid-plan limits and billing. |
| `qa-lapsed@cleffy.test` | Free plan after a lapsed subscription. Resubscribe prompts. |

```js
await page.goto(`${APP_URL}/login`);
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password', { exact: true }).fill(password);
await page.getByRole('button', { name: 'Log in' }).click();
await page.waitForURL(/\/library$/);
await settle(page.getByRole('button', { name: `Account menu (${email})` }));
```

A good sign-in lands on `/library`, the home screen. `qa-new` sees `No scores yet`. `qa-one-score` sees `1 score`. The account menu button's name is `Account menu (<email>)`. Click it and the menu shows the email and the plan (`Free` or `Personal`).

**Upload a score.** Signed in, on `/library`, set the library's file input to a fixture:

```js
await page.locator('input[type=file]').first().setInputFiles('e2e-fixtures/test-score.pdf');
await page.waitForURL(/\/doc\/[^/]+$/);
```

The upload opens the score at `/doc/<id>`. Back on `/library` the score is listed. `e2e-fixtures/` holds the PDFs to use. Never upload anything from outside it.

**Settle before every screenshot.** The app fades content in. A screenshot taken while the target is still fading proves nothing. Wait until the target element is visible and it and every ancestor have a computed `opacity` of `1`. `drive-example.mjs` has a `settle(locator)` helper that does this. Call it on the element your pass test reads, then take the screenshot.

**Handles.** Use stable handles: labels (`getByLabel`), roles with names (`getByRole`), visible text, and routes (`waitForURL`). Never use coordinates, tab order or CSS class names. Routes are in `src/app/routes.tsx`.

**One context per scenario.** Open a new browser context for each scenario, so no sign-in leaks into the next one. A scenario that needs a second person, such as a share link, opens a second context.

## Evidence

Save evidence under the folder your brief names, one subfolder per scenario, such as `<evidence folder>/<scenario>/`. When the brief names none, use `/tmp/cleffy-qa-evidence/<scenario>/` and say so in your report. For each scenario save:

- `before.png`: the screen just before the action under test, settled.
- `after.png`: the screen that shows the result, settled.
- A video for a scenario of more than one step. Create the context with `recordVideo: { dir: '<scenario folder>/video' }`. The file is written when the context closes, so close the context before you read it.
- `result.json`: what the pass test observed, read off the page, not what you expected. Example: `{ "scenario": "sign-in-new-user", "url": "http://127.0.0.1:5173/library", "emptyLibraryText": "No scores yet", "accountMenuLabel": "Account menu (qa-new@cleffy.test)", "pass": true }`. A failed scenario still writes it, with `"pass": false`, the error, and a `failure.png`.

Proof standards:

- Drive the path a user takes, through the UI. Never call the API or set state directly to skip a step.
- Capture the action and its result, not only the final screen.
- Check side effects you can see: an uploaded score is listed after a reload, a note is still there after a reload.
- A step the lane cannot drive is reported as described in "What cannot be driven". It is not a pass.

## Cleanup

Stop what you started, and only that.

1. Close every browser context and the browser your scripts opened. A script that exits does this. A script you killed may leave Chromium running, so kill only the pid your script started.
2. Stop the lane if your brief says to, or if you booted it and your brief does not say to keep it. Run these from the repo root. Each step uses the lane's own pidfiles and workdir:

   ```bash
   LANE_DIR="${CLEFFY_QA_LANE_DIR:-/tmp/cleffy-qa-lane}"
   bash -c 'source scripts/qa/boot-lane.sh; stop_pidfile "$1/vite.pid"; stop_pidfile "$1/functions.pid"' _ "$LANE_DIR"
   SUPABASE_EXPERIMENTAL_STACK=1 supabase stop --workdir "$LANE_DIR"
   ```

   If the lane booted as root and dropped to `cleffy-qa`, run the `supabase stop` as that user, as `scripts/qa/recover.sh` does.
3. Never kill by process name (`pkill node`, `killall vite`). Another lane or a person's own session may own a process of the same name.
4. Never delete evidence. After cleanup, list the evidence folder and confirm every scenario's `after.png` and `result.json` still exist. Put that listing in your report.

## Feature map

[`feature-map.md`](feature-map.md) has one row for every top-level folder under `src/`, every folder under `src/features/`, and every function under `supabase/functions/`. Each row gives the user journey the area affects and the one smoke check that shows the journey still works.

To choose what to drive for a pull request:

1. List the changed paths: `git diff --name-only <base>...HEAD`.
2. For each path under `src/` or `supabase/functions/`, take the most specific row that contains it. `src/features/library/ScoreCard.tsx` takes the `src/features/library` row. `supabase/functions/_shared/` is shared by every function, so take the row of each function the pull request names, or `supabase/functions/imslp-search` when it names none.
3. Drive each chosen row's smoke check, plus the journey the pull request itself describes.
4. A changed path outside both trees (docs, `scripts/`, CI) needs no drive of its own. Say so in your report.

If a changed folder has no row, the map is out of date. Report that, and drive the journey the pull request describes.

## What cannot be driven

A lane reaches no outside service that moves money, sends mail or signs people in elsewhere. Report any such step as "needs a human check", name the step, and drive the parts before and after it. It is neither a pass nor a fail.

- **Real email.** Resend is not configured, so no mail is sent: sign-up confirmation, password reset, guest email confirmation, share invites, billing and moderation notices.
- **Real payment.** Stripe is not configured: checkout, the customer portal, cancellation through Stripe, and plan changes that Stripe's webhook reports. The seeded plans are rows in the local database, so plan badges and limits can be driven.
- **Outside sign-in.** Any OAuth or third-party sign-in, and Turnstile's bot check.
- **Score scanning.** The lane runs no OMR service, and its build leaves play-along, fingering and smart import off, so the app offers no scan. Scanning, and the fingering suggestions and playback that read scanned notes, need a human check on `dev.cleffy.io`.
- **Share v2.** The lane leaves Share v2 off (`VITE_FEATURE_SHARE_V2`, `SHARE_V2_ENABLED`). Share links use `/join/<token>`, and invites by email, `/s` links and `/invite` need a human check on a build with Share v2 on.
- **Admin pages.** No seeded account is an admin, so `/admin/reports` needs a human check.
