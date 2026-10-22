-- Provisioning intents name only an account made inside their window
-- (20261022140300), against a real database. LOCAL STACK or the dev branch
-- project only. Runs inside one transaction and ROLLS BACK; the last line is
-- `failures | total` (scripts/ci/sql-proof.sh reads it), after any failing
-- checks.
--
-- student_provision_intents_for() names, for each intent of a teacher, the
-- Auth account the provisioning made: the one attach_student_provision()
-- recorded, or (a crash between the Auth create and the attach) one found by
-- the intent's address. That email fallback had no upper bound: a separate
-- signup at the same address days later, or the account another intent for
-- the same address recorded, could be named. Now it finds only an account
-- created inside the intent's window (one minute before created_at to
-- expires_at) that no other intent recorded.
--
-- Cast: teacher T. Intents w1 .. w6, each at its own address unless said:
--   w1  crashed between create and attach: the account, made inside the
--       window, is still found by address
--   w2  nothing made by the request; a separate signup at the address after
--       the window closed: not named
--   w3  an account at the address made long before the intent: not named
--   w4/w5  two intents for one address; w5 made and recorded its account, w4
--       made none: w4 never names w5's account
--   w6  recorded: its own account is named
--   w7/w8  accounts at expires_at exactly (named) and a second later (not)

begin;

create temp table integrity_results (
    n serial primary key,
    check_name text not null,
    passed boolean not null,
    detail text
);

grant all on integrity_results to public;

grant usage on sequence integrity_results_n_seq to public;

create function pg_temp.holds (p_name text, p_sql text) returns void language plpgsql as $$
declare
    v boolean;
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql into v;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (p_name, false, 'error: ' || v_state || ' ' || v_msg);
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, coalesce(v, false), 'got ' || coalesce(v::text, 'null'));
end;
$$;

create function pg_temp.u (p text) returns uuid language sql immutable as $$
    select ('d9000000-0000-4000-8000-0000000000' || p)::uuid;
$$;

-- An intent's roster id.
create function pg_temp.r (p text) returns uuid language sql immutable as $$
    select ('d9000000-0000-4000-8000-0000000005' || p)::uuid;
$$;

create function pg_temp.addr (p text) returns text language sql immutable as $$
    select 'iw-' || p || '@students.cleffy.app';
$$;

-- An account as GoTrue makes it: flagged as T's student, at the given time.
create function pg_temp.account (p_id text, p_address text, p_at timestamptz) returns void language sql as $$
    insert into auth.users (id, aud, role, email, raw_app_meta_data, created_at)
    values (pg_temp.u (p_id), 'authenticated', 'authenticated', p_address,
            jsonb_build_object('user_type', 'student', 'teacher_id', pg_temp.u ('a1')), p_at);
$$;

create function pg_temp.named (p_intent text) returns uuid language sql as $$
    select i.student_user_id from public.student_provision_intents_for (pg_temp.u ('a1')) i
    where i.roster_id = pg_temp.r (p_intent);
$$;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email, raw_app_meta_data)
values (pg_temp.u ('a1'), 'authenticated', 'authenticated', 'iw-teacher@example.invalid', '{}'::jsonb);

-- Each intent as begin_student_provision() records it (ten minutes), then
-- dated an hour ago, so its window is [created_at - 1 minute, expires_at].
set local role service_role;

select public.begin_student_provision (pg_temp.u ('a1'), pg_temp.r (p), pg_temp.addr (case when p = 'b4' then 'b5' else p end))
from unnest(array['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8']) as p;

reset role;

update public.student_provision_intents
set created_at = now() - interval '1 hour', expires_at = now() - interval '50 minutes'
where teacher_id = pg_temp.u ('a1');

-- w1: made 30 s after the intent, never attached.
select pg_temp.account ('c1', pg_temp.addr ('b1'), now() - interval '1 hour' + interval '30 seconds');

-- w2: a separate signup the next day.
select pg_temp.account ('c2', pg_temp.addr ('b2'), now() + interval '1 day');

-- w3: an account from a year before.
select pg_temp.account ('c3', pg_temp.addr ('b3'), now() - interval '1 year');

-- w5's own account, made and recorded; w4 shares the address.
select pg_temp.account ('c5', pg_temp.addr ('b5'), now() - interval '1 hour' + interval '10 seconds');

-- w6's own account, recorded (auth.users allows one account per address).
select pg_temp.account ('c6', pg_temp.addr ('b6'), now() - interval '1 hour' + interval '5 seconds');

-- w7 at expires_at exactly; w8 one second past it.
select pg_temp.account ('c7', pg_temp.addr ('b7'), now() - interval '50 minutes');

select pg_temp.account ('c8', pg_temp.addr ('b8'), now() - interval '50 minutes' + interval '1 second');

set local role service_role;

select public.attach_student_provision (pg_temp.r ('b5'), pg_temp.u ('c5'));

select public.attach_student_provision (pg_temp.r ('b6'), pg_temp.u ('c6'));

-- ===========================================================================
-- The checks, as the service role (delete-account's call)
-- ===========================================================================
select pg_temp.holds (
    'control: every intent is listed, none live (their requests ended 50 minutes ago)',
    $q$select count(*) = 8 and bool_and(not live) from public.student_provision_intents_for (pg_temp.u ('a1'))$q$
);

select pg_temp.holds (
    'w1: a crash between the Auth create and the attach still finds the account by address, inside the window',
    $q$select pg_temp.named ('b1') = pg_temp.u ('c1')$q$
);

select pg_temp.holds (
    'w2: a separate signup at the address after the window closed is not named',
    $q$select pg_temp.named ('b2') is null$q$
);

select pg_temp.holds (
    'w3: an account at the address from before the window is not named',
    $q$select pg_temp.named ('b3') is null$q$
);

select pg_temp.holds (
    'w4: another intent''s recorded account at the same address, inside the window, is not named',
    $q$select pg_temp.named ('b4') is null and pg_temp.named ('b5') = pg_temp.u ('c5')$q$
);

select pg_temp.holds (
    'w6: the recorded account is named, as before',
    $q$select pg_temp.named ('b6') = pg_temp.u ('c6')$q$
);

select pg_temp.holds (
    'w7 / w8: the window ends at expires_at, inclusive',
    $q$select pg_temp.named ('b7') = pg_temp.u ('c7') and pg_temp.named ('b8') is null$q$
);

reset role;

select pg_temp.holds (
    'the function keeps its service-role-only grant',
    $q$select has_function_privilege('service_role', 'public.student_provision_intents_for(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.student_provision_intents_for(uuid)', 'execute')
          and not has_function_privilege('anon', 'public.student_provision_intents_for(uuid)', 'execute')$q$
);

-- ---------------------------------------------------------------------------
-- Report: every check, then `failures | total`
-- ---------------------------------------------------------------------------
select n, check_name, passed, detail from integrity_results order by n;

select count(*) filter (where not passed) as failures, count(*) as total from integrity_results;

rollback;
