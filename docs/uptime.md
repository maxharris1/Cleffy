# Production uptime check

`.github/workflows/uptime.yml` probes production every 10 minutes. While production is down it keeps one open issue labelled `uptime` that mentions @maxharris1, so the alert arrives through GitHub notifications. It closes that issue when production recovers.

## What is probed

| Probe      | URL                                       | Up when                                                                         |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| `home`     | `https://cleffy.io/` (redirects followed) | HTTP 200 and the HTML contains `id="root"`                                      |
| `try`      | `https://cleffy.io/try`                   | HTTP 200                                                                        |
| `supabase` | `${UPTIME_SUPABASE_URL}/rest/v1/`         | Any HTTP status below 500. A 401 without an API key still proves the API is up. |

Each request has a 10 second timeout. A failed probe is retried once after 5 seconds before it counts as down.

The `supabase` probe reads the host from the repository variable `UPTIME_SUPABASE_URL`. When the variable is unset, the run skips that probe with a notice. To turn it on:

```sh
gh variable set UPTIME_SUPABASE_URL --body https://jibgwgosihadbjgxdsfe.supabase.co
```

The workflow reads no secrets. It opens and closes issues with the run's own `github.token`.

## What happens on each run

| Result          | Open `uptime` issue | Action                                                                |
| --------------- | ------------------- | --------------------------------------------------------------------- |
| A probe is down | none                | Opens `Production down: <probes>` with the probe output and run link. |
| A probe is down | yes                 | Comments the probe output and run link on it.                         |
| All up          | yes                 | Comments `Recovered at <UTC time>` and closes it.                     |
| All up          | none                | Nothing.                                                              |

A run with a down probe also fails, so outages show in the Actions history. While production stays down, the issue gets a comment every 10 minutes.

The workflow creates the `uptime` label itself if it does not exist.

## Testing it

Run the workflow by hand with the `down_url` input to force the `try` probe to fail:

```sh
gh workflow run uptime.yml -f down_url=http://127.0.0.1:9/
```

The issue it opens ends in `(forced test)`. Run it again without the input to close the issue.

## Silencing it

Disable the workflow with `gh workflow disable uptime.yml`, or with **Disable workflow** on its Actions page. Turn it back on with `gh workflow enable uptime.yml`.

## When it goes live

GitHub runs scheduled workflows only from the default branch, `main`. The check starts on its schedule with the next `dev` to `main` release. Until then it runs only when dispatched by hand.
