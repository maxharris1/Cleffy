-- Cleffy — core schema.
-- The PDF is immutable; annotations are vector rows keyed to
-- (document, page, normalized coords). Soft deletes only (tombstones) so
-- offline clients converge; `seq` is the server-authoritative sync watermark.

create table public.documents (
    id uuid primary key, -- client-generated (storage path is derived from it pre-insert)
    owner_id uuid not null references auth.users (id) on delete cascade,
    title text not null,
    storage_path text not null, -- object path within the 'scores' bucket: '{id}/original.pdf'
    page_count int,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.document_members (
    document_id uuid not null references public.documents (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    role text not null check (role in ('owner', 'editor', 'viewer')),
    created_at timestamptz not null default now(),
    primary key (document_id, user_id)
);

create index document_members_user on public.document_members (user_id);

create table public.share_links (
    -- 22-char base64url token, generated server-side.
    token text primary key default rtrim(
        replace(replace(encode(extensions.gen_random_bytes(16), 'base64'), '+', '-'), '/', '_'),
        '='
    ),
    document_id uuid not null references public.documents (id) on delete cascade,
    role text not null check (role in ('editor', 'viewer')),
    created_by uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    expires_at timestamptz,
    revoked_at timestamptz
);

create index share_links_document on public.share_links (document_id);

-- Monotonic ordering authority for annotation writes (LWW merge + pull watermark).
create sequence public.annotations_seq;

create table public.annotations (
    id uuid primary key, -- client-generated
    document_id uuid not null references public.documents (id) on delete cascade,
    page int not null check (page >= 0),
    kind text not null check (kind in ('stroke', 'highlight', 'text')),
    color text not null,
    payload jsonb not null,
    created_by uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(), -- server-set via trigger
    deleted_at timestamptz, -- tombstone; rows are never hard-deleted
    seq bigint not null default 0 -- server-set via trigger
);

create index annotations_doc_seq on public.annotations (document_id, seq);

create index annotations_doc_page on public.annotations (document_id, page) where deleted_at is null;

-- Server stamps ordering on every write: deterministic LWW immune to client clocks.
-- SECURITY DEFINER so nextval() needs no per-role sequence grants.
create or replace function public.annotations_stamp () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    new.updated_at := now();
    new.seq := nextval('public.annotations_seq');
    return new;
end;
$$;

create trigger annotations_stamp before insert or update on public.annotations
for each row execute function public.annotations_stamp ();

-- Owner membership materializes automatically. SECURITY DEFINER: the inserting
-- user has no direct write policy on document_members (all membership writes go
-- through definer paths), so without it every document creation would fail.
create or replace function public.documents_owner_membership () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    insert into public.document_members (document_id, user_id, role)
    values (new.id, new.owner_id, 'owner')
    on conflict (document_id, user_id) do update set role = 'owner';
    return new;
end;
$$;

create trigger documents_owner_membership after insert on public.documents
for each row execute function public.documents_owner_membership ();

create or replace function public.touch_updated_at () returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

create trigger documents_touch before update on public.documents
for each row execute function public.touch_updated_at ();
