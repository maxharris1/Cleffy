-- Behaviour proof for 20261022101000_storage_quota_lock_and_cover_reuse.sql
-- (Codex round 3 on #69; decision 57).
--
--   * The quota trigger locks a write's predecessor (FOR UPDATE) before the
--     owner's quota lock and reads it again under that lock before weighing
--     the no-growth exemption; every write, a non-growing one too, takes the
--     owner lock; and a row actually inserted is charged in full after
--     conflict resolution (storage_objects_charge_insert), even with the
--     BEFORE check out of the way.
--   * A signed-in user's removal (the Storage API's policy test for it) never
--     takes a live score's published cover, claim row or not: the cover
--     stays, and the removal reports nothing removed. Other covers, a deleted
--     score's covers, and the service role's removals (delete-account) go.
--     A cover removed and re-uploaded under a claimed name, then published,
--     survives the second (late) removal of that name.
--   * The folder lock is taken in document-id order: a lower id after a
--     higher one is only ever tried, never waited for.
--   * A folder already over the two-object cap is trimmed by the next sweep
--     (all but the published cover and the newest other) and by the next
--     publish.
--
-- The concurrent cases (a delete racing an upsert and another upload, a
-- removal racing a publish, opposite lock orders) are in
-- storage_quota_lock_concurrency.sql.
--
-- Runs in one transaction and ROLLS BACK. psql only (it `\ir`s the
-- migration); it writes storage.objects rows the way the Storage API does,
-- and removes them with storage.allow_delete_query set.
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/storage_quota_lock_and_cover_reuse.sql
--
-- Every row should read `t`; the last line is `failures | total`.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('5a0e0000-0c0e-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
create function pg_temp.allowed(p_name text, p_sql text) returns void language plpgsql as $f$
begin execute p_sql; insert into t_results values (p_name, true, null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
-- Must fail with this SQLSTATE and, when given, this `code` in the error's
-- JSON detail.
create function pg_temp.refused(p_name text, p_sql text, p_state text, p_code text default null) returns void language plpgsql as $f$
declare v_state text; v_message text; v_detail text;
begin
execute p_sql;
insert into t_results values (p_name, false, 'no error raised');
exception when others then
get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail;
insert into t_results values (p_name,
    v_state = p_state and (p_code is null or (nullif(v_detail, '')::jsonb ->> 'code') is not distinct from p_code),
    v_state || ' ' || v_message || coalesce(' ' || nullif(v_detail, ''), ''));
end $f$;
create function pg_temp.as_user(n int) returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(n), 'role', 'authenticated')::text, true);
perform set_config('role', 'authenticated', true);
end $f$;
-- delete-account's removals: a service-key request.
create function pg_temp.as_service() returns void language plpgsql as $f$
begin
perform set_config('role', 'service_role', true);
perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $f$;
create function pg_temp.as_server() returns void language plpgsql as $f$
begin
perform set_config('role', 'postgres', true);
perform set_config('request.jwt.claims', '', true);
end $f$;
-- The Storage API's real write: on its service path, with the size it stored,
-- as the upsert it always is.
create function pg_temp.put(p_bucket text, p_name text, p_size bigint, p_owner int) returns text language sql immutable as $f$
select format('insert into storage.objects (bucket_id, name, owner, metadata) values (%L, %L, %L, %L)'
              ' on conflict (bucket_id, name collate "C") where archived_at is null do update set metadata = excluded.metadata',
              p_bucket, p_name, pg_temp.u(p_owner), json_build_object('size', p_size)::text)
$f$;
-- A removal, as whoever is set: the names it removed.
create function pg_temp.removed(p_name text) returns text[] language plpgsql as $f$
declare v text[];
begin
    with gone as (delete from storage.objects where bucket_id = 'thumbnails' and name = p_name returning name)
    select coalesce(array_agg(name order by name), '{}') into v from gone;
    return v;
end $f$;
create function pg_temp.folder(p_doc uuid) returns text[] language sql as $f$
select coalesce(array_agg(name order by name), '{}') from storage.objects
where bucket_id = 'thumbnails' and name like p_doc::text || '/%'
$f$;
create function pg_temp.ledger(p_doc uuid) returns text[] language sql as $f$
select coalesce(array_agg(object_name order by object_name), '{}') from public.thumbnail_storage_cleanup where document_id = p_doc
$f$;
create function pg_temp.claim(p_docs uuid[], p_rev int default null) returns text[] language sql as $f$
select coalesce(array_agg(n order by n), '{}') from public.claim_superseded_thumbnails (p_docs, p_rev) n
$f$;
create function pg_temp.c(p_doc int, p_file text) returns text language sql immutable as $f$ select pg_temp.u(p_doc)::text || '/' || p_file $f$;
-- Whether this transaction holds an owner's quota lock (an advisory lock on
-- two int4 keys shows as classid, objid, objsubid 2).
create function pg_temp.holds_quota_lock(p_owner uuid) returns boolean language sql as $f$
select exists (
    select 1 from pg_locks l
    where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.objsubid = 2 and l.granted
      and l.classid::bigint = (hashtext('cleffy.storage_quota')::bigint + 4294967296) % 4294967296
      and l.objid::bigint = (hashtext(p_owner::text)::bigint + 4294967296) % 4294967296)
$f$;
create function pg_temp.holds_folder_lock(p_doc uuid) returns boolean language sql as $f$
select exists (
    select 1 from pg_locks l
    where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.objsubid = 2 and l.granted
      and l.classid::bigint = (hashtext('cleffy.thumbnail_folder')::bigint + 4294967296) % 4294967296
      and l.objid::bigint = (hashtext(p_doc::text)::bigint + 4294967296) % 4294967296)
$f$;
create function pg_temp.folder_lock(p_doc uuid) returns boolean language plpgsql as $f$
begin perform public.thumbnail_folder_lock (p_doc); return pg_temp.holds_folder_lock(p_doc); end $f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;
select set_config('storage.allow_delete_query', 'true', true);

delete from public.deployment_config;
insert into public.deployment_config (id, storage_quota_bytes, updated_by)
values (true, '{"free": 1000}', 'proof');

-- 1 and 2 are free (1000 bytes here; 3 scores each); 3 owns nothing.
insert into auth.users (id, email)
select pg_temp.u(n), 'storage-quota-lock-' || n || '@storage.test' from generate_series(1, 3) n;
insert into public.documents (id, owner_id, title, storage_path, content_rev) values
(pg_temp.u(10), pg_temp.u(1), 'P', pg_temp.u(10)::text || '/original.pdf', 0),
(pg_temp.u(20), pg_temp.u(2), 'D', pg_temp.u(20)::text || '/original.pdf', 5),
(pg_temp.u(21), pg_temp.u(2), 'G', pg_temp.u(21)::text || '/original.pdf', 5),
(pg_temp.u(30), pg_temp.u(3), 'R', pg_temp.u(30)::text || '/original.pdf', 0);

-- ===========================================================================
-- 1. The quota: predecessor locked, owner lock, then the rule; inserts charged
-- ===========================================================================
select pg_temp.chk('01 the quota trigger locks the predecessor FOR UPDATE, then takes the owner lock, then reads it FOR UPDATE again before the exemption', $q$
    select pg_get_functiondef('public.storage_objects_enforce_quota()'::regprocedure)
           ~ 'for update;[\s\S]*pg_advisory_xact_lock[^;]*cleffy\.storage_quota[\s\S]*for update[\s\S]*v_size <= v_replaced[\s\S]*storage_owner_bytes'
       and pg_get_functiondef('public.storage_objects_enforce_quota()'::regprocedure)
           !~ 'v_size <= v_replaced[\s\S]*pg_advisory_xact_lock'$q$);
select pg_temp.chk('02 an AFTER INSERT row trigger charges every inserted object under the owner lock', $q$
    select exists (select 1 from pg_trigger t where t.tgname = 'storage_objects_charge_insert'
                   and t.tgrelid = 'storage.objects'::regclass and not t.tgisinternal
                   and t.tgtype = 5) -- ROW | INSERT, AFTER
       and pg_get_functiondef('public.storage_objects_charge_insert()'::regprocedure)
           ~ 'pg_advisory_xact_lock[^;]*cleffy\.storage_quota[\s\S]*storage_owner_bytes'$q$);

select pg_temp.allowed('03 1 stores X (600) and Y (400): exactly its quota',
    pg_temp.put('scores', pg_temp.c(10, 'x.pdf'), 600, 1) || '; ' || pg_temp.put('scores', pg_temp.c(10, 'y.pdf'), 400, 1));
select pg_temp.allowed('04 rewriting Y at the same size, at the cap, is allowed',
    pg_temp.put('scores', pg_temp.c(10, 'y.pdf'), 400, 1));
-- 3's R holds a PDF written before any lock of 3's was taken here.
set local session_replication_role = replica;
insert into storage.objects (bucket_id, name, owner, metadata) values ('scores', pg_temp.c(30, 'original.pdf'), pg_temp.u(3), '{"size": 50}');
set local session_replication_role = origin;
select pg_temp.chk('05 a non-growing rewrite takes the owner''s quota lock too (3''s: not held before it, held after)', $q$
    select not pg_temp.holds_quota_lock (pg_temp.u(3))$q$);
select pg_temp.allowed('05b ... (rewriting R''s PDF at the same size)', pg_temp.put('scores', pg_temp.c(30, 'original.pdf'), 50, 3));
select pg_temp.chk('05c ... held', $q$select pg_temp.holds_quota_lock (pg_temp.u(3))$q$);
select pg_temp.refused('06 a new object at the cap is refused', pg_temp.put('scores', pg_temp.c(10, 'z.pdf'), 1, 1),
    '42501', 'storage_quota_exceeded');

-- With the BEFORE check out of the way (in this rolled-back transaction),
-- the AFTER INSERT charge alone still holds the quota.
drop trigger storage_objects_enforce_quota on storage.objects;
select pg_temp.refused('07 with only the AFTER INSERT charge, a new object over the quota is still refused',
    pg_temp.put('scores', pg_temp.c(10, 'z.pdf'), 1, 1), '42501', 'storage_quota_exceeded');
select pg_temp.allowed('08 ... while an upsert that meets an existing row inserts nothing, and is not charged as an insert',
    pg_temp.put('scores', pg_temp.c(10, 'y.pdf'), 300, 1));
select pg_temp.allowed('09 ... and a new object that fits is charged and allowed', pg_temp.put('scores', pg_temp.c(10, 'z.pdf'), 100, 1));
create trigger storage_objects_enforce_quota before insert or update on storage.objects
for each row execute function public.storage_objects_enforce_quota ();
select pg_temp.chk('10 1 stores 1000, exactly its quota', $q$select public.storage_owner_bytes (pg_temp.u(1)) = 1000$q$);

-- A predecessor this transaction deleted is no predecessor: the same name
-- written again is a new object, charged in full.
select pg_temp.allowed('11 1 removes Z (100)', format('del' || 'ete from storage.objects where bucket_id = %L and name = %L', 'scores', pg_temp.c(10, 'z.pdf')));
select pg_temp.refused('12 writing Z again at 101 is a new object, refused', pg_temp.put('scores', pg_temp.c(10, 'z.pdf'), 101, 1),
    '42501', 'storage_quota_exceeded');
select pg_temp.allowed('13 ... and at 100 it fits', pg_temp.put('scores', pg_temp.c(10, 'z.pdf'), 100, 1));
update public.deployment_config set storage_quota_bytes = '{"free": 1000000}';

-- ===========================================================================
-- 2. A client's removal never takes a live score's published cover
-- ===========================================================================
-- D is 2's: it publishes 0, then uploads 1 (unpublished).
select pg_temp.allowed('20 2 publishes D''s cover 0 and uploads 1',
    pg_temp.put('thumbnails', pg_temp.c(20, '0.jpg'), 10, 2) || format('; update public.documents set thumb_rev = 0 where id = %L', pg_temp.u(20))
    || '; ' || pg_temp.put('thumbnails', pg_temp.c(20, '1.jpg'), 10, 2));
select pg_temp.as_user(2);
select pg_temp.chk('21 2''s removal of the published cover 0 removes nothing', $q$
    select pg_temp.removed (pg_temp.c(20, '0.jpg')) = '{}'$q$);
select pg_temp.chk('22 ... and 0 is still stored and published', $q$
    select pg_temp.c(20, '0.jpg') = any (pg_temp.folder (pg_temp.u(20)))
       and (select thumb_rev = 0 from public.documents where id = pg_temp.u(20))$q$);

-- The name reused after a claim: two devices are told to remove 1.
select pg_temp.chk('23 two claims (each about to write 2) both name the unpublished 1', $q$
    select pg_temp.claim (array[pg_temp.u(20)], 2) = array[pg_temp.c(20, '1.jpg')]
       and pg_temp.claim (array[pg_temp.u(20)], 2) = array[pg_temp.c(20, '1.jpg')]$q$);
select pg_temp.chk('24 the first removal takes 1', $q$
    select pg_temp.removed (pg_temp.c(20, '1.jpg')) = array[pg_temp.c(20, '1.jpg')]$q$);
select pg_temp.chk('24b ... and its claim row goes with it', $q$
    select not exists (select 1 from public.thumbnail_storage_cleanup where object_name = pg_temp.c(20, '1.jpg'))$q$);
select pg_temp.as_server();
select pg_temp.allowed('25 1 is written again', pg_temp.put('thumbnails', pg_temp.c(20, '1.jpg'), 10, 2));
select pg_temp.as_user(2);
select pg_temp.allowed('26 and published', format('update public.documents set thumb_rev = 1 where id = %L', pg_temp.u(20)));
select pg_temp.chk('27 the second, late removal of 1 removes nothing: it is the published cover now', $q$
    select pg_temp.removed (pg_temp.c(20, '1.jpg')) = '{}'
       and pg_temp.c(20, '1.jpg') = any (pg_temp.folder (pg_temp.u(20)))
       and (select thumb_rev = 1 from public.documents where id = pg_temp.u(20))$q$);
select pg_temp.chk('28 a cover that is not the published one is still removed (0, superseded by 1)', $q$
    select pg_temp.removed (pg_temp.c(20, '0.jpg')) = array[pg_temp.c(20, '0.jpg')]$q$);
select pg_temp.as_user(3);
select pg_temp.chk('29 a stranger removes nothing (the storage policy, as before)', $q$
    select pg_temp.removed (pg_temp.c(20, '1.jpg')) = '{}'$q$);

select pg_temp.as_service();
select pg_temp.chk('30 the service role''s removal of the published cover goes ahead (delete-account empties a live score''s folders first)', $q$
    select pg_temp.removed (pg_temp.c(20, '1.jpg')) = array[pg_temp.c(20, '1.jpg')]$q$);
select pg_temp.as_server();
select pg_temp.allowed('31 D''s cover 2 is written and published',
    pg_temp.put('thumbnails', pg_temp.c(20, '2.jpg'), 10, 2) || format('; update public.documents set thumb_rev = 2 where id = %L', pg_temp.u(20)));
select pg_temp.chk('32 ... and the server''s own removal (no signed-in user) goes ahead too', $q$
    select pg_temp.removed (pg_temp.c(20, '2.jpg')) = array[pg_temp.c(20, '2.jpg')]$q$);
select pg_temp.allowed('33 a revision with no stored object may still be published (the client''s republish repairs it)',
    format('update public.documents set thumb_rev = 3 where id = %L', pg_temp.u(20)));
select pg_temp.allowed('34 3 is written; then D is deleted',
    pg_temp.put('thumbnails', pg_temp.c(20, '3.jpg'), 10, 2) || format('; del' || 'ete from public.documents where id = %L', pg_temp.u(20)));
select pg_temp.as_user(2);
select pg_temp.chk('35 a deleted score''s former cover is removed by its owner''s cleanup (purgeDocumentStorage)', $q$
    select pg_temp.removed (pg_temp.c(20, '3.jpg')) = array[pg_temp.c(20, '3.jpg')]$q$);
select pg_temp.as_server();
select pg_temp.chk('36 the guard is a BEFORE DELETE row trigger that takes the folder lock before reading thumb_rev', $q$
    select exists (select 1 from pg_trigger t where t.tgname = 'thumbnails_keep_published_cover'
                   and t.tgrelid = 'storage.objects'::regclass and not t.tgisinternal
                   and t.tgtype = 11) -- ROW | BEFORE | DELETE
       and pg_get_functiondef('public.thumbnails_keep_published_cover()'::regprocedure)
           ~ 'thumbnail_folder_lock[\s\S]*thumb_rev[\s\S]*return null'
       -- The publish's order since 20261022140500: the folder lock, then its
       -- object's row without waiting (it was the row, then the folder).
       and pg_get_functiondef('public.documents_thumbnail_published()'::regprocedure)
           ~ 'thumbnail_folder_lock \(new\.id\)[\s\S]*for key share nowait[\s\S]*claimed_at is not null'$q$);

-- ===========================================================================
-- 3. The folder lock, in document-id order
-- ===========================================================================
select pg_temp.chk('40 taking B''s folder lock records B as the highest held', $q$
    select pg_temp.folder_lock (pg_temp.u(41))
       and current_setting('cleffy.thumbnail_folder_max', true) = pg_temp.u(41)::text$q$);
select pg_temp.chk('41 a lower id (A) is then only tried: free, it is taken, and the highest stays B', $q$
    select pg_temp.folder_lock (pg_temp.u(40))
       and current_setting('cleffy.thumbnail_folder_max', true) = pg_temp.u(41)::text$q$);
select pg_temp.chk('42 ... and asking again for one already held is fine, in either order', $q$
    select pg_temp.folder_lock (pg_temp.u(40)) and pg_temp.folder_lock (pg_temp.u(41))$q$);
select pg_temp.chk('43 a higher id (C) is waited for in order, and becomes the highest', $q$
    select pg_temp.folder_lock (pg_temp.u(42))
       and current_setting('cleffy.thumbnail_folder_max', true) = pg_temp.u(42)::text$q$);
select pg_temp.chk('44 the out-of-order path never waits (pg_try_advisory_xact_lock), and refuses with thumbnail_folder_busy', $q$
    select pg_get_functiondef('public.thumbnail_folder_lock(uuid)'::regprocedure)
           ~ 'p_document_id < v_max::uuid[\s\S]*pg_try_advisory_xact_lock[\s\S]*thumbnail_folder_busy[\s\S]*55P03'
       and pg_get_functiondef('public.claim_superseded_thumbnails(uuid[], integer)'::regprocedure)
           ~ 'order by 1 loop\s+perform public\.thumbnail_folder_lock'$q$);

-- ===========================================================================
-- 4. A folder over the cap
-- ===========================================================================
-- G (2's) holds four covers from before the cap, none on the ledger, and
-- publishes 1.
set local session_replication_role = replica;
insert into storage.objects (bucket_id, name, owner, metadata, created_at) values
('thumbnails', pg_temp.c(21, '0.jpg'), pg_temp.u(2), '{"size": 1}', now() - interval '4 hours'),
('thumbnails', pg_temp.c(21, '1.jpg'), pg_temp.u(2), '{"size": 1}', now() - interval '3 hours'),
('thumbnails', pg_temp.c(21, '2.jpg'), pg_temp.u(2), '{"size": 1}', now() - interval '2 hours'),
('thumbnails', pg_temp.c(21, '3.jpg'), pg_temp.u(2), '{"size": 1}', now() - interval '1 hour');
update public.documents set thumb_rev = 1 where id = pg_temp.u(21);
set local session_replication_role = origin;
select pg_temp.chk('50 G''s folder holds four objects, none on the ledger', $q$
    select cardinality(pg_temp.folder (pg_temp.u(21))) = 4 and pg_temp.ledger (pg_temp.u(21)) = '{}'$q$);
select pg_temp.as_user(2);
select pg_temp.chk('51 a sweep claims 0 and 2: all but the published 1 and the newest other (3, perhaps on its way to being published)', $q$
    select pg_temp.claim (array[pg_temp.u(21)]) = array[pg_temp.c(21, '0.jpg'), pg_temp.c(21, '2.jpg')]$q$);
select pg_temp.chk('52 they are removed', $q$
    select pg_temp.removed (pg_temp.c(21, '0.jpg')) = array[pg_temp.c(21, '0.jpg')]
       and pg_temp.removed (pg_temp.c(21, '2.jpg')) = array[pg_temp.c(21, '2.jpg')]$q$);
select pg_temp.chk('53 at the cap, a sweep claims nothing more (3 is not on the ledger)', $q$
    select pg_temp.claim (array[pg_temp.u(21)]) = '{}'
       and pg_temp.folder (pg_temp.u(21)) = array[pg_temp.c(21, '1.jpg'), pg_temp.c(21, '3.jpg')]$q$);
select pg_temp.chk('54 the next publish (writing 4) claims 3, never the published 1', $q$
    select pg_temp.claim (array[pg_temp.u(21)], 4) = array[pg_temp.c(21, '3.jpg')]$q$);
select pg_temp.as_server();

-- ===========================================================================
-- A rerun
-- ===========================================================================
create temp table t_ledger_before as select * from public.thumbnail_storage_cleanup;

\ir ../../supabase/migrations/20261022101000_storage_quota_lock_and_cover_reuse.sql

select pg_temp.chk('60 a rerun keeps every ledger row, and each trigger once', $q$
    select not exists ((select * from t_ledger_before) except (select * from public.thumbnail_storage_cleanup))
       and (select count(*) from pg_trigger where not tgisinternal
            and tgname in ('storage_objects_enforce_quota', 'storage_objects_charge_insert', 'thumbnails_keep_published_cover',
                           'thumbnails_enforce_folder_cap', 'thumbnails_record_superseded', 'documents_thumbnail_published')) = 6$q$);
select pg_temp.chk('61 none of the new functions is a client''s to call', $q$
    select not has_function_privilege('authenticated', 'public.storage_objects_charge_insert()', 'EXECUTE')
       and not has_function_privilege('authenticated', 'public.thumbnails_keep_published_cover()', 'EXECUTE')
       and not has_function_privilege('authenticated', 'public.thumbnail_folder_lock(uuid)', 'EXECUTE')
       and not has_function_privilege('anon', 'public.thumbnail_folder_lock(uuid)', 'EXECUTE')
       and has_function_privilege('authenticated', 'public.claim_superseded_thumbnails(uuid[], integer)', 'EXECUTE')
       and not has_function_privilege('anon', 'public.claim_superseded_thumbnails(uuid[], integer)', 'EXECUTE')$q$);

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
