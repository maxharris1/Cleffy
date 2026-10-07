-- Behaviour proof for 20261007120000_sharing_access_control.sql: the member
-- RPCs, link provenance and revocation, leave, RLS after removal, the
-- membership broadcast and the realtime channel policies.
--
-- Runs inside one transaction and ROLLS BACK — nothing persists. Needs a
-- session that may SET ROLE authenticated (postgres on Supabase or on a local
-- database with every migration applied):
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f supabase/sql-tests/sharing_access_control.sql
--
-- Every row of the result table should read `t`; the last line is
-- `failures | total`. Each check names what it proves; `err` checks pass
-- when the statement is REFUSED, and record the refusal.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to authenticated;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('c5a1e000-5ac0-4000-8000-00000000000' || n)::uuid $f$;
create function pg_temp.d() returns uuid language sql immutable as $f$ select 'c5a1e0d0-5ac0-4000-8000-000000000001'::uuid $f$;
create function pg_temp.ok(p_name text, p_sql text) returns void language plpgsql as $f$
begin execute p_sql; insert into t_results values (p_name, true, null);
exception when others then insert into t_results values (p_name, false, sqlerrm); end $f$;
create function pg_temp.err(p_name text, p_sql text) returns void language plpgsql as $f$
begin execute p_sql; insert into t_results values (p_name, false, 'no error raised');
exception when others then insert into t_results values (p_name, true, sqlstate || ' ' || sqlerrm); end $f$;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlerrm); end $f$;
create function pg_temp.as_user(n int) returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(n), 'role', 'authenticated')::text, true);
perform set_config('role', 'authenticated', true);
end $f$;

-- 1 owner, 2 editor, 3 viewer, 4 outsider, 5 anonymous guest via edit link,
-- 6 via view link, 7 roster student (assigned view-only) who also opens the edit link
insert into auth.users (id, email, raw_user_meta_data, is_anonymous) values
(pg_temp.u(1),'owner@sharetest.test','{"display_name":"Olive Owner"}',false),
(pg_temp.u(2),'editor@sharetest.test','{"display_name":"Ed Editor"}',false),
(pg_temp.u(3),'viewer@sharetest.test','{}',false),
(pg_temp.u(4),'outsider@sharetest.test','{}',false),
(pg_temp.u(5),null,'{"display_name":"Guest One"}',true),
(pg_temp.u(6),'l2@sharetest.test','{}',false),
(pg_temp.u(7),'student@sharetest.test','{}',false);
insert into public.documents (id, owner_id, title, storage_path) values (pg_temp.d(), pg_temp.u(1), 'T', 'x/original.pdf');
insert into public.document_members (document_id, user_id, role) values (pg_temp.d(), pg_temp.u(2), 'editor'), (pg_temp.d(), pg_temp.u(3), 'viewer'), (pg_temp.d(), pg_temp.u(7), 'viewer');
insert into public.managed_students (id, teacher_id, student_user_id, display_name, login_code_hash) values (gen_random_uuid(), pg_temp.u(1), pg_temp.u(7), 'Stu Dent', 'x');
insert into public.assignments (id, document_id, student_user_id, assigned_by, access) values (gen_random_uuid(), pg_temp.d(), pg_temp.u(7), pg_temp.u(1), 'view');
insert into public.share_links (token, document_id, role, created_by, expires_at) values
('c5tokEDIT', pg_temp.d(), 'editor', pg_temp.u(1), null),
('c5tokVIEW', pg_temp.d(), 'viewer', pg_temp.u(1), now() + interval '7 days'),
('c5tokEXPIRED', pg_temp.d(), 'viewer', pg_temp.u(1), now() - interval '1 minute');
insert into public.annotations (id, document_id, page, kind, color, payload, created_by) values (gen_random_uuid(), pg_temp.d(), 0, 'stroke', '#000', '{"pts":[0,0,1],"w":0.01}', pg_temp.u(1));
insert into public.document_favorites (document_id, user_id) values (pg_temp.d(), pg_temp.u(3));
insert into public.library_tags (id, user_id, name) values ('c5a1e7a9-5ac0-4000-8000-000000000003', pg_temp.u(3), 'Mine');
insert into public.document_tags (document_id, tag_id) values (pg_temp.d(), 'c5a1e7a9-5ac0-4000-8000-000000000003');
select pg_temp.as_user(1);
select pg_temp.ok('00a owner creates link without a role', $q$insert into public.share_links (document_id, created_by) values (pg_temp.d(), pg_temp.u(1))$q$);
select pg_temp.chk('00b link role defaults to viewer', $q$select bool_and(role = 'viewer') from public.share_links where document_id = pg_temp.d() and token not like 'c5tok%'$q$);
select pg_temp.ok('00c owner sets an expiry on a link', $q$insert into public.share_links (document_id, created_by, role, expires_at) values (pg_temp.d(), pg_temp.u(1), 'viewer', now() + interval '30 days')$q$);

select pg_temp.as_user(5);
select pg_temp.chk('01 L1 redeems edit link', $q$select granted_role = 'editor' from public.redeem_share_link('c5tokEDIT')$q$);
select pg_temp.as_user(6);
select pg_temp.chk('02 L2 redeems view link', $q$select granted_role = 'viewer' from public.redeem_share_link('c5tokVIEW')$q$);
select pg_temp.as_user(7);
select pg_temp.chk('03 student redeems edit link -> editor', $q$select granted_role = 'editor' from public.redeem_share_link('c5tokEDIT')$q$);
select pg_temp.as_user(3);
select pg_temp.err('04 expired link refused', $q$select * from public.redeem_share_link('c5tokEXPIRED')$q$);
select pg_temp.as_user(2);
select pg_temp.chk('05 editor redeeming view link stays editor', $q$select granted_role = 'editor' from public.redeem_share_link('c5tokVIEW')$q$);
select pg_temp.err('06 client cannot read redemptions', $q$select count(*) from public.share_link_redemptions$q$);
select pg_temp.chk('07 select * on document_members still works', $q$select count(*) = 1 from (select * from public.document_members where user_id = pg_temp.u(2)) s$q$);
select pg_temp.as_user(1);
select pg_temp.chk('07b owner redeeming own link stays owner, no provenance', $q$select granted_role = 'owner' from public.redeem_share_link('c5tokEDIT')$q$);
reset role;
select pg_temp.chk('08 provenance recorded only where the link granted access', $q$select array_agg(right(user_id::text,1) || ':' || token order by user_id) = array['5:c5tokEDIT','6:c5tokVIEW','7:c5tokEDIT'] from public.share_link_redemptions where document_id = pg_temp.d()$q$);

select pg_temp.as_user(1);
select pg_temp.chk('10 owner lists all members', $q$select count(*) = 6 from public.list_document_members(pg_temp.d())$q$);
select pg_temp.chk('11 owner sees emails, link provenance, labels', $q$select bool_and(case right(user_id::text,1)
when '2' then email = 'editor@sharetest.test' and display_name = 'Ed Editor' and joined_via_link is null
when '5' then is_anonymous and joined_via_link = 'c5tokEDIT' and display_name = 'Guest One'
when '7' then is_student and display_name = 'Stu Dent'
when '3' then display_name is null and email = 'viewer@sharetest.test'
when '1' then role = 'owner' else true end) from public.list_document_members(pg_temp.d())$q$);
select pg_temp.chk('11b owner is listed first', $q$select (array_agg(role))[1] = 'owner' from public.list_document_members(pg_temp.d())$q$);
select pg_temp.as_user(2);
select pg_temp.chk('12 editor lists without emails or tokens', $q$select count(*) = 6 and bool_and(email is null and joined_via_link is null) from public.list_document_members(pg_temp.d())$q$);
select pg_temp.as_user(3);
select pg_temp.err('13 viewer cannot list', $q$select * from public.list_document_members(pg_temp.d())$q$);
select pg_temp.as_user(4);
select pg_temp.err('14 outsider cannot list', $q$select * from public.list_document_members(pg_temp.d())$q$);
reset role;
select pg_temp.err('15 unauthenticated caller cannot list', $q$select * from public.list_document_members(pg_temp.d())$q$);

select pg_temp.as_user(2);
select pg_temp.err('20 editor cannot change roles', $q$select public.set_document_member_role(pg_temp.d(), pg_temp.u(3), 'editor')$q$);
select pg_temp.err('21 editor cannot remove', $q$select public.remove_document_member(pg_temp.d(), pg_temp.u(3))$q$);
select pg_temp.err('22 editor cannot revoke', $q$select public.revoke_share_link('c5tokVIEW', true)$q$);
select pg_temp.as_user(3);
select pg_temp.err('23 viewer cannot remove', $q$select public.remove_document_member(pg_temp.d(), pg_temp.u(2))$q$);
select pg_temp.err('24 viewer cannot change roles', $q$select public.set_document_member_role(pg_temp.d(), pg_temp.u(3), 'editor')$q$);
select pg_temp.as_user(4);
select pg_temp.err('25 outsider cannot remove', $q$select public.remove_document_member(pg_temp.d(), pg_temp.u(2))$q$);
select pg_temp.err('26 outsider cannot revoke', $q$select public.revoke_share_link('c5tokVIEW', true)$q$);
select pg_temp.err('27 outsider cannot revoke an unknown token', $q$select public.revoke_share_link('nope', true)$q$);
select pg_temp.as_user(2);
select pg_temp.err('28a no direct membership update', $q$update public.document_members set role = 'editor' where user_id = pg_temp.u(3)$q$);
select pg_temp.err('28b no direct membership delete', $q$delete from public.document_members where user_id = pg_temp.u(3)$q$);

select pg_temp.as_user(1);
select pg_temp.err('30 owner cannot demote self', $q$select public.set_document_member_role(pg_temp.d(), pg_temp.u(1), 'viewer')$q$);
select pg_temp.err('31 owner cannot remove self', $q$select public.remove_document_member(pg_temp.d(), pg_temp.u(1))$q$);
select pg_temp.err('32 owner role cannot be granted', $q$select public.set_document_member_role(pg_temp.d(), pg_temp.u(2), 'owner')$q$);
select pg_temp.err('33 owner cannot leave', $q$select public.leave_document(pg_temp.d())$q$);
select pg_temp.err('34 role change for a non-member refused', $q$select public.set_document_member_role(pg_temp.d(), pg_temp.u(4), 'viewer')$q$);
select pg_temp.err('35 removing a non-member refused', $q$select public.remove_document_member(pg_temp.d(), pg_temp.u(4))$q$);

select pg_temp.ok('40 owner demotes the editor', $q$select public.set_document_member_role(pg_temp.d(), pg_temp.u(2), 'viewer')$q$);
select pg_temp.as_user(2);
select pg_temp.chk('41 demoted editor now reads viewer', $q$select public.document_role(pg_temp.d()) = 'viewer'$q$);
select pg_temp.err('42 demoted editor cannot annotate', $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by) values (gen_random_uuid(), pg_temp.d(), 0, 'stroke', '#000', '{"pts":[0,0,1],"w":0.01}', pg_temp.u(2))$q$);
select pg_temp.chk('42b demoted editor still reads annotations', $q$select count(*) = 1 from public.annotations where document_id = pg_temp.d()$q$);
select pg_temp.as_user(1);
select pg_temp.chk('43 revoke edit link + remove withdraws 2', $q$select public.revoke_share_link('c5tokEDIT', true) = 2$q$);
reset role;
select pg_temp.chk('44 link guest membership gone', $q$select not exists (select 1 from public.document_members where user_id = pg_temp.u(5))$q$);
select pg_temp.chk('45 student restored to the assignment role', $q$select role = 'viewer' from public.document_members where user_id = pg_temp.u(7)$q$);
select pg_temp.chk('45b student provenance cleared', $q$select not exists (select 1 from public.share_link_redemptions where user_id = pg_temp.u(7))$q$);
select pg_temp.chk('46 link revoked', $q$select revoked_at is not null from public.share_links where token = 'c5tokEDIT'$q$);
select pg_temp.chk('47 view-link member untouched', $q$select role = 'viewer' from public.document_members where user_id = pg_temp.u(6)$q$);
select pg_temp.chk('47b owner untouched', $q$select role = 'owner' from public.document_members where user_id = pg_temp.u(1)$q$);
select pg_temp.as_user(5);
select pg_temp.chk('48 removed guest cannot see the document', $q$select count(*) = 0 from public.documents where id = pg_temp.d()$q$);
select pg_temp.chk('49 removed guest cannot see annotations', $q$select count(*) = 0 from public.annotations where document_id = pg_temp.d()$q$);
select pg_temp.err('50 removed guest cannot rejoin via the revoked link', $q$select * from public.redeem_share_link('c5tokEDIT')$q$);
select pg_temp.err('50b removed guest cannot write annotations', $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by) values (gen_random_uuid(), pg_temp.d(), 0, 'stroke', '#000', '{"pts":[0,0,1],"w":0.01}', pg_temp.u(5))$q$);

select pg_temp.as_user(1);
select pg_temp.ok('51 owner makes the student an editor', $q$select public.set_document_member_role(pg_temp.d(), pg_temp.u(7), 'editor')$q$);
select pg_temp.chk('52 assignment access follows the role', $q$select access = 'edit' from public.assignments where student_user_id = pg_temp.u(7)$q$);
select pg_temp.ok('53 owner removes the viewer', $q$select public.remove_document_member(pg_temp.d(), pg_temp.u(3))$q$);
select pg_temp.as_user(3);
select pg_temp.chk('54 removed viewer cannot see the document', $q$select count(*) = 0 from public.documents where id = pg_temp.d()$q$);
select pg_temp.chk('55 removed viewer cannot see annotations', $q$select count(*) = 0 from public.annotations where document_id = pg_temp.d()$q$);
select pg_temp.chk('56 removed viewer cannot see members', $q$select count(*) = 0 from public.document_members where document_id = pg_temp.d()$q$);
select pg_temp.chk('57 removed viewer favorite + tag cleaned', $q$select (select count(*) from public.document_favorites where document_id = pg_temp.d()) + (select count(*) from public.document_tags where document_id = pg_temp.d()) = 0$q$);
select pg_temp.chk('57b removed viewer keeps the tag itself', $q$select count(*) = 1 from public.library_tags where user_id = pg_temp.u(3)$q$);

select pg_temp.as_user(7);
select pg_temp.err('60 assigned student cannot leave', $q$select public.leave_document(pg_temp.d())$q$);
select pg_temp.as_user(6);
select pg_temp.ok('61 view-link member leaves', $q$select public.leave_document(pg_temp.d())$q$);
select pg_temp.chk('62 cannot see the document after leaving', $q$select count(*) = 0 from public.documents where id = pg_temp.d()$q$);
select pg_temp.ok('63 leaving twice is a no-op', $q$select public.leave_document(pg_temp.d())$q$);
select pg_temp.as_user(4);
select pg_temp.ok('64 outsider leave is a no-op', $q$select public.leave_document(pg_temp.d())$q$);
select pg_temp.chk('64b outsider leave changed nothing', $q$select count(*) = 0 from public.documents where id = pg_temp.d()$q$);

select pg_temp.as_user(1);
select pg_temp.ok('70 owner removes the student', $q$select public.remove_document_member(pg_temp.d(), pg_temp.u(7))$q$);
select pg_temp.chk('71 plain revoke returns 0', $q$select public.revoke_share_link('c5tokVIEW') = 0$q$);
select pg_temp.chk('72 remaining: owner + demoted editor', $q$select count(*) = 2 from public.list_document_members(pg_temp.d())$q$);
select pg_temp.chk('72b re-revoking keeps the original timestamp', $q$with before as (select revoked_at from public.share_links where token = 'c5tokVIEW') select public.revoke_share_link('c5tokVIEW') = 0 and (select revoked_at from public.share_links where token = 'c5tokVIEW') = (select revoked_at from before)$q$);
select pg_temp.chk('72c owner still sees the document and annotations', $q$select (select count(*) from public.documents where id = pg_temp.d()) = 1 and (select count(*) from public.annotations where document_id = pg_temp.d()) = 1$q$);
reset role;
select pg_temp.chk('73 student assignment withdrawn with the membership', $q$select count(*) = 0 from public.assignments where student_user_id = pg_temp.u(7)$q$);

-- Broadcasts: one per role change / removal, private, on the doc topic.
select pg_temp.chk('80 membership broadcasts emitted', $q$select count(*) >= 7 from realtime.messages where topic = 'doc:' || pg_temp.d() and event = 'membership'$q$);
select pg_temp.chk('81 removal broadcast carries a null role', $q$select bool_or(payload ->> 'user_id' = pg_temp.u(3)::text and payload -> 'role' = 'null'::jsonb and private) from realtime.messages where event = 'membership'$q$);
select pg_temp.chk('82 demotion broadcast carries the new role', $q$select bool_or(payload ->> 'user_id' = pg_temp.u(2)::text and payload ->> 'role' = 'viewer') from realtime.messages where event = 'membership'$q$);
-- Channel authorization (evaluated by Realtime at join): the removed viewer's
-- next join is refused, the owner's is not.
select set_config('realtime.topic', 'doc:' || pg_temp.d(), true);
select pg_temp.as_user(3);
select pg_temp.chk('84 removed member no longer passes the channel receive policy', $q$select count(*) = 0 from realtime.messages where topic = realtime.topic()$q$);
select pg_temp.as_user(1);
select pg_temp.chk('85 owner still passes the channel receive policy', $q$select count(*) > 0 from realtime.messages where topic = realtime.topic()$q$);
select pg_temp.as_user(2);
select pg_temp.err('86 demoted editor can no longer send broadcast (live ink)', $q$insert into realtime.messages (topic, extension, event, payload) values (realtime.topic(), 'broadcast', 'ink:progress', '{}')$q$);
select pg_temp.ok('87 demoted editor can still send presence', $q$insert into realtime.messages (topic, extension, event, payload) values (realtime.topic(), 'presence', 'presence', '{}')$q$);
reset role;
create temp table t_before as select count(*) as n from realtime.messages where event = 'membership';
update public.document_members set role = role where user_id = pg_temp.u(2);
select pg_temp.chk('83 unchanged-role update emits nothing', $q$select count(*) = (select n from t_before) from realtime.messages where event = 'membership'$q$);

select pg_temp.chk('90 execute grants', $q$select not (
    has_function_privilege('anon','public.list_document_members(uuid)','execute')
 or has_function_privilege('anon','public.remove_document_member(uuid,uuid)','execute')
 or has_function_privilege('anon','public.set_document_member_role(uuid,uuid,text)','execute')
 or has_function_privilege('anon','public.leave_document(uuid)','execute')
 or has_function_privilege('anon','public.revoke_share_link(text,boolean)','execute')
 or has_function_privilege('anon','public.redeem_share_link(text)','execute')
 or has_function_privilege('authenticated','public.forget_document_for_user(uuid,uuid)','execute')
 or has_function_privilege('authenticated','public.broadcast_membership_changes()','execute'))
 and has_function_privilege('authenticated','public.leave_document(uuid)','execute')
 and has_function_privilege('authenticated','public.list_document_members(uuid)','execute')$q$);
select pg_temp.chk('91 definer functions pin search_path', $q$select bool_and(proconfig @> array['search_path=public']) from pg_proc where proname in ('list_document_members','set_document_member_role','remove_document_member','leave_document','revoke_share_link','redeem_share_link','broadcast_membership_changes','forget_document_for_user')$q$);

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
