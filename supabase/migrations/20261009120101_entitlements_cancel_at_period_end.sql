-- Entitlements say when a plan is ending, not only when its period ends.
--
-- The webhook has always stored Stripe's cancel_at_period_end on the
-- subscription row (stripeEvents.subscriptionRowFrom), but get_entitlements()
-- never passed it on, so the Account page could only print current_period_end
-- as "Renews <date>" -- including for a teacher who had cancelled and whose plan
-- will simply stop on that date. Telling someone who cancelled that they will be
-- charged again is the wrong way round for a paid product.
--
-- resolve_entitlements() is the 20261007120300 definition with one more key,
-- read from the same row that already supplies tier, status and period end:
--  * own subscription: the subscriber's own flag -- they can resume it from the
--    billing portal;
--  * Academy seat: the paying owner's flag. A seated teacher could already see
--    the period end through this RPC; whether that date is a renewal or the
--    last day of their access is the same fact about their own plan, and RLS
--    still keeps the owner's subscription row itself out of reach.
--  * free and student: false -- there is no period to end.
-- get_entitlements() and library_bootstrap() return this object as-is, so both
-- carry the key with no change of their own.

create or replace function public.resolve_entitlements (p_user uuid) returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare
    v_user uuid := p_user;
    v_tier text := 'free';
    v_status text;
    v_source text := 'none';
    v_period_end timestamptz;
    v_cancelling boolean := false;
    v_sub record;
begin
    if v_user is null then
        raise exception 'resolve_entitlements requires p_user' using errcode = '22023';
    end if;

    -- A provisioned student short-circuits everything below. The flag is set by
    -- the provisioning function through the admin API, so it is not something the
    -- account itself can write, and a student has no subscription, no seat and no
    -- upgrade path to resolve.
    perform 1
    from auth.users u
    where u.id = v_user
      and u.raw_app_meta_data ->> 'user_type' = 'student';

    if found then
        return jsonb_build_object(
            'user_id', v_user,
            'tier', 'student',
            'status', null::text,
            'source', 'managed',
            'current_period_end', null::timestamptz,
            'cancel_at_period_end', false,
            'limits', public.tier_limits ('student')
        );
    end if;

    -- Own subscription first. Highest tier wins if somehow more than one is live.
    select s.tier, s.status, s.current_period_end, s.cancel_at_period_end
    into v_sub
    from public.subscriptions s
    where s.user_id = v_user
      and s.mode = any (public.entitling_billing_modes ())
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
    order by case s.tier when 'academy' then 3 when 'teacher' then 2 when 'personal' then 1 else 0 end desc,
             s.current_period_end desc nulls last
    limit 1;

    if found then
        v_tier := v_sub.tier;
        v_status := v_sub.status;
        v_period_end := v_sub.current_period_end;
        v_cancelling := v_sub.cancel_at_period_end;
        v_source := 'subscription';
    else
        -- Otherwise: a seat in an academy whose owner is paying.
        select s.status, s.current_period_end, s.cancel_at_period_end
        into v_sub
        from public.studio_members sm
        join public.studios st on st.id = sm.studio_id
        join public.subscriptions s on s.user_id = st.owner_id
        where sm.user_id = v_user
          and s.tier = 'academy'
          and s.mode = any (public.entitling_billing_modes ())
          and s.status in ('active', 'trialing')
          and (s.current_period_end is null or s.current_period_end > now())
        order by s.current_period_end desc nulls last
        limit 1;

        if found then
            v_tier := 'academy';
            v_status := v_sub.status;
            v_period_end := v_sub.current_period_end;
            v_cancelling := v_sub.cancel_at_period_end;
            v_source := 'studio_member';
        end if;
    end if;

    return jsonb_build_object(
        'user_id', v_user,
        'tier', v_tier,
        'status', v_status,
        'source', v_source,
        'current_period_end', v_period_end,
        'cancel_at_period_end', coalesce(v_cancelling, false),
        'limits', public.tier_limits (v_tier)
    );
end;
$$;

-- Unchanged: service-only. get_entitlements() is the caller check in front.
revoke all on function public.resolve_entitlements (uuid) from public;
revoke all on function public.resolve_entitlements (uuid) from anon;
revoke all on function public.resolve_entitlements (uuid) from authenticated;
grant execute on function public.resolve_entitlements (uuid) to service_role;
