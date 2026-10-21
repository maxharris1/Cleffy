-- District seats, second pass (Codex review of PR #61 and the launch-compliance
-- decisions of 2026-10-21, items 1-3):
--
--  * The seat cap is enforced where access is decided, in resolve_entitlements(),
--    not only where seats are added. 20261020180400 capped INSERTs, so a district
--    that seated 100 teachers and then lapsed, had its override lowered or
--    cleared, or moved to ordinary $49 Academy, went on entitling all 100. Now a
--    seat counts only if it ranks inside the studio's effective limit. The seats
--    past it are READ-ONLY: view and export, nothing new -- no uploads, no
--    imports or analyses, no students, and (through the existing plan_lapse
--    archive, which annotation RLS already refuses writes on) no new marks.
--    Nothing is deleted. The owner picks which seats stay active
--    (studio_set_active_seats); the default is the oldest members. Paying again,
--    or the override coming back, makes every seat active again at once.
--
--  * public.district_billing is the district's billing record: the Stripe
--    Invoicing subscription it runs on, contract_ends_at (decisions item 1 --
--    the retention purge in PR #64 counts 30 days from it; null means never),
--    and an admin's grace extension. contract_ends_at is set by an admin from
--    the contract, or else follows the subscription's cancel/ended date.
--
--  * A send_invoice (Stripe Invoicing / PO terms) subscription past its due date
--    keeps full access -- override included -- for 30 days after it went past
--    due, or until an admin's extension if later (decisions item 3). After that
--    the lapse rules above apply. Stripe's own Invoicing reminders (due, +7,
--    +21 days) are an account setting; docs/DISTRICT_SEATS.md has the steps.
--
-- Why the read-only state needs two halves. The entitlement half is derived on
-- every read, so it is right the moment the clock or a row changes: a read-only
-- seat resolves to zero on every created thing and unlimited on export
-- (tier_limits('student') -- exactly "view and export"), which the score cap,
-- the quota RPCs, the export claim and student-provision already enforce. The
-- annotation half rides on archived_at, which RLS checks per write; that is a
-- stored fact, so reconcile_studio_seats() brings it in line on every event
-- that can move a seat (an override write, a subscription write, a pick, a
-- removal) and an hourly cron catches the ones only the clock moves (a grace
-- period running out, a period end with no webhook).

-- ---------------------------------------------------------------------------
-- When a subscription went past due
-- ---------------------------------------------------------------------------
-- Stripe marks a send_invoice subscription past_due once its invoice passes the
-- due date, so the first write in past_due/unpaid stands in for the due date.
-- A late webhook can only start the clock later, never earlier: the error runs
-- in the district's favour. Stamped by trigger so a hand-run update cannot
-- forget it, and kept through past_due -> unpaid.
alter table public.subscriptions add column past_due_since timestamptz;

create or replace function public.subscriptions_track_past_due () returns trigger language plpgsql
set search_path = public as $$
begin
    if new.status in ('past_due', 'unpaid') then
        if tg_op = 'UPDATE' and old.status in ('past_due', 'unpaid') then
            new.past_due_since := coalesce(new.past_due_since, old.past_due_since, now());
        else
            new.past_due_since := coalesce(new.past_due_since, now());
        end if;
    else
        new.past_due_since := null;
    end if;
    return new;
end;
$$;

revoke all on function public.subscriptions_track_past_due () from public;
revoke all on function public.subscriptions_track_past_due () from anon;
revoke all on function public.subscriptions_track_past_due () from authenticated;

create trigger subscriptions_track_past_due before insert or update on public.subscriptions
for each row execute function public.subscriptions_track_past_due ();

-- ---------------------------------------------------------------------------
-- The district billing record
-- ---------------------------------------------------------------------------
-- One row per district studio. Separate from studio_seat_overrides on purpose:
-- clearing an override at contract end must not take the contract end with it,
-- or the retention purge would never see the district.
--
-- >>> canonical public.district_billing >>>
-- One definition, byte-identical in 20261020180500_district_seat_cap_and_grace.sql
-- (mh/district-seats, PR #61) and 20261021120700_district_retention.sql
-- (mh/launch-consent, PR #64), from this marker line to the closing one. It is
-- rerunnable on its own: the table only if it is missing, each constraint only
-- if it is missing by name, and the privileges reset to the same end state
-- every time. Clients get nothing; the service role may read it; every write is
-- made by SECURITY DEFINER functions, which need no grant.
--
-- contract_ends_at: null means the district's data is never auto-purged.
-- contract_ends_source: 'admin' (pinned from the contract, null allowed: never)
-- or 'stripe' (Stripe's actual end); null only with a null contract_ends_at.
-- grace_extended_until: full access while past due lasts until the later of
-- 30 days and this.
create table if not exists public.district_billing (
    studio_id uuid primary key references public.studios (id) on delete cascade,
    stripe_subscription_id text references public.subscriptions (stripe_subscription_id) on delete set null,
    contract_ends_at timestamptz,
    contract_ends_source text,
    grace_extended_until timestamptz,
    updated_by text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

do $district_billing$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.district_billing'::regclass
          and conname = 'district_billing_contract_ends_source_check'
    ) then
        alter table public.district_billing
        add constraint district_billing_contract_ends_source_check
        check (contract_ends_source in ('admin', 'stripe'));
    end if;

    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.district_billing'::regclass
          and conname = 'district_billing_contract_ends_source_matches'
    ) then
        alter table public.district_billing
        add constraint district_billing_contract_ends_source_matches
        check ((contract_ends_source is null) = (contract_ends_at is null) or contract_ends_source is not distinct from 'admin');
    end if;
end;
$district_billing$;

create index if not exists district_billing_subscription on public.district_billing (stripe_subscription_id);

create index if not exists district_billing_contract_ends on public.district_billing (contract_ends_at)
where contract_ends_at is not null;

alter table public.district_billing enable row level security;

revoke all on table public.district_billing from public, anon, authenticated, service_role;

grant select on table public.district_billing to service_role;
-- <<< canonical public.district_billing <<<

-- Append-only, and like studio_seat_override_log it outlives the studio.
create table public.district_billing_log (
    id bigint generated by default as identity primary key,
    studio_id uuid not null,
    old_stripe_subscription_id text,
    new_stripe_subscription_id text,
    old_contract_ends_at timestamptz,
    new_contract_ends_at timestamptz,
    new_contract_ends_source text,
    old_grace_extended_until timestamptz,
    new_grace_extended_until timestamptz,
    reason text,
    actor text not null,
    changed_at timestamptz not null default now()
);

create index district_billing_log_studio on public.district_billing_log (studio_id, changed_at desc);

create or replace function public.district_billing_log_change () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_actor text := nullif(current_setting('cleffy.district_billing_actor', true), '');
    v_reason text := nullif(current_setting('cleffy.district_billing_reason', true), '');
begin
    if tg_op = 'UPDATE'
        and new.stripe_subscription_id is not distinct from old.stripe_subscription_id
        and new.contract_ends_at is not distinct from old.contract_ends_at
        and new.contract_ends_source is not distinct from old.contract_ends_source
        and new.grace_extended_until is not distinct from old.grace_extended_until then
        return new;
    end if;

    if tg_op = 'DELETE' then
        insert into public.district_billing_log (
            studio_id, old_stripe_subscription_id, old_contract_ends_at, old_grace_extended_until, reason, actor
        ) values (
            old.studio_id, old.stripe_subscription_id, old.contract_ends_at, old.grace_extended_until,
            v_reason, coalesce(v_actor, session_user::text)
        );
        return old;
    end if;

    insert into public.district_billing_log (
        studio_id, old_stripe_subscription_id, new_stripe_subscription_id, old_contract_ends_at,
        new_contract_ends_at, new_contract_ends_source, old_grace_extended_until, new_grace_extended_until,
        reason, actor
    ) values (
        new.studio_id,
        case when tg_op = 'UPDATE' then old.stripe_subscription_id end,
        new.stripe_subscription_id,
        case when tg_op = 'UPDATE' then old.contract_ends_at end,
        new.contract_ends_at,
        new.contract_ends_source,
        case when tg_op = 'UPDATE' then old.grace_extended_until end,
        new.grace_extended_until,
        v_reason,
        coalesce(v_actor, new.updated_by)
    );
    return new;
end;
$$;

create trigger district_billing_log after insert or update or delete on public.district_billing
for each row execute function public.district_billing_log_change ();

-- ---------------------------------------------------------------------------
-- Is a subscription live right now?
-- ---------------------------------------------------------------------------
-- The one definition every entitlement read now shares: active or trialing
-- inside its period, as before -- or a send_invoice subscription past due but
-- still inside its grace period. Card subscriptions get no grace: Stripe
-- retries the card and the existing past_due behaviour is unchanged.
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
        )
    );
$$;

create or replace function public.subscription_is_live (s public.subscriptions) returns boolean language sql stable
set search_path = public as $$
    select s.mode = any (public.entitling_billing_modes ())
        and (
            (s.status in ('active', 'trialing') and (s.current_period_end is null or s.current_period_end > now()))
            or (
                s.collection_method = 'send_invoice'
                and s.status in ('past_due', 'unpaid')
                and coalesce(now() < public.district_grace_ends_at (s.stripe_subscription_id, s.past_due_since), false)
            )
        );
$$;

revoke all on function public.district_grace_ends_at (text, timestamptz) from public;
revoke all on function public.district_grace_ends_at (text, timestamptz) from anon;
revoke all on function public.district_grace_ends_at (text, timestamptz) from authenticated;
grant execute on function public.district_grace_ends_at (text, timestamptz) to service_role;

revoke all on function public.subscription_is_live (public.subscriptions) from public;
revoke all on function public.subscription_is_live (public.subscriptions) from anon;
revoke all on function public.subscription_is_live (public.subscriptions) from authenticated;
grant execute on function public.subscription_is_live (public.subscriptions) to service_role;

-- Redefined from 20261020180400: liveness (grace included) from the shared
-- predicate. Otherwise unchanged.
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
              and public.subscription_is_live (s)
        ), 0)
    )
    from public.studios st
    where st.id = p_studio;
$$;

-- Unchanged, re-stated where the definition now lives: internal, unchecked.
revoke all on function public.studio_effective_seat_limit (uuid) from public;
revoke all on function public.studio_effective_seat_limit (uuid) from anon;
revoke all on function public.studio_effective_seat_limit (uuid) from authenticated;
grant execute on function public.studio_effective_seat_limit (uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Which seats are active
-- ---------------------------------------------------------------------------
-- The owner's pick. Members the owner marked kept rank first, then everyone by
-- when they were seated (oldest first), then by id so ties are stable. The
-- owner holds one seat, so the first seat_limit - 1 members are active.
alter table public.studio_members add column kept_active boolean not null default false;

create index studio_members_seat_order on public.studio_members (studio_id, kept_active desc, created_at, user_id);

-- One member's seat: true active, false read-only, null not a member. Counts
-- only as far as it needs to, so a 10000-seat district costs no more than a
-- 5-seat one on every entitlement read.
create or replace function public.studio_seat_is_active (p_studio uuid, p_user uuid) returns boolean language plpgsql stable
security definer
set search_path = public as $$
declare
    v_kept boolean;
    v_joined timestamptz;
    v_slots int;
    v_ahead int;
begin
    select sm.kept_active, sm.created_at into v_kept, v_joined
    from public.studio_members sm
    where sm.studio_id = p_studio and sm.user_id = p_user;

    if not found then
        return null;
    end if;

    v_slots := greatest(coalesce(public.studio_effective_seat_limit (p_studio), 0) - 1, 0);

    select count(*)::int into v_ahead
    from (
        select 1
        from public.studio_members o
        where o.studio_id = p_studio
          and o.user_id <> p_user
          and (
              (o.kept_active and not v_kept)
              or (o.kept_active = v_kept and (o.created_at, o.user_id) < (v_joined, p_user))
          )
        limit v_slots
    ) ahead;

    return v_ahead < v_slots;
end;
$$;

-- The whole studio at once, in the same order, for the owner's screen and the
-- reconcile below. Must agree with studio_seat_is_active; the SQL proof checks.
create or replace function public.studio_seat_states (p_studio uuid)
returns table (user_id uuid, kept_active boolean, active boolean, seated_at timestamptz) language sql stable
security definer
set search_path = public as $$
    select ranked.user_id, ranked.kept_active, ranked.position <= greatest(coalesce(public.studio_effective_seat_limit (p_studio), 0) - 1, 0), ranked.created_at
    from (
        select sm.user_id, sm.kept_active, sm.created_at,
               row_number() over (order by sm.kept_active desc, sm.created_at, sm.user_id) as position
        from public.studio_members sm
        where sm.studio_id = p_studio
    ) ranked;
$$;

revoke all on function public.studio_seat_is_active (uuid, uuid) from public;
revoke all on function public.studio_seat_is_active (uuid, uuid) from anon;
revoke all on function public.studio_seat_is_active (uuid, uuid) from authenticated;
grant execute on function public.studio_seat_is_active (uuid, uuid) to service_role;

revoke all on function public.studio_seat_states (uuid) from public;
revoke all on function public.studio_seat_states (uuid) from anon;
revoke all on function public.studio_seat_states (uuid) from authenticated;
grant execute on function public.studio_seat_states (uuid) to service_role;

-- ---------------------------------------------------------------------------
-- resolve_entitlements(): the cap, enforced
-- ---------------------------------------------------------------------------
-- The 20261009120101 definition with three changes:
--  * liveness is subscription_is_live(), so a district inside its invoice grace
--    period is still entitled -- its owner by their own subscription, its seats
--    through it;
--  * an Academy seat entitles only if it is an ACTIVE seat (inside the studio's
--    effective limit);
--  * a teacher whose only seats are past the limit resolves read-only: tier
--    'free' (they are not entitled to Academy, and buying their own plan is a
--    real way back), source 'studio_member', seat_read_only true, and the
--    view-and-export limits. Every answer now carries seat_read_only.
-- An active seat anywhere beats a read-only one, and the teacher's own
-- subscription still beats both.
create or replace function public.resolve_entitlements (p_user uuid) returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare
    v_user uuid := p_user;
    v_tier text := 'free';
    v_status text;
    v_source text := 'none';
    v_period_end timestamptz;
    v_cancelling boolean := false;
    v_read_only boolean := false;
    v_sub record;
begin
    if v_user is null then
        raise exception 'resolve_entitlements requires p_user' using errcode = '22023';
    end if;

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
            'seat_read_only', false,
            'limits', public.tier_limits ('student')
        );
    end if;

    -- Own subscription first. Highest tier wins if somehow more than one is live.
    select s.tier, s.status, s.current_period_end, s.cancel_at_period_end
    into v_sub
    from public.subscriptions s
    where s.user_id = v_user
      and public.subscription_is_live (s)
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
        -- An active seat in an academy whose owner is paying.
        select s.status, s.current_period_end, s.cancel_at_period_end
        into v_sub
        from public.studio_members sm
        join public.studios st on st.id = sm.studio_id
        join public.subscriptions s on s.user_id = st.owner_id
        where sm.user_id = v_user
          and s.tier = 'academy'
          and public.subscription_is_live (s)
          and public.studio_seat_is_active (sm.studio_id, v_user)
        order by s.current_period_end desc nulls last
        limit 1;

        if found then
            v_tier := 'academy';
            v_status := v_sub.status;
            v_period_end := v_sub.current_period_end;
            v_cancelling := v_sub.cancel_at_period_end;
            v_source := 'studio_member';
        else
            -- A seat past the limit: kept, readable, exportable -- and nothing new.
            -- Only a studio over its limit can rank anyone past it, and only an
            -- override that lapsed, shrank or went can leave one over.
            perform 1
            from public.studio_members sm
            where sm.user_id = v_user
              and not public.studio_seat_is_active (sm.studio_id, v_user);

            if found then
                v_read_only := true;
                v_source := 'studio_member';
            end if;
        end if;
    end if;

    return jsonb_build_object(
        'user_id', v_user,
        'tier', v_tier,
        'status', v_status,
        'source', v_source,
        'current_period_end', v_period_end,
        'cancel_at_period_end', coalesce(v_cancelling, false),
        'seat_read_only', v_read_only,
        -- tier_limits('student') is zero on everything one creates and unlimited
        -- on export: exactly "view and export only".
        'limits', case when v_read_only then public.tier_limits ('student') else public.tier_limits (v_tier) end
    );
end;
$$;

revoke all on function public.resolve_entitlements (uuid) from public;
revoke all on function public.resolve_entitlements (uuid) from anon;
revoke all on function public.resolve_entitlements (uuid) from authenticated;
grant execute on function public.resolve_entitlements (uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Bringing the stored half in line
-- ---------------------------------------------------------------------------
-- Every member, in id order (the order restore_plan_archived_scores visits
-- them, so the two cannot deadlock on a teacher's locks): a read-only seat has
-- its active scores archived as plan_lapse -- the archive annotation RLS
-- already refuses writes on, and the one every restore path already undoes --
-- and anyone else gets back what a lapse archived, up to the plan they now
-- resolve to (unlimited for an active paid seat, the free 3 for a teacher the
-- owner released). Both calls re-read the member's entitlements under their own
-- locks, so this is a filter, never the cap. Returns the scores it moved.
create or replace function public.reconcile_studio_seats (p_studio uuid) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_member uuid;
    v_moved int := 0;
begin
    for v_member in
        select sm.user_id
        from public.studio_members sm
        join auth.users u on u.id = sm.user_id
        where sm.studio_id = p_studio
        order by sm.user_id
    loop
        if coalesce((public.resolve_entitlements (v_member) ->> 'seat_read_only')::boolean, false) then
            v_moved := v_moved + public.apply_free_tier_archival (v_member);
        else
            v_moved := v_moved + public.restore_user_plan_archived_scores (v_member);
        end if;
    end loop;
    return v_moved;
end;
$$;

-- The hourly sweep, for what only the clock moves. Only studios with more
-- members than the Academy cap leaves room for can hold a read-only seat.
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
    return v_moved;
end;
$$;

revoke all on function public.reconcile_studio_seats (uuid) from public;
revoke all on function public.reconcile_studio_seats (uuid) from anon;
revoke all on function public.reconcile_studio_seats (uuid) from authenticated;
grant execute on function public.reconcile_studio_seats (uuid) to service_role;

revoke all on function public.reconcile_district_seats () from public;
revoke all on function public.reconcile_district_seats () from anon;
revoke all on function public.reconcile_district_seats () from authenticated;
grant execute on function public.reconcile_district_seats () to service_role;

select cron.schedule ('district-seat-reconcile', '41 * * * *', $$select public.reconcile_district_seats ()$$);

-- An override set, changed or cleared moves seats at once.
create or replace function public.studio_seat_overrides_reconcile () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if tg_op <> 'DELETE' then
        -- The override names the district's subscription; the billing record
        -- follows it, so grace and the contract end are read from the same one.
        -- Pointing it at a replacement subscription derives the contract end
        -- again at once (Codex round-2 review of #61, major 2): the old
        -- subscription's end must not outlive the renewal.
        perform set_config('cleffy.district_billing_actor', new.updated_by, true);
        insert into public.district_billing (studio_id, stripe_subscription_id, updated_by)
        values (new.studio_id, new.stripe_subscription_id, new.updated_by)
        on conflict (studio_id) do update
        set stripe_subscription_id = excluded.stripe_subscription_id,
            updated_by = excluded.updated_by,
            updated_at = now()
        where district_billing.stripe_subscription_id is distinct from excluded.stripe_subscription_id;
        perform public.district_billing_rederive (new.studio_id);
        perform set_config('cleffy.district_billing_actor', '', true);
    end if;
    perform public.reconcile_studio_seats (case when tg_op = 'DELETE' then old.studio_id else new.studio_id end);
    return null;
end;
$$;

revoke all on function public.studio_seat_overrides_reconcile () from public;
revoke all on function public.studio_seat_overrides_reconcile () from anon;
revoke all on function public.studio_seat_overrides_reconcile () from authenticated;

create trigger studio_seat_overrides_reconcile after insert or update or delete on public.studio_seat_overrides
for each row execute function public.studio_seat_overrides_reconcile ();

-- A member removed frees a seat (someone read-only may now be active) and
-- releases the member, who gets back what a read-only seat archived, up to the
-- plan they now resolve to. Skipped for a deleted account -- its scores are
-- delete-account's to drain, not to un-archive -- and for a deleted studio.
create or replace function public.studio_members_release_seat () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if exists (select 1 from auth.users u where u.id = old.user_id) then
        perform public.restore_user_plan_archived_scores (old.user_id);
    end if;
    if exists (select 1 from public.studios st where st.id = old.studio_id) then
        perform public.reconcile_studio_seats (old.studio_id);
    end if;
    return null;
end;
$$;

revoke all on function public.studio_members_release_seat () from public;
revoke all on function public.studio_members_release_seat () from anon;
revoke all on function public.studio_members_release_seat () from authenticated;

create trigger studio_members_release_seat after delete on public.studio_members
for each row execute function public.studio_members_release_seat ();

-- ---------------------------------------------------------------------------
-- Subscription writes: the billing record and the seats follow
-- ---------------------------------------------------------------------------
-- Runs inside the webhook's write_subscription_under_lock (and any hand-run
-- write), only when something an entitlement reads has changed.
--
-- contract_ends_at follows Stripe unless an admin pinned it -- and only Stripe's
-- ACTUAL end (Codex round-2 review of #61, major 3): the subscription's ended_at
-- (stripeEvents.ts endedAtOf: Stripe's ended_at, or the cancel_at a terminal
-- status confirms it ended on) once its status is terminal, and null while it
-- has not ended. Never a scheduled cancellation, which can still be moved or
-- withdrawn (a cancellation a year out, then an immediate one, must count from
-- the immediate one), and never a billing-period date, which can be long before
-- or after the day it ended. A subscription recorded as ended without an
-- ended_at (a webhook deployed before 20261020180400) falls back to the end
-- already stored, then to the event that ended it; a redelivery changes
-- nothing, because ended_at does not change once Stripe has set it.
--
-- And never while the district pays (major 2): a district renewing on a NEW
-- subscription -- the old one ended and recorded its end, then the owner signed
-- again -- has a live Stripe Invoicing Academy subscription, and that alone
-- makes the Stripe-derived end null, whichever subscription the record or the
-- override still names. Derived from scratch on every call, so whatever moved
-- (a subscription write, the override naming another subscription, an admin
-- handing the date back to Stripe) leaves the same answer. An admin's pin is
-- the contract's own date and is left alone. Clearing the date is also what
-- stops a purge cycle already under way: the retention workflow (#64) cancels
-- any cycle whose contract end is cleared or moved.
create or replace function public.district_billing_rederive (p_studio uuid) returns void
language plpgsql security definer
set search_path = public as $$
declare
    v_row public.district_billing;
    v_owner uuid;
    v_linked public.subscriptions;
    v_end timestamptz;
begin
    select * into v_row from public.district_billing b where b.studio_id = p_studio for update;
    if not found or v_row.contract_ends_source = 'admin' then
        return;
    end if;

    select st.owner_id into v_owner from public.studios st where st.id = p_studio;

    if not exists (
        select 1 from public.subscriptions s
        where s.user_id = v_owner
          and s.collection_method = 'send_invoice'
          and s.tier = 'academy'
          and public.subscription_is_live (s)
    ) then
        select * into v_linked from public.subscriptions s where s.stripe_subscription_id = v_row.stripe_subscription_id;
        if found and v_linked.status in ('canceled', 'incomplete_expired') then
            v_end := coalesce(
                v_linked.ended_at,
                case when v_row.contract_ends_source = 'stripe' then v_row.contract_ends_at end,
                v_linked.last_event_created_at,
                now()
            );
        end if;
    end if;

    update public.district_billing b
    set contract_ends_at = v_end,
        contract_ends_source = case when v_end is null then null else 'stripe' end,
        updated_by = coalesce(nullif(current_setting('cleffy.district_billing_actor', true), ''), 'stripe'),
        updated_at = now()
    where b.studio_id = p_studio
      and (b.contract_ends_at is distinct from v_end
           or b.contract_ends_source is distinct from case when v_end is null then null else 'stripe' end);
end;
$$;

revoke all on function public.district_billing_rederive (uuid) from public;
revoke all on function public.district_billing_rederive (uuid) from anon;
revoke all on function public.district_billing_rederive (uuid) from authenticated;

-- A Stripe Invoicing subscription written for the owner: the record links to it
-- if it links to nothing yet, or if it is live and the linked one is not (a
-- renewal on a new subscription). An override, when there is one, decides the
-- link instead (studio_seat_overrides_reconcile). Then the contract end is
-- derived again.
create or replace function public.district_billing_follow (p_studio uuid, s public.subscriptions) returns void
language plpgsql security definer
set search_path = public as $$
begin
    if s.collection_method is distinct from 'send_invoice' then
        return;
    end if;

    perform set_config('cleffy.district_billing_actor', 'stripe', true);

    insert into public.district_billing (studio_id, stripe_subscription_id, updated_by)
    values (p_studio, s.stripe_subscription_id, 'stripe')
    on conflict (studio_id) do update
    set stripe_subscription_id = excluded.stripe_subscription_id,
        updated_at = now()
    where district_billing.stripe_subscription_id is distinct from excluded.stripe_subscription_id
      and not exists (select 1 from public.studio_seat_overrides o where o.studio_id = p_studio)
      and (
          district_billing.stripe_subscription_id is null
          or (
              public.subscription_is_live (s)
              and not exists (
                  select 1 from public.subscriptions l
                  where l.stripe_subscription_id = district_billing.stripe_subscription_id
                    and public.subscription_is_live (l)
              )
          )
      );

    perform public.district_billing_rederive (p_studio);

    perform set_config('cleffy.district_billing_actor', '', true);
end;
$$;

revoke all on function public.district_billing_follow (uuid, public.subscriptions) from public;
revoke all on function public.district_billing_follow (uuid, public.subscriptions) from anon;
revoke all on function public.district_billing_follow (uuid, public.subscriptions) from authenticated;

create or replace function public.subscriptions_follow_district () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_studio uuid;
begin
    if tg_op = 'UPDATE'
        and new.status is not distinct from old.status
        and new.tier is not distinct from old.tier
        and new.mode is not distinct from old.mode
        and new.user_id is not distinct from old.user_id
        and new.current_period_end is not distinct from old.current_period_end
        and new.cancel_at_period_end is not distinct from old.cancel_at_period_end
        and new.collection_method is not distinct from old.collection_method
        and new.past_due_since is not distinct from old.past_due_since
        and new.ended_at is not distinct from old.ended_at then
        return null;
    end if;

    for v_studio in
        select st.id from public.studios st where st.owner_id = new.user_id order by st.id
    loop
        perform public.district_billing_follow (v_studio, new);

        if (select count(*) from public.studio_members sm where sm.studio_id = v_studio) > 4 then
            perform public.reconcile_studio_seats (v_studio);
        end if;
    end loop;

    return null;
end;
$$;

revoke all on function public.subscriptions_follow_district () from public;
revoke all on function public.subscriptions_follow_district () from anon;
revoke all on function public.subscriptions_follow_district () from authenticated;

create trigger subscriptions_follow_district after insert or update on public.subscriptions
for each row execute function public.subscriptions_follow_district ();

-- Districts whose subscription the webhook has already recorded get their
-- billing record now rather than at their next event.
insert into public.district_billing (studio_id, stripe_subscription_id, updated_by)
select o.studio_id, o.stripe_subscription_id, 'migration 20261020180500'
from public.studio_seat_overrides o
on conflict (studio_id) do nothing;

-- ---------------------------------------------------------------------------
-- The owner picks which seats stay active
-- ---------------------------------------------------------------------------
-- p_members is the owner's list of seats to keep; everyone else is ordered by
-- when they were seated. A list longer than the seats the studio can fill now
-- is refused rather than half-honoured. Allowed whatever the owner pays: the
-- pick matters most when the district has lapsed.
create or replace function public.studio_set_active_seats (p_studio uuid, p_members uuid[]) returns int language plpgsql
security definer
set search_path = public as $$
declare
    v_owner uuid;
    v_slots int;
    v_wanted uuid[] := coalesce(array(select distinct m from unnest(p_members) as m where m is not null), '{}');
begin
    if auth.uid() is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    select st.owner_id into v_owner from public.studios st where st.id = p_studio;
    if v_owner is null or v_owner <> auth.uid() then
        raise exception 'only the studio owner can choose its active seats' using errcode = '42501';
    end if;

    -- The same lock the seat trigger counts under, so a pick and an invite
    -- cannot interleave.
    perform pg_advisory_xact_lock (hashtext('cleffy.studio_seats'), hashtext(p_studio::text));

    if exists (
        select 1 from unnest(v_wanted) as m
        where not exists (
            select 1 from public.studio_members sm where sm.studio_id = p_studio and sm.user_id = m
        )
    ) then
        raise exception 'every kept seat must be a member of this academy' using errcode = '22023';
    end if;

    v_slots := greatest(public.studio_effective_seat_limit (p_studio) - 1, 0);
    if cardinality(v_wanted) > v_slots then
        raise exception 'only % seats can be active besides yours; % chosen', v_slots, cardinality(v_wanted)
            using errcode = '22023',
                  detail = json_build_object('code', 'too_many_active_seats', 'limit', v_slots)::text;
    end if;

    update public.studio_members sm
    set kept_active = (sm.user_id = any (v_wanted))
    where sm.studio_id = p_studio
      and sm.kept_active is distinct from (sm.user_id = any (v_wanted));

    return public.reconcile_studio_seats (p_studio);
end;
$$;

-- What the owner's seat list shows: who is active and who is read-only.
create or replace function public.studio_seat_status (p_studio uuid)
returns table (user_id uuid, kept_active boolean, active boolean) language plpgsql stable security definer
set search_path = public as $$
declare
    v_owner uuid;
begin
    select st.owner_id into v_owner from public.studios st where st.id = p_studio;
    if v_owner is null or v_owner <> auth.uid() then
        raise exception 'only the studio owner can list seats' using errcode = '42501';
    end if;

    return query
    select s.user_id, s.kept_active, s.active from public.studio_seat_states (p_studio) s;
end;
$$;

revoke all on function public.studio_set_active_seats (uuid, uuid[]) from public;
revoke all on function public.studio_set_active_seats (uuid, uuid[]) from anon;
grant execute on function public.studio_set_active_seats (uuid, uuid[]) to authenticated;

revoke all on function public.studio_seat_status (uuid) from public;
revoke all on function public.studio_seat_status (uuid) from anon;
grant execute on function public.studio_seat_status (uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Admin: contract end and grace (service role / SQL editor only)
-- ---------------------------------------------------------------------------
-- The billing record for a studio, created from the owner's send_invoice
-- subscription if the webhook has not made one yet.
create or replace function public.district_billing_row (p_studio uuid) returns public.district_billing language plpgsql
security definer
set search_path = public as $$
declare
    v_row public.district_billing;
    v_owner uuid;
    v_sub text;
begin
    select * into v_row from public.district_billing b where b.studio_id = p_studio;
    if found then
        return v_row;
    end if;

    select st.owner_id into v_owner from public.studios st where st.id = p_studio;
    if v_owner is null then
        raise exception 'no studio %', p_studio using errcode = 'P0002';
    end if;

    select coalesce(
        (select o.stripe_subscription_id from public.studio_seat_overrides o where o.studio_id = p_studio),
        (select s.stripe_subscription_id from public.subscriptions s
         where s.user_id = v_owner and s.collection_method = 'send_invoice'
         order by s.updated_at desc limit 1)
    ) into v_sub;

    insert into public.district_billing (studio_id, stripe_subscription_id, updated_by)
    values (p_studio, v_sub, 'admin')
    returning * into v_row;
    return v_row;
end;
$$;

-- Pins the contract end from the contract (p_contract_ends_at; null pins
-- "never purge"), or with p_automatic hands it back to Stripe's dates.
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
        set contract_ends_at = null, contract_ends_source = null, updated_by = trim(p_actor), updated_at = now()
        where b.studio_id = p_studio;

        -- Re-derive from the subscriptions as they stand, the way their
        -- webhook writes do.
        perform public.district_billing_rederive (p_studio);
    else
        update public.district_billing b
        set contract_ends_at = p_contract_ends_at,
            contract_ends_source = 'admin',
            updated_by = trim(p_actor),
            updated_at = now()
        where b.studio_id = p_studio;
    end if;

    perform set_config('cleffy.district_billing_actor', '', true);
    perform set_config('cleffy.district_billing_reason', '', true);

    select * into v_row from public.district_billing b where b.studio_id = p_studio;
    return jsonb_build_object(
        'studio_id', p_studio,
        'stripe_subscription_id', v_row.stripe_subscription_id,
        'contract_ends_at', v_row.contract_ends_at,
        'contract_ends_source', v_row.contract_ends_source
    );
end;
$$;

-- Moves full access while past due out to p_grace_until (null: back to the
-- standard 30 days). Seats move at once.
create or replace function public.admin_extend_district_grace (
    p_studio uuid,
    p_grace_until timestamptz,
    p_actor text,
    p_reason text default null
) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_row public.district_billing;
    v_ends timestamptz;
begin
    if auth.uid() is not null then
        raise exception 'district billing is admin-only' using errcode = '42501';
    end if;
    if nullif(trim(coalesce(p_actor, '')), '') is null then
        raise exception 'say who is making this change (p_actor)' using errcode = '22023';
    end if;

    v_row := public.district_billing_row (p_studio);
    if v_row.stripe_subscription_id is null then
        raise exception 'studio % has no Stripe Invoicing subscription recorded to extend', p_studio
            using errcode = 'P0002';
    end if;

    perform set_config('cleffy.district_billing_actor', trim(p_actor), true);
    perform set_config('cleffy.district_billing_reason', coalesce(p_reason, ''), true);

    update public.district_billing b
    set grace_extended_until = p_grace_until, updated_by = trim(p_actor), updated_at = now()
    where b.studio_id = p_studio;

    perform set_config('cleffy.district_billing_actor', '', true);
    perform set_config('cleffy.district_billing_reason', '', true);

    perform public.reconcile_studio_seats (p_studio);

    select public.district_grace_ends_at (s.stripe_subscription_id, s.past_due_since) into v_ends
    from public.subscriptions s
    where s.stripe_subscription_id = v_row.stripe_subscription_id;

    return jsonb_build_object(
        'studio_id', p_studio,
        'stripe_subscription_id', v_row.stripe_subscription_id,
        'grace_extended_until', p_grace_until,
        'grace_ends_at', v_ends
    );
end;
$$;

revoke all on function public.district_billing_row (uuid) from public;
revoke all on function public.district_billing_row (uuid) from anon;
revoke all on function public.district_billing_row (uuid) from authenticated;
grant execute on function public.district_billing_row (uuid) to service_role;

revoke all on function public.admin_set_district_contract_end (uuid, timestamptz, text, text, boolean) from public;
revoke all on function public.admin_set_district_contract_end (uuid, timestamptz, text, text, boolean) from anon;
revoke all on function public.admin_set_district_contract_end (uuid, timestamptz, text, text, boolean) from authenticated;
grant execute on function public.admin_set_district_contract_end (uuid, timestamptz, text, text, boolean) to service_role;

revoke all on function public.admin_extend_district_grace (uuid, timestamptz, text, text) from public;
revoke all on function public.admin_extend_district_grace (uuid, timestamptz, text, text) from anon;
revoke all on function public.admin_extend_district_grace (uuid, timestamptz, text, text) from authenticated;
grant execute on function public.admin_extend_district_grace (uuid, timestamptz, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- RLS and privileges
-- ---------------------------------------------------------------------------
-- district_billing's own are in its canonical definition above.
alter table public.district_billing_log enable row level security;

revoke all on table public.district_billing_log from public;
revoke all on table public.district_billing_log from anon;
revoke all on table public.district_billing_log from authenticated;
grant select on table public.district_billing_log to service_role;

revoke all on function public.district_billing_log_change () from public;
revoke all on function public.district_billing_log_change () from anon;
revoke all on function public.district_billing_log_change () from authenticated;
