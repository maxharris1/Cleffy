-- District retention: the re-list is idempotent (20261022130300, decision
-- 67(b) and (c)), against a real database. LOCAL STACK or the dev branch
-- project only. Same harness as district_retention_late_student.sql: one
-- transaction ending in ROLLBACK, time moved by the functions' p_now; the last
-- line is `failures | total` (scripts/ci/sql-proof.sh reads it), after any
-- failing checks.
--
-- Every run lists, archives and signs out the students attributed to a
-- soft-deleted district who are not on its list yet, and the hard delete does
-- the same right before it deletes. Only students not already listed are
-- touched: a second run (the same day or the next) lists, archives, signs out
-- and logs nothing, leaves each listed student's stamps as they were, and does
-- not undo a teacher's restore of a listed student.
--
-- The late students are written past the roster trigger's barrier (it is off
-- for their one insert each), as in district_retention_late_student.sql: rows
-- the barrier did not stop, which is what the re-list is for.
--
-- Cast: O owns district L (contract ended 17 days ago). e1 is provisioned for
-- L before the purge (the control). After the soft delete: c1 (active, signed
-- in on one device) and c2 (already archived by O) are attributed to L; later,
-- after the last sweep before the hard delete, c3.

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

create temp table ran (k text primary key, v jsonb);

grant all on ran to public;

-- Each listed student's list entry and roster stamps, after a run.
create temp table seen (k text, managed_student_id uuid, was_archived boolean, archived_at timestamptz,
                        access_revoked_at timestamptz);

grant all on seen to public;

create function pg_temp.roster (p text) returns uuid language sql immutable as $$
    select ('d5500000-0000-4000-8000-0000000005' || p)::uuid;
$$;

create function pg_temp.account (p text) returns uuid language sql immutable as $$
    select ('d5500000-0000-4000-8000-0000000000' || p)::uuid;
$$;

create function pg_temp.listed (p text) returns boolean language sql as $$
    select exists (select 1 from public.district_retention_students
                   where studio_id = 'd5500000-0000-4000-8000-0000000005d1' and managed_student_id = pg_temp.roster (p));
$$;

create function pg_temp.was_archived (p text) returns boolean language sql as $$
    select was_archived from public.district_retention_students
    where studio_id = 'd5500000-0000-4000-8000-0000000005d1' and managed_student_id = pg_temp.roster (p);
$$;

create function pg_temp.archived (p text) returns boolean language sql as $$
    select archived_at is not null and access_revoked_at is not null
    from public.managed_students where id = pg_temp.roster (p);
$$;

create function pg_temp.late_logs () returns bigint language sql as $$
    select count(*) from public.district_retention_log
    where studio_id = 'd5500000-0000-4000-8000-0000000005d1' and step = 'soft_deleted'
      and counts ->> 'event' = 'late_students_listed';
$$;

create function pg_temp.snapshot (p_k text) returns void language sql as $$
    insert into seen
    select p_k, s.managed_student_id, s.was_archived, ms.archived_at, ms.access_revoked_at
    from public.district_retention_students s
    join public.managed_students ms on ms.id = s.managed_student_id
    where s.studio_id = 'd5500000-0000-4000-8000-0000000005d1';
$$;

-- Whether two snapshots are the same rows, stamps and all.
create function pg_temp.same (p_a text, p_b text) returns boolean language sql as $$
    select not exists (
        (select managed_student_id, was_archived, archived_at, access_revoked_at from seen where k = p_a
         except
         select managed_student_id, was_archived, archived_at, access_revoked_at from seen where k = p_b)
        union all
        (select managed_student_id, was_archived, archived_at, access_revoked_at from seen where k = p_b
         except
         select managed_student_id, was_archived, archived_at, access_revoked_at from seen where k = p_a)
    ) and exists (select 1 from seen where k = p_a);
$$;

create function pg_temp.provision (p text, p_archived boolean default false) returns void language sql as $$
    insert into public.managed_students
        (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at,
         district_studio_id, archived_at)
    values (pg_temp.roster (p), pg_temp.account ('a1'), pg_temp.account (p), 'Student ' || p, null, 'code',
            'li_' || p, now(), 'd5500000-0000-4000-8000-0000000005d1',
            case when p_archived then now() - interval '1 day' end);
$$;

-- The same, past the barrier (the one trigger that refuses it, off for this
-- insert only).
create function pg_temp.provision_past_barrier (p text, p_archived boolean default false) returns void
language plpgsql as $$
begin
    alter table public.managed_students disable trigger managed_students_district_attribution;
    perform pg_temp.provision (p, p_archived);
    alter table public.managed_students enable trigger managed_students_district_attribution;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email, raw_app_meta_data)
select pg_temp.account ('a1'), 'authenticated', 'authenticated', 'li-owner@example.invalid', '{}'::jsonb
union all
select pg_temp.account (s), 'authenticated', 'authenticated', 'li-' || s || '@students.cleffy.app',
       '{"user_type":"student"}'::jsonb
from unnest(array['e1', 'c1', 'c2', 'c3']) as s;

insert into public.studios (id, owner_id, name)
values ('d5500000-0000-4000-8000-0000000005d1', pg_temp.account ('a1'), 'District L');

insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
values ('d5500000-0000-4000-8000-0000000005d1', now() - interval '17 days', 'admin', 'test');

select pg_temp.provision ('e1');

-- ===========================================================================
-- Notice, sent, soft delete
-- ===========================================================================
select public.retention_district_run (now());

select public.finish_district_retention_notice (id) from public.claim_district_retention_notices (20);

insert into ran select 'soft', public.retention_district_run (now() + interval '14 days 1 minute');

select pg_temp.holds (
    'control: the soft delete lists e1, and its own sweep lists nobody else',
    $q$select (select (v ->> 'soft_delete')::int = 1 and (v ->> 'students_late_listed')::int = 0 from ran where k = 'soft')
          and pg_temp.listed ('e1') and pg_temp.late_logs () = 0$q$
);

-- ===========================================================================
-- Late students; O restores e1
-- ===========================================================================
select pg_temp.provision_past_barrier ('c1');

select pg_temp.provision_past_barrier ('c2', true);

insert into auth.sessions (id, user_id)
values ('d5500000-0000-4000-8000-00000000a5c1', pg_temp.account ('c1'));

insert into auth.refresh_tokens (token, user_id, session_id)
values ('relist-rt-c1', pg_temp.account ('c1'), 'd5500000-0000-4000-8000-00000000a5c1');

-- The teacher's restore of a listed student, as student-provision makes it.
update public.managed_students set archived_at = null where id = pg_temp.roster ('e1');

create temp table c2_archived_at as
select archived_at from public.managed_students where id = pg_temp.roster ('c2');

grant all on c2_archived_at to public;

-- ===========================================================================
-- The next run lists them; the runs after it change nothing
-- ===========================================================================
insert into ran select 'next', public.retention_district_run (now() + interval '15 days 1 minute');

select pg_temp.snapshot ('next');

select pg_temp.holds (
    'the next run lists c1 and c2 once, archives c1 and signs it out, and logs one late listing',
    $q$select (select (v ->> 'students_late_listed')::int = 2 from ran where k = 'next')
          and pg_temp.listed ('c1') and pg_temp.listed ('c2')
          and pg_temp.archived ('c1') and not pg_temp.was_archived ('c1')
          and not exists (select 1 from auth.sessions where user_id = pg_temp.account ('c1'))
          and not exists (select 1 from auth.refresh_tokens where user_id = pg_temp.account ('c1')::text)
          and pg_temp.late_logs () = 1
          and (select (counts ->> 'students_archived')::int = 2 and counts ->> 'by' = 'sweep'
               from public.district_retention_log
               where studio_id = 'd5500000-0000-4000-8000-0000000005d1' and counts ->> 'event' = 'late_students_listed')$q$
);

select pg_temp.holds (
    'c2, archived before it was listed, is listed as was_archived and keeps its own archive stamp',
    $q$select pg_temp.was_archived ('c2')
          and (select archived_at from public.managed_students where id = pg_temp.roster ('c2'))
              = (select archived_at from c2_archived_at)$q$
);

select pg_temp.holds (
    'the teacher''s restore of e1, a listed student, stands',
    $q$select pg_temp.listed ('e1')
          and (select archived_at is null from public.managed_students where id = pg_temp.roster ('e1'))$q$
);

insert into ran select 'same day', public.retention_district_run (now() + interval '15 days 2 minutes');

select pg_temp.snapshot ('same day');

insert into ran select 'day after', public.retention_district_run (now() + interval '16 days 1 minute');

select pg_temp.snapshot ('day after');

select pg_temp.holds (
    'a second run the same day, and one the day after, list nobody',
    $q$select (select bool_and((v ->> 'students_late_listed')::int = 0 and (v ->> 'soft_delete')::int = 0)
               from ran where k in ('same day', 'day after'))$q$
);

select pg_temp.holds (
    'and leave the list and every listed student''s stamps exactly as they were',
    $q$select pg_temp.same ('next', 'same day') and pg_temp.same ('next', 'day after')
          and (select count(*) = 3 from seen where k = 'day after')$q$
);

select pg_temp.holds (
    'nor log anything, nor undo the restore of e1',
    $q$select pg_temp.late_logs () = 1
          and (select archived_at is null from public.managed_students where id = pg_temp.roster ('e1'))$q$
);

-- ===========================================================================
-- c3, after the last sweep: the hard delete's own re-list
-- ===========================================================================
select pg_temp.provision_past_barrier ('c3');

insert into ran select 'hard', public.retention_district_run (now() + interval '21 days 2 minutes');

select pg_temp.holds (
    'the hard delete lists c3 under the district''s lock, logs it, and deletes c1, c2 and c3',
    $q$select (select (v ->> 'hard_delete')::int = 1 and (v ->> 'students_late_listed')::int = 1 from ran where k = 'hard')
          and pg_temp.late_logs () = 2
          and exists (select 1 from public.district_retention_log
                      where studio_id = 'd5500000-0000-4000-8000-0000000005d1'
                        and counts ->> 'event' = 'late_students_listed' and counts ->> 'by' = 'hard_delete'
                        and (counts ->> 'students_archived')::int = 1)
          and not exists (select 1 from auth.users
                          where id in (pg_temp.account ('c1'), pg_temp.account ('c2'), pg_temp.account ('c3')))$q$
);

insert into ran select 'after', public.retention_district_run (now() + interval '22 days');

select pg_temp.holds (
    'a run after the hard delete has nothing left to list or log',
    $q$select (select (v ->> 'students_late_listed')::int = 0 and (v ->> 'hard_delete')::int = 0 from ran where k = 'after')
          and pg_temp.late_logs () = 2$q$
);

-- ---------------------------------------------------------------------------
-- Report: every check, then `failures | total`
-- ---------------------------------------------------------------------------
select n, check_name, passed, detail from integrity_results order by n;

select count(*) filter (where not passed) as failures, count(*) as total from integrity_results;

rollback;
