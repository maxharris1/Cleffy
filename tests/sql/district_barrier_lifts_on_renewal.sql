-- A renewal lifts the provisioning barrier at once (20261022140200,
-- decision 68(3)'s follow-up), against a real database. LOCAL STACK or the dev
-- branch project only. Same harness as district_provision_barrier.sql: one
-- transaction ending in ROLLBACK, time moved by the functions' p_now; the
-- last line is `failures | total` (scripts/ci/sql-proof.sh reads it), after
-- any failing checks.
--
-- Before 20261022140200 a renewed district refused every provision until the
-- next daily run's cancel. Now the barrier lifts with the renewal itself, the
-- run's cancel is unchanged, and a renewal undone before the run closes the
-- barrier again with nothing lost: the sweep lists whoever came in meanwhile.
--
-- Cast: O owns district L, T is seated in it; P owns district M. Both
-- contracts ended 17 days ago. f1 (O's) is in L and e7 (P's) in M before the
-- purge.

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

-- Passes when p_sql fails with SQLSTATE p_state (and, given, message p_msg).
create function pg_temp.refused (p_name text, p_sql text, p_state text, p_msg text default null)
returns void language plpgsql as $$
declare
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (p_name, v_state = p_state and (p_msg is null or v_msg = p_msg), v_state || ' ' || v_msg);
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, false, 'statement succeeded but should have been refused');
end;
$$;

create temp table ran (k text primary key, v jsonb);

grant all on ran to public;

create function pg_temp.u (p text) returns uuid language sql immutable as $$
    select ('d8000000-0000-4000-8000-0000000000' || p)::uuid;
$$;

create function pg_temp.roster (p text) returns uuid language sql immutable as $$
    select ('d8000000-0000-4000-8000-0000000005' || p)::uuid;
$$;

create function pg_temp.district (p text) returns uuid language sql immutable as $$
    select ('d8000000-0000-4000-8000-0000000005d' || p)::uuid;
$$;

-- A roster insert as student-provision makes it: as the service role.
create function pg_temp.provision (p text, p_teacher text, p_district uuid) returns boolean language plpgsql as $$
begin
    perform set_config('role', 'service_role', true);
    insert into public.managed_students
        (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at,
         district_studio_id)
    values (pg_temp.roster (p), pg_temp.u (p_teacher), pg_temp.u (p), 'Student ' || p, null, 'code', 'rl_' || p,
            now(), p_district);
    perform set_config('role', 'none', true);
    return true;
end;
$$;

create function pg_temp.district_of (p text) returns uuid language sql as $$
    select district_studio_id from public.managed_students where id = pg_temp.roster (p);
$$;

create function pg_temp.listed (p text, p_district uuid) returns boolean language sql as $$
    select exists (select 1 from public.district_retention_students
                   where studio_id = p_district and managed_student_id = pg_temp.roster (p));
$$;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email, raw_app_meta_data)
select pg_temp.u (t), 'authenticated', 'authenticated', 'rl-' || t || '@example.invalid', '{}'::jsonb
from unnest(array['a1', 'a2', 'a4']) as t
union all
select pg_temp.u (s), 'authenticated', 'authenticated', 'rl-' || s || '@students.cleffy.app',
       '{"user_type":"student"}'::jsonb
from unnest(array['f1', 'e3', 'e4', 'e7', 'e5', 'e6']) as s;

-- a1 = O, a2 = T, a4 = P.
insert into public.studios (id, owner_id, name)
values (pg_temp.district ('1'), pg_temp.u ('a1'), 'District L'),
       (pg_temp.district ('2'), pg_temp.u ('a4'), 'District M');

insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
values (pg_temp.district ('1'), now() - interval '17 days', 'admin', 'test'),
       (pg_temp.district ('2'), now() - interval '17 days', 'admin', 'test');

insert into public.studio_members (studio_id, user_id) values (pg_temp.district ('1'), pg_temp.u ('a2'));

select pg_temp.provision ('f1', 'a1', pg_temp.district ('1'));

select pg_temp.provision ('e7', 'a4', pg_temp.district ('2'));

-- ===========================================================================
-- Notice, sent, soft delete of L and M: the barrier is up
-- ===========================================================================
select public.retention_district_run (now());

select public.finish_district_retention_notice (id) from public.claim_district_retention_notices (20);

insert into ran select 'soft', public.retention_district_run (now() + interval '14 days 1 minute');

select pg_temp.holds (
    'control: both soft deleted, f1 and e7 listed and archived, and both districts refuse provisions',
    $q$select (select (v ->> 'soft_delete')::int = 2 from ran where k = 'soft')
          and pg_temp.listed ('f1', pg_temp.district ('1')) and pg_temp.listed ('e7', pg_temp.district ('2'))
          and public.district_deletion_pending (pg_temp.district ('1'))
          and public.district_deletion_pending (pg_temp.district ('2'))
          and public.district_provision_refusal (pg_temp.u ('a1'), pg_temp.district ('1')) = 'district_deletion_pending'$q$
);

select pg_temp.refused (
    'control: a provision into L before any renewal is refused (55000 district_deletion_pending)',
    $q$select pg_temp.provision ('e4', 'a2', pg_temp.district ('1'))$q$,
    '55000', 'district_deletion_pending'
);

-- ===========================================================================
-- L is renewed: the barrier lifts at once, before any run
-- ===========================================================================
update public.district_billing set contract_ends_at = now() + interval '1 year'
where studio_id = pg_temp.district ('1');

select pg_temp.holds (
    'right after L''s renewal, with no run since, L is no longer being deleted and its teachers may provision',
    $q$select not public.district_deletion_pending (pg_temp.district ('1'))
          and public.district_provisionable (pg_temp.u ('a1'), pg_temp.district ('1'))
          and public.district_provisionable (pg_temp.u ('a2'), pg_temp.district ('1'))
          and public.district_provision_refusal (pg_temp.u ('a2'), pg_temp.district ('1')) is null
          and exists (select 1 from public.district_retention
                      where studio_id = pg_temp.district ('1') and soft_deleted_at is not null)$q$
);

select pg_temp.holds (
    'the service role''s roster insert for L goes through (student-provision''s write)',
    $q$select pg_temp.provision ('e3', 'a2', pg_temp.district ('1'))
          and pg_temp.district_of ('e3') = pg_temp.district ('1')$q$
);

select pg_temp.holds (
    'M, not renewed, still refuses',
    $q$select public.district_deletion_pending (pg_temp.district ('2'))
          and not public.district_provisionable (pg_temp.u ('a4'), pg_temp.district ('2'))$q$
);

-- ===========================================================================
-- The next run: L's cancel, unchanged
-- ===========================================================================
insert into ran select 'cancel', public.retention_district_run (now() + interval '15 days');

select pg_temp.holds (
    'L''s cancel un-archives f1, whom the purge archived, and leaves e3, never listed, as it was',
    $q$select (select (v ->> 'cancel')::int = 1 and (v ->> 'students_restored')::int = 1 from ran where k = 'cancel')
          and (select archived_at is null from public.managed_students where id = pg_temp.roster ('f1'))
          and (select archived_at is null and access_revoked_at is null from public.managed_students
               where id = pg_temp.roster ('e3'))
          and not exists (select 1 from public.district_retention where studio_id = pg_temp.district ('1'))
          and not public.district_deletion_pending (pg_temp.district ('1'))$q$
);

-- ===========================================================================
-- M is renewed, then the renewal is undone before the run
-- ===========================================================================
update public.district_billing set contract_ends_at = now() + interval '1 year'
where studio_id = pg_temp.district ('2');

select pg_temp.holds (
    'M''s renewal lifts its barrier, and P provisions e5 into it',
    $q$select not public.district_deletion_pending (pg_temp.district ('2'))
          and pg_temp.provision ('e5', 'a4', pg_temp.district ('2'))$q$
);

update public.district_billing set contract_ends_at = now() - interval '17 days'
where studio_id = pg_temp.district ('2');

select pg_temp.holds (
    'undone (the contract end set back to the one the cycle began for), the barrier is up again',
    $q$select public.district_deletion_pending (pg_temp.district ('2'))
          and not public.district_provisionable (pg_temp.u ('a4'), pg_temp.district ('2'))$q$
);

select pg_temp.refused (
    'and a provision into M is refused again',
    $q$select pg_temp.provision ('e6', 'a4', pg_temp.district ('2'))$q$,
    '55000', 'district_deletion_pending'
);

insert into ran select 'sweep', public.retention_district_run (now() + interval '15 days 1 minute');

select pg_temp.holds (
    'the next run''s sweep lists, archives and signs out e5, who came in while the barrier was down: nothing is missed',
    $q$select (select (v ->> 'students_late_listed')::int = 1 and (v ->> 'cancel')::int = 0 from ran where k = 'sweep')
          and pg_temp.listed ('e5', pg_temp.district ('2'))
          and (select archived_at is not null and access_revoked_at is not null from public.managed_students
               where id = pg_temp.roster ('e5'))$q$
);

-- ===========================================================================
-- A hard-deleted district stays closed
-- ===========================================================================
insert into ran select 'hard', public.retention_district_run (now() + interval '21 days 2 minutes');

select pg_temp.holds (
    'M''s hard delete deletes e7 and e5; M stays closed for good',
    $q$select (select (v ->> 'hard_delete')::int = 1 and (v ->> 'students_deleted')::int = 2 from ran where k = 'hard')
          and public.district_deletion_pending (pg_temp.district ('2'))
          and not exists (select 1 from public.managed_students where id in (pg_temp.roster ('e7'), pg_temp.roster ('e5')))$q$
);

select pg_temp.holds (
    'the function keeps its signature and service-role-only grant',
    $q$select has_function_privilege('service_role', 'public.district_deletion_pending(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.district_deletion_pending(uuid)', 'execute')
          and not has_function_privilege('anon', 'public.district_deletion_pending(uuid)', 'execute')$q$
);

-- ---------------------------------------------------------------------------
-- Report: every check, then `failures | total`
-- ---------------------------------------------------------------------------
select n, check_name, passed, detail from integrity_results order by n;

select count(*) filter (where not passed) as failures, count(*) as total from integrity_results;

rollback;
