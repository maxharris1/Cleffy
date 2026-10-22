-- The hard delete detaches the students it keeps (20261022140100, decision
-- 68(2)), against a real database. LOCAL STACK or the dev branch project
-- only. Same harness as district_retention_reattribution.sql: one transaction
-- ending in ROLLBACK, time moved by the functions' p_now; the last line is
-- `failures | total` (scripts/ci/sql-proof.sh reads it), after any failing
-- checks.
--
-- A teacher's restore during the purge week still wins (20261021120700): the
-- restored student is not deleted. Before 20261022140100 they kept a
-- district_studio_id naming the district the hard delete removed. Now it is
-- cleared, and nothing else changes.
--
-- Cast: O owns district A (contract ended 17 days ago) on their own Teacher
-- plan; Q owns district B (no contract end). All four students are O's, with a
-- mark on O's score, provisioned in A:
--   k1  restored by O during the purge week: kept, detached
--   k2  untouched: the control, deleted
--   k3  an account that is not a provisioned student: kept, detached
--   k4  moved to B by an admin during the purge week: kept, still B's (the
--       correction restores them, O's plan having room)

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

create temp table ran (k text primary key, v jsonb);

grant all on ran to public;

-- Districts d7...07d<x>; k1 .. k4 roster d7...07b<n>, accounts d7...00b<n>, marks d7...a00b<n>.
create function pg_temp.district (p text) returns uuid language sql immutable as $$
    select ('d7000000-0000-4000-8000-0000000007d' || p)::uuid;
$$;

create function pg_temp.roster (p text) returns uuid language sql immutable as $$
    select ('d7000000-0000-4000-8000-0000000007' || p)::uuid;
$$;

create function pg_temp.account (p text) returns uuid language sql immutable as $$
    select ('d7000000-0000-4000-8000-0000000000' || p)::uuid;
$$;

create function pg_temp.mark (p text) returns uuid language sql immutable as $$
    select ('d7000000-0000-4000-8000-0000000a00' || p)::uuid;
$$;

create function pg_temp.survives (p text) returns boolean language sql as $$
    select exists (select 1 from auth.users where id = pg_temp.account (p))
       and exists (select 1 from public.managed_students where id = pg_temp.roster (p))
       and exists (select 1 from public.annotations
                   where id = pg_temp.mark (p) and deleted_at is null and payload ->> 'text' = 'work of ' || p);
$$;

create function pg_temp.archived (p text) returns boolean language sql as $$
    select archived_at is not null from public.managed_students where id = pg_temp.roster (p);
$$;

create function pg_temp.carried (p_district text, p text) returns boolean language sql as $$
    select exists (select 1 from public.district_retention_restores
                   where studio_id = pg_temp.district (p_district) and managed_student_id = pg_temp.roster (p));
$$;

create function pg_temp.listed (p_district text, p text) returns boolean language sql as $$
    select exists (select 1 from public.district_retention_students
                   where studio_id = pg_temp.district (p_district) and managed_student_id = pg_temp.roster (p));
$$;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
-- a1 O, a3 Q.
insert into auth.users (id, aud, role, email, raw_app_meta_data)
select pg_temp.account (s), 'authenticated', 'authenticated', 'dk-' || s || '@example.invalid', '{}'::jsonb
from unnest(array['a1', 'a3', 'b3']) as s
union all
select pg_temp.account (s), 'authenticated', 'authenticated', 'dk-' || s || '@students.cleffy.app',
       '{"user_type":"student"}'::jsonb
from unnest(array['b1', 'b2', 'b4']) as s;

insert into public.studios (id, owner_id, name)
values (pg_temp.district ('a'), pg_temp.account ('a1'), 'District A'),
       (pg_temp.district ('b'), pg_temp.account ('a3'), 'District B');

insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
values (pg_temp.district ('a'), now() - interval '17 days', 'admin', 'test'),
       (pg_temp.district ('b'), null, null, 'test');

set local role service_role;

select public.write_subscription_under_lock (
    public.claim_subscription_write ('sub_dk_teacher', interval '5 minutes'),
    'sub_dk_teacher', pg_temp.account ('a1'), 'test', 'teacher', 'active', 'price_teacher_annual',
    now() + interval '1 year', false, now() - interval '1 hour'
);

reset role;

insert into public.managed_students
    (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at,
     district_studio_id)
select pg_temp.roster (s), pg_temp.account ('a1'), pg_temp.account (s), 'Student ' || s, null, 'code', 'dk_' || s, now(),
       pg_temp.district ('a')
from unnest(array['b1', 'b2', 'b3', 'b4']) as s;

insert into public.documents (id, owner_id, title, storage_path)
values ('d7000000-0000-4000-8000-00000000d001', pg_temp.account ('a1'), 'Score',
        'd7000000-0000-4000-8000-00000000d001/original.pdf');

insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
select pg_temp.mark (s), 'd7000000-0000-4000-8000-00000000d001', 0, 'text', '#112233',
       jsonb_build_object('x', 0.3, 'y', 0.3, 'size', 0.02, 'text', 'work of ' || s), pg_temp.account (s)
from unnest(array['b1', 'b2', 'b3', 'b4']) as s;

-- ===========================================================================
-- Notice, sent, soft delete
-- ===========================================================================
select public.retention_district_run (now());

select public.finish_district_retention_notice (id) from public.claim_district_retention_notices (20);

insert into ran select 'soft', public.retention_district_run (now() + interval '14 days 1 minute');

select pg_temp.holds (
    'the soft delete lists and archives all four',
    $q$select (select (v ->> 'students_archived')::int = 4 from ran where k = 'soft')
          and pg_temp.listed ('a', 'b1') and pg_temp.listed ('a', 'b2') and pg_temp.listed ('a', 'b3')
          and pg_temp.listed ('a', 'b4')
          and pg_temp.archived ('b1') and pg_temp.archived ('b2') and pg_temp.archived ('b3') and pg_temp.archived ('b4')$q$
);

-- ===========================================================================
-- The purge week: O restores k1, an admin moves k4 to B
-- ===========================================================================
update public.managed_students set archived_at = null where id = pg_temp.roster ('b1');

select public.admin_set_student_district (pg_temp.roster ('b4'), pg_temp.district ('b'), 'test admin');

-- ===========================================================================
-- The hard delete
-- ===========================================================================
insert into ran select 'hard', public.retention_district_run (now() + interval '21 days 2 minutes');

select pg_temp.holds (
    'k2, still archived, is scrubbed and deleted, as before',
    $q$select not exists (select 1 from auth.users where id = pg_temp.account ('b2'))
          and not exists (select 1 from public.managed_students where id = pg_temp.roster ('b2'))
          and (select deleted_at is not null and payload ->> 'text' = '' from public.annotations
               where id = pg_temp.mark ('b2'))$q$
);

select pg_temp.holds (
    'k1, restored by their teacher, survives with their marking, un-archived: the restore still wins',
    $q$select pg_temp.survives ('b1') and not pg_temp.archived ('b1')$q$
);

select pg_temp.holds (
    'k1 is detached: district_studio_id cleared, attribution and teacher unchanged (decision 68(2))',
    $q$select district_studio_id is null and district_attribution = 'provisioned' and teacher_id = pg_temp.account ('a1')
       from public.managed_students where id = pg_temp.roster ('b1')$q$
);

select pg_temp.holds (
    'k3, not a provisioned student, is kept and detached too: nothing names the deleted district',
    $q$select pg_temp.survives ('b3')
          and (select district_studio_id is null from public.managed_students where id = pg_temp.roster ('b3'))
          and not exists (select 1 from public.managed_students where district_studio_id = pg_temp.district ('a'))$q$
);

select pg_temp.holds (
    'k4, moved to B before the hard delete (and restored by that correction: O''s plan has room), is still B''s',
    $q$select pg_temp.survives ('b4') and not pg_temp.archived ('b4')
          and (select district_studio_id = pg_temp.district ('b') from public.managed_students
               where id = pg_temp.roster ('b4'))$q$
);

select pg_temp.holds (
    'the detach is logged under A as attribution_changed, event detached_kept, naming k1 (restored) and k3',
    $q$select (counts ->> 'students_detached')::int = 2 and counts ->> 'by' = 'retention_district_run'
          and (select array_agg((e ->> 'managed_student_id') || ':' || (e ->> 'restored')
                                order by e ->> 'managed_student_id')
               from jsonb_array_elements(counts -> 'students') e)
              = array[pg_temp.roster ('b1')::text || ':true', pg_temp.roster ('b3')::text || ':false']
       from public.district_retention_log
       where studio_id = pg_temp.district ('a') and step = 'attribution_changed'
         and counts ->> 'event' = 'detached_kept'$q$
);

select pg_temp.holds (
    'the hard delete''s counts keep their shape; the run''s result says two detached and one deleted',
    $q$select (select counts = '{"studios":1,"students_deleted":1,"members_removed":0}'::jsonb
               from public.district_retention_log
               where studio_id = pg_temp.district ('a') and step = 'hard_deleted')
          and (select (v ->> 'students_detached')::int = 2 and (v ->> 'students_deleted')::int = 1
               from ran where k = 'hard')$q$
);

select pg_temp.holds (
    'A is gone; no log row uses a step 20261021120800 does not know',
    $q$select not exists (select 1 from public.studios where id = pg_temp.district ('a'))
          and (select bool_and(step in ('notice_queued', 'notice_sent', 'soft_deleted', 'hard_deleted', 'cancelled',
                                        'attribution_changed', 'attribution_backfilled', 'attribution_backfill_run'))
               from public.district_retention_log)$q$
);

select pg_temp.holds (
    'a later run finds nothing more to do for A',
    $q$select (v ->> 'hard_delete')::int = 0 and (v ->> 'cancel')::int = 0
       from (select public.retention_district_run (now() + interval '30 days') as v) r$q$
);

-- ---------------------------------------------------------------------------
-- Report: every check, then `failures | total`
-- ---------------------------------------------------------------------------
select n, check_name, passed, detail from integrity_results order by n;

select count(*) filter (where not passed) as failures, count(*) as total from integrity_results;

rollback;
