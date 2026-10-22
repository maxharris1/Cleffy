-- Concurrency proof for 20261022140500_thumbnail_publish_lock_order.sql (P1
-- follow-up): a removal of several covers and a publish of one of them no
-- longer deadlock.
--
-- A removal of several objects locks each row as it reaches it and takes the
-- score's folder lock in between (thumbnails_keep_published_cover). A publish
-- took its object's row FOR KEY SHARE and then waited for the folder. So: the
-- removal holds cover 0 (kept: it is the published one, but the folder lock
-- was taken to know that) and the folder; the publish of cover 1 holds 1's
-- row and waits for the folder; the removal reaches 1 and waits for the
-- publish. Here the removal's two rows are two statements of one transaction
-- (the interleaving a single DELETE of both makes, made deterministic). With
-- 20261022101000's publish, PostgreSQL aborts one of them with `deadlock
-- detected` after deadlock_timeout (1 s); now the publish waits for the folder
-- holding no row, the removal finishes, and the publish is refused
-- `thumbnail_gone` (its cover was removed) without any deadlock.
--
-- NOT one transaction: the fixtures are committed so the other backends see
-- them, and removed at the end (and at the start, after a run that stopped
-- half way). It needs the dblink extension, created here when missing and
-- dropped again if this proof created it. The other backends connect back
-- over TCP with the LOCAL stack's default password (postgres/postgres): local
-- stacks and CI only, never a hosted project. Same harness as
-- tests/sql/storage_quota_lock_concurrency.sql.
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/thumbnail_publish_lock_order.sql
--
-- Every row should read `t`; the last line is `failures | total`.
\set ON_ERROR_STOP on
create temp table t_results (name text, ok boolean, detail text);
create temp table t_state (k text primary key, v text);
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('5a0e0000-0c0e-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
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
-- The Storage API's real write, on its service path.
create function pg_temp.put(p_bucket text, p_name text, p_size bigint) returns text language sql immutable as $f$
select format('insert into storage.objects (bucket_id, name, owner, metadata) values (%L, %L, %L, %L)'
              ' on conflict (bucket_id, name collate "C") where archived_at is null do update set metadata = excluded.metadata',
              p_bucket, p_name, pg_temp.u(1), json_build_object('size', p_size)::text)
$f$;
-- A delete: the service path's, or (as_owner first) a signed-in owner's, as
-- the Storage API's policy test for a removal makes it. Answers the names it
-- removed.
create function pg_temp.remove(p_bucket text, p_name text) returns text language sql immutable as $f$
select format('with gone as (del' || 'ete from storage.objects where bucket_id = %L and name = %L returning name)'
              ' select coalesce(string_agg(name, '',''), '''') from gone', p_bucket, p_name)
$f$;
create function pg_temp.as_owner(p_conn text) returns void language plpgsql as $f$
begin
    perform pg_temp.run(p_conn, 'set role authenticated');
    perform pg_temp.run(p_conn, format('set "request.jwt.claims" to %L', json_build_object('sub', pg_temp.u(1), 'role', 'authenticated')::text));
end $f$;
create function pg_temp.as_server(p_conn text) returns void language plpgsql as $f$
begin
    perform pg_temp.run(p_conn, 'reset role');
    perform pg_temp.run(p_conn, 'reset "request.jwt.claims"');
end $f$;
create function pg_temp.folder(p_bucket text, p_doc uuid) returns text[] language sql as $f$
select coalesce(array_agg(name order by name), '{}') from storage.objects
where bucket_id = p_bucket and name like p_doc::text || '/%'
$f$;

-- Remove every fixture: before the run (a stopped earlier run) and after.
create function pg_temp.cleanup() returns void language plpgsql as $f$
begin
    perform set_config('storage.allow_delete_query', 'true', true);
    delete from storage.objects where bucket_id in ('scores', 'thumbnails') and name like '5a0e0000-0c0e-4000-8000-%';
    delete from public.documents where owner_id = pg_temp.u(1);
    delete from public.document_storage_cleanup where owner_id = pg_temp.u(1);
    delete from public.thumbnail_storage_cleanup where owner_id = pg_temp.u(1);
    delete from auth.users where id = pg_temp.u(1);
end $f$;
select pg_temp.cleanup();

insert into auth.users (id, email) values (pg_temp.u(1), 'thumbnail-lock-order-1@storage.test');
insert into public.documents (id, owner_id, title, storage_path, content_rev) values
(pg_temp.u(20), pg_temp.u(1), 'E', pg_temp.u(20)::text || '/original.pdf', 5);
create function pg_temp.e(p_file text) returns text language sql immutable as $f$ select pg_temp.u(20)::text || '/' || p_file $f$;

select pg_temp.open('a'), pg_temp.open('b'), pg_temp.open('c');
select pg_temp.run(c, 'set "storage.allow_delete_query" to ''true''') from unnest(array['a', 'b', 'c']) c;

-- E publishes 0; cover 1 is an upload whose publish has not landed (a folder
-- holds two covers at most, 20261022100900).
select pg_temp.run('c', pg_temp.put('thumbnails', pg_temp.e('0.jpg'), 10));
select pg_temp.run('c', format('update public.documents set thumb_rev = 0 where id = %L', pg_temp.u(20)));
select pg_temp.run('c', pg_temp.put('thumbnails', pg_temp.e('1.jpg'), 10));
select pg_temp.as_owner('a'), pg_temp.as_owner('b');

-- ===========================================================================
-- A removal of 0 and 1 (a stale claim's, on one device), and a publish of 1
-- ===========================================================================
-- The removal reaches 0 first: the published cover, so it is kept, but the
-- trigger took the score's folder lock to know that.
select pg_temp.run('a', 'begin');
insert into t_state values ('remove0', pg_temp.ask('a', pg_temp.remove('thumbnails', pg_temp.e('0.jpg'))));
select pg_temp.chk('01 the removal keeps 0, the published cover, holding the score''s folder lock',
    (select v from t_state where k = 'remove0') = '', coalesce(nullif((select v from t_state where k = 'remove0'), ''), '(none)'));
select pg_temp.send('b', format('update public.documents set thumb_rev = 1 where id = %L', pg_temp.u(20)));
select pg_sleep(0.3);
select pg_temp.chk('02 a publish of 1 waits for the folder the removal holds', pg_temp.busy('b'));

-- The removal reaches 1.
insert into t_state values ('t_remove1', clock_timestamp()::text);
select pg_temp.send('a', pg_temp.remove('thumbnails', pg_temp.e('1.jpg')));
insert into t_state values ('remove1', pg_temp.await('a'));
insert into t_state values ('remove1_ms', (select (extract(epoch from clock_timestamp() - (select v::timestamptz from t_state where k = 't_remove1')) * 1000)::int::text));
select pg_temp.chk('03 ... and takes 1 at once: the publish holds no row of it, so there is no deadlock',
    (select v from t_state where k = 'remove1') = pg_temp.e('1.jpg') and (select v::int < 900 from t_state where k = 'remove1_ms'),
    (select v from t_state where k = 'remove1') || ' after ' || (select v from t_state where k = 'remove1_ms') || ' ms');
select pg_temp.chk('04 the publish is still waiting for the folder', pg_temp.busy('b'));
select pg_temp.run('a', 'commit');
insert into t_state values ('publish1', pg_temp.await('b'));
select pg_temp.chk('05 once the removal commits, the publish is refused: its cover is gone (thumbnail_gone), not deadlocked',
    (select v like 'ERROR: %thumbnail_gone%' from t_state where k = 'publish1')
    and (select v not like '%deadlock%' from t_state where k = 'publish1'),
    (select v from t_state where k = 'publish1'));
select pg_temp.chk('06 the published cover is still 0, and only 0 is stored',
    (select thumb_rev = 0 from public.documents where id = pg_temp.u(20))
    and pg_temp.folder('thumbnails', pg_temp.u(20)) = array[pg_temp.e('0.jpg')],
    array_to_string(pg_temp.folder('thumbnails', pg_temp.u(20)), ', '));

-- ===========================================================================
-- The other way round: a publish of 3 under way, then one removal of 0 and 3
-- ===========================================================================
select pg_temp.run('c', pg_temp.put('thumbnails', pg_temp.e('3.jpg'), 10));
select pg_temp.run('b', 'begin');
select pg_temp.run('b', format('update public.documents set thumb_rev = 3 where id = %L', pg_temp.u(20)));
select pg_temp.send('a', format('with gone as (del' || 'ete from storage.objects where bucket_id = %L and name in (%L, %L) returning name)'
                                ' select coalesce(string_agg(name, '','' order by name), '''') from gone',
                                'thumbnails', pg_temp.e('0.jpg'), pg_temp.e('3.jpg')));
select pg_sleep(0.3);
select pg_temp.chk('10 one statement removing 0 and 3 waits for the publish of 3 under way', pg_temp.busy('a'));
select pg_temp.run('b', 'commit');
insert into t_state values ('remove03', pg_temp.await('a'));
select pg_temp.chk('11 ... then removes 0, superseded now, and leaves 3, the published cover; no deadlock',
    (select v from t_state where k = 'remove03') = pg_temp.e('0.jpg')
    and (select thumb_rev = 3 from public.documents where id = pg_temp.u(20))
    and pg_temp.folder('thumbnails', pg_temp.u(20)) = array[pg_temp.e('3.jpg')],
    (select v from t_state where k = 'remove03'));

-- ===========================================================================
-- An object row held by another writer: the publish does not wait for it
-- ===========================================================================
select pg_temp.run('c', pg_temp.put('thumbnails', pg_temp.e('5.jpg'), 10));
select pg_temp.run('c', 'begin');
select pg_temp.ask('c', format('select name from storage.objects where bucket_id = %L and name = %L for update',
                               'thumbnails', pg_temp.e('5.jpg')));
insert into t_state values ('t_publish5', clock_timestamp()::text);
select pg_temp.send('b', format('update public.documents set thumb_rev = 5 where id = %L', pg_temp.u(20)));
insert into t_state values ('publish5', pg_temp.await('b'));
insert into t_state values ('publish5_ms', (select (extract(epoch from clock_timestamp() - (select v::timestamptz from t_state where k = 't_publish5')) * 1000)::int::text));
select pg_temp.run('c', 'rollback');
select pg_temp.chk('12 with its object''s row held, the publish (holding the folder) is refused at once (thumbnail_folder_busy)',
    (select v like 'ERROR: %thumbnail_folder_busy%' from t_state where k = 'publish5')
    and (select v::int < 900 from t_state where k = 'publish5_ms'),
    (select v from t_state where k = 'publish5') || ' after ' || (select v from t_state where k = 'publish5_ms') || ' ms');
select pg_temp.run('b', format('update public.documents set thumb_rev = 5 where id = %L', pg_temp.u(20)));
select pg_temp.chk('13 ... and the retry, with the row free, publishes it',
    (select thumb_rev = 5 from public.documents where id = pg_temp.u(20)));

-- ===========================================================================
-- Done: close the backends, remove the fixtures, and dblink if it was ours
-- ===========================================================================
select extensions.dblink_disconnect('a'), extensions.dblink_disconnect('b'), extensions.dblink_disconnect('c');
select pg_temp.cleanup();
select pg_temp.chk('20 every fixture is gone',
    not exists (select 1 from storage.objects where name like '5a0e0000-0c0e-4000-8000-%')
    and not exists (select 1 from public.documents where owner_id = pg_temp.u(1))
    and not exists (select 1 from public.thumbnail_storage_cleanup where owner_id = pg_temp.u(1))
    and not exists (select 1 from auth.users where id = pg_temp.u(1)));
do $f$ begin
    if (select v from t_state where k = 'dblink_preexisting') = '0' then
        drop extension dblink;
    end if;
end $f$;

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
