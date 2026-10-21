-- Behaviour proof for the launch-checkout fix pass (Codex review of #62):
--
--   20261020160100_checkout_attempt_replay_inputs.sql -- a staged checkout
--   attempt keeps the consent and parameter fingerprint its replay must
--   reproduce, and loses them with the key.
--
-- Runs inside one transaction and ROLLS BACK -- nothing persists. Same harness
-- and reading as tests/sql/checkout_consents.sql:
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/launch_checkout_fixes.sql
--
-- Every row of the result table should read `t`; the last line is
-- `failures | total`. Run it against a local or branch database.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create temp table t_attempts (label text primary key, holder uuid);
grant all on t_attempts to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('f1c5e000-5ac0-4000-8000-00000000000' || n)::uuid $f$;
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
create function pg_temp.as_service() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
perform set_config('role', 'service_role', true);
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
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

insert into auth.users (id, email, is_anonymous) values (pg_temp.u(1), 'replay@checkoutfix.test', false);

-- ===========================================================================
-- 1. A staged attempt keeps its replay inputs, and loses them with the key
-- ===========================================================================
select pg_temp.as_service();
insert into t_attempts
select 'first', holder from public.begin_checkout_attempt (pg_temp.u(1), 'live', interval '5 minutes');

select pg_temp.chk('01 staging stores the consent id and the parameter fingerprint',
$q$select public.stage_checkout_attempt (
    p_user => pg_temp.u(1), p_mode => 'live',
    p_holder => (select holder from t_attempts where label = 'first'),
    p_attempt_id => '33333333-0000-4000-8000-000000000001', p_price_id => 'price_teacher_annual|usd',
    p_consent_id => '44444444-0000-4000-8000-000000000001', p_params_hash => repeat('a', 64)
)$q$);

-- The isolate dies holding the lease; the next request takes it over once stale.
update public.checkout_attempts set claimed_at = now() - interval '1 hour' where user_id = pg_temp.u(1);

select pg_temp.chk('02 the attempt after a death reads both back beside the key',
$q$select attempt_id = '33333333-0000-4000-8000-000000000001'
      and session_id is null
      and consent_id = '44444444-0000-4000-8000-000000000001'
      and params_hash = repeat('a', 64)
   from public.begin_checkout_attempt (pg_temp.u(1), 'live', interval '5 minutes')$q$);

-- (Each write and the read of its effect are separate statements: a subquery
-- in the same statement reads the snapshot from before the call.)
select pg_temp.chk('03 a five-argument stage (a function deployed before the migration) still stages',
$q$select public.stage_checkout_attempt (
    pg_temp.u(1), 'live',
    (select holder from public.checkout_attempts where user_id = pg_temp.u(1)),
    '33333333-0000-4000-8000-000000000002', 'price_teacher_annual|usd'
)$q$);
select pg_temp.chk('04 ... and stages no replay inputs, so that key is never replayed',
$q$select consent_id is null and params_hash is null and attempt_id = '33333333-0000-4000-8000-000000000002'
   from public.checkout_attempts where user_id = pg_temp.u(1)$q$);

select pg_temp.chk('05 re-staging with inputs',
$q$select public.stage_checkout_attempt (
    p_user => pg_temp.u(1), p_mode => 'live',
    p_holder => (select holder from public.checkout_attempts where user_id = pg_temp.u(1)),
    p_attempt_id => '33333333-0000-4000-8000-000000000003', p_price_id => 'price_teacher_annual|usd',
    p_consent_id => '44444444-0000-4000-8000-000000000003', p_params_hash => repeat('b', 64)
)$q$);
select pg_temp.chk('06 then recording the session',
$q$select public.finish_checkout_attempt (
    pg_temp.u(1), 'live',
    (select holder from public.checkout_attempts where user_id = pg_temp.u(1)),
    '33333333-0000-4000-8000-000000000003', 'price_teacher_annual|usd', 'cs_test_recorded'
)$q$);
select pg_temp.chk('07 ... clears the replay inputs with the key',
$q$select consent_id is null and params_hash is null and session_id = 'cs_test_recorded' and holder is null
   from public.checkout_attempts where user_id = pg_temp.u(1)$q$);

select pg_temp.as_user(1);
select pg_temp.refused('08 a signed-in client cannot stage a checkout attempt',
$q$select public.stage_checkout_attempt (pg_temp.u(1), 'live', gen_random_uuid(), gen_random_uuid(), 'x', gen_random_uuid(), 'x')$q$,
'42501');
select pg_temp.refused('09 nor begin one',
$q$select * from public.begin_checkout_attempt (pg_temp.u(1), 'live', interval '5 minutes')$q$, '42501');
select pg_temp.as_anon();
select pg_temp.refused('10 nor can anon',
$q$select public.stage_checkout_attempt (pg_temp.u(1), 'live', gen_random_uuid(), gen_random_uuid(), 'x', gen_random_uuid(), 'x')$q$,
'42501');

reset role;
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
