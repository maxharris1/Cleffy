-- Behaviour proof for 20261020150000_content_moderation.sql: a restricted
-- score answers its owner only, a removed one nobody (its owner's direct read
-- of the row included); neither can gain members or share links; viewers
-- already connected are told to re-check, and the score moves to fresh
-- realtime topics (20261020150100) that only who may still see it can join,
-- its committed changes going to its owner there and to nobody on the old
-- ones (needs the local
-- stack running, so today's realtime.messages partition exists: `npm run
-- cloud:up`); lifting restores exactly the access that was suspended; a
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
create function pg_temp.a(n int) returns uuid language sql immutable as $f$ select ('c0de10a0-5ac0-4000-8000-00000000000' || n)::uuid $f$;
-- A committed mark on a score, written the way the server writes it.
create function pg_temp.mark(p_id uuid, p_doc uuid) returns void language sql as $f$
    insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
    values (p_id, p_doc, 0, 'stroke', '#000', '{"pts":[0,0,1],"w":0.01}', pg_temp.u(2))
$f$;
create function pg_temp.broadcast_of(p_mark uuid) returns boolean language sql as $f$
    select exists (
        select 1 from realtime.messages
        where topic like 'doc-db:%' and payload -> 'record' ->> 'id' = p_mark::text
    )
$f$;
-- Was the mark broadcast on exactly this topic?
create function pg_temp.broadcast_on(p_mark uuid, p_topic text) returns boolean language sql as $f$
    select exists (
        select 1 from realtime.messages
        where topic = p_topic and payload -> 'record' ->> 'id' = p_mark::text
    )
$f$;
-- A join is a read of realtime.messages under the joining user with
-- realtime.topic set (tests/sql/column_integrity.sql): may this user join it?
create function pg_temp.can_join(p_topic text) returns boolean language plpgsql as $f$
declare v boolean; v_role text := current_setting('role');
begin
    -- The probe is written by the test, not by the joining user.
    perform set_config('role', 'postgres', true);
    insert into realtime.messages (topic, extension, event, payload, private) values (p_topic, 'broadcast', 'probe', '{}', true);
    perform set_config('role', v_role, true);
    perform set_config('realtime.topic', p_topic, true);
    execute 'select count(*) > 0 from realtime.messages where topic = $1' into v using p_topic;
    perform set_config('realtime.topic', '', true);
    return v;
end $f$;
create function pg_temp.told_to_recheck(p_doc uuid, p_user uuid) returns boolean language sql as $f$
    select exists (
        select 1 from realtime.messages
        where topic = 'doc:' || p_doc::text and event = 'membership'
          and payload ->> 'user_id' = p_user::text and payload -> 'role' = 'null'::jsonb
    )
$f$;
-- Walk a moderation list page by page, as the admin page's "Show more" does,
-- and answer every id in the order served.
create function pg_temp.walk(p_list text, p_filter text, p_limit int) returns uuid[] language plpgsql as $f$
declare v_page jsonb; v_ids uuid[] := '{}'; v_at timestamptz; v_id uuid; v_pages int := 0;
begin
loop
    if p_list = 'reports' then v_page := public.moderation_reports(p_filter, v_at, v_id, p_limit);
    else v_page := public.moderation_takedowns(p_filter, v_at, v_id, p_limit); end if;
    v_ids := v_ids || coalesce((select array_agg((r ->> 'id')::uuid order by n) from jsonb_array_elements(v_page -> 'rows') with ordinality e (r, n)), '{}');
    v_pages := v_pages + 1;
    exit when v_page -> 'next' = 'null'::jsonb or v_page -> 'next' is null or v_pages > 1000;
    v_at := (v_page -> 'next' ->> 'created_at')::timestamptz; v_id := (v_page -> 'next' ->> 'id')::uuid;
end loop;
return v_ids;
end $f$;
create function pg_temp.walk_log(p_limit int) returns bigint[] language plpgsql as $f$
declare v_page jsonb; v_ids bigint[] := '{}'; v_before bigint; v_pages int := 0;
begin
loop
    v_page := public.moderation_log(v_before, p_limit);
    v_ids := v_ids || coalesce((select array_agg((r ->> 'id')::bigint order by n) from jsonb_array_elements(v_page -> 'rows') with ordinality e (r, n)), '{}');
    v_pages := v_pages + 1;
    exit when v_page -> 'next' = 'null'::jsonb or v_page -> 'next' is null or v_pages > 1000;
    v_before := (v_page -> 'next' ->> 'id')::bigint;
end loop;
return v_ids;
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
(pg_temp.d(2), pg_temp.u(1), 'Removed', pg_temp.d(2)::text || '/original.pdf'),
(pg_temp.d(9), pg_temp.u(1), 'Never taken down', pg_temp.d(9)::text || '/original.pdf');
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

-- ---- realtime, before: a mark goes out on doc-db:{id}. Realtime creates the
-- day's realtime.messages partition only while it runs; without it every send
-- is a swallowed WARNING and the realtime checks below would prove nothing.
select pg_temp.chk('03 realtime is running (today''s realtime.messages partition exists)', $q$select exists (select 1 from pg_class where relnamespace = 'realtime'::regnamespace and relname = 'messages_' || to_char(now(), 'YYYY_MM_DD'))$q$);
select pg_temp.mark(pg_temp.a(1), pg_temp.d(1));
select pg_temp.chk('04 before: a committed mark is broadcast on doc-db:{id}', $q$select pg_temp.broadcast_of(pg_temp.a(1))$q$);

-- ---- client roles cannot touch the moderation tables
select pg_temp.as_user(4);
select pg_temp.refused_with('10 even a moderator cannot read reports directly', $q$select count(*) from public.content_reports$q$, '42501', null);
select pg_temp.refused_with('11 nor insert a takedown', $q$insert into public.content_takedowns (document_id, action, ground, legal_basis, facts) values (pg_temp.d(1), 'remove', 'terms', 'x', 'y')$q$, '42501', null);
select pg_temp.refused_with('12 nor make themselves a moderator twice over', $q$insert into public.content_moderators (user_id) values (pg_temp.u(5))$q$, '42501', null);
select pg_temp.refused_with('13 nor call the takedown action', $q$select public.apply_content_takedown(pg_temp.d(1), 'remove', 'terms', 'x', 'y', null, pg_temp.u(4))$q$, '42501', null);
select pg_temp.chk('14 the moderator is told they are one', $q$select public.is_content_moderator()$q$);
select pg_temp.chk('15 the moderator reads the open reports', $q$select jsonb_array_length(public.moderation_reports('open') -> 'rows') = 1 and (public.moderation_reports('open') ->> 'total')::int = 1$q$);
select pg_temp.as_user(5);
select pg_temp.chk('16 anyone else is not a moderator', $q$select not public.is_content_moderator()$q$);
select pg_temp.refused_with('17 and is refused the reports', $q$select public.moderation_reports('all')$q$, '42501', null);
select pg_temp.refused_with('17b the takedowns', $q$select public.moderation_takedowns('all')$q$, '42501', null);
select pg_temp.refused_with('17c and the log', $q$select public.moderation_log()$q$, '42501', null);
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

-- ---- viewers already connected (realtime authorizes at join, not per message)
select pg_temp.chk('70 restrict: the connected editor is told to re-check', $q$select pg_temp.told_to_recheck(pg_temp.d(1), pg_temp.u(2))$q$);
select pg_temp.chk('71 restrict: the owner, who keeps it, is not', $q$select not pg_temp.told_to_recheck(pg_temp.d(1), pg_temp.u(1))$q$);
select pg_temp.chk('72 remove: the editor and the owner are both told', $q$select pg_temp.told_to_recheck(pg_temp.d(2), pg_temp.u(2)) and pg_temp.told_to_recheck(pg_temp.d(2), pg_temp.u(1))$q$);
select pg_temp.mark(pg_temp.a(2), pg_temp.d(1));
select pg_temp.mark(pg_temp.a(3), pg_temp.d(2));
-- A takedown moves the score to generation 1 (20261020150100): a restricted
-- score's changes reach its owner's devices on doc-db:{id}:1 and nobody on the
-- old doc-db:{id}; a removed score's go nowhere.
select pg_temp.chk('73 restricted: a new mark goes to doc-db:{id}:1 only, never the old topic', $q$select pg_temp.broadcast_on(pg_temp.a(2), 'doc-db:' || pg_temp.d(1)::text || ':1') and not pg_temp.broadcast_on(pg_temp.a(2), 'doc-db:' || pg_temp.d(1)::text)$q$);
select pg_temp.chk('73b removed: a new mark is not broadcast at all', $q$select not pg_temp.broadcast_of(pg_temp.a(3))$q$);
update public.documents set content_rev = content_rev + 1 where id = pg_temp.d(1);
select pg_temp.chk('74 restricted: a replaced PDF is not broadcast on the old topic', $q$select not exists (select 1 from realtime.messages where topic = 'doc-db:' || pg_temp.d(1)::text and payload ->> 'table' = 'documents')$q$);
select pg_temp.chk('74b restricted: it goes to the owner on doc-db:{id}:1', $q$select exists (select 1 from realtime.messages where topic = 'doc-db:' || pg_temp.d(1)::text || ':1' and payload ->> 'table' = 'documents')$q$);
select pg_temp.chk('81 both takedowns rotated their score to generation 1', $q$select public.document_realtime_epoch(pg_temp.d(1)) = 1 and public.document_realtime_epoch(pg_temp.d(2)) = 1$q$);
select pg_temp.chk('82 everyone on the old topics is told topic_rotated, on both', $q$select count(distinct topic) = 2 from realtime.messages where event = 'topic_rotated' and topic in ('doc:' || pg_temp.d(1)::text, 'doc-db:' || pg_temp.d(1)::text) and payload ->> 'document_id' = pg_temp.d(1)::text$q$);
select pg_temp.chk('83 the membership hint went out on the old topic, before the move', $q$select pg_temp.told_to_recheck(pg_temp.d(1), pg_temp.u(2)) and not exists (select 1 from realtime.messages where topic = 'doc:' || pg_temp.d(1)::text || ':1' and event = 'membership')$q$);
-- More than the pull's 50-seq overlap while restricted: every one still
-- reaches the owner's other devices live, so none can skip a mark.
select pg_temp.mark(gen_random_uuid(), pg_temp.d(1)) from generate_series(1, 60);
select pg_temp.chk('84 restricted: 60 more marks all reach doc-db:{id}:1', $q$select count(*) = 61 from realtime.messages where topic = 'doc-db:' || pg_temp.d(1)::text || ':1' and payload ->> 'table' = 'annotations'$q$);
select pg_temp.chk('85 restricted: and not one of them the old doc-db:{id}', $q$select count(*) = 0 from realtime.messages where topic = 'doc-db:' || pg_temp.d(1)::text and payload ->> 'table' = 'annotations' and payload -> 'record' ->> 'id' <> pg_temp.a(1)::text$q$);
select pg_temp.chk('75 the hints carry ids only', $q$select bool_and(payload - 'table' - 'document_id' - 'user_id' - 'role' - 'id' = '{}'::jsonb) from realtime.messages where topic in ('doc:' || pg_temp.d(1)::text, 'doc:' || pg_temp.d(2)::text) and event = 'membership'$q$);
-- Something on each topic to be refused: a join is a read of realtime.messages
-- under the joining user with realtime.topic set (tests/sql/column_integrity.sql).
insert into realtime.messages (topic, extension, event, payload, private)
select t, 'broadcast', 'probe', '{}', true
from unnest(array['doc:' || pg_temp.d(1)::text, 'doc-db:' || pg_temp.d(1)::text]) as t;
select pg_temp.as_user(2);
select set_config('realtime.topic', 'doc:' || pg_temp.d(1)::text, true);
select pg_temp.chk('76 restricted: the editor cannot re-join doc:{id}', $q$select count(*) = 0 from realtime.messages where topic = 'doc:' || pg_temp.d(1)::text$q$);
select set_config('realtime.topic', 'doc-db:' || pg_temp.d(1)::text, true);
select pg_temp.chk('77 restricted: nor doc-db:{id}', $q$select count(*) = 0 from realtime.messages where topic = 'doc-db:' || pg_temp.d(1)::text$q$);
select pg_temp.chk('77b restricted: nor the new doc:{id}:1 or doc-db:{id}:1', $q$select not pg_temp.can_join('doc:' || pg_temp.d(1)::text || ':1') and not pg_temp.can_join('doc-db:' || pg_temp.d(1)::text || ':1')$q$);
select pg_temp.chk('77c restricted: the editor is not told the generation', $q$select public.realtime_topic_epoch(pg_temp.d(1)) is null$q$);
select pg_temp.as_user(1);
select pg_temp.chk('78 restricted: its owner joins the new doc:{id}:1 and doc-db:{id}:1', $q$select pg_temp.can_join('doc:' || pg_temp.d(1)::text || ':1') and pg_temp.can_join('doc-db:' || pg_temp.d(1)::text || ':1')$q$);
select pg_temp.chk('78b restricted: but not the old generation, so a stale device moves', $q$select not pg_temp.can_join('doc:' || pg_temp.d(1)::text) and not pg_temp.can_join('doc-db:' || pg_temp.d(1)::text)$q$);
select pg_temp.chk('78c restricted: the owner is told generation 1', $q$select public.realtime_topic_epoch(pg_temp.d(1)) = 1$q$);
select pg_temp.chk('78d removed: the owner joins neither generation', $q$select not pg_temp.can_join('doc:' || pg_temp.d(2)::text || ':1') and not pg_temp.can_join('doc:' || pg_temp.d(2)::text) and public.realtime_topic_epoch(pg_temp.d(2)) is null$q$);
select pg_temp.chk('78e malformed generations name no topic', $q$select bool_and(public.topic_document_role(t) is null) from unnest(array['doc:' || pg_temp.d(1)::text || ':01', 'doc:' || pg_temp.d(1)::text || ':2', 'doc:' || pg_temp.d(1)::text || ':1:1', 'doc:' || pg_temp.d(1)::text || ':x', 'doc:' || pg_temp.d(1)::text || ':0', 'doc:' || pg_temp.d(1)::text || ':-1']) as t$q$);
select pg_temp.chk('78f a score never taken down keeps generation 0 and its plain topics', $q$select public.topic_document_role('doc:' || pg_temp.d(9)::text) = 'owner' and public.db_topic_document_role('doc-db:' || pg_temp.d(9)::text) = 'owner' and public.topic_document_role('doc:' || pg_temp.d(9)::text || ':1') is null and public.realtime_topic_epoch(pg_temp.d(9)) = 0$q$);
select pg_temp.chk('79 removed: its owner cannot read the row directly either', $q$select count(*) = 0 from public.documents where id = pg_temp.d(2)$q$);
select pg_temp.chk('80 restricted: its owner still reads the row', $q$select count(*) = 1 from public.documents where id = pg_temp.d(1)$q$);
reset role;

-- ---- lift the restriction (counter-notice succeeded)
select pg_temp.as_service();
select pg_temp.chk('40 lift answers the score and uploader', $q$select (public.lift_content_takedown((select id from public.content_takedowns where document_id = pg_temp.d(1)), 'Counter-notice, no court action', pg_temp.u(4)) ->> 'uploader_id')::uuid = pg_temp.u(1)$q$);
select pg_temp.chk('41 the strike is withdrawn', $q$select public.active_content_strikes(pg_temp.u(1)) = 0$q$);
select pg_temp.refused_with('42 lifting twice is refused', $q$select public.lift_content_takedown((select id from public.content_takedowns where document_id = pg_temp.d(1)), 'again', pg_temp.u(4))$q$, 'P0002', 'takedown_not_found');
reset role;
select pg_temp.as_user(2);
select pg_temp.chk('43 lifted: the editor has it back, membership intact', $q$select public.document_role(pg_temp.d(1)) = 'editor' and pg_temp.d(1) = any (pg_temp.library_ids())$q$);
select pg_temp.chk('43b lifted: the editor joins the owner on generation 1 (lifting does not rotate)', $q$select public.realtime_topic_epoch(pg_temp.d(1)) = 1 and pg_temp.can_join('doc:' || pg_temp.d(1)::text || ':1') and not pg_temp.can_join('doc:' || pg_temp.d(1)::text)$q$);
select pg_temp.chk('44 still removed: score 2 stays out of reach', $q$select public.document_role(pg_temp.d(2)) is null$q$);
reset role;
select pg_temp.mark(pg_temp.a(4), pg_temp.d(1));
select pg_temp.mark(pg_temp.a(5), pg_temp.d(2));
select pg_temp.chk('46 lifted: marks are broadcast again (doc-db:{id}:1); still removed: not', $q$select pg_temp.broadcast_on(pg_temp.a(4), 'doc-db:' || pg_temp.d(1)::text || ':1') and not pg_temp.broadcast_of(pg_temp.a(5))$q$);
update public.document_members set role = 'viewer' where document_id = pg_temp.d(1) and user_id = pg_temp.u(2);
select pg_temp.chk('47 a later membership change is hinted on the current topic', $q$select exists (select 1 from realtime.messages where topic = 'doc:' || pg_temp.d(1)::text || ':1' and event = 'membership' and payload ->> 'user_id' = pg_temp.u(2)::text and payload ->> 'role' = 'viewer')$q$);
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

-- ---- the outbox: every notice owed is queued with its report or decision
select pg_temp.chk('A1 a stored report queues its acknowledgment, blind-copied to legal', $q$select count(*) = 1 from public.content_notice_outbox o join public.content_reports r on r.id = o.report_id where r.reporter_email = 'rights@modtest.test' and o.template = 'report_acknowledgment' and o.sender = 'content-report-ack' and o.bcc_legal and o.recipient = 'rights@modtest.test' and o.payload ->> 'reference' = r.reference$q$);
select pg_temp.chk('A2 ... and logs the report and the queued acknowledgment', $q$select count(*) filter (where event = 'report_received') = 1 and count(*) filter (where event = 'report_acknowledged' and delivery = 'queued') = 1 from public.content_notice_log where report_id = (select id from public.content_reports where reporter_email = 'rights@modtest.test')$q$);
select pg_temp.chk('A3 the takedown queued the statement of reasons to the uploader''s address', $q$select count(*) = 1 from public.content_notice_outbox o join public.content_takedowns t on t.id = o.takedown_id where t.document_id = pg_temp.d(1) and o.template = 'statement_of_reasons' and o.recipient = 'uploader@modtest.test' and o.payload ->> 'ground' = 'copyright' and (o.payload ->> 'fromReport')::boolean and (o.payload ->> 'activeStrikes')::int = 1 and o.payload ->> 'decidedAt' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'$q$);
select pg_temp.chk('A4 ... and the outcome to the reporter, never the reporter''s details to the uploader', $q$select count(*) = 1 from public.content_notice_outbox where template = 'reporter_outcome' and recipient = 'rights@modtest.test' and payload ->> 'decision' = 'actioned' and payload ->> 'action' = 'restrict' and not exists (select 1 from public.content_notice_outbox where template = 'statement_of_reasons' and payload::text like '%rights@modtest.test%')$q$);
select pg_temp.chk('A5 the lift queued its notice, the reject its outcome', $q$select exists (select 1 from public.content_notice_outbox where template = 'takedown_lifted' and recipient = 'uploader@modtest.test' and payload ->> 'reason' = 'Counter-notice, no court action') and exists (select 1 from public.content_notice_outbox where template = 'reporter_outcome' and recipient = 'someone@modtest.test' and payload ->> 'decision' = 'rejected' and payload ->> 'note' = 'No illegal content found')$q$);
-- A score owned by an account with no address: the notice is skipped, logged, and the answer says so.
insert into public.documents (id, owner_id, title, storage_path) values (pg_temp.d(3), pg_temp.u(3), 'Guest score', pg_temp.d(3)::text || '/original.pdf');
select pg_temp.as_service();
select pg_temp.chk('A6 an uploader with no address: decided, nothing queued, logged as skipped', $q$select (public.apply_content_takedown(pg_temp.d(3), 'restrict', 'terms', 'Terms', 'Facts', null, pg_temp.u(4)) -> 'uploader_notice_id') = 'null'::jsonb$q$);
reset role;
select pg_temp.chk('A7 ... with the skip in the log', $q$select exists (select 1 from public.content_notice_log l join public.content_takedowns t on t.id = l.takedown_id where t.document_id = pg_temp.d(3) and l.event = 'statement_of_reasons' and l.delivery = 'skipped')$q$);

-- Delivery, as the functions drive it.
select pg_temp.as_service();
create temp table t_claim as select * from public.claim_content_notices(50, '{}', 120);
grant all on t_claim to service_role;
select pg_temp.chk('A8 a claim leases the due rows and counts the attempt', $q$select count(*) > 0 and bool_and(attempts = 1 and claimed_until > now()) from t_claim$q$);
select pg_temp.chk('A9 a second claim gets none of them while the lease holds', $q$select not exists (select 1 from public.claim_content_notices(50, '{}', 120) c where c.id in (select id from t_claim))$q$);
reset role;
select pg_temp.as_service();
-- The acknowledgment above: out of budget first, then sent.
select public.finish_content_notice((select o.id from t_claim o where o.template = 'report_acknowledgment' and o.recipient = 'rights@modtest.test'), 'deferred', 1800);
reset role;
select pg_temp.chk('B1 out of budget: back in the queue until the window reopens, not an attempt, not logged', $q$select status = 'pending' and attempts = 0 and claimed_until is null and last_outcome = 'deferred' and next_attempt_at > now() + interval '29 minutes' and not exists (select 1 from public.content_notice_log l where (l.detail ->> 'notice_id')::uuid = o.id and l.delivery is distinct from 'queued') from public.content_notice_outbox o where template = 'report_acknowledgment' and recipient = 'rights@modtest.test'$q$);
select pg_temp.as_service();
select pg_temp.chk('B2 a deferred row is not due, but its own request may still send it first', $q$select not exists (select 1 from public.claim_content_notices(50, '{}', 120) c where c.recipient = 'rights@modtest.test' and c.template = 'report_acknowledgment') and exists (select 1 from public.claim_content_notices(1, array[(select id from public.content_notice_outbox where template = 'report_acknowledgment' and recipient = 'rights@modtest.test')], 120))$q$);
select public.finish_content_notice((select id from public.content_notice_outbox where template = 'report_acknowledgment' and recipient = 'rights@modtest.test'), 'sent');
-- The statement of reasons: fails twice.
select public.finish_content_notice((select o.id from t_claim o where o.template = 'statement_of_reasons' and o.recipient = 'uploader@modtest.test' and o.payload ->> 'ground' = 'copyright'), 'failed');
reset role;
select pg_temp.chk('B3 sent: done, the report marked acknowledged, the send logged', $q$select o.status = 'sent' and o.sent_at is not null and r.acknowledged_at is not null and exists (select 1 from public.content_notice_log l where (l.detail ->> 'notice_id')::uuid = o.id and l.delivery = 'sent') from public.content_notice_outbox o join public.content_reports r on r.id = o.report_id where o.template = 'report_acknowledgment' and o.recipient = 'rights@modtest.test'$q$);
select pg_temp.chk('B4 failed: kept, retried in a minute, the failure logged', $q$select o.status = 'pending' and o.last_outcome = 'failed' and o.next_attempt_at between now() + interval '50 seconds' and now() + interval '70 seconds' and exists (select 1 from public.content_notice_log l where (l.detail ->> 'notice_id')::uuid = o.id and l.delivery = 'failed') from public.content_notice_outbox o where o.template = 'statement_of_reasons' and o.payload ->> 'ground' = 'copyright'$q$);
update public.content_notice_outbox set next_attempt_at = now() - interval '1 second', attempts = 5 where template = 'statement_of_reasons' and payload ->> 'ground' = 'copyright';
select pg_temp.as_service();
select count(*) from public.claim_content_notices(50, '{}', 120);
select public.finish_content_notice((select id from public.content_notice_outbox where template = 'statement_of_reasons' and payload ->> 'ground' = 'copyright'), 'unconfigured');
reset role;
select pg_temp.chk('B5 each failure backs off further (the sixth: 32 minutes), and none drops the notice', $q$select status = 'pending' and attempts = 6 and last_outcome = 'unconfigured' and next_attempt_at between now() + interval '31 minutes' and now() + interval '33 minutes' from public.content_notice_outbox where template = 'statement_of_reasons' and payload ->> 'ground' = 'copyright'$q$);
select pg_temp.chk('B6 the backoff stops growing at six hours', $q$select least(interval '6 hours', interval '1 minute' * power(2, least(greatest(40 - 1, 0), 20))) = interval '6 hours'$q$);
select pg_temp.as_user(4);
select pg_temp.chk('B7 the moderator sees how many are owed, and how many are failing', $q$select (public.moderation_log() ->> 'undelivered')::int > 0 and (public.moderation_log() ->> 'failing')::int = 1$q$);
select pg_temp.refused_with('B8 even a moderator cannot read the outbox', $q$select count(*) from public.content_notice_outbox$q$, '42501', null);
select pg_temp.refused_with('B9 nor claim from it', $q$select public.claim_content_notices(1, '{}', 120)$q$, '42501', null);
select pg_temp.as_anon();
select pg_temp.refused_with('B10 nor can anon finish a notice', $q$select public.finish_content_notice(gen_random_uuid(), 'sent')$q$, '42501', null);
reset role;
select pg_temp.chk('B11 the retry runs every five minutes', $q$select exists (select 1 from cron.job where jobname = 'content-notice-retry' and schedule = '*/5 * * * *')$q$);
select pg_temp.chk('B12 without its vault secrets the retry tick is a no-op, not an error', $q$select public.content_notice_retry_tick() is null or true$q$);

-- ---- pagination: nothing drops out of reach behind 200 newer rows
-- 230 open reports and 230 live takedowns, all older than everything above,
-- plus as many decided reports and lifted takedowns newer than all of them.
-- The takedowns' scores are gone (document_id null, as when an uploader
-- deletes one): the plan's score cap would refuse 460 fixtures, and the lists
-- do not care.
insert into public.content_reports (created_at, kind, category, content_url, explanation, reporter_name, reporter_email, good_faith, signature)
select now() - interval '1 year' - n * interval '1 minute', 'illegal', 'other', 'https://cleffy.io/doc/bulk', 'Bulk report ' || n, 'Bulk', 'bulk@modtest.test', true, 'Bulk'
from generate_series(1, 230) n;
insert into public.content_reports (created_at, kind, category, content_url, explanation, reporter_name, reporter_email, good_faith, signature, status, decided_at)
select now() + n * interval '1 second', 'illegal', 'other', 'https://cleffy.io/doc/bulk', 'Decided ' || n, 'Bulk', 'bulk@modtest.test', true, 'Bulk', 'rejected', now()
from generate_series(1, 230) n;
insert into public.content_takedowns (created_at, document_id, uploader_id, document_title, action, ground, legal_basis, facts, lifted_at)
select case when n <= 230 then now() - interval '1 year' - n * interval '1 minute' else now() + n * interval '1 second' end,
       null, pg_temp.u(1), 'Bulk ' || n, 'restrict', 'terms', 'Terms', 'Bulk',
       case when n > 230 then now() end
from generate_series(1, 460) n;
insert into public.content_notice_log (event, detail) select 'report_received', jsonb_build_object('n', n) from generate_series(1, 450) n;

-- One open report newer than all the rest: last in the queue's order.
insert into public.content_reports (kind, category, content_url, explanation, reporter_name, reporter_email, good_faith, signature)
values ('illegal', 'other', 'https://cleffy.io/doc/bulk', 'Newest open', 'Bulk', 'bulk@modtest.test', true, 'Bulk');

-- Walked as the moderator; checked below as postgres against the tables,
-- which no client role can read.
create temp table t_walk (name text primary key, ids uuid[], log_ids bigint[], total int);
grant all on t_walk to authenticated;
select pg_temp.as_user(4);
insert into t_walk select 'open', pg_temp.walk('reports', 'open', 25), null, (public.moderation_reports('open') ->> 'total')::int;
insert into t_walk select 'open100', pg_temp.walk('reports', 'open', 100), null, null;
insert into t_walk select 'decided', pg_temp.walk('reports', 'decided', 30), null, (public.moderation_reports('decided') ->> 'total')::int;
insert into t_walk select 'active', pg_temp.walk('takedowns', 'active', 25), null, (public.moderation_takedowns('active') ->> 'total')::int;
insert into t_walk select 'lifted', pg_temp.walk('takedowns', 'lifted', 50), null, null;
insert into t_walk select 'log', null, pg_temp.walk_log(40), null;
select pg_temp.chk('91 open reports read oldest first: the oldest is on page one', $q$select public.moderation_reports('open', null, null, 25) -> 'rows' -> 0 ->> 'explanation' = 'Bulk report 230'$q$);
select pg_temp.chk('97 a page is never more than 100 rows', $q$select jsonb_array_length(public.moderation_reports('open', null, null, 100000) -> 'rows') = 100$q$);
select pg_temp.refused_with('98 a half cursor is refused, not read as the first page', $q$select public.moderation_reports('open', now(), null, 25)$q$, '22023', null);
reset role;
select pg_temp.chk('90 open reports: walking every page reaches each open one, once', $q$select cardinality(ids) = total and total = (select count(*) from public.content_reports where status = 'received') and cardinality(ids) = (select count(distinct x) from unnest(ids) x) and ids @> (select array_agg(id) from public.content_reports where status = 'received') from t_walk where name = 'open'$q$);
select pg_temp.chk('92 the 231st open report is still reached (no 200 cap)', $q$select cardinality(ids) = 231 and (select explanation from public.content_reports where id = ids[231]) = 'Newest open' from t_walk where name = 'open100'$q$);
select pg_temp.chk('93 decided reports walk too, newest first', $q$select cardinality(ids) = total and total = (select count(*) from public.content_reports where status <> 'received') and (select explanation from public.content_reports where id = ids[1]) = 'Decided 230' from t_walk where name = 'decided'$q$);
select pg_temp.chk('94 live takedowns: every one is reached, the oldest last', $q$select cardinality(ids) = total and total = (select count(*) from public.content_takedowns where lifted_at is null) and (select document_title from public.content_takedowns where id = ids[cardinality(ids)]) = 'Bulk 230' from t_walk where name = 'active'$q$);
select pg_temp.chk('95 lifted takedowns are their own list', $q$select cardinality(ids) = (select count(*) from public.content_takedowns where lifted_at is not null) from t_walk where name = 'lifted'$q$);
select pg_temp.chk('96 the log walks back to its first entry', $q$select cardinality(log_ids) = (select count(*) from public.content_notice_log) and log_ids[cardinality(log_ids)] = (select min(id) from public.content_notice_log) from t_walk where name = 'log'$q$);
select pg_temp.as_service();
select pg_temp.chk('99 the oldest live takedown, on the last page, can be lifted', $q$select (public.lift_content_takedown((select id from public.content_takedowns where document_title = 'Bulk 230'), 'Restored', pg_temp.u(4)) ->> 'document_title') = 'Bulk 230'$q$);
select pg_temp.chk('99b and the oldest open report decided', $q$select public.reject_content_report((select id from public.content_reports where explanation = 'Bulk report 230'), 'No action', pg_temp.u(4)) ->> 'reference' is not null$q$);
reset role;

-- ---- table rules
select pg_temp.refused_with('60 a copyright report needs the perjury statement', $q$insert into public.content_reports (kind, category, content_url, work_description, explanation, reporter_name, reporter_email, good_faith, perjury_statement, signature) values ('copyright', 'copyright', 'u', 'w', 'e', 'n', 'n@x.test', true, false, 's')$q$, '23514', null);
select pg_temp.refused_with('61 a report needs the good-faith statement', $q$insert into public.content_reports (kind, category, content_url, explanation, reporter_name, reporter_email, good_faith, signature) values ('illegal', 'other', 'u', 'e', 'n', 'n@x.test', false, 's')$q$, '23514', null);

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
