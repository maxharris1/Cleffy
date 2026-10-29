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

-- Unrelated account (no shared memberships or organization). A PDF read must
-- not grant a library row, private upload, or annotations of another owner.
select set_config('request.jwt.claims', json_build_object('sub', :'other', 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.tap('13 unrelated account reads shared original', exists (select 1 from storage.objects where bucket_id = 'scores' and name = :'shared'));
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
select pg_temp.tap('26 anonymous Auth session reads shared original', exists (select 1 from storage.objects where bucket_id = 'scores' and name = :'shared'));
select pg_temp.tap('27 anonymous Auth session cannot read private original', not exists (select 1 from storage.objects where bucket_id = 'scores' and name = :'doc' || '/original.pdf'));
reset role;
set local role anon;
select pg_temp.tap('28 unauthenticated requests cannot read shared objects', not exists (select 1 from storage.objects where bucket_id = 'scores' and name = :'shared'));
reset role;

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
