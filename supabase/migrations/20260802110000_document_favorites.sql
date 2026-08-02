-- Per-user favorites. A flag on documents would be shared state (a student's
-- star would flip the owner's), so favorites are their own RLS-scoped table.
create table public.document_favorites (
    document_id uuid not null references public.documents (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (document_id, user_id)
);

create index document_favorites_user on public.document_favorites (user_id);

alter table public.document_favorites enable row level security;

create policy favorites_select on public.document_favorites for select to authenticated
using (user_id = auth.uid());

create policy favorites_insert on public.document_favorites for insert to authenticated
with check (
    user_id = auth.uid()
    and public.document_role (document_id) is not null
);

create policy favorites_delete on public.document_favorites for delete to authenticated
using (user_id = auth.uid());
