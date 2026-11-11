-- An admin's district correction and the retention run take their locks in
-- one order (20261022130400, Codex's REVISE finding 2 on 20261022130300):
-- the districts' billing rows first, then the roster row. Between real
-- sessions, no correction and run on the same districts deadlock: one waits,
-- or is refused at once and retried, and both finish.
--
--   L1 admin_set_student_district() moving a student from a soft-deleted
--      district into a live one, while the run holds the live one (its notice)
--      and has yet to sweep the student's: the correction waits for the run
--      and both finish;
--   L2 the same move as a raw admin-flagged UPDATE, which locks the roster row
--      before its trigger can take a district's lock: the trigger does not
--      wait for the run (the run may be about to wait for that row) but is
--      refused at once (55P03 district_busy), the run finishes, and the
--      UPDATE retried afterwards goes through. Before 20261022130400 the two
--      deadlocked here;
--   L3 admin_set_student_district (student, null), the move out, while the run
--      holds the student's district: the move takes that district's lock too,
--      so it waits for the run, and both finish.
--
-- The run is held part-way by a fourth session holding the swept district's
-- retention row, so the correction can be started while the run holds the
-- districts it has passed. Each step that may wait is sent asynchronously,
-- and the proof polls until that session is waiting on a lock or has finished
-- (tests/sql/district_retention_late_student_race.sql's harness). The sessions
-- are dblink connections as postgres that COMMIT their own rows (fixed ids,
-- deleted at the start and the end), and the runs are real: so the proof first
-- checks that no other district on the database would be touched by a run
-- now, and runs nothing otherwise. LOCAL STACK only:
--
--     bash scripts/ci/sql-proof.sh "$DATABASE_URL" tests/sql/district_retention_admin_lock_order.sql
--
-- The dblink sessions log in with the local stack's password; pass
-- -v peer_password=... for any other. The last line is `failures | total`.
--
-- Cast: N1 and N2 are live districts whose notices are due (contracts ended
-- 17 days ago); S1, S2 and S3 were soft deleted yesterday (contracts ended 40
-- days ago). r1, r2 and r3 are attributed to S1, S2 and S3 and not on their
-- lists yet, so the run's sweep lists each. Ids sort N1 < S1 < N2 < S2 < S3.
\set ON_ERROR_STOP on
\if :{?peer_password}
\else
\set peer_password postgres
\endif
\o /dev/null
begin;
create temp table t_results (n serial, name text, ok boolean, detail text);
create temp table t_out (label text primary key, answer text);
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results (name, ok, detail) values (p_name, coalesce(v, false), null);
exception when others then insert into t_results (name, ok, detail) values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
create function pg_temp.note(p_name text, p_ok boolean, p_detail text default null) returns void language sql as $f$
    insert into t_results (name, ok, detail) values (p_name, coalesce(p_ok, false), p_detail)
$f$;

create function pg_temp.x(p text) returns uuid language sql immutable as $f$
    select ('d5800000-0000-4000-8000-0000000000' || p)::uuid
$f$;
create function pg_temp.roster(p text) returns uuid language sql immutable as $f$
    select ('d5800000-0000-4000-8000-0000000005' || p)::uuid
$f$;
create function pg_temp.district(p text) returns uuid language sql immutable as $f$
    select ('d5800000-0000-4000-8000-0000000005d' || p)::uuid
$f$;
-- Each district's one-digit code: N1 = 1, S1 = 2, N2 = 3, S2 = 4, S3 = 5. Its
-- owner is x('a' || code), its student (S only) roster('b' || code).
create function pg_temp.code(p_name text) returns text language sql immutable as $f$
    select case p_name when 'N1' then '1' when 'S1' then '2' when 'N2' then '3' when 'S2' then '4' when 'S3' then '5' end
$f$;
create function pg_temp.d(p_name text) returns uuid language sql immutable as $f$
    select pg_temp.district(pg_temp.code(p_name))
$f$;
create function pg_temp.student(p_name text) returns uuid language sql immutable as $f$
    select pg_temp.roster('b' || pg_temp.code(p_name))
$f$;

create extension if not exists dblink with schema extensions;
create function pg_temp.peer() returns text language sql as $f$
    select format('host=%s port=%s dbname=%s user=postgres password=%s',
        host(inet_server_addr()), inet_server_port(), current_database(), current_setting('race.peer_password'))
$f$;
select set_config('race.peer_password', :'peer_password', false);
select extensions.dblink_connect('a', pg_temp.peer());
select extensions.dblink_connect('b', pg_temp.peer());
select extensions.dblink_connect('c', pg_temp.peer());
select extensions.dblink_connect('h', pg_temp.peer());
create function pg_temp.on(p_conn text, p_sql text) returns text language sql as $f$ select extensions.dblink_exec(p_conn, p_sql) $f$;
create temp table t_pid (conn text primary key, pid int);
insert into t_pid select c, r.pid from unnest(array['a', 'b', 'c', 'h']) c,
    lateral extensions.dblink(c, 'select pg_backend_pid()') as r(pid int);
create function pg_temp.pid(p_conn text) returns int language sql as $f$ select pid from t_pid where conn = p_conn $f$;
-- The value of expression p_expr in session p_conn, waiting for it.
create function pg_temp.q(p_conn text, p_expr text) returns text language sql as $f$
    select r.v from extensions.dblink(p_conn, 'select (' || p_expr || ')::text') as r(v text)
$f$;
-- The one text value statement p_sql returns in session p_conn, waiting for it.
create function pg_temp.r(p_conn text, p_sql text) returns text language sql as $f$
    select r.v from extensions.dblink(p_conn, p_sql) as r(v text)
$f$;
-- Sends p_sql (one statement, one text column) without waiting.
create function pg_temp.send(p_conn text, p_sql text) returns int language sql as $f$ select extensions.dblink_send_query(p_conn, p_sql) $f$;
-- What p_conn's sent statement is doing (within 10 s): 'waiting' on a lock,
-- 'finished', or still 'running'.
create function pg_temp.settle(p_conn text) returns text language plpgsql as $f$
begin
    for i in 1 .. 200 loop
        if extensions.dblink_is_busy(p_conn) = 0 then
            return 'finished';
        end if;
        if exists (select 1 from pg_locks where pid = pg_temp.pid(p_conn) and not granted) then
            return 'waiting';
        end if;
        perform pg_sleep(0.05);
    end loop;
    return 'running';
end $f$;
-- The answer to what p_conn was sent: its one value, or 'ERROR: ' and the
-- message (with its SQLSTATE, from the connection's last error).
create function pg_temp.answer(p_conn text) returns text language plpgsql as $f$
declare v text;
begin
    select r.v into v from extensions.dblink_get_result(p_conn, false) as r(v text);
    if v is null then
        v := 'ERROR: ' || extensions.dblink_error_message(p_conn);
    end if;
    perform * from extensions.dblink_get_result(p_conn, false) as r(v text);
    return v;
end $f$;
create function pg_temp.keep(p_label text, p_answer text) returns void language sql as $f$
    insert into t_out values (p_label, p_answer) on conflict (label) do update set answer = excluded.answer
$f$;
create function pg_temp.got(p_label text) returns text language sql as $f$ select answer from t_out where label = p_label $f$;

-- District p_name committed: 'live' with its notice due, or 'soft_deleted'
-- yesterday with its roster student attributed to it and not on its list yet.
create function pg_temp.district_fixture(p_name text, p_stage text) returns void language plpgsql as $f$
declare
    k text := pg_temp.code(p_name);
begin
perform pg_temp.on('c', format($s$insert into auth.users (id, aud, role, email, raw_app_meta_data)
    values (%L, 'authenticated', 'authenticated', %L, '{}')$s$, pg_temp.x('a' || k), 'o' || k || '@lock-order.test'));
perform pg_temp.on('c', format($s$insert into public.studios (id, owner_id, name) values (%L, %L, %L)$s$,
    pg_temp.d(p_name), pg_temp.x('a' || k), 'P5 lock order ' || p_name));
perform pg_temp.on('c', format($s$insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
    values (%L, date_trunc('second', now()) - %L::interval, 'admin', 'p5 lock order')$s$,
    pg_temp.d(p_name), case p_stage when 'live' then '17 days' else '40 days' end));
if p_stage = 'soft_deleted' then
    perform pg_temp.on('c', format($s$insert into auth.users (id, aud, role, email, raw_app_meta_data)
        values (%L, 'authenticated', 'authenticated', %L, '{"user_type":"student"}')$s$,
        pg_temp.x('b' || k), 'r' || k || '@lock-order.test'));
    perform pg_temp.on('c', format($s$insert into public.managed_students
        (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at, district_studio_id)
        values (%L, %L, %L, %L, null, 'code', %L, now(), %L)$s$,
        pg_temp.roster('b' || k), pg_temp.x('a' || k), pg_temp.x('b' || k), 'Lock order ' || k, 'p5lockorder_' || k,
        pg_temp.d(p_name)));
    perform pg_temp.on('c', format($s$insert into public.district_retention
        (studio_id, owner_id, contract_ends_at, notice_queued_at, notice_sent_at, soft_deleted_at)
        select b.studio_id, %L, b.contract_ends_at, now() - interval '21 days', now() - interval '20 days',
               now() - interval '1 day'
        from public.district_billing b where b.studio_id = %L$s$, pg_temp.x('a' || k), pg_temp.d(p_name)));
end if;
end $f$;

-- Session h holds district p_name's retention row; the run, sent in session
-- b, stops there once it has locked the districts before it. Kept: whether it
-- did ('<label>-held').
create function pg_temp.hold_run(p_label text, p_name text) returns void language plpgsql as $f$
begin
perform pg_temp.on('h', 'begin');
perform pg_temp.r('h', format('select studio_id::text from public.district_retention where studio_id = %L for update',
    pg_temp.d(p_name)));
perform pg_temp.on('b', 'begin');
perform pg_temp.send('b', 'select public.retention_district_run (now())::text');
perform pg_temp.keep(p_label || '-held', pg_temp.settle('b'));
end $f$;

-- With the correction sent in session a and the run in b held by h: settles
-- the correction ('<label>-state'), lets the run go, and keeps both answers
-- ('<label>-correction', '<label>-run'). A correction that has already
-- finished (or failed) ends its transaction with p_end first, so a run that
-- needs its roster row is not left waiting on it; one that waits on the run is
-- answered after it.
create function pg_temp.release(p_label text, p_end text) returns void language plpgsql as $f$
begin
perform pg_temp.keep(p_label || '-state', pg_temp.settle('a'));
if pg_temp.got(p_label || '-state') = 'finished' then
    perform pg_temp.keep(p_label || '-correction', pg_temp.answer('a'));
    perform pg_temp.on('a', p_end);
end if;
perform pg_temp.on('h', 'rollback');
perform pg_temp.keep(p_label || '-run', pg_temp.answer('b'));
perform pg_temp.on('b', 'commit');
if pg_temp.got(p_label || '-state') <> 'finished' then
    perform pg_temp.keep(p_label || '-correction', pg_temp.answer('a'));
    perform pg_temp.on('a', p_end);
end if;
end $f$;

-- Everything this proof commits, any run's.
create function pg_temp.cleanup() returns void language plpgsql as $f$
begin
perform pg_temp.on('c', $s$delete from public.district_retention_log where studio_id::text like 'd5800000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.district_retention_notices where studio_id::text like 'd5800000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.district_retention_students where studio_id::text like 'd5800000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.district_retention_restores where studio_id::text like 'd5800000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.district_retention where studio_id::text like 'd5800000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.studios where id::text like 'd5800000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.district_billing_log where studio_id::text like 'd5800000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.managed_students where username like 'p5lockorder_%'$s$);
perform pg_temp.on('c', $s$delete from auth.users where email like '%@lock-order.test'$s$);
end $f$;
select pg_temp.cleanup();

select pg_temp.chk('0 no other district would be touched by a run now (the runs are real)', $q$
    select not exists (select 1 from public.retention_district_candidates (now() + interval '1 hour'))
       and not exists (select 1 from public.district_retention where hard_deleted_at is null)$q$);

-- ===========================================================================
-- L1. admin_set_student_district (r1, N1) against a run holding N1
-- ===========================================================================
do $d$
begin
if not (select ok from t_results where name like '0 %') then
    perform pg_temp.note('L skipped: other districts would be touched on this database', false);
    return;
end if;
perform pg_temp.district_fixture('N1', 'live');
perform pg_temp.district_fixture('S1', 'soft_deleted');
-- The run: N1's notice (N1's billing row locked), then the sweep, held at S1.
perform pg_temp.hold_run('L1', 'S1');
perform pg_temp.on('a', 'begin');
perform pg_temp.send('a', format($s$select public.admin_set_student_district (%L, %L, 'p5 lock order')::text$s$,
    pg_temp.student('S1'), pg_temp.d('N1')));
perform pg_temp.release('L1', 'commit');
end $d$;

select pg_temp.note('L1a the run was held at S1, past N1', pg_temp.got('L1-held') = 'waiting', pg_temp.got('L1-held'));
select pg_temp.note('L1b the correction waited for the run', pg_temp.got('L1-state') = 'waiting',
    pg_temp.got('L1-state'));
select pg_temp.note('L1c the run finished: N1''s notice queued, r1 listed in S1',
    pg_temp.got('L1-run') like '{%' and (pg_temp.got('L1-run')::jsonb ->> 'notice')::int = 1
        and (pg_temp.got('L1-run')::jsonb ->> 'students_late_listed')::int = 1, pg_temp.got('L1-run'));
select pg_temp.note('L1d and so did the correction, after it', pg_temp.got('L1-correction') = '',
    pg_temp.got('L1-correction'));
select pg_temp.chk('L1e r1 is in N1 now, and off S1''s list', $q$
    select (select district_studio_id = pg_temp.d('N1') from public.managed_students where id = pg_temp.student('S1'))
       and not exists (select 1 from public.district_retention_students where managed_student_id = pg_temp.student('S1'))$q$);

-- ===========================================================================
-- L2. The same move as a raw admin-flagged UPDATE
-- ===========================================================================
do $d$
begin
if not (select ok from t_results where name like '0 %') then
    return;
end if;
perform pg_temp.district_fixture('N2', 'live');
perform pg_temp.district_fixture('S2', 'soft_deleted');
-- The run: N2's notice, then the sweep (S1, nothing new), held at S2.
perform pg_temp.hold_run('L2', 'S2');
perform pg_temp.on('a', 'begin');
perform pg_temp.on('a', $s$set local cleffy.district_attribution = 'admin'$s$);
perform pg_temp.send('a', format($s$update public.managed_students set district_studio_id = %L, district_attribution = 'admin'
    where id = %L returning id::text$s$, pg_temp.d('N2'), pg_temp.student('S2')));
perform pg_temp.release('L2', 'rollback');
-- Retried, the run committed.
perform pg_temp.on('a', 'begin');
perform pg_temp.on('a', $s$set local cleffy.district_attribution = 'admin'$s$);
perform pg_temp.send('a', format($s$update public.managed_students
    set district_studio_id = %L, district_attribution = 'admin' where id = %L returning id::text$s$,
    pg_temp.d('N2'), pg_temp.student('S2')));
perform pg_temp.keep('L2-retry', pg_temp.answer('a'));
perform pg_temp.on('a', 'commit');
end $d$;

select pg_temp.note('L2a the run was held at S2, past N2', pg_temp.got('L2-held') = 'waiting', pg_temp.got('L2-held'));
select pg_temp.note('L2b no deadlock: neither the run nor the UPDATE was aborted as a deadlock victim',
    coalesce(pg_temp.got('L2-run'), '') not like '%deadlock%' and coalesce(pg_temp.got('L2-correction'), '') not like '%deadlock%',
    'run: ' || coalesce(left(pg_temp.got('L2-run'), 120), '?') || ' / update: ' || coalesce(pg_temp.got('L2-correction'), '?'));
select pg_temp.note('L2c the UPDATE did not wait on the run: refused at once, district_busy',
    pg_temp.got('L2-state') = 'finished' and pg_temp.got('L2-correction') like 'ERROR:%district_busy%',
    pg_temp.got('L2-state') || ': ' || coalesce(pg_temp.got('L2-correction'), '?'));
select pg_temp.note('L2d the run finished: N2''s notice queued, r2 listed in S2',
    pg_temp.got('L2-run') like '{%' and (pg_temp.got('L2-run')::jsonb ->> 'notice')::int = 1
        and (pg_temp.got('L2-run')::jsonb ->> 'students_late_listed')::int = 1, pg_temp.got('L2-run'));
select pg_temp.note('L2e retried after the run, the UPDATE moved r2 into N2',
    pg_temp.got('L2-retry') = pg_temp.student('S2')::text
        and (select district_studio_id = pg_temp.d('N2') from public.managed_students where id = pg_temp.student('S2')),
    pg_temp.got('L2-retry'));

-- ===========================================================================
-- L3. admin_set_student_district (r3, null) against a run holding S3
-- ===========================================================================
do $d$
begin
if not (select ok from t_results where name like '0 %') then
    return;
end if;
perform pg_temp.district_fixture('S3', 'soft_deleted');
-- The run: the sweep (S1, S2: nothing new), held at S3 with S3's billing row
-- locked.
perform pg_temp.hold_run('L3', 'S3');
perform pg_temp.on('a', 'begin');
perform pg_temp.send('a', format($s$select public.admin_set_student_district (%L, null, 'p5 lock order')::text$s$,
    pg_temp.student('S3')));
perform pg_temp.release('L3', 'commit');
end $d$;

select pg_temp.note('L3a the run was held at S3, S3''s billing row locked', pg_temp.got('L3-held') = 'waiting',
    pg_temp.got('L3-held'));
select pg_temp.note('L3b the move out took S3''s lock too, so it waited for the run', pg_temp.got('L3-state') = 'waiting',
    pg_temp.got('L3-state'));
select pg_temp.note('L3c the run finished (r3 listed in S3), and so did the move out, after it',
    pg_temp.got('L3-run') like '{%' and (pg_temp.got('L3-run')::jsonb ->> 'students_late_listed')::int = 1
        and pg_temp.got('L3-correction') = '',
    pg_temp.got('L3-run') || ' / ' || coalesce(pg_temp.got('L3-correction'), '?'));
select pg_temp.chk('L3d r3 is private now, and off S3''s list', $q$
    select (select district_studio_id is null from public.managed_students where id = pg_temp.student('S3'))
       and not exists (select 1 from public.district_retention_students where managed_student_id = pg_temp.student('S3'))$q$);

-- ===========================================================================
-- Cleanup
-- ===========================================================================
select pg_temp.cleanup();
select pg_temp.chk('Z the proof''s accounts, districts, lists, notices and logs are gone again', $q$
    select r.ok from extensions.dblink('c', $s$select not exists (select 1 from auth.users where email like '%@lock-order.test')
        and not exists (select 1 from public.studios where id::text like 'd5800000-0000-4000-8000-0000000005d_')
        and not exists (select 1 from public.district_retention where studio_id::text like 'd5800000-0000-4000-8000-0000000005d_')
        and not exists (select 1 from public.district_retention_log where studio_id::text like 'd5800000-0000-4000-8000-0000000005d_')
        and not exists (select 1 from public.district_retention_notices where studio_id::text like 'd5800000-0000-4000-8000-0000000005d_')
        and not exists (select 1 from public.district_retention_restores where studio_id::text like 'd5800000-0000-4000-8000-0000000005d_')
        and not exists (select 1 from public.managed_students where username like 'p5lockorder_%')$s$) as r(ok boolean)$q$);
select extensions.dblink_disconnect('a');
select extensions.dblink_disconnect('b');
select extensions.dblink_disconnect('c');
select extensions.dblink_disconnect('h');

\o
select n, name, ok, regexp_replace(detail, '\s+', ' ', 'g') from t_results order by n;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
