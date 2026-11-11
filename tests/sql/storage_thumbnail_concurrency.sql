-- Concurrency proof for 20261022100900_storage_cleanup_markers_and_thumbnail_cap.sql
-- (Codex round 2 on #69: MAJOR 3's remainder, MINOR 2, and MAJOR 1's
-- cleanup race; decision 52).
--
-- Real concurrent transactions, through dblink: two or three backends of
-- their own, each committing, with this session watching. What it shows:
--
--   * Three uploads into one empty thumbnail folder at once, each the
--     Storage API's real (service-role) write: the second and third wait on
--     the first's per-score lock, and of them exactly one commits. The folder
--     ends with two objects, never three -- the count is held in committed
--     state, not in a policy test that rolls back.
--   * A cleanup claim and a publish of the same object, both orders: a claim
--     made first refuses the late publish (`thumbnail_claimed`); a publish
--     made first keeps the claim off the new published revision.
--   * Clearing a deleted score's cleanup marker and an upload into its
--     folder, both orders: the marker cleared first refuses the waiting
--     upload (`storage_folder_gone`) rather than letting it land
--     unattributed; the upload committed first keeps the marker.
--
-- NOT one transaction: the fixtures are committed so the other backends see
-- them, and removed at the end (and at the start, after a run that stopped
-- half way). It needs the dblink extension, created here when missing and
-- dropped again if this proof created it. The other backends connect back
-- over TCP with the LOCAL stack's default password (postgres/postgres):
-- local stacks and CI only, never a hosted project.
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/storage_thumbnail_concurrency.sql
--
-- Every row should read `t`; the last line is `failures | total`.
\set ON_ERROR_STOP on
create temp table t_results (name text, ok boolean, detail text);
create temp table t_state (k text primary key, v text);
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('5a0c0000-0c0c-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
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
-- The Storage API's real write, on its service path.
create function pg_temp.put(p_bucket text, p_name text, p_size bigint) returns text language sql immutable as $f$
select format('insert into storage.objects (bucket_id, name, owner, metadata) values (%L, %L, %L, %L)'
              ' on conflict (bucket_id, name collate "C") where archived_at is null do update set metadata = excluded.metadata',
              p_bucket, p_name, pg_temp.u(1), json_build_object('size', p_size)::text)
$f$;
create function pg_temp.as_owner(p_conn text) returns void language plpgsql as $f$
begin
    perform pg_temp.run(p_conn, 'set role authenticated');
    perform pg_temp.run(p_conn, format('set "request.jwt.claims" to %L', json_build_object('sub', pg_temp.u(1), 'role', 'authenticated')::text));
end $f$;
create function pg_temp.folder(p_bucket text, p_doc uuid) returns text[] language sql as $f$
select coalesce(array_agg(name order by name), '{}') from storage.objects
where bucket_id = p_bucket and name like p_doc::text || '/%'
$f$;

-- Remove every fixture: before the run (a stopped earlier run) and after.
create function pg_temp.cleanup() returns void language plpgsql as $f$
begin
    perform set_config('storage.allow_delete_query', 'true', true);
    delete from storage.objects where bucket_id in ('scores', 'thumbnails') and name like '5a0c0000-0c0c-4000-8000-%';
    delete from public.documents where owner_id = pg_temp.u(1);
    delete from public.document_storage_cleanup where owner_id = pg_temp.u(1);
    delete from public.thumbnail_storage_cleanup where owner_id = pg_temp.u(1);
    delete from auth.users where id = pg_temp.u(1);
end $f$;
select pg_temp.cleanup();

-- 1 is free (500 MiB: the quota stays out of the way; 3 scores) and owns E,
-- F and G; H replaces E later.
insert into auth.users (id, email) values (pg_temp.u(1), 'storage-concurrency-1@storage.test');
insert into public.documents (id, owner_id, title, storage_path, content_rev) values
(pg_temp.u(10), pg_temp.u(1), 'E', pg_temp.u(10)::text || '/original.pdf', 5),
(pg_temp.u(11), pg_temp.u(1), 'F', pg_temp.u(11)::text || '/original.pdf', 5),
(pg_temp.u(12), pg_temp.u(1), 'G', pg_temp.u(12)::text || '/original.pdf', 5);

select pg_temp.open('a'), pg_temp.open('b'), pg_temp.open('c');

-- ===========================================================================
-- 1. Three uploads into one thumbnail folder at once
-- ===========================================================================
select pg_temp.run('a', 'begin');
select pg_temp.run('a', pg_temp.put('thumbnails', pg_temp.u(10)::text || '/0.jpg', 10));
select pg_temp.send('b', pg_temp.put('thumbnails', pg_temp.u(10)::text || '/1.jpg', 10));
select pg_temp.send('c', pg_temp.put('thumbnails', pg_temp.u(10)::text || '/2.jpg', 10));
select pg_sleep(0.3);
select pg_temp.chk('01 with the first upload uncommitted, the second and third wait on its per-score lock',
    pg_temp.busy('b') and pg_temp.busy('c'));
select pg_temp.run('a', 'commit');
insert into t_state values ('b1', pg_temp.await('b')), ('c1', pg_temp.await('c'));
select pg_temp.chk('02 of the two that waited, exactly one commits and one is refused (thumbnail_limit)',
    (select count(*) from t_state where k in ('b1', 'c1') and v like 'ERROR: %thumbnail_limit%') = 1
    and (select count(*) from t_state where k in ('b1', 'c1') and v not like 'ERROR:%') = 1,
    (select string_agg(k || '=' || v, '; ' order by k) from t_state where k in ('b1', 'c1')));
select pg_temp.chk('03 the folder holds two objects in committed state, never three',
    cardinality(pg_temp.folder('thumbnails', pg_temp.u(10))) = 2
    and pg_temp.u(10)::text || '/0.jpg' = any (pg_temp.folder('thumbnails', pg_temp.u(10))),
    array_to_string(pg_temp.folder('thumbnails', pg_temp.u(10)), ', '));

-- Two at once into a folder already holding one: the same, one more slot.
delete from public.documents where id = pg_temp.u(10);
insert into public.documents (id, owner_id, title, storage_path, content_rev)
values (pg_temp.u(13), pg_temp.u(1), 'H', pg_temp.u(13)::text || '/original.pdf', 5);
select pg_temp.run('a', pg_temp.put('thumbnails', pg_temp.u(13)::text || '/0.jpg', 10));
select pg_temp.run('a', 'begin');
select pg_temp.run('a', pg_temp.put('thumbnails', pg_temp.u(13)::text || '/1.jpg', 10));
select pg_temp.send('b', pg_temp.put('thumbnails', pg_temp.u(13)::text || '/2.jpg', 10));
select pg_sleep(0.3);
select pg_temp.chk('04 a second writer into a folder of one waits too', pg_temp.busy('b'));
select pg_temp.run('a', 'commit');
insert into t_state values ('b4', pg_temp.await('b'));
select pg_temp.chk('05 ... and is refused once the first commits: two is the limit',
    (select v like 'ERROR: %thumbnail_limit%' from t_state where k = 'b4')
    and cardinality(pg_temp.folder('thumbnails', pg_temp.u(13))) = 2,
    (select v from t_state where k = 'b4'));

-- ===========================================================================
-- 2. A cleanup claim and a publish of the same object
-- ===========================================================================
-- F publishes 0, then uploads 1 whose publish is still to come.
select pg_temp.run('a', pg_temp.put('thumbnails', pg_temp.u(11)::text || '/0.jpg', 10));
select pg_temp.run('a', format('update public.documents set thumb_rev = 0 where id = %L', pg_temp.u(11)));
select pg_temp.run('a', pg_temp.put('thumbnails', pg_temp.u(11)::text || '/1.jpg', 10));

-- Claim first: another device, about to write 2, claims 1 and holds the
-- lock; the publish of 1 waits behind it, and is refused.
select pg_temp.as_owner('a');
select pg_temp.run('a', 'begin');
insert into t_state select 'claim2', s from extensions.dblink('a',
    format('select array_to_string(array(select public.claim_superseded_thumbnails (array[%L]::uuid[], 2)), '','')', pg_temp.u(11))) as t(s text);
select pg_temp.as_owner('b');
select pg_temp.send('b', format('update public.documents set thumb_rev = 1 where id = %L', pg_temp.u(11)));
select pg_sleep(0.3);
select pg_temp.chk('10 the claim takes 1 (the unpublished upload), not the published 0',
    (select v from t_state where k = 'claim2') = pg_temp.u(11)::text || '/1.jpg', (select v from t_state where k = 'claim2'));
select pg_temp.chk('11 the publish of 1 waits on the claim''s per-score lock', pg_temp.busy('b'));
select pg_temp.run('a', 'commit');
insert into t_state values ('pub1', pg_temp.await('b'));
select pg_temp.chk('12 ... and is refused: a claimed object is never published (thumbnail_claimed)',
    (select v like 'ERROR: %thumbnail_claimed%' from t_state where k = 'pub1'), (select v from t_state where k = 'pub1'));
select pg_temp.chk('13 the published revision is still 0, so removing 1 removes no published cover',
    (select thumb_rev = 0 from public.documents where id = pg_temp.u(11)));

-- Publish first: after 1 is removed and re-uploaded as 2, a publish of 2
-- holds the lock; a library sweep's claim waits behind it, and then takes 0
-- (superseded by the publish), never 2.
select pg_temp.run('c', 'set "storage.allow_delete_query" to ''true''');
select pg_temp.run('c', format('delete from storage.objects where bucket_id = %L and name = %L', 'thumbnails', pg_temp.u(11)::text || '/1.jpg'));
select pg_temp.run('c', pg_temp.put('thumbnails', pg_temp.u(11)::text || '/2.jpg', 10));
select pg_temp.run('b', 'begin');
select pg_temp.run('b', format('update public.documents set thumb_rev = 2 where id = %L', pg_temp.u(11)));
select pg_temp.send('a', format('select array_to_string(array(select public.claim_superseded_thumbnails (array[%L]::uuid[])), '','')', pg_temp.u(11)));
select pg_sleep(0.3);
select pg_temp.chk('14 a sweep''s claim waits on the publish''s per-score lock', pg_temp.busy('a'));
select pg_temp.run('b', 'commit');
insert into t_state values ('sweep', pg_temp.await('a'));
select pg_temp.chk('15 ... and then claims 0, not the just-published 2',
    (select v from t_state where k = 'sweep') = pg_temp.u(11)::text || '/0.jpg', (select v from t_state where k = 'sweep'));
select pg_temp.chk('16 2 is published and unclaimed',
    (select thumb_rev = 2 from public.documents where id = pg_temp.u(11))
    and not exists (select 1 from public.thumbnail_storage_cleanup where object_name = pg_temp.u(11)::text || '/2.jpg'));

-- ===========================================================================
-- 3. Clearing a deleted score's marker, and an upload into its folder
-- ===========================================================================
-- G is deleted with nothing stored: its marker waits on an empty folder.
delete from public.documents where id = pg_temp.u(12);

-- The clear first: it holds the owner's quota lock; the upload that found
-- the marker waits on it, and is refused once the marker is gone.
select pg_temp.run('a', 'begin');
insert into t_state select 'finish1', s from extensions.dblink('a',
    format('select public.finish_document_storage_cleanup (%L)::text', pg_temp.u(12))) as t(s text);
select pg_temp.run('b', 'reset role');
select pg_temp.run('b', 'reset "request.jwt.claims"');
select pg_temp.send('b', pg_temp.put('scores', pg_temp.u(12)::text || '/original.pdf', 100));
select pg_sleep(0.3);
select pg_temp.chk('20 the clear finds the folder empty', (select v = 'true' from t_state where k = 'finish1'),
    (select v from t_state where k = 'finish1'));
select pg_temp.chk('21 an upload into the folder waits on the owner''s quota lock', pg_temp.busy('b'));
select pg_temp.run('a', 'commit');
insert into t_state values ('put1', pg_temp.await('b'));
select pg_temp.chk('22 ... and is refused once the marker is gone (storage_folder_gone): nothing lands unattributed',
    (select v like 'ERROR: %storage_folder_gone%' from t_state where k = 'put1')
    and pg_temp.folder('scores', pg_temp.u(12)) = '{}', (select v from t_state where k = 'put1'));

-- The upload first: G is re-created and deleted again (a new marker), an
-- upload into its folder holds the lock; the clear waits, sees the object
-- and keeps the marker.
insert into public.documents (id, owner_id, title, storage_path)
values (pg_temp.u(12), pg_temp.u(1), 'G again', pg_temp.u(12)::text || '/original.pdf');
delete from public.documents where id = pg_temp.u(12);
select pg_temp.run('b', 'begin');
select pg_temp.run('b', pg_temp.put('scores', pg_temp.u(12)::text || '/original.pdf', 100));
select pg_temp.send('a', format('select public.finish_document_storage_cleanup (%L)::text', pg_temp.u(12)));
select pg_sleep(0.3);
select pg_temp.chk('23 a clear waits on the upload''s quota lock', pg_temp.busy('a'));
select pg_temp.run('b', 'commit');
insert into t_state values ('finish2', pg_temp.await('a'));
select pg_temp.chk('24 ... sees the committed object, and keeps the marker: the bytes still count',
    (select v = 'false' from t_state where k = 'finish2')
    and exists (select 1 from public.document_storage_cleanup where document_id = pg_temp.u(12))
    and public.storage_owner_bytes (pg_temp.u(1)) >= 100, (select v from t_state where k = 'finish2'));

-- ===========================================================================
-- Done: close the backends, remove the fixtures, and dblink if it was ours
-- ===========================================================================
select extensions.dblink_disconnect('a'), extensions.dblink_disconnect('b'), extensions.dblink_disconnect('c');
select pg_temp.cleanup();
select pg_temp.chk('30 every fixture is gone',
    not exists (select 1 from storage.objects where name like '5a0c0000-0c0c-4000-8000-%')
    and not exists (select 1 from public.documents where owner_id = pg_temp.u(1))
    and not exists (select 1 from public.document_storage_cleanup where owner_id = pg_temp.u(1))
    and not exists (select 1 from auth.users where id = pg_temp.u(1)));
do $f$ begin
    if (select v from t_state where k = 'dblink_preexisting') = '0' then
        drop extension dblink;
    end if;
end $f$;

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
