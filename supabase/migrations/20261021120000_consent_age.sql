-- Age at sign-up: nobody creates a Cleffy account below the consent age for
-- their country, whichever door they come in by.
--
-- The front end asks first (src/features/auth/AgeScreen.tsx, on /register and
-- before a share-link guest is made on /join): the visitor's country and their
-- birth month and year, compared against the age for that country and thrown
-- away. Nothing about their birthday is stored. What the account keeps is the
-- outcome, in its user_metadata:
--
--     age_gate: { "country": "DE", "min_age": 16, "source": "self", "v": 1 }
--
-- meaning "this person said they live in Germany and are at least 16". A
-- teacher adding a student (student-provision) writes the same object with
-- "source": "teacher", from the attestation the teacher ticked.
--
-- The screen alone would be advisory: an old cached build, or anyone calling
-- GoTrue's /signup directly, would skip it. So GoTrue asks the database before
-- every new user is written — the before_user_created Auth hook below — and
-- this function refuses any user whose age_gate is missing, malformed, or
-- names an age below what consent_age() says that country requires. The hook
-- runs for every creation path: email sign-up, anonymous sign-in (the share
-- link's guest), and the admin API's createUser and inviteUserByEmail.
--
-- The hook has to be switched on per project; config.toml does it for the
-- local stack. On the hosted projects it is a dashboard step (Authentication →
-- Hooks → Before User Created → Postgres function public.hook_before_user_created),
-- listed for Max in the PR. Until it is on, the function exists and nothing
-- calls it.

-- ---------------------------------------------------------------------------
-- The table. Mirrors supabase/functions/_shared/consentAge.ts and
-- src/features/legal/consentAge.ts; tests/legal/consentAgeInSync.test.ts holds
-- the three together.
-- ---------------------------------------------------------------------------
create or replace function public.consent_age (p_country text) returns int
language sql immutable parallel safe
set search_path = '' as $$
    select case upper(coalesce(p_country, ''))
        when 'AT' then 14
        when 'BE' then 13
        when 'BG' then 14
        when 'HR' then 16
        when 'CY' then 14
        when 'CZ' then 15
        when 'DK' then 13
        when 'EE' then 13
        when 'FI' then 13
        when 'FR' then 15
        when 'DE' then 16
        when 'GR' then 15
        when 'HU' then 16
        when 'IE' then 16
        when 'IT' then 14
        when 'LV' then 13
        when 'LT' then 14
        when 'LU' then 16
        when 'MT' then 13
        when 'NL' then 16
        when 'PL' then 16
        when 'PT' then 13
        when 'RO' then 16
        when 'SK' then 16
        when 'SI' then 15
        when 'ES' then 14
        when 'SE' then 13
        when 'IS' then 13
        when 'LI' then 16
        when 'NO' then 13
        when 'GB' then 13
        else 13
    end;
$$;

-- Pure, and nothing secret: anyone may ask it.
revoke all on function public.consent_age (text) from public;
grant execute on function public.consent_age (text) to anon, authenticated, service_role, supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- The check, separate from the hook so it can be tested on its own.
--
-- Null for a user who may be created; otherwise the reason, which the hook
-- turns into a refusal.
-- ---------------------------------------------------------------------------
create or replace function public.age_gate_problem (p_user_metadata jsonb) returns text
language plpgsql immutable
set search_path = '' as $$
declare
    gate jsonb := p_user_metadata -> 'age_gate';
    country text;
begin
    if gate is null or jsonb_typeof(gate) <> 'object' then
        return 'age_check_missing';
    end if;
    country := gate ->> 'country';
    if country is null or country !~ '^[A-Za-z]{2}$' then
        return 'age_check_missing';
    end if;
    if jsonb_typeof(gate -> 'min_age') <> 'number' then
        return 'age_check_missing';
    end if;
    if (gate ->> 'min_age')::numeric < public.consent_age (country) then
        return 'below_consent_age';
    end if;
    return null;
end;
$$;

revoke all on function public.age_gate_problem (jsonb) from public, anon, authenticated;
grant execute on function public.age_gate_problem (jsonb) to service_role, supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- The Auth hook. GoTrue calls it as supabase_auth_admin with
-- { "metadata": {…}, "user": {…} } and creates the user only on `{}`.
--
-- Neutral wording on purpose: a refusal must not say which age would have
-- passed, or the next attempt simply claims it.
-- ---------------------------------------------------------------------------
create or replace function public.hook_before_user_created (event jsonb) returns jsonb
language plpgsql stable
set search_path = '' as $$
declare
    problem text := public.age_gate_problem (coalesce(event -> 'user' -> 'user_metadata', '{}'::jsonb));
begin
    if problem is null then
        return '{}'::jsonb;
    end if;
    if problem = 'age_check_missing' then
        return jsonb_build_object(
            'error',
            jsonb_build_object(
                'http_code', 400,
                'message', 'Sign-up needs the age check first. Reload the page and try again.'
            )
        );
    end if;
    return jsonb_build_object(
        'error',
        jsonb_build_object('http_code', 403, 'message', 'Sorry, you can’t create a Cleffy account.')
    );
end;
$$;

revoke all on function public.hook_before_user_created (jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created (jsonb) to supabase_auth_admin;
