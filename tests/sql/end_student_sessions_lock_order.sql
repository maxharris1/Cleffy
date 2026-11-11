-- Concurrency proof for 20261022140900_end_student_sessions_lock_order.sql
-- (launch-fix follow-up 17): end_student_sessions() and a retention-style
-- revocation of the same student no longer deadlock.
--
-- The retention run's soft delete locks the student's roster row, then
-- deletes their refresh tokens and sessions. end_student_sessions() deleted the
-- tokens and sessions first and updated the roster row last. Here session c
-- takes the roster row as the soft delete does; x calls end_student_sessions()
-- (student-provision's archive or reset); then c deletes the tokens. With
-- 20261020150100's function, x held the tokens and waited for the row while c
-- held the row and waited for the tokens: `deadlock detected`. Now x waits for
-- the row before it touches a token, c goes straight on, and x finishes after.
--
-- NOT one transaction: the fixtures are committed so the other backends see
-- them, and removed at the end (and at the start, after a run that stopped
-- half way). It needs the dblink extension, created here when missing and
-- dropped again if this proof created it. The other backends connect back
-- over TCP with the LOCAL stack's default password (postgres/postgres): local
-- stacks and CI only, never a hosted project. Same harness as
-- tests/sql/storage_quota_lock_concurrency.sql.
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/end_student_sessions_lock_order.sql
--
-- Every row should read `t`; the last line is `failures | total`.
\set ON_ERROR_STOP on
create temp table t_results (name text, ok boolean, detail text);
create temp table t_state (k text primary key, v text);
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('5a120000-0c12-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.chk(p_name text, p_ok boolean, p_detail text default null) returns void language sql as $f$
insert into t_results values (p_name, coalesce(p_ok, false), p_detail)
$f$;

-- dblink, for this run only if it was not already there.
insert into t_state values ('dblink_preexisting', (select count(*)::text from pg_extension where extname = 'dblink'));
create extension if not exists dblink with schema extensions;

-- Open a backend of our own, as postgres (the Storage API's service path).
create function pg_temp.open(p_conn text) returns void language plpgsql as $f$
begin
    perform extensions.dblink_connect(p_conn, format('host=%s port=%s dbname=%s user=postgres password=postgres',
        host(inet_server_addr()), inet_server_port(), current_database()));
end $f$;
create function pg_temp.run(p_conn text, p_sql text) returns void language plpgsql as $f$
begin perform extensions.dblink_exec(p_conn, p_sql); end $f$;
-- Send without waiting; await() collects the result: its rows, or
-- 'ERROR: <message>'.
create function pg_temp.send(p_conn text, p_sql text) returns void language plpgsql as $f$
begin perform extensions.dblink_send_query(p_conn, p_sql); end $f$;
create function pg_temp.await(p_conn text) returns text language plpgsql as $f$
declare v text; v_out text := ''; v_err text;
begin
    for v in select s from extensions.dblink_get_result(p_conn, false) as t(s text) loop
        v_out := v_out || coalesce(v, '');
    end loop;
    v_err := extensions.dblink_error_message(p_conn);
    perform 1 from extensions.dblink_get_result(p_conn, false) as t(s text);
    return case when v_err is distinct from 'OK'
                then 'ERROR: ' || regexp_replace(regexp_replace(v_err, '^ERROR:\s*', ''), '\s+', ' ', 'g')
                else v_out end;
end $f$;
create function pg_temp.busy(p_conn text) returns boolean language sql as $f$ select extensions.dblink_is_busy(p_conn) = 1 $f$;
-- One row's answer from a backend, now.
create function pg_temp.ask(p_conn text, p_sql text) returns text language sql as $f$
select s from extensions.dblink(p_conn, p_sql) as t(s text)
$f$;
-- Remove every fixture: before the run (a stopped earlier run) and after.
create function pg_temp.cleanup() returns void language plpgsql as $f$
begin
    delete from auth.refresh_tokens where user_id = pg_temp.u(2)::text;
    delete from auth.sessions where user_id = pg_temp.u(2);
    delete from public.managed_students where teacher_id = pg_temp.u(1);
    delete from auth.users where id in (pg_temp.u(1), pg_temp.u(2));
end $f$;
select pg_temp.cleanup();

-- Teacher 1; student 2 signed in on one device (a session and its refresh token).
insert into auth.users (id, email, raw_app_meta_data) values
(pg_temp.u(1), 'ess-teacher@example.invalid', '{}'),
(pg_temp.u(2), 'ess-student@students.cleffy.app', jsonb_build_object('user_type', 'student', 'teacher_id', pg_temp.u(1)));
insert into public.managed_students (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method)
values (pg_temp.u(20), pg_temp.u(1), pg_temp.u(2), 'Student', 'hash-ess-2', 'code');
insert into auth.sessions (id, user_id, created_at, updated_at) values (pg_temp.u(30), pg_temp.u(2), now(), now());
insert into auth.refresh_tokens (token, user_id, revoked, created_at, updated_at, session_id)
values ('ess-token-' || pg_temp.u(2)::text, pg_temp.u(2)::text, false, now(), now(), pg_temp.u(30));

select pg_temp.open('c'), pg_temp.open('x');
select pg_temp.run('x', format('set "request.jwt.claims" to %L', json_build_object('role', 'service_role')::text));

-- c: the soft delete's order. The roster row first ...
select pg_temp.run('c', 'begin');
select pg_temp.run('c', format('update public.managed_students set archived_at = now(), access_revoked_at = clock_timestamp() where id = %L', pg_temp.u(20)));
-- ... x: the teacher's archive or reset ends the student's sessions ...
select pg_temp.send('x', format('select coalesce(public.end_student_sessions (%L)::text, ''null'')', pg_temp.u(2)));
select pg_sleep(0.3);
select pg_temp.chk('01 end_student_sessions waits for the roster row the soft delete holds', pg_temp.busy('x'));

-- ... then c deletes the tokens and sessions, as the soft delete does.
insert into t_state values ('t_tokens', clock_timestamp()::text);
select pg_temp.send('c', format('delete from auth.refresh_tokens where user_id = %L', pg_temp.u(2)::text));
insert into t_state values ('tokens', pg_temp.await('c'));
insert into t_state values ('tokens_ms', (select (extract(epoch from clock_timestamp() - (select v::timestamptz from t_state where k = 't_tokens')) * 1000)::int::text));
select pg_temp.chk('03 the soft delete deletes the tokens at once: nothing of them is held, so no deadlock',
    (select v not like 'ERROR:%' from t_state where k = 'tokens') and (select v::int < 300 from t_state where k = 'tokens_ms'),
    (select v from t_state where k = 'tokens') || ' after ' || (select v from t_state where k = 'tokens_ms') || ' ms');
select pg_temp.run('c', format('delete from auth.sessions where user_id = %L', pg_temp.u(2)));
select pg_temp.run('c', 'commit');
insert into t_state values ('ended', pg_temp.await('x'));
select pg_temp.chk('04 then end_student_sessions finishes, without a deadlock: nothing left to end',
    (select v = '0' from t_state where k = 'ended'), (select v from t_state where k = 'ended'));
select pg_temp.chk('05 the student is archived, every token and session is gone, and access_revoked_at is stamped',
    (select archived_at is not null and access_revoked_at is not null from public.managed_students where id = pg_temp.u(20))
    and not exists (select 1 from auth.refresh_tokens where user_id = pg_temp.u(2)::text)
    and not exists (select 1 from auth.sessions where user_id = pg_temp.u(2)));
select pg_temp.chk('06 the function takes the roster row first: its lock comes before the token delete in its text',
    pg_get_functiondef('public.end_student_sessions(uuid)'::regprocedure)
        ~ 'for update[\s\S]*delete from auth\.refresh_tokens[\s\S]*delete from auth\.sessions[\s\S]*access_revoked_at = clock_timestamp');

-- ===========================================================================
-- Done: close the backends, remove the fixtures, and dblink if it was ours
-- ===========================================================================
select extensions.dblink_disconnect('c'), extensions.dblink_disconnect('x');
select pg_temp.cleanup();
select pg_temp.chk('10 every fixture is gone',
    not exists (select 1 from auth.users where id in (pg_temp.u(1), pg_temp.u(2)))
    and not exists (select 1 from public.managed_students where teacher_id = pg_temp.u(1))
    and not exists (select 1 from auth.sessions where user_id = pg_temp.u(2)));
do $f$ begin
    if (select v from t_state where k = 'dblink_preexisting') = '0' then
        drop extension dblink;
    end if;
end $f$;

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
