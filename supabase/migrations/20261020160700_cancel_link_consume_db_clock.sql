-- A cancel link is spent only while it is still good on the database's clock,
-- and spending it is what authorizes everything after it (Codex round 7 on
-- #62, its major; decisions 27, 38 and 39).
--
-- billing-cancel spent a link with an UPDATE that checked only the hash and
-- that the link was unused. Whether it had expired was asked once, earlier
-- (read_cancel_link_token, 20261020160600) -- and between that read and the
-- spend came the account lookups, Stripe's read and Stripe's update, any of
-- which can outlast the link's hour. A link read a moment before its expiry
-- was still spent after it, and the spend is what lets the refund request
-- reach support. The email promises the link works "until <time>"; after
-- that time it must do nothing. Now:
--
--   * consume_cancel_link_token (below) is the one way the cancel page spends
--     a link. It takes the link's history locks in the order every other path
--     takes them (billing_cancel_link_lock, 20261020160600: the outbox id,
--     then the hash), and then spends it in ONE statement, gated on
--     `used_at is null and expires_at > clock_timestamp()` -- read after any
--     wait for those locks or the row's. No row back is a refusal, with its
--     reason: `expired`, `used`, or `not_found`. The service role only;
--   * cancelFlow.ts spends the link BEFORE any Stripe call or the refund
--     request, and only a link this function answered `consumed` for goes on
--     to them. A Stripe failure after the spend leaves the link spent: the
--     buyer asks for a new one, or cancels from Billing while signed in
--     (decision 27). An expired or spent link hands nothing back to the
--     per-recipient count or the mail budget (decision 38);
--   * the token table's guard (billing_cancel_tokens_lifetime, as
--     20261020160400 defines it) also refuses ANY update that spends a link
--     whose expiry has passed on clock_timestamp(), whoever makes it -- the
--     service role's direct UPDATE included.
--
-- tests/sql/cancel_link_consume_db_clock.sql proves it, tests/billing/
-- cancelLinkStore.test.ts runs the store against it, and tests/billing/
-- cancelFlow.test.ts holds the flow's order.
--
-- Not changed (decision 39): a direct single-row DELETE takes the row before
-- its trigger takes the history locks, so it can deadlock with the tick, or
-- with a spend, which take the locks first. Postgres aborts one, nothing is
-- lost, and no application path deletes a token directly.
--
-- Safe to re-run: both functions are CREATE OR REPLACE (the trigger that
-- calls the guard is 20261020160300's, unchanged), and the grants and revokes
-- are idempotent.

-- ---------------------------------------------------------------------------
-- The token table's guard: no spending an expired link
-- ---------------------------------------------------------------------------
-- As 20261020160400 defines it, with one more refusal on UPDATE: setting
-- used_at on a link whose expiry is at or before clock_timestamp(). The
-- expiry checked is the row's new one, which can only be the same or sooner.
create or replace function public.billing_cancel_tokens_lifetime ()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_status text;
    v_kind text;
    v_expires timestamptz;
begin
    if tg_op = 'INSERT' then
        select o.status, o.kind, o.link_expires_at into v_status, v_kind, v_expires
        from public.billing_mail_outbox o
        where o.id = new.outbox_id;
        if new.outbox_id is null or v_kind is distinct from 'cancel_link' or v_status is distinct from 'pending'
           or v_expires <= clock_timestamp() then
            raise exception 'a cancel link is only saved for its own request, while it waits to send and before it expires'
                using errcode = '55000';
        end if;
        new.expires_at := v_expires;
        return new;
    end if;

    if tg_op = 'UPDATE' then
        if new.token_hash <> old.token_hash
           or new.user_id <> old.user_id
           or new.mode <> old.mode
           or new.outbox_id is distinct from old.outbox_id
           or new.expires_at > old.expires_at then
            raise exception 'a saved cancel link keeps its expiry and what it cancels'
                using errcode = '55000';
        end if;
        if old.used_at is not null and new.used_at is distinct from old.used_at then
            raise exception 'a spent cancel link stays spent'
                using errcode = '55000';
        end if;
        if old.used_at is null and new.used_at is not null
           and new.expires_at <= clock_timestamp() then
            raise exception 'an expired cancel link cannot be spent'
                using errcode = '55000';
        end if;
        return new;
    end if;

    -- DELETE
    if exists (select 1 from auth.users u where u.id = old.user_id)
       and (old.expires_at > now()
            or exists (select 1 from public.billing_mail_outbox o where o.id = old.outbox_id and o.status = 'pending')) then
        raise exception 'a cancel link is kept until it has expired and its request can no longer be retried'
            using errcode = '55000';
    end if;
    return old;
end;
$$;

revoke all on function public.billing_cancel_tokens_lifetime () from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- consume_cancel_link_token: spent once, and only while still good
-- ---------------------------------------------------------------------------
-- Answers {"answer": ...}:
--   consumed  -- this call spent the link, at used_at, on clock_timestamp();
--                also {"user_id", "mode", "used_at"}. Only now may the caller
--                touch Stripe or mail support;
--   expired   -- unused, but its expiry has passed on clock_timestamp();
--   used      -- already spent (by this button or another request);
--   not_found -- no such link (never saved, or deleted and tombstoned).
-- Nothing is written on a refusal. The outbox id is read first only to take
-- the locks in their one order; the guard forbids it ever changing, so the
-- read cannot go stale.
create or replace function public.consume_cancel_link_token (p_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_outbox uuid;
    v_user uuid;
    v_mode text;
    v_used timestamptz;
    v_text text;
begin
    select t.outbox_id into v_outbox
    from public.billing_cancel_tokens t
    where t.token_hash = p_hash;
    perform public.billing_cancel_link_lock (v_outbox, p_hash);

    begin
        update public.billing_cancel_tokens t
        set used_at = pg_catalog.clock_timestamp()
        where t.token_hash = p_hash
          and t.used_at is null
          and t.expires_at > pg_catalog.clock_timestamp()
        returning t.user_id, t.mode, t.used_at into v_user, v_mode, v_used;
    exception when sqlstate '55000' then
        -- The guard read the clock a moment after the WHERE did, and the
        -- expiry fell between the two: expired all the same.
        get stacked diagnostics v_text = message_text;
        if v_text <> 'an expired cancel link cannot be spent' then
            raise;
        end if;
        return jsonb_build_object('answer', 'expired');
    end;
    if v_user is not null then
        return jsonb_build_object('answer', 'consumed', 'user_id', v_user, 'mode', v_mode, 'used_at', v_used);
    end if;

    select t.used_at into v_used
    from public.billing_cancel_tokens t
    where t.token_hash = p_hash;
    if not found then
        return jsonb_build_object('answer', 'not_found');
    end if;
    return jsonb_build_object('answer', case when v_used is not null then 'used' else 'expired' end);
end;
$$;

revoke all on function public.consume_cancel_link_token (text) from public, anon, authenticated;
grant execute on function public.consume_cancel_link_token (text) to service_role;
