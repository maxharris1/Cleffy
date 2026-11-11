-- Behaviour proof for 20261020160400_cancel_link_tombstones_db_clock.sql (and
-- 20261020160500, which moves its save to save_cancel_link_token_v2), the
-- tombstone half (Codex round 5 on #62, new major 1; decision 29): a cancel
-- link that was spent or deleted can never come back, whoever writes.
--
--   1. the cleanup that deletes an expired token writes its tombstone -- the
--      hash and the outbox id, nothing else -- in the same statement;
--   2. a direct insert of that hash against a NEW pending cancel-link row is
--      refused: the service role may not insert tokens at all any more, and
--      the table's owner, which may, is refused by the tombstone trigger;
--   3. a request re-created under the deleted row's id (the same HMAC) cannot
--      save that link -- or any other -- through save_cancel_link_token_v2, which
--      settles the row for good instead, and a direct insert for that id is
--      refused too;
--   4. an account's deletion tombstones its links as well;
--   5. a tombstone is permanent: nobody may update, delete or truncate one,
--      and only the SECURITY DEFINER functions write them; tokens can no
--      longer be truncated (which would skip the tombstones).
--
-- Everything runs inside one transaction and ROLLS BACK. Run it against the
-- LOCAL stack (scripts/ci/sql-proof.sh does, in CI):
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/cancel_link_tombstones.sql
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
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('7e5b0000-5ac0-4000-8000-00000000000' || n)::uuid $f$;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
-- Refused with this SQLSTATE and, when given, a message containing p_message:
-- which guard said no, not just that something did.
create function pg_temp.refused(p_name text, p_sql text, p_state text, p_message text default null) returns void language plpgsql as $f$
declare v_state text; v_text text;
begin
execute p_sql;
insert into t_results values (p_name, false, 'no error raised');
exception when others then
get stacked diagnostics v_state = returned_sqlstate, v_text = message_text;
insert into t_results values (p_name, v_state = p_state and (p_message is null or strpos(v_text, p_message) > 0), v_state || ' ' || v_text);
end $f$;
create function pg_temp.as_service() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
perform set_config('role', 'service_role', true);
end $f$;
-- save_cancel_link_token_v2's answer (or, before it existed, the old save's).
create function pg_temp.answer(p_label text, p_hash text default null) returns text language plpgsql as $f$
declare v jsonb;
begin
execute 'select public.save_cancel_link_token_v2 ($1, $2, $3, $4)'
    into v using (select id from t_ids where label = p_label), (select claim from t_ids where label = p_label),
    coalesce(p_hash, (select hash from t_ids where label = p_label)), pg_temp.u(1);
return coalesce(v->>'answer', v #>> '{}');
end $f$;
-- Leases a due row the way claim_billing_mail does for a worker.
create function pg_temp.claim(p_label text) returns void language plpgsql as $f$
begin
update public.billing_mail_outbox set next_attempt_at = now() - interval '1 second', claimed_until = null
where id = (select id from t_ids where label = p_label);
update t_ids t set claim = c.claim_token
from public.claim_billing_mail (50, interval '2 minutes') c where c.id = t.id and t.label = p_label;
end $f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

insert into auth.users (id, email, is_anonymous) values
    (pg_temp.u(1), 'tombstone@cancellink.test', false),
    (pg_temp.u(2), 'leaving@tombstone.test', false);
-- Nothing else in this database is due while the proofs below run.
update public.billing_mail_outbox set next_attempt_at = now() + interval '1 day' where status = 'pending';

-- ===========================================================================
-- 1. The cleanup tombstones what it deletes
-- ===========================================================================
select pg_temp.as_service();
insert into t_ids (label, id, hash)
select 'gone', public.enqueue_billing_mail ('cancel_link', null, 'test', '{"email": "tombstone@cancellink.test", "origin": "https://cleffy.io"}'),
    repeat('7', 64);
select pg_temp.claim('gone');
select pg_temp.chk('01 the link is saved', $q$select pg_temp.answer('gone') = 'saved'$q$);
select pg_temp.chk('02 ... and sent',
$q$select public.settle_billing_mail ((select id from t_ids where label = 'gone'), (select claim from t_ids where label = 'gone'), 'sent')$q$);
select pg_temp.chk('02b ... which deletes its row',
$q$select not exists (select 1 from public.billing_mail_outbox where id = (select id from t_ids where label = 'gone'))$q$);
select pg_temp.chk('03 the customer spends it',
$q$with spent as (update public.billing_cancel_tokens set used_at = now()
    where token_hash = (select hash from t_ids where label = 'gone') and used_at is null returning 1)
    select count(*) = 1 from spent$q$);
-- Its hour runs out (brought forward: now() is fixed inside this transaction).
update public.billing_cancel_tokens set expires_at = now() - interval '1 second'
where token_hash = (select hash from t_ids where label = 'gone');
reset role;
select pg_temp.chk('04 the cleanup runs',
$q$select true from (select public.billing_mail_outbox_tick ()) t$q$);
select pg_temp.chk('05 ... the token is gone',
$q$select not exists (select 1 from public.billing_cancel_tokens where token_hash = (select hash from t_ids where label = 'gone'))$q$);
select pg_temp.chk('06 ... and its tombstone holds its hash and its row',
$q$select count(*) = 1 and bool_and(outbox_id = (select id from t_ids where label = 'gone') and deleted_at = now())
   from public.billing_cancel_token_tombstones where token_hash = (select hash from t_ids where label = 'gone')$q$);
select pg_temp.chk('07 a tombstone holds nothing else: no user, no address, no mode',
$q$select array_agg(column_name::text order by column_name) = array['deleted_at', 'outbox_id', 'token_hash']
   from information_schema.columns where table_schema = 'public' and table_name = 'billing_cancel_token_tombstones'$q$);

-- ===========================================================================
-- 2. The deleted hash cannot be inserted against a new pending row
-- ===========================================================================
select pg_temp.as_service();
insert into t_ids (label, id)
select 'fresh', public.enqueue_billing_mail ('cancel_link', null, 'test', '{"email": "tombstone@cancellink.test", "origin": "https://cleffy.io"}');
select pg_temp.chk('10 the new request is pending, with an hour to go',
$q$select status = 'pending' and link_expires_at > now() + interval '59 minutes'
   from public.billing_mail_outbox where id = (select id from t_ids where label = 'fresh')$q$);
select pg_temp.refused('11 the service role cannot insert the deleted hash against it',
$q$insert into public.billing_cancel_tokens (token_hash, user_id, mode, expires_at, outbox_id)
   values ((select hash from t_ids where label = 'gone'), pg_temp.u(1), 'test', now() + interval '1 hour',
           (select id from t_ids where label = 'fresh'))$q$, '42501');
select pg_temp.refused('12 ... nor upsert it, the way the store once did',
$q$insert into public.billing_cancel_tokens (token_hash, user_id, mode, expires_at, outbox_id)
   values ((select hash from t_ids where label = 'gone'), pg_temp.u(1), 'test', now() + interval '1 hour',
           (select id from t_ids where label = 'fresh'))
   on conflict (token_hash) do update set used_at = null$q$, '42501');
reset role;
-- The table's owner keeps INSERT (the save runs as it), so the
-- trigger is what stands in its way.
select pg_temp.refused('13 the table''s owner is refused by the tombstone',
$q$insert into public.billing_cancel_tokens (token_hash, user_id, mode, expires_at, outbox_id)
   values ((select hash from t_ids where label = 'gone'), pg_temp.u(1), 'test', now() + interval '1 hour',
           (select id from t_ids where label = 'fresh'))$q$, '55000', 'never comes back');
select pg_temp.refused('14 ... with no row named at all',
$q$insert into public.billing_cancel_tokens (token_hash, user_id, mode, expires_at)
   values ((select hash from t_ids where label = 'gone'), pg_temp.u(1), 'test', now() + interval '1 hour')$q$, '55000');
select pg_temp.chk('15 the spent link never works again',
$q$select not exists (select 1 from public.billing_cancel_tokens where token_hash = (select hash from t_ids where label = 'gone'))$q$);

-- ===========================================================================
-- 3. A request re-created under the deleted row's id cannot save the link
-- ===========================================================================
select pg_temp.as_service();
-- billingCancelStore.ts cancelLinkToken is HMAC(secret, row id): the same id
-- is the same link.
insert into public.billing_mail_outbox (id, kind, mode, payload)
values ((select id from t_ids where label = 'gone'), 'cancel_link', 'test',
        '{"email": "tombstone@cancellink.test", "origin": "https://cleffy.io"}');
select pg_temp.claim('gone');
select pg_temp.chk('20 the re-created request is leased like any other',
$q$select claim is not null from t_ids where label = 'gone'$q$);
select pg_temp.chk('21 saving its link is refused as spent',
$q$select pg_temp.answer('gone') = 'spent'$q$);
select pg_temp.chk('22 ... nothing is saved',
$q$select not exists (select 1 from public.billing_cancel_tokens where token_hash = (select hash from t_ids where label = 'gone'))$q$);
select pg_temp.chk('23 ... and the row is settled for good, without its address',
$q$select status = 'expired' and not (payload ? 'email') and last_error = 'cancel link already spent or removed'
   from public.billing_mail_outbox where id = (select id from t_ids where label = 'gone')$q$);
select pg_temp.chk('24 ... which the worker then records',
$q$select public.settle_billing_mail ((select id from t_ids where label = 'gone'),
    (select claim from t_ids where label = 'gone'), 'expired', 'cancel link already spent or removed')$q$);
select pg_temp.chk('25 ... and it is never handed out again',
$q$select not exists (select 1 from public.claim_billing_mail (50, interval '2 minutes')
    where id = (select id from t_ids where label = 'gone'))$q$);

-- The outbox id is tombstoned as well as the hash: a DIFFERENT hash for that
-- id is refused too. The `gone` row is settled now, so this needs a pending
-- row of its own: a request whose tombstone (by id) is planted the way the
-- cleanup would have left it.
reset role;
insert into t_ids (label, id, hash)
select 'reused', gen_random_uuid(), repeat('8', 64);
insert into public.billing_mail_outbox (id, kind, mode, payload)
values ((select id from t_ids where label = 'reused'), 'cancel_link', 'test', '{"origin": "https://cleffy.io"}');
select pg_temp.chk('26 (its row id tombstoned, as the cleanup leaves it)',
$q$with planted as (insert into public.billing_cancel_token_tombstones (token_hash, outbox_id)
    values (repeat('9', 64), (select id from t_ids where label = 'reused')) returning 1) select count(*) = 1 from planted$q$);
select pg_temp.refused('27 a different hash for a tombstoned row id is refused too',
$q$insert into public.billing_cancel_tokens (token_hash, user_id, mode, expires_at, outbox_id)
   values ((select hash from t_ids where label = 'reused'), pg_temp.u(1), 'test', now() + interval '1 hour',
           (select id from t_ids where label = 'reused'))$q$, '55000', 'never comes back');
select pg_temp.as_service();
select pg_temp.claim('reused');
select pg_temp.chk('28 ... and through the save, under a lease',
$q$select pg_temp.answer('reused') = 'spent'
   and not exists (select 1 from public.billing_cancel_tokens where outbox_id = (select id from t_ids where label = 'reused'))$q$);
reset role;

-- ===========================================================================
-- 4. Deleting an account tombstones its links
-- ===========================================================================
select pg_temp.as_service();
insert into t_ids (label, id, hash)
select 'leaving', public.enqueue_billing_mail ('cancel_link', null, 'test', '{"email": "leaving@tombstone.test", "origin": "https://cleffy.io"}'),
    repeat('6', 64);
select pg_temp.claim('leaving');
select pg_temp.chk('30 a waiting request''s link is saved',
$q$select public.save_cancel_link_token_v2 ((select id from t_ids where label = 'leaving'),
    (select claim from t_ids where label = 'leaving'), (select hash from t_ids where label = 'leaving'), pg_temp.u(2))->>'answer' = 'saved'$q$);
reset role;
select pg_temp.chk('31 the account is deleted, and its link with it',
$q$with gone as (delete from auth.users where id = pg_temp.u(2) returning 1) select count(*) = 1 from gone$q$);
select pg_temp.chk('32 ... leaving a tombstone',
$q$select exists (select 1 from public.billing_cancel_token_tombstones
    where token_hash = (select hash from t_ids where label = 'leaving') and outbox_id = (select id from t_ids where label = 'leaving'))$q$);

-- ===========================================================================
-- 5. Tombstones are permanent; tokens are written only through the save
-- ===========================================================================
select pg_temp.refused('40 the owner cannot change a tombstone',
$q$update public.billing_cancel_token_tombstones set token_hash = repeat('5', 64)
   where token_hash = (select hash from t_ids where label = 'gone')$q$, '55000', 'permanent');
select pg_temp.refused('41 ... or delete one',
$q$delete from public.billing_cancel_token_tombstones where token_hash = (select hash from t_ids where label = 'gone')$q$, '55000', 'permanent');
select pg_temp.refused('42 ... or truncate them',
$q$truncate public.billing_cancel_token_tombstones$q$, '55000', 'permanent');
select pg_temp.refused('43 tokens cannot be truncated, which would skip their tombstones',
$q$truncate public.billing_cancel_tokens$q$, '55000');
select pg_temp.as_service();
select pg_temp.refused('44 the service role cannot write a tombstone',
$q$insert into public.billing_cancel_token_tombstones (token_hash, outbox_id) values (repeat('4', 64), null)$q$, '42501');
select pg_temp.refused('45 ... or remove one',
$q$delete from public.billing_cancel_token_tombstones where token_hash = (select hash from t_ids where label = 'gone')$q$, '42501');
select pg_temp.chk('46 ... but it can read them',
$q$select count(*) >= 2 from public.billing_cancel_token_tombstones$q$);
reset role;
select pg_temp.chk('47 nobody but the owner may insert, update, delete or truncate a tombstone',
$q$select bool_and(not has_table_privilege(r, 'public.billing_cancel_token_tombstones', p))
   from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['insert', 'update', 'delete', 'truncate']) p$q$);
select pg_temp.chk('48 ... and clients cannot even read them',
$q$select not has_table_privilege('anon', 'public.billing_cancel_token_tombstones', 'select')
   and not has_table_privilege('authenticated', 'public.billing_cancel_token_tombstones', 'select')
   and (select relrowsecurity from pg_class where oid = 'public.billing_cancel_token_tombstones'::regclass)$q$);
select pg_temp.chk('49 the service role no longer inserts or truncates tokens, and still reads, spends and deletes them',
$q$select not has_table_privilege('service_role', 'public.billing_cancel_tokens', 'insert')
   and not has_table_privilege('service_role', 'public.billing_cancel_tokens', 'truncate')
   and has_table_privilege('service_role', 'public.billing_cancel_tokens', 'select')
   and has_table_privilege('service_role', 'public.billing_cancel_tokens', 'update')
   and has_table_privilege('service_role', 'public.billing_cancel_tokens', 'delete')$q$);
select pg_temp.chk('50 both saves run as the owner, with search_path pinned, for the service role alone',
$q$select count(*) = 2 and bool_and(p.prosecdef and p.proconfig @> array['search_path=""']
   and has_function_privilege('service_role', p.oid, 'execute')
   and not has_function_privilege('authenticated', p.oid, 'execute')
   and not has_function_privilege('anon', p.oid, 'execute'))
   from pg_proc p where p.oid in ('public.save_cancel_link_token_v2(uuid, uuid, text, uuid)'::regprocedure,
       'public.save_cancel_link_token(uuid, uuid, text, uuid)'::regprocedure)$q$);
select pg_temp.chk('51 the tombstone triggers: search_path pinned empty, nobody may call them',
$q$select count(*) = 3 and bool_and(p.proconfig @> array['search_path=""']
    and not has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute')
    and not has_function_privilege('service_role', p.oid, 'execute'))
   from pg_proc p where p.oid in ('public.billing_cancel_tokens_tombstone()'::regprocedure,
       'public.billing_cancel_tokens_not_tombstoned()'::regprocedure,
       'public.billing_cancel_link_history_kept()'::regprocedure)$q$);

\o
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
