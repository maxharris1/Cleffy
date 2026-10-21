-- District retention scope (20261021120800), against a real database. LOCAL
-- STACK or the dev branch project only. Same harness and same reading as
-- district_retention.sql: one transaction ending in ROLLBACK, every check a row
-- in integrity_results, a clean run is exactly one row 'ALL n CHECKS PASSED'.
--
-- Codex round-2 review of #64, new major 1: the purge must take the students
-- the district provided -- recorded when they were provisioned -- and nobody
-- else's, whoever is seated in the district on the day it runs.
--
-- Cast: district A (owner OA) and district B (owner OB), both contracts ended
-- 17 days ago. P is a teacher with a private student p1 who then joins A and
-- provisions p2. L is seated in A, provisions l1, leaves A, then provisions l2.
-- T is seated in B and then in A, and provisions t1. OA provisions oa1. Q is an
-- unrelated teacher with q1. Every student has a mark on P's score.

begin;

create temp table integrity_results (
    n serial primary key,
    check_name text not null,
    passed boolean not null,
    detail text
);

grant all on integrity_results to public;

grant usage on sequence integrity_results_n_seq to public;

create function pg_temp.act_as (p_uid uuid) returns void language plpgsql as $$
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
end;
$$;

create function pg_temp.act_as_service () returns void language plpgsql as $$
begin
    perform set_config('role', 'service_role', true);
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
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
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email, raw_app_meta_data)
select ('e2000000-0000-4000-8000-0000000000' || k)::uuid, 'authenticated', 'authenticated',
       'ds-' || k || '@example.invalid', '{}'::jsonb
from unnest(array['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) k;
-- a1 OA, a2 OB, a3 P, a4 L, a5 T, a6 Q

insert into auth.users (id, aud, role, email, raw_app_meta_data)
select ('e2000000-0000-4000-8000-0000000000' || k)::uuid, 'authenticated', 'authenticated',
       'ds-' || k || '@students.cleffy.app', '{"user_type":"student"}'::jsonb
from unnest(array['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7']) k;
-- b1 p1, b2 p2, b3 l1, b4 l2, b5 t1, b6 oa1, b7 q1

create function pg_temp.provision (p_key text, p_teacher text, p_created timestamptz default now())
returns void language sql as $$
    insert into public.managed_students
        (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at,
         created_at)
    values (('e2000000-0000-4000-8000-0000000005' || p_key)::uuid,
            ('e2000000-0000-4000-8000-0000000000' || p_teacher)::uuid,
            ('e2000000-0000-4000-8000-0000000000' || p_key)::uuid,
            'Student ' || p_key, null, 'code', 'ds_' || p_key, now(), p_created);
$$;

create function pg_temp.district_of (p_key text) returns uuid language sql as $$
    select district_studio_id from public.managed_students
    where id = ('e2000000-0000-4000-8000-0000000005' || p_key)::uuid;
$$;

create function pg_temp.gone (p_key text) returns boolean language sql as $$
    select not exists (select 1 from auth.users where id = ('e2000000-0000-4000-8000-0000000000' || p_key)::uuid)
       and not exists (select 1 from public.managed_students
                       where id = ('e2000000-0000-4000-8000-0000000005' || p_key)::uuid);
$$;

create function pg_temp.live (p_key text) returns boolean language sql as $$
    select exists (select 1 from auth.users where id = ('e2000000-0000-4000-8000-0000000000' || p_key)::uuid)
       and exists (select 1 from public.managed_students
                   where id = ('e2000000-0000-4000-8000-0000000005' || p_key)::uuid and archived_at is null);
$$;

-- P's private student, from before P joined any district.
select pg_temp.provision ('b1', 'a3', now() - interval '1 day');

insert into public.studios (id, owner_id, name)
values ('e2000000-0000-4000-8000-0000000005da', 'e2000000-0000-4000-8000-0000000000a1', 'District A'),
       ('e2000000-0000-4000-8000-0000000005db', 'e2000000-0000-4000-8000-0000000000a2', 'District B');

insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
values ('e2000000-0000-4000-8000-0000000005da', now() - interval '17 days', 'admin', 'test'),
       ('e2000000-0000-4000-8000-0000000005db', now() - interval '17 days', 'admin', 'test');

-- T holds a seat in B first, then one in A.
insert into public.studio_members (studio_id, user_id, created_at)
values ('e2000000-0000-4000-8000-0000000005db', 'e2000000-0000-4000-8000-0000000000a5', now() - interval '2 days'),
       ('e2000000-0000-4000-8000-0000000005da', 'e2000000-0000-4000-8000-0000000000a5', now() - interval '1 day'),
       ('e2000000-0000-4000-8000-0000000005da', 'e2000000-0000-4000-8000-0000000000a3', now()),
       ('e2000000-0000-4000-8000-0000000005da', 'e2000000-0000-4000-8000-0000000000a4', now());

select pg_temp.provision ('b2', 'a3');
select pg_temp.provision ('b3', 'a4');
select pg_temp.provision ('b5', 'a5');
select pg_temp.provision ('b6', 'a1');
select pg_temp.provision ('b7', 'a6');

-- L leaves A, then provisions l2 as a private teacher.
delete from public.studio_members
where studio_id = 'e2000000-0000-4000-8000-0000000005da' and user_id = 'e2000000-0000-4000-8000-0000000000a4';

select pg_temp.provision ('b4', 'a4');

insert into public.documents (id, owner_id, title, storage_path)
values ('e2000000-0000-4000-8000-00000000d001', 'e2000000-0000-4000-8000-0000000000a3', 'Score',
        'e2000000-0000-4000-8000-00000000d001/original.pdf');

insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
select ('e2000000-0000-4000-8000-0000000a00' || k)::uuid, 'e2000000-0000-4000-8000-00000000d001', 0, 'text',
       '#112233', '{"x":0.3,"y":0.3,"size":0.02,"text":"student work"}',
       ('e2000000-0000-4000-8000-0000000000' || k)::uuid
from unnest(array['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7']) k;

-- ===========================================================================
-- What each roster row recorded when it was provisioned
-- ===========================================================================
select pg_temp.holds (
    'a private student provisioned before the teacher joined a district belongs to no district',
    $q$select pg_temp.district_of ('b1') is null$q$
);

select pg_temp.holds (
    'a student provisioned while seated in A belongs to A',
    $q$select pg_temp.district_of ('b2') = 'e2000000-0000-4000-8000-0000000005da'
       and pg_temp.district_of ('b3') = 'e2000000-0000-4000-8000-0000000005da'$q$
);

select pg_temp.holds (
    'a district''s owner provisions into their own district',
    $q$select pg_temp.district_of ('b6') = 'e2000000-0000-4000-8000-0000000005da'$q$
);

select pg_temp.holds (
    'a teacher seated in two districts provisions into the seat held longest (B), not both',
    $q$select pg_temp.district_of ('b5') = 'e2000000-0000-4000-8000-0000000005db'$q$
);

select pg_temp.holds (
    'after leaving the district, the teacher''s new students are their own',
    $q$select pg_temp.district_of ('b4') is null and pg_temp.district_of ('b7') is null$q$
);

select pg_temp.holds (
    'the purge''s scope for A is the students A provided, the departed teacher''s included',
    $q$select array_agg(student_user_id order by student_user_id) = array[
           'e2000000-0000-4000-8000-0000000000b2', 'e2000000-0000-4000-8000-0000000000b3',
           'e2000000-0000-4000-8000-0000000000b6']::uuid[]
       from public.retention_district_students ('e2000000-0000-4000-8000-0000000005da')$q$
);

select pg_temp.holds (
    'and for B, only the student provisioned under B',
    $q$select array_agg(student_user_id) = array['e2000000-0000-4000-8000-0000000000b5']::uuid[]
       from public.retention_district_students ('e2000000-0000-4000-8000-0000000005db')$q$
);

-- ===========================================================================
-- The record cannot be written by anyone but the provisioning trigger
-- ===========================================================================
select pg_temp.act_as_service ();

select pg_temp.refused (
    'the service role cannot move a student into a district by UPDATE',
    $q$update public.managed_students set district_studio_id = 'e2000000-0000-4000-8000-0000000005da'
       where id = 'e2000000-0000-4000-8000-0000000005b1'$q$,
    '42501'
);

select pg_temp.refused (
    'nor out of one',
    $q$update public.managed_students set district_studio_id = null
       where id = 'e2000000-0000-4000-8000-0000000005b2'$q$,
    '42501'
);

select pg_temp.act_as_server ();

insert into auth.users (id, aud, role, email, raw_app_meta_data)
values ('e2000000-0000-4000-8000-0000000000c1', 'authenticated', 'authenticated', 'ds-c1@students.cleffy.app',
        '{"user_type":"student"}');

insert into public.managed_students
    (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at,
     district_studio_id)
values ('e2000000-0000-4000-8000-0000000005c1', 'e2000000-0000-4000-8000-0000000000a6',
        'e2000000-0000-4000-8000-0000000000c1', 'Forged', null, 'code', 'ds_c1', now(),
        'e2000000-0000-4000-8000-0000000005da');

select pg_temp.holds (
    'a district supplied on INSERT is ignored: the trigger records the teacher''s own',
    $q$select pg_temp.district_of ('c1') is null$q$
);

select pg_temp.holds (
    'other updates of the row are unaffected (an archive and a restore)',
    $q$with a as (
           update public.managed_students set archived_at = now()
           where id = 'e2000000-0000-4000-8000-0000000005b2' returning 1
       ), r as (
           update public.managed_students set archived_at = null
           where id = 'e2000000-0000-4000-8000-0000000005b3' returning 1
       )
       select (select count(*) from a) = 1 and (select count(*) from r) = 1$q$
);

update public.managed_students set archived_at = null where id = 'e2000000-0000-4000-8000-0000000005b2';

select pg_temp.act_as ('e2000000-0000-4000-8000-0000000000a1');

select pg_temp.refused (
    'a client cannot call the admin correction',
    $q$select public.admin_set_student_district ('e2000000-0000-4000-8000-0000000005b1', null, 'x')$q$,
    '42501'
);

select pg_temp.refused (
    'nor read the attribution column',
    $q$select district_studio_id from public.managed_students$q$,
    '42501'
);

select pg_temp.act_as_server ();

select public.admin_set_student_district (
    'e2000000-0000-4000-8000-0000000005c1', 'e2000000-0000-4000-8000-0000000005db', 'test admin'
);

select pg_temp.holds (
    'the admin correction moves one student, and is logged with who made it',
    $q$select pg_temp.district_of ('c1') = 'e2000000-0000-4000-8000-0000000005db'
       and exists (select 1 from public.district_retention_log
                   where step = 'attribution_changed' and counts ->> 'actor' = 'test admin'
                     and counts ->> 'managed_student_id' = 'e2000000-0000-4000-8000-0000000005c1')$q$
);

select public.admin_set_student_district ('e2000000-0000-4000-8000-0000000005c1', null, 'test admin');

-- ===========================================================================
-- The backfill for rows provisioned before 20261021120800
-- ===========================================================================
create temp table before_backfill as
select id, district_studio_id from public.managed_students where id::text like 'e2000000-%';

grant select on before_backfill to public;

-- Pretend p2, l1 and oa1 predate the column.
set local cleffy.district_attribution = 'admin';
update public.managed_students set district_studio_id = null
where id in ('e2000000-0000-4000-8000-0000000005b2', 'e2000000-0000-4000-8000-0000000005b3',
             'e2000000-0000-4000-8000-0000000005b6');
set local cleffy.district_attribution = '';

select public.backfill_district_student_attribution ();

select pg_temp.holds (
    'the backfill attributes the owner''s student and a seated teacher''s student created since the seat',
    $q$select pg_temp.district_of ('b2') = 'e2000000-0000-4000-8000-0000000005da'
       and pg_temp.district_of ('b6') = 'e2000000-0000-4000-8000-0000000005da'$q$
);

select pg_temp.holds (
    'but never a private student from before the seat, nor a departed teacher''s (no record is left)',
    $q$select pg_temp.district_of ('b1') is null and pg_temp.district_of ('b3') is null$q$
);

select public.admin_set_student_district (
    'e2000000-0000-4000-8000-0000000005b3', 'e2000000-0000-4000-8000-0000000005da', 'test admin'
);

select pg_temp.holds (
    'the backfill touched nothing it was not asked to, and a second run changes nothing',
    $q$select public.backfill_district_student_attribution () = 0
       and not exists (
           select 1 from before_backfill b join public.managed_students ms using (id)
           where ms.district_studio_id is distinct from b.district_studio_id)$q$
);

-- ===========================================================================
-- Both contracts end: notice, soft delete, hard delete
-- ===========================================================================
select public.retention_district_run (now());

select public.finish_district_retention_notice (id) from public.claim_district_retention_notices (20);

select public.retention_district_run (now() + interval '14 days 1 minute');

select pg_temp.holds (
    'the soft delete archives A''s and B''s students and nobody else',
    $q$select (select count(*) = 4 from public.district_retention_students)
       and pg_temp.live ('b1') and pg_temp.live ('b4') and pg_temp.live ('b7')
       and (select bool_and(archived_at is not null) from public.managed_students
            where id in ('e2000000-0000-4000-8000-0000000005b2', 'e2000000-0000-4000-8000-0000000005b3',
                         'e2000000-0000-4000-8000-0000000005b5', 'e2000000-0000-4000-8000-0000000005b6'))$q$
);

select public.retention_district_run (now() + interval '21 days 2 minutes');

select pg_temp.holds (
    'the hard delete removes the districts'' students, the departed teacher''s l1 included',
    $q$select pg_temp.gone ('b2') and pg_temp.gone ('b3') and pg_temp.gone ('b5') and pg_temp.gone ('b6')$q$
);

select pg_temp.holds (
    'and never the teacher''s private students (p1 from before joining, l2 from after leaving), nor Q''s',
    $q$select pg_temp.live ('b1') and pg_temp.live ('b4') and pg_temp.live ('b7') and pg_temp.live ('c1')
       and (select bool_and(deleted_at is null and payload ->> 'text' = 'student work') from public.annotations
            where created_by in ('e2000000-0000-4000-8000-0000000000b1', 'e2000000-0000-4000-8000-0000000000b4',
                                 'e2000000-0000-4000-8000-0000000000b7'))$q$
);

select pg_temp.holds (
    'every teacher account and the teacher''s score are untouched',
    $q$select (select count(*) = 6 from auth.users where id::text like 'e2000000-0000-4000-8000-0000000000a%')
       and exists (select 1 from public.documents where id = 'e2000000-0000-4000-8000-00000000d001')$q$
);

select pg_temp.holds (
    'the hard-delete counts name the students each district provided',
    $q$select (select (counts ->> 'students_deleted')::int = 3 from public.district_retention_log
               where studio_id = 'e2000000-0000-4000-8000-0000000005da' and step = 'hard_deleted')
       and (select (counts ->> 'students_deleted')::int = 1 from public.district_retention_log
            where studio_id = 'e2000000-0000-4000-8000-0000000005db' and step = 'hard_deleted')$q$
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
