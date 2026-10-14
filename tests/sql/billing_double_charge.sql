-- The double-charge guards (migrations 20261012120100 through 120105, and
-- 20261013120100 through 120102): at most one entitling subscription per user
-- per Stripe account, a webhook claim that can be taken over when its delivery
-- died and that says WHY it was refused, a subscription write that cannot be
-- overwritten by an older Stripe event, the two leased locks that serialise what
-- no comparison can -- one checkout attempt per buyer, one writer per
-- subscription -- and the three things the QA round 4 review of #56 added to
-- them: a checkout idempotency key made durable under its own lease before
-- Stripe is asked to use it, a subscription write that refuses a lease it no
-- longer holds, and a ledger that keeps a duplicate's unmade refund owed after
-- the event that found it has been acknowledged.
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
    ('d1c00000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'd1-other@example.invalid'),
    ('d1c00000-0000-4000-8000-0000000000a3', 'authenticated', 'authenticated', 'd1-third@example.invalid');

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
-- stage_checkout_attempt: the idempotency key, durable before Stripe sees it
-- ===========================================================================
-- What the lock above still left open (QA round 4 review of #56, finding 1).
-- The attempt id the Stripe idempotency key is derived from lived in the Edge
-- isolate's memory until finish_checkout_attempt recorded it, which is AFTER
-- `checkout.sessions.create` returned. An isolate killed in that window left a
-- payable session in Stripe that nothing here knew about, and the buyer's next
-- attempt minted a fresh key -- so Stripe made them a second one. Staged first,
-- the next attempt reads the key back and replays it, and Stripe answers with
-- the session the dead attempt opened.
--
-- The other half of the same finding was the lease being SHORTER than an
-- invocation may run. That is a number in checkoutFlow.ts
-- (CHECKOUT_ATTEMPT_STALE_AFTER) and not something SQL can hold; what SQL holds
-- is the consequence -- staging is scoped to `holder`, so a request whose lease
-- was taken over cannot stage, and therefore never reaches the create at all,
-- however the lease compares to the ceiling.
insert into attempts (label, holder, session_id, price_id)
select 'staging', holder, session_id, price_id
from public.begin_checkout_attempt (
    'd1c00000-0000-4000-8000-0000000000a3', 'live', interval '5 minutes'
);

select pg_temp.holds (
    'staging records the key and the price while KEEPING the lock',
    $q$select public.stage_checkout_attempt (
           'd1c00000-0000-4000-8000-0000000000a3',
           'live',
           (select holder from attempts where label = 'staging'),
           '22222222-0000-4000-8000-000000000001',
           'price_teacher_annual'
       )$q$
);

select pg_temp.holds (
    'the key is readable back, and the lock is still held',
    $q$select attempt_id = '22222222-0000-4000-8000-000000000001'
          and price_id = 'price_teacher_annual'
          and session_id is null
          and holder = (select holder from attempts where label = 'staging')
       from public.checkout_attempts
       where user_id = 'd1c00000-0000-4000-8000-0000000000a3' and mode = 'live'$q$
);

-- So an overlapping request is still refused the lock, which is the point of
-- not releasing it: the Stripe create has not happened yet.
select pg_temp.holds (
    'and an overlapping request still gets nothing',
    $q$select not exists (
           select 1 from public.begin_checkout_attempt (
               'd1c00000-0000-4000-8000-0000000000a3', 'live', interval '5 minutes'
           )
       )$q$
);

-- The recovery state the flow looks for: a key with no session. This is what
-- layer 4b in checkoutFlow.ts replays rather than minting a new one.
-- Pushed back rather than waited out, and by the clock rather than by the
-- interval argument: `now()` is the transaction's start time, so `claimed_at <
-- now() - interval '0 seconds'` is false for a lease this transaction took.
update public.checkout_attempts
set claimed_at = now() - interval '1 hour'
where user_id = 'd1c00000-0000-4000-8000-0000000000a3' and mode = 'live';

select pg_temp.holds (
    'an attempt that staged and died leaves its key for the next one to replay',
    $q$select attempt_id = '22222222-0000-4000-8000-000000000001' and session_id is null
       from public.begin_checkout_attempt (
           'd1c00000-0000-4000-8000-0000000000a3', 'live', interval '5 minutes'
       )$q$
);

-- The lease takeover, which is the half that makes the lease length stop
-- mattering: the first holder above has just been superseded by the one the
-- stale-lease claim above issued.
select pg_temp.holds (
    'a request whose lease was taken over cannot stage, so it never creates',
    $q$select not public.stage_checkout_attempt (
           'd1c00000-0000-4000-8000-0000000000a3',
           'live',
           (select holder from attempts where label = 'staging'),
           '22222222-0000-4000-8000-000000000002',
           'price_academy_annual'
       )$q$
);

select pg_temp.holds (
    'and the key it tried to stage was not written',
    $q$select attempt_id = '22222222-0000-4000-8000-000000000001'
       from public.checkout_attempts
       where user_id = 'd1c00000-0000-4000-8000-0000000000a3' and mode = 'live'$q$
);

-- Staging clears the stored session on purpose: by then it has either been
-- handed back to the buyer or expired, and leaving the id would point the next
-- reuse at a session that is dead.
select pg_temp.holds (
    'staging clears a session id the previous attempt had recorded',
    $q$select public.finish_checkout_attempt (
           'd1c00000-0000-4000-8000-0000000000a3',
           'live',
           (select holder from public.checkout_attempts
            where user_id = 'd1c00000-0000-4000-8000-0000000000a3' and mode = 'live'),
           '22222222-0000-4000-8000-000000000003',
           'price_teacher_annual',
           'cs_test_staged'
       )$q$
);

insert into attempts (label, holder, session_id, price_id)
select 'restaging', holder, session_id, price_id
from public.begin_checkout_attempt (
    'd1c00000-0000-4000-8000-0000000000a3', 'live', interval '5 minutes'
);

select pg_temp.holds (
    'the next attempt is handed that session, then stages over it',
    $q$select session_id = 'cs_test_staged' from attempts where label = 'restaging'$q$
);

-- Its own statement, and the result read in the next one: an uncorrelated
-- subquery beside the function call is free to be evaluated before it (see the
-- note above the claim_stripe_event section, where that cost a check its
-- meaning).
select pg_temp.holds (
    'that attempt stages its own key over the stored session',
    $q$select public.stage_checkout_attempt (
           'd1c00000-0000-4000-8000-0000000000a3',
           'live',
           (select holder from attempts where label = 'restaging'),
           '22222222-0000-4000-8000-000000000004',
           'price_teacher_annual'
       )$q$
);

select pg_temp.holds (
    'and after staging there is no session id left to reuse',
    $q$select session_id is null and attempt_id = '22222222-0000-4000-8000-000000000004'
       from public.checkout_attempts
       where user_id = 'd1c00000-0000-4000-8000-0000000000a3' and mode = 'live'$q$
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
-- write_subscription_under_lock: the lease, checked where the write happens
-- ===========================================================================
-- What the lease above still left open (QA round 4 review of #56, finding 3).
-- Only release_subscription_write ever asked whose lease it was, so a delivery
-- whose lease had gone stale -- the Stripe read this lock is held across can
-- outlive it -- still wrote the state it had read minutes earlier, on top of the
-- newer state written by the delivery that took the lease over. The staleness
-- trigger cannot order those two: Stripe stamps `created` to the second and
-- equal stamps have to pass. So the write itself is now conditional on the
-- lease, in one statement.
--
-- One session cannot show that the `for update` closes the gap between the check
-- and the write -- that needs two -- but it can show the condition itself, which
-- is what was missing entirely.
insert into writes (label, holder)
values ('under', public.claim_subscription_write ('sub_d1_under', interval '5 minutes'));

select pg_temp.holds (
    'the lease holder writes the subscription',
    $q$select public.write_subscription_under_lock (
           (select holder from writes where label = 'under'),
           'sub_d1_under',
           'd1c00000-0000-4000-8000-0000000000a3',
           'test',
           'teacher',
           'past_due',
           'price_teacher_annual',
           now() + interval '1 month',
           false,
           '2026-10-12T17:04:09Z'
       ) = 'written'$q$
);

select pg_temp.holds (
    'and the row says what it wrote',
    $q$select status = 'past_due' and tier = 'teacher' and mode = 'test'
       from public.subscriptions where stripe_subscription_id = 'sub_d1_under'$q$
);

-- The race, as the review tells it: the stalled delivery comes back and tries
-- to write the `past_due` it read, after the delivery that took its lease over
-- has written `active`. Same Stripe `created` second, so the trigger has
-- nothing to say about it.
update public.subscription_writes
set claimed_at = now() - interval '1 hour'
where stripe_subscription_id = 'sub_d1_under';

insert into writes (label, holder)
values ('tookover', public.claim_subscription_write ('sub_d1_under', interval '5 minutes'));

select pg_temp.holds (
    'the delivery that took the lease over writes the newer state',
    $q$select public.write_subscription_under_lock (
           (select holder from writes where label = 'tookover'),
           'sub_d1_under',
           'd1c00000-0000-4000-8000-0000000000a3',
           'test',
           'teacher',
           'active',
           'price_teacher_annual',
           now() + interval '1 month',
           false,
           '2026-10-12T17:04:09Z'
       ) = 'written'$q$
);

select pg_temp.holds (
    'the stalled delivery is refused, because the lease is not its any more',
    $q$select public.write_subscription_under_lock (
           (select holder from writes where label = 'under'),
           'sub_d1_under',
           'd1c00000-0000-4000-8000-0000000000a3',
           'test',
           'teacher',
           'past_due',
           'price_teacher_annual',
           now() + interval '1 month',
           false,
           '2026-10-12T17:04:09Z'
       ) = 'lost_lock'$q$
);

select pg_temp.holds (
    'so the customer who fixed their card is still recorded as paid up',
    $q$select status = 'active'
       from public.subscriptions where stripe_subscription_id = 'sub_d1_under'$q$
);

-- A lease that was never taken at all is the same answer: there is no row to
-- match, so nothing is written.
select pg_temp.holds (
    'a write for a subscription nobody holds the lease on is refused',
    $q$select public.write_subscription_under_lock (
           '00000000-0000-4000-8000-000000000999',
           'sub_d1_unlocked',
           'd1c00000-0000-4000-8000-0000000000a3',
           'test',
           'teacher',
           'active',
           'price_teacher_annual',
           now() + interval '1 month',
           false,
           null
       ) = 'lost_lock'$q$
);

select pg_temp.holds (
    'and no row appeared for it',
    $q$select not exists (
           select 1 from public.subscriptions where stripe_subscription_id = 'sub_d1_unlocked'
       )$q$
);

-- The staleness trigger still wins where it can speak, through the function:
-- an older event stamp is dropped and the answer is still `written`, exactly as
-- the PostgREST upsert reported it as a success.
select pg_temp.holds (
    'an older event stamp is still dropped, and still answers written',
    $q$select public.write_subscription_under_lock (
           (select holder from writes where label = 'tookover'),
           'sub_d1_under',
           'd1c00000-0000-4000-8000-0000000000a3',
           'test',
           'free',
           'unpaid',
           'price_teacher_annual',
           now() + interval '1 month',
           false,
           '2026-10-12T17:04:08Z'
       ) = 'written'$q$
);

select pg_temp.holds (
    'and the row kept the newer state',
    $q$select status = 'active'
       from public.subscriptions where stripe_subscription_id = 'sub_d1_under'$q$
);

-- The duplicate index, named from Postgres's own diagnostics rather than from
-- the text of an error message, which is what the Edge Function used to do.
insert into writes (label, holder)
values ('dup', public.claim_subscription_write ('sub_d1_dup', interval '5 minutes'));

select pg_temp.holds (
    'a second entitling subscription for one user and account answers duplicate',
    $q$select public.write_subscription_under_lock (
           (select holder from writes where label = 'dup'),
           'sub_d1_dup',
           'd1c00000-0000-4000-8000-0000000000a1',
           'live',
           'academy',
           'active',
           'price_academy_annual',
           now() + interval '1 month',
           false,
           null
       ) = 'duplicate'$q$
);

select pg_temp.holds (
    'and the duplicate is NOT recorded',
    $q$select not exists (
           select 1 from public.subscriptions where stripe_subscription_id = 'sub_d1_dup'
       )$q$
);

-- The deleted account, which is the only foreign key on this table.
insert into writes (label, holder)
values ('gone', public.claim_subscription_write ('sub_d1_gone', interval '5 minutes'));

select pg_temp.holds (
    'a subscription whose user was deleted answers missing_user',
    $q$select public.write_subscription_under_lock (
           (select holder from writes where label = 'gone'),
           'sub_d1_gone',
           'd1c00000-0000-4000-8000-0000000000ff',
           'live',
           'teacher',
           'active',
           'price_teacher_annual',
           now() + interval '1 month',
           false,
           null
       ) = 'missing_user'$q$
);

-- Any OTHER unique violation is re-raised rather than reported as a duplicate:
-- swallowing one would turn a bug into an acknowledged event, and a Stripe
-- retry every few hours against a constraint that will never yield. Proven with
-- an index that exists only inside this transaction -- partial on a tier no row
-- here holds, so it constrains nothing already written -- created as the owner,
-- because service_role does not own the table.
select pg_temp.act_as_server ();

create unique index subscriptions_academy_once_d1 on public.subscriptions (user_id) where tier = 'academy';

select pg_temp.act_as ('service_role');

insert into writes (label, holder)
values ('other_a', public.claim_subscription_write ('sub_d1_other_a', interval '5 minutes')),
       ('other_b', public.claim_subscription_write ('sub_d1_other_b', interval '5 minutes'));

select pg_temp.holds (
    'the first row the throwaway index allows is written',
    $q$select public.write_subscription_under_lock (
           (select holder from writes where label = 'other_a'),
           'sub_d1_other_a',
           'd1c00000-0000-4000-8000-0000000000a3',
           'live',
           'academy',
           'canceled',
           'price_academy_annual',
           now() + interval '1 month',
           false,
           null
       ) = 'written'$q$
);

-- `canceled`, so it is the throwaway index that refuses this and not
-- subscriptions_one_entitling_per_user_mode.
select pg_temp.refused (
    'a unique violation on anything else is raised, not reported as duplicate',
    $q$select public.write_subscription_under_lock (
           (select holder from writes where label = 'other_b'),
           'sub_d1_other_b',
           'd1c00000-0000-4000-8000-0000000000a3',
           'live',
           'academy',
           'canceled',
           'price_academy_annual',
           now() + interval '1 month',
           false,
           null
       )$q$,
    '23505',
    '%subscriptions_academy_once_d1%'
);

-- ===========================================================================
-- duplicate_refunds: money we owe, after the event that found it is gone
-- ===========================================================================
-- QA round 4 review of #56, finding 2. A refund that failed asked Stripe to
-- redeliver -- but the CANCEL half had succeeded, so the redelivery read the
-- duplicate back as `canceled`, the partial unique index had nothing to refuse,
-- the row was written as an ordinary cancellation, and the event was
-- acknowledged 200. The duplicate branch -- the only code that ever attempted a
-- refund -- was never entered again, and nothing anywhere recorded that one was
-- owed.
select pg_temp.allowed (
    'opening the debt leaves it pending, with the user it belongs to',
    $q$select public.record_duplicate_refund (
           'sub_d1_dup', 'live', 'd1c00000-0000-4000-8000-0000000000a1'
       )$q$
);

select pg_temp.holds (
    'and a later delivery can see that something is still owed',
    $q$select user_id = 'd1c00000-0000-4000-8000-0000000000a1' and attempts = 0
       from public.pending_duplicate_refund ('sub_d1_dup', 'live')$q$
);

-- Mode-keyed like billing_customers, and read mode-filtered, so a sandbox
-- ledger row is never answered to a live delivery.
select pg_temp.holds (
    'the other Stripe account is not owed anything',
    $q$select not exists (select 1 from public.pending_duplicate_refund ('sub_d1_dup', 'test'))$q$
);

select pg_temp.allowed (
    'an attempt that failed keeps the debt open, and is counted',
    $q$select public.settle_duplicate_refund (
           'sub_d1_dup', 'live', 'pending', true, 'failed', 'stopped=true refund=failed'
       )$q$
);

select pg_temp.holds (
    'so the next delivery is still asked to retry it',
    $q$select attempts = 1 from public.pending_duplicate_refund ('sub_d1_dup', 'live')$q$
);

select pg_temp.allowed (
    'and a second opening does not reset the count',
    $q$select public.record_duplicate_refund ('sub_d1_dup', 'live', null)$q$
);

select pg_temp.holds (
    'the user it belongs to survives an opening that does not know it',
    $q$select user_id = 'd1c00000-0000-4000-8000-0000000000a1' and attempts = 1
       from public.pending_duplicate_refund ('sub_d1_dup', 'live')$q$
);

select pg_temp.allowed (
    'a refund that landed closes the debt',
    $q$select public.settle_duplicate_refund (
           'sub_d1_dup', 'live', 'resolved', true, 'refunded', 'refunded re_test'
       )$q$
);

select pg_temp.holds (
    'so nothing is owed any more',
    $q$select not exists (select 1 from public.pending_duplicate_refund ('sub_d1_dup', 'live'))$q$
);

-- A settled debt must not be reopened by another attempt at the same duplicate:
-- the undo is idempotent, so re-attempting is harmless, but money we have handed
-- back must not read as outstanding.
select pg_temp.allowed (
    'and reopening it does not make a refunded duplicate look unpaid',
    $q$select public.record_duplicate_refund (
           'sub_d1_dup', 'live', 'd1c00000-0000-4000-8000-0000000000a1'
       )$q$
);

select pg_temp.holds (
    'the ledger still says resolved',
    $q$select state = 'resolved' and attempts = 2
       from public.duplicate_refunds
       where stripe_subscription_id = 'sub_d1_dup' and mode = 'live'$q$
);

-- `needs_human` is the one outcome nothing retries: a paid invoice whose payment
-- cannot be identified reads the same way every time, so retrying would bury the
-- alert rather than surface it. The row is what a human reconciles from.
select pg_temp.allowed (
    'a refund only a human can make is recorded and not retried',
    $q$select public.record_duplicate_refund (
           'sub_d1_human', 'live', 'd1c00000-0000-4000-8000-0000000000a2'
       )$q$
);

select pg_temp.allowed (
    'settled as needs_human',
    $q$select public.settle_duplicate_refund (
           'sub_d1_human', 'live', 'needs_human', true, 'needs_human', 'refund it by hand'
       )$q$
);

select pg_temp.holds (
    'and no delivery is asked to try it again',
    $q$select not exists (select 1 from public.pending_duplicate_refund ('sub_d1_human', 'live'))$q$
);

-- The foreign key nulls the user rather than cascading: an account going away
-- does not make a refund we never issued stop being owed, and this row is the
-- only record of it -- the subscription id in it is enough to find the charge in
-- Stripe. (Spelled through confdeltype so this file keeps its promise to contain
-- no row-removal keyword; see README.md.)
select pg_temp.holds (
    'the debt outlives the account it belongs to, with the id to find it by',
    $q$select exists (
           select 1 from pg_constraint c
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
           where c.conrelid = 'public.duplicate_refunds'::regclass
             and c.contype = 'f' and a.attname = 'user_id' and c.confdeltype = 'n'
       )$q$
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

-- And the three things the review added, for the same reasons. A buyer who
-- could stage could point their own lock at a key of their choosing; one who
-- could write a subscription row could entitle themselves; one who could reach
-- the refund ledger could make a debt we owe read as settled.
select pg_temp.refused (
    'nor stage a checkout idempotency key',
    $q$select public.stage_checkout_attempt (
           'd1c00000-0000-4000-8000-0000000000a1',
           'live',
           '00000000-0000-4000-8000-000000000999',
           '22222222-0000-4000-8000-00000000009f',
           'price_teacher_annual'
       )$q$,
    '42501'
);

select pg_temp.refused (
    'nor write a subscription row under a lease',
    $q$select public.write_subscription_under_lock (
           '00000000-0000-4000-8000-000000000999',
           'sub_d1_forged',
           'd1c00000-0000-4000-8000-0000000000a1',
           'live',
           'academy',
           'active',
           'price_academy_annual',
           now() + interval '1 year',
           false,
           null
       )$q$,
    '42501'
);

select pg_temp.refused (
    'nor open a duplicate refund',
    $q$select public.record_duplicate_refund ('sub_d1_dup', 'live', null)$q$,
    '42501'
);

select pg_temp.refused (
    'nor settle one',
    $q$select public.settle_duplicate_refund (
           'sub_d1_dup', 'live', 'resolved', true, 'refunded', 'forged'
       )$q$,
    '42501'
);

select pg_temp.refused (
    'nor ask what is still owed',
    $q$select * from public.pending_duplicate_refund ('sub_d1_dup', 'live')$q$,
    '42501'
);

select pg_temp.refused (
    'nor read the refund ledger',
    $q$select count(*) from public.duplicate_refunds$q$,
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
