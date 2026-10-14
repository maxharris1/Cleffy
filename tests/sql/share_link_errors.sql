-- Behaviour proof for 20261009120200_share_link_errors_and_peek.sql: a dead
-- link is refused with SQLSTATE PT404 (PostgREST: HTTP 404) and a stable
-- detail code, redemption otherwise behaves exactly as before, and
-- peek_share_link answers {valid, role} -- the same {false, null} for every
-- kind of dead link -- to anon and signed-in callers alike, writing nothing.
--
-- Runs inside one transaction and ROLLS BACK — nothing persists. Same harness
-- and reading as supabase/sql-tests/sharing_access_control.sql:
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/share_link_errors.sql
--
-- Every row of the result table should read `t`; the last line is
-- `failures | total`. No DROP / DELETE / TRUNCATE keyword, so the Supabase
-- MCP runs it without holding for confirmation (see tests/sql/README.md).
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('5e7a1000-5ac0-4000-8000-00000000000' || n)::uuid $f$;
create function pg_temp.d() returns uuid language sql immutable as $f$ select '5e7a10d0-5ac0-4000-8000-000000000001'::uuid $f$;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
-- Must be refused with exactly this SQLSTATE, message and `detail` code.
create function pg_temp.refused_with(p_name text, p_sql text, p_state text, p_message text, p_code text) returns void language plpgsql as $f$
declare v_state text; v_message text; v_detail text;
begin
execute p_sql;
insert into t_results values (p_name, false, 'no error raised');
exception when others then
get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail;
insert into t_results values (
    p_name,
    v_state = p_state and v_message = p_message
        and (p_code is null or (v_detail::json ->> 'code') is not distinct from p_code),
    v_state || ' ' || v_message || ' ' || coalesce(v_detail, '')
);
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

-- 1 owner, 2 guest joining by link, 3 a viewer the edit link lifts.
insert into auth.users (id, email, raw_user_meta_data, is_anonymous) values
(pg_temp.u(1), 'owner@peektest.test', '{"display_name":"Owner"}', false),
(pg_temp.u(2), null, '{"display_name":"Guest"}', true),
(pg_temp.u(3), 'viewer@peektest.test', '{}', false);
insert into public.documents (id, owner_id, title, storage_path) values (pg_temp.d(), pg_temp.u(1), 'Peek', pg_temp.d()::text || '/original.pdf');
insert into public.document_members (document_id, user_id, role) values (pg_temp.d(), pg_temp.u(3), 'viewer');
insert into public.share_links (token, document_id, role, created_by, expires_at, revoked_at) values
('5e7aEDIT', pg_temp.d(), 'editor', pg_temp.u(1), null, null),
('5e7aVIEW', pg_temp.d(), 'viewer', pg_temp.u(1), now() + interval '7 days', null),
('5e7aEXPIRED', pg_temp.d(), 'editor', pg_temp.u(1), now() - interval '1 minute', null),
('5e7aREVOKED', pg_temp.d(), 'editor', pg_temp.u(1), null, now() - interval '1 minute');

-- ---- peek, as anon (no session yet: the join page's case)
select pg_temp.as_anon();
select pg_temp.chk('01 anon: edit link is valid, as editor', $q$select valid and role = 'editor' from public.peek_share_link('5e7aEDIT')$q$);
select pg_temp.chk('02 anon: view link is valid, as viewer', $q$select valid and role = 'viewer' from public.peek_share_link('5e7aVIEW')$q$);
select pg_temp.chk('03 anon: expired link is invalid, no role', $q$select not valid and role is null from public.peek_share_link('5e7aEXPIRED')$q$);
select pg_temp.chk('04 anon: revoked link is invalid, no role', $q$select not valid and role is null from public.peek_share_link('5e7aREVOKED')$q$);
select pg_temp.chk('05 anon: unknown token is invalid, no role', $q$select not valid and role is null from public.peek_share_link('5e7aNOSUCH')$q$);
select pg_temp.chk('06 anon: null and empty tokens are invalid', $q$select (select not valid from public.peek_share_link(null)) and (select not valid from public.peek_share_link(''))$q$);
select pg_temp.chk('07 anon: an over-long token is invalid without a match', $q$select not valid and role is null from public.peek_share_link(repeat('x', 5000))$q$);
select pg_temp.chk('08 always exactly one row', $q$select (select count(*) from public.peek_share_link('5e7aEDIT')) = 1 and (select count(*) from public.peek_share_link('5e7aNOSUCH')) = 1$q$);
select pg_temp.chk('09 the answer has only valid and role', $q$select array_agg(key order by key) = array['role', 'valid'] from json_object_keys((select row_to_json(p) from public.peek_share_link('5e7aEDIT') p)) key$q$);
select pg_temp.chk('10 anon still cannot redeem', $q$select not has_function_privilege('anon', 'public.redeem_share_link(text)', 'execute')$q$);

-- ---- peek, signed in
select pg_temp.as_user(2);
select pg_temp.chk('11 signed in: peek answers the same', $q$select valid and role = 'editor' from public.peek_share_link('5e7aEDIT')$q$);
select pg_temp.chk('12 peek joins nobody', $q$select not exists (select 1 from public.document_members where user_id = pg_temp.u(2))$q$);

-- ---- redeem: dead links are a 4xx with a stable code
select pg_temp.refused_with('20 unknown token -> PT404 invalid_share_link', $q$select * from public.redeem_share_link('5e7aNOSUCH')$q$, 'PT404', 'invalid or expired share link', 'invalid_share_link');
select pg_temp.refused_with('21 expired link -> PT404 invalid_share_link', $q$select * from public.redeem_share_link('5e7aEXPIRED')$q$, 'PT404', 'invalid or expired share link', 'invalid_share_link');
select pg_temp.refused_with('22 revoked link -> PT404 invalid_share_link', $q$select * from public.redeem_share_link('5e7aREVOKED')$q$, 'PT404', 'invalid or expired share link', 'invalid_share_link');
select pg_temp.chk('23 a refused redeem joins nobody', $q$select not exists (select 1 from public.document_members where user_id = pg_temp.u(2))$q$);

-- ---- redeem: everything else unchanged
select pg_temp.chk('30 guest redeems the edit link as editor', $q$select document_id = pg_temp.d() and granted_role = 'editor' from public.redeem_share_link('5e7aEDIT')$q$);
reset role;
select pg_temp.chk('31 provenance recorded for the guest', $q$select token = '5e7aEDIT' from public.share_link_redemptions where user_id = pg_temp.u(2)$q$);
select pg_temp.as_user(3);
select pg_temp.chk('32 the edit link lifts a viewer to editor', $q$select granted_role = 'editor' from public.redeem_share_link('5e7aEDIT')$q$);
select pg_temp.chk('33 an editor opening the view link stays editor', $q$select granted_role = 'editor' from public.redeem_share_link('5e7aVIEW')$q$);
select pg_temp.as_user(1);
select pg_temp.chk('34 the owner opening their own link stays owner', $q$select granted_role = 'owner' from public.redeem_share_link('5e7aEDIT')$q$);
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.refused_with('35 no session -> 28000, as before', $q$select * from public.redeem_share_link('5e7aEDIT')$q$, '28000', 'not authenticated', null);

-- ---- the functions themselves
select pg_temp.chk('40 execute grants: peek to anon + authenticated, not PUBLIC', $q$select has_function_privilege('anon', 'public.peek_share_link(text)', 'execute')
    and has_function_privilege('authenticated', 'public.peek_share_link(text)', 'execute')
    and not exists (
        select 1 from pg_proc p, aclexplode(p.proacl) a
        where p.oid = 'public.peek_share_link(text)'::regprocedure and a.grantee = 0
    )$q$);
select pg_temp.chk('41 redeem: authenticated only, not PUBLIC', $q$select has_function_privilege('authenticated', 'public.redeem_share_link(text)', 'execute')
    and not exists (
        select 1 from pg_proc p, aclexplode(p.proacl) a
        where p.oid = 'public.redeem_share_link(text)'::regprocedure and a.grantee = 0
    )$q$);
select pg_temp.chk('42 both are definer functions with a pinned search_path', $q$select bool_and(prosecdef and proconfig @> array['search_path=public']) and count(*) = 2 from pg_proc where oid in ('public.peek_share_link(text)'::regprocedure, 'public.redeem_share_link(text)'::regprocedure)$q$);
select pg_temp.chk('43 peek is STABLE (a read, never a write)', $q$select provolatile = 's' from pg_proc where oid = 'public.peek_share_link(text)'::regprocedure$q$);

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
