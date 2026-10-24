-- Check the write lease in the same statement as the write (QA round 4 review of
-- #56, finding 3).
--
-- What 20261012120105 left open. The lease made the Stripe read and the row
-- write one step per subscription -- but only by convention: the webhook took
-- the lease, read Stripe, wrote the row through PostgREST, and gave the lease
-- back, and `release_subscription_write` was the ONLY statement that checked
-- whose lease it was. So the sequence that defeats it is:
--
--   A  claims the lease on sub_X, reads `past_due` from Stripe, and stalls
--      (Stripe slow, the SDK retrying -- the read is the long call here).
--   .. A's lease goes stale, because two minutes is shorter than the wall-clock
--      ceiling an invocation may reach.
--   B  takes the lease over, reads `active` from Stripe, writes it, releases.
--   A  wakes up and writes the `past_due` it read minutes ago. Nothing refuses
--      it: the upsert carried no lease, and `subscriptions_refuse_stale_event`
--      cannot order two events Stripe stamped in the same second (that is why
--      the lease exists).
--
-- The row then says a customer whose card failed is paid up -- or, with the
-- statuses the other way round, that a paying customer has lapsed and their
-- scores are archived -- until the next event about them, a month or a year
-- away. Exactly D3, through the lock instead of around it.
--
-- Lengthening the lease (checkoutFlow.ts and stripeEvents.ts both now ask for
-- five minutes) makes the race rarer and nothing more, because "rarer than the
-- ceiling" is a bet on a platform limit we do not set. What closes it is making
-- the WRITE conditional on still holding the lease, in one statement, so there
-- is no gap between the check and the write for a takeover to land in.
--
-- Hence this function rather than PostgREST's upsert: a cross-table condition is
-- not something PostgREST can express, and splitting it into a read and a write
-- would reintroduce the same race one level down.
--
-- `for update` on the lease row is the other half. It holds the row for the rest
-- of this transaction, so `claim_subscription_write` -- whose
-- `on conflict do update` needs the same row lock -- cannot take the lease over
-- WHILE this write is in flight. A takeover therefore happens strictly before
-- (and this function answers `lost_lock`) or strictly after (and the write has
-- already landed), never during.
--
-- The three answers the caller branches on, so none of them is an error string
-- it has to parse:
--
--   written       the row is this delivery's state
--   lost_lock     the lease is someone else's; nothing was written, and the
--                 delivery asks Stripe to redeliver (503)
--   duplicate     subscriptions_one_entitling_per_user_mode refused a SECOND
--                 entitling subscription for this user and account. Matched on
--                 `constraint_name` from the diagnostics rather than on the text
--                 of the message, which is what the Edge Function used to do.
--                 Any OTHER unique violation is re-raised: swallowing one would
--                 turn a bug into an acknowledged event.
--   missing_user  the FK to auth.users: the account was deleted while this
--                 subscription was live. There is no row to write, and
--                 stripe-webhook cancels whatever can still bill.
--
-- The `subscriptions_refuse_stale_event` trigger still sits on the update and
-- still wins where it can speak: it drops a write carrying an older event stamp,
-- which this function reports as `written` exactly as the PostgREST upsert
-- reported it as a success. The two guard different windows -- that trigger
-- orders events a second or more apart, this one orders what the clock cannot.

-- The grant service_role needs even though it bypasses RLS
-- (20260827140000_core_table_grants.sql). `subscriptions` predates that
-- migration and never got one; on hosted Supabase the platform's default ACL
-- hides it, and the function below is SECURITY INVOKER, so on a bare cluster it
-- would answer 42501 before it ever reached the lease check. (This is the
-- environment note at the end of tests/sql/README.md, fixed.)
grant all on table public.subscriptions to service_role;

create or replace function public.write_subscription_under_lock (
    p_holder uuid,
    p_subscription_id text,
    p_user uuid,
    p_mode text,
    p_tier text,
    p_status text,
    p_price_id text,
    p_current_period_end timestamptz,
    p_cancel_at_period_end boolean,
    p_last_event_created_at timestamptz
) returns text language plpgsql set search_path = public as $$
declare
    v_constraint text;
begin
    -- Ours, and held for the rest of the transaction. Outside the exception
    -- block below on purpose: a subtransaction rollback would give the row lock
    -- back, and the point of it is that it outlives the write.
    perform 1
    from public.subscription_writes
    where stripe_subscription_id = p_subscription_id and holder = p_holder
    for update;

    if not found then
        return 'lost_lock';
    end if;

    begin
        insert into public.subscriptions (
            stripe_subscription_id,
            user_id,
            mode,
            tier,
            status,
            price_id,
            current_period_end,
            cancel_at_period_end,
            last_event_created_at,
            updated_at
        ) values (
            p_subscription_id,
            p_user,
            p_mode,
            p_tier,
            p_status,
            p_price_id,
            p_current_period_end,
            p_cancel_at_period_end,
            p_last_event_created_at,
            now()
        )
        -- The primary key, as before: a redelivery updates the subscription's
        -- own row. The partial unique index is NOT a conflict target -- a second
        -- entitling subscription is not the same subscription, so there is no
        -- row for it to merge into.
        on conflict (stripe_subscription_id) do update
        set user_id = excluded.user_id,
            mode = excluded.mode,
            tier = excluded.tier,
            status = excluded.status,
            price_id = excluded.price_id,
            current_period_end = excluded.current_period_end,
            cancel_at_period_end = excluded.cancel_at_period_end,
            last_event_created_at = excluded.last_event_created_at,
            updated_at = now();
    exception
        when unique_violation then
            get stacked diagnostics v_constraint = constraint_name;
            if v_constraint = 'subscriptions_one_entitling_per_user_mode' then
                return 'duplicate';
            end if;
            raise;
        when foreign_key_violation then
            return 'missing_user';
    end;

    return 'written';
end;
$$;

revoke all on function public.write_subscription_under_lock (
    uuid, text, uuid, text, text, text, text, timestamptz, boolean, timestamptz
) from public, anon, authenticated;

grant execute on function public.write_subscription_under_lock (
    uuid, text, uuid, text, text, text, text, timestamptz, boolean, timestamptz
) to service_role;
