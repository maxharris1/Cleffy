-- Local Supabase only. Rolled-back pgTAP/RLS proof, adapted to sql-proof.sh's
-- results table so CI runs it automatically with every other tests/sql proof.
\set ON_ERROR_STOP on
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();
create temp table t_results (name text, ok boolean, detail text);
create function pg_temp.tap(p_name text, p_ok boolean) returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
    insert into t_results values (p_name, coalesce(p_ok, false), extensions.ok(coalesce(p_ok, false), p_name));
end;
$$;
create function pg_temp.refused(p_name text, p_sql text, p_state text) returns void
language plpgsql as $$
begin
    execute p_sql;
    perform pg_temp.tap(p_name, false);
exception when others then
    perform pg_temp.tap(p_name, sqlstate = p_state);
end;
$$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;
select set_config('storage.allow_delete_query', 'true', true);

\set owner 'ab281200-0000-4000-8000-000000000001'
\set other 'ab281200-0000-4000-8000-000000000002'
\set guest 'ab281200-0000-4000-8000-000000000003'
\set doc 'ab281200-0000-4000-8000-000000000010'
\set doc2 'ab281200-0000-4000-8000-000000000011'
\set token 'ab281200-0000-4000-8000-000000000020'
\set token2 'ab281200-0000-4000-8000-000000000021'
\set shared '00000000-0000-0000-0000-000000000000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf'
\set orphan '00000000-0000-0000-0000-000000000000/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.pdf'

insert into auth.users (id, email, is_anonymous) values
    (:'owner', 'imslp-owner@cache.test', false),
    (:'other', 'imslp-other@cache.test', false), (:'guest', null, true);
insert into public.documents (id, owner_id, title, storage_path) values
    (:'doc', :'owner', 'Shared score, private library', :'shared'),
    (:'doc2', :'other', 'Another library, same original', :'shared');
insert into storage.objects (bucket_id, name, metadata) values
    ('scores', :'shared', '{"size": 100, "mimetype": "application/pdf"}'),
    ('scores', :'orphan', '{"size": 100, "mimetype": "application/pdf"}'),
    ('scores', :'doc' || '/original.pdf', '{"size": 50, "mimetype": "application/pdf"}');

insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
values ('ab281200-0000-4000-8000-000000000030', :'doc', 0, 'text', '#000000',
    '{"x":0.1,"y":0.1,"size":0.02,"text":"private annotation"}', :'owner');

select pg_temp.tap('01 scores bucket is private', (select not public from storage.buckets where id = 'scores'));
select pg_temp.tap('02 first file lease acquired', public.claim_imslp_pdf('51037', :'token'));
select pg_temp.tap('03 another worker cannot take a live file lease', not public.claim_imslp_pdf('51037', :'token2'));
select pg_temp.refused('04 wrong token cannot publish',
    format('select public.publish_imslp_pdf(%L::jsonb, %L::uuid)', jsonb_build_object('imslp_file_id', '51037'), :'token2'), '40001');
select pg_temp.refused('05 missing object cannot publish', format(
    'select public.publish_imslp_pdf(%L::jsonb, %L::uuid)',
    jsonb_build_object('imslp_file_id', '51037', 'storage_path', 'missing.pdf', 'size', 100), :'token'), '22023');
select pg_temp.tap('06 failed publish leaves cache empty', not exists (select 1 from public.imslp_pdf_cache));
select pg_temp.refused('07 incomplete size cannot publish', format(
    'select public.publish_imslp_pdf(%L::jsonb, %L::uuid)',
    jsonb_build_object('imslp_file_id', '51037', 'storage_path', :'shared', 'size', 101), :'token'), '22023');

select public.publish_imslp_pdf(jsonb_build_object(
    'imslp_file_id', '51037', 'filename', 'IMSLP51037-score.pdf',
    'sha256', repeat('a', 64), 'storage_path', :'shared', 'size', 100,
    'fetched_at', now(), 'work_title', 'Sonata', 'license_label', 'Public Domain',
    'provenance', jsonb_build_object('source_url', 'https://imslp.org/wiki/Sonata',
        'source_filename', 'IMSLP51037-score.pdf', 'source_license', 'Public Domain',
        'source_attribution', jsonb_build_object('source', 'imslp', 'work', 'Sonata'))
), :'token');
select pg_temp.tap('08 complete object published once', (select count(*) = 1 from public.imslp_pdf_cache));
select public.release_imslp_pdf('51037', :'token2');
select pg_temp.tap('09 wrong token cannot release a live lease', exists (select 1 from public.imslp_pdf_claims where imslp_file_id = '51037'));
update public.imslp_pdf_claims set expires_at = clock_timestamp() - interval '1 second' where imslp_file_id = '51037';
select pg_temp.tap('10 expired lease can be recovered', public.claim_imslp_pdf('51037', :'token2'));
select public.release_imslp_pdf('51037', :'token');
select pg_temp.tap('11 stale holder cannot remove successor', (select token = :'token2'::uuid from public.imslp_pdf_claims where imslp_file_id = '51037'));
select pg_temp.refused('12 stale worker cannot publish',
    format('select public.publish_imslp_pdf(%L::jsonb, %L::uuid)', jsonb_build_object('imslp_file_id', '51037'), :'token'), '40001');

-- Explicit license restrictions revoke reads; license-cache presence is not required.
insert into public.imslp_file_licenses (filename, work_title, license, downloadable)
values ('IMSLP51037-score.pdf', 'Sonata', 'public_domain', true);

-- Unrelated account (no shared memberships or organization). A PDF read must
-- not grant a library row, private upload, or annotations of another owner.
select set_config('request.jwt.claims', json_build_object('sub', :'other', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.tap('13 another library owner reads its referenced shared original', exists (select 1 from storage.objects where bucket_id = 'scores' and name = :'shared'));
select pg_temp.tap('14 unrelated account cannot read private original', not exists (select 1 from storage.objects where bucket_id = 'scores' and name = :'doc' || '/original.pdf'));
select pg_temp.tap('15 unrelated account cannot read another library', not exists (select 1 from public.documents where id = :'doc'));
select pg_temp.tap('16 unrelated account cannot read another annotations', not exists (select 1 from public.annotations where document_id = :'doc'));
select pg_temp.tap('17 uncommitted/orphan objects are not shared', not exists (select 1 from storage.objects where bucket_id = 'scores' and name = :'orphan'));
select pg_temp.refused('18 cache metadata is service-only', 'select * from public.imslp_pdf_cache', '42501');
select pg_temp.refused('19 claims are service-only', 'select * from public.imslp_pdf_claims', '42501');
select pg_temp.refused('20 clients cannot claim', format('select public.claim_imslp_pdf(''51037'', %L::uuid)', :'token'), '42501');
with gone as (delete from storage.objects where bucket_id = 'scores' and name = :'shared' returning 1)
select pg_temp.tap('21 client deletion of shared object affects no rows', (select count(*) = 0 from gone));
with changed as (update storage.objects set metadata = '{}' where bucket_id = 'scores' and name = :'shared' returning 1)
select pg_temp.tap('22 client update of shared object affects no rows', (select count(*) = 0 from changed));
select pg_temp.refused('23 client cannot create shared objects', format('insert into storage.objects(bucket_id, name) values (''scores'', %L)', :'shared'), '42501');
select pg_temp.refused('24 owner cannot repoint to another PDF', format('update public.documents set storage_path = %L where id = %L::uuid', :'orphan', :'doc2'), '42501');
select pg_temp.refused('25 another owner cannot detach this score', format('select public.detach_imslp_pdf(%L::uuid, 0)', :'doc'), '42501');

reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'guest', 'role', 'authenticated', 'is_anonymous', true)::text, true);
set local role authenticated;
select pg_temp.tap('26 anonymous nonmember cannot read shared original', not exists (select 1 from storage.objects where bucket_id = 'scores' and name = :'shared'));
select pg_temp.tap('27 anonymous Auth session cannot read private original', not exists (select 1 from storage.objects where bucket_id = 'scores' and name = :'doc' || '/original.pdf'));
select pg_temp.tap('26a anonymous session cannot import', not public.can_import_imslp());
select pg_temp.tap('26b anonymous listing cannot enumerate the shared cache',
    (select count(*) = 0 from storage.objects where bucket_id = 'scores'
      and name like '00000000-0000-0000-0000-000000000000/%'));
select pg_temp.refused('26c anonymous session cannot query cache presence RPC',
    format('select public.is_shared_imslp_pdf(%L)', :'shared'), '42501');
select pg_temp.refused('26d anonymous session cannot insert a shared document',
    format('insert into public.documents(id, owner_id, title, storage_path) values (%L, %L, %L, %L)',
        'ab281200-0000-4000-8000-000000000099', :'guest', 'Forbidden', :'shared'), '42501');
reset role;
set local role anon;
select pg_temp.tap('28 unauthenticated requests cannot read shared objects', not exists (select 1 from storage.objects where bucket_id = 'scores' and name = :'shared'));
reset role;

-- Membership, revocation, takedown, license and RPC-oracle regressions.
select pg_temp.tap('28a cache presence RPC revoked for every client role',
    not has_function_privilege('authenticated', 'public.is_shared_imslp_pdf(text)', 'execute')
    and not has_function_privilege('anon', 'public.is_shared_imslp_pdf(text)', 'execute'));
select pg_temp.tap('28b clients cannot create policy helpers',
    not has_schema_privilege('authenticated', 'imslp_private', 'create'));
insert into public.document_members(document_id, user_id, role) values (:'doc', :'guest', 'viewer');
select set_config('request.jwt.claims', json_build_object('sub', :'guest', 'role', 'authenticated', 'is_anonymous', true)::text, true);
set local role authenticated;
select pg_temp.tap('28c anonymous member can read the score it joined', exists (
    select 1 from storage.objects where bucket_id = 'scores' and name = :'shared'));
select pg_temp.refused('28d viewer cannot detach', format('select public.commit_pdf_replacement(%L, 0)', :'doc'), '42501');
reset role;
delete from public.document_members where document_id = :'doc' and user_id = :'guest';
set local role authenticated;
select pg_temp.tap('28e revoked membership loses shared bytes', not exists (
    select 1 from storage.objects where bucket_id = 'scores' and name = :'shared'));
reset role;

-- The same member as a provisioned student must lose access on session revocation.
insert into public.managed_students(id, teacher_id, student_user_id, display_name, login_code_hash)
values ('ab281200-0000-4000-8000-000000000040', :'owner', :'guest', 'Cache student', 'test-only');
insert into public.document_members(document_id, user_id, role) values (:'doc', :'guest', 'editor');
select set_config('request.jwt.claims', json_build_object('sub', :'guest', 'role', 'authenticated',
    'iat', extract(epoch from now())::bigint, 'app_metadata', json_build_object('user_type', 'student'))::text, true);
set local role authenticated;
select pg_temp.tap('28f student member reads before revocation', exists (
    select 1 from storage.objects where bucket_id = 'scores' and name = :'shared'));
select pg_temp.tap('28g student cannot import', not public.can_import_imslp());
select pg_temp.refused('28h editor cannot detach', format('select public.commit_pdf_replacement(%L, 0)', :'doc'), '42501');
reset role;
update public.managed_students set access_revoked_at = now() + interval '1 minute' where student_user_id = :'guest';
set local role authenticated;
select pg_temp.tap('28i revoked student loses shared bytes despite membership', not exists (
    select 1 from storage.objects where bucket_id = 'scores' and name = :'shared'));
reset role;

select set_config('request.jwt.claims', json_build_object('sub', :'owner', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.tap('28j registered owner may import', public.can_import_imslp());
select pg_temp.refused('28k registered client cannot probe cache presence', format('select public.is_shared_imslp_pdf(%L)', :'shared'), '42501');
select pg_temp.refused('28l shared rows reject legacy direct revision bumps',
    format('update public.documents set content_rev = content_rev + 1 where id = %L', :'doc'), '42501');
select pg_temp.refused('28m registered owner cannot insert a shared reference',
    format('insert into public.documents(id, owner_id, title, storage_path) values (%L, %L, %L, %L)',
        'ab281200-0000-4000-8000-000000000099', :'owner', 'Forbidden', :'shared'), '42501');
reset role;
delete from public.imslp_file_licenses where filename = 'IMSLP51037-score.pdf';
set local role authenticated;
select pg_temp.tap('28n missing clearance preserves existing shared reads', exists (
    select 1 from storage.objects where bucket_id = 'scores' and name = :'shared'));
reset role;
-- A caller's alias is not a licensing fact about the cached canonical file.
insert into public.imslp_file_licenses(filename, work_title, license, downloadable)
values ('IMSLP51037-attacker.pdf', 'Unrelated work', 'unknown', false);
set local role authenticated;
select pg_temp.tap('28n2 an unlisted caller alias cannot disable the canonical score', exists (
    select 1 from storage.objects where bucket_id = 'scores' and name = :'shared'));
reset role;
insert into public.imslp_file_licenses(filename, work_title, license, downloadable)
values ('IMSLP51037-score.pdf', 'Sonata', 'non-pd', false);
set local role authenticated;
select pg_temp.tap('28o restricted license blocks shared reads', not exists (
    select 1 from storage.objects where bucket_id = 'scores' and name = :'shared'));
reset role;
update public.imslp_file_licenses set downloadable = true where filename = 'IMSLP51037-score.pdf';
-- A second file id for the same hash cannot sidestep a content block.
insert into public.imslp_pdf_cache(imslp_file_id, filename, sha256, storage_path, size,
    fetched_at, work_title, license_label, provenance)
select '51038', 'IMSLP51038-alias.pdf', sha256, storage_path, size, fetched_at,
    work_title, license_label, provenance from public.imslp_pdf_cache where imslp_file_id = '51037';
insert into public.imslp_file_licenses(filename, work_title, license, downloadable)
values ('IMSLP51038-alias.pdf', 'Sonata', 'public_domain', true);
-- Uploader-specific removals still deny that document's members, but never
-- blacklist the public-domain original in somebody else's library.
insert into public.content_takedowns(document_id, uploader_id, action, ground, legal_basis, facts)
values (:'doc', :'owner', 'remove', 'terms', 'Test uploader terms removal', 'Test document scope');
set local role authenticated;
select pg_temp.tap('28o2 terms removal denies the removed document owner', not exists (
    select 1 from storage.objects where bucket_id = 'scores' and name = :'shared'));
reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'other', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.tap('28o3 terms removal preserves another library', exists (
    select 1 from storage.objects where bucket_id = 'scores' and name = :'shared'));
reset role;
update public.content_takedowns set ground = 'illegal' where document_id = :'doc';
select set_config('request.jwt.claims', json_build_object('sub', :'owner', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.tap('28o3a illegal-conduct removal denies the removed document owner', not exists (
    select 1 from storage.objects where bucket_id = 'scores' and name = :'shared'));
reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'other', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.tap('28o4 uploader illegal-conduct removal preserves another library', exists (
    select 1 from storage.objects where bucket_id = 'scores' and name = :'shared'));
reset role;
select pg_temp.tap('28o5 uploader takedowns do not block future cache hits', public.is_shared_imslp_pdf(:'shared'));
update public.content_takedowns set lifted_at = now() where document_id = :'doc';
select set_config('request.jwt.claims', json_build_object('sub', :'owner', 'role', 'authenticated')::text, true);
insert into public.content_takedowns(document_id, uploader_id, action, ground, legal_basis, facts)
values (:'doc', :'owner', 'remove', 'copyright', 'Test copyright removal', 'Test shared cache block');
set local role authenticated;
select pg_temp.tap('28p removed document owner loses shared bytes', not exists (
    select 1 from storage.objects where bucket_id = 'scores' and name = :'shared'));
reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'other', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.tap('28q takedown blocks bytes through another library reference', not exists (
    select 1 from storage.objects where bucket_id = 'scores' and name = :'shared'));
select pg_temp.refused('28q2 owner cannot commit a missing replacement', format('select public.commit_pdf_replacement(%L, 0)', :'doc2'), '22023');
reset role;
select pg_temp.tap('28q3 blocked bytes are not republished under another file id',
    public.claim_imslp_pdf('51039', :'token'));
select pg_temp.refused('28q4 publication cannot sidestep a blocked hash', format(
    'select public.publish_imslp_pdf(%L::jsonb, %L::uuid)',
    (select to_jsonb(c) || jsonb_build_object('imslp_file_id', '51039', 'filename', 'IMSLP51039-alias.pdf')
     from public.imslp_pdf_cache c where imslp_file_id = '51037'), :'token'), '42501');
select pg_temp.tap('28r takedown persistently blocks future cache hits',
    (select blocked_at is not null from public.imslp_pdf_cache where imslp_file_id = '51037'));
update public.content_takedowns set lifted_at = now() where document_id = :'doc';
select pg_temp.tap('28s lifting one document does not automatically relicense shared bytes',
    (select blocked_at is not null from public.imslp_pdf_cache where imslp_file_id = '51037'));
-- Operator review restoring availability, solely for the remaining replacement proof.
update public.imslp_pdf_cache set blocked_at = null where imslp_file_id = '51038';
select pg_temp.tap('28t clearing an alias does not bypass a blocked hash', not public.is_shared_imslp_pdf(:'shared'));
update public.imslp_pdf_cache set blocked_at = null where storage_path = :'shared';

select set_config('request.jwt.claims', json_build_object('sub', :'owner', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.refused('29 stale replacement revision refuses detach', format('select public.detach_imslp_pdf(%L::uuid, 99)', :'doc'), '40001');
select pg_temp.tap('30 owner detaches to private replacement', (public.detach_imslp_pdf(:'doc', 0)).storage_path = :'doc' || '/original.pdf');
select pg_temp.tap('31 detach bumps revision', (select content_rev = 1 from public.documents where id = :'doc'));
reset role;
select pg_temp.tap('32 detach keeps shared mapping and object', exists (select 1 from public.imslp_pdf_cache where imslp_file_id = '51037') and exists (select 1 from storage.objects where name = :'shared' and bucket_id = 'scores'));
delete from public.documents where id = :'doc2';
select pg_temp.tap('33 deleting final library reference keeps cache', exists (select 1 from storage.objects where name = :'shared' and bucket_id = 'scores'));
select * from finish();
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
