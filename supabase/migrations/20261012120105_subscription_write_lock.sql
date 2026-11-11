-- Serialise the webhook's read-back-and-write per subscription (QA round 4, D3
-- follow-up).
--
-- The `subscriptions_refuse_stale_event` trigger (migration 20261012120102)
-- compares the Stripe `created` stamp of the event each write carries and keeps
-- the newest. That closes reordering between events Stripe stamped a second or
-- more apart, and nothing finer: `created` has one-second resolution, so two
-- events created inside the same second compare EQUAL, and equal has to pass --
-- a retry of one event must be able to write the same state again. So the
-- window the trigger cannot see is exactly the one that matters:
-- `customer.subscription.updated` for a card failure and one for the retry
-- succeeding, both stamped 17:04:09, delivered concurrently. A reads `active`
-- from Stripe, B reads `past_due`, B writes, A writes -- and the row says a
-- customer whose card failed is paid up until the next event about them, a month
-- or a year away.
--
-- Widening the comparison to `<=` would not fix it (it would refuse the equal
-- stamp a retry needs, and still not order the two) and neither would a finer
-- clock, because the race is not in the comparison: it is that the Stripe READ
-- and the DB WRITE are two steps with a gap between them. What removes it is
-- making the pair atomic per subscription -- whoever holds the lock reads the
-- subscription as Stripe holds it NOW and writes that, and the other delivery
-- does its own read afterwards and therefore reads the same or newer state.
--
-- Same shape as the event claim, for the same reason (an Edge isolate shares no
-- memory with the next one, and PostgREST cannot hold a transaction open across
-- a Stripe round trip): a leased row, reclaimable once stale so a dead isolate
-- cannot wedge a subscription, and a delivery that cannot get it is answered
-- with a 503 so Stripe redelivers it rather than a 200 that drops it.
create table if not exists public.subscription_writes (
    stripe_subscription_id text primary key,
    holder uuid not null,
    claimed_at timestamptz not null default now()
);

-- Service role only, like the event ledger beside it: no policy, and the
-- table-level grant service_role needs even though it bypasses RLS (see
-- 20260827140000_core_table_grants.sql).
alter table public.subscription_writes enable row level security;

grant all on table public.subscription_writes to service_role;

-- Take the lock for one subscription, or answer null because someone holds it.
--
-- One statement, so two deliveries cannot both win. The lease is what keeps an
-- isolate that died mid-write from locking a subscription out of every later
-- event; `p_stale_after` is the caller's (STRIPE_SUBSCRIPTION_LOCK_STALE_AFTER).
create or replace function public.claim_subscription_write (p_subscription_id text, p_stale_after interval)
returns uuid language plpgsql set search_path = public as $$
declare
    v_holder uuid := gen_random_uuid();
    v_won uuid;
begin
    insert into public.subscription_writes as w (stripe_subscription_id, holder, claimed_at)
    values (p_subscription_id, v_holder, now())
    on conflict (stripe_subscription_id) do update
    set holder = v_holder,
        claimed_at = now()
    where w.claimed_at < now() - p_stale_after
    returning w.holder into v_won;

    return v_won;
end;
$$;

-- Give it back, but only while it is still ours: a lease that went stale and was
-- taken over belongs to the delivery holding it now, and releasing that one
-- would let a third delivery in beside it.
create or replace function public.release_subscription_write (p_subscription_id text, p_holder uuid)
returns boolean language plpgsql set search_path = public as $$
begin
    delete from public.subscription_writes
    where stripe_subscription_id = p_subscription_id and holder = p_holder;

    return found;
end;
$$;

revoke all on function public.claim_subscription_write (text, interval) from public, anon, authenticated;
revoke all on function public.release_subscription_write (text, uuid) from public, anon, authenticated;

grant execute on function public.claim_subscription_write (text, interval) to service_role;
grant execute on function public.release_subscription_write (text, uuid) to service_role;
