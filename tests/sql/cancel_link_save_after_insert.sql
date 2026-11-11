-- Behaviour proof for save_cancel_link_token_v2 as 20261020160600 defines it,
-- the remaining-lifetime half (Codex round 6 on #62, its new major; decision
-- 34): the seconds left that decide the send are counted on the database's
-- clock as the save's LAST step, after every statement that can wait --
-- the token's INSERT included.
--
-- Before, they were counted before the INSERT. That INSERT checks the
-- token's account (its foreign key to auth.users), so it waits while anyone
-- holds that account's row FOR UPDATE. With 122 s left the save counted 121,
-- waited past the 120 s margin, then answered `saved` with 121 -- and
-- cancelFlow.ts sent a link that had too little left. Now:
--
--   1. a save whose INSERT waits from 122 s left to under 120 answers
--      `expired`, with what is really left; the link it inserted cannot be
--      used (its expiry brought forward to the moment of the refusal, in the
--      same transaction), and the row is settled `expired` without its
--      address -- nothing a sender could send on;
--   2. a save whose INSERT waits with plenty left is saved, and the seconds
--      it answers are counted after the wait, not before it.
--
-- Both need a second session holding the account's row, so they use two
-- dblink sessions as postgres, commit their own rows (random ids and hashes)
-- and delete them again at the end. Run it against the LOCAL stack
-- (scripts/ci/sql-proof.sh does, in CI):
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/cancel_link_save_after_insert.sql
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
create temp table t_ids (label text primary key, id uuid, claim uuid, hash text, answer jsonb);
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
create function pg_temp.random_hash() returns text language sql volatile as $f$ select md5(random()::text) || md5(random()::text) $f$;

create extension if not exists dblink with schema extensions;
create function pg_temp.peer() returns text language sql as $f$
    select format('host=%s port=%s dbname=%s user=postgres password=%s',
        host(inet_server_addr()), inet_server_port(), current_database(), current_setting('cancel_link_test.peer_password'))
$f$;
select set_config('cancel_link_test.peer_password', :'peer_password', true);
select extensions.dblink_connect('a', pg_temp.peer());
select extensions.dblink_connect('b', pg_temp.peer());
-- A one-value query in session `a`, outside this transaction: what is committed.
create function pg_temp.a_ok(p_sql text) returns boolean language sql as $f$
    select r.ok from extensions.dblink('a', p_sql) as r(ok boolean)
$f$;

\set user_id 'b10c0000-5ac0-4000-8000-000000000001'
select extensions.dblink_exec('a', $q$delete from public.billing_mail_outbox where payload->>'email' = 'held@cancellink.test'$q$);
select extensions.dblink_exec('a', format('delete from auth.users where id = %L', :'user_id'));
select extensions.dblink_exec('a', format($q$insert into auth.users (id, email, is_anonymous)
    values (%L, 'held@cancellink.test', false)$q$, :'user_id'));
select set_config('cancel_link_test.user_id', :'user_id', true);

-- One committed, leased request per case.
create function pg_temp.request(p_label text) returns void language plpgsql as $f$
declare v_id uuid; v_claim uuid;
begin
select r.id into v_id from extensions.dblink('a', $q$select public.enqueue_billing_mail ('cancel_link', null, 'test',
    '{"email": "held@cancellink.test", "origin": "https://cleffy.io"}')$q$) as r(id uuid);
select r.claim_token into v_claim from extensions.dblink('a', format($q$select o.claim_token
    from public.claim_billing_mail (50, interval '5 minutes') o where o.id = %L$q$, v_id)) as r(claim_token uuid);
insert into t_ids (label, id, claim, hash) values (p_label, v_id, v_claim, pg_temp.random_hash());
end $f$;
-- The request's expiry brought forward to p_left from now on the real clock;
-- then `a` holds the account's row FOR UPDATE for p_hold seconds while `b`
-- saves the link, whose INSERT has to wait for it.
create function pg_temp.race(p_label text, p_left interval, p_hold float) returns void language plpgsql as $f$
declare r record;
begin
select * into r from t_ids where label = p_label;
perform extensions.dblink_exec('a', format($q$update public.billing_mail_outbox set link_expires_at = clock_timestamp() + %L::interval
    where id = %L$q$, p_left, r.id));
perform extensions.dblink_exec('a', 'begin');
perform * from extensions.dblink('a', format('select id from auth.users where id = %L for update',
    current_setting('cancel_link_test.user_id'))) as x(id uuid);
perform extensions.dblink_send_query('b', format('select public.save_cancel_link_token_v2 (%L, %L, %L, %L)',
    r.id, r.claim, r.hash, current_setting('cancel_link_test.user_id')));
perform pg_sleep(p_hold);
insert into t_results values (p_label || 'a the save waits on the account''s row', extensions.dblink_is_busy('b') = 1, null);
perform extensions.dblink_exec('a', 'commit');
update t_ids set answer = (select x.answer from extensions.dblink_get_result('b') as x(answer jsonb)) where label = p_label;
perform * from extensions.dblink_get_result('b') as x(answer jsonb);
update t_results set detail = (select answer::text from t_ids where label = p_label)
where name = p_label || 'a the save waits on the account''s row';
end $f$;

select pg_temp.request('1');
select pg_temp.request('2');
select pg_temp.race('1', interval '122 seconds', 4);
select pg_temp.race('2', interval '600 seconds', 3);

-- ===========================================================================
-- 1. Waited past the margin: refused, and nothing usable left behind
-- ===========================================================================
select pg_temp.chk('1b a save whose INSERT waited from 122 s left to under 120 answers expired',
$q$select answer->>'answer' = 'expired' from t_ids where label = '1'$q$);
select pg_temp.chk('1c ... with what is really left, counted after the wait',
$q$select (answer->>'remaining_seconds')::int between 112 and 119 from t_ids where label = '1'$q$);
select pg_temp.chk('1d ... the link it inserted cannot be used: the database will not answer for it',
$q$select pg_temp.a_ok(format('select public.read_cancel_link_token (%L) is null', hash)) from t_ids where label = '1'$q$);
select pg_temp.chk('1e ... its expiry brought forward, at most to the refusal',
$q$select pg_temp.a_ok(format($s$select coalesce(bool_and(expires_at <= clock_timestamp()), true)
        from public.billing_cancel_tokens where token_hash = %L$s$, hash)) from t_ids where label = '1'$q$);
select pg_temp.chk('1f ... and the row is settled expired, without its address, never to be handed out again',
$q$select pg_temp.a_ok(format($s$select status = 'expired' and not (payload ? 'email') and last_error = 'expired before delivery'
        from public.billing_mail_outbox where id = %L$s$, id)) from t_ids where label = '1'$q$);

-- ===========================================================================
-- 2. Waited with plenty left: saved, its seconds counted after the wait
-- ===========================================================================
select pg_temp.chk('2b a save whose INSERT waited with ten minutes left is saved',
$q$select answer->>'answer' = 'saved' from t_ids where label = '2'$q$);
select pg_temp.chk('2c ... and the seconds it answers are counted after the wait, not before it',
$q$select (answer->>'remaining_seconds')::int between 590 and 597 from t_ids where label = '2'$q$);
select pg_temp.chk('2d ... its link works',
$q$select pg_temp.a_ok(format('select public.read_cancel_link_token (%L) is not null', hash)) from t_ids where label = '2'$q$);

-- ===========================================================================
-- 3. The count is the save's last step
-- ===========================================================================
select pg_temp.chk('30 the save reads clock_timestamp() again after its INSERT, and decides on that',
$q$select position('insert into public.billing_cancel_tokens' in s) > 0
   and position('clock_timestamp()' in substr(s, position('insert into public.billing_cancel_tokens' in s))) > 0
   and position('interval ''120 seconds''' in substr(s, position('insert into public.billing_cancel_tokens' in s))) > 0
   from (select prosrc s from pg_proc where oid = 'public.save_cancel_link_token_v2(uuid, uuid, text, uuid)'::regprocedure) p$q$);

select extensions.dblink_exec('a', format('delete from public.billing_mail_outbox where id in (%L, %L)',
    (select id from t_ids where label = '1'), (select id from t_ids where label = '2')));
select extensions.dblink_exec('a', format('delete from auth.users where id = %L', :'user_id'));
select pg_temp.chk('40 the proof''s rows are gone again',
$q$select pg_temp.a_ok(format($s$select not exists (select 1 from public.billing_mail_outbox where id in (%L, %L))
        and not exists (select 1 from auth.users where id = %L)$s$,
        (select id from t_ids where label = '1'), (select id from t_ids where label = '2'), current_setting('cancel_link_test.user_id')))$q$);
select extensions.dblink_disconnect('a');
select extensions.dblink_disconnect('b');

\o
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
