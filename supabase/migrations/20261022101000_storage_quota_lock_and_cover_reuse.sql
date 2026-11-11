-- Storage accounting and thumbnail lifecycle, round 3 (Codex round 3 on #69:
-- the MAJOR, MINOR 2's remainder and the new MINOR; decision 57).
--
--  1. A replacement can no longer slip past the quota while its predecessor
--     is being deleted. 20261022100900 let a write that replaces an object
--     with one no larger skip the quota, judging "replaces" from an unlocked
--     read before the owner's quota lock. A BEFORE INSERT trigger runs before
--     unique-conflict resolution: if a concurrent delete of the predecessor
--     commits meanwhile, the upsert goes on as a plain INSERT, which nothing
--     charged. Now the existing row is locked (FOR UPDATE) and the owner's
--     quota lock taken before the exemption is weighed, and the row is read
--     again, FOR UPDATE, under that lock: a predecessor still there cannot be
--     deleted before this write commits, and one already gone is charged as
--     a new object. Every write into a score's folders takes the owner lock
--     now, a non-growing one too. And an AFTER INSERT trigger charges every
--     row that was actually inserted -- after conflict resolution -- in full,
--     under the same lock, whatever the BEFORE trigger concluded.
--
--  2. A delayed cleanup can no longer delete a cover that has since become
--     the published one under the same name. Claims protected a name only
--     until the first removal deleted its ledger row; a second, late removal
--     of the same name could then take a re-uploaded, re-published cover.
--     A BEFORE DELETE trigger on storage.objects now re-checks, under the
--     score's folder lock, that the object is not the score's published cover
--     (documents.thumb_rev) before a client's removal may take it, claim row
--     or no claim row: the Storage API's policy test for the removal skips
--     it, so its real delete never includes it. The service role's removals
--     (delete-account empties a live score's folders before deleting the
--     row) are not held to it. Publishing a revision takes its object's row
--     lock (FOR KEY SHARE) first, so a removal already under way finishes
--     before the publish, which is then refused (`thumbnail_gone`) rather
--     than naming a removed cover, and a removal that starts after it sees
--     the cover as published.
--
--  3. One lock order for the per-score folder locks: document id ascending.
--     claim_superseded_thumbnails already took them in id order; a bulk
--     UPDATE of thumb_rev took them in whatever order it visited rows, and
--     could deadlock against a batched claim. thumbnail_folder_lock now
--     remembers, for the transaction, the highest score id it has locked;
--     a request for a lower one never waits: it takes the lock if it is
--     free, and otherwise is refused at once (`thumbnail_folder_busy`,
--     55P03, safe to retry). No transaction ever waits for a folder lock
--     below one it holds, so no two can wait on each other for them.
--
--  4. Folders already over the two-object cap (written before
--     20261022100900 counted them) are trimmed by the next library sweep, not
--     only by the next publish: a sweep's claim, in a folder of more than
--     two, also takes every object but the published one and the newest
--     other (an upload whose publish may still be on its way).
--
-- Lock order, everywhere: a score's documents row, then a Storage object
-- row, then the owner's quota lock, then the score's folder lock (ascending),
-- then the cleanup ledger.
--
-- Rerunnable: functions replaced, triggers dropped before they are created.

-- ---------------------------------------------------------------------------
-- 3. The folder lock, in one order
-- ---------------------------------------------------------------------------
-- The highest score id this transaction holds the folder lock of rides in
-- cleffy.thumbnail_folder_max (transaction-local; a rolled-back savepoint
-- takes it back with the locks it took).
create or replace function public.thumbnail_folder_lock (p_document_id uuid) returns void language plpgsql
set search_path = '' as $$
declare
    v_max text := nullif(current_setting('cleffy.thumbnail_folder_max', true), '');
begin
    if v_max is not null and p_document_id < v_max::uuid then
        -- Out of order: take it only if no one holds it (or this transaction
        -- already does). Waiting here could close a cycle.
        if not pg_try_advisory_xact_lock (hashtext('cleffy.thumbnail_folder'), hashtext(p_document_id::text)) then
            raise exception 'thumbnail_folder_busy'
                using errcode = '55P03',
                      detail = json_build_object('code', 'thumbnail_folder_busy', 'document_id', p_document_id)::text,
                      hint = 'Another change to this score''s cover is under way; try again.';
        end if;
        return;
    end if;
    perform pg_advisory_xact_lock (hashtext('cleffy.thumbnail_folder'), hashtext(p_document_id::text));
    perform set_config('cleffy.thumbnail_folder_max', p_document_id::text, true);
end;
$$;

revoke all on function public.thumbnail_folder_lock (uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. The quota: the predecessor locked, the owner lock taken, then the rule
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

    v_owner := public.storage_object_owner (new.bucket_id, new.name);
    if v_owner is null then
        return new;
    end if;

    -- An insert's predecessor (the row an upsert is about to meet), locked
    -- before the owner lock: an UPDATE holds its row before this trigger
    -- runs, so every writer takes the row first, then the owner lock. A
    -- delete of it under way finishes first, and then there is none.
    if tg_op = 'INSERT' then
        perform 1 from storage.objects o
        where o.bucket_id = new.bucket_id
          and o.name collate "C" = new.name collate "C"
        for update;
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

    -- The object this write replaces, read under the owner lock: this row's
    -- own old version, or the predecessor, locked (one that appeared while
    -- this write waited is locked now). A move replaces nothing (it cannot
    -- land on an existing name).
    if tg_op = 'UPDATE' then
        if new.bucket_id = old.bucket_id and new.name = old.name then
            v_replaced := public.storage_object_size (old.metadata);
        end if;
    else
        select sum(public.storage_object_size (p.metadata)) into v_replaced
        from (
            select o.metadata from storage.objects o
            where o.bucket_id = new.bucket_id
              and o.name collate "C" = new.name collate "C"
            for update
        ) p;
    end if;

    -- Replacing an object with one no larger never adds bytes, so it is
    -- allowed even over quota (the Storage API's size-less policy test for a
    -- replacement included). The predecessor is locked to this transaction,
    -- so the write does replace it; and should the row go in as a new one
    -- after all, storage_objects_charge_insert charges it in full.
    if v_replaced is not null and v_size <= v_replaced then
        return new;
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

-- After conflict resolution: a row that was actually inserted (an upsert
-- that met an existing row fires AFTER UPDATE instead) is a new object, and
-- is charged in full under the owner lock, with this row now in the usage.
create or replace function public.storage_objects_charge_insert () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_size bigint := public.storage_object_size (new.metadata);
    v_owner uuid;
    v_limit bigint;
    v_used bigint;
begin
    if new.bucket_id is null or new.bucket_id not in ('scores', 'thumbnails') then
        return null;
    end if;
    v_owner := public.storage_object_owner (new.bucket_id, new.name);
    if v_owner is null then
        return null;
    end if;

    perform pg_advisory_xact_lock (hashtext('cleffy.storage_quota'), hashtext(v_owner::text));

    v_limit := public.storage_quota_bytes (public.resolve_entitlements (v_owner) ->> 'tier');
    -- Everything else stored: this row is in the usage now.
    v_used := public.storage_owner_bytes (v_owner) - v_size;

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
    return null;
end;
$$;

revoke all on function public.storage_objects_charge_insert () from public, anon, authenticated;

drop trigger if exists storage_objects_charge_insert on storage.objects;

create trigger storage_objects_charge_insert
after insert on storage.objects
for each row execute function public.storage_objects_charge_insert ();

-- ---------------------------------------------------------------------------
-- 2. A client's removal never takes the published cover
-- ---------------------------------------------------------------------------
-- BEFORE DELETE, for a signed-in user's delete -- the Storage API's policy
-- test, whose answer is the list its real (service) delete then removes.
-- Under the score's folder lock, which publishing takes too: the score's
-- published cover is skipped (the row stays, and the removal reports it
-- not removed). Other objects, a deleted score's, and the service role's
-- removals go ahead.
create or replace function public.thumbnails_keep_published_cover () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_folder text;
begin
    if old.bucket_id is distinct from 'thumbnails' or (select auth.uid ()) is null then
        return old;
    end if;
    v_folder := split_part(old.name, '/', 1);
    if v_folder !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return old;
    end if;

    perform public.thumbnail_folder_lock (v_folder::uuid);

    if exists (
        select 1 from public.documents d
        where d.id = v_folder::uuid
          and d.thumb_rev is not null
          and old.name = d.id::text || '/' || d.thumb_rev::text || '.jpg'
    ) then
        return null;
    end if;
    return old;
end;
$$;

revoke all on function public.thumbnails_keep_published_cover () from public, anon, authenticated;

drop trigger if exists thumbnails_keep_published_cover on storage.objects;

create trigger thumbnails_keep_published_cover before delete on storage.objects
for each row execute function public.thumbnails_keep_published_cover ();

-- Publishing a revision: its object's row first (FOR KEY SHARE: a removal of
-- it under way finishes first, and the publish is refused; one that starts
-- later waits for this commit and then finds it published), then the folder
-- lock. Refused while a
-- removal has claimed the object; otherwise it is current, and everything
-- else in the folder is superseded. Holding another score's folder lock
-- already (a bulk update), it never waits on the row: a removal under way
-- refuses it (`thumbnail_folder_busy`).
create or replace function public.documents_thumbnail_published () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_name text;
begin
    if new.thumb_rev is null or new.thumb_rev is not distinct from old.thumb_rev then
        return new;
    end if;
    v_name := new.id::text || '/' || new.thumb_rev::text || '.jpg';

    -- A revision whose object is not stored at all may still be named (the
    -- client's republish repairs a missing cover); one that a removal takes
    -- while this publish waits for it is refused (`thumbnail_gone`).
    if exists (
        select 1 from storage.objects o
        where o.bucket_id = 'thumbnails' and o.name collate "C" = v_name collate "C"
    ) then
        if nullif(current_setting('cleffy.thumbnail_folder_max', true), '') is null then
            perform 1 from storage.objects o
            where o.bucket_id = 'thumbnails' and o.name collate "C" = v_name collate "C"
            for key share;
        else
            perform 1 from storage.objects o
            where o.bucket_id = 'thumbnails' and o.name collate "C" = v_name collate "C"
            for key share skip locked;
            if not found and exists (
                select 1 from storage.objects o
                where o.bucket_id = 'thumbnails' and o.name collate "C" = v_name collate "C"
            ) then
                raise exception 'thumbnail_folder_busy'
                    using errcode = '55P03',
                          detail = json_build_object('code', 'thumbnail_folder_busy', 'document_id', new.id)::text,
                          hint = 'Another change to this score''s cover is under way; try again.';
            end if;
        end if;
        if not found then
            raise exception 'thumbnail_gone'
                using errcode = '55000',
                      detail = json_build_object('code', 'thumbnail_gone', 'object', v_name)::text,
                      hint = 'That cover was removed while it was being published; upload it again.';
        end if;
    end if;

    perform public.thumbnail_folder_lock (new.id);

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

-- ---------------------------------------------------------------------------
-- 4. A sweep trims a folder over the cap
-- ---------------------------------------------------------------------------
-- 20261022100900's claim, except that a library sweep (p_writing_rev null)
-- in a folder of more than two objects also takes every object but the
-- published one and the newest other. Folder locks in id order, as before.
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

    -- In id order: the one order every folder lock is taken in.
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
        with folder as (
            select o.name, o.created_at
            from storage.objects o
            where o.bucket_id = 'thumbnails'
              and o.name collate "C" >= (v_doc::text || '/') collate "C"
              and o.name collate "C" < (v_doc::text || '0') collate "C"
        ),
        -- Over the cap, the newest object besides the published one may be
        -- an upload on its way to being published: it stays.
        newest as (
            select f.name from folder f
            where f.name is distinct from v_current
            order by f.created_at desc, f.name desc
            limit 1
        ),
        candidates as (
            select f.name
            from folder f
            where f.name is distinct from v_current
              and f.name is distinct from v_writing
              and (p_writing_rev is not null
                   or exists (select 1 from public.thumbnail_storage_cleanup c where c.object_name = f.name)
                   or ((select count(*) from folder) > 2 and f.name not in (select n.name from newest n)))
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
