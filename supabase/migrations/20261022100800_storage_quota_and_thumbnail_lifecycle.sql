-- Storage abuse: a byte quota per owner, and one thumbnail per score
-- (launch re-audit A2; Codex round 1 on #69, MAJOR 3).
--
-- 20261022100400 pinned object NAMES, but nothing bounded how much an owner
-- stores: every numeric thumbnails/{id}/{rev}.jpg was a new object no one
-- removed (thumbnailRemote.ts uploads a revision and never deletes the one
-- before), and archiving a score (an owner's UPDATE) frees its cap slot while
-- its PDF stays, so create-archive-repeat kept a PDF per archived score.
--
--  1. A per-owner byte quota, enforced as an object row is written. The
--     owner is the owner of the score whose folder ({document_id}/) the
--     object is in -- or, for a deleted score whose bytes still wait on
--     cleanup, its document_storage_cleanup owner. Everything in both buckets
--     counts: archived scores' PDFs, the pre-import backup, every thumbnail
--     revision still stored, and deleted scores' leftovers. The limit is
--     read from public.deployment_config.storage_quota_bytes, keyed by plan
--     tier, defaulting to 500 MiB for free (and a roster student or a
--     read-only seat) and 5 GiB for the paid tiers.
--
--     It is a BEFORE INSERT OR UPDATE trigger on storage.objects, not a
--     policy: the Storage API checks policies on a test insert it rolls back
--     (no size known yet) and then writes the real row on its service path,
--     where no client policy runs. The trigger sees that write, size and all.
--     An advisory lock per owner, held to commit, serializes concurrent
--     uploads, and each one re-reads the usage after taking it, so two at
--     once cannot both fit into the same remaining space. A write that does
--     not grow an object is never refused, so nothing already stored becomes
--     unwritable.
--
--  2. Thumbnails keep only the latest revision. A thumbnail written into a
--     folder records every OTHER object there in
--     public.thumbnail_storage_cleanup, the tombstone ledger the client
--     purges from (the document_storage_cleanup pattern of 20261007120401:
--     SQL cannot delete Storage bytes, storage.protect_delete blocks it). The
--     ledger clears itself: removing an object deletes its row. A client may
--     write a thumbnail only while its folder holds at most one other object
--     (the latest, not yet replaced) and only for a revision between 0 and
--     the score's content_rev, capped at 1,000,000.
--
-- Rerunnable: the column, table and constraints are guarded, functions
-- replaced, triggers and policies dropped before they are created.

-- ---------------------------------------------------------------------------
-- 1a. The limits, in deployment_config
-- ---------------------------------------------------------------------------
alter table public.deployment_config add column if not exists storage_quota_bytes jsonb;

-- Null means the defaults. Otherwise an object of plan tier -> positive byte
-- count; a tier it leaves out keeps its default.
create or replace function public.storage_quota_config_valid (p_config jsonb) returns boolean language sql immutable
set search_path = '' as $$
    select p_config is null
        or (
            jsonb_typeof(p_config) = 'object'
            and not exists (
                select 1
                from jsonb_each(p_config) e
                where e.key not in ('free', 'personal', 'teacher', 'academy', 'student')
                   or jsonb_typeof(e.value) <> 'number'
                   or (e.value #>> '{}') !~ '^[1-9][0-9]{0,15}$'
            )
        );
$$;

revoke all on function public.storage_quota_config_valid (jsonb) from public, anon, authenticated;

alter table public.deployment_config drop constraint if exists deployment_config_storage_quota_bytes_check;

alter table public.deployment_config
add constraint deployment_config_storage_quota_bytes_check check (public.storage_quota_config_valid (storage_quota_bytes));

-- The quota for a plan tier.
create or replace function public.storage_quota_bytes (p_tier text) returns bigint language sql stable security definer
set search_path = public as $$
    select coalesce(
        (select (c.storage_quota_bytes ->> p_tier)::bigint from public.deployment_config c where c.id),
        case when p_tier in ('personal', 'teacher', 'academy') then 5368709120 -- 5 GiB
             else 524288000 -- 500 MiB: free, a roster student, anything unknown
        end
    );
$$;

revoke all on function public.storage_quota_bytes (text) from public, anon, authenticated;
grant execute on function public.storage_quota_bytes (text) to service_role;

-- ---------------------------------------------------------------------------
-- 1b. Whose bytes, and how many
-- ---------------------------------------------------------------------------
-- The owner of the score whose folder an object in 'scores' or 'thumbnails'
-- is in: the live score's owner, else the owner a deleted score's cleanup
-- tombstone names; null for anything else.
create or replace function public.storage_object_owner (p_bucket text, p_name text) returns uuid language plpgsql stable
security definer
set search_path = public as $$
declare
    v_folder text := split_part(p_name, '/', 1);
    v_doc uuid;
    v_owner uuid;
begin
    if p_bucket is null or p_bucket not in ('scores', 'thumbnails')
       or v_folder !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return null;
    end if;
    v_doc := v_folder::uuid;
    select d.owner_id into v_owner from public.documents d where d.id = v_doc;
    if v_owner is null then
        select c.owner_id into v_owner from public.document_storage_cleanup c where c.document_id = v_doc;
    end if;
    return v_owner;
end;
$$;

revoke all on function public.storage_object_owner (text, text) from public, anon, authenticated;

-- An object's stored size; 0 when Storage has not recorded one.
create or replace function public.storage_object_size (p_metadata jsonb) returns bigint language sql immutable
set search_path = '' as $$
    select case when (p_metadata ->> 'size') ~ '^[0-9]{1,18}$' then (p_metadata ->> 'size')::bigint else 0 end;
$$;

revoke all on function public.storage_object_size (jsonb) from public, anon, authenticated;

-- Every byte an owner has in both buckets: under each score they own,
-- archived or not, and under each deleted score of theirs still awaiting
-- cleanup. Each folder is one range probe on Storage's (bucket_id, name
-- COLLATE "C") index: '/' sorts right before '0', so [id/, id0) is the folder.
create or replace function public.storage_owner_bytes (p_owner uuid) returns bigint language sql stable security definer
set search_path = public as $$
    select coalesce(sum(public.storage_object_size (o.metadata)), 0)::bigint
    from (
        select d.id from public.documents d where d.owner_id = p_owner
        union
        select c.document_id from public.document_storage_cleanup c
        where c.owner_id = p_owner
          and not exists (select 1 from public.documents d where d.id = c.document_id)
    ) f
    cross join (values ('scores'), ('thumbnails')) b(bucket)
    join storage.objects o
      on o.bucket_id = b.bucket
     and o.name collate "C" >= (f.id::text || '/') collate "C"
     and o.name collate "C" < (f.id::text || '0') collate "C";
$$;

revoke all on function public.storage_owner_bytes (uuid) from public, anon, authenticated;
grant execute on function public.storage_owner_bytes (uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 1c. The quota, as the row is written
-- ---------------------------------------------------------------------------
create or replace function public.storage_objects_enforce_quota () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_size bigint := public.storage_object_size (new.metadata);
    v_owner uuid;
    v_limit bigint;
    v_used bigint;
begin
    if new.bucket_id is null or new.bucket_id not in ('scores', 'thumbnails') then
        return new;
    end if;
    -- Rewriting an object in place without growing it is always allowed.
    if tg_op = 'UPDATE'
       and new.bucket_id = old.bucket_id
       and new.name = old.name
       and v_size <= public.storage_object_size (old.metadata) then
        return new;
    end if;

    v_owner := public.storage_object_owner (new.bucket_id, new.name);
    if v_owner is null then
        return new;
    end if;

    perform pg_advisory_xact_lock (hashtext('cleffy.storage_quota'), hashtext(v_owner::text));

    v_limit := public.storage_quota_bytes (public.resolve_entitlements (v_owner) ->> 'tier');

    -- Everything stored, less the object this write replaces (an upsert's
    -- existing row, or this row's own old version).
    v_used := public.storage_owner_bytes (v_owner) - coalesce((
        select sum(public.storage_object_size (o.metadata))
        from storage.objects o
        where o.bucket_id = new.bucket_id
          and o.name collate "C" = new.name collate "C"
    ), 0);

    -- A write with no size yet (the Storage API's policy test) is refused
    -- once nothing is left, so a full account fails before it uploads.
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

drop trigger if exists storage_objects_enforce_quota on storage.objects;

create trigger storage_objects_enforce_quota before insert or update on storage.objects
for each row execute function public.storage_objects_enforce_quota ();

-- ---------------------------------------------------------------------------
-- 2a. Superseded thumbnails: the cleanup ledger
-- ---------------------------------------------------------------------------
create table if not exists public.thumbnail_storage_cleanup (
    -- The object's name in the 'thumbnails' bucket: {document_id}/{rev}.jpg.
    object_name text primary key,
    -- No foreign keys, as document_storage_cleanup: the row must outlive a
    -- score deleted before its old covers were purged.
    document_id uuid not null,
    owner_id uuid not null,
    superseded_at timestamptz not null default now()
);

create index if not exists thumbnail_storage_cleanup_owner_idx on public.thumbnail_storage_cleanup (owner_id);

create index if not exists thumbnail_storage_cleanup_document_idx on public.thumbnail_storage_cleanup (document_id);

comment on table public.thumbnail_storage_cleanup is
    'Thumbnail objects a newer revision of the same score has replaced. The owner''s client removes them from the '
    'thumbnails bucket (thumbnailRemote.ts); removing an object deletes its row here.';

alter table public.thumbnail_storage_cleanup enable row level security;

-- The owner reads their own rows. Rows are written and removed only by the
-- triggers below, so no client can mark someone else's cover for removal.
drop policy if exists thumbnail_storage_cleanup_select on public.thumbnail_storage_cleanup;

create policy thumbnail_storage_cleanup_select on public.thumbnail_storage_cleanup for select to authenticated
using (owner_id = (select auth.uid ()));

revoke all on table public.thumbnail_storage_cleanup from public, anon, authenticated;
grant select on table public.thumbnail_storage_cleanup to authenticated;
grant all on table public.thumbnail_storage_cleanup to service_role;

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

    -- The revision just written is the latest, not a leftover.
    delete from public.thumbnail_storage_cleanup c where c.object_name = new.name;
    return null;
end;
$$;

revoke all on function public.thumbnails_record_superseded () from public, anon, authenticated;

drop trigger if exists thumbnails_record_superseded on storage.objects;

create trigger thumbnails_record_superseded after insert or delete on storage.objects
for each row execute function public.thumbnails_record_superseded ();

-- ---------------------------------------------------------------------------
-- 2b. What a client may write into a thumbnail folder
-- ---------------------------------------------------------------------------
-- True when `p_name` (already held to {uuid}/{rev}.jpg by 20261022100400) names
-- a revision between 0 and the score's content_rev (at most 1,000,000), and
-- its folder holds at most one OTHER object: the latest, which this write
-- replaces and the ledger above then marks for removal.
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
    if v_content_rev is null or v_rev > v_content_rev or v_rev > 1000000 then
        return false;
    end if;

    return (
        select count(*) <= 1
        from storage.objects o
        where o.bucket_id = 'thumbnails'
          and o.name collate "C" >= (v_folder || '/') collate "C"
          and o.name collate "C" < (v_folder || '0') collate "C"
          and o.name <> p_name
    );
end;
$$;

revoke all on function public.thumbnail_write_allowed (text) from public, anon;
grant execute on function public.thumbnail_write_allowed (text) to authenticated;

-- Restrictive, beside 20261022100400's name policies: ANDed with the
-- permissive owner policies, so it can only narrow them.
drop policy if exists thumbnails_revision_insert on storage.objects;

create policy thumbnails_revision_insert on storage.objects as restrictive for insert to authenticated
with check (bucket_id is distinct from 'thumbnails' or public.thumbnail_write_allowed (name));

drop policy if exists thumbnails_revision_update on storage.objects;

create policy thumbnails_revision_update on storage.objects as restrictive for update to authenticated
using (bucket_id is distinct from 'thumbnails' or public.thumbnail_write_allowed (name))
with check (bucket_id is distinct from 'thumbnails' or public.thumbnail_write_allowed (name));

-- ---------------------------------------------------------------------------
-- 2c. Covers already superseded before this migration
-- ---------------------------------------------------------------------------
-- In each live score's thumbnail folder, every object but the one to keep
-- goes on the ledger, so the owner's next library visit removes it. The one
-- kept is the published revision (documents.thumb_rev) when it is stored --
-- other devices download that one -- else the newest object.
insert into public.thumbnail_storage_cleanup (object_name, document_id, owner_id)
select o.name, d.id, d.owner_id
from storage.objects o
join public.documents d
  on o.name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
 and d.id = split_part(o.name, '/', 1)::uuid
where o.bucket_id = 'thumbnails'
  and o.name is distinct from coalesce(
      (select k.name from storage.objects k
       where k.bucket_id = 'thumbnails'
         and k.name collate "C" = (d.id::text || '/' || d.thumb_rev::text || '.jpg') collate "C"),
      (select k.name from storage.objects k
       where k.bucket_id = 'thumbnails'
         and k.name collate "C" >= (d.id::text || '/') collate "C"
         and k.name collate "C" < (d.id::text || '0') collate "C"
       order by k.created_at desc, k.name desc
       limit 1)
  )
on conflict (object_name) do nothing;
