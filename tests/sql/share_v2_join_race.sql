-- Behaviour proof for redeem_share_link against the owner's narrowing of a
-- general link (20261113120000_share_v2_links.sql, Codex round 3 on #107):
-- a join in flight and an owner's Restricted, revoke, editor-to-viewer, reset
-- or score deletion, in both orders, between real sessions.
--
--   J1-J4 the join first, held mid-way by a third session holding the
--         student's roster row, then Restricted (J1), revoke (J2), the link
--         turned viewer (J3) and Reset link (J4): the owner waits for the
--         join, then withdraws it (J1, J2), demotes it (J3) or moves it onto
--         the new link (J4);
--   O1-O3 the owner first, still open, then the join: it waits, and once the
--         owner commits it is refused (O1 Restricted, O2 revoke) or granted
--         viewer (O3);
--   D1    the join first, held the same way, then the score deleted: the
--         deletion waits for the join, no deadlock.
--
-- Each step that must wait is sent asynchronously and the proof polls
-- pg_locks until that session is blocked. The sessions are dblink connections
-- as postgres that COMMIT their own rows (random ids per run), deleted again
-- at the start and the end. Run it against the LOCAL stack only:
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/share_v2_join_race.sql
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
create function pg_temp.note(p_name text, p_ok boolean, p_detail text default null) returns void language sql as $f$
    insert into t_results values (p_name, coalesce(p_ok, false), p_detail)
$f$;

select set_config('race.run', substr(md5(random()::text || clock_timestamp()::text), 1, 8), false);
create function pg_temp.x(n int) returns uuid language sql stable as $f$
    select (current_setting('race.run') || '-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$f$;
create function pg_temp.s(n int) returns uuid language sql stable as $f$ select pg_temp.x(100 + n) $f$;

create extension if not exists dblink with schema extensions;
select set_config('race.peer_password', :'peer_password', false);
create function pg_temp.peer() returns text language sql as $f$
    select format('host=%s port=%s dbname=%s user=postgres password=%s',
        host(inet_server_addr()), inet_server_port(), current_database(), current_setting('race.peer_password'))
$f$;
select extensions.dblink_connect('a', pg_temp.peer());
select extensions.dblink_connect('b', pg_temp.peer());
select extensions.dblink_connect('c', pg_temp.peer());
create function pg_temp.on(p_conn text, p_sql text) returns text language sql as $f$ select extensions.dblink_exec(p_conn, p_sql) $f$;
create temp table t_pid (conn text primary key, pid int);
insert into t_pid select c, r.pid from unnest(array['a', 'b', 'c']) c,
    lateral extensions.dblink(c, 'select pg_backend_pid()') as r(pid int);
create function pg_temp.pid(p_conn text) returns int language sql as $f$ select pid from t_pid where conn = p_conn $f$;
create function pg_temp.as_user(p_conn text, n int) returns text language sql as $f$
    select extensions.dblink_exec(p_conn, format(
        $s$set local "request.jwt.claims" to %L; set local role authenticated$s$,
        json_build_object('sub', pg_temp.x(n), 'role', 'authenticated', 'iat', floor(extract(epoch from now())) - 60)::text))
$f$;
create function pg_temp.q(p_conn text, p_expr text) returns text language sql as $f$
    select r.v from extensions.dblink(p_conn, 'select (' || p_expr || ')::text') as r(v text)
$f$;
create function pg_temp.send(p_conn text, p_sql text) returns int language sql as $f$ select extensions.dblink_send_query(p_conn, p_sql) $f$;
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
create function pg_temp.member(p_doc uuid, n int) returns text language sql as $f$
    select coalesce((select role from public.document_members where document_id = p_doc and user_id = pg_temp.x(n)), 'none')
$f$;
create function pg_temp.token(p_doc uuid) returns text language sql as $f$
    select token from public.share_links where document_id = p_doc and general and revoked_at is null
$f$;
create function pg_temp.redeem_sql(p_doc uuid) returns text language sql as $f$
    select format('select r.granted_role from public.redeem_share_link(%L) r', pg_temp.token(p_doc))
$f$;

create function pg_temp.cleanup() returns void language plpgsql as $f$
begin
perform pg_temp.on('a', $s$delete from public.documents where title like 'Join race %'$s$);
perform pg_temp.on('a', $s$delete from public.managed_students where username like 'joinrace_%'$s$);
perform pg_temp.on('a', $s$delete from auth.users where email like '%@join-race.test'$s$);
perform pg_temp.on('a', $s$delete from public.document_storage_cleanup
    where document_id::text ~ '^[0-9a-f]{8}-0000-4000-8000-0000000001[0-9]{2}$'$s$);
perform pg_temp.on('a', $s$delete from realtime.messages
    where topic ~ '^doc(-db|-view)?:[0-9a-f]{8}-0000-4000-8000-0000000001[0-9]{2}(:[0-9]+)?$'$s$);
end $f$;
select pg_temp.cleanup();

--   users:  1, 3 and 4 owners (three scores each at most: the free plan's
--           cap); 2 teacher 1's roster student, who joins every score.
--   scores: 1 J1, 2 J2, 3 J3 (owner 1); 4 J4, 5 O1, 6 O2 (owner 3);
--           7 O3, 8 D1 (owner 4). Each has a general editor link.
select pg_temp.on('a', format($s$insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data, is_anonymous)
    select (%L || '-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'join-' || n || '@join-race.test',
           case when n = 2 then '{"user_type":"student"}'::jsonb else '{}'::jsonb end, '{}', false
    from generate_series(1, 4) n$s$, current_setting('race.run')));
select pg_temp.on('a', format($s$insert into public.documents (id, owner_id, title, storage_path)
    select d.id, (%1$L || '-0000-4000-8000-' || lpad((case when n <= 3 then 1 when n <= 6 then 3 else 4 end)::text, 12, '0'))::uuid,
           'Join race ' || n, d.id::text || '/original.pdf'
    from generate_series(1, 8) n, lateral (select (%1$L || '-0000-4000-8000-' || lpad((100 + n)::text, 12, '0'))::uuid as id) d$s$,
    current_setting('race.run')));
select pg_temp.on('a', format($s$insert into public.managed_students
    (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at)
    values (%L, %L, %L, 'Two', null, 'code', %L, now())$s$,
    pg_temp.x(202), pg_temp.x(1), pg_temp.x(2), 'joinrace_' || current_setting('race.run') || '_2'));
do $d$
begin
for n in 1 .. 8 loop
    perform pg_temp.on('a', 'begin');
    perform pg_temp.as_user('a', case when n <= 3 then 1 when n <= 6 then 3 else 4 end);
    perform pg_temp.q('a', format($s$(select count(*) from public.set_general_access(%L, 'anyone', 'editor'))$s$, pg_temp.s(n)));
    perform pg_temp.on('a', 'commit');
end loop;
end $d$;
select pg_temp.note('00 every score has a committed general editor link',
    (select count(*) = 8 from public.share_links l where l.document_id in (select pg_temp.s(n) from generate_series(1, 8) n)
        and l.general and l.revoked_at is null and l.role = 'editor'));

-- ===========================================================================
-- J. The join first, held on the student's roster row, then the owner
-- ===========================================================================
-- Session c holds the roster row; b's join (student 2) starts and waits on
-- it; a runs the owner's step p_owner_sql as owner p_owner and must wait;
-- then c lets go, the join commits, and the owner's step finishes.
create function pg_temp.join_first(p_case text, p_doc uuid, p_owner int, p_owner_sql text) returns void language plpgsql as $f$
declare v_waited boolean;
begin
perform pg_temp.on('c', 'begin');
perform pg_temp.q('c', format('(select id from public.managed_students where student_user_id = %L for update)', pg_temp.x(2)));
perform pg_temp.on('b', 'begin');
perform pg_temp.as_user('b', 2);
perform pg_temp.send('b', pg_temp.redeem_sql(p_doc));
perform pg_temp.note(p_case || 'a the join is under way, waiting on the roster row', pg_temp.blocked(pg_temp.pid('b')));
perform pg_temp.on('a', 'begin');
if p_owner is null then
    perform pg_temp.on('a', 'set local role postgres');
else
    perform pg_temp.as_user('a', p_owner);
end if;
perform pg_temp.send('a', p_owner_sql);
v_waited := pg_temp.blocked(pg_temp.pid('a'));
perform pg_temp.note(p_case || 'b the owner''s change waits for the join in flight', v_waited);
if not v_waited then
    perform pg_temp.keep(p_case || '-owner', pg_temp.answer('a'));
    perform pg_temp.keep(p_case || '-owner-commit', extensions.dblink_exec('a', 'commit', false) || ' ' || extensions.dblink_error_message('a'));
end if;
perform pg_temp.on('c', 'commit');
perform pg_temp.keep(p_case || '-join', pg_temp.answer('b'));
perform pg_temp.keep(p_case || '-join-commit', extensions.dblink_exec('b', 'commit', false) || ' ' || extensions.dblink_error_message('b'));
if v_waited then
    perform pg_temp.keep(p_case || '-owner', pg_temp.answer('a'));
    perform pg_temp.keep(p_case || '-owner-commit', extensions.dblink_exec('a', 'commit', false) || ' ' || extensions.dblink_error_message('a'));
end if;
perform pg_temp.note(p_case || 'c the join was granted editor and committed',
    pg_temp.got(p_case || '-join') = 'editor' and pg_temp.got(p_case || '-join-commit') like 'COMMIT%',
    pg_temp.got(p_case || '-join') || ' / ' || pg_temp.got(p_case || '-join-commit'));
perform pg_temp.note(p_case || 'd the owner''s change went through after it, no deadlock',
    pg_temp.got(p_case || '-owner') not like 'ERROR:%' and pg_temp.got(p_case || '-owner-commit') like 'COMMIT%',
    pg_temp.got(p_case || '-owner') || ' / ' || pg_temp.got(p_case || '-owner-commit'));
end $f$;

select pg_temp.join_first('J1', pg_temp.s(1), 1,
    format($s$select count(*)::text from public.set_general_access(%L, 'restricted')$s$, pg_temp.s(1)));
select pg_temp.note('J1e Restricted withdrew the join: no membership, no redemption, no live link',
    pg_temp.member(pg_temp.s(1), 2) = 'none'
    and not exists (select 1 from public.share_link_redemptions where document_id = pg_temp.s(1))
    and pg_temp.token(pg_temp.s(1)) is null,
    pg_temp.member(pg_temp.s(1), 2));

select pg_temp.join_first('J2', pg_temp.s(2), 1,
    format($s$select public.revoke_share_link(%L)::text$s$, pg_temp.token(pg_temp.s(2))));
select pg_temp.note('J2e the revoke withdrew the join it waited for (1 member)',
    pg_temp.member(pg_temp.s(2), 2) = 'none' and pg_temp.got('J2-owner') = '1',
    pg_temp.member(pg_temp.s(2), 2) || ' / ' || pg_temp.got('J2-owner'));

select pg_temp.join_first('J3', pg_temp.s(3), 1,
    format($s$select count(*)::text from public.set_general_access(%L, 'anyone', 'viewer')$s$, pg_temp.s(3)));
select pg_temp.note('J3e the link turned viewer demoted the join to viewer',
    pg_temp.member(pg_temp.s(3), 2) = 'viewer', pg_temp.member(pg_temp.s(3), 2));

select pg_temp.join_first('J4', pg_temp.s(4), 3,
    format($s$select count(*)::text from public.reset_general_link(%L)$s$, pg_temp.s(4)));
select pg_temp.note('J4e Reset link kept the join as editor, recorded against the new link',
    pg_temp.member(pg_temp.s(4), 2) = 'editor'
    and (select r.token from public.share_link_redemptions r where r.document_id = pg_temp.s(4) and r.user_id = pg_temp.x(2))
        is not distinct from pg_temp.token(pg_temp.s(4)),
    pg_temp.member(pg_temp.s(4), 2));

-- ===========================================================================
-- O. The owner first, still open, then the join
-- ===========================================================================
create function pg_temp.owner_first(p_case text, p_doc uuid, p_owner int, p_owner_sql text) returns void language plpgsql as $f$
declare v_join text := pg_temp.redeem_sql(p_doc);
begin
perform pg_temp.on('a', 'begin');
perform pg_temp.as_user('a', p_owner);
perform pg_temp.keep(p_case || '-owner', pg_temp.q('a', p_owner_sql));
perform pg_temp.on('b', 'begin');
perform pg_temp.as_user('b', 2);
perform pg_temp.send('b', v_join);
perform pg_temp.note(p_case || 'a the join waits for the owner''s open change', pg_temp.blocked(pg_temp.pid('b')));
perform pg_temp.on('a', 'commit');
perform pg_temp.keep(p_case || '-join', pg_temp.answer('b'));
perform pg_temp.on('b', 'commit');
end $f$;

select pg_temp.owner_first('O1', pg_temp.s(5), 3,
    format($s$(select count(*) from public.set_general_access(%L, 'restricted'))$s$, pg_temp.s(5)));
select pg_temp.note('O1b once Restricted commits, the join is refused and nothing is granted',
    pg_temp.got('O1-join') like 'ERROR: %invalid or expired share link%' and pg_temp.member(pg_temp.s(5), 2) = 'none',
    pg_temp.got('O1-join'));

select pg_temp.owner_first('O2', pg_temp.s(6), 3,
    format($s$public.revoke_share_link(%L)$s$, pg_temp.token(pg_temp.s(6))));
select pg_temp.note('O2b once the revoke commits, the join is refused and nothing is granted',
    pg_temp.got('O2-join') like 'ERROR: %invalid or expired share link%' and pg_temp.member(pg_temp.s(6), 2) = 'none',
    pg_temp.got('O2-join'));

select pg_temp.owner_first('O3', pg_temp.s(7), 4,
    format($s$(select count(*) from public.set_general_access(%L, 'anyone', 'viewer'))$s$, pg_temp.s(7)));
select pg_temp.note('O3b once the link turns viewer, the join is granted viewer only',
    pg_temp.got('O3-join') = 'viewer' and pg_temp.member(pg_temp.s(7), 2) = 'viewer',
    pg_temp.got('O3-join'));

-- ===========================================================================
-- D1. The join first, then the score deleted
-- ===========================================================================
select pg_temp.join_first('D1', pg_temp.s(8), null,
    format($s$with d as (delete from public.documents where id = %L returning 1) select count(*)::text from d$s$, pg_temp.s(8)));
select pg_temp.note('D1e the score and its link are gone',
    not exists (select 1 from public.documents where id = pg_temp.s(8))
    and not exists (select 1 from public.share_links where document_id = pg_temp.s(8))
    and pg_temp.got('D1-owner') = '1',
    pg_temp.got('D1-owner'));

-- ===========================================================================
-- Cleanup
-- ===========================================================================
select pg_temp.cleanup();
select pg_temp.note('Z the race''s accounts and scores are gone again',
    (select r.ok from extensions.dblink('c', format($s$select not exists (select 1 from auth.users where email like '%%@join-race.test')
        and not exists (select 1 from public.documents where title like 'Join race %%')$s$)) as r(ok boolean)));
select extensions.dblink_disconnect('a');
select extensions.dblink_disconnect('b');
select extensions.dblink_disconnect('c');

\o
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
