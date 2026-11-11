-- Storage accounting and thumbnail lifecycle, round 2 (Codex round 2 on #69:
-- MAJOR 1, MAJOR 3's remainder, MINORs 2 and 3; decision 52).
--
--  1. A deleted score's cleanup marker can no longer be cleared by a client.
--     20261022100800 counts a deleted score's leftovers against its owner
--     through public.document_storage_cleanup, but the owner could DELETE that
--     marker through PostgREST (20261007120401) and so take the bytes off the
--     books while the objects stayed. The DELETE grant and the owner delete
--     policy go. A marker is cleared only by
--     public.finish_document_storage_cleanup, which confirms, under the
--     owner's quota lock, that both of the score's folders are empty (or that
--     the owner re-created the score under the same id), or by the service
--     role (delete-account, after it has emptied both folders). Until then
--     the bytes keep counting. A write that waited on the quota lock while the
--     marker was cleared is refused rather than landing unattributed.
--
--  2. At most two thumbnails per score, in committed state. 20261022100800's
--     two-object check is a policy, and the Storage API only runs policies on
--     a test insert it rolls back; its real write is on the service path. So
--     an AFTER INSERT/move trigger on storage.objects takes a per-score
--     advisory lock and counts the folder, committed rows included: of
--     concurrent uploads into one folder, every one past the second is
--     refused (`thumbnail_limit`, 42501). It holds every writer, the service
--     role too, because every real write is the service role's. The policy
--     keeps only its revision cap: the trigger also runs on the policy test,
--     so a full folder is refused there by name.
--
--  3. Thumbnail cleanup is claimed under the same per-score lock, and a
--     claimed cover can never be published.
--     public.claim_superseded_thumbnails marks the objects a client may
--     remove: in a library sweep, the listed (superseded) ones; before a
--     publish, every object but the one being written. Never the published
--     revision (documents.thumb_rev), read under the lock. Publishing a
--     revision (a thumb_rev change) takes the lock too and is refused
--     (`thumbnail_claimed`) while its object is claimed, so a removal already
--     claimed cannot delete a cover that has since become the published one.
--     A publish whose thumb_rev update failed no longer blocks the next: its
--     unpublished upload is not current, so the next publish claims and
--     removes it before writing (thumbnailRemote.ts).
--
--  4. An over-quota account can still replace a file with one no larger.
--     The Storage API's size-less policy test for a replacement used to be
--     refused once the account's other files filled its quota, so a shrink
--     never reached the real write. A write that replaces an object (an
--     update, or an upsert's insert over an existing row) with one no larger
--     is allowed, the size-less test included; the real write, size known,
--     is held to that same rule, so growth past the quota is still refused.
--
-- Rerunnable: functions replaced, the column guarded, triggers and policies
-- dropped before they are created.

-- ---------------------------------------------------------------------------
-- 1. Cleanup markers: cleared by the server, never by a client
-- ---------------------------------------------------------------------------
drop policy if exists document_storage_cleanup_delete on public.document_storage_cleanup;

revoke delete on table public.document_storage_cleanup from public, anon, authenticated;

-- Clear the caller's marker for a deleted score once nothing of it is stored.
-- True when no marker of the caller's is left for this id; false while either
-- folder still holds an object, so the caller removes them and asks again.
-- Under the owner's quota lock, which every write into these folders takes:
-- an upload already waiting there is either seen here, or refused when it
-- finds the marker gone.
create or replace function public.finish_document_storage_cleanup (p_document_id uuid) returns boolean
language plpgsql security definer
set search_path = public as $$
declare
    v_owner uuid := (select auth.uid ());
begin
    if v_owner is null or p_document_id is null then
        return false;
    end if;
    if not exists (
        select 1 from public.document_storage_cleanup c
        where c.document_id = p_document_id and c.owner_id = v_owner
    ) then
        return true;
    end if;

    perform pg_advisory_xact_lock (hashtext('cleffy.storage_quota'), hashtext(v_owner::text));

    perform 1 from public.document_storage_cleanup c
    where c.document_id = p_document_id and c.owner_id = v_owner
    for update;
    if not found then
        return true;
    end if;

    -- A live score under this id is the owner's again (20261007120401 lets
    -- only the former owner re-create it), and its files count through it.
    if not exists (select 1 from public.documents d where d.id = p_document_id)
       and exists (
           select 1
           from storage.objects o
           where o.bucket_id in ('scores', 'thumbnails')
             and o.name collate "C" >= (p_document_id::text || '/') collate "C"
             and o.name collate "C" < (p_document_id::text || '0') collate "C"
       ) then
        return false;
    end if;

    delete from public.document_storage_cleanup c
    where c.document_id = p_document_id and c.owner_id = v_owner;
    return true;
end;
$$;

revoke all on function public.finish_document_storage_cleanup (uuid) from public, anon;
grant execute on function public.finish_document_storage_cleanup (uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4 (and 1). The quota trigger: replacements no larger pass; a folder whose
-- marker went while the write waited is refused
-- ---------------------------------------------------------------------------
create or replace function public.storage_objects_enforce_quota () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_size bigint := public.storage_object_size (new.metadata);
    v_replaced bigint;
    v_owner uuid;
    v_limit bigint;
    v_used bigint;
begin
    if new.bucket_id is null or new.bucket_id not in ('scores', 'thumbnails') then
        return new;
    end if;

    -- The object this write replaces: this row's own old version, or the row
    -- an upsert's insert is about to meet; null for a new object.
    if tg_op = 'UPDATE' and new.bucket_id = old.bucket_id and new.name = old.name then
        v_replaced := public.storage_object_size (old.metadata);
    else
        select sum(public.storage_object_size (o.metadata)) into v_replaced
        from storage.objects o
        where o.bucket_id = new.bucket_id
          and o.name collate "C" = new.name collate "C";
    end if;

    -- Replacing an object with one no larger never adds bytes, so it is
    -- allowed even over quota: the Storage API's size-less policy test for a
    -- replacement passes here, and its real write, size known, meets this
    -- same rule or the quota below.
    if v_replaced is not null and v_size <= v_replaced then
        return new;
    end if;

    v_owner := public.storage_object_owner (new.bucket_id, new.name);
    if v_owner is null then
        return new;
    end if;

    perform pg_advisory_xact_lock (hashtext('cleffy.storage_quota'), hashtext(v_owner::text));

    -- The score was deleted and its cleanup finished while this write
    -- waited: its folder is no one's now, and nothing may land in it.
    if public.storage_object_owner (new.bucket_id, new.name) is distinct from v_owner then
        raise exception 'storage_folder_gone'
            using errcode = '42501',
                  detail = json_build_object('code', 'storage_folder_gone')::text,
                  hint = 'The score this file belongs to was deleted.';
    end if;

    v_limit := public.storage_quota_bytes (public.resolve_entitlements (v_owner) ->> 'tier');

    -- Everything stored, less the object this write replaces.
    v_used := public.storage_owner_bytes (v_owner) - coalesce(v_replaced, 0);

    -- A write with no size yet (the Storage API's policy test) for a new
    -- object is refused once nothing is left, so a full account fails before
    -- it uploads.
    if v_used + v_size > v_limit or (v_size = 0 and v_used >= v_limit) then
        raise exception 'storage_quota_exceeded'
            using errcode = '42501',
                  detail = json_build_object(
                      'code', 'storage_quota_exceeded',
                      'limit_bytes', v_limit,
                      'used_bytes', v_used,
                      'object_bytes', v_size
                  )::text,
                  hint = 'Delete scores (archived ones count too) or upgrade for more storage.';
    end if;

    return new;
end;
$$;

revoke all on function public.storage_objects_enforce_quota () from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. At most two thumbnails per score, counted under a per-score lock
-- ---------------------------------------------------------------------------
-- The lock every change to a score's thumbnail folder, its claims and its
-- published revision takes, held to commit.
create or replace function public.thumbnail_folder_lock (p_document_id uuid) returns void language plpgsql
set search_path = '' as $$
begin
    perform pg_advisory_xact_lock (hashtext('cleffy.thumbnail_folder'), hashtext(p_document_id::text));
end;
$$;

revoke all on function public.thumbnail_folder_lock (uuid) from public, anon, authenticated;

-- AFTER the row is in: under the lock, the count sees every upload committed
-- before this one, and its own row. The folder may hold the published cover
-- and one more (the one replacing it); anything past that is refused.
create or replace function public.thumbnails_enforce_folder_cap () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_folder text;
    v_count bigint;
begin
    if new.bucket_id is distinct from 'thumbnails' then
        return null;
    end if;
    if tg_op = 'UPDATE' and old.bucket_id = new.bucket_id and old.name = new.name then
        return null;
    end if;
    v_folder := split_part(new.name, '/', 1);
    if v_folder !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return null;
    end if;

    perform public.thumbnail_folder_lock (v_folder::uuid);

    select count(*) into v_count
    from storage.objects o
    where o.bucket_id = 'thumbnails'
      and o.name collate "C" >= (v_folder || '/') collate "C"
      and o.name collate "C" < (v_folder || '0') collate "C";

    if v_count > 2 then
        raise exception 'thumbnail_limit'
            using errcode = '42501',
                  detail = json_build_object('code', 'thumbnail_limit', 'objects', v_count, 'limit', 2)::text,
                  hint = 'Remove the superseded cover (claim_superseded_thumbnails) before writing a new one.';
    end if;
    return null;
end;
$$;

revoke all on function public.thumbnails_enforce_folder_cap () from public, anon, authenticated;

drop trigger if exists thumbnails_enforce_folder_cap on storage.objects;

-- Named to fire before thumbnails_record_superseded (AFTER triggers run in
-- name order), so a refused write ledgers nothing.
create trigger thumbnails_enforce_folder_cap
after insert or update of name, bucket_id on storage.objects
for each row execute function public.thumbnails_enforce_folder_cap ();

-- The policy behind thumbnails_revision_insert/_update (20261022100800) keeps
-- only its revision cap. Its folder count ran on the Storage API's rolled-back
-- test alone and so bounded nothing; the trigger above counts on that test
-- too, and on the real write. Refused there, a full folder says so
-- (`thumbnail_limit`) rather than as a bare policy violation, which is how
-- the owner's client knows to clear the folder first (thumbnailRemote.ts).
create or replace function public.thumbnail_write_allowed (p_name text) returns boolean language plpgsql stable
security definer
set search_path = public as $$
declare
    v_folder text := split_part(p_name, '/', 1);
    v_rev_text text := substring(split_part(p_name, '/', 2) from '^([0-9]{1,10})\.jpg$');
    v_rev bigint;
    v_content_rev int;
begin
    if v_rev_text is null
       or v_folder !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return false;
    end if;
    v_rev := v_rev_text::bigint;

    select d.content_rev into v_content_rev from public.documents d where d.id = v_folder::uuid;
    return v_content_rev is not null and v_rev <= v_content_rev and v_rev <= 1000000;
end;
$$;

revoke all on function public.thumbnail_write_allowed (text) from public, anon;
grant execute on function public.thumbnail_write_allowed (text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Claims: what a client may remove, and what may no longer be published
-- ---------------------------------------------------------------------------
alter table public.thumbnail_storage_cleanup add column if not exists claimed_at timestamptz;

comment on column public.thumbnail_storage_cleanup.claimed_at is
    'Set by claim_superseded_thumbnails when a client was told to remove the object. A claimed object is never '
    'published (documents_thumbnail_published); the row goes when the object does.';

-- 20261022100800's ledger trigger, except that writing an object again no
-- longer clears a claim on it: the removal already claimed would delete the
-- new bytes, so the claim must keep it from being published.
create or replace function public.thumbnails_record_superseded () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_folder text;
    v_owner uuid;
begin
    if tg_op = 'DELETE' then
        if old.bucket_id = 'thumbnails' then
            delete from public.thumbnail_storage_cleanup c where c.object_name = old.name;
        end if;
        return null;
    end if;

    if new.bucket_id is distinct from 'thumbnails' then
        return null;
    end if;
    v_owner := public.storage_object_owner (new.bucket_id, new.name);
    if v_owner is null then
        return null;
    end if;
    v_folder := split_part(new.name, '/', 1);

    insert into public.thumbnail_storage_cleanup (object_name, document_id, owner_id)
    select o.name, v_folder::uuid, v_owner
    from storage.objects o
    where o.bucket_id = 'thumbnails'
      and o.name collate "C" >= (v_folder || '/') collate "C"
      and o.name collate "C" < (v_folder || '0') collate "C"
      and o.name <> new.name
    on conflict (object_name) do nothing;

    -- The revision just written is the latest, not a leftover -- unless a
    -- removal has already claimed it.
    delete from public.thumbnail_storage_cleanup c where c.object_name = new.name and c.claimed_at is null;
    return null;
end;
$$;

revoke all on function public.thumbnails_record_superseded () from public, anon, authenticated;

-- The objects in these scores' thumbnail folders that the caller (their
-- owner) may now remove, each claimed. With p_writing_rev null (a library
-- sweep), the ones on the ledger; with it set (one score, about to write that
-- revision), every object but that one, so an earlier upload whose publish
-- failed does not hold the folder full. Never the published revision, read
-- under the folder lock that publishing takes too. Scores that are not the
-- caller's, or gone, are skipped.
create or replace function public.claim_superseded_thumbnails (p_document_ids uuid[], p_writing_rev integer default null)
returns setof text language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := (select auth.uid ());
    v_doc uuid;
    v_thumb_rev integer;
    v_current text;
    v_writing text;
begin
    if v_caller is null or p_document_ids is null or cardinality(p_document_ids) = 0 then
        return;
    end if;
    if cardinality(p_document_ids) > 100 then
        raise exception 'at most 100 scores per claim' using errcode = '22023';
    end if;
    if p_writing_rev is not null and cardinality(p_document_ids) <> 1 then
        raise exception 'a revision being written names exactly one score' using errcode = '22023';
    end if;

    -- In id order, so two claims over overlapping scores take the locks alike.
    for v_doc in select distinct x from unnest(p_document_ids) x where x is not null order by 1 loop
        perform public.thumbnail_folder_lock (v_doc);

        select d.thumb_rev into v_thumb_rev
        from public.documents d
        where d.id = v_doc and d.owner_id = v_caller;
        if not found then
            continue;
        end if;
        v_current := case when v_thumb_rev is not null then v_doc::text || '/' || v_thumb_rev::text || '.jpg' end;
        v_writing := case when p_writing_rev is not null then v_doc::text || '/' || p_writing_rev::text || '.jpg' end;

        -- The published cover is not superseded.
        delete from public.thumbnail_storage_cleanup c where c.object_name = v_current;

        return query
        with candidates as (
            select o.name
            from storage.objects o
            where o.bucket_id = 'thumbnails'
              and o.name collate "C" >= (v_doc::text || '/') collate "C"
              and o.name collate "C" < (v_doc::text || '0') collate "C"
              and o.name is distinct from v_current
              and o.name is distinct from v_writing
              and (p_writing_rev is not null
                   or exists (select 1 from public.thumbnail_storage_cleanup c where c.object_name = o.name))
        )
        insert into public.thumbnail_storage_cleanup as t (object_name, document_id, owner_id, claimed_at)
        select k.name, v_doc, v_caller, now() from candidates k
        on conflict (object_name) do update set claimed_at = coalesce(t.claimed_at, excluded.claimed_at)
        returning t.object_name;
    end loop;
end;
$$;

revoke all on function public.claim_superseded_thumbnails (uuid[], integer) from public, anon;
grant execute on function public.claim_superseded_thumbnails (uuid[], integer) to authenticated;

-- Publishing a revision: under the folder lock, refused while a removal has
-- claimed its object; otherwise it is current, and everything else in the
-- folder is superseded (the ledger the sweep claims from).
create or replace function public.documents_thumbnail_published () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_name text;
begin
    if new.thumb_rev is null or new.thumb_rev is not distinct from old.thumb_rev then
        return new;
    end if;
    perform public.thumbnail_folder_lock (new.id);
    v_name := new.id::text || '/' || new.thumb_rev::text || '.jpg';

    if exists (
        select 1 from public.thumbnail_storage_cleanup c
        where c.object_name = v_name and c.claimed_at is not null
    ) then
        raise exception 'thumbnail_claimed'
            using errcode = '55000',
                  detail = json_build_object('code', 'thumbnail_claimed', 'object', v_name)::text,
                  hint = 'That cover is being removed; upload it again before publishing it.';
    end if;

    delete from public.thumbnail_storage_cleanup c where c.object_name = v_name;
    insert into public.thumbnail_storage_cleanup (object_name, document_id, owner_id)
    select o.name, new.id, new.owner_id
    from storage.objects o
    where o.bucket_id = 'thumbnails'
      and o.name collate "C" >= (new.id::text || '/') collate "C"
      and o.name collate "C" < (new.id::text || '0') collate "C"
      and o.name <> v_name
    on conflict (object_name) do nothing;
    return new;
end;
$$;

revoke all on function public.documents_thumbnail_published () from public, anon, authenticated;

drop trigger if exists documents_thumbnail_published on public.documents;

create trigger documents_thumbnail_published before update of thumb_rev on public.documents
for each row execute function public.documents_thumbnail_published ();
