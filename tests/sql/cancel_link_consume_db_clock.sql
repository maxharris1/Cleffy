-- Behaviour proof for consume_cancel_link_token and the token guard's expiry
-- check (migration 20261020160700_cancel_link_consume_db_clock.sql; Codex
-- round 7 on #62, its major; decisions 38 and 39): a cancel link is spent
-- only while it is unused AND unexpired on the database's clock at the moment
-- it is spent, however long the spend waited, and a refusal says why.
--
-- Before 20261020160700 billing-cancel spent a link with an UPDATE that
-- checked only the hash and used_at: a link read as good just before its
-- expiry was still spent after it, and the spend authorizes the refund
-- request to support.
--
--   1. a link read as good, whose expiry passes while the spend waits on its
--      history lock (held as the tick holds it), is refused `expired` and
--      stays unused -- and with time left, the same wait still spends it;
--   2. the same while the spend waits on the token's row: the guard, reading
--      the clock after the wait, refuses it, and the function answers
--      `expired`;
--   3. read as good, then expired, then spent, in one transaction whose now()
--      is still before the expiry: refused `expired`, unused, and nothing is
--      written -- no outbox row, no token row changed; a good link is spent
--      once, on clock_timestamp(), then answered `used`; an unknown hash is
--      `not_found`;
--   4. the guard refuses a direct UPDATE spending an expired link, by the
--      service role or the table's owner, and lets one with time left through;
--   5. only the service role may call it; its search_path is pinned; it locks
--      before its one gated UPDATE.
--
-- Sections 1 and 2 need two sessions besides this one, so they run in dblink
-- sessions as postgres that commit their own rows (random hashes: tombstones
-- are permanent) and delete the account again at the end. Sections 3-5 run
-- inside this transaction and ROLL BACK. Run it against the LOCAL stack
-- (scripts/ci/sql-proof.sh does, in CI):
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/cancel_link_consume_db_clock.sql
--
-- The dblink sessions log in with the local stack's password; pass
-- -v peer_password=... for any other. Every row of the result table should
-- read `t`; the last line is `failures | total`.
\set ON_ERROR_STOP on
\if :{?peer_password}
\else
\set peer_password postgres
\endif
\o /dev/null
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create temp table t_ids (label text primary key, id uuid, claim uuid, hash text, answer text, error text);
grant all on t_ids to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('c05e0000-5ac0-4000-8000-00000000000' || n)::uuid $f$;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
create function pg_temp.refused(p_name text, p_sql text, p_state text, p_message text default null) returns void language plpgsql as $f$
declare v_state text; v_text text;
begin
execute p_sql;
insert into t_results values (p_name, false, 'no error raised');
exception when others then
get stacked diagnostics v_state = returned_sqlstate, v_text = message_text;
insert into t_results values (p_name, v_state = p_state and (p_message is null or strpos(v_text, p_message) > 0), v_state || ' ' || v_text);
end $f$;
create function pg_temp.as_role(p_role text) returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('role', p_role)::text, true);
perform set_config('role', p_role, true);
end $f$;
create function pg_temp.random_hash() returns text language sql volatile as $f$ select md5(random()::text) || md5(random()::text) $f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

create extension if not exists dblink with schema extensions;
create function pg_temp.peer() returns text language sql as $f$
    select format('host=%s port=%s dbname=%s user=postgres password=%s',
        host(inet_server_addr()), inet_server_port(), current_database(), current_setting('cancel_link_test.peer_password'))
$f$;
select set_config('cancel_link_test.peer_password', :'peer_password', true);
select extensions.dblink_connect('a', pg_temp.peer());
select extensions.dblink_connect('b', pg_temp.peer());
create function pg_temp.a(p_sql text) returns text language sql as $f$ select extensions.dblink_exec('a', p_sql) $f$;
create function pg_temp.b(p_sql text) returns text language sql as $f$ select extensions.dblink_exec('b', p_sql) $f$;
-- A one-value query in session `a`, outside this transaction: what is committed.
create function pg_temp.a_ok(p_sql text) returns boolean language sql as $f$
    select r.ok from extensions.dblink('a', p_sql) as r(ok boolean)
$f$;

select pg_temp.a($q$delete from public.billing_mail_outbox where payload->>'email' like '%@consume-race.test'$q$);
select pg_temp.a(format('delete from auth.users where id = %L', pg_temp.u(1)));
select pg_temp.a(format($q$insert into auth.users (id, email, is_anonymous) values (%L, 'race@consume-race.test', false)$q$, pg_temp.u(1)));

-- A committed cancel-link request, leased, and its link saved under a random
-- hash, an hour to run.
create function pg_temp.request(p_label text) returns void language plpgsql as $f$
declare v_id uuid; v_claim uuid; v_hash text := pg_temp.random_hash(); v_answer text;
begin
select r.id into v_id from extensions.dblink('a', $q$select public.enqueue_billing_mail ('cancel_link', null, 'test',
    jsonb_build_object('email', 'race@consume-race.test', 'origin', 'https://cleffy.io'))$q$) as r(id uuid);
select r.claim_token into v_claim from extensions.dblink('a', format($q$select o.claim_token
    from public.claim_billing_mail (50, interval '5 minutes') o where o.id = %L$q$, v_id)) as r(claim_token uuid);
select r.answer into v_answer from extensions.dblink('a', format($q$select public.save_cancel_link_token_v2 (%L, %L, %L, %L)->>'answer'$q$,
    v_id, v_claim, v_hash, pg_temp.u(1))) as r(answer text);
insert into t_ids (label, id, claim, hash, answer) values (p_label, v_id, v_claim, v_hash, v_answer);
end $f$;
-- The race: `a` takes p_hold and keeps its transaction open; `b`, as the
-- service role, spends the link meanwhile; after p_wait seconds `a` commits,
-- and `b` gets its answer. The link is first given at most p_left seconds to run (on
-- clock_timestamp()) and read as good, as the cancel page reads it.
create function pg_temp.race(p_label text, p_link text, p_left float, p_hold text, p_wait float) returns void language plpgsql as $f$
declare r record; v_pid int; v_answer text; v_error text;
begin
select * into r from t_ids where label = p_link;
perform pg_temp.a(format($q$update public.billing_cancel_tokens set expires_at = least(expires_at, clock_timestamp() + make_interval(secs => %s))
    where token_hash = %L$q$, p_left, r.hash));
insert into t_results values (p_label || 'a the link is read as good before the spend',
    pg_temp.a_ok(format($q$select public.read_cancel_link_token (%L) is not null$q$, r.hash)), null);
perform pg_temp.a('begin');
perform pg_temp.a(format(p_hold, r.id, r.hash));
perform pg_temp.b('set role service_role');
select x.pid into v_pid from extensions.dblink('b', 'select pg_backend_pid()') as x(pid int);
perform extensions.dblink_send_query('b', format($q$select public.consume_cancel_link_token (%L)->>'answer'$q$, r.hash));
perform pg_sleep(p_wait);
insert into t_results values (p_label || 'b the spend waits on a''s lock',
    extensions.dblink_is_busy('b') = 1 and exists (select 1 from pg_locks where pid = v_pid and not granted), null);
perform pg_temp.a('commit');
select x.answer into v_answer from extensions.dblink_get_result('b', false) as x(answer text);
v_error := extensions.dblink_error_message('b');
perform * from extensions.dblink_get_result('b', false) as x(answer text);
perform pg_temp.b('reset role');
insert into t_ids (label, answer, error) values (p_label, v_answer, v_error);
end $f$;

-- What the tick and every delete hold: the history locks, outbox id then hash.
\set hold_history 'do $d$ begin perform public.billing_cancel_link_lock (%L, %L); end $d$'
-- The token's row itself, as a concurrent writer would hold it.
\set hold_row 'do $d$ begin perform 1 from public.billing_cancel_tokens where outbox_id = %L and token_hash = %L for update; end $d$'

-- ===========================================================================
-- 1. Expired while the spend waits on the history lock
-- ===========================================================================
select pg_temp.request('wait1');
select pg_temp.request('wait1ok');
select pg_temp.request('wait2');
select pg_temp.chk('00 (three links saved, committed)',
$q$select count(*) = 3 and bool_and(answer = 'saved') from t_ids where label in ('wait1', 'wait1ok', 'wait2')$q$);
select pg_temp.race('1', 'wait1', 1.0, :'hold_history', 2.0);
select pg_temp.chk('1c the link that expired during the wait is refused: expired',
$q$select answer = 'expired' from t_ids where label = '1'$q$);
select pg_temp.chk('1d ... and stays unused',
$q$select pg_temp.a_ok(format('select used_at is null from public.billing_cancel_tokens where token_hash = %L', hash))
   from t_ids where label = 'wait1'$q$);
select pg_temp.race('1ok', 'wait1ok', 3600, :'hold_history', 1.0);
select pg_temp.chk('1e with its hour still running, the same wait spends it',
$q$select answer = 'consumed' from t_ids where label = '1ok'$q$);
select pg_temp.chk('1f ... used now, on the database''s clock',
$q$select pg_temp.a_ok(format('select used_at is not null and used_at < expires_at from public.billing_cancel_tokens where token_hash = %L', hash))
   from t_ids where label = 'wait1ok'$q$);

-- ===========================================================================
-- 2. Expired while the spend waits on the token's row
-- ===========================================================================
select pg_temp.race('2', 'wait2', 1.0, :'hold_row', 2.0);
select pg_temp.chk('2c refused once the row is free, its expiry read after the wait: expired',
$q$select answer = 'expired' and error = 'OK' from t_ids where label = '2'$q$);
select pg_temp.chk('2d ... and stays unused',
$q$select pg_temp.a_ok(format('select used_at is null from public.billing_cancel_tokens where token_hash = %L', hash))
   from t_ids where label = 'wait2'$q$);

select pg_temp.a(format('delete from public.billing_mail_outbox where id = any (%L::uuid[])',
    (select array_agg(id) from t_ids where id is not null)));
select pg_temp.a(format('delete from auth.users where id = %L', pg_temp.u(1)));
select pg_temp.chk('09 the race''s account, requests and links are gone again',
$q$select pg_temp.a_ok(format($s$select not exists (select 1 from auth.users where id = %L)
        and not exists (select 1 from public.billing_cancel_tokens where user_id = %L)
        and not exists (select 1 from public.billing_mail_outbox where id in (select unnest(%L::uuid[])))$s$,
        pg_temp.u(1), pg_temp.u(1), (select array_agg(id) from t_ids where id is not null)))$q$);
select extensions.dblink_disconnect('a');
select extensions.dblink_disconnect('b');

-- ===========================================================================
-- 3. The function's answers, in this transaction (rolled back)
-- ===========================================================================
insert into auth.users (id, email, is_anonymous) values (pg_temp.u(2), 'spender@consume-race.test', false);
update public.billing_mail_outbox set next_attempt_at = now() + interval '1 day' where status = 'pending';

select pg_temp.as_role('service_role');
insert into t_ids (label, id, hash)
select l, public.enqueue_billing_mail ('cancel_link', null, 'test', '{"email": "spender@consume-race.test", "origin": "https://cleffy.io"}'),
    pg_temp.random_hash()
from unnest(array['late', 'live', 'used', 'guard']) l;
update t_ids t set claim = c.claim_token
from public.claim_billing_mail (50, interval '2 minutes') c where c.id = t.id;
select pg_temp.chk('10 (four links saved)',
$q$select bool_and(public.save_cancel_link_token_v2 (id, claim, hash, pg_temp.u(2))->>'answer' = 'saved')
   from t_ids where label in ('late', 'live', 'used', 'guard')$q$);

-- Read as good, as the cancel page reads it; then brought forward to a moment
-- ago on the real clock. Inside this transaction now() is still before it,
-- so only clock_timestamp() can say it has passed.
select pg_temp.chk('11 the link is read as good',
$q$select public.read_cancel_link_token (hash) is not null from t_ids where label = 'late'$q$);
update public.billing_cancel_tokens set expires_at = clock_timestamp() + interval '200 milliseconds'
where token_hash = (select hash from t_ids where label = 'late');
select pg_sleep(0.4);
select pg_temp.chk('12 (its expiry is still ahead of this transaction''s now())',
$q$select expires_at > now() from public.billing_cancel_tokens where token_hash = (select hash from t_ids where label = 'late')$q$);
create temp table t_before as
select (select count(*) from public.billing_mail_outbox) as outbox,
       (select md5(string_agg(t::text, ',' order by t.token_hash)) from public.billing_cancel_tokens t) as tokens;
grant all on t_before to service_role;
select pg_temp.chk('13 spending it now is refused: expired',
$q$select public.consume_cancel_link_token (hash) = jsonb_build_object('answer', 'expired') from t_ids where label = 'late'$q$);
select pg_temp.chk('14 ... it stays unused',
$q$select used_at is null from public.billing_cancel_tokens where token_hash = (select hash from t_ids where label = 'late')$q$);
select pg_temp.chk('15 ... and the refusal wrote nothing: no outbox row (no refund request), no token changed',
$q$select (select count(*) from public.billing_mail_outbox) = b.outbox
      and (select md5(string_agg(t::text, ',' order by t.token_hash)) from public.billing_cancel_tokens t) = b.tokens
   from t_before b$q$);

select pg_temp.chk('16 a link with time left is spent, with its account and mode',
$q$with c as (update t_ids set answer = public.consume_cancel_link_token (hash)::text where label = 'live' returning answer::jsonb r)
   select r->>'answer' = 'consumed' and r->>'user_id' = pg_temp.u(2)::text and r->>'mode' = 'test' from c$q$);
select pg_temp.chk('17 ... at the used_at it answered, on clock_timestamp(), not the transaction''s now()',
$q$select t.used_at = (i.answer::jsonb->>'used_at')::timestamptz and t.used_at > now()
   from t_ids i join public.billing_cancel_tokens t on t.token_hash = i.hash where i.label = 'live'$q$);
create temp table t_spent as select used_at from public.billing_cancel_tokens where token_hash = (select hash from t_ids where label = 'live');
grant all on t_spent to service_role;
select pg_temp.chk('18 spending it again is refused: used, and its used_at stands',
$q$select public.consume_cancel_link_token (hash) = jsonb_build_object('answer', 'used')
      and (select used_at from public.billing_cancel_tokens where token_hash = i.hash) = (select used_at from t_spent)
   from t_ids i where label = 'live'$q$);
select pg_temp.chk('19 a hash nobody saved is refused: not_found',
$q$select public.consume_cancel_link_token (pg_temp.random_hash()) = jsonb_build_object('answer', 'not_found')$q$);
update public.billing_cancel_tokens set used_at = now() where token_hash = (select hash from t_ids where label = 'used');
update public.billing_cancel_tokens set expires_at = now() - interval '1 second' where token_hash = (select hash from t_ids where label = 'used');
select pg_temp.chk('20 a link both spent and expired is refused as used',
$q$select public.consume_cancel_link_token (hash) = jsonb_build_object('answer', 'used') from t_ids where label = 'used'$q$);

-- ===========================================================================
-- 4. The guard: no direct UPDATE spends an expired link
-- ===========================================================================
select pg_temp.refused('30 the service role cannot spend an expired link directly',
$q$update public.billing_cancel_tokens set used_at = now() where token_hash = (select hash from t_ids where label = 'late')$q$,
'55000', 'an expired cancel link cannot be spent');
reset role;
select pg_temp.refused('31 ... nor can the table''s owner',
$q$update public.billing_cancel_tokens set used_at = now() where token_hash = (select hash from t_ids where label = 'late')$q$,
'55000', 'an expired cancel link cannot be spent');
select pg_temp.as_role('service_role');
select pg_temp.refused('32 ... nor bring a link''s expiry forward and spend it in one update',
$q$update public.billing_cancel_tokens set expires_at = now() - interval '1 second', used_at = now()
   where token_hash = (select hash from t_ids where label = 'guard')$q$,
'55000', 'an expired cancel link cannot be spent');
select pg_temp.chk('33 a link with time left can still be spent directly (the guard refuses only the expired)',
$q$with spent as (update public.billing_cancel_tokens set used_at = now()
    where token_hash = (select hash from t_ids where label = 'guard') and used_at is null returning 1)
    select count(*) = 1 from spent$q$);
select pg_temp.chk('34 the expired link is still unused after all of that',
$q$select used_at is null from public.billing_cancel_tokens where token_hash = (select hash from t_ids where label = 'late')$q$);
reset role;
select pg_temp.chk('35 the guard reads the expiry on clock_timestamp()',
$q$select position('new.expires_at <= clock_timestamp()' in prosrc) > 0
   from pg_proc where oid = 'public.billing_cancel_tokens_lifetime()'::regprocedure$q$);

-- ===========================================================================
-- 5. The service role's alone, pinned, locked, one gated statement
-- ===========================================================================
select pg_temp.as_role('authenticated');
select pg_temp.refused('40 a signed-in client cannot call it',
$q$select public.consume_cancel_link_token (repeat('a', 64))$q$, '42501');
reset role;
select pg_temp.as_role('anon');
select pg_temp.refused('41 nor an anonymous one',
$q$select public.consume_cancel_link_token (repeat('a', 64))$q$, '42501');
reset role;
select pg_temp.chk('42 only the service role may: no PUBLIC, anon or authenticated EXECUTE',
$q$select has_function_privilege('service_role', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute')
      and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
   from pg_proc p where p.oid = 'public.consume_cancel_link_token(text)'::regprocedure$q$);
select pg_temp.chk('43 SECURITY DEFINER, with search_path pinned empty',
$q$select p.prosecdef and p.proconfig @> array['search_path=""']
   from pg_proc p where p.oid = 'public.consume_cancel_link_token(text)'::regprocedure$q$);
select pg_temp.chk('44 it takes the history locks (outbox id, then hash) before its one UPDATE, gated on clock_timestamp()',
$q$select position('public.billing_cancel_link_lock (v_outbox, p_hash)' in s) between 1 and position('update public.billing_cancel_tokens' in s)
      and s ~ 'set used_at = pg_catalog\.clock_timestamp\(\)\s+where t\.token_hash = p_hash\s+and t\.used_at is null\s+and t\.expires_at > pg_catalog\.clock_timestamp\(\)'
      and (length(s) - length(replace(s, 'update public.billing_cancel_tokens', ''))) / length('update public.billing_cancel_tokens') = 1
      and position('now()' in s) = 0
   from (select prosrc s from pg_proc where oid = 'public.consume_cancel_link_token(text)'::regprocedure) p$q$);

\o
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
