-- Launch consent and retention (mh/launch-consent), against a real database:
--
--   20261021120000_consent_age.sql            consent_age(), the before_user_created hook
--   20261021120100_teacher_attestations.sql   roster columns, teacher_attestations
--   20261021120200_delete_student_markings.sql scrub_student_markings()
--   20261021120300_retention_jobs.sql         the purge functions and their cron jobs
--
-- Same harness and same reading as column_integrity.sql (see README.md): one
-- transaction ending in ROLLBACK, every check a row in integrity_results, and a
-- clean run is exactly one row reading 'ALL n CHECKS PASSED'. The purge
-- functions act on the whole database, so the checks below look at this file's
-- own fixtures rather than at the counts the functions return.
--
-- Cast: T teaches and owns score D; O is another teacher; S is T's student with
-- marks on D and in its lesson history; S2 was archived 13 months ago and S3
-- six months ago; G1..G4 are share-link guests of various ages.

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

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email, raw_app_meta_data)
values
    ('1c000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'lc-teacher@example.invalid', '{}'),
    ('1c000000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'lc-other@example.invalid', '{}'),
    ('1c000000-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated', 'lc-s@students.cleffy.app',
     '{"user_type":"student"}'),
    ('1c000000-0000-4000-8000-0000000000b2', 'authenticated', 'authenticated', 'lc-s2@students.cleffy.app',
     '{"user_type":"student"}'),
    ('1c000000-0000-4000-8000-0000000000b3', 'authenticated', 'authenticated', 'lc-s3@students.cleffy.app',
     '{"user_type":"student"}');

insert into public.managed_students
    (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at, archived_at,
     country, age_attested_at, age_attested_min_age)
values
    ('1c000000-0000-4000-8000-0000000005b1', '1c000000-0000-4000-8000-0000000000a1',
     '1c000000-0000-4000-8000-0000000000b1', 'Sam', null, 'code', 'lc_sam', now(), null, 'DE', now(), 16),
    ('1c000000-0000-4000-8000-0000000005b2', '1c000000-0000-4000-8000-0000000000a1',
     '1c000000-0000-4000-8000-0000000000b2', 'Sid', null, 'code', 'lc_sid', now(), now() - interval '13 months',
     null, null, null),
    ('1c000000-0000-4000-8000-0000000005b3', '1c000000-0000-4000-8000-0000000000a1',
     '1c000000-0000-4000-8000-0000000000b3', 'Sue', null, 'code', 'lc_sue', now(), now() - interval '6 months',
     null, null, null);

insert into public.teacher_attestations
    (teacher_id, managed_student_id, action, country, min_age, wording, wording_version)
values
    ('1c000000-0000-4000-8000-0000000000a1', '1c000000-0000-4000-8000-0000000005b1', 'create', 'DE', 16,
     'I confirm this student is at least 16 years old, the minimum age to use Cleffy in Germany.', '2026-10-21');

insert into public.documents (id, owner_id, title, storage_path)
values ('1c000000-0000-4000-8000-00000000d001', '1c000000-0000-4000-8000-0000000000a1', 'Score', '1c000000-0000-4000-8000-00000000d001/original.pdf');

insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
values
    ('1c000000-0000-4000-8000-0000000a0001', '1c000000-0000-4000-8000-00000000d001', 0, 'stroke', '#112233',
     '{"pts":[0.1,0.1,0.5,0.2,0.2,0.5],"w":0.01}', '1c000000-0000-4000-8000-0000000000b1'),
    ('1c000000-0000-4000-8000-0000000a0002', '1c000000-0000-4000-8000-00000000d001', 0, 'text', '#112233',
     '{"x":0.3,"y":0.3,"size":0.02,"text":"my secret note"}', '1c000000-0000-4000-8000-0000000000b1'),
    ('1c000000-0000-4000-8000-0000000a0003', '1c000000-0000-4000-8000-00000000d001', 0, 'stroke', '#445566',
     '{"pts":[0.4,0.4,0.5,0.6,0.6,0.5],"w":0.01}', '1c000000-0000-4000-8000-0000000000a1'),
    ('1c000000-0000-4000-8000-0000000a0004', '1c000000-0000-4000-8000-00000000d001', 1, 'stroke', '#445566',
     '{"pts":[0.4,0.4,0.5,0.6,0.6,0.5],"w":0.01}', '1c000000-0000-4000-8000-0000000000b2');

insert into public.annotation_snapshots (id, document_id, captured_on, payload, created_by)
values (
    '1c000000-0000-4000-8000-00000000e001', '1c000000-0000-4000-8000-00000000d001', current_date - 1,
    '[{"id":"1c000000-0000-4000-8000-0000000a0001","createdBy":"1c000000-0000-4000-8000-0000000000b1"},
      {"id":"1c000000-0000-4000-8000-0000000a0003","createdBy":"1c000000-0000-4000-8000-0000000000a1"}]',
    '1c000000-0000-4000-8000-0000000000b1'
);

-- Guests: G1 long idle; G2 old but its session refreshed today; G3 new; R an
-- old registered account, which is never a guest.
insert into auth.users (id, aud, role, email, is_anonymous, created_at, updated_at, last_sign_in_at)
values
    ('1c000000-0000-4000-8000-0000000000c1', 'authenticated', 'authenticated', null, true,
     now() - interval '100 days', now() - interval '100 days', now() - interval '100 days'),
    ('1c000000-0000-4000-8000-0000000000c2', 'authenticated', 'authenticated', null, true,
     now() - interval '100 days', now() - interval '100 days', now() - interval '100 days'),
    ('1c000000-0000-4000-8000-0000000000c3', 'authenticated', 'authenticated', null, true,
     now() - interval '10 days', now() - interval '10 days', now() - interval '10 days'),
    ('1c000000-0000-4000-8000-0000000000c4', 'authenticated', 'authenticated', 'lc-old@example.invalid', false,
     now() - interval '400 days', now() - interval '400 days', now() - interval '400 days');

insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at)
values ('1c000000-0000-4000-8000-0000000005c2', '1c000000-0000-4000-8000-0000000000c2',
        now() - interval '100 days', now(), (now() at time zone 'UTC'));

insert into public.edge_rate_buckets (key, count, reset_at)
values ('lc:old', 3, now() - interval '2 days'), ('lc:live', 3, now() + interval '1 minute');

insert into public.edge_login_attempts (key, attempts, last_attempt_at)
values ('lc:old', 2, now() - interval '3 days'), ('lc:live', 2, now());

insert into public.support_messages (resend_email_id, from_address, received_at)
values ('lc-old', 'a@example.invalid', now() - interval '25 months'),
       ('lc-new', 'b@example.invalid', now() - interval '23 months');

-- ===========================================================================
-- consent_age() and the before_user_created hook
-- ===========================================================================
select pg_temp.holds (
    'consent_age: Germany 16, France 15, Spain 14, UK 13, unlisted and null 13',
    $q$select public.consent_age ('de') = 16 and public.consent_age ('FR') = 15 and public.consent_age ('ES') = 14
       and public.consent_age ('GB') = 13 and public.consent_age ('ZZ') = 13 and public.consent_age (null) = 13$q$
);

select pg_temp.holds (
    'hook: a passing age_gate creates the user',
    $q$select public.hook_before_user_created (
        '{"user":{"user_metadata":{"age_gate":{"country":"DE","min_age":16}}}}') = '{}'::jsonb$q$
);

select pg_temp.holds (
    'hook: no age_gate is refused 400',
    $q$select (public.hook_before_user_created ('{"user":{"user_metadata":{}}}') #>> '{error,http_code}') = '400'$q$
);

select pg_temp.holds (
    'hook: an age below the country''s is refused 403, naming no age',
    $q$select (h #>> '{error,http_code}') = '403' and (h #>> '{error,message}') !~ '[0-9]'
       from public.hook_before_user_created (
           '{"user":{"user_metadata":{"age_gate":{"country":"DE","min_age":13}}}}') h$q$
);

select pg_temp.holds (
    'hook: a malformed country or a string age is refused',
    $q$select public.age_gate_problem ('{"age_gate":{"country":"Germany","min_age":16}}') = 'age_check_missing'
       and public.age_gate_problem ('{"age_gate":{"country":"DE","min_age":"16"}}') = 'age_check_missing'$q$
);

select pg_temp.holds (
    'hook: only supabase_auth_admin may call it',
    $q$select has_function_privilege ('supabase_auth_admin', 'public.hook_before_user_created(jsonb)', 'execute')
       and not has_function_privilege ('authenticated', 'public.hook_before_user_created(jsonb)', 'execute')
       and not has_function_privilege ('anon', 'public.hook_before_user_created(jsonb)', 'execute')$q$
);

-- ===========================================================================
-- Roster attestation columns and teacher_attestations
-- ===========================================================================
select pg_temp.refused (
    'managed_students: a lower-case country is refused',
    $q$update public.managed_students set country = 'de' where id = '1c000000-0000-4000-8000-0000000005b1'$q$,
    '23514'
);

select pg_temp.refused (
    'managed_students: a country without its attestation is refused',
    $q$update public.managed_students set country = 'FR' where id = '1c000000-0000-4000-8000-0000000005b2'$q$,
    '23514'
);

select pg_temp.act_as ('1c000000-0000-4000-8000-0000000000a1');

select pg_temp.holds (
    'teacher reads the new roster columns',
    $q$select country = 'DE' and age_attested_min_age = 16 from public.managed_students
       where id = '1c000000-0000-4000-8000-0000000005b1'$q$
);

select pg_temp.holds (
    'teacher reads their own attestations',
    $q$select count(*) = 1 from public.teacher_attestations
       where managed_student_id = '1c000000-0000-4000-8000-0000000005b1'$q$
);

select pg_temp.refused (
    'teacher cannot write an attestation themselves',
    $q$insert into public.teacher_attestations (teacher_id, action, country, min_age, wording, wording_version)
       values ('1c000000-0000-4000-8000-0000000000a1', 'create', 'US', 13, 'x', 'v')$q$,
    '42501'
);

select pg_temp.act_as ('1c000000-0000-4000-8000-0000000000a2');

select pg_temp.holds (
    'another teacher sees none of them',
    $q$select count(*) = 0 from public.teacher_attestations$q$
);

select pg_temp.refused (
    'a client cannot scrub anyone''s markings',
    $q$select public.scrub_student_markings ('1c000000-0000-4000-8000-0000000000b1')$q$,
    '42501'
);

select pg_temp.refused (
    'a client cannot run a purge',
    $q$select public.retention_purge_stale_guests ()$q$,
    '42501'
);

-- ===========================================================================
-- scrub_student_markings (the teacher's Delete student)
-- ===========================================================================
select pg_temp.act_as_server ();

create temp table seq_before as
select id, seq from public.annotations where document_id = '1c000000-0000-4000-8000-00000000d001';

grant select on seq_before to public;

select pg_temp.act_as_service ();

select pg_temp.refused (
    'scrub refuses an account that is not a provisioned student',
    $q$select public.scrub_student_markings ('1c000000-0000-4000-8000-0000000000a1')$q$,
    '22023'
);

select pg_temp.holds (
    'scrub reports two marks and one snapshot',
    $q$select public.scrub_student_markings ('1c000000-0000-4000-8000-0000000000b1')
       = '{"annotations":2,"snapshots":1}'::jsonb$q$
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'the student''s marks are tombstoned and their content is gone',
    $q$select bool_and(deleted_at is not null)
           and bool_and(payload::text not like '%secret%')
           and bool_and(public.annotation_payload_valid (kind, payload))
       from public.annotations
       where id in ('1c000000-0000-4000-8000-0000000a0001', '1c000000-0000-4000-8000-0000000a0002')$q$
);

select pg_temp.holds (
    'the tombstones bump seq, so every device converges by sync',
    $q$select bool_and(a.seq > b.seq) from public.annotations a join seq_before b using (id)
       where a.id in ('1c000000-0000-4000-8000-0000000a0001', '1c000000-0000-4000-8000-0000000a0002')$q$
);

select pg_temp.holds (
    'the teacher''s own mark is untouched',
    $q$select a.deleted_at is null and a.seq = b.seq and a.payload ->> 'w' = '0.01'
       from public.annotations a join seq_before b using (id)
       where a.id = '1c000000-0000-4000-8000-0000000a0003'$q$
);

select pg_temp.holds (
    'the snapshot keeps the teacher''s mark, drops the student''s and stops naming them',
    $q$select jsonb_array_length(payload) = 1
           and payload -> 0 ->> 'createdBy' = '1c000000-0000-4000-8000-0000000000a1'
           and created_by is null
       from public.annotation_snapshots where id = '1c000000-0000-4000-8000-00000000e001'$q$
);

select pg_temp.act_as_service ();

select pg_temp.holds (
    'a second scrub finds nothing new to cut from history',
    $q$select (public.scrub_student_markings ('1c000000-0000-4000-8000-0000000000b1') ->> 'snapshots')::int = 0$q$
);

-- ===========================================================================
-- Retention
-- ===========================================================================
select pg_temp.act_as_server ();

select public.retention_purge_archived_students ();

select pg_temp.holds (
    'archived 13 months ago: account and roster row gone, mark tombstoned',
    $q$select not exists (select 1 from auth.users where id = '1c000000-0000-4000-8000-0000000000b2')
       and not exists (select 1 from public.managed_students where id = '1c000000-0000-4000-8000-0000000005b2')
       and (select deleted_at is not null and created_by is null from public.annotations
            where id = '1c000000-0000-4000-8000-0000000a0004')$q$
);

select pg_temp.holds (
    'archived six months ago, and active students: kept',
    $q$select count(*) = 2 from public.managed_students
       where id in ('1c000000-0000-4000-8000-0000000005b3', '1c000000-0000-4000-8000-0000000005b1')$q$
);

select public.retention_purge_stale_guests ();

select pg_temp.holds (
    'a guest idle for 100 days is gone',
    $q$select not exists (select 1 from auth.users where id = '1c000000-0000-4000-8000-0000000000c1')$q$
);

select pg_temp.holds (
    'an old guest whose session refreshed today, a new guest and an old registered account stay',
    $q$select count(*) = 3 from auth.users
       where id in ('1c000000-0000-4000-8000-0000000000c2', '1c000000-0000-4000-8000-0000000000c3',
                    '1c000000-0000-4000-8000-0000000000c4')$q$
);

select public.retention_purge_rate_limits ();

select pg_temp.holds (
    'rate buckets: the stale ones go, the live ones stay',
    $q$select (select array_agg(key order by key) from public.edge_rate_buckets where key like 'lc:%') = array['lc:live']
       and (select array_agg(key order by key) from public.edge_login_attempts where key like 'lc:%') = array['lc:live']$q$
);

select public.retention_purge_support_messages ();

select pg_temp.holds (
    'support mail: 25 months old goes, 23 months old stays',
    $q$select array_agg(resend_email_id) = array['lc-new'] from public.support_messages
       where resend_email_id like 'lc-%'$q$
);

select pg_temp.holds (
    'the five retention jobs are scheduled, off the hour',
    $q$select count(*) = 5 and bool_and(schedule !~ '^0 ')
       from cron.job
       where jobname in ('retention-archived-students', 'retention-stale-guests', 'retention-rate-limits',
                         'retention-support-messages', 'retention-compact-tombstones')$q$
);

select pg_temp.holds (
    'every purge is SECURITY DEFINER with a pinned search_path',
    $q$select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
       from pg_proc p
       where p.proname in ('retention_purge_archived_students', 'retention_purge_stale_guests',
                           'retention_purge_rate_limits', 'retention_purge_support_messages',
                           'scrub_student_markings')$q$
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
