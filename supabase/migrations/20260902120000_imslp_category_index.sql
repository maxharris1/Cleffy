-- IMSLP category membership index: cached Category Walker intersections.
-- Filled by the imslp-sync edge function (resumable categorymembers pager);
-- read by imslp-search via imslp_browse / imslp_index_ready /
-- imslp_titles_in_categories. Snapshots roll over by generation so a
-- mid-category failure leaves the previous ok generation live.
--
-- Vault secrets imslp_sync_url + imslp_sync_secret must be created
-- out-of-band (see SETUP_SUPABASE.md). If missing, the cron tick is a no-op.
--
-- Supersedes 20260831090000 (imslp_category_snapshots + imslp_intersect_categories).

drop function if exists public.imslp_intersect_categories (jsonb);
drop table if exists public.imslp_category_snapshots;
drop table if exists public.imslp_category_members;
drop table if exists public.imslp_category_sync;

create table public.imslp_category_members (
    category text not null,
    page_title text not null,
    page_id int not null,
    sort_key text,
    touched timestamptz,
    generation int not null,
    primary key (category, generation, page_title)
);

create index imslp_category_members_cat_gen_title
    on public.imslp_category_members (category, generation, page_title);

create index imslp_category_members_cat_gen_touched
    on public.imslp_category_members (category, generation, touched desc);

alter table public.imslp_category_members enable row level security;
-- Zero policies — service_role only, like imslp_file_licenses.
grant all on public.imslp_category_members to service_role;

create table public.imslp_category_sync (
    category text primary key,
    state text not null default 'never'
        check (state in ('never', 'building', 'ok', 'failed')),
    active_generation int not null default 0,
    building_generation int not null default 0,
    cmcontinue text,
    pages_done int not null default 0,
    last_error text,
    completed_at timestamptz,
    updated_at timestamptz not null default now()
);

alter table public.imslp_category_sync enable row level security;
grant all on public.imslp_category_sync to service_role;

-- Browse: each group is a UNION of its categories at that category's
-- active_generation; groups are INTERSECTed. total is a window count so
-- the caller can page and show a status line.
create or replace function public.imslp_browse (
    groups jsonb,
    sort text,
    lim int,
    off int
)
returns table (
    page_title text,
    page_id int,
    touched timestamptz,
    total bigint
)
language sql
stable
security definer
set search_path = public
as $$
    with bounds as (
        select
            case
                when sort in ('title', 'recent', 'relevance') then sort
                else 'relevance'
            end as sort_key,
            least(greatest(coalesce(lim, 50), 1), 300) as page_lim,
            greatest(coalesce(off, 0), 0) as page_off
    ),
    group_cats as (
        select
            g.ordinality::int as group_idx,
            cat.value as category
        from jsonb_array_elements(coalesce(groups, '[]'::jsonb)) with ordinality as g (value, ordinality)
        cross join lateral jsonb_array_elements_text(g.value) as cat (value)
        where jsonb_typeof(g.value) = 'array'
    ),
    group_count as (
        select count(distinct group_idx)::int as n from group_cats
    ),
    members as (
        select
            gc.group_idx,
            m.page_title,
            m.page_id,
            m.touched
        from group_cats gc
        join public.imslp_category_sync s
            on s.category = gc.category
        join public.imslp_category_members m
            on m.category = gc.category
            and m.generation = s.active_generation
        where s.active_generation > 0
    ),
    per_group as (
        select distinct group_idx, page_title, page_id, touched
        from members
    ),
    intersected as (
        select
            pg.page_title,
            min(pg.page_id) as page_id,
            max(pg.touched) as touched
        from per_group pg
        cross join group_count gc
        where gc.n > 0
        group by pg.page_title, gc.n
        having count(distinct pg.group_idx) = gc.n
    ),
    ordered as (
        select
            i.page_title,
            i.page_id,
            i.touched,
            count(*) over () as total,
            b.sort_key
        from intersected i
        cross join bounds b
    )
    select
        o.page_title,
        o.page_id,
        o.touched,
        o.total
    from ordered o
    cross join bounds b
    order by
        case when b.sort_key = 'recent' then o.touched end desc nulls last,
        case when b.sort_key = 'relevance' then char_length(o.page_title) end asc,
        o.page_title asc
    limit (select page_lim from bounds)
    offset (select page_off from bounds);
$$;

-- Categories in the argument list that have no ok snapshot yet.
create or replace function public.imslp_index_ready (categories text[])
returns text[]
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(array_agg(c order by c), '{}'::text[])
    from unnest(coalesce(categories, '{}'::text[])) as c
    where not exists (
        select 1
        from public.imslp_category_sync s
        where s.category = c
          and s.state = 'ok'
          and s.active_generation > 0
    );
$$;

-- Membership lookup for typed-search hard filters (cache first).
create or replace function public.imslp_titles_in_categories (
    titles text[],
    categories text[]
)
returns table (
    page_title text,
    category text
)
language sql
stable
security definer
set search_path = public
as $$
    select m.page_title, m.category
    from public.imslp_category_members m
    join public.imslp_category_sync s
        on s.category = m.category
        and m.generation = s.active_generation
    where s.state = 'ok'
      and s.active_generation > 0
      and m.page_title = any (coalesce(titles, '{}'::text[]))
      and m.category = any (coalesce(categories, '{}'::text[]));
$$;

revoke all on function public.imslp_browse (jsonb, text, int, int) from public, anon, authenticated;
grant execute on function public.imslp_browse (jsonb, text, int, int) to service_role;

revoke all on function public.imslp_index_ready (text[]) from public, anon, authenticated;
grant execute on function public.imslp_index_ready (text[]) to service_role;

revoke all on function public.imslp_titles_in_categories (text[], text[]) from public, anon, authenticated;
grant execute on function public.imslp_titles_in_categories (text[], text[]) to service_role;

-- Hosted refresh: same pg_cron + pg_net + vault pattern as omr_sweep.
-- Extensions are already enabled by 20260806140000_omr_cron.sql.
create or replace function public.imslp_sync_tick ()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
    sync_url text;
    sync_secret text;
begin
    select decrypted_secret into sync_url
    from vault.decrypted_secrets
    where name = 'imslp_sync_url'
    limit 1;

    select decrypted_secret into sync_secret
    from vault.decrypted_secrets
    where name = 'imslp_sync_secret'
    limit 1;

    if sync_url is null or sync_secret is null or length(trim(sync_url)) = 0 then
        raise notice 'imslp_sync_tick: vault secrets imslp_sync_url/imslp_sync_secret missing — skip';
        return;
    end if;

    perform net.http_post(
        url := rtrim(sync_url, '/'),
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-imslp-sync-secret', sync_secret
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 5000
    );
end;
$$;

revoke all on function public.imslp_sync_tick () from public, anon, authenticated;
grant execute on function public.imslp_sync_tick () to service_role;

do $$
begin
    perform cron.unschedule (jobid)
    from cron.job
    where jobname = 'imslp-sync';
exception
    when undefined_table then null;
    when others then null;
end;
$$;

select cron.schedule ('imslp-sync', '*/2 * * * *', $$select public.imslp_sync_tick ()$$);
