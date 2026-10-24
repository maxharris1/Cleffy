-- Concurrency proof for clear_stale_code_reset_markers() (20261022140700, PR
-- #72 fix 2): the marker cleanup and an Auth account deletion of the same
-- student never deadlock.
--
-- The cleanup locks the student's roster row (and reservation), then writes
-- the account's auth.users row. An Auth deletion holds that auth.users row,
-- then waits for the roster row through managed_students' ON DELETE CASCADE:
-- the inverse order. Here session c takes the student's auth.users row as the
-- deletion does; x runs the cleanup; then c deletes the account. With the
-- first version of the function, x held the roster row and waited for the
-- auth row while c held the auth row and waited for the roster row:
-- `deadlock detected`. Now x takes the auth row NOWAIT, passes the student
-- over, and lets go of its roster row at once; c's delete goes straight on.
--
--   A  deletion holds the auth row first: the cleanup does not wait, skips the
--      student, and the delete runs at once (the deadlock case).
--   B  an Auth update holds the auth row: the cleanup, still in its own open
--      transaction, has let go of the roster row (a third backend takes it
--      NOWAIT); the next call, once the row is free, clears the marker.
--   C  the cleanup goes first: the deletion only waits for it, then deletes.
--
-- NOT one transaction: the fixtures are committed so the other backends see
-- them, and removed at the end (and at the start, after a run that stopped
-- half way). It needs the dblink extension, created here when missing and
-- dropped again if this proof created it. The other backends connect back
-- over TCP with the LOCAL stack's default password (postgres/postgres): local
-- stacks and CI only, never a hosted project. Same harness as
-- tests/sql/end_student_sessions_lock_order.sql.
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/clear_stale_code_reset_markers_race.sql
--
-- Every row should read `t`; the last line is `failures | total`.
\set ON_ERROR_STOP on
create temp table t_results (name text, ok boolean, detail text);
create temp table t_state (k text primary key, v text);
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('5a140000-0c14-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
-- Roster row of student n.
create function pg_temp.r(n int) returns uuid language sql immutable as $f$ select ('5a14e000-0c14-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.chk(p_name text, p_ok boolean, p_detail text default null) returns void language sql as $f$
insert into t_results values (p_name, coalesce(p_ok, false), p_detail)
$f$;
create function pg_temp.marker(n int) returns text language sql as $f$
    select raw_app_meta_data ->> 'code_reset_worker' from auth.users where id = pg_temp.u(n) $f$;

-- dblink, for this run only if it was not already there.
insert into t_state values ('dblink_preexisting', (select count(*)::text from pg_extension where extname = 'dblink'));
create extension if not exists dblink with schema extensions;

-- Open a backend of our own, as postgres (as Auth and the service role's calls run).
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
-- ask(), or 'ERROR: <message>' when the backend refuses it.
create function pg_temp.try_ask(p_conn text, p_sql text) returns text language plpgsql as $f$
begin return pg_temp.ask(p_conn, p_sql);
exception when others then return 'ERROR: ' || sqlerrm; end $f$;
-- Milliseconds since the stamp `k`.
create function pg_temp.ms_since(p_k text) returns int language sql as $f$
select (extract(epoch from clock_timestamp() - (select v::timestamptz from t_state where k = p_k)) * 1000)::int
$f$;
-- Remove every fixture: before the run (a stopped earlier run) and after.
create function pg_temp.cleanup() returns void language plpgsql as $f$
begin
    delete from public.managed_students where teacher_id = pg_temp.u(1);
    delete from auth.users where id in (select pg_temp.u(n) from generate_series(1, 4) n);
end $f$;
select pg_temp.cleanup();

-- Whatever stale markers this database already had go first, so the counts
-- below are this proof's own.
select public.clear_stale_code_reset_markers (1000000);

-- Teacher 1; students 2, 3 and 4 on its roster, each with a stale marker (no
-- reservation: their resets completed).
insert into auth.users (id, email, raw_app_meta_data) values (pg_temp.u(1), 'csmr-teacher@example.invalid', '{}');
insert into auth.users (id, email, raw_app_meta_data)
select pg_temp.u(n), 'csmr-' || n || '@students.cleffy.app',
       jsonb_build_object('provider', 'email', 'user_type', 'student', 'teacher_id', pg_temp.u(1), 'code_reset_worker', 'w-' || n)
from generate_series(2, 4) n;
insert into public.managed_students (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method)
select pg_temp.r(n), pg_temp.u(1), pg_temp.u(n), 'Student ' || n, 'hash-csmr-' || n, 'code'
from generate_series(2, 4) n;

select pg_temp.open('c'), pg_temp.open('x'), pg_temp.open('y');
select pg_temp.run('x', format('set "request.jwt.claims" to %L', json_build_object('role', 'service_role')::text));
-- A wait this proof does not expect ends in an error, not a hang.
select pg_temp.run('x', 'set statement_timeout = ''5s'''), pg_temp.run('c', 'set statement_timeout = ''5s''');

-- ===========================================================================
-- A: the deletion holds student 2's auth row, then deletes the account
-- ===========================================================================
-- Only student 2 is a candidate here (3 and 4 are held aside by c too, below).
select pg_temp.run('c', 'begin');
select pg_temp.ask('c', format('select count(*)::text from (select 1 from auth.users where id = %L for update) l', pg_temp.u(2)));
select pg_temp.run('y', 'begin');
select pg_temp.ask('y', format('select count(*)::text from (select 1 from public.managed_students where id in (%L, %L) for update) l', pg_temp.r(3), pg_temp.r(4)));
insert into t_state values ('a_start', clock_timestamp()::text);
select pg_temp.send('x', 'select public.clear_stale_code_reset_markers ()::text');
select pg_sleep(0.3);
select pg_temp.chk('01 the cleanup does not wait for the auth row an Auth deletion holds', not pg_temp.busy('x'));

-- c deletes the account: its cascade takes the roster row, which nothing
-- holds now. (The first version still held it here, waiting for c's auth
-- row: `deadlock detected`.)
insert into t_state values ('a_delete_start', clock_timestamp()::text);
select pg_temp.send('c', format('delete from auth.users where id = %L', pg_temp.u(2)));
insert into t_state values ('a_delete', pg_temp.await('c'));
insert into t_state values ('a_delete_ms', pg_temp.ms_since('a_delete_start')::text);
insert into t_state values ('a_cleanup', pg_temp.await('x'));
select pg_temp.chk('02 ... it passes the student over: nothing cleared',
    (select v = '0' from t_state where k = 'a_cleanup'), (select v from t_state where k = 'a_cleanup'));
select pg_temp.chk('03 the deletion goes straight on: no wait on the roster row, no deadlock',
    (select v not like 'ERROR:%' from t_state where k = 'a_delete') and (select v::int < 300 from t_state where k = 'a_delete_ms'),
    (select v from t_state where k = 'a_delete') || ' after ' || (select v from t_state where k = 'a_delete_ms') || ' ms');
select pg_temp.run('c', 'commit');
select pg_temp.run('y', 'rollback');
select pg_temp.chk('04 student 2''s account and roster row are gone',
    not exists (select 1 from auth.users where id = pg_temp.u(2))
    and not exists (select 1 from public.managed_students where id = pg_temp.r(2)));

-- ===========================================================================
-- B: an Auth update holds student 3's auth row while a cleanup runs
-- ===========================================================================
select pg_temp.run('c', 'begin');
select pg_temp.ask('c', format('select count(*)::text from (select 1 from auth.users where id = %L for update) l', pg_temp.u(3)));
select pg_temp.run('y', 'begin');
select pg_temp.ask('y', format('select count(*)::text from (select 1 from public.managed_students where id = %L for update) l', pg_temp.r(4)));
-- x's own transaction stays open after the call, so any lock it kept would show.
select pg_temp.run('x', 'begin');
select pg_temp.send('x', 'select public.clear_stale_code_reset_markers ()::text');
select pg_sleep(0.3);
insert into t_state values ('b_busy', pg_temp.busy('x')::text);
select pg_temp.run('c', 'rollback') where (select v = 'true' from t_state where k = 'b_busy'); -- the first version waits on it
insert into t_state values ('b_cleanup', pg_temp.await('x'));
select pg_temp.chk('05 the busy account is passed over at once: nothing cleared, the marker stays',
    (select v = 'false' from t_state where k = 'b_busy')
    and (select v = '0' from t_state where k = 'b_cleanup') and pg_temp.marker(3) = 'w-3',
    (select v from t_state where k = 'b_cleanup'));
select pg_temp.run('y', 'rollback');
insert into t_state values ('b_roster', pg_temp.try_ask('y',
    format('select count(*)::text from (select 1 from public.managed_students where id = %L for update nowait) l', pg_temp.r(3))));
select pg_temp.chk('06 ... and the cleanup let go of its roster row: another backend takes it NOWAIT while the cleanup''s transaction is still open',
    (select v = '1' from t_state where k = 'b_roster'), (select v from t_state where k = 'b_roster'));
select pg_temp.run('x', 'commit');
select pg_temp.run('c', 'rollback') where (select v = 'false' from t_state where k = 'b_busy');
insert into t_state values ('b_next', pg_temp.ask('x', 'select public.clear_stale_code_reset_markers ()::text'));
select pg_temp.chk('07 the next call, the row free again, clears students 3''s and 4''s markers',
    (select v = '2' from t_state where k = 'b_next') and pg_temp.marker(3) is null and pg_temp.marker(4) is null,
    (select v from t_state where k = 'b_next'));

-- ===========================================================================
-- C: the cleanup goes first; the deletion waits for it, then deletes
-- ===========================================================================
update auth.users set raw_app_meta_data = raw_app_meta_data || '{"code_reset_worker": "w-again"}' where id = pg_temp.u(3);
select pg_temp.run('x', 'begin');
insert into t_state values ('c_cleanup', pg_temp.ask('x', 'select public.clear_stale_code_reset_markers ()::text'));
select pg_temp.send('c', format('delete from auth.users where id = %L', pg_temp.u(3)));
select pg_sleep(0.3);
select pg_temp.chk('08 a deletion after the cleanup waits for it (the cleanup holds the auth row it wrote)',
    (select v = '1' from t_state where k = 'c_cleanup') and pg_temp.busy('c'), (select v from t_state where k = 'c_cleanup'));
select pg_temp.run('x', 'commit');
insert into t_state values ('c_delete', pg_temp.await('c'));
select pg_temp.chk('09 ... then deletes the account, without a deadlock',
    (select v not like 'ERROR:%' from t_state where k = 'c_delete')
    and not exists (select 1 from auth.users where id = pg_temp.u(3))
    and not exists (select 1 from public.managed_students where id = pg_temp.r(3)),
    (select v from t_state where k = 'c_delete'));
select pg_temp.chk('10 the function takes the auth row NOWAIT inside a per-candidate block',
    pg_get_functiondef('public.clear_stale_code_reset_markers(integer)'::regprocedure)
        ~ 'for update skip locked[\s\S]*from auth\.users u\s+where u\.id = v_user\.id\s+for update nowait[\s\S]*exception when lock_not_available');

-- ===========================================================================
-- Done: close the backends, remove the fixtures, and dblink if it was ours
-- ===========================================================================
select extensions.dblink_disconnect('c'), extensions.dblink_disconnect('x'), extensions.dblink_disconnect('y');
select pg_temp.cleanup();
select pg_temp.chk('11 every fixture is gone',
    not exists (select 1 from auth.users where id in (select pg_temp.u(n) from generate_series(1, 4) n))
    and not exists (select 1 from public.managed_students where teacher_id = pg_temp.u(1)));
do $f$ begin
    if (select v from t_state where k = 'dblink_preexisting') = '0' then
        drop extension dblink;
    end if;
end $f$;

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
