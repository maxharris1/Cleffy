-- Behaviour proof for 20261020160000_checkout_consents_and_self_service_cancel.sql:
-- the service role records a checkout consent and links it to its session;
-- no client role can read or write consents, cancel tokens or billing notices;
-- a consent younger than three years cannot be removed, by anyone; deleting the
-- account keeps the consent and only clears its user_id; billing_notices
-- refuses a second confirmation for the same Stripe object; and
-- billing_user_for_email answers the service role alone, never for a guest.
--
-- Runs inside one transaction and ROLLS BACK -- nothing persists. Same harness
-- and reading as tests/sql/guest_email_verification.sql:
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/checkout_consents.sql
--
-- Every row of the result table should read `t`; the last line is
-- `failures | total`. Unlike its siblings it says DELETE, because what it
-- proves is a delete guard -- run it against a local or branch database.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('c0c5e000-5ac0-4000-8000-00000000000' || n)::uuid $f$;
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

-- 1 a buyer, 2 a guest sharing nothing, 3 a buyer whose account is deleted.
insert into auth.users (id, email, is_anonymous) values
(pg_temp.u(1), 'Buyer@ConsentTest.test', false),
(pg_temp.u(2), 'guest@consenttest.test', true),
(pg_temp.u(3), 'leaver@consenttest.test', false);

-- ---- the service role records consent (what stripe-checkout does)
select pg_temp.as_service();
select pg_temp.chk('01 service role records a consent', $q$with ins as (
    insert into public.checkout_consents (id, user_id, mode, stripe_customer_id, price_id, plan_slot, currency,
        amount_minor, renewal_interval, tax_inclusive, wording, wording_version, terms_version,
        refund_policy_version, declared_country, ip_address)
    values
    (pg_temp.u(7), pg_temp.u(1), 'test', 'cus_1', 'price_1', 'teacherMonthly', 'eur', 2100, 'month', true,
     'I agree that my Cleffy Teacher subscription renews automatically every month', 'auto-renewal-v1',
     '2026-10-20-draft', '2026-10-20-draft', 'DE', '203.0.113.7'),
    (pg_temp.u(8), pg_temp.u(3), 'test', 'cus_3', 'price_1', 'teacherMonthly', 'usd', 1900, 'month', false,
     'I agree', 'auto-renewal-v1', 'v', 'v', 'US', null)
    returning 1) select count(*) = 2 from ins$q$);
select pg_temp.chk('02 ... and links it to its Checkout Session (what linkConsent does)', $q$with up as (
    update public.checkout_consents set checkout_session_id = 'cs_1' where id = pg_temp.u(7) returning 1)
    select count(*) = 1 from up$q$);
select pg_temp.chk('03 ... and completes it from the webhook', $q$with up as (
    update public.checkout_consents set stripe_subscription_id = 'sub_1', billing_country = 'AT', completed_at = now()
    where id = pg_temp.u(7) returning 1) select count(*) = 1 from up$q$);
select pg_temp.refused('04 a currency we do not sell is refused', $q$insert into public.checkout_consents (user_id, mode, stripe_customer_id, price_id, plan_slot, currency, amount_minor, renewal_interval, tax_inclusive, wording, wording_version, terms_version, refund_policy_version, declared_country) values (pg_temp.u(1), 'test', 'c', 'p', 's', 'jpy', 1, 'month', false, 'w', 'v', 'v', 'v', 'JP')$q$, '23514');
select pg_temp.refused('05 a country that is not ISO alpha-2 is refused', $q$insert into public.checkout_consents (user_id, mode, stripe_customer_id, price_id, plan_slot, currency, amount_minor, renewal_interval, tax_inclusive, wording, wording_version, terms_version, refund_policy_version, declared_country) values (pg_temp.u(1), 'test', 'c', 'p', 's', 'usd', 1, 'month', false, 'w', 'v', 'v', 'v', 'usa')$q$, '23514');

-- ---- the retention floor
select pg_temp.refused('10 a fresh consent cannot be deleted, even by the service role', $q$delete from public.checkout_consents where id = pg_temp.u(7)$q$, '42501');
reset role;
select pg_temp.refused('11 ... nor by postgres', $q$delete from public.checkout_consents where id = pg_temp.u(7)$q$, '42501');
update public.checkout_consents set consented_at = now() - interval '3 years 1 day' where id = pg_temp.u(8);
select pg_temp.chk('12 one older than three years can be', $q$with del as (
    delete from public.checkout_consents where id = pg_temp.u(8) returning 1) select count(*) = 1 from del$q$);
insert into public.checkout_consents (id, user_id, mode, stripe_customer_id, price_id, plan_slot, currency,
    amount_minor, renewal_interval, tax_inclusive, wording, wording_version, terms_version, refund_policy_version,
    declared_country)
values (pg_temp.u(8), pg_temp.u(3), 'test', 'cus_3', 'price_1', 'teacherMonthly', 'usd', 1900, 'month', false,
    'I agree', 'auto-renewal-v1', 'v', 'v', 'US');
delete from auth.users where id = pg_temp.u(3);
select pg_temp.chk('13 deleting the account keeps the consent and clears only its user_id', $q$select user_id is null and stripe_customer_id = 'cus_3'
    from public.checkout_consents where id = pg_temp.u(8)$q$);

-- ---- billing_notices: one confirmation per Stripe object
select pg_temp.as_service();
insert into public.billing_notices (kind, stripe_object_id) values ('purchase_confirmation', 'cs_1');
select pg_temp.refused('20 a second purchase confirmation for the same session is refused', $q$insert into public.billing_notices (kind, stripe_object_id) values ('purchase_confirmation', 'cs_1')$q$, '23505');
select pg_temp.chk('21 ... while a cancellation notice for another key goes in', $q$with ins as (
    insert into public.billing_notices (kind, stripe_object_id) values ('cancellation_confirmation', 'sub_1:2026-11-20') returning 1)
    select count(*) = 1 from ins$q$);

-- ---- billing_cancel_tokens
select pg_temp.chk('30 the service role stores a hashed token', $q$with ins as (
    insert into public.billing_cancel_tokens (token_hash, user_id, mode, expires_at)
    values (repeat('a', 64), pg_temp.u(1), 'test', now() + interval '1 hour') returning 1) select count(*) = 1 from ins$q$);
select pg_temp.refused('31 anything but a SHA-256 hex digest is refused', $q$insert into public.billing_cancel_tokens (token_hash, user_id, mode, expires_at) values ('the-raw-token', pg_temp.u(1), 'test', now())$q$, '23514');
select pg_temp.chk('32 a token is spent once (what consumeToken does)', $q$with first as (
    update public.billing_cancel_tokens set used_at = now() where token_hash = repeat('a', 64) and used_at is null returning 1)
    select count(*) = 1 from first$q$);
select pg_temp.chk('33 ... and not twice', $q$with second as (
    update public.billing_cancel_tokens set used_at = now() where token_hash = repeat('a', 64) and used_at is null returning 1)
    select count(*) = 0 from second$q$);

-- ---- billing_user_for_email
select pg_temp.chk('40 finds the account for an address (any case, padded)', $q$select public.billing_user_for_email('  buyer@consenttest.TEST ') = pg_temp.u(1)$q$);
select pg_temp.chk('41 never a guest', $q$select public.billing_user_for_email('guest@consenttest.test') is null$q$);
select pg_temp.chk('42 nothing for an unknown, null or blank address', $q$select public.billing_user_for_email('nobody@consenttest.test') is null
    and public.billing_user_for_email(null) is null and public.billing_user_for_email(' ') is null$q$);

-- ---- clients get nothing
reset role;
select pg_temp.as_user(1);
select pg_temp.refused('50 a buyer cannot read their consents', $q$select count(*) from public.checkout_consents$q$, '42501');
select pg_temp.refused('51 ... or write one', $q$insert into public.checkout_consents (user_id, mode, stripe_customer_id, price_id, plan_slot, currency, amount_minor, renewal_interval, tax_inclusive, wording, wording_version, terms_version, refund_policy_version, declared_country) values (pg_temp.u(1), 'test', 'c', 'p', 's', 'usd', 1, 'month', false, 'w', 'v', 'v', 'v', 'US')$q$, '42501');
select pg_temp.refused('52 ... or read cancel tokens', $q$select count(*) from public.billing_cancel_tokens$q$, '42501');
select pg_temp.refused('53 ... or billing notices', $q$select count(*) from public.billing_notices$q$, '42501');
select pg_temp.refused('54 ... or look up an address', $q$select public.billing_user_for_email('buyer@consenttest.test')$q$, '42501');
reset role;
select pg_temp.as_anon();
select pg_temp.refused('55 anon cannot read consents', $q$select count(*) from public.checkout_consents$q$, '42501');
select pg_temp.refused('56 ... or look up an address', $q$select public.billing_user_for_email('buyer@consenttest.test')$q$, '42501');
reset role;

select pg_temp.chk('60 RLS is on for all three tables', $q$select bool_and(c.relrowsecurity) from pg_class c
    where c.oid in ('public.checkout_consents'::regclass, 'public.billing_cancel_tokens'::regclass, 'public.billing_notices'::regclass)$q$);
select pg_temp.chk('61 the delete guard: search_path pinned empty, nobody may call it', $q$select p.proconfig @> array['search_path=""']
    and not has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute')
    and not has_function_privilege('service_role', p.oid, 'execute')
    from pg_proc p where p.oid = 'public.checkout_consents_refuse_early_delete()'::regprocedure$q$);

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
