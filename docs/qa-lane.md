# QA lane

A QA lane is a fresh cloud machine where an agent boots Cleffy at a pull
request's commit and drives the real UI. Everything in a lane runs as a plain
process: no Docker. Supabase runs on the CLI's native runtime.

## Scripts

| Script                      | npm          | What it does                                                                                                 |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `scripts/qa/cloud-setup.sh` |              | Runs once when the lane image is built: `npm ci`, Playwright's Chromium, Supabase CLI 3.2.0. Starts nothing. |
| `scripts/qa/boot-lane.sh`   | `qa:boot`    | Boots Supabase, the edge functions and Vite. Prints `READY <app url> <api url>`.                             |
| `scripts/qa/doctor.sh`      | `qa:doctor`  | One `OK` or `FAIL` line per check. Exits 0 only if every check passes.                                       |
| `scripts/qa/recover.sh`     | `qa:recover` | Stops what `boot-lane.sh` started and boots again.                                                           |

The lane's state lives outside the worktree in `${CLEFFY_QA_LANE_DIR:-/tmp/cleffy-qa-lane}`:
the Supabase config copy, `start.json` (the start output), `vite.pid` and one log
per step under `logs/`.

## Outside-service settings

A lane reads these names from the machine's environment and passes them to the
edge functions. `doctor.sh` fails, naming the setting, when one is unset. Both
scripts read this block, so adding a name here needs no script change.

```qa-lane-settings
ANTHROPIC_API_KEY
OMR_SERVICE_URL
OMR_SERVICE_SECRET
```

`OMR_SERVICE_URL` and `OMR_SERVICE_SECRET` point the lane at the deployed dev copy
of the score-scanning service. Stripe, Resend and Turnstile are left out, so a
lane never charges a card or sends mail.

## The config copy

`boot-lane.sh` never edits the committed `supabase/config.toml`. It copies
`supabase/` into the lane dir and changes only the copy:

- It drops the fixed `port` of `[api]`, `[db]`, `[studio]` and `[local_smtp]`,
  `shadow_port`, and `inspector_port`, so the native engine picks free ports.
  Nothing in a lane assumes a fixed port; the scripts read them from `start.json`.
- It drops every `[remotes.*]` section. They describe hosted projects, and the
  native validator rejects them in a copy.

The native start writes `supabase/supabase.lock` into its workdir, which is the
other reason it runs from the copy.

## Running as root

The native runtime refuses root. When `boot-lane.sh` starts as root it creates a
`cleffy-qa` user, gives it the worktree and the lane dir, and re-runs itself as
that user with only `PATH`, `HOME`, the settings above and the proxy variables.

## Running a lane by hand

```bash
bash scripts/qa/cloud-setup.sh
export ANTHROPIC_API_KEY=... OMR_SERVICE_URL=... OMR_SERVICE_SECRET=...
npm run qa:boot
npm run qa:doctor
```
