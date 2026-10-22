-- An ordered replay of the migrations over a database that already has them,
-- including district retention log rows that record a skip (Codex round 1 on
-- #66, minor 1). LOCAL STACK only. One transaction ending in ROLLBACK; the last
-- line is `failures | total` (scripts/ci/sql-proof.sh reads it).
--
-- psql only: the migrations are included with \ir, relative to this file. Run
-- from the repository root against the local stack (npm run cloud:up):
--
--     bash scripts/ci/sql-proof.sh "postgresql://postgres:postgres@127.0.0.1:54422/postgres" \
--         tests/sql/migrations_ordered_replay.sql
--
-- What it replays: every migration from 20261020160300 on, in filename order,
-- which is every migration that can be applied a second time (each was checked
-- alone on 2026-10-22). The ones before it create tables, policies and
-- triggers without IF NOT EXISTS and never could; a fresh install (supabase
-- start / db reset) applies those, and all of these, once, in order. A recovery
-- replay of this list must pass with real data present. In particular
-- 20261021120800 drops and re-adds district_retention_log_step_check with its
-- own eight steps, so no later migration may log a step outside them: the
-- re-attribution skip (20261022130000) is logged as attribution_changed with
-- counts.event = 'skipped_reattributed'. Against this PR's first revision,
-- which added a ninth step, the replay stops at 20261021120800.
--
-- Before the replay: district A soft deleted, with one student moved out by
-- admin_set_student_district (a skip row and a carried-over restore, A still
-- pending); district D hard deleted after one of its students was
-- re-attributed the old way (the hard delete's skip row); and a deleted
-- account's keyed copyright strike, inherited by a re-registration.

\set ON_ERROR_STOP 1

begin;

create temp table t_results (name text primary key, ok boolean not null, detail text);

grant all on t_results to public;

create function pg_temp.chk (p_name text, p_sql text) returns void language plpgsql as $$
declare
    v boolean;
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql into v;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into t_results values (p_name, false, 'error: ' || v_state || ' ' || v_msg);
        return;
    end;
    insert into t_results values (p_name, coalesce(v, false), 'got ' || coalesce(v::text, 'null'));
end;
$$;

create function pg_temp.u (p text) returns uuid language sql immutable as $$
    select ('d5200000-0000-4000-8000-0000000000' || p)::uuid;
$$;

create function pg_temp.roster (p text) returns uuid language sql immutable as $$
    select ('d5200000-0000-4000-8000-0000000005' || p)::uuid;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
-- O owns district A and Q owns district D (contracts ended 17 days ago; one
-- live studio per owner since 20261022100300); neither has a plan of their
-- own, so a moved student's restore is carried over rather than done.
insert into auth.users (id, aud, role, email, raw_app_meta_data)
select pg_temp.u ('a1'), 'authenticated', 'authenticated', 'replay-owner@example.invalid', '{}'::jsonb
union all
select pg_temp.u ('a2'), 'authenticated', 'authenticated', 'replay-owner-d@example.invalid', '{}'::jsonb
union all
select pg_temp.u (s), 'authenticated', 'authenticated', 'replay-' || s || '@students.cleffy.app',
       '{"user_type":"student"}'::jsonb
from unnest(array['b1', 'b2', 'b3']) as s;

insert into public.studios (id, owner_id, name)
values ('d5200000-0000-4000-8000-0000000005da', pg_temp.u ('a1'), 'Replay district A'),
       ('d5200000-0000-4000-8000-0000000005dd', pg_temp.u ('a2'), 'Replay district D');

insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
values ('d5200000-0000-4000-8000-0000000005da', now() - interval '17 days', 'admin', 'test'),
       ('d5200000-0000-4000-8000-0000000005dd', now() - interval '17 days', 'admin', 'test');

insert into public.managed_students
    (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at, district_studio_id)
select pg_temp.roster (s), pg_temp.u (case when s = 'b1' then 'a1' else 'a2' end), pg_temp.u (s), 'Student ' || s, null, 'code', 'replay_' || s, now(),
       case when s = 'b1' then 'd5200000-0000-4000-8000-0000000005da'::uuid
            else 'd5200000-0000-4000-8000-0000000005dd'::uuid end
from unnest(array['b1', 'b2', 'b3']) as s;

-- Notice, sent, soft delete of both; then b1 is moved out of A by the admin
-- correction, b2 out of D the old way; D is moved on to its hard delete alone.
select public.retention_district_run (now());

select public.finish_district_retention_notice (id) from public.claim_district_retention_notices (20);

select public.retention_district_run (now() + interval '14 days 1 minute');

select public.admin_set_student_district (pg_temp.roster ('b1'), null, 'replay admin');

select set_config('cleffy.district_attribution', 'admin', true);

update public.managed_students set district_studio_id = null, district_attribution = 'admin'
where id = pg_temp.roster ('b2');

select set_config('cleffy.district_attribution', '', true);

-- A's hard delete is pushed out (a new, later end), so only D's runs now.
update public.district_retention set soft_deleted_at = now() + interval '30 days'
where studio_id = 'd5200000-0000-4000-8000-0000000005da';

select public.retention_district_run (now() + interval '21 days 2 minutes');

-- A copyright strike, its account deleted (keyed then), the address back.
insert into auth.users (id, aud, role, email, is_anonymous)
values (pg_temp.u ('c1'), 'authenticated', 'authenticated', 'replay-uploader@example.invalid', false),
       (pg_temp.u ('e1'), 'authenticated', 'authenticated', 'replay-moderator@example.invalid', false);

insert into public.content_moderators (user_id, note) values (pg_temp.u ('e1'), 'test');

insert into public.documents (id, owner_id, title, storage_path)
values ('d5200000-0000-4000-8000-00000000d001', pg_temp.u ('c1'), 'Score',
        'd5200000-0000-4000-8000-00000000d001/original.pdf');

select public.apply_content_takedown ('d5200000-0000-4000-8000-00000000d001', 'remove', 'copyright', '17 U.S.C. 512',
                                      'Facts', null, pg_temp.u ('e1'));

delete from auth.users where id = pg_temp.u ('c1');

insert into auth.users (id, aud, role, email, is_anonymous)
values (pg_temp.u ('c2'), 'authenticated', 'authenticated', 'replay-uploader@example.invalid', false);

-- What the replay must keep.
create temp table before_log as select * from public.district_retention_log;

create temp table before_restores as select * from public.district_retention_restores;

create temp table before_strikes as select * from public.content_strikes;

select pg_temp.chk ('00 before: skip rows from both halves, a carried-over restore, a keyed orphan strike', $q$
    select (select count(*) = 2 from before_log
            where step = 'attribution_changed' and counts ->> 'event' = 'skipped_reattributed'
              and studio_id in ('d5200000-0000-4000-8000-0000000005da', 'd5200000-0000-4000-8000-0000000005dd'))
       and (select count(*) = 1 from before_restores where studio_id = 'd5200000-0000-4000-8000-0000000005da')
       and (select count(*) = 1 from before_strikes s where s.user_id is null and s.subject_key is not null)
       and public.active_content_strikes (pg_temp.u ('c2')) = 1$q$);

-- ---------------------------------------------------------------------------
-- The replay, in order
-- ---------------------------------------------------------------------------
set local client_min_messages = warning;

\ir ../../supabase/migrations/20261020160300_cancel_link_token_lifetime.sql
\ir ../../supabase/migrations/20261020160400_cancel_link_tombstones_db_clock.sql
\ir ../../supabase/migrations/20261020160500_cancel_link_save_replayable.sql
\ir ../../supabase/migrations/20261020160600_cancel_link_serialized_history.sql
\ir ../../supabase/migrations/20261020160700_cancel_link_consume_db_clock.sql
\ir ../../supabase/migrations/20261020180400_district_seat_overrides.sql
\ir ../../supabase/migrations/20261020180500_district_seat_cap_and_grace.sql
\ir ../../supabase/migrations/20261020180600_read_only_seats_enforced.sql
\ir ../../supabase/migrations/20261020180700_read_only_seats_storage.sql
\ir ../../supabase/migrations/20261020180800_read_only_seats_live_ink.sql
\ir ../../supabase/migrations/20261020180900_district_paying_status.sql
\ir ../../supabase/migrations/20261020181000_district_contract_end_clamp.sql
\ir ../../supabase/migrations/20261020181100_read_only_seats_grace_deadline.sql
\ir ../../supabase/migrations/20261020181200_district_contract_end_automatic_retry.sql
\ir ../../supabase/migrations/20261021120000_consent_age.sql
\ir ../../supabase/migrations/20261021120100_teacher_attestations.sql
\ir ../../supabase/migrations/20261021120200_delete_student_markings.sql
\ir ../../supabase/migrations/20261021120300_retention_jobs.sql
\ir ../../supabase/migrations/20261021120400_delete_student_one_transaction.sql
\ir ../../supabase/migrations/20261021120500_retention_recheck_under_lock.sql
\ir ../../supabase/migrations/20261021120600_tombstone_resync_floor.sql
\ir ../../supabase/migrations/20261021120700_district_retention.sql
\ir ../../supabase/migrations/20261021120800_district_student_attribution.sql
\ir ../../supabase/migrations/20261021120900_district_notice_mail_budget.sql
\ir ../../supabase/migrations/20261022130000_district_retention_reattribution.sql
\ir ../../supabase/migrations/20261022130100_content_strikes_survive_deletion.sql
\ir ../../supabase/migrations/20261022130300_district_retention_late_students.sql
\ir ../../supabase/migrations/20261022130400_district_retention_moveout_locks.sql

reset client_min_messages;

-- ---------------------------------------------------------------------------
-- After
-- ---------------------------------------------------------------------------
select pg_temp.chk ('10 every district retention log row is still there, unchanged', $q$
    select (select count(*) from before_log) = (select count(*) from public.district_retention_log l
                                                 join before_log b using (id)
                                                 where l.step = b.step and l.counts = b.counts
                                                   and l.studio_id = b.studio_id and l.at = b.at)$q$);

select pg_temp.chk ('11 the carried-over restore and the strikes are unchanged', $q$
    select not exists (select * from before_restores except select * from public.district_retention_restores)
       and not exists (select * from public.district_retention_restores except select * from before_restores)
       and not exists (select * from before_strikes except select * from public.content_strikes)
       and not exists (select * from public.content_strikes except select * from before_strikes)$q$);

select pg_temp.chk ('12 the step check is 20261021120800''s eight steps, and there is one', $q$
    select count(*) = 1
       and bool_and(pg_get_constraintdef(c.oid) not like '%skipped_reattributed%'
                    and pg_get_constraintdef(c.oid) like '%attribution_backfill_run%')
    from pg_constraint c
    where c.conrelid = 'public.district_retention_log'::regclass and c.conname = 'district_retention_log_step_check'$q$);

select pg_temp.chk ('13 the latest definitions win: the run, the correction and the strike count', $q$
    select pg_get_functiondef('public.retention_district_run(timestamptz, int)'::regprocedure)
               like '%district_reattributed_restore%'
       and pg_get_functiondef('public.admin_set_student_district(uuid, uuid, text)'::regprocedure)
               like '%district_retention_restores%'
       and pg_get_functiondef('public.active_content_strikes(uuid)'::regprocedure) like '%subject_key_version%'
       and to_regprocedure('public.content_strike_subject_key(text)') is null$q$);

select pg_temp.chk ('13b and the late-student fix''s: the barrier, the sweep and the locked re-list', $q$
    select pg_get_functiondef('public.managed_students_district_attribution()'::regprocedure)
               like '%district_deletion_pending%'
       and pg_get_functiondef('public.district_provisionable(uuid, uuid)'::regprocedure)
               like '%district_provision_refusal%'
       and pg_get_functiondef('public.retention_district_run(timestamptz, int)'::regprocedure)
               like '%district_retention_list_late%'
       and pg_get_functiondef('public.admin_set_student_district(uuid, uuid, text)'::regprocedure)
               like '%district_deletion_pending%'$q$);

select pg_temp.chk ('14 one of each: strike triggers, retention jobs', $q$
    select (select count(*) = 1 from pg_trigger
            where tgrelid = 'auth.users'::regclass and tgname = 'content_strikes_key_on_account_delete')
       and (select count(*) = 1 from pg_trigger
            where tgrelid = 'public.content_strikes'::regclass and tgname = 'content_strikes_set_subject_key')
       and (select count(*) = 1 from cron.job where jobname = 'retention-content-strikes')
       and (select count(*) = 1 from cron.job where jobname = 'retention-archived-students')$q$);

select pg_temp.chk ('15 the re-registered address still inherits the strike', $q$
    select public.active_content_strikes (pg_temp.u ('c2')) = 1$q$);

-- And the replayed functions still work on the data: A is renewed, and its
-- cancel tries the carried-over restore (O still has no roster: refused, and
-- cleared with A's lists).
update public.district_billing set contract_ends_at = now() + interval '1 year'
where studio_id = 'd5200000-0000-4000-8000-0000000005da';

create temp table after_run as select public.retention_district_run (now() + interval '21 days 3 minutes') as v;

select pg_temp.chk ('16 after the replay, the run cancels A and clears its carried-over restore', $q$
    select (select (v ->> 'cancel')::int = 1 from after_run)
       and not exists (select 1 from public.district_retention_restores
                       where studio_id = 'd5200000-0000-4000-8000-0000000005da')
       and exists (select 1 from public.district_retention_log
                   where studio_id = 'd5200000-0000-4000-8000-0000000005da' and step = 'cancelled'
                     and (counts ->> 'reattributed_restored')::int = 0)$q$);

-- ---------------------------------------------------------------------------
-- Report: every check, then `failures | total`
-- ---------------------------------------------------------------------------
select name, ok, detail from t_results order by name;

select count(*) filter (where not ok) as failures, count(*) as total from t_results;

rollback;
