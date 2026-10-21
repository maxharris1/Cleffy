-- Behaviour proof for 20261020150000_content_moderation.sql: a restricted
-- score answers its owner only, a removed one nobody; neither can gain members
-- or share links; lifting restores exactly the access that was suspended; a
-- copyright takedown is a strike and lifting it withdraws the strike; the
-- moderator RPCs refuse everyone else; and no client role can read or write
-- the moderation tables.
--
-- Runs inside one transaction and ROLLS BACK — nothing persists:
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/content_moderation.sql
--
-- Every row of the result table should read `t`; the last line is
-- `failures | total`. No DROP / DELETE / TRUNCATE keyword (see README.md).
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('c0de1000-5ac0-4000-8000-00000000000' || n)::uuid $f$;
create function pg_temp.d(n int) returns uuid language sql immutable as $f$ select ('c0de10d0-5ac0-4000-8000-00000000000' || n)::uuid $f$;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
create function pg_temp.refused_with(p_name text, p_sql text, p_state text, p_code text) returns void language plpgsql as $f$
declare v_state text; v_detail text;
begin
execute p_sql;
insert into t_results values (p_name, false, 'no error raised');
exception when others then
get stacked diagnostics v_state = returned_sqlstate, v_detail = pg_exception_detail;
insert into t_results values (
    p_name,
    v_state = p_state and (p_code is null or (nullif(v_detail, '')::json ->> 'code') is not distinct from p_code),
    v_state || ' ' || coalesce(v_detail, '')
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
create function pg_temp.as_service() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
perform set_config('role', 'service_role', true);
end $f$;
create function pg_temp.library_ids() returns uuid[] language sql as $f$
    select coalesce(array_agg((e ->> 'id')::uuid), '{}') from jsonb_array_elements(public.library_documents () -> 'documents') e
$f$;

-- 1 uploader, 2 editor member, 3 a guest with a link, 4 moderator, 5 nobody.
insert into auth.users (id, email, raw_user_meta_data, is_anonymous) values
(pg_temp.u(1), 'uploader@modtest.test', '{}', false),
(pg_temp.u(2), 'editor@modtest.test', '{}', false),
(pg_temp.u(3), null, '{}', true),
(pg_temp.u(4), 'moderator@modtest.test', '{}', false),
(pg_temp.u(5), 'nobody@modtest.test', '{}', false);
insert into public.documents (id, owner_id, title, storage_path) values
(pg_temp.d(1), pg_temp.u(1), 'Restricted', pg_temp.d(1)::text || '/original.pdf'),
(pg_temp.d(2), pg_temp.u(1), 'Removed', pg_temp.d(2)::text || '/original.pdf');
insert into public.document_members (document_id, user_id, role) values
(pg_temp.d(1), pg_temp.u(2), 'editor'),
(pg_temp.d(2), pg_temp.u(2), 'editor');
insert into public.share_links (token, document_id, role, created_by) values ('c0deLINK1', pg_temp.d(1), 'viewer', pg_temp.u(1));
insert into public.content_moderators (user_id, note) values (pg_temp.u(4), 'test');
insert into public.content_reports (kind, category, content_url, document_id, work_description, explanation,
    reporter_name, reporter_email, good_faith, perjury_statement, signature)
values ('copyright', 'copyright', 'https://cleffy.io/doc/' || pg_temp.d(1), pg_temp.d(1), 'Edition X', 'Scanned from my edition',
    'Rights Holder', 'rights@modtest.test', true, true, 'Rights Holder');

-- ---- before any takedown
select pg_temp.as_user(2);
select pg_temp.chk('01 before: the editor has the score', $q$select public.document_role(pg_temp.d(1)) = 'editor' and pg_temp.d(1) = any (pg_temp.library_ids())$q$);
reset role;
select pg_temp.chk('02 reference looks like CR-XXXXXXXXXX', $q$select reference ~ '^CR-[0-9A-F]{10}$' from public.content_reports limit 1$q$);

-- ---- client roles cannot touch the moderation tables
select pg_temp.as_user(4);
select pg_temp.refused_with('10 even a moderator cannot read reports directly', $q$select count(*) from public.content_reports$q$, '42501', null);
select pg_temp.refused_with('11 nor insert a takedown', $q$insert into public.content_takedowns (document_id, action, ground, legal_basis, facts) values (pg_temp.d(1), 'remove', 'terms', 'x', 'y')$q$, '42501', null);
select pg_temp.refused_with('12 nor make themselves a moderator twice over', $q$insert into public.content_moderators (user_id) values (pg_temp.u(5))$q$, '42501', null);
select pg_temp.refused_with('13 nor call the takedown action', $q$select public.apply_content_takedown(pg_temp.d(1), 'remove', 'terms', 'x', 'y', null, pg_temp.u(4))$q$, '42501', null);
select pg_temp.chk('14 the moderator is told they are one', $q$select public.is_content_moderator()$q$);
select pg_temp.chk('15 the moderator reads the queue', $q$select jsonb_array_length(public.moderation_queue() -> 'reports') = 1$q$);
select pg_temp.as_user(5);
select pg_temp.chk('16 anyone else is not a moderator', $q$select not public.is_content_moderator()$q$);
select pg_temp.refused_with('17 and is refused the queue', $q$select public.moderation_queue()$q$, '42501', null);
select pg_temp.as_anon();
select pg_temp.refused_with('18 anon cannot ask either', $q$select public.is_content_moderator()$q$, '42501', null);
select pg_temp.refused_with('19 anon cannot read reports', $q$select count(*) from public.content_reports$q$, '42501', null);

-- ---- restrict score 1 (copyright, from the report), remove score 2 (illegal)
select pg_temp.as_service();
select pg_temp.chk('20 restrict: one strike for the uploader', $q$select (public.apply_content_takedown(pg_temp.d(1), 'restrict', 'copyright', '17 U.S.C. 512', 'Matches the rights holder''s edition', (select id from public.content_reports limit 1), pg_temp.u(4)) ->> 'active_strikes')::int = 1$q$);
select pg_temp.chk('21 remove (illegal): no strike', $q$select (public.apply_content_takedown(pg_temp.d(2), 'remove', 'illegal', 'Illegal under X', 'Facts', null, pg_temp.u(4)) ->> 'active_strikes')::int = 1$q$);
select pg_temp.refused_with('22 a second takedown on the same score is refused', $q$select public.apply_content_takedown(pg_temp.d(1), 'remove', 'terms', 'x', 'y', null, pg_temp.u(4))$q$, '23505', 'already_taken_down');
select pg_temp.chk('23 the report is marked actioned', $q$select status = 'actioned' and decided_by = pg_temp.u(4) from public.content_reports limit 1$q$);
select pg_temp.chk('24 both takedowns are logged', $q$select count(*) = 2 from public.content_notice_log where event = 'takedown'$q$);
reset role;

select pg_temp.as_user(1);
select pg_temp.chk('30 restricted: the owner keeps it', $q$select public.document_role(pg_temp.d(1)) = 'owner' and pg_temp.d(1) = any (pg_temp.library_ids())$q$);
select pg_temp.chk('31 removed: not even the owner can open it', $q$select public.document_role(pg_temp.d(2)) is null and not (pg_temp.d(2) = any (pg_temp.library_ids()))$q$);
select pg_temp.chk('32 removed: the owner cannot update it', $q$with u as (update public.documents set title = 'renamed' where id = pg_temp.d(2) returning 1) select count(*) = 0 from u$q$);
select pg_temp.refused_with('33 restricted: the owner cannot make a new share link', $q$insert into public.share_links (token, document_id, role, created_by) values ('c0deLINK2', pg_temp.d(1), 'viewer', pg_temp.u(1))$q$, '42501', 'content_unavailable');
select pg_temp.as_user(2);
select pg_temp.chk('34 restricted: the editor loses it', $q$select public.document_role(pg_temp.d(1)) is null and not (pg_temp.d(1) = any (pg_temp.library_ids()))$q$);
select pg_temp.chk('35 removed: the editor loses it', $q$select public.document_role(pg_temp.d(2)) is null and not (pg_temp.d(2) = any (pg_temp.library_ids()))$q$);
select pg_temp.chk('36 the editor cannot read its markings', $q$select count(*) = 0 from public.annotations where document_id = pg_temp.d(1)$q$);
select pg_temp.as_user(3);
select pg_temp.refused_with('37 a guest cannot join through the old link', $q$select * from public.redeem_share_link('c0deLINK1')$q$, '42501', 'content_unavailable');
reset role;

-- ---- lift the restriction (counter-notice succeeded)
select pg_temp.as_service();
select pg_temp.chk('40 lift answers the score and uploader', $q$select (public.lift_content_takedown((select id from public.content_takedowns where document_id = pg_temp.d(1)), 'Counter-notice, no court action', pg_temp.u(4)) ->> 'uploader_id')::uuid = pg_temp.u(1)$q$);
select pg_temp.chk('41 the strike is withdrawn', $q$select public.active_content_strikes(pg_temp.u(1)) = 0$q$);
select pg_temp.refused_with('42 lifting twice is refused', $q$select public.lift_content_takedown((select id from public.content_takedowns where document_id = pg_temp.d(1)), 'again', pg_temp.u(4))$q$, 'P0002', 'takedown_not_found');
reset role;
select pg_temp.as_user(2);
select pg_temp.chk('43 lifted: the editor has it back, membership intact', $q$select public.document_role(pg_temp.d(1)) = 'editor' and pg_temp.d(1) = any (pg_temp.library_ids())$q$);
select pg_temp.chk('44 still removed: score 2 stays out of reach', $q$select public.document_role(pg_temp.d(2)) is null$q$);
select pg_temp.as_user(3);
select pg_temp.chk('45 lifted: the old link works again', $q$select granted_role = 'viewer' from public.redeem_share_link('c0deLINK1')$q$);
reset role;

-- ---- reject a report
insert into public.content_reports (kind, category, content_url, explanation, reporter_name, reporter_email, good_faith, signature)
values ('illegal', 'other', 'https://cleffy.io/doc/nothing', 'Unfounded', 'Someone', 'someone@modtest.test', true, 'Someone');
select pg_temp.as_service();
select pg_temp.chk('50 reject answers the reporter to notify', $q$select public.reject_content_report((select id from public.content_reports where reporter_name = 'Someone'), 'No illegal content found', pg_temp.u(4)) ->> 'reporter_email' = 'someone@modtest.test'$q$);
select pg_temp.refused_with('51 a decided report cannot be rejected again', $q$select public.reject_content_report((select id from public.content_reports where reporter_name = 'Someone'), 'x', pg_temp.u(4))$q$, 'P0002', 'report_not_open');
reset role;

-- ---- table rules
select pg_temp.refused_with('60 a copyright report needs the perjury statement', $q$insert into public.content_reports (kind, category, content_url, work_description, explanation, reporter_name, reporter_email, good_faith, perjury_statement, signature) values ('copyright', 'copyright', 'u', 'w', 'e', 'n', 'n@x.test', true, false, 's')$q$, '23514', null);
select pg_temp.refused_with('61 a report needs the good-faith statement', $q$insert into public.content_reports (kind, category, content_url, explanation, reporter_name, reporter_email, good_faith, signature) values ('illegal', 'other', 'u', 'e', 'n', 'n@x.test', false, 's')$q$, '23514', null);

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
