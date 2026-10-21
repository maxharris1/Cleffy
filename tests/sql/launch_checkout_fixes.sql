-- Behaviour proof for the launch-checkout fix pass (Codex review of #62):
--
--   20261020160100_checkout_attempt_replay_inputs.sql -- a staged checkout
--   attempt keeps the consent and parameter fingerprint its replay must
--   reproduce, and loses them with the key.
--
--   20261020160200_billing_mail_outbox.sql -- billing mail is written down once
--   per Stripe object, claimed under a lease that expires (so a worker that
--   dies holding a row only delays it), settled only by the lease holder,
--   retried after a backoff, and a cancel-link request's address is deleted
--   once handled. No client role can touch any of it.
--
-- Runs inside one transaction and ROLLS BACK -- nothing persists. Same harness
-- and reading as tests/sql/checkout_consents.sql:
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/launch_checkout_fixes.sql
--
-- Every row of the result table should read `t`; the last line is
-- `failures | total`. Run it against a local or branch database.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create temp table t_attempts (label text primary key, holder uuid);
grant all on t_attempts to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('f1c5e000-5ac0-4000-8000-00000000000' || n)::uuid $f$;
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
create function pg_temp.as_user(n int) returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(n), 'role', 'authenticated')::text, true);
perform set_config('role', 'authenticated', true);
end $f$;
create function pg_temp.as_anon() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
perform set_config('role', 'anon', true);
end $f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

insert into auth.users (id, email, is_anonymous) values (pg_temp.u(1), 'replay@checkoutfix.test', false);

-- ===========================================================================
-- 1. A staged attempt keeps its replay inputs, and loses them with the key
-- ===========================================================================
select pg_temp.as_service();
insert into t_attempts
select 'first', holder from public.begin_checkout_attempt (pg_temp.u(1), 'live', interval '5 minutes');

select pg_temp.chk('01 staging stores the consent id and the parameter fingerprint',
$q$select public.stage_checkout_attempt (
    p_user => pg_temp.u(1), p_mode => 'live',
    p_holder => (select holder from t_attempts where label = 'first'),
    p_attempt_id => '33333333-0000-4000-8000-000000000001', p_price_id => 'price_teacher_annual|usd',
    p_consent_id => '44444444-0000-4000-8000-000000000001', p_params_hash => repeat('a', 64)
)$q$);

-- The isolate dies holding the lease; the next request takes it over once stale.
update public.checkout_attempts set claimed_at = now() - interval '1 hour' where user_id = pg_temp.u(1);

select pg_temp.chk('02 the attempt after a death reads both back beside the key',
$q$select attempt_id = '33333333-0000-4000-8000-000000000001'
      and session_id is null
      and consent_id = '44444444-0000-4000-8000-000000000001'
      and params_hash = repeat('a', 64)
   from public.begin_checkout_attempt (pg_temp.u(1), 'live', interval '5 minutes')$q$);

-- (Each write and the read of its effect are separate statements: a subquery
-- in the same statement reads the snapshot from before the call.)
select pg_temp.chk('03 a five-argument stage (a function deployed before the migration) still stages',
$q$select public.stage_checkout_attempt (
    pg_temp.u(1), 'live',
    (select holder from public.checkout_attempts where user_id = pg_temp.u(1)),
    '33333333-0000-4000-8000-000000000002', 'price_teacher_annual|usd'
)$q$);
select pg_temp.chk('04 ... and stages no replay inputs, so that key is never replayed',
$q$select consent_id is null and params_hash is null and attempt_id = '33333333-0000-4000-8000-000000000002'
   from public.checkout_attempts where user_id = pg_temp.u(1)$q$);

select pg_temp.chk('05 re-staging with inputs',
$q$select public.stage_checkout_attempt (
    p_user => pg_temp.u(1), p_mode => 'live',
    p_holder => (select holder from public.checkout_attempts where user_id = pg_temp.u(1)),
    p_attempt_id => '33333333-0000-4000-8000-000000000003', p_price_id => 'price_teacher_annual|usd',
    p_consent_id => '44444444-0000-4000-8000-000000000003', p_params_hash => repeat('b', 64)
)$q$);
select pg_temp.chk('06 then recording the session',
$q$select public.finish_checkout_attempt (
    pg_temp.u(1), 'live',
    (select holder from public.checkout_attempts where user_id = pg_temp.u(1)),
    '33333333-0000-4000-8000-000000000003', 'price_teacher_annual|usd', 'cs_test_recorded'
)$q$);
select pg_temp.chk('07 ... clears the replay inputs with the key',
$q$select consent_id is null and params_hash is null and session_id = 'cs_test_recorded' and holder is null
   from public.checkout_attempts where user_id = pg_temp.u(1)$q$);

-- ===========================================================================
-- 2. The billing mail outbox
-- ===========================================================================
create temp table t_mail (label text primary key, id uuid, claim uuid);
grant all on t_mail to anon, authenticated, service_role;
-- Nothing else in this database is due while the proofs below run.
update public.billing_mail_outbox set next_attempt_at = now() + interval '1 day' where status = 'pending';

select pg_temp.chk('20 a confirmation is written down',
$q$with q as (insert into t_mail (label, id)
    select 'purchase', public.enqueue_billing_mail ('purchase_confirmation', 'cs_fix_1', 'test', '{"userId": "x"}')
    returning id) select id is not null from q$q$);
select pg_temp.chk('21 a redelivery writes nothing new, and is answered with the same row',
$q$select public.enqueue_billing_mail ('purchase_confirmation', 'cs_fix_1', 'test', '{"userId": "x"}')
    = (select id from t_mail where label = 'purchase')$q$);
select pg_temp.chk('22 ... so there is exactly one',
$q$select count(*) = 1 from public.billing_mail_outbox where kind = 'purchase_confirmation' and dedupe_key = 'cs_fix_1'$q$);
select pg_temp.chk('23 cancel-link requests are not de-duplicated here (the worker limits per recipient)',
$q$with q as (insert into t_mail (label, id)
    select 'link-' || n, public.enqueue_billing_mail ('cancel_link', null, 'test', '{"email": "a@b.test"}')
    from generate_series (1, 2) n returning 1) select count(*) = 2 from q$q$);
select pg_temp.refused('24 a confirmation without its de-duplication key is refused',
$q$select public.enqueue_billing_mail ('purchase_confirmation', null, 'test', '{}')$q$, '23514');
select pg_temp.refused('25 ... and so is a kind the outbox does not send',
$q$select public.enqueue_billing_mail ('newsletter', 'k', 'test', '{}')$q$, '23514');

select pg_temp.chk('26 a worker claims what is due, under a lease',
$q$with c as (select * from public.claim_billing_mail (10, interval '2 minutes'))
    select count(*) = 3 and bool_and(claim_token is not null and attempts = 1 and claimed_until > now()) from c$q$);
update t_mail m set claim = o.claim_token from public.billing_mail_outbox o where o.id = m.id;
select pg_temp.chk('27 a second worker gets none of them while the lease holds',
$q$select count(*) = 0 from public.claim_billing_mail (10, interval '2 minutes')$q$);

select pg_temp.chk('28 a worker that is not the lease holder cannot settle a row',
$q$select not public.settle_billing_mail ((select id from t_mail where label = 'purchase'), gen_random_uuid(), 'sent')$q$);
select pg_temp.chk('29 a failed send is put back, due after its backoff',
$q$select public.settle_billing_mail ((select id from t_mail where label = 'purchase'),
    (select claim from t_mail where label = 'purchase'), 'retry', 'resend failed', interval '4 minutes')$q$);
select pg_temp.chk('30 ... with its reason, and no lease',
$q$select claim_token is null and last_error = 'resend failed' and next_attempt_at = now() + interval '4 minutes'
       and status = 'pending'
   from public.billing_mail_outbox where id = (select id from t_mail where label = 'purchase')$q$);
select pg_temp.chk('31 ... and not handed out again before then',
$q$select count(*) = 0 from public.claim_billing_mail (10, interval '2 minutes')$q$);

-- A worker dies holding link-1: its lease runs out (pushed back by the clock,
-- since now() is fixed inside this transaction).
update public.billing_mail_outbox set claimed_until = now() - interval '1 second'
where id = (select id from t_mail where label = 'link-1');
select pg_temp.chk('32 a row whose worker died is claimable again once its lease has expired',
$q$with c as (select * from public.claim_billing_mail (10, interval '2 minutes'))
    select count(*) = 1 and bool_and(id = (select id from t_mail where label = 'link-1') and attempts = 2) from c$q$);
select pg_temp.chk('33 ... and the dead worker can no longer settle it',
$q$select not public.settle_billing_mail ((select id from t_mail where label = 'link-1'),
    (select claim from t_mail where label = 'link-1'), 'sent')$q$);

update t_mail m set claim = o.claim_token from public.billing_mail_outbox o where o.id = m.id;
select pg_temp.chk('34 a sent cancel link is deleted, address and all',
$q$select public.settle_billing_mail ((select id from t_mail where label = 'link-1'),
    (select claim from t_mail where label = 'link-1'), 'sent')$q$);
select pg_temp.chk('35 ... gone',
$q$select not exists (select 1 from public.billing_mail_outbox where id = (select id from t_mail where label = 'link-1'))$q$);
select pg_temp.chk('36 a request with nothing to send is deleted too',
$q$select public.settle_billing_mail ((select id from t_mail where label = 'link-2'),
    (select claim from t_mail where label = 'link-2'), 'done')$q$);

-- The purchase confirmation's backoff is over.
update public.billing_mail_outbox set next_attempt_at = now() - interval '1 second'
where id = (select id from t_mail where label = 'purchase');
select pg_temp.chk('37 the retried confirmation is claimed again',
$q$with c as (insert into t_mail (label, id, claim) select 'purchase-2', id, claim_token
    from public.claim_billing_mail (10, interval '2 minutes') returning 1) select count(*) = 1 from c$q$);
select pg_temp.chk('38 a sent confirmation is kept, as the key that stops a second one',
$q$select public.settle_billing_mail ((select id from t_mail where label = 'purchase-2'),
    (select claim from t_mail where label = 'purchase-2'), 'sent')$q$);
select pg_temp.chk('39 ... sent, and never handed out again',
$q$select status = 'sent' and sent_at is not null and claim_token is null
   from public.billing_mail_outbox where id = (select id from t_mail where label = 'purchase')$q$);

-- Housekeeping: a month-old sent confirmation and a day-old link request go.
insert into t_mail (label, id)
select 'old-link', public.enqueue_billing_mail ('cancel_link', null, 'test', '{"email": "old@b.test"}');
update public.billing_mail_outbox set created_at = now() - interval '2 days', next_attempt_at = now() + interval '1 day'
where id = (select id from t_mail where label = 'old-link');
update public.billing_mail_outbox set sent_at = now() - interval '31 days'
where id = (select id from t_mail where label = 'purchase');
reset role;
select pg_temp.chk('40 the cron tick runs (without the Vault secrets it only tidies)',
$q$select true from (select public.billing_mail_outbox_tick ()) t$q$);
select pg_temp.chk('41 ... and has dropped the old link request and the month-old confirmation',
$q$select not exists (select 1 from public.billing_mail_outbox
    where id in (select id from t_mail where label in ('old-link', 'purchase')))$q$);
select pg_temp.chk('42 the tick is scheduled every minute',
$q$select exists (select 1 from cron.job where jobname = 'billing-mail-outbox' and schedule = '* * * * *')$q$);
-- Migrations first, functions after (Codex round 2, finding 2 on #62): the
-- PREVIOUS stripe-webhook still runs against this schema for a while, and it
-- claims a confirmation by inserting into billing_notices, treats 23505 as
-- "already sent", and deletes its claim when the send fails. All three must
-- still work, or its confirmations reach neither its own path nor the outbox.
select pg_temp.chk('43 billing_notices is kept for the previous webhook', $q$select to_regclass ('public.billing_notices') is not null$q$);
select pg_temp.chk('45 the previous webhook can still claim a confirmation in it',
$q$with claimed as (insert into public.billing_notices (kind, stripe_object_id)
    values ('purchase_confirmation', 'cs_legacy_1') returning 1) select count(*) = 1 from claimed$q$);
select pg_temp.refused('46 ... a second claim of the same one reads as already sent',
$q$insert into public.billing_notices (kind, stripe_object_id) values ('purchase_confirmation', 'cs_legacy_1')$q$, '23505');
select pg_temp.chk('47 ... and a claim whose send failed can be released for the redelivery',
$q$with released as (delete from public.billing_notices
    where kind = 'purchase_confirmation' and stripe_object_id = 'cs_legacy_1' returning 1) select count(*) = 1 from released$q$);
select pg_temp.chk('48 the cancellation key shape it uses still fits',
$q$with claimed as (insert into public.billing_notices (kind, stripe_object_id)
    values ('cancellation_confirmation', 'sub_legacy:2027-01-15T08:00:00.000Z') returning 1) select count(*) = 1 from claimed$q$);
select pg_temp.chk('44 RLS is on for the outbox', $q$select relrowsecurity from pg_class where oid = 'public.billing_mail_outbox'::regclass$q$);

select pg_temp.as_user(1);
select pg_temp.refused('08 a signed-in client cannot stage a checkout attempt',
$q$select public.stage_checkout_attempt (pg_temp.u(1), 'live', gen_random_uuid(), gen_random_uuid(), 'x', gen_random_uuid(), 'x')$q$,
'42501');
select pg_temp.refused('09 nor begin one',
$q$select * from public.begin_checkout_attempt (pg_temp.u(1), 'live', interval '5 minutes')$q$, '42501');
select pg_temp.refused('50 a signed-in client cannot read the outbox', $q$select count(*) from public.billing_mail_outbox$q$, '42501');
select pg_temp.refused('51 ... or write to it', $q$select public.enqueue_billing_mail ('cancel_link', null, 'live', '{}')$q$, '42501');
select pg_temp.refused('52 ... or claim from it', $q$select count(*) from public.claim_billing_mail (10, interval '1 minute')$q$, '42501');
select pg_temp.refused('53 ... or settle a row', $q$select public.settle_billing_mail (gen_random_uuid(), gen_random_uuid(), 'sent')$q$, '42501');
select pg_temp.refused('54 ... or run the tick', $q$select public.billing_mail_outbox_tick ()$q$, '42501');
select pg_temp.as_anon();
select pg_temp.refused('10 nor can anon',
$q$select public.stage_checkout_attempt (pg_temp.u(1), 'live', gen_random_uuid(), gen_random_uuid(), 'x', gen_random_uuid(), 'x')$q$,
'42501');
select pg_temp.refused('55 anon cannot read the outbox', $q$select count(*) from public.billing_mail_outbox$q$, '42501');
select pg_temp.refused('56 ... or write to it', $q$select public.enqueue_billing_mail ('cancel_link', null, 'live', '{}')$q$, '42501');

reset role;
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
