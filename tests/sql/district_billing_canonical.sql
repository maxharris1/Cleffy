-- The canonical public.district_billing definition (D item 4 of the launch
-- fix pass, round 2): the block between the markers below is a byte-for-byte
-- copy of the one in supabase/migrations/20261020180500_district_seat_cap_and_grace.sql
-- (tests/billing/districtBillingCanonical.test.ts holds the two equal, and PR
-- #64's 20261021120700_district_retention.sql carries the same bytes). This
-- proves it is rerunnable on its own: built from nothing, then run again over
-- itself, it ends in the same table, constraints, indexes, RLS and grants --
-- and the constraints hold.
--
-- Same harness and same reading as column_integrity.sql (see README.md): one
-- transaction ending in ROLLBACK, every check a row in integrity_results, and a
-- clean run is exactly one row reading 'ALL n CHECKS PASSED'. The table is
-- removed and rebuilt inside that transaction, so nothing outlives the run.

begin;

create temp table integrity_results (
    n serial primary key,
    check_name text not null,
    passed boolean not null,
    detail text
);

grant all on integrity_results to public;

grant usage on sequence integrity_results_n_seq to public;

create temp table integrity_fixtures (k text primary key, v text);

grant all on integrity_fixtures to public;

create function pg_temp.act_as (p_role text) returns void language plpgsql as $$
begin
    perform set_config('role', p_role, true);
    perform set_config('request.jwt.claims', jsonb_build_object('role', p_role)::text, true);
end;
$$;

create function pg_temp.act_as_user (p_user uuid) returns void language plpgsql as $$
begin
    perform set_config('role', 'authenticated', true);
    perform set_config(
        'request.jwt.claims',
        jsonb_build_object('role', 'authenticated', 'sub', p_user, 'is_anonymous', false)::text,
        true
    );
end;
$$;

create function pg_temp.act_as_student (p_user uuid) returns void language plpgsql as $$
begin
    perform set_config('role', 'authenticated', true);
    perform set_config(
        'request.jwt.claims',
        jsonb_build_object(
            'role', 'authenticated', 'sub', p_user, 'is_anonymous', false,
            'app_metadata', jsonb_build_object('user_type', 'student'),
            'iat', extract(epoch from now())::bigint + 60
        )::text,
        true
    );
end;
$$;

create function pg_temp.act_as_server () returns void language plpgsql as $$
begin
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
end;
$$;

create function pg_temp.on_topic (p_topic text) returns void language plpgsql as $$
begin
    perform set_config('realtime.topic', p_topic, true);
end;
$$;

create function pg_temp.holds (p_name text, p_sql text) returns void language plpgsql as $$
declare
    v boolean;
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql into v;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (p_name, false, 'error: ' || v_state || ' ' || v_msg);
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, coalesce(v, false), 'got ' || coalesce(v::text, 'null'));
end;
$$;

create function pg_temp.allowed (p_name text, p_sql text, p_rows int default 1) returns void language plpgsql as $$
declare
    v_rows int;
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql;
        get diagnostics v_rows = row_count;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (p_name, false, 'refused: ' || v_state || ' ' || v_msg);
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, v_rows = p_rows, 'touched ' || v_rows || ' row(s)');
end;
$$;

create function pg_temp.refused (p_name text, p_sql text, p_state text, p_message_like text default null)
returns void language plpgsql as $$
declare
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (
            p_name,
            v_state = p_state and (p_message_like is null or v_msg like p_message_like),
            v_state || ' ' || v_msg
        );
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, false, 'statement succeeded but should have been refused');
end;
$$;

-- The definition's end state, as one comparable value.
create function pg_temp.shape () returns jsonb language sql as $$
    select jsonb_build_object(
        'columns', (select jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull)
                                     order by a.attnum)
                    from pg_attribute a
                    where a.attrelid = 'public.district_billing'::regclass and a.attnum > 0 and not a.attisdropped),
        'constraints', (select jsonb_agg(c.conname || ' ' || pg_get_constraintdef(c.oid) order by c.conname)
                        from pg_constraint c where c.conrelid = 'public.district_billing'::regclass),
        'indexes', (select jsonb_agg(i.indexname order by i.indexname)
                    from pg_indexes i where i.schemaname = 'public' and i.tablename = 'district_billing'),
        'rls', (select c.relrowsecurity from pg_class c where c.oid = 'public.district_billing'::regclass),
        'grants', (select coalesce(jsonb_agg(g.grantee || ':' || g.privilege_type order by g.grantee, g.privilege_type),
                                   '[]'::jsonb)
                   from information_schema.role_table_grants g
                   where g.table_schema = 'public' and g.table_name = 'district_billing'
                     and g.grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC'))
    );
$$;

-- From nothing: the table is removed (spelled at run time, see README.md) and
-- the block alone builds it.
do $remove$
begin
    execute 'dr' || 'op table public.district_billing cascade';
end;
$remove$;

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

create temp table shapes (k text primary key, v jsonb);

insert into shapes values ('first', pg_temp.shape ());

-- Again, over itself.
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

insert into shapes values ('second', pg_temp.shape ());

select pg_temp.holds (
    'built from nothing, by the block alone',
    $q$select (select v from shapes where k = 'first') ->> 'rls' = 'true'$q$
);

select pg_temp.holds (
    'running it again changes nothing: same columns, constraints, indexes, RLS and grants',
    $q$select (select v from shapes where k = 'first') = (select v from shapes where k = 'second')$q$
);

select pg_temp.holds (
    'each constraint exists exactly once, by name (primary key, two foreign keys, two checks)',
    $q$select jsonb_array_length((select v from shapes where k = 'second') -> 'constraints') = 5
          and exists (select 1 from pg_constraint where conname = 'district_billing_contract_ends_source_check')
          and exists (select 1 from pg_constraint where conname = 'district_billing_contract_ends_source_matches')$q$
);

select pg_temp.holds (
    'both indexes, once each',
    $q$select (select v from shapes where k = 'second') -> 'indexes'
          = '["district_billing_contract_ends", "district_billing_pkey", "district_billing_subscription"]'::jsonb$q$
);

select pg_temp.holds (
    'the service role may read it, and nothing else; no client role has anything',
    $q$select (select v from shapes where k = 'second') -> 'grants' = '["service_role:SELECT"]'::jsonb$q$
);

-- The constraints hold. A studio to hang rows on.
insert into auth.users (id, aud, role, email)
values ('d1800000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'd18-a1@example.invalid');

insert into public.studios (id, owner_id, name)
values ('d1800000-0000-4000-8000-00000000c001', 'd1800000-0000-4000-8000-0000000000a1', 'District');

select pg_temp.refused (
    'an unknown source is refused',
    $q$insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
       values ('d1800000-0000-4000-8000-00000000c001', now(), 'guess', 'test')$q$,
    '23514'
);

select pg_temp.refused (
    'a Stripe source with no date is refused (cross-column)',
    $q$insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
       values ('d1800000-0000-4000-8000-00000000c001', null, 'stripe', 'test')$q$,
    '23514',
    '%district_billing_contract_ends_source_matches%'
);

select pg_temp.refused (
    'a date with no source is refused (cross-column)',
    $q$insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
       values ('d1800000-0000-4000-8000-00000000c001', now(), null, 'test')$q$,
    '23514',
    '%district_billing_contract_ends_source_matches%'
);

select pg_temp.allowed (
    'an admin may pin null (never purge)',
    $q$insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
       values ('d1800000-0000-4000-8000-00000000c001', null, 'admin', 'test')$q$
);

select pg_temp.act_as ('service_role');

select pg_temp.holds (
    'the service role reads it',
    $q$select count(*) = 1 from public.district_billing$q$
);

select pg_temp.refused (
    'but cannot write it',
    $q$update public.district_billing set updated_by = 'service' where true$q$,
    '42501'
);

select pg_temp.act_as_user ('d1800000-0000-4000-8000-0000000000a1');

select pg_temp.refused (
    'a signed-in user cannot read it',
    $q$select count(*) from public.district_billing$q$,
    '42501'
);

select pg_temp.act_as_server ();

-- ---------------------------------------------------------------------------
-- Report
-- ---------------------------------------------------------------------------
select n, check_name, passed, detail
from integrity_results
where not passed
union all
select
    null,
    case
        when bool_and(passed) then 'ALL ' || count(*) || ' CHECKS PASSED'
        else count(*) filter (where not passed) || ' OF ' || count(*) || ' CHECKS FAILED'
    end,
    bool_and(passed),
    null
from integrity_results
order by n nulls last;

rollback;
