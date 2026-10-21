-- Behaviour proof for 20261020160400_cancel_link_tombstones_db_clock.sql and
-- 20261020160500_cancel_link_save_replayable.sql (save_cancel_link_token_v2), the
-- clock half (Codex round 5 on #62, new major 2; decision 30): whether a
-- cancel link can still be sent is decided on the database's clock, read
-- AFTER the row lock is held, with 120 seconds to spare -- and the time left
-- is handed back for the edge function's final send decision.
--
--   1. a link with less than 120 s left is refused and its row settled
--      `expired`, without its address; with more, it is saved and the answer
--      says how many seconds remain, counted on the database's clock;
--   2. a save whose transaction started before the expiry, and which waited
--      on the row's lock until after it, is refused (transaction-start now()
--      would still have said "not yet");
--   3. likewise a save that waited on the lock from 122 s left to under 120.
--
-- Section 1 runs in this transaction and ROLLS BACK. Sections 2-3 need a
-- second session holding the lock, so they use two dblink sessions as
-- postgres, commit their own rows (random ids and hashes) and delete them
-- again at the end. Run it against the LOCAL stack (scripts/ci/sql-proof.sh
-- does, in CI):
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/cancel_link_db_clock.sql
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
create temp table t_ids (label text primary key, id uuid, claim uuid, hash text, answer jsonb);
grant all on t_ids to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('c10c0000-5ac0-4000-8000-00000000000' || n)::uuid $f$;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
create function pg_temp.as_service() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
perform set_config('role', 'service_role', true);
end $f$;
-- save_cancel_link_token_v2's answer, kept on the row's t_ids entry.
create function pg_temp.save(p_label text) returns void language plpgsql as $f$
declare v jsonb;
begin
execute 'select to_jsonb(public.save_cancel_link_token_v2 ($1, $2, $3, $4))'
    into v using (select id from t_ids where label = p_label), (select claim from t_ids where label = p_label),
    (select hash from t_ids where label = p_label), pg_temp.u(1);
update t_ids set answer = v where label = p_label;
end $f$;
-- A random SHA-256-shaped hash: committed tokens leave permanent tombstones,
-- so no two runs may share one.
create function pg_temp.random_hash() returns text language sql volatile as $f$ select md5(random()::text) || md5(random()::text) $f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

insert into auth.users (id, email, is_anonymous) values (pg_temp.u(1), 'clock@cancellink.test', false);
update public.billing_mail_outbox set next_attempt_at = now() + interval '1 day' where status = 'pending';

-- ===========================================================================
-- 1. 120 seconds to spare, on the database's clock
-- ===========================================================================
select pg_temp.as_service();
insert into t_ids (label, id, hash)
select l, public.enqueue_billing_mail ('cancel_link', null, 'test', '{"email": "clock@cancellink.test", "origin": "https://cleffy.io"}'),
    pg_temp.random_hash()
from unnest(array['short', 'ten', 'hour', 'legacy']) l;
update t_ids t set claim = c.claim_token
from public.claim_billing_mail (50, interval '2 minutes') c where c.id = t.id;
-- Brought forward (the one move an expiry allows), from the real clock:
-- now() is fixed inside this transaction.
update public.billing_mail_outbox set link_expires_at = clock_timestamp() + interval '119 seconds'
where id = (select id from t_ids where label = 'short');
update public.billing_mail_outbox set link_expires_at = clock_timestamp() + interval '600 seconds'
where id = (select id from t_ids where label = 'ten');
update public.billing_mail_outbox set link_expires_at = clock_timestamp() + interval '119 seconds'
where id = (select id from t_ids where label = 'legacy');
select pg_temp.save('short');
select pg_temp.save('ten');
select pg_temp.save('hour');

select pg_temp.chk('01 a link with 119 s left is refused as expired',
$q$select answer->>'answer' = 'expired' and (answer->>'remaining_seconds')::int between 0 and 119
   from t_ids where label = 'short'$q$);
select pg_temp.chk('02 ... saves nothing',
$q$select not exists (select 1 from public.billing_cancel_tokens where token_hash = (select hash from t_ids where label = 'short'))$q$);
select pg_temp.chk('03 ... and is settled expired there and then, without its address',
$q$select status = 'expired' and not (payload ? 'email') and last_error = 'expired before delivery'
   from public.billing_mail_outbox where id = (select id from t_ids where label = 'short')$q$);
select pg_temp.chk('04 ... which the worker holding it still records',
$q$select public.settle_billing_mail ((select id from t_ids where label = 'short'),
    (select claim from t_ids where label = 'short'), 'expired', 'expired before delivery')$q$);
select pg_temp.chk('05 ... and it is never handed out again',
$q$select not exists (select 1 from public.claim_billing_mail (50, interval '2 minutes')
    where id = (select id from t_ids where label = 'short'))$q$);
select pg_temp.chk('06 a link with ten minutes left is saved, and told it has ten minutes',
$q$select answer->>'answer' = 'saved' and (answer->>'remaining_seconds')::int between 590 and 600
   from t_ids where label = 'ten'$q$);
select pg_temp.chk('07 a fresh link is saved with its hour, counted on the clock rather than the transaction',
$q$select answer->>'answer' = 'saved' and (answer->>'remaining_seconds')::int between 3500 and 3599
   from t_ids where label = 'hour'$q$);
select pg_temp.chk('08 a worker without the lease is told so, with no time to its name',
$q$select to_jsonb(public.save_cancel_link_token_v2 ((select id from t_ids where label = 'hour'), gen_random_uuid(),
    pg_temp.random_hash(), pg_temp.u(1))) = '{"answer": "not_held", "remaining_seconds": 0}'::jsonb$q$);
select pg_temp.chk('11 the save under its old name, for the previous edge function, is the same save: text, and refused with 119 s left',
$q$select public.save_cancel_link_token ((select id from t_ids where label = 'legacy'), (select claim from t_ids where label = 'legacy'),
    (select hash from t_ids where label = 'legacy'), pg_temp.u(1)) = 'expired'
   and pg_typeof(public.save_cancel_link_token (gen_random_uuid(), gen_random_uuid(), pg_temp.random_hash(), pg_temp.u(1)))::text = 'text'$q$);
select pg_temp.chk('12 ... and settles the row the same way',
$q$select status = 'expired' and not (payload ? 'email') from public.billing_mail_outbox where id = (select id from t_ids where label = 'legacy')$q$);
reset role;
select pg_temp.chk('09 the margin is 120 seconds, read after the lock, on clock_timestamp()',
$q$select position('for update' in s) > 0
   and position('clock_timestamp()' in s) > position('for update' in s)
   and position('interval ''120 seconds''' in s) > 0
   and position('now()' in s) = 0
   from (select prosrc s from pg_proc where oid = 'public.save_cancel_link_token_v2(uuid, uuid, text, uuid)'::regprocedure) p$q$);
select pg_temp.chk('10 the token guard checks expiry on clock_timestamp() too',
$q$select position('v_expires <= clock_timestamp()' in s) > 0
   from (select prosrc s from pg_proc where oid = 'public.billing_cancel_tokens_lifetime()'::regprocedure) p$q$);

-- ===========================================================================
-- 2-3. A save that waits on the row's lock past the line is refused
-- ===========================================================================
create extension if not exists dblink with schema extensions;
create function pg_temp.peer() returns text language sql as $f$
    select format('host=%s port=%s dbname=%s user=postgres password=%s',
        host(inet_server_addr()), inet_server_port(), current_database(), current_setting('cancel_link_test.peer_password'))
$f$;
select set_config('cancel_link_test.peer_password', :'peer_password', true);
select extensions.dblink_connect('a', pg_temp.peer());
select extensions.dblink_connect('b', pg_temp.peer());
select extensions.dblink_exec('a', $q$delete from public.billing_mail_outbox where payload->>'email' = 'waiter@cancellink.test'$q$);
select extensions.dblink_exec('a', $q$delete from auth.users where id = 'c10c0000-5ac0-4000-8000-000000000009'$q$);
select extensions.dblink_exec('a', $q$insert into auth.users (id, email, is_anonymous)
    values ('c10c0000-5ac0-4000-8000-000000000009', 'waiter@cancellink.test', false)$q$);

-- One committed, leased request per case; its expiry brought forward to
-- p_left from now on the real clock, just before the race starts.
create function pg_temp.waiter(p_label text) returns void language plpgsql as $f$
declare v_id uuid; v_claim uuid;
begin
select r.id into v_id from extensions.dblink('a', $q$select public.enqueue_billing_mail ('cancel_link', null, 'test',
    '{"email": "waiter@cancellink.test", "origin": "https://cleffy.io"}')$q$) as r(id uuid);
select r.claim_token into v_claim from extensions.dblink('a', format($q$select o.claim_token
    from public.claim_billing_mail (50, interval '5 minutes') o where o.id = %L$q$, v_id)) as r(claim_token uuid);
insert into t_ids (label, id, claim, hash) values (p_label, v_id, v_claim, pg_temp.random_hash());
end $f$;
-- `a` holds the row's lock for p_hold; `b`, whose transaction began first,
-- saves the link meanwhile and has to wait for it.
create function pg_temp.race(p_label text, p_left interval, p_hold float) returns void language plpgsql as $f$
declare r record;
begin
select * into r from t_ids where label = p_label;
perform extensions.dblink_exec('a', format($q$update public.billing_mail_outbox set link_expires_at = clock_timestamp() + %L::interval
    where id = %L$q$, p_left, r.id));
perform extensions.dblink_exec('b', 'begin');
-- b's transaction time is fixed here, before the expiry.
perform * from extensions.dblink('b', 'select now()') as x(t timestamptz);
perform extensions.dblink_exec('a', 'begin');
perform * from extensions.dblink('a', format('select id from public.billing_mail_outbox where id = %L for update', r.id)) as x(id uuid);
perform extensions.dblink_send_query('b', format('select to_jsonb(public.save_cancel_link_token_v2 (%L, %L, %L, %L))',
    r.id, r.claim, r.hash, 'c10c0000-5ac0-4000-8000-000000000009'));
perform pg_sleep(p_hold);
insert into t_results values (p_label || ' b waits on a''s lock', extensions.dblink_is_busy('b') = 1, null);
perform extensions.dblink_exec('a', 'commit');
update t_ids set answer = (select x.answer from extensions.dblink_get_result('b') as x(answer jsonb)) where label = p_label;
perform * from extensions.dblink_get_result('b') as x(answer jsonb);
-- Still inside b's transaction: its now() had not reached the expiry.
insert into t_results
select p_label || ' b''s transaction began before the line', x.before, null
from extensions.dblink('b', format($q$select now() < link_expires_at - %L::interval from public.billing_mail_outbox where id = %L$q$,
    case when p_left > interval '120 seconds' then interval '120 seconds' else interval '0' end, r.id)) as x(before boolean);
perform extensions.dblink_exec('b', 'commit');
end $f$;

select pg_temp.waiter('20');
select pg_temp.waiter('30');
select pg_temp.race('20', interval '2 seconds', 3);
select pg_temp.race('30', interval '122 seconds', 3);

select pg_temp.chk('20 a save that waited on the lock past the expiry is refused',
$q$select answer->>'answer' = 'expired' and (answer->>'remaining_seconds')::int = 0 from t_ids where label = '20'$q$);
select pg_temp.chk('21 ... nothing was saved, and the row is settled expired',
$q$select r.ok from extensions.dblink('a', format($s$select not exists (select 1 from public.billing_cancel_tokens where token_hash = %L)
    and (select status = 'expired' and not (payload ? 'email') from public.billing_mail_outbox where id = %L)$s$,
    (select hash from t_ids where label = '20'), (select id from t_ids where label = '20'))) as r(ok boolean)$q$);
select pg_temp.chk('30 a save that waited from 122 s left to under 120 is refused',
$q$select answer->>'answer' = 'expired' and (answer->>'remaining_seconds')::int between 115 and 119 from t_ids where label = '30'$q$);
select pg_temp.chk('31 ... nothing was saved, and the row is settled expired',
$q$select r.ok from extensions.dblink('a', format($s$select not exists (select 1 from public.billing_cancel_tokens where token_hash = %L)
    and (select status = 'expired' and not (payload ? 'email') from public.billing_mail_outbox where id = %L)$s$,
    (select hash from t_ids where label = '30'), (select id from t_ids where label = '30'))) as r(ok boolean)$q$);

select extensions.dblink_exec('a', format('delete from public.billing_mail_outbox where id in (%L, %L)',
    (select id from t_ids where label = '20'), (select id from t_ids where label = '30')));
select extensions.dblink_exec('a', $q$delete from public.billing_mail_outbox where payload->>'email' = 'waiter@cancellink.test'$q$);
select extensions.dblink_exec('a', $q$delete from auth.users where id = 'c10c0000-5ac0-4000-8000-000000000009'$q$);
select pg_temp.chk('40 the race''s rows are gone again',
$q$select r.n = 0 from extensions.dblink('a', format($s$select count(*) from public.billing_mail_outbox where id in (%L, %L)$s$,
    (select id from t_ids where label = '20'), (select id from t_ids where label = '30'))) as r(n bigint)$q$);
select extensions.dblink_disconnect('a');
select extensions.dblink_disconnect('b');

\o
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
