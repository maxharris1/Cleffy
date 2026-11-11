-- Concurrency proof for 20261022101000_storage_quota_lock_and_cover_reuse.sql
-- (Codex round 3 on #69: the MAJOR, MINOR 2's remainder and the new MINOR;
-- decision 57).
--
-- Real concurrent transactions, through dblink: backends of their own, each
-- committing, with this session watching. What it shows:
--
--   1. A delete of X, an upsert of X and another upload, interleaved as in the
--      review (the delete commits while the upsert waits; the other upload
--      then takes the freed space under the owner lock): the upsert waits on
--      X's row, finds it gone, and is charged as a new object -- refused. The
--      owner never ends over the cap. The same with the delete and the other
--      upload in one transaction; and with the delete rolled back, the upsert
--      is still the non-growing replacement it was, allowed at the cap.
--   2. A name reused after a claim: two devices are told to remove the same
--      cover; the first removes it; it is uploaded again and published; the
--      second, late removal leaves it alone. A removal and a publish of the
--      same object, both orders: a removal under way makes the publish wait
--      and then refuses it (`thumbnail_gone`); a publish under way makes the
--      removal wait, which then leaves the now-published cover.
--   3. Opposite lock orders across two scores: a batched claim holds A and
--      waits for B, held by a transaction that published B and now publishes
--      A. That publish is refused at once (`thumbnail_folder_busy`), not
--      after a deadlock, and the claim completes.
--
-- NOT one transaction: the fixtures are committed so the other backends see
-- them, and removed at the end (and at the start, after a run that stopped
-- half way). It needs the dblink extension, created here when missing and
-- dropped again if this proof created it. The other backends connect back
-- over TCP with the LOCAL stack's default password (postgres/postgres):
-- local stacks and CI only, never a hosted project.
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/storage_quota_lock_concurrency.sql
--
-- Every row should read `t`; the last line is `failures | total`.
\set ON_ERROR_STOP on
create temp table t_results (name text, ok boolean, detail text);
create temp table t_state (k text primary key, v text);
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('5a0d0000-0c0d-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
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
    delete from storage.objects where bucket_id in ('scores', 'thumbnails') and name like '5a0d0000-0c0d-4000-8000-%';
    delete from public.documents where owner_id = pg_temp.u(1);
    delete from public.document_storage_cleanup where owner_id = pg_temp.u(1);
    delete from public.thumbnail_storage_cleanup where owner_id = pg_temp.u(1);
    delete from auth.users where id = pg_temp.u(1);
end $f$;
select pg_temp.cleanup();

-- 1 is free: its quota is whatever this stack gives the free tier (L), and
-- it may keep 3 scores. It owns P (the quota cases) and E (the covers); A
-- and B (the lock orders, A < B) replace P later.
insert into t_state values ('limit', public.storage_quota_bytes ('free')::text);
insert into auth.users (id, email) values (pg_temp.u(1), 'storage-quota-lock-1@storage.test');
insert into public.documents (id, owner_id, title, storage_path, content_rev) values
(pg_temp.u(10), pg_temp.u(1), 'P', pg_temp.u(10)::text || '/original.pdf', 5),
(pg_temp.u(20), pg_temp.u(1), 'E', pg_temp.u(20)::text || '/original.pdf', 5);
create function pg_temp.lim() returns bigint language sql as $f$ select v::bigint from t_state where k = 'limit' $f$;
create function pg_temp.p(p_file text) returns text language sql immutable as $f$ select pg_temp.u(10)::text || '/' || p_file $f$;
create function pg_temp.e(p_file text) returns text language sql immutable as $f$ select pg_temp.u(20)::text || '/' || p_file $f$;

select pg_temp.open('a'), pg_temp.open('b'), pg_temp.open('c');
select pg_temp.run(c, 'set "storage.allow_delete_query" to ''true''') from unnest(array['a', 'b', 'c']) c;

-- ===========================================================================
-- 1. A delete of X, an upsert of X, and another upload
-- ===========================================================================
-- 1 is exactly at its quota: X (100) and Y (L - 100).
select pg_temp.run('a', pg_temp.put('scores', pg_temp.p('x.pdf'), 100));
select pg_temp.run('a', pg_temp.put('scores', pg_temp.p('y.pdf'), pg_temp.lim() - 100));
select pg_temp.chk('01 1 is at its quota', public.storage_owner_bytes (pg_temp.u(1)) = pg_temp.lim(),
    public.storage_owner_bytes (pg_temp.u(1))::text || ' of ' || pg_temp.lim()::text);

-- The review's interleaving. a deletes X; b upserts X at the same size (a
-- replacement, were X there); c holds the owner's quota lock (rewriting Y
-- in place, which takes it now) ...
select pg_temp.run('a', 'begin');
select pg_temp.run('a', format('del' || 'ete from storage.objects where bucket_id = %L and name = %L', 'scores', pg_temp.p('x.pdf')));
select pg_temp.send('b', pg_temp.put('scores', pg_temp.p('x.pdf'), 100));
select pg_sleep(0.3);
select pg_temp.chk('02 an upsert of X waits on X''s row while a delete of it is under way', pg_temp.busy('b'));
select pg_temp.run('c', 'begin');
select pg_temp.run('c', pg_temp.put('scores', pg_temp.p('y.pdf'), pg_temp.lim() - 100));
-- ... the delete commits, and the upsert, finding X gone, waits for the lock c holds ...
select pg_temp.run('a', 'commit');
select pg_sleep(0.3);
select pg_temp.chk('03 the delete committed, the upsert waits on the owner''s quota lock', pg_temp.busy('b'));
-- ... c takes the freed space and commits ...
select pg_temp.send('c', pg_temp.put('scores', pg_temp.p('z.pdf'), 100));
insert into t_state values ('other1', pg_temp.await('c'));
select pg_temp.run('c', 'commit');
insert into t_state values ('upsert1', pg_temp.await('b'));
-- ... and the upsert, a new object now, is refused.
select pg_temp.chk('04 ... then is charged as a new object, and refused (storage_quota_exceeded)',
    (select v like 'ERROR: %storage_quota_exceeded%' from t_state where k = 'upsert1'), (select v from t_state where k = 'upsert1'));
select pg_temp.chk('05 the other upload landed; 1 never ends over its quota: Y and Z, exactly L, and no X',
    (select v not like 'ERROR:%' from t_state where k = 'other1')
    and public.storage_owner_bytes (pg_temp.u(1)) = pg_temp.lim()
    and pg_temp.folder('scores', pg_temp.u(10)) = array[pg_temp.p('y.pdf'), pg_temp.p('z.pdf')],
    public.storage_owner_bytes (pg_temp.u(1))::text || '; ' || array_to_string(pg_temp.folder('scores', pg_temp.u(10)), ', '));

-- The delete and the other upload in one transaction: two sessions.
select pg_temp.run('a', 'begin');
select pg_temp.run('a', format('del' || 'ete from storage.objects where bucket_id = %L and name = %L', 'scores', pg_temp.p('z.pdf')));
select pg_temp.send('b', pg_temp.put('scores', pg_temp.p('z.pdf'), 100));
select pg_sleep(0.3);
select pg_temp.chk('06 an upsert of Z waits on Z''s row while a delete of it is under way', pg_temp.busy('b'));
select pg_temp.run('a', pg_temp.put('scores', pg_temp.p('w.pdf'), 100));
select pg_temp.run('a', 'commit');
insert into t_state values ('upsert2', pg_temp.await('b'));
select pg_temp.chk('07 the delete and another upload commit together; the upsert is refused as a new object',
    (select v like 'ERROR: %storage_quota_exceeded%' from t_state where k = 'upsert2'), (select v from t_state where k = 'upsert2'));
select pg_temp.chk('08 ... and 1 is at its quota, not over it',
    public.storage_owner_bytes (pg_temp.u(1)) = pg_temp.lim()
    and pg_temp.folder('scores', pg_temp.u(10)) = array[pg_temp.p('w.pdf'), pg_temp.p('y.pdf')],
    public.storage_owner_bytes (pg_temp.u(1))::text || '; ' || array_to_string(pg_temp.folder('scores', pg_temp.u(10)), ', '));

-- The delete rolled back: the upsert replaces W, no larger, at the cap.
select pg_temp.run('a', 'begin');
select pg_temp.run('a', format('del' || 'ete from storage.objects where bucket_id = %L and name = %L', 'scores', pg_temp.p('w.pdf')));
select pg_temp.send('b', pg_temp.put('scores', pg_temp.p('w.pdf'), 90));
select pg_sleep(0.3);
select pg_temp.chk('09 an upsert of W waits on the delete of W', pg_temp.busy('b'));
select pg_temp.run('a', 'rollback');
insert into t_state values ('upsert3', pg_temp.await('b'));
select pg_temp.chk('10 the delete rolled back: the upsert is the non-growing replacement it was, and lands at the cap',
    (select v not like 'ERROR:%' from t_state where k = 'upsert3')
    and public.storage_owner_bytes (pg_temp.u(1)) = pg_temp.lim() - 10,
    (select v from t_state where k = 'upsert3') || '; ' || public.storage_owner_bytes (pg_temp.u(1))::text);
-- Room for the covers below.
select pg_temp.run('c', format('del' || 'ete from storage.objects where bucket_id = %L and name = %L', 'scores', pg_temp.p('y.pdf')));

-- ===========================================================================
-- 2. A cover's name reused after a claim
-- ===========================================================================
-- E publishes 0, then uploads 1 whose publish never lands.
select pg_temp.run('a', pg_temp.put('thumbnails', pg_temp.e('0.jpg'), 10));
select pg_temp.run('a', format('update public.documents set thumb_rev = 0 where id = %L', pg_temp.u(20)));
select pg_temp.run('a', pg_temp.put('thumbnails', pg_temp.e('1.jpg'), 10));
-- Two devices, each about to write 2, are both told to remove 1.
select pg_temp.as_owner('a'), pg_temp.as_owner('b');
insert into t_state values
('claimA', pg_temp.ask('a', format('select array_to_string(array(select public.claim_superseded_thumbnails (array[%L]::uuid[], 2)), '','')', pg_temp.u(20)))),
('claimB', pg_temp.ask('b', format('select array_to_string(array(select public.claim_superseded_thumbnails (array[%L]::uuid[], 2)), '','')', pg_temp.u(20))));
select pg_temp.chk('20 two devices'' claims both name 1',
    (select v from t_state where k = 'claimA') = pg_temp.e('1.jpg') and (select v from t_state where k = 'claimB') = pg_temp.e('1.jpg'),
    (select string_agg(k || '=' || v, '; ' order by k) from t_state where k in ('claimA', 'claimB')));
insert into t_state values ('removeA', pg_temp.ask('a', pg_temp.remove('thumbnails', pg_temp.e('1.jpg'))));
select pg_temp.chk('21 the first removes 1, and its claim row goes with it',
    (select v from t_state where k = 'removeA') = pg_temp.e('1.jpg')
    and not exists (select 1 from public.thumbnail_storage_cleanup where object_name = pg_temp.e('1.jpg')),
    (select v from t_state where k = 'removeA'));
-- A third device writes 1 again and publishes it.
select pg_temp.run('c', pg_temp.put('thumbnails', pg_temp.e('1.jpg'), 10));
select pg_temp.as_owner('c');
select pg_temp.run('c', format('update public.documents set thumb_rev = 1 where id = %L', pg_temp.u(20)));
select pg_temp.as_server('c');
select pg_temp.chk('22 1 is written again and published',
    (select thumb_rev = 1 from public.documents where id = pg_temp.u(20)) and pg_temp.e('1.jpg') = any (pg_temp.folder('thumbnails', pg_temp.u(20))));
insert into t_state values ('removeB', pg_temp.ask('b', pg_temp.remove('thumbnails', pg_temp.e('1.jpg'))));
select pg_temp.chk('23 the second device''s late removal of 1 removes nothing: 1 is the published cover now',
    (select v from t_state where k = 'removeB') = ''
    and pg_temp.e('1.jpg') = any (pg_temp.folder('thumbnails', pg_temp.u(20)))
    and (select thumb_rev = 1 from public.documents where id = pg_temp.u(20)),
    coalesce((select nullif(v, '') from t_state where k = 'removeB'), '(none)') || '; ' || array_to_string(pg_temp.folder('thumbnails', pg_temp.u(20)), ', '));

-- A removal under way, then a publish of its object. The superseded 0 goes;
-- E uploads 2, and a removal of 2 (a stale claim's) starts.
select pg_temp.run('c', format('del' || 'ete from storage.objects where bucket_id = %L and name = %L', 'thumbnails', pg_temp.e('0.jpg')));
select pg_temp.run('c', pg_temp.put('thumbnails', pg_temp.e('2.jpg'), 10));
select pg_temp.run('a', 'begin');
insert into t_state values ('removeC', pg_temp.ask('a', pg_temp.remove('thumbnails', pg_temp.e('2.jpg'))));
select pg_temp.send('b', format('update public.documents set thumb_rev = 2 where id = %L', pg_temp.u(20)));
select pg_sleep(0.3);
select pg_temp.chk('25 a publish of 2 waits for a removal of 2 under way',
    pg_temp.busy('b') and (select v from t_state where k = 'removeC') = pg_temp.e('2.jpg'), (select v from t_state where k = 'removeC'));
select pg_temp.run('a', 'commit');
insert into t_state values ('pub2', pg_temp.await('b'));
select pg_temp.chk('26 ... and is refused once 2 is gone (thumbnail_gone): the published cover stays 1, still stored',
    (select v like 'ERROR: %thumbnail_gone%' from t_state where k = 'pub2')
    and (select thumb_rev = 1 from public.documents where id = pg_temp.u(20))
    and pg_temp.folder('thumbnails', pg_temp.u(20)) = array[pg_temp.e('1.jpg')],
    (select v from t_state where k = 'pub2'));

-- A publish under way, then a removal of its object.
select pg_temp.run('c', pg_temp.put('thumbnails', pg_temp.e('3.jpg'), 10));
select pg_temp.run('b', 'begin');
select pg_temp.run('b', format('update public.documents set thumb_rev = 3 where id = %L', pg_temp.u(20)));
select pg_temp.send('a', pg_temp.remove('thumbnails', pg_temp.e('3.jpg')));
select pg_sleep(0.3);
select pg_temp.chk('27 a removal of 3 waits for a publish of 3 under way', pg_temp.busy('a'));
select pg_temp.run('b', 'commit');
insert into t_state values ('removeD', pg_temp.await('a'));
select pg_temp.chk('28 ... and then removes nothing: 3 is published and stored',
    (select v from t_state where k = 'removeD') = ''
    and (select thumb_rev = 3 from public.documents where id = pg_temp.u(20))
    and pg_temp.e('3.jpg') = any (pg_temp.folder('thumbnails', pg_temp.u(20))),
    coalesce((select nullif(v, '') from t_state where k = 'removeD'), '(none)'));
insert into t_state values ('removeE', pg_temp.ask('c', pg_temp.remove('thumbnails', pg_temp.e('3.jpg'))));
select pg_temp.chk('29 the service role''s removal (delete-account empties a live score''s folders) still takes the published cover',
    (select v from t_state where k = 'removeE') = pg_temp.e('3.jpg') and pg_temp.folder('thumbnails', pg_temp.u(20)) = array[pg_temp.e('1.jpg')],
    (select v from t_state where k = 'removeE'));

-- ===========================================================================
-- 3. Opposite lock orders across two scores
-- ===========================================================================
-- b publishes B and, in the same transaction, then A (a bulk publish
-- visiting B first); a's batched claim over A and B takes A's lock first.
delete from public.documents where id = pg_temp.u(10);
insert into public.documents (id, owner_id, title, storage_path, content_rev) values
(pg_temp.u(30), pg_temp.u(1), 'A', pg_temp.u(30)::text || '/original.pdf', 5),
(pg_temp.u(31), pg_temp.u(1), 'B', pg_temp.u(31)::text || '/original.pdf', 5);
select pg_temp.run('c', pg_temp.put('thumbnails', pg_temp.u(30)::text || '/0.jpg', 10));
select pg_temp.run('c', pg_temp.put('thumbnails', pg_temp.u(31)::text || '/0.jpg', 10));
select pg_temp.run('b', 'begin');
select pg_temp.run('b', format('update public.documents set thumb_rev = 0 where id = %L', pg_temp.u(31)));
select pg_temp.send('a', format('select array_to_string(array(select public.claim_superseded_thumbnails (array[%L, %L]::uuid[])), '','')',
                                pg_temp.u(31), pg_temp.u(30)));
select pg_sleep(0.3);
select pg_temp.chk('30 a batched claim holds A''s folder lock and waits for B''s, held by a publish of B', pg_temp.busy('a'));
insert into t_state values ('bulkA', (select clock_timestamp()::text));
select pg_temp.send('b', format('update public.documents set thumb_rev = 0 where id = %L', pg_temp.u(30)));
insert into t_state values ('bulkA_result', pg_temp.await('b'));
insert into t_state values ('bulkA_ms', (select (extract(epoch from clock_timestamp() - (select v::timestamptz from t_state where k = 'bulkA')) * 1000)::int::text));
select pg_temp.chk('31 the same transaction publishing A next (out of order) is refused at once (thumbnail_folder_busy), not by a deadlock',
    (select v like 'ERROR: %thumbnail_folder_busy%' from t_state where k = 'bulkA_result')
    and (select v::int < 900 from t_state where k = 'bulkA_ms'),
    (select v from t_state where k = 'bulkA_result') || ' after ' || (select v from t_state where k = 'bulkA_ms') || ' ms');
select pg_temp.run('b', 'rollback');
insert into t_state values ('claimAB', pg_temp.await('a'));
select pg_temp.chk('32 ... and the claim completes once that transaction ends',
    (select v not like 'ERROR:%' from t_state where k = 'claimAB'), (select v from t_state where k = 'claimAB'));
select pg_temp.chk('33 nothing was published by the refused transaction',
    (select count(*) = 2 from public.documents where id in (pg_temp.u(30), pg_temp.u(31)) and thumb_rev is null));

-- In order (A, then B) the same pair only waits: no refusal, no deadlock.
select pg_temp.run('b', 'begin');
select pg_temp.run('b', format('update public.documents set thumb_rev = 0 where id = %L', pg_temp.u(30)));
select pg_temp.send('a', format('select array_to_string(array(select public.claim_superseded_thumbnails (array[%L, %L]::uuid[])), '','')',
                                pg_temp.u(30), pg_temp.u(31)));
select pg_sleep(0.3);
select pg_temp.chk('34 a claim waits for A''s lock while a transaction publishes A', pg_temp.busy('a'));
select pg_temp.run('b', format('update public.documents set thumb_rev = 0 where id = %L', pg_temp.u(31)));
select pg_temp.run('b', 'commit');
insert into t_state values ('claimAB2', pg_temp.await('a'));
select pg_temp.chk('35 ... that transaction publishes B too (in order) and commits; the claim then completes',
    (select v not like 'ERROR:%' from t_state where k = 'claimAB2')
    and (select count(*) = 2 from public.documents where id in (pg_temp.u(30), pg_temp.u(31)) and thumb_rev = 0),
    (select v from t_state where k = 'claimAB2'));

-- ===========================================================================
-- Done: close the backends, remove the fixtures, and dblink if it was ours
-- ===========================================================================
select extensions.dblink_disconnect('a'), extensions.dblink_disconnect('b'), extensions.dblink_disconnect('c');
select pg_temp.cleanup();
select pg_temp.chk('40 every fixture is gone',
    not exists (select 1 from storage.objects where name like '5a0d0000-0c0d-4000-8000-%')
    and not exists (select 1 from public.documents where owner_id = pg_temp.u(1))
    and not exists (select 1 from public.document_storage_cleanup where owner_id = pg_temp.u(1))
    and not exists (select 1 from public.thumbnail_storage_cleanup where owner_id = pg_temp.u(1))
    and not exists (select 1 from auth.users where id = pg_temp.u(1)));
do $f$ begin
    if (select v from t_state where k = 'dblink_preexisting') = '0' then
        drop extension dblink;
    end if;
end $f$;

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
