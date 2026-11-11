-- District retention against a provision racing it (20261022130300, decision
-- 67), between real sessions: what district_retention_late_student.sql can
-- only model in one.
--
--   R1 a provision in flight when the soft delete reaches its district: the
--      run passes the district over (its billing row's lock, SKIP LOCKED), the
--      provision commits, and the next run soft deletes the district with the
--      student on its list;
--   R2 the soft delete running, then a provision into its district: the
--      provision waits on the district's lock and, once the soft delete
--      commits, is refused (district_deletion_pending);
--   R3 the hard delete running, then a provision into its district: the
--      provision waits and is refused once the district is gone, and nothing
--      attributed to the district outlives it;
--   R4 the student who raced the soft delete is deleted with their district.
--
-- Each step that must wait is sent asynchronously and the proof polls
-- pg_locks until that session is blocked before it moves the other one on
-- (tests/sql/realtime_revocation_race.sql's harness). The sessions are dblink
-- connections as postgres that COMMIT their own rows (fixed ids, deleted at
-- the start and the end), and the runs they make are real: so the proof first
-- checks that no other district on the database would be due at any time it
-- runs them, and runs nothing otherwise. LOCAL STACK only:
--
--     bash scripts/ci/sql-proof.sh "$DATABASE_URL" tests/sql/district_retention_late_student_race.sql
--
-- The dblink sessions log in with the local stack's password; pass
-- -v peer_password=... for any other. The last line is `failures | total`.
--
-- Cast: X1, X2 and X3 are districts (owners a1, a2, a3; contracts ended 17
-- days ago). b1 is provisioned into X1 during R1, b2 into X2 during R2, b3
-- into X3 during R3.
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
    select ('d5600000-0000-4000-8000-0000000000' || p)::uuid
$f$;
create function pg_temp.roster(p text) returns uuid language sql immutable as $f$
    select ('d5600000-0000-4000-8000-0000000005' || p)::uuid
$f$;
create function pg_temp.district(p text) returns uuid language sql immutable as $f$
    select ('d5600000-0000-4000-8000-0000000005d' || p)::uuid
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
create function pg_temp.on(p_conn text, p_sql text) returns text language sql as $f$ select extensions.dblink_exec(p_conn, p_sql) $f$;
create temp table t_pid (conn text primary key, pid int);
insert into t_pid select c, r.pid from unnest(array['a', 'b', 'c']) c,
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
-- Whether backend p_pid is (or within 10 s comes to be) waiting on a lock.
create function pg_temp.blocked(p_pid int) returns boolean language plpgsql as $f$
begin
    for i in 1 .. 200 loop
        if exists (select 1 from pg_locks where pid = p_pid and not granted) then
            return true;
        end if;
        perform pg_sleep(0.05);
    end loop;
    return false;
end $f$;
-- The answer to what p_conn was sent: its one value, or 'ERROR: ' and the message.
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
-- A roster insert as student-provision makes it (the service role), for
-- session p_conn's open transaction.
create function pg_temp.provision_sql(p text, p_owner text, p_district text) returns text language sql as $f$
    select format($s$insert into public.managed_students
        (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at,
         district_studio_id)
        values (%L, %L, %L, %L, null, 'code', %L, now(), %L) returning id::text$s$,
        pg_temp.roster(p), pg_temp.x(p_owner), pg_temp.x(p), 'Race student ' || p, 'p5race_' || p,
        pg_temp.district(p_district))
$f$;
create function pg_temp.as_service(p_conn text) returns text language sql as $f$
    select extensions.dblink_exec(p_conn,
        $s$set local "request.jwt.claims" to '{"role":"service_role"}'; set local role service_role$s$)
$f$;

-- Everything this proof commits, any run's.
create function pg_temp.cleanup() returns void language plpgsql as $f$
begin
perform pg_temp.on('c', $s$delete from public.district_retention_log where studio_id::text like 'd5600000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.district_retention_notices where studio_id::text like 'd5600000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.district_retention_students where studio_id::text like 'd5600000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.district_retention_restores where studio_id::text like 'd5600000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.district_retention where studio_id::text like 'd5600000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.studios where id::text like 'd5600000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.district_billing_log where studio_id::text like 'd5600000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.managed_students where username like 'p5race_%'$s$);
perform pg_temp.on('c', $s$delete from auth.users where email like '%@latestudent-race.test'$s$);
end $f$;
select pg_temp.cleanup();

select pg_temp.chk('0 no other district is due at any time this proof runs the purge (the runs are real)', $q$
    select not exists (select 1 from public.retention_district_candidates (now() + interval '23 days'))
       and not exists (select 1 from public.district_retention where hard_deleted_at is null)$q$);

do $d$
begin
if not (select ok from t_results where name like '0 %') then
    perform pg_temp.note('R skipped: other districts are due on this database', false);
    return;
end if;

-- Fixtures, committed.
perform pg_temp.on('c', format($s$insert into auth.users (id, aud, role, email, raw_app_meta_data) values
    (%L, 'authenticated', 'authenticated', 'a1@latestudent-race.test', '{}'),
    (%L, 'authenticated', 'authenticated', 'a2@latestudent-race.test', '{}'),
    (%L, 'authenticated', 'authenticated', 'a3@latestudent-race.test', '{}'),
    (%L, 'authenticated', 'authenticated', 'b1@latestudent-race.test', '{"user_type":"student"}'),
    (%L, 'authenticated', 'authenticated', 'b2@latestudent-race.test', '{"user_type":"student"}'),
    (%L, 'authenticated', 'authenticated', 'b3@latestudent-race.test', '{"user_type":"student"}')$s$,
    pg_temp.x('a1'), pg_temp.x('a2'), pg_temp.x('a3'), pg_temp.x('b1'), pg_temp.x('b2'), pg_temp.x('b3')));
perform pg_temp.on('c', format($s$insert into public.studios (id, owner_id, name) values
    (%L, %L, 'P5 late race X1'), (%L, %L, 'P5 late race X2'), (%L, %L, 'P5 late race X3')$s$,
    pg_temp.district('1'), pg_temp.x('a1'), pg_temp.district('2'), pg_temp.x('a2'),
    pg_temp.district('3'), pg_temp.x('a3')));
perform pg_temp.on('c', format($s$insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
    select id, now() - interval '17 days', 'admin', 'p5 late race' from public.studios where id in (%L, %L, %L)$s$,
    pg_temp.district('1'), pg_temp.district('2'), pg_temp.district('3')));

-- Notices queued and sent.
perform pg_temp.q('c', 'public.retention_district_run (now())');
perform pg_temp.q('c', $s$(select count(*) from (select public.finish_district_retention_notice (id)
    from public.claim_district_retention_notices (20)) f)$s$);

-- R1 + R2. b1's provision into X1 is in flight; the run (soft delete time)
-- passes X1 over and soft deletes X2 and X3, and stays open; b2's provision
-- into X2 waits on it.
perform pg_temp.on('a', 'begin');
perform pg_temp.as_service('a');
perform pg_temp.keep('R1-provision', pg_temp.r('a', pg_temp.provision_sql('b1', 'a1', '1')));
perform pg_temp.on('b', 'begin');
perform pg_temp.keep('R1-run', pg_temp.q('b', $s$public.retention_district_run (now() + interval '14 days 1 minute')$s$));
perform pg_temp.on('c', 'begin');
perform pg_temp.as_service('c');
perform pg_temp.send('c', pg_temp.provision_sql('b2', 'a2', '2'));
perform pg_temp.note('R2a a provision into X2 waits on the open soft delete', pg_temp.blocked(pg_temp.pid('c')));
perform pg_temp.on('a', 'commit');
perform pg_temp.on('b', 'commit');
perform pg_temp.keep('R2-provision', pg_temp.answer('c'));
perform pg_temp.on('c', 'rollback');

-- The next run: X1 now.
perform pg_temp.keep('R1-next', pg_temp.q('c', $s$public.retention_district_run (now() + interval '15 days 1 minute')$s$));
end $d$;

select pg_temp.chk('R1a the run passed X1 over while b1''s provision held it, and soft deleted X2 and X3', $q$
    select (pg_temp.got('R1-run')::jsonb ->> 'soft_delete')::int = 2
       and pg_temp.got('R1-provision') = pg_temp.roster('b1')::text$q$);
select pg_temp.chk('R1b the next run soft deleted X1 with b1 on its list, archived', $q$
    select (pg_temp.got('R1-next')::jsonb ->> 'soft_delete')::int = 1
       and exists (select 1 from public.district_retention_students
                   where studio_id = pg_temp.district('1') and managed_student_id = pg_temp.roster('b1'))
       and (select archived_at is not null and access_revoked_at is not null
            from public.managed_students where id = pg_temp.roster('b1'))$q$);
select pg_temp.note('R2b once the soft delete committed, the provision into X2 was refused: district_deletion_pending',
    pg_temp.got('R2-provision') like 'ERROR:%district_deletion_pending%', pg_temp.got('R2-provision'));
select pg_temp.chk('R2c and wrote nothing', $q$
    select not exists (select 1 from public.managed_students where id = pg_temp.roster('b2'))$q$);

do $d$
begin
if not (select ok from t_results where name like '0 %') then
    return;
end if;
-- R3. The hard delete of X2 and X3 open; b3's provision into X3 waits on it.
perform pg_temp.on('b', 'begin');
perform pg_temp.keep('R3-run', pg_temp.q('b', $s$public.retention_district_run (now() + interval '21 days 2 minutes')$s$));
perform pg_temp.on('c', 'begin');
perform pg_temp.as_service('c');
perform pg_temp.send('c', pg_temp.provision_sql('b3', 'a3', '3'));
perform pg_temp.note('R3a a provision into X3 waits on the open hard delete', pg_temp.blocked(pg_temp.pid('c')));
perform pg_temp.on('b', 'commit');
perform pg_temp.keep('R3-provision', pg_temp.answer('c'));
perform pg_temp.on('c', 'rollback');

-- R4. X1's hard delete.
perform pg_temp.keep('R4-run', pg_temp.q('c', $s$public.retention_district_run (now() + interval '22 days 2 minutes')$s$));
end $d$;

select pg_temp.chk('R3b the hard delete removed X2 and X3', $q$
    select (pg_temp.got('R3-run')::jsonb ->> 'hard_delete')::int = 2
       and not exists (select 1 from public.studios where id in (pg_temp.district('2'), pg_temp.district('3')))$q$);
select pg_temp.note('R3c once it committed, the provision into X3 was refused: the district is gone (42501)',
    pg_temp.got('R3-provision') like 'ERROR:%the teacher does not own or hold a seat in that district%',
    pg_temp.got('R3-provision'));
select pg_temp.chk('R3d nothing attributed to X2 or X3 outlives them', $q$
    select not exists (select 1 from public.managed_students
                       where district_studio_id in (pg_temp.district('2'), pg_temp.district('3')))$q$);
select pg_temp.chk('R4 b1, who raced X1''s soft delete, is deleted with X1, and nothing attributed to X1 remains', $q$
    select (pg_temp.got('R4-run')::jsonb ->> 'hard_delete')::int = 1
       and (pg_temp.got('R4-run')::jsonb ->> 'students_deleted')::int = 1
       and not exists (select 1 from auth.users where id = pg_temp.x('b1'))
       and not exists (select 1 from public.managed_students where district_studio_id = pg_temp.district('1'))$q$);

-- ===========================================================================
-- Cleanup
-- ===========================================================================
select pg_temp.cleanup();
select pg_temp.chk('Z the race''s accounts, districts, lists, notices and logs are gone again', $q$
    select r.ok from extensions.dblink('c', $s$select not exists (select 1 from auth.users where email like '%@latestudent-race.test')
        and not exists (select 1 from public.studios where id::text like 'd5600000-0000-4000-8000-0000000005d_')
        and not exists (select 1 from public.district_retention where studio_id::text like 'd5600000-0000-4000-8000-0000000005d_')
        and not exists (select 1 from public.district_retention_log where studio_id::text like 'd5600000-0000-4000-8000-0000000005d_')
        and not exists (select 1 from public.district_retention_notices where studio_id::text like 'd5600000-0000-4000-8000-0000000005d_')
        and not exists (select 1 from public.district_billing_log where studio_id::text like 'd5600000-0000-4000-8000-0000000005d_')
        and not exists (select 1 from public.managed_students where username like 'p5race_%')$s$) as r(ok boolean)$q$);
select extensions.dblink_disconnect('a');
select extensions.dblink_disconnect('b');
select extensions.dblink_disconnect('c');

\o
select n, name, ok, regexp_replace(detail, '\s+', ' ', 'g') from t_results order by n;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
