-- Shared, immutable IMSLP originals in the existing private scores bucket.
-- The reserved UUID folder keeps existing Storage policies' UUID casts safe.
-- Ready entries contain only server-verified public/CC repertoire + provenance.
create table if not exists public.imslp_pdf_cache (
    imslp_file_id text primary key check (char_length(imslp_file_id) between 1 and 600),
    filename text not null,
    sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
    storage_path text not null,
    size bigint not null check (size between 1 and 52428800),
    fetched_at timestamptz not null default now(),
    work_title text not null check (work_title <> ''),
    license_label text,
    provenance jsonb not null check (jsonb_typeof(provenance) = 'object'),
    check (storage_path = '00000000-0000-0000-0000-000000000000/' || sha256 || '.pdf')
);
create index if not exists imslp_pdf_cache_storage_path on public.imslp_pdf_cache (storage_path);

create table if not exists public.imslp_pdf_claims (
    imslp_file_id text primary key check (char_length(imslp_file_id) between 1 and 600),
    token uuid not null,
    expires_at timestamptz not null
);
alter table public.imslp_pdf_cache enable row level security;
alter table public.imslp_pdf_claims enable row level security;
revoke all on public.imslp_pdf_cache, public.imslp_pdf_claims from public, anon, authenticated;
grant all on public.imslp_pdf_cache, public.imslp_pdf_claims to service_role;

-- Unique-row arbitration works across Edge isolates. A crashed worker's lease
-- expires after four minutes (longer than the bounded upstream download).
create or replace function public.claim_imslp_pdf(p_file_id text, p_token uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
    insert into public.imslp_pdf_claims (imslp_file_id, token, expires_at)
    values (p_file_id, p_token, clock_timestamp() + interval '4 minutes')
    on conflict (imslp_file_id) do update
        set token = excluded.token, expires_at = excluded.expires_at
        where public.imslp_pdf_claims.expires_at <= clock_timestamp();
    return found;
end;
$$;

create or replace function public.release_imslp_pdf(p_file_id text, p_token uuid) returns void
language sql security definer set search_path = public as $$
    delete from public.imslp_pdf_claims where imslp_file_id = p_file_id and token = p_token;
$$;

-- A failed upload never publishes a mapping. An expired/stolen lease cannot
-- publish or delete its successor's work. Existing ready mappings are immutable.
create or replace function public.publish_imslp_pdf(p_entry jsonb, p_token uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
    v_entry public.imslp_pdf_cache;
begin
    select * into v_entry from jsonb_populate_record(null::public.imslp_pdf_cache, p_entry);
    perform 1 from public.imslp_pdf_claims
    where imslp_file_id = v_entry.imslp_file_id and token = p_token
      and expires_at > clock_timestamp() for update;
    if not found then
        raise exception 'Shared PDF lease expired' using errcode = '40001';
    end if;
    if not exists (
        select 1 from storage.objects o where o.bucket_id = 'scores'
        and o.name = v_entry.storage_path
        and public.storage_object_size(o.metadata) = v_entry.size
        and o.metadata ->> 'mimetype' = 'application/pdf'
    ) then
        raise exception 'Shared PDF upload is incomplete' using errcode = '22023';
    end if;
    insert into public.imslp_pdf_cache select v_entry.* on conflict (imslp_file_id) do nothing;
end;
$$;
revoke all on function public.claim_imslp_pdf(text, uuid), public.release_imslp_pdf(text, uuid),
    public.publish_imslp_pdf(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.claim_imslp_pdf(text, uuid), public.release_imslp_pdf(text, uuid),
    public.publish_imslp_pdf(jsonb, uuid) to service_role;

-- Only published originals are shared. These policies grant no access to
-- documents, annotations, uploads, thumbnails or private replacement PDFs.
create or replace function public.is_shared_imslp_pdf(p_path text) returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.imslp_pdf_cache where storage_path = p_path);
$$;
revoke all on function public.is_shared_imslp_pdf(text) from public, anon;
grant execute on function public.is_shared_imslp_pdf(text) to authenticated, service_role;
drop policy if exists scores_shared_imslp_read on storage.objects;
create policy scores_shared_imslp_read on storage.objects for select to authenticated
using (bucket_id = 'scores' and public.is_shared_imslp_pdf(name));
-- Defense in depth: even a future permissive owner policy cannot mutate cache objects.
drop policy if exists scores_shared_imslp_delete on storage.objects;
create policy scores_shared_imslp_delete on storage.objects as restrictive for delete to authenticated
using (bucket_id <> 'scores' or name not like '00000000-0000-0000-0000-000000000000/%');
drop policy if exists scores_shared_imslp_update on storage.objects;
create policy scores_shared_imslp_update on storage.objects as restrictive for update to authenticated
using (bucket_id <> 'scores' or name not like '00000000-0000-0000-0000-000000000000/%')
with check (bucket_id <> 'scores' or name not like '00000000-0000-0000-0000-000000000000/%');

alter table public.documents drop constraint if exists documents_storage_path_derived;
alter table public.documents add constraint documents_storage_path_derived check (
    storage_path = id::text || '/original.pdf'
    or storage_path ~ '^00000000-0000-0000-0000-000000000000/[a-f0-9]{64}\.pdf$'
);
alter table public.documents drop constraint if exists documents_cache_folder_reserved;
alter table public.documents add constraint documents_cache_folder_reserved
    check (id <> '00000000-0000-0000-0000-000000000000'::uuid);
-- The existing guard still prohibits client path updates. Only the import
-- service may insert a shared reference; the replacement RPC below detaches it.
drop policy if exists documents_shared_imslp_insert on public.documents;
create policy documents_shared_imslp_insert on public.documents as restrictive for insert to authenticated
with check (storage_path not like '00000000-0000-0000-0000-000000000000/%');

-- Replacing an original is copy-on-write: clients upload to their own folder
-- first; this owner-only RPC switches the reference and bumps the revision.
create or replace function public.detach_imslp_pdf(p_document_id uuid, p_content_rev int)
returns public.documents language plpgsql security definer set search_path = public as $$
declare v_doc public.documents;
begin
    -- Deletion barrier before the document row lock, matching deletion's lock order.
    if auth.uid() is null or public.account_deletion_pending(auth.uid()) then
        raise exception 'This account cannot replace PDFs' using errcode = '42501';
    end if;
    select * into v_doc from public.documents where id = p_document_id for update;
    if not found or v_doc.owner_id is distinct from auth.uid()
       or public.caller_seat_read_only() or v_doc.archived_at is not null then
        raise exception 'Only an active score owner can replace its PDF' using errcode = '42501';
    end if;
    if p_content_rev is null or v_doc.content_rev <> p_content_rev
       or not public.is_shared_imslp_pdf(v_doc.storage_path) then
        raise exception 'Score changed before replacement' using errcode = '40001';
    end if;
    if not exists (select 1 from storage.objects where bucket_id = 'scores'
        and name = p_document_id::text || '/original.pdf') then
        raise exception 'Replacement PDF is missing' using errcode = '22023';
    end if;
    update public.documents set storage_path = p_document_id::text || '/original.pdf',
        content_rev = content_rev + 1 where id = p_document_id returning * into v_doc;
    return v_doc;
end;
$$;
revoke all on function public.detach_imslp_pdf(uuid, int) from public, anon;
grant execute on function public.detach_imslp_pdf(uuid, int) to authenticated;
