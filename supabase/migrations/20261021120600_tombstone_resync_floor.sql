-- Tombstone compaction: a device that missed a compacted deletion resyncs.
--
-- Devices pull annotations by watermark (seq). A deletion reaches a device as
-- its tombstone, a row with deleted_at set and a newer seq. Compaction
-- (compact_annotation_tombstones, weekly since 20261021120300) hard-deletes
-- tombstones after 90 days, so a device that last synced before a mark was
-- deleted and comes back after its tombstone is compacted pulls nothing for
-- that mark and keeps drawing it for good — including marks Delete student
-- scrubbed.
--
-- So compaction now leaves a floor per score: the highest seq it removed
-- there. A device whose watermark is below a score's floor may have missed a
-- deletion it can no longer learn about, and the server says so
-- (annotation_resync_floor): the device then pulls the score's whole current
-- set and drops every synced mark the server no longer has
-- (SyncEngine.pullOnce). A device at or past the floor saw every compacted
-- tombstone before it went, and pulls by watermark as before.

create table if not exists public.annotation_sync_floors (
    document_id uuid primary key references public.documents (id) on delete cascade,
    floor_seq bigint not null,
    compacted_at timestamptz not null default now()
);

comment on table public.annotation_sync_floors is
'Per score, the highest annotation seq tombstone compaction has removed. A device whose sync watermark is below it must resync in full.';

alter table public.annotation_sync_floors enable row level security;

revoke all on table public.annotation_sync_floors from public, anon, authenticated;

grant all on table public.annotation_sync_floors to service_role;

-- What a member of the score is told: its floor, or 0 when nothing there was
-- ever compacted. Null for anyone who cannot read the score at all, the same
-- answer as for a score that does not exist.
create or replace function public.annotation_resync_floor (p_document uuid) returns bigint language sql stable
security definer
set search_path = public as $$
    select case
        when public.document_role (p_document) is null then null
        else coalesce((select f.floor_seq from public.annotation_sync_floors f where f.document_id = p_document), 0)
    end;
$$;

revoke all on function public.annotation_resync_floor (uuid) from public, anon;
grant execute on function public.annotation_resync_floor (uuid) to authenticated;

-- Same signature, defaults and grants as 20260802044133; it now records each
-- score's floor in the statement that removes the tombstones.
create or replace function public.compact_annotation_tombstones (p_older_than interval default interval '90 days')
returns int language plpgsql security definer
set search_path = public as $$
declare
    deleted_count int;
begin
    with gone as (
        delete from public.annotations
        where deleted_at is not null
          and deleted_at < now() - p_older_than
        returning document_id, seq
    ),
    floors as (
        insert into public.annotation_sync_floors (document_id, floor_seq, compacted_at)
        select g.document_id, max(g.seq), now()
        from gone g
        where exists (select 1 from public.documents d where d.id = g.document_id)
        group by g.document_id
        on conflict (document_id) do update
        set floor_seq = greatest(public.annotation_sync_floors.floor_seq, excluded.floor_seq),
            compacted_at = excluded.compacted_at
        returning 1
    )
    select count(*) into deleted_count from gone;
    return deleted_count;
end;
$$;

revoke all on function public.compact_annotation_tombstones (interval) from public, anon, authenticated;
grant execute on function public.compact_annotation_tombstones (interval) to service_role;
