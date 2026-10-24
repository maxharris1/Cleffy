-- Behaviour proof for 20261022100800_storage_quota_and_thumbnail_lifecycle.sql
-- (launch re-audit A2; Codex round 1 on #69, MAJOR 3).
--
--   * The quota's limits come from deployment_config.storage_quota_bytes by
--     plan tier, defaulting to 500 MiB free and 5 GiB paid; the column takes
--     only an object of known tiers to positive byte counts.
--   * A write that would take an owner past their quota is refused
--     (`storage_quota_exceeded`, 42501), whether it is the Storage API's real
--     write (its service path, size known) or a client's own insert. Archived
--     scores' files count, and so do a deleted score's leftovers until they are
--     purged. An upsert does not count the object it replaces twice, and a
--     write that does not grow an object is never refused.
--   * Thumbnails keep only the latest revision: a new one puts every other
--     object in its folder on public.thumbnail_storage_cleanup, the ledger the
--     owner's client purges and that clears itself as objects go; a client
--     may write one only while its folder holds at most one other object, and
--     only for a revision between 0 and the score's content_rev (at most
--     1,000,000). Covers superseded before the migration are put on the ledger
--     by it.
--
-- Runs in one transaction and ROLLS BACK. psql only (it `\ir`s the
-- migration); it writes storage.objects rows the way the Storage API does,
-- and removes them with storage.allow_delete_query set.
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/storage_quota.sql
--
-- Every row should read `t`; the last line is `failures | total`.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('5a0a0000-0c0a-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
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
create function pg_temp.as_server() returns void language plpgsql as $f$
begin
perform set_config('role', 'postgres', true);
perform set_config('request.jwt.claims', '', true);
end $f$;
-- The Storage API's real write: on its service path, with the size it stored.
create function pg_temp.put(p_bucket text, p_name text, p_size bigint, p_owner int) returns text language sql immutable as $f$
select format('insert into storage.objects (bucket_id, name, owner, metadata) values (%L, %L, %L, %L)',
              p_bucket, p_name, pg_temp.u(p_owner), json_build_object('size', p_size)::text)
$f$;
-- The same, as an upsert (upload with upsert: true).
create function pg_temp.upsert(p_bucket text, p_name text, p_size bigint, p_owner int) returns text language sql immutable as $f$
select pg_temp.put(p_bucket, p_name, p_size, p_owner)
    || ' on conflict (bucket_id, name collate "C") where archived_at is null do update set metadata = excluded.metadata'
$f$;
-- A client's insert, as the Storage API's policy test makes it: no size yet.
create function pg_temp.client_put(p_bucket text, p_name text, p_owner int) returns text language sql immutable as $f$
select format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', p_bucket, p_name, pg_temp.u(p_owner))
$f$;
create function pg_temp.drop_object(p_bucket text, p_name text) returns text language sql immutable as $f$
select format('del' || 'ete from storage.objects where bucket_id = %L and name = %L', p_bucket, p_name)
$f$;
create function pg_temp.ledger(p_doc uuid) returns text[] language sql as $f$
select coalesce(array_agg(object_name order by object_name), '{}') from public.thumbnail_storage_cleanup where document_id = p_doc
$f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;
select set_config('storage.allow_delete_query', 'true', true);

-- ===========================================================================
-- The limits
-- ===========================================================================
delete from public.deployment_config;

select pg_temp.chk('01 unset: 500 MiB free, 5 GiB on every paid tier, the free quota for a student or anything else', $q$
    select public.storage_quota_bytes ('free') = 524288000
       and public.storage_quota_bytes ('personal') = 5368709120
       and public.storage_quota_bytes ('teacher') = 5368709120
       and public.storage_quota_bytes ('academy') = 5368709120
       and public.storage_quota_bytes ('student') = 524288000
       and public.storage_quota_bytes ('nonsense') = 524288000
       and public.storage_quota_bytes (null) = 524288000$q$);

insert into public.deployment_config (id, storage_quota_bytes, updated_by)
values (true, '{"free": 1000, "teacher": 5000}', 'proof');

select pg_temp.chk('02 configured: each tier named reads its value, the others keep their default', $q$
    select public.storage_quota_bytes ('free') = 1000
       and public.storage_quota_bytes ('teacher') = 5000
       and public.storage_quota_bytes ('academy') = 5368709120$q$);
select pg_temp.chk('03 a null column is the defaults again', $q$
    with x as (update public.deployment_config set storage_quota_bytes = null returning 1)
    select (select count(*) from x) = 1$q$);
select pg_temp.chk('03b ... and the entitling modes are untouched by it', $q$
    select public.entitling_billing_modes () = array['live', 'test']$q$);
select pg_temp.refused('04 an unknown tier is refused', $q$
    update public.deployment_config set storage_quota_bytes = '{"gold": 10}'$q$, '23514');
select pg_temp.refused('05 a zero quota is refused', $q$
    update public.deployment_config set storage_quota_bytes = '{"free": 0}'$q$, '23514');
select pg_temp.refused('06 a negative quota is refused', $q$
    update public.deployment_config set storage_quota_bytes = '{"free": -5}'$q$, '23514');
select pg_temp.refused('07 a quota written as a string is refused', $q$
    update public.deployment_config set storage_quota_bytes = '{"free": "1000"}'$q$, '23514');
select pg_temp.refused('08 a fractional quota is refused', $q$
    update public.deployment_config set storage_quota_bytes = '{"free": 10.5}'$q$, '23514');
select pg_temp.refused('09 anything but an object is refused', $q$
    update public.deployment_config set storage_quota_bytes = '[1000]'$q$, '23514');

update public.deployment_config set storage_quota_bytes = '{"free": 1000, "teacher": 5000}';

select pg_temp.as_user(1);
select pg_temp.refused('10 no client reads the quota or another owner''s usage', $q$
    select public.storage_owner_bytes (pg_temp.u(2))$q$, '42501');
select pg_temp.refused('11 ... nor the configuration', $q$select storage_quota_bytes from public.deployment_config$q$, '42501');
select pg_temp.as_server();

-- ===========================================================================
-- The quota
-- ===========================================================================
-- 1 is free (1000 bytes here) and owns score A (active) and B (archived); 2
-- has a Teacher plan (5000 bytes here) and owns score C; 3 owns nothing.
insert into auth.users (id, email)
select pg_temp.u(n), 'storage-quota-' || n || '@storage.test' from generate_series(1, 3) n;
insert into public.subscriptions (stripe_subscription_id, user_id, tier, status, current_period_end, mode, collection_method)
values ('sub_sq_2', pg_temp.u(2), 'teacher', 'active', now() + interval '30 days', 'live', 'charge_automatically');
insert into public.documents (id, owner_id, title, storage_path, content_rev) values
(pg_temp.u(10), pg_temp.u(1), 'A', pg_temp.u(10)::text || '/original.pdf', 0),
(pg_temp.u(11), pg_temp.u(1), 'B', pg_temp.u(11)::text || '/original.pdf', 0),
(pg_temp.u(20), pg_temp.u(2), 'C', pg_temp.u(20)::text || '/original.pdf', 0);
update public.documents set archived_at = now(), archived_reason = 'owner' where id = pg_temp.u(11);

\set a '5a0a0000-0c0a-4000-8000-000000000010'
\set b '5a0a0000-0c0a-4000-8000-000000000011'
\set c '5a0a0000-0c0a-4000-8000-000000000020'

select pg_temp.allowed('20 1 stores A''s PDF (600 of 1000 bytes)', pg_temp.put('scores', :'a' || '/original.pdf', 600, 1));
select pg_temp.allowed('21 and B''s, though B is archived (900)', pg_temp.put('scores', :'b' || '/original.pdf', 300, 1));
select pg_temp.chk('22 the usage counts both, the archived score''s too', $q$
    select public.storage_owner_bytes (pg_temp.u(1)) = 900$q$);
select pg_temp.refused('23 a 200-byte cover for A would take 1 past the quota (1100): refused, storage_quota_exceeded',
    pg_temp.put('thumbnails', :'a' || '/0.jpg', 200, 1), '42501', 'storage_quota_exceeded');
select pg_temp.allowed('24 a 100-byte one fits exactly (1000)', pg_temp.put('thumbnails', :'a' || '/0.jpg', 100, 1));
select pg_temp.refused('25 so at the quota, a client''s own insert (no size yet) is refused too',
    pg_temp.client_put('scores', :'a' || '/pre-import-original.pdf', 1), '42501', 'storage_quota_exceeded');
select pg_temp.allowed('26 an upsert shrinking A''s PDF to 550 counts the new size only, not old and new',
    pg_temp.upsert('scores', :'a' || '/original.pdf', 550, 1));
select pg_temp.chk('27 ... so the usage is 950', $q$select public.storage_owner_bytes (pg_temp.u(1)) = 950$q$);
select pg_temp.refused('28 an upsert that grows it past the quota is refused',
    pg_temp.upsert('scores', :'a' || '/original.pdf', 700, 1), '42501', 'storage_quota_exceeded');
select pg_temp.allowed('29 an upsert that grows it to exactly the quota is not',
    pg_temp.upsert('scores', :'a' || '/original.pdf', 600, 1));

update public.deployment_config set storage_quota_bytes = '{"free": 100, "teacher": 5000}';

select pg_temp.allowed('30 with the quota lowered under what 1 stores, rewriting an object no larger is still allowed',
    format('update storage.objects set metadata = %L where bucket_id = %L and name = %L',
           '{"size": 600}', 'scores', :'a' || '/original.pdf'));
select pg_temp.allowed('31 ... and so is shrinking it',
    format('update storage.objects set metadata = %L where bucket_id = %L and name = %L',
           '{"size": 500}', 'scores', :'a' || '/original.pdf'));
select pg_temp.refused('32 ... but not growing it', format('update storage.objects set metadata = %L where bucket_id = %L and name = %L',
           '{"size": 501}', 'scores', :'a' || '/original.pdf'), '42501', 'storage_quota_exceeded');

update public.deployment_config set storage_quota_bytes = '{"free": 1000, "teacher": 5000}';

select pg_temp.allowed('33 a Teacher owner stores 3000 bytes, more than the free quota', pg_temp.put('scores', :'c' || '/original.pdf', 3000, 2));
select pg_temp.refused('34 ... and is held to their own (3000 + 2500 > 5000)',
    pg_temp.put('scores', :'c' || '/pre-import-original.pdf', 2500, 2), '42501', 'storage_quota_exceeded');
select pg_temp.chk('35 one owner''s bytes are not another''s', $q$
    select public.storage_owner_bytes (pg_temp.u(2)) = 3000 and public.storage_owner_bytes (pg_temp.u(3)) = 0$q$);

-- 1 deletes A: its bytes stay until the client purges the folder.
select pg_temp.as_user(1);
select pg_temp.allowed('36 1 deletes score A', format('del' || 'ete from public.documents where id = %L', :'a'));
select pg_temp.as_server();
select pg_temp.chk('37 a deleted score''s files still count until they are purged', $q$
    select public.storage_owner_bytes (pg_temp.u(1)) = 900
       and public.storage_object_owner ('scores', '5a0a0000-0c0a-4000-8000-000000000010/original.pdf') = pg_temp.u(1)$q$);
select pg_temp.allowed('38 purging them', pg_temp.drop_object('scores', :'a' || '/original.pdf'));
select pg_temp.allowed('38b ... and its cover', pg_temp.drop_object('thumbnails', :'a' || '/0.jpg'));
select pg_temp.chk('39 ... gives the space back', $q$select public.storage_owner_bytes (pg_temp.u(1)) = 300$q$);
select pg_temp.chk('40 objects outside a score folder, or in other buckets, belong to no one here', $q$
    select public.storage_object_owner ('scores', 'not-a-uuid/original.pdf') is null
       and public.storage_object_owner ('avatars', '5a0a0000-0c0a-4000-8000-000000000011/x.png') is null
       and public.storage_object_owner ('scores', '5a0a0000-0c0a-4000-8000-0000000000ff/original.pdf') is null$q$);
select pg_temp.chk('41 the quota trigger serializes an owner''s writes and re-reads the usage under the lock', $q$
    select pg_get_functiondef('public.storage_objects_enforce_quota()'::regprocedure)
           ~ 'pg_advisory_xact_lock[^;]*cleffy\.storage_quota[\s\S]*storage_owner_bytes'
       and exists (select 1 from pg_trigger where tgname = 'storage_objects_enforce_quota'
                   and tgrelid = 'storage.objects'::regclass and not tgisinternal)$q$);

-- ===========================================================================
-- Thumbnails: the latest revision only
-- ===========================================================================
-- 3 owns score D at content_rev 3.
insert into public.documents (id, owner_id, title, storage_path, content_rev)
values (pg_temp.u(30), pg_temp.u(3), 'D', pg_temp.u(30)::text || '/original.pdf', 3);
\set d '5a0a0000-0c0a-4000-8000-000000000030'

select pg_temp.as_user(3);
select pg_temp.allowed('50 the owner publishes D''s cover at revision 0', pg_temp.client_put('thumbnails', :'d' || '/0.jpg', 3));
select pg_temp.chk('51 nothing is superseded yet', $q$select pg_temp.ledger (pg_temp.u(30)) = '{}'$q$);
select pg_temp.allowed('52 revision 1', pg_temp.client_put('thumbnails', :'d' || '/1.jpg', 3));
select pg_temp.chk('53 puts revision 0 on the cleanup ledger, for its owner', $q$
    select pg_temp.ledger (pg_temp.u(30)) = array['5a0a0000-0c0a-4000-8000-000000000030/0.jpg']
       and (select owner_id from public.thumbnail_storage_cleanup where document_id = pg_temp.u(30)) = pg_temp.u(3)$q$);
select pg_temp.chk('54 which the owner reads', $q$select count(*) = 1 from public.thumbnail_storage_cleanup$q$);
select pg_temp.refused('55 while revision 0 is still stored, revision 2 is refused (two other objects)',
    pg_temp.client_put('thumbnails', :'d' || '/2.jpg', 3), '42501');
select pg_temp.allowed('56 re-publishing revision 1 over itself (upsert) is not',
    pg_temp.client_put('thumbnails', :'d' || '/1.jpg', 3)
        || ' on conflict (bucket_id, name collate "C") where archived_at is null do update set metadata = excluded.metadata');
select pg_temp.allowed('57 the owner''s client removes the superseded revision',
    pg_temp.drop_object('thumbnails', :'d' || '/0.jpg'));
select pg_temp.chk('58 and its ledger row goes with it', $q$select pg_temp.ledger (pg_temp.u(30)) = '{}'$q$);
select pg_temp.allowed('59 now revision 2 lands', pg_temp.client_put('thumbnails', :'d' || '/2.jpg', 3));
select pg_temp.chk('60 superseding revision 1', $q$
    select pg_temp.ledger (pg_temp.u(30)) = array['5a0a0000-0c0a-4000-8000-000000000030/1.jpg']$q$);
select pg_temp.allowed('61 removing it', pg_temp.drop_object('thumbnails', :'d' || '/1.jpg'));
select pg_temp.refused('62 a revision the score has not reached (4 > content_rev 3) is refused',
    pg_temp.client_put('thumbnails', :'d' || '/4.jpg', 3), '42501');
select pg_temp.refused('63 ... and so is a move onto one',
    format('update storage.objects set name = %L where bucket_id = %L and name = %L', :'d' || '/4.jpg', 'thumbnails', :'d' || '/2.jpg'), '42501');
select pg_temp.as_server();
update public.documents set content_rev = 2000000 where id = pg_temp.u(30);
select pg_temp.as_user(3);
select pg_temp.allowed('64 at content_rev 2,000,000, revision 1,000,000 is allowed', pg_temp.client_put('thumbnails', :'d' || '/1000000.jpg', 3));
select pg_temp.allowed('64b (its predecessor removed)', pg_temp.drop_object('thumbnails', :'d' || '/2.jpg'));
select pg_temp.refused('65 ... but nothing past the cap of 1,000,000', pg_temp.client_put('thumbnails', :'d' || '/1000001.jpg', 3), '42501');

select pg_temp.as_user(1);
select pg_temp.chk('66 another user reads none of 3''s ledger', $q$select count(*) = 0 from public.thumbnail_storage_cleanup$q$);
select pg_temp.refused('67 ... and cannot write a ledger row', $q$
    insert into public.thumbnail_storage_cleanup (object_name, document_id, owner_id)
    values ('5a0a0000-0c0a-4000-8000-000000000030/1000000.jpg', pg_temp.u(30), pg_temp.u(1))$q$, '42501');
select pg_temp.as_user(3);
select pg_temp.refused('68 nor can the owner remove one by hand (the object''s removal does)',
    'del' || 'ete from public.thumbnail_storage_cleanup', '42501');
select pg_temp.as_server();
select pg_temp.allowed('69 the service role is not held to the revision cap',
    pg_temp.put('thumbnails', :'d' || '/2000000.jpg', 10, 3));
-- 20261022100900: the folder count holds in committed state, on every writer
-- (the Storage API's real write is the service role's).
select pg_temp.refused('69b ... but is held to the folder count (a third object)',
    pg_temp.put('thumbnails', :'d' || '/7.jpg', 10, 3), '42501', 'thumbnail_limit');

-- ===========================================================================
-- Covers superseded before the migration, and a rerun
-- ===========================================================================
-- Score E's folder holds revisions 0, 1 and 2 from before the migration, the
-- row naming 1 as published (2 an upload whose row update never landed);
-- score F's holds 0 and 1 and names none.
insert into public.documents (id, owner_id, title, storage_path, content_rev, thumb_rev)
values (pg_temp.u(40), pg_temp.u(3), 'E', pg_temp.u(40)::text || '/original.pdf', 2, 1),
       (pg_temp.u(41), pg_temp.u(3), 'F', pg_temp.u(41)::text || '/original.pdf', 1, null);
\set e '5a0a0000-0c0a-4000-8000-000000000040'
set local session_replication_role = replica;
insert into storage.objects (bucket_id, name, owner, metadata, created_at) values
('thumbnails', :'e' || '/0.jpg', pg_temp.u(3), '{"size": 1}', now() - interval '3 hours'),
('thumbnails', :'e' || '/1.jpg', pg_temp.u(3), '{"size": 1}', now() - interval '2 hours'),
('thumbnails', :'e' || '/2.jpg', pg_temp.u(3), '{"size": 1}', now() - interval '1 hour'),
('thumbnails', '5a0a0000-0c0a-4000-8000-000000000041/0.jpg', pg_temp.u(3), '{"size": 1}', now() - interval '2 hours'),
('thumbnails', '5a0a0000-0c0a-4000-8000-000000000041/1.jpg', pg_temp.u(3), '{"size": 1}', now() - interval '1 hour');
set local session_replication_role = origin;
create temp table t_ledger_before as select * from public.thumbnail_storage_cleanup;

\ir ../../supabase/migrations/20261022100800_storage_quota_and_thumbnail_lifecycle.sql

select pg_temp.chk('70 the migration puts everything but the published revision 1 on the ledger: 0, and 2 (no row names it)', $q$
    select pg_temp.ledger (pg_temp.u(40)) = array['5a0a0000-0c0a-4000-8000-000000000040/0.jpg',
                                                  '5a0a0000-0c0a-4000-8000-000000000040/2.jpg']$q$);
select pg_temp.chk('70b with nothing published, it keeps the newest', $q$
    select pg_temp.ledger (pg_temp.u(41)) = array['5a0a0000-0c0a-4000-8000-000000000041/0.jpg']$q$);
select pg_temp.chk('71 a rerun leaves every other ledger row as it was', $q$
    select not exists ((select * from t_ledger_before) except (select * from public.thumbnail_storage_cleanup))$q$);
select pg_temp.chk('72 ... each policy and trigger once', $q$
    select (select count(*) from pg_policy where polrelid = 'storage.objects'::regclass
            and polname in ('thumbnails_revision_insert', 'thumbnails_revision_update') and not polpermissive) = 2
       and (select count(*) from pg_trigger where tgrelid = 'storage.objects'::regclass and not tgisinternal
            and tgname in ('storage_objects_enforce_quota', 'thumbnails_record_superseded')) = 2$q$);
select pg_temp.chk('73 ... and the configured quota kept', $q$select public.storage_quota_bytes ('free') = 1000$q$);
select pg_temp.chk('74 the ledger is the owner''s to read and the service role''s to write, no one else''s', $q$
    select has_table_privilege('service_role', 'public.thumbnail_storage_cleanup', 'SELECT, INSERT, UPDATE, DELETE')
       and has_table_privilege('authenticated', 'public.thumbnail_storage_cleanup', 'SELECT')
       and not has_table_privilege('authenticated', 'public.thumbnail_storage_cleanup', 'INSERT, UPDATE, DELETE, TRUNCATE')
       and not has_table_privilege('anon', 'public.thumbnail_storage_cleanup', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
       and (select relrowsecurity from pg_class where oid = 'public.thumbnail_storage_cleanup'::regclass)$q$);

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
