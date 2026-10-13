-- The double-charge guards (migrations 20261012120100 through 120105): at most
-- one entitling subscription per user per Stripe account, a webhook claim that
-- can be taken over when its delivery died and that says WHY it was refused, a
-- subscription write that cannot be overwritten by an older Stripe event, and
-- the two leased locks that serialise what no comparison can -- one checkout
-- attempt per buyer, one writer per subscription.
--
-- Same harness and same reading as column_integrity.sql (see README.md): one
-- transaction ending in ROLLBACK, every check a row in integrity_results, and a
-- clean run is exactly one row reading 'ALL n CHECKS PASSED'.

begin;

create temp table integrity_results (
    n serial primary key,
    check_name text not null,
    passed boolean not null,
    detail text
);

grant all on integrity_results to public;

grant usage on sequence integrity_results_n_seq to public;

create function pg_temp.act_as (p_role text) returns void language plpgsql as $$
begin
    perform set_config('role', p_role, true);
    perform set_config('request.jwt.claims', jsonb_build_object('role', p_role)::text, true);
end;
$$;

create function pg_temp.act_as_server () returns void language plpgsql as $$
begin
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
end;
$$;

create function pg_temp.holds (p_name text, p_sql text) returns void language plpgsql as $$
declare
    v boolean;
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql into v;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (p_name, false, 'error: ' || v_state || ' ' || v_msg);
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, coalesce(v, false), 'got ' || coalesce(v::text, 'null'));
end;
$$;

create function pg_temp.allowed (p_name text, p_sql text, p_rows int default 1) returns void language plpgsql as $$
declare
    v_rows int;
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql;
        get diagnostics v_rows = row_count;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (p_name, false, 'refused: ' || v_state || ' ' || v_msg);
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, v_rows = p_rows, 'touched ' || v_rows || ' row(s)');
end;
$$;

create function pg_temp.refused (p_name text, p_sql text, p_state text, p_message_like text default null)
returns void language plpgsql as $$
declare
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (
            p_name,
            v_state = p_state and (p_message_like is null or v_msg like p_message_like),
            v_state || ' ' || v_msg
        );
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, false, 'statement succeeded but should have been refused');
end;
$$;

-- Throwaway accounts. 'd1c' for the defect these guards are about.
insert into auth.users (id, aud, role, email)
values
    ('d1c00000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'd1-teacher@example.invalid'),
    ('d1c00000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'd1-other@example.invalid');

select pg_temp.act_as ('service_role');

-- ===========================================================================
-- One entitling subscription per user per Stripe account
-- ===========================================================================

-- The shape of the index itself: unique, and PARTIAL. A plain unique index on
-- (user_id, mode) would refuse the cancelled subscription a new one replaces.
select pg_temp.holds (
    'the entitling index is unique and partial on the entitling statuses',
    $q$select indexdef like 'CREATE UNIQUE INDEX%'
          and indexdef like '%(user_id, mode)%'
          and indexdef like '%WHERE (status = ANY%'
       from pg_indexes
       where schemaname = 'public' and indexname = 'subscriptions_one_entitling_per_user_mode'$q$
);

select pg_temp.allowed (
    'the first entitling subscription is recorded',
    $q$insert into public.subscriptions
           (stripe_subscription_id, user_id, mode, tier, status, price_id, current_period_end)
       values ('sub_d1_first', 'd1c00000-0000-4000-8000-0000000000a1', 'live', 'teacher', 'active',
               'price_teacher_annual', now() + interval '1 month')$q$
);

-- The double charge, as the webhook would have written it: a second Checkout
-- Session, paid moments after the first.
select pg_temp.refused (
    'a second active subscription for the same user and account is refused',
    $q$insert into public.subscriptions
           (stripe_subscription_id, user_id, mode, tier, status, price_id, current_period_end)
       values ('sub_d1_second', 'd1c00000-0000-4000-8000-0000000000a1', 'live', 'teacher', 'active',
               'price_teacher_annual', now() + interval '1 month')$q$,
    '23505',
    '%subscriptions_one_entitling_per_user_mode%'
);

select pg_temp.refused (
    'a trial beside a paid subscription is refused too',
    $q$insert into public.subscriptions
           (stripe_subscription_id, user_id, mode, tier, status, price_id)
       values ('sub_d1_trial', 'd1c00000-0000-4000-8000-0000000000a1', 'live', 'personal', 'trialing',
               'price_personal_monthly')$q$,
    '23505',
    '%subscriptions_one_entitling_per_user_mode%'
);

-- A sandbox subscription belongs to a different Stripe account: on production
-- it entitles nobody (entitling_billing_modes is array['live'] there) and it
-- must not collide with the live one.
select pg_temp.allowed (
    'the same user may hold one in the other Stripe account',
    $q$insert into public.subscriptions
           (stripe_subscription_id, user_id, mode, tier, status, price_id)
       values ('sub_d1_sandbox', 'd1c00000-0000-4000-8000-0000000000a1', 'test', 'teacher', 'active',
               'price_teacher_annual')$q$
);

select pg_temp.allowed (
    'another user is unaffected',
    $q$insert into public.subscriptions
           (stripe_subscription_id, user_id, mode, tier, status, price_id)
       values ('sub_d1_elsewhere', 'd1c00000-0000-4000-8000-0000000000a2', 'live', 'teacher', 'active',
               'price_teacher_annual')$q$
);

-- A status nobody is entitled by is not something to serialise: this is the
-- ordinary resubscribe, and the whole reason the index is partial.
select pg_temp.allowed (
    'a cancelled subscription makes room for its replacement',
    $q$insert into public.subscriptions
           (stripe_subscription_id, user_id, mode, tier, status, price_id)
       values ('sub_d1_lapsed', 'd1c00000-0000-4000-8000-0000000000a2', 'test', 'free', 'canceled',
               'price_teacher_annual')$q$
);

select pg_temp.allowed (
    'and the replacement is recorded',
    $q$insert into public.subscriptions
           (stripe_subscription_id, user_id, mode, tier, status, price_id)
       values ('sub_d1_renewed', 'd1c00000-0000-4000-8000-0000000000a2', 'test', 'teacher', 'active',
               'price_teacher_annual')$q$
);

-- The upsert path, not just the insert: the webhook writes with
-- `on conflict (stripe_subscription_id) do update`, so a lapsed subscription
-- being revived while another is live has to be refused as well.
select pg_temp.refused (
    'reviving a cancelled subscription beside a live one is refused',
    $q$update public.subscriptions set status = 'active', tier = 'teacher'
       where stripe_subscription_id = 'sub_d1_lapsed'$q$,
    '23505',
    '%subscriptions_one_entitling_per_user_mode%'
);

select pg_temp.allowed (
    'the live subscription may still update itself',
    $q$update public.subscriptions set cancel_at_period_end = true
       where stripe_subscription_id = 'sub_d1_first'$q$
);

-- ===========================================================================
-- claim_stripe_event: a claim that can be taken over, but only when stale
-- ===========================================================================
-- Each claim is taken in a statement of its own, and what it did is read in the
-- next one. Asking both at once -- `claim(...) is not null and exists (select
-- ...)` -- proves nothing: the subquery is uncorrelated, so Postgres is free to
-- evaluate it before the function that creates the row, and it did.
create temp table claims (label text primary key, state text, stamp timestamptz);

grant all on claims to public;

insert into claims (label, state, stamp)
select 'evt_d1_a', state, claimed_at
from public.claim_stripe_event ('evt_d1_a', 'checkout.session.completed', interval '10 minutes');

select pg_temp.holds (
    'a fresh event is claimed',
    $q$select state = 'claimed' and stamp is not null from claims where label = 'evt_d1_a'$q$
);

select pg_temp.holds (
    'and the claim is recorded as in progress',
    $q$select status = 'processing' from public.stripe_events where id = 'evt_d1_a'$q$
);

-- It answers with the stamp as well as the state so the webhook can release
-- (or finish) exactly the claim it holds and nobody else's.
select pg_temp.holds (
    'the stamp it answers with is the claim it wrote',
    $q$select c.stamp = e.claimed_at
       from claims c
       join public.stripe_events e on e.id = c.label
       where c.label = 'evt_d1_a'$q$
);

-- The distinction migration 120104 added, and the whole reason this answers a
-- state rather than just a stamp: a live claim means NOBODY has applied the
-- event, so the webhook has to answer Stripe 409 and be delivered again. A 200
-- there -- which is what a null stamp alone bought -- made Stripe forget an
-- event no delivery had applied.
select pg_temp.holds (
    'a second delivery of an in-flight event is told it is in flight, not done',
    $q$select state = 'processing' and claimed_at is null
       from public.claim_stripe_event ('evt_d1_a', 'checkout.session.completed', interval '10 minutes')$q$
);

-- What the handler does on every 2xx it finished with.
update public.stripe_events set status = 'done', processed_at = now() where id = 'evt_d1_a';

select pg_temp.holds (
    'a finished event is never claimed again, however old, and says so',
    $q$select state = 'done' and claimed_at is null
       from public.claim_stripe_event ('evt_d1_a', 'checkout.session.completed', interval '1 second')$q$
);

-- The isolate that died holding the claim: nothing marked it done, nothing
-- released it. Before the migration this answered `duplicate` for the three
-- days Stripe retries, and a purchase was charged and never applied.
select state from public.claim_stripe_event ('evt_d1_b', 'customer.subscription.updated', interval '10 minutes');

update public.stripe_events set claimed_at = now() - interval '1 hour' where id = 'evt_d1_b';

select pg_temp.holds (
    'a stale claim is taken over, and the takeover re-stamps it',
    $q$select state = 'claimed' and claimed_at > now() - interval '1 minute'
       from public.claim_stripe_event ('evt_d1_b', 'customer.subscription.updated', interval '10 minutes')$q$
);

select pg_temp.holds (
    'the taken-over claim is in flight again, not done',
    $q$select status = 'processing' from public.stripe_events where id = 'evt_d1_b'$q$
);

select pg_temp.holds (
    'and it is now too fresh for a third delivery to take',
    $q$select state = 'processing'
       from public.claim_stripe_event ('evt_d1_b', 'customer.subscription.updated', interval '10 minutes')$q$
);

-- ===========================================================================
-- Refusing a subscription write that carries an older event than the row holds
-- ===========================================================================
select pg_temp.allowed (
    'a write stamps the row with the event that made it',
    $q$update public.subscriptions
       set status = 'past_due', tier = 'free', last_event_created_at = '2026-10-12T22:35:47Z'
       where stripe_subscription_id = 'sub_d1_first'$q$
);

select pg_temp.holds (
    'an older event cannot put the row back',
    $q$with refused as (
           update public.subscriptions
           set status = 'active', tier = 'teacher', last_event_created_at = '2026-10-12T22:35:08Z'
           where stripe_subscription_id = 'sub_d1_first'
           returning status, last_event_created_at
       )
       select status = 'past_due' and last_event_created_at = '2026-10-12T22:35:47Z'::timestamptz from refused$q$
);

select pg_temp.holds (
    'a newer event is applied',
    $q$with applied as (
           update public.subscriptions
           set status = 'active', tier = 'teacher', last_event_created_at = '2026-10-12T23:00:00Z'
           where stripe_subscription_id = 'sub_d1_first'
           returning status, last_event_created_at
       )
       select status = 'active' and last_event_created_at = '2026-10-12T23:00:00Z'::timestamptz from applied$q$
);

-- The retry of an event whose archival failed after its upsert landed writes
-- the same state again; an equal stamp has to pass, or that retry is lost.
select pg_temp.holds (
    'the same event may be applied again',
    $q$with again as (
           update public.subscriptions
           set tier = 'personal', last_event_created_at = '2026-10-12T23:00:00Z'
           where stripe_subscription_id = 'sub_d1_first'
           returning tier
       )
       select tier = 'personal' from again$q$
);

-- An unstamped write is let through -- refusing one would silently discard a
-- legitimate change from a code path that carries no event -- but it must not
-- wipe the high-water mark, or the next stale event walks straight in.
select pg_temp.holds (
    'a write carrying no stamp is applied and keeps the one the row has',
    $q$with unstamped as (
           update public.subscriptions
           set tier = 'teacher', last_event_created_at = null
           where stripe_subscription_id = 'sub_d1_first'
           returning tier, last_event_created_at
       )
       select tier = 'teacher' and last_event_created_at = '2026-10-12T23:00:00Z'::timestamptz from unstamped$q$
);

select pg_temp.holds (
    'and the stamp it kept still refuses an older event',
    $q$with refused as (
           update public.subscriptions
           set status = 'canceled', last_event_created_at = '2026-10-12T22:00:00Z'
           where stripe_subscription_id = 'sub_d1_first'
           returning status
       )
       select status = 'active' from refused$q$
);

-- Every row written before the migration has no stamp. Refusing those would
-- freeze them for good.
select pg_temp.holds (
    'a row with no stamp yet accepts the first one it is given',
    $q$with first_stamp as (
           update public.subscriptions
           set status = 'past_due', tier = 'free', last_event_created_at = '2026-10-12T22:00:00Z'
           where stripe_subscription_id = 'sub_d1_elsewhere'
           returning status, last_event_created_at
       )
       select status = 'past_due' and last_event_created_at = '2026-10-12T22:00:00Z'::timestamptz from first_stamp$q$
);

-- ===========================================================================
-- begin_checkout_attempt: one checkout attempt per buyer per Stripe account
-- ===========================================================================
-- Why a lock at all (QA round 4, D1 follow-up): expiring the open sessions and
-- keying creation on an idempotency key only serialise two requests that AGREE
-- about the purchase. Two tabs on different plans compute different keys, so
-- Stripe makes a session each, and two isolates interleave so that neither
-- expire sees the other's. Two open sessions are two payable sessions.
create temp table attempts (label text primary key, holder uuid, session_id text, price_id text);

grant all on attempts to public;

insert into attempts (label, holder, session_id, price_id)
select 'first', holder, session_id, price_id
from public.begin_checkout_attempt (
    'd1c00000-0000-4000-8000-0000000000a1', 'live', interval '2 minutes'
);

select pg_temp.holds (
    'a first attempt takes the lock, and finds nothing stored',
    $q$select holder is not null and session_id is null and price_id is null
       from attempts where label = 'first'$q$
);

select pg_temp.holds (
    'an overlapping attempt for the same buyer and account gets nothing',
    $q$select not exists (
           select 1 from public.begin_checkout_attempt (
               'd1c00000-0000-4000-8000-0000000000a1', 'live', interval '2 minutes'
           )
       )$q$
);

-- Per (user, mode): the same teacher testing against the sandbox is a different
-- purchase in a different Stripe account, and must not be held off by it.
select pg_temp.holds (
    'the same buyer may hold an attempt in the other Stripe account',
    $q$select exists (
           select 1 from public.begin_checkout_attempt (
               'd1c00000-0000-4000-8000-0000000000a1', 'test', interval '2 minutes'
           )
       )$q$
);

select pg_temp.holds (
    'and another buyer is never held off by someone else attempt',
    $q$select exists (
           select 1 from public.begin_checkout_attempt (
               'd1c00000-0000-4000-8000-0000000000a2', 'live', interval '2 minutes'
           )
       )$q$
);

-- A request that opened nothing gives the lock back at once: a refusal, a
-- failed read, a throw. Without it the buyer would wait out the whole lease.
select pg_temp.holds (
    'releasing leaves the lock free and the stored session untouched',
    $q$select public.release_checkout_attempt (
           'd1c00000-0000-4000-8000-0000000000a1', 'live', (select holder from attempts where label = 'first')
       )$q$
);

select pg_temp.holds (
    'and a release by anyone but the holder changes nothing',
    $q$select not public.release_checkout_attempt (
           'd1c00000-0000-4000-8000-0000000000a1', 'live', '00000000-0000-4000-8000-000000000999'
       )$q$
);

-- The session the attempt opened, remembered: this is what lets the next
-- request hand the buyer back the session they already have rather than open a
-- second payable one.
insert into attempts (label, holder, session_id, price_id)
select 'second', holder, session_id, price_id
from public.begin_checkout_attempt (
    'd1c00000-0000-4000-8000-0000000000a1', 'live', interval '2 minutes'
);

select pg_temp.holds (
    'finishing records the session this attempt opened and frees the lock',
    $q$select public.finish_checkout_attempt (
           'd1c00000-0000-4000-8000-0000000000a1',
           'live',
           (select holder from attempts where label = 'second'),
           '11111111-0000-4000-8000-000000000001',
           'price_teacher_annual',
           'cs_test_d1'
       )$q$
);

select pg_temp.holds (
    'and the next attempt is handed that session back',
    $q$select session_id = 'cs_test_d1' and price_id = 'price_teacher_annual'
       from public.begin_checkout_attempt (
           'd1c00000-0000-4000-8000-0000000000a1', 'live', interval '2 minutes'
       )$q$
);

-- The lease, for the same reason the event claim has one: an isolate killed
-- mid-checkout releases nothing, and a lock without a lease would stop that
-- buyer paying us ever again.
select pg_temp.holds (
    'a lease nobody released is NOT taken over while it is fresh',
    $q$select not exists (
           select 1 from public.begin_checkout_attempt (
               'd1c00000-0000-4000-8000-0000000000a1', 'live', interval '2 minutes'
           )
       )$q$
);

update public.checkout_attempts
set claimed_at = now() - interval '1 hour'
where user_id = 'd1c00000-0000-4000-8000-0000000000a1' and mode = 'live';

select pg_temp.holds (
    'but it is once it has gone stale, and the stored session comes with it',
    $q$select holder is not null and session_id = 'cs_test_d1'
       from public.begin_checkout_attempt (
           'd1c00000-0000-4000-8000-0000000000a1', 'live', interval '2 minutes'
       )$q$
);

select pg_temp.holds (
    'and the dead attempt can no longer record a session over the live one',
    $q$select not public.finish_checkout_attempt (
           'd1c00000-0000-4000-8000-0000000000a1',
           'live',
           (select holder from attempts where label = 'second'),
           '11111111-0000-4000-8000-000000000002',
           'price_academy_annual',
           'cs_test_stale'
       )$q$
);

-- ===========================================================================
-- claim_subscription_write: one writer per subscription
-- ===========================================================================
-- What the staleness trigger above cannot do (QA round 4, D3 follow-up): Stripe
-- stamps `created` to the second and equal stamps must pass, so two events from
-- the same second, delivered at once, can still land in the order they READ in.
-- The lock makes the Stripe read and the row write one step.
create temp table writes (label text primary key, holder uuid);

grant all on writes to public;

insert into writes (label, holder)
values ('first', public.claim_subscription_write ('sub_d1_first', interval '2 minutes'));

select pg_temp.holds (
    'the first delivery gets the write lock',
    $q$select holder is not null from writes where label = 'first'$q$
);

select pg_temp.holds (
    'a delivery that overlaps it does not',
    $q$select public.claim_subscription_write ('sub_d1_first', interval '2 minutes') is null$q$
);

select pg_temp.holds (
    'another subscription is locked independently',
    $q$select public.claim_subscription_write ('sub_d1_elsewhere', interval '2 minutes') is not null$q$
);

select pg_temp.holds (
    'a release by anyone but the holder leaves the lock standing',
    $q$select not public.release_subscription_write ('sub_d1_first', '00000000-0000-4000-8000-000000000999')$q$
);

select pg_temp.holds (
    'the holder gives it back',
    $q$select public.release_subscription_write ('sub_d1_first', (select holder from writes where label = 'first'))$q$
);

select pg_temp.holds (
    'and the next delivery takes it',
    $q$select public.claim_subscription_write ('sub_d1_first', interval '2 minutes') is not null$q$
);

update public.subscription_writes set claimed_at = now() - interval '1 hour' where stripe_subscription_id = 'sub_d1_first';

select pg_temp.holds (
    'a lease left by a dead isolate is taken over once stale',
    $q$select public.claim_subscription_write ('sub_d1_first', interval '2 minutes') is not null$q$
);

-- ===========================================================================
-- Who may claim an event
-- ===========================================================================
select pg_temp.act_as ('authenticated');

select pg_temp.refused (
    'a signed-in user cannot claim a webhook event',
    $q$select public.claim_stripe_event ('evt_d1_c', 'checkout.session.completed', interval '10 minutes')$q$,
    '42501'
);

select pg_temp.act_as ('anon');

select pg_temp.refused (
    'nor can an anonymous caller',
    $q$select public.claim_stripe_event ('evt_d1_c', 'checkout.session.completed', interval '10 minutes')$q$,
    '42501'
);

select pg_temp.refused (
    'and the events table itself stays out of reach',
    $q$select count(*) from public.stripe_events$q$,
    '42501'
);

-- The two locks are service-role business too. A buyer who could take their own
-- checkout lock could park it and lock themselves out of paying; one who could
-- take a subscription's write lock could refuse every webhook about it.
select pg_temp.refused (
    'nor can an anonymous caller take a checkout attempt lock',
    $q$select * from public.begin_checkout_attempt (
           'd1c00000-0000-4000-8000-0000000000a1', 'live', interval '2 minutes'
       )$q$,
    '42501'
);

select pg_temp.refused (
    'or release one',
    $q$select public.release_checkout_attempt (
           'd1c00000-0000-4000-8000-0000000000a1', 'live', '00000000-0000-4000-8000-000000000999'
       )$q$,
    '42501'
);

select pg_temp.refused (
    'or record a session against one',
    $q$select public.finish_checkout_attempt (
           'd1c00000-0000-4000-8000-0000000000a1',
           'live',
           '00000000-0000-4000-8000-000000000999',
           '11111111-0000-4000-8000-000000000003',
           'price_teacher_annual',
           'cs_forged'
       )$q$,
    '42501'
);

select pg_temp.refused (
    'or read the attempts table',
    $q$select count(*) from public.checkout_attempts$q$,
    '42501'
);

select pg_temp.refused (
    'or take a subscription write lock',
    $q$select public.claim_subscription_write ('sub_d1_first', interval '2 minutes')$q$,
    '42501'
);

select pg_temp.refused (
    'or release one',
    $q$select public.release_subscription_write ('sub_d1_first', '00000000-0000-4000-8000-000000000999')$q$,
    '42501'
);

select pg_temp.refused (
    'or read the write locks table',
    $q$select count(*) from public.subscription_writes$q$,
    '42501'
);

select pg_temp.act_as_server ();

-- ---------------------------------------------------------------------------
-- Report
-- ---------------------------------------------------------------------------
select n, check_name, passed, detail
from integrity_results
where not passed
union all
select
    null,
    case
        when bool_and(passed) then 'ALL ' || count(*) || ' CHECKS PASSED'
        else count(*) filter (where not passed) || ' OF ' || count(*) || ' CHECKS FAILED'
    end,
    bool_and(passed),
    null
from integrity_results
order by n nulls last;

rollback;
