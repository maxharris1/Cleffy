-- Handing the contract end back to Stripe twice does not restart retention
-- (launch-compliance decision 22; Codex round-5 review of PR #61, new minor 1).
--
-- 20261020181000's admin_set_district_contract_end (p_automatic => true)
-- cleared contract_end_learned_at on every call and re-derived, so the
-- re-derivation found no learned-at time to keep and assigned now(). Repeating
-- the hand-back after the district already followed Stripe -- a retry, a
-- runbook step run twice -- moved the clamped contract_ends_at, and with it
-- #64's notice and purge, later each time, though Stripe's data had not
-- changed. Decision 22's learned-at time is persisted once.
--
-- Now:
--
--   * Already following Stripe (contract_ends_source 'stripe', or null with no
--     end): nothing is cleared. The request only runs the re-derivation every
--     webhook write already runs, which writes nothing while Stripe's data is
--     unchanged and keeps the learned-at time of the same Stripe date
--     (20261020181000). The end, its learned-at time and Stripe's date stay.
--   * A real hand-back (contract_ends_source 'admin'): the pin goes and the end
--     is derived from Stripe again. The pin's date and learned-at time are kept
--     on the row as it is handed over, so a Stripe end on that same date keeps
--     the earlier learned-at time (never a later one); a different date is a
--     new end, learned now; no end clears both. An end Stripe gives no date
--     for is not inherited from the pin: it is null, as it was before.
--
-- Pinning a date (p_automatic false) is unchanged from 20261020181000.
--
-- Rerunnable: the function is CREATE OR REPLACE, nothing else is created or
-- altered, and the privileges are reset to the same end state every time.

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
        if v_row.contract_ends_source is not distinct from 'admin' then
            -- A real hand-back. The row follows Stripe from here, carrying the
            -- pin's date and learned-at time (a pinned "never" carries none), so
            -- that the re-derivation below keeps that learned-at time if Stripe
            -- reports the same date and learns any other date now.
            update public.district_billing b
            set contract_ends_source = case when b.contract_ends_at is null then null else 'stripe' end,
                contract_end_reported_at = case when b.contract_ends_at is null then null else b.contract_end_reported_at end,
                contract_end_learned_at = case when b.contract_ends_at is null then null else b.contract_end_learned_at end,
                updated_by = trim(p_actor), updated_at = now()
            where b.studio_id = p_studio;
        end if;

        -- Re-derive from the subscriptions as they stand, the way their
        -- webhook writes do. Already following Stripe, with Stripe's data
        -- unchanged, this writes nothing.
        perform public.district_billing_rederive (p_studio);

        if v_row.contract_ends_source is not distinct from 'admin' then
            -- Stripe ended the subscription without a date (the re-derivation
            -- warns and keeps what the row has): the pin's date is not
            -- Stripe's, so it is not kept as Stripe's end.
            update public.district_billing b
            set contract_ends_at = null, contract_ends_source = null,
                contract_end_reported_at = null, contract_end_learned_at = null,
                updated_by = trim(p_actor), updated_at = now()
            where b.studio_id = p_studio
              and b.contract_ends_source = 'stripe'
              and not exists (
                  select 1 from public.subscriptions s
                  where s.stripe_subscription_id = b.stripe_subscription_id
                    and s.status in ('canceled', 'incomplete_expired')
                    and coalesce(s.ended_at, s.current_period_end) is not distinct from b.contract_end_reported_at
              );
        end if;
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
