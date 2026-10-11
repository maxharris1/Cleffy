-- An archived student who types their own password is told they were archived
-- (migration 20261011120100_archived_student_password_check), and nobody else
-- learns anything.
--
-- Same harness and same reading as column_integrity.sql (see README.md): one
-- transaction ending in ROLLBACK, every check a row in integrity_results, and a
-- clean run is exactly one row reading 'ALL n CHECKS PASSED'.
--
-- Cast: T teaches; A is T's archived, claimed code student 'archived_ada'; L is
-- a live claimed student 'live_lee'; U is an archived student who never
-- claimed; X is an archived row whose auth user is not a provisioned student;
-- H is archived but holds a hash crypt() cannot check.

begin;

create temp table integrity_results (
    n serial primary key,
    check_name text not null,
    passed boolean not null,
    detail text
);

grant all on integrity_results to public;

grant usage on sequence integrity_results_n_seq to public;

create function pg_temp.act_as_service () returns void language plpgsql as $$
begin
    perform set_config('role', 'service_role', true);
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end;
$$;

create function pg_temp.act_as (p_uid uuid, p_role text) returns void language plpgsql as $$
begin
    perform set_config('role', p_role, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', p_uid, 'role', p_role)::text, true);
end;
$$;

create function pg_temp.act_as_server () returns void language plpgsql as $$
begin
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
end;
$$;

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

create function pg_temp.refused (p_name text, p_sql text, p_state text) returns void language plpgsql as $$
declare
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (p_name, v_state = p_state, v_state || ' ' || v_msg);
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, false, 'statement succeeded but should have been refused');
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres). Cost 4: the check is the same at GoTrue's 10.
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email)
values ('a4c00000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'arch-teacher@example.invalid');

insert into auth.users (id, aud, role, email, raw_app_meta_data, encrypted_password)
values
    ('a4c00000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'st-a@students.cleffy.app',
     '{"user_type":"student"}', extensions.crypt ('Correct1horse', extensions.gen_salt ('bf', 4))),
    ('a4c00000-0000-4000-8000-0000000000a3', 'authenticated', 'authenticated', 'st-l@students.cleffy.app',
     '{"user_type":"student"}', extensions.crypt ('Correct1horse', extensions.gen_salt ('bf', 4))),
    ('a4c00000-0000-4000-8000-0000000000a4', 'authenticated', 'authenticated', 'st-u@students.cleffy.app',
     '{"user_type":"student"}', extensions.crypt ('Correct1horse', extensions.gen_salt ('bf', 4))),
    ('a4c00000-0000-4000-8000-0000000000a5', 'authenticated', 'authenticated', 'not-a-student@example.invalid',
     '{}', extensions.crypt ('Correct1horse', extensions.gen_salt ('bf', 4))),
    ('a4c00000-0000-4000-8000-0000000000a6', 'authenticated', 'authenticated', 'st-h@students.cleffy.app',
     '{"user_type":"student"}', 'plain-text-not-a-hash');

insert into public.managed_students
    (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at, archived_at)
values
    ('a4c00000-0000-4000-8000-0000000005a2', 'a4c00000-0000-4000-8000-0000000000a1',
     'a4c00000-0000-4000-8000-0000000000a2', 'Ada', null, 'code', 'archived_ada', now(), now()),
    ('a4c00000-0000-4000-8000-0000000005a3', 'a4c00000-0000-4000-8000-0000000000a1',
     'a4c00000-0000-4000-8000-0000000000a3', 'Lee', null, 'code', 'live_lee', now(), null),
    -- Invited (unclaimed), with a username left over from an earlier claim.
    ('a4c00000-0000-4000-8000-0000000005a4', 'a4c00000-0000-4000-8000-0000000000a1',
     'a4c00000-0000-4000-8000-0000000000a4', 'Una', 'code-hash', 'code', 'unclaimed_una', null, now()),
    ('a4c00000-0000-4000-8000-0000000005a5', 'a4c00000-0000-4000-8000-0000000000a1',
     'a4c00000-0000-4000-8000-0000000000a5', 'Xan', null, 'code', 'not_student_xan', now(), now()),
    ('a4c00000-0000-4000-8000-0000000005a6', 'a4c00000-0000-4000-8000-0000000000a1',
     'a4c00000-0000-4000-8000-0000000000a6', 'Hal', null, 'code', 'odd_hash_hal', now(), now());

-- ===========================================================================
-- The service role (student-login)
-- ===========================================================================
select pg_temp.act_as_service ();

select pg_temp.holds (
    'archived student, right password: true',
    $q$select public.archived_student_password_matches ('archived_ada', 'Correct1horse')$q$
);

select pg_temp.holds (
    'archived student, wrong password: false',
    $q$select not public.archived_student_password_matches ('archived_ada', 'Wrong1horse')$q$
);

select pg_temp.holds (
    'archived student, password differing only in case: false',
    $q$select not public.archived_student_password_matches ('archived_ada', 'correct1horse')$q$
);

select pg_temp.holds (
    'empty or null password: false',
    $q$select not public.archived_student_password_matches ('archived_ada', '')
          and not coalesce(public.archived_student_password_matches ('archived_ada', null), false)$q$
);

select pg_temp.holds (
    'live (unarchived) student, right password: false (GoTrue answers them)',
    $q$select not public.archived_student_password_matches ('live_lee', 'Correct1horse')$q$
);

select pg_temp.holds (
    'archived but never claimed: false',
    $q$select not public.archived_student_password_matches ('unclaimed_una', 'Correct1horse')$q$
);

select pg_temp.holds (
    'archived row whose account is not a provisioned student: false',
    $q$select not public.archived_student_password_matches ('not_student_xan', 'Correct1horse')$q$
);

select pg_temp.holds (
    'a stored password that is not bcrypt: false, not an error',
    $q$select not public.archived_student_password_matches ('odd_hash_hal', 'plain-text-not-a-hash')$q$
);

select pg_temp.holds (
    'unknown username: false',
    $q$select not public.archived_student_password_matches ('nobody_here', 'Correct1horse')$q$
);

-- ===========================================================================
-- Anyone else: an unthrottled password check, so refused outright
-- ===========================================================================
select pg_temp.act_as ('a4c00000-0000-4000-8000-0000000000a3', 'authenticated');

select pg_temp.refused (
    'a signed-in user cannot call it',
    $q$select public.archived_student_password_matches ('archived_ada', 'Correct1horse')$q$,
    '42501'
);

select pg_temp.act_as (null, 'anon');

select pg_temp.refused (
    'anon cannot call it',
    $q$select public.archived_student_password_matches ('archived_ada', 'Correct1horse')$q$,
    '42501'
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'not executable by public, anon or authenticated',
    $q$select not has_function_privilege ('anon', 'public.archived_student_password_matches(text, text)', 'execute')
          and not has_function_privilege ('authenticated', 'public.archived_student_password_matches(text, text)', 'execute')
          and has_function_privilege ('service_role', 'public.archived_student_password_matches(text, text)', 'execute')$q$
);

select pg_temp.holds (
    'definer function pins search_path',
    $q$select p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
       from pg_proc p
       where p.oid = 'public.archived_student_password_matches'::regproc$q$
);

-- ---------------------------------------------------------------------------
-- Report
-- ---------------------------------------------------------------------------
select n, check_name, passed, detail
from integrity_results
where not passed
union all
select
    null,
    case
        when bool_and(passed) then 'ALL ' || count(*) || ' CHECKS PASSED'
        else count(*) filter (where not passed) || ' OF ' || count(*) || ' CHECKS FAILED'
    end,
    bool_and(passed),
    null
from integrity_results
order by n nulls last;

rollback;
