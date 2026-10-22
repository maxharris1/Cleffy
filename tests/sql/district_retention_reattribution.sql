-- District retention re-attribution (20261022130000), against a real database.
-- LOCAL STACK or the dev branch project only. Same harness as
-- district_retention.sql: one transaction ending in ROLLBACK, time moved by
-- the functions' p_now; the last line is `failures | total`
-- (scripts/ci/sql-proof.sh reads it), after any failing checks.
--
-- Launch re-audit, Codex A4: a student the soft delete listed under district A
-- and a human then re-attributed (to a private roster, or to district B) must
-- survive A's hard delete, markings and all, and the log must say why. Codex
-- round 1 on #66, minor 2, and Cleffy's decision: one archived only because A
-- lapsed is un-archived as part of the re-attribution if their teacher's plan
-- has room, and otherwise when A's contract is renewed.
--
-- Cast: O owns district A (contract ended 17 days ago) and district B (no
-- contract end), and has no plan of their own (free: no roster). T teaches in
-- A on their own Teacher plan (unlimited roster). P owns district C (contract
-- ended 17 days ago), also free until C is renewed. Every student has a mark on
-- O's score. After the soft deletes:
--   r1  O's, admin_set_student_district -> private (null): O's plan has no
--       roster, so r1 stays archived and the restore is carried over
--   r2  O's, admin_set_student_district -> B: likewise
--   r3  O's, re-attributed the way 20261021120800's correction did it, which
--       left the purge list alone (the hard delete's re-check is the backstop)
--   r4  O's, untouched: the control, still deleted
--   r5  O's, admin_set_student_district -> A again (re-confirmed): still deleted
--   r6  O's, its purge list entry names another account, x, than its roster
--       row does: neither r6 nor x is deleted
--   r8  T's, admin_set_student_district -> private: un-archived on the spot
--   r9  T's, archived by T before the soft delete, -> private: stays archived
--   s1  T's, re-attributed the old way: un-archived by the hard delete's skip
--   s2  P's (district C), -> private: carried over, then un-archived when C's
--       contract is renewed and P is paying again

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

-- r1 .. r6, and x as b7: roster ids d5...05b<n>, accounts d5...00b<n>, marks d5...a000<n>.
create function pg_temp.roster (p text) returns uuid language sql immutable as $$
    select ('d5000000-0000-4000-8000-0000000005' || p)::uuid;
$$;

create function pg_temp.account (p text) returns uuid language sql immutable as $$
    select ('d5000000-0000-4000-8000-0000000000' || p)::uuid;
$$;

create function pg_temp.mark (p text) returns uuid language sql immutable as $$
    select ('d5000000-0000-4000-8000-0000000a00' || p)::uuid;
$$;

-- The student's account, roster row and mark are all still there, the mark
-- unscrubbed.
create function pg_temp.survives (p text) returns boolean language sql as $$
    select exists (select 1 from auth.users where id = pg_temp.account (p))
       and exists (select 1 from public.managed_students where id = pg_temp.roster (p))
       and exists (select 1 from public.annotations
                   where id = pg_temp.mark (p) and deleted_at is null and payload ->> 'text' = 'work of ' || p);
$$;

create function pg_temp.archived (p text) returns boolean language sql as $$
    select archived_at is not null from public.managed_students where id = pg_temp.roster (p);
$$;

create function pg_temp.carried (p_studio text, p text) returns boolean language sql as $$
    select exists (select 1 from public.district_retention_restores
                   where studio_id = ('d5000000-0000-4000-8000-0000000005' || p_studio)::uuid
                     and managed_student_id = pg_temp.roster (p));
$$;

create function pg_temp.listed (p text) returns boolean language sql as $$
    select exists (select 1 from public.district_retention_students
                   where studio_id = 'd5000000-0000-4000-8000-0000000005da' and managed_student_id = pg_temp.roster (p));
$$;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email, raw_app_meta_data)
select pg_temp.account ('a1'), 'authenticated', 'authenticated', 'rr-owner@example.invalid', '{}'::jsonb
union all
select pg_temp.account (s), 'authenticated', 'authenticated', 'rr-' || s || '@students.cleffy.app',
       '{"user_type":"student"}'::jsonb
from unnest(array['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'c1', 'c2']) as s
union all
select pg_temp.account (s), 'authenticated', 'authenticated', 'rr-' || s || '@example.invalid', '{}'::jsonb
from unnest(array['a2', 'a3']) as s;

insert into public.studios (id, owner_id, name)
values ('d5000000-0000-4000-8000-0000000005da', pg_temp.account ('a1'), 'District A'),
       ('d5000000-0000-4000-8000-0000000005db', pg_temp.account ('a1'), 'District B'),
       ('d5000000-0000-4000-8000-0000000005dc', pg_temp.account ('a3'), 'District C');

insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
values ('d5000000-0000-4000-8000-0000000005da', now() - interval '17 days', 'admin', 'test'),
       ('d5000000-0000-4000-8000-0000000005db', null, null, 'test'),
       ('d5000000-0000-4000-8000-0000000005dc', now() - interval '17 days', 'admin', 'test');

-- T: seated in A, on their own Teacher plan.
insert into public.studio_members (studio_id, user_id) values ('d5000000-0000-4000-8000-0000000005da', pg_temp.account ('a2'));

set local role service_role;

select public.write_subscription_under_lock (
    public.claim_subscription_write ('sub_rr_teacher', interval '5 minutes'),
    'sub_rr_teacher', pg_temp.account ('a2'), 'test', 'teacher', 'active', 'price_teacher_annual',
    now() + interval '1 year', false, now() - interval '1 hour'
);

reset role;

-- r1-r6 provisioned for A; x is a private student of O's.
insert into public.managed_students
    (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at, archived_at,
     district_studio_id)
select pg_temp.roster (s), pg_temp.account (case when s in ('b8', 'b9', 'c1') then 'a2' when s = 'c2' then 'a3' else 'a1' end),
       pg_temp.account (s), 'Student ' || s, null, 'code', 'rr_' || s, now(),
       case when s = 'b9' then now() - interval '1 day' end,
       case when s = 'b7' then null
            when s = 'c2' then 'd5000000-0000-4000-8000-0000000005dc'::uuid
            else 'd5000000-0000-4000-8000-0000000005da'::uuid end
from unnest(array['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'c1', 'c2']) as s;

insert into public.documents (id, owner_id, title, storage_path)
values ('d5000000-0000-4000-8000-00000000d001', pg_temp.account ('a1'), 'Score',
        'd5000000-0000-4000-8000-00000000d001/original.pdf');

insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
select pg_temp.mark (s), 'd5000000-0000-4000-8000-00000000d001', 0, 'text', '#112233',
       jsonb_build_object('x', 0.3, 'y', 0.3, 'size', 0.02, 'text', 'work of ' || s), pg_temp.account (s)
from unnest(array['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'c1', 'c2']) as s;

-- ===========================================================================
-- Notice, sent, soft delete
-- ===========================================================================
select public.retention_district_run (now());

select public.finish_district_retention_notice (id) from public.claim_district_retention_notices (20);

insert into ran select 'soft', public.retention_district_run (now() + interval '14 days 1 minute');

select pg_temp.holds (
    'the soft deletes list and archive A''s nine students and C''s one, and not O''s private student',
    $q$select (select (v ->> 'soft_delete')::int = 2 and (v ->> 'students_archived')::int = 10 from ran where k = 'soft')
       and (select count(*) = 9 from public.district_retention_students
            where studio_id = 'd5000000-0000-4000-8000-0000000005da')
       and (select count(*) = 1 from public.district_retention_students
            where studio_id = 'd5000000-0000-4000-8000-0000000005dc')
       and (select bool_and(was_archived = (managed_student_id = pg_temp.roster ('b9')))
            from public.district_retention_students)
       and not pg_temp.archived ('b7')$q$
);

-- ===========================================================================
-- Re-attribution between the soft and the hard delete
-- ===========================================================================
select public.admin_set_student_district (pg_temp.roster ('b1'), null, 'test admin');

select public.admin_set_student_district (pg_temp.roster ('b2'), 'd5000000-0000-4000-8000-0000000005db', 'test admin');

select public.admin_set_student_district (pg_temp.roster ('b5'), 'd5000000-0000-4000-8000-0000000005da', 'test admin');

select public.admin_set_student_district (pg_temp.roster ('b8'), null, 'test admin');

select public.admin_set_student_district (pg_temp.roster ('b9'), null, 'test admin');

select public.admin_set_student_district (pg_temp.roster ('c2'), null, 'test admin');

select pg_temp.holds (
    'moving a student out of A takes them off A''s purge list; re-confirming A keeps them on it',
    $q$select not pg_temp.listed ('b1') and not pg_temp.listed ('b2') and pg_temp.listed ('b5')
          and pg_temp.listed ('b3') and pg_temp.listed ('b4') and pg_temp.listed ('b6')
          and not pg_temp.listed ('b8') and not pg_temp.listed ('b9') and pg_temp.listed ('c1')$q$
);

select pg_temp.holds (
    'r8, archived only because A lapsed, is un-archived as part of the correction: T''s plan has room',
    $q$select not pg_temp.archived ('b8') and not pg_temp.carried ('da', 'b8')$q$
);

select pg_temp.holds (
    'r9, whom T had archived before the purge, stays archived and nothing is carried over',
    $q$select pg_temp.archived ('b9') and not pg_temp.carried ('da', 'b9')$q$
);

select pg_temp.holds (
    'r1, r2 and s2 stay archived (their teachers'' plans have no roster) and their restores are carried over',
    $q$select pg_temp.archived ('b1') and pg_temp.archived ('b2') and pg_temp.archived ('c2')
          and pg_temp.carried ('da', 'b1') and pg_temp.carried ('da', 'b2') and pg_temp.carried ('dc', 'c2')
          and (select count(*) = 3 from public.district_retention_restores)$q$
);

select pg_temp.holds (
    'each drop is logged under the district it left as attribution_changed, event skipped_reattributed, with the restore',
    $q$select count(*) = 5
          and bool_and(l.counts ->> 'actor' = 'test admin' and l.counts ->> 'by' = 'admin_set_student_district'
                       and (l.counts ->> 'students_skipped')::int = 1)
          and bool_or(l.counts ->> 'managed_student_id' = pg_temp.roster ('b1')::text and l.counts -> 'to' = 'null'::jsonb
                      and l.counts ->> 'restore' = 'no_roster_plan' and not (l.counts ->> 'was_archived')::boolean
                      and l.studio_id = 'd5000000-0000-4000-8000-0000000005da')
          and bool_or(l.counts ->> 'managed_student_id' = pg_temp.roster ('b2')::text
                      and l.counts ->> 'to' = 'd5000000-0000-4000-8000-0000000005db'
                      and l.counts ->> 'restore' = 'no_roster_plan')
          and bool_or(l.counts ->> 'managed_student_id' = pg_temp.roster ('b8')::text and l.counts ->> 'restore' = 'restored')
          and bool_or(l.counts ->> 'managed_student_id' = pg_temp.roster ('b9')::text
                      and l.counts ->> 'restore' = 'was_archived' and (l.counts ->> 'was_archived')::boolean)
          and bool_or(l.counts ->> 'managed_student_id' = pg_temp.roster ('c2')::text
                      and l.studio_id = 'd5000000-0000-4000-8000-0000000005dc')
       from public.district_retention_log l
       where l.step = 'attribution_changed' and l.counts ->> 'event' = 'skipped_reattributed'$q$
);

select pg_temp.holds (
    'the correction itself is still logged as attribution_changed, as before',
    $q$select count(*) = 6 from public.district_retention_log
       where step = 'attribution_changed' and counts ->> 'actor' = 'test admin' and counts ->> 'event' is null$q$
);

select pg_temp.holds (
    'no log row uses a step 20261021120800 does not know (its replay rebuilds the check)',
    $q$select bool_and(step in ('notice_queued', 'notice_sent', 'soft_deleted', 'hard_deleted', 'cancelled',
                                'attribution_changed', 'attribution_backfilled', 'attribution_backfill_run'))
       from public.district_retention_log$q$
);

-- r3: the 20261021120800 correction, which never touched the list.
select set_config('cleffy.district_attribution', 'admin', true);

update public.managed_students set district_studio_id = 'd5000000-0000-4000-8000-0000000005db', district_attribution = 'admin'
where id = pg_temp.roster ('b3');

update public.managed_students set district_studio_id = null, district_attribution = 'admin'
where id = pg_temp.roster ('c1');

select set_config('cleffy.district_attribution', '', true);

-- r6: a list entry that names another account than the roster row.
update public.district_retention_students set student_user_id = pg_temp.account ('b7')
where studio_id = 'd5000000-0000-4000-8000-0000000005da' and managed_student_id = pg_temp.roster ('b6');

select pg_temp.holds (
    'the dry run counts the five students still listed for A''s hard delete',
    $q$select e ->> 'next_step' = 'hard_delete' and (e ->> 'listed_students')::int = 5
       from jsonb_array_elements(public.retention_district_dry_run (now() + interval '21 days 2 minutes') -> 'studios') e
       where e ->> 'studio_id' = 'd5000000-0000-4000-8000-0000000005da'$q$
);

-- C is renewed before its hard delete: a new contract end, and P paying.
update public.district_billing set contract_ends_at = now() + interval '1 year'
where studio_id = 'd5000000-0000-4000-8000-0000000005dc';

set local role service_role;

select public.write_subscription_under_lock (
    public.claim_subscription_write ('sub_rr_district_c', interval '5 minutes'),
    'sub_rr_district_c', pg_temp.account ('a3'), 'test', 'academy', 'active', 'price_district_custom',
    now() + interval '1 year', false, now() - interval '1 hour', 'send_invoice'
);

reset role;

-- ===========================================================================
-- A's hard delete, C's cancel
-- ===========================================================================
insert into ran select 'hard', public.retention_district_run (now() + interval '21 days 2 minutes');

select pg_temp.holds (
    'r1, re-attributed to a private roster after the soft delete, survives with their marking',
    $q$select pg_temp.survives ('b1')$q$
);

select pg_temp.holds (
    'r2, re-attributed to district B, survives with their marking, still B''s',
    $q$select pg_temp.survives ('b2')
          and (select district_studio_id = 'd5000000-0000-4000-8000-0000000005db' from public.managed_students
               where id = pg_temp.roster ('b2'))$q$
);

select pg_temp.holds (
    'r3, re-attributed without the list being touched, survives: the hard delete re-checks the attribution',
    $q$select pg_temp.survives ('b3')$q$
);

select pg_temp.holds (
    'r6 survives, and so does x, the account its stale list entry named',
    $q$select pg_temp.survives ('b6') and pg_temp.survives ('b7')$q$
);

select pg_temp.holds (
    's1, re-attributed the old way, survives and the skip un-archives them: T''s plan has room',
    $q$select pg_temp.survives ('c1') and not pg_temp.archived ('c1')$q$
);

select pg_temp.holds (
    'r8 survives, still un-archived; r9 survives, still archived; r1, r2 and r3 survive archived (O has no roster)',
    $q$select pg_temp.survives ('b8') and not pg_temp.archived ('b8') and pg_temp.survives ('b9') and pg_temp.archived ('b9')
          and pg_temp.archived ('b1') and pg_temp.archived ('b2') and pg_temp.archived ('b3')$q$
);

select pg_temp.holds (
    'C''s renewal un-archives s2, whose restore the correction carried over, now that P''s plan has room',
    $q$select (select (v ->> 'cancel')::int = 1 and (v ->> 'students_restored')::int = 1 from ran where k = 'hard')
          and pg_temp.survives ('c2') and not pg_temp.archived ('c2')
          and (select (counts ->> 'students_restored')::int = 1 and (counts ->> 'reattributed_restored')::int = 1
               from public.district_retention_log
               where studio_id = 'd5000000-0000-4000-8000-0000000005dc' and step = 'cancelled')$q$
);

select pg_temp.holds (
    'no carried-over restore is left: C''s cancel and A''s hard delete clear theirs',
    $q$select not exists (select 1 from public.district_retention_restores)$q$
);

select pg_temp.holds (
    'control: r4 (unchanged) and r5 (re-confirmed for A) are scrubbed and deleted',
    $q$select not exists (select 1 from auth.users where id in (pg_temp.account ('b4'), pg_temp.account ('b5')))
          and not exists (select 1 from public.managed_students where id in (pg_temp.roster ('b4'), pg_temp.roster ('b5')))
          and (select bool_and(deleted_at is not null and payload ->> 'text' = '') from public.annotations
               where id in (pg_temp.mark ('b4'), pg_temp.mark ('b5')))$q$
);

select pg_temp.holds (
    'the run reports two deleted and three skipped as re-attributed',
    $q$select (v ->> 'hard_delete')::int = 1 and (v ->> 'students_deleted')::int = 2
          and (v ->> 'students_skipped_reattributed')::int = 3
       from ran where k = 'hard'$q$
);

select pg_temp.holds (
    'the log shows the hard delete''s skip, naming r3, r6 and s1 with their restores, and the hard delete''s counts',
    $q$select (select (counts ->> 'students_skipped')::int = 3 and counts ->> 'by' = 'retention_district_run'
                  and (select array_agg((e ->> 'managed_student_id') || ':' || (e ->> 'restore')
                                        order by e ->> 'managed_student_id')
                       from jsonb_array_elements(counts -> 'students') e)
                      = array[pg_temp.roster ('b3')::text || ':no_roster_plan',
                              pg_temp.roster ('b6')::text || ':other_account',
                              pg_temp.roster ('c1')::text || ':restored']
                  and contract_ends_at is not null
           from public.district_retention_log
           where studio_id = 'd5000000-0000-4000-8000-0000000005da' and step = 'attribution_changed'
             and counts ->> 'event' = 'skipped_reattributed' and counts ->> 'by' = 'retention_district_run')
       and (select counts = '{"studios":1,"students_deleted":2,"members_removed":1}'::jsonb
            from public.district_retention_log
            where studio_id = 'd5000000-0000-4000-8000-0000000005da' and step = 'hard_deleted')$q$
);

select pg_temp.holds (
    'A is gone and its list is empty; B, the owner and the score stay',
    $q$select not exists (select 1 from public.studios where id = 'd5000000-0000-4000-8000-0000000005da')
          and not exists (select 1 from public.district_retention_students
                          where studio_id = 'd5000000-0000-4000-8000-0000000005da')
          and exists (select 1 from public.studios where id = 'd5000000-0000-4000-8000-0000000005db')
          and exists (select 1 from auth.users where id = pg_temp.account ('a1'))
          and exists (select 1 from public.documents where id = 'd5000000-0000-4000-8000-00000000d001')$q$
);

-- ===========================================================================
-- Still the service role's alone
-- ===========================================================================
select pg_temp.act_as (pg_temp.account ('a1'));

select pg_temp.refused (
    'a client cannot run the purge',
    $q$select public.retention_district_run ()$q$,
    '42501'
);

select pg_temp.refused (
    'nor make the correction',
    $q$select public.admin_set_student_district ('d5000000-0000-4000-8000-0000000005b1', null, 'me')$q$,
    '42501'
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'both functions keep their signature and service-role-only grant; the restore helper is no client''s',
    $q$select bool_and(has_function_privilege('service_role', p.oid, 'execute')
                    and not has_function_privilege('authenticated', p.oid, 'execute')
                    and not has_function_privilege('anon', p.oid, 'execute'))
          and count(*) = 2
       from pg_proc p
       where p.oid in ('public.retention_district_run(timestamptz, int)'::regprocedure,
                       'public.admin_set_student_district(uuid, uuid, text)'::regprocedure)
          and not has_function_privilege('authenticated', 'public.district_reattributed_restore(uuid, uuid)', 'execute')
          and not has_function_privilege('anon', 'public.district_reattributed_restore(uuid, uuid)', 'execute')
          and not has_table_privilege('authenticated', 'public.district_retention_restores', 'select')$q$
);

-- ---------------------------------------------------------------------------
-- Report: failing checks, then `failures | total`
-- ---------------------------------------------------------------------------
select n, check_name, detail from integrity_results where not passed order by n;

select count(*) filter (where not passed) as failures, count(*) as total from integrity_results;

rollback;
