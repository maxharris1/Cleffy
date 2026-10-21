-- Behaviour proof for 20261020160300_cancel_link_token_lifetime.sql (Codex
-- round 4 on #62): a cancel link's expiry is fixed once, when it is asked for,
-- and no retry of its outbox row moves it.
--
--   1. the outbox row carries the expiry from the moment it is written down,
--      and it can only ever be brought forward;
--   2. the token is saved only under the row's lease, with the row's expiry,
--      and a second save -- or the upsert the store used to make -- changes
--      nothing;
--   3. once the expiry has passed nothing is saved, the row is settled
--      `expired` for good, without its address, and never handed out again;
--   4. a spent link is never revived (Codex's round-4 major): Resend takes it,
--      the answer is lost, the customer uses it, the row retries after the
--      expiry, the cleanup runs, the row is retried -- and at no point is the
--      link usable again; a retry after use keeps used_at; a token is deleted
--      only once it has expired and its row can no longer retry, and nothing
--      can insert it again;
--   5. two sessions saving at once (two retries of one row) keep the first
--      save's expiry.
--
-- Sections 1-4 run inside one transaction and ROLL BACK. Section 5 needs two
-- real sessions, so it opens them with dblink, commits its own rows there and
-- deletes them again at the end. Run it against the LOCAL stack (CI does, in
-- the supabase-local job: scripts/ci/sql-proof.sh):
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/cancel_link_lifetime.sql
--
-- The dblink sessions log in as postgres with the local stack's password; pass
-- -v peer_password=... for any other. Every row of the result table should read
-- `t`; the last line is `failures | total`.
\set ON_ERROR_STOP on
\if :{?peer_password}
\else
\set peer_password postgres
\endif
-- Only the result table is printed; the setup's own output is not.
\o /dev/null
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create temp table t_ids (label text primary key, id uuid, claim uuid, hash text);
grant all on t_ids to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('11fe0000-5ac0-4000-8000-00000000000' || n)::uuid $f$;
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
create function pg_temp.as_service() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
perform set_config('role', 'service_role', true);
end $f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

insert into auth.users (id, email, is_anonymous) values (pg_temp.u(1), 'lifetime@cancellink.test', false);
-- Nothing else in this database is due while the proofs below run.
update public.billing_mail_outbox set next_attempt_at = now() + interval '1 day' where status = 'pending';

-- ===========================================================================
-- 1. The expiry is set once, when the link is asked for
-- ===========================================================================
select pg_temp.as_service();
insert into t_ids (label, id)
select 'link', public.enqueue_billing_mail ('cancel_link', null, 'test', '{"email": "lifetime@cancellink.test", "origin": "https://cleffy.io"}');

select pg_temp.chk('01 a cancel-link request carries its expiry from the moment it is written down',
$q$select link_expires_at = created_at + interval '1 hour'
   from public.billing_mail_outbox where id = (select id from t_ids where label = 'link')$q$);
insert into t_ids (label, id)
select 'purchase', public.enqueue_billing_mail ('purchase_confirmation', 'cs_lifetime_1', 'test', '{"userId": "x"}');
select pg_temp.chk('02 ... and a confirmation carries none',
$q$select link_expires_at is null from public.billing_mail_outbox where id = (select id from t_ids where label = 'purchase')$q$);
select pg_temp.chk('03 an insert cannot choose a later expiry: it is always an hour after created_at',
$q$with q as (insert into public.billing_mail_outbox (kind, mode, payload, link_expires_at)
    values ('cancel_link', 'test', '{}', now() + interval '1 year') returning link_expires_at, created_at)
   select link_expires_at = created_at + interval '1 hour' from q$q$);
select pg_temp.refused('04 a retry cannot push the expiry later',
$q$update public.billing_mail_outbox set link_expires_at = link_expires_at + interval '1 minute'
   where id = (select id from t_ids where label = 'link')$q$, '55000');
select pg_temp.refused('05 ... or clear it',
$q$update public.billing_mail_outbox set link_expires_at = null
   where id = (select id from t_ids where label = 'link')$q$, '55000');

-- ===========================================================================
-- 2. The token is saved under the lease, with the row's expiry, once
-- ===========================================================================
update t_ids t set claim = c.claim_token
from public.claim_billing_mail (10, interval '2 minutes') c where c.id = t.id;
update t_ids set hash = repeat('c', 64) where label = 'link';

select pg_temp.chk('10 the lease holder saves the link',
$q$select public.save_cancel_link_token ((select id from t_ids where label = 'link'),
    (select claim from t_ids where label = 'link'), (select hash from t_ids where label = 'link'), pg_temp.u(1)) = 'saved'$q$);
select pg_temp.chk('11 ... with the row''s expiry and mode, for that row, unused',
$q$select t.expires_at = o.link_expires_at and t.mode = o.mode and t.outbox_id = o.id and t.used_at is null
   from public.billing_cancel_tokens t join public.billing_mail_outbox o on o.id = t.outbox_id
   where t.token_hash = (select hash from t_ids where label = 'link')$q$);
select pg_temp.chk('12 a worker without the lease is told so, and saves nothing',
$q$select public.save_cancel_link_token ((select id from t_ids where label = 'link'),
    gen_random_uuid(), repeat('d', 64), pg_temp.u(1)) = 'not_held'
   and not exists (select 1 from public.billing_cancel_tokens where token_hash = repeat('d', 64))$q$);

-- A later attempt at the same row: time has passed (pushed back by the clock,
-- since now() is fixed inside this transaction), the expiry has not.
select pg_temp.chk('13 a second save of the same link answers saved',
$q$select public.save_cancel_link_token ((select id from t_ids where label = 'link'),
    (select claim from t_ids where label = 'link'), (select hash from t_ids where label = 'link'), pg_temp.u(1)) = 'saved'$q$);
select pg_temp.chk('14 ... and leaves the one token exactly as the first save stored it',
$q$select count(*) = 1 and bool_and(t.expires_at = o.created_at + interval '1 hour')
   from public.billing_cancel_tokens t join public.billing_mail_outbox o on o.id = t.outbox_id
   where t.token_hash = (select hash from t_ids where label = 'link')$q$);
-- What billingCancelStore.ts saveToken sent before this fix: PostgREST's
-- upsert on token_hash, with an expiry an hour from the retry. The service
-- role may not insert tokens at all any more (20261020160400), so the table's
-- trigger is proved as the owner, who may.
select pg_temp.refused('15a the service role cannot insert a token directly',
$q$insert into public.billing_cancel_tokens (token_hash, user_id, mode, expires_at)
   values ((select hash from t_ids where label = 'link'), pg_temp.u(1), 'test', now() + interval '2 hours')
   on conflict (token_hash) do update set user_id = excluded.user_id, mode = excluded.mode, expires_at = excluded.expires_at$q$,
'42501');
reset role;
select pg_temp.refused('15 the upsert the store used to make cannot refresh the expiry',
$q$insert into public.billing_cancel_tokens (token_hash, user_id, mode, expires_at)
   values ((select hash from t_ids where label = 'link'), pg_temp.u(1), 'test', now() + interval '2 hours')
   on conflict (token_hash) do update set user_id = excluded.user_id, mode = excluded.mode, expires_at = excluded.expires_at$q$,
'55000');
select pg_temp.as_service();
select pg_temp.refused('16 nor can any update move a saved expiry later',
$q$update public.billing_cancel_tokens set expires_at = expires_at + interval '1 hour'
   where token_hash = (select hash from t_ids where label = 'link')$q$, '55000');
select pg_temp.chk('17 the expiry is still the one the link was asked with',
$q$select t.expires_at = o.created_at + interval '1 hour'
   from public.billing_cancel_tokens t join public.billing_mail_outbox o on o.id = (select id from t_ids where label = 'link')
   where t.token_hash = (select hash from t_ids where label = 'link')$q$);

reset role;
select pg_temp.chk('18 save_cancel_link_token is the service role''s alone',
$q$select has_function_privilege('service_role', 'public.save_cancel_link_token(uuid, uuid, text, uuid)', 'execute')
   and not has_function_privilege('authenticated', 'public.save_cancel_link_token(uuid, uuid, text, uuid)', 'execute')
   and not has_function_privilege('anon', 'public.save_cancel_link_token(uuid, uuid, text, uuid)', 'execute')$q$);

-- ===========================================================================
-- 3. Nothing is sent once the expiry has passed
-- ===========================================================================
select pg_temp.as_service();
insert into t_ids (label, id)
select 'late', public.enqueue_billing_mail ('cancel_link', null, 'test', '{"email": "lifetime@cancellink.test", "origin": "https://cleffy.io"}');
update public.billing_mail_outbox set next_attempt_at = now() + interval '1 day' where id = (select id from t_ids where label = 'link');
update t_ids t set claim = c.claim_token, hash = repeat('f', 64)
from public.claim_billing_mail (10, interval '2 minutes') c where c.id = t.id;
-- The hour runs out while the row waits (brought forward, since now() is fixed
-- inside this transaction; bringing an expiry forward is the one move allowed).
update public.billing_mail_outbox set link_expires_at = now() - interval '1 second'
where id = (select id from t_ids where label = 'late');

select pg_temp.chk('20 a save after the expiry is refused as expired',
$q$select public.save_cancel_link_token ((select id from t_ids where label = 'late'),
    (select claim from t_ids where label = 'late'), (select hash from t_ids where label = 'late'), pg_temp.u(1)) = 'expired'$q$);
select pg_temp.chk('21 ... and saves nothing',
$q$select not exists (select 1 from public.billing_cancel_tokens where token_hash = (select hash from t_ids where label = 'late'))$q$);
select pg_temp.chk('22 the worker settles it expired',
$q$select public.settle_billing_mail ((select id from t_ids where label = 'late'),
    (select claim from t_ids where label = 'late'), 'expired', 'expired before delivery')$q$);
select pg_temp.chk('23 ... for good: no lease, the reason kept, the address gone',
$q$select status = 'expired' and claim_token is null and claimed_until is null
       and last_error = 'expired before delivery' and not (payload ? 'email') and payload->>'origin' = 'https://cleffy.io'
   from public.billing_mail_outbox where id = (select id from t_ids where label = 'late')$q$);
update public.billing_mail_outbox set next_attempt_at = now() - interval '1 minute'
where id = (select id from t_ids where label = 'late');
select pg_temp.chk('24 an expired row is never handed out again, however due',
$q$select not exists (select 1 from public.claim_billing_mail (10, interval '2 minutes')
    where id = (select id from t_ids where label = 'late'))$q$);
select pg_temp.chk('25 ... and its old lease can neither save nor settle it',
$q$select public.save_cancel_link_token ((select id from t_ids where label = 'late'),
    (select claim from t_ids where label = 'late'), (select hash from t_ids where label = 'late'), pg_temp.u(1)) = 'not_held'
   and not public.settle_billing_mail ((select id from t_ids where label = 'late'), (select claim from t_ids where label = 'late'), 'retry')$q$);
insert into t_ids (label, id, claim)
select 'confirmation', id, claim_token from public.billing_mail_outbox
where id = (select id from t_ids where label = 'purchase');
update public.billing_mail_outbox set next_attempt_at = now() - interval '1 minute'
where id = (select id from t_ids where label = 'purchase');
update t_ids t set claim = c.claim_token
from public.claim_billing_mail (10, interval '2 minutes') c where c.id = t.id and t.label = 'confirmation';
select pg_temp.refused('26 only a cancel link can expire: a confirmation is retried until it goes',
$q$select public.settle_billing_mail ((select id from t_ids where label = 'confirmation'),
    (select claim from t_ids where label = 'confirmation'), 'expired')$q$, '22023');
reset role;

-- ===========================================================================
-- 4. A spent link is never revived
-- ===========================================================================
insert into auth.users (id, email, is_anonymous) values (pg_temp.u(2), 'leaving@cancellink.test', false);
select pg_temp.as_service();
update public.billing_mail_outbox set next_attempt_at = now() + interval '1 day' where status = 'pending';
insert into t_ids (label, id)
select 'spent', public.enqueue_billing_mail ('cancel_link', null, 'test', '{"email": "lifetime@cancellink.test", "origin": "https://cleffy.io"}');
update t_ids t set claim = c.claim_token, hash = repeat('1', 64)
from public.claim_billing_mail (10, interval '2 minutes') c where c.id = t.id;

-- Attempt 1: saved and handed to Resend, whose answer is lost -- `unknown`,
-- so the row is put back to retry.
select pg_temp.chk('40 the first attempt saves the link',
$q$select public.save_cancel_link_token ((select id from t_ids where label = 'spent'),
    (select claim from t_ids where label = 'spent'), (select hash from t_ids where label = 'spent'), pg_temp.u(1)) = 'saved'$q$);
select pg_temp.chk('41 ... Resend''s answer is lost, so the row will retry',
$q$select public.settle_billing_mail ((select id from t_ids where label = 'spent'),
    (select claim from t_ids where label = 'spent'), 'retry', 'resend unknown: network', interval '1 minute')$q$);
-- The email did arrive, and the customer uses the link (consumeToken).
select pg_temp.chk('42 the customer spends the link',
$q$with spent as (update public.billing_cancel_tokens set used_at = now()
    where token_hash = (select hash from t_ids where label = 'spent') and used_at is null returning 1)
    select count(*) = 1 from spent$q$);
select pg_temp.refused('43 a spent link cannot be made unspent',
$q$update public.billing_cancel_tokens set used_at = null where token_hash = (select hash from t_ids where label = 'spent')$q$,
'55000');
select pg_temp.refused('44 ... or re-spent at another time',
$q$update public.billing_cancel_tokens set used_at = now() + interval '1 minute'
   where token_hash = (select hash from t_ids where label = 'spent')$q$, '55000');

-- Attempt 2, still inside the hour: Resend answers from the first request.
update public.billing_mail_outbox set next_attempt_at = now() - interval '1 second'
where id = (select id from t_ids where label = 'spent');
update t_ids t set claim = c.claim_token
from public.claim_billing_mail (10, interval '2 minutes') c where c.id = t.id and t.label = 'spent';
select pg_temp.chk('45 a retry after the link was used saves it again',
$q$select public.save_cancel_link_token ((select id from t_ids where label = 'spent'),
    (select claim from t_ids where label = 'spent'), (select hash from t_ids where label = 'spent'), pg_temp.u(1)) = 'saved'$q$);
select pg_temp.chk('46 ... and the link is still spent, at the moment it was spent, with its first expiry',
$q$select t.used_at = now() and t.expires_at = o.created_at + interval '1 hour'
   from public.billing_cancel_tokens t join public.billing_mail_outbox o on o.id = t.outbox_id
   where t.token_hash = (select hash from t_ids where label = 'spent')$q$);
select pg_temp.chk('47 ... answered unknown again, so it retries once more',
$q$select public.settle_billing_mail ((select id from t_ids where label = 'spent'),
    (select claim from t_ids where label = 'spent'), 'retry', 'resend unknown: timeout', interval '6 hours')$q$);

-- A day goes by (both expiries brought forward, now() being fixed here).
update public.billing_mail_outbox set link_expires_at = now() - interval '23 hours'
where id = (select id from t_ids where label = 'spent');
update public.billing_cancel_tokens set expires_at = now() - interval '23 hours'
where token_hash = (select hash from t_ids where label = 'spent');
select pg_temp.refused('48 the spent link cannot be deleted while its row can still retry, even expired',
$q$delete from public.billing_cancel_tokens where token_hash = (select hash from t_ids where label = 'spent')$q$, '55000');
reset role;
select pg_temp.chk('49 the cleanup keeps it too',
$q$select true from (select public.billing_mail_outbox_tick ()) t$q$);
select pg_temp.chk('50 ... still there, still spent',
$q$select used_at is not null from public.billing_cancel_tokens where token_hash = (select hash from t_ids where label = 'spent')$q$);
select pg_temp.as_service();

-- Attempt 3, the delayed retry: past the expiry, so nothing is saved or sent.
update public.billing_mail_outbox set next_attempt_at = now() - interval '1 second'
where id = (select id from t_ids where label = 'spent');
update t_ids t set claim = c.claim_token
from public.claim_billing_mail (10, interval '2 minutes') c where c.id = t.id and t.label = 'spent';
select pg_temp.chk('51 the delayed retry is refused as expired',
$q$select public.save_cancel_link_token ((select id from t_ids where label = 'spent'),
    (select claim from t_ids where label = 'spent'), (select hash from t_ids where label = 'spent'), pg_temp.u(1)) = 'expired'$q$);
select pg_temp.chk('52 ... and settled for good',
$q$select public.settle_billing_mail ((select id from t_ids where label = 'spent'),
    (select claim from t_ids where label = 'spent'), 'expired', 'expired before delivery')$q$);
reset role;
select pg_temp.chk('53 now the cleanup removes the token',
$q$select true from (select public.billing_mail_outbox_tick ()) t$q$);
select pg_temp.chk('54 ... gone',
$q$select not exists (select 1 from public.billing_cancel_tokens where token_hash = (select hash from t_ids where label = 'spent'))$q$);
select pg_temp.as_service();
-- And then the row is "retried".
select pg_temp.refused('55 the settled row cannot be made pending again',
$q$update public.billing_mail_outbox set status = 'pending', next_attempt_at = now() - interval '1 second'
   where id = (select id from t_ids where label = 'spent')$q$, '55000');
select pg_temp.chk('56 ... is never handed out',
$q$select not exists (select 1 from public.claim_billing_mail (10, interval '2 minutes')
    where id = (select id from t_ids where label = 'spent'))$q$);
select pg_temp.chk('57 ... and its old lease cannot save the link',
$q$select public.save_cancel_link_token ((select id from t_ids where label = 'spent'),
    (select claim from t_ids where label = 'spent'), (select hash from t_ids where label = 'spent'), pg_temp.u(1)) = 'not_held'$q$);
reset role;
select pg_temp.refused('58 nothing can insert the spent token again: not for its row',
$q$insert into public.billing_cancel_tokens (token_hash, user_id, mode, expires_at, outbox_id)
   values ((select hash from t_ids where label = 'spent'), pg_temp.u(1), 'test', now() + interval '1 hour',
           (select id from t_ids where label = 'spent'))$q$, '55000');
select pg_temp.refused('59 ... nor the way the store used to, with no row at all',
$q$insert into public.billing_cancel_tokens (token_hash, user_id, mode, expires_at)
   values ((select hash from t_ids where label = 'spent'), pg_temp.u(1), 'test', now() + interval '1 hour')
   on conflict (token_hash) do update set expires_at = excluded.expires_at$q$, '55000');
select pg_temp.as_service();
select pg_temp.chk('60 the spent link never works again',
$q$select not exists (select 1 from public.billing_cancel_tokens
    where token_hash = (select hash from t_ids where label = 'spent') and used_at is null and expires_at > now())$q$);

-- A link that went out (row deleted on `sent`) and one still unused.
insert into t_ids (label, id)
select 'sent', public.enqueue_billing_mail ('cancel_link', null, 'test', '{"email": "lifetime@cancellink.test", "origin": "https://cleffy.io"}');
update t_ids t set claim = c.claim_token, hash = repeat('2', 64)
from public.claim_billing_mail (10, interval '2 minutes') c where c.id = t.id;
select pg_temp.chk('61 a link is saved and sent; its row is deleted',
$q$select public.save_cancel_link_token ((select id from t_ids where label = 'sent'),
    (select claim from t_ids where label = 'sent'), (select hash from t_ids where label = 'sent'), pg_temp.u(1)) = 'saved'
   and public.settle_billing_mail ((select id from t_ids where label = 'sent'), (select claim from t_ids where label = 'sent'), 'sent')$q$);
select pg_temp.refused('62 a live link cannot be deleted before its expiry',
$q$delete from public.billing_cancel_tokens where token_hash = (select hash from t_ids where label = 'sent')$q$, '55000');
select pg_temp.chk('63 once expired, with its row gone, it can be',
$q$with gone as (update public.billing_cancel_tokens set expires_at = now() - interval '1 second'
    where token_hash = (select hash from t_ids where label = 'sent') returning 1) select count(*) = 1 from gone$q$);
select pg_temp.chk('64 ... (deleted)',
$q$with gone as (delete from public.billing_cancel_tokens where token_hash = (select hash from t_ids where label = 'sent') returning 1)
    select count(*) = 1 from gone$q$);
reset role;
select pg_temp.refused('65 ... and never inserted again, its row being gone',
$q$insert into public.billing_cancel_tokens (token_hash, user_id, mode, expires_at, outbox_id)
   values ((select hash from t_ids where label = 'sent'), pg_temp.u(1), 'test', now() + interval '1 hour',
           (select id from t_ids where label = 'sent'))$q$, '55000');
select pg_temp.as_service();

-- Deleting an account takes its links, whatever state their rows are in.
insert into t_ids (label, id)
select 'leaving', public.enqueue_billing_mail ('cancel_link', null, 'test', '{"email": "leaving@cancellink.test", "origin": "https://cleffy.io"}');
update t_ids t set claim = c.claim_token, hash = repeat('3', 64)
from public.claim_billing_mail (10, interval '2 minutes') c where c.id = t.id;
select pg_temp.chk('66 a waiting request''s link is saved',
$q$select public.save_cancel_link_token ((select id from t_ids where label = 'leaving'),
    (select claim from t_ids where label = 'leaving'), (select hash from t_ids where label = 'leaving'), pg_temp.u(2)) = 'saved'$q$);
reset role;
select pg_temp.chk('67 the account can still be deleted, and its link goes with it',
$q$with gone as (delete from auth.users where id = pg_temp.u(2) returning 1)
    select count(*) = 1 from gone$q$);
select pg_temp.chk('68 ... gone',
$q$select not exists (select 1 from public.billing_cancel_tokens where token_hash = (select hash from t_ids where label = 'leaving'))$q$);
select pg_temp.chk('69 the token guard: search_path pinned empty, nobody may call it',
$q$select p.proconfig @> array['search_path=""'] and p.prosecdef
    and not has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute')
    and not has_function_privilege('service_role', p.oid, 'execute')
    from pg_proc p where p.oid = 'public.billing_cancel_tokens_lifetime()'::regprocedure$q$);

-- ===========================================================================
-- 5. Two retries in two sessions at once keep the first save's expiry
-- ===========================================================================
-- Real concurrency needs committed rows and two connections: dblink sessions
-- `a` and `b`, as postgres, on this database. Their rows use their own ids and
-- are deleted at the end (and before, in case an earlier run stopped midway).
create extension if not exists dblink with schema extensions;
create function pg_temp.peer() returns text language sql as $f$
    select format('host=%s port=%s dbname=%s user=postgres password=%s',
        host(inet_server_addr()), inet_server_port(), current_database(), current_setting('cancel_link_test.peer_password'))
$f$;
select set_config('cancel_link_test.peer_password', :'peer_password', true);
select extensions.dblink_connect('a', pg_temp.peer());
select extensions.dblink_connect('b', pg_temp.peer());
select extensions.dblink_exec('a', $q$delete from public.billing_mail_outbox where payload->>'email' = 'race@cancellink.test'$q$);
select extensions.dblink_exec('a', $q$delete from auth.users where id = '11fe0000-5ac0-4000-8000-000000000009'$q$);
select extensions.dblink_exec('a', $q$insert into auth.users (id, email, is_anonymous)
    values ('11fe0000-5ac0-4000-8000-000000000009', 'race@cancellink.test', false)$q$);
insert into t_ids (label, id)
select 'race', id from extensions.dblink('a', $q$select public.enqueue_billing_mail ('cancel_link', null, 'test',
    '{"email": "race@cancellink.test", "origin": "https://cleffy.io"}')$q$) as r(id uuid);
-- A fresh hash every run: this section commits, and a committed token leaves
-- a permanent tombstone when the cleanup below deletes it (20261020160400).
update t_ids t set claim = r.claim_token, hash = md5(random()::text) || md5(random()::text)
from extensions.dblink('a', format($q$select o.claim_token from public.claim_billing_mail (50, interval '2 minutes') o
    where o.id = %L$q$, (select id from t_ids where label = 'race'))) as r(claim_token uuid)
where t.label = 'race';

-- `a` saves first and holds its transaction open: the row is locked.
select extensions.dblink_exec('a', 'begin');
select pg_temp.chk('30 the first retry saves, holding the row',
$q$select r.answer = 'saved' from extensions.dblink('a', format('select public.save_cancel_link_token (%L, %L, %L, %L)',
    (select id from t_ids where label = 'race'), (select claim from t_ids where label = 'race'),
    (select hash from t_ids where label = 'race'), '11fe0000-5ac0-4000-8000-000000000009')) as r(answer text)$q$);
-- `b`, a moment later, saves the same link: it waits for `a`.
select pg_sleep(0.2);
select extensions.dblink_send_query('b', format('select public.save_cancel_link_token (%L, %L, %L, %L)',
    (select id from t_ids where label = 'race'), (select claim from t_ids where label = 'race'),
    (select hash from t_ids where label = 'race'), '11fe0000-5ac0-4000-8000-000000000009'));
select pg_sleep(0.3);
select pg_temp.chk('31 the second retry waits on the first, rather than racing it',
$q$select extensions.dblink_is_busy('b') = 1$q$);
select extensions.dblink_exec('a', 'commit');
select pg_temp.chk('32 ... and once the first commits, it answers saved too',
$q$select r.answer = 'saved' from extensions.dblink_get_result('b') as r(answer text)$q$);
select * from extensions.dblink_get_result('b') as r(answer text);
select pg_temp.chk('33 there is one token, with the expiry the link was asked with',
$q$select r.n = 1 and r.ok from extensions.dblink('a', format($s$select count(*), bool_and(t.expires_at = o.created_at + interval '1 hour'
       and t.expires_at = o.link_expires_at and t.used_at is null)
    from public.billing_cancel_tokens t join public.billing_mail_outbox o on o.id = t.outbox_id
    where t.token_hash = %L$s$, (select hash from t_ids where label = 'race'))) as r(n bigint, ok boolean)$q$);

select extensions.dblink_exec('a', $q$delete from public.billing_mail_outbox where payload->>'email' = 'race@cancellink.test'$q$);
select extensions.dblink_exec('a', $q$delete from auth.users where id = '11fe0000-5ac0-4000-8000-000000000009'$q$);
select pg_temp.chk('34 the race''s rows are gone again',
$q$select r.n = 0 from extensions.dblink('a', format($s$select count(*) from public.billing_cancel_tokens
    where token_hash = %L$s$, (select hash from t_ids where label = 'race'))) as r(n bigint)$q$);
select extensions.dblink_disconnect('a');
select extensions.dblink_disconnect('b');

\o
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
