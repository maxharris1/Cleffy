-- One checkout attempt at a time per buyer per Stripe account (QA round 4, D1
-- follow-up).
--
-- What the first round of fixes missed: expiring the customer's open sessions
-- before creating another, and keying creation on an idempotency key, only
-- serialise a double-submit that happens to agree about the purchase. Two
-- requests that disagree -- Teacher in one tab, Academy in the other -- or that
-- straddle the key's time bucket get DIFFERENT idempotency keys, so Stripe
-- creates two sessions; and because the two isolates interleave (both list,
-- both find the other's session absent or already kept, both create), the expire
-- step can leave both open. Two open sessions are two payable sessions, which is
-- the double charge again by another road.
--
-- Edge isolates share no memory, so the mutual exclusion has to live here. A
-- transaction-scoped advisory lock cannot: the critical section spans several
-- Stripe round trips, and PostgREST ends the transaction with the statement. So
-- the lock is a leased row instead -- taken by `begin_checkout_attempt`,
-- released by `finish_checkout_attempt` (recording the session it opened) or by
-- `release_checkout_attempt` (recording nothing), and reclaimable once the lease
-- goes stale, so an isolate that dies mid-checkout does not lock a buyer out of
-- paying us.
--
-- The row outlives the lock on purpose. It remembers the session the last
-- attempt opened, which is what lets the next request hand the buyer back the
-- session they already have instead of minting a second one, and it remembers
-- the attempt id that session's idempotency key was derived from, so a NEW
-- attempt always gets a new key -- Stripe replays a key for 24 hours, and
-- replaying a key whose session we have since expired would send the buyer to a
-- dead Checkout page.
create table if not exists public.checkout_attempts (
    user_id uuid not null references auth.users (id) on delete cascade,
    mode text not null check (mode in ('live', 'test')),
    -- Non-null exactly while a request is inside the critical section. The
    -- value is the token that request has to present to release it, so a
    -- request whose lease went stale cannot release the one that took over.
    holder uuid,
    claimed_at timestamptz not null default now(),
    -- The session the last attempt opened, and the attempt id its Stripe
    -- idempotency key was built from. Null until a session has been opened.
    attempt_id uuid,
    price_id text,
    session_id text,
    updated_at timestamptz not null default now(),
    primary key (user_id, mode)
);

-- Service role only, like every other billing table: the client never reads or
-- writes this, and a buyer who could would be a buyer who could park a lock on
-- their own account or point it at someone else's session. No policy, so RLS
-- refuses every client role outright.
alter table public.checkout_attempts enable row level security;

-- service_role bypasses RLS but still needs the table-level grant (see
-- 20260827140000_core_table_grants.sql): on the local image the default ACL for
-- a table `postgres` created gives nobody DML, so without this the functions
-- below answer 42501 before RLS is ever consulted.
grant all on table public.checkout_attempts to service_role;

-- Take the lock, and answer with what the last attempt left behind.
--
-- One statement, so two isolates racing cannot both win: the conditional
-- `on conflict do update ... where` is what decides, and Postgres takes a row
-- lock for the duration of it. An empty result means someone else holds the
-- lease and has not let go of it yet -- stripe-checkout answers that request
-- with a 409 rather than opening a session beside theirs.
--
-- `attempt_id` / `price_id` / `session_id` come back as they were stored: the
-- update deliberately leaves them alone, because the caller needs the PREVIOUS
-- attempt's session to decide whether to reuse it.
create or replace function public.begin_checkout_attempt (p_user uuid, p_mode text, p_stale_after interval)
returns table (holder uuid, attempt_id uuid, price_id text, session_id text)
language plpgsql set search_path = public as $$
declare
    v_holder uuid := gen_random_uuid();
    v_row public.checkout_attempts;
begin
    insert into public.checkout_attempts as c (user_id, mode, holder, claimed_at, updated_at)
    values (p_user, p_mode, v_holder, now(), now())
    on conflict (user_id, mode) do update
    set holder = v_holder,
        claimed_at = now(),
        updated_at = now()
    where c.holder is null
       or c.claimed_at < now() - p_stale_after
    returning * into v_row;

    if not found then
        return;
    end if;

    return query select v_holder, v_row.attempt_id, v_row.price_id, v_row.session_id;
end;
$$;

-- Release the lock, recording the session this attempt opened.
--
-- Scoped to our own lease (`holder = p_holder`), like the webhook's claim: if
-- ours went stale and another request took it over, that request's session is
-- the live one and overwriting it would point the next reuse at a session we
-- had already abandoned. `false` says exactly that happened.
create or replace function public.finish_checkout_attempt (
    p_user uuid,
    p_mode text,
    p_holder uuid,
    p_attempt_id uuid,
    p_price_id text,
    p_session_id text
) returns boolean language plpgsql set search_path = public as $$
begin
    update public.checkout_attempts
    set holder = null,
        attempt_id = p_attempt_id,
        price_id = p_price_id,
        session_id = p_session_id,
        updated_at = now()
    where user_id = p_user and mode = p_mode and holder = p_holder;

    return found;
end;
$$;

-- Release the lock having opened nothing, leaving the stored session as it was:
-- every refusal and every failure between taking the lock and creating a
-- session. Without it the buyer would wait out the lease before they could try
-- again.
create or replace function public.release_checkout_attempt (p_user uuid, p_mode text, p_holder uuid)
returns boolean language plpgsql set search_path = public as $$
begin
    update public.checkout_attempts
    set holder = null,
        updated_at = now()
    where user_id = p_user and mode = p_mode and holder = p_holder;

    return found;
end;
$$;

revoke all on function public.begin_checkout_attempt (uuid, text, interval) from public, anon, authenticated;
revoke all on function public.finish_checkout_attempt (uuid, text, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.release_checkout_attempt (uuid, text, uuid) from public, anon, authenticated;

grant execute on function public.begin_checkout_attempt (uuid, text, interval) to service_role;
grant execute on function public.finish_checkout_attempt (uuid, text, uuid, uuid, text, text) to service_role;
grant execute on function public.release_checkout_attempt (uuid, text, uuid) to service_role;
