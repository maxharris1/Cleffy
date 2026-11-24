# Production preflight

`npm run ops:preflight -- <base-url>` reads a deployed site and prints one `OK`, `FAIL` or `INFO` line per check. It exits 0 only when no check fails, 1 when one does, and 2 on bad arguments.

It is read-only. Every request is a plain `GET` with `redirect: 'manual'`, `credentials: 'omit'`, no request headers and a 10 second timeout. It follows redirects itself, up to 5, so it can report the chain. It changes nothing on the site, in Vercel or in Supabase.

## Checks

- `pages`: `/`, `/try`, `/privacy`, `/terms`, `/refunds` and `/copyright` each answer 200 after redirects. The line names every path that does not.
- `utm-redirect`: `<base>/?utm_source=preflight&utm_medium=check&utm_campaign=preflight` lands on a 200 with the same path and all three `utm_` tags. The line prints the redirect chain, for example `308 https://cleffy.io/?… -> 200 https://www.cleffy.io/?…`.
- `canonical-host`: the host `/` lands on. It is `INFO`, not `FAIL`, when the page's `og:url` names a different host or has none. It fails only when `/` cannot be reached.
- `security-headers`: the response `/` lands on sends `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy` and `Permissions-Policy`. The CSP's own `script-src` and `frame-src` list `https://challenges.cloudflare.com` for Turnstile, and its `connect-src` lists a Sentry ingest host such as `https://*.ingest.sentry.io`. A source in `default-src` does not count. The line names every missing header, wrong value and missing source.

## Before the canonical-domain switch

Run it against production before and after changing the domain redirect:

```sh
npm run ops:preflight -- https://cleffy.io
```

Proceed only on exit 0. After the switch, check that `utm-redirect` still says the tags were kept and that `canonical-host` names the host you meant to make canonical. If `canonical-host` prints `INFO` with a different `og:url` host, the redirect and the page's `og:url` disagree. Decide which one is right before you announce the domain.
