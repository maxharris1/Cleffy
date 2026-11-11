-- IMSLP works mirror: one row per work page with the taxonomy categories it
-- belongs to. The committed catalog (scripts/data/imslp-works-catalog.jsonl.gz)
-- is loaded by a later migration; this file only creates the live table.
--
-- Chip browse is one GIN lookup on `categories`. Refresh ticks write
-- imslp_works_building (next migration) and promote onto this snapshot.
-- imslp_category_members stays until the catalog migration has filled
-- imslp_works, so a failed catalog load does not wipe the old index.

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
