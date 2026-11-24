# Production preflight

`npm run ops:preflight -- <base-url> [--require captcha,sentry]` reads a deployed site and prints one `OK`, `FAIL` or `INFO` line per check. It exits 0 only when no check fails, 1 when one does, and 2 on bad arguments.

It is read-only. Every request is a plain `GET` with `redirect: 'manual'`, `credentials: 'omit'`, no request headers and a 10 second timeout. It follows redirects itself, up to 5, so it can report the chain. It changes nothing on the site, in Vercel or in Supabase.

## Checks

- `pages`: `/`, `/try`, `/privacy`, `/terms`, `/refunds` and `/copyright` each answer 200 after redirects. The line names every path that does not.
- `utm-redirect`: `<base>/?utm_source=preflight&utm_medium=check&utm_campaign=preflight` lands on a 200 with the same path and all three `utm_` tags. The line prints the redirect chain, for example `308 https://cleffy.io/?… -> 200 https://www.cleffy.io/?…`.
- `canonical-host`: the host `/` lands on. It is `INFO`, not `FAIL`, when the page's `og:url` names a different host or has none. It fails only when `/` cannot be reached.
- `security-headers`: the response `/` lands on sends `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy` and `Permissions-Policy`. The CSP's own `script-src` and `frame-src` list `https://challenges.cloudflare.com` for Turnstile, and its `connect-src` lists a Sentry ingest host such as `https://*.ingest.sentry.io`. A source in `default-src` does not count. The line names every missing header, wrong value and missing source.
- `captcha`: whether the Turnstile site key was compiled into the deployed JS. It scans the entry script, every `modulepreload`, and every `assets/*.js` file the fetched JS names. It fetches same-origin files only and stops after 200. The line shows only the key length, never the key.
- `sentry`: whether the Sentry DSN was compiled into the same JS. The line shows only the ingest host, never the DSN.

`captcha` and `sentry` are `INFO` when the value is absent. Pass `--require captcha`, `--require sentry` or `--require captcha,sentry` to make absence `FAIL`. A scan that hits the 200-file cap without finding the key also fails `--require captcha`. Both fail under `--require` when `/` cannot be reached.

## Before the canonical-domain switch

Run it against production before and after changing the domain redirect:

```sh
npm run ops:preflight -- https://cleffy.io
```

Proceed only on exit 0. After the switch, check that `utm-redirect` still says the tags were kept and that `canonical-host` names the host you meant to make canonical. If `canonical-host` prints `INFO` with a different `og:url` host, the redirect and the page's `og:url` disagree. Decide which one is right before you announce the domain.

## Before turning Supabase captcha on

Check that the deployed bundle carries the Turnstile site key:

```sh
npm run ops:preflight -- https://cleffy.io --require captcha
```

Proceed only on exit 0. A `FAIL captcha` line means the build that is live has no site key. Supabase would then reject auth requests from that build, because they carry no captcha token.

## Before turning Sentry on

Check that the deployed bundle carries the Sentry DSN:

```sh
npm run ops:preflight -- https://cleffy.io --require sentry
```

Proceed only on exit 0. Check that the ingest host on the `sentry` line belongs to the Sentry project you meant.
