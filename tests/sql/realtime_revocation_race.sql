-- Behaviour proof for 20261022120100_realtime_revocation_races.sql (Codex
-- round 1 on #71): the races a single-transaction proof cannot show, each
-- between two (or three) real sessions.
--
--   R1 an archive, then an assignment of the same student: the assignment
--      waits on the roster row and is refused once the archive commits;
--   R2 an assignment, then an archive: the archive waits, and its rotation
--      moves the score the assignment just granted;
--   R3 a reset (end_student_sessions), then an assignment: it waits and goes
--      through, and the student's token from before the reset is refused it;
--   R4 an assignment, then a reset: the reset waits, and moves that score;
--   R5 an archive, then the student redeeming a share link: the redemption
--      waits, and the archived student is refused the score;
--   R6 the district soft delete, in one run, against an assignment that
--      locked first (the run waits, then moves that score) and one that came
--      after (it waits, then is refused);
--   D1 a member removed, then the score deleted: no deadlock (before, the
--      removal's commit-time rotation waited on the score the deletion held
--      while the deletion waited on the removed membership);
--   D2 the same with an editor turned viewer;
--   C1 two removals rotating one score at once: the second tells the
--      generation the first moved it to, not the one both started from;
--   H1 a share redemption, then the district hard delete of the redeeming
--      student (20261022120200): the hard delete waits on the roster row the
--      redemption holds, then deletes the student, no deadlock;
--   H2 the hard delete first, stopped (by a third session holding the
--      student's account row) between its roster lock and the account's
--      deletion, then the student redeems a link to a score they are already
--      on: the redemption waits on the roster row before it touches the
--      membership, so the hard delete's cascade to that membership never
--      waits on it. Before, the redemption locked the membership first, and
--      PostgreSQL aborted one of the two (deadlock).
--
-- Each step that must wait is sent asynchronously and the proof polls
-- pg_locks until that session is blocked before it moves the other one on;
-- "waits" checks say so. The sessions are dblink connections as postgres that
-- COMMIT their own rows (random ids per run: deleted scores leave
-- tombstones), deleted again at the start and the end. Run it against the
-- LOCAL stack only, with Realtime started (today's realtime.messages
-- partition):
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/realtime_revocation_race.sql
--
-- The dblink sessions log in with the local stack's password; pass
-- -v peer_password=... for any other. Every row of the result table should
-- read `t`; the last line is `failures | total`.
\set ON_ERROR_STOP on
\if :{?peer_password}
\else
\set peer_password postgres
\endif
\o /dev/null
begin;
create temp table t_results (name text, ok boolean, detail text);
create temp table t_out (label text primary key, answer text);
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
create function pg_temp.note(p_name text, p_ok boolean, p_detail text default null) returns void language sql as $f$
    insert into t_results values (p_name, coalesce(p_ok, false), p_detail)
$f$;

-- This run's ids: users, scores, studios.
select set_config('race.run', substr(md5(random()::text || clock_timestamp()::text), 1, 8), false);
create function pg_temp.x(n int) returns uuid language sql stable as $f$
    select (current_setting('race.run') || '-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
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
-- Each session's backend, read while it is idle (a busy one takes no query).
create temp table t_pid (conn text primary key, pid int);
insert into t_pid select c, r.pid from unnest(array['a', 'b', 'c']) c,
    lateral extensions.dblink(c, 'select pg_backend_pid()') as r(pid int);
create function pg_temp.pid(p_conn text) returns int language sql as $f$ select pid from t_pid where conn = p_conn $f$;
-- In session p_conn, inside its open transaction: act as user n, with a token
-- issued a minute ago (p_fresh: one issued now, after any revocation so far).
create function pg_temp.as_user(p_conn text, n int, p_fresh boolean default false) returns text language sql as $f$
    select extensions.dblink_exec(p_conn, format(
        $s$set local "request.jwt.claims" to %L; set local role authenticated$s$,
        json_build_object('sub', pg_temp.x(n), 'role', 'authenticated',
            'iat', case when p_fresh then ceil(extract(epoch from clock_timestamp())) + 1
                        else floor(extract(epoch from now())) - 60 end)::text))
$f$;
create function pg_temp.as_service(p_conn text) returns text language sql as $f$
    select extensions.dblink_exec(p_conn,
        $s$set local "request.jwt.claims" to '{"role":"service_role"}'; set local role service_role$s$)
$f$;
-- The value of expression p_expr in session p_conn, waiting for it.
create function pg_temp.q(p_conn text, p_expr text) returns text language sql as $f$
    select r.v from extensions.dblink(p_conn, 'select (' || p_expr || ')::text') as r(v text)
$f$;
-- Sends p_sql (one statement, one text column or a command) without waiting.
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
-- The answer to what p_conn was sent: its one value, a command's status, or
-- 'ERROR: ' and the message.
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

-- Realtime, as tests/sql/realtime_revocation_rotation.sql asks it, in THIS
-- session (rolled back at the end): may user n join the topic?
create function pg_temp.claims(n int, p_fresh boolean default false) returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.x(n), 'role', 'authenticated',
    'iat', case when p_fresh then ceil(extract(epoch from clock_timestamp())) + 1 else floor(extract(epoch from now())) - 60 end)::text, true);
perform set_config('role', 'authenticated', true);
end $f$;
create function pg_temp.as_postgres() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', '', true);
perform set_config('role', 'none', true);
end $f$;
create function pg_temp.can_join(p_topic text) returns boolean language plpgsql as $f$
declare v boolean; v_role text := current_setting('role');
begin
    perform set_config('role', 'postgres', true);
    insert into realtime.messages (topic, extension, event, payload, private) values (p_topic, 'broadcast', 'probe', '{}', true);
    perform set_config('role', v_role, true);
    perform set_config('realtime.topic', p_topic, true);
    execute 'select count(*) > 0 from realtime.messages where topic = $1' into v using p_topic;
    perform set_config('realtime.topic', '', true);
    return v;
end $f$;
create function pg_temp.live(p_doc uuid, p_epoch int) returns text language sql immutable as $f$
    select 'doc:' || p_doc::text || case when p_epoch = 0 then '' else ':' || p_epoch::text end
$f$;
create function pg_temp.db(p_doc uuid, p_epoch int) returns text language sql immutable as $f$
    select 'doc-db:' || p_doc::text || case when p_epoch = 0 then '' else ':' || p_epoch::text end
$f$;
-- User n's view of score p_doc: the generation they are told (null: none),
-- and whether they may join both topics of generation p_epoch.
create function pg_temp.sees(n int, p_doc uuid, p_epoch int, p_fresh boolean default false) returns text language plpgsql as $f$
declare v_told int; v_joins boolean;
begin
    perform pg_temp.claims(n, p_fresh);
    v_told := public.realtime_topic_epoch (p_doc);
    v_joins := pg_temp.can_join(pg_temp.live(p_doc, p_epoch)) and pg_temp.can_join(pg_temp.db(p_doc, p_epoch));
    perform pg_temp.as_postgres();
    return coalesce(v_told::text, 'none') || '/' || case when v_joins then 'joins' else 'refused' end;
end $f$;
create function pg_temp.epoch(p_doc uuid) returns int language sql as $f$
    select coalesce((select e.epoch from public.document_realtime_epochs e where e.document_id = p_doc), 0)
$f$;
-- topic_rotated hints sent on generation p_epoch's two topics.
create function pg_temp.told(p_doc uuid, p_epoch int) returns bigint language sql as $f$
    select count(*) from realtime.messages
    where event = 'topic_rotated' and topic in (pg_temp.live(p_doc, p_epoch), pg_temp.db(p_doc, p_epoch))
$f$;
create function pg_temp.member(p_doc uuid, n int) returns text language sql as $f$
    select coalesce((select role from public.document_members where document_id = p_doc and user_id = pg_temp.x(n)), 'none')
$f$;

-- Leftovers of an earlier run that stopped half way, then this run's
-- fixtures, all committed by session a. A hard-deleted district's studio is
-- gone, so its retention rows are found by their owner too.
create function pg_temp.cleanup() returns void language plpgsql as $f$
begin
perform pg_temp.on('a', $s$delete from public.documents where title like 'P4 race %'$s$);
perform pg_temp.on('a', $s$delete from public.district_retention_log where studio_id in (select r.studio_id from public.district_retention r
    join auth.users u on u.id = r.owner_id where u.email like '%@revocation-race.test')$s$);
perform pg_temp.on('a', $s$delete from public.district_retention_students where studio_id in (select r.studio_id from public.district_retention r
    join auth.users u on u.id = r.owner_id where u.email like '%@revocation-race.test')$s$);
perform pg_temp.on('a', $s$delete from public.district_retention r using auth.users u
    where u.id = r.owner_id and u.email like '%@revocation-race.test'$s$);
perform pg_temp.on('a', $s$delete from public.district_retention_students where studio_id in (select id from public.studios where name like 'P4 race %')$s$);
perform pg_temp.on('a', $s$delete from public.district_retention_log where studio_id in (select id from public.studios where name like 'P4 race %')$s$);
perform pg_temp.on('a', $s$delete from public.district_retention where studio_id in (select id from public.studios where name like 'P4 race %')$s$);
perform pg_temp.on('a', $s$delete from public.district_billing where studio_id in (select id from public.studios where name like 'P4 race %')$s$);
perform pg_temp.on('a', $s$delete from public.studios where name like 'P4 race %'$s$);
perform pg_temp.on('a', $s$delete from public.managed_students where username like 'p4race_%'$s$);
perform pg_temp.on('a', $s$delete from auth.users where email like '%@revocation-race.test'$s$);
-- What the deletions above leave behind them, any run's (this proof's scores
-- are {run}-0000-4000-8000-0000000001NN, its studios ...-0000000003NN): the
-- storage cleanup queue of each deleted score, the billing log of each
-- district, and, last, the hints they broadcast (membership changes).
perform pg_temp.on('a', $s$delete from public.document_storage_cleanup
    where document_id::text ~ '^[0-9a-f]{8}-0000-4000-8000-0000000001[0-9]{2}$'$s$);
perform pg_temp.on('a', $s$delete from public.district_billing_log
    where studio_id::text ~ '^[0-9a-f]{8}-0000-4000-8000-0000000003[0-9]{2}$'$s$);
perform pg_temp.on('a', $s$delete from realtime.messages
    where topic ~ '^doc(-db)?:[0-9a-f]{8}-0000-4000-8000-0000000001[0-9]{2}(:[0-9]+)?$'$s$);
end $f$;
select pg_temp.cleanup();

--   users:  1 and 10 teachers; 2 (R1, R2), 3 (R3), 4 (R5) teacher 1's roster
--           students, 6 (R4) teacher 10's; 5 and 11 district students of
--           districts 1 and 2, whose owners are 7 and 13; 12 a third teacher;
--           8 and 14 collaborators; 16 and 18 district students of districts
--           3 and 4 (H1, H2), whose owners are 15 and 17.
--   scores: 1-3 teacher 1's (R1, R2, R3); 4-6 teacher 10's (R4, R5, D1);
--           7 and 8 teacher 12's (D2, C1); 9 owner 7's, 10 owner 13's (R6);
--           11 owner 15's (H1), 12 owner 17's (H2).
--   (Three each: the free plan's cap.)
select pg_temp.on('a', format($s$insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data, is_anonymous)
    select (%L || '-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'race-' || n || '@revocation-race.test',
           case when n in (2, 3, 4, 5, 6, 11, 16, 18) then '{"user_type":"student"}'::jsonb else '{}'::jsonb end, '{}', false
    from generate_series(1, 18) n$s$, current_setting('race.run')));
select pg_temp.on('a', format($s$insert into public.documents (id, owner_id, title, storage_path)
    select d.id, (%1$L || '-0000-4000-8000-' || lpad((case when n <= 3 then 1 when n <= 6 then 10 when n <= 8 then 12 when n = 9 then 7
                                                          when n = 10 then 13 when n = 11 then 15 else 17 end)::text, 12, '0'))::uuid,
           'P4 race ' || n, d.id::text || '/original.pdf'
    from generate_series(1, 12) n, lateral (select (%1$L || '-0000-4000-8000-' || lpad((100 + n)::text, 12, '0'))::uuid as id) d$s$, current_setting('race.run')));
create function pg_temp.s(n int) returns uuid language sql stable as $f$ select pg_temp.x(100 + n) $f$;
select pg_temp.on('a', format($s$insert into public.managed_students
    (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at)
    values (%L, %L, %L, 'Two', null, 'code', %L, now()), (%L, %L, %L, 'Three', null, 'code', %L, now()),
           (%L, %L, %L, 'Four', null, 'code', %L, now()), (%L, %L, %L, 'Five', null, 'code', %L, now()),
           (%L, %L, %L, 'Six', null, 'code', %L, now()), (%L, %L, %L, 'Eleven', null, 'code', %L, now())$s$,
    pg_temp.x(202), pg_temp.x(1), pg_temp.x(2), 'p4race_' || current_setting('race.run') || '_2',
    pg_temp.x(203), pg_temp.x(1), pg_temp.x(3), 'p4race_' || current_setting('race.run') || '_3',
    pg_temp.x(204), pg_temp.x(1), pg_temp.x(4), 'p4race_' || current_setting('race.run') || '_4',
    pg_temp.x(205), pg_temp.x(7), pg_temp.x(5), 'p4race_' || current_setting('race.run') || '_5',
    pg_temp.x(206), pg_temp.x(10), pg_temp.x(6), 'p4race_' || current_setting('race.run') || '_6',
    pg_temp.x(211), pg_temp.x(13), pg_temp.x(11), 'p4race_' || current_setting('race.run') || '_11'));
select pg_temp.on('a', format($s$insert into public.document_members (document_id, user_id, role) values
    (%L, %L, 'editor'), (%L, %L, 'editor'), (%L, %L, 'editor'), (%L, %L, 'viewer')$s$,
    pg_temp.s(6), pg_temp.x(8), pg_temp.s(7), pg_temp.x(8), pg_temp.s(8), pg_temp.x(8), pg_temp.s(8), pg_temp.x(14)));
select pg_temp.on('a', format($s$insert into public.share_links (token, document_id, role, created_by) values (%L, %L, 'viewer', %L)$s$,
    'p4race' || current_setting('race.run'), pg_temp.s(5), pg_temp.x(10)));
-- Two districts whose contracts ended 40 and 39 days ago, notice sent 20 days
-- ago: the next run soft-deletes both, the earlier contract first.
select pg_temp.on('a', format($s$insert into public.studios (id, owner_id, name) values (%L, %L, 'P4 race D1'), (%L, %L, 'P4 race D2')$s$,
    pg_temp.x(301), pg_temp.x(7), pg_temp.x(302), pg_temp.x(13)));
select pg_temp.on('a', format($s$insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
    values (%L, date_trunc('second', now()) - interval '40 days', 'admin', 'test'), (%L, date_trunc('second', now()) - interval '39 days', 'admin', 'test')$s$,
    pg_temp.x(301), pg_temp.x(302)));
-- A district's students are the roster rows attributed to it (20261021120800),
-- set here the way admin_set_student_district does.
select pg_temp.on('a', format($s$begin; set local cleffy.district_attribution = 'admin';
    update public.managed_students set district_studio_id = %L where id = %L;
    update public.managed_students set district_studio_id = %L where id = %L; commit$s$,
    pg_temp.x(301), pg_temp.x(205), pg_temp.x(302), pg_temp.x(211)));
select pg_temp.on('a', format($s$insert into public.district_retention (studio_id, owner_id, contract_ends_at, notice_queued_at, notice_sent_at)
    select b.studio_id, s.owner_id, b.contract_ends_at, now() - interval '21 days', now() - interval '20 days'
    from public.district_billing b join public.studios s on s.id = b.studio_id where b.studio_id in (%L, %L)$s$,
    pg_temp.x(301), pg_temp.x(302)));

select pg_temp.chk('00 realtime is running (today''s realtime.messages partition exists)', $q$select exists (select 1 from pg_class where relnamespace = 'realtime'::regnamespace and relname = 'messages_' || to_char(now(), 'YYYY_MM_DD'))$q$);
select pg_temp.chk('00b the fixtures are committed (a third session sees them)', $q$select r.n = 12 from extensions.dblink('c', format('select count(*) from public.documents where title like %L', 'P4 race %')) as r(n bigint)$q$);

-- ===========================================================================
-- R1. Archive first, then an assignment
-- ===========================================================================
select pg_temp.on('a', 'begin');
select pg_temp.as_service('a');
select pg_temp.on('a', format('update public.managed_students set archived_at = now() where id = %L', pg_temp.x(202)));
select pg_temp.on('b', 'begin');
select pg_temp.as_user('b', 1);
select pg_temp.send('b', format('select public.assign_score(%L, %L)::text', pg_temp.s(1), pg_temp.x(2)));
select pg_temp.note('R1a the assignment waits on the student''s roster row while the archive is open', pg_temp.blocked(pg_temp.pid('b')));
select pg_temp.on('a', 'commit');
select pg_temp.keep('R1', pg_temp.answer('b'));
select pg_temp.on('b', 'rollback');
select pg_temp.chk('R1b once the archive commits, the assignment is refused (not on your roster)', $q$select pg_temp.got('R1') like 'ERROR: %not on your roster%'$q$);
select pg_temp.chk('R1c and nothing was granted', $q$select pg_temp.member(pg_temp.s(1), 2) = 'none' and not exists (select 1 from public.assignments where document_id = pg_temp.s(1))$q$);

-- ===========================================================================
-- R2. An assignment first, then the archive
-- ===========================================================================
select pg_temp.on('a', format('update public.managed_students set archived_at = null where id = %L', pg_temp.x(202)));
select pg_temp.on('b', 'begin');
select pg_temp.as_user('b', 1);
select pg_temp.q('b', format('public.assign_score(%L, %L)', pg_temp.s(2), pg_temp.x(2)));
select pg_temp.on('a', 'begin');
select pg_temp.as_service('a');
select pg_temp.send('a', format('update public.managed_students set archived_at = now() where id = %L', pg_temp.x(202)));
select pg_temp.note('R2a the archive waits on the open assignment', pg_temp.blocked(pg_temp.pid('a')));
select pg_temp.on('b', 'commit');
select pg_temp.keep('R2', pg_temp.answer('a'));
select pg_temp.on('a', 'commit');
select pg_temp.chk('R2b the archive went through after it', $q$select pg_temp.got('R2') = 'UPDATE 1'$q$);
select pg_temp.chk('R2c its rotation moved the score the assignment granted, telling generation 0', $q$select pg_temp.epoch(pg_temp.s(2)) = 1 and pg_temp.told(pg_temp.s(2), 0) = 2$q$);
select pg_temp.chk('R2d the archived student is told no generation and joins neither', $q$select pg_temp.sees(2, pg_temp.s(2), 1) = 'none/refused' and pg_temp.sees(2, pg_temp.s(2), 0) = 'none/refused'$q$);
select pg_temp.chk('R2e the teacher joins generation 1', $q$select pg_temp.sees(1, pg_temp.s(2), 1) = '1/joins'$q$);

-- ===========================================================================
-- R3. A reset (end_student_sessions) first, then an assignment
-- ===========================================================================
select pg_temp.on('a', 'begin');
select pg_temp.as_service('a');
select pg_temp.q('a', format('public.end_student_sessions(%L)', pg_temp.x(3)));
select pg_temp.on('b', 'begin');
select pg_temp.as_user('b', 1);
select pg_temp.send('b', format('select public.assign_score(%L, %L)::text', pg_temp.s(3), pg_temp.x(3)));
select pg_temp.note('R3a the assignment waits on the reset', pg_temp.blocked(pg_temp.pid('b')));
select pg_temp.on('a', 'commit');
select pg_temp.keep('R3', pg_temp.answer('b'));
select pg_temp.on('b', 'commit');
select pg_temp.chk('R3b a reset is not an archive: the assignment goes through after it', $q$select pg_temp.got('R3') !~ '^ERROR' and pg_temp.member(pg_temp.s(3), 3) = 'editor'$q$);
select pg_temp.chk('R3c the student''s token from before the reset is told no generation and joins nothing', $q$select pg_temp.sees(3, pg_temp.s(3), 0) = 'none/refused'$q$);
select pg_temp.chk('R3d signed in again, the student joins it', $q$select pg_temp.sees(3, pg_temp.s(3), 0, true) = '0/joins'$q$);

-- ===========================================================================
-- R4. An assignment first, then a reset
-- ===========================================================================
select pg_temp.on('b', 'begin');
select pg_temp.as_user('b', 10);
select pg_temp.q('b', format('public.assign_score(%L, %L)', pg_temp.s(4), pg_temp.x(6)));
select pg_temp.on('a', 'begin');
select pg_temp.as_service('a');
select pg_temp.send('a', format('select public.end_student_sessions(%L)::text', pg_temp.x(6)));
select pg_temp.note('R4a the reset waits on the open assignment', pg_temp.blocked(pg_temp.pid('a')));
select pg_temp.on('b', 'commit');
select pg_temp.keep('R4', pg_temp.answer('a'));
select pg_temp.on('a', 'commit');
select pg_temp.chk('R4b the reset went through after it', $q$select pg_temp.got('R4') !~ '^ERROR'$q$);
select pg_temp.chk('R4c its rotation moved the score the assignment granted, telling generation 0', $q$select pg_temp.epoch(pg_temp.s(4)) = 1 and pg_temp.told(pg_temp.s(4), 0) = 2$q$);
select pg_temp.chk('R4d the student''s token from before the reset joins neither generation', $q$select pg_temp.sees(6, pg_temp.s(4), 1) = 'none/refused' and pg_temp.sees(6, pg_temp.s(4), 0) = 'none/refused'$q$);
select pg_temp.chk('R4e the score''s owner joins generation 1', $q$select pg_temp.sees(10, pg_temp.s(4), 1) = '1/joins'$q$);

-- ===========================================================================
-- R5. Archive first, then the student redeems a share link
-- ===========================================================================
select pg_temp.on('a', 'begin');
select pg_temp.as_service('a');
select pg_temp.on('a', format('update public.managed_students set archived_at = now() where id = %L', pg_temp.x(204)));
select pg_temp.on('b', 'begin');
select pg_temp.as_user('b', 4);
select pg_temp.send('b', format('select r.granted_role from public.redeem_share_link(%L) r', 'p4race' || current_setting('race.run')));
select pg_temp.note('R5a the redemption waits on the student''s roster row while the archive is open', pg_temp.blocked(pg_temp.pid('b')));
select pg_temp.on('a', 'commit');
select pg_temp.keep('R5', pg_temp.answer('b'));
select pg_temp.on('b', 'commit');
select pg_temp.chk('R5b the archived student is refused the score whatever the redemption wrote, old token or new', $q$select pg_temp.sees(4, pg_temp.s(5), 0) = 'none/refused' and pg_temp.sees(4, pg_temp.s(5), 0, true) = 'none/refused'$q$);
select pg_temp.chk('R5c (the link''s owner is unaffected)', $q$select pg_temp.sees(10, pg_temp.s(5), 0) = '0/joins'$q$);

-- ===========================================================================
-- R6. The district soft delete, between two assignments
-- ===========================================================================
select pg_temp.chk('R6- only this proof''s two districts are due (anything else would be soft-deleted for real)', $q$select array_agg(c.studio_id order by c.contract_ends_at) = array[pg_temp.x(301), pg_temp.x(302)]
   from public.retention_district_candidates (now()) c$q$);
do $d$
begin
if not (select ok from t_results where name like 'R6- only%') then
    perform pg_temp.note('R6 skipped: other districts are due on this database', false);
    return;
end if;
-- District 2's student assigned first, and held open.
perform pg_temp.on('b', 'begin');
perform pg_temp.as_user('b', 13);
perform pg_temp.q('b', format('public.assign_score(%L, %L)', pg_temp.s(10), pg_temp.x(11)));
-- The run: district 1 (student 5) first, then district 2, where it waits.
perform pg_temp.on('a', 'begin');
perform pg_temp.send('a', 'select public.retention_district_run(now())::text');
perform pg_temp.note('R6a the soft delete waits on the assignment district 2''s student is in', pg_temp.blocked(pg_temp.pid('a')));
-- District 1's student assigned now: waits on the run.
perform pg_temp.on('c', 'begin');
perform pg_temp.as_user('c', 7);
perform pg_temp.send('c', format('select public.assign_score(%L, %L)::text', pg_temp.s(9), pg_temp.x(5)));
perform pg_temp.note('R6b a later assignment of district 1''s student waits on the open soft delete', pg_temp.blocked(pg_temp.pid('c')));
perform pg_temp.on('b', 'commit');
perform pg_temp.keep('R6-run', pg_temp.answer('a'));
perform pg_temp.on('a', 'commit');
perform pg_temp.keep('R6-late', pg_temp.answer('c'));
perform pg_temp.on('c', 'rollback');
end $d$;
select pg_temp.chk('R6c the run soft-deleted both districts', $q$select (pg_temp.got('R6-run')::jsonb ->> 'soft_delete')::int = 2
   and (select bool_and(archived_at is not null and access_revoked_at is not null) from public.managed_students where id in (pg_temp.x(205), pg_temp.x(211)))$q$);
select pg_temp.chk('R6d the score assigned before it was moved, telling generation 0', $q$select pg_temp.epoch(pg_temp.s(10)) = 1 and pg_temp.told(pg_temp.s(10), 0) = 2$q$);
select pg_temp.chk('R6e its student joins neither generation; its owner joins generation 1', $q$select pg_temp.sees(11, pg_temp.s(10), 1) = 'none/refused' and pg_temp.sees(11, pg_temp.s(10), 0) = 'none/refused' and pg_temp.sees(13, pg_temp.s(10), 1) = '1/joins'$q$);
select pg_temp.chk('R6f the assignment after it was refused, and granted nothing', $q$select pg_temp.got('R6-late') like 'ERROR: %not on your roster%' and pg_temp.member(pg_temp.s(9), 5) = 'none' and pg_temp.epoch(pg_temp.s(9)) = 0$q$);

-- ===========================================================================
-- D1. A member removed, then the score deleted
-- ===========================================================================
select pg_temp.on('a', 'begin');
select pg_temp.as_user('a', 10);
select pg_temp.q('a', format('public.remove_document_member(%L, %L)', pg_temp.s(6), pg_temp.x(8)));
select pg_temp.on('b', 'begin');
select pg_temp.send('b', format('delete from public.documents where id = %L', pg_temp.s(6)));
select pg_temp.note('D1a the deletion waits on the removed membership', pg_temp.blocked(pg_temp.pid('b')));
select pg_temp.keep('D1-remove', extensions.dblink_exec('a', 'commit', false) || ' ' || extensions.dblink_error_message('a'));
select pg_temp.keep('D1-delete', pg_temp.answer('b'));
select pg_temp.keep('D1-delete-commit', extensions.dblink_exec('b', 'commit', false) || ' ' || extensions.dblink_error_message('b'));
select pg_temp.chk('D1b the removal commits (its rotation never waits on the score)', $q$select pg_temp.got('D1-remove') like 'COMMIT%' and pg_temp.got('D1-remove') !~* 'deadlock'$q$);
select pg_temp.chk('D1c the deletion goes through after it, no deadlock', $q$select pg_temp.got('D1-delete') = 'DELETE 1' and pg_temp.got('D1-delete-commit') like 'COMMIT%'$q$);
select pg_temp.chk('D1d nothing is left of the score, its generation included', $q$select not exists (select 1 from public.documents where id = pg_temp.s(6)) and not exists (select 1 from public.document_realtime_epochs where document_id = pg_temp.s(6))$q$);

-- ===========================================================================
-- D2. An editor turned viewer, then the score deleted
-- ===========================================================================
select pg_temp.on('a', 'begin');
select pg_temp.as_user('a', 12);
select pg_temp.q('a', format($s$public.set_document_member_role(%L, %L, 'viewer')$s$, pg_temp.s(7), pg_temp.x(8)));
select pg_temp.on('b', 'begin');
select pg_temp.send('b', format('delete from public.documents where id = %L', pg_temp.s(7)));
select pg_temp.note('D2a the deletion waits on the demoted membership', pg_temp.blocked(pg_temp.pid('b')));
select pg_temp.keep('D2-demote', extensions.dblink_exec('a', 'commit', false) || ' ' || extensions.dblink_error_message('a'));
select pg_temp.keep('D2-delete', pg_temp.answer('b'));
select pg_temp.keep('D2-delete-commit', extensions.dblink_exec('b', 'commit', false) || ' ' || extensions.dblink_error_message('b'));
select pg_temp.chk('D2b the demotion commits and the deletion goes through after it, no deadlock', $q$select pg_temp.got('D2-demote') like 'COMMIT%' and pg_temp.got('D2-delete') = 'DELETE 1' and pg_temp.got('D2-delete-commit') like 'COMMIT%'$q$);
select pg_temp.chk('D2c nothing is left of the score, its generation included', $q$select not exists (select 1 from public.documents where id = pg_temp.s(7)) and not exists (select 1 from public.document_realtime_epochs where document_id = pg_temp.s(7))$q$);

-- ===========================================================================
-- C1. Two removals rotate one score at once
-- ===========================================================================
select pg_temp.on('a', 'begin');
select pg_temp.as_user('a', 12);
select pg_temp.q('a', format('public.remove_document_member(%L, %L)', pg_temp.s(8), pg_temp.x(8)));
-- What COMMIT runs first: a's rotation, holding generation 1 uncommitted.
select pg_temp.on('a', 'set constraints public.document_realtime_rotation_queue_rotate immediate');
select pg_temp.on('b', 'begin');
select pg_temp.as_user('b', 12);
select pg_temp.q('b', format('public.remove_document_member(%L, %L)', pg_temp.s(8), pg_temp.x(14)));
select pg_temp.send('b', 'commit');
select pg_temp.note('C1a the second removal''s commit-time rotation waits on the first''s generation', pg_temp.blocked(pg_temp.pid('b')));
select pg_temp.on('a', 'commit');
select pg_temp.keep('C1', pg_temp.answer('b'));
select pg_temp.chk('C1b both commit, and the score is at generation 2', $q$select pg_temp.got('C1') = 'COMMIT' and pg_temp.epoch(pg_temp.s(8)) = 2$q$);
select pg_temp.chk('C1c the first told generation 0 and the second generation 1 (two hints each), never 0 twice', $q$select pg_temp.told(pg_temp.s(8), 0) = 2 and pg_temp.told(pg_temp.s(8), 1) = 2 and pg_temp.told(pg_temp.s(8), 2) = 0$q$);
select pg_temp.chk('C1d the owner joins generation 2; the removed members join nothing', $q$select pg_temp.sees(12, pg_temp.s(8), 2) = '2/joins' and pg_temp.sees(8, pg_temp.s(8), 2) = 'none/refused' and pg_temp.sees(14, pg_temp.s(8), 2) = 'none/refused'$q$);

-- ===========================================================================
-- H1/H2. A share redemption and the district hard delete (20261022120200)
-- ===========================================================================
-- District p_n's student (roster row x(200 + p_student), account x(p_student),
-- owner x(p_owner), studio x(300 + p_n)): soft-deleted eight days ago, so the
-- next run hard-deletes it, the student already a viewer of score p_score
-- through the owner's link (token p4race{run}h{p_n}), which grants editor.
create function pg_temp.hard_delete_due(p_n int, p_owner int, p_student int, p_score int) returns void language plpgsql as $f$
begin
perform pg_temp.on('a', format($s$insert into public.managed_students
    (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at)
    values (%L, %L, %L, 'District', null, 'code', %L, now())$s$,
    pg_temp.x(200 + p_student), pg_temp.x(p_owner), pg_temp.x(p_student), 'p4race_' || current_setting('race.run') || '_' || p_student));
perform pg_temp.on('a', format($s$insert into public.document_members (document_id, user_id, role) values (%L, %L, 'viewer')$s$,
    pg_temp.s(p_score), pg_temp.x(p_student)));
perform pg_temp.on('a', format($s$insert into public.share_links (token, document_id, role, created_by) values (%L, %L, 'editor', %L)$s$,
    'p4race' || current_setting('race.run') || 'h' || p_n, pg_temp.s(p_score), pg_temp.x(p_owner)));
perform pg_temp.on('a', format($s$insert into public.studios (id, owner_id, name) values (%L, %L, %L)$s$,
    pg_temp.x(300 + p_n), pg_temp.x(p_owner), 'P4 race D' || p_n));
perform pg_temp.on('a', format($s$insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
    values (%L, date_trunc('second', now()) - interval '60 days', 'admin', 'test')$s$, pg_temp.x(300 + p_n)));
perform pg_temp.on('a', format($s$begin; set local cleffy.district_attribution = 'admin';
    update public.managed_students set district_studio_id = %L, archived_at = now() - interval '8 days',
        access_revoked_at = now() - interval '8 days' where id = %L; commit$s$,
    pg_temp.x(300 + p_n), pg_temp.x(200 + p_student)));
perform pg_temp.on('a', format($s$insert into public.district_retention (studio_id, owner_id, contract_ends_at, notice_queued_at, notice_sent_at, soft_deleted_at)
    select b.studio_id, %L, b.contract_ends_at, now() - interval '45 days', now() - interval '44 days', now() - interval '8 days'
    from public.district_billing b where b.studio_id = %L$s$, pg_temp.x(p_owner), pg_temp.x(300 + p_n)));
perform pg_temp.on('a', format($s$insert into public.district_retention_students (studio_id, managed_student_id, student_user_id, was_archived)
    values (%L, %L, %L, false)$s$, pg_temp.x(300 + p_n), pg_temp.x(200 + p_student), pg_temp.x(p_student)));
end $f$;
-- Whether this session could take p_id's roster row FOR SHARE right now (a
-- subtransaction, rolled back: nothing stays locked).
create function pg_temp.roster_free(p_id uuid) returns boolean language plpgsql as $f$
begin
    begin
        perform 1 from public.managed_students where id = p_id for share nowait;
        raise exception using errcode = 'P0001', message = 'free';
    exception
        when lock_not_available then return false;
        when raise_exception then return true;
    end;
end $f$;
-- Student n is gone: account, roster row, and every membership.
create function pg_temp.gone(n int) returns boolean language sql as $f$
    select not exists (select 1 from auth.users where id = pg_temp.x(n))
       and not exists (select 1 from public.managed_students where student_user_id = pg_temp.x(n))
       and not exists (select 1 from public.document_members where user_id = pg_temp.x(n))
$f$;

-- H1. The redemption first, then the hard delete.
select pg_temp.hard_delete_due(3, 15, 16, 11);
select pg_temp.chk('H1- only this proof''s district 3 is due (anything else would be hard-deleted for real)', $q$select array_agg(c.studio_id) = array[pg_temp.x(303)] and bool_and(c.next_step = 'hard_delete')
   from public.retention_district_candidates (now()) c$q$);
do $d$
begin
if not (select ok from t_results where name like 'H1- only%') then
    perform pg_temp.note('H1 skipped: other districts are due on this database', false);
    return;
end if;
perform pg_temp.on('a', 'begin');
perform pg_temp.as_user('a', 16);
perform pg_temp.keep('H1-redeem', pg_temp.q('a', format('(select r.granted_role from public.redeem_share_link(%L) r)',
    'p4race' || current_setting('race.run') || 'h3')));
perform pg_temp.on('b', 'begin');
perform pg_temp.send('b', 'select public.retention_district_run(now())::text');
perform pg_temp.note('H1a the hard delete waits on the roster row the open redemption holds', pg_temp.blocked(pg_temp.pid('b')));
perform pg_temp.keep('H1-redeem-commit', extensions.dblink_exec('a', 'commit', false) || ' ' || extensions.dblink_error_message('a'));
perform pg_temp.keep('H1-run', pg_temp.answer('b'));
perform pg_temp.keep('H1-run-commit', extensions.dblink_exec('b', 'commit', false) || ' ' || extensions.dblink_error_message('b'));
end $d$;
select pg_temp.chk('H1b the redemption commits first (the link''s editor role), no deadlock', $q$select pg_temp.got('H1-redeem') = 'editor' and pg_temp.got('H1-redeem-commit') like 'COMMIT%' and pg_temp.got('H1-redeem-commit') !~* 'deadlock'$q$);
select pg_temp.chk('H1c the hard delete goes through after it, no deadlock', $q$select (pg_temp.got('H1-run')::jsonb ->> 'hard_delete')::int = 1 and (pg_temp.got('H1-run')::jsonb ->> 'students_deleted')::int = 1
   and pg_temp.got('H1-run-commit') like 'COMMIT%'$q$);
select pg_temp.chk('H1d nothing is left of the student, the membership the redemption raised included', $q$select pg_temp.gone(16)$q$);

-- H2. The hard delete first, held between its roster lock and the account's
-- deletion; then the redemption.
select pg_temp.hard_delete_due(4, 17, 18, 12);
select pg_temp.chk('H2- only this proof''s district 4 is due', $q$select array_agg(c.studio_id) = array[pg_temp.x(304)] and bool_and(c.next_step = 'hard_delete')
   from public.retention_district_candidates (now()) c$q$);
do $d$
begin
if not (select ok from t_results where name like 'H2- only%') then
    perform pg_temp.note('H2 skipped: other districts are due on this database', false);
    return;
end if;
-- c holds the student's account row: deleting it waits.
perform pg_temp.on('c', 'begin');
perform pg_temp.on('c', format('do $l$ begin perform 1 from auth.users where id = %L for key share; end $l$', pg_temp.x(18)));
perform pg_temp.on('b', 'begin');
perform pg_temp.send('b', 'select public.retention_district_run(now())::text');
perform pg_temp.note('H2a the hard delete waits to delete the student''s account', pg_temp.blocked(pg_temp.pid('b')));
perform pg_temp.note('H2b holding the student''s roster row', not pg_temp.roster_free(pg_temp.x(218)));
perform pg_temp.on('a', 'begin');
perform pg_temp.as_user('a', 18);
perform pg_temp.send('a', format('select r.granted_role from public.redeem_share_link(%L) r', 'p4race' || current_setting('race.run') || 'h4'));
perform pg_temp.note('H2c the redemption waits on the roster row, before it touches the membership', pg_temp.blocked(pg_temp.pid('a')));
perform pg_temp.on('c', 'commit');
perform pg_temp.keep('H2-run', pg_temp.answer('b'));
perform pg_temp.keep('H2-run-commit', extensions.dblink_exec('b', 'commit', false) || ' ' || extensions.dblink_error_message('b'));
perform pg_temp.keep('H2-redeem', pg_temp.answer('a'));
perform pg_temp.on('a', 'rollback');
end $d$;
select pg_temp.chk('H2d the hard delete goes through, no deadlock (its cascade never waits on the redemption)', $q$select (pg_temp.got('H2-run')::jsonb ->> 'hard_delete')::int = 1 and (pg_temp.got('H2-run')::jsonb ->> 'students_deleted')::int = 1
   and pg_temp.got('H2-run-commit') like 'COMMIT%' and pg_temp.got('H2-run-commit') !~* 'deadlock'$q$);
select pg_temp.note('H2e the redemption then fails on the deleted account (no membership for it), not on a deadlock',
    pg_temp.got('H2-redeem') like 'ERROR: %' and pg_temp.got('H2-redeem') !~* 'deadlock', pg_temp.got('H2-redeem'));
select pg_temp.chk('H2f nothing is left of the student', $q$select pg_temp.gone(18)$q$);

-- ===========================================================================
-- Cleanup
-- ===========================================================================
select pg_temp.cleanup();
select pg_temp.chk('Z the race''s accounts, scores, generations, districts, logs and messages are gone again', format($q$select r.ok from extensions.dblink('c', %L) as r(ok boolean)$q$,
    format($s$select not exists (select 1 from auth.users where email like '%%@revocation-race.test')
        and not exists (select 1 from public.documents where title like 'P4 race %%')
        and not exists (select 1 from public.studios where name like 'P4 race %%')
        and not exists (select 1 from public.document_realtime_epochs where document_id::text like %L)
        and not exists (select 1 from realtime.messages where topic like %L)
        and not exists (select 1 from public.document_storage_cleanup where document_id::text like %1$L)
        and not exists (select 1 from public.district_billing_log where studio_id::text like %1$L)$s$,
        current_setting('race.run') || '-%', '%:' || current_setting('race.run') || '-0000-4000-8000-%')));
select extensions.dblink_disconnect('a');
select extensions.dblink_disconnect('b');
select extensions.dblink_disconnect('c');

\o
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
