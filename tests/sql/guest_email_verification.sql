-- Behaviour proof for 20261010120200_guest_email_verification.sql: a guest's
-- emailed code is checked by check_guest_email_code -- right code for the
-- right address answers 'ok' and keeps the row for the attach; a wrong one
-- spends a try; the last allowed wrong try, an expired code and an absent one
-- each refuse and leave nothing redeemable -- and guest_email_taken answers a
-- boolean to the service role and to nobody else. Clients can neither read
-- the table nor call either function.
--
-- Runs inside one transaction and ROLLS BACK -- nothing persists. Same harness
-- and reading as tests/sql/share_link_errors.sql:
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/guest_email_verification.sql
--
-- Every row of the result table should read `t`; the last line is
-- `failures | total`. No DROP / DELETE / TRUNCATE keyword, so the Supabase
-- MCP runs it without holding for confirmation (see tests/sql/README.md).
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('9e5e1000-5ac0-4000-8000-00000000000' || n)::uuid $f$;
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

-- 1-4 guests (anonymous, no email yet); 5 an existing account.
insert into auth.users (id, email, is_anonymous) values
(pg_temp.u(1), null, true),
(pg_temp.u(2), null, true),
(pg_temp.u(3), null, true),
(pg_temp.u(4), null, true),
(pg_temp.u(5), 'Owner@GuestTest.test', false);

-- ---- the service role stores pending codes (what guest-email-start does)
select pg_temp.as_service();
select pg_temp.chk('01 service role stores a pending code', $q$with ins as (
    insert into public.guest_email_verifications (user_id, email, code_hash, expires_at) values
    (pg_temp.u(1), 'ada@guesttest.test', 'hash-1', now() + interval '15 minutes'),
    (pg_temp.u(2), 'bob@guesttest.test', 'hash-2', now() + interval '15 minutes'),
    (pg_temp.u(3), 'cy@guesttest.test', 'hash-3', now() + interval '15 minutes')
    returning 1) select count(*) = 3 from ins$q$);
select pg_temp.refused('02 an address is stored lower-cased only', $q$insert into public.guest_email_verifications (user_id, email, code_hash, expires_at) values (pg_temp.u(4), 'Mixed@GuestTest.test', 'h', now() + interval '1 minute')$q$, '23514');

-- ---- check_guest_email_code
-- (A check and the row it changed are read in separate statements: a
-- statement's own subqueries see the snapshot from before the call.)
select pg_temp.chk('10 wrong code: mismatch', $q$select public.check_guest_email_code(pg_temp.u(1), 'ada@guesttest.test', 'wrong', 5) = 'mismatch'$q$);
select pg_temp.chk('10b ... and one try is spent', $q$select attempts = 1 from public.guest_email_verifications where user_id = pg_temp.u(1)$q$);
select pg_temp.chk('11 right code for another address: mismatch', $q$select public.check_guest_email_code(pg_temp.u(1), 'eve@guesttest.test', 'hash-1', 5) = 'mismatch'$q$);
select pg_temp.chk('12 right code and address (any case, padded): ok', $q$select public.check_guest_email_code(pg_temp.u(1), '  ADA@guesttest.test ', 'hash-1', 5) = 'ok'$q$);
select pg_temp.chk('12b ... and the row is kept for the attach to clear', $q$select exists (select 1 from public.guest_email_verifications where user_id = pg_temp.u(1))$q$);
select pg_temp.chk('13 one guest''s code is not another''s', $q$select public.check_guest_email_code(pg_temp.u(2), 'ada@guesttest.test', 'hash-1', 5) = 'mismatch'$q$);

select pg_temp.chk('20 tries 2-4 of 5 are mismatches', $q$select public.check_guest_email_code(pg_temp.u(2), 'bob@guesttest.test', 'x', 5) = 'mismatch'
    and public.check_guest_email_code(pg_temp.u(2), 'bob@guesttest.test', 'x', 5) = 'mismatch'
    and public.check_guest_email_code(pg_temp.u(2), 'bob@guesttest.test', 'x', 5) = 'mismatch'$q$);
select pg_temp.chk('21 the last allowed wrong try locks', $q$select public.check_guest_email_code(pg_temp.u(2), 'bob@guesttest.test', 'x', 5) = 'locked'$q$);
select pg_temp.chk('21b ... and removes the code', $q$select not exists (select 1 from public.guest_email_verifications where user_id = pg_temp.u(2))$q$);
select pg_temp.chk('22 after the lock even the right code finds nothing', $q$select public.check_guest_email_code(pg_temp.u(2), 'bob@guesttest.test', 'hash-2', 5) = 'missing'$q$);

update public.guest_email_verifications set expires_at = now() - interval '1 second' where user_id = pg_temp.u(3);
select pg_temp.chk('30 an expired code is refused, even the right one', $q$select public.check_guest_email_code(pg_temp.u(3), 'cy@guesttest.test', 'hash-3', 5) = 'expired'$q$);
select pg_temp.chk('30b ... and removed', $q$select not exists (select 1 from public.guest_email_verifications where user_id = pg_temp.u(3))$q$);
select pg_temp.chk('31 no code ever sent: missing', $q$select public.check_guest_email_code(pg_temp.u(4), 'dee@guesttest.test', 'h', 5) = 'missing'$q$);
select pg_temp.refused('32 nonsense arguments are an error, not an answer', $q$select public.check_guest_email_code(pg_temp.u(1), 'ada@guesttest.test', 'hash-1', 0)$q$, '22023');

-- ---- guest_email_taken
select pg_temp.chk('40 an address with an account is taken (any case, padded)', $q$select public.guest_email_taken(' owner@guesttest.TEST ')$q$);
select pg_temp.chk('41 an unknown address is not', $q$select not public.guest_email_taken('nobody@guesttest.test')$q$);
select pg_temp.chk('42 null and blank are not', $q$select not public.guest_email_taken(null) and not public.guest_email_taken('  ')$q$);

-- ---- clients get nothing
reset role;
select pg_temp.as_user(1);
select pg_temp.refused('50 a guest cannot read the pending codes', $q$select count(*) from public.guest_email_verifications$q$, '42501');
select pg_temp.refused('51 a guest cannot check a code directly', $q$select public.check_guest_email_code(pg_temp.u(1), 'ada@guesttest.test', 'hash-1', 5)$q$, '42501');
select pg_temp.refused('52 a signed-in caller cannot ask whether an address has an account', $q$select public.guest_email_taken('owner@guesttest.test')$q$, '42501');
reset role;
select pg_temp.as_anon();
select pg_temp.refused('53 anon cannot read the pending codes', $q$select count(*) from public.guest_email_verifications$q$, '42501');
select pg_temp.refused('54 anon cannot ask whether an address has an account', $q$select public.guest_email_taken('owner@guesttest.test')$q$, '42501');
reset role;
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(1), 'role', 'authenticated')::text, true);
select pg_temp.refused('55 the definer checks its caller: without a service-role JWT it refuses even with EXECUTE', $q$select public.guest_email_taken('owner@guesttest.test')$q$, '42501');
select set_config('request.jwt.claims', '', true);

-- ---- the objects themselves
select pg_temp.chk('60 guest_email_taken: definer, search_path pinned empty, service_role only', $q$select p.prosecdef and p.proconfig @> array['search_path=""']
    and has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute')
    and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
    from pg_proc p where p.oid = 'public.guest_email_taken(text)'::regprocedure$q$);
select pg_temp.chk('61 check_guest_email_code: invoker, search_path pinned, service_role only', $q$select not p.prosecdef and p.proconfig @> array['search_path=public']
    and has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute')
    and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
    from pg_proc p where p.oid = 'public.check_guest_email_code(uuid,text,text,int)'::regprocedure$q$);
select pg_temp.chk('62 RLS on, no policies, no client grants on the table', $q$select c.relrowsecurity
    and not exists (select 1 from pg_policy where polrelid = c.oid)
    and not has_table_privilege('authenticated', c.oid, 'select,insert,update')
    and not has_table_privilege('anon', c.oid, 'select,insert,update')
    from pg_class c where c.oid = 'public.guest_email_verifications'::regclass$q$);
select pg_temp.chk('63 a deleted guest takes their pending code with them (ON DELETE CASCADE)', $q$select confdeltype = 'c' from pg_constraint
    where conrelid = 'public.guest_email_verifications'::regclass and contype = 'f'$q$);

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
