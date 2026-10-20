-- District seats: an admin-set teacher-seat count above the Academy cap of 5,
-- tied to the district's Stripe Invoicing subscription.
--
-- A district buys on a custom quote. Max creates the subscription in Stripe with
-- collection_method = send_invoice (the district is invoiced and pays by bank
-- transfer or card on its own terms), the webhook records it like any other
-- subscription, and the seat count from the contract is set here by hand. Five
-- things make that safe:
--
--  * The override lives in its OWN table, keyed by studio, that nothing in the
--    webhook writes. A renewal, a period move, a past_due blip, a cancellation:
--    every one of them rewrites the subscriptions row and none of them can reset
--    the seat count, because the seat count is not on that row. studios.seat_limit
--    stays 5 and stays out of every client grant (20260826193902_billing.sql).
--
--  * The override only counts while the subscription it names is live: the
--    studio owner's own, recorded with collection_method = send_invoice, tier
--    academy, in an entitling Stripe account and status, inside its period. A
--    contract that ends (cancelled, unpaid, past due) puts the studio back on 5
--    without anyone remembering to clear anything, and a renewal brings it back
--    without anyone re-setting it. The foreign key to subscriptions is what
--    makes a typo in the subscription id an error rather than a silent no-op.
--
--  * collection_method is new on subscriptions, written by the webhook from the
--    Stripe object. Checkout only ever creates charge_automatically
--    subscriptions, so "send_invoice" is a fact only an admin with the Stripe
--    secret key can create. Rows that predate this column read null, which is
--    never send_invoice, so no existing subscription gains an override.
--
--  * Every write is logged by a trigger into studio_seat_override_log, whoever
--    makes it -- the admin functions below, or a hand-run statement in the SQL
--    editor -- with the actor and reason the admin functions pass through.
--
--  * Admin-only: there is no admin role in the app, so "admin" is the service
--    role (and postgres, in the dashboard's SQL editor). Neither table and none
--    of the admin functions is reachable from a user JWT, and the functions
--    refuse one even if a grant ever slips.
--
-- studios_enforce_seat_limit now reads the effective limit, and takes a
-- per-studio advisory lock before counting, so two invites in flight together
-- cannot both take the last seat -- which mattered little at 5 and matters more
-- at 200.

-- ---------------------------------------------------------------------------
-- subscriptions.collection_method
-- ---------------------------------------------------------------------------
alter table public.subscriptions
    add column collection_method text check (collection_method in ('charge_automatically', 'send_invoice'));

-- Re-declared from 20261013120101_subscription_write_under_lock.sql with one more
-- parameter. Dropped first because adding a parameter makes a NEW overload, and
-- the old ten-argument one would then be ambiguous for a call naming ten. The
-- default keeps a webhook deployed before this migration working against it, and
-- the coalesce in the update keeps such a write from nulling a method a newer
-- delivery already recorded.
--
-- The grant service_role needs even though it bypasses RLS: the function is
-- SECURITY INVOKER (see 20261013120101 for why).
grant all on table public.subscriptions to service_role;

drop function if exists public.write_subscription_under_lock (
    uuid, text, uuid, text, text, text, text, timestamptz, boolean, timestamptz
);

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
    p_last_event_created_at timestamptz,
    p_collection_method text default null
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
            collection_method,
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
            p_collection_method,
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
            collection_method = coalesce(excluded.collection_method, subscriptions.collection_method),
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
    uuid, text, uuid, text, text, text, text, timestamptz, boolean, timestamptz, text
) from public, anon, authenticated;

grant execute on function public.write_subscription_under_lock (
    uuid, text, uuid, text, text, text, text, timestamptz, boolean, timestamptz, text
) to service_role;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
-- One override per studio. The ceiling is a sanity bound on a hand-typed number,
-- not a product limit: a district bigger than this is a conversation first.
create table public.studio_seat_overrides (
    studio_id uuid primary key references public.studios (id) on delete cascade,
    seat_limit int not null check (seat_limit > 5 and seat_limit <= 10000),
    stripe_subscription_id text not null references public.subscriptions (stripe_subscription_id) on delete cascade,
    reason text,
    updated_by text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index studio_seat_overrides_subscription on public.studio_seat_overrides (stripe_subscription_id);

-- Append-only. By-default identity rather than always: nothing writes an id by
-- hand, and tests/migrationRecoverability.test.ts pins omr_jobs as the one
-- always-generated id a logical restore has to work around.
--
-- No foreign key on purpose: the history of a contract is worth
-- keeping after the studio it described is gone, and it names no person -- only
-- the admin who made the change.
create table public.studio_seat_override_log (
    id bigint generated by default as identity primary key,
    studio_id uuid not null,
    action text not null check (action in ('set', 'changed', 'cleared')),
    old_seat_limit int,
    new_seat_limit int,
    old_stripe_subscription_id text,
    new_stripe_subscription_id text,
    reason text,
    actor text not null,
    changed_at timestamptz not null default now()
);

create index studio_seat_override_log_studio on public.studio_seat_override_log (studio_id, changed_at desc);

-- ---------------------------------------------------------------------------
-- Change log, written by trigger so no write path can skip it
-- ---------------------------------------------------------------------------
-- The admin functions pass actor and reason through transaction-local settings;
-- a hand-run statement falls back to the row's own updated_by/reason, and a
-- cascade (the studio or its owner deleted) to the database role that ran it.
create or replace function public.studio_seat_overrides_log_change () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_actor text := nullif(current_setting('cleffy.seat_override_actor', true), '');
    v_reason text := nullif(current_setting('cleffy.seat_override_reason', true), '');
begin
    if tg_op = 'INSERT' then
        insert into public.studio_seat_override_log (
            studio_id, action, new_seat_limit, new_stripe_subscription_id, reason, actor
        ) values (
            new.studio_id, 'set', new.seat_limit, new.stripe_subscription_id,
            coalesce(v_reason, new.reason), coalesce(v_actor, new.updated_by)
        );
        return new;
    end if;

    if tg_op = 'UPDATE' then
        if new.seat_limit is not distinct from old.seat_limit
            and new.stripe_subscription_id is not distinct from old.stripe_subscription_id
            and new.reason is not distinct from old.reason then
            return new;
        end if;
        insert into public.studio_seat_override_log (
            studio_id, action, old_seat_limit, new_seat_limit,
            old_stripe_subscription_id, new_stripe_subscription_id, reason, actor
        ) values (
            new.studio_id, 'changed', old.seat_limit, new.seat_limit,
            old.stripe_subscription_id, new.stripe_subscription_id,
            coalesce(v_reason, new.reason), coalesce(v_actor, new.updated_by)
        );
        return new;
    end if;

    insert into public.studio_seat_override_log (
        studio_id, action, old_seat_limit, old_stripe_subscription_id, reason, actor
    ) values (
        old.studio_id, 'cleared', old.seat_limit, old.stripe_subscription_id,
        v_reason, coalesce(v_actor, session_user::text)
    );
    return old;
end;
$$;

create trigger studio_seat_overrides_log after insert or update or delete on public.studio_seat_overrides
for each row execute function public.studio_seat_overrides_log_change ();

-- ---------------------------------------------------------------------------
-- The effective seat limit
-- ---------------------------------------------------------------------------
-- The studio's own limit (5), raised by an override only while the subscription
-- it is tied to is the owner's live district subscription. The subscription
-- predicates are resolve_entitlements()'s own, so a district whose owner has
-- lapsed to free cannot hold more seats than it is paying for.
create or replace function public.studio_effective_seat_limit (p_studio uuid) returns int language sql stable security definer
set search_path = public as $$
    select greatest(
        st.seat_limit,
        coalesce((
            select o.seat_limit
            from public.studio_seat_overrides o
            join public.subscriptions s on s.stripe_subscription_id = o.stripe_subscription_id
            where o.studio_id = st.id
              and s.user_id = st.owner_id
              and s.collection_method = 'send_invoice'
              and s.tier = 'academy'
              and s.mode = any (public.entitling_billing_modes ())
              and s.status in ('active', 'trialing')
              and (s.current_period_end is null or s.current_period_end > now())
        ), 0)
    )
    from public.studios st
    where st.id = p_studio;
$$;

-- Redefined from 20260826193902_billing.sql: the effective limit instead of the
-- column, and the per-studio lock before the count.
create or replace function public.studios_enforce_seat_limit () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_limit int;
    v_used int;
begin
    v_limit := public.studio_effective_seat_limit (new.studio_id);
    if v_limit is null then
        raise exception 'studio not found' using errcode = 'P0002';
    end if;

    -- Two invites in flight at once would otherwise both count the same members
    -- and both take the last seat. The second blocks here until the first
    -- commits, then counts again with a fresh snapshot (read committed takes one
    -- per statement) that includes the first one's row. Released at commit.
    perform pg_advisory_xact_lock (hashtext('cleffy.studio_seats'), hashtext(new.studio_id::text));

    -- The owner occupies a seat, so members may fill at most seat_limit - 1.
    select count(*)::int into v_used
    from public.studio_members sm
    where sm.studio_id = new.studio_id and sm.user_id <> new.user_id;

    if v_used + 1 > v_limit - 1 then
        raise exception 'seat_limit_reached'
            using errcode = 'P0001',
                  detail = json_build_object('code', 'seat_limit_reached', 'limit', v_limit)::text;
    end if;

    return new;
end;
$$;

-- What the Academy seats screen shows as "n of N seats". The owner and the
-- studio's members may ask; nobody else learns a district's size.
create or replace function public.studio_seat_limit (p_studio uuid) returns int language plpgsql stable security definer
set search_path = public as $$
begin
    if auth.uid() is null or public.studio_role (p_studio) is null then
        raise exception 'only the studio owner or its members can read its seat limit' using errcode = '42501';
    end if;
    return public.studio_effective_seat_limit (p_studio);
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin functions (service role / SQL editor only)
-- ---------------------------------------------------------------------------
-- Sets or changes a studio's override. Everything that would make the override
-- silently do nothing is refused here instead, with a message that says which:
-- the subscription must already be recorded (the webhook has seen it), belong to
-- the studio's owner, be a send_invoice subscription, and resolve to Academy.
create or replace function public.admin_set_studio_seat_override (
    p_studio uuid,
    p_seat_limit int,
    p_stripe_subscription_id text,
    p_actor text,
    p_reason text default null
) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_owner uuid;
    v_sub record;
begin
    -- Belt and braces behind the grants: no signed-in user is an admin.
    if auth.uid() is not null then
        raise exception 'seat overrides are admin-only' using errcode = '42501';
    end if;
    if nullif(trim(coalesce(p_actor, '')), '') is null then
        raise exception 'say who is making this change (p_actor)' using errcode = '22023';
    end if;
    if p_seat_limit is null or p_seat_limit <= 5 or p_seat_limit > 10000 then
        raise exception 'a seat override must be above the Academy cap of 5 (and at most 10000); got %', p_seat_limit
            using errcode = '22023';
    end if;

    select st.owner_id into v_owner from public.studios st where st.id = p_studio;
    if v_owner is null then
        raise exception 'no studio %', p_studio using errcode = 'P0002';
    end if;

    select s.user_id, s.collection_method, s.tier, s.status, s.mode
    into v_sub
    from public.subscriptions s
    where s.stripe_subscription_id = p_stripe_subscription_id;

    if not found then
        raise exception 'subscription % is not recorded yet; wait for the webhook, then retry', p_stripe_subscription_id
            using errcode = 'P0002';
    end if;
    if v_sub.user_id <> v_owner then
        raise exception 'subscription % belongs to another user, not this studio''s owner', p_stripe_subscription_id
            using errcode = '22023';
    end if;
    if v_sub.collection_method is distinct from 'send_invoice' then
        raise exception 'subscription % is not a send_invoice (Stripe Invoicing) subscription', p_stripe_subscription_id
            using errcode = '22023';
    end if;
    if v_sub.tier <> 'academy' or not (v_sub.mode = any (public.entitling_billing_modes ())) then
        raise exception 'subscription % does not entitle Academy (tier %, status %, mode %)',
            p_stripe_subscription_id, v_sub.tier, v_sub.status, v_sub.mode
            using errcode = '22023';
    end if;

    perform set_config('cleffy.seat_override_actor', trim(p_actor), true);
    perform set_config('cleffy.seat_override_reason', coalesce(p_reason, ''), true);

    insert into public.studio_seat_overrides (studio_id, seat_limit, stripe_subscription_id, reason, updated_by)
    values (p_studio, p_seat_limit, p_stripe_subscription_id, p_reason, trim(p_actor))
    on conflict (studio_id) do update
    set seat_limit = excluded.seat_limit,
        stripe_subscription_id = excluded.stripe_subscription_id,
        reason = excluded.reason,
        updated_by = excluded.updated_by,
        updated_at = now();

    -- Transaction-local is not statement-local: cleared, so a later hand-run
    -- write in the same transaction is not logged under this call's name.
    perform set_config('cleffy.seat_override_actor', '', true);
    perform set_config('cleffy.seat_override_reason', '', true);

    return jsonb_build_object(
        'studio_id', p_studio,
        'seat_limit', p_seat_limit,
        'stripe_subscription_id', p_stripe_subscription_id,
        'effective_seat_limit', public.studio_effective_seat_limit (p_studio)
    );
end;
$$;

-- Removes a studio's override; it goes back to 5. Members already seated keep
-- their seats (nothing here evicts anyone), but no new one can be added until
-- the count is under 5 again.
create or replace function public.admin_clear_studio_seat_override (
    p_studio uuid,
    p_actor text,
    p_reason text default null
) returns boolean language plpgsql security definer
set search_path = public as $$
declare
    v_found boolean;
begin
    if auth.uid() is not null then
        raise exception 'seat overrides are admin-only' using errcode = '42501';
    end if;
    if nullif(trim(coalesce(p_actor, '')), '') is null then
        raise exception 'say who is making this change (p_actor)' using errcode = '22023';
    end if;

    perform set_config('cleffy.seat_override_actor', trim(p_actor), true);
    perform set_config('cleffy.seat_override_reason', coalesce(p_reason, ''), true);

    delete from public.studio_seat_overrides where studio_id = p_studio;
    v_found := found;

    perform set_config('cleffy.seat_override_actor', '', true);
    perform set_config('cleffy.seat_override_reason', '', true);
    return v_found;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS and privileges
-- ---------------------------------------------------------------------------
-- RLS on with no policies: no client role reads or writes either table.
alter table public.studio_seat_overrides enable row level security;
alter table public.studio_seat_override_log enable row level security;

revoke all on table public.studio_seat_overrides from public;
revoke all on table public.studio_seat_overrides from anon;
revoke all on table public.studio_seat_overrides from authenticated;
grant select on table public.studio_seat_overrides to service_role;

revoke all on table public.studio_seat_override_log from public;
revoke all on table public.studio_seat_override_log from anon;
revoke all on table public.studio_seat_override_log from authenticated;
grant select on table public.studio_seat_override_log to service_role;

-- Trigger-only.
revoke all on function public.studio_seat_overrides_log_change () from public;
revoke all on function public.studio_seat_overrides_log_change () from anon;
revoke all on function public.studio_seat_overrides_log_change () from authenticated;

-- Internal: unchecked, so not a client RPC. studio_seat_limit is the checked one.
revoke all on function public.studio_effective_seat_limit (uuid) from public;
revoke all on function public.studio_effective_seat_limit (uuid) from anon;
revoke all on function public.studio_effective_seat_limit (uuid) from authenticated;
grant execute on function public.studio_effective_seat_limit (uuid) to service_role;

revoke all on function public.studio_seat_limit (uuid) from public;
revoke all on function public.studio_seat_limit (uuid) from anon;
grant execute on function public.studio_seat_limit (uuid) to authenticated;

revoke all on function public.admin_set_studio_seat_override (uuid, int, text, text, text) from public;
revoke all on function public.admin_set_studio_seat_override (uuid, int, text, text, text) from anon;
revoke all on function public.admin_set_studio_seat_override (uuid, int, text, text, text) from authenticated;
grant execute on function public.admin_set_studio_seat_override (uuid, int, text, text, text) to service_role;

revoke all on function public.admin_clear_studio_seat_override (uuid, text, text) from public;
revoke all on function public.admin_clear_studio_seat_override (uuid, text, text) from anon;
revoke all on function public.admin_clear_studio_seat_override (uuid, text, text) from authenticated;
grant execute on function public.admin_clear_studio_seat_override (uuid, text, text) to service_role;

-- Re-stated because create or replace keeps grants but this file is the one a
-- reader lands on: still trigger-only.
revoke all on function public.studios_enforce_seat_limit () from public;
revoke all on function public.studios_enforce_seat_limit () from anon;
revoke all on function public.studios_enforce_seat_limit () from authenticated;
