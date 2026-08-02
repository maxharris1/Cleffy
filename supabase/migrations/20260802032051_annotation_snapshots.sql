-- Daily annotation starting-point snapshots (lesson history).
-- One row per (document, local calendar day). Payload is the full live
-- annotation set captured before the first edit of that day.

create table public.annotation_snapshots (
    id uuid primary key,
    document_id uuid not null references public.documents (id) on delete cascade,
    captured_on date not null,
    label text,
    payload jsonb not null,
    created_at timestamptz not null default now(),
    created_by uuid references auth.users (id) on delete set null,
    unique (document_id, captured_on)
);

create index annotation_snapshots_doc_day on public.annotation_snapshots (document_id, captured_on desc);

alter table public.annotation_snapshots enable row level security;

create policy annotation_snapshots_select on public.annotation_snapshots for select to authenticated
using (public.document_role (document_id) is not null);

create policy annotation_snapshots_insert on public.annotation_snapshots for insert to authenticated
with check (public.document_role (document_id) in ('owner', 'editor'));

-- Snapshots are immutable starting points — no update/delete policies.
