# QA lane

A QA lane is a fresh cloud machine where an agent boots Cleffy at a pull
request's commit and drives the real UI. Everything in a lane runs as a plain
process: no Docker. Supabase runs on the CLI's native runtime.

## Scripts

| Script                      | npm          | What it does                                                                                                              |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `scripts/qa/cloud-setup.sh` |              | Runs once when the lane image is built: `npm ci`, Playwright's Chromium, Supabase CLI 3.2.0, Deno 2.7.14. Starts nothing. |
| `scripts/qa/boot-lane.sh`   | `qa:boot`    | Boots Supabase, the edge functions and Vite. Prints `READY <app url> <api url>`.                                          |
| `scripts/qa/doctor.sh`      | `qa:doctor`  | One `OK` or `FAIL` line per check. Exits 0 only if every check passes.                                                    |
| `scripts/qa/recover.sh`     | `qa:recover` | Stops what `boot-lane.sh` started and boots again.                                                                        |

The lane's state lives outside the worktree in `${CLEFFY_QA_LANE_DIR:-/tmp/cleffy-qa-lane}`:
the Supabase config copy, `start.json` (the start output), `functions.url`,
`functions.pid`, `vite.pid` and one log per step under `logs/`.

## Edge functions

The lane does not use the CLI's functions service. On CLI 3.2.0's native stack it
answered `404 Function not found` for every function on a Linux lane (see
[Upstream notes](#upstream-notes)). Instead `boot-lane.sh` starts
`scripts/qa/functions-server.ts` under Deno. It:

- serves `supabase/functions/<name>/index.ts` at `/functions/v1/<name>`, loading
  each function on its first request and capturing the handler it passes to
  `Deno.serve`;
- proxies every other path, websockets included, to the stack's `API_URL`;
- listens on a free port on `127.0.0.1` and writes its address to `functions.url`.

The functions get `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` from `start.json`, plus the settings below and
`APP_URL`. Vite gets the server's address as
`VITE_SUPABASE_URL`, so the app reaches the API and the functions through one URL.
The server does not verify JWTs, the same as `functions serve --no-verify-jwt`.
When `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE` names a file, Deno gets it as
`DENO_CERT`.

`boot-lane.sh` and `doctor.sh` pass the functions check only when
`OPTIONS /functions/v1/imslp-search` answers 2xx; any other answer, such as
`500 BOOT_ERROR` from a function that fails to import, fails with the status and
response body. When the doctor check fails, a boot stops the previous functions
server and Vite before starting new ones, so Vite always gets the current
`functions.url`.

## Outside-service settings

A lane reads these names from the machine's environment and passes them to the
edge functions. `doctor.sh` fails, naming the setting, when one is unset. Both
scripts read this block, so adding a name here needs no script change.

```qa-lane-settings
ANTHROPIC_API_KEY
```

Stripe, Resend and Turnstile are left out, so a lane never charges a card or
sends mail.

## Score scanning

Scan requests do not complete in a lane. The lane runs no score-scanning service
and passes no `OMR_*` setting to the edge functions, so `score-analyze` answers
`502 service_unreachable` and marks the analysis failed. The deployed dev service
cannot serve a lane: it accepts only PDF URLs from its own Supabase project, and
it cannot reach a lane's loopback API or write into the lane's database. QA
score-scan changes on `dev.cleffy.io`.

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

Postgres's `initdb` refuses a locale the machine lacks, such as `C.UTF-8` on
macOS. Both scripts set `LANG` and `LC_ALL` to an installed UTF-8 locale before
any `supabase` command. This matters for every command, not only `start`: the
CLI's stack host is a long-lived process that keeps the environment of the
command that first started it.

The stack keeps its database in `~/.supabase/stacks/<id>`. A second boot on the
same machine reuses it and applies no migrations; a fresh lane machine applies
all of them.

## Running as root

The native runtime refuses root. When `boot-lane.sh` starts as root it creates a
`cleffy-qa` user, gives it the worktree and the lane dir, and re-runs itself as
that user with only `PATH`, `HOME`, the settings above and the proxy variables.

## Upstream notes

Two problems in Supabase CLI 3.2.0's experimental native stack. The lane works
around both and does not wait on a fix.

- **Function routing 404.** With `supabase start --runtime native` and
  `supabase functions serve`, every `/functions/v1/<name>` request returned
  `404 Function not found`, including a one-line `Deno.serve` function, on a
  Linux machine. The 404 comes from `resolveFunctionConfig` in the CLI's bundled
  main service. On macOS the same route answered, so the lane's own server
  avoids the difference.
- **Second-start database timeout.** On the same Linux machine, after one
  successful start and `supabase stop`, every later start in a fresh workdir
  failed after about 2m50s with `Database readiness timed out` and wrote no
  database log. On macOS stop-then-start worked. If a lane hits it,
  `recover.sh` will fail the same way; deleting `~/.supabase/stacks/<id>` and
  booting again is the next thing to try (untested on Linux).

## Running a lane by hand

```bash
bash scripts/qa/cloud-setup.sh
export ANTHROPIC_API_KEY=...
npm run qa:boot
npm run qa:doctor
```
