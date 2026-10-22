-- stripe-webhook while an account's deletion is pending (launch-fix item 16,
-- decision 70(1)): the database half of what stripeEvents.ts deletionRefusal
-- does, against a real database. LOCAL STACK only. One transaction, ROLLED
-- BACK; the last line is `failures | total` (scripts/ci/sql-proof.sh reads it).
--
-- The webhook asks account_deletion_pending() for the event's user before it
-- writes anything; while it is true the event is answered 503 and its claim
-- released -- the store's releaseEvent, `delete from stripe_events where id =
-- ... and claimed_at = <ours>` -- so Stripe's retry is a fresh claim, not a
-- duplicate. Proved here, as the service role the webhook runs as:
--   * the predicate is true while an attempt is live, and false again once the
--     attempt is abandoned (settle_account_deletion_attempt) or the deletion
--     completes (the Auth user's cascade takes the marker);
--   * a released claim is claimed afresh by the retry, finished once, and every
--     later delivery reads `done` -- processed exactly once;
--   * once the deletion has completed, the retry's subscription write answers
--     `missing_user` (the deleted-account path, deletedAccountBilling.ts) and
--     its customer link fails on the FK the webhook logs and skips: nothing
--     is written for the account.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to service_role;
create temp table t_state (k text primary key, v text);
grant all on t_state to service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('5a160000-0c16-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
-- claim_stripe_event's state for an event, as the store reads its first row.
create function pg_temp.claim(p_id text) returns text language sql as $f$
    select state from public.claim_stripe_event (p_id, 'customer.subscription.updated', interval '10 minutes') $f$;
-- The store's releaseEvent: only the claim this delivery holds.
create function pg_temp.release(p_id text) returns bigint language sql as $f$
    with gone as (
        delete from public.stripe_events
        where id = p_id and claimed_at = (select claimed_at from public.stripe_events where id = p_id)
        returning 1)
    select count(*) from gone $f$;
-- The store's markEventDone.
create function pg_temp.done(p_id text) returns bigint language sql as $f$
    with marked as (
        update public.stripe_events set status = 'done', processed_at = now()
        where id = p_id and status = 'processing'
        returning 1)
    select count(*) from marked $f$;
grant execute on all functions in schema pg_temp to service_role;

-- a: a deletion that will be abandoned; c: one that will complete.
insert into auth.users (id, email)
select pg_temp.u(n), 'swdp-' || n || '@example.invalid' from generate_series(1, 2) n;

set local role service_role;

-- ---------------------------------------------------------------------------
-- Abandoned: refused while pending, then processed once
-- ---------------------------------------------------------------------------
insert into t_state values ('attempt_a', public.begin_account_deletion_attempt (pg_temp.u(1))::text);

select pg_temp.chk('01 a live attempt: account_deletion_pending() is true for the event''s user', $q$
    select public.account_deletion_pending (pg_temp.u(1))$q$);

select pg_temp.chk('02 the first delivery claims the event', $q$
    select pg_temp.claim('evt_swdp_a') = 'claimed'$q$);

select pg_temp.chk('03 refused: its claim is released (one row)', $q$
    select pg_temp.release('evt_swdp_a') = 1$q$);

select pg_temp.chk('03b and the event is unknown again', $q$
    select not exists (select 1 from public.stripe_events where id = 'evt_swdp_a')$q$);

select public.settle_account_deletion_attempt (pg_temp.u(1), (select v::uuid from t_state where k = 'attempt_a'), 'abandoned');

select pg_temp.chk('04 abandoned: not pending, and the marker is gone', $q$
    select not public.account_deletion_pending (pg_temp.u(1))
       and not exists (select 1 from public.account_deletions where user_id = pg_temp.u(1))$q$);

select pg_temp.chk('05 Stripe''s retry claims it afresh -- not a duplicate, not in flight', $q$
    select pg_temp.claim('evt_swdp_a') = 'claimed'$q$);

select pg_temp.chk('06 the retry finishes it once', $q$
    select pg_temp.done('evt_swdp_a') = 1$q$);

select pg_temp.chk('07 every later delivery reads done: processed exactly once', $q$
    select pg_temp.claim('evt_swdp_a') = 'done' and pg_temp.claim('evt_swdp_a') = 'done'
       and (select count(*) = 1 from public.stripe_events where id = 'evt_swdp_a' and status = 'done')$q$);

-- ---------------------------------------------------------------------------
-- Completed: refused while pending, then the deleted-account path
-- ---------------------------------------------------------------------------
insert into t_state values ('attempt_c', public.begin_account_deletion_attempt (pg_temp.u(2))::text);

select pg_temp.chk('08 destructive cleanup begun: still pending', $q$
    select public.mark_account_deletion_destructive (pg_temp.u(2), (select v::uuid from t_state where k = 'attempt_c'))
       and public.account_deletion_pending (pg_temp.u(2))$q$);

select pg_temp.chk('09 the first delivery is claimed, then released on the refusal', $q$
    select pg_temp.claim('evt_swdp_c') = 'claimed' and pg_temp.release('evt_swdp_c') = 1$q$);

reset role;

-- The deletion completes: the Auth user goes (delete-account's last step).
delete from auth.users where id = pg_temp.u(2);

set local role service_role;

select pg_temp.chk('10 completed: not pending (the marker went with the user)', $q$
    select not public.account_deletion_pending (pg_temp.u(2))
       and not exists (select 1 from public.account_deletions where user_id = pg_temp.u(2))$q$);

select pg_temp.chk('11 the retry claims it afresh', $q$
    select pg_temp.claim('evt_swdp_c') = 'claimed'$q$);

select pg_temp.chk('12 its subscription write answers missing_user: the deleted-account path, no row', $q$
    select public.write_subscription_under_lock (
               public.claim_subscription_write ('sub_swdp_c', interval '5 minutes'),
               'sub_swdp_c', pg_temp.u(2), 'test', 'teacher', 'active', 'price_x',
               now() + interval '30 days', false, now(), 'charge_automatically', null) = 'missing_user'
       and not exists (select 1 from public.subscriptions where stripe_subscription_id = 'sub_swdp_c')$q$);

create function pg_temp.link_fails() returns text language plpgsql as $f$
begin
    insert into public.billing_customers (user_id, mode, stripe_customer_id)
    values (pg_temp.u(2), 'test', 'cus_swdp_c');
    return 'linked';
exception when foreign_key_violation then
    return '23503';
end $f$;
grant execute on function pg_temp.link_fails() to service_role;

select pg_temp.chk('13 its customer link fails on the user FK (23503, logged and skipped by the webhook)', $q$
    select pg_temp.link_fails() = '23503'
       and not exists (select 1 from public.billing_customers where stripe_customer_id = 'cus_swdp_c')$q$);

select pg_temp.chk('14 the retry is finished once, and later deliveries are duplicates', $q$
    select pg_temp.done('evt_swdp_c') = 1 and pg_temp.claim('evt_swdp_c') = 'done'$q$);

-- ---------------------------------------------------------------------------
-- What the webhook may call
-- ---------------------------------------------------------------------------
reset role;

select pg_temp.chk('15 service_role may ask the predicate; anon and authenticated may not', $q$
    select has_function_privilege('service_role', 'public.account_deletion_pending(uuid)', 'execute')
       and not has_function_privilege('anon', 'public.account_deletion_pending(uuid)', 'execute')
       and not has_function_privilege('authenticated', 'public.account_deletion_pending(uuid)', 'execute')$q$);

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
