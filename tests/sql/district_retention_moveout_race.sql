-- District retention against an admin moving a student out of the district
-- (20261022130400, Codex's REVISE finding 1 on 20261022130300), between real
-- sessions. A student an admin is moving out of a district while the run lists
-- it must not be listed, archived or signed out by the run once the move
-- commits: the run locks each roster row and re-checks the district it names
-- now, before it lists, records was_archived or revokes anything.
--
--   M1 the sweep, while admin_set_student_district (student, null) is open:
--      the move holds the district's lock (its billing row FOR KEY SHARE), so
--      the sweep passes the district over (SKIP LOCKED); once the move
--      commits, the student is untouched, and the next run lists only who is
--      still in the district;
--   M2 the sweep's own re-check: a move out that holds no district lock (the
--      roster trigger off for it, as the late-student proofs write rows past
--      the barrier) is in flight; the sweep waits for the roster row, and
--      once the move commits, skips the student and lists the others;
--   M3 the same against the hard delete's re-list: it skips the student who
--      left, and deletes the district and the student who stayed;
--   M4 the same against the soft delete's own listing.
--
-- In each, the student who left is checked to be untouched: not listed, not
-- archived, access not revoked, still signed in (session and refresh token),
-- and named by no late-listing log.
--
-- Each step that may wait is sent asynchronously, and the proof polls until
-- that session is waiting on a lock or has finished before it moves the other
-- one on (tests/sql/district_retention_late_student_race.sql's harness). The
-- sessions are dblink connections as postgres that COMMIT their own rows
-- (fixed ids, deleted at the start and the end), and the runs are real: so the
-- proof first checks that no other district on the database would be touched
-- by a run now, and runs nothing otherwise. LOCAL STACK only:
--
--     bash scripts/ci/sql-proof.sh "$DATABASE_URL" tests/sql/district_retention_moveout_race.sql
--
-- The dblink sessions log in with the local stack's password; pass
-- -v peer_password=... for any other. The last line is `failures | total`.
--
-- Cast: districts X1..X4 (owners a1..a4; contracts ended 40 days ago). In
-- each, b<k> is the student moved out and c<k> one who stays. X1 and X2 are
-- soft deleted (yesterday) with b and c attributed and not listed; X3 was soft
-- deleted 8 days ago (the hard delete is due), b3 and c3 likewise; X4's notice
-- was sent 20 days ago (the soft delete is due), b4 and c4 attributed.
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
    select ('d5700000-0000-4000-8000-0000000000' || p)::uuid
$f$;
create function pg_temp.roster(p text) returns uuid language sql immutable as $f$
    select ('d5700000-0000-4000-8000-0000000005' || p)::uuid
$f$;
create function pg_temp.district(p text) returns uuid language sql immutable as $f$
    select ('d5700000-0000-4000-8000-0000000005d' || p)::uuid
$f$;
create function pg_temp.session_id(p text) returns uuid language sql immutable as $f$
    select ('d5700000-0000-4000-8000-00000000a5' || p)::uuid
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

-- District X<k>, owner a<k>, b<k> and c<k> attributed to it and signed in,
-- committed. p_stage: 'soft_deleted' (yesterday: the sweep's), 'hard_due'
-- (soft deleted 8 days ago) or 'soft_due' (notice sent 20 days ago).
create function pg_temp.fixture(k text, p_stage text) returns void language plpgsql as $f$
begin
perform pg_temp.on('c', format($s$insert into auth.users (id, aud, role, email, raw_app_meta_data) values
    (%L, 'authenticated', 'authenticated', %L, '{}'),
    (%L, 'authenticated', 'authenticated', %L, '{"user_type":"student"}'),
    (%L, 'authenticated', 'authenticated', %L, '{"user_type":"student"}')$s$,
    pg_temp.x('a' || k), 'a' || k || '@moveout-race.test',
    pg_temp.x('b' || k), 'b' || k || '@moveout-race.test',
    pg_temp.x('c' || k), 'c' || k || '@moveout-race.test'));
perform pg_temp.on('c', format($s$insert into public.studios (id, owner_id, name) values (%L, %L, %L)$s$,
    pg_temp.district(k), pg_temp.x('a' || k), 'P5 moveout race X' || k));
perform pg_temp.on('c', format($s$insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
    values (%L, date_trunc('second', now()) - interval '40 days', 'admin', 'p5 moveout race')$s$, pg_temp.district(k)));
perform pg_temp.on('c', format($s$insert into public.managed_students
    (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at, district_studio_id)
    values (%L, %L, %L, %L, null, 'code', %L, now(), %L), (%L, %L, %L, %L, null, 'code', %L, now(), %L)$s$,
    pg_temp.roster('b' || k), pg_temp.x('a' || k), pg_temp.x('b' || k), 'Leaving ' || k, 'p5moveout_b' || k, pg_temp.district(k),
    pg_temp.roster('c' || k), pg_temp.x('a' || k), pg_temp.x('c' || k), 'Staying ' || k, 'p5moveout_c' || k, pg_temp.district(k)));
perform pg_temp.on('c', format($s$insert into auth.sessions (id, user_id) values (%L, %L), (%L, %L)$s$,
    pg_temp.session_id('b' || k), pg_temp.x('b' || k), pg_temp.session_id('c' || k), pg_temp.x('c' || k)));
perform pg_temp.on('c', format($s$insert into auth.refresh_tokens (token, user_id, session_id) values (%L, %L, %L), (%L, %L, %L)$s$,
    'p5moveout-rt-b' || k, pg_temp.x('b' || k), pg_temp.session_id('b' || k),
    'p5moveout-rt-c' || k, pg_temp.x('c' || k), pg_temp.session_id('c' || k)));
-- The purge's state, as the run leaves it at that stage (the students
-- attributed after the soft delete, so not on the list).
perform pg_temp.on('c', format($s$insert into public.district_retention
    (studio_id, owner_id, contract_ends_at, notice_queued_at, notice_sent_at, soft_deleted_at)
    select b.studio_id, %L, b.contract_ends_at, now() - interval '21 days', now() - interval '20 days',
           case %L when 'soft_deleted' then now() - interval '1 day'
                   when 'hard_due' then now() - interval '8 days' end
    from public.district_billing b where b.studio_id = %L$s$, pg_temp.x('a' || k), p_stage, pg_temp.district(k)));
end $f$;

-- Moves b<k> out of its district in session a, uncommitted, past the roster
-- trigger (off for this one UPDATE): a move that takes no district lock.
create function pg_temp.move_out_unlocked(k text) returns void language plpgsql as $f$
begin
perform pg_temp.on('a', 'begin');
perform pg_temp.on('a', 'alter table public.managed_students disable trigger managed_students_district_attribution');
perform pg_temp.on('a', format('update public.managed_students set district_studio_id = null where id = %L', pg_temp.roster('b' || k)));
perform pg_temp.on('a', 'alter table public.managed_students enable trigger managed_students_district_attribution');
end $f$;

-- One run in session b, while session a's move is open: sent, settled, then
-- a commits, the run's answer is kept, and b commits.
create function pg_temp.race(p_label text) returns void language plpgsql as $f$
begin
perform pg_temp.on('b', 'begin');
perform pg_temp.send('b', 'select public.retention_district_run (now())::text');
perform pg_temp.keep(p_label || '-state', pg_temp.settle('b'));
perform pg_temp.on('a', 'commit');
perform pg_temp.keep(p_label || '-run', pg_temp.answer('b'));
perform pg_temp.on('b', 'commit');
end $f$;

-- Whether b<k> is untouched: not listed anywhere, active, access not revoked,
-- still signed in, its account there, and named by no late-listing log.
create function pg_temp.untouched(k text) returns boolean language sql as $f$
    select not exists (select 1 from public.district_retention_students where managed_student_id = pg_temp.roster('b' || k))
       and (select archived_at is null and access_revoked_at is null
            from public.managed_students where id = pg_temp.roster('b' || k))
       and exists (select 1 from auth.users where id = pg_temp.x('b' || k))
       and exists (select 1 from auth.sessions where user_id = pg_temp.x('b' || k))
       and exists (select 1 from auth.refresh_tokens where user_id = pg_temp.x('b' || k)::text)
       and not exists (select 1 from public.district_retention_log l
                       where l.studio_id = pg_temp.district(k) and l.counts ->> 'event' = 'late_students_listed'
                         and l.counts -> 'students' @> jsonb_build_array(
                                 jsonb_build_object('managed_student_id', pg_temp.roster('b' || k))))
$f$;
-- Whether c<k> is listed for X<k>, archived, its access revoked and signed out.
create function pg_temp.listed_out(k text) returns boolean language sql as $f$
    select exists (select 1 from public.district_retention_students
                   where studio_id = pg_temp.district(k) and managed_student_id = pg_temp.roster('c' || k))
       and (select archived_at is not null and access_revoked_at is not null
            from public.managed_students where id = pg_temp.roster('c' || k))
       and not exists (select 1 from auth.sessions where user_id = pg_temp.x('c' || k))
       and not exists (select 1 from auth.refresh_tokens where user_id = pg_temp.x('c' || k)::text)
$f$;

-- Everything this proof commits, any run's.
create function pg_temp.cleanup() returns void language plpgsql as $f$
begin
perform pg_temp.on('c', $s$delete from public.district_retention_log where studio_id::text like 'd5700000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.district_retention_notices where studio_id::text like 'd5700000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.district_retention_students where studio_id::text like 'd5700000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.district_retention_restores where studio_id::text like 'd5700000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.district_retention where studio_id::text like 'd5700000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.studios where id::text like 'd5700000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.district_billing_log where studio_id::text like 'd5700000-0000-4000-8000-0000000005d_'$s$);
perform pg_temp.on('c', $s$delete from public.managed_students where username like 'p5moveout_%'$s$);
perform pg_temp.on('c', $s$delete from auth.refresh_tokens where token like 'p5moveout-rt-%'$s$);
perform pg_temp.on('c', $s$delete from auth.sessions where id::text like 'd5700000-0000-4000-8000-00000000a5%'$s$);
perform pg_temp.on('c', $s$delete from auth.users where email like '%@moveout-race.test'$s$);
end $f$;
select pg_temp.cleanup();

select pg_temp.chk('0 no other district would be touched by a run now (the runs are real)', $q$
    select not exists (select 1 from public.retention_district_candidates (now() + interval '1 hour'))
       and not exists (select 1 from public.district_retention where hard_deleted_at is null)$q$);

-- ===========================================================================
-- M1. admin_set_student_district (b1, null) open; the sweep runs
-- ===========================================================================
do $d$
begin
if not (select ok from t_results where name like '0 %') then
    perform pg_temp.note('M skipped: other districts would be touched on this database', false);
    return;
end if;
perform pg_temp.fixture('1', 'soft_deleted');
perform pg_temp.on('a', 'begin');
perform pg_temp.keep('M1-move', pg_temp.q('a', format($s$public.admin_set_student_district (%L, null, 'p5 moveout race')$s$,
    pg_temp.roster('b1'))));
perform pg_temp.race('M1');
-- The next run, the move committed.
perform pg_temp.keep('M1-next', pg_temp.q('c', 'public.retention_district_run (now())'));
end $d$;

select pg_temp.note('M1a the sweep run while the move was open finished (while it was open: '
        || coalesce(pg_temp.got('M1-state'), '?') || ')',
    pg_temp.got('M1-run') like '{%', pg_temp.got('M1-run'));
select pg_temp.chk('M1b once the move committed, b1 is out of X1 and untouched: not listed, not archived, not revoked, signed in', $q$
    select pg_temp.got('M1-move') = ''
       and (select district_studio_id is null from public.managed_students where id = pg_temp.roster('b1'))
       and pg_temp.untouched('1')$q$);
select pg_temp.chk('M1c the next run listed, archived and signed out c1, who stayed, and still not b1', $q$
    select (pg_temp.got('M1-next')::jsonb ->> 'students_late_listed')::int = 1
       and pg_temp.listed_out('1') and pg_temp.untouched('1')$q$);

-- ===========================================================================
-- M2. A move out holding no district lock open; the sweep re-checks
-- ===========================================================================
do $d$
begin
if not (select ok from t_results where name like '0 %') then
    return;
end if;
perform pg_temp.fixture('2', 'soft_deleted');
perform pg_temp.move_out_unlocked('2');
perform pg_temp.race('M2');
end $d$;

select pg_temp.note('M2a the sweep waited for the open move', pg_temp.got('M2-state') = 'waiting', pg_temp.got('M2-state'));
select pg_temp.note('M2b and then finished', pg_temp.got('M2-run') like '{%', pg_temp.got('M2-run'));
select pg_temp.chk('M2c b2, who left X2 while the sweep waited, is untouched', $q$select pg_temp.untouched('2')$q$);
select pg_temp.chk('M2d c2, who stayed, was listed, archived and signed out by the same sweep', $q$
    select (pg_temp.got('M2-run')::jsonb ->> 'students_late_listed')::int = 1 and pg_temp.listed_out('2')$q$);

-- ===========================================================================
-- M3. The same against the hard delete's re-list
-- ===========================================================================
do $d$
begin
if not (select ok from t_results where name like '0 %') then
    return;
end if;
perform pg_temp.fixture('3', 'hard_due');
perform pg_temp.move_out_unlocked('3');
perform pg_temp.race('M3');
end $d$;

select pg_temp.note('M3a the hard delete waited for the open move', pg_temp.got('M3-state') = 'waiting', pg_temp.got('M3-state'));
select pg_temp.chk('M3b and then deleted X3, re-listing and deleting c3, who stayed', $q$
    select (pg_temp.got('M3-run')::jsonb ->> 'hard_delete')::int = 1
       and (pg_temp.got('M3-run')::jsonb ->> 'students_late_listed')::int = 1
       and (pg_temp.got('M3-run')::jsonb ->> 'students_deleted')::int = 1
       and not exists (select 1 from public.studios where id = pg_temp.district('3'))
       and not exists (select 1 from auth.users where id = pg_temp.x('c3'))$q$);
select pg_temp.chk('M3c b3, who left X3 while the hard delete waited, is untouched (and was never on the list)', $q$
    select pg_temp.untouched('3')
       and not exists (select 1 from public.district_retention_log l
                       where l.studio_id = pg_temp.district('3')
                         and l.counts::text like '%' || pg_temp.roster('b3')::text || '%')$q$);

-- ===========================================================================
-- M4. The same against the soft delete's own listing
-- ===========================================================================
do $d$
begin
if not (select ok from t_results where name like '0 %') then
    return;
end if;
perform pg_temp.fixture('4', 'soft_due');
perform pg_temp.move_out_unlocked('4');
perform pg_temp.race('M4');
end $d$;

select pg_temp.note('M4a the soft delete waited for the open move', pg_temp.got('M4-state') = 'waiting', pg_temp.got('M4-state'));
select pg_temp.chk('M4b and then soft deleted X4, listing, archiving and signing out c4, who stayed', $q$
    select (pg_temp.got('M4-run')::jsonb ->> 'soft_delete')::int = 1
       and (select soft_deleted_at is not null from public.district_retention where studio_id = pg_temp.district('4'))
       and pg_temp.listed_out('4')$q$);
select pg_temp.chk('M4c b4, who left X4 while the soft delete waited, is untouched', $q$select pg_temp.untouched('4')$q$);

-- ===========================================================================
-- Cleanup
-- ===========================================================================
select pg_temp.cleanup();
select pg_temp.chk('Z the race''s accounts, districts, lists, notices and logs are gone again', $q$
    select r.ok from extensions.dblink('c', $s$select not exists (select 1 from auth.users where email like '%@moveout-race.test')
        and not exists (select 1 from public.studios where id::text like 'd5700000-0000-4000-8000-0000000005d_')
        and not exists (select 1 from public.district_retention where studio_id::text like 'd5700000-0000-4000-8000-0000000005d_')
        and not exists (select 1 from public.district_retention_log where studio_id::text like 'd5700000-0000-4000-8000-0000000005d_')
        and not exists (select 1 from public.district_retention_students where studio_id::text like 'd5700000-0000-4000-8000-0000000005d_')
        and not exists (select 1 from public.district_billing_log where studio_id::text like 'd5700000-0000-4000-8000-0000000005d_')
        and not exists (select 1 from auth.sessions where id::text like 'd5700000-0000-4000-8000-00000000a5%')
        and not exists (select 1 from public.managed_students where username like 'p5moveout_%')$s$) as r(ok boolean)$q$);
select extensions.dblink_disconnect('a');
select extensions.dblink_disconnect('b');
select extensions.dblink_disconnect('c');

\o
select n, name, ok, regexp_replace(detail, '\s+', ' ', 'g') from t_results order by n;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
