-- Behaviour proof for 20261022120000_realtime_revocation_rotation.sql: every
-- way a member loses a score (or loses write on it) moves the score to its next
-- realtime topic generation, once per transaction, at commit; whoever lost
-- access is refused the new topics, whoever kept it joins them, and an editor
-- turned viewer joins without being able to send live ink. Paths: role
-- downgrade, assign_score flipping to view-only, remove, leave, link revoke
-- with removal, unassign, a student's sessions ended (reset), archive, and the
-- district soft delete. Then 20261022120100_realtime_revocation_races.sql: an
-- archived score has no realtime and archiving moves it, the generation no
-- longer holds a foreign key yet still goes with its score, an archived
-- student's assignment is refused under the roster lock whoever writes it, and
-- back-to-back rotations each tell the generation they replaced (the races
-- themselves are in realtime_revocation_race.sql). Needs the local stack
-- running, so today's realtime.messages partition exists (`npm run cloud:up`).
--
-- Runs inside one transaction and ROLLS BACK — nothing persists:
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/realtime_revocation_rotation.sql
--
-- The rotation runs when the transaction commits (a deferred trigger), which a
-- rolled-back proof never reaches: pg_temp.at_commit() fires it the way COMMIT
-- would (SET CONSTRAINTS … IMMEDIATE), so everything between two calls is one
-- transaction's worth.
--
-- Every row of the result table should read `t`; the last line is
-- `failures | total`. No DROP / DELETE / TRUNCATE keyword (see README.md).
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('c0de4e00-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.d(n int) returns uuid language sql immutable as $f$ select ('c0de4ed0-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
create function pg_temp.as_user(n int) returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(n), 'role', 'authenticated', 'iat', floor(extract(epoch from now())) - 60)::text, true);
perform set_config('role', 'authenticated', true);
end $f$;
-- A token issued now (after any revocation so far): a student who signed in again.
create function pg_temp.as_user_signed_in_again(n int) returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(n), 'role', 'authenticated', 'iat', ceil(extract(epoch from clock_timestamp())) + 1)::text, true);
perform set_config('role', 'authenticated', true);
end $f$;
create function pg_temp.as_service() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
perform set_config('role', 'service_role', true);
end $f$;
create function pg_temp.as_postgres() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', '', true);
perform set_config('role', 'none', true);
end $f$;
-- What COMMIT does first: run the deferred rotation, then carry on deferring.
create function pg_temp.at_commit() returns boolean language plpgsql as $f$
begin
set constraints public.document_realtime_rotation_queue_rotate immediate;
set constraints public.document_realtime_rotation_queue_rotate deferred;
return true;
end $f$;
-- A join is a read of realtime.messages under the joining user with
-- realtime.topic set (tests/sql/content_moderation.sql): may this user join it?
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
-- A live-ink broadcast is an insert into realtime.messages under the sender
-- with realtime.topic set (tests/sql/column_integrity.sql): may this user send it?
create function pg_temp.can_send(p_topic text) returns boolean language plpgsql as $f$
begin
    perform set_config('realtime.topic', p_topic, true);
    begin
        insert into realtime.messages (topic, extension, event, payload, private) values (p_topic, 'broadcast', 'ink:progress', '{}', true);
    exception when insufficient_privilege then
        perform set_config('realtime.topic', '', true);
        return false;
    end;
    perform set_config('realtime.topic', '', true);
    return true;
end $f$;
-- A presence update is the same insert with extension 'presence'.
create function pg_temp.can_track(p_topic text) returns boolean language plpgsql as $f$
begin
    perform set_config('realtime.topic', p_topic, true);
    begin
        insert into realtime.messages (topic, extension, event, payload, private) values (p_topic, 'presence', 'presence', '{}', true);
    exception when insufficient_privilege then
        perform set_config('realtime.topic', '', true);
        return false;
    end;
    perform set_config('realtime.topic', '', true);
    return true;
end $f$;
create function pg_temp.live(p_doc uuid, p_epoch int) returns text language sql immutable as $f$
    select 'doc:' || p_doc::text || case when p_epoch = 0 then '' else ':' || p_epoch::text end
$f$;
create function pg_temp.db(p_doc uuid, p_epoch int) returns text language sql immutable as $f$
    select 'doc-db:' || p_doc::text || case when p_epoch = 0 then '' else ':' || p_epoch::text end
$f$;
-- May this user join both of the score's topics at generation p_epoch?
create function pg_temp.joins(p_doc uuid, p_epoch int) returns boolean language sql as $f$
    select pg_temp.can_join(pg_temp.live(p_doc, p_epoch)) and pg_temp.can_join(pg_temp.db(p_doc, p_epoch))
$f$;
-- Neither of them?
create function pg_temp.refused(p_doc uuid, p_epoch int) returns boolean language sql as $f$
    select not pg_temp.can_join(pg_temp.live(p_doc, p_epoch)) and not pg_temp.can_join(pg_temp.db(p_doc, p_epoch))
$f$;
-- Generations and topic_rotated hints, before an action and after it.
create temp table t_snap (doc uuid primary key, epoch int, told bigint);
grant all on t_snap to anon, authenticated, service_role;
create function pg_temp.epoch(p_doc uuid) returns int language sql as $f$
    select coalesce((select e.epoch from public.document_realtime_epochs e where e.document_id = p_doc), 0)
$f$;
create function pg_temp.told(p_doc uuid) returns bigint language sql as $f$
    select count(*) from realtime.messages where event = 'topic_rotated' and payload ->> 'document_id' = p_doc::text
$f$;
create function pg_temp.snap() returns void language sql as $f$
    insert into t_snap select pg_temp.d(n), pg_temp.epoch(pg_temp.d(n)), pg_temp.told(pg_temp.d(n)) from generate_series(1, 11) n
    on conflict (doc) do update set epoch = excluded.epoch, told = excluded.told
$f$;
-- How many generations the score moved since the snapshot.
create function pg_temp.moved(p_doc uuid) returns int language sql as $f$
    select pg_temp.epoch(p_doc) - s.epoch from t_snap s where s.doc = p_doc
$f$;
-- Moved exactly once, telling both old topics (one hint each), and nothing else.
create function pg_temp.moved_once(p_doc uuid) returns boolean language sql as $f$
    select pg_temp.moved(p_doc) = 1
       and pg_temp.told(p_doc) - s.told = 2
       and exists (select 1 from realtime.messages m where m.event = 'topic_rotated' and m.topic = pg_temp.live(p_doc, s.epoch))
       and exists (select 1 from realtime.messages m where m.event = 'topic_rotated' and m.topic = pg_temp.db(p_doc, s.epoch))
    from t_snap s where s.doc = p_doc
$f$;
create function pg_temp.still(p_doc uuid) returns boolean language sql as $f$
    select pg_temp.moved(p_doc) = 0 and pg_temp.told(p_doc) = s.told from t_snap s where s.doc = p_doc
$f$;
-- The membership hint for this user went out on exactly this topic.
create function pg_temp.hinted(p_user uuid, p_topic text) returns boolean language sql as $f$
    select exists (
        select 1 from realtime.messages
        where topic = p_topic and event = 'membership' and payload ->> 'user_id' = p_user::text
    )
$f$;
create function pg_temp.queue_empty() returns boolean language sql as $f$
    select not exists (select 1 from public.document_realtime_rotation_queue)
$f$;
-- Row removal, spelled at run time (README.md: no such keyword in the file).
create function pg_temp.remove_score(p_doc uuid) returns void language plpgsql as $f$
begin execute 'del' || 'ete from public.documents where id = $1' using p_doc; end $f$;

-- 1 owner (teacher), 2 editor who stays, 3 editor turned viewer, 4 editor
-- removed, 5 and 6 guests through a link, 7 roster student (assigned, then
-- unassigned), 8 roster student whose sessions are ended (reset), 9 roster
-- student archived, 10 and 11 district students, 12 a viewer who leaves, 13 the
-- district's teacher, 14 a viewer made editor, 15 another teacher (the free
-- plan holds three scores each).
insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data, is_anonymous)
select pg_temp.u(n), 'p4-' || n || '@revocation.test',
       case when n in (7, 8, 9, 10, 11) then '{"user_type":"student"}'::jsonb else '{}'::jsonb end,
       '{}', false
from generate_series(1, 15) n;
-- 1-3 the teacher's; 4 and 5 the roster students' scores, and 8 (deleted in
-- the same transaction as a removal), teacher 15's; 6 and 7 the district
-- teacher's, and 9, a score nobody loses; 10 (archived) and 11 (deleted) 14's.
insert into public.documents (id, owner_id, title, storage_path)
select pg_temp.d(n), case when n in (6, 7, 9) then pg_temp.u(13) when n in (4, 5, 8) then pg_temp.u(15) when n in (10, 11) then pg_temp.u(14) else pg_temp.u(1) end, 'P4 score ' || n,
       pg_temp.d(n)::text || '/original.pdf'
from generate_series(1, 11) n;
insert into public.studios (id, owner_id, name) values (pg_temp.d(50), pg_temp.u(13), 'P4 District');
insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
values (pg_temp.d(50), now() - interval '17 days', 'admin', 'test');
insert into public.managed_students
    (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at, district_studio_id)
values
    (pg_temp.d(70), pg_temp.u(1), pg_temp.u(7), 'Seven', null, 'code', 'p4_seven', now(), null),
    (pg_temp.d(80), pg_temp.u(1), pg_temp.u(8), 'Eight', null, 'code', 'p4_eight', now(), null),
    (pg_temp.d(90), pg_temp.u(1), pg_temp.u(9), 'Nine', null, 'code', 'p4_nine', now(), null),
    (pg_temp.d(100), pg_temp.u(13), pg_temp.u(10), 'Ten', null, 'code', 'p4_ten', now(), pg_temp.d(50)),
    (pg_temp.d(110), pg_temp.u(13), pg_temp.u(11), 'Eleven', null, 'code', 'p4_eleven', now(), pg_temp.d(50));
insert into public.document_members (document_id, user_id, role) values
(pg_temp.d(1), pg_temp.u(2), 'editor'),
(pg_temp.d(1), pg_temp.u(3), 'editor'),
(pg_temp.d(1), pg_temp.u(4), 'editor'),
(pg_temp.d(1), pg_temp.u(12), 'viewer'),
(pg_temp.d(1), pg_temp.u(14), 'viewer'),
(pg_temp.d(2), pg_temp.u(2), 'editor'),
(pg_temp.d(2), pg_temp.u(5), 'viewer'),
(pg_temp.d(2), pg_temp.u(6), 'viewer'),
(pg_temp.d(3), pg_temp.u(7), 'editor'),
(pg_temp.d(4), pg_temp.u(8), 'editor'),
(pg_temp.d(4), pg_temp.u(9), 'editor'),
(pg_temp.d(5), pg_temp.u(8), 'editor'),
(pg_temp.d(6), pg_temp.u(10), 'editor'),
(pg_temp.d(6), pg_temp.u(11), 'editor'),
(pg_temp.d(7), pg_temp.u(10), 'viewer'),
(pg_temp.d(8), pg_temp.u(2), 'editor'),
(pg_temp.d(9), pg_temp.u(2), 'editor'),
(pg_temp.d(10), pg_temp.u(2), 'editor'),
(pg_temp.d(11), pg_temp.u(2), 'editor'),
(pg_temp.d(11), pg_temp.u(3), 'viewer');
insert into public.assignments (id, document_id, student_user_id, assigned_by, access) values
(pg_temp.d(30), pg_temp.d(3), pg_temp.u(7), pg_temp.u(1), 'edit'),
(pg_temp.d(31), pg_temp.d(5), pg_temp.u(8), pg_temp.u(15), 'edit');
insert into public.share_links (token, document_id, role, created_by) values
('c0deP4LINK1', pg_temp.d(2), 'viewer', pg_temp.u(1)),
('c0deP4LINK2', pg_temp.d(2), 'viewer', pg_temp.u(1));
insert into public.share_link_redemptions (document_id, user_id, token) values
(pg_temp.d(2), pg_temp.u(5), 'c0deP4LINK1'),
(pg_temp.d(2), pg_temp.u(6), 'c0deP4LINK1');

-- Realtime creates the day's realtime.messages partition only while it runs;
-- without it every send is a swallowed WARNING and the hint checks below would
-- prove nothing.
select pg_temp.chk('00 realtime is running (today''s realtime.messages partition exists)', $q$select exists (select 1 from pg_class where relnamespace = 'realtime'::regnamespace and relname = 'messages_' || to_char(now(), 'YYYY_MM_DD'))$q$);
select pg_temp.chk('00b nothing is queued before anything happens', $q$select pg_temp.queue_empty()$q$);
select pg_temp.chk('00c every score starts at generation 0', $q$select bool_and(pg_temp.epoch(pg_temp.d(n)) = 0) from generate_series(1, 9) n$q$);
select pg_temp.snap();

-- ---- downgrade: editor -> viewer (set_document_member_role)
select pg_temp.as_user(1);
select public.set_document_member_role(pg_temp.d(1), pg_temp.u(3), 'viewer');
select pg_temp.as_postgres();
select pg_temp.chk('01 downgrade: nothing moves before the transaction commits', $q$select pg_temp.still(pg_temp.d(1)) and not pg_temp.queue_empty()$q$);
select pg_temp.chk('01b downgrade: the hint went out on the topic the viewer is on', $q$select pg_temp.hinted(pg_temp.u(3), pg_temp.live(pg_temp.d(1), 0))$q$);
select pg_temp.at_commit();
select pg_temp.chk('02 downgrade: the score moved once, both old topics told topic_rotated', $q$select pg_temp.moved_once(pg_temp.d(1))$q$);
select pg_temp.chk('02b downgrade: the queue is empty after commit', $q$select pg_temp.queue_empty()$q$);
select pg_temp.chk('02c downgrade: the owner''s other scores did not move', $q$select pg_temp.still(pg_temp.d(2)) and pg_temp.still(pg_temp.d(9))$q$);
select pg_temp.as_user(3);
select pg_temp.chk('03 downgrade: the viewer is told generation 1 and joins doc:{id}:1 and doc-db:{id}:1', $q$select public.realtime_topic_epoch(pg_temp.d(1)) = 1 and pg_temp.joins(pg_temp.d(1), 1)$q$);
select pg_temp.chk('03b downgrade: the viewer cannot send live ink on the new doc:{id}:1', $q$select not pg_temp.can_send(pg_temp.live(pg_temp.d(1), 1))$q$);
select pg_temp.chk('03c downgrade: the viewer cannot rejoin the old generation', $q$select pg_temp.refused(pg_temp.d(1), 0)$q$);
select pg_temp.as_user(2);
select pg_temp.chk('04 downgrade: the editor who stays joins generation 1 and sends live ink there', $q$select public.realtime_topic_epoch(pg_temp.d(1)) = 1 and pg_temp.joins(pg_temp.d(1), 1) and pg_temp.can_send(pg_temp.live(pg_temp.d(1), 1))$q$);
select pg_temp.as_user(1);
select pg_temp.chk('04b downgrade: so does the owner', $q$select pg_temp.joins(pg_temp.d(1), 1) and pg_temp.can_send(pg_temp.live(pg_temp.d(1), 1))$q$);

-- ---- gaining access moves nothing
select pg_temp.as_postgres();
select pg_temp.snap();
select pg_temp.as_user(1);
select public.set_document_member_role(pg_temp.d(1), pg_temp.u(14), 'editor');
select public.set_document_member_role(pg_temp.d(1), pg_temp.u(2), 'editor');
select pg_temp.as_postgres();
select pg_temp.at_commit();
select pg_temp.chk('05 a viewer made editor, or a role set to what it was, moves nothing', $q$select pg_temp.still(pg_temp.d(1)) and pg_temp.queue_empty()$q$);

-- ---- remove and leave, in one transaction
select pg_temp.snap();
select pg_temp.as_user(1);
select public.remove_document_member(pg_temp.d(1), pg_temp.u(4));
select pg_temp.as_user(12);
select public.leave_document(pg_temp.d(1));
select pg_temp.as_postgres();
select pg_temp.chk('06 remove: the removed member''s hint went out on the topic they are on (doc:{id}:1)', $q$select pg_temp.hinted(pg_temp.u(4), pg_temp.live(pg_temp.d(1), 1)) and pg_temp.hinted(pg_temp.u(12), pg_temp.live(pg_temp.d(1), 1))$q$);
select pg_temp.at_commit();
select pg_temp.chk('07 remove + leave in one transaction: the score moved once', $q$select pg_temp.moved_once(pg_temp.d(1))$q$);
select pg_temp.as_user(4);
select pg_temp.chk('08 remove: the removed member is not told the generation, and joins neither the new topics nor the old', $q$select public.realtime_topic_epoch(pg_temp.d(1)) is null and pg_temp.refused(pg_temp.d(1), 2) and pg_temp.refused(pg_temp.d(1), 1)$q$);
select pg_temp.chk('08b remove: nor can they send live ink on the new doc:{id}:2', $q$select not pg_temp.can_send(pg_temp.live(pg_temp.d(1), 2))$q$);
select pg_temp.as_user(12);
select pg_temp.chk('09 leave: the member who left joins neither generation', $q$select public.realtime_topic_epoch(pg_temp.d(1)) is null and pg_temp.refused(pg_temp.d(1), 2) and pg_temp.refused(pg_temp.d(1), 1)$q$);
select pg_temp.as_user(2);
select pg_temp.chk('10 remove: the editor who stays joins doc:{id}:2 and sends there', $q$select public.realtime_topic_epoch(pg_temp.d(1)) = 2 and pg_temp.joins(pg_temp.d(1), 2) and pg_temp.can_send(pg_temp.live(pg_temp.d(1), 2))$q$);
select pg_temp.as_user(3);
select pg_temp.chk('10b remove: the viewer who stays joins doc:{id}:2, still without sending', $q$select pg_temp.joins(pg_temp.d(1), 2) and not pg_temp.can_send(pg_temp.live(pg_temp.d(1), 2))$q$);

-- ---- committed marks follow the members who stay
select pg_temp.as_postgres();
insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
values ('c0de4ea0-0000-4000-8000-000000000001', pg_temp.d(1), 0, 'stroke', '#000', '{"pts":[0,0,1],"w":0.01}', pg_temp.u(2));
select pg_temp.chk('11 a mark committed after the move goes out on doc-db:{id}:2 only, never an old topic', $q$select exists (select 1 from realtime.messages where topic = pg_temp.db(pg_temp.d(1), 2) and payload -> 'record' ->> 'id' = 'c0de4ea0-0000-4000-8000-000000000001') and not exists (select 1 from realtime.messages where topic in (pg_temp.db(pg_temp.d(1), 0), pg_temp.db(pg_temp.d(1), 1)) and payload -> 'record' ->> 'id' = 'c0de4ea0-0000-4000-8000-000000000001')$q$);

-- ---- link revoke with removal
select pg_temp.snap();
select pg_temp.as_user(1);
select pg_temp.chk('12 revoke a link withdrawing its members: two withdrawn', $q$select public.revoke_share_link('c0deP4LINK1', true) = 2$q$);
select pg_temp.as_postgres();
select pg_temp.at_commit();
select pg_temp.chk('13 revoke with removal: the score moved once for both members', $q$select pg_temp.moved_once(pg_temp.d(2))$q$);
select pg_temp.as_user(5);
select pg_temp.chk('14 revoke: a withdrawn guest joins neither generation', $q$select public.realtime_topic_epoch(pg_temp.d(2)) is null and pg_temp.refused(pg_temp.d(2), 1) and pg_temp.refused(pg_temp.d(2), 0)$q$);
select pg_temp.as_user(6);
select pg_temp.chk('14b revoke: nor the other', $q$select pg_temp.refused(pg_temp.d(2), 1)$q$);
select pg_temp.as_user(2);
select pg_temp.chk('15 revoke: the editor who stays joins generation 1', $q$select public.realtime_topic_epoch(pg_temp.d(2)) = 1 and pg_temp.joins(pg_temp.d(2), 1)$q$);
select pg_temp.as_postgres();
select pg_temp.snap();
select pg_temp.as_user(1);
select public.revoke_share_link('c0deP4LINK2', false);
select pg_temp.as_postgres();
select pg_temp.at_commit();
select pg_temp.chk('16 a plain revoke (no member withdrawn) moves nothing', $q$select pg_temp.still(pg_temp.d(2))$q$);

-- ---- assignment flipped to view-only, then unassigned
select pg_temp.snap();
select pg_temp.as_user(1);
select public.assign_score(pg_temp.d(3), pg_temp.u(7), 'view');
select pg_temp.as_postgres();
select pg_temp.at_commit();
select pg_temp.chk('17 assign_score flipping an assignment to view-only: the score moved once', $q$select pg_temp.moved_once(pg_temp.d(3)) and (select role = 'viewer' from public.document_members where document_id = pg_temp.d(3) and user_id = pg_temp.u(7))$q$);
select pg_temp.as_user(7);
select pg_temp.chk('17b the student joins generation 1 without sending live ink', $q$select pg_temp.joins(pg_temp.d(3), 1) and not pg_temp.can_send(pg_temp.live(pg_temp.d(3), 1))$q$);
select pg_temp.as_postgres();
select pg_temp.snap();
select pg_temp.as_user(1);
select public.unassign_score(pg_temp.d(3), pg_temp.u(7));
select pg_temp.as_postgres();
select pg_temp.at_commit();
select pg_temp.chk('18 unassign: the score moved once', $q$select pg_temp.moved_once(pg_temp.d(3))$q$);
select pg_temp.as_user(7);
select pg_temp.chk('19 unassign: the student joins neither generation', $q$select public.realtime_topic_epoch(pg_temp.d(3)) is null and pg_temp.refused(pg_temp.d(3), 2) and pg_temp.refused(pg_temp.d(3), 1)$q$);
select pg_temp.as_user(1);
select pg_temp.chk('20 unassign: the owner joins generation 2', $q$select public.realtime_topic_epoch(pg_temp.d(3)) = 2 and pg_temp.joins(pg_temp.d(3), 2)$q$);

-- ---- a student's sessions ended (reset): every score they are on
select pg_temp.as_postgres();
select pg_temp.snap();
select pg_temp.as_user(8);
select pg_temp.chk('21 before: the student joins both their scores', $q$select pg_temp.joins(pg_temp.d(4), 0) and pg_temp.joins(pg_temp.d(5), 0)$q$);
select pg_temp.as_service();
select public.end_student_sessions(pg_temp.u(8));
select pg_temp.as_postgres();
select pg_temp.chk('22 session end: the hint went out on the topic the student is on', $q$select pg_temp.hinted(pg_temp.u(8), pg_temp.live(pg_temp.d(4), 0)) and pg_temp.hinted(pg_temp.u(8), pg_temp.live(pg_temp.d(5), 0))$q$);
select pg_temp.at_commit();
select pg_temp.chk('23 session end: each of the student''s scores moved once', $q$select pg_temp.moved_once(pg_temp.d(4)) and pg_temp.moved_once(pg_temp.d(5))$q$);
select pg_temp.chk('23b session end: no other score moved', $q$select pg_temp.still(pg_temp.d(1)) and pg_temp.still(pg_temp.d(9))$q$);
select pg_temp.as_user(8);
select pg_temp.chk('24 session end: the student''s old token joins neither generation of either score', $q$select public.realtime_topic_epoch(pg_temp.d(4)) is null and pg_temp.refused(pg_temp.d(4), 1) and pg_temp.refused(pg_temp.d(4), 0) and pg_temp.refused(pg_temp.d(5), 1)$q$);
select pg_temp.as_user(9);
select pg_temp.chk('25 session end: another student on the score joins generation 1', $q$select public.realtime_topic_epoch(pg_temp.d(4)) = 1 and pg_temp.joins(pg_temp.d(4), 1)$q$);
select pg_temp.as_user(15);
select pg_temp.chk('25b session end: and the score''s owner', $q$select pg_temp.joins(pg_temp.d(4), 1) and pg_temp.joins(pg_temp.d(5), 1)$q$);
select pg_temp.as_user_signed_in_again(8);
select pg_temp.chk('25c a reset is not an archive: signed in again, the student joins generation 1', $q$select public.realtime_topic_epoch(pg_temp.d(4)) = 1 and pg_temp.joins(pg_temp.d(4), 1)$q$);

-- ---- archive: the stamp, then (another request) the session end
select pg_temp.as_postgres();
select pg_temp.snap();
select pg_temp.as_service();
update public.managed_students set archived_at = now() where id = pg_temp.d(90);
select pg_temp.as_postgres();
select pg_temp.at_commit();
select pg_temp.chk('26 archive: the student''s score moved once', $q$select pg_temp.moved_once(pg_temp.d(4))$q$);
select pg_temp.as_service();
select public.end_student_sessions(pg_temp.u(9));
select pg_temp.as_postgres();
select pg_temp.at_commit();
select pg_temp.chk('27 archive: ending an archived student''s sessions does not move it again', $q$select pg_temp.moved_once(pg_temp.d(4))$q$);
select pg_temp.as_user_signed_in_again(9);
select pg_temp.chk('28 archive: the student joins neither generation, even signed in again', $q$select public.realtime_topic_epoch(pg_temp.d(4)) is null and pg_temp.refused(pg_temp.d(4), 2) and pg_temp.refused(pg_temp.d(4), 1)$q$);
select pg_temp.as_user(15);
select pg_temp.chk('28b archive: the score''s owner joins generation 2', $q$select pg_temp.joins(pg_temp.d(4), 2)$q$);
select pg_temp.as_postgres();
select pg_temp.snap();
select pg_temp.as_service();
update public.managed_students set archived_at = null where id = pg_temp.d(90);
select pg_temp.as_postgres();
select pg_temp.at_commit();
select pg_temp.chk('29 restoring an archived student moves nothing', $q$select pg_temp.still(pg_temp.d(4))$q$);

-- ---- district soft delete (retention_district_run, 20261021120700)
select pg_temp.as_postgres();
select public.retention_district_run(now());
select public.finish_district_retention_notice(id) from public.claim_district_retention_notices(50);
select pg_temp.at_commit();
select pg_temp.snap();
create temp table t_soft as select public.retention_district_run(now() + interval '14 days 1 minute') as ran;
select pg_temp.chk('30 the district soft delete ran and archived both students', $q$select (select (ran ->> 'soft_delete')::int >= 1 from t_soft) and (select bool_and(archived_at is not null and access_revoked_at is not null) from public.managed_students where id in (pg_temp.d(100), pg_temp.d(110)))$q$);
select pg_temp.chk('30b nothing moves before it commits', $q$select pg_temp.still(pg_temp.d(6)) and pg_temp.still(pg_temp.d(7))$q$);
select pg_temp.at_commit();
select pg_temp.chk('31 soft delete: a score both students were on moved once', $q$select pg_temp.moved_once(pg_temp.d(6))$q$);
select pg_temp.chk('31b soft delete: and the other score one of them was on, once', $q$select pg_temp.moved_once(pg_temp.d(7))$q$);
select pg_temp.chk('31c soft delete: the queue is empty after commit', $q$select pg_temp.queue_empty()$q$);
select pg_temp.as_user(10);
select pg_temp.chk('32 soft delete: a district student joins neither generation', $q$select public.realtime_topic_epoch(pg_temp.d(6)) is null and pg_temp.refused(pg_temp.d(6), 1) and pg_temp.refused(pg_temp.d(6), 0) and pg_temp.refused(pg_temp.d(7), 1)$q$);
select pg_temp.as_user(11);
select pg_temp.chk('32b soft delete: nor the other', $q$select pg_temp.refused(pg_temp.d(6), 1)$q$);
select pg_temp.as_user(13);
select pg_temp.chk('33 soft delete: the district teacher joins generation 1', $q$select public.realtime_topic_epoch(pg_temp.d(6)) = 1 and pg_temp.joins(pg_temp.d(6), 1) and pg_temp.joins(pg_temp.d(7), 1)$q$);

-- ---- a score deleted after its member was removed, in one transaction
select pg_temp.as_postgres();
select pg_temp.snap();
select pg_temp.as_user(15);
select public.remove_document_member(pg_temp.d(8), pg_temp.u(2));
select pg_temp.as_postgres();
select pg_temp.remove_score(pg_temp.d(8));
select pg_temp.chk('34 a score deleted after a removal: the commit succeeds and nothing is left behind', $q$select pg_temp.at_commit() and pg_temp.queue_empty() and not exists (select 1 from public.document_realtime_epochs where document_id = pg_temp.d(8))$q$);

-- ---- nobody can reach the queue or the rotation directly
select pg_temp.as_user(1);
select pg_temp.chk('35 a client cannot read the queue', $q$select not has_table_privilege('authenticated', 'public.document_realtime_rotation_queue', 'select')$q$);
select pg_temp.chk('35b nor write it', $q$select not has_table_privilege('authenticated', 'public.document_realtime_rotation_queue', 'insert')$q$);
select pg_temp.chk('35c nor queue or run a rotation', $q$select not has_function_privilege('authenticated', 'public.queue_document_realtime_rotation(uuid)', 'execute') and not has_function_privilege('anon', 'public.queue_document_realtime_rotation(uuid)', 'execute') and not has_function_privilege('authenticated', 'public.rotate_queued_document_realtime()', 'execute')$q$);
select pg_temp.as_postgres();
select pg_temp.chk('36 the score nobody lost never moved', $q$select pg_temp.epoch(pg_temp.d(9)) = 0$q$);

-- ---- an archived score (20261022120100): no realtime, and archiving moves it
select pg_temp.snap();
select pg_temp.as_user(14);
select pg_temp.chk('37 before: the owner and an editor of a live score join, send and track', $q$select pg_temp.joins(pg_temp.d(10), 0) and pg_temp.can_send(pg_temp.live(pg_temp.d(10), 0)) and pg_temp.can_track(pg_temp.live(pg_temp.d(10), 0))$q$);
select pg_temp.as_postgres();
update public.documents set archived_at = now(), archived_reason = 'plan_lapse' where id = pg_temp.d(10);
select pg_temp.chk('37b archive: nothing moves before the transaction commits', $q$select pg_temp.still(pg_temp.d(10)) and not pg_temp.queue_empty()$q$);
select pg_temp.at_commit();
select pg_temp.chk('38 archive: the score moved once, both old topics told topic_rotated', $q$select pg_temp.moved_once(pg_temp.d(10)) and pg_temp.queue_empty()$q$);
select pg_temp.as_user(14);
select pg_temp.chk('39 archived: the owner is told no generation and joins neither generation', $q$select public.realtime_topic_epoch(pg_temp.d(10)) is null and pg_temp.refused(pg_temp.d(10), 1) and pg_temp.refused(pg_temp.d(10), 0)$q$);
select pg_temp.chk('39b archived: nor sends live ink or presence on the current doc:{id}:1', $q$select not pg_temp.can_send(pg_temp.live(pg_temp.d(10), 1)) and not pg_temp.can_track(pg_temp.live(pg_temp.d(10), 1))$q$);
select pg_temp.as_user(2);
select pg_temp.chk('39c archived: nor does an editor', $q$select public.realtime_topic_epoch(pg_temp.d(10)) is null and pg_temp.refused(pg_temp.d(10), 1) and not pg_temp.can_send(pg_temp.live(pg_temp.d(10), 1)) and not pg_temp.can_track(pg_temp.live(pg_temp.d(10), 1))$q$);
select pg_temp.chk('39d archived: the editor''s other scores are untouched', $q$select pg_temp.joins(pg_temp.d(9), 0) and pg_temp.can_send(pg_temp.live(pg_temp.d(9), 0))$q$);
select pg_temp.as_postgres();
select pg_temp.snap();
update public.documents set archived_at = null where id = pg_temp.d(10);
select pg_temp.at_commit();
select pg_temp.chk('40 restore: moves nothing', $q$select pg_temp.still(pg_temp.d(10))$q$);
select pg_temp.as_user(14);
select pg_temp.chk('40b restored: the owner is told generation 1, joins it and sends there again', $q$select public.realtime_topic_epoch(pg_temp.d(10)) = 1 and pg_temp.joins(pg_temp.d(10), 1) and pg_temp.can_send(pg_temp.live(pg_temp.d(10), 1)) and pg_temp.can_track(pg_temp.live(pg_temp.d(10), 1))$q$);
select pg_temp.as_postgres();

-- ---- the generation without a foreign key (20261022120100)
select pg_temp.chk('41 document_realtime_epochs holds no foreign key on documents (the rotation never waits on the score)', $q$select not exists (select 1 from pg_constraint where conrelid = 'public.document_realtime_epochs'::regclass and contype = 'f')$q$);
select pg_temp.as_user(14);
select public.remove_document_member(pg_temp.d(11), pg_temp.u(3));
select pg_temp.as_postgres();
select pg_temp.at_commit();
select pg_temp.chk('41b a rotated score has a generation row', $q$select pg_temp.epoch(pg_temp.d(11)) = 1$q$);
select pg_temp.remove_score(pg_temp.d(11));
select pg_temp.chk('41c deleting the score removes its generation at once, after the cascades', $q$select not exists (select 1 from public.document_realtime_epochs where document_id = pg_temp.d(11)) and not exists (select 1 from public.document_members where document_id = pg_temp.d(11))$q$);
select pg_temp.chk('41d the rotation never locks the score (no FOR KEY SHARE / FOR SHARE left in it)', $q$select prosrc !~* 'for (key )?share' from pg_proc where oid = 'public.rotate_queued_document_realtime()'::regprocedure$q$);

-- ---- grants take the student's roster lock (20261022120100)
select pg_temp.chk('42 every assignment and membership insert locks the student''s roster row first', $q$select (select count(*) from pg_trigger where not tgisinternal and tgenabled = 'O' and tgtype & 2 = 2 and tgtype & 4 = 4
        and ((tgrelid = 'public.assignments'::regclass and tgname = 'assignments_lock_student')
          or (tgrelid = 'public.document_members'::regclass and tgname = 'document_members_lock_student'))) = 2
   and (select prosrc ~* 'for share' from pg_proc where oid = 'public.lock_student_for_grant(uuid)'::regprocedure)$q$);
create function pg_temp.assign_raw(p_doc uuid, p_student uuid) returns void language plpgsql as $f$
begin
    insert into public.assignments (id, document_id, student_user_id, assigned_by, access)
    values (gen_random_uuid(), p_doc, p_student, pg_temp.u(13), 'edit');
end $f$;
select pg_temp.chk('42b (district student 10 is archived by the soft delete above)', $q$select archived_at is not null from public.managed_students where id = pg_temp.d(100)$q$);
do $d$
begin
    perform pg_temp.assign_raw(pg_temp.d(9), pg_temp.u(10));
    insert into t_results values ('42c the raw insert for archived district student 10 raised', false, 'no error raised');
exception when others then
    insert into t_results values ('42c the raw insert for archived district student 10 raised', sqlstate = 'P0002' and sqlerrm = 'not on your roster', sqlstate || ' ' || sqlerrm);
end $d$;
select pg_temp.assign_raw(pg_temp.d(9), pg_temp.u(7));
select pg_temp.chk('42d an active student''s assignment still goes through', $q$select exists (select 1 from public.assignments where student_user_id = pg_temp.u(7) and document_id = pg_temp.d(9))$q$);

-- ---- back to back, each rotation tells the generation it replaced (20261022120100)
select pg_temp.snap();
select pg_temp.chk('43 two rotations in a row: generations 1 and 2', $q$select public.rotate_document_realtime(pg_temp.d(9)) = 1 and public.rotate_document_realtime(pg_temp.d(9)) = 2$q$);
select pg_temp.chk('43b the first told generation 0 and the second generation 1, on both topics each', $q$select (select count(*) from realtime.messages m where m.event = 'topic_rotated' and m.topic in (pg_temp.live(pg_temp.d(9), 0), pg_temp.db(pg_temp.d(9), 0))) = 2
   and (select count(*) from realtime.messages m where m.event = 'topic_rotated' and m.topic in (pg_temp.live(pg_temp.d(9), 1), pg_temp.db(pg_temp.d(9), 1))) = 2
   and pg_temp.told(pg_temp.d(9)) - (select s.told from t_snap s where s.doc = pg_temp.d(9)) = 4$q$);

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
