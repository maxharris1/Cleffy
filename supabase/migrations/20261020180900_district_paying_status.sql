-- Who is paying: one status set for card and Stripe Invoicing Academy billing
-- (launch-compliance decisions 21 and 25; Codex round-4 review of PR #61, new
-- major 1 and the Decision 21 partial).
--
-- 20261020180500 counted a subscription as live when it was active or
-- trialing inside its period, or -- for send_invoice only -- past_due OR unpaid
-- inside its 30-day grace. Two things were wrong with that:
--
--  * `unpaid` counted. Stripe moves a subscription to unpaid once it has given
--    up collecting; that is not a district that pays (decision 25).
--  * A card-paid Academy past due got no grace at all, and the webhook
--    (stripeEvents.ts) recorded it as tier free. A district that moved to
--    ordinary card Academy and whose card then failed stopped counting as
--    paying the moment Stripe first retried: an old linked cancellation came
--    back as its contract end (purgeable), and a past admin pin was no longer
--    cleared (decision 8).
--
-- Now, for card and Stripe Invoicing alike (decisions 21 and 25), a subscription
-- is paying when it is
--
--     active or trialing (inside its period, as before), or
--     past_due, inside 30 days of when past_due was first recorded
--     (subscriptions.past_due_since), or until an admin's later per-district
--     extension (district_billing.grace_extended_until).
--
-- unpaid, canceled, incomplete and incomplete_expired are not. The past-due
-- grace is for Academy (any collection method) and, as before, for any Stripe
-- Invoicing subscription; a card Personal or Teacher plan past due is still
-- free limits at once (the webhook records it as tier free, and it is not live
-- here either, so it cannot mask a seat).
--
-- After the grace period the ordinary lapse rules apply, from the clock alone:
-- resolve_entitlements() reads this on every call, so the seats past 5 are
-- read-only the moment grace ends (nothing is deleted), and the hourly sweep
-- now re-derives every district's contract end, so a district that stopped
-- paying only by the clock gets its Stripe end back without waiting for an
-- event.
--
-- Rerunnable: every function is CREATE OR REPLACE; nothing else is created.

-- ---------------------------------------------------------------------------
-- The grace deadline
-- ---------------------------------------------------------------------------
-- Redefined from 20261020180500: an admin's extension is per district, so it
-- now reaches the owner's card-paid Academy too, not only the Stripe Invoicing
-- subscription the billing record links to.
create or replace function public.district_grace_ends_at (p_subscription_id text, p_past_due_since timestamptz)
returns timestamptz language sql stable
set search_path = public as $$
    -- greatest() skips nulls: no extension is just the 30 days.
    select greatest(
        p_past_due_since + interval '30 days',
        (
            select max(b.grace_extended_until)
            from public.district_billing b
            where b.stripe_subscription_id = p_subscription_id
               or b.studio_id in (
                   select st.id
                   from public.subscriptions s
                   join public.studios st on st.owner_id = s.user_id
                   where s.stripe_subscription_id = p_subscription_id
                     and s.tier = 'academy'
               )
        )
    );
$$;

revoke all on function public.district_grace_ends_at (text, timestamptz) from public;
revoke all on function public.district_grace_ends_at (text, timestamptz) from anon;
revoke all on function public.district_grace_ends_at (text, timestamptz) from authenticated;
grant execute on function public.district_grace_ends_at (text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- The paying status set
-- ---------------------------------------------------------------------------
-- Redefined from 20261020180500. The one predicate every entitlement read, the
-- seat limit, the paying check behind the contract end (district_billing_rederive)
-- and the billing record's link already share, so changing it here changes all
-- of them together.
create or replace function public.subscription_is_live (s public.subscriptions) returns boolean language sql stable
set search_path = public as $$
    select s.mode = any (public.entitling_billing_modes ())
        and (
            (s.status in ('active', 'trialing') and (s.current_period_end is null or s.current_period_end > now()))
            or (
                s.status = 'past_due'
                and (s.tier = 'academy' or s.collection_method = 'send_invoice')
                and coalesce(now() < public.district_grace_ends_at (s.stripe_subscription_id, s.past_due_since), false)
            )
        );
$$;

revoke all on function public.subscription_is_live (public.subscriptions) from public;
revoke all on function public.subscription_is_live (public.subscriptions) from anon;
revoke all on function public.subscription_is_live (public.subscriptions) from authenticated;
grant execute on function public.subscription_is_live (public.subscriptions) to service_role;

-- ---------------------------------------------------------------------------
-- The hourly sweep
-- ---------------------------------------------------------------------------
-- Redefined from 20261020180500: the same seat walk, then EVERY district's
-- contract end derived again rather than only the admin pins already past. A
-- grace period that runs out is only the clock: no webhook marks it, so this is
-- where a district that has stopped paying gets its Stripe end back (and where
-- a pin the clock carried into the past is cleared while it pays, as before).
-- district_billing_rederive writes only when the answer changes.
create or replace function public.reconcile_district_seats () returns int language plpgsql security definer
set search_path = public as $$
declare
    v_studio uuid;
    v_moved int := 0;
begin
    for v_studio in
        select sm.studio_id
        from public.studio_members sm
        group by sm.studio_id
        having count(*) > 4
        order by sm.studio_id
    loop
        v_moved := v_moved + public.reconcile_studio_seats (v_studio);
    end loop;

    for v_studio in
        select b.studio_id from public.district_billing b order by b.studio_id
    loop
        perform public.district_billing_rederive (v_studio);
    end loop;
    return v_moved;
end;
$$;

revoke all on function public.reconcile_district_seats () from public;
revoke all on function public.reconcile_district_seats () from anon;
revoke all on function public.reconcile_district_seats () from authenticated;
grant execute on function public.reconcile_district_seats () to service_role;

-- ---------------------------------------------------------------------------
-- Admin grace extension
-- ---------------------------------------------------------------------------
-- Redefined from 20261020180500: a district paying by card can be given more
-- time too (the extension is per district). Refused only when the owner has no
-- Academy subscription of any kind and the record links none. The answer's
-- grace_ends_at is for the linked subscription, or else the owner's past-due
-- Academy, whichever ends latest.
create or replace function public.admin_extend_district_grace (
    p_studio uuid,
    p_grace_until timestamptz,
    p_actor text,
    p_reason text default null
) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_row public.district_billing;
    v_owner uuid;
    v_ends timestamptz;
begin
    if auth.uid() is not null then
        raise exception 'district billing is admin-only' using errcode = '42501';
    end if;
    if nullif(trim(coalesce(p_actor, '')), '') is null then
        raise exception 'say who is making this change (p_actor)' using errcode = '22023';
    end if;

    v_row := public.district_billing_row (p_studio);
    select st.owner_id into v_owner from public.studios st where st.id = p_studio;

    if v_row.stripe_subscription_id is null
        and not exists (select 1 from public.subscriptions s where s.user_id = v_owner and s.tier = 'academy') then
        raise exception 'studio % has no Academy subscription recorded to extend', p_studio
            using errcode = 'P0002';
    end if;

    perform set_config('cleffy.district_billing_actor', trim(p_actor), true);
    perform set_config('cleffy.district_billing_reason', coalesce(p_reason, ''), true);

    update public.district_billing b
    set grace_extended_until = p_grace_until, updated_by = trim(p_actor), updated_at = now()
    where b.studio_id = p_studio;

    perform set_config('cleffy.district_billing_reason', '', true);

    perform public.reconcile_studio_seats (p_studio);
    -- Paying again (or no longer) moves the contract end too, by this actor.
    perform public.district_billing_rederive (p_studio);

    perform set_config('cleffy.district_billing_actor', '', true);

    select max(public.district_grace_ends_at (s.stripe_subscription_id, s.past_due_since)) into v_ends
    from public.subscriptions s
    where s.stripe_subscription_id = v_row.stripe_subscription_id
       or (s.user_id = v_owner and s.tier = 'academy' and s.status = 'past_due');

    return jsonb_build_object(
        'studio_id', p_studio,
        'stripe_subscription_id', v_row.stripe_subscription_id,
        'grace_extended_until', p_grace_until,
        'grace_ends_at', v_ends
    );
end;
$$;

revoke all on function public.admin_extend_district_grace (uuid, timestamptz, text, text) from public;
revoke all on function public.admin_extend_district_grace (uuid, timestamptz, text, text) from anon;
revoke all on function public.admin_extend_district_grace (uuid, timestamptz, text, text) from authenticated;
grant execute on function public.admin_extend_district_grace (uuid, timestamptz, text, text) to service_role;
