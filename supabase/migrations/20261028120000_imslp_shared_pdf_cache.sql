-- Shared, immutable IMSLP originals in the existing private scores bucket.
-- The reserved UUID folder keeps existing Storage policies' UUID casts safe.
-- Ready entries contain only server-verified public/CC repertoire + provenance.
-- Shared originals are platform storage: they do not count against an individual
-- library's byte quota. Import credits and cloud-score caps still apply.
-- No hosted migration has been applied; keep this file and the replay in sync.
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
-- Keep replays safe even when the original draft of this migration ran locally.
alter table public.imslp_pdf_cache add column if not exists blocked_at timestamptz;
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
    -- The same bytes under another IMSLP edition id cannot bypass a block.
    if exists (select 1 from public.imslp_pdf_cache
        where storage_path = v_entry.storage_path and blocked_at is not null) then
        raise exception 'Shared PDF is blocked' using errcode = '42501';
    end if;
    insert into public.imslp_pdf_cache select v_entry.* on conflict (imslp_file_id) do nothing;
end;
$$;
revoke all on function public.claim_imslp_pdf(text, uuid), public.release_imslp_pdf(text, uuid),
    public.publish_imslp_pdf(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.claim_imslp_pdf(text, uuid), public.release_imslp_pdf(text, uuid),
    public.publish_imslp_pdf(jsonb, uuid) to service_role;

-- Policy helpers live outside PostgREST's exposed schemas. Clients may evaluate
-- their own access through RLS, but cannot probe aggregate cache presence by RPC.
create schema if not exists imslp_private;
revoke all on schema imslp_private from public, anon, authenticated;
grant usage on schema imslp_private to authenticated;
create index if not exists documents_shared_imslp_path on public.documents (storage_path)
where storage_path like '00000000-0000-0000-0000-000000000000/%';

create or replace function public.is_shared_imslp_pdf(p_path text) returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.imslp_pdf_cache
        where storage_path = p_path and blocked_at is null)
      and not exists (select 1 from public.imslp_pdf_cache
        where storage_path = p_path and blocked_at is not null);
$$;
revoke all on function public.is_shared_imslp_pdf(text) from public, anon, authenticated;
grant execute on function public.is_shared_imslp_pdf(text) to service_role;

-- Known license restrictions stop existing reads. TTL revalidation belongs to
-- the import path; an existing library does not expire merely with the TTL.
create or replace function imslp_private.can_read_pdf(p_path text) returns boolean
language sql stable security definer set search_path = public as $$
    select exists (
        select 1 from public.imslp_pdf_cache c
        join public.imslp_file_licenses l on l.filename = c.filename
        where c.storage_path = p_path and c.blocked_at is null
          and l.downloadable
    ) and not exists (
        select 1 from public.imslp_pdf_cache c
        left join public.imslp_file_licenses l on l.filename = c.filename
        where c.storage_path = p_path and (c.blocked_at is not null or l.downloadable = false)
    ) and exists (
        select 1 from public.documents d where d.storage_path = p_path
          and d.storage_path like '00000000-0000-0000-0000-000000000000/%'
          and public.document_role(d.id) is not null
    );
$$;
revoke all on function imslp_private.can_read_pdf(text) from public, anon, authenticated;
grant execute on function imslp_private.can_read_pdf(text) to authenticated;
drop policy if exists scores_shared_imslp_read on storage.objects;
create policy scores_shared_imslp_read on storage.objects for select to authenticated
using (bucket_id = 'scores' and imslp_private.can_read_pdf(name));
-- Also constrain future permissive policies that might otherwise bypass this gate.
drop policy if exists scores_shared_imslp_read_guard on storage.objects;
create policy scores_shared_imslp_read_guard on storage.objects as restrictive for select to authenticated
using (bucket_id <> 'scores' or name not like '00000000-0000-0000-0000-000000000000/%'
    or imslp_private.can_read_pdf(name));

-- A copyright restriction or removal stops redistribution of these bytes in all
-- libraries, including future imports. Lifting a document takedown does not
-- automatically relicense the shared file: a service operator must clear the
-- cache block after reviewing it. The block survives document/account deletion.
create or replace function public.block_imslp_pdf(p_file_id text) returns void
language sql security definer set search_path = public as $$
    update public.imslp_pdf_cache set blocked_at = coalesce(blocked_at, now())
    where storage_path = (select storage_path from public.imslp_pdf_cache where imslp_file_id = p_file_id);
$$;
revoke all on function public.block_imslp_pdf(text) from public, anon, authenticated;
grant execute on function public.block_imslp_pdf(text) to service_role;
create or replace function imslp_private.block_taken_down_pdf() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if new.lifted_at is null and (new.action = 'remove' or new.ground = 'copyright') then
        update public.imslp_pdf_cache c set blocked_at = coalesce(c.blocked_at, now())
        from public.documents d where d.id = new.document_id and c.storage_path = d.storage_path;
    end if;
    return new;
end;
$$;
revoke all on function imslp_private.block_taken_down_pdf() from public, anon, authenticated;
drop trigger if exists content_takedowns_block_shared_pdf on public.content_takedowns;
create trigger content_takedowns_block_shared_pdf after insert or update on public.content_takedowns
for each row execute function imslp_private.block_taken_down_pdf();

-- Match the caller predicates used by documents_insert and the restrictive seat
-- policy before a claim, upstream request or permanent cache write is possible.
create or replace function public.can_import_imslp() returns boolean
language sql stable security definer set search_path = public as $$
    select auth.uid() is not null
      and not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
      and coalesce(auth.jwt() -> 'app_metadata' ->> 'user_type', '') <> 'student'
      and not public.caller_seat_read_only();
$$;
revoke all on function public.can_import_imslp() from public, anon;
grant execute on function public.can_import_imslp() to authenticated;
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
create or replace function public.commit_pdf_replacement(p_document_id uuid, p_content_rev int)
returns public.documents language plpgsql security definer set search_path = public as $$
declare v_doc public.documents;
begin
    -- Deletion barrier before the document row lock, matching deletion's lock order.
    if auth.uid() is null or public.account_deletion_pending(auth.uid()) then
        raise exception 'This account cannot replace PDFs' using errcode = '42501';
    end if;
    select * into v_doc from public.documents where id = p_document_id for update;
    if not found or v_doc.owner_id is distinct from auth.uid()
       or public.caller_seat_read_only() or v_doc.archived_at is not null
       or public.document_role(v_doc.id) is distinct from 'owner' then
        raise exception 'Only an active score owner can replace its PDF' using errcode = '42501';
    end if;
    if p_content_rev is null or v_doc.content_rev <> p_content_rev then
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
revoke all on function public.commit_pdf_replacement(uuid, int) from public, anon;
grant execute on function public.commit_pdf_replacement(uuid, int) to authenticated;

-- Compatibility for clients that already selected the old detach endpoint.
create or replace function public.detach_imslp_pdf(p_document_id uuid, p_content_rev int)
returns public.documents language sql security definer set search_path = public as $$
    select public.commit_pdf_replacement(p_document_id, p_content_rev);
$$;
revoke all on function public.detach_imslp_pdf(uuid, int) from public, anon;
grant execute on function public.detach_imslp_pdf(uuid, int) to authenticated;

-- An old client must not bump a shared row while leaving its replacement
-- unreferenced. The definer commit RPC above is the only replacement path.
create or replace function imslp_private.guard_shared_revision() returns trigger
language plpgsql set search_path = public as $$
begin
    if current_user in ('authenticated', 'anon')
       and old.storage_path like '00000000-0000-0000-0000-000000000000/%'
       and new.content_rev is distinct from old.content_rev then
        raise exception 'Use commit_pdf_replacement for shared PDFs' using errcode = '42501';
    end if;
    return new;
end;
$$;
revoke all on function imslp_private.guard_shared_revision() from public, anon, authenticated;
drop trigger if exists documents_guard_shared_revision on public.documents;
create trigger documents_guard_shared_revision before update on public.documents
for each row execute function imslp_private.guard_shared_revision();
