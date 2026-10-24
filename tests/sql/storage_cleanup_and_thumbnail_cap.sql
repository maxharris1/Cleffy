-- Behaviour proof for 20261022100900_storage_cleanup_markers_and_thumbnail_cap.sql
-- (Codex round 2 on #69: MAJOR 1, MAJOR 3's remainder, MINORs 2 and 3;
-- decision 52).
--
--   * A deleted score's cleanup marker is not the owner's to delete: the
--     DELETE grant and policy are gone, the attempt is refused, and the bytes
--     keep counting against the owner. finish_document_storage_cleanup clears
--     it only once both folders are empty (or the owner has re-created the
--     score); the service role still clears markers (delete-account).
--   * An over-quota owner can replace a file with one no larger: the Storage
--     API's size-less policy test for the replacement passes, and so does the
--     real write, while growing it is refused.
--   * A score's thumbnail folder holds at most two objects in committed
--     state, whoever writes (the Storage API's real write is the service
--     role's). An upload whose publish failed is not current, so the next
--     publish claims it (claim_superseded_thumbnails) and removes it rather
--     than being blocked. A claim never takes the published revision, and a
--     claimed object cannot be published.
--
-- The concurrent-write cases are in storage_thumbnail_concurrency.sql.
--
-- Runs in one transaction and ROLLS BACK. psql only (it `\ir`s the
-- migration); it writes storage.objects rows the way the Storage API does,
-- and removes them with storage.allow_delete_query set.
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/storage_cleanup_and_thumbnail_cap.sql
--
-- Every row should read `t`; the last line is `failures | total`.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('5a0b0000-0c0b-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
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
-- A client's write, as the Storage API's policy test makes it: no size yet.
create function pg_temp.client_put(p_bucket text, p_name text, p_owner int) returns text language sql immutable as $f$
select format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)'
              ' on conflict (bucket_id, name collate "C") where archived_at is null do update set owner = excluded.owner',
              p_bucket, p_name, pg_temp.u(p_owner))
$f$;
create function pg_temp.drop_object(p_bucket text, p_name text) returns text language sql immutable as $f$
select format('del' || 'ete from storage.objects where bucket_id = %L and name = %L', p_bucket, p_name)
$f$;
create function pg_temp.folder(p_doc uuid) returns text[] language sql as $f$
select coalesce(array_agg(name order by name), '{}') from storage.objects
where bucket_id = 'thumbnails' and name like p_doc::text || '/%'
$f$;
create function pg_temp.ledger(p_doc uuid) returns text[] language sql as $f$
select coalesce(array_agg(object_name order by object_name), '{}') from public.thumbnail_storage_cleanup where document_id = p_doc
$f$;
create function pg_temp.claimed(p_doc uuid) returns text[] language sql as $f$
select coalesce(array_agg(object_name order by object_name), '{}') from public.thumbnail_storage_cleanup
where document_id = p_doc and claimed_at is not null
$f$;
create function pg_temp.claim(p_docs uuid[], p_rev int default null) returns text[] language sql as $f$
select coalesce(array_agg(n order by n), '{}') from public.claim_superseded_thumbnails (p_docs, p_rev) n
$f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;
select set_config('storage.allow_delete_query', 'true', true);

delete from public.deployment_config;
insert into public.deployment_config (id, storage_quota_bytes, updated_by)
values (true, '{"free": 1000}', 'proof');

-- 1 and 2 are free (1000 bytes here); 3 owns nothing.
insert into auth.users (id, email)
select pg_temp.u(n), 'storage-cleanup-' || n || '@storage.test' from generate_series(1, 3) n;
insert into public.documents (id, owner_id, title, storage_path, content_rev) values
(pg_temp.u(10), pg_temp.u(1), 'A', pg_temp.u(10)::text || '/original.pdf', 0),
(pg_temp.u(11), pg_temp.u(1), 'B', pg_temp.u(11)::text || '/original.pdf', 0),
(pg_temp.u(20), pg_temp.u(2), 'C', pg_temp.u(20)::text || '/original.pdf', 0),
(pg_temp.u(21), pg_temp.u(2), 'D', pg_temp.u(21)::text || '/original.pdf', 5);

\set a '5a0b0000-0c0b-4000-8000-000000000010'
\set b '5a0b0000-0c0b-4000-8000-000000000011'
\set c '5a0b0000-0c0b-4000-8000-000000000020'
\set d '5a0b0000-0c0b-4000-8000-000000000021'

-- ===========================================================================
-- 1. Cleanup markers
-- ===========================================================================
select pg_temp.allowed('01 1 stores A''s PDF (600) and cover (100)',
    pg_temp.put('scores', :'a' || '/original.pdf', 600, 1) || '; ' || pg_temp.put('thumbnails', :'a' || '/0.jpg', 100, 1));
select pg_temp.as_user(1);
select pg_temp.allowed('02 1 deletes score A', format('del' || 'ete from public.documents where id = %L', :'a'));
select pg_temp.as_server();
select pg_temp.chk('03 its marker names 1, and A''s 700 bytes still count against 1', $q$
    select (select owner_id from public.document_storage_cleanup where document_id = pg_temp.u(10)) = pg_temp.u(1)
       and public.storage_owner_bytes (pg_temp.u(1)) = 700$q$);

select pg_temp.as_user(1);
select pg_temp.refused('04 1 cannot delete the marker (no DELETE grant)',
    format('del' || 'ete from public.document_storage_cleanup where document_id = %L', :'a'), '42501');
select pg_temp.chk('05 ... nor, with the grant gone, would any policy allow it', $q$
    select not has_table_privilege('authenticated', 'public.document_storage_cleanup', 'DELETE')
       and not has_table_privilege('anon', 'public.document_storage_cleanup', 'DELETE')
       and not exists (select 1 from pg_policy where polrelid = 'public.document_storage_cleanup'::regclass
                       and polcmd in ('d', '*'))$q$);
select pg_temp.chk('06 ... and 1 still reads it', $q$
    select count(*) = 1 from public.document_storage_cleanup where document_id = pg_temp.u(10)$q$);
select pg_temp.chk('07 the server will not clear it while A''s files are stored', $q$
    select public.finish_document_storage_cleanup (pg_temp.u(10)) = false$q$);
select pg_temp.as_server();
select pg_temp.chk('08 so the marker and the usage are unchanged', $q$
    select (select count(*) from public.document_storage_cleanup where document_id = pg_temp.u(10)) = 1
       and public.storage_owner_bytes (pg_temp.u(1)) = 700$q$);
select pg_temp.refused('09 and the quota still holds them: 1 cannot add 400 bytes elsewhere',
    pg_temp.put('scores', :'b' || '/original.pdf', 400, 1), '42501', 'storage_quota_exceeded');

select pg_temp.as_user(3);
select pg_temp.chk('10 another user''s call clears nothing (nothing of theirs is pending)', $q$
    select public.finish_document_storage_cleanup (pg_temp.u(10))$q$);
select pg_temp.as_server();
select pg_temp.chk('11 ... the marker is still there', $q$
    select count(*) = 1 from public.document_storage_cleanup where document_id = pg_temp.u(10)$q$);

select pg_temp.allowed('12 1 removes A''s PDF', pg_temp.drop_object('scores', :'a' || '/original.pdf'));
select pg_temp.as_user(1);
select pg_temp.chk('13 with the cover still stored, the marker stays', $q$
    select public.finish_document_storage_cleanup (pg_temp.u(10)) = false$q$);
select pg_temp.as_server();
select pg_temp.allowed('14 1 removes the cover', pg_temp.drop_object('thumbnails', :'a' || '/0.jpg'));
select pg_temp.as_user(1);
select pg_temp.chk('15 both folders empty: the server clears the marker', $q$
    select public.finish_document_storage_cleanup (pg_temp.u(10))$q$);
select pg_temp.as_server();
select pg_temp.chk('16 ... it is gone, and so is the usage', $q$
    select (select count(*) from public.document_storage_cleanup where document_id = pg_temp.u(10)) = 0
       and public.storage_owner_bytes (pg_temp.u(1)) = 0$q$);
select pg_temp.as_user(1);
select pg_temp.chk('17 asking again is harmless', $q$select public.finish_document_storage_cleanup (pg_temp.u(10))$q$);
select pg_temp.as_server();

-- B: deleted with its PDF stored, then re-created by its owner.
select pg_temp.allowed('18 1 stores B''s PDF (300)', pg_temp.put('scores', :'b' || '/original.pdf', 300, 1));
select pg_temp.as_user(1);
select pg_temp.allowed('19 1 deletes B, then re-creates it under the same id',
    format('del' || 'ete from public.documents where id = %L; insert into public.documents (id, owner_id, title, storage_path) values (%L, %L, %L, %L)',
           :'b', :'b', pg_temp.u(1), 'B again', :'b' || '/original.pdf'));
select pg_temp.chk('20 the re-created score''s files count through it, with or without the marker', $q$
    select public.finish_document_storage_cleanup (pg_temp.u(11))$q$);
select pg_temp.as_server();
select pg_temp.chk('21 ... 300 bytes, once', $q$
    select public.storage_owner_bytes (pg_temp.u(1)) = 300
       and (select count(*) from public.document_storage_cleanup where document_id = pg_temp.u(11)) = 0$q$);

select pg_temp.chk('22 the service role still clears markers (delete-account, after emptying both folders)', $q$
    select has_table_privilege('service_role', 'public.document_storage_cleanup', 'DELETE')$q$);
select pg_temp.as_user(1);
select pg_temp.refused('23 anon cannot call it', $q$
    set local role anon; select public.finish_document_storage_cleanup (pg_temp.u(11))$q$, '42501');
select pg_temp.as_server();

-- ===========================================================================
-- 4. An over-quota owner shrinks a file through the upload path
-- ===========================================================================
select pg_temp.allowed('30 2 stores C''s PDF (800) and its import backup (150)',
    pg_temp.put('scores', :'c' || '/original.pdf', 800, 2) || '; ' || pg_temp.put('scores', :'c' || '/pre-import-original.pdf', 150, 2));
-- A downgrade: the quota is now under what C's backup alone takes.
update public.deployment_config set storage_quota_bytes = '{"free": 100}';

select pg_temp.as_user(2);
select pg_temp.allowed('31 the Storage API''s policy test for replacing C''s PDF (size-less upsert as 2) passes',
    pg_temp.client_put('scores', :'c' || '/original.pdf', 2));
select pg_temp.refused('32 ... but the same test for a new object is refused',
    pg_temp.client_put('scores', :'c' || '/extra.pdf', 2), '42501', 'storage_quota_exceeded');
select pg_temp.as_server();
select pg_temp.allowed('33 the real write shrinking it to 700 passes, the other files alone being over quota',
    pg_temp.put('scores', :'c' || '/original.pdf', 700, 2));
select pg_temp.allowed('34 ... and rewriting it at the same size', pg_temp.put('scores', :'c' || '/original.pdf', 700, 2));
select pg_temp.refused('35 growing it is refused', pg_temp.put('scores', :'c' || '/original.pdf', 701, 2), '42501', 'storage_quota_exceeded');
select pg_temp.allowed('36 a direct UPDATE that shrinks it passes',
    format('update storage.objects set metadata = %L where bucket_id = %L and name = %L', '{"size": 650}', 'scores', :'c' || '/original.pdf'));
select pg_temp.refused('37 ... one that grows it is refused',
    format('update storage.objects set metadata = %L where bucket_id = %L and name = %L', '{"size": 651}', 'scores', :'c' || '/original.pdf'),
    '42501', 'storage_quota_exceeded');
select pg_temp.chk('38 2 now stores 800', $q$select public.storage_owner_bytes (pg_temp.u(2)) = 800$q$);
update public.deployment_config set storage_quota_bytes = '{"free": 1000000}';

-- ===========================================================================
-- 2 and 3. Two thumbnails per score; claims; publishing
-- ===========================================================================
-- D is 2's, at content_rev 5.
select pg_temp.as_user(2);
select pg_temp.allowed('40 2 publishes D''s cover at revision 0',
    pg_temp.client_put('thumbnails', :'d' || '/0.jpg', 2) || format('; update public.documents set thumb_rev = 0 where id = %L', :'d'));
select pg_temp.allowed('41 uploads revision 1, whose thumb_rev update then fails (no update here)',
    pg_temp.client_put('thumbnails', :'d' || '/1.jpg', 2));
select pg_temp.as_service();
select pg_temp.refused('42 a third object is refused on the real (service-role) write, not only by the policy',
    pg_temp.put('thumbnails', :'d' || '/2.jpg', 10, 2), '42501', 'thumbnail_limit');
select pg_temp.as_user(2);
select pg_temp.refused('42b ... and the Storage API''s policy test for it is refused by name, so the client knows to clear the folder',
    pg_temp.client_put('thumbnails', :'d' || '/2.jpg', 2), '42501', 'thumbnail_limit');
select pg_temp.as_server();
select pg_temp.chk('43 ... so the folder holds 0 and 1, and nothing was ledgered for 2', $q$
    select pg_temp.folder (pg_temp.u(21)) = array['5a0b0000-0c0b-4000-8000-000000000021/0.jpg',
                                                  '5a0b0000-0c0b-4000-8000-000000000021/1.jpg']
       and pg_temp.ledger (pg_temp.u(21)) = array['5a0b0000-0c0b-4000-8000-000000000021/0.jpg']$q$);

select pg_temp.as_user(2);
select pg_temp.chk('44 a library sweep claims nothing: 0 is ledgered but still the published cover', $q$
    select pg_temp.claim (array[pg_temp.u(21)]) = '{}'
       and pg_temp.ledger (pg_temp.u(21)) = '{}'$q$);
select pg_temp.chk('45 publishing revision 2 first claims the failed upload, 1, never the published 0', $q$
    select pg_temp.claim (array[pg_temp.u(21)], 2) = array['5a0b0000-0c0b-4000-8000-000000000021/1.jpg']
       and pg_temp.claimed (pg_temp.u(21)) = array['5a0b0000-0c0b-4000-8000-000000000021/1.jpg']$q$);
select pg_temp.refused('46 a claimed object cannot be published (the late thumb_rev update for 1)',
    format('update public.documents set thumb_rev = 1 where id = %L', :'d'), '55000', 'thumbnail_claimed');
select pg_temp.as_server();
select pg_temp.chk('47 ... thumb_rev is still 0', $q$select thumb_rev = 0 from public.documents where id = pg_temp.u(21)$q$);
select pg_temp.allowed('48 writing 1 again does not lift its claim', pg_temp.put('thumbnails', :'d' || '/1.jpg', 10, 2));
select pg_temp.chk('49 ... it is still claimed', $q$
    select pg_temp.claimed (pg_temp.u(21)) = array['5a0b0000-0c0b-4000-8000-000000000021/1.jpg']$q$);
select pg_temp.allowed('50 the client removes the claimed 1', pg_temp.drop_object('thumbnails', :'d' || '/1.jpg'));
select pg_temp.as_user(2);
select pg_temp.allowed('51 revision 2 now lands', pg_temp.client_put('thumbnails', :'d' || '/2.jpg', 2));
select pg_temp.allowed('52 and is published', format('update public.documents set thumb_rev = 2 where id = %L', :'d'));
select pg_temp.chk('53 publishing it leaves 0 on the ledger, unclaimed, and 2 off it', $q$
    select pg_temp.ledger (pg_temp.u(21)) = array['5a0b0000-0c0b-4000-8000-000000000021/0.jpg']
       and pg_temp.claimed (pg_temp.u(21)) = '{}'$q$);
select pg_temp.as_user(3);
select pg_temp.chk('54 a stranger''s sweep claims none of 2''s covers', $q$
    select pg_temp.claim (array[pg_temp.u(21)]) = '{}'$q$);
select pg_temp.as_user(2);
select pg_temp.chk('55 2''s sweep claims 0', $q$
    select pg_temp.claim (array[pg_temp.u(21)]) = array['5a0b0000-0c0b-4000-8000-000000000021/0.jpg']$q$);
select pg_temp.refused('56 so 0 cannot be made the published cover again',
    format('update public.documents set thumb_rev = 0 where id = %L', :'d'), '55000', 'thumbnail_claimed');
select pg_temp.chk('57 a claim before writing 3 never takes the published 2', $q$
    select pg_temp.claim (array[pg_temp.u(21)], 3) = array['5a0b0000-0c0b-4000-8000-000000000021/0.jpg']$q$);
select pg_temp.as_server();
select pg_temp.allowed('58 removing 0', pg_temp.drop_object('thumbnails', :'d' || '/0.jpg'));
select pg_temp.chk('59 ... clears the ledger', $q$select pg_temp.ledger (pg_temp.u(21)) = '{}'$q$);
select pg_temp.as_user(2);
select pg_temp.refused('60 a claim naming a revision covers exactly one score',
    $q$select public.claim_superseded_thumbnails (array[pg_temp.u(20), pg_temp.u(21)], 3)$q$, '22023');
select pg_temp.refused('61 ... and a sweep at most 100',
    $q$select public.claim_superseded_thumbnails (array(select gen_random_uuid () from generate_series(1, 101)))$q$, '22023');
select pg_temp.as_server();
select pg_temp.chk('62 the RPCs are the signed-in user''s, the lock no client''s', $q$
    select has_function_privilege('authenticated', 'public.claim_superseded_thumbnails(uuid[], integer)', 'EXECUTE')
       and not has_function_privilege('anon', 'public.claim_superseded_thumbnails(uuid[], integer)', 'EXECUTE')
       and has_function_privilege('authenticated', 'public.finish_document_storage_cleanup(uuid)', 'EXECUTE')
       and not has_function_privilege('anon', 'public.finish_document_storage_cleanup(uuid)', 'EXECUTE')
       and not has_function_privilege('authenticated', 'public.thumbnail_folder_lock(uuid)', 'EXECUTE')
       and not has_function_privilege('anon', 'public.thumbnail_folder_lock(uuid)', 'EXECUTE')$q$);
select pg_temp.chk('63 the cap and the publish guard take the per-score lock; the cap fires before the ledger', $q$
    select pg_get_functiondef('public.thumbnails_enforce_folder_cap()'::regprocedure) ~ 'thumbnail_folder_lock[\s\S]*count\(\*\)'
       and pg_get_functiondef('public.documents_thumbnail_published()'::regprocedure) ~ 'thumbnail_folder_lock[\s\S]*claimed_at is not null'
       and pg_get_functiondef('public.claim_superseded_thumbnails(uuid[], integer)'::regprocedure) ~ 'thumbnail_folder_lock[\s\S]*thumb_rev'
       and 'thumbnails_enforce_folder_cap' < 'thumbnails_record_superseded'
       and exists (select 1 from pg_trigger where tgname = 'thumbnails_enforce_folder_cap'
                   and tgrelid = 'storage.objects'::regclass and not tgisinternal)
       and exists (select 1 from pg_trigger where tgname = 'documents_thumbnail_published'
                   and tgrelid = 'public.documents'::regclass and not tgisinternal)$q$);

-- ===========================================================================
-- A rerun
-- ===========================================================================
create temp table t_ledger_before as select * from public.thumbnail_storage_cleanup;

\ir ../../supabase/migrations/20261022100900_storage_cleanup_markers_and_thumbnail_cap.sql

select pg_temp.chk('70 a rerun keeps every ledger row, each trigger once, and no delete grant or policy', $q$
    select not exists ((select * from t_ledger_before) except (select * from public.thumbnail_storage_cleanup))
       and (select count(*) from pg_trigger where not tgisinternal
            and tgname in ('thumbnails_enforce_folder_cap', 'documents_thumbnail_published')) = 2
       and not has_table_privilege('authenticated', 'public.document_storage_cleanup', 'DELETE')
       and has_table_privilege('authenticated', 'public.document_storage_cleanup', 'SELECT')$q$);

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
