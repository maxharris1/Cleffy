-- A category is ready while it has a live snapshot (active_generation > 0),
-- whatever its sync state. imslp_index_ready and imslp_titles_in_categories
-- required state = 'ok', so during every refresh tick the category being
-- rebuilt (For piano first, ~3 minutes) read as missing: chips fell back to
-- "Index still building" and typed search to live MediaWiki category checks,
-- even though generation-based rollover keeps the previous snapshot serving.
-- imslp_browse already reads active_generation only.

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
          and s.active_generation > 0
    );
$$;

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
    where s.active_generation > 0
      and m.page_title = any (coalesce(titles, '{}'::text[]))
      and m.category = any (coalesce(categories, '{}'::text[]));
$$;
