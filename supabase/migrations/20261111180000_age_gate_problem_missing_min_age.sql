-- age_gate_problem failed open when min_age was absent.
--
-- 20261021120000 used `jsonb_typeof(gate -> 'min_age') <> 'number'`. A missing
-- key makes jsonb_typeof NULL, and NULL <> 'number' is NULL, so IF does not
-- fire. The numeric comparison then also yields NULL, and the function
-- returns NULL = allowed. `{"country":"DE"}` was therefore accepted;
-- `{"country":"DE","min_age":null}` was already refused (`'null' <> 'number'`).
--
-- This redefines the check with `is distinct from`, which treats SQL NULL as
-- not a number. The same style is used for the gate object and country so a
-- missing field cannot skip the IF. Grep of supabase/migrations for
-- `jsonb_typeof(.*->.*) <>` found only this site; other `jsonb_typeof(...) <>`
-- uses are on a value already shown non-null, or sit behind an `is null` OR.
--
-- There is no TypeScript/Edge copy of this validator: the browser builds a
-- complete AgeGate (min_age always a number) and student-provision writes
-- ageGateOf(attestation) the same way. Enforcement stays in SQL.
--
-- GoTrue's admin createUser (the path this backstop exists for) maps ANY
-- INSERT exception to HTTP 500, error_code unexpected_failure, message
-- "Database error creating new user". It does not forward this function's
-- SQLSTATE or RAISE text. Sign-up and anonymous guests still go through
-- before_user_created, which returns 400/403 with the clear wording.
--
-- Future GoTrue internals that INSERT into auth.users as supabase_auth_admin
-- without a passing age_gate will be refused by enforce_age_gate_on_user.
-- To exempt a path: write a valid age_gate into raw_user_meta_data, or INSERT
-- as postgres / supabase_admin (the seed.sql / SQL-fixture exemption). Do not
-- disable the trigger and do not GRANT supabase_auth_admin to a client role.

create or replace function public.age_gate_problem (p_user_metadata jsonb) returns text
language plpgsql immutable
set search_path = '' as $$
declare
    gate jsonb := p_user_metadata -> 'age_gate';
    country text;
begin
    -- jsonb_typeof(NULL) is NULL; NULL <> 'object' is NULL; IF would skip.
    if jsonb_typeof(gate) is distinct from 'object' then
        return 'age_check_missing';
    end if;
    country := gate ->> 'country';
    if jsonb_typeof(gate -> 'country') is distinct from 'string'
        or country !~ '^[A-Za-z]{2}$' then
        return 'age_check_missing';
    end if;
    if jsonb_typeof(gate -> 'min_age') is distinct from 'number' then
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

create or replace function public.enforce_age_gate_on_user () returns trigger
language plpgsql
set search_path = ''
as $$
declare
    problem text;
begin
    -- supabase_auth_admin is GoTrue, including admin createUser and any future
    -- internal INSERT GoTrue grows. postgres / supabase_admin skip this check
    -- (seed, fixtures, migrations). That is the exemption: INSERT as those
    -- roles, or put a passing age_gate on the row. Not a GUC, not a disable.
    if current_user is distinct from 'supabase_auth_admin' then
        return new;
    end if;
    problem := public.age_gate_problem (coalesce(new.raw_user_meta_data, '{}'::jsonb));
    if problem is null then
        return new;
    end if;
    -- RAISE text matches the hook. GoTrue createUser still answers 500
    -- "Database error creating new user" / unexpected_failure and does not
    -- forward this SQLSTATE; the hook path (sign-up, anonymous) still does.
    if problem = 'age_check_missing' then
        raise exception 'Sign-up needs the age check first. Reload the page and try again.'
            using errcode = '22023';
    end if;
    raise exception 'Sorry, you can’t create a Cleffy account.'
        using errcode = '42501';
end;
$$;

revoke all on function public.enforce_age_gate_on_user () from public, anon, authenticated, service_role;
grant execute on function public.enforce_age_gate_on_user () to supabase_auth_admin;

comment on function public.enforce_age_gate_on_user () is
    'Age-gate INSERT backstop for GoTrue (supabase_auth_admin). '
    'Exempt by inserting as postgres/supabase_admin, or by writing a valid age_gate. '
    'GoTrue createUser surfaces a refusal as HTTP 500 unexpected_failure, not this RAISE.';
