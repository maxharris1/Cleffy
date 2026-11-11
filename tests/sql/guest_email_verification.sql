-- Behaviour proof for 20261010120200_guest_email_verification.sql: a guest's
-- emailed code is checked by check_guest_email_code -- right code for the
-- right address answers 'ok' and keeps the row for the attach; a wrong one
-- spends a try; the last allowed wrong try, an expired code and an absent one
-- each refuse and leave nothing redeemable -- and guest_email_taken answers a
-- boolean to the service role and to nobody else. Clients can neither read
-- the table nor call either function. The guard_guest_email trigger refuses
-- GoTrue (as supabase_auth_admin, when the role exists) any update that gives
-- a guest an address no code proved, in the order the user path and the
-- admin path take and in the reverse one, and lets the proven address on.
-- The 'ok' answer stamps verified_email / verified_at, the proof the trigger
-- reads.
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
-- Run updates on auth.users the way GoTrue does: one transaction, statement by
-- statement, as supabase_auth_admin (the role auth.users belongs to on hosted
-- projects) whenever this session may become it.
create function pg_temp.gotrue(p_steps text[]) returns boolean language plpgsql as $f$
declare v_step text;
begin
if pg_has_role(session_user, 'supabase_auth_admin', 'member') then
    perform set_config('role', 'supabase_auth_admin', true);
end if;
foreach v_step in array p_steps loop
    execute v_step;
end loop;
perform set_config('role', 'none', true);
return true;
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

-- ---- guard_guest_email: GoTrue cannot give a guest an unproven address
-- 6-17 guests. Codes for 9-17 are sent; 11-17 are then checked 'ok' (as
-- guest-email-confirm does) for the address named here; 13's proof is aged
-- past the 10-minute window. 9 and 10 never have theirs checked.
reset role;
insert into auth.users (id, email, is_anonymous)
select pg_temp.u(n), null, true from generate_series(6, 9) n;
insert into auth.users (id, email, is_anonymous) values
('9e5e1000-5ac0-4000-8000-000000000010', null, true),
('9e5e1000-5ac0-4000-8000-000000000011', null, true),
('9e5e1000-5ac0-4000-8000-000000000012', null, true),
('9e5e1000-5ac0-4000-8000-000000000013', null, true),
('9e5e1000-5ac0-4000-8000-000000000014', null, true),
('9e5e1000-5ac0-4000-8000-000000000015', null, true),
('9e5e1000-5ac0-4000-8000-000000000016', null, true),
('9e5e1000-5ac0-4000-8000-000000000017', null, true),
('9e5e1000-5ac0-4000-8000-000000000018', null, false);
create function pg_temp.g(n int) returns uuid language sql immutable as $f$ select ('9e5e1000-5ac0-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $f$;
grant execute on function pg_temp.g(int) to public;
insert into public.guest_email_verifications (user_id, email, code_hash, expires_at)
select pg_temp.g(n), 'guest' || n || '@guesttest.test', 'hash-' || n, now() + interval '15 minutes'
from generate_series(9, 17) n;
select pg_temp.as_service();
select pg_temp.chk('70 checked codes answer ok', $q$select bool_and(public.check_guest_email_code(pg_temp.g(n), 'guest' || n || '@guesttest.test', 'hash-' || n, 5) = 'ok')
    from generate_series(11, 17) n$q$);
reset role;
select pg_temp.chk('70b ... and stamp the proven address and time; unchecked codes have neither', $q$select bool_and(case when user_id in (pg_temp.g(9), pg_temp.g(10)) then verified_email is null and verified_at is null
    else verified_email = email and verified_at is not null end)
    from public.guest_email_verifications where user_id in (select pg_temp.g(n) from generate_series(9, 17) n)$q$);
update public.guest_email_verifications set verified_at = clock_timestamp() - interval '11 minutes' where user_id = pg_temp.g(13);

-- The user path (PUT /auth/v1/user, mailer_autoconfirm on) and the admin path
-- both clear is_anonymous, then set the email. QA's B4: a guest's own JWT,
-- someone else's address, nothing proven.
select pg_temp.refused('71 no proof, GoTrue''s order (is_anonymous cleared, then email set): refused', $q$select pg_temp.gotrue(array[
    'update auth.users set is_anonymous = false where id = pg_temp.g(6)',
    'update auth.users set email = ''owner-victim@guesttest.test'' where id = pg_temp.g(6)'])$q$, '42501');
select pg_temp.refused('72 no proof, the reverse order (email set, then is_anonymous cleared): refused', $q$select pg_temp.gotrue(array[
    'update auth.users set email = ''owner-victim@guesttest.test'' where id = pg_temp.g(7)',
    'update auth.users set is_anonymous = false where id = pg_temp.g(7)'])$q$, '42501');
select pg_temp.refused('73 no proof, both in one statement: refused', $q$select pg_temp.gotrue(array[
    'update auth.users set email = ''owner-victim@guesttest.test'', is_anonymous = false where id = pg_temp.g(8)'])$q$, '42501');
select pg_temp.refused('74 a row still marked anonymous gets no email either', $q$select pg_temp.gotrue(array[
    'update auth.users set email = ''owner-victim@guesttest.test'' where id = pg_temp.g(8)'])$q$, '42501');
select pg_temp.refused('75 a code sent but never checked proves nothing', $q$select pg_temp.gotrue(array[
    'update auth.users set is_anonymous = false where id = pg_temp.g(9)',
    'update auth.users set email = ''guest9@guesttest.test'' where id = pg_temp.g(9)'])$q$, '42501');
select pg_temp.refused('76 nor does it let the guest leave anonymity without an address', $q$select pg_temp.gotrue(array[
    'update auth.users set is_anonymous = false where id = pg_temp.g(10)'])$q$, '42501');
select pg_temp.refused('77 proof of one address does not attach another (GoTrue''s order)', $q$select pg_temp.gotrue(array[
    'update auth.users set is_anonymous = false where id = pg_temp.g(11)',
    'update auth.users set email = ''owner-victim@guesttest.test'' where id = pg_temp.g(11)'])$q$, '42501');
select pg_temp.refused('78 ... nor in the reverse order', $q$select pg_temp.gotrue(array[
    'update auth.users set email = ''owner-victim@guesttest.test'' where id = pg_temp.g(12)',
    'update auth.users set is_anonymous = false where id = pg_temp.g(12)'])$q$, '42501');
select pg_temp.refused('79 a proof older than 10 minutes is spent', $q$select pg_temp.gotrue(array[
    'update auth.users set is_anonymous = false where id = pg_temp.g(13)',
    'update auth.users set email = ''guest13@guesttest.test'' where id = pg_temp.g(13)'])$q$, '42501');
select pg_temp.chk('79b every refused guest is still an anonymous guest with no email', $q$select bool_and(is_anonymous and email is null)
    from auth.users where id in (select pg_temp.g(n) from generate_series(6, 13) n)$q$);

select pg_temp.chk('80 the proven address attaches in GoTrue''s order (the admin path guest-email-confirm takes)', $q$select pg_temp.gotrue(array[
    'update auth.users set email_confirmed_at = now() where id = pg_temp.g(14)',
    'update auth.users set is_anonymous = false where id = pg_temp.g(14)',
    'update auth.users set email = ''guest14@guesttest.test'' where id = pg_temp.g(14)'])$q$);
select pg_temp.chk('81 ... and in the reverse order', $q$select pg_temp.gotrue(array[
    'update auth.users set email = ''guest15@guesttest.test'' where id = pg_temp.g(15)',
    'update auth.users set is_anonymous = false where id = pg_temp.g(15)'])$q$);
select pg_temp.chk('82 ... and in one statement, in whatever case GoTrue keeps it', $q$select pg_temp.gotrue(array[
    'update auth.users set email = ''Guest16@GuestTest.test'', is_anonymous = false where id = pg_temp.g(16)'])$q$);
select pg_temp.chk('82b the three are registered accounts with their proven addresses', $q$select count(*) = 3 from auth.users
    where id in (pg_temp.g(14), pg_temp.g(15), pg_temp.g(16)) and not is_anonymous
    and lower(email) = 'guest' || right(id::text, 2) || '@guesttest.test'$q$);
select pg_temp.refused('83 an upgraded guest cannot swap the address later in the same request', $q$select pg_temp.gotrue(array[
    'update auth.users set email = ''owner-victim@guesttest.test'' where id = pg_temp.g(14)'])$q$, '42501');
select pg_temp.chk('84 the proof does not have to be spent at once: a guest may stay a guest', $q$select pg_temp.gotrue(array[
    'update auth.users set raw_user_meta_data = ''{"name": "x"}'' where id = pg_temp.g(17)'])$q$);
-- A new code asked for another address (start's upsert) replaces `email` but
-- cannot carry the old proof over to it.
update public.guest_email_verifications set email = 'other17@guesttest.test', code_hash = 'hash-17b' where user_id = pg_temp.g(17);
select pg_temp.refused('84b a proof stays with the address it proved, not the next one asked for', $q$select pg_temp.gotrue(array[
    'update auth.users set email = ''other17@guesttest.test'', is_anonymous = false where id = pg_temp.g(17)'])$q$, '42501');
select pg_temp.chk('84c a soft delete may obfuscate a guest''s email (it attaches nothing)', $q$select pg_temp.gotrue(array[
    'update auth.users set email = ''9e5e1000@deleted.invalid'', deleted_at = now() where id = pg_temp.g(10)'])$q$);
select pg_temp.chk('85 registered accounts are untouched: a changed address', $q$select pg_temp.gotrue(array[
    'update auth.users set email = ''owner2@guesttest.test'' where id = pg_temp.u(5)'])$q$);
select pg_temp.chk('86 ... and a first address on an account that had none', $q$select pg_temp.gotrue(array[
    'update auth.users set email = ''late@guesttest.test'' where id = pg_temp.g(18)'])$q$);

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
select pg_temp.chk('64 guard_guest_email: definer, search_path pinned empty, nobody may call it', $q$select p.prosecdef and p.proconfig @> array['search_path=""']
    and not has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute')
    and not has_function_privilege('service_role', p.oid, 'execute')
    and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
    from pg_proc p where p.oid = 'public.guard_guest_email()'::regprocedure$q$);
select pg_temp.chk('65 the guard is an enabled BEFORE UPDATE trigger on auth.users', $q$select t.tgenabled = 'O' and (t.tgtype & 2) = 2 and (t.tgtype & 16) = 16
    from pg_trigger t where t.tgrelid = 'auth.users'::regclass and t.tgname = 'guard_guest_email'$q$);
select pg_temp.chk('63 a deleted guest takes their pending code with them (the foreign key cascades)', $q$select confdeltype = 'c' from pg_constraint
    where conrelid = 'public.guest_email_verifications'::regclass and contype = 'f'$q$);

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
