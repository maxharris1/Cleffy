-- save_cancel_link_token answers text again, so 20261020160300 replays (a
-- follow-up to 20261020160400, Codex round 5 on #62).
--
-- 20261020160400 changed save_cancel_link_token's result from text to jsonb
-- ({answer, remaining_seconds}) by dropping and recreating it. That left
-- 20261020160300 unable to replay over a database that has 20261020160400:
-- its `create or replace function public.save_cancel_link_token (...) returns
-- text` fails with "cannot change return type of existing function". A
-- recovery replays migrations over a database that may already hold them
-- (tests/migrationRecoverability.test.ts), so that is not allowed to fail --
-- and 20261020160400, already pushed, is not edited.
--
-- So the jsonb save gets a name of its own, save_cancel_link_token_v2 (what
-- billingCancelStore.ts calls), with exactly the body 20261020160400 gave the
-- save: the row locked FOR UPDATE, clock_timestamp() read after the lock, a
-- tombstoned hash or outbox id refused (`spent`), under 120 seconds refused
-- (`expired`, the row settled), the seconds left on the database's clock in
-- the answer. save_cancel_link_token is put back to `returns text`, as
-- 20261020160300 made it, answering v2's `answer`: the same save under every
-- guard, for the previous edge function while the one in this PR deploys (it
-- does not know `spent`, so it retries -- the row is already settled -- and
-- never sends on it).
--
-- Replaying 20261020160300, 20261020160400 and this one in order now succeeds
-- and ends here; CI's supabase-local job does exactly that, and
-- tests/sql/cancel_link_db_clock.sql and cancel_link_tombstones.sql prove v2.
--
-- Safe to re-run: the old save is dropped IF EXISTS whatever its result type
-- (only the argument types name it), and both functions are CREATE OR REPLACE.

drop function if exists public.save_cancel_link_token (uuid, uuid, text, uuid);

-- ---------------------------------------------------------------------------
-- save_cancel_link_token_v2: on the database's clock, after the lock
-- ---------------------------------------------------------------------------
-- Answers {"answer": ..., "remaining_seconds": n}:
--   saved    -- the token is stored (now, or by an earlier attempt at this row,
--               whose expiry and used_at are left exactly as they were), with
--               n >= 120 seconds left: the caller may send, and only then;
--   expired  -- fewer than 120 seconds are left (n, at most 119, never below
--               0): nothing is saved, the row is settled `expired` without its
--               address, and the caller must not send;
--   spent    -- this link (its hash) or its request (the row id) was deleted
--               before: nothing is saved, the row is settled `expired`, and
--               the caller must not send;
--   not_held -- the caller does not hold this row's lease (another worker took
--               it over, or the row was settled): it must not send.
-- The row is locked FOR UPDATE first, so two saves of one row run one after
-- the other, and the clock is read only once the lock is held: however long
-- the wait, the time left is the time left now. A row settled here keeps its
-- lease, so the worker holding it records the outcome as it would have.
-- SECURITY DEFINER: the service role no longer inserts tokens itself.
create or replace function public.save_cancel_link_token_v2 (
    p_outbox_id uuid,
    p_claim uuid,
    p_hash text,
    p_user uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_mode text;
    v_expires timestamptz;
    v_left integer;
begin
    select o.mode, o.link_expires_at into v_mode, v_expires
    from public.billing_mail_outbox o
    where o.id = p_outbox_id
      and o.claim_token = p_claim
      and o.kind = 'cancel_link'
      and o.status = 'pending'
    for update;
    if not found then
        return jsonb_build_object('answer', 'not_held', 'remaining_seconds', 0);
    end if;

    if exists (
        select 1 from public.billing_cancel_token_tombstones t
        where t.token_hash = p_hash or t.outbox_id = p_outbox_id
    ) then
        update public.billing_mail_outbox
        set status = 'expired', last_error = 'cancel link already spent or removed', payload = payload - 'email'
        where id = p_outbox_id;
        return jsonb_build_object('answer', 'spent', 'remaining_seconds', 0);
    end if;

    -- A token an earlier attempt saved may have had its expiry brought
    -- forward since; the sooner of the two is the one that counts.
    v_expires := least(v_expires, (select t.expires_at from public.billing_cancel_tokens t where t.token_hash = p_hash));
    if v_expires is null
       or v_expires - clock_timestamp() < interval '120 seconds' then
        v_left := greatest(0, coalesce(floor(extract(epoch from v_expires - clock_timestamp()))::integer, 0));
        update public.billing_mail_outbox
        set status = 'expired', last_error = 'expired before delivery', payload = payload - 'email'
        where id = p_outbox_id;
        return jsonb_build_object('answer', 'expired', 'remaining_seconds', v_left);
    end if;
    v_left := floor(extract(epoch from v_expires - clock_timestamp()))::integer;

    insert into public.billing_cancel_tokens (token_hash, user_id, mode, expires_at, outbox_id)
    values (p_hash, p_user, v_mode, v_expires, p_outbox_id)
    on conflict (token_hash) do nothing;
    return jsonb_build_object('answer', 'saved', 'remaining_seconds', v_left);
end;
$$;

revoke all on function public.save_cancel_link_token_v2 (uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.save_cancel_link_token_v2 (uuid, uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- save_cancel_link_token: the same save, answering only its `answer`
-- ---------------------------------------------------------------------------
-- `returns text`, as 20261020160300 made it. SECURITY DEFINER like v2, whose
-- insert it makes.
create or replace function public.save_cancel_link_token (
    p_outbox_id uuid,
    p_claim uuid,
    p_hash text,
    p_user uuid
) returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
    return public.save_cancel_link_token_v2 (p_outbox_id, p_claim, p_hash, p_user)->>'answer';
end;
$$;

revoke all on function public.save_cancel_link_token (uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.save_cancel_link_token (uuid, uuid, text, uuid) to service_role;
