-- Per-user library tags (labels). Personal organization — not shared across
-- document collaborators, same rationale as document_favorites.

create table public.library_tags (
    id uuid primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    name text not null,
    created_at timestamptz not null default now(),
    constraint library_tags_name_nonempty check (length(trim(name)) > 0)
);

create unique index library_tags_user_name_lower on public.library_tags (user_id, lower(name));
create index library_tags_user on public.library_tags (user_id);

create table public.document_tags (
    document_id uuid not null references public.documents (id) on delete cascade,
    tag_id uuid not null references public.library_tags (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (document_id, tag_id)
);

create index document_tags_tag on public.document_tags (tag_id);

alter table public.library_tags enable row level security;
alter table public.document_tags enable row level security;

create policy library_tags_select on public.library_tags for select to authenticated
using (user_id = (select auth.uid()));

create policy library_tags_insert on public.library_tags for insert to authenticated
with check (user_id = (select auth.uid()));

create policy library_tags_update on public.library_tags for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy library_tags_delete on public.library_tags for delete to authenticated
using (user_id = (select auth.uid()));

create policy document_tags_select on public.document_tags for select to authenticated
using (
    exists (
        select 1
        from public.library_tags t
        where t.id = tag_id
          and t.user_id = (select auth.uid())
    )
);

create policy document_tags_insert on public.document_tags for insert to authenticated
with check (
    exists (
        select 1
        from public.library_tags t
        where t.id = tag_id
          and t.user_id = (select auth.uid())
    )
    and public.document_role (document_id) is not null
);

create policy document_tags_delete on public.document_tags for delete to authenticated
using (
    exists (
        select 1
        from public.library_tags t
        where t.id = tag_id
          and t.user_id = (select auth.uid())
    )
);
