-- Cached IMSLP category membership for Walker-style chip browse.
-- Filled by imslp-category-sync (paged categorymembers); read by imslp-search
-- via imslp_intersect_categories. Until a snapshot is `ok`, search bootstraps
-- from the curated Popular list plus a small extras set.

create table public.imslp_category_members (
    category text not null,
    page_title text not null,
    page_id bigint,
    last_seen_at timestamptz not null default now(),
    primary key (category, page_title)
);

create index imslp_category_members_title_idx on public.imslp_category_members (page_title);

create table public.imslp_category_snapshots (
    category text primary key,
    status text not null check (status in ('ok', 'partial', 'error')),
    member_count integer not null default 0,
    resume_token text,
    synced_at timestamptz not null default now()
);

alter table public.imslp_category_members enable row level security;
alter table public.imslp_category_snapshots enable row level security;

revoke all on table public.imslp_category_members from public;
revoke all on table public.imslp_category_members from anon;
revoke all on table public.imslp_category_members from authenticated;
revoke all on table public.imslp_category_snapshots from public;
revoke all on table public.imslp_category_snapshots from anon;
revoke all on table public.imslp_category_snapshots from authenticated;

grant all on table public.imslp_category_members to service_role;
grant all on table public.imslp_category_snapshots to service_role;

-- AND of OR-clauses: each jsonb array is a set of categories (instrument ∪ arr).
create or replace function public.imslp_intersect_categories (p_clauses jsonb)
    returns table (page_title text)
    language plpgsql
    stable
    set search_path = public
as $$
declare
    clause jsonb;
    first_clause boolean := true;
    sql text := '';
    cats text[];
begin
    if p_clauses is null
        or jsonb_typeof(p_clauses) <> 'array'
        or jsonb_array_length(p_clauses) = 0 then
        return;
    end if;

    for clause in select value from jsonb_array_elements(p_clauses)
    loop
        if jsonb_typeof(clause) <> 'array' or jsonb_array_length(clause) = 0 then
            return;
        end if;
        select coalesce(array_agg(value), '{}') into cats
        from jsonb_array_elements_text(clause);
        if first_clause then
            sql := format(
                'select m.page_title from public.imslp_category_members m where m.category = any (%L)',
                cats
            );
            first_clause := false;
        else
            sql := sql || format(
                ' intersect select m.page_title from public.imslp_category_members m where m.category = any (%L)',
                cats
            );
        end if;
    end loop;

    return query execute sql;
end;
$$;

revoke all on function public.imslp_intersect_categories (jsonb) from public;
revoke all on function public.imslp_intersect_categories (jsonb) from anon;
revoke all on function public.imslp_intersect_categories (jsonb) from authenticated;
grant execute on function public.imslp_intersect_categories (jsonb) to service_role;
