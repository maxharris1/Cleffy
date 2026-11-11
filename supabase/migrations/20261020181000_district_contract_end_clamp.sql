-- A contract end is never earlier than when Cleffy learned of it
-- (launch-compliance decision 22; Codex round-4 review of PR #61, new major 2).
--
-- The retention purge (PR #64) sends the owner an export notice 16 days after
-- district_billing.contract_ends_at and purges 30 days after it. Every path
-- that set the end wrote its source date as given: Stripe's ended_at or
-- current_period_end (district_billing_rederive) and an admin's date
-- (admin_set_district_contract_end). So a cancellation Stripe delivered late,
-- or recorded with an old period end, or an admin date already in the past,
-- started the retention clock in the past -- possibly already beyond its notice
-- and its window, so a district could be purged with no notice at all.
--
-- Now every end-setting path stores
--
--     contract_ends_at = greatest(the source's date, contract_end_learned_at)
--
-- where contract_end_learned_at is when Cleffy learned of that end: now() at the
-- write or at the event's processing. The source's own date is kept beside it
-- (contract_end_reported_at), and the lower bound is preserved: a retry, a
-- replayed or redelivered event, an hourly re-derivation -- anything that
-- reports the SAME date from the same source -- keeps the learned-at time it
-- has, so it can neither move the learned-at time later nor the end earlier. A
-- different date (Stripe's ended_at arriving after a webhook that only gave a
-- period end, an admin entering a new date) is a new end, learned now. A
-- missing date still leaves the stored value unchanged (20261020180500's
-- warning path), and an end that goes away (the district pays again, an admin
-- hands it back) clears both columns with it. The district always gets its
-- full 14-day notice and 30-day window, counted from no earlier than the day
-- Cleffy knew.
--
-- The columns are added here, outside the canonical district_billing block
-- that 20261020180500 shares byte for byte with #64's
-- 20261021120700_district_retention.sql, so that block is unchanged; #64 only
-- reads contract_ends_at, which is already clamped when it reads it.
--
-- Rerunnable: columns IF NOT EXISTS, functions CREATE OR REPLACE, and the
-- backfill touches only rows it has not touched before.

alter table public.district_billing add column if not exists contract_end_reported_at timestamptz;

alter table public.district_billing add column if not exists contract_end_learned_at timestamptz;

-- ---------------------------------------------------------------------------
-- Rows written before this migration
-- ---------------------------------------------------------------------------
-- Their source date is the stored end. When it was learned is not recorded;
-- the row's last write is the closest bound there is (never later than now),
-- and it errs the district's way: the clamp can only move the end later.
do $backfill$
begin
    perform set_config('cleffy.district_billing_actor', 'migration 20261020181000', true);
    perform set_config('cleffy.district_billing_reason', 'contract end clamped to when it was last written (decision 22)', true);

    update public.district_billing b
    set contract_end_reported_at = b.contract_ends_at,
        contract_end_learned_at = least(b.updated_at, now()),
        contract_ends_at = greatest(b.contract_ends_at, least(b.updated_at, now()))
    where b.contract_ends_at is not null
      and b.contract_end_learned_at is null;

    perform set_config('cleffy.district_billing_actor', '', true);
    perform set_config('cleffy.district_billing_reason', '', true);
end;
$backfill$;

-- ---------------------------------------------------------------------------
-- Deriving the end from Stripe
-- ---------------------------------------------------------------------------
-- Redefined from 20261020180500. Which date, and whether the district pays, are
-- decided exactly as before; what is stored is clamped to when it was learned.
create or replace function public.district_billing_rederive (p_studio uuid) returns void
language plpgsql security definer
set search_path = public as $$
declare
    v_row public.district_billing;
    v_owner uuid;
    v_linked public.subscriptions;
    v_end timestamptz;
    v_learned timestamptz;
    v_stored timestamptz;
    v_paying boolean;
    v_reason text := nullif(current_setting('cleffy.district_billing_reason', true), '');
begin
    select * into v_row from public.district_billing b where b.studio_id = p_studio for update;
    if not found then
        return;
    end if;

    select st.owner_id into v_owner from public.studios st where st.id = p_studio;

    -- Any paying Academy subscription of the owner, card-paid or Stripe
    -- Invoicing (subscription_is_live: decisions 21 and 25), is a district
    -- that pays: #64 never purges it. Its seats past the cap of 5 are still
    -- read-only (decisions item 2); that is the seat limit's business.
    v_paying := exists (
        select 1 from public.subscriptions s
        where s.user_id = v_owner
          and s.tier = 'academy'
          and public.subscription_is_live (s)
    );

    if v_row.contract_ends_source = 'admin' then
        -- An admin's pin is the contract's own date and is left alone -- unless
        -- it has already passed while the owner pays (decision 8): cleared and
        -- logged, it hands the record back to Stripe, which, the owner paying,
        -- says no end. A pin still in the future, and a pinned "never" (null),
        -- stay.
        if v_paying and v_row.contract_ends_at is not null and v_row.contract_ends_at <= now() then
            perform set_config('cleffy.district_billing_reason',
                'admin pin ' || v_row.contract_ends_at::text || ' had passed while the owner pays on a live subscription: cleared',
                true);
            update public.district_billing b
            set contract_ends_at = null,
                contract_ends_source = null,
                contract_end_reported_at = null,
                contract_end_learned_at = null,
                updated_by = coalesce(nullif(current_setting('cleffy.district_billing_actor', true), ''), 'system'),
                updated_at = now()
            where b.studio_id = p_studio;
            perform set_config('cleffy.district_billing_reason', coalesce(v_reason, ''), true);
        end if;
        return;
    end if;

    if not v_paying then
        select * into v_linked from public.subscriptions s where s.stripe_subscription_id = v_row.stripe_subscription_id;
        if found and v_linked.status in ('canceled', 'incomplete_expired') then
            -- Stripe's own dates only (Codex round-3 review of #61): ended_at,
            -- else the subscription's current_period_end. Never the event's
            -- time or now() as the date itself: with neither, the record keeps
            -- what it has and says so.
            v_end := coalesce(v_linked.ended_at, v_linked.current_period_end);
            if v_end is null then
                raise warning 'district_billing: studio % subscription % ended with no Stripe end date; contract_ends_at left at %',
                    p_studio, v_linked.stripe_subscription_id, coalesce(v_row.contract_ends_at::text, 'null');
                return;
            end if;
        end if;
    end if;

    -- Decision 22: never earlier than when Cleffy learned of it. The same
    -- Stripe date as stored (a redelivery, a replay, the hourly sweep) keeps
    -- the learned-at time it has; a new date is learned now.
    if v_end is not null then
        if v_row.contract_ends_source = 'stripe'
            and v_row.contract_end_reported_at is not distinct from v_end
            and v_row.contract_end_learned_at is not null then
            v_learned := v_row.contract_end_learned_at;
        else
            v_learned := now();
        end if;
        v_stored := greatest(v_end, v_learned);
    end if;

    if v_stored is distinct from v_end and v_reason is null then
        perform set_config('cleffy.district_billing_reason',
            'stripe end ' || v_end::text || ' predates when Cleffy learned of it (' || v_learned::text || '): clamped',
            true);
    end if;

    update public.district_billing b
    set contract_ends_at = v_stored,
        contract_ends_source = case when v_end is null then null else 'stripe' end,
        contract_end_reported_at = v_end,
        contract_end_learned_at = v_learned,
        updated_by = coalesce(nullif(current_setting('cleffy.district_billing_actor', true), ''), 'stripe'),
        updated_at = now()
    where b.studio_id = p_studio
      and (b.contract_ends_at is distinct from v_stored
           or b.contract_ends_source is distinct from case when v_end is null then null else 'stripe' end
           or b.contract_end_reported_at is distinct from v_end
           or b.contract_end_learned_at is distinct from v_learned);

    perform set_config('cleffy.district_billing_reason', coalesce(v_reason, ''), true);
end;
$$;

revoke all on function public.district_billing_rederive (uuid) from public;
revoke all on function public.district_billing_rederive (uuid) from anon;
revoke all on function public.district_billing_rederive (uuid) from authenticated;

-- ---------------------------------------------------------------------------
-- An admin's date
-- ---------------------------------------------------------------------------
-- Redefined from 20261020180500. The admin's date is stored clamped to when it
-- was entered; entering the same date again (a retry) keeps the first time.
-- A pinned "never" (null) and handing the date back to Stripe (p_automatic)
-- are unchanged.
create or replace function public.admin_set_district_contract_end (
    p_studio uuid,
    p_contract_ends_at timestamptz,
    p_actor text,
    p_reason text default null,
    p_automatic boolean default false
) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_row public.district_billing;
    v_learned timestamptz;
begin
    if auth.uid() is not null then
        raise exception 'district billing is admin-only' using errcode = '42501';
    end if;
    if nullif(trim(coalesce(p_actor, '')), '') is null then
        raise exception 'say who is making this change (p_actor)' using errcode = '22023';
    end if;
    if p_automatic and p_contract_ends_at is not null then
        raise exception 'p_automatic follows Stripe; pass p_contract_ends_at => null with it' using errcode = '22023';
    end if;

    v_row := public.district_billing_row (p_studio);

    perform set_config('cleffy.district_billing_actor', trim(p_actor), true);
    perform set_config('cleffy.district_billing_reason', coalesce(p_reason, ''), true);

    if p_automatic then
        update public.district_billing b
        set contract_ends_at = null, contract_ends_source = null,
            contract_end_reported_at = null, contract_end_learned_at = null,
            updated_by = trim(p_actor), updated_at = now()
        where b.studio_id = p_studio;

        -- Re-derive from the subscriptions as they stand, the way their
        -- webhook writes do.
        perform public.district_billing_rederive (p_studio);
    else
        if p_contract_ends_at is not null then
            if v_row.contract_ends_source = 'admin'
                and v_row.contract_end_reported_at is not distinct from p_contract_ends_at
                and v_row.contract_end_learned_at is not null then
                v_learned := v_row.contract_end_learned_at;
            else
                v_learned := now();
            end if;
        end if;

        update public.district_billing b
        set contract_ends_at = greatest(p_contract_ends_at, v_learned),
            contract_ends_source = 'admin',
            contract_end_reported_at = p_contract_ends_at,
            contract_end_learned_at = v_learned,
            updated_by = trim(p_actor),
            updated_at = now()
        where b.studio_id = p_studio;

        -- A pin already past while the owner pays is cleared (and logged) at
        -- once, as on any later event; the answer below says so.
        perform public.district_billing_rederive (p_studio);
    end if;

    perform set_config('cleffy.district_billing_actor', '', true);
    perform set_config('cleffy.district_billing_reason', '', true);

    select * into v_row from public.district_billing b where b.studio_id = p_studio;
    return jsonb_build_object(
        'studio_id', p_studio,
        'stripe_subscription_id', v_row.stripe_subscription_id,
        'contract_ends_at', v_row.contract_ends_at,
        'contract_ends_source', v_row.contract_ends_source,
        'contract_end_reported_at', v_row.contract_end_reported_at,
        'contract_end_learned_at', v_row.contract_end_learned_at
    );
end;
$$;

revoke all on function public.admin_set_district_contract_end (uuid, timestamptz, text, text, boolean) from public;
revoke all on function public.admin_set_district_contract_end (uuid, timestamptz, text, text, boolean) from anon;
revoke all on function public.admin_set_district_contract_end (uuid, timestamptz, text, text, boolean) from authenticated;
grant execute on function public.admin_set_district_contract_end (uuid, timestamptz, text, text, boolean) to service_role;
