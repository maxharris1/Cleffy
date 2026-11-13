-- First-party web events and sign-up attribution.
--
-- What it answers: an email click -> /try -> sign-up -> paid, counted in our
-- own database. No IP address, no user agent, no third-party tracker, and no
-- user id for a visitor who is not signed in.
--
-- * public.web_events: one row per page view or funnel action. The browser
--   sends them in batches through public.record_web_events (src/lib/webEvents.ts).
-- * public.signup_attribution: the first-touch campaign tags a sign-up carried
--   (src/lib/attribution.ts -> options.data.attribution in signUpWithPassword),
--   written by an AFTER INSERT trigger on auth.users.
--
-- Who is never recorded, enforced here and not only in the browser: roster
-- students (app_metadata.user_type = 'student', admin-set by
-- student-provision -- the flag userTypeOf() and monitoringUserIdOf() read)
-- and guests (anonymous accounts, is_anonymous). The RPC drops every event
-- from such a JWT, and also when the caller's auth.users row says so, so a
-- token minted before the flag was set cannot slip through. The trigger skips
-- them the same way.
--
-- Neither table has a policy or a client grant: nobody reads them but the
-- service role (the weekly aggregate in the PR description). Explicit grants,
-- as 20261022100000_explicit_service_role_grants.sql (BL-3): hosted projects'
-- default ACL hands anon and authenticated everything on a new table, so the
-- revoke is load-bearing there.
--
-- Paths: only a route pattern listed in public.web_route_patterns() is ever
-- stored (record_web_events drops any other event; the trigger leaves
-- landing_path null). The browser sends the same patterns (routePatternOf), so
-- this only bites a hand-made call: it can never store a raw /join/<token> or
-- /doc/<uuid>.
--
-- Retention: events older than 13 months are purged daily by pg_cron. An
-- account's attribution and events go with the account (on delete cascade).
--
-- Rerunnable: if not exists / create or replace / drop ... if exists.

create table if not exists public.web_events (
    id bigint generated always as identity primary key,
    occurred_at timestamptz not null default now(),
    event text not null constraint web_events_event_check
        check (event in ('page_view', 'demo_visit', 'signup_click', 'signup_completed')),
    -- A route pattern from src/app/routes.tsx ('/join/:token'), or '*' for an
    -- unknown path: never a token, an id or a query string.
    path text constraint web_events_path_check
        check (char_length(path) <= 200 and path ~ '^(\*|/[A-Za-z0-9/:._-]*)$'),
    utm_source text constraint web_events_utm_source_check check (utm_source ~ '^[A-Za-z0-9._-]{1,100}$'),
    utm_medium text constraint web_events_utm_medium_check check (utm_medium ~ '^[A-Za-z0-9._-]{1,100}$'),
    utm_campaign text constraint web_events_utm_campaign_check check (utm_campaign ~ '^[A-Za-z0-9._-]{1,100}$'),
    utm_content text constraint web_events_utm_content_check check (utm_content ~ '^[A-Za-z0-9._-]{1,100}$'),
    utm_term text constraint web_events_utm_term_check check (utm_term ~ '^[A-Za-z0-9._-]{1,100}$'),
    -- The referring page's host name only, lower case; never its URL.
    referrer_host text constraint web_events_referrer_host_check
        check (referrer_host ~ '^[a-z0-9.-]{1,253}$'),
    device_class text constraint web_events_device_class_check
        check (device_class in ('mobile', 'tablet', 'desktop')),
    -- Random per browser tab (sessionStorage); not tied to the account.
    session_key uuid not null,
    -- Only ever auth.uid(), set by record_web_events.
    user_id uuid references auth.users (id) on delete cascade
);

create index if not exists web_events_event_occurred_at_idx on public.web_events (event, occurred_at);

create index if not exists web_events_session_key_occurred_at_idx on public.web_events (session_key, occurred_at);

-- For the per-user daily cap in record_web_events, and the cascade on account
-- deletion, which would otherwise scan the table.
create index if not exists web_events_user_id_occurred_at_idx on public.web_events (user_id, occurred_at)
where user_id is not null;

create table if not exists public.signup_attribution (
    user_id uuid primary key references auth.users (id) on delete cascade,
    utm_source text constraint signup_attribution_utm_source_check check (utm_source ~ '^[A-Za-z0-9._-]{1,100}$'),
    utm_medium text constraint signup_attribution_utm_medium_check check (utm_medium ~ '^[A-Za-z0-9._-]{1,100}$'),
    utm_campaign text constraint signup_attribution_utm_campaign_check check (utm_campaign ~ '^[A-Za-z0-9._-]{1,100}$'),
    utm_content text constraint signup_attribution_utm_content_check check (utm_content ~ '^[A-Za-z0-9._-]{1,100}$'),
    utm_term text constraint signup_attribution_utm_term_check check (utm_term ~ '^[A-Za-z0-9._-]{1,100}$'),
    landing_path text constraint signup_attribution_landing_path_check
        check (char_length(landing_path) <= 200 and landing_path ~ '^(\*|/[A-Za-z0-9/:._-]*)$'),
    first_seen_at timestamptz,
    created_at timestamptz not null default now()
);

alter table public.web_events enable row level security;

alter table public.signup_attribution enable row level security;

revoke all on table public.web_events, public.signup_attribution from public, anon, authenticated;

grant all on table public.web_events, public.signup_attribution to service_role;

-- ---------------------------------------------------------------------------
-- web_route_patterns: the route patterns a web event's path or a sign-up's
-- landing_path may hold, besides '*' (the not-found route). This is
-- ROUTE_PATTERNS in src/app/routePatterns.ts, which is every path routes.tsx
-- declares; src/app/routePatterns.test.ts fails when they differ. A new route
-- therefore needs a migration that redefines this function. Until it lands,
-- events on that route are dropped and its landing_path is null: data is
-- lost, nothing breaks.
-- ---------------------------------------------------------------------------
create or replace function public.web_route_patterns () returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
    select array[
        '/',
        '/login',
        '/register',
        '/forgot-password',
        '/update-password',
        '/student',
        '/student/claim',
        '/student/welcome',
        '/assignments',
        '/library',
        '/search',
        '/students',
        '/account',
        '/admin/reports',
        '/settings',
        '/doc/:documentId',
        '/try',
        '/join/:token',
        '/auth/callback',
        '/privacy',
        '/children-privacy',
        '/terms',
        '/cancel',
        '/refunds',
        '/copyright',
        '/report',
        '/account-deleted'
    ]::text[]
$$;

revoke all on function public.web_route_patterns () from public, anon, authenticated;

grant execute on function public.web_route_patterns () to service_role;

-- ---------------------------------------------------------------------------
-- record_web_events: the browser's only way in.
--
-- A batch is up to 20 events. Every event is checked before any is stored,
-- and one bad event refuses the whole batch (22023): the browser validates
-- the same rules, so a refusal is a bug to see, not data to half-keep. An
-- event may carry only the keys below -- no user_id, no timestamp.
--
-- A path must also be '*' or listed in web_route_patterns(). One that has the
-- right shape but is not listed (a raw /join/<token>, /doc/<uuid>, or a route
-- this database does not know yet) drops that event only, quietly: a client
-- a deploy ahead of the migration loses those events, not its whole batch.
--
-- user_id is auth.uid(): null for a visitor with no session. A guest, a
-- roster student or any anonymous JWT gets nothing stored and no error.
--
-- Caps, the rest dropped quietly; advisory locks make the counts exact under
-- concurrent calls (the user's lock first, then each session's):
-- * 500 rows per session_key in any 24 hours;
-- * 1000 rows per signed-in user in any 24 hours, whatever session_key they
--   send, so rotating keys does not get a signed-in caller past the cap.
-- A visitor with no session has only the session_key cap, and session_key is
-- the caller's choice: a script with the public anon key can mint keys and
-- add rows without limit. There is deliberately no global cap for those
-- visitors: one script could fill it and blank out every real visitor's
-- funnel for the day. The rows hold no personal data (strict patterns, no free
-- text), so the cost is table growth and noisy counts; the defence is a rate
-- limit in front of PostgREST, not here.
-- ---------------------------------------------------------------------------
create or replace function public.record_web_events (p_events jsonb) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    c_tag constant text := '^[A-Za-z0-9._-]{1,100}$';
    c_path constant text := '^(\*|/[A-Za-z0-9/:._-]*)$';
    c_utm constant text[] := array['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    c_keys constant text[] := array['event', 'path', 'session_key', 'referrer_host', 'device_class',
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    v_uid uuid := auth.uid();
    v_claims jsonb := coalesce(auth.jwt(), '{}'::jsonb);
    v_patterns constant text[] := public.web_route_patterns();
    v_event jsonb;
    v_key text;
    v_session uuid;
    v_count bigint;
    v_user_count bigint := 0;
begin
    if p_events is null or jsonb_typeof(p_events) <> 'array' then
        raise exception 'web events must be a JSON array' using errcode = '22023';
    end if;
    if jsonb_array_length(p_events) > 20 then
        raise exception 'at most 20 web events per call' using errcode = '22023';
    end if;

    for v_event in select e from jsonb_array_elements(p_events) e loop
        if jsonb_typeof(v_event) <> 'object' then
            raise exception 'a web event must be an object' using errcode = '22023';
        end if;
        for v_key in select k from jsonb_object_keys(v_event) k loop
            if not v_key = any (c_keys) then
                raise exception 'unknown web event field %', v_key using errcode = '22023';
            end if;
        end loop;
        if not coalesce(v_event ->> 'event' in ('page_view', 'demo_visit', 'signup_click', 'signup_completed')
                        and jsonb_typeof(v_event -> 'event') = 'string', false) then
            raise exception 'unknown web event' using errcode = '22023';
        end if;
        if jsonb_typeof(v_event -> 'session_key') is distinct from 'string'
           or v_event ->> 'session_key' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
            raise exception 'a web event needs a session_key uuid' using errcode = '22023';
        end if;
        if jsonb_typeof(v_event -> 'path') = 'string' then
            if char_length(v_event ->> 'path') > 200 or v_event ->> 'path' !~ c_path then
                raise exception 'a web event path must be a route pattern' using errcode = '22023';
            end if;
        elsif coalesce(jsonb_typeof(v_event -> 'path'), 'null') <> 'null' then
            raise exception 'a web event path must be a route pattern' using errcode = '22023';
        end if;
        foreach v_key in array c_utm loop
            if coalesce(jsonb_typeof(v_event -> v_key), 'null') <> 'null'
               and (jsonb_typeof(v_event -> v_key) <> 'string' or v_event ->> v_key !~ c_tag) then
                raise exception '% must match %', v_key, c_tag using errcode = '22023';
            end if;
        end loop;
        if coalesce(jsonb_typeof(v_event -> 'referrer_host'), 'null') <> 'null'
           and (jsonb_typeof(v_event -> 'referrer_host') <> 'string'
                or v_event ->> 'referrer_host' !~ '^[a-z0-9.-]{1,253}$') then
            raise exception 'referrer_host must be a lower-case host name' using errcode = '22023';
        end if;
        if coalesce(jsonb_typeof(v_event -> 'device_class'), 'null') <> 'null'
           and not coalesce(jsonb_typeof(v_event -> 'device_class') = 'string'
                            and v_event ->> 'device_class' in ('mobile', 'tablet', 'desktop'), false) then
            raise exception 'device_class must be mobile, tablet or desktop' using errcode = '22023';
        end if;
    end loop;

    -- Guests, roster students and anonymous JWTs: nothing is stored.
    if v_claims ->> 'is_anonymous' = 'true'
       or v_claims -> 'app_metadata' ->> 'user_type' = 'student' then
        return;
    end if;
    if v_uid is not null and exists (
        select 1 from auth.users u
        where u.id = v_uid
          and (u.is_anonymous or u.raw_app_meta_data ->> 'user_type' = 'student')
    ) then
        return;
    end if;

    if v_uid is not null then
        perform pg_advisory_xact_lock(hashtextextended('web_events:user:' || v_uid::text, 0));
        select count(*) into v_user_count
        from public.web_events w
        where w.user_id = v_uid and w.occurred_at > now() - interval '1 day';
    end if;

    for v_event in select e from jsonb_array_elements(p_events) e loop
        if v_event ->> 'path' is not null
           and v_event ->> 'path' <> '*'
           and not (v_event ->> 'path') = any (v_patterns) then
            continue;
        end if;
        if v_uid is not null and v_user_count >= 1000 then
            exit;
        end if;
        v_session := (v_event ->> 'session_key')::uuid;
        perform pg_advisory_xact_lock(hashtextextended('web_events:' || v_session::text, 0));
        select count(*) into v_count
        from public.web_events w
        where w.session_key = v_session and w.occurred_at > now() - interval '1 day';
        if v_count >= 500 then
            continue;
        end if;
        insert into public.web_events (event, path, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
                                       referrer_host, device_class, session_key, user_id)
        values (v_event ->> 'event', v_event ->> 'path',
                v_event ->> 'utm_source', v_event ->> 'utm_medium', v_event ->> 'utm_campaign',
                v_event ->> 'utm_content', v_event ->> 'utm_term',
                v_event ->> 'referrer_host', v_event ->> 'device_class', v_session, v_uid);
        v_user_count := v_user_count + 1;
    end loop;
end;
$$;

revoke all on function public.record_web_events (jsonb) from public, anon, authenticated, service_role;

grant execute on function public.record_web_events (jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- record_signup_attribution: AFTER INSERT on auth.users.
--
-- Fires for every creation path (email sign-up, admin createUser, anonymous
-- sign-in) but acts only for a user whose user_metadata carries
-- `attribution`, who is not anonymous and not a roster student. Each value
-- is checked on its own and a bad one is left out; with no valid utm tag
-- left, nothing is written. landing_path must be '*' or listed in
-- web_route_patterns(), else it is left null. It must never raise -- a bad
-- tag must not block a sign-up -- so any error is swallowed.
-- ---------------------------------------------------------------------------
create or replace function public.record_signup_attribution () returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    c_tag constant text := '^[A-Za-z0-9._-]{1,100}$';
    a jsonb;
    v_tags jsonb := '{}'::jsonb;
    v_key text;
    v_landing text;
    v_first timestamptz;
begin
    if not coalesce(new.raw_user_meta_data ? 'attribution', false)
       or coalesce(new.is_anonymous, false)
       or (new.raw_app_meta_data ->> 'user_type') is not distinct from 'student' then
        return null;
    end if;
    begin
        a := new.raw_user_meta_data -> 'attribution';
        if jsonb_typeof(a) is distinct from 'object' then
            return null;
        end if;
        foreach v_key in array array['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] loop
            if jsonb_typeof(a -> v_key) = 'string' and a ->> v_key ~ c_tag then
                v_tags := v_tags || jsonb_build_object(v_key, a ->> v_key);
            end if;
        end loop;
        if v_tags = '{}'::jsonb then
            return null;
        end if;
        if jsonb_typeof(a -> 'landing_path') = 'string'
           and (a ->> 'landing_path' = '*' or a ->> 'landing_path' = any (public.web_route_patterns())) then
            v_landing := a ->> 'landing_path';
        end if;
        if jsonb_typeof(a -> 'first_seen_at') = 'string' then
            begin
                v_first := (a ->> 'first_seen_at')::timestamptz;
            exception when others then
                v_first := null;
            end;
            if v_first > now() + interval '1 day' or v_first < now() - interval '1 year' then
                v_first := null;
            end if;
        end if;
        insert into public.signup_attribution (user_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
                                               landing_path, first_seen_at)
        values (new.id, v_tags ->> 'utm_source', v_tags ->> 'utm_medium', v_tags ->> 'utm_campaign',
                v_tags ->> 'utm_content', v_tags ->> 'utm_term', v_landing, v_first)
        on conflict (user_id) do nothing;
    exception when others then
        raise warning 'record_signup_attribution skipped for %: %', new.id, sqlerrm;
    end;
    return null;
end;
$$;

revoke all on function public.record_signup_attribution () from public, anon, authenticated, service_role;

grant execute on function public.record_signup_attribution () to supabase_auth_admin;

drop trigger if exists record_signup_attribution on auth.users;

create trigger record_signup_attribution
after insert on auth.users
for each row
execute function public.record_signup_attribution ();

-- ---------------------------------------------------------------------------
-- Retention: web events are kept 13 months (privacy policy, "How long we keep
-- information"). Daily, off the hour and clear of the other retention jobs
-- (03:17-04:23).
-- ---------------------------------------------------------------------------
create or replace function public.retention_purge_web_events (p_older_than interval default interval '13 months')
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
    purged int;
begin
    delete from public.web_events where occurred_at < now() - p_older_than;
    get diagnostics purged = row_count;
    return purged;
end;
$$;

revoke all on function public.retention_purge_web_events (interval) from public, anon, authenticated;

grant execute on function public.retention_purge_web_events (interval) to service_role;

do $$
begin
    perform cron.unschedule (jobid) from cron.job where jobname = 'retention-web-events';
exception
    when undefined_table then null;
    when others then null;
end;
$$;

select cron.schedule ('retention-web-events', '13 5 * * *', $$select public.retention_purge_web_events ()$$);
