-- Isolate works-mirror refreshes the way imslp_category_members generations
-- used to: building ticks write imslp_works_building; readers only see
-- imslp_works. Promote+prune is one transaction after the walk completes, so
-- imslp_index_ready (active_generation > 0) never serves a half-refreshed
-- category. Membership from other completed anchors is unioned, not replaced.
--
-- imslp_browse is restored as a wrapper over imslp_browse_works so a live
-- `dev` edge that still RPCs the old name does not 404 after this lands.

create table public.imslp_works_building (
    page_id int not null,
    generation int not null,
    anchor text not null,
    page_title text not null,
    composer text,
    categories text[] not null default '{}'::text[],
    touched timestamptz,
    seen_at timestamptz not null default now(),
    primary key (page_id, generation, anchor)
);

create index imslp_works_building_anchor_gen
    on public.imslp_works_building (anchor, generation);

alter table public.imslp_works_building enable row level security;

revoke all on table public.imslp_works from public, anon, authenticated;
revoke all on table public.imslp_works_building from public, anon, authenticated;
grant all on table public.imslp_works to service_role;
grant all on table public.imslp_works_building to service_role;

drop function if exists public.imslp_prune_anchor (text, timestamptz);
drop function if exists public.imslp_browse_works (jsonb, text, int, int, text[]);
drop function if exists public.imslp_browse_works (jsonb, text, int, int, text[], text[]);
drop function if exists public.imslp_browse (jsonb, text, int, int, text[], text[]);
drop function if exists public.imslp_browse (jsonb, text, int, int);

-- Browse live snapshot only. title_filters keeps the old `dev` key-chip
-- contract (any-of case-insensitive regex) for the compatibility wrapper.
create or replace function public.imslp_browse_works (
    groups jsonb,
    sort text,
    lim int,
    off int,
    popular_titles text[] default '{}'::text[],
    title_filters text[] default '{}'::text[]
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
            greatest(coalesce(off, 0), 0) as page_off,
            coalesce(popular_titles, '{}'::text[]) as popular,
            coalesce(title_filters, '{}'::text[]) as filters
    ),
    group_arrays as (
        select array_agg(cat.value) as cats
        from jsonb_array_elements(coalesce(groups, '[]'::jsonb)) with ordinality as g (value, ordinality)
        cross join lateral jsonb_array_elements_text(g.value) as cat (value)
        where jsonb_typeof(g.value) = 'array'
        group by g.ordinality
    ),
    group_count as (
        select count(*)::int as n from group_arrays
    ),
    matched as (
        select w.page_title, w.page_id, w.touched
        from public.imslp_works w
        cross join group_count gc
        cross join bounds b
        where gc.n > 0
          and not exists (
              select 1
              from group_arrays ga
              where not (w.categories && ga.cats)
          )
          and (
              cardinality(b.filters) = 0
              or exists (
                  select 1
                  from unnest(b.filters) as f (pattern)
                  where w.page_title ~* f.pattern
              )
          )
    ),
    ordered as (
        select
            m.page_title,
            m.page_id,
            m.touched,
            count(*) over () as total,
            (m.page_title = any (b.popular)) as is_popular,
            b.sort_key
        from matched m
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
        case when b.sort_key = 'relevance' then o.is_popular end desc,
        case when b.sort_key = 'relevance' then char_length(o.page_title) end asc,
        o.page_title asc
    limit (select page_lim from bounds)
    offset (select page_off from bounds);
$$;

create or replace function public.imslp_browse (
    groups jsonb,
    sort text,
    lim int,
    off int,
    title_filters text[] default '{}'::text[],
    popular_titles text[] default '{}'::text[]
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
    select *
    from public.imslp_browse_works (groups, sort, lim, off, popular_titles, title_filters);
$$;

-- Live snapshot only. Building rows are invisible until promote.
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
    select w.page_title, c.category
    from public.imslp_works w
    cross join lateral unnest(w.categories) as c (category)
    where w.page_title = any (coalesce(titles, '{}'::text[]))
      and c.category = any (coalesce(categories, '{}'::text[]));
$$;

-- Atomic rollover: union this walk into the live snapshot, drop the walked
-- anchor from live pages this generation did not see, then drop the building
-- rows. seen_at of some other anchor cannot keep a stale membership.
create or replace function public.imslp_promote_anchor (
    anchor text,
    generation int
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    pruned int;
begin
    if anchor is null or generation is null or generation <= 0 then
        return 0;
    end if;

    insert into public.imslp_works as live (page_id, page_title, composer, categories, touched, seen_at)
    select b.page_id, b.page_title, b.composer, b.categories, b.touched, b.seen_at
    from public.imslp_works_building b
    where b.anchor = imslp_promote_anchor.anchor
      and b.generation = imslp_promote_anchor.generation
    on conflict (page_id) do update set
        page_title = excluded.page_title,
        composer = coalesce(excluded.composer, live.composer),
        categories = (
            select coalesce(array_agg(x.cat), '{}'::text[])
            from (
                select distinct c.cat
                from unnest(live.categories || excluded.categories) as c (cat)
                where c.cat is not null and c.cat <> ''
            ) x
        ),
        touched = coalesce(excluded.touched, live.touched),
        seen_at = excluded.seen_at;

    update public.imslp_works w
    set categories = array_remove(w.categories, imslp_promote_anchor.anchor)
    where imslp_promote_anchor.anchor = any (w.categories)
      and not exists (
          select 1
          from public.imslp_works_building b
          where b.anchor = imslp_promote_anchor.anchor
            and b.generation = imslp_promote_anchor.generation
            and b.page_id = w.page_id
      );
    get diagnostics pruned = row_count;

    delete from public.imslp_works where cardinality(categories) = 0;

    delete from public.imslp_works_building
    where imslp_works_building.anchor = imslp_promote_anchor.anchor
      and imslp_works_building.generation <= imslp_promote_anchor.generation;

    return pruned;
end;
$$;

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
        timeout_milliseconds := 120000
    );
end;
$$;

revoke all on function public.imslp_browse_works (jsonb, text, int, int, text[], text[]) from public, anon, authenticated;
grant execute on function public.imslp_browse_works (jsonb, text, int, int, text[], text[]) to service_role;

revoke all on function public.imslp_browse (jsonb, text, int, int, text[], text[]) from public, anon, authenticated;
grant execute on function public.imslp_browse (jsonb, text, int, int, text[], text[]) to service_role;

revoke all on function public.imslp_titles_in_categories (text[], text[]) from public, anon, authenticated;
grant execute on function public.imslp_titles_in_categories (text[], text[]) to service_role;

revoke all on function public.imslp_promote_anchor (text, int) from public, anon, authenticated;
grant execute on function public.imslp_promote_anchor (text, int) to service_role;

revoke all on function public.imslp_sync_tick () from public, anon, authenticated;
grant execute on function public.imslp_sync_tick () to service_role;
