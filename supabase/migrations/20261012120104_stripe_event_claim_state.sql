-- Tell a webhook delivery WHY it did not get the claim (QA round 4, D2
-- follow-up).
--
-- claim_stripe_event (migration 20261012120101) answers with the stamp it wrote
-- and null for everything else, and null conflates the two outcomes that want
-- opposite answers:
--
--  * 'done'       -- the event has been applied. A redelivery is a duplicate and
--                    200 is right: nothing is lost by acknowledging it.
--  * 'processing' -- another delivery holds the claim and has not finished. A
--                    200 here tells Stripe the event landed, and Stripe stops
--                    retrying it. If that other delivery then dies -- the very
--                    case 120101 exists for -- the claim goes stale with nobody
--                    left to retry it: for checkout.session.completed, a
--                    customer charged and never entitled. The staleness window
--                    only helps if Stripe is still delivering.
--
-- So the claim now says which of the three it is, and stripe-webhook answers a
-- live claim with a 409 (Stripe retries) instead of a 200 (Stripe forgets). The
-- 409 is the honest answer either way: this delivery did nothing, and the event
-- has not been applied by anyone yet.
--
-- The losing read is a second statement, which is harmless: mutual exclusion is
-- entirely the conditional upsert's, and a losing caller is only describing a
-- row it is not allowed to touch. A row that vanishes between the two (a
-- release by the holder) reads as 'absent', which the caller treats like a live
-- claim -- a retry, which re-claims it.
-- The ledger has never carried a grant of its own, which the hosted image's
-- permissive default ACL hid: locally, a table `postgres` created gives nobody
-- DML, so the claim below -- and the webhook's own update of `status` through
-- PostgREST -- answers 42501 before RLS is consulted. Idempotent, and the
-- claim states this migration adds are the first thing a local run would have
-- needed it for.
grant all on table public.stripe_events to service_role;

drop function if exists public.claim_stripe_event (text, text, interval);

create or replace function public.claim_stripe_event (p_id text, p_type text, p_stale_after interval)
returns table (state text, claimed_at timestamptz) language plpgsql set search_path = public as $$
declare
    v_claimed_at timestamptz;
    v_status text;
begin
    insert into public.stripe_events as e (id, type, status, claimed_at)
    values (p_id, p_type, 'processing', now())
    on conflict (id) do update
    set status = 'processing',
        claimed_at = now(),
        type = excluded.type
    where e.status = 'processing'
      and e.claimed_at < now() - p_stale_after
    returning e.claimed_at into v_claimed_at;

    if v_claimed_at is not null then
        return query select 'claimed'::text, v_claimed_at;
        return;
    end if;

    -- Lost it. Which way decides whether Stripe should keep trying.
    select e.status into v_status from public.stripe_events e where e.id = p_id;

    return query select coalesce(v_status, 'absent')::text, null::timestamptz;
end;
$$;

revoke all on function public.claim_stripe_event (text, text, interval) from public, anon, authenticated;

grant execute on function public.claim_stripe_event (text, text, interval) to service_role;
