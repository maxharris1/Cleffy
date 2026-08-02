-- Smart import: adopt pre-existing handwritten annotations as native marks.
--
-- content_rev: documents' PDF bytes were immutable until now. The import
-- flow can replace the stored file with a cleaned copy; content_rev lets
-- clients detect a stale Dexie pdfCache (cache stores the rev it holds).
alter table public.documents
add column content_rev int not null default 0;

-- One row per document tracking the import offer/decision, so a declined
-- prompt never nags again across devices, and the backup object is findable.
create table public.document_imports (
    document_id uuid primary key references public.documents (id) on delete cascade,
    status text not null check (status in ('prompted', 'declined', 'imported')),
    backup_path text, -- '{id}/pre-import-original.pdf' once a clean+replace ran
    pages_cleaned int[] not null default '{}',
    created_by uuid references auth.users (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- Fan the replacement out to open viewers on the existing per-doc topic
-- (same mechanism as annotations_broadcast). Gated on content_rev so
-- renames/page-count patches don't generate realtime traffic.
create or replace function public.broadcast_document_changes () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    perform realtime.broadcast_changes(
        'doc:' || new.id::text, -- topic
        tg_op, tg_op, tg_table_name, tg_table_schema, new, old
    );
    return null;
end;
$$;

create trigger documents_broadcast
after update on public.documents for each row
when (old.content_rev is distinct from new.content_rev)
execute function public.broadcast_document_changes ();

alter table public.document_imports enable row level security;

create policy document_imports_select on public.document_imports for select to authenticated
using (public.document_role (document_id) is not null);

create policy document_imports_insert on public.document_imports for insert to authenticated
with check (public.document_role (document_id) = 'owner');

create policy document_imports_update on public.document_imports for update to authenticated
using (public.document_role (document_id) = 'owner')
with check (public.document_role (document_id) = 'owner');
