-- Superseding a studio rotates the realtime of every score it takes from a
-- member (launch-fix follow-up 10, P4's superseded-studio rotation), against
-- a real database with Realtime running (today's realtime.messages
-- partition). LOCAL STACK or the dev branch project only.
--
-- P4 (#71) noted that 20261022100300 (one live studio per owner, P1 #69)
-- changes a studio's entitlement without the writes P4's rotation watches.
-- With both merged, superseding reaches it through 20261022100600: a member
-- left on a capped plan is archived past the cap (apply_free_tier_archival),
-- and archiving a score rotates it (20261022120100's
-- documents_rotate_on_archive), so the member's channels joined before are
-- told to move and the archived score admits no join. This proves it end to
-- end; no migration is needed. Nothing rotates where access did not shrink: a
-- member under the cap, and the scores a member keeps.
--
-- Runs in one transaction and ROLLS BACK; COMMIT's deferred rotation is run
-- by pg_temp.at_commit(), as tests/sql/realtime_revocation_rotation.sql does.
-- The last line is `failures | total`.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('05e10000-5aa0-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.s(n int) returns uuid language sql immutable as $f$ select ('05e1d000-5aa0-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
-- Score k of member n.
create function pg_temp.d(n int, k int) returns uuid language sql immutable as $f$ select ('05e1e000-5aa0-4000-' || lpad(n::text, 4, '0') || '-' || lpad(k::text, 12, '0'))::uuid $f$;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
create function pg_temp.as_user(n int) returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(n), 'role', 'authenticated', 'iat', floor(extract(epoch from now())) - 60)::text, true);
perform set_config('role', 'authenticated', true);
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
-- realtime.topic set (tests/sql/realtime_revocation_rotation.sql).
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
create function pg_temp.epoch(p_doc uuid) returns int language sql as $f$
    select coalesce((select e.epoch from public.document_realtime_epochs e where e.document_id = p_doc), 0)
$f$;
create function pg_temp.told(p_doc uuid) returns bigint language sql as $f$
    select count(*) from realtime.messages where event = 'topic_rotated' and payload ->> 'document_id' = p_doc::text
$f$;
create function pg_temp.live(p_doc uuid, p_epoch int) returns text language sql immutable as $f$
    select 'doc:' || p_doc::text || case when p_epoch = 0 then '' else ':' || p_epoch::text end
$f$;
create function pg_temp.db(p_doc uuid, p_epoch int) returns text language sql immutable as $f$
    select 'doc-db:' || p_doc::text || case when p_epoch = 0 then '' else ':' || p_epoch::text end
$f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- Owner 1 (Academy) with one live studio s1; members 10 (no plan of their own,
-- five scores: past the free cap of three once the seat goes) and 11 (two
-- scores: under it).
insert into auth.users (id, email)
select pg_temp.u(n), 'superseded-rotation-' || n || '@studios.test' from unnest(array[1, 10, 11]) n;

insert into public.subscriptions (stripe_subscription_id, user_id, tier, status, current_period_end, mode, collection_method)
values ('sub_ssr_o', pg_temp.u(1), 'academy', 'active', now() + interval '30 days', 'live', 'charge_automatically');

insert into public.studios (id, owner_id, name) values (pg_temp.s(1), pg_temp.u(1), 'Retired later');

insert into public.studio_members (studio_id, user_id) values (pg_temp.s(1), pg_temp.u(10)), (pg_temp.s(1), pg_temp.u(11));

insert into public.documents (id, owner_id, title, storage_path, updated_at)
select pg_temp.d(n, k), pg_temp.u(n), 'Score ' || k, pg_temp.d(n, k)::text || '/original.pdf', now() - k * interval '1 hour'
from (values (10, 5), (11, 2)) m(n, c), generate_series(1, c) k;

select pg_temp.chk('01 control: both members are seated (Academy), every score active at generation 0, joinable by its owner', $q$
    select public.resolve_entitlements (pg_temp.u(10)) ->> 'tier' = 'academy'
       and (select count(*) = 7 and bool_and(archived_at is null) from public.documents
            where owner_id in (pg_temp.u(10), pg_temp.u(11)))
       and pg_temp.epoch(pg_temp.d(10, 5)) = 0$q$);

select pg_temp.as_user(10);
select pg_temp.chk('02 control: 10 may join both topics of their oldest score before the studio goes', $q$
    select pg_temp.can_join(pg_temp.live(pg_temp.d(10, 5), 0)) and pg_temp.can_join(pg_temp.db(pg_temp.d(10, 5), 0))$q$);
select pg_temp.as_postgres();

-- ---- the studio is superseded (as 20261022100300 does to an owner's extras)
update public.studios set superseded_at = now() where id = pg_temp.s(1);
select pg_temp.at_commit();

select pg_temp.chk('10 10 drops to free and their two oldest scores are archived as plan_lapse', $q$
    select public.resolve_entitlements (pg_temp.u(10)) ->> 'tier' = 'free'
       and (select array_agg(id order by id) from public.documents
            where owner_id = pg_temp.u(10) and archived_reason = 'plan_lapse') = array[pg_temp.d(10, 4), pg_temp.d(10, 5)]$q$);

select pg_temp.chk('11 each archived score moved to its next topic generation, once', $q$
    select pg_temp.epoch(pg_temp.d(10, 4)) = 1 and pg_temp.epoch(pg_temp.d(10, 5)) = 1$q$);

select pg_temp.chk('12 ... and the channels joined before were told on both old topics', $q$
    select bool_and(exists (select 1 from realtime.messages m
                           where m.event = 'topic_rotated' and m.topic = pg_temp.live(doc, 0))
                and exists (select 1 from realtime.messages m
                           where m.event = 'topic_rotated' and m.topic = pg_temp.db(doc, 0))
                and pg_temp.told(doc) = 2)
    from unnest(array[pg_temp.d(10, 4), pg_temp.d(10, 5)]) doc$q$);

select pg_temp.as_user(10);
select pg_temp.chk('13 an archived score admits no join on either generation', $q$
    select not pg_temp.can_join(pg_temp.live(pg_temp.d(10, 5), 0)) and not pg_temp.can_join(pg_temp.live(pg_temp.d(10, 5), 1))
       and not pg_temp.can_join(pg_temp.db(pg_temp.d(10, 5), 1))$q$);
select pg_temp.chk('14 the scores 10 keeps are still joinable on generation 0', $q$
    select bool_and(pg_temp.can_join(pg_temp.live(doc, 0)) and pg_temp.can_join(pg_temp.db(doc, 0)))
    from unnest(array[pg_temp.d(10, 1), pg_temp.d(10, 2), pg_temp.d(10, 3)]) doc$q$);
select pg_temp.as_postgres();
select pg_temp.chk('14a ... and none of them was rotated or told', $q$
    select bool_and(pg_temp.epoch(doc) = 0 and pg_temp.told(doc) = 0)
    from unnest(array[pg_temp.d(10, 1), pg_temp.d(10, 2), pg_temp.d(10, 3)]) doc$q$);

select pg_temp.chk('15 11, free but under the cap, loses nothing and nothing of theirs rotates', $q$
    select (select count(*) = 2 and bool_and(archived_at is null) from public.documents where owner_id = pg_temp.u(11))
       and pg_temp.epoch(pg_temp.d(11, 1)) = 0 and pg_temp.epoch(pg_temp.d(11, 2)) = 0
       and pg_temp.told(pg_temp.d(11, 1)) = 0$q$);

select pg_temp.chk('16 the rotation queue is empty once its transaction''s rotation has run', $q$
    select not exists (select 1 from public.document_realtime_rotation_queue)$q$);

select name, ok, coalesce(detail, '') from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
