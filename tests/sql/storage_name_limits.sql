-- Behaviour proof for 20261022100400_storage_object_names.sql and
-- 20261022100500_storage_bucket_limits.sql (launch re-audit SF-3, Codex A2).
--
--   * A score's owner writes exactly the names the app writes -- scores
--     {id}/original.pdf and {id}/pre-import-original.pdf, thumbnails
--     {id}/{rev}.jpg -- by insert and by upsert, and nothing else in their own
--     folder: another name, a deeper path, another case, another extension, a
--     malformed rev, or a rename (move) to any of those is refused. An object
--     left under an odd name from before can still be removed, and the
--     service role (the Edge Functions) is not held to the names.
--   * A client cannot create a score already archived; the server still can.
--   * Both buckets carry their size and type limits from the migration (it
--     reports here whether the write applied), and both migrations rerun
--     cleanly, leaving each policy once.
-- The limits themselves are enforced by the Storage API, not SQL: what this
-- proves is that the bucket rows say them.
--
-- Runs in one transaction and ROLLS BACK. psql only (it `\ir`s the
-- migrations); it removes storage.objects rows the way the Storage API does,
-- with storage.allow_delete_query set.
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/storage_name_limits.sql
--
-- Every row should read `t`; the last line is `failures | total`.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('5f0a0000-5ac0-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
-- Must succeed and touch p_rows rows.
create function pg_temp.allowed(p_name text, p_sql text, p_rows int default 1) returns void language plpgsql as $f$
declare v_rows int;
begin
execute p_sql; get diagnostics v_rows = row_count;
insert into t_results values (p_name, v_rows = p_rows, 'rows: ' || v_rows);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
create function pg_temp.refused(p_name text, p_sql text, p_state text) returns void language plpgsql as $f$
declare v_state text; v_message text;
begin
execute p_sql;
insert into t_results values (p_name, false, 'no error raised');
exception when others then
get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
insert into t_results values (p_name, v_state = p_state, v_state || ' ' || v_message);
end $f$;
create function pg_temp.as_user(n int) returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(n), 'role', 'authenticated')::text, true);
perform set_config('role', 'authenticated', true);
end $f$;
create function pg_temp.as_service() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
perform set_config('role', 'service_role', true);
end $f$;
-- An object insert into one bucket, as the Storage API makes it.
create function pg_temp.put(p_bucket text, p_name text) returns text language sql immutable as $f$
select format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', p_bucket, p_name, pg_temp.u(1))
$f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;
select set_config('storage.allow_delete_query', 'true', true);

-- 1 owns score 10 (lower-case id, as every id the app makes is).
insert into auth.users (id, email) values (pg_temp.u(1), 'owner@storagenames.test');
-- At content_rev 17, so revisions 0..17 are ones it has had: 20261022100800
-- refuses a thumbnail for a revision the score never reached
-- (storage_quota.sql proves that cap).
insert into public.documents (id, owner_id, title, storage_path, content_rev)
values (pg_temp.u(10), pg_temp.u(1), 'Names', pg_temp.u(10)::text || '/original.pdf', 17);
-- An object from before the policies, under a name the app never writes.
insert into storage.objects (bucket_id, name, owner) values ('scores', pg_temp.u(10)::text || '/stray.bin', pg_temp.u(1));

\set doc '5f0a0000-5ac0-4000-8000-000000000010'

-- ---- what the app writes
select pg_temp.as_user(1);
select pg_temp.allowed('01 scores: {id}/original.pdf', pg_temp.put('scores', :'doc' || '/original.pdf'));
select pg_temp.allowed('02 scores: {id}/pre-import-original.pdf (the smart-import backup)', pg_temp.put('scores', :'doc' || '/pre-import-original.pdf'));
select pg_temp.allowed('03 scores: an upsert over original.pdf (upload with upsert: true, TUS)',
    pg_temp.put('scores', :'doc' || '/original.pdf') || $q$ on conflict (bucket_id, name collate "C") where archived_at is null do update set metadata = '{"size": 2}'$q$);
select pg_temp.allowed('04 thumbnails: {id}/0.jpg and {id}/17.jpg', pg_temp.put('thumbnails', :'doc' || '/0.jpg') || ', (''thumbnails'', ''' || :'doc' || '/17.jpg'', ''' || pg_temp.u(1) || ''')', 2);
select pg_temp.allowed('05 thumbnails: an upsert over {id}/17.jpg',
    pg_temp.put('thumbnails', :'doc' || '/17.jpg') || $q$ on conflict (bucket_id, name collate "C") where archived_at is null do update set metadata = '{"size": 2}'$q$);
-- The largest int is a valid NAME; 20261022100800's revision cap refuses it.
select pg_temp.refused('06 thumbnails: the largest int rev is a valid name, but past the revision cap', pg_temp.put('thumbnails', :'doc' || '/2147483647.jpg'), '42501');

-- ---- anything else in the owner's own folder
select pg_temp.refused('10 scores: another name', pg_temp.put('scores', :'doc' || '/notes.txt'), '42501');
select pg_temp.refused('11 scores: another pdf name', pg_temp.put('scores', :'doc' || '/copy.pdf'), '42501');
select pg_temp.refused('12 scores: a deeper path', pg_temp.put('scores', :'doc' || '/x/original.pdf'), '42501');
select pg_temp.refused('13 scores: a suffix after the name', pg_temp.put('scores', :'doc' || '/original.pdf.exe'), '42501');
select pg_temp.refused('14 scores: another case', pg_temp.put('scores', :'doc' || '/ORIGINAL.PDF'), '42501');
select pg_temp.refused('15 scores: the folder in upper case', pg_temp.put('scores', upper(:'doc') || '/original.pdf'), '42501');
select pg_temp.refused('16 scores: the folder alone', pg_temp.put('scores', :'doc' || '/'), '42501');
select pg_temp.refused('20 thumbnails: a name that is not a rev', pg_temp.put('thumbnails', :'doc' || '/cover.jpg'), '42501');
select pg_temp.refused('21 thumbnails: a rev with a leading zero', pg_temp.put('thumbnails', :'doc' || '/07.jpg'), '42501');
select pg_temp.refused('22 thumbnails: a negative rev', pg_temp.put('thumbnails', :'doc' || '/-1.jpg'), '42501');
select pg_temp.refused('23 thumbnails: a rev past an int', pg_temp.put('thumbnails', :'doc' || '/12345678901.jpg'), '42501');
select pg_temp.refused('24 thumbnails: another extension', pg_temp.put('thumbnails', :'doc' || '/7.png'), '42501');
select pg_temp.refused('25 thumbnails: a deeper path', pg_temp.put('thumbnails', :'doc' || '/7.jpg/x'), '42501');
select pg_temp.refused('30 scores: a move (rename) to another name',
    format('update storage.objects set name = %L where bucket_id = ''scores'' and name = %L', :'doc' || '/evil.pdf', :'doc' || '/original.pdf'), '42501');
select pg_temp.refused('31 thumbnails: a move to another name',
    format('update storage.objects set name = %L where bucket_id = ''thumbnails'' and name = %L', :'doc' || '/x.jpg', :'doc' || '/17.jpg'), '42501');
select pg_temp.allowed('32 an object under an odd name from before cannot be rewritten (matches nothing)',
    format('update storage.objects set metadata = ''{}'' where bucket_id = ''scores'' and name = %L', :'doc' || '/stray.bin'), 0);
select pg_temp.allowed('33 ... but its owner can still remove it',
    format('delete from storage.objects where bucket_id = ''scores'' and name = %L', :'doc' || '/stray.bin'));
reset role;
select pg_temp.as_service();
select pg_temp.allowed('34 the service role is not held to the names', pg_temp.put('scores', :'doc' || '/server-side.bin'));
reset role;

-- ---- documents
select pg_temp.as_user(1);
select pg_temp.refused('40 a client cannot create a score already archived', $q$
    insert into public.documents (id, owner_id, title, storage_path, archived_at)
    values (pg_temp.u(11), pg_temp.u(1), 'Archived', pg_temp.u(11)::text || '/original.pdf', now())$q$, '42501');
select pg_temp.allowed('41 ... and creates an active one as before', $q$
    insert into public.documents (id, owner_id, title, storage_path)
    values (pg_temp.u(12), pg_temp.u(1), 'Active', pg_temp.u(12)::text || '/original.pdf')$q$);
reset role;
select pg_temp.as_service();
select pg_temp.allowed('42 the server may still write an archived row', $q$
    insert into public.documents (id, owner_id, title, storage_path, archived_at)
    values (pg_temp.u(13), pg_temp.u(1), 'Server archived', pg_temp.u(13)::text || '/original.pdf', now())$q$);
reset role;

-- ---- the buckets
select pg_temp.chk('50 scores: private, 50 MiB, application/pdf', $q$
    select not public and file_size_limit = 52428800 and allowed_mime_types = array['application/pdf'] from storage.buckets where id = 'scores'$q$);
select pg_temp.chk('51 thumbnails: private, 2 MiB, image/jpeg', $q$
    select not public and file_size_limit = 2097152 and allowed_mime_types = array['image/jpeg'] from storage.buckets where id = 'thumbnails'$q$);
update storage.buckets set file_size_limit = null, allowed_mime_types = null where id in ('scores', 'thumbnails');
\ir ../../supabase/migrations/20261022100500_storage_bucket_limits.sql
select pg_temp.chk('52 the bucket migration (re)applies the limits, and keeps each bucket private', $q$
    select count(*) = 2 from storage.buckets
    where not public and ((id = 'scores' and file_size_limit = 52428800 and allowed_mime_types = array['application/pdf'])
                       or (id = 'thumbnails' and file_size_limit = 2097152 and allowed_mime_types = array['image/jpeg']))$q$);
\ir ../../supabase/migrations/20261022100400_storage_object_names.sql
\ir ../../supabase/migrations/20261022100400_storage_object_names.sql
select pg_temp.chk('53 the names migration reruns: each policy once, restrictive, for authenticated', $q$
    select count(*) = 5 and bool_and(not polpermissive) and bool_and(polroles = array['authenticated'::regrole::oid])
    from pg_policy
    where polname in ('scores_object_name_insert', 'scores_object_name_update', 'thumbnails_object_name_insert',
                      'thumbnails_object_name_update', 'documents_insert_active_only')$q$);
select pg_temp.as_user(1);
select pg_temp.refused('54 ... and still refuses a stray name after the rerun', pg_temp.put('scores', :'doc' || '/again.txt'), '42501');
reset role;

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
