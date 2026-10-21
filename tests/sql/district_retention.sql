-- District retention (20261021120700, scoped by 20261021120800, notices
-- budgeted by 20261021120900), against a real database. LOCAL STACK
-- or the dev branch project only. Same harness and same reading as
-- launch_consent.sql: one transaction ending in ROLLBACK, every check a row in
-- integrity_results, a clean run is exactly one row 'ALL n CHECKS PASSED'.
--
-- Time is moved by the functions' p_now, against a contract that ended 17 days
-- ago (E): the notice is due at E + 16 days, the soft delete at E + 30 days and
-- 14 days after the notice was SENT (the sender stamps the real clock), the
-- hard delete 7 days after that.
--
-- Cast: O owns district studio S with contract end E; M is a teacher seated
-- in S; X is an unrelated teacher. s1 is O's student (with a mark), s2 is M's
-- (already archived before any of this), s3 is X's. N is a second district
-- whose contract_ends_at is null.

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

-- Steps a test wants the result of, kept for later checks.
create temp table ran (k text primary key, v jsonb);

grant all on ran to public;

create function pg_temp.dry (p_offset interval) returns jsonb language sql as $$
    select e from jsonb_array_elements(public.retention_district_dry_run (now() + p_offset) -> 'studios') e
    where e ->> 'studio_id' = 'd1000000-0000-4000-8000-0000000005d1';
$$;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email, raw_app_meta_data)
values
    ('d1000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'dr-owner@example.invalid', '{}'),
    ('d1000000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'dr-member@example.invalid', '{}'),
    ('d1000000-0000-4000-8000-0000000000a3', 'authenticated', 'authenticated', 'dr-other@example.invalid', '{}'),
    ('d1000000-0000-4000-8000-0000000000a4', 'authenticated', 'authenticated', 'dr-null@example.invalid', '{}'),
    ('d1000000-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated', 'dr-s1@students.cleffy.app',
     '{"user_type":"student"}'),
    ('d1000000-0000-4000-8000-0000000000b2', 'authenticated', 'authenticated', 'dr-s2@students.cleffy.app',
     '{"user_type":"student"}'),
    ('d1000000-0000-4000-8000-0000000000b3', 'authenticated', 'authenticated', 'dr-s3@students.cleffy.app',
     '{"user_type":"student"}');

-- The district exists before its students are provisioned: each roster row
-- records the district it was provisioned under (20261021120800).
insert into public.studios (id, owner_id, name)
values ('d1000000-0000-4000-8000-0000000005d1', 'd1000000-0000-4000-8000-0000000000a1', 'District S'),
       ('d1000000-0000-4000-8000-0000000005d2', 'd1000000-0000-4000-8000-0000000000a4', 'District N');

insert into public.studio_members (studio_id, user_id)
values ('d1000000-0000-4000-8000-0000000005d1', 'd1000000-0000-4000-8000-0000000000a2');

insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
values ('d1000000-0000-4000-8000-0000000005d1', now() - interval '17 days', 'admin', 'test'),
       ('d1000000-0000-4000-8000-0000000005d2', null, null, 'test');

insert into public.managed_students
    (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at, archived_at)
values
    ('d1000000-0000-4000-8000-0000000005b1', 'd1000000-0000-4000-8000-0000000000a1',
     'd1000000-0000-4000-8000-0000000000b1', 'One', null, 'code', 'dr_one', now(), null),
    ('d1000000-0000-4000-8000-0000000005b2', 'd1000000-0000-4000-8000-0000000000a2',
     'd1000000-0000-4000-8000-0000000000b2', 'Two', null, 'code', 'dr_two', now(), now() - interval '60 days'),
    ('d1000000-0000-4000-8000-0000000005b3', 'd1000000-0000-4000-8000-0000000000a3',
     'd1000000-0000-4000-8000-0000000000b3', 'Three', null, 'code', 'dr_three', now(), null);

insert into public.documents (id, owner_id, title, storage_path)
values ('d1000000-0000-4000-8000-00000000d001', 'd1000000-0000-4000-8000-0000000000a1', 'Score',
        'd1000000-0000-4000-8000-00000000d001/original.pdf');

insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
values ('d1000000-0000-4000-8000-0000000a0001', 'd1000000-0000-4000-8000-00000000d001', 0, 'text', '#112233',
        '{"x":0.3,"y":0.3,"size":0.02,"text":"student work"}', 'd1000000-0000-4000-8000-0000000000b1');

-- ===========================================================================
-- Nobody but the service role
-- ===========================================================================
select pg_temp.act_as ('d1000000-0000-4000-8000-0000000000a1');

select pg_temp.refused ('the owner cannot run the purge', $q$select public.retention_district_run ()$q$, '42501');

select pg_temp.refused ('nor its dry run', $q$select public.retention_district_dry_run ()$q$, '42501');

select pg_temp.refused ('nor read the billing record', $q$select * from public.district_billing$q$, '42501');

select pg_temp.refused ('nor the purge log', $q$select * from public.district_retention_log$q$, '42501');

select pg_temp.refused (
    'nor claim notices', $q$select * from public.claim_district_retention_notices ()$q$, '42501'
);

select pg_temp.act_as_server ();

-- ===========================================================================
-- Paused, dry run, and the notice
-- ===========================================================================
select pg_temp.holds (
    'the purge ships unscheduled',
    $q$select not exists (select 1 from cron.job where command ilike '%retention_district_run%')$q$
);

select pg_temp.holds (
    'dry run at E + 15 days: nothing due for S',
    $q$select pg_temp.dry (interval '-2 days') is null$q$
);

select pg_temp.holds (
    'dry run now (E + 17 days): the notice is due, counting S''s two students and one seated teacher',
    $q$select e ->> 'next_step' = 'notice' and (e ->> 'students')::int = 2 and (e ->> 'members')::int = 1
       from pg_temp.dry (interval '0') e$q$
);

select pg_temp.holds (
    'a district whose contract_ends_at is null is never a candidate',
    $q$select not exists (
           select 1 from jsonb_array_elements(public.retention_district_dry_run (now() + interval '10 years') -> 'studios') e
           where e ->> 'studio_id' = 'd1000000-0000-4000-8000-0000000005d2')$q$
);

select pg_temp.holds (
    'the dry run wrote nothing',
    $q$select not exists (select 1 from public.district_retention)
       and not exists (select 1 from public.district_retention_notices)
       and not exists (select 1 from public.district_retention_log)$q$
);

insert into ran select 'notice', public.retention_district_run (now());

select pg_temp.holds (
    'the run queues one notice to the owner, purge not before 14 days from now (later than E + 30 days)',
    $q$select (select (v ->> 'notice')::int = 1 from ran where k = 'notice')
       and n.to_email = 'dr-owner@example.invalid' and n.studio_name = 'District S' and n.sent_at is null
       and n.purge_not_before = now() + interval '14 days'
       and n.purge_not_before > n.contract_ends_at + interval '30 days'
       from public.district_retention_notices n
       where n.studio_id = 'd1000000-0000-4000-8000-0000000005d1'$q$
);

select pg_temp.holds (
    'and logs it with its counts',
    $q$select counts = '{"students":2,"members":1}'::jsonb from public.district_retention_log
       where studio_id = 'd1000000-0000-4000-8000-0000000005d1' and step = 'notice_queued'$q$
);

insert into ran select 'unsent', public.retention_district_run (now() + interval '20 days');

select pg_temp.holds (
    'with the notice unsent, nothing is soft deleted, even well past E + 30 days',
    $q$select (select (v ->> 'soft_delete')::int = 0 from ran where k = 'unsent')
       and (select archived_at is null from public.managed_students
            where id = 'd1000000-0000-4000-8000-0000000005b1')$q$
);

-- The sender: a failed send is kept for a retry, never counted as sent.
create temp table claimed as select * from public.claim_district_retention_notices (20);

grant select on claimed to public;

select pg_temp.holds (
    'the sender claims the notice; a second sender gets nothing while it holds it',
    $q$select (select count(*) = 1 from claimed)
       and not exists (select 1 from public.claim_district_retention_notices (20))$q$
);

select public.finish_district_retention_notice ((select id from claimed), 'resend returned 500');

select pg_temp.holds (
    'a failed send is not sent, and can be claimed again',
    $q$select n.sent_at is null and n.last_error like 'resend returned 500%' and n.lease_until is null
          and (select notice_sent_at is null from public.district_retention
               where studio_id = 'd1000000-0000-4000-8000-0000000005d1')
       from public.district_retention_notices n where n.id = (select id from claimed)$q$
);

-- The mail budget is spent (20261021120900): the sender hands the claim back.
create temp table attempts_before as
select attempts from public.district_retention_notices where studio_id = 'd1000000-0000-4000-8000-0000000005d1';

grant select on attempts_before to public;

select public.defer_district_retention_notice (id) from public.claim_district_retention_notices (20);

select pg_temp.holds (
    'a notice deferred for the mail budget is unsent, unleased, and its attempt taken back',
    $q$select n.sent_at is null and n.lease_until is null and n.attempts = (select attempts from attempts_before)
          and n.last_error like 'deferred:%'
          and (select notice_sent_at is null from public.district_retention
               where studio_id = 'd1000000-0000-4000-8000-0000000005d1')
       from public.district_retention_notices n
       where n.studio_id = 'd1000000-0000-4000-8000-0000000005d1'$q$
);

select pg_temp.act_as ('d1000000-0000-4000-8000-0000000000a1');

select pg_temp.refused (
    'a client cannot defer a notice',
    $q$select public.defer_district_retention_notice (1)$q$,
    '42501'
);

select pg_temp.act_as_server ();

select public.finish_district_retention_notice (id) from public.claim_district_retention_notices (20);

select pg_temp.holds (
    'a delivered notice is stamped, on the purge state too, and logged',
    $q$select (select notice_sent_at is not null from public.district_retention
               where studio_id = 'd1000000-0000-4000-8000-0000000005d1')
       and exists (select 1 from public.district_retention_log
                   where studio_id = 'd1000000-0000-4000-8000-0000000005d1' and step = 'notice_sent')$q$
);

select pg_temp.holds (
    'past E + 30 days but under 14 days since the notice was sent: still nothing due',
    $q$select pg_temp.dry (interval '13 days') is null$q$
);

-- ===========================================================================
-- Soft delete, and a contract that comes back
-- ===========================================================================
insert into ran select 'soft', public.retention_district_run (now() + interval '14 days 1 minute');

select pg_temp.holds (
    'soft delete archives S''s students and refuses their tokens, and leaves X''s alone',
    $q$select (select (v ->> 'soft_delete')::int = 1 from ran where k = 'soft')
       and (select archived_at is not null and access_revoked_at is not null from public.managed_students
            where id = 'd1000000-0000-4000-8000-0000000005b1')
       and (select archived_at is null from public.managed_students where id = 'd1000000-0000-4000-8000-0000000005b3')
       and (select count(*) = 2 from public.district_retention_students
            where studio_id = 'd1000000-0000-4000-8000-0000000005d1')$q$
);

update public.district_billing set contract_ends_at = null
where studio_id = 'd1000000-0000-4000-8000-0000000005d1';

insert into ran select 'cancel', public.retention_district_run (now() + interval '15 days');

select pg_temp.holds (
    'a renewed contract cancels: s1 is un-archived, s2 (archived before) stays archived',
    $q$select (select (v ->> 'cancel')::int = 1 and (v ->> 'students_restored')::int = 1 from ran where k = 'cancel')
       and (select archived_at is null from public.managed_students where id = 'd1000000-0000-4000-8000-0000000005b1')
       and (select archived_at is not null from public.managed_students
            where id = 'd1000000-0000-4000-8000-0000000005b2')
       and not exists (select 1 from public.district_retention
                       where studio_id = 'd1000000-0000-4000-8000-0000000005d1')
       and exists (select 1 from public.district_retention_log
                   where studio_id = 'd1000000-0000-4000-8000-0000000005d1' and step = 'cancelled')$q$
);

-- ===========================================================================
-- The contract ends again: notice again, soft, a restore, hard
-- ===========================================================================
update public.district_billing set contract_ends_at = now() - interval '17 days'
where studio_id = 'd1000000-0000-4000-8000-0000000005d1';

select public.retention_district_run (now());

select pg_temp.holds (
    'the new cycle mails the owner again, for the same date',
    $q$select sent_at is null and attempts = 0 from public.district_retention_notices
       where studio_id = 'd1000000-0000-4000-8000-0000000005d1'$q$
);

select public.finish_district_retention_notice (id) from public.claim_district_retention_notices (20);

select public.retention_district_run (now() + interval '14 days 1 minute');

-- The teacher restores s2 between the soft and the hard delete.
update public.managed_students set archived_at = null where id = 'd1000000-0000-4000-8000-0000000005b2';

select pg_temp.holds (
    'dry run a week later: the hard delete is due, for two listed students',
    $q$select e ->> 'next_step' = 'hard_delete' and (e ->> 'listed_students')::int = 2
       from pg_temp.dry (interval '21 days 2 minutes') e$q$
);

insert into ran select 'hard', public.retention_district_run (now() + interval '21 days 2 minutes');

select pg_temp.holds (
    'hard delete: s1 scrubbed and gone, the studio, its seat and its billing record gone',
    $q$select (select (v ->> 'hard_delete')::int = 1 and (v ->> 'students_deleted')::int = 1 from ran where k = 'hard')
       and not exists (select 1 from auth.users where id = 'd1000000-0000-4000-8000-0000000000b1')
       and (select deleted_at is not null and payload ->> 'text' = '' from public.annotations
            where id = 'd1000000-0000-4000-8000-0000000a0001')
       and not exists (select 1 from public.studios where id = 'd1000000-0000-4000-8000-0000000005d1')
       and not exists (select 1 from public.studio_members where studio_id = 'd1000000-0000-4000-8000-0000000005d1')
       and not exists (select 1 from public.district_billing where studio_id = 'd1000000-0000-4000-8000-0000000005d1')$q$
);

select pg_temp.holds (
    'a student the teacher restored after the soft delete is kept',
    $q$select exists (select 1 from public.managed_students
                      where id = 'd1000000-0000-4000-8000-0000000005b2' and archived_at is null)$q$
);

select pg_temp.holds (
    'teachers'' own accounts, their score, and another teacher''s student are untouched',
    $q$select (select count(*) = 3 from auth.users where id in ('d1000000-0000-4000-8000-0000000000a1',
               'd1000000-0000-4000-8000-0000000000a2', 'd1000000-0000-4000-8000-0000000000a3'))
       and exists (select 1 from public.documents where id = 'd1000000-0000-4000-8000-00000000d001')
       and exists (select 1 from public.managed_students where id = 'd1000000-0000-4000-8000-0000000005b3')$q$
);

select pg_temp.holds (
    'the log outlives the studio, with the hard delete''s counts',
    $q$select counts = '{"studios":1,"students_deleted":1,"members_removed":1}'::jsonb
       from public.district_retention_log
       where studio_id = 'd1000000-0000-4000-8000-0000000005d1' and step = 'hard_deleted'$q$
);

select pg_temp.holds (
    'and a later run finds nothing more to do for S',
    $q$select pg_temp.dry (interval '60 days') is null$q$
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
