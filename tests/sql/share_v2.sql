-- Behaviour proof for Share v2's four migrations (#104):
-- 20261113120000_share_v2_links, 20261113120100_share_v2_viewer_auth,
-- 20261113120200_share_v2_invites and 20261113120300_share_v2_link_guests.
--
--   * D15 link expiry: 7 days by default, 1 hour to 365 days or never.
--   * The owner RPCs refuse non-owners, guests, roster students and dead
--     scores; a score has at most one live general link; peek and redeem keep
--     today's answers and add the link's state.
--   * A signed-out viewer token (anon, iss cleffy-share, cleffy_link) opens its
--     own score's snapshot and nothing else, in every claim case; it reads no
--     table and executes only the anon allow-list; an authenticated token with
--     a forged claim gets nothing more.
--   * Realtime: the viewer reads broadcast on doc: and doc-view: at the current
--     generation, tracks presence on doc: only, sends no broadcast, gets
--     nothing on doc-db: or an old generation.
--   * Restricted, reset, revoke and an editor-to-viewer change each rotate the
--     score once per commit and withdraw, keep or demote the link's members.
--   * The mark whitelist (PR #98's cases) and the doc-view fan-out.
--   * Invites, the retention crons, the link-guest age gate and D8.
--
-- Needs the local stack running, so today's realtime.messages partition exists
-- (`npm run cloud:up`). Runs inside one transaction and ROLLS BACK:
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/share_v2.sql
--
-- Every row of the result table should read `t`; the last line is
-- `failures | total`. No DROP / DELETE / TRUNCATE keyword (see README.md).
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role, supabase_auth_admin;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('5a2e0000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.d(n int) returns uuid language sql immutable as $f$ select ('5a2e00d0-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
-- Must raise exactly this SQLSTATE (and, when given, carry this detail code).
create function pg_temp.refused(p_name text, p_sql text, p_state text, p_code text default null) returns void language plpgsql as $f$
declare v_state text; v_message text; v_detail text;
begin
execute p_sql;
insert into t_results values (p_name, false, 'no error raised');
exception when others then
get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail;
insert into t_results values (p_name,
    v_state = p_state and (p_code is null or (v_detail::jsonb ->> 'code') = p_code),
    v_state || ' ' || v_message || ' ' || coalesce(v_detail, ''));
end $f$;
create function pg_temp.as_user(n int, anonymous boolean default false) returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(n), 'role', 'authenticated', 'is_anonymous', anonymous)::text, true);
perform set_config('role', 'authenticated', true);
end $f$;
create function pg_temp.as_jwt(p_role text, p_claims jsonb) returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', p_claims::text, true);
perform set_config('role', p_role, true);
end $f$;
-- A share-session token for (doc, link), with any claim overridden.
create function pg_temp.viewer_claims(p_doc uuid, p_link uuid, p_extra jsonb default '{}') returns jsonb language sql stable as $f$
    select jsonb_build_object(
        'iss', 'cleffy-share', 'role', 'anon', 'aud', 'authenticated',
        'iat', floor(extract(epoch from now())), 'exp', floor(extract(epoch from now())) + 600,
        'cleffy_link', jsonb_build_object('doc', p_doc, 'link', p_link, 'v', 1)
    ) || p_extra
$f$;
create function pg_temp.as_viewer(p_doc uuid, p_link uuid, p_extra jsonb default '{}') returns void language plpgsql as $f$
begin perform pg_temp.as_jwt('anon', pg_temp.viewer_claims(p_doc, p_link, p_extra)); end $f$;
create function pg_temp.as_service() returns void language plpgsql as $f$
begin perform pg_temp.as_jwt('service_role', '{"role":"service_role"}'); end $f$;
create function pg_temp.as_postgres() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', '', true);
perform set_config('role', 'none', true);
end $f$;
create function pg_temp.at_commit() returns boolean language plpgsql as $f$
begin
set constraints public.document_realtime_rotation_queue_rotate immediate;
set constraints public.document_realtime_rotation_queue_rotate deferred;
return true;
end $f$;
-- A join is a read of realtime.messages under the joining role with
-- realtime.topic set (realtime_revocation_rotation.sql).
create function pg_temp.can_read(p_topic text, p_extension text default 'broadcast') returns boolean language plpgsql as $f$
declare v boolean; v_role text := current_setting('role');
begin
    perform set_config('role', 'postgres', true);
    insert into realtime.messages (topic, extension, event, payload, private) values (p_topic, p_extension, 'probe', '{}', true);
    perform set_config('role', v_role, true);
    perform set_config('realtime.topic', p_topic, true);
    execute 'select count(*) > 0 from realtime.messages where topic = $1 and extension = $2' into v using p_topic, p_extension;
    perform set_config('realtime.topic', '', true);
    return v;
end $f$;
create function pg_temp.can_insert(p_topic text, p_extension text) returns boolean language plpgsql as $f$
begin
    perform set_config('realtime.topic', p_topic, true);
    begin
        insert into realtime.messages (topic, extension, event, payload, private) values (p_topic, p_extension, 'ink:progress', '{}', true);
    exception when insufficient_privilege then
        perform set_config('realtime.topic', '', true);
        return false;
    end;
    perform set_config('realtime.topic', '', true);
    return true;
end $f$;
create function pg_temp.topic(p_prefix text, p_doc uuid, p_epoch int) returns text language sql immutable as $f$
    select p_prefix || ':' || p_doc::text || case when p_epoch = 0 then '' else ':' || p_epoch::text end
$f$;
create function pg_temp.epoch(p_doc uuid) returns int language sql security definer as $f$
    select coalesce((select e.epoch from public.document_realtime_epochs e where e.document_id = p_doc), 0)
$f$;
create temp table t_epoch (doc uuid primary key, epoch int);
grant all on t_epoch to anon, authenticated, service_role;
create function pg_temp.mark_epoch(p_doc uuid) returns void language sql as $f$
    insert into t_epoch values (p_doc, pg_temp.epoch(p_doc)) on conflict (doc) do update set epoch = excluded.epoch
$f$;
create function pg_temp.moved(p_doc uuid) returns int language sql as $f$
    select pg_temp.epoch(p_doc) - (select t.epoch from t_epoch t where t.doc = p_doc)
$f$;
create function pg_temp.member_role(p_doc uuid, p_user uuid) returns text language sql security definer as $f$
    select dm.role from public.document_members dm where dm.document_id = p_doc and dm.user_id = p_user
$f$;
create function pg_temp.view_msgs(p_doc uuid, p_event text) returns bigint language sql as $f$
    select count(*) from realtime.messages m where m.topic like 'doc-view:' || p_doc::text || '%' and m.event = p_event
$f$;
create function pg_temp.all_keys(j jsonb) returns setof text language sql immutable as $f$
    with recursive walk(v) as (
        select j
        union all
        select e.value from walk, lateral (
            select o.value from jsonb_each(case when jsonb_typeof(walk.v) = 'object' then walk.v end) o
            union all
            select a.value from jsonb_array_elements(case when jsonb_typeof(walk.v) = 'array' then walk.v end) a
        ) e
    )
    select k from walk, jsonb_object_keys(walk.v) k where jsonb_typeof(walk.v) = 'object'
$f$;
create temp table t_link (name text primary key, id uuid, token text);
grant all on t_link to anon, authenticated, service_role;
create function pg_temp.link_id(p_name text) returns uuid language sql as $f$ select id from t_link where name = p_name $f$;
create function pg_temp.link_token(p_name text) returns text language sql as $f$ select token from t_link where name = p_name $f$;
create function pg_temp.keep_link(p_name text, p_doc uuid) returns void language sql as $f$
    insert into t_link
    select p_name, l.id, l.token from public.share_links l
    where l.document_id = p_doc and l.general and l.revoked_at is null
    on conflict (name) do update set id = excluded.id, token = excluded.token
$f$;
-- A writing call's answer, kept for the checks that follow: a check that
-- reads what the call wrote has to be a later statement (a statement reads
-- one snapshot, taken before the call ran).
create temp table t_out (name text primary key, val jsonb);
grant all on t_out to anon, authenticated, service_role;
create function pg_temp.run(p_name text, p_sql text) returns void language plpgsql as $f$
declare v jsonb;
begin
    execute format('select to_jsonb((%s))', p_sql) into v;
    insert into t_out values (p_name, v) on conflict (name) do update set val = excluded.val;
end $f$;
create function pg_temp.out(p_name text) returns jsonb language sql as $f$ select val from t_out where name = p_name $f$;
create function pg_temp.exec(p_sql text) returns void language plpgsql as $f$ begin execute p_sql; end $f$;
create function pg_temp.sha(p text) returns bytea language sql immutable as $f$ select extensions.digest(p, 'sha256') $f$;

-- ---- fixtures
-- 1 owner (teacher of 4), 2 another owner (teacher of 10), 3 a guest, 4 roster
-- student of 1, 5 and 6 joiners, 7 a link guest, 8 and 13 more owners, 9 a
-- regular guest, 10 roster student of 2, 11 an existing account to invite,
-- 12 owner for reset/revoke/retention, 14 and 15 link guests for D8.
insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, last_sign_in_at)
select pg_temp.u(n),
       case when n in (3, 7, 9, 14, 15) then null else 's2-' || n || '@sharev2.test' end,
       case when n in (4, 10) then '{"user_type":"student"}'::jsonb else '{}'::jsonb end,
       case
           when n in (7, 14, 15) then '{"age_gate":{"source":"link_guest","v":2}}'::jsonb
           when n = 1 then '{"display_name":"Ms Owner"}'::jsonb
           else '{}'::jsonb
       end,
       n in (3, 7, 9, 14, 15),
       now(), now()
from generate_series(1, 15) n;
insert into public.managed_students (id, teacher_id, student_user_id, display_name, auth_method, username, claimed_at, student_email)
values (pg_temp.d(90), pg_temp.u(1), pg_temp.u(4), 'Four', 'code', 's2_four', now(), null),
       (pg_temp.d(91), pg_temp.u(2), pg_temp.u(10), 'Ten', 'email', null, now(), 'ten.student@sharev2.test');
-- d1 main viewer link, d2 "doc B", d3 editor link (owner 1); d4 archived, d6
-- removed, d7 restricted (owner 2); d5 the roster student's own; d8 reset,
-- d9 revoke, d10 fan-out (owner 12); d11 owner 8; d12 owner 13.
insert into public.documents (id, owner_id, title, storage_path, page_count)
select pg_temp.d(n),
       case when n in (1, 2, 3) then pg_temp.u(1) when n in (4, 6, 7) then pg_temp.u(2)
            when n in (8, 9, 10) then pg_temp.u(12) when n = 11 then pg_temp.u(8) else pg_temp.u(13) end,
       'Share v2 score ' || n, pg_temp.d(n)::text || '/original.pdf', 3
from generate_series(1, 12) n;
-- A roster student's plan holds no scores; d5 is handed to the student the way
-- a score could have reached them before (the cap only gates new scores).
update public.documents set owner_id = pg_temp.u(4) where id = pg_temp.d(5);
update public.document_members set user_id = pg_temp.u(4) where document_id = pg_temp.d(5) and role = 'owner';
insert into public.annotations (id, document_id, page, kind, color, payload, created_by) values
('5a2e00a0-0000-4000-8000-000000000001', pg_temp.d(1), 0, 'stroke', '#000', '{"pts":[0,0,1],"w":0.02}', pg_temp.u(1)),
('5a2e00a0-0000-4000-8000-000000000002', pg_temp.d(1), 1, 'stroke', '#00f', '{"pts":[0,0,1],"w":0.02}', pg_temp.u(1)),
('5a2e00a0-0000-4000-8000-000000000009', pg_temp.d(2), 0, 'stroke', '#000', '{"pts":[0,0,1],"w":0.02}', pg_temp.u(1));

-- ===========================================================================
-- Shape
-- ===========================================================================
select pg_temp.chk('001 share_links has id (unique, set on every row), general and updated_at', $q$
    select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'share_links'
            and column_name in ('id', 'general', 'updated_at')) = 3
       and not exists (select 1 from public.share_links where id is null)
       and to_regclass('public.share_links_id_key') is not null$q$);
select pg_temp.chk('002 one live general link per score is a partial unique index', $q$
    select indexdef like '%UNIQUE%' and indexdef like '%WHERE (general AND (revoked_at IS NULL))%'
    from pg_indexes where indexname = 'share_links_one_general'$q$);
select pg_temp.chk('003 PR #98''s view links are gone: no table, no function, no job', $q$
    select to_regclass('public.view_links') is null
       and not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                       and (proname like 'view\_link\_%' or proname like '%\_view\_link' or proname = 'view_mark_for_viewer'))
       and not exists (select 1 from cron.job where jobname = 'retention-view-links')$q$);
select pg_temp.chk('004 the two retention jobs are scheduled, once each', $q$
    select (select count(*) from cron.job where jobname = 'retention-share-links' and schedule = '53 3 * * *') = 1
       and (select count(*) from cron.job where jobname = 'retention-share-invites' and schedule = '3 4 * * *') = 1$q$);

-- ===========================================================================
-- D15: link expiry
-- ===========================================================================
select pg_temp.chk('010 never is null', $q$select public.share_link_expiry(null) is null$q$);
select pg_temp.chk('011 1 hour, 7 days and 365 days are accepted', $q$
    select public.share_link_expiry('1 hour') = now() + interval '1 hour'
       and public.share_link_expiry('7 days') = now() + interval '7 days'
       and public.share_link_expiry('365 days') = now() + interval '365 days'$q$);
select pg_temp.refused('012 59 minutes is refused with invalid_link_expiry', $q$select public.share_link_expiry('59 minutes')$q$, '22023', 'invalid_link_expiry');
select pg_temp.refused('013 366 days is refused with invalid_link_expiry', $q$select public.share_link_expiry('366 days')$q$, '22023', 'invalid_link_expiry');
select pg_temp.chk('014 a link inserted with no expiry expires in 7 days', $q$
    with l as (insert into public.share_links (document_id, role, created_by) values (pg_temp.d(11), 'viewer', pg_temp.u(8)) returning expires_at)
    select expires_at = now() + interval '7 days' from l$q$);
select pg_temp.as_user(1);
select pg_temp.chk('015 today''s client choices still insert: 7 days, 30 days and never', $q$
    with l as (
        insert into public.share_links (document_id, role, created_by, expires_at) values
        (pg_temp.d(1), 'viewer', pg_temp.u(1), now() + interval '7 days'),
        (pg_temp.d(1), 'editor', pg_temp.u(1), now() + interval '30 days'),
        (pg_temp.d(1), 'viewer', pg_temp.u(1), null)
        returning general)
    select count(*) = 3 and not bool_or(general) from l$q$);
select pg_temp.refused('016 a client link expiring in 30 minutes is refused', $q$
    insert into public.share_links (document_id, role, created_by, expires_at) values (pg_temp.d(1), 'viewer', pg_temp.u(1), now() + interval '30 minutes')$q$,
    '22023', 'invalid_link_expiry');
select pg_temp.refused('017 a client link expiring in two years is refused', $q$
    insert into public.share_links (document_id, role, created_by, expires_at) values (pg_temp.d(1), 'viewer', pg_temp.u(1), now() + interval '2 years')$q$,
    '22023', 'invalid_link_expiry');
select pg_temp.refused('018 set_general_access refuses 30 minutes', $q$select * from public.set_general_access(pg_temp.d(2), 'anyone', 'viewer', '30 minutes')$q$, '22023', 'invalid_link_expiry');
select pg_temp.chk('019 set_general_access defaults to 7 days', $q$
    select expires_at = now() + interval '7 days' and role = 'viewer' from public.set_general_access(pg_temp.d(1), 'anyone')$q$);
select pg_temp.keep_link('d1', pg_temp.d(1));
select pg_temp.chk('020 set_general_access with null expires never, and keeps the same link', $q$
    select expires_at is null and link_id = pg_temp.link_id('d1')
    from public.set_general_access(pg_temp.d(1), 'anyone', 'viewer', null)$q$);
select pg_temp.chk('021 back to 7 days', $q$
    select expires_at = now() + interval '7 days' from public.set_general_access(pg_temp.d(1), 'anyone', 'viewer', '7 days')$q$);
select pg_temp.refused('022 renew refuses 400 days', $q$select public.renew_share_link(pg_temp.link_id('d1'), '400 days')$q$, '22023', 'invalid_link_expiry');
select pg_temp.as_postgres();
update public.share_links set expires_at = now() - interval '1 minute' where id = pg_temp.link_id('d1');
select pg_temp.chk('023 an expired general link reads expired', $q$
    select state = 'expired' and not valid from public.peek_share_link(pg_temp.link_token('d1'))$q$);
select pg_temp.as_user(1);
select pg_temp.run('renew', $q$public.renew_share_link(pg_temp.link_id('d1'))$q$);
select pg_temp.chk('024 renewing it (default 7 days) makes it live again', $q$
    select (pg_temp.out('renew') #>> '{}')::timestamptz = now() + interval '7 days'
       and (select state = 'live' and valid from public.peek_share_link(pg_temp.link_token('d1')))$q$);
select pg_temp.chk('025 renew accepts 1 hour, 365 days and never', $q$
    select public.renew_share_link(pg_temp.link_id('d1'), '1 hour') = now() + interval '1 hour'
       and public.renew_share_link(pg_temp.link_id('d1'), '365 days') = now() + interval '365 days'
       and public.renew_share_link(pg_temp.link_id('d1'), null) is null
       and public.renew_share_link(pg_temp.link_id('d1'), '7 days') = now() + interval '7 days'$q$);

-- ===========================================================================
-- One general link; what a client may still do directly
-- ===========================================================================
select pg_temp.refused('030 an owner cannot insert a general link directly', $q$
    insert into public.share_links (document_id, role, created_by, general) values (pg_temp.d(1), 'viewer', pg_temp.u(1), true)$q$, '42501');
select pg_temp.refused('031 an owner cannot update the general link directly', $q$
    update public.share_links set role = 'editor' where id = pg_temp.link_id('d1')$q$, '42501');
select pg_temp.refused('032 an owner cannot delete the general link directly', $q$
    select pg_temp.exec('del' || 'ete from public.share_links where id = ' || quote_literal(pg_temp.link_id('d1')))$q$, '42501');
select pg_temp.chk('033 an older link''s role and expiry still update directly (today''s client)', $q$
    with l as (update public.share_links set role = 'editor', expires_at = now() + interval '30 days'
               where document_id = pg_temp.d(1) and not general and expires_at is null returning updated_at)
    select count(*) = 1 and bool_and(updated_at = now()) from l$q$);
select pg_temp.refused('034 an older link''s id cannot change', $q$
    update public.share_links set id = gen_random_uuid() where document_id = pg_temp.d(1) and not general$q$, '42501');
select pg_temp.as_postgres();
select pg_temp.refused('035 a second live general link for a score is impossible', $q$
    insert into public.share_links (document_id, role, created_by, general) values (pg_temp.d(1), 'viewer', pg_temp.u(1), true)$q$, '23505');
select pg_temp.chk('036 exactly one live general link on d1', $q$
    select count(*) = 1 from public.share_links where document_id = pg_temp.d(1) and general and revoked_at is null$q$);

-- ===========================================================================
-- Owner RPC refusals: non-owner, guest, roster student, dead score
-- ===========================================================================
-- General links on the student's own score and on the scores about to die.
insert into public.share_links (document_id, role, created_by, general) values
(pg_temp.d(5), 'viewer', pg_temp.u(4), true),
(pg_temp.d(4), 'viewer', pg_temp.u(2), true),
(pg_temp.d(7), 'viewer', pg_temp.u(2), true),
(pg_temp.d(6), 'viewer', pg_temp.u(2), true);
select pg_temp.keep_link('d5', pg_temp.d(5));
select pg_temp.keep_link('d4', pg_temp.d(4));
select pg_temp.keep_link('d6', pg_temp.d(6));
select pg_temp.keep_link('d7', pg_temp.d(7));
update public.documents set archived_at = now(), archived_reason = 'plan_lapse' where id = pg_temp.d(4);
insert into public.content_takedowns (document_id, action, ground, legal_basis, facts) values
(pg_temp.d(6), 'remove', 'copyright', 'test', 'test'),
(pg_temp.d(7), 'restrict', 'copyright', 'test', 'test');
create function pg_temp.refusal_matrix(p_rpc text, p_call text) returns void language plpgsql as $f$
begin
    perform pg_temp.as_user(2);
    perform pg_temp.refused('04' || p_rpc || 'a refuses a non-owner', format(p_call, 'd1'), '42501');
    perform pg_temp.as_user(3, true);
    perform pg_temp.refused('04' || p_rpc || 'b refuses a guest', format(p_call, 'd1'), '42501');
    perform pg_temp.as_user(4);
    perform pg_temp.refused('04' || p_rpc || 'c refuses a roster student on their own score', format(p_call, 'd5'), '42501');
    perform pg_temp.as_user(2);
    perform pg_temp.refused('04' || p_rpc || 'd refuses the owner of an archived score', format(p_call, 'd4'), '42501');
    perform pg_temp.refused('04' || p_rpc || 'e refuses the owner of a restricted score', format(p_call, 'd7'), '42501');
    perform pg_temp.refused('04' || p_rpc || 'f refuses the owner of a removed score', format(p_call, 'd6'), '42501');
    perform pg_temp.as_postgres();
end $f$;
create function pg_temp.doc_of(p_name text) returns uuid language sql security definer as $f$
    select document_id from public.share_links where id = pg_temp.link_id(p_name)
$f$;
select pg_temp.refusal_matrix('1 set_general_access ', $q$select * from public.set_general_access(pg_temp.doc_of('%s'), 'anyone')$q$);
select pg_temp.refusal_matrix('2 reset_general_link ', $q$select * from public.reset_general_link(pg_temp.doc_of('%s'))$q$);
select pg_temp.refusal_matrix('3 renew_share_link ', $q$select public.renew_share_link(pg_temp.link_id('%s'))$q$);
select pg_temp.refusal_matrix('4 revoke_share_link ', $q$select public.revoke_share_link(pg_temp.link_token('%s'))$q$);
select set_config('request.jwt.claims', '', true);
select pg_temp.refused('045 no session is refused', $q$select * from public.set_general_access(pg_temp.d(1), 'anyone')$q$, '28000');
select pg_temp.as_user(1);
select pg_temp.refused('046 an unknown mode is refused', $q$select * from public.set_general_access(pg_temp.d(1), 'everyone')$q$, '22023', 'invalid_mode');
select pg_temp.refused('047 an unknown role is refused', $q$select * from public.set_general_access(pg_temp.d(1), 'anyone', 'owner')$q$, '22023', 'invalid_role');
select pg_temp.refused('048 reset with no general link says so', $q$select * from public.reset_general_link(pg_temp.d(2))$q$, 'P0002', 'no_general_link');
select pg_temp.as_postgres();

-- ===========================================================================
-- peek and redeem
-- ===========================================================================
insert into t_link (name, id, token)
select 'legacy_live', l.id, l.token from public.share_links l where l.document_id = pg_temp.d(1) and not general and l.role = 'viewer' limit 1;
insert into public.share_links (document_id, role, created_by, expires_at, revoked_at) values
(pg_temp.d(2), 'viewer', pg_temp.u(1), null, now()),
(pg_temp.d(2), 'viewer', pg_temp.u(1), now() - interval '1 day', null);
insert into t_link select 'legacy_revoked', id, token from public.share_links where document_id = pg_temp.d(2) and revoked_at is not null;
insert into t_link select 'legacy_expired', id, token from public.share_links where document_id = pg_temp.d(2) and expires_at < now();
select pg_temp.as_jwt('anon', '{"role":"anon"}');
select pg_temp.chk('050 peek, live: valid, its role, state live', $q$
    select valid and role = 'viewer' and state = 'live' from public.peek_share_link(pg_temp.link_token('legacy_live'))$q$);
select pg_temp.chk('051 peek, revoked: not valid, no role, state revoked', $q$
    select not valid and role is null and state = 'revoked' from public.peek_share_link(pg_temp.link_token('legacy_revoked'))$q$);
select pg_temp.chk('052 peek, expired: not valid, no role, state expired', $q$
    select not valid and role is null and state = 'expired' from public.peek_share_link(pg_temp.link_token('legacy_expired'))$q$);
select pg_temp.chk('053 peek, unknown: one row, not valid, state invalid', $q$
    select count(*) = 1 and bool_and(not valid and role is null and state = 'invalid') from public.peek_share_link('nope-nope-nope-nope-no')$q$);
select pg_temp.chk('054 peek, a live link to an archived score: valid as before, state unavailable', $q$
    select valid and state = 'unavailable' from public.peek_share_link(pg_temp.link_token('d4'))$q$);
select pg_temp.chk('055 anon may peek but not redeem', $q$
    select has_function_privilege('anon', 'public.peek_share_link(text)', 'execute')
       and not has_function_privilege('anon', 'public.redeem_share_link(text)', 'execute')$q$);
select pg_temp.as_user(5);
select pg_temp.refused('056 redeem, revoked: PT404 invalid_share_link with state revoked', $q$
    select * from public.redeem_share_link(pg_temp.link_token('legacy_revoked'))$q$, 'PT404', 'invalid_share_link');
select pg_temp.chk('057 ... and the detail carries the state', $q$
    select t.detail like '%"state" : "revoked"%' from t_results t where t.name like '056%'$q$);
select pg_temp.refused('058 redeem, unknown: state invalid', $q$
    select * from public.redeem_share_link('nope-nope-nope-nope-no')$q$, 'PT404', 'invalid_share_link');
select pg_temp.chk('059 ... with state invalid in the detail', $q$
    select t.detail like '%"state" : "invalid"%' from t_results t where t.name like '058%'$q$);
select pg_temp.as_postgres();

-- ===========================================================================
-- The viewer token: claim matrix
-- ===========================================================================
insert into t_link select 'legacy_d1_viewer', id, token from public.share_links where document_id = pg_temp.d(1) and not general and role = 'viewer' and expires_at is not null limit 1;
-- d2's general link, for the expired and revoked cases.
insert into public.share_links (document_id, role, created_by, general, expires_at) values (pg_temp.d(2), 'viewer', pg_temp.u(1), true, now() - interval '1 minute');
select pg_temp.keep_link('d2_expired', pg_temp.d(2));
insert into public.share_links (document_id, role, created_by, general, revoked_at) values (pg_temp.d(3), 'viewer', pg_temp.u(1), true, now());
insert into t_link select 'd3_revoked', id, token from public.share_links where document_id = pg_temp.d(3) and general;
insert into public.share_links (document_id, role, created_by, general) values (pg_temp.d(11), 'editor', pg_temp.u(8), true);
select pg_temp.keep_link('d11_editor', pg_temp.d(11));
create function pg_temp.claim_case(p_name text, p_doc uuid, p_link uuid, p_status text, p_extra jsonb default '{}') returns void language plpgsql as $f$
begin
    perform pg_temp.as_viewer(p_doc, p_link, p_extra);
    perform pg_temp.chk(p_name || ' (access)', format($q$select public.link_view_access() = jsonb_build_object('status', %L)$q$, p_status));
    perform pg_temp.refused(p_name || ' (no document, no snapshot)', $q$select public.link_view_snapshot()$q$, 'PT403', p_status);
    perform pg_temp.as_postgres();
end $f$;
select pg_temp.as_viewer(pg_temp.d(1), pg_temp.link_id('d1'));
select pg_temp.chk('060 the viewer token for d1''s live general link: open, with the generation, the score and the expiry', $q$
    select a ->> 'status' = 'open' and (a ->> 'epoch')::int = 0 and (a ->> 'doc')::uuid = pg_temp.d(1)
       and (a ->> 'link_expires_at')::timestamptz = now() + interval '7 days'
    from public.link_view_access() a$q$);
select pg_temp.chk('061 its snapshot is d1''s title, page count and marks', $q$
    select s -> 'doc' = jsonb_build_object('title', 'Share v2 score 1', 'page_count', 3, 'content_rev', 0)
       and jsonb_array_length(s -> 'marks') = 2 and not (s ->> 'more')::boolean
    from public.link_view_snapshot() s$q$);
select pg_temp.claim_case('062 doc B under d1''s link: invalid', pg_temp.d(2), pg_temp.link_id('d1'), 'invalid');
select pg_temp.claim_case('063 another link id: invalid', pg_temp.d(1), gen_random_uuid(), 'invalid');
select pg_temp.claim_case('064 an older (not general) viewer link of d1: invalid', pg_temp.d(1), pg_temp.link_id('legacy_d1_viewer'), 'invalid');
select pg_temp.claim_case('065 an expired general link: expired', pg_temp.d(2), pg_temp.link_id('d2_expired'), 'expired');
select pg_temp.claim_case('066 a revoked general link: revoked', pg_temp.d(3), pg_temp.link_id('d3_revoked'), 'revoked');
select pg_temp.claim_case('067 an archived score: unavailable', pg_temp.d(4), pg_temp.link_id('d4'), 'unavailable');
select pg_temp.claim_case('068 a restricted score: unavailable', pg_temp.d(7), pg_temp.link_id('d7'), 'unavailable');
select pg_temp.claim_case('069 a removed score: unavailable', pg_temp.d(6), pg_temp.link_id('d6'), 'unavailable');
select pg_temp.claim_case('070 an editor general link: invalid', pg_temp.d(11), pg_temp.link_id('d11_editor'), 'invalid');
select pg_temp.claim_case('071 version 2 of the claim: invalid', pg_temp.d(1), pg_temp.link_id('d1'), 'invalid',
    jsonb_build_object('cleffy_link', jsonb_build_object('doc', pg_temp.d(1), 'link', pg_temp.link_id('d1'), 'v', 2)));
select pg_temp.claim_case('072 another issuer: invalid', pg_temp.d(1), pg_temp.link_id('d1'), 'invalid', '{"iss":"supabase"}');
select pg_temp.claim_case('073 a malformed id: invalid, and nothing throws', pg_temp.d(1), pg_temp.link_id('d1'), 'invalid',
    '{"cleffy_link":{"doc":"not-a-uuid","link":"x","v":1}}');
select pg_temp.claim_case('074 an anon session whose claim says authenticated: invalid', pg_temp.d(1), pg_temp.link_id('d1'), 'invalid', '{"role":"authenticated"}');
select pg_temp.as_viewer(pg_temp.d(3), pg_temp.link_id('d3_revoked'));
select pg_temp.refused('075 a revoked link''s snapshot is refused with 403 and its state', $q$select public.link_view_snapshot()$q$, 'PT403', 'revoked');
select pg_temp.as_viewer(pg_temp.d(2), pg_temp.link_id('d1'));
select pg_temp.refused('076 doc B''s snapshot is refused as invalid', $q$select public.link_view_snapshot()$q$, 'PT403', 'invalid');
select pg_temp.as_postgres();
select pg_temp.as_postgres();

-- What link_view_claims makes of the session's token, read from inside a
-- definer function as the policies' helpers do.
create function pg_temp.claims_seen() returns bigint language sql security definer as $f$ select count(*) from public.link_view_claims() $f$;
select pg_temp.as_viewer(pg_temp.d(1), pg_temp.link_id('d1'));
select pg_temp.chk('077 the same function does see a real viewer token', $q$select pg_temp.claims_seen() = 1$q$);
select pg_temp.as_postgres();
-- An authenticated token with a forged cleffy_link (sub of a non-member).
select pg_temp.as_jwt('authenticated', pg_temp.viewer_claims(pg_temp.d(1), pg_temp.link_id('d1'),
    jsonb_build_object('role', 'authenticated', 'sub', pg_temp.u(5))));
select pg_temp.refused('078 a forged claim on an authenticated token cannot call the viewer functions', $q$select public.link_view_access()$q$, '42501');
select pg_temp.chk('079 ... reads nothing on d1''s topics', $q$
    select not pg_temp.can_read(pg_temp.topic('doc', pg_temp.d(1), 0))
       and not pg_temp.can_read(pg_temp.topic('doc-view', pg_temp.d(1), 0))$q$);
select pg_temp.chk('080 ... and the claim is not honoured even where it is evaluated', $q$select pg_temp.claims_seen() = 0$q$);
select pg_temp.as_postgres();

-- ===========================================================================
-- What a viewer token may touch
-- ===========================================================================
create function pg_temp.reads_nothing(p_table text) returns boolean language plpgsql as $f$
declare v bigint;
begin
    execute format('select count(*) from %s', p_table) into v;
    return v = 0;
exception when insufficient_privilege then
    return true;
end $f$;
select pg_temp.as_viewer(pg_temp.d(1), pg_temp.link_id('d1'));
select pg_temp.chk('090 the viewer reads none of annotations, documents, document_members, share_links, document_invites, storage.objects', $q$
    select pg_temp.reads_nothing('public.annotations') and pg_temp.reads_nothing('public.documents')
       and pg_temp.reads_nothing('public.document_members') and pg_temp.reads_nothing('public.share_links')
       and pg_temp.reads_nothing('public.document_invites') and pg_temp.reads_nothing('storage.objects')$q$);
select pg_temp.as_postgres();
create temp table t_allow (fn regprocedure);
insert into t_allow values
('public.consent_age(text)'), ('public.peek_share_link(text)'), ('public.record_web_events(jsonb)'),
('public.link_view_access()'), ('public.link_view_snapshot(bigint, integer)'), ('public.link_view_topic_ok(text, text)');
select pg_temp.chk('091 no function authenticated may call is callable by anon, outside the allow-list', $q$
    select not exists (
        select 1 from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.prorettype <> 'trigger'::regtype
          and has_function_privilege('authenticated', p.oid, 'execute')
          and has_function_privilege('anon', p.oid, 'execute')
          and p.oid::regprocedure not in (select fn from t_allow)
    )$q$);
select pg_temp.chk('092 anon executes exactly the allow-list', $q$
    select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text) = (select array_agg(fn::text order by fn::text) from t_allow)
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prorettype <> 'trigger'::regtype
      and has_function_privilege('anon', p.oid, 'execute')$q$);
select pg_temp.chk('093 a function created now in public is not anon''s through the default privileges', $q$
    select not exists (
        select 1 from pg_default_acl a, aclexplode(a.defaclacl) x
        where a.defaclrole = 'postgres'::regrole and a.defaclnamespace = 'public'::regnamespace
          and a.defaclobjtype = 'f' and x.grantee = 'anon'::regrole
    )$q$);

-- ===========================================================================
-- Realtime: what the viewer token may join, track and send
-- ===========================================================================
select public.rotate_document_realtime(pg_temp.d(1));
select pg_temp.as_viewer(pg_temp.d(1), pg_temp.link_id('d1'));
select pg_temp.chk('100 reads broadcast on doc: at the current generation', $q$select pg_temp.can_read(pg_temp.topic('doc', pg_temp.d(1), 1))$q$);
select pg_temp.chk('101 reads broadcast on doc-view: at the current generation', $q$select pg_temp.can_read(pg_temp.topic('doc-view', pg_temp.d(1), 1))$q$);
select pg_temp.chk('102 reads nothing on doc-db:', $q$select not pg_temp.can_read(pg_temp.topic('doc-db', pg_temp.d(1), 1))$q$);
select pg_temp.chk('103 reads nothing on the old generation', $q$
    select not pg_temp.can_read(pg_temp.topic('doc', pg_temp.d(1), 0)) and not pg_temp.can_read(pg_temp.topic('doc-view', pg_temp.d(1), 0))$q$);
select pg_temp.chk('104 reads nothing on another score''s topics', $q$
    select not pg_temp.can_read(pg_temp.topic('doc', pg_temp.d(2), 0)) and not pg_temp.can_read(pg_temp.topic('doc-view', pg_temp.d(2), 0))$q$);
select pg_temp.chk('105 does not read presence (D13)', $q$select not pg_temp.can_read(pg_temp.topic('doc', pg_temp.d(1), 1), 'presence')$q$);
select pg_temp.chk('106 tracks presence on doc:', $q$select pg_temp.can_insert(pg_temp.topic('doc', pg_temp.d(1), 1), 'presence')$q$);
select pg_temp.chk('107 tracks no presence on doc-view: or doc-db:', $q$
    select not pg_temp.can_insert(pg_temp.topic('doc-view', pg_temp.d(1), 1), 'presence')
       and not pg_temp.can_insert(pg_temp.topic('doc-db', pg_temp.d(1), 1), 'presence')$q$);
select pg_temp.chk('108 sends no broadcast anywhere', $q$
    select not pg_temp.can_insert(pg_temp.topic('doc', pg_temp.d(1), 1), 'broadcast')
       and not pg_temp.can_insert(pg_temp.topic('doc-view', pg_temp.d(1), 1), 'broadcast')
       and not pg_temp.can_insert(pg_temp.topic('doc-db', pg_temp.d(1), 1), 'broadcast')$q$);
select pg_temp.as_viewer(pg_temp.d(3), pg_temp.link_id('d3_revoked'));
select pg_temp.chk('109 a revoked link''s token reads nothing', $q$
    select not pg_temp.can_read(pg_temp.topic('doc', pg_temp.d(3), 0)) and not pg_temp.can_insert(pg_temp.topic('doc', pg_temp.d(3), 0), 'presence')$q$);
select pg_temp.as_user(1);
select pg_temp.chk('110 members keep their topics, and do not get doc-view:', $q$
    select pg_temp.can_read(pg_temp.topic('doc', pg_temp.d(1), 1)) and pg_temp.can_read(pg_temp.topic('doc-db', pg_temp.d(1), 1))
       and not pg_temp.can_read(pg_temp.topic('doc-view', pg_temp.d(1), 1))$q$);
select pg_temp.as_postgres();

-- ===========================================================================
-- Rotations and the link's members
-- ===========================================================================
-- d8 (owner 12): a general editor link; 5 joins through it, 6 joins and then
-- has a role set by hand (role lock), 4 is owner 1's roster student, assigned
-- d8? no: assignments are the teacher's, so d3 (owner 1) carries the student.
select pg_temp.as_user(1);
select * from public.set_general_access(pg_temp.d(3), 'anyone', 'editor', '7 days');
select pg_temp.keep_link('d3', pg_temp.d(3));
select pg_temp.as_postgres();
insert into public.assignments (id, document_id, student_user_id, assigned_by, access)
values (pg_temp.d(95), pg_temp.d(3), pg_temp.u(4), pg_temp.u(1), 'view');
select pg_temp.as_user(5);
select * from public.redeem_share_link(pg_temp.link_token('d3'));
select pg_temp.as_user(6);
select * from public.redeem_share_link(pg_temp.link_token('d3'));
select pg_temp.as_user(4);
select * from public.redeem_share_link(pg_temp.link_token('d3'));
select pg_temp.as_postgres();
insert into public.document_member_role_locks (document_id, user_id) values (pg_temp.d(3), pg_temp.u(6));
select pg_temp.chk('120 the link made 5, 6 and the roster student editors', $q$
    select pg_temp.member_role(pg_temp.d(3), pg_temp.u(5)) = 'editor' and pg_temp.member_role(pg_temp.d(3), pg_temp.u(6)) = 'editor'
       and pg_temp.member_role(pg_temp.d(3), pg_temp.u(4)) = 'editor'
       and pg_temp.at_commit()$q$);
select pg_temp.mark_epoch(pg_temp.d(3));
select pg_temp.as_user(1);
select * from public.set_general_access(pg_temp.d(3), 'anyone', 'viewer', '7 days');
select pg_temp.as_postgres();
select pg_temp.chk('121 editor to viewer rotates exactly once', $q$select pg_temp.at_commit() and pg_temp.moved(pg_temp.d(3)) = 1$q$);
select pg_temp.chk('122 ... the link''s editor is a viewer, the hand-set role stays, the roster student falls back to the assignment', $q$
    select pg_temp.member_role(pg_temp.d(3), pg_temp.u(5)) = 'viewer'
       and pg_temp.member_role(pg_temp.d(3), pg_temp.u(6)) = 'editor'
       and pg_temp.member_role(pg_temp.d(3), pg_temp.u(4)) = 'viewer'$q$);
select pg_temp.mark_epoch(pg_temp.d(3));
select pg_temp.as_user(1);
select * from public.set_general_access(pg_temp.d(3), 'anyone', 'viewer', '30 days');
select pg_temp.as_postgres();
select pg_temp.chk('123 an expiry change alone does not rotate', $q$select pg_temp.at_commit() and pg_temp.moved(pg_temp.d(3)) = 0$q$);
select pg_temp.as_user(1);
select * from public.set_general_access(pg_temp.d(3), 'anyone', 'editor', '30 days');
select pg_temp.as_postgres();
select pg_temp.chk('124 viewer to editor rotates exactly once, and changes no member', $q$
    select pg_temp.at_commit() and pg_temp.moved(pg_temp.d(3)) = 1
       and pg_temp.member_role(pg_temp.d(3), pg_temp.u(5)) = 'viewer'$q$);
select pg_temp.mark_epoch(pg_temp.d(3));
select pg_temp.chk('125 the rotation told the old doc-view topic too', $q$
    select exists (select 1 from realtime.messages m where m.event = 'topic_rotated'
                   and m.topic = pg_temp.topic('doc-view', pg_temp.d(3), pg_temp.epoch(pg_temp.d(3)) - 1))$q$);
select pg_temp.as_user(1);
select * from public.set_general_access(pg_temp.d(3), 'restricted');
select pg_temp.as_postgres();
select pg_temp.chk('126 restricted rotates exactly once and revokes the link', $q$
    select pg_temp.at_commit() and pg_temp.moved(pg_temp.d(3)) = 1
       and (select revoked_at is not null from public.share_links where id = pg_temp.link_id('d3'))$q$);
select pg_temp.chk('127 ... withdrawing the link''s members; the hand-set member was the link''s too, the student keeps the assignment', $q$
    select pg_temp.member_role(pg_temp.d(3), pg_temp.u(5)) is null
       and pg_temp.member_role(pg_temp.d(3), pg_temp.u(6)) is null
       and pg_temp.member_role(pg_temp.d(3), pg_temp.u(4)) = 'viewer'
       and pg_temp.member_role(pg_temp.d(3), pg_temp.u(1)) = 'owner'$q$);
select pg_temp.mark_epoch(pg_temp.d(3));
select pg_temp.as_user(1);
select pg_temp.chk('128 restricted again is a no-op', $q$
    select (select count(*) from public.set_general_access(pg_temp.d(3), 'restricted')) = 0 and pg_temp.at_commit() and pg_temp.moved(pg_temp.d(3)) = 0$q$);
select pg_temp.as_postgres();

-- Reset (d8, owner 12): the link guest 7 joins, then the link is reset.
select pg_temp.as_user(12);
select * from public.set_general_access(pg_temp.d(8), 'anyone', 'viewer', '30 days');
select pg_temp.keep_link('d8_old', pg_temp.d(8));
select pg_temp.as_user(7, true);
select * from public.redeem_share_link(pg_temp.link_token('d8_old'));
select pg_temp.as_postgres();
select pg_temp.chk('130 setup: the link guest is a viewer through the link', $q$select pg_temp.member_role(pg_temp.d(8), pg_temp.u(7)) = 'viewer' and pg_temp.at_commit()$q$);
select pg_temp.mark_epoch(pg_temp.d(8));
select pg_temp.as_user(12);
select * from public.reset_general_link(pg_temp.d(8));
select pg_temp.keep_link('d8_new', pg_temp.d(8));
select pg_temp.as_postgres();
select pg_temp.chk('131 reset rotates exactly once', $q$select pg_temp.at_commit() and pg_temp.moved(pg_temp.d(8)) = 1$q$);
select pg_temp.chk('132 reset: a new token, same role and expiry; the old one reads revoked', $q$
    select n.token <> o.token and n.role = o.role and n.expires_at = o.expires_at and n.revoked_at is null
       and (select state = 'revoked' from public.peek_share_link(o.token))
    from public.share_links n, public.share_links o
    where n.id = pg_temp.link_id('d8_new') and o.id = pg_temp.link_id('d8_old')$q$);
select pg_temp.chk('133 reset keeps the members, now recorded against the new link', $q$
    select pg_temp.member_role(pg_temp.d(8), pg_temp.u(7)) = 'viewer'
       and (select token from public.share_link_redemptions where document_id = pg_temp.d(8) and user_id = pg_temp.u(7)) = pg_temp.link_token('d8_new')$q$);
select pg_temp.as_postgres();
update public.share_links set expires_at = now() - interval '1 hour' where id = pg_temp.link_id('d8_new');
select pg_temp.as_user(12);
select pg_temp.chk('134 resetting a lapsed link gives the new one 7 days', $q$
    select expires_at = now() + interval '7 days' from public.reset_general_link(pg_temp.d(8))$q$);
select pg_temp.as_postgres();

-- Revoke (d9, owner 12): the general link always takes its members.
select pg_temp.as_user(12);
select * from public.set_general_access(pg_temp.d(9), 'anyone', 'editor');
select pg_temp.keep_link('d9', pg_temp.d(9));
select pg_temp.as_user(5);
select * from public.redeem_share_link(pg_temp.link_token('d9'));
select pg_temp.as_postgres();
select pg_temp.chk('140 setup: 5 is an editor on d9 through its general link', $q$select pg_temp.member_role(pg_temp.d(9), pg_temp.u(5)) = 'editor' and pg_temp.at_commit()$q$);
select pg_temp.mark_epoch(pg_temp.d(9));
select pg_temp.as_user(12);
select pg_temp.chk('141 revoking the general link without asking withdraws its member anyway', $q$
    select public.revoke_share_link(pg_temp.link_token('d9')) = 1$q$);
select pg_temp.as_postgres();
select pg_temp.chk('142 ... and rotates exactly once', $q$
    select pg_temp.at_commit() and pg_temp.moved(pg_temp.d(9)) = 1 and pg_temp.member_role(pg_temp.d(9), pg_temp.u(5)) is null$q$);
select pg_temp.mark_epoch(pg_temp.d(9));
select pg_temp.as_user(12);
select pg_temp.chk('143 a second revoke changes nothing and does not rotate', $q$
    select public.revoke_share_link(pg_temp.link_token('d9')) = 0 and pg_temp.at_commit() and pg_temp.moved(pg_temp.d(9)) = 0$q$);
select pg_temp.as_user(1);
select pg_temp.mark_epoch(pg_temp.d(1));
select pg_temp.chk('144 an older link revoked without removal does not rotate (as before)', $q$
    select public.revoke_share_link(pg_temp.link_token('legacy_live')) = 0 and pg_temp.at_commit() and pg_temp.moved(pg_temp.d(1)) = 0$q$);
select pg_temp.as_postgres();
select pg_temp.chk('145 the rotation queue is empty after every commit', $q$select not exists (select 1 from public.document_realtime_rotation_queue)$q$);

-- ===========================================================================
-- The mark whitelist (PR #98's cases) and the doc-view fan-out
-- ===========================================================================
insert into public.annotations (id, document_id, page, kind, color, payload, created_by) values
('5a2e00a0-0000-4000-8000-000000000003', pg_temp.d(1), 0, 'text', '#000',
 '{"x":0.1,"y":0.2,"size":0.03,"text":"cresc.","hw":1,"bold":1,"italic":0,"font":"serif","src":1,"sf":1,"note":"PRIVATE-NOTE"}', pg_temp.u(1)),
('5a2e00a0-0000-4000-8000-000000000004', pg_temp.d(1), 2, 'stroke', '#00f',
 '{"pts":[0.5,0.5,1],"w":0.01,"sp":1,"src":1,"note":{"deep":"PRIVATE-NOTE"}}', pg_temp.u(1)),
('5a2e00a0-0000-4000-8000-000000000005', pg_temp.d(1), 0, 'text', '#f00',
 '{"x":0.3,"y":0.3,"size":0.03,"text":"ERASED-SECRET"}', pg_temp.u(1));
update public.annotations set deleted_at = now()
where id in ('5a2e00a0-0000-4000-8000-000000000005', '5a2e00a0-0000-4000-8000-000000000001');
create temp table t_snapshot (body jsonb);
grant all on t_snapshot to anon;
select pg_temp.as_viewer(pg_temp.d(1), pg_temp.link_id('d1'));
insert into t_snapshot select public.link_view_snapshot(0, 500);
select pg_temp.chk('150 each live mark carries exactly id, page, kind, color, payload, seq, deleted:false', $q$
    select count(*) = 3
       and bool_and((select array_agg(k order by k) from jsonb_object_keys(a) k) = array['color', 'deleted', 'id', 'kind', 'page', 'payload', 'seq'])
    from t_snapshot, jsonb_array_elements(body -> 'marks') a where a -> 'deleted' = 'false'::jsonb$q$);
select pg_temp.chk('151 every erased mark, from since 0, is exactly {id, seq, deleted:true}', $q$
    select count(*) = 2
       and bool_and((select array_agg(k order by k) from jsonb_object_keys(a) k) = array['deleted', 'id', 'seq'])
    from t_snapshot, jsonb_array_elements(body -> 'marks') a where a -> 'deleted' = 'true'::jsonb$q$);
select pg_temp.chk('152 erased content never comes back', $q$select position('ERASED-SECRET' in body::text) = 0 from t_snapshot$q$);
select pg_temp.chk('153 no unknown or provenance payload key reaches the viewer, at any depth', $q$
    select position('PRIVATE-NOTE' in body::text) = 0
       and not exists (select 1 from pg_temp.all_keys(body) k where k in ('note', 'deep', 'src', 'sf', 'created_by', 'owner_id', 'email', 'storage_path'))
    from t_snapshot$q$);
select pg_temp.chk('154 a text mark keeps exactly x, y, size, text, hw, font, bold, italic', $q$
    select a -> 'payload' = '{"x":0.1,"y":0.2,"size":0.03,"text":"cresc.","hw":1,"bold":1,"italic":0,"font":"serif"}'::jsonb
    from t_snapshot, jsonb_array_elements(body -> 'marks') a where a ->> 'id' = '5a2e00a0-0000-4000-8000-000000000003'$q$);
select pg_temp.chk('155 an ink mark keeps exactly pts, w, sp; absent keys stay absent', $q$
    select bool_and(case a ->> 'id'
        when '5a2e00a0-0000-4000-8000-000000000004' then a -> 'payload' = '{"pts":[0.5,0.5,1],"w":0.01,"sp":1}'::jsonb
        when '5a2e00a0-0000-4000-8000-000000000002' then a -> 'payload' = '{"pts":[0,0,1],"w":0.02}'::jsonb
        end) and count(*) = 2
    from t_snapshot, jsonb_array_elements(body -> 'marks') a
    where a ->> 'id' in ('5a2e00a0-0000-4000-8000-000000000004', '5a2e00a0-0000-4000-8000-000000000002')$q$);
select pg_temp.chk('156 since filters to newer marks; a page sets more and the watermark of what was sent', $q$
    select jsonb_array_length(public.link_view_snapshot((select (body ->> 'max_seq')::bigint from t_snapshot), 500) -> 'marks') = 0
       and (select jsonb_array_length(b -> 'marks') = 1 and (b ->> 'more')::boolean
                   and (b ->> 'max_seq')::bigint = ((b -> 'marks' -> 0) ->> 'seq')::bigint
            from (select public.link_view_snapshot(0, 1) as b) p)$q$);
select pg_temp.chk('157 the snapshot never names the owner or the storage path', $q$
    select not exists (select 1 from t_snapshot, pg_temp.all_keys(body) k where k in ('created_by', 'owner_id', 'storage_path', 'pdf_path', 'email'))$q$);
select pg_temp.as_postgres();
select pg_temp.chk('158 link_view_mark is no client''s to call', $q$
    select not has_function_privilege(r, 'public.link_view_mark(uuid, integer, text, text, jsonb, bigint, timestamptz)', 'execute')
    from unnest(array['anon', 'authenticated']) r$q$);

-- Fan-out on d10 (owner 12): nothing until a live general viewer link.
create function pg_temp.add_mark(n int) returns void language sql as $f$
    insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
    values (('5a2e00b0-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, pg_temp.d(10), 0, 'stroke', '#000',
            '{"pts":[0,0,1],"w":0.02,"src":1}', pg_temp.u(12))
$f$;
select pg_temp.add_mark(1);
select pg_temp.chk('160 no general link: nothing on doc-view', $q$select pg_temp.view_msgs(pg_temp.d(10), 'mark') = 0$q$);
select pg_temp.as_user(12);
select * from public.set_general_access(pg_temp.d(10), 'anyone', 'editor');
select pg_temp.keep_link('d10', pg_temp.d(10));
select pg_temp.as_postgres();
select pg_temp.add_mark(2);
select pg_temp.chk('161 an editor link: nothing on doc-view', $q$select pg_temp.view_msgs(pg_temp.d(10), 'mark') = 0$q$);
select pg_temp.as_user(12);
select * from public.set_general_access(pg_temp.d(10), 'anyone', 'viewer');
select pg_temp.as_postgres();
select pg_temp.at_commit();
select pg_temp.add_mark(3);
select pg_temp.chk('162 a live viewer link: one whitelisted mark on the current doc-view topic', $q$
    select count(*) = 1 and bool_and(m.payload = jsonb_build_object('id', '5a2e00b0-0000-4000-8000-000000000003'::uuid, 'page', 0, 'kind', 'stroke',
        'color', '#000', 'payload', '{"pts":[0,0,1],"w":0.02}'::jsonb, 'seq', (select seq from public.annotations where id = '5a2e00b0-0000-4000-8000-000000000003'), 'deleted', false))
    from realtime.messages m where m.topic = public.document_view_topic(pg_temp.d(10)) and m.event = 'mark'$q$);
update public.annotations set deleted_at = now() where id = '5a2e00b0-0000-4000-8000-000000000003';
select pg_temp.chk('163 erasing sends the tombstone only', $q$
    select m.payload = jsonb_build_object('id', '5a2e00b0-0000-4000-8000-000000000003'::uuid, 'seq',
        (select seq from public.annotations where id = '5a2e00b0-0000-4000-8000-000000000003'), 'deleted', true)
    from realtime.messages m where m.topic = public.document_view_topic(pg_temp.d(10)) and m.event = 'mark'
      and m.payload ->> 'deleted' = 'true'$q$);
update public.documents set content_rev = content_rev + 1 where id = pg_temp.d(10);
select pg_temp.chk('164 a new content revision goes to doc-view as {content_rev}', $q$
    select exists (select 1 from realtime.messages m where m.topic = public.document_view_topic(pg_temp.d(10))
                   and m.event = 'doc' and m.payload ->> 'content_rev' = '1'
                   and (select array_agg(k order by k) from jsonb_object_keys(m.payload) k) <@ array['content_rev', 'id'])$q$);
update public.share_links set expires_at = now() - interval '1 minute' where id = pg_temp.link_id('d10');
select pg_temp.add_mark(4);
select pg_temp.chk('165 an expired viewer link: nothing more on doc-view', $q$select pg_temp.view_msgs(pg_temp.d(10), 'mark') = 2$q$);
update public.share_links set expires_at = now() + interval '1 day', revoked_at = now() where id = pg_temp.link_id('d10');
select pg_temp.add_mark(5);
select pg_temp.chk('166 a revoked viewer link: nothing more on doc-view', $q$select pg_temp.view_msgs(pg_temp.d(10), 'mark') = 2$q$);

-- ===========================================================================
-- share-session's read
-- ===========================================================================
select pg_temp.as_service();
select pg_temp.chk('170 a live viewer link: the score''s facts, the storage path and the expiry', $q$
    select r ->> 'state' = 'live' and r ->> 'role' = 'viewer' and (r ->> 'link_id')::uuid = pg_temp.link_id('d1')
       and r -> 'doc' = jsonb_build_object('id', pg_temp.d(1), 'title', 'Share v2 score 1', 'page_count', 3, 'content_rev', 0)
       and r ->> 'pdf_path' = pg_temp.d(1)::text || '/original.pdf' and r ? 'link_expires_at'
    from public.share_session_resolve(pg_temp.link_token('d1')) r$q$);
select pg_temp.chk('171 a live editor link says editor', $q$
    select r ->> 'state' = 'live' and r ->> 'role' = 'editor' from public.share_session_resolve(pg_temp.link_token('d11_editor')) r$q$);
select pg_temp.chk('172 a dead general link: its state and id, nothing else', $q$
    select r = jsonb_build_object('state', 'revoked', 'link_id', pg_temp.link_id('d3_revoked'))
       and (select s = jsonb_build_object('state', 'unavailable', 'link_id', pg_temp.link_id('d4')) from public.share_session_resolve(pg_temp.link_token('d4')) s)
    from public.share_session_resolve(pg_temp.link_token('d3_revoked')) r$q$);
select pg_temp.chk('173 an older link, an unknown token and a malformed one: invalid', $q$
    select public.share_session_resolve(pg_temp.link_token('legacy_d1_viewer')) = '{"state":"invalid"}'
       and public.share_session_resolve('AAAAAAAAAAAAAAAAAAAAAA') = '{"state":"invalid"}'
       and public.share_session_resolve('short') = '{"state":"invalid"}'$q$);
select pg_temp.as_postgres();
select pg_temp.chk('174 only the service role resolves', $q$
    select not has_function_privilege('anon', 'public.share_session_resolve(text)', 'execute')
       and not has_function_privilege('authenticated', 'public.share_session_resolve(text)', 'execute')$q$);

-- ===========================================================================
-- Invites
-- ===========================================================================
select pg_temp.as_service();
select pg_temp.run('invite1', $q$public.share_invite_create(pg_temp.u(1), pg_temp.d(2), '  New.Person@Example.TEST ', 'viewer', pg_temp.sha('tok-1'))$q$);
select pg_temp.chk('180 a new address gets a pending invite, its hash only, for 14 days', $q$
    select r ->> 'kind' = 'invite' and r ->> 'title' = 'Share v2 score 2' and r ->> 'inviter_name' = 'Ms Owner'
       and (select i.email = 'new.person@example.test' and i.token_hash = pg_temp.sha('tok-1') and i.expires_at = now() + interval '14 days'
                   and i.role = 'viewer'
            from public.document_invites i where i.id = (r ->> 'invite_id')::uuid)
    from pg_temp.out('invite1') r$q$);
select pg_temp.chk('181 the table has no column for the token itself', $q$
    select not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'document_invites' and column_name = 'token')$q$);
select pg_temp.run('invite2', $q$public.share_invite_create(pg_temp.u(1), pg_temp.d(2), 'new.person@example.test', 'editor', pg_temp.sha('tok-2'))$q$);
select pg_temp.chk('182 inviting the address again reissues the same invite', $q$
    select (r ->> 'invite_id') = (pg_temp.out('invite1') ->> 'invite_id')
       and (select count(*) = 1 and bool_and(token_hash = pg_temp.sha('tok-2') and role = 'editor') from public.document_invites where email = 'new.person@example.test')
    from pg_temp.out('invite2') r$q$);
select pg_temp.run('invite3', $q$public.share_invite_create(pg_temp.u(1), pg_temp.d(2), 's2-11@sharev2.test', 'editor', pg_temp.sha('tok-3'))$q$);
select pg_temp.chk('183 an existing account becomes a member at once, with a role lock, and no invite row', $q$
    select pg_temp.out('invite3') = jsonb_build_object('kind', 'member', 'title', 'Share v2 score 2', 'inviter_name', 'Ms Owner')
       and pg_temp.member_role(pg_temp.d(2), pg_temp.u(11)) = 'editor'
       and exists (select 1 from public.document_member_role_locks where document_id = pg_temp.d(2) and user_id = pg_temp.u(11))
       and not exists (select 1 from public.document_invites where email = 's2-11@sharev2.test')$q$);
select pg_temp.chk('184 a roster student of another teacher is refused (D7), by account email and by roster email', $q$
    select public.share_invite_create(pg_temp.u(1), pg_temp.d(2), 's2-10@sharev2.test', 'viewer', pg_temp.sha('tok-4')) = '{"kind":"roster_refused"}'
       and public.share_invite_create(pg_temp.u(1), pg_temp.d(2), 'ten.student@sharev2.test', 'viewer', pg_temp.sha('tok-5')) = '{"kind":"roster_refused"}'
       and pg_temp.member_role(pg_temp.d(2), pg_temp.u(10)) is null$q$);
select pg_temp.as_postgres();
update public.content_takedowns set lifted_at = now() where document_id = pg_temp.d(7);
select pg_temp.as_service();
select pg_temp.run('invite_student', $q$public.share_invite_create(pg_temp.u(2), pg_temp.d(7), 's2-10@sharev2.test', 'viewer', pg_temp.sha('tok-6'))$q$);
select pg_temp.chk('186 (with the score live again) the teacher''s invite gives the student the score', $q$
    select pg_temp.out('invite_student') ->> 'kind' = 'member' and pg_temp.member_role(pg_temp.d(7), pg_temp.u(10)) = 'viewer'$q$);
select pg_temp.refused('187 a caller who does not own the score is refused', $q$
    select public.share_invite_create(pg_temp.u(2), pg_temp.d(2), 'x@example.test', 'viewer', pg_temp.sha('tok-7'))$q$, '42501');
select pg_temp.refused('188 a bad role is refused', $q$
    select public.share_invite_create(pg_temp.u(1), pg_temp.d(2), 'x@example.test', 'owner', pg_temp.sha('tok-7'))$q$, '22023', 'invalid_role');
select pg_temp.chk('189 peek: a pending invite''s title, inviter, role and address; an unknown hash is invalid', $q$
    select public.share_invite_peek(pg_temp.sha('tok-2')) = jsonb_build_object('state', 'pending', 'title', 'Share v2 score 2',
               'inviter_name', 'Ms Owner', 'role', 'editor', 'email', 'new.person@example.test')
       and public.share_invite_peek(pg_temp.sha('tok-1')) = '{"state":"invalid"}'$q$);
select pg_temp.as_postgres();
insert into auth.users (id, email, raw_user_meta_data, is_anonymous) values
(pg_temp.u(20), 'new.person@example.test', '{}', false),
(pg_temp.u(21), 'someone.else@example.test', '{}', false);
select pg_temp.as_service();
select pg_temp.chk('190 accepting as another address is refused', $q$
    select public.share_invite_consume(pg_temp.sha('tok-2'), pg_temp.u(21)) = '{"ok":false,"state":"email_mismatch"}'$q$);
select pg_temp.run('consume', $q$public.share_invite_consume(pg_temp.sha('tok-2'), pg_temp.u(20))$q$);
select pg_temp.chk('191 accepting as the invited address attaches the membership, with a role lock', $q$
    select pg_temp.out('consume') = jsonb_build_object('ok', true, 'document_id', pg_temp.d(2))
       and pg_temp.member_role(pg_temp.d(2), pg_temp.u(20)) = 'editor'
       and exists (select 1 from public.document_member_role_locks where document_id = pg_temp.d(2) and user_id = pg_temp.u(20))$q$);
select pg_temp.chk('192 a used invite is refused, and peeks as used', $q$
    select public.share_invite_consume(pg_temp.sha('tok-2'), pg_temp.u(20)) = '{"ok":false,"state":"used"}'
       and public.share_invite_peek(pg_temp.sha('tok-2')) = '{"state":"used"}'$q$);
select public.share_invite_create(pg_temp.u(1), pg_temp.d(1), 'cancel.me@example.test', 'viewer', pg_temp.sha('tok-8'));
select public.share_invite_create(pg_temp.u(1), pg_temp.d(1), 'expire.me@example.test', 'viewer', pg_temp.sha('tok-9'));
select pg_temp.run('reissue', $q$public.share_invite_reissue(pg_temp.u(1), (select id from public.document_invites where email = 'cancel.me@example.test'), pg_temp.sha('tok-10'))$q$);
select pg_temp.chk('193 resend gives a pending invite a new token and 14 more days', $q$
    select pg_temp.out('reissue') ->> 'kind' = 'invite' and pg_temp.out('reissue') ->> 'email' = 'cancel.me@example.test'
       and (select token_hash = pg_temp.sha('tok-10') and expires_at = now() + interval '14 days' from public.document_invites where email = 'cancel.me@example.test')$q$);
select pg_temp.run('cancel', $q$public.share_invite_cancel(pg_temp.u(1), (select id from public.document_invites where email = 'cancel.me@example.test'))$q$);
select pg_temp.chk('194 cancel: the invite peeks cancelled and cannot be accepted', $q$
    select pg_temp.out('cancel') = 'true'::jsonb
       and public.share_invite_peek(pg_temp.sha('tok-10')) = '{"state":"cancelled"}'
       and public.share_invite_consume(pg_temp.sha('tok-10'), pg_temp.u(20)) = '{"ok":false,"state":"cancelled"}'$q$);
select pg_temp.chk('195 a cancelled invite cannot be resent or cancelled again', $q$
    select public.share_invite_reissue(pg_temp.u(1), (select id from public.document_invites where email = 'cancel.me@example.test'), pg_temp.sha('tok-11')) is null
       and not public.share_invite_cancel(pg_temp.u(1), (select id from public.document_invites where email = 'cancel.me@example.test'))$q$);
select pg_temp.refused('196 another owner cannot cancel it', $q$
    select public.share_invite_cancel(pg_temp.u(2), (select id from public.document_invites where email = 'expire.me@example.test'))$q$, '42501');
select pg_temp.as_postgres();
update public.document_invites set expires_at = now() - interval '1 minute' where email = 'expire.me@example.test';
select pg_temp.as_service();
select pg_temp.chk('197 an expired invite peeks expired and cannot be accepted', $q$
    select public.share_invite_peek(pg_temp.sha('tok-9')) = '{"state":"expired"}'
       and public.share_invite_consume(pg_temp.sha('tok-9'), pg_temp.u(20)) = '{"ok":false,"state":"expired"}'$q$);
select pg_temp.as_user(1);
select pg_temp.chk('198 the owner lists their score''s invites (no token hash), share_owner_ready says yes', $q$
    select (select count(*) from public.document_invites) = 3
       and not has_column_privilege('authenticated', 'public.document_invites', 'token_hash', 'select')
       and public.share_owner_ready(pg_temp.d(1))$q$);
select pg_temp.as_user(2);
select pg_temp.chk('199 another account lists none of them', $q$select count(*) = 0 from public.document_invites where document_id in (pg_temp.d(1), pg_temp.d(2))$q$);
select pg_temp.refused('200 ... and share_owner_ready refuses it', $q$select public.share_owner_ready(pg_temp.d(1))$q$, '42501');
select pg_temp.as_postgres();
select pg_temp.chk('201 no client writes invites; anon reads nothing; the service-role RPCs are no client''s', $q$
    select not has_table_privilege('authenticated', 'public.document_invites', 'INSERT, UPDATE, DELETE')
       and not has_any_column_privilege('anon', 'public.document_invites', 'SELECT, INSERT, UPDATE')
       and not bool_or(has_function_privilege(r, f, 'execute'))
    from unnest(array['anon', 'authenticated']) r,
         unnest(array['public.share_invite_create(uuid, uuid, text, text, bytea)', 'public.share_invite_reissue(uuid, uuid, bytea)',
                      'public.share_invite_cancel(uuid, uuid)', 'public.share_invite_peek(bytea)',
                      'public.share_invite_consume(bytea, uuid)']::regprocedure[]) f$q$);

-- A direct invite outlasts the general link. d13 (owner 13) has a general
-- viewer link; 5, 6 and 22 join through it. 22's address was invited before
-- they had an account; 5 is invited after joining, as an existing account.
insert into public.documents (id, owner_id, title, storage_path, page_count)
values (pg_temp.d(13), pg_temp.u(13), 'Share v2 score 13', pg_temp.d(13)::text || '/original.pdf', 3);
select pg_temp.as_user(13);
select * from public.set_general_access(pg_temp.d(13), 'anyone', 'viewer', '7 days');
select pg_temp.keep_link('d13', pg_temp.d(13));
select pg_temp.as_service();
select public.share_invite_create(pg_temp.u(13), pg_temp.d(13), 'late.joiner@example.test', 'editor', pg_temp.sha('tok-20'));
select pg_temp.as_postgres();
insert into auth.users (id, email, raw_user_meta_data, is_anonymous) values (pg_temp.u(22), 'late.joiner@example.test', '{}', false);
select pg_temp.as_user(5);
select * from public.redeem_share_link(pg_temp.link_token('d13'));
select pg_temp.as_user(6);
select * from public.redeem_share_link(pg_temp.link_token('d13'));
select pg_temp.as_user(22);
select * from public.redeem_share_link(pg_temp.link_token('d13'));
select pg_temp.as_service();
select pg_temp.run('direct_invite', $q$public.share_invite_create(pg_temp.u(13), pg_temp.d(13), 's2-5@sharev2.test', 'editor', pg_temp.sha('tok-21'))$q$);
select pg_temp.run('late_accept', $q$public.share_invite_consume(pg_temp.sha('tok-20'), pg_temp.u(22))$q$);
select pg_temp.as_postgres();
select pg_temp.chk('202 setup: 5 (invited as an account) and 22 (a pending invite accepted) are editors; 6 is the link''s viewer', $q$
    select pg_temp.out('direct_invite') ->> 'kind' = 'member' and pg_temp.out('late_accept') ->> 'ok' = 'true'
       and pg_temp.member_role(pg_temp.d(13), pg_temp.u(5)) = 'editor' and pg_temp.member_role(pg_temp.d(13), pg_temp.u(22)) = 'editor'
       and pg_temp.member_role(pg_temp.d(13), pg_temp.u(6)) = 'viewer'$q$);
select pg_temp.chk('203 a direct invite, either way, ends the link''s record of the person', $q$
    select (select array_agg(user_id) from public.share_link_redemptions where document_id = pg_temp.d(13)) = array[pg_temp.u(6)]$q$);
select pg_temp.as_user(13);
select * from public.set_general_access(pg_temp.d(13), 'restricted');
select pg_temp.as_postgres();
select pg_temp.chk('204 Restricted withdraws the link''s viewer and keeps both people invited directly', $q$
    select pg_temp.member_role(pg_temp.d(13), pg_temp.u(6)) is null
       and pg_temp.member_role(pg_temp.d(13), pg_temp.u(5)) = 'editor'
       and pg_temp.member_role(pg_temp.d(13), pg_temp.u(22)) = 'editor'$q$);

-- D7 after the invite went out: its address becomes another teacher's roster
-- student (23, teacher 2) before the owner resends it or the student accepts.
select pg_temp.as_service();
select pg_temp.run('roster_late', $q$public.share_invite_create(pg_temp.u(1), pg_temp.d(1), 'late.student@example.test', 'editor', pg_temp.sha('tok-22'))$q$);
select pg_temp.as_postgres();
insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data, is_anonymous)
values (pg_temp.u(23), 'late.student@example.test', '{"user_type":"student"}', '{}', false);
insert into public.managed_students (id, teacher_id, student_user_id, display_name, auth_method, username, claimed_at, student_email)
values (pg_temp.d(92), pg_temp.u(2), pg_temp.u(23), 'Late', 'code', 's2_late', now(), null);
select pg_temp.as_service();
select pg_temp.chk('205 resending it is refused as a roster student (D7), and the mailed token still stands', $q$
    select public.share_invite_reissue(pg_temp.u(1), (pg_temp.out('roster_late') ->> 'invite_id')::uuid, pg_temp.sha('tok-23')) = '{"kind":"roster_refused"}'
       and (select token_hash = pg_temp.sha('tok-22') from public.document_invites where email = 'late.student@example.test')$q$);
select pg_temp.chk('206 ... and so is accepting it: no membership', $q$
    select public.share_invite_consume(pg_temp.sha('tok-22'), pg_temp.u(23)) = '{"ok":false,"state":"roster_refused"}'
       and pg_temp.member_role(pg_temp.d(1), pg_temp.u(23)) is null$q$);
select pg_temp.as_postgres();

-- ===========================================================================
-- Retention
-- ===========================================================================
-- d12 (owner 13): links revoked or expired 29 and 31 days ago, and a member
-- (5) who joined through the 31-day one.
insert into public.share_links (document_id, role, created_by, expires_at, revoked_at, token) values
(pg_temp.d(12), 'viewer', pg_temp.u(13), null, now() - interval '31 days', 'retention-revoked-31dA'),
(pg_temp.d(12), 'viewer', pg_temp.u(13), null, now() - interval '29 days', 'retention-revoked-29dA'),
(pg_temp.d(12), 'viewer', pg_temp.u(13), now() - interval '31 days', null, 'retention-expired-31dA'),
(pg_temp.d(12), 'viewer', pg_temp.u(13), now() - interval '29 days', null, 'retention-expired-29dA'),
(pg_temp.d(12), 'viewer', pg_temp.u(13), now() + interval '1 day', null, 'retention-live-linkAAA');
insert into public.document_members (document_id, user_id, role) values (pg_temp.d(12), pg_temp.u(5), 'viewer');
insert into public.share_link_redemptions (document_id, user_id, token) values (pg_temp.d(12), pg_temp.u(5), 'retention-revoked-31dA');
insert into public.document_invites (document_id, email, role, invited_by, token_hash, created_at, expires_at, accepted_at, revoked_at) values
(pg_temp.d(12), 'r1@example.test', 'viewer', pg_temp.u(13), pg_temp.sha('r1'), now() - interval '40 days', now() - interval '26 days', now() - interval '31 days', null),
(pg_temp.d(12), 'r2@example.test', 'viewer', pg_temp.u(13), pg_temp.sha('r2'), now() - interval '40 days', now() - interval '26 days', now() - interval '29 days', null),
(pg_temp.d(12), 'r3@example.test', 'viewer', pg_temp.u(13), pg_temp.sha('r3'), now() - interval '40 days', now() - interval '26 days', null, now() - interval '31 days'),
(pg_temp.d(12), 'r4@example.test', 'viewer', pg_temp.u(13), pg_temp.sha('r4'), now() - interval '40 days', now() - interval '26 days', null, now() - interval '29 days'),
(pg_temp.d(12), 'r5@example.test', 'viewer', pg_temp.u(13), pg_temp.sha('r5'), now() - interval '45 days', now() - interval '31 days', null, null),
(pg_temp.d(12), 'r6@example.test', 'viewer', pg_temp.u(13), pg_temp.sha('r6'), now() - interval '43 days', now() - interval '29 days', null, null),
(pg_temp.d(12), 'r7@example.test', 'viewer', pg_temp.u(13), pg_temp.sha('r7'), now(), now() + interval '14 days', null, null);
select pg_temp.as_service();
select pg_temp.run('purge_links', $q$public.retention_purge_share_links()$q$);
select pg_temp.chk('210 retention-share-links: links revoked or expired over 30 days ago go; the rest stay', $q$
    select (pg_temp.out('purge_links') #>> '{}')::int >= 2
       and (select array_agg(token order by token) from public.share_links where document_id = pg_temp.d(12))
           = array['retention-expired-29dA', 'retention-live-linkAAA', 'retention-revoked-29dA']$q$);
select pg_temp.chk('211 ... the redemption goes with the link, the member keeps the score', $q$
    select not exists (select 1 from public.share_link_redemptions where document_id = pg_temp.d(12))
       and pg_temp.member_role(pg_temp.d(12), pg_temp.u(5)) = 'viewer'$q$);
select pg_temp.run('purge_invites', $q$public.retention_purge_share_invites()$q$);
select pg_temp.chk('212 retention-share-invites: 30 days after accept, cancel or expiry; pending and recent stay', $q$
    select (pg_temp.out('purge_invites') #>> '{}')::int >= 3
       and (select array_agg(email order by email) from public.document_invites where document_id = pg_temp.d(12))
           = array['r2@example.test', 'r4@example.test', 'r6@example.test', 'r7@example.test']$q$);
select pg_temp.as_postgres();
select pg_temp.chk('213 the cron jobs run these functions', $q$
    select (select command from cron.job where jobname = 'retention-share-links') = 'select public.retention_purge_share_links ()'
       and (select command from cron.job where jobname = 'retention-share-invites') = 'select public.retention_purge_share_invites ()'$q$);

-- ===========================================================================
-- The link-guest age gate
-- ===========================================================================
select pg_temp.chk('220 the link guest gate passes only for an anonymous user', $q$
    select public.age_gate_problem_for('{"age_gate":{"source":"link_guest","v":2}}', true) is null
       and public.age_gate_problem_for('{"age_gate":{"source":"link_guest","v":2}}', false) = 'age_check_missing'
       and public.age_gate_problem_for('{"age_gate":{"source":"link_guest","v":1}}', true) = 'age_check_missing'
       and public.age_gate_problem_for('{}', true) = 'age_check_missing'$q$);
select pg_temp.chk('221 every other gate is age_gate_problem''s answer, anonymous or not', $q$
    select public.age_gate_problem_for('{"age_gate":{"country":"US","min_age":13}}', false) is null
       and public.age_gate_problem_for('{"age_gate":{"country":"US","min_age":13}}', true) is null
       and public.age_gate_problem_for('{"age_gate":{"country":"US","min_age":10}}', false) = 'below_consent_age'$q$);
select pg_temp.chk('222 the hook admits an anonymous link guest and refuses the same gate on a registered sign-up', $q$
    select public.hook_before_user_created('{"user":{"is_anonymous":true,"user_metadata":{"age_gate":{"source":"link_guest","v":2}}}}') = '{}'
       and (public.hook_before_user_created('{"user":{"is_anonymous":false,"email":"a@b.test","user_metadata":{"age_gate":{"source":"link_guest","v":2}}}}')
            -> 'error' ->> 'http_code') = '400'
       and (public.hook_before_user_created('{"user":{"user_metadata":{"age_gate":{"source":"link_guest","v":2}}}}')
            -> 'error' ->> 'http_code') = '400'$q$);
-- GoTrue's own inserts (as supabase_auth_admin) are in age_gate_admin_backstop.sql, checks 34 and 35.
insert into auth.users (id, raw_user_meta_data, is_anonymous) values
(pg_temp.u(30), '{"age_gate":{"source":"link_guest","v":2}}', true),
(pg_temp.u(32), '{"age_gate":{"source":"link_guest","v":2}}', true);
insert into public.guest_email_verifications (user_id, email, code_hash, expires_at, verified_email, verified_at)
values (pg_temp.u(30), 'lg30@example.test', 'x', now() + interval '10 minutes', 'lg30@example.test', clock_timestamp());
select pg_temp.refused('225 a link guest cannot become an account while the gate is still link_guest', $q$
    update auth.users set email = 'lg30@example.test', is_anonymous = false where id = pg_temp.u(30)$q$, '42501');
update auth.users set raw_user_meta_data = '{"age_gate":{"country":"US","min_age":13}}' where id = pg_temp.u(30);
select pg_temp.chk('226 ... and can once the age screen''s gate is written first', $q$
    with s as (update auth.users set email = 'lg30@example.test', is_anonymous = false where id = pg_temp.u(30) returning is_anonymous)
    select count(*) = 1 and not bool_or(is_anonymous) from s$q$);
-- The marker is the guest's own user_metadata: a guest may remove or change
-- it. Leaving anonymity takes a passing gate whatever it says (33 removed it,
-- 34 altered it, 35 claims an age below consent; 36 is a regular guest).
insert into auth.users (id, raw_user_meta_data, is_anonymous) values
(pg_temp.u(33), '{"age_gate":null}', true),
(pg_temp.u(34), '{"age_gate":{"source":"link_guest","v":3}}', true),
(pg_temp.u(35), '{"age_gate":{"country":"DE","min_age":13,"source":"self","v":1}}', true),
(pg_temp.u(36), '{"age_gate":{"country":"US","min_age":13,"source":"self","v":1}}', true);
insert into public.guest_email_verifications (user_id, email, code_hash, expires_at, verified_email, verified_at)
select pg_temp.u(n), 'lg' || n || '@example.test', 'x', now() + interval '10 minutes', 'lg' || n || '@example.test', clock_timestamp()
from generate_series(33, 36) n;
select pg_temp.refused('227 a guest whose gate was removed cannot become an account', $q$
    update auth.users set email = 'lg33@example.test', is_anonymous = false where id = pg_temp.u(33)$q$, '42501');
select pg_temp.refused('228 nor one whose link-guest gate was altered', $q$
    update auth.users set email = 'lg34@example.test', is_anonymous = false where id = pg_temp.u(34)$q$, '42501');
select pg_temp.refused('229 nor one whose gate is below the consent age', $q$
    update auth.users set email = 'lg35@example.test', is_anonymous = false where id = pg_temp.u(35)$q$, '42501');
select pg_temp.chk('229b a guest with a passing gate becomes an account', $q$
    with s as (update auth.users set email = 'lg36@example.test', is_anonymous = false where id = pg_temp.u(36) returning is_anonymous)
    select count(*) = 1 and not bool_or(is_anonymous) from s$q$);

-- ===========================================================================
-- D8: the owner's idle window for link guests
-- ===========================================================================
select pg_temp.as_user(8);
select pg_temp.chk('230 the default is 30 days', $q$select public.my_share_settings() = '{"link_guest_idle_days": 30}'$q$);
select pg_temp.run('set7', $q$public.set_link_guest_retention(7)$q$);
select pg_temp.chk('231 an owner sets 7 days', $q$select pg_temp.out('set7') = '7'::jsonb and public.my_share_settings() = '{"link_guest_idle_days": 7}'$q$);
select pg_temp.refused('232 0 days is refused', $q$select public.set_link_guest_retention(0)$q$, '22023', 'invalid_retention_days');
select pg_temp.refused('233 91 days is refused', $q$select public.set_link_guest_retention(91)$q$, '22023', 'invalid_retention_days');
select pg_temp.chk('234 1 and 90 days are accepted', $q$select public.set_link_guest_retention(1) = 1 and public.set_link_guest_retention(90) = 90 and public.set_link_guest_retention(7) = 7$q$);
select pg_temp.as_user(13);
select pg_temp.chk('235 another owner sets 60 days', $q$select public.set_link_guest_retention(60) = 60$q$);
select pg_temp.as_user(3, true);
select pg_temp.refused('236 a guest has no sharing settings', $q$select public.set_link_guest_retention(30)$q$, '42501');
select pg_temp.as_user(4);
select pg_temp.refused('237 nor does a roster student', $q$select public.set_link_guest_retention(30)$q$, '42501');
select pg_temp.as_postgres();
select pg_temp.chk('238 the setting is no client''s table', $q$
    select not bool_or(has_any_column_privilege(r, 'public.share_owner_settings', 'SELECT, INSERT, UPDATE')) from unnest(array['anon', 'authenticated']) r$q$);
-- 14: link guest on owner 8's score (7 days). 15: on owner 8's and owner 13's
-- (7 and 60). 7: on owner 12's (never chose: 30). 9: a regular guest.
insert into public.document_members (document_id, user_id, role) values
(pg_temp.d(11), pg_temp.u(14), 'editor'),
(pg_temp.d(11), pg_temp.u(15), 'editor'),
(pg_temp.d(12), pg_temp.u(15), 'editor');
select pg_temp.chk('239 the windows: 7 days, the longer of 7 and 60, 30 by default, 90 for a regular guest', $q$
    select public.retention_guest_idle_window(pg_temp.u(14), '90 days') = interval '7 days'
       and public.retention_guest_idle_window(pg_temp.u(15), '90 days') = interval '60 days'
       and public.retention_guest_idle_window(pg_temp.u(7), '90 days') = interval '30 days'
       and public.retention_guest_idle_window(pg_temp.u(9), '90 days') = interval '90 days'$q$);
create function pg_temp.idle(p_user uuid, p_days int) returns void language sql as $f$
    update auth.users set created_at = now() - make_interval(days => p_days), last_sign_in_at = now() - make_interval(days => p_days),
                          updated_at = now() - make_interval(days => p_days)
    where id = p_user
$f$;
create function pg_temp.exists_user(p_user uuid) returns boolean language sql as $f$ select exists (select 1 from auth.users where id = p_user) $f$;
select pg_temp.idle(pg_temp.u(14), 10);
select pg_temp.idle(pg_temp.u(15), 30);
select pg_temp.idle(pg_temp.u(9), 60);
select public.retention_purge_stale_guests();
select pg_temp.chk('240 a link guest idle 10 days on a 7-day owner is deleted', $q$select not pg_temp.exists_user(pg_temp.u(14))$q$);
select pg_temp.chk('241 a link guest on a 7-day and a 60-day owner, idle 30 days, is kept', $q$select pg_temp.exists_user(pg_temp.u(15))$q$);
select pg_temp.chk('242 a regular guest idle 60 days is kept', $q$select pg_temp.exists_user(pg_temp.u(9))$q$);
select pg_temp.idle(pg_temp.u(15), 61);
select pg_temp.idle(pg_temp.u(9), 91);
select public.retention_purge_stale_guests();
select pg_temp.chk('243 ... idle 61 days, it is deleted', $q$select not pg_temp.exists_user(pg_temp.u(15))$q$);
select pg_temp.chk('244 a regular guest idle 91 days is deleted', $q$select not pg_temp.exists_user(pg_temp.u(9))$q$);
select pg_temp.chk('245 a link guest on no score uses 30 days; an upgraded one is a regular account', $q$
    select public.retention_guest_idle_window(pg_temp.u(32), '90 days') = interval '30 days'
       and public.retention_guest_idle_window(pg_temp.u(30), '90 days') = interval '90 days'$q$);

-- ---------------------------------------------------------------------------
-- Report: every check, then `failures | total`
-- ---------------------------------------------------------------------------
select name, ok, detail from t_results order by name;

select count(*) filter (where not ok) as failures, count(*) as total from t_results;

rollback;
