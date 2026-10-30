-- Persist a checkout attempt's Stripe idempotency key BEFORE the session is
-- created with it (QA round 4 review of #56, finding 1).
--
-- What 20261012120103 left open. The attempt id that the Stripe idempotency key
-- is derived from was minted in the Edge Function's memory one line above
-- `checkout.sessions.create`, and only written to `checkout_attempts` by
-- `finish_checkout_attempt` AFTER the create returned. Everything between those
-- two points -- which is the slowest call in the whole flow -- was therefore
-- unrecoverable: an isolate killed there left a session Stripe had created and
-- this database had never heard of, and the buyer's next attempt minted a FRESH
-- key, so Stripe made them a second one. Two payable sessions, which is the
-- double charge again.
--
-- The second half of the same finding is the lease. Two minutes was shorter than
-- the wall-clock ceiling an invocation may legally reach, so a create that was
-- merely SLOW -- Stripe retrying behind the SDK -- outlived its own lease, and a
-- second request took the lock from a request that was still running, found no
-- open session yet (the first create had not returned), expired nothing, and
-- opened its own. checkoutFlow.ts now asks for five minutes
-- (CHECKOUT_ATTEMPT_STALE_AFTER); the interval is the caller's argument, so
-- nothing here changes for it.
--
-- `stage_checkout_attempt` is what makes both safe, and it does it without
-- betting on arithmetic about how long an invocation may run:
--
--   * it writes the attempt id and price under the CURRENT lease and keeps the
--     lease, so the key reaching Stripe is one a later attempt can read back and
--     replay -- Stripe answers a repeated key with its original response for 24
--     hours, so the session the dead attempt opened comes back instead of a
--     second one;
--   * it is scoped to `holder`, like finish and release, so an attempt whose
--     lease HAS been taken over cannot stage and therefore never reaches the
--     create at all. A takeover can no longer produce two sessions however the
--     lease length compares to the invocation ceiling.
--
-- `session_id` is cleared on purpose. By the time this runs the stored session
-- has either been handed back to the buyer (layer 4) or expired (layer 5), so
-- leaving the id would point the next attempt's reuse at a session that is dead
-- -- and a null session id beside a non-null attempt id is exactly the state
-- layer 4b recognises as "this key may need replaying".
--
-- `claimed_at` is deliberately NOT re-stamped: the lease is one window from
-- `begin_checkout_attempt`, which is what keeps the bound on how long a buyer
-- can be locked out by a dead isolate readable (one lease, not two).
create or replace function public.stage_checkout_attempt (
    p_user uuid,
    p_mode text,
    p_holder uuid,
    p_attempt_id uuid,
    p_price_id text
) returns boolean language plpgsql set search_path = public as $$
begin
    update public.checkout_attempts
    set attempt_id = p_attempt_id,
        price_id = p_price_id,
        session_id = null,
        updated_at = now()
    where user_id = p_user and mode = p_mode and holder = p_holder;

    return found;
end;
$$;

revoke all on function public.stage_checkout_attempt (uuid, text, uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.stage_checkout_attempt (uuid, text, uuid, uuid, text) to service_role;
