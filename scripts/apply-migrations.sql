-- Combined migrations for the Supabase SQL editor (generated from supabase/migrations/*.sql)
-- Paste and run this whole file once in: Dashboard → SQL Editor → New query

-- ===== supabase/migrations/20260801160752_schema.sql =====
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

-- ===== supabase/migrations/20260801160754_rls.sql =====
-- Row Level Security: owner / editor / viewer via document_members.
-- Design notes (plan §RLS):
--  * document_role() is SECURITY DEFINER so policies never recurse into
--    document_members' own RLS.
--  * Editors may edit/erase ANYONE's annotations (the product requirement) —
--    but inserts must be attributed to the author (created_by = auth.uid()).
--  * No DELETE policy on annotations at all: deletes are tombstone updates.
--  * Anonymous users are role `authenticated` with an is_anonymous JWT claim;
--    they may join/annotate via share links but never create documents.

alter table public.documents enable row level security;

alter table public.document_members enable row level security;

alter table public.share_links enable row level security;

alter table public.annotations enable row level security;

create or replace function public.document_role (doc uuid) returns text language sql stable security definer
set search_path = public as $$
    select role from public.document_members
    where document_id = doc and user_id = auth.uid();
$$;

grant execute on function public.document_role (uuid) to authenticated;

-- documents ---------------------------------------------------------------
-- Owner is visible WITHOUT the membership join: during INSERT … RETURNING
-- (PostgREST return=representation) the AFTER-trigger membership row does not
-- exist yet, so a membership-only SELECT policy rejects the returned row.
create policy documents_select on public.documents for select to authenticated
using (
    owner_id = auth.uid()
    or public.document_role (id) is not null
);

create policy documents_insert on public.documents for insert to authenticated
with check (
    owner_id = auth.uid()
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
);

create policy documents_update on public.documents for update to authenticated
using (public.document_role (id) = 'owner')
with check (owner_id = auth.uid());

create policy documents_delete on public.documents for delete to authenticated
using (public.document_role (id) = 'owner');

-- document_members ----------------------------------------------------------
-- Members can see who else is on a document. NO direct write policies:
-- membership writes happen only via SECURITY DEFINER paths (owner trigger,
-- redeem_share_link).
create policy members_select on public.document_members for select to authenticated
using (public.document_role (document_id) is not null);

-- share_links ---------------------------------------------------------------
create policy share_links_select on public.share_links for select to authenticated
using (public.document_role (document_id) = 'owner');

create policy share_links_insert on public.share_links for insert to authenticated
with check (
    public.document_role (document_id) = 'owner'
    and created_by = auth.uid()
);

create policy share_links_update on public.share_links for update to authenticated
using (public.document_role (document_id) = 'owner');

create policy share_links_delete on public.share_links for delete to authenticated
using (public.document_role (document_id) = 'owner');

-- annotations ---------------------------------------------------------------
create policy annotations_select on public.annotations for select to authenticated
using (public.document_role (document_id) is not null);

create policy annotations_insert on public.annotations for insert to authenticated
with check (
    public.document_role (document_id) in ('owner', 'editor')
    and created_by = auth.uid()
);

create policy annotations_update on public.annotations for update to authenticated
using (public.document_role (document_id) in ('owner', 'editor'))
with check (public.document_role (document_id) in ('owner', 'editor'));

-- Share-link redemption -----------------------------------------------------
-- Never reads share_links under the caller's RLS; upserts membership without
-- ever downgrading an existing owner/editor role.
create or replace function public.redeem_share_link (p_token text) returns table (document_id uuid, granted_role text) language plpgsql security definer
set search_path = public as $$
-- OUT params (document_id) collide with column names inside the body (e.g.
-- the ON CONFLICT target) — let columns win; the OUTs are only set positionally.
#variable_conflict use_column
declare
    link record;
begin
    if auth.uid() is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    select sl.document_id, sl.role into link
    from public.share_links sl
    where sl.token = p_token
      and sl.revoked_at is null
      and (sl.expires_at is null or sl.expires_at > now());

    if not found then
        raise exception 'invalid or expired share link' using errcode = 'P0002';
    end if;

    insert into public.document_members (document_id, user_id, role)
    values (link.document_id, auth.uid(), link.role)
    on conflict (document_id, user_id) do update
        set role = case
            when public.document_members.role = 'owner' then 'owner'
            when public.document_members.role = 'editor' then 'editor'
            else excluded.role
        end;

    return query
        select link.document_id,
               (select dm.role from public.document_members dm
                where dm.document_id = link.document_id and dm.user_id = auth.uid());
end;
$$;

grant execute on function public.redeem_share_link (text) to authenticated;

-- storage: private 'scores' bucket; object path is '{documentId}/original.pdf'
-- (bucket itself is created via dashboard/API — hosted storage.buckets writes
-- from migrations can hit ownership errors post-lockdown).
create policy scores_read on storage.objects for select to authenticated
using (
    bucket_id = 'scores'
    and public.document_role (((storage.foldername (name))[1])::uuid) is not null
);

create policy scores_insert on storage.objects for insert to authenticated
with check (
    bucket_id = 'scores'
    and public.document_role (((storage.foldername (name))[1])::uuid) = 'owner'
);

create policy scores_update on storage.objects for update to authenticated
using (
    bucket_id = 'scores'
    and public.document_role (((storage.foldername (name))[1])::uuid) = 'owner'
);

create policy scores_delete on storage.objects for delete to authenticated
using (
    bucket_id = 'scores'
    and public.document_role (((storage.foldername (name))[1])::uuid) = 'owner'
);

-- ===== supabase/migrations/20260801162310_realtime.sql =====
-- Realtime: one private channel per document, topic 'doc:{documentId}'.
--  * Committed annotations fan out via broadcast-from-database (exactly-one
--    fan-out that also fires for offline flushes; no postgres_changes
--    per-subscriber overhead). Gap-fill on (re)connect is the watermark pull.
--  * Live in-progress ink + presence are client events on the same channel.
--  * realtime.messages policies mirror document membership; send is split by
--    extension so viewers appear in presence but can never broadcast ink.

-- Safe topic → role resolution ('doc:{uuid}' only; never throws on foreign topics).
create or replace function public.topic_document_role (topic text) returns text language plpgsql stable security definer
set search_path = public as $$
declare
    doc uuid;
begin
    if topic not like 'doc:%' then
        return null;
    end if;
    begin
        doc := split_part(topic, ':', 2)::uuid;
    exception when invalid_text_representation then
        return null;
    end;
    return public.document_role(doc);
end;
$$;

grant execute on function public.topic_document_role (text) to authenticated;

-- Broadcast every committed annotation write to the document's channel.
-- SECURITY DEFINER: the writing user has no direct insert grant on
-- realtime.messages — the documented broadcast_changes trigger pattern.
create or replace function public.broadcast_annotation_changes () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    perform realtime.broadcast_changes(
        'doc:' || new.document_id::text, -- topic
        tg_op,                           -- event name ('INSERT' | 'UPDATE')
        tg_op,                           -- operation
        tg_table_name,
        tg_table_schema,
        new,
        old
    );
    return null;
end;
$$;

create trigger annotations_broadcast after insert or update on public.annotations
for each row execute function public.broadcast_annotation_changes ();

-- Receive: any member of the document, both broadcast and presence.
create policy doc_topic_receive on realtime.messages for select to authenticated
using (public.topic_document_role (realtime.topic ()) is not null);

-- Send presence: any member (viewers must appear in the presence bar).
create policy doc_topic_send_presence on realtime.messages for insert to authenticated
with check (
    realtime.messages.extension = 'presence'
    and public.topic_document_role (realtime.topic ()) is not null
);

-- Send broadcast (live ink): editors and owners only.
create policy doc_topic_send_broadcast on realtime.messages for insert to authenticated
with check (
    realtime.messages.extension = 'broadcast'
    and public.topic_document_role (realtime.topic ()) in ('owner', 'editor')
);

-- ===== supabase/migrations/20260802032051_annotation_snapshots.sql =====
-- Daily annotation starting-point snapshots (lesson history).
-- One row per (document, local calendar day). Payload is the full live
-- annotation set captured before the first edit of that day.

create table public.annotation_snapshots (
    id uuid primary key,
    document_id uuid not null references public.documents (id) on delete cascade,
    captured_on date not null,
    label text,
    payload jsonb not null,
    created_at timestamptz not null default now(),
    created_by uuid references auth.users (id) on delete set null,
    unique (document_id, captured_on)
);

create index annotation_snapshots_doc_day on public.annotation_snapshots (document_id, captured_on desc);

alter table public.annotation_snapshots enable row level security;

create policy annotation_snapshots_select on public.annotation_snapshots for select to authenticated
using (public.document_role (document_id) is not null);

create policy annotation_snapshots_insert on public.annotation_snapshots for insert to authenticated
with check (public.document_role (document_id) in ('owner', 'editor'));

-- Snapshots are immutable starting points — no update/delete policies.

-- ===== supabase/migrations/20260802044133_free_plan_efficiency.sql =====
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

-- ===== supabase/migrations/20260802045146_batch_rpc_revoke_public.sql =====
-- Harden batch annotation RPCs: revoke PUBLIC (and anon) before authenticated grant.
-- Matches check_edge_rate_limit / compact_annotation_tombstones pattern.

revoke all on function public.insert_annotations_batch (jsonb) from public;
revoke all on function public.insert_annotations_batch (jsonb) from anon;
grant execute on function public.insert_annotations_batch (jsonb) to authenticated;

revoke all on function public.patch_annotations_batch (jsonb) from public;
revoke all on function public.patch_annotations_batch (jsonb) from anon;
grant execute on function public.patch_annotations_batch (jsonb) to authenticated;

-- ===== supabase/migrations/20260802110000_document_favorites.sql =====
-- Per-user favorites. A flag on documents would be shared state (a student's
-- star would flip the owner's), so favorites are their own RLS-scoped table.
create table public.document_favorites (
    document_id uuid not null references public.documents (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (document_id, user_id)
);

create index document_favorites_user on public.document_favorites (user_id);

alter table public.document_favorites enable row level security;

create policy favorites_select on public.document_favorites for select to authenticated
using (user_id = auth.uid());

create policy favorites_insert on public.document_favorites for insert to authenticated
with check (
    user_id = auth.uid()
    and public.document_role (document_id) is not null
);

create policy favorites_delete on public.document_favorites for delete to authenticated
using (user_id = auth.uid());

-- ===== supabase/migrations/20260802172000_edge_rate_rls_and_revoke_execute.sql =====
-- Log-hardening: RLS on edge_rate_buckets + revoke EXECUTE on trigger-only /
-- service-only defs; harden client RPCs like batch_rpc_revoke_public.

-- ---------------------------------------------------------------------------
-- edge_rate_buckets: service-role / SECURITY DEFINER only (no client access)
-- ---------------------------------------------------------------------------
alter table public.edge_rate_buckets enable row level security;

revoke all on table public.edge_rate_buckets from public;
revoke all on table public.edge_rate_buckets from anon;
revoke all on table public.edge_rate_buckets from authenticated;

-- ---------------------------------------------------------------------------
-- Trigger-only functions: must not be callable via /rest/v1/rpc
-- ---------------------------------------------------------------------------
revoke all on function public.annotations_stamp () from public;
revoke all on function public.annotations_stamp () from anon;
revoke all on function public.annotations_stamp () from authenticated;

revoke all on function public.documents_owner_membership () from public;
revoke all on function public.documents_owner_membership () from anon;
revoke all on function public.documents_owner_membership () from authenticated;

revoke all on function public.broadcast_annotation_changes () from public;
revoke all on function public.broadcast_annotation_changes () from anon;
revoke all on function public.broadcast_annotation_changes () from authenticated;

-- ---------------------------------------------------------------------------
-- Service-only RPCs: belt-and-suspenders revoke from client roles
-- ---------------------------------------------------------------------------
revoke all on function public.check_edge_rate_limit (text, int, int) from anon;
revoke all on function public.check_edge_rate_limit (text, int, int) from authenticated;

revoke all on function public.compact_annotation_tombstones (interval) from anon;
revoke all on function public.compact_annotation_tombstones (interval) from authenticated;

-- ---------------------------------------------------------------------------
-- Client RPCs: revoke PUBLIC/anon, keep authenticated (incl. anonymous users)
-- ---------------------------------------------------------------------------
revoke all on function public.document_role (uuid) from public;
revoke all on function public.document_role (uuid) from anon;
grant execute on function public.document_role (uuid) to authenticated;

revoke all on function public.topic_document_role (text) from public;
revoke all on function public.topic_document_role (text) from anon;
grant execute on function public.topic_document_role (text) to authenticated;

revoke all on function public.redeem_share_link (text) from public;
revoke all on function public.redeem_share_link (text) from anon;
grant execute on function public.redeem_share_link (text) to authenticated;

