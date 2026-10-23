-- Thumbnails: a publish and a multi-object removal take their locks in one
-- order (P1 follow-up).
--
-- 20261022101000's order is "a score's documents row, then a Storage object
-- row, then the owner's quota lock, then the score's folder lock". A removal
-- of several covers in one statement (removeClaimedThumbnails' remove([...]),
-- one DELETE ... WHERE name IN (...)) does not keep it: the executor locks
-- each row as it reaches it, and thumbnails_keep_published_cover takes the
-- folder lock in between, so it holds object A1 and the folder, then waits
-- for object A2. A publish of A2 took A2's row FOR KEY SHARE first and then
-- waited for the folder lock. Each waited for the other: PostgreSQL's
-- deadlock detector aborted one after deadlock_timeout.
--
-- Now the publish reads whether its object is stored (no lock), takes the
-- score's folder lock, holding no object row of the score, and only then its
-- object's row, FOR KEY SHARE NOWAIT: it
-- never waits for a row while it holds the folder, so no cycle can form with
-- a removal, an upload (its predecessor's row, then the owner lock, then the
-- folder) or a claim. What a publish now sees:
--   * a removal of its object that already holds the folder (single or
--     multi-object): the publish waits for the folder, then finds the object
--     gone and is refused `thumbnail_gone`, as before;
--   * a removal or upload holding its object's row but not yet the folder: the
--     publish is refused at once with `thumbnail_folder_busy` (55P03, safe to
--     retry; thumbnailRemote.publishThumbnail returns false and a later
--     session publishes again), where it used to wait;
--   * a removal that starts after the publish took the folder waits for it
--     and then leaves the now-published cover (thumbnails_keep_published_cover
--     re-reads documents.thumb_rev under the folder lock), as before.
-- A bulk publish's out-of-order folder request is still refused at once by
-- thumbnail_folder_lock (20261022101000, item 3).
--
-- Lock order, everywhere, from here: a score's documents row, then (a writer
-- of objects) a Storage object row, then the owner's quota lock, then the
-- score's folder lock (ascending), then the cleanup ledger; a publish, which
-- holds the documents row, takes the folder lock and then its object's row
-- without waiting.
--
-- Rerunnable: the function is replaced with the same signature; the trigger
-- (documents_thumbnail_published, 20261022100800) is unchanged.

-- 20261022101000's definition; the folder lock moves ahead of the object's
-- row lock, which no longer waits.
create or replace function public.documents_thumbnail_published () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_name text;
    v_stored boolean;
begin
    if new.thumb_rev is null or new.thumb_rev is not distinct from old.thumb_rev then
        return new;
    end if;
    v_name := new.id::text || '/' || new.thumb_rev::text || '.jpg';

    -- Whether the revision's object is stored, read before any wait: a
    -- revision whose object was never stored may still be named (the
    -- client's republish repairs a missing cover); one that a removal takes
    -- while this publish waits is refused (`thumbnail_gone`).
    v_stored := exists (
        select 1 from storage.objects o
        where o.bucket_id = 'thumbnails' and o.name collate "C" = v_name collate "C"
    );

    -- The folder next, holding no object row of this score: a removal or a
    -- claim that holds it finishes before this goes on.
    perform public.thumbnail_folder_lock (new.id);

    -- Then the object's row, without waiting: whoever holds it may be waiting
    -- for the folder this transaction now holds.
    if v_stored then
        begin
            perform 1 from storage.objects o
            where o.bucket_id = 'thumbnails' and o.name collate "C" = v_name collate "C"
            for key share nowait;
        exception
            when lock_not_available then
                raise exception 'thumbnail_folder_busy'
                    using errcode = '55P03',
                          detail = json_build_object('code', 'thumbnail_folder_busy', 'document_id', new.id)::text,
                          hint = 'Another change to this score''s cover is under way; try again.';
        end;
        if not found then
            raise exception 'thumbnail_gone'
                using errcode = '55000',
                      detail = json_build_object('code', 'thumbnail_gone', 'object', v_name)::text,
                      hint = 'That cover was removed while it was being published; upload it again.';
        end if;
    end if;

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

-- DEPLOY: no order constraint, no edge function or client change.
