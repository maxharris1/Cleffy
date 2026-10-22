# Deploying Cleffy — cleffy.io (main) and dev.cleffy.io (dev)

`main` builds to **cleffy.io**, `dev` builds to **dev.cleffy.io**, both served by
one Vercel project over two Supabase projects. **The live flip is done:**
cleffy.io sells from the real Stripe account and dev.cleffy.io from the sandbox,
each against its own database.

Everything in this file that could be automated **has been**. What remains are
the steps that need a human because no API exposes them — each one says why.

---

## Status

| Piece                                                                  | State                                                                                                                 |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Billing schema (`billing`, `roster` migrations)                        | ✅ applied to production                                                                                              |
| Edge Functions (checkout, portal, webhook, student ×2, metered imslp)  | ✅ deployed, ACTIVE                                                                                                   |
| Stripe functions redeployed at v2 with the self-configuring catalogue  | ✅ verified live                                                                                                      |
| Stripe sandbox catalogue (3 products, 7 prices)                        | ✅ created                                                                                                            |
| Stripe **live** catalogue (3 products, 7 prices)                       | ✅ created                                                                                                            |
| Stripe webhook endpoint → `stripe-webhook` (sandbox)                   | ⚠️ enabled with 5 events; needs all 9 the webhook handles (_Go-live 2026-10_, _Stripe webhook events_)                |
| Stripe webhook endpoint → `stripe-webhook` (live)                      | ⚠️ enabled with 5 events; needs all 9 the webhook handles (_Go-live 2026-10_, _Stripe webhook events_)                |
| Price ids: client ↔ Edge Function, both modes                          | ✅ committed, drift-guarded by tests                                                                                  |
| Stripe Customer portal configuration (sandbox)                         | ✅ created, `is_default: true`; plan switching **not verified** (§1)                                                  |
| Stripe Customer portal configuration (live)                            | ✅ `bpc_1U9juu4eZ6RX0W0gPrUkrH6S`, default + active, plan switching on                                                |
| Edge secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_URL`) | ✅ set on production                                                                                                  |
| Edge secret `STRIPE_WEBHOOK_SECRET_LIVE` (production)                  | ✅ set                                                                                                                |
| Edge secret `STRIPE_SECRET_KEY_LIVE` (production)                      | ✅ set 2026-08-28                                                                                                     |
| Stripe secrets on the `dev` branch project                             | ✅ key, webhook secret and `APP_URL` set 2026-08-29                                                                   |
| Vercel project, linked to `main`, auto-deploying                       | ✅ created and verified live                                                                                          |
| `dev` branch deploy config (SPA rewrite + Supabase env)                | ✅ pushed, preview verified live                                                                                      |
| cleffy.io / dev.cleffy.io attached, certs issued                       | ✅ live                                                                                                               |
| Separate dev Supabase backend                                          | ✅ persistent `dev` branch, `qdbnlrgylelelvwbkvnm` (§5)                                                               |
| dev.cleffy.io actually pointed at that backend                         | ✅ by hostname in the bundle — **was production until 2026-08-28 (§5)**                                               |
| Edge secret `STRIPE_MODES` (both projects)                             | ✅ `live` on production, `test` on the branch                                                                         |
| Sandbox webhook endpoint retargeted to the branch                      | ✅ `we_1U9fnx9EqxUjgZtnXnAvtJH3`; the superseded one is disabled                                                      |
| Billing migration `20260828180000` applied to production               | ✅ applied and recorded                                                                                               |
| `entitling_billing_modes()` narrowed on production                     | ✅ `{live}`                                                                                                           |
| Stripe functions redeployed mode-aware                                 | ✅ v7 ACTIVE on production                                                                                            |
| Migrations `20260827150000` + `20260828120000` on production           | ✅ applied 2026-08-29 (history drift repaired again 2026-10-08, step 1)                                               |
| Supabase plan (realtime quota, connections, pausing)                   | ✅ **Pro** (org "Cleffy"); watch realtime usage after launch (§10)                                                    |
| QA round 3 migrations `20261010120200` … `20261010120302`              | ✅ dev branch project (latest `20261010120302`); ⏳ production has none of the 2026-10 migrations (release checklist) |
| QA round 4 migrations `20261011120100`, `20261011120101`               | ⏳ not applied on either project (release checklist)                                                                  |
| Recovery path (history replay, corpus tables, logical restore)         | ⚠️ four known gaps, none blocking the push (_Recovery and disaster recovery_)                                         |
| Production go-live: wipe, then a fresh replay of every migration       | ⏳ not started (_Go-live 2026-10: fresh production_)                                                                  |

---

## Go-live 2026-10: fresh production (wipe first)

This is the path for the 2026-10 launch: production (`jibgwgosihadbjgxdsfe`)
is **wiped**, and then every migration replays onto it from the start when
PR #54 (`dev` → `main`) merges. It replaces the _Release checklist — launch
fixes (20261007\*)_ below, which was written for pushing pending migrations
onto production's existing data.

**Counts, from the repository at `dev` 47e9b38f:** 96 migrations
(`ls supabase/migrations | wc -l`) and 23 Edge Functions (the directories under
`supabase/functions/` other than `_shared`). `main` has 26 migrations and 13
functions. So the merge applies 70 migrations on top of a reset to `main`, and
deploys 23 functions. Count again on the final #54 head, because P1, P3, P4 and
P5 add migrations.

Steps are in order. Steps 3 to 6 are one sitting: from the wipe in step 3 until
Vercel finishes the build in step 6, cleffy.io serves the old bundle against an
empty database. Do them outside lesson hours. Names that the launchfix packets
P1 to P5 add were not on any branch when this was written (no
`mh/launchfix-p1…p5` branch existed at 47e9b38f). They are marked
"(confirm after P<N>)". Replace each one with the real name before you start.

### 1. Land P1 to P6, CI green

- Merge P1 to P5 into `dev`, then this PR (P6) last. CI must be green on the
  `dev` head that #54 will carry: `checks`, `supabase-drift`, `omr-service`
  and Vercel.
- Regenerate `scripts/apply-migrations.sql` with `npm run migrations:mirror`
  after each merge. Never hand-merge it.
- Update #54's body. The draft is in this PR's report. The current body still
  says 48 migrations and 15 functions.

### 2. Max's prerequisites (nothing technical is blocked on these, but launch is)

- **Legal.** Cleffy LLC formed, and counsel's final text published. Replace the
  placeholder blocks, drop `-draft` from `LEGAL_VERSIONS` and set
  `LEGAL_DOCUMENTS_ARE_DRAFTS = false` (PR #63). Settle the open items in
  `docs/LEGAL_REVIEW.md`. Register the DMCA designated agent and put its number
  in `/copyright`.
- **Tax registrations.** New York sales tax, EU OSS and UK VAT, as your
  accountant advises. Confirm the proposed product tax codes in
  `scripts/stripe/configure-tax.mjs`.
- **Stripe Tax**, sandbox first and then live. Dashboard → Tax: set the origin
  address, turn Stripe Tax on, and add the registrations above. Then run the
  catalogue script and read each dry run before you apply it:

    ```bash
    STRIPE_SECRET_KEY=sk_test_… node --experimental-strip-types scripts/stripe/configure-tax.mjs          # dry run
    STRIPE_SECRET_KEY=sk_test_… node --experimental-strip-types scripts/stripe/configure-tax.mjs --apply
    STRIPE_SECRET_KEY=sk_live_… node --experimental-strip-types scripts/stripe/configure-tax.mjs --live      # dry run
    STRIPE_SECRET_KEY=sk_live_… node --experimental-strip-types scripts/stripe/configure-tax.mjs --live --apply
    ```

    `stripe-checkout` sends `automatic_tax` and a `currency`. Stripe refuses the
    session until Stripe Tax is on and every price has a `tax_behavior` and
    EUR/GBP `currency_options`.

- **Customer portal, both modes** (§1). Switch plans on, with the six plan
  prices and without Founding. Under Cancellations, choose "Cancel at end of
  billing period" (that is what `/cancel` does too).
- **Stripe webhook events, both endpoints.** Subscribe `we_1U9V8T4eZ6RX0W0glk3BZIOi`
  (live) and `we_1U9fnx9EqxUjgZtnXnAvtJH3` (sandbox) to all nine events in
  _Stripe webhook events_ below. As of the status table they carry five.
- **Live subscriptions in the old production database.** Before the wipe, list
  every running live subscription (step 3). The wipe removes the account, but
  Stripe keeps billing the card. Cancel and refund each one, or tell the
  customer first.
- **DNS for cleffy.io mail.** Check SPF, DKIM and DMARC for the sending domains
  (`cleffy.io` for `noreply@`, and `send.cleffy.io` for support forwards). Look
  them up with `dig TXT`. In Resend, every domain must show **Verified**. Never
  call `POST /domains/{id}/verify` on a working domain (§7).
- **Resend plan quota.** Check it against the mail budget in
  `supabase/functions/_shared/mailBudget.ts`. `DEFAULT_MAIL_BUDGET` assumes
  100/hour and 500/day. Of that, `AUTH_MAIL_RESERVE` keeps 40/200 for GoTrue's
  resets and confirmations. `LAUNCH_MAIL_SPLIT` gives our own senders 60/hour
  and **300/day** in total. If the plan allows less than 500/day, set
  `MAIL_BUDGET_PER_HOUR` / `MAIL_BUDGET_PER_DAY` on production (step 4), so
  the caps shrink and the auth reserve stays whole.

### 3. Logical dump of production, then the wipe

**Max confirms in writing before anything in this step runs.** Everything below
the dump is irreversible. `pitr_enabled: false` means there is nothing finer
than last night's physical backup (_PITR_ below).

**What is lost from production.** Every row is lost: accounts, scores,
annotations, share links, subscriptions rows, `support_messages`, `stripe_events`.
Every Storage object is lost too. Some of it no migration recreates, so the dump
is the only production copy:

- `pd_pdf_store` (2,402 rows on 2026-10-12);
- `playalong_corpus_seed` (8,215), `playalong_corpus` (0) and
  `playalong_corpus_control` (1);
- their three functions, `playalong_corpus_get_by_hash()`,
  `playalong_corpus_put()` and `playalong_corpus_get_by_layout()`;
- the `pd-pdfs` bucket.

None of these is in any migration on `dev` (R2; PR #52 still open). A fresh
replay does not create them. Checked on the local stack at 47e9b38f:
`to_regclass` is null for all four tables. The `dev` branch project still holds
its own copy. The IMSLP works catalogue is **not** lost: the catalog-data
migrations reload it.

1. **Record what is there**, read-only, in production's SQL editor:

    ```sql
    select (select count(*) from auth.users) as users,
           (select count(*) from public.documents) as documents,
           (select count(*) from public.annotations) as annotations,
           (select count(*) from public.support_messages) as support_messages,
           (select count(*) from public.pd_pdf_store) as pd_pdf_store,
           (select count(*) from public.playalong_corpus_seed) as corpus_seed;
    select bucket_id, count(*), sum((metadata ->> 'size')::bigint) as bytes
    from storage.objects group by 1 order by 1;
    select user_id, mode, status, stripe_subscription_id, current_period_end
    from public.subscriptions
    where mode = 'live' and status in ('active', 'trialing', 'past_due');
    ```

    Every row of the last query is a live customer. Deal with each one (step 2)
    before you continue.

2. **Dump** with the CLI, linked to production. You need the database password,
   not the Management API.

    ```bash
    supabase link --project-ref jibgwgosihadbjgxdsfe
    supabase db dump --linked --role-only -f prod-20261022-roles.sql
    supabase db dump --linked -f prod-20261022-schema.sql
    supabase db dump --linked --data-only --use-copy -f prod-20261022-data.sql
    supabase db dump --linked --data-only --schema supabase_migrations -f prod-20261022-history.sql
    ```

    Then download every bucket from the counts above: `scores`, `thumbnails` and
    `pd-pdfs`, plus any other bucket the query lists. Use the Storage API with
    the service key, or the CLI's
    `supabase storage cp -r ss:///<bucket> ./<bucket> --experimental`.
    Check the file count against `storage.objects` for each bucket. The dump holds personal data, so store it encrypted and
    off any shared drive. It is also the only record of `support_messages`,
    which the Privacy Policy keeps for 24 months.

3. **Prove the dump restores** into a scratch local stack before you wipe
   anything. Run `npm run local:up`, then load the schema and then the data
   with `psql`, with `session_replication_role = replica`. Count the same
   tables as in 3.1. **`omr_jobs` (R3):** `id` is
   `generated always as identity`. The CLI's `COPY` dump carries the ids and the sequence position.
   A hand-written `insert … select` copy is refused unless it uses
   `overriding system value`, and then the sequence must be moved with R3's
   `setval`. Run that `setval` after any restore, then check
   `select max(id), (select last_value from public.omr_jobs_id_seq) from public.omr_jobs`.

4. **Empty Storage.** `db reset` does not touch Storage. For each bucket, use
   the Storage API, because `supabase storage rm` silently does nothing (see
   _Resetting a remote database — two traps_):

    ```bash
    curl -X DELETE "https://jibgwgosihadbjgxdsfe.supabase.co/storage/v1/object/<bucket>" \
      -H "Authorization: Bearer $SERVICE_KEY" -H 'Content-Type: application/json' \
      -d '{"prefixes":["<path>", "…"]}'
    ```

    Repeat until `select count(*) from storage.objects` is 0.

5. **Reset the database to `main`.** From a clean checkout of `origin/main` at
   the commit production runs:
    1. Drop the leftover sequences (trap 1 in _Resetting a remote database_).
    2. Run `supabase db reset --linked --no-seed`. Pass `--no-seed`: `seed.sql`
       creates the local test accounts.

    This replays `main`'s 26 migrations through the same path `db push` uses.
    So the history carries every body, and R1's NULL row is gone. The merge in
    step 6 applies the remaining 70.

    Then check:
    - `supabase_migrations.schema_migrations` lists exactly `main`'s 26
      versions;
    - `auth.users` is 0;
    - `storage.objects` is 0;
    - `select name from vault.secrets` (note which remain for step 8);
    - `select jobname from cron.job` shows only `main`'s `omr-sweep`.

    (The exact wipe mechanism comes from re-audit §8, which was not available
    when this was written. Confirm that §8 means a reset to `main`, and not an
    empty history replayed in full at the merge. The steps below hold either
    way.)

### 4. Production Edge secrets

`supabase secrets list --project-ref jibgwgosihadbjgxdsfe` shows names and
SHA-256 digests, never values. Secrets live outside the database, so the wipe
keeps them. Check every **required** one is present.

| Secret                                                 | Required?                                            | Used by                                                     |
| ------------------------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------- |
| `STRIPE_SECRET_KEY_LIVE`                               | **required**                                         | checkout, portal, webhook read-back, delete-account, cancel |
| `STRIPE_WEBHOOK_SECRET_LIVE`                           | **required**                                         | `stripe-webhook`                                            |
| `STRIPE_MODES` = `live`                                | **required**                                         | every Stripe function (_STRIPE_MODES_ below)                |
| `APP_URL` = `https://cleffy.io`                        | **required**                                         | checkout/portal return, billing mail links                  |
| `RESEND_API_KEY`                                       | **required**                                         | guest codes, billing mail, notices, `resend-inbound`        |
| `RESEND_WEBHOOK_SECRET`                                | **required** (inbound support is live, §7)           | `resend-inbound` (500 without it)                           |
| `SUPPORT_FORWARD_TO`                                   | **required** for forwarding (§7)                     | `resend-inbound`                                            |
| `IMSLP_SYNC_SECRET`                                    | **required**, equal to Vault `imslp_sync_secret`     | `imslp-sync`                                                |
| `BILLING_OUTBOX_SECRET`                                | **required**, equal to Vault `billing_outbox_secret` | `billing-mail-outbox`                                       |
| `CONTENT_NOTICE_SECRET`                                | **required**, equal to Vault `content_notice_secret` | `content-notices`                                           |
| `DISTRICT_NOTICE_SECRET`                               | when district retention starts                       | `district-retention-notices`                                |
| P3's inbound-retry secret (confirm after P3)           | (confirm after P3)                                   | (confirm after P3)                                          |
| `LOGIN_THROTTLE_SECRET`                                | optional, recommended (§9)                           | student sign-in limiter                                     |
| `GUEST_EMAIL_SECRET`, `GUEST_EMAIL_FROM`               | optional                                             | guest email codes                                           |
| `BILLING_EMAIL_FROM`, `BILLING_CANCEL_SECRET`          | optional                                             | billing mail, `/cancel` limiter                             |
| `CONTENT_NOTICE_FROM`, `CONTENT_REPORT_SECRET`         | optional                                             | content reports and notices                                 |
| `DISTRICT_NOTICE_FROM`                                 | optional                                             | district notices                                            |
| `SUPPORT_FORWARD_FROM`                                 | optional (default `support@send.cleffy.io`)          | `resend-inbound`                                            |
| `MAIL_BUDGET_PER_HOUR`, `MAIL_BUDGET_PER_DAY`          | optional, set if the Resend plan is smaller          | every sender we control                                     |
| `TURNSTILE_SECRET_KEY`                                 | optional (inert until the site key ships)            | guest email, content report                                 |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`   | optional (§2)                                        | edge error reports                                          |
| `IMSLP_DOWNLOAD_GLOBAL_MAX`, `…_SPACING_MS`            | optional tuning                                      | `imslp-download`                                            |
| `STRIPE_LIVE_ORIGINS`, `STRIPE_TEST_ORIGINS`           | optional; leave unset                                | origin → mode                                               |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (sandbox) | not used while `STRIPE_MODES=live`                   | —                                                           |
| `ANTHROPIC_API_KEY`, `ANALYZE_NOTES_MODEL`, `OMR_*`    | not for this launch (smart import, play-along off)   | AI and OMR functions                                        |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
provided by the platform.

(Re-audit §4 item 8 has the authoritative required/optional split. This table
is built from every `Deno.env.get` in `supabase/functions` at 47e9b38f.)

### 5. Auth settings — everything except the hook

Set these with a Management API token (`PATCH
https://api.supabase.com/v1/projects/jibgwgosihadbjgxdsfe/config/auth`). `GET`
the same path before and after. Leave **Before User Created OFF** until step 10.
An old bundle sends no `age_gate`, so with the hook on, every sign-up from that
bundle is refused.

```bash
curl -sS -X PATCH "https://api.supabase.com/v1/projects/jibgwgosihadbjgxdsfe/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "mailer_autoconfirm": false,
    "password_min_length": 8,
    "password_required_characters": "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
    "site_url": "https://cleffy.io",
    "uri_allow_list": "https://cleffy.io/**,https://www.cleffy.io/**",
    "disable_signup": true
  }'
```

- **Confirm email ON** (`mailer_autoconfirm: false`). The app already handles
  it: `RegisterPage` shows "check your email", and `/auth/callback` finishes it.
  See QA round 3's _Owner decision_ in the old checklist for why.
- **Password policy**: 8+ characters, letters and digits (§8).
- **Redirect URLs**: `https://cleffy.io/**` **and** `https://www.cleffy.io/**`.
  The wildcard covers `/auth/callback`, `/update-password` and
  `/student/welcome`. If the `GET` shows other entries, keep them. Check that
  anonymous sign-ins (`external_anonymous_users_enabled`) are still `true`:
  share-link guests need them.
- **Sign-ups closed** (`disable_signup: true`) until step 10. This closes the
  window between the merge and the hook, in which a sign-up would not be
  age-checked. It also blocks anonymous sign-ins (share-link guests). The
  admin API, and so `student-provision`, still works. (This setting is
  recommended here and is not taken from the re-audit. Confirm it; drop it if
  §8 keeps sign-ups open.)
- **SMTP.** The `GET` must show Resend's SMTP host, sender `noreply@cleffy.io`,
  and `rate_limit_email_sent` (100/hour on production) within the Resend plan.
  Send yourself a password reset from the dashboard (Authentication → Users →
  your user → Send password recovery). The test account can be made in step 9,
  so do this check after step 9 if no user exists yet.

### 6. Merge #54 outside lesson hours

Max merges `dev` → `main`. The Supabase GitHub integration applies the 70
pending migrations in filename order, then deploys all 23 functions. Vercel
builds the bundle in parallel. Wait for the Supabase check on the merge commit
to go green before you go on.

- Expect minutes: the two IMSLP catalog-data migrations are ~48 MB.
- **R4.** Migration `20260902120000` schedules `imslp-sync`, and later
  migrations redefine its tick. If Vault still holds `imslp_sync_url` /
  `imslp_sync_secret` after the reset (step 3.5), pause the job right after
  `20260902120000` commits and resume it after `20260910160001`. Use
  `select cron.alter_job(jobid, active := false) from cron.job where jobname = 'imslp-sync'`
  (then `active := true`). On the local stack, `postgres` cannot
  `update cron.job` directly: that is refused with `permission denied for table job`.
  Without those Vault secrets the tick only logs "missing — skip", and there
  is nothing to pause.
- If the function deploy fails, redeploy it before anything else (the old
  checklist's step 8 explains the bundle/function race).

### 7. Immediately after the merge

Run each check in production's SQL editor. Each must come back exactly as
stated.

1. **`STRIPE_MODES=live`.** Compare the digest from
   `supabase secrets list --project-ref jibgwgosihadbjgxdsfe` with
   `printf %s live | sha256sum`, which is
   `247610f4dedd4ab7247d07dbda19c81ca9817f85820742cad49d407ffae9e4ed`. The
   behavioural check is in _STRIPE_MODES_ below; it needs a signed-in user, so
   run it in step 11.
2. **The live-only config row (P1), then verify it.** A fresh replay leaves
   `entitling_billing_modes()` at the shipped `{live,test}`. That was checked
   on the local stack at 47e9b38f. It means test-mode subscriptions entitle on
   production, which is R1's landmine. P1 adds `deployment_config` so the
   narrowing lives in data, not in a hand edit.

    ```sql
    -- (confirm after P1: P1's exact insert / function call)
    insert into public.deployment_config (…) values (…);

    select public.entitling_billing_modes();
    -- must be {live}
    ```

3. **Grants.** Zero rows is a pass. It was run on the local stack at 47e9b38f,
   where it returned 0 rows. With
   `grant select on public.content_moderators to anon` and RLS turned off on `stripe_events` inside a rolled-back
   transaction, it reported exactly those two.

    ```sql
    with tables as (
        select c.oid, c.relname, c.relrowsecurity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
    ),
    server_only (t) as (values
        ('annotation_sync_floors'), ('billing_cancel_token_tombstones'), ('billing_cancel_tokens'),
        ('billing_mail_outbox'), ('billing_notices'), ('checkout_consents'), ('content_moderators'),
        ('content_notice_log'), ('content_notice_outbox'), ('content_reports'), ('content_strikes'),
        ('content_takedowns'), ('district_billing'), ('district_billing_log'), ('district_retention'),
        ('district_retention_log'), ('district_retention_notices'), ('district_retention_students'),
        ('district_student_evidence'), ('document_member_role_locks'), ('document_realtime_epochs'),
        ('edge_login_attempts'), ('edge_rate_buckets'), ('guest_email_verifications'), ('imslp_works'),
        ('imslp_works_building'), ('managed_students'), ('pdf_export_claims'), ('seat_read_only_since'),
        ('share_link_redemptions'), ('stripe_events'), ('studio_seat_override_log'),
        ('studio_seat_overrides'), ('studio_seat_tenures'), ('support_messages')
    ),
    client_read (t) as (values
        ('documents'), ('annotations'), ('document_members'), ('share_links'), ('subscriptions'),
        ('billing_customers'), ('studios'), ('studio_members'), ('assignments'), ('practice_notes'),
        ('usage_counters'), ('teacher_attestations')
    )
    select relname as object, 'RLS is off' as problem from tables where not relrowsecurity
    union all
    select relname, 'service_role cannot select' from tables
    where not has_table_privilege('service_role', oid, 'select')
    union all
    select s.t, r || ' has ' || p from server_only s
    cross join unnest(array['anon', 'authenticated']) r
    cross join unnest(array['select', 'insert', 'update', 'delete']) p
    where has_table_privilege(r, ('public.' || s.t)::regclass, p)
    union all
    select t, 'authenticated cannot select' from client_read
    where not has_table_privilege('authenticated', ('public.' || t)::regclass, 'select')
    order by 1, 2;
    ```

    `server_only` is every public table that a migration explicitly revokes
    from `anon` / `authenticated`. Add any table P1 to P5 create the same way
    (confirm after P1 to P5). An "undefined table" error means a listed table
    is missing, which is itself a failure.

4. **`cron.job`.** Zero rows is a pass. Ten jobs are expected, all active, and
   `retention-district` must be **absent**: it is scheduled only by hand, after
   the note below. Checked on the local stack: 0 rows. With
   `retention-district` scheduled and `imslp-sync` paused inside a rolled-back
   transaction, it reported both.

    ```sql
    with expected (jobname) as (values
        ('billing-mail-outbox'), ('content-notice-retry'), ('district-seat-reconcile'), ('imslp-sync'),
        ('omr-sweep'), ('retention-archived-students'), ('retention-compact-tombstones'),
        ('retention-rate-limits'), ('retention-stale-guests'), ('retention-support-messages')
        -- (confirm after P3: add P3's inbound retry job)
    )
    select coalesce(e.jobname, j.jobname) as jobname,
           case when j.jobname is null then 'missing'
                when e.jobname is null then 'not expected'
                else 'inactive' end as problem
    from expected e
    full join cron.job j on j.jobname = e.jobname
    where j.jobname is null or e.jobname is null or not j.active;
    ```

    `retention-archived-students` and `retention-stale-guests` delete for good
    at 03:17 and 03:27 UTC. On an empty database there is nothing for them to
    take.

5. **Functions and `verify_jwt`.** All 23 must be `ACTIVE`, with `verify_jwt`
   as declared in `supabase/config.toml`.

    ```bash
    curl -sS "https://api.supabase.com/v1/projects/jibgwgosihadbjgxdsfe/functions" \
      -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
      | jq -r '.[] | "\(.slug) \(.verify_jwt) \(.status)"' | sort
    ```

    `verify_jwt = false` (10): `billing-cancel`, `billing-mail-outbox`,
    `content-notices`, `content-report`, `district-retention-notices`,
    `imslp-sync`, `resend-inbound`, `stripe-webhook`, `student-claim`,
    `student-login`. `verify_jwt = true` (13): `analyze-annotations`,
    `analyze-notes`, `content-moderation`, `delete-account`,
    `guest-email-confirm`, `guest-email-start`, `imslp-download`,
    `imslp-search`, `imslp-work`, `score-analyze`, `stripe-checkout`,
    `stripe-portal`, `student-provision`. A `false` function that shows `true`
    refuses its caller: Stripe, Resend, pg_cron or a signed-out visitor. A
    `true` function that shows `false` is open to anyone. As a quick probe, an
    unsigned POST to `stripe-webhook` must answer
    `400 {"code":"missing_header"}` (§2).

6. `list_migrations` (or `schema_migrations`) ends at the newest file in
   `supabase/migrations/`. Run the security advisor: only `peek_share_link` is
   anon-executable on purpose (old checklist, step 11).

### 8. Vault secrets

These go in production's SQL editor. Each `…_secret` must equal the matching
Edge secret from step 4. If the reset left a name in place (step 3.5), update it
with `select vault.update_secret(id, '<value>') from vault.secrets where name = '<name>'`.
Do not create it a second time.

```sql
select vault.create_secret('https://jibgwgosihadbjgxdsfe.supabase.co/functions/v1/imslp-sync', 'imslp_sync_url');
select vault.create_secret('<same value as IMSLP_SYNC_SECRET>', 'imslp_sync_secret');
select vault.create_secret('https://jibgwgosihadbjgxdsfe.supabase.co/functions/v1/billing-mail-outbox', 'billing_outbox_url');
select vault.create_secret('<same value as BILLING_OUTBOX_SECRET>', 'billing_outbox_secret');
select vault.create_secret('https://jibgwgosihadbjgxdsfe.supabase.co/functions/v1/content-notices', 'content_notice_url');
select vault.create_secret('<same value as CONTENT_NOTICE_SECRET>', 'content_notice_secret');
select vault.create_secret('https://jibgwgosihadbjgxdsfe.supabase.co/functions/v1/district-retention-notices', 'district_notice_url');
select vault.create_secret('<same value as DISTRICT_NOTICE_SECRET>', 'district_notice_secret');
-- (confirm after P3: P3's inbound retry URL and secret names)
```

`omr_service_url` / `omr_service_secret` are not needed, because play-along is
off for this launch. Without them `omr-sweep` skips its poke and only purges the
cache.

Check the names with `select name from vault.secrets order by 1`.

Within two minutes, `imslp-sync` should start walking categories:
`select category, state from imslp_category_sync order by updated_at desc limit 5`.

### 9. `content_moderators` row for Max

Max needs an auth user first. Sign-ups are closed, so create the account in the
dashboard (Authentication → Users → Add user, with Auto Confirm). The hook is
still off, so no `age_gate` is needed. Then:

```sql
insert into public.content_moderators (user_id, note)
select id, 'Max' from auth.users where email = '<max's address>';
```

Check it: as Max, `/admin/reports` opens (it calls `is_content_moderator`).

### 10. Before User Created hook ON, then one sign-up and one share-link join

1. Dashboard → Authentication → Hooks → **Before User Created** → Postgres →
   `public.hook_before_user_created`. Do this only once the new bundle is live
   on cleffy.io: `/register` must ask for country and birth month and year
   first.
2. Open sign-ups (`"disable_signup": false`, same PATCH as step 5). From now
   on the hook age-checks every sign-up and every share-link guest.
   `student-provision` checks the teacher's attestation itself (PR #64).
3. Sign up as a throwaway teacher on cleffy.io. Confirm the email from the
   inbox; it arrives from `noreply@cleffy.io`. The account's `user_metadata`
   carries `age_gate`.
4. Join a score by share link in a private window, as a guest. The age screen
   comes first, then the name. Under-age answers are refused with no account
   created: `auth.users` does not grow.
5. If you are not ready to open, close sign-ups again (`disable_signup: true`)
   until step 12.

### 11. Smoke tests

These cover re-audit T-3 to T-7 and T-11 (confirm the mapping against the
re-audit). Use throwaway accounts only, and run this smoke plus the old
checklist's steps 12 and 13 where they still apply.

- **CSP and headers.** `npm run build && node scripts/csp-smoke.mjs` gives
  zero violations. cleffy.io with the console open shows no CSP errors.
- **Sharing and sync.** Share a score, change a member's role live, revoke a
  link with removal, then leave. Draw offline and come back online.
- **Roster.** Add a code student with the attestation, sign in as them, then
  archive them: the open score signs them out. Then use Delete student.
- **Export and IMSLP.** On a free account, export a PDF twice: the second is
  refused. Import from IMSLP and open its Source dialog.
- **Moderation.** Report a throwaway score at `/report` signed out. The
  acknowledgment arrives with a `CR-…` reference. Take it down from
  `/admin/reports`, then lift it.
- **`STRIPE_MODES` behaviour** (_STRIPE_MODES_ below). With a teacher's JWT,
  `stripe-checkout` with `Origin: https://dev.cleffy.io` answers
  `400 unknown_origin`.
- **One real low-price purchase.** Use Personal monthly ($7, or €8 / £7 VAT
  included) with a real card on cleffy.io.
    - Checkout shows no test-mode banner, and tax is shown.
    - The webhook writes `subscriptions` with `mode = 'live'`, and a
      `checkout_consents` row exists.
    - The confirmation email arrives with the model withdrawal form.
    - The Account page shows Personal.
    - Then **refund and cancel** it, exactly as in _Refunds_ below. The
      account goes back to free, and the cancellation email arrives.
    - Also try `/cancel` signed out with that address: the link mail arrives,
      and it reports nothing left to cancel.
- **Delete the throwaway accounts** from the Account page (`delete-account`,
  which needs the live key). Each is gone from Auth and from both buckets, and
  its Stripe subscriptions are cancelled. Its `checkout_consents` rows stay with
  `user_id` null, because they are kept 3 years (PR #62). Delete the guest from
  the join page ("Delete my guest profile").

### 12. Open sign-ups, then watch for 48 hours

- Set `"disable_signup": false` if you closed it again in step 10.
- Then watch:
    - function logs, for 5xx on `stripe-webhook`, `guest-email-start` and
      `student-login`;
    - Stripe → Webhooks, for failed deliveries;
    - Resend, for bounces and the daily count against the plan;
    - the `cron.job_run_details` failures;
    - Realtime usage (§10);
    - `select count(*) from auth.users` against the sign-ups you expect.

### Before scheduling `retention-district`

It stays unscheduled at launch. Schedule it only when all of these hold:

1. **P5 is merged** and deployed (confirm after P5: P5's change to the district
   purge).
2. `district-retention-notices` is deployed with `DISTRICT_NOTICE_SECRET`, and
   the Vault pair `district_notice_url` / `district_notice_secret` exists
   (step 8).
3. **The dry-run counts are read and expected**:
   `select public.retention_district_dry_run();` on production. On a fresh
   production it is empty until a district has a `contract_ends_at`.
4. **The hourly notice-sender cron** from decision 11 is scheduled (confirm
   after P5: its job name and schedule). Without it, a notice deferred by the
   mail budget (`20261021120900`) waits for the next daily purge run, and
   nothing is purged before its notice is sent.

Then schedule it:
`select cron.schedule('retention-district', '57 3 * * *', $$select public.retention_district_run()$$);`
After that, add `retention-district` to the expected list in step 7.4.

### Stripe webhook events

`stripe-webhook` handles nine event types
(`dispatchStripeEvent` in `supabase/functions/_shared/stripeEvents.ts`).
**Subscribe both endpoints to all nine**, the live one
(`we_1U9V8T4eZ6RX0W0glk3BZIOi`, production) and the sandbox one
(`we_1U9fnx9EqxUjgZtnXnAvtJH3`, `dev` branch):

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.subscription.paused`
- `customer.subscription.resumed`
- `invoice.paid`
- `invoice.payment_succeeded`
- `invoice.payment_failed`

Each missing event has a cost:

- Without `paused` / `resumed`, a paused subscription keeps entitling.
- Without `invoice.paid` / `invoice.payment_succeeded`, a renewal leaves the
  old period end in place. The teacher then drops to free limits until some
  other event arrives (QA round 4, D6).

Anything else is acknowledged and ignored. There is **no `charge.refunded`
handler**, so a refund changes nothing in Cleffy (_Refunds_).

### Refunds — a manual step

The Refund Policy (`/refunds`, `src/features/legal/refundPolicy.ts`) promises a
full refund on request within 14 days of the first purchase of a paid plan.
After the refund, the subscription is cancelled and the account returns to free.
Requests arrive at support@. The `/cancel` page's "request my 14-day refund"
emails support@ with Reply-To set to the buyer.

Nothing in Cleffy reacts to a refund, because no `charge.refunded` handler
exists. A refund alone leaves the subscription **active, entitled and renewing**.
So every refund is two Stripe actions plus a log line:

1. **Check eligibility.** It must be the customer's first paid subscription,
   and the request must come within 14 days of it. Check the subscription's
   `created` date in Stripe, or `checkout_consents.created_at` for the user.
   Counsel still has to settle a re-subscription, a plan change within the 14
   days, and Academy (placeholder in the policy).
2. **Refund the full amount**, tax included. Stripe → Payments → the charge →
   Refund → full amount.
3. **Cancel the subscription immediately**, not at period end. Stripe →
   Subscriptions → Cancel → Immediately. Stripe's cancel dialog can also refund
   the last payment. Either order works, as long as both are done.
   `customer.subscription.deleted` then sets the row `canceled`, and the
   account drops to free limits. Its scores past those limits become read-only;
   nothing is deleted.
4. **Verify.** In Stripe the charge shows Refunded and the subscription shows
   Canceled. In the database:
   `select status from public.subscriptions where stripe_subscription_id = '<sub_…>'`
   returns `canceled`.
5. **Log it.** Write a line in the refunds log:
    - date;
    - customer email;
    - the Stripe customer, charge and subscription ids;
    - amount and currency, tax included;
    - the request date;
    - "within 14 days: yes";
    - who did it.

    Keep the log where the support records are kept (confirm where with Max).

6. Reply to the customer, within 14 days of the request.

### PITR

`GET /v1/projects/jibgwgosihadbjgxdsfe/database/backups` reported
`walg_enabled: true` and **`pitr_enabled: false`** as of 2026-10-12. That means
seven daily physical backups and nothing finer (_Recovery and disaster
recovery_). Whether to buy PITR (a paid add-on on the Pro plan) is **Max's
decision before launch**.

**Until PITR is on, take a logical dump before every release** that runs
migrations against production. Use the commands in step 3.2, and keep it until
the next release is known good. Restore it with **R3**'s `omr_jobs` note:
`id` is `generated always as identity`. A copy written as `insert … select`
needs `overriding system value` and then the `setval`. The CLI's `COPY` dump
carries both, but run the `setval` check after any restore anyway.

### STRIPE_MODES

**What it does.** `servedModes()` in `supabase/functions/_shared/stripeMode.ts`
reads `STRIPE_MODES` and returns which Stripe accounts this backend will serve.
`live`, `test` or `live,test`; unset means both.

- Checkout, the portal and `/cancel` first map the request's Origin to a mode
  (§0). A mode the backend does not serve is answered `400 unknown_origin`.
  Production therefore never writes a test-mode row.
- `stripe-webhook` (`supabase/functions/stripe-webhook/index.ts`, the
  `servedModes()` loop before signature verification) tries only the served
  modes' signing secrets. A sandbox event that reaches production verifies
  against nothing and is refused. With no served secret set, it answers
  `500 Server misconfigured`.
- It is the backstop for a wrong build or a wrong DNS entry (§0, §5).
  `entitling_billing_modes()` (P1's config row) is the database-side half.

**Value per project.**

| Project                                 | `STRIPE_MODES` |
| --------------------------------------- | -------------- |
| production `jibgwgosihadbjgxdsfe`       | `live`         |
| `dev` branch `qdbnlrgylelelvwbkvnm`     | `test`         |
| local stack (`supabase/functions/.env`) | unset (both)   |

**How to verify.**

1. **Digest.** `supabase secrets list --project-ref <ref>` shows the SHA-256 of
   each value. Compare it with `printf %s live | sha256sum` (`247610f4…e9e4ed`)
   or `printf %s test | sha256sum` (`9f86d081…f00a08`).
2. **Behaviour.** With a signed-in teacher's JWT, POST to production's
   `stripe-checkout` with `Origin: https://dev.cleffy.io`. It must answer
   `400 {"code":"unknown_origin"}`. The same request with
   `Origin: https://cleffy.io` returns a live `checkout.stripe.com` URL (§0,
   _Verifying_). Mirror both on the `dev` branch: there, `https://cleffy.io` is
   refused.
3. **Database.** `select public.entitling_billing_modes();` returns `{live}`
   on production (step 7.2).

---

## Release checklist — launch fixes (20261007\*)

> **Superseded for the fresh-production path.** The 2026-10 go-live wipes
> production and replays every migration (_Go-live 2026-10: fresh production_,
> above). This checklist assumed pending migrations pushed onto production's
> existing data. Its reference detail still holds, and the go-live links to
> it: the per-migration order constraints, the QA-round smoke steps, and the
> bundle/function race at the merge. Its data-preserving steps do not apply:
> step 1's history repairs and the rehearsal against production's data.

One ordered list for the integrated `fix/*` branches (integrity, sharing, sync,
billing, library, security, compliance, scope-imslp), the pre-launch QA
round on top of them (`qa/sync`, `qa/billing`, `qa/sharing`, `qa/polish`,
integrated on `qa-integrate`) and QA round 3 (`qa3/sync`, `qa3/realtime`,
`qa3/shell-auth`, `qa3/roster-data`, `qa3/perf`, `qa3/imslp`, integrated on
`qa3-integrate`) shipping on one `dev` → `main` merge. Steps are in the order
to do them; each says what breaks if it is skipped or reordered. Reference
detail stays in the sections it links to.

**What ships.** Twenty migrations, applied in filename order by the Supabase
GitHub integration on the merge (migrations before functions):

| Migration                                                | Branch           | Order constraint                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `20261007120000_sharing_access_control`                  | sharing          | Before the bundle: the new Share dialog, member roles, revoke-with-removal and Leave call its RPCs. Old bundles are unaffected (links still default to the role they send).                                                                                                                                                                            |
| `20261007120100_column_integrity`                        | integrity        | Any order. Holds only for client roles; service role, definer functions and FK actions pass.                                                                                                                                                                                                                                                           |
| `20261007120101_realtime_db_topic`                       | integrity        | Either order is safe but not seamless — step 9.                                                                                                                                                                                                                                                                                                        |
| `20261007120200_patch_annotations_batch_returns_ids`     | sync             | Any order: the client treats the old void answer as "applied".                                                                                                                                                                                                                                                                                         |
| `20261007120300_billing_correctness`                     | billing          | Any order: the export claim falls back to `consume_pdf_export` until it exists. Backfills `archived_reason` (production holds 0 archived scores) and restores already-entitled owners.                                                                                                                                                                 |
| `20261007120400_library_pagination`                      | library          | Before the bundle for search / tag / A–Z paging; without it only the plain recent list pages (REST fallback).                                                                                                                                                                                                                                          |
| `20261007120401_document_storage_cleanup`                | library          | **Before the bundle**: the new delete removes the row first and purges Storage through these tombstone policies; without them the purge is refused and the bytes are orphaned.                                                                                                                                                                         |
| `20261007120500_function_search_path_and_execute_grants` | security         | Any order. Restates `guard_score_analyses_client_write` with the 120100 body (role-keyed) — do not "restore" the 20260803 body, it breaks account deletion.                                                                                                                                                                                            |
| `20261007120501_student_login_throttle`                  | security         | **Before** `student-login` / `student-claim` / `student-provision`: the limiter fails closed (§9).                                                                                                                                                                                                                                                     |
| `20261007120600_account_deletion`                        | compliance       | **Before** `delete-account`, with the updated `stripe-webhook` (§2, _Account deletion_).                                                                                                                                                                                                                                                               |
| `20261007120700_document_provenance`                     | scope-imslp      | **Before** `imslp-download` / `imslp-work`: imports fail at the provenance write without it (and are refunded).                                                                                                                                                                                                                                        |
| `20261009120100_pdf_export_claim_ids`                    | qa/billing       | Any order: without it the client repeats the claim without its id (PGRST202 fallback), so a lost answer or a dismissed share sheet can count an export twice, as before.                                                                                                                                                                               |
| `20261009120101_entitlements_cancel_at_period_end`       | qa/billing       | Any order: a missing `cancel_at_period_end` reads as false ("Renews" for a cancelled plan, as before).                                                                                                                                                                                                                                                 |
| `20261009120200_share_link_errors_and_peek`              | qa/sharing       | Any order: the client still reads the old P0002 refusal; without `peek_share_link` it carries on as before (redeem refuses a dead link, but leaves an orphan guest).                                                                                                                                                                                   |
| `20261010120200_guest_email_verification`                | qa3/shell-auth   | **Before** `guest-email-start` / `guest-email-confirm` (start answers `503 email_unavailable` without it), and they before the bundle. Until it is applied a guest can attach any address through `PUT /auth/v1/user` (QA round 3 below).                                                                                                              |
| `20261010120300_student_access_revocation`               | qa3/roster-data  | **Before** `student-provision`: a reset calls its `end_student_sessions()` and, without it, fails with a 502 after scrambling the password. Before the bundle too, or a student's refused change is retried, not rolled back. Old bundles are unaffected.                                                                                              |
| `20261010120301_annotation_payload_shape`                | qa3/roster-data  | **With the bundle**: the new client keeps text notes and imported marks inside the checked bounds; an old bundle's over-long note or far-off-page imported mark is refused (`23514`) and rolled back to server truth. VALIDATE fails the migration if a stored row breaks the rules (production's and dev's rows were checked read-only and all pass). |
| `20261010120302_library_hides_revoked_student_scores`    | qa3/roster-data  | After `20261010120300` (it calls `student_access_revoked()`); any order against the bundle.                                                                                                                                                                                                                                                            |
| `20261011120100_archived_student_password_check`         | qa4/roster-shell | Any order: until it is in, `student-login`'s call to `archived_student_password_matches()` fails, which it reads as "no", so an archived student gets the generic refusal as before.                                                                                                                                                                   |
| `20261011120101_refund_edge_rate_limit`                  | qa4/roster-shell | Any order: until it is in, `guest-email-start`'s refund fails (logged) and an unsent code keeps its mailbox and project counts, as before.                                                                                                                                                                                                             |

Functions changed: `delete-account`, `guest-email-start` and
`guest-email-confirm` (new), `imslp-download`, `imslp-work`, `imslp-sync`,
`imslp-search`, `stripe-webhook`, `stripe-checkout`, `stripe-portal`,
`student-login`, `student-claim`, `student-provision`, `resend-inbound`,
`analyze-annotations`, and `_shared/` (so redeploy every function that imports
it — the merge deploys all of them).

**QA round (20261009\*).** What each function change needs:

- `stripe-checkout` refuses a second subscription in the same mode
  (`409 already_subscribed`); plan changes then go through the Customer portal
  only. Check Switch plans in **both** modes' portal first (§1, _Checkout
  depends on it_; step 2) — the sandbox one has never been verified.
- `stripe-webhook` / `stripe-checkout` (`_shared/stripeEvents.ts`): a
  `cancel_at` inside the period now reads as cancelling. Rows already scheduled
  that way pick it up on their next subscription event.
- `delete-account` (`_shared/accountDeletion.ts`) now deletes share-link
  guests (no password, no Stripe call) instead of refusing them with
  `403 anonymous_session`. The new bundle's "Delete my guest profile" and the
  join page's dead-link cleanup need it; until it is deployed they get that
  403 and delete nothing.
- `imslp-search` (`_shared/search.ts`, `searchFacetData.ts`, `popularWorks.ts`)
  and `imslp-sync` (`_shared/categorySync.ts`): ranking and the Piano chip's
  keyboard categories — step 16.
- The bundle also emits a same-origin `/supabase-preconnect.js` (CSP
  `script-src 'self'`); it is in `dist/` and needs nothing else.

**QA round 3 — shell and auth (`qa3/shell-auth`, 20261010120200).**

- **Guest "add your email" is now verified** (two new functions,
  `guest-email-start` and `guest-email-confirm`, declared in `config.toml`
  with `verify_jwt = true`, plus migration
  `20261010120200_guest_email_verification`). The banner used to call
  `updateUser` with the address from the browser, and with
  `mailer_autoconfirm` on (both projects) GoTrue confirmed it on the spot with
  no mail sent: a guest could attach anybody's address, the real owner then
  got "an account with this email already exists", and a reset to that
  address would hand over the guest's account. Now `guest-email-start` mails
  a six-digit code (Resend, 15 minutes, HMAC'd at rest) and
  `guest-email-confirm` checks it — 5 tries — before attaching the email
  (confirmed) and a password with the admin API, which keeps the guest's user
  id. That admin call also deletes all the user's sessions, the guest's
  own included (GoTrue logs a user out everywhere when an admin sets the
  password), so the banner then signs in with the new email and password —
  a fresh, registered session for the same id — and says "Saved" only once
  that works; if it does not, it says the email is saved and links to sign
  in. An address that already has an account is answered "sign in instead",
  nothing more (asked again at confirm, for an address registered in the
  meantime). Limits (edge_rate_buckets): start 5/h per guest, 20/h per IP,
  per recipient mailbox 3/h and 10/day (an address's `+tag` counts as the
  same mailbox), and for the whole project 60/h and 300/day, all spent only
  when a code is actually mailed (reserved just before the send and refunded
  through `refund_edge_rate_limit`, migration `20261011120101`, when the code
  could not be stored or the mail failed or is not configured — so a Resend
  outage or a deploy without `RESEND_API_KEY` uses none of them up; the
  per-guest and per-IP attempt limits stay spent); confirm 10 per 15 min per
  guest, 30 per IP.
  The project ceiling exists because the other limits move with things an
  attacker rotates for free (IPs, anonymous sign-ins, addresses) while every
  code goes out on the Resend key and domain that carry password resets and
  sign-ups: **check it against the Resend plan's daily quota** (past it, start
  answers `503 email_unavailable` to everyone until the window moves on, and
  `guest-email-start:global…` is logged). An address is checked against the
  rule GoTrue itself applies at the attach (badoux/checkmail: ASCII local
  part, letter-digit-hyphen labels, plus a dot in the domain) before anything
  is mailed, so `Name <a@b.com>`, quoted or trailing-dot forms and non-ASCII
  addresses are refused up front instead of mailed a code that can never
  attach; confirm withdraws the code if GoTrue still refuses one
  (`validation_failed` → `422 invalid_email`). Flow and reasons:
  `supabase/functions/_shared/guestEmail.ts`.
- **The old path is closed on the server, not just in the app.** Removing the
  `updateUser({ email })` call from the banner does not stop a guest making
  it: GoTrue's `PUT /auth/v1/user` takes it from anyone with their own guest
  JWT and the public anon key, and with `mailer_autoconfirm` on it confirms
  an anonymous user's new address in the same request, mailing nobody
  (GoTrue `api/user.go`, "anonymous users can add an email with automatic
  confirmation"). The same migration adds `guard_guest_email`, a BEFORE
  UPDATE trigger on `auth.users`: a guest's row cannot leave anonymity, nor
  gain or change its email, unless `guest-email-confirm` checked a code for
  exactly that address in the last 10 minutes. GoTrue gets a 500 and rolls
  the whole update back. **Until this migration is applied, that endpoint is
  open on any project with "Confirm email" off** (both, today) — the app
  change alone does not close B4. Side effects: an anonymous user can no
  longer be upgraded any other way (dashboard edits of a guest's email
  included; ask the guest to use the banner), and nothing else is touched —
  registered accounts, soft deletes and the `student-*` functions never
  update a guest row.
    - **Order:** the migration **before** the functions (without it start
      answers `503 email_unavailable`), the functions **before** the bundle
      (the new banner gets a 404 from a missing function). Once the
      migration is in, an old bundle's banner still calls `updateUser` and
      now gets an error from the trigger — so ship the functions and the
      bundle right after it; do not hold either back.
    - **Secrets, on both projects** (they do not inherit, §5):
      `RESEND_API_KEY` (production has it for `resend-inbound`; **the `dev`
      branch needs it too**, or the banner says email is unavailable there).
      Optional: `GUEST_EMAIL_FROM` (default `Cleffy <noreply@cleffy.io>`, the
      sender auth mail already uses — it must be on a Resend-verified domain,
      §7), `GUEST_EMAIL_SECRET` (HMAC key for the codes; unset falls back to
      the service-role key, like `LOGIN_THROTTLE_SECRET`).
    - **Smoke:** join a score by link as a guest, "Add your email to keep
      it" with a throwaway address you can read: the code arrives from
      `noreply@cleffy.io`; a wrong code is refused; the right one says
      "Saved"; reload, and the banner is gone and a checkout from the
      pricing dialog reaches Stripe (`stripe-checkout` checks the session:
      on the old guest one it would answer `session_not_found`); the
      address signs in with the password
      on another browser and sees the score. Repeat with an address that has
      an account: "sign in instead", no mail sent. Then the closed door: as
      a fresh guest, call `supabase.auth.updateUser({ email: '<another
throwaway>' })` from the console — it must fail (500), and the guest
      must still be anonymous with no email. Finally the race: send a code
      to a throwaway address, register that address in another browser,
      then enter the code — "sign in instead", not "couldn't save" (GoTrue's
      admin update has no duplicate check of its own; confirm asks again).
    - Accounts already upgraded the old way keep working; they have an
      email and may have no password (the reset flow sets one).
- **Owner decision, recommended (not changed here): turn on "Confirm email"**
  on both projects (Authentication → Sign In / Providers → Email;
  `mailer_autoconfirm: false` via the Management API). It is not only sign-up
  hygiene. With it off, (1) sign-up has the same hole the guest banner had —
  anyone can register an address they do not own and block its owner — and
  (2) GoTrue confirms a guest's `PUT /auth/v1/user` email change instantly;
  only the `guard_guest_email` trigger above stands between that and B4. With
  it on, GoTrue mails a confirmation to the new address instead, so the
  direct endpoint needs the mailbox too (a second, independent lock; the
  trigger still refuses the confirmation link for a guest, since the app's
  only upgrade path is the code). The app already handles sign-up
  confirmation (`RegisterPage` shows "check your email", `/auth/callback`
  finishes it); what changes is that every new teacher must click a link
  before using the account, and sign-up then depends on the Resend domain
  staying verified (§7).
- Front-end only, nothing to deploy beyond the bundle: a tab left open across
  a deploy now reloads once when it asks for a chunk that no longer exists
  (`src/lib/staleChunk.ts`; it used to go blank), and the crash screen no
  longer needs the router; an expired or used reset link explains itself
  instead of landing silently on the sign-in page; browser zoom works
  everywhere except over the score viewer (WCAG 1.4.4); "Two months free"
  meets AA contrast.

**QA round 3 — roster, sync, realtime, perf, IMSLP (`qa3/*`, 20261010120300–302).**

- **Archiving or resetting a student ends their open sessions** (roster-data:
  `20261010120300`, `20261010120302`, `student-provision` with
  `_shared/studentSessions.ts`). `document_role()` — so every policy, storage
  rule and realtime topic check built on it — and the library RPCs refuse a
  roster student whose row is archived, or whose access token was issued
  (`iat`) before `managed_students.access_revoked_at`.
  `end_student_sessions()` (service role only) stamps that column, deletes
  the student's sessions and refresh tokens (so nothing can mint a newer
  token) and sends the membership hint; `student-provision` calls it on
  reset (a failure stops the reset) and on archive (a failure is logged, the
  archive stands). **Only the teacher's action revokes.** A first version
  refused any student token whose session row was gone, and GoTrue deletes
  every session of an account on a global sign-out (supabase-js's default,
  which the app uses) and on any admin password change: a student signing
  out on a school iPad would have had their phone's marks refused and rolled
  back. Now the student's own sign-out elsewhere leaves their other devices
  working until those tokens expire, as before this release
  (`tests/sql/student_access_revocation.sql` proves both). The migration
  owner must be able to delete from `auth.sessions` /
  `auth.refresh_tokens`, which hosted Supabase allows. Known limit: a
  realtime channel the student had already joined stays authorized until
  the socket's token expires (Realtime authorizes at join); the hint makes
  the app leave the score, so only a tampered client keeps receiving
  broadcasts. Nothing changes for accounts that are not roster students —
  including a guest whose sessions `guest-email-confirm` just ended
  (`tests/sql/qa3_cross_branch.sql`).
- **A student signed out by their teacher keeps their unsynced marks** (client).
  When the server says the sign-in was ended (an archive or a reset), the
  student app signs out locally and keeps the device's queued changes and
  mirror, every op stamped with the student's account, instead of the usual
  sign-out's clear: no other account on the device sends or draws them, and
  they upload when the same student signs in there again (after a reset with
  the new code; after an archive once restored). The sign-in page says how
  many were kept. The sync engine likewise holds, rather than rolls back, a
  change refused under an ended sign-in, and the open viewer signs out the
  same way instead of purging the score. Only a student whose account is gone
  altogether (deleted with their teacher) is cleared as before. This makes
  the roster's "annotations … all stay" true for marks still on the device.
- **The server checks mark payloads and colours** (`20261010120301`): CHECK
  constraints `annotations_payload_shape` and `annotations_color_hex` on every
  write path (plain writes and both batch RPCs). Ship it with the bundle (table
  above).
- **Offline changes belong to the account that queued them** (sync, client
  only). Production never recorded who queued an offline change or which
  account cached a score, so for changes still queued on a device when this
  ships, the first account to open that score online is treated as their
  author and uploads them under its name — right on a single-user device,
  possibly wrong on a shared one, and nothing on the device can tell. From
  this build on every change records its account, and a score's cache
  changing hands no longer passes old changes to the next account.
- **Realtime** (client only): channels the server closes are re-joined with
  backoff, the 15 s pull keeps running meanwhile, and the client slows live
  ink and presence on rate-limit notices — §10, which also recommends moving
  the org to **Pro before launch**.
- **First opens stream** (perf, client only): page 1 of a score not yet on the
  device renders while the PDF downloads from a signed Storage URL, and the
  finished file becomes the offline copy. It needs Storage to answer a signed
  URL with a readable `Content-Length` and Range with `206` — checked in step
  2; without them the open waits for the whole file as before, and the
  console says so. Pen-up no longer repaints every mark on the page. An export
  started while a first open is still streaming downloads the file itself
  (it is not in the cache yet) and now stores the viewer's role with it, and
  a stream that finishes after such an export fills in a missing role rather
  than skipping the row: before, closing the viewer then left an offline copy
  that opened view-only. (The export still downloads the file a second time
  meanwhile; waiting for the stream instead is a follow-up.)
- **IMSLP display** (imslp): search snippets decode doubly escaped entities,
  and `{{Flat}}` / `{{Sharp}}` / `{{Natural}}` render as ♭ ♯ ♮ in snippets and
  edition part names. The code is in `_shared/search.ts` and
  `_shared/imslpFileBlocks.ts`, so it reaches users only once `imslp-search`,
  `imslp-work` and `imslp-download` are redeployed (the merge deploys every
  function). Scores imported earlier keep the provenance text stored then.

**QA round 4 — roster and shell (`qa4/roster-shell`, 20261011120100–101).**

- **A student deleted with their teacher is told the truth** (client). The
  viewer used to keep such a student's queued changes and promise they
  "are saved when you sign in here again" — an account that can never sign in
  again. It now asks the server first (`fetchAccountDeleted`: the token is
  refused as a student's _and_ no roster row answers it; anything unanswered
  counts as "not deleted", which keeps the changes), as /assignments already
  did from its roster read. A deleted account's own queued changes are
  discarded and the sign-in page says so; another account's kept changes on
  the same device stay for that account. Exporting them is not offered: the
  scores they were drawn on were deleted with the account.
- **An archived student who signs in is told they were archived** (migration
  `20261011120100`, `student-login`, client). GoTrue refuses a banned
  (archived) account before it checks the password, so `student-login`
  checks it itself, with pgcrypto against the stored bcrypt hash
  (`archived_student_password_matches`, service role only), and answers
  `403 student_archived` only to the right password — anyone else still gets
  the one floored refusal, so usernames stay unconfirmable. An email-method
  student meets GoTrue's own `user_banned` (which GoTrue returns without a
  password check anyway) and gets the same message. The sign-in page keeps
  its "your teacher changed your access / N changes kept" notice up after a
  failed attempt. Needs hosted `postgres` to read `auth.users`
  (`guest_email_taken` already does) and pgcrypto in `extensions` (Supabase
  default).
- **The crash screen can recover from a bad cache** (client). A cached
  assignment list that does not parse is dropped instead of painted (it threw
  on every load before the fresh list could replace it), and the crash screen
  has "Clear cached data and reload", which empties the list snapshots
  (library, roster, assignments, entitlements, thumbnails, analyses) — never
  the outbox, annotation mirror, day snapshots or cached PDFs.
- **Contrast**: `--color-danger` is red-700 (was red-600: 3.79:1 behind the
  viewer's error, 4.37:1 on paper); danger buttons darken on hover.

**QA round 4 — sync (`qa4/sync`), client only.**

- **An edit made after Undo of an erase survives a collaborator's erase**
  (C1, was B5; QA lost it 9 times in 10). Reconcile now takes its verdict
  inside the transaction that rewrites the outbox, over the mark's ops as
  they are then, not as they were when its server read left (a read sent
  offline is out for ~7 s while postgrest-js retries it). It also waits for
  an edit that has begun but is not in the outbox yet (`hasUnsavedEdit` /
  `whenSaved` in `annotationStore.ts`), and a verdict to send nothing adopts
  the server row in the same transaction and tells other tabs at once.
- **The library says "Offline" at load** when the browser already knows it
  is (C6), instead of after ~7 s of retries, and reloads on reconnect.

**QA round 4 — first page (`qa4/perf`), client only.** A cold open of a
150-page, 16.5 MB scan under Fast 3G + 4× CPU shows page 1 in ~10 s (was
15.7 s; 12.3 s with 1.2 s to first byte), from the local benchmark
(`scripts/bench-first-page.mjs`): the file's tail is fetched as soon as its
length is known, Range requests are small and grow as pdf.js reads on, extra
bytes are kept, a refused Range request no longer stalls page 1, and the
pdf.js worker starts while the score is looked up. Range bytes never enter
the offline copy. Missed only where something caps parallel Range requests at
about six (HTTP/1.1, or a proxy): ~35 s. QA's ~50 s on dev.cleffy.io is
unexplained — re-measure there (step 2) before deciding anything about
rewriting PDFs at upload.

**QA round 4 — integration review (`qa4-integrate`), client only.**

- **A pull that crosses this device's own push no longer takes it back.**
  Found by a new randomized test (`src/sync/reconcileInterleaving.test.ts`,
  150 random runs of erase / Undo / Redo / edit over two notes across a
  dropped connection, against a collaborator's erase or edit). On reconnect
  the 'online' pull runs beside the drain resuming from offline. A server
  patch answers with no seq, so the store kept the pre-push seq, and a row
  the pull had read before the push landed won under seq LWW: an erase came
  back on this device, or an Undo vanished, until the push's echo or the next
  pull — and an edit made meanwhile went onto the tombstone and was lost.
  The engine now records when each mark's push landed (`landed`), and a row
  read before that is not applied unless it is that push's own echo (same
  delete instant, or same content); the server is asked again for it
  (`askAgain`, one GET, only when a read crossed a push of the same mark).
  Pulled rows held for a queued op are dated by when the pull left.
- **Edit, erase, Undo keeps the edit** (same test). Reconcile folded an edit
  and a later erase into one delete; an Undo queued before that delete was
  sent then met a delete + restore pair over the unedited server row, sent
  nothing, and the note came back without the edit. The edit now goes out
  ahead of the delete (one more patch in the same batch).
- **Library reconnect race**: an 'online' event between the offline notice's
  paint and the effect that listens for it was missed; both offline states
  now reload when they find the browser already back. (Found as a test that
  failed only under full-suite load.)
- **Still open, by design for now:** when one engine's reconcile adopts a
  collaborator's erase, another engine on the same score — a second tab, or
  this tab's viewer while a background drain that started before the score
  was reopened is still running — keeps drawing the mark until it hears (a
  BroadcastChannel hop and one IndexedDB read), and the reconcile does not
  wait for an edit that engine has begun but not yet queued. An edit there in
  that window can still land on the tombstone (qa4/sync's "Two tabs" note).
  A realtime row that predates a push but arrives after its ack is still
  applied; the push's echo, behind it on the same channel, corrects it. And
  a store op is built from the mark as it is when the action starts, so an
  erase begun within the few milliseconds of an edit's commit would carry
  the pre-edit content into its Undo — not reachable from the UI, where the
  eraser cannot reach a note whose editor is open.

`stripe-webhook` now applies `customer.subscription.created` / `.updated` from
the subscription as Stripe holds it **now** (`subscriptions.retrieve`), not from
the copy embedded in the event: Stripe does not deliver in order, and a retried
older event (every transient failure here is a 500 that Stripe retries) would
otherwise overwrite a newer state — a late `unpaid` after the customer paid
archived their scores, a late `active` after `unpaid` restored them unpaid.
`.deleted` still applies as `canceled` without a read. One Stripe API call per
subscription event; a failed read is a released claim and a 500, which Stripe
retries.

The smart-import refund ledger that fix/billing first proposed
(`smart_import_charges`, `refund_smart_import`) was dropped in integration and
never applied anywhere: `imslp-download` now creates the score itself and
refunds every failure before it answers, so there is no client rollback left
to refund (comment at the end of `20261007120300`).

### Before the merge

1. **Production is further behind than this release.** Its migration history
   ends at `20260830101624` (checked 2026-10-08): the merge also applies
   `20260830120000` … `20260910160001` (library bootstrap, thumbnails, the IMSLP
   works mirror and its two catalog data files, ~48 MB). Those two catalog
   files are not in `scripts/apply-migrations.sql`; only `db push` / the
   integration applies them. Expect the migration step to take minutes, and
   confirm the Supabase check on the merge commit is green before announcing.
   **Migration-history repairs, 2026-10-08.** Both projects carried history
   rows the repo has no file for, which made `db push` and the integration
   refuse. Only the history rows were removed; no schema changed.
    - Production: `20260918042925_tmp_ledger_cleanup`, a hand-run statement
      whose only effect was to delete other history rows. Newer than every
      pending `dev` migration, it made all ten "out of order".
    - `dev` branch: the five `20260921141103` … `20260921141127`
      `playalong_corpus*` rows, applied by hand from
      `mh/playalong-on-dev-ab47`, which made Supabase Preview fail with
      "Remote migration versions not found in local migrations directory".

    The `playalong_corpus*` tables, the `pd_pdf_store` table and the `pd-pdfs`
    bucket remain on both projects without history rows; no fix here touches
    them, and that branch's migrations guard their creates so they re-apply
    over the existing objects when it merges.

    **Two recovery-path gaps to settle before trusting any rebuilt
    environment**, both measured on 2026-10-12 and written up under _Recovery
    and disaster recovery_: production's history row for `20260828180000` has
    `statements = NULL`, so replaying production's history builds a database
    that **fails** on migration 15 — which is why branch-based QA has been
    standing in for production only after manual remediation (R1, and read its
    landmine note before repairing it); and the 10,618 rows in the corpus
    tables above are recreatable by no migration on `main` until PR #52 merges
    (R2). Neither blocks this push.

2. **Prove the set on the `dev` branch first.** Push `dev` (unpause the branch
   first, §5), then run, against `qdbnlrgylelelvwbkvnm` only, each rolled-back
   proof: `tests/sql/column_integrity.sql`, `tests/sql/cross_branch_integration.sql`
   and `supabase/sql-tests/sharing_access_control.sql` (how: `tests/sql/README.md`).
   All three must report no failures except the sharing file's realtime checks
   80–82, 85 and 87, which need today's `realtime.messages` partition and fail
   on an idle project. (Run on 2026-10-08 before merge, as one rolled-back
   transaction per file with every 20261007 migration applied first: 113/113,
   37/37 and 89/94 with exactly those five.)
   QA round 3 adds four proofs, run the same way once the 20261010 migrations
   are on the branch (or inside the transaction, README _Testing a migration
   before it is applied_): `tests/sql/guest_email_verification.sql`,
   `tests/sql/student_access_revocation.sql`,
   `tests/sql/annotation_payload_shape.sql` and
   `tests/sql/qa3_cross_branch.sql`. On 2026-10-10 every file passed on a
   local Postgres 16 with all 55 migrations replayed (catalogs included) and
   GoTrue's `supabase_auth_admin` role present: 53/53, 44/44, 57/57 and 12/12,
   and the earlier files 113/113, 37/37, 35/35, 26/26 and 94/94. Not yet run
   on the dev branch.
   QA round 4 adds `tests/sql/archived_student_password.sql` and
   `tests/sql/edge_rate_limit_refund.sql`, run the same way once
   `20261011120100` / `…101` are on the branch. On 2026-10-11 the integrated
   set (`qa4-integrate`, 57 migrations replayed with catalogs, local
   Postgres 16) passed every file: 13/13 and 10/10 for the new two, and
   57/57, 35/35, 113/113, 37/37, 53/53, 12/12, 26/26, 44/44 and 94/94 for
   the rest. Then, on dev, archive a code student and sign in as them with
   the right password: the page must say the account is archived
   (`403 student_archived`); a wrong password must get the ordinary refusal.
   And re-measure qa4/perf's first page against real Storage: a large score
   not yet on the device, DevTools Fast 3G, no proxy — page 1 well inside
   20 s.
   Then the out-of-order webhook check, in the Stripe sandbox against the dev
   endpoint (Workbench → Events): make any two `customer.subscription.updated`
   events on a test subscription (e.g. turn cancel-at-period-end on, then
   off), then **Resend** the older one. The `subscriptions` row must keep the
   newer state (there: `cancel_at_period_end = false`), and the function log
   must show the resent event applied, not refused and not a 500.
   While in the sandbox dashboard, check its Customer portal has Switch plans
   on with the six plan prices and without Founding (§1, _Checkout depends on
   it_) — subscribers can change plan nowhere else once `stripe-checkout`
   refuses them a second subscription.
   Then score streaming against real Storage (qa3/perf: a first open shows
   page 1 while the PDF downloads, `progressiveDownload.ts`). It needs three
   things of a signed `scores` URL, and silently falls back to the old
   whole-file wait without them. On dev.cleffy.io, in a private window (so no
   score is cached), open one of your scores with DevTools open and copy the
   `…/storage/v1/object/sign/scores/…` URL from the Network tab; in the
   console, with `u` set to it,
   `const r = await fetch(u); [r.headers.get('content-length'), r.headers.get('content-encoding')]`
   must give the file size and `null`, and
   `(await fetch(u, { headers: { Range: 'bytes=0-99' } })).status` must be
   `206`. (The CORS side was checked on 2026-10-10: a preflight for
   `Range` to dev Storage answers `access-control-allow-headers: range`.) Then
   open a large score not yet on the device with Fast 3G throttling: page 1
   appears before the Network tab's full GET finishes.
3. **Auth password policy on both projects** — 8+ characters, letters and
   digits, via the Management API (§8). `config.toml` only covers the local
   stack. Existing passwords keep working.
4. **Edge secrets.**
    - `STRIPE_SECRET_KEY_LIVE` must be set on production (it is, since
      2026-08-28): `delete-account` refuses with `503 billing_unavailable` and
      deletes nothing for any live customer it cannot reach (§2), and
      `stripe-webhook` reads every subscription event back from Stripe, so
      without the key each one is a 500 until it is set (Stripe keeps retrying
      for three days; nothing is lost if it is set within that window). The
      dev branch needs its sandbox key the same way (`STRIPE_SECRET_KEY_TEST`,
      or the older `STRIPE_SECRET_KEY`; set 2026-08-29).
    - `LOGIN_THROTTLE_SECRET` (recommended, optional): HMAC key for the
      student-login limiter (§9); unset falls back to the service-role key.
    - `RESEND_API_KEY` on the **`dev` branch** too (production has it for
      `resend-inbound`): `guest-email-start` mails the guest's code with it,
      and without it the banner says email is unavailable. Optional
      `GUEST_EMAIL_FROM` and `GUEST_EMAIL_SECRET` (QA round 3, shell and auth).
    - Optional: `SENTRY_DSN` (+ `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`) for edge
      error reports (§2, _Error monitoring_).
    - Optional tuning: `IMSLP_DOWNLOAD_GLOBAL_MAX` / `IMSLP_DOWNLOAD_GLOBAL_SPACING_MS`
      (deployment-wide IMSLP pacing, defaults 2 per 1000 ms — SETUP_SUPABASE.md).
5. **Vercel env (build time).** Leave `VITE_FEATURE_PLAYALONG`,
   `VITE_FEATURE_FINGERING`, `VITE_FEATURE_PRINT_HANDWRITING` and
   `VITE_FEATURE_SMART_IMPORT` unset (or `0`): play-along, fingering and smart
   import are not part of this release and the pricing copy no longer sells
   them. Optional `VITE_SENTRY_DSN` / `VITE_SENTRY_RELEASE` (§4).
   The `vercel.json` security headers (CSP, HSTS, frame, referrer, permissions)
   ship with the bundle; the CSP already allows both Supabase projects and
   `*.ingest.sentry.io`, `*.ingest.us.sentry.io`, `*.ingest.de.sentry.io`.
6. **Legal.** `/privacy` and `/terms` go live with this merge. Settle every open
   item in `docs/LEGAL_REVIEW.md` (operator entity, hosting region, refunds,
   governing law, processors including Sentry) with counsel first. Two
   statements changed on 2026-10-08 to match the integrated code, flagged for
   counsel in §7 and §15: the Terms now say scores past a smaller plan's limits
   stay read-only "until you upgrade again" (there is no owner unarchive), and
   the Privacy Policy now says sign-out uploads pending changes, warns about
   any it could not upload, then removes the account's markings from the
   device (it used to say unsynced markings were kept).
7. **CI is green**, including the new `npm audit --omit=dev --audit-level=high`
   step (pdf.js 6.4.299 fixes GHSA-hq66-cqwq-w95j).

### The merge

8. Merge `dev` → `main` outside lesson hours. The integration applies the
   migrations, then deploys the functions; Vercel builds the bundle in parallel.
   For the minutes in between:
    - a new bundle against the old `imslp-download` gets 403 on IMSLP imports
      (it no longer creates the row first) — the function must win this race,
      so if the function deploy fails, redeploy it before anything else;
    - old bundles against the new `imslp-download` are still served (they
      create the row themselves), but show a busy queue as an error;
    - an old bundle's guest banner calls `updateUser({ email })`, which
      `guard_guest_email` now refuses, and a new bundle's banner gets a 404
      until `guest-email-start` is deployed — so do not hold the functions or
      the bundle back once `20261010120200` is in.

    **Deactivate `imslp-sync` the moment migration 3 (`20260902120000`)
    commits**, and re-enable it only after migration 10 (`20260910160001`):
    that migration schedules the job 27 migrations early, and on the rehearsal
    it fired 9 times mid-push, including inside migration 9's 102-second
    exclusive lock on `imslp_works`. Statements and the reason are under
    _Recovery and disaster recovery_, R4 — which also says to leave
    `omr-sweep` running.

9. **Realtime topic split** (`20261007120101`). Committed annotation rows, PDF
   replacement and play-along status move from `doc:{id}` to the receive-only
   `doc-db:{id}`; presence, live ink and the sharing `membership` event stay on
   `doc:{id}`. _Bundle first_: the new client cannot join `doc-db:{id}` yet;
   after 4 s it pulls every 15 s (and 1.5 s after a peer's stroke) and once more
   when the join succeeds — late, never lost. _Migration first_: tabs on the old
   bundle stop receiving committed rows live; a peer's live preview fades after
   10 s and the mark appears on the next pull (reconnect, `online`, reload).
   Expect open tabs to need one reload.
10. **Clients upgrade their local database** on first load (Dexie v8 removes
    duplicate lesson snapshots, v9 makes one per score-day unique) — nothing to
    do, but a device that cannot open IndexedDB keeps working without it.

### After the merge

11. Supabase check on the merge commit green; `list_migrations` on production
    ends at `20261011120101`; security advisor: no new
    `function_search_path_mutable` / `anon_security_definer_function_executable`
    except `peek_share_link`, which is anon-callable on purpose (the join page
    checks a link before anyone signs in) and answers only `{valid, role}`.
    (In the local replay every public definer function pins `search_path`,
    and `peek_share_link` is the only one anon may execute.)
12. Run the CSP smoke against the production build
    (`npm run build && node scripts/csp-smoke.mjs`; with a Sentry DSN build also
    `CSP_SMOKE_SENTRY=1`; with a Turnstile build — `VITE_TURNSTILE_SITE_KEY` set,
    or Cloudflare's test key `1x00000000000000000000AA` — also
    `CSP_SMOKE_TURNSTILE=1`) — zero violations, legal pages, Account page, Source
    dialog, both exports and the Turnstile challenge included. Then open cleffy.io with the console open:
    no CSP or header errors.
13. Smoke on production with throwaway accounts: share a score, change a
    member's role and watch the other tab follow live, revoke a link with
    removal, leave a score; draw offline and come back online; export a PDF on
    a free account twice (the second is refused and nothing is saved or
    shared; the PDF is built before the claim, so a failed build spends
    nothing); import from IMSLP and open its Source dialog; delete a score and
    check the library and Storage; delete a throwaway account from the Account
    page (needs the live key) and confirm it is gone from Auth, Storage and
    Stripe. QA round: open a revoked share link (the join page says so before
    asking a name, and no guest appears in Auth); join as a guest and use
    "Delete my guest profile" (gone from Auth and from the owner's member
    list); cancel a plan in the portal and see "Ends <date>" with Resume on the
    Account page. As an editor, draw offline, have the owner make you a viewer,
    reconnect on the library: the marks stay until you open the score, which
    then undoes them and says why. On a free account, dismiss the share sheet
    of "Save page 1 as PDF", then "Export whole score as PDF": it goes through,
    not refused.
    QA round 3 (the guest-email smoke is in its own section above):
    - Roster: open an assigned score as a student, then archive the student
      from the teacher's roster — without a reload the open score signs the
      student out and the sign-in page says why; the assignment list does the
      same (at once on focus, else within a minute). Restore, sign in again
      on two devices, reset the code: both lose access the same way. Then
      the other direction: sign in on two devices, draw a mark offline on
      device B, sign out on device A, reconnect B — the mark uploads and B
      keeps working (until its token expires). And a reset with a mark
      queued offline on B: B's sign-in page says one change is kept; after
      claiming the new code and signing in on B, the mark is on the score.
    - Two tabs of one account on one score: recolour a mark offline in tab
      1, have a collaborator recolour it meanwhile, reconnect tab 1. Tab 2
      goes straight to tab 1's colour and never shows the collaborator's.
    - Shared browser: account A draws offline and its session ends without a
      sign-out; account C signs in and exports that score as PDF and as a
      page photo — neither contains A's unsynced marks.
    - Import marks from the same annotated PDF twice: the second review says
      the marks are already imported. Paste more than 10,000 characters into
      a text note: the editor stops at the limit.
    - IMSLP: search results show no `&quot;` / `&amp;` and part names show ♭
      where IMSLP has `{{Flat}}`; on a 390×667 phone the edition picker's Add
      button and its disclaimer are on screen without scrolling.
      QA round 4:
    - C1, five times over: A has a synced text note; A goes offline, erases
      it, presses Undo, edits its text; B erases it (reaches the server); A
      reconnects. Every time, both A and B show the note with A's text, and
      A's dot reads Synced. Control: the same without A's edit — B's erase
      stands on both.
    - Open the library offline (cached): "Offline — showing scores cached on
      this device" at once; reconnect: the notice goes without a reload.
    - Students: delete a teacher whose student has the score open with a
      mark queued offline — the sign-in page says the account was deleted and
      the change discarded, not that it will be saved. An archived student
      signing in with the right password is told they were archived.
14. **Leftover Storage of accounts deleted any other way.** `delete-account`
    empties both buckets for every `document_storage_cleanup` tombstone the
    account owns before it deletes the auth user. An account removed from the
    dashboard skips that and leaves tombstones whose owner no longer exists;
    list them with
    `select c.* from public.document_storage_cleanup c left join auth.users u on u.id = c.owner_id where u.id is null`
    and remove `{document_id}/` from the `scores` and `thumbnails` buckets
    (Storage API, service key), then the rows.
15. If monitoring is on: trigger a test error on dev.cleffy.io and confirm it
    arrives in Sentry scrubbed (no emails, tokens or annotation content).
16. **IMSLP Piano chip now covers keyboard works** (qa/polish). Five new
    taxonomy categories — `For keyboard`, `For keyboard (arr)`,
    `For harpsichord`, `For harpsichord (arr)`, `For clavichord` — have no
    `imslp_category_sync` row on either project, so the `imslp-sync` cron
    (every 2 min) walks them next, one per tick, about 10 minutes in all; no
    migration. Until then typed search checks them live, but browsing by
    chip with no query is affected: Piano alone (or with chips whose
    categories aren't walked yet either) shows "IMSLP index is still being
    built for Piano", and Piano with another walked chip (e.g. Baroque) lists
    only the `For piano` side, missing keyboard- and harpsichord-only works.
    Check:
    `select category, state, pages_done from imslp_category_sync where category ~ 'keyboard|harpsichord|clavichord'`
    shows five `ok` rows. Then search "BWV 846" on cleffy.io: "Prelude and
    Fugue in C major, BWV 846" first.

---

## 0. The live flip — cleffy.io on the real Stripe account

cleffy.io transacts against Stripe account **Cleffy** (`acct_1U35FW4eZ6RX0W0g`,
live). dev.cleffy.io and localhost stay on **Cleffy sandbox**
(`acct_1U35Fc9EqxUjgZtn`).

Which account a checkout reaches is decided by `STRIPE_SECRET_KEY` — an Edge
Function secret. The two deploys have separate Supabase projects (§5), so in
principle that is one live key on production, one test key on the `dev` branch,
and nothing else to say.

It is not enough on its own, because "which project a deploy talks to" is itself
just configuration, and §5 records what happened the last time that was the only
safeguard: dev.cleffy.io was believed to be on the branch project and was in fact
on production for its entire existence. A live key alone would have meant real
cards behind dev's buttons for exactly as long as nobody checked.

So the account is chosen per request, from the **Origin** header
(`supabase/functions/_shared/stripeMode.ts`), and `STRIPE_MODES` lets each
backend refuse the origins that are not its own:

| Origin                                       | Account                        |
| -------------------------------------------- | ------------------------------ |
| `https://cleffy.io`, `https://www.cleffy.io` | live                           |
| `https://dev.cleffy.io`                      | sandbox                        |
| any plain-`http://` origin                   | sandbox                        |
| anything else                                | refused — `400 unknown_origin` |

Development is matched by scheme rather than hostname because `dev:local` binds
every interface for iPad testing, so its origin is as often a LAN address as
localhost. Both storefronts are https and Vercel serves them no other way, so
nothing reachable over http can be the live shop.

Nothing in a request body influences that choice, so no crafted payload moves a
caller between accounts, and an origin we do not publish from is refused rather
than guessed. `STRIPE_LIVE_ORIGINS` / `STRIPE_TEST_ORIGINS` (comma-separated)
extend the lists without a deploy.

`STRIPE_MODES` then narrows it per backend: production serves `live` only, so a
sandbox caller reaching it — dev, a preview, a laptop with the wrong `.env` —
gets `400 unknown_origin` rather than a test-mode row in the production
database. The `dev` branch serves `test` only, the mirror of it. Unset means
both, which is what a single-project setup wants.

The webhook has no Origin to sort by — both accounts POST to one URL per project
— so it verifies the signature against each account's secret in turn, and
whichever secret verifies _is_ the account. Mode is a result of authentication
there, never an input to it.

### Done — production is on the live account (2026-08-28)

| Step                                                            | State                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY_LIVE` on `jibgwgosihadbjgxdsfe`              | ✅ set; Stripe accepts it and it returns the live catalogue            |
| `20260828180000_billing_stripe_mode.sql` applied                | ✅ `mode` on both tables, `billing_customers` PK now `(user_id, mode)` |
| `entitling_billing_modes()` narrowed on production              | ✅ returns `{live}`                                                    |
| `stripe-checkout` / `stripe-portal` / `stripe-webhook` deployed | ✅ ACTIVE at v7, `verify_jwt` preserved (webhook `false`)              |

Verified after deploying: the deployed bundles carry `modeForRequest`,
`servedModes`, `resolvePrice`, both price catalogues and the dual webhook
secrets; `stripe-checkout` answers `401` without a JWT; the webhook answers
`400 {"code":"missing_header"}` to an unsigned POST, which is the signal that it
booted and read a secret.

**Not exercised: a signed-in checkout against the live account.** That needs a
real user, and creating one on production was out of scope for the flip. Do it
once from cleffy.io after §0's remaining work — buy Personal, confirm the
Checkout page carries no test-mode banner, and confirm the webhook writes a
`subscriptions` row with `mode = 'live'`.

### What is left

**1. Merge `dev` → `main`** for the frontend — but see the blocker below first.
Until it merges, cleffy.io still ships the old bundle naming sandbox price ids;
checkout re-prices those into live mode, so it sells correctly either way.

**2. ~~Give the `dev` branch project its sandbox secrets.~~ Done 2026-08-29.**
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `APP_URL=https://dev.cleffy.io`
are set on `qdbnlrgylelelvwbkvnm`, alongside the `STRIPE_MODES=test` that was
already there. Verified: the branch webhook answers `400 missing_header` to an
unsigned POST rather than `500 Server misconfigured`, and `stripe-checkout`
answers `401` without a JWT.

`STRIPE_MODES=test` is the mirror of production's: the branch refuses a
cleffy.io caller, so the two backends cannot serve each other's storefront even
if a build or a DNS entry is wrong.

**Loose end — two sandbox webhook endpoints now point at the branch.** The
original (`we_1U8njJ9EqxUjgZtnfBK3y0XH`) only reveals its signing secret at
creation, so a replacement (`we_1U9fnx9EqxUjgZtnXnAvtJH3`) was created to obtain
one. Only the replacement's secret is configured, so the original's deliveries
fail signature verification and Stripe will eventually disable it and email about
it. **Delete `we_1U8njJ9EqxUjgZtnfBK3y0XH`** in the sandbox dashboard. Nothing is
double-processed meanwhile: both deliveries carry the same event id and
`stripe_events` drops the replay.

**3. Create the live Customer portal configuration.** Live dashboard → Settings →
Billing → **Customer portal** → Save. `stripe-portal` 500s for every live caller
until a default configuration exists, exactly as it did in the sandbox (§1).
There is still no API for it.

**4. Rotate `sk_live_…`** if it has been pasted anywhere it should not persist.

### ~~Blocker for merging `dev` → `main`~~ — cleared 2026-08-29

Two migrations `dev` carried were missing from production. Both are now applied,
and `supabase/migrations/` and production's history match exactly — no version in
the repo is missing from `schema_migrations`.

**A trap worth knowing.** These went in through the Supabase MCP's
`apply_migration`, which records the migration under a **fresh timestamp of its
own** rather than the repo filename's version. Left alone that reads as two
unapplied migrations, and the next `db push` would try to re-run them and fail on
a duplicate column. The history rows were renamed to `20260827150000` and
`20260828120000` afterwards to match the repo. Check `schema_migrations` after
any `apply_migration`, not just that the DDL succeeded.

What each one did:

| Migration                                  | What breaks without it                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260827150000_student_credentials.sql`   | Student sign-in. `mark_student_claimed()` and the `managed_students` credential columns do not exist on production — verified, not assumed. |
| `20260828120000_free_tier_no_students.sql` | Free-tier roster gating. Production's `tier_limits('free')` still reports `students: 3` while the merged client hides the roster.           |

Neither touched the Stripe flip; they were the rest of the release.

### Webhook endpoints — already retargeted

| Endpoint                      | Account | Posts to                            |
| ----------------------------- | ------- | ----------------------------------- |
| `we_1U9V8T4eZ6RX0W0glk3BZIOi` | live    | `jibgwgosihadbjgxdsfe` (production) |
| `we_1U9fnx9EqxUjgZtnXnAvtJH3` | sandbox | `qdbnlrgylelelvwbkvnm` (dev branch) |

The sandbox endpoint posted to production until 2026-08-28, from when dev shared
that backend — so a purchase on dev.cleffy.io wrote its subscription row into
production. It now posts to the branch.

The sandbox row is a **replacement**. Stripe reveals a signing secret only at
creation and the original (`we_1U8njJ9EqxUjgZtnfBK3y0XH`) predated this work, so
a new endpoint was created to obtain one. The original is now **disabled** and
labelled `SUPERSEDED` — disabled rather than deleted because no DELETE is exposed
through the connector; remove it from the sandbox dashboard whenever convenient.
While it was enabled nothing was double-processed: both deliveries carried the
same event id and `stripe_events` dropped the replay.

One consequence to expect: the branch is paused most of the time and Stripe gives
up after retrying a dead endpoint, so sandbox events raised while it is paused
are dropped. That is the cost of a paused dev backend, and it is the right side
of the trade — a lost test event beats a real one in the wrong database.

### Verifying

```bash
# Live mode: cleffy.io must reach the live account.
curl -sS -X POST https://jibgwgosihadbjgxdsfe.supabase.co/functions/v1/stripe-checkout \
  -H 'Origin: https://cleffy.io' -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' -d '{"priceId":"price_1U9V7M4eZ6RX0W0glzzjnokr"}'
# -> a checkout.stripe.com URL, live mode, no test-mode banner

# An origin we do not publish from buys nothing at all.
curl -sS -X POST … -H 'Origin: https://example.com' …
# -> 400 {"error":"Unrecognised origin","code":"unknown_origin"}
```

Note that a `curl` with no `Origin` header now gets `400 unknown_origin` — the
smoke test in §6 predates this and needs the header added.

The Personal subscription bought in the sandbox on 2026-08-28
(`sub_1U9SxH9EqxUjgZtnJvCo0viW`, in production's database) keeps entitling until
step 3, then stops. Re-buy it on the live account and cancel the sandbox one so
it does not keep renewing in test mode.

---

## 1. Stripe Customer portal — configured in both modes

`stripe-portal` returns 500 for every caller until a **default portal
configuration** exists for that mode. Both modes now have one; live is
`bpc_1U9juu4eZ6RX0W0gPrUkrH6S` (default, active), verified by creating a real
live portal session against a throwaway customer and then deleting it.

Intended shape, live and sandbox alike:

| Feature                              | Setting                                                              |
| ------------------------------------ | -------------------------------------------------------------------- |
| Cancel subscription                  | on                                                                   |
| Update payment method                | on                                                                   |
| Invoice history                      | on                                                                   |
| Switch plans (`subscription_update`) | on, `default_allowed_updates: ['price']`                             |
| Proration                            | `always_invoice` — charge the difference at the moment of the switch |
| Switchable products                  | Personal, Teacher, Academy — monthly and annual each                 |
| **Excluded**                         | **the $99 Founding Teacher annual price**                            |

`always_invoice` is what makes an upgrade bill correctly mid-cycle: Stripe
credits the unused remainder of the old plan and charges the new one only from
the switch forward, then invoices the net difference immediately. Nobody pays the
upgraded rate for days already elapsed. Its cost is that a failing card surfaces
as a failed invoice during the upgrade rather than quietly on the next cycle.

Two things the UI does not warn about:

- **Founding Teacher is a second annual price on the Teacher product**, so it sits
  next to the $190 one in the product picker. Listing it would let anyone switch
  _into_ a grandfathered launch price and keep it indefinitely.
- **The portal has no direction control.** Listing the products enables downgrades
  as well as upgrades; under `always_invoice` a downgrade yields a credit balance
  against future invoices, not a refund.

### Checkout depends on it — verify both modes before deploying

`stripe-checkout` answers **409 `already_subscribed`** to anyone who already
holds a running subscription in that mode (active or trialing inside its
period — cancelling included — or past_due), and the pricing dialog sends
subscribers to the portal instead of Checkout. Checkout always creates a new
subscription, so before this guard a Personal subscriber who chose Teacher
there was billed for both. The cost is that the **portal is now the only way a
subscriber changes plan**: in a mode whose portal has Switch plans off, its
subscribers cannot change plan at all.

Live was verified with switching on (2026-08-29, above). **The sandbox
configuration never was** — the status table only records that it exists, and
dev.cleffy.io sells from the sandbox. Before deploying `stripe-checkout` with the
guard, open **Settings → Billing → Customer portal** in **each** mode and confirm
the table above: Switch plans on, the six Personal / Teacher / Academy prices
listed, the Founding price **not** listed. Then, on dev.cleffy.io with a test
subscription, Account → Manage subscription must offer the other plans.

### This is dashboard-only — the API cannot do it

There is no create endpoint exposed here, and **`features[subscription_update][products]`
is silently ignored on write and absent on read**, at every API version this
account accepts (2020-08-27 through 2025-03-31.basil were all tried). A write can
therefore turn `subscription_update` _on_ while leaving the product list null —
switching enabled with an unverifiable scope, which is worse than off. Do it in
**Settings → Billing → Customer portal**, in each mode, and treat the dashboard as
the only source of truth for which prices are switchable.

## 2. Edge Function secrets

Five values, and none of them can be committed:

```bash
npx supabase secrets set \
  --project-ref jibgwgosihadbjgxdsfe \
  STRIPE_SECRET_KEY='sk_test_…' \
  STRIPE_WEBHOOK_SECRET='whsec_…' \
  STRIPE_SECRET_KEY_LIVE='sk_live_…' \
  STRIPE_WEBHOOK_SECRET_LIVE='whsec_…' \
  APP_URL='https://cleffy.io'
```

Each mode reads its own pair, most specific name first:

| Mode | Secret key                                         | Webhook secret                                             | Stripe account                           |
| ---- | -------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| live | `STRIPE_SECRET_KEY_LIVE`                           | `STRIPE_WEBHOOK_SECRET_LIVE`                               | Cleffy (`acct_1U35FW4eZ6RX0W0g`)         |
| test | `STRIPE_SECRET_KEY_TEST`, else `STRIPE_SECRET_KEY` | `STRIPE_WEBHOOK_SECRET_TEST`, else `STRIPE_WEBHOOK_SECRET` | Cleffy sandbox (`acct_1U35Fc9EqxUjgZtn`) |

- Set them **per project**. The table above is production's; the `dev` branch
  project (`qdbnlrgylelelvwbkvnm`) needs only the sandbox pair, since no
  cleffy.io origin ever reaches it.
- The pre-split names fall through to test mode on purpose: they held the sandbox
  key before there were two accounts, so **adding `STRIPE_SECRET_KEY_LIVE` is by
  itself the whole live flip**. On production the old `STRIPE_SECRET_KEY` then
  serves localhost and nothing else.
- A key is rejected if its own mode infix (`sk_live_` / `sk_test_`, `rk_` too)
  contradicts the variable holding it. That one paste is what charges a real card
  from a test button, so it fails closed instead. A key shape Stripe has not
  shipped yet is passed through — this is a swap check, not an allowlist.
- Webhook secrets: `we_1U8njJ9EqxUjgZtnfBK3y0XH` is the sandbox endpoint,
  `we_1U9V8T4eZ6RX0W0glk3BZIOi` the live one, and both currently post to
  production. A receiver tries each secret it has and the one that verifies names
  the account — see §0 on whether the sandbox endpoint should move to the branch.
- `APP_URL` — where Checkout and the Portal return to when a caller sent no
  `Origin` at all. A recognised `Origin` now wins over it, so a dev.cleffy.io
  tester is returned to dev.cleffy.io instead of being handed to production.

To confirm the secrets landed, POST an unsigned body to the webhook:

```bash
curl -i -X POST https://jibgwgosihadbjgxdsfe.supabase.co/functions/v1/stripe-webhook \
  -H 'Content-Type: application/json' -d '{"id":"evt_probe","type":"ping","data":{"object":{}}}'
```

`500 {"error":"Server misconfigured"}` means `STRIPE_WEBHOOK_SECRET` is still
unset — the state as of this writing. Once set, the same call returns
`400 {"error":"Invalid signature","code":"missing_header"}`, which is the
success signal: the function booted, read the secret, and rejected an unsigned
request exactly as it should.

**No `STRIPE_PRICE_*` variable is needed.** Both catalogues are committed in
`supabase/functions/_shared/stripeMode.ts` as `PUBLISHED_PRICES`, because a price
id is configuration rather than a secret — the same fourteen values already ship
in `.env.production` and therefore in every browser bundle.
`tests/billing/priceCatalogInSync.test.ts` fails the build if the copies ever
disagree, or if an id ever appears in both catalogues at once.

Overrides are per mode — `STRIPE_PRICE_*` for test, `STRIPE_PRICE_LIVE_*` for
live — and **all-or-nothing within a mode**: one override replaces that whole
catalogue. That is deliberate. A per-key merge would let a half-finished
catalogue change serve two vintages of price from one account, which looks fine
until someone is billed the wrong amount.

### Account deletion — `delete-account`

Self-serve deletion (Account page → Delete account) is a new function,
declared in `supabase/config.toml` with `verify_jwt = true`, so the Supabase
GitHub integration deploys it on the `dev` → `main` merge like every other
function (§5) — no manual `functions deploy`, no second `db push`. The same
merge must carry migration `20261007120600_account_deletion.sql` and the updated
`stripe-webhook`; they ship together on that merge. Without the migration,
deleting someone who drew on another person's score would cascade-delete those
marks from the owner's copy; without the webhook change, a Checkout completed in
another tab during a deletion could keep billing an account that is gone.

It needs no new secret, but it depends on the Stripe ones above:

- **`STRIPE_SECRET_KEY_LIVE` must be set wherever a live `billing_customers`
  row can exist.** Deletion cancels every subscription before it deletes
  anything, and refuses with `503 billing_unavailable` — deleting nothing — for
  any user with a live customer when it cannot reach the live account. That is
  the intended fail-closed behaviour, but it means a missing live key blocks
  every paying customer from deleting their account.
- A missing **test** key is skipped with a log line: sandbox subscriptions never
  charge a card, so they are no reason to keep someone's data.
- It also uses `SUPABASE_URL`, `SUPABASE_ANON_KEY` (to re-check the password)
  and `SUPABASE_SERVICE_ROLE_KEY`, which every project has already.

What it deletes and in which order is documented at the top of
`supabase/functions/_shared/accountDeletion.ts` — including the
`document_storage_cleanup` tombstones (`20261007120401`): before the auth user
goes, it empties both buckets' `{document_id}/` folders for every tombstone the
account owns (its own score deletes, and library deletes whose Storage purge
never finished) and drops the rows, failing the request if it cannot.

### Error monitoring — optional

All of it is off until a DSN is set, and costs nothing while off.

| Where                   | Variable              | What it does                                                                                                                       |
| ----------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Edge Function secret    | `SENTRY_DSN`          | Also post every `logError` record (`_shared/errorLog.ts`) to Sentry. Unset: the JSON line in the function logs is the only record. |
| Edge Function secret    | `SENTRY_ENVIRONMENT`  | Optional. Defaults from the project ref: `production` for `jibgwgosihadbjgxdsfe`, `development` for `qdbnlrgylelelvwbkvnm`.        |
| Edge Function secret    | `SENTRY_RELEASE`      | Optional release tag for edge events.                                                                                              |
| Vercel env (build time) | `VITE_SENTRY_DSN`     | DSN of a Sentry **browser** project. Unset: the SDK is not even emitted into the bundle. Environment comes from the hostname.      |
| Vercel env (build time) | `VITE_SENTRY_RELEASE` | Optional. Defaults to `cleffy@<VERCEL_GIT_COMMIT_SHA>`; set it only to match a release that source maps were uploaded under.       |

```bash
npx supabase secrets set --project-ref jibgwgosihadbjgxdsfe SENTRY_DSN='https://<key>@<org>.ingest.sentry.io/<project>'
```

- Use one Sentry project for the browser and one for the functions, or one for
  both; the environment tag keeps production and dev apart either way.
- Both sides scrub before sending: no annotation contents, no emails, no tokens,
  no URL query strings (`src/lib/monitoring/scrub.ts`, `_shared/errorLog.ts`).
  Keep it that way — the privacy policy promises it.
- `vercel.json`'s Content-Security-Policy already allows the ingest hosts
  (`https://*.ingest.sentry.io`, `*.ingest.us.sentry.io`, `*.ingest.de.sentry.io`);
  a DSN on any other host needs adding to `connect-src`, or browser reports are
  silently blocked (`tests/security/securityHeaders.test.ts` pins these).
- `VITE_SENTRY_DSN` is read at build time: redeploy after setting it.
- Sentry is a new processor of personal data (account ids, IP addresses at
  ingest); `docs/LEGAL_REVIEW.md` lists it.

## 3. Vercel project

### 3a. Add a GitHub Login Connection (human only)

Creating a git-linked project fails at the API with:

> Failed to link maxharris1/sheet_music_scribbler. You need to add a Login
> Connection to your GitHub account first.

Fix it once at **vercel.com/account/login-connections** → connect GitHub. This
is an account-level auth setting; no token or API call can substitute for it.

### 3b. Create the project

Team `maxharris1's projects` (`team_Ucc421wJMOxuAagxXETuQp13`), repo
`maxharris1/sheet_music_scribbler`, project name **cleffy**. Vercel
auto-detects Vite; `vercel.json` already supplies the SPA rewrite.

Production branch must be **main**.

### 3c. Domains — the only step left

The project exists: **cleffy** (`prj_aKb8bhLYHDA6P7DFb8F7bENTHUT8`), production
branch `main`, linked to the repo, building on every push. `cleffy.vercel.app`
is live and verified.

`cleffy.io` is already registered to the Vercel account **and already using
Vercel nameservers** (`ns1/ns2.vercel-dns.com`), and `dev.cleffy.io` already
resolves to Vercel's edge. **No registrar or DNS work is required.** What is
missing is only the project assignment — both hostnames currently answer:

```
HTTP 404  The deployment could not be found on Vercel.  DEPLOYMENT_NOT_FOUND
```

and HTTPS fails outright, because Vercel issues a certificate only once a
domain belongs to a project.

In **Project cleffy → Settings → Domains**, add:

| Domain          | Assign to                                                |
| --------------- | -------------------------------------------------------- |
| `cleffy.io`     | production (`main`)                                      |
| `www.cleffy.io` | redirect to `cleffy.io` (Vercel offers this when adding) |
| `dev.cleffy.io` | git branch **`dev`**                                     |

**The redirect runs the other way in practice.** `https://cleffy.io/` answers
`308` to `https://www.cleffy.io/`, so **www is the canonical production origin**,
not the apex. Both are in the live-origin list in
`supabase/functions/_shared/stripeMode.ts` and in `PRODUCTION_HOSTS` in
`src/lib/supabase.ts`, so billing and the backend choice are correct either way —
but anything that assumes the apex is what a buyer's browser sends is wrong.

Because the nameservers are already Vercel's, the records are created
automatically and certificates issue within a minute or two.

There is no API for this: the Vercel connector exposes domain _purchase_ tools
only (`buy_domain`, `check_domain_availability_and_price`, `get_domain_order`),
with nothing to attach an existing domain to a project.

## 3e. The `dev` branch — fixed

`dev` could not have served dev.cleffy.io usefully: built the way Vercel builds
it, the bundle contained no Supabase URL (no `.env.production` on that branch),
and with no `vercel.json` every deep link would have 404d, because Vercel's Vite
preset documents the catch-all rewrite as a step you perform rather than
supplying it.

Commit `710bd73` on `dev` adds both, plus the `!.env.production` exception its
`.gitignore` was missing — the blanket `.env.*` rule had been swallowing the
file. Typecheck and all 466 tests pass on that branch.

dev.cleffy.io shares the production Supabase project for now. To point it at a
separate backend later, override `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` for the Vercel **Preview** environment rather than
editing the committed file — a real environment variable wins under Vite 8,
which was verified rather than assumed.

## 4. Environment variables on Vercel

**Production needs none.** `.env.production` is committed and client-safe by
design, so the production build is self-configuring.

Preview/dev only needs variables once `dev.cleffy.io` points at a different
Supabase backend (§5). This was verified empirically rather than assumed: a real
environment variable **does** beat `.env.production` under Vite 8, so setting
these for the _Preview_ environment is enough to repoint the dev deploy.

```
VITE_SUPABASE_URL       = https://<dev-ref>.supabase.co
VITE_SUPABASE_ANON_KEY  = sb_publishable_…
```

Optional on either environment: `VITE_SENTRY_DSN` (and `VITE_SENTRY_RELEASE`)
to turn on browser error monitoring — see §2, _Error monitoring_.

## 5. A separate dev Supabase backend — done

`dev.cleffy.io` runs on its own Supabase project: the persistent branch **`dev`**
(`qdbnlrgylelelvwbkvnm`), a child of `jibgwgosihadbjgxdsfe`.

### It was not actually pointed there until 2026-08-28

This section previously said dev testing no longer wrote production rows. It
did. The repoint was supposed to come from `VITE_SUPABASE_*` overrides in the
Vercel **Preview** environment (§4), and those were never set — every
dev.cleffy.io deploy, up to and including the one built minutes before this was
written, shipped `https://jibgwgosihadbjgxdsfe.supabase.co` in its bundle.
Verify the claim rather than trusting it:

```bash
curl -s https://dev.cleffy.io/ | grep -o '/assets/index-[A-Za-z0-9_-]*\.js'
curl -s "https://dev.cleffy.io/assets/index-<hash>.js" | grep -o 'https://[a-z]\{20\}\.supabase\.co' | sort -u
```

Nothing failed while it was wrong, which is the point: a rule kept in a
dashboard is invisible to review, to CI, and to the repo. So the choice now
lives in the bundle — `supabaseConfig()` in `src/lib/supabase.ts` picks the
project from the hostname, cleffy.io and www.cleffy.io get production and every
other host gets the branch, with `src/lib/supabaseConfig.test.ts` holding it
there. An explicit `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` still wins,
which is what a local `.env` and the local stack set — and what a Vercel
environment variable would set if one is ever added.

The Edge Functions enforce the same rule independently, so it does not rest on
the client being right: production sets `STRIPE_MODES=live`, and its billing
functions refuse a sandbox caller outright (§0).

|                    |                                                         |
| ------------------ | ------------------------------------------------------- |
| Branch project ref | `qdbnlrgylelelvwbkvnm`                                  |
| URL                | `https://qdbnlrgylelelvwbkvnm.supabase.co`              |
| Git branch         | `dev`                                                   |
| Persistent         | yes — not auto-paused, not deleted when a PR closes     |
| Data               | none cloned from production; **not seeded** (see below) |
| Cost               | $0.01344/hr while running (~$9.80/mo), $0 while paused  |

Branch compute is **not covered by the Spend Cap**, so a branch left running
bills silently. Pausing is a deliberate act — see the release loop below.

### Configuration lives in `config.toml`

The branch deploy applies `config.toml` to the branch, so the `[remotes.dev]`
block at the bottom of that file is load-bearing: without it the branch would
inherit `auth.site_url = http://localhost:5173` and every auth redirect on
dev.cleffy.io would land on localhost.

Seeding is **off** for the branch. `seed.sql` creates `teacher@cleffy.local`
and `student@cleffy.local` with the password `cleffy-local-test`, which is
written down in `.cursor/README.md` — fine on a local stack, not on an
internet-facing host. Sign up a real account on dev.cleffy.io instead.

Because the branch is unseeded, the `scores` bucket can no longer come from
`seed.sql`; it is declared in `[storage.buckets.scores]` in `config.toml`, which
creates it on any environment built from that config.

### The release-test loop

The branch is tied to git `dev`, so a push to `dev` triggers a branch deploy.
That deploy's health step waits for branch services, so **a push while the
branch is paused will fail** — cosmetic, but expect it. Unpausing does not
retroactively apply migrations that landed while paused; a deploy has to run
after it is up.

```bash
supabase branches unpause dev --project-ref jibgwgosihadbjgxdsfe   # ~1 min
git push origin dev            # or re-run the deploy from the dashboard
# ...test dev.cleffy.io...
supabase branches pause dev --project-ref jibgwgosihadbjgxdsfe
```

### Edge Function secrets do not inherit

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_URL`, `ANTHROPIC_API_KEY`
and the `OMR_SERVICE_*` pair are set on production and are **not** copied to the
branch. Until they are set, billing / AI / OMR paths on dev.cleffy.io fail:

```bash
supabase secrets set --project-ref qdbnlrgylelelvwbkvnm STRIPE_SECRET_KEY=... APP_URL=https://dev.cleffy.io
```

### GitHub integration

GitHub App `supabase` is installed on **`maxharris1/Cleffy`** (working
directory `.`). The dashboard still used the pre-rename repo name in older
notes; the App follows the repo id, and checks/`supabase[bot]` comments land
on Cleffy.

**Deploy to production is ON.** Verified 2026-09-10 via
`GET /v1/projects/jibgwgosihadbjgxdsfe/branches`: the default branch
(`is_default`, project `jibgwgosihadbjgxdsfe`) has `git_branch: "main"`. That
field _is_ the dashboard **Deploy to production** switch (empty string = off).
There is no public Management API field named `deploy_to_production`; the
Studio form PATCHes `/v1/branches/{id}` with `git_branch`. Do not also add a
GitHub Action `db push` — two appliers would fight.

On merge to `main` the integration applies: pending SQL migrations, Edge
Functions declared in `config.toml` (including `imslp-sync` with
`verify_jwt = false`), and storage buckets from `config.toml`. Auth/API/seed
are ignored.

**Gate:** open a PR `dev` → `main`, approve it, merge with a **merge commit**
(not squash). That merge is the full deploy: Vercel already auto-deploys
`main` → cleffy.io; Supabase applies backend on the same merge. Do not merge
that PR until you intend to ship production.

The October launch-fix release has its own ordered checklist — see
[Release checklist](#release-checklist--launch-fixes-20261007) above.

**Automatic branching must stay OFF** (`new_branch_per_pr`). Confirm at
[Project Settings → Integrations](https://supabase.com/dashboard/project/jibgwgosihadbjgxdsfe/settings/integrations)
— toggle **Automatic branching**. The public API can _list_ GitHub connections
(`GET /v2/organizations/{slug}/integrations/github/connections`) but cannot
update them; Studio uses `/platform/integrations/github/connections/{id}`.
PR #32 spawned preview `cwxkhoqeqbhgakfafthd` (deleted after merge). If that
toggle is on, turn it off so feature branches do not bill.

**Still human:**

1. **Automatic branching** — confirm OFF on the Integrations page (above).
2. **Require a PR into `main`** — this sandbox cannot write rulesets
   (`403 Resource not accessible by integration`). From a PAT with
   `administration:write`:
   `GH_TOKEN=ghp_… bash scripts/protect-main.sh --require-pr --require-ci`
3. Vault `imslp_sync_url` / `imslp_sync_secret` are **not** created by GitHub.
   Chip browse works without them; cron refresh is a silent no-op until they
   exist (see SETUP_SUPABASE.md).

## 6. Smoke test — passed 2026-08-27

Run end to end against the live stack, not simulated:

| Step                                                  | Result                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Sign up via the public auth API                       | user created, session returned                                                     |
| `stripe-checkout` with a bogus price                  | `400 unknown_price` — the allowlist holds                                          |
| `stripe-checkout` with Teacher monthly                | Checkout session created; Stripe customer carries `metadata.user_id`               |
| `stripe-portal`                                       | returns a portal session URL                                                       |
| Subscription created in Stripe                        | webhook wrote `tier=teacher`, `status=trialing`, correct `price_id` and period end |
| Subscription cancelled                                | webhook wrote `tier=free`, `status=canceled`                                       |
| `get_entitlements` over PostgREST with the user's JWT | `tier=free` with the free ceilings                                                 |
| `stripe_events`                                       | both events recorded — idempotency table working                                   |

The tier mapping is the load-bearing result: **no `STRIPE_PRICE_*` Edge secret is
set**, so `teacher` was resolved purely from `PUBLISHED_PRICES` in
`_shared/stripe.ts`. The committed catalogue works in production.

### Cleaning up the smoke-test rows

The Supabase MCP runs SQL read-only, so these were left behind. Harmless — the
subscription is cancelled and free-tier — but to remove them, run in the SQL
editor:

```sql
delete from subscriptions      where user_id in (select id from auth.users where email like 'cleffy-smoke-%');
delete from billing_customers  where user_id in (select id from auth.users where email like 'cleffy-smoke-%');
delete from stripe_events      where type like 'customer.subscription.%';
delete from auth.users         where email like 'cleffy-smoke-%';
```

The sandbox Stripe customer and its cancelled subscription can stay; they are
test-mode records.

### Still worth doing

~~Enable "Switch plans" in the portal~~ — done for live on 2026-08-29; the
sandbox is still to be checked, and `stripe-checkout` now relies on it in both
modes (§1, _Checkout depends on it_).

## 7. Inbound support mail (Resend) — live

`support@cleffy.io` is meant to reach a human and, later, feed agentic triage.
Resend can receive on a custom domain, but **it cannot forward** — its own
[forwarding guide](https://resend.com/docs/knowledge-base/forward-emails-with-resend-inbound)
is webhook-plus-code, because the `email.received` webhook carries metadata only
and the body must be fetched from the Received Emails API. So forwarding is ours
to write, which is fine: the same endpoint is the triage entry point later.

Live as of 2026-08-29 and proven end to end: an email to `support@cleffy.io` is
received by Resend, signed with Svix, verified here, stored in
`support_messages` with its body, and forwarded to the mailbox in
`SUPPORT_FORWARD_TO`. Verified by sending a real message through it and reading
the resulting row (`has_body: true, forwarded: true, forward_error: null`); the
test rows were then deleted.

What exists:

| Piece                                 | What it does                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_shared/svixSignature.ts`            | Svix HMAC verification, import-free like `stripeSignature.ts` so vitest and Deno load the same file. Resend signs with Svix: `svix-id` / `svix-timestamp` / `svix-signature`, signed content `id.timestamp.body`, base64 digests, and the secret is the **base64-decoded** body of `whsec_…` — not its ASCII. |
| `resend-inbound/index.ts`             | Verifies, claims by `resend_email_id`, fetches the body, stores, then forwards. `verify_jwt = false`, like `stripe-webhook`.                                                                                                                                                                                  |
| `20260829130000_support_messages.sql` | The durable record. RLS on with no policy and every grant revoked — support mail is stranger-written and never belongs in a browser.                                                                                                                                                                          |
| `tests/support/svixSignature.test.ts` | 18 cases: round-trip, rotation, replay window, tampered body, wrong secret, wrong id.                                                                                                                                                                                                                         |

Order inside the handler is deliberate: **persist, then forward.** A forward that
fails leaves `forwarded_at` null — visible and replayable. Forwarding first and
failing to store would lose the message on the retry that then no-ops.

### ⚠️ Never call `POST /domains/{id}/verify` on a working domain

This cost a live outage on 2026-08-29. Enabling receiving adds a required MX
record, which moves the domain to `pending`; calling `/verify` then reset
**DKIM and SPF to pending as well**, and those had been verified for months.
Resend refuses to send from a domain that is not `verified`, so:

```
The cleffy.io domain is not verified.
```

**Supabase Auth sends through `smtp.resend.com` as `noreply@cleffy.io`** — check
`GET /v1/projects/{ref}/config/auth` before touching this domain. Password resets
and student email invites stop working while it is pending. Signups survive only
because `mailer_autoconfirm` is on.

Every DNS record was verified byte-for-byte against Resend's expected values
throughout; nothing in DNS was wrong, and no pre-existing record was altered.
Recovery is Resend's async re-check, which the dashboard's **Verify DNS Records**
button drives harder than the API does. Receiving was rolled back to `disabled`
to return the required set to its original three records.

The apex `MX inbound-smtp.us-east-1.amazonaws.com` (priority 10) is still in
Vercel DNS and inert while receiving is off. Re-enabling receiving is what makes
it live — and note Resend requires it to be the **lowest-priority** MX on the
domain.

### Two API traps this cost, both worth remembering

**The receive endpoint is `GET /emails/receiving/{id}`, not `/emails/received/{id}`.**
The wrong spelling returns `405`, not `404`, so it reads like a method problem
rather than a wrong path. With no body fetched, the forward then fails
`422 Missing \`html\` or \`text\` field` — a message that blames the send when the
fault is upstream. The handler now records the fetch failure on the row and
refuses to attempt a bodyless forward, so the row names the real cause.

**`support_email` cannot be set through the Stripe API.** `POST /v1/accounts/{id}`
answers _"You cannot use this method on your own account: you may only use it on
connected accounts."_ It is a dashboard field, like the portal configuration —
live dashboard → Settings → Business → Public business information.

### State

| Piece                     | Where                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| Resend domain `cleffy.io` | verified, sending **and** receiving enabled                                               |
| Inbound MX (apex)         | `inbound-smtp.us-east-1.amazonaws.com` priority 10, in Vercel DNS                         |
| Webhook                   | `ea73d8be-19ec-45f9-9cd8-ebf4a2ff681f` → `/functions/v1/resend-inbound`, `email.received` |
| Edge secrets              | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SUPPORT_FORWARD_TO`, `SUPPORT_FORWARD_FROM`   |
| `resend-inbound`          | ACTIVE on production, `verify_jwt = false`                                                |
| `support_messages`        | applied to production and the `dev` branch                                                |

The signature gate was checked against the deployed endpoint, not only in tests:
unsigned → `missing_header`, forged → `signature_mismatch`, stale timestamp →
`timestamp_out_of_tolerance`, and no row was written by any of them.

## 8. Auth password policy — must be set on both projects

Every new password is checked in the browser (and in `student-claim`) against
`supabase/functions/_shared/passwordPolicy.ts`: at least 8 characters, at least
one ASCII letter and one digit, at most 72 bytes. GoTrue is the authority, and
`config.toml` only configures the local stack (and the `dev` branch, if its
deploy applies config). Set the hosted projects explicitly, production AND the
`dev` branch, with a Management API token:

```bash
for ref in jibgwgosihadbjgxdsfe qdbnlrgylelelvwbkvnm; do
  curl -sS -X PATCH "https://api.supabase.com/v1/projects/$ref/config/auth" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"password_min_length": 8, "password_required_characters": "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789"}'
done
```

`password_required_characters` takes the character SETS, colon-separated: the
string above is the API's enum value for "letters and digits" (one set of
letters, one of digits) — the same value the CLI writes for
`password_requirements = "letters_digits"`. Check it with a `GET` on the same
path before and after; the dashboard (Authentication → Policies → Password
strength) shows it as "Letters and digits". Existing accounts keep working:
GoTrue checks strength only where a password is set, never at sign-in, and the
app does the same.

Leaked-password protection (`"password_hibp_enabled": true` in the same
payload) is flagged by the security advisor on both projects. It needs a paid
plan; when it is on, a breached password is refused with
`weak_password`/`reasons: ["pwned"]`, which `mapAuthError` already words.

## 9. Student sign-in limiter — migration BEFORE the functions

`student-login` now limits attempts per username
(`supabase/functions/_shared/loginThrottle.ts`) through the
`begin_login_attempt` / `clear_login_attempts` / `clear_login_account` RPCs
created by `20261007120501_student_login_throttle.sql`. Two limits:

- **Per username + address**: 5 tries, then locks of 30 s doubling to 15 min
  for that address only. Someone hammering a classmate's username locks out
  their own address, not the classmate signing in from elsewhere.
- **Per username, all addresses**: 30 attempts per hour, to cap guessing from
  many addresses. No real student gets near it.

The limiter fails CLOSED: if the RPCs are missing, every username sign-in is
refused with "Too many sign-in attempts". So on each project, apply the
migration first, then deploy all three functions that use it
(`student-provision` and `student-claim` clear a username's limits on a
teacher's reset and on a successful claim):

```bash
supabase functions deploy student-login --no-verify-jwt
supabase functions deploy student-claim --no-verify-jwt
supabase functions deploy student-provision
```

Keys are HMAC-SHA-256 of the username (and of the client address) under
`LOGIN_THROTTLE_SECRET` if that function secret is set, otherwise under the
service-role key, so the table holds neither names nor addresses. A dedicated
secret is optional and recommended
(`supabase secrets set LOGIN_THROTTLE_SECRET=$(openssl rand -hex 32)`); setting
or rotating it, or rotating the service-role key while it is unset, simply
resets all counters.

A student locked out at the account ceiling waits for the hour to end, or the
teacher issues a fresh setup card ('reset'), which clears every limit on that
username; claiming the card clears them again for the name the student picks.
Because the keys are HMAC'd, a lock cannot be lifted by hand from the table
without the secret; use the reset.

## 10. Realtime capacity

**The Supabase organisation "Cleffy" (`hgiyoueenqqdfhqgilsp`), which holds
"Cleffy Main" (`jibgwgosihadbjgxdsfe`) and its `dev` branch, is on the Pro
plan** (`get_organization` → `plan: pro`, checked 2026-10-10). An earlier note
here said Free; that read the wrong organisation. Pro gives, per organisation:

| Pro plan               | Limit                                                                      |
| ---------------------- | -------------------------------------------------------------------------- |
| Realtime messages      | **5 M / month** included, then $2.50 per million; shared by prod and `dev` |
| Concurrent connections | **500** (one per open score tab; both topics share it)                     |
| Messages per second    | **500/s** (2,500/s with the Spend Cap off)                                 |
| Inactive projects      | never paused                                                               |

Current figures: <https://supabase.com/docs/guides/realtime/limits>,
<https://supabase.com/docs/guides/realtime/quotas>. The per-second limit is
what the 25-person load test hit on `dev`; see below for how the client now
copes.

### How Cleffy spends messages

Realtime bills each broadcast once as sent and once per member it reaches, so
every message below costs about N for a room of N people:

- **Live ink** (`ink:progress` on `doc:{id}`, only while someone else is there):
  one batch per 10 ms × N, kept between 80 ms and 250 ms, plus one at pen-up
  (`src/sync/realtimeChannel.ts`). A one-second stroke is ~13 batches one-to-one
  and 4 at 25 people (c08a922 sent ~10 at any size).
- **Committed rows** (`doc-db:{id}`, database trigger): one per saved stroke,
  recolour or erase.
- **Presence**: one per join and per page change, at most one per user every
  2 s.

Per one-second stroke that is about N × (batches + 1): **~28 messages** in a
one-to-one lesson, ~110 at 10 people, **~125 at 25** (it was ~250 at c08a922,
measured in the load test).

| Lesson-hour (estimate, not measured)                              | Messages   |
| ----------------------------------------------------------------- | ---------- |
| One-to-one, ~400 strokes, page turns                              | **~12 k**  |
| Group of 10: teacher every 10 s, students 30 strokes each         | ~75 k      |
| Group of 25: same pattern, plus everyone's page turns             | **~175 k** |
| Stress pattern: all 25 drawing a stroke every 2 s, the whole hour | ~5–6 M     |

So the 5 M included each month is ~415 one-to-one lesson-hours or ~28
large-group ones, across the whole org including dev testing; beyond that the
overage is about $0.03 per one-to-one lesson-hour and $0.45 per 25-person one.

The stress pattern also exceeds Pro's 500 messages/s (~1,500/s). The client now
copes rather than breaking — see below — but sessions where everyone draws at
once at that size need the Spend Cap off (2,500/s), a Supabase limit increase,
or a product decision such as streaming live ink from the teacher only.

### What the client does when Realtime pushes back

Fixed after the 2026-10 load test (QA B3/B11):

- The server's "Too many messages per second" (a `system` error, then it closes
  the channel) used to leave a viewer with no live updates until reload:
  realtime-js never re-joins a channel the server closed, and the 15 s pull
  stopped too. Now every drop re-joins with jittered exponential backoff (1 s
  to 30 s, at least 2.5 s after a rate-limit notice), the pull keeps running
  whenever `doc-db:{id}` is not joined, and a gap-fill pull follows the re-join.
- Each rate-limit notice (or join refused for the same reason) doubles the
  ink cadence and presence gap; after three, mid-stroke previews stop and a
  stroke streams once, whole, at pen-up. A level wears off every 30 s without a
  new notice. Committed strokes never depend on this channel: they go through
  the outbox and the database.

Watch Organization → Usage → Realtime messages for the first weeks after
launch and compare it with the table above.

### Measured on `dev`, 2026-10-12 (a81eaae, the app's own sync code)

N Node clients ran the real `SyncEngine`, `AnnotationStore` and
`DocRealtimeChannel`; each drew a 1 s stroke every 2 s for 2 minutes. A
headless Chromium viewer watched the 25-person run. "Billed" counts each send
plus each delivery, plus the trigger's row broadcast.

|                                    | N=5        | N=10        | N=25                    |
| ---------------------------------- | ---------- | ----------- | ----------------------- |
| Billed messages per stroke         | 71         | 99          | 95 (previews throttled) |
| Messages/s mean / peak             | 175 / 237  | 489 / 698   | 1,084 / 2,612           |
| Saved stroke reaches others p50/95 | 174/364 ms | 190/411 ms  | 224/755 ms              |
| Live ink p50 / p95                 | 46 / 61 ms | 49 / 90 ms  | 60 / 262 ms             |
| "Too many messages" closes         | 0          | 7           | 211 (18 of 25 clients)  |
| Re-joined / recovery p95           | —          | all / 5.0 s | all / 24.7 s            |
| Everyone ends with the same marks  | ✅         | ✅          | ❌ before the fix below |

One-to-one measured 29 messages per stroke. Every re-join honoured
the backoff bounds and the polling fallback kept marks flowing while up to 18
of 25 clients had `doc-db` down; the viewer stayed responsive (p95 timer lag
≤ 260 ms). The test used ~225 k messages.

The ❌: a gap-fill pull asked for while another pull was in flight was
dropped, so rows committed while `doc-db` was down could be skipped for good
once live rows carried the watermark past them. `SyncEngine.pullSince` now
runs one more pull after the in-flight one instead (regression test in
`syncEngine.test.ts`, "while a pull is in flight").

At ~500 msg/s, one 10-person lesson where everyone draws at once already
reaches Pro's limit; the realistic patterns in the table above fit ~20 such
lessons at once.

## Migration history — reconciled 2026-08-27

Production and the `dev` branch were both hard-reset and rebuilt from
`supabase/migrations/`. They now carry the **same 22 migrations** — verified by
identical fingerprints (`md5` over the ordered version list):

|                                     | migrations | tables | users | storage objects | fingerprint |
| ----------------------------------- | ---------- | ------ | ----- | --------------- | ----------- |
| production `jibgwgosihadbjgxdsfe`   | 22         | 22     | 0     | 0               | `4f0bca6b…` |
| `dev` branch `qdbnlrgylelelvwbkvnm` | 22         | 22     | 0     | 0               | `4f0bca6b…` |

The previous divergence (25 applied in production, 4 at versions in no branch, 8
under different timestamps) is gone. Deploy-to-production is on (§5); apply
production by merging `dev` → `main`, not a second `db push`.

All prior data was intentionally discarded in the reset: 40 users, 46 documents,
1,063 annotations and 47 uploaded PDFs. The Stripe sandbox subscription that
existed was **not** cancelled — it lives in Stripe, and the database row backing
it is gone, so clean it up in the Stripe dashboard if it still matters.

### Resetting a remote database — two traps

`supabase db reset --linked --project-ref <ref>` is the tool, but as of CLI
2.115.0:

1. **It drops tables but not sequences**, so the re-apply dies on
   `relation "annotations_seq" already exists (SQLSTATE 42P07)` — leaving the
   database empty and half-built. Drop the leftovers first, then re-run:

    ```sql
    do $$ declare r record; begin
      for r in select sequencename from pg_sequences where schemaname='public' loop
        execute format('drop sequence if exists public.%I cascade', r.sequencename);
      end loop;
    end $$;
    ```

2. **`supabase storage rm` silently no-ops** — it returns `{"deleted":[]}` and
   removes nothing, for a bucket path or a single explicit object. Use the
   Storage API instead:

    ```bash
    curl -X DELETE "$URL/storage/v1/object/scores" -H "Authorization: Bearer $SERVICE_KEY" \
         -H 'Content-Type: application/json' -d '{"prefixes":["<path>","<path>"]}'
    ```

Note `db reset --linked` **does** clear `auth.users`, but does **not** touch
storage. Pass `--no-seed` against any hosted environment: `seed.sql` creates
accounts whose password is documented in `.cursor/README.md`.

### Why `core_table_grants` exists

On the **local** Docker Postgres image, the default ACL depends on who creates
the object: tables created by `supabase_admin` grant `arwdDxtm` to
anon/authenticated, tables created by `postgres` grant only `Dxtm`. Migrations
run as `postgres`, so every table `schema.sql` created was unreadable and
PostgREST answered `42501 permission denied for table documents` before RLS was
ever consulted.

The hosted images do **not** behave that way — a rebuilt branch shows
`authenticated=arwdDxtm` on every table from the default ACL alone. So
`20260827140000_core_table_grants.sql` is load-bearing locally and a no-op
hosted, which the rebuild confirmed. Keep it: it makes the grant explicit rather
than dependent on which image an environment happens to run, and any new table
should grant explicitly for the same reason.

---

## Recovery and disaster recovery — four things that do not work today

> **Historical once production is rebuilt** by _Go-live 2026-10_. The reset
> and the replay write every migration's body, which retires **R1**'s NULL
> row. Its landmine is then closed by P1's live-only config row, not by
> production's hand-applied narrowing.
>
> **R2**'s tables are dropped from production by the wipe. The go-live dump
> and the `dev` branch project then hold the only copies, until PR #52 lands
> their migrations.
>
> **R3**'s two statements stay correct for any logical restore (_PITR_ in the
> go-live). **R4** applies only during the go-live merge itself.
>
> The findings below are as measured on 2026-10-12, against the old
> production.

The 2026-10-12 rehearsal replayed all 30 pending migrations against a copy of
production's data and **passed**: 30/30 clean, no table rewrite, no dropped
column, not one of production's 10,931 rows altered. The push is safe.

What is not safe is the recovery path. Four separate findings, none of which
blocks the push and all of which make "we can roll back" or "we can restore"
untrue as written. **Nothing below has been applied to any database** — the
observations are read-only reads of production, and the repairs are for a human
to run deliberately, not steps the deploy performs.

The one constraint that shapes all of it: `GET /v1/projects/{ref}/database/backups`
reports `walg_enabled: true` and **`pitr_enabled: false`**. There are seven daily
physical backups and nothing finer. A physical restore is therefore not a
rollback — it is a jump back to that morning's snapshot that discards every user
write since, and it cannot be aimed at "the moment before the push". Treat it as
a disaster option. The real rollback is forward-only SQL, and the real backup is
a logical dump taken immediately before the push (which is where R3 bites).

### R1. Production's migration history cannot rebuild production

```sql
select version, name, statements is null
from supabase_migrations.schema_migrations
where version = '20260828180000';
-- 20260828180000 | billing_stripe_mode | t
```

`20260828180000_billing_stripe_mode` is recorded on production with
**`statements = NULL`**, and it is the only row in the table that is (re-checked
read-only 2026-10-12; 27 rows, head `20260830101624`). The migration _is_ applied
to the live schema — the `mode` columns are there — but its body was never
recorded, so the history is a list of names with one hole in it.

Anything built by replaying that history — a preview branch, a staging
environment, a `supabase db reset`, a DR rebuild — comes up **without**
`billing_customers.mode`, `subscriptions.mode`, the
`billing_customers_pkey (user_id, mode)` composite primary key, the
`subscriptions_user_mode` index and `entitling_billing_modes()`, and with the
pre-mode body of `get_entitlements()`. Migration 15,
`20261007120300_billing_correctness.sql`, then **fails** there: it references
`s.mode` and `public.entitling_billing_modes()`. This is why the rehearsal's
clean preview branch had to be remediated by hand before it could stand in for
production at all, and it is why branch-based QA cannot currently be trusted to
have tested what production will run.

#### The landmine — read this before repairing anything

The single migration whose body was never recorded is _exactly_ the one whose
shipped body would re-open test-mode billing.

`20260828180000_billing_stripe_mode.sql` ships
`select array['live', 'test']::text[]`. Production's live
`entitling_billing_modes()` is the hand-applied `select array['live']::text[]`
from §0's live-flip step — which exists in this repository **only as the comment
at lines 46-56 of that migration**, in no migration anyone can run (verified
read-only 2026-10-12: production's body is the narrowed one). So a
rebuild-from-migrations, or any future `create or replace` of that function,
silently re-enables **test-mode subscriptions entitling in production**: Stripe's
published test card buying a real plan. And because `statements` is NULL, no
drift check that reads the recorded history can see the difference.

Two things follow.

- **The 1.0 push itself is safe.** None of the 30 pending migrations re-creates
  `entitling_billing_modes()` — they only call it — so the push preserves
  production's narrowing. `tests/migrationRecoverability.test.ts` now asserts
  that the function is redefined in exactly one migration, so a second
  definition cannot arrive unnoticed.
- **Repairing R1 makes the landmine reachable.** Today the NULL row hides it by
  accident: a rebuild from production's history has no
  `entitling_billing_modes()` at all and dies at migration 15. Once `statements`
  carries the shipped body, a rebuild succeeds and comes up entitling **both**
  modes. For a preview or staging environment that is the correct answer and what
  the migration's comment intends. For a DR rebuild **of production** it is
  wrong, and re-narrowing it is a mandatory step of that rebuild. Folding the
  narrowed body into a ref-guarded migration (Phase 1 finding F3) is the real
  fix; until that exists, the repair below has to be paired with the manual
  re-narrowing.

#### The repair

Neither option touches the live schema. `statements` is metadata consumed when an
environment is rebuilt from history, so repairing it is safe for a running
production — and it does **not** mean re-running the migration, which is already
applied.

**Option A, preferred — let the CLI write the row.**

```sh
supabase link --project-ref jibgwgosihadbjgxdsfe
supabase migration repair --status reverted 20260828180000 --linked
supabase migration repair --status applied  20260828180000 --linked
```

Reverted-then-applied rather than `applied` alone, because `applied` on a version
that is already present depends on the CLI's `ON CONFLICT` clause, which the
shipped binary does not expose: CLI 2.103.0's `migration repair` is a thin
wrapper that shells out to the legacy Go CLI (`legacy.migration.repair`), so the
SQL is not readable from the installed artifact and whether it overwrites a
non-NULL-to-NULL `statements` cannot be established without running it. Deleting
the row first removes the question: the insert path is the same one `db push`
uses to record every migration, and that path demonstrably writes `statements`.
The history is one row short between the two commands, which is harmless because
nothing replays in between — but do not stop halfway.

Note `migration repair` needs a **direct Postgres connection and the project
password**, not the Management API. From this sandbox that is possible (see
`.claude/skills/supabase-ops/SKILL.md`, _Applying migrations_); it is not a
reason to reach for Option B.

**Option B, fallback — write the row by hand.** Use this only if the CLI cannot
reach the database, or if Option A is observed to leave `statements` NULL.

```sql
update supabase_migrations.schema_migrations
set name = 'billing_stripe_mode',
    statements = array[$mig$ -- paste supabase/migrations/20260828180000_billing_stripe_mode.sql verbatim
$mig$]
where version = '20260828180000';
```

`$mig$` is safe as the quote tag: the file's own dollar quoting is `$$`. The
one-element array is not a guess — it is a shape production already carries.
`20260830101624` has `array_length(statements, 1) = 1` with a 862-character
element against an 865-byte file, i.e. the whole file in one element, while
`20260827140000` has 10 elements whose `array_to_string(statements, ';')` is 2,410
characters against a 2,426-byte file, i.e. split on statement boundaries with the
separators dropped. Both shapes replay, so there is no canonical decomposition to
reproduce and the whole-file element is the one a human can get right.

Confirm either way, and expect `f`:

```sql
select version, statements is null, array_length(statements, 1),
       length(array_to_string(statements, ';'))
from supabase_migrations.schema_migrations
where version = '20260828180000';
```

### R2. Four production tables and three functions exist in no migration on `main`

`pd_pdf_store` (2,402 rows), `playalong_corpus_seed` (8,215), `playalong_corpus`
(0) and `playalong_corpus_control` (1) — 10,618 rows, including the two largest
tables in production — plus `playalong_corpus_get_by_hash()`,
`playalong_corpus_put()` and `playalong_corpus_get_by_layout()` exist on
production and on the `dev` branch project, created out of band (see _Before the
merge_ step 1, which records the five history rows that were removed in the
2026-10-08 repair). No migration on `main` or on `dev` creates them, so nothing
in the repository can recreate them: a `supabase db diff`-generated migration, a
branch merge or a schema reset can drop all 10,618 rows and the only copy is
production itself.

**What closes this is merging PR #52** (`dev` ← `mh/playalong-on-dev-ab47`), which
carries six migrations that create and then evolve every one of the seven objects
— `20260916140000_playalong_corpus.sql`, `…150000_playalong_corpus_seed_bucket.sql`,
`…160000_…edition_signals.sql`, `…180000_…imslp_origin.sql`,
`…190000_…imslp_pause.sql` and `20260924120000_…hash_prefers_symbolic.sql` — every
statement guarded (`if not exists`, `drop constraint if exists`,
`create or replace`, `on conflict do nothing`) precisely so they replay over the
objects production already has.

Their cumulative end state was diffed against production's live DDL read
read-only on 2026-10-12, and it is faithful: all 60 columns of the four tables
match on name, `attnum` order, type, NOT NULL and default (including the columns
the later files add — `playalong_corpus_seed`'s `us_pd`, `attempts`,
`candidate_url`, `edition` and `playalong_corpus_control`'s `imslp_paused_until`,
`imslp_pause_reason`); all 10 constraints match, including the three-column
`playalong_corpus_pkey`, `playalong_corpus_seed_pkey (work_title, origin, filename)`,
`playalong_corpus_control`'s `singleton` primary key with its `CHECK (singleton)`,
and `pd_pdf_store_origin_check` after `…180000` drops and re-adds it to admit
`imslp`; both non-primary-key indexes match; RLS is enabled with zero policies on
all four, as on production, with `grant all … to service_role` and EXECUTE
revoked from public/anon/authenticated and granted to `service_role` alone, which
is production's ACL (`{postgres=X/postgres,service_role=X/postgres}`).

One difference, and it runs the safe way. Production's
`playalong_corpus_get_by_hash()` is the body from `20260916140000`;
`20260924120000` adds `(c.symbolic_source is distinct from 'omr') desc` to its
`order by` so a symbolic row outranks an OMR row for the same bytes, and
production never received that file. So merging #52 **advances** production by
that one function body, which is the intent of the file. Nothing production has
is lost, and the other two function bodies are byte-identical after whitespace
normalisation.

**If #52 stalls, the exposure stays open**, and it is the largest irreplaceable
data risk in the project: 10,618 rows that no migration can rebuild, on a project
with no PITR. Either merge it or lift its corpus migrations onto `dev`
separately — and that means **all six**, not the first two. Which file supplies
what:

| File                                        | What only it carries                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `20260916140000_playalong_corpus.sql`       | `playalong_corpus`, `playalong_corpus_seed`, `playalong_corpus_control` and all three functions |
| `…150000_playalong_corpus_seed_bucket.sql`  | `pd_pdf_store`; the seed's `us_pd`, `attempts`, `candidate_url`                                 |
| `…160000_…edition_signals.sql`              | `edition jsonb` on `pd_pdf_store` **and** on `playalong_corpus_seed`                            |
| `…180000_…imslp_origin.sql`                 | `pd_pdf_store_origin_check` re-added to admit `imslp`                                           |
| `…190000_…imslp_pause.sql`                  | `playalong_corpus_control.imslp_paused_until`, `imslp_pause_reason`                             |
| `20260924120000_…hash_prefers_symbolic.sql` | `playalong_corpus_get_by_hash()` preferring a symbolic row over an OMR one                      |

The first two alone do close this finding's own exposure — every one of the seven
objects becomes recreatable from the repository — but they do **not** reproduce
production's schema, and the gap is the quiet kind. A database built from them
has no `edition` column for the importer's signals to land in and an
`origin` CHECK that refuses `imslp`, so the failure does not arrive as a
migration that fails: it arrives later, as rows the app cannot store, in whatever
environment was rebuilt. If the first two are lifted on their own to stop the
data risk, the other four are not optional follow-up — they are the rest of the
same schema, and nothing may write an IMSLP-sourced row or an edition signal in
that environment until they are in.

`tests/migrationRecoverability.test.ts` fails on exactly that partial state: once
any migration creates these tables, it requires the two `edition` columns, the
`imslp`-admitting CHECK and the pause columns to be somewhere in the tree.

Do not write a second capture of the same seven objects — two sources of truth
for the same DDL is how they drift.

### R3. A naive logical restore of production is broken today

`public.omr_jobs.id` is `bigint generated always as identity`
(`20260806120000_omr_jobs.sql`, and it is the only such column in the schema —
`pg_attribute.attidentity = 'a'`, sequence `public.omr_jobs_id_seq`, confirmed
read-only 2026-10-12). A production-to-environment copy written the obvious way
is **rejected outright**:

```
ERROR: cannot insert a non-DEFAULT value into column "id"
DETAIL: Column "id" is an identity column defined as GENERATED ALWAYS.
```

It needs the override, and then the sequence has to be moved past the restored
rows or the first insert after the restore dies on a duplicate key:

```sql
-- inside the restore transaction, with session_replication_role = replica
insert into public.omr_jobs overriding system value
select * from <source>;

-- and afterwards, or the next enqueue collides on omr_jobs_pkey
select setval(
    pg_get_serial_sequence('public.omr_jobs', 'id'),
    coalesce((select max(id) from public.omr_jobs), 0) + 1,
    false
);
```

`select *` relies on the source and target having identical column order, which a
same-version copy does; `session_replication_role = replica` is what the rehearsal
used to load all 28 public tables in one 10.6-second transaction without firing
triggers or ordering around foreign keys.

Both statements are only right while the column is still `generated always`, and
one `alter table public.omr_jobs alter column id set generated by default` in any
later migration would make them wrong quietly: `OVERRIDING SYSTEM VALUE` on a
by-default column is accepted and ignored, so the copy would succeed and the
skipped `setval` would surface as a primary-key collision on the next enqueue.
`tests/migrationRecoverability.test.ts` pins both halves — that the column is
defined `generated always` in exactly one migration, and that no migration
relaxes or drops that identity afterwards.

This is the step that makes "we can restore production" false rather than slow.
Combined with **R2** (the largest tables are not in any migration, so a rebuilt
schema has nowhere to restore them _to_) and `pitr_enabled: false`, the honest
statement today is: the migration is safe to run, and the plan for what to do if
it is not would not work. Both must be fixed before the push, and the pre-flight
logical dump has to be taken with the two statements above in it — a backup that
silently skips `omr_jobs` is discovered at the worst possible moment.

### R4. Pause `imslp-sync` across the push

`20260902120000_imslp_category_index.sql` ends with

```sql
select cron.schedule ('imslp-sync', '*/2 * * * *', $$select public.imslp_sync_tick ()$$);
```

That is **migration 3 of the 30**, so the job goes live 27 migrations early.
Measured on the rehearsal: it began firing immediately after migration 3 committed
and ran 9 times during the push, including ticks inside migration 9's 102-second
`AccessExclusiveLock` on `imslp_works`. All 9 runs succeeded in under 62 ms and
nothing broke — but that is partly luck. For migrations 3-10 the job calls an
`imslp_sync_tick()` that later migrations redefine, against tables migration 10
drops, and it issues outbound `pg_net` HTTP to IMSLP from production from
migration 3 onward.

So, as part of the serial push:

```sql
-- immediately after migration 3 (20260902120000) commits
update cron.job set active = false where jobname = 'imslp-sync';

-- only after migration 10 (20260910160001) commits
update cron.job set active = true where jobname = 'imslp-sync';
```

**Leave `omr-sweep` alone.** Production already runs it every minute
(`20260806140000_omr_cron.sql`, scheduled long ago; read-only check on 2026-10-12
shows exactly one job, `omr-sweep`, active, and no `imslp-sync` yet). It reaps
expired OMR leases and purges the score cache; deactivating it stalls OMR for the
duration, and no migration in the pending set re-schedules it, which
`tests/migrationRecoverability.test.ts` pins.
