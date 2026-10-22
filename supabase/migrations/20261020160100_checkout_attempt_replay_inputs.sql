-- Replaying a dead checkout attempt's idempotency key with the SAME parameters
-- (launch compliance fix pass, Codex finding 1 on #62).
--
-- Layer 4b of checkoutFlow.ts replays the key an attempt staged and then died
-- holding, so Stripe answers with the session that attempt opened instead of
-- making a second one. Stripe only replays a key for a request whose parameters
-- are IDENTICAL to the first one; a replay with different parameters is refused
-- with an idempotency error. The checkout consent added with #62 broke that:
-- every request records a fresh `checkout_consents` row, its id goes into the
-- session's metadata, so the replay carried a different `consent_id` from the
-- request it was replaying and Stripe refused it.
--
-- So the attempt now stages what the replay has to reproduce, beside the key:
--
--   * `consent_id`  -- the consent the original request recorded, which the
--                      replay reuses rather than recording another;
--   * `params_hash` -- a SHA-256 of the session parameters (and the consent
--                      wording) the original request sent. The replay rebuilds
--                      its parameters and replays the key only if the hash
--                      matches; anything else -- a changed origin, a reworded
--                      submit message after a deploy -- mints a fresh key and
--                      expires the orphan instead (layer 5).
--
-- Both are cleared whenever a session is recorded or the key is discarded:
-- replay only ever applies to a staged key with no session.
alter table public.checkout_attempts
    add column if not exists consent_id uuid,
    add column if not exists params_hash text;

-- The answer gains the two columns, which is a new return type, so the function
-- is dropped and recreated rather than replaced. Callers that read the four old
-- columns by name are unaffected by the two new ones.
drop function if exists public.begin_checkout_attempt (uuid, text, interval);

create or replace function public.begin_checkout_attempt (p_user uuid, p_mode text, p_stale_after interval)
returns table (
    holder uuid,
    attempt_id uuid,
    price_id text,
    session_id text,
    consent_id uuid,
    params_hash text
)
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

    return query
    select v_holder, v_row.attempt_id, v_row.price_id, v_row.session_id, v_row.consent_id, v_row.params_hash;
end;
$$;

-- Staging takes the two new inputs. Defaulted, so a function deployed before
-- this migration (five named arguments) still stages -- without them, which the
-- flow reads as "not replayable" and answers with a fresh key.
drop function if exists public.stage_checkout_attempt (uuid, text, uuid, uuid, text);

create or replace function public.stage_checkout_attempt (
    p_user uuid,
    p_mode text,
    p_holder uuid,
    p_attempt_id uuid,
    p_price_id text,
    p_consent_id uuid default null,
    p_params_hash text default null
) returns boolean language plpgsql set search_path = public as $$
begin
    update public.checkout_attempts
    set attempt_id = p_attempt_id,
        price_id = p_price_id,
        session_id = null,
        consent_id = p_consent_id,
        params_hash = p_params_hash,
        updated_at = now()
    where user_id = p_user and mode = p_mode and holder = p_holder;

    return found;
end;
$$;

-- Recording a session (or discarding the key) ends any chance of a replay, so
-- the replay inputs go with it. Same signature, same lease scoping.
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
        consent_id = null,
        params_hash = null,
        updated_at = now()
    where user_id = p_user and mode = p_mode and holder = p_holder;

    return found;
end;
$$;

revoke all on function public.begin_checkout_attempt (uuid, text, interval) from public, anon, authenticated;
revoke all on function public.stage_checkout_attempt (uuid, text, uuid, uuid, text, uuid, text)
from public, anon, authenticated;

grant execute on function public.begin_checkout_attempt (uuid, text, interval) to service_role;
grant execute on function public.stage_checkout_attempt (uuid, text, uuid, uuid, text, uuid, text) to service_role;
