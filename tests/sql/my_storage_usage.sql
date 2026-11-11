-- my_storage_usage() (20261022140600, decision 50(3)): the signed-in owner
-- reads their own storage use and cap, the figures the quota itself uses, and
-- nobody else's. LOCAL STACK or the dev branch project only. One transaction,
-- ROLLED BACK; the last line is `failures | total`.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('5a0f0000-0c0f-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
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
create function pg_temp.as_anon() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
perform set_config('role', 'anon', true);
end $f$;
create function pg_temp.as_postgres() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', '', true);
perform set_config('role', 'none', true);
end $f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- 1 (free) owns a score with 300 + 20 bytes stored; 2 (a Teacher plan) owns one with 5000.
insert into auth.users (id, email) values (pg_temp.u(1), 'msu-1@storage.test'), (pg_temp.u(2), 'msu-2@storage.test');
insert into public.subscriptions (stripe_subscription_id, user_id, tier, status, current_period_end, mode, collection_method)
values ('sub_msu_2', pg_temp.u(2), 'teacher', 'active', now() + interval '30 days', 'live', 'charge_automatically');
insert into public.documents (id, owner_id, title, storage_path) values
(pg_temp.u(10), pg_temp.u(1), 'One', pg_temp.u(10)::text || '/original.pdf'),
(pg_temp.u(20), pg_temp.u(2), 'Two', pg_temp.u(20)::text || '/original.pdf');
insert into storage.objects (bucket_id, name, owner, metadata) values
('scores', pg_temp.u(10)::text || '/original.pdf', pg_temp.u(1), '{"size": 300}'),
('thumbnails', pg_temp.u(10)::text || '/0.jpg', pg_temp.u(1), '{"size": 20}'),
('scores', pg_temp.u(20)::text || '/original.pdf', pg_temp.u(2), '{"size": 5000}');

-- The caps as this stack has them (deployment_config may set its own).
create temp table t_caps as select public.storage_quota_bytes ('free') as free, public.storage_quota_bytes ('teacher') as teacher;
grant select on t_caps to authenticated;

select pg_temp.as_user(1);
select pg_temp.chk('01 the owner reads their own use, both buckets, and their plan''s cap', $q$
    select public.my_storage_usage () = jsonb_build_object('used_bytes', 320, 'limit_bytes', (select free from t_caps))$q$);
select pg_temp.as_postgres();
select pg_temp.chk('02 ... the very figures the quota uses', $q$
    select public.storage_owner_bytes (pg_temp.u(1)) = 320
       and public.resolve_entitlements (pg_temp.u(1)) ->> 'tier' = 'free'
       and public.storage_quota_bytes ('free') > 0$q$);

select pg_temp.as_user(2);
select pg_temp.chk('03 another owner reads only theirs, on their own plan''s cap', $q$
    select public.my_storage_usage () = jsonb_build_object('used_bytes', 5000, 'limit_bytes', (select teacher from t_caps))$q$);

select pg_temp.as_anon();
select pg_temp.refused('04 a caller without a session cannot ask', $q$select public.my_storage_usage ()$q$, '42501');
select pg_temp.as_postgres();
select pg_temp.refused('05 nor can a session with no user (no auth.uid())', $q$select public.my_storage_usage ()$q$, '42501');

select pg_temp.chk('06 it takes no argument, so it can name nobody else; signed-in users and the service role may call it, anon may not', $q$
    select to_regprocedure('public.my_storage_usage()') is not null
       and not exists (select 1 from pg_proc p where p.proname = 'my_storage_usage' and p.pronargs > 0)
       and has_function_privilege('authenticated', 'public.my_storage_usage()', 'execute')
       and has_function_privilege('service_role', 'public.my_storage_usage()', 'execute')
       and not has_function_privilege('anon', 'public.my_storage_usage()', 'execute')$q$);

select name, ok, coalesce(detail, '') from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
