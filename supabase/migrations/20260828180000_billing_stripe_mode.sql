-- Split the billing tables by Stripe account.
--
-- cleffy.io and dev.cleffy.io are two Vercel deploys of one codebase over ONE
-- Supabase project, and at the live flip they stop sharing a Stripe account:
-- production transacts against "Cleffy" (live), dev against "Cleffy sandbox"
-- (test). Two things in here were single-account assumptions that break the
-- moment that is true.
--
-- 1. A Stripe customer id belongs to exactly one account. `billing_customers`
--    allowed one row per user, so a teacher who had ever opened checkout on dev
--    would carry a sandbox `cus_…` into production, and the live Checkout call
--    would fail with "No such customer". A user now gets one customer row per
--    mode.
--
-- 2. auth users are shared between the two deploys, so a subscription bought on
--    dev with a published test card would otherwise grant paid features on
--    production. Subscriptions are now tagged with the account that created
--    them, and only live ones entitle.
--
-- Every existing row predates the flip and is therefore sandbox, which is what
-- the 'test' default backfills.

alter table public.billing_customers
    add column mode text not null default 'test' check (mode in ('live', 'test'));

-- One customer per user PER ACCOUNT. stripe_customer_id keeps its own unique
-- constraint: customer ids are globally unique, so it stays a valid lookup key.
alter table public.billing_customers drop constraint billing_customers_pkey;
alter table public.billing_customers add constraint billing_customers_pkey primary key (user_id, mode);

alter table public.subscriptions
    add column mode text not null default 'test' check (mode in ('live', 'test'));

create index if not exists subscriptions_user_mode on public.subscriptions (user_id, mode);

-- Which Stripe account's subscriptions actually entitle.
--
-- 'live' only, because dev.cleffy.io is a public hostname over this same
-- database: without the filter, anyone could subscribe there with Stripe's
-- published test card and walk onto cleffy.io with a paid plan. Split dev onto
-- its own Supabase project and this can safely widen to
-- array['live', 'test'] — that is the single line to change.
create or replace function public.entitling_billing_modes () returns text[] language sql immutable
set search_path = public as $$
select array['live']::text[]
$$;

revoke all on function public.entitling_billing_modes () from public;
revoke all on function public.entitling_billing_modes () from anon;

-- Re-declared verbatim from 20260826193902_billing.sql except for the two
-- `s.mode = any (...)` predicates, so the diff against that definition is
-- exactly the mode filter and nothing else.
create or replace function public.get_entitlements (p_user uuid default null) returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_user uuid;
    v_tier text := 'free';
    v_status text;
    v_source text := 'none';
    v_period_end timestamptz;
    v_sub record;
begin
    if v_caller is null then
        if p_user is null then
            raise exception 'get_entitlements requires p_user when unauthenticated' using errcode = '22023';
        end if;
        v_user := p_user;
    else
        if p_user is not null and p_user <> v_caller then
            raise exception 'cannot read another user''s entitlements' using errcode = '42501';
        end if;
        v_user := v_caller;
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
            'limits', public.tier_limits ('student')
        );
    end if;

    -- Own subscription first. Highest tier wins if somehow more than one is live.
    select s.tier, s.status, s.current_period_end
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
        v_source := 'subscription';
    else
        -- Otherwise: a seat in an academy whose owner is paying.
        select s.status, s.current_period_end
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
            v_source := 'studio_member';
        end if;
    end if;

    return jsonb_build_object(
        'user_id', v_user,
        'tier', v_tier,
        'status', v_status,
        'source', v_source,
        'current_period_end', v_period_end,
        'limits', public.tier_limits (v_tier)
    );
end;
$$;
