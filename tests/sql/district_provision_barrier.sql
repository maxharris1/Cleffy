-- District provisioning barrier (20261022130300, decision 67(a)), against a
-- real database. LOCAL STACK or the dev branch project only. Same harness as
-- district_retention_late_student.sql: one transaction ending in ROLLBACK,
-- time moved by the functions' p_now; the last line is `failures | total`
-- (scripts/ci/sql-proof.sh reads it), after any failing checks.
--
-- Once a district is soft deleted, nothing provisions into it or attributes a
-- student to it: district_provisionable() says no, district_provision_refusal()
-- says why (to the district's own teachers only), the roster trigger refuses
-- the insert as the service role makes it (SQLSTATE 55000,
-- 'district_deletion_pending', which student-provision answers with a 409),
-- and the admin correction and the backfill cannot move a student in. Private
-- students and moves out of the district are untouched, and the barrier lifts
-- when the purge is cancelled.
--
-- Cast: O owns district L and T is seated in it; X teaches with no seat. P
-- owns district M. Both contracts ended 17 days ago. f1 (O's) and f2 (T's)
-- are provisioned into L before the purge; b1 is O's private student; b2 is
-- O's legacy student whose district's record names L; e1 is P's in M.

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
    select ('d5400000-0000-4000-8000-0000000000' || p)::uuid;
$$;

create function pg_temp.roster (p text) returns uuid language sql immutable as $$
    select ('d5400000-0000-4000-8000-0000000005' || p)::uuid;
$$;

create function pg_temp.district (p text) returns uuid language sql immutable as $$
    select ('d5400000-0000-4000-8000-0000000005d' || p)::uuid;
$$;

-- A roster insert as student-provision makes it: as the service role.
create function pg_temp.provision (p text, p_teacher text, p_district uuid) returns boolean language plpgsql as $$
begin
    perform set_config('role', 'service_role', true);
    insert into public.managed_students
        (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at,
         district_studio_id)
    values (pg_temp.roster (p), pg_temp.u (p_teacher), pg_temp.u (p), 'Student ' || p, null, 'code', 'pb_' || p,
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
select pg_temp.u (t), 'authenticated', 'authenticated', 'pb-' || t || '@example.invalid', '{}'::jsonb
from unnest(array['a1', 'a2', 'a3', 'a4']) as t
union all
select pg_temp.u (s), 'authenticated', 'authenticated', 'pb-' || s || '@students.cleffy.app',
       '{"user_type":"student"}'::jsonb
from unnest(array['f1', 'f2', 'c1', 'c2', 'c3', 'c4', 'b1', 'b2', 'e1', 'e2']) as s;

-- a1 = O, a2 = T, a3 = X, a4 = P.
insert into public.studios (id, owner_id, name)
values (pg_temp.district ('1'), pg_temp.u ('a1'), 'District L'),
       (pg_temp.district ('2'), pg_temp.u ('a4'), 'District M');

insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
values (pg_temp.district ('1'), now() - interval '17 days', 'admin', 'test'),
       (pg_temp.district ('2'), now() - interval '17 days', 'admin', 'test');

insert into public.studio_members (studio_id, user_id) values (pg_temp.district ('1'), pg_temp.u ('a2'));

-- ===========================================================================
-- Before the purge: the district's teachers provision into it
-- ===========================================================================
select pg_temp.holds (
    'control: before the purge, L''s owner and seated teacher may provision into it',
    $q$select public.district_provisionable (pg_temp.u ('a1'), pg_temp.district ('1'))
          and public.district_provisionable (pg_temp.u ('a2'), pg_temp.district ('1'))
          and public.district_provision_refusal (pg_temp.u ('a1'), pg_temp.district ('1')) is null
          and not public.district_deletion_pending (pg_temp.district ('1'))$q$
);

select pg_temp.holds (
    'control: before the purge, the service role''s roster inserts for L go through',
    $q$select pg_temp.provision ('f1', 'a1', pg_temp.district ('1'))
          and pg_temp.provision ('f2', 'a2', pg_temp.district ('1'))
          and pg_temp.provision ('b1', 'a1', null)
          and pg_temp.provision ('b2', 'a1', null)
          and pg_temp.provision ('e1', 'a4', pg_temp.district ('2'))
          and pg_temp.district_of ('f1') = pg_temp.district ('1')$q$
);

-- b2 becomes a legacy row, and L's own record names it.
select set_config('cleffy.district_attribution', 'admin', true);

update public.managed_students set district_attribution = 'legacy' where id = pg_temp.roster ('b2');

select set_config('cleffy.district_attribution', '', true);

select public.admin_record_district_evidence (pg_temp.roster ('b2'), pg_temp.district ('1'), 'roster export', 'test');

-- ===========================================================================
-- Notice, sent, soft delete of L and M
-- ===========================================================================
select public.retention_district_run (now());

select public.finish_district_retention_notice (id) from public.claim_district_retention_notices (20);

insert into ran select 'soft', public.retention_district_run (now() + interval '14 days 1 minute');

select pg_temp.holds (
    'control: both districts are soft deleted, f1, f2 and e1 listed',
    $q$select (select (v ->> 'soft_delete')::int = 2 from ran where k = 'soft')
          and pg_temp.listed ('f1', pg_temp.district ('1')) and pg_temp.listed ('f2', pg_temp.district ('1'))
          and pg_temp.listed ('e1', pg_temp.district ('2'))
          and public.district_deletion_pending (pg_temp.district ('1'))$q$
);

-- ===========================================================================
-- The barrier
-- ===========================================================================
select pg_temp.holds (
    'district_provisionable says no to L''s owner and seated teacher, and the refusal says why',
    $q$select not public.district_provisionable (pg_temp.u ('a1'), pg_temp.district ('1'))
          and not public.district_provisionable (pg_temp.u ('a2'), pg_temp.district ('1'))
          and public.district_provision_refusal (pg_temp.u ('a1'), pg_temp.district ('1')) = 'district_deletion_pending'
          and public.district_provision_refusal (pg_temp.u ('a2'), pg_temp.district ('1')) = 'district_deletion_pending'$q$
);

select pg_temp.holds (
    'a teacher outside L is told only that they are not in it',
    $q$select public.district_provision_refusal (pg_temp.u ('a3'), pg_temp.district ('1')) = 'not_in_district'
          and not public.district_provisionable (pg_temp.u ('a3'), pg_temp.district ('1'))$q$
);

select pg_temp.refused (
    'a provision into L by its owner after the soft delete is refused: district_deletion_pending (55000)',
    $q$select pg_temp.provision ('c1', 'a1', pg_temp.district ('1'))$q$,
    '55000', 'district_deletion_pending'
);

select pg_temp.refused (
    'so is one by its seated teacher',
    $q$select pg_temp.provision ('c2', 'a2', pg_temp.district ('1'))$q$,
    '55000', 'district_deletion_pending'
);

select pg_temp.refused (
    'and one by a teacher outside it is refused as before (42501)',
    $q$select pg_temp.provision ('c4', 'a3', pg_temp.district ('1'))$q$,
    '42501'
);

select pg_temp.holds (
    'nothing refused was written',
    $q$select not exists (select 1 from public.managed_students
                          where id in (pg_temp.roster ('c1'), pg_temp.roster ('c2'), pg_temp.roster ('c4')))$q$
);

select pg_temp.holds (
    'a private student of L''s owner is still provisioned after the soft delete',
    $q$select pg_temp.provision ('c3', 'a1', null) and pg_temp.district_of ('c3') is null$q$
);

select pg_temp.refused (
    'the admin correction cannot move a private student into L',
    $q$select public.admin_set_student_district (pg_temp.roster ('b1'), pg_temp.district ('1'), 'test admin')$q$,
    '55000', 'district_deletion_pending'
);

select pg_temp.refused (
    'nor can an admin-flagged UPDATE of the roster row (the trigger''s own refusal)',
    $q$select set_config('cleffy.district_attribution', 'admin', true);
       update public.managed_students set district_studio_id = pg_temp.district ('1'), district_attribution = 'admin'
       where id = pg_temp.roster ('b1')$q$,
    '55000', 'district_deletion_pending'
);

select set_config('cleffy.district_attribution', '', true);

select pg_temp.holds (
    'b1 is still private, and L''s list did not grow',
    $q$select pg_temp.district_of ('b1') is null
          and (select count(*) = 2 from public.district_retention_students where studio_id = pg_temp.district ('1'))$q$
);

select public.admin_set_student_district (pg_temp.roster ('f1'), pg_temp.district ('1'), 'test admin');

select public.admin_set_student_district (pg_temp.roster ('f2'), null, 'test admin');

select pg_temp.holds (
    're-confirming L for f1 (no new attribution) and moving f2 out of L both still work',
    $q$select pg_temp.district_of ('f1') = pg_temp.district ('1') and pg_temp.listed ('f1', pg_temp.district ('1'))
          and pg_temp.district_of ('f2') is null and not pg_temp.listed ('f2', pg_temp.district ('1'))$q$
);

insert into ran select 'backfill', public.backfill_district_student_attribution ();

select pg_temp.holds (
    'the backfill leaves b2 unattributed, counted as district_gone, and keeps its result''s shape',
    $q$select pg_temp.district_of ('b2') is null
          and (select district_attribution = 'legacy' from public.managed_students where id = pg_temp.roster ('b2'))
          and (select (v ->> 'skipped_district_gone')::int >= 1 and (v ->> 'attributed')::int = 0
                      and (select array_agg(key order by key) from jsonb_object_keys(v) key)
                          = array['attributed', 'skipped_ambiguous', 'skipped_before_district',
                                  'skipped_district_gone', 'skipped_no_evidence', 'skipped_outside_tenure']
               from ran where k = 'backfill')
          and exists (select 1 from public.district_retention_log
                      where studio_id = pg_temp.district ('1') and step = 'attribution_backfilled'
                        and counts = '{"district_gone": 1}'::jsonb)$q$
);

-- ===========================================================================
-- M's contract is renewed: its cancel lifts the barrier
-- ===========================================================================
update public.district_billing set contract_ends_at = now() + interval '1 year'
where studio_id = pg_temp.district ('2');

insert into ran select 'cancel', public.retention_district_run (now() + interval '15 days');

select pg_temp.holds (
    'after M''s cancel, its owner provisions into it again',
    $q$select (select (v ->> 'cancel')::int = 1 from ran where k = 'cancel')
          and not public.district_deletion_pending (pg_temp.district ('2'))
          and public.district_provisionable (pg_temp.u ('a4'), pg_temp.district ('2'))
          and pg_temp.provision ('e2', 'a4', pg_temp.district ('2'))
          and pg_temp.district_of ('e2') = pg_temp.district ('2')$q$
);

-- ===========================================================================
-- L's hard delete: the district is gone, and stays closed
-- ===========================================================================
insert into ran select 'hard', public.retention_district_run (now() + interval '21 days 2 minutes');

select pg_temp.holds (
    'after L''s hard delete it is still being deleted, and nobody is in it any more',
    $q$select (select (v ->> 'hard_delete')::int = 1 from ran where k = 'hard')
          and public.district_deletion_pending (pg_temp.district ('1'))
          and public.district_provision_refusal (pg_temp.u ('a1'), pg_temp.district ('1')) = 'not_in_district'
          and not exists (select 1 from public.managed_students where district_studio_id = pg_temp.district ('1'))$q$
);

-- ===========================================================================
-- Privileges
-- ===========================================================================
select pg_temp.holds (
    'the barrier''s functions are the service role''s alone; the re-list is internal',
    $q$select (select bool_and(has_function_privilege('service_role', f, 'execute')
                               and not has_function_privilege('anon', f, 'execute')
                               and not has_function_privilege('authenticated', f, 'execute'))
               from unnest(array['public.district_deletion_pending(uuid)',
                                 'public.district_provision_refusal(uuid, uuid)',
                                 'public.district_provisionable(uuid, uuid)',
                                 'public.admin_set_student_district(uuid, uuid, text)',
                                 'public.backfill_district_student_attribution()',
                                 'public.retention_district_run(timestamptz, int)']) f)
          and (select not bool_or(has_function_privilege(r, 'public.district_retention_list_late(uuid, timestamptz, text)',
                                                         'execute'))
               from unnest(array['service_role', 'anon', 'authenticated']) r)$q$
);

-- ---------------------------------------------------------------------------
-- Report: every check, then `failures | total`
-- ---------------------------------------------------------------------------
select n, check_name, passed, detail from integrity_results order by n;

select count(*) filter (where not passed) as failures, count(*) as total from integrity_results;

rollback;
