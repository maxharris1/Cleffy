# Cleffy PR #74: zod bump report

**Status:** Complete

## Environment

- Cloud environment: **Cleffy** (`env_01WAd3yiz3qpSnsofpyEwCh2`, kind `anthropic_cloud`), not Sandbox. Confirmed with `get_session` and `list_environments`.
- Only the local stack was used. Hosted Supabase was not touched, no `.env` files or secrets were used, and `playwright install` was not run.

## Branch and commit

- Branch: `mh/ui-polish-emil` (PR #74, draft, base `dev`)
- Old head: `07dd982ac908112e29055db9d3298766eb19fa63` (matched the expected head)
- New head: `a95c2ce79acb38554836508094dc6f43689bdf00`, pushed as a fast-forward (`07dd982..a95c2ce`). No force push, no rebase.
- Commit `a95c2ce79acb38554836508094dc6f43689bdf00`, author Max Harris <drumaxter@gmail.com>:
  `Bump zod to ^4.6.7 to clear GHSA-mrhx-c7xc-m3w5`
- Files changed: `package.json` and `package-lock.json` only (1 + 4 lines).
- PR #74 was not merged or marked ready. Nothing was pushed to `dev` or `main`. PR #54 was not touched.

## zod version

|                      | Before   | After    |
| -------------------- | -------- | -------- |
| `package.json` range | `^4.4.3` | `^4.6.7` |
| Lockfile resolved    | `4.4.3`  | `4.6.7`  |

4.6.7 is the npm `latest` tag and the newest 4.x release. The only zod in the tree is one deduped copy, which `eslint-plugin-react-hooks` and `zod-validation-error` also use.

## Local checks (run before pushing, on the new tree)

| Check                                     | Result                                                                |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `npm audit --omit=dev --audit-level=high` | Pass: `found 0 vulnerabilities` (before the bump: 1 high, zod <4.6.6) |
| `npm run lint:check`                      | Pass (exit 0)                                                         |
| `npm run typecheck`                       | Pass (exit 0)                                                         |
| `npm run test`                            | Pass: 250 files passed, 6 skipped; 3920 tests passed, 22 skipped      |
| `npm run build`                           | Pass (exit 0, PWA sw generated)                                       |

## GitHub CI

On head `a95c2ce`, the `checks` job **succeeded**. Every step passed, including "Audit production dependencies".

- Run URL: https://github.com/maxharris1/Cleffy/actions/runs/40048694102/job/120736204913
- A second CI run on the same SHA was also green: https://github.com/maxharris1/Cleffy/actions/runs/40048698285/job/120736218625
- The other checks on that head are green too: `supabase-local`, `supabase-drift`, `edge-functions-deno`, `omr-service` and Vercel Preview Comments. Supabase Preview was skipped.

## Anything else audit flagged

The production audit (`--omit=dev`, which is the CI gate) is now clean.

The full `npm audit`, including dev dependencies, still reports 10 issues (1 low, 3 moderate, 6 high). All of them are in dev tooling, which is outside the CI gate and this task's scope, so I left them unchanged and am reporting them here:

| Package              | Severity | Vulnerable range                  | Direct dev dep |
| -------------------- | -------- | --------------------------------- | -------------- |
| vite                 | high     | 8.2.0 - 8.2.2                     | yes            |
| undici               | high     | 8.0.0 - 8.12.1                    | yes            |
| brace-expansion      | high     | 2.0.0 - 2.1.6 \|\| 4.0.0 - 5.0.11 | no             |
| fast-uri             | high     | 3.0.0 - 3.1.8                     | no             |
| nanoid               | high     | <3.3.18                           | no             |
| source-map-js        | high     | 1.0.0 - 1.2.1                     | no             |
| vitest               | moderate | 2.1.0-beta.1 - 4.1.10             | yes            |
| @vitest/ui           | moderate | 2.1.0-beta.1 - 4.1.10             | yes            |
| @vitest/mocker       | moderate | <=4.1.11                          | no             |
| serialize-javascript | low      | <7.1.3                            | no             |

`npm audit` says a fix is available for every one of these via `npm audit fix`. That should be a separate dev-dependency update.
