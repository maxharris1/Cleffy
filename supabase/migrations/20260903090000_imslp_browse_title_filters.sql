-- imslp_browse: apply key-chip title filters inside the intersection and let the
-- curated Popular list lead the relevance order.
--
-- Key has no IMSLP category, so imslp-search used to filter the returned page by
-- title after paging: Piano · C major reported total 62,947 with zero rows on the
-- first page. title_filters (case-insensitive regexes, any-of) now narrow the
-- intersection before total/limit/offset are computed. popular_titles puts the
-- curated works first under `relevance`; shortest title was the only prior.

drop function if exists public.imslp_browse (jsonb, text, int, int);

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
    with bounds as (
        select
            case
                when sort in ('title', 'recent', 'relevance') then sort
                else 'relevance'
            end as sort_key,
            least(greatest(coalesce(lim, 50), 1), 300) as page_lim,
            greatest(coalesce(off, 0), 0) as page_off,
            coalesce(title_filters, '{}'::text[]) as filters,
            coalesce(popular_titles, '{}'::text[]) as popular
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
    narrowed as (
        select i.*
        from intersected i
        cross join bounds b
        where cardinality(b.filters) = 0
           or exists (
               select 1
               from unnest(b.filters) as f (pattern)
               where i.page_title ~* f.pattern
           )
    ),
    ordered as (
        select
            n.page_title,
            n.page_id,
            n.touched,
            count(*) over () as total,
            (n.page_title = any (b.popular)) as is_popular,
            b.sort_key
        from narrowed n
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

revoke all on function public.imslp_browse (jsonb, text, int, int, text[], text[]) from public, anon, authenticated;
grant execute on function public.imslp_browse (jsonb, text, int, int, text[], text[]) to service_role;
