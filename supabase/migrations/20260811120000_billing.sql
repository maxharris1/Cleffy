-- Billing: Stripe customers/subscriptions, academy seats, metered usage, and the
-- free-tier cloud-score cap.
--
-- Design notes:
--  * Stripe price IDs live in Edge Function env, never in the database. The
--    webhook resolves price -> tier and stores the RESOLVED tier here, which is
--    why Founding Teacher needs no schema support: it is a second price on the
--    Teacher product, so a founding subscription is simply tier 'teacher'.
--  * The seat tables keep their original names (studios, studio_members); only
--    the tier they entitle was renamed, from the v1 studio tier to academy. The
--    same goes for the studio_member entitlement source, which names the table
--    the seat row lives in rather than the tier.
--  * tier_limits() is the single source of truth for the numbers. The TS mirror
--    in supabase/functions/_shared/entitlements.ts is drift-guarded by
--    tests/billing/limitsInSync.test.ts, which parses this file.
--  * cloud_scores and students are STOCKS (a live count of non-archived
--    documents, and of roster rows), not flows, so they are enforced where the
--    row is written and never reach usage_counters. The other metrics are
--    monthly flows. pdf_exports is a flow with a caveat: the export itself runs
--    on-device, so its gate is honest-UI plus this server-side counter, and it
--    never applies to anonymous guests or provisioned students.
--  * Lapsing NEVER deletes data. Scores beyond the free cap get archived_at set;
--    they stay readable and exportable, only annotation writes are blocked.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.billing_customers (
    user_id uuid primary key references auth.users (id) on delete cascade,
    stripe_customer_id text not null unique,
    created_at timestamptz not null default now()
);

create table public.subscriptions (
    stripe_subscription_id text primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    tier text not null check (tier in ('free', 'personal', 'teacher', 'academy')),
    status text not null,
    price_id text,
    current_period_end timestamptz,
    cancel_at_period_end boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index subscriptions_user on public.subscriptions (user_id);

create table public.studios (
    id uuid primary key,
    owner_id uuid not null references auth.users (id) on delete cascade,
    name text not null,
    seat_limit int not null default 5 check (seat_limit > 0),
    created_at timestamptz not null default now()
);

create index studios_owner on public.studios (owner_id);

create table public.studio_members (
    studio_id uuid not null references public.studios (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (studio_id, user_id)
);

create index studio_members_user on public.studio_members (user_id);

-- Monthly metered usage. `month` is the first day of the calendar month, so a
-- rollover is simply a new conflict key -- last month's row is never touched.
create table public.usage_counters (
    user_id uuid not null references auth.users (id) on delete cascade,
    metric text not null,
    month date not null,
    count int not null default 0,
    updated_at timestamptz not null default now(),
    primary key (user_id, metric, month)
);

-- Webhook idempotency ledger, keyed by Stripe's own event id.
create table public.stripe_events (
    id text primary key,
    type text not null,
    processed_at timestamptz not null default now()
);

-- Active = archived_at is null. Archived scores stay viewable and exportable.
alter table public.documents add column archived_at timestamptz;

create index documents_owner_active on public.documents (owner_id) where archived_at is null;

-- ---------------------------------------------------------------------------
-- Tier limits -- the single source of truth for the numbers (-1 = unlimited)
-- ---------------------------------------------------------------------------
create or replace function public.tier_limits (p_tier text) returns jsonb language sql immutable
set search_path = public as $$
    select case p_tier
        -- students = 0 is what makes Personal a solo plan: no roster, no seats.
        when 'personal' then jsonb_build_object(
            'cloud_scores', -1, 'omr_runs', -1, 'vision_reads', 500, 'smart_imports', -1, 'pdf_exports', -1, 'students', 0
        )
        when 'teacher' then jsonb_build_object(
            'cloud_scores', -1, 'omr_runs', -1, 'vision_reads', 500, 'smart_imports', -1, 'pdf_exports', -1, 'students', -1
        )
        when 'academy' then jsonb_build_object(
            'cloud_scores', -1, 'omr_runs', -1, 'vision_reads', 500, 'smart_imports', -1, 'pdf_exports', -1, 'students', -1
        )
        else jsonb_build_object(
            'cloud_scores', 3, 'omr_runs', 3, 'vision_reads', 5, 'smart_imports', 2, 'pdf_exports', 1, 'students', 3
        )
    end;
$$;

-- ---------------------------------------------------------------------------
-- Effective entitlements, resolving Academy seat membership
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so it can read subscriptions/studios past their own RLS.
-- That makes the caller check mandatory: a signed-in user may only ask about
-- themselves; service-role callers (auth.uid() is null) must name a user.
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

    -- Own subscription first. Highest tier wins if somehow more than one is live.
    select s.tier, s.status, s.current_period_end
    into v_sub
    from public.subscriptions s
    where s.user_id = v_user
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

-- ---------------------------------------------------------------------------
-- Atomic metered consume -- check and increment in ONE statement
-- ---------------------------------------------------------------------------
create or replace function public.consume_quota (p_user uuid, p_metric text, p_limit int) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_month date := date_trunc('month', now())::date;
    v_count int;
begin
    if p_user is null or p_metric is null or p_limit is null then
        raise exception 'consume_quota requires p_user, p_metric and p_limit' using errcode = '22023';
    end if;

    -- A zero limit can never be satisfied, and must be rejected BEFORE the
    -- insert: the first write of a month has no conflict, so DO UPDATE's WHERE
    -- never runs and count = 1 would slip straight past the cap.
    if p_limit = 0 then
        return jsonb_build_object('ok', false, 'count', 0, 'limit', p_limit);
    end if;

    -- The WHERE on DO UPDATE is what makes this race-free: on conflict Postgres
    -- takes a row lock and re-evaluates the predicate against the locked row, so
    -- concurrent callers serialize with no check-then-write window. Zero rows
    -- back means the cap was hit AND nothing was incremented.
    insert into public.usage_counters (user_id, metric, month, count)
    values (p_user, p_metric, v_month, 1)
    on conflict (user_id, metric, month) do update
        set count = usage_counters.count + 1,
            updated_at = now()
        where p_limit < 0 or usage_counters.count < p_limit
    returning count into v_count;

    if v_count is null then
        select uc.count into v_count
        from public.usage_counters uc
        where uc.user_id = p_user and uc.metric = p_metric and uc.month = v_month;
        return jsonb_build_object('ok', false, 'count', coalesce(v_count, 0), 'limit', p_limit);
    end if;

    return jsonb_build_object('ok', true, 'count', v_count, 'limit', p_limit);
end;
$$;

-- Refund a consumed unit when the work it paid for failed. Never goes below 0.
create or replace function public.release_quota (p_user uuid, p_metric text) returns void language sql security definer
set search_path = public as $$
    update public.usage_counters
    set count = greatest(0, count - 1), updated_at = now()
    where user_id = p_user
      and metric = p_metric
      and month = date_trunc('month', now())::date;
$$;

-- ---------------------------------------------------------------------------
-- Cloud-score cap (a stock, not a flow) + archived read-only
-- ---------------------------------------------------------------------------
create or replace function public.document_is_archived (doc uuid) returns boolean language sql stable security definer
set search_path = public as $$
    select coalesce((select d.archived_at is not null from public.documents d where d.id = doc), false);
$$;

-- Uploads are a direct browser PostgREST insert (see documentsService.uploadDocument),
-- so the cap lives in a trigger rather than an Edge Function. A WITH CHECK
-- expression could reject the row but could not carry the structured payload the
-- client needs, so this raises with a machine-readable DETAIL instead.
create or replace function public.documents_enforce_score_cap () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_ent jsonb;
    v_tier text;
    v_limit int;
    v_count int;
begin
    -- Only a row that is (or becomes) active claims a slot.
    if new.archived_at is not null then
        return new;
    end if;
    if tg_op = 'UPDATE' and old.archived_at is null then
        return new; -- already active; nothing new is being claimed
    end if;

    v_ent := public.get_entitlements (new.owner_id);
    v_tier := v_ent ->> 'tier';
    v_limit := (v_ent -> 'limits' ->> 'cloud_scores')::int;

    if v_limit < 0 then
        return new;
    end if;

    select count(*)::int into v_count
    from public.documents d
    where d.owner_id = new.owner_id
      and d.archived_at is null
      and d.id <> new.id;

    if v_count >= v_limit then
        raise exception 'limit_reached'
            using errcode = 'P0001',
                  detail = json_build_object(
                      'code', 'limit_reached',
                      'metric', 'cloud_scores',
                      'limit', v_limit,
                      'tier', v_tier
                  )::text,
                  hint = 'Upgrade for unlimited cloud scores.';
    end if;

    return new;
end;
$$;

create trigger documents_enforce_score_cap before insert or update on public.documents
for each row execute function public.documents_enforce_score_cap ();

-- Archived scores are read-only. Enforced in RLS rather than in the client so it
-- also holds for share-link students and for the batch RPCs (which are SECURITY
-- INVOKER precisely so policies like this keep applying to bulk writes).
drop policy if exists annotations_insert on public.annotations;

create policy annotations_insert on public.annotations for insert to authenticated
with check (
    public.document_role (document_id) in ('owner', 'editor')
    and created_by = (select auth.uid())
    and not public.document_is_archived (document_id)
);

drop policy if exists annotations_update on public.annotations;

create policy annotations_update on public.annotations for update to authenticated
using (public.document_role (document_id) in ('owner', 'editor'))
with check (
    public.document_role (document_id) in ('owner', 'editor')
    and not public.document_is_archived (document_id)
);

-- Called by the webhook when a subscription lapses. Keeps the most recently
-- touched scores active and archives the rest -- never deletes.
create or replace function public.apply_free_tier_archival (p_user uuid) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_limit int;
    v_archived int;
begin
    v_limit := (public.get_entitlements (p_user) -> 'limits' ->> 'cloud_scores')::int;
    if v_limit < 0 then
        return 0;
    end if;

    with keep as (
        select d.id
        from public.documents d
        where d.owner_id = p_user and d.archived_at is null
        order by d.updated_at desc, d.id
        limit v_limit
    )
    update public.documents d
    set archived_at = now()
    where d.owner_id = p_user
      and d.archived_at is null
      and not exists (select 1 from keep k where k.id = d.id);

    get diagnostics v_archived = row_count;
    return v_archived;
end;
$$;

-- ---------------------------------------------------------------------------
-- Academy seat management (on the studios/studio_members tables, v1 names kept)
-- ---------------------------------------------------------------------------
create or replace function public.studios_enforce_seat_limit () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_limit int;
    v_used int;
begin
    select st.seat_limit into v_limit from public.studios st where st.id = new.studio_id;
    if v_limit is null then
        raise exception 'studio not found' using errcode = 'P0002';
    end if;

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

create trigger studio_members_seat_limit before insert on public.studio_members
for each row execute function public.studios_enforce_seat_limit ();

-- auth.users is not client-readable, so seat invites resolve the email here.
create or replace function public.studio_invite_member (p_studio uuid, p_email text) returns uuid language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_owner uuid;
    v_target uuid;
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    select st.owner_id into v_owner from public.studios st where st.id = p_studio;
    if v_owner is null or v_owner <> v_caller then
        raise exception 'only the studio owner can add seats' using errcode = '42501';
    end if;

    select u.id into v_target from auth.users u where lower(u.email) = lower(trim(p_email)) limit 1;
    if v_target is null then
        raise exception 'no Cleffy account with that email'
            using errcode = 'P0002',
                  detail = json_build_object('code', 'user_not_found')::text;
    end if;

    -- The owner already holds a seat implicitly; adding a row for them would
    -- double-count against seat_limit.
    if v_target = v_owner then
        raise exception 'the studio owner already holds a seat'
            using errcode = 'P0001',
                  detail = json_build_object('code', 'owner_already_seated')::text;
    end if;

    insert into public.studio_members (studio_id, user_id)
    values (p_studio, v_target)
    on conflict (studio_id, user_id) do nothing;

    return v_target;
end;
$$;

-- Seat roster with emails, owner only. studio_members holds ids, and auth.users
-- is not client-readable, so the join has to happen behind a definer boundary.
create or replace function public.studio_roster (p_studio uuid) returns table (user_id uuid, email text) language plpgsql stable security definer
set search_path = public as $$
-- OUT params (user_id, email) share names with the columns below; let columns win,
-- same hazard redeem_share_link documents.
#variable_conflict use_column
declare
    v_caller uuid := auth.uid();
    v_owner uuid;
begin
    select st.owner_id into v_owner from public.studios st where st.id = p_studio;
    if v_caller is null or v_owner is null or v_owner <> v_caller then
        raise exception 'only the studio owner can list seats' using errcode = '42501';
    end if;

    return query
        select sm.user_id, u.email::text
        from public.studio_members sm
        join auth.users u on u.id = sm.user_id
        where sm.studio_id = p_studio
        order by u.email;
end;
$$;

create or replace function public.studio_remove_member (p_studio uuid, p_user uuid) returns void language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_owner uuid;
begin
    select st.owner_id into v_owner from public.studios st where st.id = p_studio;
    if v_caller is null or v_owner is null or v_owner <> v_caller then
        raise exception 'only the studio owner can remove seats' using errcode = '42501';
    end if;

    delete from public.studio_members where studio_id = p_studio and user_id = p_user;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS -- users read only their own rows; every write is service-role/definer
-- ---------------------------------------------------------------------------
alter table public.billing_customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.studios enable row level security;
alter table public.studio_members enable row level security;
alter table public.usage_counters enable row level security;
alter table public.stripe_events enable row level security;

create policy billing_customers_select on public.billing_customers for select to authenticated
using (user_id = (select auth.uid()));

create policy subscriptions_select on public.subscriptions for select to authenticated
using (user_id = (select auth.uid()));

create policy usage_counters_select on public.usage_counters for select to authenticated
using (user_id = (select auth.uid()));

-- Owners manage their studio; members may see the studio they belong to.
create policy studios_select on public.studios for select to authenticated
using (
    owner_id = (select auth.uid())
    or exists (
        select 1
        from public.studio_members sm
        where sm.studio_id = id and sm.user_id = (select auth.uid())
    )
);

create policy studios_insert on public.studios for insert to authenticated
with check (owner_id = (select auth.uid()));

create policy studios_update on public.studios for update to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy studio_members_select on public.studio_members for select to authenticated
using (
    user_id = (select auth.uid())
    or exists (
        select 1
        from public.studios st
        where st.id = studio_id and st.owner_id = (select auth.uid())
    )
);

-- ---------------------------------------------------------------------------
-- Privilege hardening (same convention as edge_rate_rls_and_revoke_execute)
-- ---------------------------------------------------------------------------
revoke all on table public.billing_customers from public;
revoke all on table public.billing_customers from anon;
revoke all on table public.billing_customers from authenticated;
grant select on table public.billing_customers to authenticated;

revoke all on table public.subscriptions from public;
revoke all on table public.subscriptions from anon;
revoke all on table public.subscriptions from authenticated;
grant select on table public.subscriptions to authenticated;

revoke all on table public.usage_counters from public;
revoke all on table public.usage_counters from anon;
revoke all on table public.usage_counters from authenticated;
grant select on table public.usage_counters to authenticated;

revoke all on table public.stripe_events from public;
revoke all on table public.stripe_events from anon;
revoke all on table public.stripe_events from authenticated;

revoke all on table public.studios from public;
revoke all on table public.studios from anon;
revoke all on table public.studios from authenticated;
grant select, insert, update on table public.studios to authenticated;

revoke all on table public.studio_members from public;
revoke all on table public.studio_members from anon;
revoke all on table public.studio_members from authenticated;
grant select on table public.studio_members to authenticated;

-- Trigger-only functions: never callable via /rest/v1/rpc.
revoke all on function public.documents_enforce_score_cap () from public;
revoke all on function public.documents_enforce_score_cap () from anon;
revoke all on function public.documents_enforce_score_cap () from authenticated;

revoke all on function public.studios_enforce_seat_limit () from public;
revoke all on function public.studios_enforce_seat_limit () from anon;
revoke all on function public.studios_enforce_seat_limit () from authenticated;

-- Service-only RPCs: metering and lapse handling are Edge Function concerns.
revoke all on function public.consume_quota (uuid, text, int) from public;
revoke all on function public.consume_quota (uuid, text, int) from anon;
revoke all on function public.consume_quota (uuid, text, int) from authenticated;
grant execute on function public.consume_quota (uuid, text, int) to service_role;

revoke all on function public.release_quota (uuid, text) from public;
revoke all on function public.release_quota (uuid, text) from anon;
revoke all on function public.release_quota (uuid, text) from authenticated;
grant execute on function public.release_quota (uuid, text) to service_role;

revoke all on function public.apply_free_tier_archival (uuid) from public;
revoke all on function public.apply_free_tier_archival (uuid) from anon;
revoke all on function public.apply_free_tier_archival (uuid) from authenticated;
grant execute on function public.apply_free_tier_archival (uuid) to service_role;

-- Client RPCs: revoke PUBLIC/anon, keep authenticated.
revoke all on function public.get_entitlements (uuid) from public;
revoke all on function public.get_entitlements (uuid) from anon;
grant execute on function public.get_entitlements (uuid) to authenticated;
grant execute on function public.get_entitlements (uuid) to service_role;

revoke all on function public.tier_limits (text) from public;
revoke all on function public.tier_limits (text) from anon;
grant execute on function public.tier_limits (text) to authenticated;

revoke all on function public.document_is_archived (uuid) from public;
revoke all on function public.document_is_archived (uuid) from anon;
grant execute on function public.document_is_archived (uuid) to authenticated;

revoke all on function public.studio_invite_member (uuid, text) from public;
revoke all on function public.studio_invite_member (uuid, text) from anon;
grant execute on function public.studio_invite_member (uuid, text) to authenticated;

revoke all on function public.studio_remove_member (uuid, uuid) from public;
revoke all on function public.studio_remove_member (uuid, uuid) from anon;
grant execute on function public.studio_remove_member (uuid, uuid) to authenticated;

revoke all on function public.studio_roster (uuid) from public;
revoke all on function public.studio_roster (uuid) from anon;
grant execute on function public.studio_roster (uuid) to authenticated;
