-- Delete the score first, clean its storage after.
--
-- deleteDocument() used to remove the PDF from Storage FIRST and the
-- documents row second, because every storage policy keys off
-- document_role() — membership that dies with the row (FK cascade). When the
-- row delete then failed (network drop, timeout, a trigger error) the teacher
-- was left with a score in the library whose PDF was gone: visible, shared
-- with students, and unopenable.
--
-- The safe order is the reverse — the row goes first, atomically taking the
-- score away from every member, and the bytes are cleaned up afterwards. To
-- let the former owner's own session still remove objects after the
-- membership is gone, an AFTER DELETE trigger records a tombstone, and the
-- storage policies below grant select/delete on a tombstoned folder to the
-- user who owned it. Cleanup that fails (offline, refused) leaves the
-- tombstone in place; the client retries from it on a later library visit,
-- and the table doubles as a server-side ledger of folders still to purge.
--
-- Storage objects cannot be removed from SQL here (storage.protect_delete
-- blocks direct deletes from storage.objects; the Storage API has to delete
-- the bytes), which is why the cleanup itself stays client-driven.

create table if not exists public.document_storage_cleanup (
    document_id uuid primary key,
    -- No FK to auth.users: an account deletion cascades through documents,
    -- and this trigger runs after the users row is already gone — a foreign
    -- key here would make deleting an account fail.
    owner_id uuid not null,
    storage_path text not null,
    thumb_rev integer,
    deleted_at timestamptz not null default now()
);

create index if not exists document_storage_cleanup_owner_idx
    on public.document_storage_cleanup (owner_id);

comment on table public.document_storage_cleanup is
    'Storage folders ({document_id}/ in the scores and thumbnails buckets) of deleted scores whose bytes may still exist. '
    'The former owner''s client clears its own rows after purging; rows whose owner no longer exists in auth.users '
    '(account deletion) can only be purged by a service-role job, which should remove both folders and then the row.';

alter table public.document_storage_cleanup enable row level security;

-- Owners read their pending cleanups and delete them once done. No insert or
-- update policy: rows are written only by the trigger below, so a user cannot
-- tombstone someone else's live score to gain delete rights on its folder.
drop policy if exists document_storage_cleanup_select on public.document_storage_cleanup;
create policy document_storage_cleanup_select on public.document_storage_cleanup for select to authenticated
using (owner_id = (select auth.uid()));

drop policy if exists document_storage_cleanup_delete on public.document_storage_cleanup;
create policy document_storage_cleanup_delete on public.document_storage_cleanup for delete to authenticated
using (owner_id = (select auth.uid()));

-- Grants mirror the policies one-for-one (see 20260827140000_core_table_grants).
revoke all on table public.document_storage_cleanup from anon, authenticated;
grant select, delete on table public.document_storage_cleanup to authenticated;
grant all on table public.document_storage_cleanup to service_role;

-- ---------------------------------------------------------------------------
-- Tombstone trigger
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER: the deleting user has no insert grant on the table, by
-- design. Fires for every delete path — the library's delete, an upload or
-- IMSLP import rolling back its row, an account deletion cascading — so no
-- caller has to remember to record what it orphaned.
create or replace function public.documents_record_storage_cleanup ()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.document_storage_cleanup (document_id, owner_id, storage_path, thumb_rev)
    values (old.id, old.owner_id, old.storage_path, old.thumb_rev)
    -- An id can come back (ids are client-chosen) and be deleted again; the
    -- latest owner is the one whose folder it is now.
    on conflict (document_id) do update
        set owner_id = excluded.owner_id,
            storage_path = excluded.storage_path,
            thumb_rev = excluded.thumb_rev,
            deleted_at = now();
    return old;
end;
$$;

revoke all on function public.documents_record_storage_cleanup () from public;
revoke all on function public.documents_record_storage_cleanup () from anon;
revoke all on function public.documents_record_storage_cleanup () from authenticated;

drop trigger if exists documents_record_storage_cleanup on public.documents;
create trigger documents_record_storage_cleanup after delete on public.documents
for each row execute function public.documents_record_storage_cleanup ();

-- ---------------------------------------------------------------------------
-- A tombstoned id is not handed to someone else
-- ---------------------------------------------------------------------------
-- Document ids are chosen by the client. If a former member of a deleted
-- score (who knows its id) created a new score under that id before the
-- owner's cleanup ran, any bytes still in the folder — the pre-import backup,
-- say — would become readable through the new row's membership. The app
-- always mints a fresh uuid, so refusing the reuse costs no legitimate flow.
--
-- The former owner re-creating their own id is allowed, and retires the
-- tombstone in the same statement: the folder belongs to a live score again,
-- and a cleanup still pending for it must not go on to remove that score's
-- files (the owner's ordinary storage policies would let it). If the insert
-- fails afterwards, the delete rolls back with it.
create or replace function public.documents_refuse_tombstoned_id ()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if exists (
        select 1
        from public.document_storage_cleanup c
        where c.document_id = new.id
          and c.owner_id <> new.owner_id
    ) then
        raise exception 'document id is not available' using errcode = '23505';
    end if;
    delete from public.document_storage_cleanup c
    where c.document_id = new.id
      and c.owner_id = new.owner_id;
    return new;
end;
$$;

revoke all on function public.documents_refuse_tombstoned_id () from public;
revoke all on function public.documents_refuse_tombstoned_id () from anon;
revoke all on function public.documents_refuse_tombstoned_id () from authenticated;

drop trigger if exists documents_refuse_tombstoned_id on public.documents;
create trigger documents_refuse_tombstoned_id before insert on public.documents
for each row execute function public.documents_refuse_tombstoned_id ();

-- ---------------------------------------------------------------------------
-- Storage access to a tombstoned folder
-- ---------------------------------------------------------------------------
-- True when `folder` names a deleted score the caller owned and has not
-- finished cleaning up. SECURITY DEFINER so it can also confirm the score is
-- really gone: document ids are chosen client-side, and if anyone has since
-- created a new score under the same id, that folder is theirs now and the
-- former owner's tombstone must not reach it. The CASE guards the uuid cast —
-- a stray non-uuid folder name must read as "no", not abort every storage
-- query that evaluates these policies.
create or replace function public.document_storage_cleanup_pending (folder text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select case
        when folder ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (
            exists (
                select 1
                from public.document_storage_cleanup c
                where c.document_id = folder::uuid
                  and c.owner_id = (select auth.uid())
            )
            and not exists (
                select 1
                from public.documents d
                where d.id = folder::uuid
            )
        )
        else false
    end;
$$;

revoke all on function public.document_storage_cleanup_pending (text) from public;
revoke all on function public.document_storage_cleanup_pending (text) from anon;
grant execute on function public.document_storage_cleanup_pending (text) to authenticated;

-- Select as well as delete: the Storage API lists the folder before removing
-- it, and its delete returns the removed rows, both of which need SELECT.
drop policy if exists scores_cleanup_read on storage.objects;
create policy scores_cleanup_read on storage.objects for select to authenticated
using (
    bucket_id = 'scores'
    and public.document_storage_cleanup_pending ((storage.foldername (name))[1])
);

drop policy if exists scores_cleanup_delete on storage.objects;
create policy scores_cleanup_delete on storage.objects for delete to authenticated
using (
    bucket_id = 'scores'
    and public.document_storage_cleanup_pending ((storage.foldername (name))[1])
);

drop policy if exists thumbnails_cleanup_read on storage.objects;
create policy thumbnails_cleanup_read on storage.objects for select to authenticated
using (
    bucket_id = 'thumbnails'
    and public.document_storage_cleanup_pending ((storage.foldername (name))[1])
);

drop policy if exists thumbnails_cleanup_delete on storage.objects;
create policy thumbnails_cleanup_delete on storage.objects for delete to authenticated
using (
    bucket_id = 'thumbnails'
    and public.document_storage_cleanup_pending ((storage.foldername (name))[1])
);
