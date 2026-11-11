-- Behaviour proof for 20261022100600_superseded_studio_followups.sql (Codex
-- round 1 on #69, MAJOR 1 and 2): what superseding a studio leaves behind.
--
--   * Scores. Inside this transaction the database is put back to before
--     20261022100300 (its trigger and index, and 20261022100600's trigger,
--     removed) with an owner holding two studios. 20261022100300 alone leaves
--     a member who drops to free with every active score; 20261022100600 then
--     archives past the free cap, as 'plan_lapse', deleting nothing, and skips
--     every member still entitled -- through their own plan, a seat in another
--     owner's live studio, or a seat in the owner's kept studio. A rerun
--     changes nothing. A studio superseded later is followed by the trigger,
--     and one brought back gets its members' scores back.
--   * Live ink. In the last minutes of the owner's grace, a member whose only
--     membership is in the retired studio is no longer refused broadcast on
--     their own score (the 20261020181100 reading would have refused it),
--     while a member of the owner's live studio still is.
--
-- Runs in one transaction and ROLLS BACK. psql only (it `\ir`s the migrations):
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/superseded_studio_members.sql
--
-- Every row should read `t`; the last line is `failures | total`.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create temp table t_fixtures (k text primary key, v text);
grant all on t_fixtures to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('05e00000-5aa0-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.s(n int) returns uuid language sql immutable as $f$ select ('05e5d000-5aa0-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
-- Score k of member n.
create function pg_temp.d(n int, k int) returns uuid language sql immutable as $f$ select ('05ed0000-5aa0-4000-' || lpad(n::text, 4, '0') || '-' || lpad(k::text, 12, '0'))::uuid $f$;
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
create function pg_temp.allowed(p_name text, p_sql text) returns void language plpgsql as $f$
begin
execute p_sql;
insert into t_results values (p_name, true, null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
-- A signed-in member whose access token expires at p_exp, on a realtime topic.
create function pg_temp.as_user_until(n int, p_exp timestamptz, p_topic text) returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(n), 'role', 'authenticated',
    'exp', extract(epoch from p_exp)::bigint)::text, true);
perform set_config('role', 'authenticated', true);
perform set_config('realtime.topic', p_topic, true);
end $f$;
create function pg_temp.as_server() returns void language plpgsql as $f$
begin
perform set_config('role', 'postgres', true);
perform set_config('request.jwt.claims', '', true);
end $f$;
create function pg_temp.active(n int) returns bigint language sql as $f$
    select count(*) from public.documents where owner_id = pg_temp.u(n) and archived_at is null $f$;
create function pg_temp.lapsed(n int) returns bigint language sql as $f$
    select count(*) from public.documents where owner_id = pg_temp.u(n) and archived_reason = 'plan_lapse' $f$;
create function pg_temp.scores(n int) returns bigint language sql as $f$
    select count(*) from public.documents where owner_id = pg_temp.u(n) $f$;
-- 20261020181100's seat_grace_deadline(), verbatim, for the "before" reading.
create function pg_temp.old_seat_grace_deadline(p_user uuid) returns timestamptz language plpgsql stable as $f$
begin
    if p_user is null or not exists (select 1 from public.studio_members sm where sm.user_id = p_user) then
        return null;
    end if;
    return (
        select min(public.district_grace_ends_at (s.stripe_subscription_id, s.past_due_since))
        from public.subscriptions s
        where s.status = 'past_due'
          and (
              s.user_id = p_user
              or s.user_id in (
                  select st.owner_id
                  from public.studio_members sm
                  join public.studios st on st.id = sm.studio_id
                  where sm.user_id = p_user
              )
          )
          and public.subscription_is_live (s)
    );
end $f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- ---- a database from before 20261022100300
drop trigger studios_refuse_second_live on public.studios;
drop trigger studios_follow_superseded on public.studios;
drop index public.studios_one_live_per_owner;

-- Owners: 1 O (two studios: s1 older, kept; s2 newer, superseded), 2 P (one
-- studio, s3), 3 Q (one studio, s4, superseded by hand later).
-- Members of O's s2: 10 (nothing else: drops to free), 11 (also seated in P's
-- s3), 12 (a Teacher plan of their own), 13 (also seated in O's s1), 14
-- (nothing else, but under the free cap), 16 (nothing else; live-ink case).
-- 17 is seated in O's s1 only (live-ink control); 15 in Q's s4 only.
insert into auth.users (id, email)
select pg_temp.u(n), 'superseded-members-' || n || '@studios.test'
from unnest(array[1, 2, 3, 10, 11, 12, 13, 14, 15, 16, 17]) n;

insert into public.subscriptions (stripe_subscription_id, user_id, tier, status, current_period_end, mode, collection_method) values
('sub_ssm_o', pg_temp.u(1), 'academy', 'active', now() + interval '30 days', 'live', 'charge_automatically'),
('sub_ssm_p', pg_temp.u(2), 'academy', 'active', now() + interval '30 days', 'live', 'charge_automatically'),
('sub_ssm_q', pg_temp.u(3), 'academy', 'active', now() + interval '30 days', 'live', 'charge_automatically'),
('sub_ssm_12', pg_temp.u(12), 'teacher', 'active', now() + interval '30 days', 'live', 'charge_automatically');

insert into public.studios (id, owner_id, name, created_at) values
(pg_temp.s(1), pg_temp.u(1), 'O kept', now() - interval '2 days'),
(pg_temp.s(2), pg_temp.u(1), 'O retired', now() - interval '1 day'),
(pg_temp.s(3), pg_temp.u(2), 'P only', now() - interval '1 day'),
(pg_temp.s(4), pg_temp.u(3), 'Q only', now() - interval '1 day');

insert into public.studio_members (studio_id, user_id) values
(pg_temp.s(3), pg_temp.u(11)), (pg_temp.s(1), pg_temp.u(13)), (pg_temp.s(1), pg_temp.u(17)),
(pg_temp.s(4), pg_temp.u(15));
-- Six in O's retired studio, past what the seat trigger allows (the state an
-- override that lapsed leaves behind): 14 and 16, seated last, were read-only
-- there before it was retired.
set local session_replication_role = replica;
insert into public.studio_members (studio_id, user_id, created_at)
select pg_temp.s(2), pg_temp.u(n), now() - interval '1 hour' + i * interval '1 minute'
from unnest(array[10, 11, 12, 13, 14, 16]) with ordinality as m(n, i);
set local session_replication_role = origin;

-- Five active scores each (two for 14, four for 15), with
-- distinct updated_at so the kept three are known: the most recently updated.
-- Triggers off: 14 is a read-only seat until the migration runs, and the cap
-- would refuse it.
set local session_replication_role = replica;
insert into public.documents (id, owner_id, title, storage_path, updated_at)
select pg_temp.d(n, k), pg_temp.u(n), 'Score ' || k, pg_temp.d(n, k)::text || '/original.pdf', now() - k * interval '1 hour'
from unnest(array[10, 11, 12, 13]) n, generate_series(1, 5) k
union all
select pg_temp.d(14, k), pg_temp.u(14), 'Score ' || k, pg_temp.d(14, k)::text || '/original.pdf', now() - k * interval '1 hour'
from generate_series(1, 2) k
union all
select pg_temp.d(15, k), pg_temp.u(15), 'Score ' || k, pg_temp.d(15, k)::text || '/original.pdf', now() - k * interval '1 hour'
from generate_series(1, 4) k
;
set local session_replication_role = origin;

select pg_temp.chk('01 before: 10 resolves Academy through O''s second studio, with five active scores', $q$
    select public.resolve_entitlements (pg_temp.u(10)) ->> 'tier' = 'academy' and pg_temp.active(10) = 5$q$);

-- ---- 20261022100300 alone: the gap Codex found
\ir ../../supabase/migrations/20261022100300_one_studio_per_owner.sql

select pg_temp.chk('02 20261022100300 alone: O''s newer studio is superseded and 10 resolves free...', $q$
    select (select superseded_at is not null from public.studios where id = pg_temp.s(2))
       and public.resolve_entitlements (pg_temp.u(10)) ->> 'tier' = 'free'$q$);
select pg_temp.chk('03 ... yet 10 still has all five scores active, past the free cap of three', $q$
    select pg_temp.active(10) = 5 and (public.tier_limits ('free') ->> 'cloud_scores')::int = 3$q$);

-- ---- 20261022100600
\ir ../../supabase/migrations/20261022100600_superseded_studio_followups.sql

select pg_temp.chk('10 10, now free, keeps their three most recently updated scores active', $q$
    select array_agg(id order by id) = array[pg_temp.d(10, 1), pg_temp.d(10, 2), pg_temp.d(10, 3)]
    from public.documents where owner_id = pg_temp.u(10) and archived_at is null$q$);
select pg_temp.chk('11 ... and the other two are archived as plan_lapse, not deleted', $q$
    select pg_temp.lapsed(10) = 2 and pg_temp.scores(10) = 5$q$);
select pg_temp.chk('12 11, still seated in another owner''s live studio, is skipped: Academy, five active', $q$
    select public.resolve_entitlements (pg_temp.u(11)) ->> 'tier' = 'academy' and pg_temp.active(11) = 5 and pg_temp.lapsed(11) = 0$q$);
select pg_temp.chk('13 12, on a Teacher plan of their own, is skipped: five active', $q$
    select public.resolve_entitlements (pg_temp.u(12)) ->> 'tier' = 'teacher' and pg_temp.active(12) = 5 and pg_temp.lapsed(12) = 0$q$);
select pg_temp.chk('14 13, also seated in O''s kept studio, is skipped: Academy, five active', $q$
    select public.resolve_entitlements (pg_temp.u(13)) ->> 'tier' = 'academy' and pg_temp.active(13) = 5 and pg_temp.lapsed(13) = 0$q$);
select pg_temp.chk('15 14, free but under the cap, loses nothing', $q$
    select public.resolve_entitlements (pg_temp.u(14)) ->> 'tier' = 'free' and pg_temp.active(14) = 2 and pg_temp.lapsed(14) = 0$q$);
select pg_temp.chk('16 the member rows are all still there', $q$
    select count(*) = 10 from public.studio_members where user_id in (
        select pg_temp.u(n) from unnest(array[10, 11, 12, 13, 14, 15, 16, 17]) n)$q$);
select pg_temp.refused('17 10 cannot bring an archived score back past the cap (limit_reached)', $q$
    update public.documents set archived_at = null, archived_reason = null where id = pg_temp.d(10, 4)$q$, 'P0001');

create temp table t_docs as select id, archived_at, archived_reason from public.documents
where owner_id in (select pg_temp.u(n) from unnest(array[10, 11, 12, 13, 14, 15, 16, 17]) n);

\ir ../../supabase/migrations/20261022100600_superseded_studio_followups.sql

select pg_temp.chk('20 a rerun archives nothing more and restores nothing', $q$
    select not exists (
        (select id, archived_at, archived_reason from public.documents
         where owner_id in (select pg_temp.u(n) from unnest(array[10, 11, 12, 13, 14, 15, 16, 17]) n))
        except (select * from t_docs))
       and (select count(*) from t_docs) = (select count(*) from public.documents
         where owner_id in (select pg_temp.u(n) from unnest(array[10, 11, 12, 13, 14, 15, 16, 17]) n))$q$);
select pg_temp.chk('21 the follow function and its trigger are the service''s alone', $q$
    select has_function_privilege('service_role', 'public.superseded_studio_member_follow(uuid)', 'EXECUTE')
       and not has_function_privilege('authenticated', 'public.superseded_studio_member_follow(uuid)', 'EXECUTE')
       and not has_function_privilege('anon', 'public.superseded_studio_member_follow(uuid)', 'EXECUTE')
       and not has_function_privilege('authenticated', 'public.studios_follow_superseded()', 'EXECUTE')
       and (select count(*) = 1 from pg_trigger where tgname = 'studios_follow_superseded' and not tgisinternal)$q$);

-- ---- superseded later, and brought back
update public.studios set superseded_at = now() where id = pg_temp.s(4);

select pg_temp.chk('30 a studio superseded later: its free member is archived down to three by the trigger', $q$
    select public.resolve_entitlements (pg_temp.u(15)) ->> 'tier' = 'free' and pg_temp.active(15) = 3 and pg_temp.lapsed(15) = 1$q$);

update public.studios set superseded_at = null where id = pg_temp.s(4);

select pg_temp.chk('31 brought back, the seat entitles again and the archived score is restored', $q$
    select public.resolve_entitlements (pg_temp.u(15)) ->> 'tier' = 'academy' and pg_temp.active(15) = 4 and pg_temp.lapsed(15) = 0$q$);

-- ---- live ink in the last minutes of O's grace
-- O's subscription is past due on the clock, its 30-day grace ending in twenty
-- minutes; every trigger off, as the district proofs move the clock.
set local session_replication_role = replica;
update public.subscriptions
set status = 'past_due', past_due_since = now() - interval '30 days' + interval '20 minutes'
where stripe_subscription_id = 'sub_ssm_o';
set local session_replication_role = origin;

-- A message timestamp inside a realtime.messages partition that exists (see
-- district_read_only_seats.sql).
insert into t_fixtures
select 'msg_at', coalesce(
    (select now()::timestamp
     where exists (
         select 1 from pg_class
         where relnamespace = 'realtime'::regnamespace and relname = 'messages_' || to_char(now(), 'YYYY_MM_DD')
     )),
    (select to_timestamp(substr(max(relname), 10), 'YYYY_MM_DD')::timestamp + interval '12 hours'
     from pg_class
     where relnamespace = 'realtime'::regnamespace
       and relkind = 'r'
       and relname ~ '^messages_[0-9]{4}_[0-9]{2}_[0-9]{2}$')
)::text;
-- 16 and 17 each make a score of their own (triggers on: the owner's
-- document_members row comes with it).
insert into public.documents (id, owner_id, title, storage_path)
select pg_temp.d(n, 1), pg_temp.u(n), 'Own score', pg_temp.d(n, 1)::text || '/original.pdf'
from unnest(array[16, 17]) n;

insert into t_fixtures values
('topic_16', public.document_live_topic (pg_temp.d(16, 1))),
('topic_17', public.document_live_topic (pg_temp.d(17, 1)));

select pg_temp.chk('40 the 20261020181100 reading would give 16, a member of O''s retired studio only, O''s deadline', $q$
    select pg_temp.old_seat_grace_deadline (pg_temp.u(16)) is not null
       and pg_temp.old_seat_grace_deadline (pg_temp.u(16)) < now() + interval '1 hour'$q$);
select pg_temp.chk('41 now the retired membership gives 16 no deadline at all', $q$
    select public.seat_grace_deadline (pg_temp.u(16)) is null$q$);
select pg_temp.chk('42 ... while 17, seated in O''s live studio, still has it', $q$
    select public.seat_grace_deadline (pg_temp.u(17)) < now() + interval '1 hour'$q$);

select pg_temp.as_user_until(16, now() + interval '1 hour', (select v from t_fixtures where k = 'topic_16'));
select pg_temp.allowed('43 16''s live-ink join on their own score, token outliving O''s deadline, is admitted', $q$
    insert into realtime.messages (topic, extension, event, payload, private, inserted_at)
    values ((select v from t_fixtures where k = 'topic_16'), 'broadcast', 'ink:progress', '{}', true,
            (select v::timestamp from t_fixtures where k = 'msg_at'))$q$);
select pg_temp.as_server();

select pg_temp.as_user_until(17, now() + interval '1 hour', (select v from t_fixtures where k = 'topic_17'));
select pg_temp.refused('44 the same join by 17, a member of O''s live studio, is still refused', $q$
    insert into realtime.messages (topic, extension, event, payload, private, inserted_at)
    values ((select v from t_fixtures where k = 'topic_17'), 'broadcast', 'ink:progress', '{}', true,
            (select v::timestamp from t_fixtures where k = 'msg_at'))$q$, '42501');
select pg_temp.as_server();

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
