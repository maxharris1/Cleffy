-- clear_stale_code_reset_markers() (20261022140700, decision 64(1)'s
-- follow-up): app_metadata.code_reset_worker goes only from an account no live
-- reservation holds, and nothing else of app_metadata goes with it. LOCAL
-- STACK or the dev branch project only. One transaction, ROLLED BACK; the
-- last line is `failures | total`.
--
-- Cast: teacher T (account 1); roster students s1 .. s4 and s6 (accounts 2 .. 5
-- and 7), and u5 (account 6) with no roster row.
--   s1  marker, no reservation (the reset completed): cleared
--   s2  marker, a live reset whose worker is inside its Auth call: kept
--   s3  marker, a reset whose hold ran out: cleared
--   s4  marker, a live claim: kept
--   u5  marker, no roster row: cleared
--   s6  no marker: untouched
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('5a100000-0c10-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
-- Roster row of student n.
create function pg_temp.r(n int) returns uuid language sql immutable as $f$ select ('5a10e000-0c10-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
create function pg_temp.refused(p_name text, p_sql text, p_state text) returns void language plpgsql as $f$
declare v_state text; v_message text;
begin
execute p_sql;
insert into t_results values (p_name, false, 'no error raised');
exception when others then
get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
insert into t_results values (p_name, v_state = p_state, v_state || ' ' || v_message);
end $f$;
create function pg_temp.marker(n int) returns text language sql as $f$
    select raw_app_meta_data ->> 'code_reset_worker' from auth.users where id = pg_temp.u(n) $f$;
create temp table t_ran (k text primary key, v int);
grant all on t_ran to service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- Whatever stale markers this database already had go first (rolled back with
-- the rest), so the counts below are this proof's own.
select public.clear_stale_code_reset_markers (1000000);

insert into auth.users (id, email, raw_app_meta_data) values (pg_temp.u(1), 'csm-teacher@example.invalid', '{}');
insert into auth.users (id, email, raw_app_meta_data)
select pg_temp.u(n), 'csm-' || n || '@students.cleffy.app',
       jsonb_build_object('provider', 'email', 'user_type', 'student', 'teacher_id', pg_temp.u(1))
       || case when n = 7 then '{}'::jsonb else jsonb_build_object('code_reset_worker', gen_random_uuid()) end
from generate_series(2, 7) n;
-- Students 2..5 and 7 are on T's roster as s1..s4 and s6; 6 is u5 (no roster row).
insert into public.managed_students (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method)
select pg_temp.r(n), pg_temp.u(1), pg_temp.u(n), 'Student ' || n, 'hash-csm-' || n, 'code'
from unnest(array[2, 3, 4, 5, 7]) n;
update auth.users set raw_app_meta_data = raw_app_meta_data || '{"code_reset_worker": "w-u5"}' where id = pg_temp.u(6);
insert into public.student_claim_reservations (student_id, kind, login_code_hash, reserved_until, worker, worker_epoch, worker_in_auth) values
(pg_temp.r(3), 'reset', null, now() + interval '9 minutes', gen_random_uuid(), 7, true),
(pg_temp.r(4), 'reset', null, now() - interval '1 minute', gen_random_uuid(), 8, true),
(pg_temp.r(5), 'claim', 'hash-csm-5', now() + interval '1 minute', null, null, false);
create temp table t_before as select id, raw_app_meta_data from auth.users where id in (select pg_temp.u(n) from generate_series(1, 7) n);

select pg_temp.chk('01 control: five accounts carry a marker', $q$
    select count(*) = 5 from auth.users where id in (select pg_temp.u(n) from generate_series(1, 7) n)
                                          and raw_app_meta_data ? 'code_reset_worker'$q$);

set local role service_role;
insert into t_ran select 'first', public.clear_stale_code_reset_markers ();
reset role;

select pg_temp.chk('02 three are cleared: s1 (no reservation), s3 (hold ran out), u5 (no roster row)', $q$
    select (select v = 3 from t_ran where k = 'first')
       and pg_temp.marker(2) is null and pg_temp.marker(4) is null and pg_temp.marker(6) is null$q$);
select pg_temp.chk('03 s2, whose reset is live with its worker inside the Auth call, keeps its marker unchanged', $q$
    select pg_temp.marker(3) = (select raw_app_meta_data ->> 'code_reset_worker' from t_before where id = pg_temp.u(3))$q$);
select pg_temp.chk('04 s4, held by a live claim, keeps its marker too', $q$
    select pg_temp.marker(5) = (select raw_app_meta_data ->> 'code_reset_worker' from t_before where id = pg_temp.u(5))$q$);
select pg_temp.chk('05 only the marker goes: every other app_metadata key stays, and s6 and the teacher are untouched', $q$
    select bool_and(u.raw_app_meta_data - 'code_reset_worker' = b.raw_app_meta_data - 'code_reset_worker')
       and (select raw_app_meta_data = '{}'::jsonb from auth.users where id = pg_temp.u(1))
       and (select not raw_app_meta_data ? 'code_reset_worker' and raw_app_meta_data ->> 'user_type' = 'student'
            from auth.users where id = pg_temp.u(7))
    from auth.users u join t_before b on b.id = u.id$q$);
select pg_temp.chk('06 the reservations are untouched', $q$
    select count(*) = 3 from public.student_claim_reservations where student_id in (pg_temp.r(3), pg_temp.r(4), pg_temp.r(5))$q$);

set local role service_role;
insert into t_ran select 'again', public.clear_stale_code_reset_markers ();
reset role;
select pg_temp.chk('07 idempotent: a second call clears nothing more', $q$
    select (select v = 0 from t_ran where k = 'again') and pg_temp.marker(3) is not null and pg_temp.marker(5) is not null$q$);

-- s2's reset finishes (its reservation goes): the next call clears it.
delete from public.student_claim_reservations where student_id = pg_temp.r(3);
update auth.users set raw_app_meta_data = raw_app_meta_data || '{"code_reset_worker": "w-again"}' where id = pg_temp.u(2);
set local role service_role;
insert into t_ran select 'limited', public.clear_stale_code_reset_markers (1);
reset role;
select pg_temp.chk('08 at most p_limit accounts per call', $q$
    select (select v <= 1 from t_ran where k = 'limited')$q$);
set local role service_role;
insert into t_ran select 'rest', public.clear_stale_code_reset_markers ();
reset role;
select pg_temp.chk('09 ... and the calls clear s1''s new marker and s2''s once its reset is over, still not s4''s', $q$
    select (select sum(v) = 2 from t_ran where k in ('limited', 'rest'))
       and pg_temp.marker(2) is null and pg_temp.marker(3) is null and pg_temp.marker(5) is not null$q$);

set local role authenticated;
select pg_temp.refused('10 no client may call it', $q$select public.clear_stale_code_reset_markers ()$q$, '42501');
reset role;
select pg_temp.chk('11 it is the service role''s alone', $q$
    select has_function_privilege('service_role', 'public.clear_stale_code_reset_markers(integer)', 'execute')
       and not has_function_privilege('anon', 'public.clear_stale_code_reset_markers(integer)', 'execute')
       and not has_function_privilege('authenticated', 'public.clear_stale_code_reset_markers(integer)', 'execute')$q$);

select name, ok, coalesce(detail, '') from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
