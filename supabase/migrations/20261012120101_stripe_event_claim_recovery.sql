-- Make a webhook event's claim recoverable (QA round 4, D2).
--
-- stripe-webhook claims an event id before it processes the event, so two
-- concurrent deliveries of the same event cannot both apply it. The claim was a
-- committed row and the only compensation was an in-process delete: if the
-- isolate died between claiming and finishing -- a timeout on the Stripe
-- read-back, an OOM, a deploy restarting the worker -- no catch ran, the row
-- stayed, and every one of Stripe's retries for the next three days answered
-- `200 duplicate`. For checkout.session.completed that is a customer who paid
-- and was never entitled, and nothing swept for claims that had never been
-- applied.
--
-- So a claim now records that it is in progress and when it was taken. An
-- unfinished one goes stale and Stripe's own retry re-claims it; a finished one
-- is a duplicate forever, as before.

-- Every row that exists was written by the old claim, which processed the event
-- in the same invocation and had no other state to be in -- so 'done' is what
-- they are, and the default is what backfills them. Nothing inserts without
-- naming a status (claim_stripe_event below always does), so the default only
-- ever decides for these historical rows.
alter table public.stripe_events
    add column if not exists status text not null default 'done' check (status in ('processing', 'done')),
    add column if not exists claimed_at timestamptz not null default now();

-- Claim an event, or say that someone else holds it.
--
-- Why a function rather than the upsert this replaces: the claim has to stay a
-- SINGLE statement, or two deliveries racing can both read "not claimed" and
-- both process. PostgREST's upsert can express "insert, ignore a conflict" but
-- not "insert, or take the row over when the claim on it has gone stale", which
-- is a conditional `on conflict do update ... where`.
--
-- It answers with the stamp it wrote rather than a boolean, so the answer says
-- both "do I own this?" (non-null) and WHICH claim is mine. The webhook needs
-- the second part: releasing a claim after a failure must delete the row only
-- while it is still this invocation's claim -- if the claim went stale and
-- another delivery took it over, deleting would strand that one and let a third
-- delivery in beside it.
--
--  * no row            -> claimed, and this invocation processes the event;
--  * 'done'            -> null; it has been applied, and a replay must not
--                         re-apply it;
--  * 'processing', recent -> null; another delivery is genuinely in flight, and
--                         both applying it is what the claim exists to stop;
--  * 'processing', stale -> claimed; whoever took it never finished, so this
--                         delivery takes it over and processes it.
--
-- Re-processing a taken-over event is safe: every write the handler makes is an
-- upsert keyed on the Stripe id, or an RPC (apply_free_tier_archival /
-- restore_plan_archived_scores) that recomputes from the entitlements the
-- database holds now rather than stepping a counter.
--
-- `type` is refreshed on a takeover for the same reason the insert records it:
-- it is only ever read by a human looking at the row.
create or replace function public.claim_stripe_event (p_id text, p_type text, p_stale_after interval)
returns timestamptz language plpgsql set search_path = public as $$
declare
    v_claimed_at timestamptz;
begin
    insert into public.stripe_events as e (id, type, status, claimed_at)
    values (p_id, p_type, 'processing', now())
    on conflict (id) do update
    set status = 'processing',
        claimed_at = now(),
        type = excluded.type
    where e.status = 'processing'
      and e.claimed_at < now() - p_stale_after
    returning claimed_at into v_claimed_at;

    return v_claimed_at;
end;
$$;

-- Service role only, like every other billing write: to anyone else this would
-- be a way to claim an event Stripe has not delivered yet and have the real
-- delivery answered as a duplicate -- a purchase acknowledged and dropped.
revoke all on function public.claim_stripe_event (text, text, interval) from public, anon, authenticated;

grant execute on function public.claim_stripe_event (text, text, interval) to service_role;
