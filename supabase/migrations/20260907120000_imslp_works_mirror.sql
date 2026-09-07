-- IMSLP works mirror: one row per work page with the taxonomy categories it
-- belongs to, replacing the per-category membership table.
--
-- The walker (scripts/imslp-seed.ts one-shot, imslp-sync cron refresh) pages
-- each taxonomy category with generator=categorymembers + prop=categories +
-- clcategories=<every taxonomy category>, so a single pass over "For piano"
-- records each piano work's era, forms, keys and composer flags at once.
-- Chip browse is then one GIN lookup on `categories`; every walked page carries
-- its full membership, so the intersection is exact as soon as any one of the
-- selected groups has been walked completely.
--
-- imslp_category_sync keeps per-category walk state (generation rollover,
-- resumable cmcontinue). building_started_at bounds the prune that removes a
-- category from pages the latest walk did not see.
--
-- imslp_titles_in_categories keeps its signature for the typed-search hard
-- filters; imslp_index_ready and imslp_sync_tick are unchanged.

create table public.imslp_works (
    page_id int primary key,
    page_title text not null,
    composer text,
    categories text[] not null default '{}'::text[],
    touched timestamptz,
    seen_at timestamptz not null default now()
);

create index imslp_works_categories_gin on public.imslp_works using gin (categories);
create index imslp_works_page_title on public.imslp_works (page_title);

alter table public.imslp_works enable row level security;
-- Zero policies — service_role only, like imslp_category_sync.
grant all on public.imslp_works to service_role;

alter table public.imslp_category_sync add column if not exists building_started_at timestamptz;

drop function if exists public.imslp_browse (jsonb, text, int, int, text[], text[]);
drop function if exists public.imslp_browse (jsonb, text, int, int);
drop function if exists public.imslp_titles_in_categories (text[], text[]);
drop table if exists public.imslp_category_members;

-- Browse: each group is a jsonb array of categories (OR within); a work must
-- match every group (AND across). total is a window count for paging.
create or replace function public.imslp_browse_works (
    groups jsonb,
    sort text,
    lim int,
    off int,
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
    with bounds as (
        select
            case
                when sort in ('title', 'recent', 'relevance') then sort
                else 'relevance'
            end as sort_key,
            least(greatest(coalesce(lim, 50), 1), 300) as page_lim,
            greatest(coalesce(off, 0), 0) as page_off,
            coalesce(popular_titles, '{}'::text[]) as popular
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
        where gc.n > 0
          and not exists (
              select 1
              from group_arrays ga
              where not (w.categories && ga.cats)
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

-- Membership lookup for typed-search hard filters — same signature as before,
-- now answered from the mirror.
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

-- After a category's walk completes, pages the walk did not touch are no
-- longer members: drop the category from them, and drop pages left with no
-- taxonomy membership at all.
create or replace function public.imslp_prune_anchor (
    anchor text,
    before timestamptz
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    pruned int;
begin
    if anchor is null or before is null then
        return 0;
    end if;
    update public.imslp_works
    set categories = array_remove(categories, anchor)
    where anchor = any (categories)
      and seen_at < before;
    get diagnostics pruned = row_count;
    delete from public.imslp_works where cardinality(categories) = 0;
    return pruned;
end;
$$;

revoke all on function public.imslp_browse_works (jsonb, text, int, int, text[]) from public, anon, authenticated;
grant execute on function public.imslp_browse_works (jsonb, text, int, int, text[]) to service_role;

revoke all on function public.imslp_titles_in_categories (text[], text[]) from public, anon, authenticated;
grant execute on function public.imslp_titles_in_categories (text[], text[]) to service_role;

revoke all on function public.imslp_prune_anchor (text, timestamptz) from public, anon, authenticated;
grant execute on function public.imslp_prune_anchor (text, timestamptz) to service_role;
