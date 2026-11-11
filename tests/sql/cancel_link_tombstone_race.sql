-- Behaviour proof for 20261020160600_cancel_link_serialized_history.sql, the
-- tombstone half (Codex round 6 on #62, the round-5 major 1 still open;
-- decisions 29 and 34): a cancel link deleted in one transaction cannot be
-- put back by another that ran at the same time.
--
-- Before 20261020160600 the token trigger read the tombstones without a lock.
-- Transaction A deletes hash H (the tick's cleanup, or an account's deletion)
-- and writes its tombstone; until A commits, B cannot see that tombstone. B
-- inserts H -- or a new hash under A's outbox id -- its trigger finds no
-- tombstone, and once A commits nothing stands in the way: the spent link is
-- back, unused. Now both sides take the same transaction advisory locks (the
-- outbox id, then the hash) and B reads the tombstones only once it has them:
--
--   1. the tick deletes an expired, spent hash while the table's owner
--      inserts that hash against a new pending request: the insert waits on
--      the tick's advisory lock, and is refused once the tick commits;
--   2. the same, with save_cancel_link_token_v2 saving that hash under a new
--      request's lease: it waits, then answers `spent` and settles the row;
--   3. an account's deletion takes its pending request's token while the
--      owner inserts a NEW hash under that request's id: it waits, and is
--      refused -- before, it was not even made to wait;
--   4. an insert outside READ COMMITTED (whose snapshot could predate the
--      delete it waited for) is refused outright;
--   5. an outbox id is tombstoned once: two tokens for one request (a secret
--      rotated while it retried) both leave their hash, one of them the id.
--
-- Sections 1-3 need two sessions besides this one, so they run in dblink
-- sessions as postgres that commit their own rows (random ids and hashes:
-- tombstones are permanent) and delete the accounts again at the end. Run it
-- against the LOCAL stack (scripts/ci/sql-proof.sh does, in CI):
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/cancel_link_tombstone_race.sql
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
create temp table t_ids (label text primary key, id uuid, claim uuid, hash text, hash2 text, answer text, error text);
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('a7ce0000-5ac0-4000-8000-00000000000' || n)::uuid $f$;
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
create function pg_temp.random_hash() returns text language sql volatile as $f$ select md5(random()::text) || md5(random()::text) $f$;

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

select pg_temp.a($q$delete from public.billing_mail_outbox where payload->>'email' like '%@tombstone-race.test'$q$);
select pg_temp.a(format('delete from auth.users where id in (%L, %L)', pg_temp.u(1), pg_temp.u(2)));
select pg_temp.a(format($q$insert into auth.users (id, email, is_anonymous) values
    (%L, 'race1@tombstone-race.test', false), (%L, 'race2@tombstone-race.test', false)$q$, pg_temp.u(1), pg_temp.u(2)));

-- A committed cancel-link request of p_user's, leased, and (p_save) its link
-- saved under a random hash.
create function pg_temp.request(p_label text, p_user int, p_save boolean) returns void language plpgsql as $f$
declare v_id uuid; v_claim uuid; v_hash text := pg_temp.random_hash(); v_answer text;
begin
select r.id into v_id from extensions.dblink('a', format($q$select public.enqueue_billing_mail ('cancel_link', null, 'test',
    jsonb_build_object('email', 'race%s@tombstone-race.test', 'origin', 'https://cleffy.io'))$q$, p_user)) as r(id uuid);
select r.claim_token into v_claim from extensions.dblink('a', format($q$select o.claim_token
    from public.claim_billing_mail (50, interval '5 minutes') o where o.id = %L$q$, v_id)) as r(claim_token uuid);
if p_save then
    select r.answer into v_answer from extensions.dblink('a', format($q$select public.save_cancel_link_token_v2 (%L, %L, %L, %L)->>'answer'$q$,
        v_id, v_claim, v_hash, pg_temp.u(p_user))) as r(answer text);
end if;
insert into t_ids (label, id, claim, hash, answer) values (p_label, v_id, v_claim, v_hash, v_answer);
end $f$;
-- Its link sent (which deletes the request's row), used, and its hour over:
-- what the tick's cleanup deletes.
create function pg_temp.spent(p_label text) returns void language plpgsql as $f$
declare r record;
begin
select * into r from t_ids where label = p_label;
perform pg_temp.a_ok(format($q$select public.settle_billing_mail (%L, %L, 'sent')$q$, r.id, r.claim));
perform pg_temp.a(format($q$update public.billing_cancel_tokens set used_at = now() where token_hash = %L$q$, r.hash));
perform pg_temp.a(format($q$update public.billing_cancel_tokens set expires_at = now() - interval '1 second' where token_hash = %L$q$, r.hash));
end $f$;
-- The race: `a` runs p_delete and holds its transaction open; `b` sends
-- p_write meanwhile; after p_hold seconds `a` commits, and `b` gets its
-- answer (or its error) and commits whatever it did.
create function pg_temp.race(p_label text, p_delete text, p_write text, p_hold float) returns void language plpgsql as $f$
declare v_pid int; v_answer text; v_error text;
begin
perform pg_temp.a('begin');
perform pg_temp.a(p_delete);
perform pg_temp.b('begin');
select r.pid into v_pid from extensions.dblink('b', 'select pg_backend_pid()') as r(pid int);
perform extensions.dblink_send_query('b', p_write);
perform pg_sleep(p_hold);
insert into t_results values (p_label || 'a b waits while a''s delete is uncommitted', extensions.dblink_is_busy('b') = 1, null);
insert into t_results values (p_label || 'b ... on the history''s advisory lock',
    exists (select 1 from pg_locks where pid = v_pid and locktype = 'advisory' and not granted), null);
perform pg_temp.a('commit');
select x.answer into v_answer from extensions.dblink_get_result('b', false) as x(answer text);
v_error := extensions.dblink_error_message('b');
perform * from extensions.dblink_get_result('b', false) as x(answer text);
perform pg_temp.b('commit');
insert into t_ids (label, answer, error) values (p_label, v_answer, v_error);
end $f$;

-- The cron tick, as a statement session `a` can run inside its transaction.
\set tick 'do $d$ begin perform public.billing_mail_outbox_tick (); end $d$'

-- ===========================================================================
-- 1. The tick deletes a spent hash; the table's owner inserts it meanwhile
-- ===========================================================================
select pg_temp.request('spent1', 1, true);
select pg_temp.spent('spent1');
select pg_temp.request('fresh1', 1, false);
select pg_temp.chk('00 (the link was saved, then sent, used and expired)',
$q$select answer = 'saved' from t_ids where label = 'spent1'$q$);
select pg_temp.race('1', :'tick',
    format($q$insert into public.billing_cancel_tokens (token_hash, user_id, mode, expires_at, outbox_id)
        values (%L, %L, 'test', now() + interval '1 hour', %L)$q$,
        (select hash from t_ids where label = 'spent1'), pg_temp.u(1), (select id from t_ids where label = 'fresh1')),
    1.5);
select pg_temp.chk('1c the insert is refused once the tick commits',
$q$select answer is null and strpos(error, 'never comes back') > 0 from t_ids where label = '1'$q$);
select pg_temp.chk('1d ... the spent link stays gone, its tombstone kept',
$q$select pg_temp.a_ok(format('select not exists (select 1 from public.billing_cancel_tokens where token_hash = %L)
        and exists (select 1 from public.billing_cancel_token_tombstones where token_hash = %L)', hash, hash))
   from t_ids where label = 'spent1'$q$);

-- ===========================================================================
-- 2. ... and the save, under a new request's lease
-- ===========================================================================
select pg_temp.request('spent2', 1, true);
select pg_temp.spent('spent2');
select pg_temp.request('fresh2', 1, false);
select pg_temp.race('2', :'tick',
    format($q$select public.save_cancel_link_token_v2 (%L, %L, %L, %L)->>'answer'$q$,
        (select id from t_ids where label = 'fresh2'), (select claim from t_ids where label = 'fresh2'),
        (select hash from t_ids where label = 'spent2'), pg_temp.u(1)),
    1.5);
select pg_temp.chk('2c the save answers spent once the tick commits',
$q$select answer = 'spent' from t_ids where label = '2'$q$);
select pg_temp.chk('2d ... saves nothing, and settles its row for good',
$q$select pg_temp.a_ok(format($s$select not exists (select 1 from public.billing_cancel_tokens where token_hash = %L)
        and (select status = 'expired' and last_error = 'cancel link already spent or removed' from public.billing_mail_outbox where id = %L)$s$,
        (select hash from t_ids where label = 'spent2'), (select id from t_ids where label = 'fresh2')))$q$);

-- ===========================================================================
-- 3. An account's deletion takes its pending request's link; a new hash for
--    that request is inserted meanwhile
-- ===========================================================================
select pg_temp.request('leaving', 2, true);
select pg_temp.race('3', format('delete from auth.users where id = %L', pg_temp.u(2)),
    format($q$insert into public.billing_cancel_tokens (token_hash, user_id, mode, expires_at, outbox_id)
        values (%L, %L, 'test', now() + interval '1 hour', %L)$q$,
        pg_temp.random_hash(), pg_temp.u(1), (select id from t_ids where label = 'leaving')),
    1.5);
select pg_temp.chk('3c the insert under the deleted link''s request is refused once the deletion commits',
$q$select answer is null and strpos(error, 'never comes back') > 0 from t_ids where label = '3'$q$);
select pg_temp.chk('3d ... no link is left for that request, and its id is tombstoned',
$q$select pg_temp.a_ok(format('select not exists (select 1 from public.billing_cancel_tokens where outbox_id = %L)
        and exists (select 1 from public.billing_cancel_token_tombstones where outbox_id = %L)', id, id))
   from t_ids where label = 'leaving'$q$);

-- ===========================================================================
-- 4. Only under READ COMMITTED, where the history read after the lock is
--    a fresh one
-- ===========================================================================
select pg_temp.request('fresh4', 1, false);
select pg_temp.b('begin isolation level repeatable read');
select pg_temp.chk('40 an insert under REPEATABLE READ is refused',
$q$select extensions.dblink_exec('b', format($s$insert into public.billing_cancel_tokens (token_hash, user_id, mode, expires_at, outbox_id)
        values (%L, %L, 'test', now() + interval '1 hour', %L)$s$, pg_temp.random_hash(), pg_temp.u(1),
        (select id from t_ids where label = 'fresh4')), false) = 'ERROR'
   and strpos(extensions.dblink_error_message('b'), 'READ COMMITTED') > 0$q$);
select pg_temp.b('rollback');
select pg_temp.chk('41 ... and the save, under its lease, still saves under READ COMMITTED',
$q$select r.answer = 'saved' from t_ids, lateral extensions.dblink('a', format($s$select public.save_cancel_link_token_v2 (%L, %L, %L, %L)->>'answer'$s$,
    id, claim, hash, pg_temp.u(1))) as r(answer text) where label = 'fresh4'$q$);

-- ===========================================================================
-- 5. One request, two links: each hash tombstoned, the request's id once
-- ===========================================================================
select pg_temp.request('rotated', 1, true);
update t_ids set hash2 = pg_temp.random_hash() where label = 'rotated';
select pg_temp.chk('50 a second link for the same request (a rotated secret) is saved too',
$q$select r.answer = 'saved' from t_ids, lateral extensions.dblink('a', format($s$select public.save_cancel_link_token_v2 (%L, %L, %L, %L)->>'answer'$s$,
    id, claim, hash2, pg_temp.u(1))) as r(answer text) where label = 'rotated'$q$);
select pg_temp.spent('rotated');
select pg_temp.a(format($q$update public.billing_cancel_tokens set expires_at = now() - interval '1 second' where token_hash = %L$q$,
    (select hash2 from t_ids where label = 'rotated')));
select pg_temp.chk('51 the tick deletes both',
$q$select pg_temp.a_ok('select true from (select public.billing_mail_outbox_tick ()) t')
   and pg_temp.a_ok(format('select not exists (select 1 from public.billing_cancel_tokens where outbox_id = %L)', id))
   from t_ids where label = 'rotated'$q$);
select pg_temp.chk('52 ... both hashes are tombstoned, and the request''s id exactly once',
$q$select pg_temp.a_ok(format('select (select count(*) from public.billing_cancel_token_tombstones where token_hash in (%L, %L)) = 2
        and (select count(*) from public.billing_cancel_token_tombstones where outbox_id = %L) = 1', hash, hash2, id))
   from t_ids where label = 'rotated'$q$);
select pg_temp.chk('53 an outbox id''s tombstone is unique',
$q$select exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = 'public.billing_cancel_token_tombstones'::regclass and i.indisunique and i.indnatts = 1 and a.attname = 'outbox_id')$q$);
select pg_temp.refused('54 ... so a second one for the same id is refused, even to the owner',
$q$insert into public.billing_cancel_token_tombstones (token_hash, outbox_id)
   values (pg_temp.random_hash(), (select id from t_ids where label = 'rotated'))$q$, '23505');

-- ===========================================================================
-- 6. Every path takes the locks, outbox id first, before it reads history
-- ===========================================================================
select pg_temp.chk('60 the lock key is namespaced, and the same for every path',
$q$select public.billing_cancel_link_lock_key ('outbox', 'x') = hashtextextended('cleffy.billing_cancel_link.outbox:x', 0)
   and public.billing_cancel_link_lock_key ('hash', 'x') = hashtextextended('cleffy.billing_cancel_link.hash:x', 0)
   and public.billing_cancel_link_lock_key ('outbox', 'x') <> public.billing_cancel_link_lock_key ('hash', 'x')$q$);
select pg_temp.chk('61 the lock takes the outbox id before the hash',
$q$select position('''outbox''' in s) between 1 and position('''hash''' in s)
   from (select prosrc s from pg_proc where oid = 'public.billing_cancel_link_lock(uuid, text)'::regprocedure) p$q$);
select pg_temp.chk('62 the insert trigger and the save lock before they read the tombstones',
$q$select bool_and(position('public.billing_cancel_link_lock (' in prosrc) between 1 and position('billing_cancel_token_tombstones' in prosrc))
   from pg_proc where oid in ('public.billing_cancel_tokens_not_tombstoned()'::regprocedure,
       'public.save_cancel_link_token_v2(uuid, uuid, text, uuid)'::regprocedure)$q$);
select pg_temp.chk('63 every delete of a token locks first (a BEFORE DELETE trigger), and the tick before it deletes',
$q$select exists (select 1 from pg_trigger where tgrelid = 'public.billing_cancel_tokens'::regclass
        and tgname = 'billing_cancel_tokens_delete_lock' and tgtype & 8 = 8 and tgtype & 2 = 2 and tgenabled = 'O')
   and (select position('pg_advisory_xact_lock' in prosrc) between 1 and position('delete from public.billing_cancel_tokens' in prosrc)
        from pg_proc where oid = 'public.billing_mail_outbox_tick()'::regprocedure)$q$);

select pg_temp.a(format('delete from public.billing_mail_outbox where id = any (%L::uuid[])',
    (select array_agg(id) from t_ids where id is not null)));
select pg_temp.a(format('delete from auth.users where id in (%L, %L)', pg_temp.u(1), pg_temp.u(2)));
select pg_temp.chk('70 the race''s accounts and requests are gone again',
$q$select pg_temp.a_ok(format($s$select not exists (select 1 from auth.users where id in (%L, %L))
        and not exists (select 1 from public.billing_mail_outbox where id in (select unnest(%L::uuid[])))$s$,
        pg_temp.u(1), pg_temp.u(2), (select array_agg(id) from t_ids where id is not null)))$q$);
select extensions.dblink_disconnect('a');
select extensions.dblink_disconnect('b');

\o
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
