-- Free-plan efficiency: shared Edge rate limits, RLS initplan, FK indexes,
-- and optional tombstone compaction.

-- ---------------------------------------------------------------------------
-- Shared rate-limit buckets (Edge Functions call via service role / RPC)
-- ---------------------------------------------------------------------------
create table public.edge_rate_buckets (
    key text primary key,
    count int not null,
    reset_at timestamptz not null
);

create or replace function public.check_edge_rate_limit (
    p_key text,
    p_limit int,
    p_window_ms int
) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    now_ts timestamptz := clock_timestamp();
    bucket public.edge_rate_buckets%rowtype;
    retry_sec int;
begin
    if p_limit < 1 or p_window_ms < 1 then
        return jsonb_build_object('ok', false, 'retryAfterSec', 1);
    end if;

    select * into bucket from public.edge_rate_buckets where key = p_key for update;
    if not found or bucket.reset_at <= now_ts then
        insert into public.edge_rate_buckets (key, count, reset_at)
        values (p_key, 1, now_ts + make_interval(secs => p_window_ms / 1000.0))
        on conflict (key) do update
            set count = 1,
                reset_at = excluded.reset_at;
        return jsonb_build_object('ok', true);
    end if;

    if bucket.count >= p_limit then
        retry_sec := greatest(1, ceil(extract(epoch from (bucket.reset_at - now_ts))));
        return jsonb_build_object('ok', false, 'retryAfterSec', retry_sec);
    end if;

    update public.edge_rate_buckets set count = count + 1 where key = p_key;
    return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.check_edge_rate_limit (text, int, int) from public;
grant execute on function public.check_edge_rate_limit (text, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- Batch annotation inserts (security invoker → RLS still applies)
-- ---------------------------------------------------------------------------
create or replace function public.insert_annotations_batch (p_rows jsonb) returns void language plpgsql security invoker
set search_path = public as $$
begin
    if jsonb_typeof(p_rows) is distinct from 'array' then
        raise exception 'p_rows must be a JSON array';
    end if;

    insert into public.annotations (
        id,
        document_id,
        page,
        kind,
        color,
        payload,
        created_by,
        created_at,
        deleted_at
    )
    select
        (elem ->> 'id')::uuid,
        (elem ->> 'document_id')::uuid,
        (elem ->> 'page')::int,
        elem ->> 'kind',
        elem ->> 'color',
        elem -> 'payload',
        (elem ->> 'created_by')::uuid,
        coalesce((elem ->> 'created_at')::timestamptz, now()),
        (elem ->> 'deleted_at')::timestamptz
    from jsonb_array_elements(p_rows) as elem
    on conflict (id) do nothing;
end;
$$;

revoke all on function public.insert_annotations_batch (jsonb) from public;
grant execute on function public.insert_annotations_batch (jsonb) to authenticated;

create or replace function public.patch_annotations_batch (p_patches jsonb) returns void language plpgsql security invoker
set search_path = public as $$
declare
    elem jsonb;
begin
    if jsonb_typeof(p_patches) is distinct from 'array' then
        raise exception 'p_patches must be a JSON array';
    end if;

    for elem in select value from jsonb_array_elements(p_patches)
    loop
        update public.annotations
        set
            color = coalesce(elem ->> 'color', color),
            payload = case when elem ? 'payload' then elem -> 'payload' else payload end,
            deleted_at = case
                when elem ? 'deleted_at' then (elem ->> 'deleted_at')::timestamptz
                else deleted_at
            end
        where id = (elem ->> 'id')::uuid
          and document_id = (elem ->> 'document_id')::uuid;
    end loop;
end;
$$;

revoke all on function public.patch_annotations_batch (jsonb) from public;
grant execute on function public.patch_annotations_batch (jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Tombstone compaction (call periodically or from a future cron)
-- ---------------------------------------------------------------------------
create or replace function public.compact_annotation_tombstones (p_older_than interval default interval '90 days')
returns int language plpgsql security definer
set search_path = public as $$
declare
    deleted_count int;
begin
    delete from public.annotations
    where deleted_at is not null
      and deleted_at < now() - p_older_than;
    get diagnostics deleted_count = row_count;
    return deleted_count;
end;
$$;

revoke all on function public.compact_annotation_tombstones (interval) from public;
grant execute on function public.compact_annotation_tombstones (interval) to service_role;

-- ---------------------------------------------------------------------------
-- RLS initplan: evaluate auth.* once per query
-- ---------------------------------------------------------------------------
drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents for select to authenticated
using (
    owner_id = (select auth.uid())
    or public.document_role (id) is not null
);

drop policy if exists documents_insert on public.documents;
create policy documents_insert on public.documents for insert to authenticated
with check (
    owner_id = (select auth.uid())
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
);

drop policy if exists documents_update on public.documents;
create policy documents_update on public.documents for update to authenticated
using (public.document_role (id) = 'owner')
with check (owner_id = (select auth.uid()));

drop policy if exists share_links_insert on public.share_links;
create policy share_links_insert on public.share_links for insert to authenticated
with check (
    public.document_role (document_id) = 'owner'
    and created_by = (select auth.uid())
);

drop policy if exists annotations_insert on public.annotations;
create policy annotations_insert on public.annotations for insert to authenticated
with check (
    public.document_role (document_id) in ('owner', 'editor')
    and created_by = (select auth.uid())
);

-- ---------------------------------------------------------------------------
-- Missing FK indexes (performance advisors)
-- ---------------------------------------------------------------------------
create index if not exists annotations_created_by_idx on public.annotations (created_by);
create index if not exists documents_owner_id_idx on public.documents (owner_id);
create index if not exists share_links_created_by_idx on public.share_links (created_by);
create index if not exists annotation_snapshots_created_by_idx on public.annotation_snapshots (created_by);
