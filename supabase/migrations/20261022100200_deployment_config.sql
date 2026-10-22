-- Which Stripe account's subscriptions entitle, read from configuration rather
-- than from a function body (launch re-audit BL-2).
--
-- 20260828180000_billing_stripe_mode.sql ships entitling_billing_modes() as
-- array['live', 'test'], and production's narrowing to array['live'] was a
-- hand-applied `create or replace` (DEPLOY.md §0 / R1) that exists in no
-- migration. So a fresh replay onto a wiped production -- the release plan --
-- comes back entitling test-mode subscriptions, and Stripe's published test
-- card buys a real plan until someone remembers to narrow it again; and any
-- later migration that redefined the function would quietly undo the narrowing
-- the same way.
--
-- The narrowing now lives in data: a service-role-only singleton,
-- public.deployment_config, whose entitling_billing_modes column the function
-- reads. Unset (no row, or a null column) keeps today's answer, {live,test},
-- which is right for every database but production. Production's step, run
-- once against jibgwgosihadbjgxdsfe after the replay (P6 documents it):
--
--   insert into public.deployment_config (id, entitling_billing_modes, updated_by)
--   values (true, array['live'], 'Max')
--   on conflict (id) do update
--   set entitling_billing_modes = excluded.entitling_billing_modes,
--       updated_by = excluded.updated_by,
--       updated_at = now();
--
-- Applied in place over a database whose function body was narrowed by hand,
-- this migration carries that narrowing into the table before it replaces the
-- body (the DO block below), so applying it to today's production keeps
-- test-mode subscriptions out rather than letting them back in.
--
-- The function goes from IMMUTABLE to STABLE: its answer now depends on a
-- table, and an immutable function may be folded into a cached plan and keep
-- answering what the row said when the plan was made. Nothing indexes on it,
-- no constraint, generated column or policy calls it (checked against the
-- local stack on 2026-10-22 through pg_depend, pg_index, pg_constraint and
-- pg_policy; tests/sql/deployment_config.sql checks again), and every caller
-- -- subscription_is_live(), resolve_entitlements(), the seat-override
-- functions -- is itself STABLE or VOLATILE, so nothing that calls it has to
-- change. SECURITY DEFINER so an invoker-rights caller (subscription_is_live()
-- is one) can read the row without any client being granted the table.
--
-- Rerunnable: the table and its constraint are guarded, the function is
-- replaced, and the carry-over only acts while no row exists.

create table if not exists public.deployment_config (
    -- One row: the key can only be true.
    id boolean primary key default true check (id),
    entitling_billing_modes text[],
    updated_at timestamptz not null default now(),
    updated_by text not null default 'unknown'
);

alter table public.deployment_config drop constraint if exists deployment_config_entitling_billing_modes_check;

-- Null means unset. An empty list would entitle nobody, which no deployment
-- wants, and anything but the two account names would match no subscription.
alter table public.deployment_config
add constraint deployment_config_entitling_billing_modes_check check (
    entitling_billing_modes is null
    or (
        cardinality(entitling_billing_modes) > 0
        and entitling_billing_modes <@ array['live', 'test']::text[]
        and array_position(entitling_billing_modes, null) is null
    )
);

alter table public.deployment_config enable row level security;

revoke all on table public.deployment_config from public, anon, authenticated;
grant all on table public.deployment_config to service_role;

-- A body narrowed by hand (production) is carried into the table before the
-- body is replaced. Only while no row exists: once one does, the row is the
-- configuration and this migration's rerun must not overwrite it.
do $$
declare
    v_modes text[];
begin
    if exists (select 1 from public.deployment_config) then
        return;
    end if;
    if to_regprocedure('public.entitling_billing_modes()') is null then
        return;
    end if;
    execute 'select public.entitling_billing_modes ()' into v_modes;
    if v_modes is distinct from array['live', 'test']::text[] then
        insert into public.deployment_config (id, entitling_billing_modes, updated_by)
        values (true, v_modes, 'migration 20261022100200 (carried from the function body)');
        raise notice 'deployment_config: carried entitling_billing_modes % from the existing function body', v_modes;
    end if;
end;
$$;

create or replace function public.entitling_billing_modes () returns text[] language sql stable security definer
set search_path = public as $$
select coalesce(
    (select c.entitling_billing_modes from public.deployment_config c where c.id),
    array['live', 'test']::text[]
)
$$;

-- The grants 20260828180000 set, unchanged.
revoke all on function public.entitling_billing_modes () from public;
revoke all on function public.entitling_billing_modes () from anon;
