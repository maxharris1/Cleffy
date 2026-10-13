-- The double-charge guards (migrations 20261012120100 / 120101 / 120102):
-- at most one entitling subscription per user per Stripe account, a webhook
-- claim that can be taken over when its delivery died, and a subscription write
-- that cannot be overwritten by an older Stripe event.
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
create temp table claims (label text primary key, stamp timestamptz);

grant all on claims to public;

insert into claims (label, stamp)
values ('evt_d1_a', public.claim_stripe_event ('evt_d1_a', 'checkout.session.completed', interval '10 minutes'));

select pg_temp.holds (
    'a fresh event is claimed',
    $q$select stamp is not null from claims where label = 'evt_d1_a'$q$
);

select pg_temp.holds (
    'and the claim is recorded as in progress',
    $q$select status = 'processing' from public.stripe_events where id = 'evt_d1_a'$q$
);

-- It answers with the stamp rather than a boolean so the webhook can release
-- (or finish) exactly the claim it holds and nobody else's.
select pg_temp.holds (
    'the stamp it answers with is the claim it wrote',
    $q$select c.stamp = e.claimed_at
       from claims c
       join public.stripe_events e on e.id = c.label
       where c.label = 'evt_d1_a'$q$
);

select pg_temp.holds (
    'a second delivery of an in-flight event is refused the claim',
    $q$select public.claim_stripe_event ('evt_d1_a', 'checkout.session.completed', interval '10 minutes') is null$q$
);

-- What the handler does on every 2xx it finished with.
update public.stripe_events set status = 'done', processed_at = now() where id = 'evt_d1_a';

select pg_temp.holds (
    'a finished event is never claimed again, however old',
    $q$select public.claim_stripe_event ('evt_d1_a', 'checkout.session.completed', interval '1 second') is null$q$
);

-- The isolate that died holding the claim: nothing marked it done, nothing
-- released it. Before the migration this answered `duplicate` for the three
-- days Stripe retries, and a purchase was charged and never applied.
select public.claim_stripe_event ('evt_d1_b', 'customer.subscription.updated', interval '10 minutes');

update public.stripe_events set claimed_at = now() - interval '1 hour' where id = 'evt_d1_b';

select pg_temp.holds (
    'a stale claim is taken over, and the takeover re-stamps it',
    $q$select public.claim_stripe_event ('evt_d1_b', 'customer.subscription.updated', interval '10 minutes')
             > now() - interval '1 minute'$q$
);

select pg_temp.holds (
    'the taken-over claim is in flight again, not done',
    $q$select status = 'processing' from public.stripe_events where id = 'evt_d1_b'$q$
);

select pg_temp.holds (
    'and it is now too fresh for a third delivery to take',
    $q$select public.claim_stripe_event ('evt_d1_b', 'customer.subscription.updated', interval '10 minutes') is null$q$
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
