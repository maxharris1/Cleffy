-- Behaviour proof for read_cancel_link_token (migration
-- 20261020160600_cancel_link_serialized_history.sql; Codex round 6 on #62,
-- the round-5 major 2 still open; decisions 30 and 34): whether a cancel link
-- still works is decided by the database, on clock_timestamp(), not by the
-- edge function's clock.
--
--   1. a saved, unused link with time left is answered with its account and
--      mode, nothing else;
--   2. one whose expiry has passed on the database's clock is not, however
--      little ago -- clock_timestamp(), not the transaction's now();
--   3. a used one is not; an unknown hash is not;
--   4. only the service role may ask.
--
-- Everything runs inside one transaction and ROLLS BACK. Run it against the
-- LOCAL stack (scripts/ci/sql-proof.sh does, in CI):
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/cancel_link_read_db_clock.sql
--
-- Every row of the result table should read `t`; the last line is
-- `failures | total`.
\set ON_ERROR_STOP on
\o /dev/null
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create temp table t_ids (label text primary key, id uuid, claim uuid, hash text);
grant all on t_ids to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('4ead0000-5ac0-4000-8000-00000000000' || n)::uuid $f$;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
create function pg_temp.refused(p_name text, p_sql text, p_state text) returns void language plpgsql as $f$
declare v_state text; v_text text;
begin
execute p_sql;
insert into t_results values (p_name, false, 'no error raised');
exception when others then
get stacked diagnostics v_state = returned_sqlstate, v_text = message_text;
insert into t_results values (p_name, v_state = p_state, v_state || ' ' || v_text);
end $f$;
create function pg_temp.as_role(p_role text) returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('role', p_role)::text, true);
perform set_config('role', p_role, true);
end $f$;
create function pg_temp.random_hash() returns text language sql volatile as $f$ select md5(random()::text) || md5(random()::text) $f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

insert into auth.users (id, email, is_anonymous) values (pg_temp.u(1), 'reader@cancellink.test', false);
update public.billing_mail_outbox set next_attempt_at = now() + interval '1 day' where status = 'pending';

select pg_temp.as_role('service_role');
insert into t_ids (label, id, hash)
select l, public.enqueue_billing_mail ('cancel_link', null, 'test', '{"email": "reader@cancellink.test", "origin": "https://cleffy.io"}'),
    pg_temp.random_hash()
from unnest(array['live', 'late', 'used']) l;
update t_ids t set claim = c.claim_token
from public.claim_billing_mail (50, interval '2 minutes') c where c.id = t.id;
select pg_temp.chk('00 (three links saved)',
$q$select bool_and(public.save_cancel_link_token_v2 (id, claim, hash, pg_temp.u(1))->>'answer' = 'saved') from t_ids$q$);

-- ===========================================================================
-- 1-3. The database's answer
-- ===========================================================================
select pg_temp.chk('01 a link with time left is answered with its account and mode, and nothing else',
$q$select public.read_cancel_link_token (hash) = jsonb_build_object('user_id', pg_temp.u(1), 'mode', 'test')
   from t_ids where label = 'live'$q$);
-- Brought forward to a moment ago on the real clock: inside this transaction
-- now() is still before it, so only clock_timestamp() can say it has passed.
update public.billing_cancel_tokens set expires_at = clock_timestamp() + interval '200 milliseconds'
where token_hash = (select hash from t_ids where label = 'late');
select pg_sleep(0.4);
select pg_temp.chk('02 (its expiry is still ahead of this transaction''s now())',
$q$select expires_at > now() from public.billing_cancel_tokens where token_hash = (select hash from t_ids where label = 'late')$q$);
select pg_temp.chk('03 a link whose expiry has passed on the database''s clock is not answered',
$q$select public.read_cancel_link_token (hash) is null from t_ids where label = 'late'$q$);
update public.billing_cancel_tokens set used_at = now() where token_hash = (select hash from t_ids where label = 'used');
select pg_temp.chk('04 a used link is not answered',
$q$select public.read_cancel_link_token (hash) is null from t_ids where label = 'used'$q$);
select pg_temp.chk('05 nor a hash nobody saved',
$q$select public.read_cancel_link_token (pg_temp.random_hash()) is null$q$);
reset role;
select pg_temp.chk('06 it reads the expiry on clock_timestamp(), never now()',
$q$select position('t.expires_at > pg_catalog.clock_timestamp()' in s) > 0 and position('now()' in s) = 0
   from (select prosrc s from pg_proc where oid = 'public.read_cancel_link_token(text)'::regprocedure) p$q$);

-- ===========================================================================
-- 4. The service role's alone
-- ===========================================================================
select pg_temp.as_role('authenticated');
select pg_temp.refused('10 a signed-in client cannot ask',
$q$select public.read_cancel_link_token (repeat('a', 64))$q$, '42501');
reset role;
select pg_temp.as_role('anon');
select pg_temp.refused('11 nor an anonymous one',
$q$select public.read_cancel_link_token (repeat('a', 64))$q$, '42501');
reset role;
select pg_temp.chk('12 the service role may, with search_path pinned',
$q$select has_function_privilege('service_role', p.oid, 'execute') and p.proconfig @> array['search_path=""']
   from pg_proc p where p.oid = 'public.read_cancel_link_token(text)'::regprocedure$q$);

\o
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
