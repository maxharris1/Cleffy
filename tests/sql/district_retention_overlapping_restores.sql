-- Overlapping district purges hand a carried restore on (20261022140000),
-- against a real database. LOCAL STACK or the dev branch project only. Same
-- harness as district_retention_reattribution.sql: one transaction ending in
-- ROLLBACK, time moved by the functions' p_now; the last line is
-- `failures | total` (scripts/ci/sql-proof.sh reads it), after any failing
-- checks.
--
-- Decision 47's residual (a follow-up by 66(1)): a student whom district A's
-- soft delete archived and a human then moved to district B, whose purge
-- lists them too, has the restore record under A only. B's entry says
-- was_archived (A had archived them), so B's cancel does not un-archive them.
-- Before 20261022140000, A's end deleted A's record (its cancel after
-- retrying it, its hard delete without looking, its skip of a student moved
-- the raw way without carrying anything), and B's renewal left the student
-- archived for good.
--
-- Cast: O owns district A and is seated in district C, P owns C, Q owns B.
-- O has no plan of their own (free: no roster) until B's renewal. Every
-- student is O's, with a mark on O's score.
--   s1  provisioned in A; admin_set_student_district -> B (restore carried, A)
--   s2  provisioned in A; moved to B the raw way (A's list entry left behind)
--   s3  provisioned in C; admin_set_student_district -> B (restore carried, C)
--   s4  provisioned in A; untouched: the control, deleted with A
-- A and C are soft deleted first; then B's contract ends and B's soft delete
-- lists s1-s3 (was_archived true). C is renewed (its cancel), A is hard
-- deleted, then B is renewed while O is paying: B's cancel must un-archive
-- s1, s2 and s3.

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

-- Districts d6...06d<x>; s1 .. s4 roster d6...06b<n>, accounts d6...00b<n>, marks d6...a00b<n>.
create function pg_temp.district (p text) returns uuid language sql immutable as $$
    select ('d6000000-0000-4000-8000-0000000006d' || p)::uuid;
$$;

create function pg_temp.roster (p text) returns uuid language sql immutable as $$
    select ('d6000000-0000-4000-8000-0000000006' || p)::uuid;
$$;

create function pg_temp.account (p text) returns uuid language sql immutable as $$
    select ('d6000000-0000-4000-8000-0000000000' || p)::uuid;
$$;

create function pg_temp.mark (p text) returns uuid language sql immutable as $$
    select ('d6000000-0000-4000-8000-0000000a00' || p)::uuid;
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
-- a1 O, a2 P, a3 Q.
insert into auth.users (id, aud, role, email, raw_app_meta_data)
select pg_temp.account (s), 'authenticated', 'authenticated', 'or-' || s || '@example.invalid', '{}'::jsonb
from unnest(array['a1', 'a2', 'a3']) as s
union all
select pg_temp.account (s), 'authenticated', 'authenticated', 'or-' || s || '@students.cleffy.app',
       '{"user_type":"student"}'::jsonb
from unnest(array['b1', 'b2', 'b3', 'b4']) as s;

insert into public.studios (id, owner_id, name)
values (pg_temp.district ('a'), pg_temp.account ('a1'), 'District A'),
       (pg_temp.district ('b'), pg_temp.account ('a3'), 'District B'),
       (pg_temp.district ('c'), pg_temp.account ('a2'), 'District C');

insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
values (pg_temp.district ('a'), now() - interval '17 days', 'admin', 'test'),
       (pg_temp.district ('b'), null, null, 'test'),
       (pg_temp.district ('c'), now() - interval '17 days', 'admin', 'test');

-- O teaches in C too.
insert into public.studio_members (studio_id, user_id) values (pg_temp.district ('c'), pg_temp.account ('a1'));

insert into public.managed_students
    (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at,
     district_studio_id)
select pg_temp.roster (s), pg_temp.account ('a1'), pg_temp.account (s), 'Student ' || s, null, 'code', 'or_' || s, now(),
       pg_temp.district (case when s = 'b3' then 'c' else 'a' end)
from unnest(array['b1', 'b2', 'b3', 'b4']) as s;

insert into public.documents (id, owner_id, title, storage_path)
values ('d6000000-0000-4000-8000-00000000d001', pg_temp.account ('a1'), 'Score',
        'd6000000-0000-4000-8000-00000000d001/original.pdf');

insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
select pg_temp.mark (s), 'd6000000-0000-4000-8000-00000000d001', 0, 'text', '#112233',
       jsonb_build_object('x', 0.3, 'y', 0.3, 'size', 0.02, 'text', 'work of ' || s), pg_temp.account (s)
from unnest(array['b1', 'b2', 'b3', 'b4']) as s;

-- ===========================================================================
-- A's and C's notices, sent, soft deletes
-- ===========================================================================
select public.retention_district_run (now());

select public.finish_district_retention_notice (id) from public.claim_district_retention_notices (20);

insert into ran select 'soft_ac', public.retention_district_run (now() + interval '14 days 1 minute');

select pg_temp.holds (
    'A''s and C''s soft deletes list and archive their students, none archived before',
    $q$select (select (v ->> 'soft_delete')::int = 2 and (v ->> 'students_archived')::int = 4 from ran where k = 'soft_ac')
          and pg_temp.listed ('a', 'b1') and pg_temp.listed ('a', 'b2') and pg_temp.listed ('a', 'b4')
          and pg_temp.listed ('c', 'b3')
          and (select bool_and(not was_archived) from public.district_retention_students)
          and pg_temp.archived ('b1') and pg_temp.archived ('b2') and pg_temp.archived ('b3') and pg_temp.archived ('b4')$q$
);

-- ===========================================================================
-- Moved to B while B is still live (no contract end, so no barrier)
-- ===========================================================================
select public.admin_set_student_district (pg_temp.roster ('b1'), pg_temp.district ('b'), 'test admin');

select public.admin_set_student_district (pg_temp.roster ('b3'), pg_temp.district ('b'), 'test admin');

-- s2: the raw admin UPDATE, which leaves A's list entry behind.
select set_config('cleffy.district_attribution', 'admin', true);

update public.managed_students set district_studio_id = pg_temp.district ('b'), district_attribution = 'admin'
where id = pg_temp.roster ('b2');

select set_config('cleffy.district_attribution', '', true);

select pg_temp.holds (
    's1 and s3 stay archived (O has no roster) and their restores are carried over under A and C; s2 is still on A''s list',
    $q$select pg_temp.archived ('b1') and pg_temp.archived ('b3')
          and pg_temp.carried ('a', 'b1') and pg_temp.carried ('c', 'b3')
          and not pg_temp.listed ('a', 'b1') and not pg_temp.listed ('c', 'b3') and pg_temp.listed ('a', 'b2')$q$
);

-- ===========================================================================
-- B's contract ends: notice, sent, soft delete
-- ===========================================================================
update public.district_billing set contract_ends_at = now() - interval '17 days', contract_ends_source = 'admin'
where studio_id = pg_temp.district ('b');

select public.retention_district_run (now() + interval '14 days 2 minutes');

select public.finish_district_retention_notice (id) from public.claim_district_retention_notices (20);

insert into ran select 'soft_b', public.retention_district_run (now() + interval '14 days 3 minutes');

select pg_temp.holds (
    'B''s soft delete lists s1, s2 and s3, each as archived already (A or C archived them)',
    $q$select (select (v ->> 'soft_delete')::int = 1 from ran where k = 'soft_b')
          and (select count(*) = 3 and bool_and(was_archived) from public.district_retention_students
               where studio_id = pg_temp.district ('b'))$q$
);

-- ===========================================================================
-- C is renewed: its cancel retries s3's restore, which B's purge blocks
-- ===========================================================================
update public.district_billing set contract_ends_at = now() + interval '1 year'
where studio_id = pg_temp.district ('c');

insert into ran select 'cancel_c', public.retention_district_run (now() + interval '15 days');

select pg_temp.holds (
    'C''s cancel cannot restore s3 (B''s purge lists them) and hands the restore on to B instead of deleting it',
    $q$select (select (v ->> 'cancel')::int = 1 from ran where k = 'cancel_c')
          and pg_temp.archived ('b3') and not pg_temp.carried ('c', 'b3') and pg_temp.carried ('b', 'b3')
          and (select (counts ->> 'restores_handed_on')::int = 1 and (counts ->> 'reattributed_restored')::int = 0
               from public.district_retention_log
               where studio_id = pg_temp.district ('c') and step = 'cancelled')$q$
);

-- ===========================================================================
-- A's hard delete
-- ===========================================================================
insert into ran select 'hard_a', public.retention_district_run (now() + interval '21 days 2 minutes');

select pg_temp.holds (
    'A''s hard delete deletes only the control s4; s1 and s2, now B''s, survive archived',
    $q$select (select (v ->> 'hard_delete')::int = 1 and (v ->> 'students_deleted')::int = 1 from ran where k = 'hard_a')
          and not exists (select 1 from auth.users where id = pg_temp.account ('b4'))
          and pg_temp.survives ('b1') and pg_temp.survives ('b2')
          and pg_temp.archived ('b1') and pg_temp.archived ('b2')$q$
);

select pg_temp.holds (
    'A''s hard delete hands s1''s carried restore and s2''s skip on to B, before A''s own records go',
    $q$select pg_temp.carried ('b', 'b1') and pg_temp.carried ('b', 'b2')
          and not exists (select 1 from public.district_retention_restores where studio_id = pg_temp.district ('a'))
          and (select (counts ->> 'restores_handed_on')::int = 2 from public.district_retention_log
               where studio_id = pg_temp.district ('a') and step = 'hard_deleted')$q$
);

select pg_temp.holds (
    'each hand-on is logged under B as attribution_changed, event restore_handed_on, naming the district it came from',
    $q$select count(*) = 3
          and bool_or(counts ->> 'managed_student_id' = pg_temp.roster ('b1')::text
                      and counts ->> 'from' = pg_temp.district ('a')::text)
          and bool_or(counts ->> 'managed_student_id' = pg_temp.roster ('b2')::text
                      and counts ->> 'from' = pg_temp.district ('a')::text)
          and bool_or(counts ->> 'managed_student_id' = pg_temp.roster ('b3')::text
                      and counts ->> 'from' = pg_temp.district ('c')::text)
       from public.district_retention_log
       where studio_id = pg_temp.district ('b') and step = 'attribution_changed'
         and counts ->> 'event' = 'restore_handed_on'$q$
);

select pg_temp.holds (
    'no log row uses a step 20261021120800 does not know (its replay rebuilds the check)',
    $q$select bool_and(step in ('notice_queued', 'notice_sent', 'soft_deleted', 'hard_deleted', 'cancelled',
                                'attribution_changed', 'attribution_backfilled', 'attribution_backfill_run'))
       from public.district_retention_log$q$
);

-- ===========================================================================
-- B is renewed while O is paying: its cancel restores all three
-- ===========================================================================
update public.district_billing set contract_ends_at = now() + interval '1 year'
where studio_id = pg_temp.district ('b');

set local role service_role;

select public.write_subscription_under_lock (
    public.claim_subscription_write ('sub_or_teacher', interval '5 minutes'),
    'sub_or_teacher', pg_temp.account ('a1'), 'test', 'teacher', 'active', 'price_teacher_annual',
    now() + interval '1 year', false, now() - interval '1 hour'
);

reset role;

insert into ran select 'cancel_b', public.retention_district_run (now() + interval '22 days');

select pg_temp.holds (
    'B''s renewal un-archives s1, s2 and s3, whose restores the ended purges handed on to it',
    $q$select (select (v ->> 'cancel')::int = 1 and (v ->> 'students_restored')::int = 3 from ran where k = 'cancel_b')
          and not pg_temp.archived ('b1') and not pg_temp.archived ('b2') and not pg_temp.archived ('b3')
          and pg_temp.survives ('b1') and pg_temp.survives ('b2') and pg_temp.survives ('b3')
          and (select (counts ->> 'reattributed_restored')::int = 3 from public.district_retention_log
               where studio_id = pg_temp.district ('b') and step = 'cancelled')$q$
);

select pg_temp.holds (
    'nothing is left on any list or restore record',
    $q$select not exists (select 1 from public.district_retention_restores
                          where studio_id in (pg_temp.district ('a'), pg_temp.district ('b'), pg_temp.district ('c')))
          and not exists (select 1 from public.district_retention_students
                          where studio_id in (pg_temp.district ('a'), pg_temp.district ('b'), pg_temp.district ('c')))$q$
);

-- ===========================================================================
-- Still nobody's but the run's
-- ===========================================================================
select pg_temp.act_as (pg_temp.account ('a1'));

select pg_temp.refused (
    'a client cannot hand a restore on',
    $q$select public.district_retention_hand_on_restore (gen_random_uuid (), gen_random_uuid (), gen_random_uuid ())$q$,
    '42501'
);

select pg_temp.refused (
    'nor take the overlap locks',
    $q$select public.district_retention_lock_overlaps (gen_random_uuid ())$q$,
    '42501'
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'the run keeps its signature and service-role-only grant; the two helpers are not even the service role''s',
    $q$select has_function_privilege('service_role', 'public.retention_district_run(timestamptz, int)', 'execute')
          and not has_function_privilege('authenticated', 'public.retention_district_run(timestamptz, int)', 'execute')
          and not has_function_privilege('service_role', 'public.district_retention_hand_on_restore(uuid, uuid, uuid)', 'execute')
          and not has_function_privilege('service_role', 'public.district_retention_lock_overlaps(uuid)', 'execute')
          and not has_function_privilege('anon', 'public.district_retention_lock_overlaps(uuid)', 'execute')$q$
);

-- ---------------------------------------------------------------------------
-- Report: every check, then `failures | total`
-- ---------------------------------------------------------------------------
select n, check_name, passed, detail from integrity_results order by n;

select count(*) filter (where not passed) as failures, count(*) as total from integrity_results;

rollback;
