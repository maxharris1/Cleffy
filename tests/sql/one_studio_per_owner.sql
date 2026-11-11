-- Behaviour proof for 20261022100300_one_studio_per_owner.sql (launch re-audit
-- BL-4, Codex A1): one live studio per owner.
--
--   * Backfill: inside this transaction the trigger and index are removed and
--     owners with several studios are made, as a database from before the
--     migration could hold them; then the migration runs (`\ir`). An owner
--     keeps the studio a district is billed on (district_billing) or has its
--     seat count on (studio_seat_overrides) -- even over an older one -- else
--     the oldest; the others are marked superseded_at and logged with their
--     member count; nothing is deleted; a rerun changes nothing.
--   * A second live studio is refused with `studio_exists` -- for a signed-in
--     owner, for the server, and for a superseded studio brought back -- and
--     the partial unique index refuses it even with triggers off; a client
--     cannot set superseded_at.
--   * A superseded studio's members get no Academy entitlement from it, a seat
--     there past the limit is not read-only either, and it takes no new seats,
--     while the kept studio works as before.
--
-- Runs in one transaction and ROLLS BACK. psql only (it `\ir`s the migration):
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/one_studio_per_owner.sql
--
-- Every row should read `t`; the last line is `failures | total`.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('05e00000-5ac0-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.s(n int) returns uuid language sql immutable as $f$ select ('05e5d000-5ac0-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
-- Must fail with this SQLSTATE and, when given, this `code` in the error's
-- JSON detail.
create function pg_temp.refused(p_name text, p_sql text, p_state text, p_code text default null) returns void language plpgsql as $f$
declare v_state text; v_message text; v_detail text;
begin
execute p_sql;
insert into t_results values (p_name, false, 'no error raised');
exception when others then
get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail;
insert into t_results values (p_name,
    v_state = p_state and (p_code is null or (nullif(v_detail, '')::jsonb ->> 'code') is not distinct from p_code),
    v_state || ' ' || v_message || coalesce(' ' || nullif(v_detail, ''), ''));
end $f$;
create function pg_temp.as_user(n int) returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(n), 'role', 'authenticated')::text, true);
perform set_config('role', 'authenticated', true);
end $f$;
create function pg_temp.ent(n int) returns jsonb language sql as $f$ select public.resolve_entitlements (pg_temp.u(n)) $f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- ---- a database from before the migration
drop trigger studios_refuse_second_live on public.studios;
drop index public.studios_one_live_per_owner;

-- Owners: 1 A (three studios, the middle one a billed district), 2 B (two
-- plain studios), 3 C (one), 4 D (two, the newer one with a seat override),
-- 5 E (none yet). Members: 10-11 in A's oldest, 12-16 in A's newest (five:
-- one past the Academy limit), 20 in B's newer, 21 in B's older.
insert into auth.users (id, email)
select pg_temp.u(n), 'one-studio-' || n || '@studios.test'
from unnest(array[1, 2, 3, 4, 5, 10, 11, 12, 13, 14, 15, 16, 20, 21, 30]) n;

insert into public.subscriptions (stripe_subscription_id, user_id, tier, status, current_period_end, mode, collection_method) values
('sub_os_a', pg_temp.u(1), 'academy', 'active', now() + interval '30 days', 'live', 'charge_automatically'),
('sub_os_b', pg_temp.u(2), 'academy', 'active', now() + interval '30 days', 'live', 'charge_automatically'),
('sub_os_d', pg_temp.u(4), 'academy', 'active', now() + interval '30 days', 'live', 'send_invoice');

insert into public.studios (id, owner_id, name, created_at) values
(pg_temp.s(1), pg_temp.u(1), 'A oldest', now() - interval '3 days'),
(pg_temp.s(2), pg_temp.u(1), 'A district', now() - interval '2 days'),
(pg_temp.s(3), pg_temp.u(1), 'A newest', now() - interval '1 day'),
(pg_temp.s(4), pg_temp.u(2), 'B older', now() - interval '2 days'),
(pg_temp.s(5), pg_temp.u(2), 'B newer', now() - interval '1 day'),
(pg_temp.s(6), pg_temp.u(3), 'C only', now() - interval '1 day'),
(pg_temp.s(7), pg_temp.u(4), 'D older', now() - interval '2 days'),
(pg_temp.s(8), pg_temp.u(4), 'D override', now() - interval '1 day');

insert into public.district_billing (studio_id, updated_by) values (pg_temp.s(2), 'proof');
insert into public.studio_seat_overrides (studio_id, seat_limit, stripe_subscription_id, updated_by)
values (pg_temp.s(8), 10, 'sub_os_d', 'proof');

insert into public.studio_members (studio_id, user_id, created_at) values
(pg_temp.s(1), pg_temp.u(10), now() - interval '5 hours'),
(pg_temp.s(1), pg_temp.u(11), now() - interval '4 hours'),
(pg_temp.s(5), pg_temp.u(20), now() - interval '3 hours'),
(pg_temp.s(4), pg_temp.u(21), now() - interval '3 hours');
-- Five in one studio, past what the seat trigger allows: the state an
-- override that lapsed leaves behind.
set local session_replication_role = replica;
insert into public.studio_members (studio_id, user_id, created_at)
select pg_temp.s(3), pg_temp.u(n), now() - interval '1 hour' + n * interval '1 minute'
from unnest(array[12, 13, 14, 15, 16]) n;
set local session_replication_role = origin;

create temp table t_before as
select (select count(*) from public.studios) as studios, (select count(*) from public.studio_members) as members;

select pg_temp.chk('01 before: a member of B''s second studio resolves Academy through it', $q$select pg_temp.ent(20) ->> 'tier' = 'academy'$q$);
select pg_temp.chk('02 before: the fifth member of A''s newest studio is a read-only seat', $q$select (pg_temp.ent(16) ->> 'seat_read_only')::boolean$q$);

-- ---- the migration
\ir ../../supabase/migrations/20261022100300_one_studio_per_owner.sql

select pg_temp.chk('10 A keeps its district studio over an older one; the other two are superseded', $q$
    select (select superseded_at is null from public.studios where id = pg_temp.s(2))
       and (select superseded_at is not null from public.studios where id = pg_temp.s(1))
       and (select superseded_at is not null from public.studios where id = pg_temp.s(3))$q$);
select pg_temp.chk('11 B, with no district, keeps its oldest', $q$
    select (select superseded_at is null from public.studios where id = pg_temp.s(4))
       and (select superseded_at is not null from public.studios where id = pg_temp.s(5))$q$);
select pg_temp.chk('12 D keeps the studio with a seat override over an older one', $q$
    select (select superseded_at is null from public.studios where id = pg_temp.s(8))
       and (select superseded_at is not null from public.studios where id = pg_temp.s(7))$q$);
select pg_temp.chk('13 C''s only studio is untouched', $q$select superseded_at is null from public.studios where id = pg_temp.s(6)$q$);
select pg_temp.chk('14 nothing is deleted: every studio and every member is still there', $q$
    select (select count(*) from public.studios) = b.studios and (select count(*) from public.studio_members) = b.members
    from t_before b$q$);
select pg_temp.chk('15 each superseded studio is logged with its member count, the studio kept and why', $q$
    select array_agg(studio_id::text || ':' || member_count || ':' || kept_studio_id::text || ':' || reason order by studio_id) = array[
        pg_temp.s(1)::text || ':2:' || pg_temp.s(2)::text || ':kept the district studio',
        pg_temp.s(3)::text || ':5:' || pg_temp.s(2)::text || ':kept the district studio',
        pg_temp.s(5)::text || ':1:' || pg_temp.s(4)::text || ':kept the oldest studio',
        pg_temp.s(7)::text || ':0:' || pg_temp.s(8)::text || ':kept the district studio']
    from public.studio_supersede_log
    where owner_id in (pg_temp.u(1), pg_temp.u(2), pg_temp.u(3), pg_temp.u(4))$q$);
select pg_temp.chk('16 every owner now has exactly one live studio', $q$
    select bool_and(n = 1) from (select count(*) n from public.studios where superseded_at is null group by owner_id) x$q$);

create temp table t_superseded as select id, superseded_at from public.studios where superseded_at is not null;
create temp table t_log_rows as select count(*) as n from public.studio_supersede_log;

\ir ../../supabase/migrations/20261022100300_one_studio_per_owner.sql

select pg_temp.chk('20 a rerun supersedes nothing more and logs nothing', $q$
    select (select count(*) from public.studio_supersede_log) = (select n from t_log_rows)
       and not exists (
           (select id, superseded_at from public.studios where superseded_at is not null)
           except (select id, superseded_at from t_superseded))$q$);
select pg_temp.chk('21 the partial unique index is back, once', $q$
    select count(*) = 1 and bool_and(i.indisunique) and bool_and(pg_get_expr(i.indpred, i.indrelid) ilike '%superseded_at IS NULL%')
    from pg_index i where i.indexrelid = 'public.studios_one_live_per_owner'::regclass$q$);
select pg_temp.chk('22 the log is the service role''s alone', $q$
    select has_table_privilege('service_role', 'public.studio_supersede_log', 'SELECT, INSERT')
       and not has_table_privilege('authenticated', 'public.studio_supersede_log', 'SELECT, INSERT, UPDATE, DELETE')
       and not has_table_privilege('anon', 'public.studio_supersede_log', 'SELECT, INSERT, UPDATE, DELETE')
       and (select relrowsecurity from pg_class where oid = 'public.studio_supersede_log'::regclass)$q$);

-- ---- entitlements
select pg_temp.chk('30 a member of B''s superseded studio gets no Academy from it: free, no seat', $q$
    select e ->> 'tier' = 'free' and e ->> 'source' = 'none' and not (e ->> 'seat_read_only')::boolean
    from pg_temp.ent(20) e$q$);
select pg_temp.chk('31 a member of B''s kept studio keeps Academy', $q$select pg_temp.ent(21) ->> 'tier' = 'academy'$q$);
select pg_temp.chk('32 the members of A''s superseded studios get nothing from them', $q$
    select bool_and(pg_temp.ent(n) ->> 'tier' = 'free') from unnest(array[10, 11, 12, 13, 14, 15]) n$q$);
select pg_temp.chk('33 ... and a seat past the limit there is no longer read-only', $q$
    select e ->> 'tier' = 'free' and not (e ->> 'seat_read_only')::boolean from pg_temp.ent(16) e$q$);
select pg_temp.chk('34 the owners'' own subscriptions are untouched', $q$
    select pg_temp.ent(1) ->> 'tier' = 'academy' and pg_temp.ent(2) ->> 'tier' = 'academy'$q$);
select pg_temp.chk('35 seat_read_only() agrees for a superseded studio''s member', $q$select not public.seat_read_only (pg_temp.u(16))$q$);

-- ---- a second live studio
select pg_temp.as_user(3);
select pg_temp.refused('40 an owner cannot create a second academy: studio_exists', $q$
    insert into public.studios (id, owner_id, name) values (pg_temp.s(20), pg_temp.u(3), 'C second')$q$, 'P0001', 'studio_exists');
select pg_temp.refused('41 ... nor set superseded_at themselves', $q$
    insert into public.studios (id, owner_id, name, superseded_at) values (pg_temp.s(21), pg_temp.u(3), 'C x', now())$q$, '42501');
reset role;
select pg_temp.as_user(5);
select pg_temp.chk('42 an owner with no academy creates one', $q$with ins as (
    insert into public.studios (id, owner_id, name) values (pg_temp.s(22), pg_temp.u(5), 'E first') returning 1)
    select count(*) = 1 from ins$q$);
select pg_temp.refused('43 ... and not a second', $q$
    insert into public.studios (id, owner_id, name) values (pg_temp.s(23), pg_temp.u(5), 'E second')$q$, 'P0001', 'studio_exists');
reset role;
select pg_temp.refused('44 the server is refused a second live studio too', $q$
    insert into public.studios (id, owner_id, name) values (pg_temp.s(24), pg_temp.u(3), 'C by server')$q$, 'P0001', 'studio_exists');
select pg_temp.refused('45 a superseded studio cannot be brought back beside the live one', $q$
    update public.studios set superseded_at = null where id = pg_temp.s(1)$q$, 'P0001', 'studio_exists');
select pg_temp.refused('46 a studio cannot be handed to an owner who has one', $q$
    update public.studios set owner_id = pg_temp.u(3) where id = pg_temp.s(22)$q$, 'P0001', 'studio_exists');
set local session_replication_role = replica;
select pg_temp.refused('47 with triggers off, the unique index alone refuses it', $q$
    insert into public.studios (id, owner_id, name) values (pg_temp.s(25), pg_temp.u(3), 'C raw')$q$, '23505');
set local session_replication_role = origin;
select pg_temp.chk('48 the server may still record a superseded studio', $q$with ins as (
    insert into public.studios (id, owner_id, name, superseded_at) values (pg_temp.s(26), pg_temp.u(3), 'C old', now()) returning 1)
    select count(*) = 1 from ins$q$);

-- ---- invites
select pg_temp.as_user(2);
select pg_temp.refused('50 a superseded studio takes no new seats', $q$
    select public.studio_invite_member (pg_temp.s(5), 'one-studio-30@studios.test')$q$, '42501', 'studio_superseded');
select pg_temp.chk('51 the kept studio still seats a teacher', $q$
    select public.studio_invite_member (pg_temp.s(4), 'one-studio-30@studios.test') = pg_temp.u(30)$q$);
reset role;
select pg_temp.chk('52 ... who resolves Academy', $q$select pg_temp.ent(30) ->> 'tier' = 'academy'$q$);

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
