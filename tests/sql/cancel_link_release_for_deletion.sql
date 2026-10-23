-- Behaviour proof for release_cancel_link_token_for_deletion and the token
-- guard's one exception (migration 20261022160000_cancel_link_release_for_deletion.sql;
-- launch-fix item 16, Codex r1 finding 3 on #73, decision 72(1)): a cancel
-- link spent just as its account's deletion began is put back unspent, so an
-- abandoned deletion leaves a link that still cancels -- and nothing else can
-- un-spend a link.
--
--   1. while the account is clear the release changes nothing; once a
--      deletion attempt is live it puts the spent link back unspent, the link
--      reads as good again, keeps its expiry, and can be spent again; a link
--      already unspent stays so; another account's link and an unknown hash
--      are left alone; once the attempt is abandoned the release changes
--      nothing again;
--   2. the guard still refuses every other un-spend: a direct UPDATE by the
--      service role (also in a session that never set the release's setting,
--      which reads NULL) or the table's owner, one under a setting that names
--      another link, and -- since the guard asks account_deletion_pending()
--      itself (Codex r2 finding 3 on #73) -- one under a setting that names
--      the link's own hash while its account is clear; the setting is cleared
--      before the release returns, and lets nothing else through (an expiry
--      moved later is still refused);
--   3. only the service role may call it; it is SECURITY DEFINER with its
--      search_path pinned; it asks account_deletion_pending() before it takes
--      the link's history locks, and writes in one UPDATE;
--   4. keep_cancel_link_refund_request (Codex r2 finding 2 on #73): a link
--      starts with no refund request; the first one asked is kept and every
--      later call answers with it, whatever it asks; nothing changes it once
--      kept, the service role's direct UPDATE included; keeping it neither
--      spends the link nor moves its expiry; only the service role may call
--      it, SECURITY DEFINER with its search_path pinned; read_cancel_link_token
--      answers with the kept request beside the link's account and mode, and
--      as before for a link with none (Codex r3 on #73).
--
-- One transaction, ROLLED BACK. Run it against the LOCAL stack
-- (scripts/ci/sql-proof.sh does, in CI):
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/cancel_link_release_for_deletion.sql
--
-- Every row of the result table should read `t`; the last line is
-- `failures | total`.
\set ON_ERROR_STOP on
\o /dev/null
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create temp table t_ids (label text primary key, id uuid, claim uuid, hash text, v text);
grant all on t_ids to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('c05e0000-7e1e-4000-8000-00000000000' || n)::uuid $f$;
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
create function pg_temp.h(p_label text) returns text language sql volatile as $f$ select hash from t_ids where label = p_label $f$;
create function pg_temp.used(p_label text) returns timestamptz language sql volatile as $f$
    select used_at from public.billing_cancel_tokens where token_hash = pg_temp.h(p_label) $f$;
create function pg_temp.release(p_label text) returns text language sql volatile as $f$
    select public.release_cancel_link_token_for_deletion (pg_temp.h(p_label))->>'answer' $f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- u(1): the account whose deletion begins; u(2): another account, clear.
insert into auth.users (id, email, is_anonymous)
values (pg_temp.u(1), 'deleting@release-for-deletion.test', false),
       (pg_temp.u(2), 'other@release-for-deletion.test', false);
update public.billing_mail_outbox set next_attempt_at = now() + interval '1 day' where status = 'pending';

select pg_temp.as_role('service_role');
insert into t_ids (label, id, hash)
select l, public.enqueue_billing_mail ('cancel_link', null, 'test',
        jsonb_build_object('email', case when l = 'other' then 'other' else 'deleting' end || '@release-for-deletion.test',
                           'origin', 'https://cleffy.io')),
       pg_temp.random_hash()
from unnest(array['spent', 'unspent', 'other']) l;
update t_ids t set claim = c.claim_token
from public.claim_billing_mail (50, interval '2 minutes') c where c.id = t.id;
select pg_temp.chk('01 (three links saved: two for the account being deleted, one for another)',
$q$select bool_and(public.save_cancel_link_token_v2 (id, claim, hash,
          case when label = 'other' then pg_temp.u(2) else pg_temp.u(1) end)->>'answer' = 'saved')
   from t_ids where label in ('spent', 'unspent', 'other')$q$);
select pg_temp.chk('02 (the cancel page spends two of them while both accounts are clear)',
$q$select public.consume_cancel_link_token (pg_temp.h('spent'))->>'answer' = 'consumed'
      and public.consume_cancel_link_token (pg_temp.h('other'))->>'answer' = 'consumed'$q$);
insert into t_ids (label, v)
select 'spent_expiry', expires_at::text from public.billing_cancel_tokens where token_hash = pg_temp.h('spent');

-- Before anything in this session has set cleffy.cancel_link_release, as in
-- every PostgREST session: current_setting() reads NULL, which must not let
-- the un-spend through.
select pg_temp.chk('02b (the setting has never been set in this session)',
$q$select current_setting('cleffy.cancel_link_release', true) is null$q$);
select pg_temp.refused('02c ... and the service role''s direct UPDATE still cannot un-spend a link',
$q$update public.billing_cancel_tokens set used_at = null where token_hash = pg_temp.h('other')$q$,
'55000', 'a spent cancel link stays spent');

-- ===========================================================================
-- 1. What the release does
-- ===========================================================================
select pg_temp.chk('03 the account is clear: answered clear, and the link stays spent',
$q$select pg_temp.release('spent') = 'clear' and pg_temp.used('spent') is not null$q$);

insert into t_ids (label, v) values ('attempt', public.begin_account_deletion_attempt (pg_temp.u(1))::text);
select pg_temp.chk('04 (a deletion attempt is live: account_deletion_pending() is true)',
$q$select public.account_deletion_pending (pg_temp.u(1))$q$);
select pg_temp.chk('05 being deleted: answered released, and the link is unspent',
$q$select pg_temp.release('spent') = 'released'$q$);
select pg_temp.chk('05b ... used_at is null again',
$q$select pg_temp.used('spent') is null$q$);
select pg_temp.chk('06 it reads as good again, as the cancel page reads it',
$q$select public.read_cancel_link_token (pg_temp.h('spent')) is not null$q$);
select pg_temp.chk('07 it keeps its expiry',
$q$select expires_at::text = (select v from t_ids where label = 'spent_expiry')
   from public.billing_cancel_tokens where token_hash = pg_temp.h('spent')$q$);
select pg_temp.chk('08 asked again: still released, still unspent',
$q$select pg_temp.release('spent') = 'released' and pg_temp.used('spent') is null$q$);
select pg_temp.chk('09 a link of the same account that was never spent: released, and unspent as it was',
$q$select pg_temp.release('unspent') = 'released' and pg_temp.used('unspent') is null$q$);
select pg_temp.chk('10 another account''s spent link: answered clear, and it stays spent',
$q$select pg_temp.release('other') = 'clear' and pg_temp.used('other') is not null$q$);
select pg_temp.chk('11 an unknown hash: not_found',
$q$select public.release_cancel_link_token_for_deletion (repeat('0', 64)) = jsonb_build_object('answer', 'not_found')$q$);
select pg_temp.chk('12 the released link can be spent again, once',
$q$select public.consume_cancel_link_token (pg_temp.h('spent'))->>'answer' = 'consumed'
      and public.consume_cancel_link_token (pg_temp.h('spent'))->>'answer' = 'used'$q$);

select public.settle_account_deletion_attempt (pg_temp.u(1), (select v::uuid from t_ids where label = 'attempt'), 'abandoned');
select pg_temp.chk('13 abandoned: answered clear, and the link spent since stays spent',
$q$select not public.account_deletion_pending (pg_temp.u(1))
      and pg_temp.release('spent') = 'clear' and pg_temp.used('spent') is not null$q$);

-- ===========================================================================
-- 2. The guard: no other un-spend
-- ===========================================================================
select pg_temp.refused('20 the service role''s direct UPDATE cannot un-spend a link',
$q$update public.billing_cancel_tokens set used_at = null where token_hash = pg_temp.h('other')$q$,
'55000', 'a spent cancel link stays spent');
reset role;
select pg_temp.refused('21 nor can the table''s owner',
$q$update public.billing_cancel_tokens set used_at = null where token_hash = pg_temp.h('other')$q$,
'55000', 'a spent cancel link stays spent');
select pg_temp.refused('22 nor an UPDATE under a setting that names another link',
$q$select set_config('cleffy.cancel_link_release', pg_temp.h('spent'), true);
   update public.billing_cancel_tokens set used_at = null where token_hash = pg_temp.h('other')$q$,
'55000', 'a spent cancel link stays spent');
select set_config('cleffy.cancel_link_release', '', true);
select pg_temp.refused('23 the setting lets nothing else through: an expiry moved later is still refused',
$q$select set_config('cleffy.cancel_link_release', pg_temp.h('other'), true);
   update public.billing_cancel_tokens set expires_at = expires_at + interval '1 day' where token_hash = pg_temp.h('other')$q$,
'55000', 'a saved cancel link keeps its expiry');
select set_config('cleffy.cancel_link_release', '', true);
-- Codex r2 finding 3 on #73: the setting is the caller's to set, so a
-- matching one alone is no authority. The guard asks account_deletion_pending()
-- itself: on a clear account, a direct UPDATE under the link's own hash is
-- refused like any other.
select pg_temp.as_role('service_role');
select pg_temp.refused('23b a matching setting on a clear account: the service role''s direct UPDATE is still refused',
$q$select set_config('cleffy.cancel_link_release', pg_temp.h('spent'), true);
   update public.billing_cancel_tokens set used_at = null where token_hash = pg_temp.h('spent')$q$,
'55000', 'a spent cancel link stays spent');
select set_config('cleffy.cancel_link_release', '', true);
select pg_temp.refused('23c ... and another clear account''s link under its own hash too',
$q$select set_config('cleffy.cancel_link_release', pg_temp.h('other'), true);
   update public.billing_cancel_tokens set used_at = null where token_hash = pg_temp.h('other')$q$,
'55000', 'a spent cancel link stays spent');
select set_config('cleffy.cancel_link_release', '', true);
select pg_temp.chk('23d (both links are still spent)',
$q$select pg_temp.used('spent') is not null and pg_temp.used('other') is not null$q$);
reset role;
select pg_temp.refused('23e nor the table''s owner, under the matching setting',
$q$select set_config('cleffy.cancel_link_release', pg_temp.h('spent'), true);
   update public.billing_cancel_tokens set used_at = null where token_hash = pg_temp.h('spent')$q$,
'55000', 'a spent cancel link stays spent');
select set_config('cleffy.cancel_link_release', '', true);
select pg_temp.as_role('service_role');
insert into t_ids (label, v) values ('attempt2', public.begin_account_deletion_attempt (pg_temp.u(1))::text);
select pg_temp.chk('24 the release clears its setting before it returns',
$q$select pg_temp.release('spent') = 'released'
      and coalesce(current_setting('cleffy.cancel_link_release', true), '') = ''$q$);
select pg_temp.chk('25 (the released link is spent again)',
$q$select public.consume_cancel_link_token (pg_temp.h('spent'))->>'answer' = 'consumed'$q$);
select pg_temp.refused('25b ... and a direct UPDATE un-spending it is refused as before',
$q$update public.billing_cancel_tokens set used_at = null where token_hash = pg_temp.h('spent')$q$,
'55000', 'a spent cancel link stays spent');
reset role;

-- ===========================================================================
-- 3. The service role's alone, pinned, deletion lock first, one UPDATE
-- ===========================================================================
select pg_temp.as_role('authenticated');
select pg_temp.refused('30 a signed-in client cannot call it',
$q$select public.release_cancel_link_token_for_deletion (repeat('a', 64))$q$, '42501');
reset role;
select pg_temp.as_role('anon');
select pg_temp.refused('31 nor an anonymous one',
$q$select public.release_cancel_link_token_for_deletion (repeat('a', 64))$q$, '42501');
reset role;
select pg_temp.chk('32 only the service role may: no PUBLIC, anon or authenticated EXECUTE',
$q$select has_function_privilege('service_role', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute')
      and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
   from pg_proc p where p.oid = 'public.release_cancel_link_token_for_deletion(text)'::regprocedure$q$);
select pg_temp.chk('33 SECURITY DEFINER, with search_path pinned empty',
$q$select p.prosecdef and p.proconfig @> array['search_path=""']
   from pg_proc p where p.oid = 'public.release_cancel_link_token_for_deletion(text)'::regprocedure$q$);
select pg_temp.chk('34 it asks account_deletion_pending() before the history locks, and those before its one UPDATE',
$q$select position('public.account_deletion_pending (v_user)' in s) between 1 and position('public.billing_cancel_link_lock (v_outbox, p_hash)' in s)
      and position('public.billing_cancel_link_lock (v_outbox, p_hash)' in s) < position('update public.billing_cancel_tokens' in s)
      and (length(s) - length(replace(s, 'update public.billing_cancel_tokens', ''))) / length('update public.billing_cancel_tokens') = 1
   from (select prosrc s from pg_proc where oid = 'public.release_cancel_link_token_for_deletion(text)'::regprocedure) p$q$);

-- ===========================================================================
-- 4. The refund request kept with the link
-- ===========================================================================
create function pg_temp.keep(p_label text, p_request jsonb) returns jsonb language sql volatile as $f$
    select public.keep_cancel_link_refund_request (pg_temp.h(p_label), p_request) $f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;
select pg_temp.as_role('service_role');
select pg_temp.chk('40 a saved link starts with no refund request',
$q$select bool_and(refund_request is null) from public.billing_cancel_tokens
   where token_hash in (select hash from t_ids where hash is not null)$q$);
select pg_temp.chk('40b ... and read_cancel_link_token answers for it with its account and mode alone',
$q$select public.read_cancel_link_token (pg_temp.h('unspent')) - 'mode' = jsonb_build_object('user_id', pg_temp.u(1))
      and public.read_cancel_link_token (pg_temp.h('unspent')) ? 'mode'$q$);
select pg_temp.chk('41 the first request is kept, and answered',
$q$select pg_temp.keep('unspent', '{"subject":"one","text":"Plan: Teacher","html":"<p>one</p>","replyTo":"a@x.test"}')
      = jsonb_build_object('answer', 'kept', 'request',
          '{"subject":"one","text":"Plan: Teacher","html":"<p>one</p>","replyTo":"a@x.test"}'::jsonb)$q$);
select pg_temp.chk('42 a later call asking another one is answered with the first, and writes nothing',
$q$select pg_temp.keep('unspent', '{"subject":"two","text":"Plan: Studio","html":"<p>two</p>","replyTo":"b@x.test"}')->'request'->>'replyTo' = 'a@x.test'
      and (select refund_request->>'subject' from public.billing_cancel_tokens where token_hash = pg_temp.h('unspent')) = 'one'$q$);
select pg_temp.refused('43 the service role''s direct UPDATE cannot change a kept request',
$q$update public.billing_cancel_tokens set refund_request = '{"subject":"two"}' where token_hash = pg_temp.h('unspent')$q$,
'55000', 'a cancel link keeps the refund request it first sent');
select pg_temp.refused('44 ... nor clear it',
$q$update public.billing_cancel_tokens set refund_request = null where token_hash = pg_temp.h('unspent')$q$,
'55000', 'a cancel link keeps the refund request it first sent');
select pg_temp.chk('45 keeping it neither spent the link nor moved its expiry',
$q$select pg_temp.used('unspent') is null and public.read_cancel_link_token (pg_temp.h('unspent')) is not null$q$);
select pg_temp.chk('45b read_cancel_link_token answers with the request kept first, beside its account and mode (Codex r3 on #73)',
$q$select public.read_cancel_link_token (pg_temp.h('unspent'))->'refund_request'
          = '{"subject":"one","text":"Plan: Teacher","html":"<p>one</p>","replyTo":"a@x.test"}'::jsonb
      and public.read_cancel_link_token (pg_temp.h('unspent')) - 'refund_request' - 'mode' = jsonb_build_object('user_id', pg_temp.u(1))$q$);
select pg_temp.chk('46 a spent link keeps one too, and stays spent',
$q$select pg_temp.keep('other', '{"subject":"o","text":"o","html":"o","replyTo":"o@x.test"}')->>'answer' = 'kept'
      and pg_temp.used('other') is not null$q$);
select pg_temp.chk('47 an unknown hash: not_found',
$q$select public.keep_cancel_link_refund_request (repeat('0', 64), '{"subject":"x"}') = jsonb_build_object('answer', 'not_found')$q$);
select pg_temp.refused('48 a request that is not a JSON object is refused',
$q$select pg_temp.keep('spent', '"text"')$q$, '22023');
reset role;
select pg_temp.as_role('authenticated');
select pg_temp.refused('49 a signed-in client cannot call it',
$q$select public.keep_cancel_link_refund_request (repeat('a', 64), '{}')$q$, '42501');
reset role;
select pg_temp.as_role('anon');
select pg_temp.refused('49b nor an anonymous one',
$q$select public.keep_cancel_link_refund_request (repeat('a', 64), '{}')$q$, '42501');
reset role;
select pg_temp.chk('49c only the service role may; SECURITY DEFINER, with search_path pinned empty',
$q$select has_function_privilege('service_role', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute')
      and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
      and p.prosecdef and p.proconfig @> array['search_path=""']
   from pg_proc p where p.oid = 'public.keep_cancel_link_refund_request(text, jsonb)'::regprocedure$q$);

\o
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
