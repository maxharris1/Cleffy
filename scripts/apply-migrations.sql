-- Combined migrations for the Supabase SQL editor (generated from supabase/migrations/*.sql)

-- Paste and run this whole file once in: Dashboard → SQL Editor → New query
-- Catalog inserts (*_imslp_works_catalog.sql) are omitted: they exceed the SQL editor
-- paste limit. Apply those with `npx supabase db push` or `psql -f`.

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

-- ===== supabase/migrations/20260802172249_edge_rate_rls_and_revoke_execute.sql =====
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

-- ===== supabase/migrations/20260802180000_smart_import.sql =====
-- Smart import: adopt pre-existing handwritten annotations as native marks.
--
-- content_rev: documents' PDF bytes were immutable until now. The import
-- flow can replace the stored file with a cleaned copy; content_rev lets
-- clients detect a stale Dexie pdfCache (cache stores the rev it holds).
alter table public.documents
add column content_rev int not null default 0;

-- One row per document tracking the import offer/decision, so a declined
-- prompt never nags again across devices, and the backup object is findable.
create table public.document_imports (
    document_id uuid primary key references public.documents (id) on delete cascade,
    status text not null check (status in ('prompted', 'declined', 'imported')),
    backup_path text, -- '{id}/pre-import-original.pdf' once a clean+replace ran
    pages_cleaned int[] not null default '{}',
    created_by uuid references auth.users (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- Fan the replacement out to open viewers on the existing per-doc topic
-- (same mechanism as annotations_broadcast). Gated on content_rev so
-- renames/page-count patches don't generate realtime traffic.
create or replace function public.broadcast_document_changes () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    perform realtime.broadcast_changes(
        'doc:' || new.id::text, -- topic
        tg_op, tg_op, tg_table_name, tg_table_schema, new, old
    );
    return null;
end;
$$;

create trigger documents_broadcast
after update on public.documents for each row
when (old.content_rev is distinct from new.content_rev)
execute function public.broadcast_document_changes ();

alter table public.document_imports enable row level security;

create policy document_imports_select on public.document_imports for select to authenticated
using (public.document_role (document_id) is not null);

create policy document_imports_insert on public.document_imports for insert to authenticated
with check (public.document_role (document_id) = 'owner');

create policy document_imports_update on public.document_imports for update to authenticated
using (public.document_role (document_id) = 'owner')
with check (public.document_role (document_id) = 'owner');

-- ===== supabase/migrations/20260802182000_library_tags.sql =====
-- Per-user library tags (labels). Personal organization — not shared across
-- document collaborators, same rationale as document_favorites.

create table public.library_tags (
    id uuid primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    name text not null,
    created_at timestamptz not null default now(),
    constraint library_tags_name_nonempty check (length(trim(name)) > 0)
);

create unique index library_tags_user_name_lower on public.library_tags (user_id, lower(name));
create index library_tags_user on public.library_tags (user_id);

create table public.document_tags (
    document_id uuid not null references public.documents (id) on delete cascade,
    tag_id uuid not null references public.library_tags (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (document_id, tag_id)
);

create index document_tags_tag on public.document_tags (tag_id);

alter table public.library_tags enable row level security;
alter table public.document_tags enable row level security;

create policy library_tags_select on public.library_tags for select to authenticated
using (user_id = (select auth.uid()));

create policy library_tags_insert on public.library_tags for insert to authenticated
with check (user_id = (select auth.uid()));

create policy library_tags_update on public.library_tags for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy library_tags_delete on public.library_tags for delete to authenticated
using (user_id = (select auth.uid()));

create policy document_tags_select on public.document_tags for select to authenticated
using (
    exists (
        select 1
        from public.library_tags t
        where t.id = tag_id
          and t.user_id = (select auth.uid())
    )
);

create policy document_tags_insert on public.document_tags for insert to authenticated
with check (
    exists (
        select 1
        from public.library_tags t
        where t.id = tag_id
          and t.user_id = (select auth.uid())
    )
    and public.document_role (document_id) is not null
);

create policy document_tags_delete on public.document_tags for delete to authenticated
using (
    exists (
        select 1
        from public.library_tags t
        where t.id = tag_id
          and t.user_id = (select auth.uid())
    )
);

-- ===== supabase/migrations/20260803000000_score_analyses.sql =====
-- Play-along score analyses: one row per document holding the OMR-derived
-- ScoreData (note events split by hand + measure/system geometry in
-- normalized page coordinates) and its processing lifecycle. The row is
-- created 'pending' by the score-analyze Edge Function on behalf of the
-- caller; the OMR service (service role, bypasses RLS) heartbeats
-- 'processing' progress and writes the terminal 'ready'/'failed' state.

create table public.score_analyses (
    document_id uuid primary key references public.documents (id) on delete cascade,
    status text not null check (status in ('pending', 'processing', 'ready', 'failed')),
    error text, -- machine code, e.g. 'omr_timeout', 'no_staves_found' (see services/omr-service/src/errors.ts)
    progress int, -- pages processed so far (service heartbeat; also refreshes updated_at for staleness checks)
    engine_version text,
    bpm_default int,
    score jsonb, -- ScoreData v1 (src/types/scoreData.ts); null until ready
    created_by uuid references auth.users (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create trigger score_analyses_touch before update on public.score_analyses
for each row execute function public.touch_updated_at ();

alter table public.score_analyses enable row level security;

-- Any member may read (viewers can play along); only owner/editor may
-- request or retry an analysis. No delete policy — rows die with the
-- document via the FK cascade.
create policy score_analyses_select on public.score_analyses for select to authenticated
using (public.document_role (document_id) is not null);

create policy score_analyses_insert on public.score_analyses for insert to authenticated
with check (
    public.document_role (document_id) in ('owner', 'editor')
    and created_by = (select auth.uid())
);

create policy score_analyses_update on public.score_analyses for update to authenticated
using (public.document_role (document_id) in ('owner', 'editor'))
with check (public.document_role (document_id) in ('owner', 'editor'));

-- New tables are no longer auto-exposed to the Data API on current projects
-- (see auto_expose_new_tables note in supabase/config.toml) — grant explicitly.
grant select, insert, update on public.score_analyses to authenticated;
grant all on public.score_analyses to service_role;

-- ===== supabase/migrations/20260803120000_score_analyses_write_guard.sql =====
-- Clients (owner/editor via user JWT, including score-analyze) may only
-- request/retry analyses. They must not forge status='ready' or write ScoreData.
-- The OMR service uses the service_role JWT and retains full write access.

create or replace function public.guard_score_analyses_client_write()
returns trigger
language plpgsql
as $$
begin
    -- Service role (OMR write-back) may write any lifecycle fields.
    if coalesce(auth.jwt() ->> 'role', '') = 'service_role' then
        return new;
    end if;

    if tg_op = 'INSERT' then
        if new.status not in ('pending', 'failed') then
            raise exception 'score_analyses: clients may only insert pending or failed';
        end if;
        if new.score is not null then
            raise exception 'score_analyses: clients may not write score';
        end if;
        if new.status = 'pending' then
            new.score := null;
            new.progress := null;
            new.engine_version := null;
            new.bpm_default := null;
        end if;
        return new;
    end if;

    -- UPDATE: request/retry only.
    if new.status not in ('pending', 'failed') then
        raise exception 'score_analyses: clients may only set pending or failed';
    end if;
    if new.score is not null then
        raise exception 'score_analyses: clients may not write score';
    end if;
    -- Preserve original requester attribution across retries.
    new.created_by := old.created_by;
    if new.status = 'pending' then
        new.score := null;
        new.progress := null;
        new.error := null;
        new.engine_version := null;
        new.bpm_default := null;
    end if;
    return new;
end;
$$;

drop trigger if exists score_analyses_client_write_guard on public.score_analyses;
create trigger score_analyses_client_write_guard
before insert or update on public.score_analyses
for each row
execute function public.guard_score_analyses_client_write();

-- ===== supabase/migrations/20260803130000_set_document_page_count.sql =====
-- Allow owners and editors to backfill a missing documents.page_count
-- (needed before score-analyze). Does not overwrite an existing positive count.

create or replace function public.set_document_page_count (doc uuid, pages int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if pages is null or pages < 1 then
        raise exception 'invalid page count';
    end if;
    if public.document_role (doc) is distinct from 'owner'
        and public.document_role (doc) is distinct from 'editor' then
        raise exception 'forbidden';
    end if;
    update public.documents
    set page_count = pages
    where id = doc
      and (page_count is null or page_count < 1);
end;
$$;

revoke all on function public.set_document_page_count (uuid, int) from public;
grant execute on function public.set_document_page_count (uuid, int) to authenticated;

-- ===== supabase/migrations/20260806110000_score_cache_timings.sql =====
-- Content-hash result cache + timings column on score_analyses.
-- ENGINE_VERSION key invalidates cache automatically on parser/engine bumps.

alter table public.score_analyses
add column if not exists timings jsonb;

create table public.score_cache (
    content_hash text not null,
    engine_version text not null,
    score jsonb not null,
    bpm_default int,
    created_at timestamptz not null default now(),
    last_used_at timestamptz not null default now(),
    use_count int not null default 1,
    primary key (content_hash, engine_version)
);

alter table public.score_cache enable row level security;
-- Zero policies — service_role only.
grant all on public.score_cache to service_role;

create or replace function public.score_cache_get (p_hash text, p_engine_version text)
returns table (score jsonb, bpm_default int)
language plpgsql
security definer
set search_path = public
as $$
begin
    return query
    update public.score_cache sc
    set last_used_at = now(), use_count = sc.use_count + 1
    where sc.content_hash = p_hash
      and sc.engine_version = p_engine_version
    returning sc.score, sc.bpm_default;
end;
$$;

create or replace function public.score_cache_put (
    p_hash text,
    p_engine_version text,
    p_score jsonb,
    p_bpm_default int
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.score_cache (content_hash, engine_version, score, bpm_default)
    values (p_hash, p_engine_version, p_score, p_bpm_default)
    on conflict (content_hash, engine_version) do update
    set
        score = excluded.score,
        bpm_default = excluded.bpm_default,
        last_used_at = now(),
        use_count = public.score_cache.use_count + 1;
end;
$$;

create or replace function public.score_cache_purge_stale (p_max_age_days int default 180)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    deleted int;
begin
    delete from public.score_cache
    where last_used_at < now() - make_interval(days => greatest(p_max_age_days, 1));
    get diagnostics deleted = row_count;
    return deleted;
end;
$$;

revoke all on function public.score_cache_get (text, text) from public, anon, authenticated;
revoke all on function public.score_cache_put (text, text, jsonb, int) from public, anon, authenticated;
revoke all on function public.score_cache_purge_stale (int) from public, anon, authenticated;
grant execute on function public.score_cache_get (text, text) to service_role;
grant execute on function public.score_cache_put (text, text, jsonb, int) to service_role;
grant execute on function public.score_cache_purge_stale (int) to service_role;

-- ===== supabase/migrations/20260806120000_omr_jobs.sql =====
-- Durable OMR job queue (service-role only). score_analyses stays the
-- client-facing status projection / result cache; workers claim rows here
-- with FOR UPDATE SKIP LOCKED and never put leases on score_analyses.

create table public.omr_jobs (
    id bigint generated always as identity primary key,
    document_id uuid not null references public.documents (id) on delete cascade,
    status text not null default 'queued'
        check (status in ('queued', 'running', 'succeeded', 'failed_permanent', 'dead')),
    priority smallint not null default 0,
    attempt int not null default 0,
    max_attempts int not null default 3,
    run_after timestamptz not null default now(),
    claimed_at timestamptz,
    worker_id text,
    lease_expires_at timestamptz,
    storage_path text not null,
    page_count int not null,
    last_error text,
    created_by uuid references auth.users (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index omr_jobs_one_active_per_doc
    on public.omr_jobs (document_id)
    where status in ('queued', 'running');

create index omr_jobs_claim_idx
    on public.omr_jobs (priority desc, id)
    where status = 'queued';

create trigger omr_jobs_touch before update on public.omr_jobs
for each row execute function public.touch_updated_at ();

alter table public.omr_jobs enable row level security;
-- Zero policies for authenticated — service_role only.
grant all on public.omr_jobs to service_role;
grant usage, select on sequence public.omr_jobs_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- Claim / heartbeat / complete / fail / reap
-- ---------------------------------------------------------------------------

create or replace function public.omr_claim_job (p_worker_id text, p_lease_seconds int default 300)
returns public.omr_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
    claimed public.omr_jobs;
begin
    if p_worker_id is null or length(trim(p_worker_id)) = 0 then
        raise exception 'omr_claim_job: worker_id required';
    end if;

    select *
    into claimed
    from public.omr_jobs
    where status = 'queued'
      and run_after <= now()
    order by priority desc, id
    for update skip locked
    limit 1;

    if claimed.id is null then
        return null;
    end if;

    update public.omr_jobs
    set
        status = 'running',
        attempt = claimed.attempt + 1,
        claimed_at = now(),
        worker_id = p_worker_id,
        lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 60)),
        last_error = null
    where id = claimed.id
    returning * into claimed;

    return claimed;
end;
$$;

create or replace function public.omr_heartbeat_job (
    p_job_id bigint,
    p_worker_id text,
    p_lease_seconds int default 300
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    updated int;
begin
    update public.omr_jobs
    set lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 60))
    where id = p_job_id
      and status = 'running'
      and worker_id = p_worker_id;
    get diagnostics updated = row_count;
    return updated > 0;
end;
$$;

-- Atomic success: job succeeded + score_analyses ready in one transaction.
create or replace function public.omr_complete_job (
    p_job_id bigint,
    p_worker_id text,
    p_score jsonb,
    p_bpm_default int,
    p_engine_version text,
    p_timings jsonb default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    job public.omr_jobs;
    updated int;
begin
    update public.omr_jobs
    set
        status = 'succeeded',
        worker_id = null,
        lease_expires_at = null,
        last_error = null
    where id = p_job_id
      and status = 'running'
      and worker_id = p_worker_id
    returning * into job;
    get diagnostics updated = row_count;
    if updated = 0 then
        return false;
    end if;

    insert into public.score_analyses as sa (
        document_id,
        status,
        error,
        progress,
        engine_version,
        bpm_default,
        score,
        timings,
        created_by,
        updated_at
    )
    values (
        job.document_id,
        'ready',
        null,
        null,
        p_engine_version,
        p_bpm_default,
        p_score,
        p_timings,
        job.created_by,
        now()
    )
    on conflict (document_id) do update
    set
        status = excluded.status,
        error = null,
        progress = null,
        engine_version = excluded.engine_version,
        bpm_default = excluded.bpm_default,
        score = excluded.score,
        timings = excluded.timings,
        updated_at = now();

    return true;
end;
$$;

-- Shared requeue / terminal failure used by omr_fail_job and the reaper.
create or replace function public.omr_apply_failure (
    p_job_id bigint,
    p_error text,
    p_permanent boolean
) returns text -- resulting status
language plpgsql
security definer
set search_path = public
as $$
declare
    job public.omr_jobs;
    next_status text;
    backoff_secs int;
begin
    select * into job from public.omr_jobs where id = p_job_id for update;
    if job.id is null then
        return null;
    end if;

    if p_permanent or job.attempt >= job.max_attempts then
        next_status := case when p_permanent then 'failed_permanent' else 'dead' end;
        update public.omr_jobs
        set
            status = next_status,
            last_error = p_error,
            worker_id = null,
            lease_expires_at = null,
            claimed_at = null
        where id = p_job_id;

        insert into public.score_analyses as sa (
            document_id, status, error, progress, score, timings, created_by, updated_at
        )
        values (
            job.document_id, 'failed', p_error, null, null, null, job.created_by, now()
        )
        on conflict (document_id) do update
        set
            status = 'failed',
            error = excluded.error,
            progress = null,
            score = null,
            timings = null,
            engine_version = null,
            bpm_default = null,
            updated_at = now();
    else
        -- Transient: requeue with exponential backoff 60s / 5min / 15min.
        backoff_secs := least(900, 60 * power(5, greatest(job.attempt - 1, 0))::int);
        next_status := 'queued';
        update public.omr_jobs
        set
            status = 'queued',
            last_error = p_error,
            worker_id = null,
            lease_expires_at = null,
            claimed_at = null,
            run_after = now() + make_interval(secs => backoff_secs)
        where id = p_job_id;

        update public.score_analyses
        set status = 'pending', error = null, progress = null, updated_at = now()
        where document_id = job.document_id;
    end if;

    return next_status;
end;
$$;

create or replace function public.omr_fail_job (
    p_job_id bigint,
    p_worker_id text,
    p_error text,
    p_permanent boolean
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    owned int;
begin
    update public.omr_jobs
    set updated_at = now() -- touch so we know we still own it
    where id = p_job_id
      and status = 'running'
      and worker_id = p_worker_id;
    get diagnostics owned = row_count;
    if owned = 0 then
        return null;
    end if;
    return public.omr_apply_failure (p_job_id, p_error, p_permanent);
end;
$$;

-- Reap expired leases; touch score_analyses.updated_at for live queued/running
-- rows so the client's 20-min staleness rule does not false-fail deep backlogs.
-- Returns count of jobs currently queued (for the sweeper poke decision).
create or replace function public.omr_reap_expired_leases ()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    expired record;
    queued_count int;
begin
    for expired in
        select id
        from public.omr_jobs
        where status = 'running'
          and lease_expires_at is not null
          and lease_expires_at < now()
        for update skip locked
    loop
        perform public.omr_apply_failure (expired.id, 'worker_lost', false);
    end loop;

    -- Keep-alive for client staleness: only updated_at (status/progress unchanged
    -- → realtime trigger stays silent under IS DISTINCT FROM gate).
    update public.score_analyses sa
    set updated_at = now()
    where exists (
        select 1
        from public.omr_jobs j
        where j.document_id = sa.document_id
          and j.status in ('queued', 'running')
    )
    and sa.status in ('pending', 'processing');

    select count(*)::int into queued_count
    from public.omr_jobs
    where status = 'queued'
      and run_after <= now();

    return queued_count;
end;
$$;

-- Per-user active backlog count for admission control.
create or replace function public.omr_user_active_job_count (p_user_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
    select count(*)::int
    from public.omr_jobs
    where created_by = p_user_id
      and status in ('queued', 'running');
$$;

revoke all on function public.omr_claim_job (text, int) from public, anon, authenticated;
revoke all on function public.omr_heartbeat_job (bigint, text, int) from public, anon, authenticated;
revoke all on function public.omr_complete_job (bigint, text, jsonb, int, text, jsonb) from public, anon, authenticated;
revoke all on function public.omr_apply_failure (bigint, text, boolean) from public, anon, authenticated;
revoke all on function public.omr_fail_job (bigint, text, text, boolean) from public, anon, authenticated;
revoke all on function public.omr_reap_expired_leases () from public, anon, authenticated;
revoke all on function public.omr_user_active_job_count (uuid) from public, anon, authenticated;

grant execute on function public.omr_claim_job (text, int) to service_role;
grant execute on function public.omr_heartbeat_job (bigint, text, int) to service_role;
grant execute on function public.omr_complete_job (bigint, text, jsonb, int, text, jsonb) to service_role;
grant execute on function public.omr_apply_failure (bigint, text, boolean) to service_role;
grant execute on function public.omr_fail_job (bigint, text, text, boolean) to service_role;
grant execute on function public.omr_reap_expired_leases () to service_role;
grant execute on function public.omr_user_active_job_count (uuid) to service_role;
-- Edge function uses service-role for the cap check too.

-- ===== supabase/migrations/20260806130000_score_analyses_broadcast.sql =====
-- Trimmed score_analyses lifecycle fan-out on the existing doc:{id} topic.
-- Never broadcast the score jsonb — only status/error/progress/updated_at.
-- Gate inside the function (INSERT triggers cannot reference OLD in WHEN).

create or replace function public.broadcast_score_analysis_changes () returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if tg_op = 'UPDATE'
       and old.status is not distinct from new.status
       and old.progress is not distinct from new.progress then
        return null;
    end if;

    perform realtime.send(
        jsonb_build_object(
            'table', 'score_analyses',
            'document_id', new.document_id,
            'status', new.status,
            'error', new.error,
            'progress', new.progress,
            'updated_at', new.updated_at
        ),
        'score_analysis', -- event
        'doc:' || new.document_id::text, -- topic
        true -- private
    );
    return null;
end;
$$;

drop trigger if exists score_analyses_broadcast on public.score_analyses;
create trigger score_analyses_broadcast
after insert or update on public.score_analyses
for each row
execute function public.broadcast_score_analysis_changes ();

-- ===== supabase/migrations/20260806140000_omr_cron.sql =====
-- OMR sweeper: enable pg_cron + pg_net, reap expired leases, wake workers.
-- Vault secrets omr_service_url / omr_service_secret must be created out-of-band
-- (see SETUP_SUPABASE.md). If missing, the poke is a no-op; reap still runs.
--
-- Day-one check (2026-08-06): pg_cron 1.6.4 and pg_net 0.20.4 available but
-- not installed; supabase_vault already installed. Enabling both here.
-- Fallback if enable fails on a future project: Cloud Scheduler → POST /poke
-- and have the worker call omr_reap_expired_leases() at the top of each poke.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create or replace function public.omr_sweep ()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
    queued int;
    svc_url text;
    svc_secret text;
begin
    queued := public.omr_reap_expired_leases ();
    perform public.score_cache_purge_stale (180);

    if queued is null or queued <= 0 then
        return;
    end if;

    select decrypted_secret into svc_url
    from vault.decrypted_secrets
    where name = 'omr_service_url'
    limit 1;

    select decrypted_secret into svc_secret
    from vault.decrypted_secrets
    where name = 'omr_service_secret'
    limit 1;

    if svc_url is null or svc_secret is null or length(trim(svc_url)) = 0 then
        raise notice 'omr_sweep: vault secrets omr_service_url/omr_service_secret missing — skip poke';
        return;
    end if;

    perform net.http_post(
        url := rtrim(svc_url, '/') || '/poke',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-omr-secret', svc_secret
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 5000
    );
end;
$$;

revoke all on function public.omr_sweep () from public, anon, authenticated;
grant execute on function public.omr_sweep () to service_role;

-- Schedule every minute. Unschedule prior job of the same name if re-applied.
do $$
begin
    perform cron.unschedule (jobid)
    from cron.job
    where jobname = 'omr-sweep';
exception
    when undefined_table then null;
    when others then null;
end;
$$;

select cron.schedule ('omr-sweep', '* * * * *', $$select public.omr_sweep ()$$);

-- ===== supabase/migrations/20260806150000_omr_enqueue_and_fail_policy.sql =====
-- Atomic enqueue + SQL-owned retry permanence (review fixes).

-- Permanence policy lives here only (mirrors services/omr-service/src/errors.ts tests).
create or replace function public.omr_error_is_permanent (p_error text, p_attempt int)
returns boolean
language sql
immutable
as $$
    select case
        when p_error in (
            'too_large', 'page_count_unknown', 'no_staves_found',
            'musicxml_parse_failed', 'backlog_full'
        ) then true
        when p_error in ('omr_crash', 'omr_timeout') then p_attempt >= 2
        else false
    end;
$$;

-- Fail without client-supplied permanence; SQL decides.
create or replace function public.omr_fail_job (
    p_job_id bigint,
    p_worker_id text,
    p_error text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    owned int;
    job public.omr_jobs;
begin
    update public.omr_jobs
    set updated_at = now()
    where id = p_job_id
      and status = 'running'
      and worker_id = p_worker_id
    returning * into job;
    get diagnostics owned = row_count;
    if owned = 0 then
        return null;
    end if;
    return public.omr_apply_failure (
        p_job_id,
        p_error,
        public.omr_error_is_permanent (p_error, job.attempt)
    );
end;
$$;

revoke all on function public.omr_fail_job (bigint, text, text, boolean) from public, anon, authenticated, service_role;
drop function if exists public.omr_fail_job (bigint, text, text, boolean);

revoke all on function public.omr_fail_job (bigint, text, text) from public, anon, authenticated;
grant execute on function public.omr_fail_job (bigint, text, text) to service_role;
grant execute on function public.omr_error_is_permanent (text, int) to service_role;

-- Cap + pending upsert + job insert in one transaction.
create or replace function public.omr_enqueue_job (
    p_document_id uuid,
    p_user_id uuid,
    p_storage_path text,
    p_page_count int,
    p_cap int default 10
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    active_count int;
    inserted_id bigint;
begin
    -- Clear zombie running rows before admission so Generate is not blocked
    -- for a full lease after a worker crash.
    perform public.omr_reap_expired_leases();

    perform pg_advisory_xact_lock (hashtext('omr_enqueue:' || p_user_id::text));

    select count(*)::int into active_count
    from public.omr_jobs
    where created_by = p_user_id
      and status in ('queued', 'running');

    if active_count >= p_cap then
        return jsonb_build_object('ok', false, 'code', 'backlog_full');
    end if;

    if exists (
        select 1 from public.omr_jobs
        where document_id = p_document_id
          and status in ('queued', 'running')
    ) then
        return jsonb_build_object('ok', false, 'code', 'already_running');
    end if;

    insert into public.score_analyses as sa (
        document_id, created_by, status, progress, error, score, updated_at
    )
    values (
        p_document_id, p_user_id, 'pending', null, null, null, now()
    )
    on conflict (document_id) do update
    set
        status = 'pending',
        progress = null,
        error = null,
        score = null,
        engine_version = null,
        bpm_default = null,
        timings = null,
        updated_at = now();

    begin
        insert into public.omr_jobs (
            document_id, status, storage_path, page_count, created_by, priority
        )
        values (
            p_document_id, 'queued', p_storage_path, p_page_count, p_user_id, 0
        )
        returning id into inserted_id;
    exception
        when unique_violation then
            return jsonb_build_object('ok', false, 'code', 'already_running');
    end;

    return jsonb_build_object('ok', true, 'code', 'queued', 'job_id', inserted_id);
end;
$$;

revoke all on function public.omr_enqueue_job (uuid, uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.omr_enqueue_job (uuid, uuid, text, int, int) to service_role;

-- ===== supabase/migrations/20260806160000_omr_enqueue_persist_backlog_full.sql =====
-- Persist backlog_full onto score_analyses so client remount/rehydrate still
-- shows the admission rejection (without clobbering an existing ready analysis).

create or replace function public.omr_enqueue_job (
    p_document_id uuid,
    p_user_id uuid,
    p_storage_path text,
    p_page_count int,
    p_cap int default 10
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    active_count int;
    inserted_id bigint;
begin
    -- Clear zombie running rows before admission so Generate is not blocked
    -- for a full lease after a worker crash.
    perform public.omr_reap_expired_leases();

    perform pg_advisory_xact_lock (hashtext('omr_enqueue:' || p_user_id::text));

    select count(*)::int into active_count
    from public.omr_jobs
    where created_by = p_user_id
      and status in ('queued', 'running');

    if active_count >= p_cap then
        insert into public.score_analyses as sa (
            document_id, created_by, status, progress, error, score, updated_at
        )
        values (
            p_document_id, p_user_id, 'failed', null, 'backlog_full', null, now()
        )
        on conflict (document_id) do update
        set
            status = 'failed',
            progress = null,
            error = 'backlog_full',
            updated_at = now()
        where sa.status is distinct from 'ready';
        return jsonb_build_object('ok', false, 'code', 'backlog_full');
    end if;

    if exists (
        select 1 from public.omr_jobs
        where document_id = p_document_id
          and status in ('queued', 'running')
    ) then
        return jsonb_build_object('ok', false, 'code', 'already_running');
    end if;

    insert into public.score_analyses as sa (
        document_id, created_by, status, progress, error, score, updated_at
    )
    values (
        p_document_id, p_user_id, 'pending', null, null, null, now()
    )
    on conflict (document_id) do update
    set
        status = 'pending',
        progress = null,
        error = null,
        score = null,
        engine_version = null,
        bpm_default = null,
        timings = null,
        updated_at = now();

    begin
        insert into public.omr_jobs (
            document_id, status, storage_path, page_count, created_by, priority
        )
        values (
            p_document_id, 'queued', p_storage_path, p_page_count, p_user_id, 0
        )
        returning id into inserted_id;
    exception
        when unique_violation then
            return jsonb_build_object('ok', false, 'code', 'already_running');
    end;

    return jsonb_build_object('ok', true, 'code', 'queued', 'job_id', inserted_id);
end;
$$;

-- ===== supabase/migrations/20260826193902_billing.sql =====
-- Billing: Stripe customers/subscriptions, academy seats, metered usage, and the
-- free-tier cloud-score cap.
--
-- Design notes:
--  * Stripe price IDs live in Edge Function env, never in the database. The
--    webhook resolves price -> tier and stores the RESOLVED tier here, which is
--    why Founding Teacher needs no schema support: it is a second price on the
--    Teacher product, so a founding subscription is simply tier 'teacher'.
--  * The seat tables keep their original names (studios, studio_members); only
--    the tier they entitle was renamed, from the v1 studio tier to academy. The
--    same goes for the studio_member entitlement source, which names the table
--    the seat row lives in rather than the tier.
--  * tier_limits() is the single source of truth for the numbers. The TS mirror
--    in supabase/functions/_shared/entitlements.ts is drift-guarded by
--    tests/billing/limitsInSync.test.ts, which parses this file.
--  * cloud_scores and students are STOCKS (a live count of non-archived
--    documents, and of roster rows), not flows, so they are enforced where the
--    row is written and never reach usage_counters. The other metrics are
--    monthly flows. pdf_exports is a flow with a caveat: the export itself runs
--    on-device, so its gate is honest-UI plus this server-side counter, and it
--    never applies to anonymous guests or provisioned students.
--  * A provisioned student is not a customer. get_entitlements() answers tier
--    'student' (source 'managed') straight from app_metadata, before any
--    subscription lookup, so the roster features in 20260826194426_roster.sql
--    work for an account that will never have a Stripe row.
--  * Lapsing NEVER deletes data. Scores beyond the free cap get archived_at set;
--    they stay readable and exportable, only annotation writes are blocked.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.billing_customers (
    user_id uuid primary key references auth.users (id) on delete cascade,
    stripe_customer_id text not null unique,
    created_at timestamptz not null default now()
);

create table public.subscriptions (
    stripe_subscription_id text primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    tier text not null check (tier in ('free', 'personal', 'teacher', 'academy')),
    status text not null,
    price_id text,
    current_period_end timestamptz,
    cancel_at_period_end boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index subscriptions_user on public.subscriptions (user_id);

create table public.studios (
    id uuid primary key,
    owner_id uuid not null references auth.users (id) on delete cascade,
    name text not null,
    seat_limit int not null default 5 check (seat_limit > 0),
    created_at timestamptz not null default now()
);

create index studios_owner on public.studios (owner_id);

create table public.studio_members (
    studio_id uuid not null references public.studios (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (studio_id, user_id)
);

create index studio_members_user on public.studio_members (user_id);

-- Monthly metered usage. `month` is the first day of the calendar month, so a
-- rollover is simply a new conflict key -- last month's row is never touched.
create table public.usage_counters (
    user_id uuid not null references auth.users (id) on delete cascade,
    metric text not null,
    month date not null,
    count int not null default 0,
    updated_at timestamptz not null default now(),
    primary key (user_id, metric, month)
);

-- Webhook idempotency ledger, keyed by Stripe's own event id.
create table public.stripe_events (
    id text primary key,
    type text not null,
    processed_at timestamptz not null default now()
);

-- Active = archived_at is null. Archived scores stay viewable and exportable.
alter table public.documents add column archived_at timestamptz;

create index documents_owner_active on public.documents (owner_id) where archived_at is null;

-- ---------------------------------------------------------------------------
-- Tier limits -- the single source of truth for the numbers (-1 = unlimited)
-- ---------------------------------------------------------------------------
create or replace function public.tier_limits (p_tier text) returns jsonb language sql immutable
set search_path = public as $$
    select case p_tier
        -- students = 0 is what makes Personal a solo plan: no roster, no seats.
        when 'personal' then jsonb_build_object(
            'cloud_scores', -1, 'omr_runs', -1, 'vision_reads', 500, 'smart_imports', -1, 'pdf_exports', -1, 'students', 0
        )
        when 'teacher' then jsonb_build_object(
            'cloud_scores', -1, 'omr_runs', -1, 'vision_reads', 500, 'smart_imports', -1, 'pdf_exports', -1, 'students', -1
        )
        when 'academy' then jsonb_build_object(
            'cloud_scores', -1, 'omr_runs', -1, 'vision_reads', 500, 'smart_imports', -1, 'pdf_exports', -1, 'students', -1
        )
        -- Not purchasable: a provisioned student account. It creates nothing of
        -- its own -- every score it can reach is one a teacher assigned -- and it
        -- is never export-gated, because there is nobody to sell an upgrade to.
        when 'student' then jsonb_build_object(
            'cloud_scores', 0, 'omr_runs', 0, 'vision_reads', 0, 'smart_imports', 0, 'pdf_exports', -1, 'students', 0
        )
        else jsonb_build_object(
            'cloud_scores', 3, 'omr_runs', 3, 'vision_reads', 5, 'smart_imports', 2, 'pdf_exports', 1, 'students', 3
        )
    end;
$$;

-- ---------------------------------------------------------------------------
-- Effective entitlements, resolving Academy seat membership
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so it can read subscriptions/studios past their own RLS.
-- That makes the caller check mandatory: a signed-in user may only ask about
-- themselves; service-role callers (auth.uid() is null) must name a user.
create or replace function public.get_entitlements (p_user uuid default null) returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_user uuid;
    v_tier text := 'free';
    v_status text;
    v_source text := 'none';
    v_period_end timestamptz;
    v_sub record;
begin
    if v_caller is null then
        if p_user is null then
            raise exception 'get_entitlements requires p_user when unauthenticated' using errcode = '22023';
        end if;
        v_user := p_user;
    else
        if p_user is not null and p_user <> v_caller then
            raise exception 'cannot read another user''s entitlements' using errcode = '42501';
        end if;
        v_user := v_caller;
    end if;

    -- A provisioned student short-circuits everything below. The flag is set by
    -- the provisioning function through the admin API, so it is not something the
    -- account itself can write, and a student has no subscription, no seat and no
    -- upgrade path to resolve.
    perform 1
    from auth.users u
    where u.id = v_user
      and u.raw_app_meta_data ->> 'user_type' = 'student';

    if found then
        return jsonb_build_object(
            'user_id', v_user,
            'tier', 'student',
            'status', null::text,
            'source', 'managed',
            'current_period_end', null::timestamptz,
            'limits', public.tier_limits ('student')
        );
    end if;

    -- Own subscription first. Highest tier wins if somehow more than one is live.
    select s.tier, s.status, s.current_period_end
    into v_sub
    from public.subscriptions s
    where s.user_id = v_user
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
    order by case s.tier when 'academy' then 3 when 'teacher' then 2 when 'personal' then 1 else 0 end desc,
             s.current_period_end desc nulls last
    limit 1;

    if found then
        v_tier := v_sub.tier;
        v_status := v_sub.status;
        v_period_end := v_sub.current_period_end;
        v_source := 'subscription';
    else
        -- Otherwise: a seat in an academy whose owner is paying.
        select s.status, s.current_period_end
        into v_sub
        from public.studio_members sm
        join public.studios st on st.id = sm.studio_id
        join public.subscriptions s on s.user_id = st.owner_id
        where sm.user_id = v_user
          and s.tier = 'academy'
          and s.status in ('active', 'trialing')
          and (s.current_period_end is null or s.current_period_end > now())
        order by s.current_period_end desc nulls last
        limit 1;

        if found then
            v_tier := 'academy';
            v_status := v_sub.status;
            v_period_end := v_sub.current_period_end;
            v_source := 'studio_member';
        end if;
    end if;

    return jsonb_build_object(
        'user_id', v_user,
        'tier', v_tier,
        'status', v_status,
        'source', v_source,
        'current_period_end', v_period_end,
        'limits', public.tier_limits (v_tier)
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- Atomic metered consume -- check and increment in ONE statement
-- ---------------------------------------------------------------------------
create or replace function public.consume_quota (p_user uuid, p_metric text, p_limit int) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_month date := date_trunc('month', now())::date;
    v_count int;
begin
    if p_user is null or p_metric is null or p_limit is null then
        raise exception 'consume_quota requires p_user, p_metric and p_limit' using errcode = '22023';
    end if;

    -- A zero limit can never be satisfied, and must be rejected BEFORE the
    -- insert: the first write of a month has no conflict, so DO UPDATE's WHERE
    -- never runs and count = 1 would slip straight past the cap.
    if p_limit = 0 then
        return jsonb_build_object('ok', false, 'count', 0, 'limit', p_limit);
    end if;

    -- The WHERE on DO UPDATE is what makes this race-free: on conflict Postgres
    -- takes a row lock and re-evaluates the predicate against the locked row, so
    -- concurrent callers serialize with no check-then-write window. Zero rows
    -- back means the cap was hit AND nothing was incremented.
    insert into public.usage_counters (user_id, metric, month, count)
    values (p_user, p_metric, v_month, 1)
    on conflict (user_id, metric, month) do update
        set count = usage_counters.count + 1,
            updated_at = now()
        where p_limit < 0 or usage_counters.count < p_limit
    returning count into v_count;

    if v_count is null then
        select uc.count into v_count
        from public.usage_counters uc
        where uc.user_id = p_user and uc.metric = p_metric and uc.month = v_month;
        return jsonb_build_object('ok', false, 'count', coalesce(v_count, 0), 'limit', p_limit);
    end if;

    return jsonb_build_object('ok', true, 'count', v_count, 'limit', p_limit);
end;
$$;

-- Refund a consumed unit when the work it paid for failed. Never goes below 0.
create or replace function public.release_quota (p_user uuid, p_metric text) returns void language sql security definer
set search_path = public as $$
    update public.usage_counters
    set count = greatest(0, count - 1), updated_at = now()
    where user_id = p_user
      and metric = p_metric
      and month = date_trunc('month', now())::date;
$$;

-- The PDF export runs entirely on-device, so nothing here can stop it: this is
-- the honest-UI counter the client calls before exporting, not a hard gate. It
-- is the one consume path granted to authenticated -- an export has no Edge
-- Function to meter it -- which is safe because the worst a caller can do by
-- calling it directly is spend their own allowance.
create or replace function public.consume_pdf_export () returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_user uuid := auth.uid();
    v_ent jsonb;
    v_limit int;
begin
    if v_user is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    -- A share-link guest is someone else's visitor, with no plan of their own to
    -- draw down and no way to upgrade. Never gated.
    if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
        return jsonb_build_object('ok', true, 'exempt', 'anonymous');
    end if;

    v_ent := public.get_entitlements ();

    -- Students print what they were assigned. That is the product working, not
    -- usage to meter.
    if v_ent ->> 'tier' = 'student' then
        return jsonb_build_object('ok', true, 'exempt', 'student');
    end if;

    v_limit := (v_ent -> 'limits' ->> 'pdf_exports')::int;
    if v_limit < 0 then
        return jsonb_build_object('ok', true);
    end if;

    return public.consume_quota (v_user, 'pdf_exports', v_limit);
end;
$$;

-- ---------------------------------------------------------------------------
-- Cloud-score cap (a stock, not a flow) + archived read-only
-- ---------------------------------------------------------------------------
create or replace function public.document_is_archived (doc uuid) returns boolean language sql stable security definer
set search_path = public as $$
    select coalesce((select d.archived_at is not null from public.documents d where d.id = doc), false);
$$;

-- Uploads are a direct browser PostgREST insert (see documentsService.uploadDocument),
-- so the cap lives in a trigger rather than an Edge Function. A WITH CHECK
-- expression could reject the row but could not carry the structured payload the
-- client needs, so this raises with a machine-readable DETAIL instead.
--
-- AFTER, not BEFORE, and behind a per-owner advisory lock: counting is otherwise
-- check-then-write, the very window consume_quota goes out of its way to close.
-- A BEFORE trigger counts against a snapshot that cannot include the row being
-- written, so ten rows in one INSERT would each see the same pre-statement count
-- and all ten would land. AFTER ROW triggers fire once the statement's rows are
-- in, so the count includes them; the advisory lock does the same job across
-- concurrent transactions, since a second inserter blocks here and then re-counts
-- (a volatile function takes a fresh snapshot per statement) against the winner's
-- committed row. Both cases end in the same rollback a BEFORE raise would give.
create or replace function public.documents_enforce_score_cap () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_ent jsonb;
    v_tier text;
    v_limit int;
    v_count int;
begin
    -- Only a row that is (or becomes) active claims a slot.
    if new.archived_at is not null then
        return null;
    end if;
    if tg_op = 'UPDATE' and old.archived_at is null then
        return null; -- already active; nothing new is being claimed
    end if;

    v_ent := public.get_entitlements (new.owner_id);
    v_tier := v_ent ->> 'tier';
    v_limit := (v_ent -> 'limits' ->> 'cloud_scores')::int;

    if v_limit < 0 then
        return null;
    end if;

    -- Taken only on a capped tier, and only once the cheap exits are past: an
    -- unlimited plan never serializes against itself. Released at commit.
    perform pg_advisory_xact_lock (hashtext('cleffy.documents_score_cap'), hashtext(new.owner_id::text));

    -- The new row is already in, so it counts itself: the test is `>`, not `>=`.
    select count(*)::int into v_count
    from public.documents d
    where d.owner_id = new.owner_id
      and d.archived_at is null;

    if v_count > v_limit then
        raise exception 'limit_reached'
            using errcode = 'P0001',
                  detail = json_build_object(
                      'code', 'limit_reached',
                      'metric', 'cloud_scores',
                      'limit', v_limit,
                      'tier', v_tier
                  )::text,
                  hint = 'Upgrade for unlimited cloud scores.';
    end if;

    return null;
end;
$$;

create trigger documents_enforce_score_cap after insert or update on public.documents
for each row execute function public.documents_enforce_score_cap ();

-- Archived scores are read-only. Enforced in RLS rather than in the client so it
-- also holds for share-link students and for the batch RPCs (which are SECURITY
-- INVOKER precisely so policies like this keep applying to bulk writes).
drop policy if exists annotations_insert on public.annotations;

create policy annotations_insert on public.annotations for insert to authenticated
with check (
    public.document_role (document_id) in ('owner', 'editor')
    and created_by = (select auth.uid())
    and not public.document_is_archived (document_id)
);

drop policy if exists annotations_update on public.annotations;

create policy annotations_update on public.annotations for update to authenticated
using (public.document_role (document_id) in ('owner', 'editor'))
with check (
    public.document_role (document_id) in ('owner', 'editor')
    and not public.document_is_archived (document_id)
);

-- Archiving is a plan event, not a touch. The pre-existing documents_touch
-- trigger stamps updated_at = now() on every UPDATE, which apply_free_tier_archival
-- below would otherwise fire on every score it archives -- making the read-only
-- ones the NEWEST rows in the library (listDocuments orders by updated_at desc
-- and stops at 100), and destroying the last-touched signal the keep-set below
-- sorts on. Same drop-and-recreate as the annotations policies above; the shared
-- touch_updated_at() is left alone because library_tags, managed_students,
-- assignments and practice_notes all still want the plain behaviour.
create or replace function public.documents_touch_updated_at () returns trigger language plpgsql
set search_path = public as $$
begin
    if new.archived_at is distinct from old.archived_at then
        new.updated_at := old.updated_at;
        return new;
    end if;
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists documents_touch on public.documents;

create trigger documents_touch before update on public.documents
for each row execute function public.documents_touch_updated_at ();

revoke all on function public.documents_touch_updated_at () from public;

revoke all on function public.documents_touch_updated_at () from anon;

revoke all on function public.documents_touch_updated_at () from authenticated;

-- Called by the webhook when a subscription lapses. Keeps the most recently
-- touched scores active and archives the rest -- never deletes.
create or replace function public.apply_free_tier_archival (p_user uuid) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_limit int;
    v_archived int;
begin
    v_limit := (public.get_entitlements (p_user) -> 'limits' ->> 'cloud_scores')::int;
    if v_limit < 0 then
        return 0;
    end if;

    with keep as (
        select d.id
        from public.documents d
        where d.owner_id = p_user and d.archived_at is null
        order by d.updated_at desc, d.id
        limit v_limit
    )
    update public.documents d
    set archived_at = now()
    where d.owner_id = p_user
      and d.archived_at is null
      and not exists (select 1 from keep k where k.id = d.id);

    get diagnostics v_archived = row_count;
    return v_archived;
end;
$$;

-- ---------------------------------------------------------------------------
-- Academy seat management (on the studios/studio_members tables, v1 names kept)
-- ---------------------------------------------------------------------------
create or replace function public.studios_enforce_seat_limit () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_limit int;
    v_used int;
begin
    select st.seat_limit into v_limit from public.studios st where st.id = new.studio_id;
    if v_limit is null then
        raise exception 'studio not found' using errcode = 'P0002';
    end if;

    -- The owner occupies a seat, so members may fill at most seat_limit - 1.
    select count(*)::int into v_used
    from public.studio_members sm
    where sm.studio_id = new.studio_id and sm.user_id <> new.user_id;

    if v_used + 1 > v_limit - 1 then
        raise exception 'seat_limit_reached'
            using errcode = 'P0001',
                  detail = json_build_object('code', 'seat_limit_reached', 'limit', v_limit)::text;
    end if;

    return new;
end;
$$;

create trigger studio_members_seat_limit before insert on public.studio_members
for each row execute function public.studios_enforce_seat_limit ();

-- SECURITY DEFINER for exactly the reason document_role() is (see
-- 20260801160754_rls.sql): a studios policy that reads studio_members and a
-- studio_members policy that reads studios are MUTUALLY recursive, and Postgres
-- refuses both with "infinite recursion detected in policy" -- which is every
-- read either table has, taking the whole Academy seats screen with it. Routing
-- both through one definer function is what breaks the cycle.
create or replace function public.studio_role (p_studio uuid) returns text language sql stable security definer
set search_path = public as $$
    select case
        when exists (
            select 1 from public.studios st where st.id = p_studio and st.owner_id = auth.uid()
        ) then 'owner'
        when exists (
            select 1 from public.studio_members sm where sm.studio_id = p_studio and sm.user_id = auth.uid()
        ) then 'member'
    end;
$$;

-- auth.users is not client-readable, so seat invites resolve the email here.
create or replace function public.studio_invite_member (p_studio uuid, p_email text) returns uuid language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_owner uuid;
    v_target uuid;
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    select st.owner_id into v_owner from public.studios st where st.id = p_studio;
    if v_owner is null or v_owner <> v_caller then
        raise exception 'only the studio owner can add seats' using errcode = '42501';
    end if;

    -- Owning a studio is not the same as paying for one, and anyone may create a
    -- studio row. Without this, the distinct "no Cleffy account" raise below is a
    -- free, unrate-limited oracle over auth.users for any signed-in caller -- and
    -- a way to push a stranger into a studio they never joined. Seats only exist
    -- on Academy, so that is where the lookup lives.
    if (public.get_entitlements () ->> 'tier') is distinct from 'academy' then
        raise exception 'an Academy subscription is required to add seats'
            using errcode = '42501',
                  detail = json_build_object('code', 'academy_required')::text;
    end if;

    select u.id into v_target from auth.users u where lower(u.email) = lower(trim(p_email)) limit 1;
    if v_target is null then
        raise exception 'no Cleffy account with that email'
            using errcode = 'P0002',
                  detail = json_build_object('code', 'user_not_found')::text;
    end if;

    -- The owner already holds a seat implicitly; adding a row for them would
    -- double-count against seat_limit.
    if v_target = v_owner then
        raise exception 'the studio owner already holds a seat'
            using errcode = 'P0001',
                  detail = json_build_object('code', 'owner_already_seated')::text;
    end if;

    insert into public.studio_members (studio_id, user_id)
    values (p_studio, v_target)
    on conflict (studio_id, user_id) do nothing;

    return v_target;
end;
$$;

-- Seat roster with emails, owner only. studio_members holds ids, and auth.users
-- is not client-readable, so the join has to happen behind a definer boundary.
create or replace function public.studio_roster (p_studio uuid) returns table (user_id uuid, email text) language plpgsql stable security definer
set search_path = public as $$
-- OUT params (user_id, email) share names with the columns below; let columns win,
-- same hazard redeem_share_link documents.
#variable_conflict use_column
declare
    v_caller uuid := auth.uid();
    v_owner uuid;
begin
    select st.owner_id into v_owner from public.studios st where st.id = p_studio;
    if v_caller is null or v_owner is null or v_owner <> v_caller then
        raise exception 'only the studio owner can list seats' using errcode = '42501';
    end if;

    return query
        select sm.user_id, u.email::text
        from public.studio_members sm
        join auth.users u on u.id = sm.user_id
        where sm.studio_id = p_studio
        order by u.email;
end;
$$;

create or replace function public.studio_remove_member (p_studio uuid, p_user uuid) returns void language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_owner uuid;
begin
    select st.owner_id into v_owner from public.studios st where st.id = p_studio;
    if v_caller is null or v_owner is null or v_owner <> v_caller then
        raise exception 'only the studio owner can remove seats' using errcode = '42501';
    end if;

    delete from public.studio_members where studio_id = p_studio and user_id = p_user;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS -- users read only their own rows; every write is service-role/definer
-- ---------------------------------------------------------------------------
alter table public.billing_customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.studios enable row level security;
alter table public.studio_members enable row level security;
alter table public.usage_counters enable row level security;
alter table public.stripe_events enable row level security;

create policy billing_customers_select on public.billing_customers for select to authenticated
using (user_id = (select auth.uid()));

create policy subscriptions_select on public.subscriptions for select to authenticated
using (user_id = (select auth.uid()));

create policy usage_counters_select on public.usage_counters for select to authenticated
using (user_id = (select auth.uid()));

-- Owners manage their studio; members may see the studio they belong to. The
-- owner branch is direct rather than through studio_role() for the reason
-- documents_select keeps its own: an owner holds no studio_members row at all,
-- and INSERT ... RETURNING has to see the row it just wrote.
create policy studios_select on public.studios for select to authenticated
using (
    owner_id = (select auth.uid())
    or public.studio_role (id) = 'member'
);

-- Same two exclusions documents_insert carries: a share-link guest has no plan
-- of their own and a provisioned student creates nothing, so neither has an
-- academy to own. The column grants below are what keep seat_limit out of reach.
create policy studios_insert on public.studios for insert to authenticated
with check (
    owner_id = (select auth.uid())
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'user_type', '') <> 'student'
);

create policy studios_update on public.studios for update to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy studio_members_select on public.studio_members for select to authenticated
using (
    user_id = (select auth.uid())
    or public.studio_role (studio_id) = 'owner'
);

-- ---------------------------------------------------------------------------
-- Privilege hardening (same convention as edge_rate_rls_and_revoke_execute)
-- ---------------------------------------------------------------------------
revoke all on table public.billing_customers from public;
revoke all on table public.billing_customers from anon;
revoke all on table public.billing_customers from authenticated;
grant select on table public.billing_customers to authenticated;

revoke all on table public.subscriptions from public;
revoke all on table public.subscriptions from anon;
revoke all on table public.subscriptions from authenticated;
grant select on table public.subscriptions to authenticated;

revoke all on table public.usage_counters from public;
revoke all on table public.usage_counters from anon;
revoke all on table public.usage_counters from authenticated;
grant select on table public.usage_counters to authenticated;

revoke all on table public.stripe_events from public;
revoke all on table public.stripe_events from anon;
revoke all on table public.stripe_events from authenticated;

revoke all on table public.studios from public;
revoke all on table public.studios from anon;
revoke all on table public.studios from authenticated;
grant select on table public.studios to authenticated;
-- Column-scoped on purpose: seat_limit is the SOLE input to
-- studios_enforce_seat_limit, so a table-wide insert/update grant would make the
-- Academy seat cap self-service -- one $49 subscription entitling any number of
-- teachers through get_entitlements()'s seat branch. The policies above only
-- check owner_id, and the CHECK constraint only asks for > 0, so nothing else
-- stands between an owner and `{"seat_limit": 100000}`. Nothing legitimate wants
-- it either: createStudio posts {id, owner_id, name} and StudioSeats only reads.
grant insert (id, owner_id, name), update (name) on table public.studios to authenticated;

revoke all on table public.studio_members from public;
revoke all on table public.studio_members from anon;
revoke all on table public.studio_members from authenticated;
grant select on table public.studio_members to authenticated;

-- Trigger-only functions: never callable via /rest/v1/rpc.
revoke all on function public.documents_enforce_score_cap () from public;
revoke all on function public.documents_enforce_score_cap () from anon;
revoke all on function public.documents_enforce_score_cap () from authenticated;

revoke all on function public.studios_enforce_seat_limit () from public;
revoke all on function public.studios_enforce_seat_limit () from anon;
revoke all on function public.studios_enforce_seat_limit () from authenticated;

-- Service-only RPCs: metering and lapse handling are Edge Function concerns.
revoke all on function public.consume_quota (uuid, text, int) from public;
revoke all on function public.consume_quota (uuid, text, int) from anon;
revoke all on function public.consume_quota (uuid, text, int) from authenticated;
grant execute on function public.consume_quota (uuid, text, int) to service_role;

revoke all on function public.release_quota (uuid, text) from public;
revoke all on function public.release_quota (uuid, text) from anon;
revoke all on function public.release_quota (uuid, text) from authenticated;
grant execute on function public.release_quota (uuid, text) to service_role;

revoke all on function public.apply_free_tier_archival (uuid) from public;
revoke all on function public.apply_free_tier_archival (uuid) from anon;
revoke all on function public.apply_free_tier_archival (uuid) from authenticated;
grant execute on function public.apply_free_tier_archival (uuid) to service_role;

-- Client RPCs: revoke PUBLIC/anon, keep authenticated.
revoke all on function public.get_entitlements (uuid) from public;
revoke all on function public.get_entitlements (uuid) from anon;
grant execute on function public.get_entitlements (uuid) to authenticated;
grant execute on function public.get_entitlements (uuid) to service_role;

revoke all on function public.tier_limits (text) from public;
revoke all on function public.tier_limits (text) from anon;
grant execute on function public.tier_limits (text) to authenticated;

-- Unlike consume_quota, this one IS a client RPC: the export it counts happens
-- in the browser, so there is no server-side caller to keep it away from.
revoke all on function public.consume_pdf_export () from public;
revoke all on function public.consume_pdf_export () from anon;
grant execute on function public.consume_pdf_export () to authenticated;

revoke all on function public.document_is_archived (uuid) from public;
revoke all on function public.document_is_archived (uuid) from anon;
grant execute on function public.document_is_archived (uuid) to authenticated;

revoke all on function public.studio_invite_member (uuid, text) from public;
revoke all on function public.studio_invite_member (uuid, text) from anon;
grant execute on function public.studio_invite_member (uuid, text) to authenticated;

revoke all on function public.studio_remove_member (uuid, uuid) from public;
revoke all on function public.studio_remove_member (uuid, uuid) from anon;
grant execute on function public.studio_remove_member (uuid, uuid) to authenticated;

revoke all on function public.studio_roster (uuid) from public;
revoke all on function public.studio_roster (uuid) from anon;
grant execute on function public.studio_roster (uuid) to authenticated;

-- Read by the studios/studio_members policies, so authenticated must hold it.
revoke all on function public.studio_role (uuid) from public;
revoke all on function public.studio_role (uuid) from anon;
grant execute on function public.studio_role (uuid) to authenticated;

-- ===== supabase/migrations/20260826194426_roster.sql =====
-- Roster, assignments, and practice notes — the teaching half of pricing v2.
--
-- The model, in one place:
--  * A provisioned student is a REAL Supabase user, flagged with
--    app_metadata.user_type = 'student' by the student-provision Edge Function
--    (admin-set, so it is not user-editable and can be trusted in a policy).
--    managed_students is the teacher's side of that account: the display name
--    they picked, the hash of the login code, and the archive flag that decides
--    whether the row still counts against the `students` stock.
--  * Permissions ride the roles that already exist. Assigning a score upserts a
--    document_members row — 'editor' so the student can annotate their own
--    fingerings and practice marks, or 'viewer' when the teacher flips the
--    assignment to view-only. There is no new member role, and the annotation
--    policies are untouched: a student IS an editor, by the same rules as a
--    share-link collaborator.
--  * practice_notes is the teacher's journal. Notes are private to their author
--    until `shared` is set, which is what lets a teacher write both "watch the
--    left hand in bar 12" for the student and "parents want to move to Tuesdays"
--    for themselves, in the same place.
--  * Students are never gated and never billed. get_entitlements() answers tier
--    'student' for them (see 20260826193902_billing.sql), and nothing in this
--    file consumes a quota — the teacher's roster stock is what pricing meters.
--
-- Ids are caller-generated, matching documents/annotations/library_tags: the
-- provisioning function and the client already hold the uuid they just made.

-- ---------------------------------------------------------------------------
-- Roster
-- ---------------------------------------------------------------------------
create table public.managed_students (
    id uuid primary key,
    teacher_id uuid not null references auth.users (id) on delete cascade,
    -- One roster row per student account: a student belongs to the teacher who
    -- provisioned them, and moving them means archiving and re-provisioning.
    student_user_id uuid not null unique references auth.users (id) on delete cascade,
    display_name text not null,
    -- Never the code itself. The login function hashes and compares.
    login_code_hash text not null,
    parent_email text,
    -- Archived students keep their history and stop counting against `students`.
    archived_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint managed_students_display_name_nonempty check (length(trim(display_name)) > 0)
);

-- The roster stock is "unarchived rows for this teacher", so the index carries
-- the same predicate the count does.
create index managed_students_teacher_active on public.managed_students (teacher_id) where archived_at is null;

create index managed_students_login_code on public.managed_students (login_code_hash);

create trigger managed_students_touch before update on public.managed_students
for each row execute function public.touch_updated_at ();

-- ---------------------------------------------------------------------------
-- Assignments
-- ---------------------------------------------------------------------------
create table public.assignments (
    id uuid primary key,
    document_id uuid not null references public.documents (id) on delete cascade,
    student_user_id uuid not null references auth.users (id) on delete cascade,
    assigned_by uuid not null references auth.users (id) on delete cascade,
    note text,
    due_at timestamptz,
    -- 'edit' grants the editor role, 'view' the viewer role. Full edit is the
    -- default: a student who cannot mark their own fingerings has half a score.
    access text not null default 'edit' check (access in ('edit', 'view')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (document_id, student_user_id)
);

create index assignments_student on public.assignments (student_user_id);

create index assignments_document on public.assignments (document_id);

create trigger assignments_touch before update on public.assignments
for each row execute function public.touch_updated_at ();

-- ---------------------------------------------------------------------------
-- Practice notes (the teacher's journal, with an opt-in share flag)
-- ---------------------------------------------------------------------------
create table public.practice_notes (
    id uuid primary key,
    document_id uuid not null references public.documents (id) on delete cascade,
    -- Null means a note about the score in general rather than about one student.
    student_user_id uuid references auth.users (id) on delete cascade,
    author_id uuid not null references auth.users (id) on delete cascade,
    noted_on date not null default current_date,
    body text not null,
    -- Off by default: a journal the student can read is a different thing from
    -- a journal, so sharing is always a deliberate act.
    shared boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint practice_notes_body_nonempty check (length(trim(body)) > 0)
);

create index practice_notes_doc_day on public.practice_notes (document_id, noted_on desc);

create index practice_notes_student_day on public.practice_notes (student_user_id, noted_on desc);

create trigger practice_notes_touch before update on public.practice_notes
for each row execute function public.touch_updated_at ();

-- ---------------------------------------------------------------------------
-- Assignment RPCs — the only write path for assignments and their membership
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because assigning has to write document_members, which has no
-- client write policy at all (every membership write goes through a definer
-- path: the owner trigger, redeem_share_link, and now this).
create or replace function public.assign_score (
    p_document uuid,
    p_student uuid,
    p_access text default 'edit',
    p_note text default null,
    p_due_at timestamptz default null
) returns uuid language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_role text;
    v_id uuid;
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    -- document_role() reads auth.uid(), which is still the CALLER inside a
    -- definer function — the JWT claim does not change with the executing role.
    if public.document_role (p_document) is distinct from 'owner' then
        raise exception 'only the score owner can assign it' using errcode = '42501';
    end if;

    if p_access not in ('edit', 'view') then
        raise exception 'access must be edit or view' using errcode = '22023';
    end if;

    -- A teacher may only assign to their own, unarchived roster: this is what
    -- stops an assignment from reaching a student someone else provisioned.
    if not exists (
        select 1
        from public.managed_students ms
        where ms.teacher_id = v_caller
          and ms.student_user_id = p_student
          and ms.archived_at is null
    ) then
        raise exception 'not on your roster' using errcode = 'P0002';
    end if;

    v_role := case when p_access = 'view' then 'viewer' else 'editor' end;

    insert into public.assignments (id, document_id, student_user_id, assigned_by, note, due_at, access)
    values (gen_random_uuid(), p_document, p_student, v_caller, p_note, p_due_at, p_access)
    on conflict (document_id, student_user_id) do update
        set access = excluded.access,
            note = excluded.note,
            due_at = excluded.due_at,
            updated_at = now()
    returning id into v_id;

    insert into public.document_members (document_id, user_id, role)
    values (p_document, p_student, v_role)
    on conflict (document_id, user_id) do update
        set role = case
            -- Same owner guard as redeem_share_link: assigning a score must never
            -- cost anyone ownership of it.
            when public.document_members.role = 'owner' then 'owner'
            -- Unlike a share link, the teacher's toggle otherwise wins, editor ->
            -- viewer included: flipping an assignment to view-only has to demote.
            else excluded.role
        end;

    return v_id;
end;
$$;

create or replace function public.unassign_score (p_document uuid, p_student uuid) returns void language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_withdrawn int;
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    if public.document_role (p_document) is distinct from 'owner' then
        raise exception 'only the score owner can unassign it' using errcode = '42501';
    end if;

    delete from public.assignments
    where document_id = p_document
      and student_user_id = p_student;

    get diagnostics v_withdrawn = row_count;

    -- Only what the assignment granted comes back. Guarded on the delete above
    -- actually having removed one: document_members has no client write policy,
    -- so an unguarded delete here would quietly make this the app's general
    -- membership-revocation primitive, accepting any user id -- a share-link
    -- collaborator's editor row would vanish on an unassign that withdrew
    -- nothing, while assign_score is careful to refuse anyone off the roster.
    if v_withdrawn = 0 then
        return;
    end if;

    -- An owner row was never the assignment's to give and is not its to take away.
    delete from public.document_members
    where document_id = p_document
      and user_id = p_student
      and role <> 'owner';
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.managed_students enable row level security;
alter table public.assignments enable row level security;
alter table public.practice_notes enable row level security;

-- The teacher sees their roster; the student sees their own row (it is how the
-- student app learns its display name). NO client write policies: rows are
-- created by the student-provision Edge Function under the service role.
create policy managed_students_select on public.managed_students for select to authenticated
using (
    teacher_id = (select auth.uid())
    or student_user_id = (select auth.uid())
);

-- Both sides of an assignment can read it. Writes go through assign_score /
-- unassign_score so the membership row can never drift from the assignment.
create policy assignments_select on public.assignments for select to authenticated
using (
    student_user_id = (select auth.uid())
    or public.document_role (document_id) = 'owner'
);

create policy practice_notes_select on public.practice_notes for select to authenticated
using (
    author_id = (select auth.uid())
    or (
        shared
        and student_user_id = (select auth.uid())
    )
);

create policy practice_notes_insert on public.practice_notes for insert to authenticated
with check (
    author_id = (select auth.uid())
    and public.document_role (document_id) = 'owner'
    and (
        student_user_id is null
        or exists (
            select 1
            from public.managed_students ms
            where ms.teacher_id = (select auth.uid())
              -- Qualified: unqualified would bind to ms's own column.
              and ms.student_user_id = practice_notes.student_user_id
        )
    )
);

-- The WITH CHECK repeats the insert policy's two guarantees rather than trusting
-- author_id alone: without them document_id, student_user_id and `shared` are all
-- freely mutable after the fact, which dissolves both. A note could be moved onto
-- a score its author does not own and re-aimed at somebody else's student, and
-- the immutability of "who this note is about" -- the thing that stops a note
-- written with nobody named from ever reaching anyone -- would be a client-side
-- type and nothing more. The column grant below is the other half.
create policy practice_notes_update on public.practice_notes for update to authenticated
using (author_id = (select auth.uid()))
with check (
    author_id = (select auth.uid())
    and public.document_role (document_id) = 'owner'
    and (
        student_user_id is null
        or exists (
            select 1
            from public.managed_students ms
            where ms.teacher_id = (select auth.uid())
              -- Qualified: unqualified would bind to ms's own column.
              and ms.student_user_id = practice_notes.student_user_id
        )
    )
);

create policy practice_notes_delete on public.practice_notes for delete to authenticated
using (author_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- documents_insert: students are editors, never creators
-- ---------------------------------------------------------------------------
-- Keeps the owner and is_anonymous conditions from free_plan_efficiency and adds
-- the student clause. A provisioned student's library is exactly what their
-- teacher assigned: letting a student create a score would give them one nobody
-- pays for, that no teacher can see, and that no roster row can reach. The
-- documents table is live, which is why this rides here rather than being edited
-- into an already-applied migration.
drop policy if exists documents_insert on public.documents;

create policy documents_insert on public.documents for insert to authenticated
with check (
    owner_id = (select auth.uid())
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'user_type', '') <> 'student'
);

-- ---------------------------------------------------------------------------
-- Privilege hardening (same convention as edge_rate_rls_and_revoke_execute)
-- ---------------------------------------------------------------------------
revoke all on table public.managed_students from public;
revoke all on table public.managed_students from anon;
revoke all on table public.managed_students from authenticated;
-- Every column EXCEPT login_code_hash. The select policy above has a student
-- branch, so a table-wide grant would ship the hash of the code that is also the
-- account's Supabase password down to the student's own browser -- for a value
-- nothing on the client reads, and that only student-login ever compares, under
-- the service role. parent_email stays: it is the teacher's record of who to send
-- the printed card home to, and there is no column grant that can show it to one
-- side of this policy and not the other.
grant select (id, teacher_id, student_user_id, display_name, parent_email, archived_at, created_at, updated_at)
on table public.managed_students to authenticated;

revoke all on table public.assignments from public;
revoke all on table public.assignments from anon;
revoke all on table public.assignments from authenticated;
grant select on table public.assignments to authenticated;

revoke all on table public.practice_notes from public;
revoke all on table public.practice_notes from anon;
revoke all on table public.practice_notes from authenticated;
grant select, insert, delete on table public.practice_notes to authenticated;
-- Exactly the fields PracticeNoteUpdate exposes. document_id, student_user_id and
-- author_id are set once at insert, where the policy vets them, and a table-wide
-- update grant is what would let them be rewritten afterwards.
grant update (body, shared, noted_on) on table public.practice_notes to authenticated;

-- Client RPCs: revoke PUBLIC/anon, keep authenticated.
revoke all on function public.assign_score (uuid, uuid, text, text, timestamptz) from public;
revoke all on function public.assign_score (uuid, uuid, text, text, timestamptz) from anon;
grant execute on function public.assign_score (uuid, uuid, text, text, timestamptz) to authenticated;

revoke all on function public.unassign_score (uuid, uuid) from public;
revoke all on function public.unassign_score (uuid, uuid) from anon;
grant execute on function public.unassign_score (uuid, uuid) to authenticated;

-- ===== supabase/migrations/20260827140000_core_table_grants.sql =====
-- Table-level grants for the core schema.
--
-- Why this exists: on the current Supabase Postgres image, the default ACL for
-- objects created by `postgres` in `public` gives anon/authenticated only
-- Dxtm (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) — no SELECT/INSERT/UPDATE/DELETE.
-- Only objects created by `supabase_admin` get the permissive arwdDxtm default.
-- Migrations run as `postgres`, so every table 0001_schema.sql created is
-- unreadable by the app: PostgREST returns 42501 "permission denied for table
-- documents" before RLS is ever consulted.
--
-- The later migrations (score_analyses, billing, roster) already grant
-- explicitly, which is why only the original core tables were affected.
--
-- Grants below mirror the RLS policies one-for-one — a table gets a privilege
-- only where a policy for that command exists. RLS still decides which ROWS are
-- visible; these grants only open the table-level gate. Tables with no
-- user-facing policy (omr_jobs, score_cache, edge_rate_buckets) are deliberately
-- absent: they stay service_role-only.
--
-- Idempotent: re-granting an existing privilege is a no-op, so this is safe to
-- replay against an environment that already has them.

grant select, insert, update, delete on table public.documents to authenticated;
grant select, insert, update          on table public.annotations to authenticated;
grant select, insert                  on table public.annotation_snapshots to authenticated;
grant select                          on table public.document_members to authenticated;
grant select, insert, update, delete on table public.share_links to authenticated;
grant select, insert, delete         on table public.document_favorites to authenticated;
grant select, insert, delete         on table public.document_tags to authenticated;
grant select, insert, update, delete on table public.library_tags to authenticated;
grant select, insert, update          on table public.document_imports to authenticated;

-- service_role bypasses RLS but still needs the table-level grant.
grant all on table public.documents,
               public.annotations,
               public.annotation_snapshots,
               public.document_members,
               public.share_links,
               public.document_favorites,
               public.document_tags,
               public.library_tags,
               public.document_imports
    to service_role;

-- ===== supabase/migrations/20260827150000_student_credentials.sql =====
-- Student credentials: a code becomes a claim token, and email joins it.
--
-- The model this replaces: the login code was the whole credential — its hash
-- selected the roster row AND it was the synthetic account's Supabase password,
-- forever. That is a password a child reads off a card, cannot change, and
-- shares with whoever picks the card up off the piano.
--
-- The model this establishes: the teacher picks a method per student, once, at
-- creation, and `auth_method` is fixed for the life of the row.
--
--  * 'code' — the zero-email path, for a young child. The printed code is a
--    ONE-TIME CLAIM TOKEN: student-claim spends it to choose a username and a
--    password, and from then on student-login takes those. The synthetic
--    st-<roster-id>@students.cleffy.app address stays, because Supabase needs
--    something to key an auth user on and no inbox is ever asked for.
--  * 'email' — the teacher supplies the student's real address and GoTrue
--    invites it. There is no code, no username and no synthetic address: the
--    student sets a password from the emailed link and signs in client-side,
--    exactly as a teacher does.
--
-- Four states, and this file's CHECK constraint is what makes them the only
-- four. "Invited" always means the same thing on both paths: the auth password
-- is a scramble nobody has ever seen (generateProvisionPassword), so no sign-in
-- path exists for the account at all.
--
--   code  + Invited : login_code_hash set, claimed_at null   -> student-claim
--   code  + Active  : username set, login_code_hash NULL     -> student-login
--   email + Invited : student_email set, claimed_at null     -> the invite link
--   email + Active  : student_email set, claimed_at stamped  -> ordinary sign-in
--
-- A reset returns either row to Invited, and scrambles the password FIRST —
-- that scramble is the actual revocation, exactly as the archive ban is.
-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table public.managed_students
    add column auth_method text not null default 'code'
        check (auth_method in ('code', 'email')),
    -- Stored canonical-lowercase (normalizeUsername runs before every write and
    -- every lookup), which is what makes the plain unique index below a
    -- CASE-INSENSITIVE uniqueness guarantee without a functional index or a
    -- citext column: two spellings that differ only in case are the same string
    -- by the time either one reaches this table.
    add column username text,
    -- The student's REAL address, on the email path only. Never a synthetic one:
    -- those are derived from the roster id and stored nowhere.
    add column student_email text,
    -- Setup-complete. On the code path the claim stamps it; on the email path
    -- the student does, through mark_student_claimed() below.
    add column claimed_at timestamptz,
    -- Was NOT NULL when the code was a permanent password. It is now absent for
    -- a claimed code student (spent) and for every email student (never minted).
    alter column login_code_hash drop not null;

-- The DB re-checks USERNAME_RE from _shared/studentCodes.ts. A service-role bug
-- that stored an un-normalized spelling would store one student-login could
-- never match — this refuses it at the table instead.
alter table public.managed_students add constraint managed_students_username_shape
    check (username is null or username ~ '^[a-z0-9_]{3,20}$');

-- Plain unique index, not partial: NULLs are distinct in Postgres, so every
-- email row and every unclaimed code row coexists freely.
create unique index managed_students_username_key on public.managed_students (username);

-- The state machine, enforced. Note what is deliberately NOT constrained: an
-- Invited code row may carry a username left over from a previous claim. Reset
-- does not clear it, because the next claim overwrites it and keeping-or-
-- changing the name is the student's call, not the teacher's.
--
-- Existing rows all satisfy the first branch: auth_method defaults to 'code',
-- student_email is null, claimed_at is null, and login_code_hash was NOT NULL.
alter table public.managed_students add constraint managed_students_claim_state check (
    (auth_method = 'code' and student_email is null and (
        (claimed_at is null and login_code_hash is not null)
        or (claimed_at is not null and username is not null and login_code_hash is null)))
    or (auth_method = 'email' and student_email is not null
        and login_code_hash is null and username is null));

-- ---------------------------------------------------------------------------
-- mark_student_claimed — the email student stamps their own setup-complete
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because managed_students has no client write policy at all,
-- by design (see 20260826194426_roster.sql): every write is either a definer
-- function or the service role. A code student's claim is stamped by
-- student-claim under the service role, in the same UPDATE that sets the
-- username; an email student never touches an Edge Function on their way in, so
-- this is the one write they need.
--
-- Scoped to auth.uid(), so the caller can only ever stamp their own row — the
-- function takes no arguments precisely so there is no row to aim it at.
--
-- The auth_method guard is not redundant. Without it, a code student calling
-- this would set claimed_at on a row whose username is still null, the
-- managed_students_claim_state CHECK would reject the UPDATE, and this function
-- would RAISE rather than no-op. Refusing to match the row is the tolerant
-- spelling of the same rule.
create or replace function public.mark_student_claimed () returns void
language sql security definer set search_path = public as $$
    update public.managed_students
    set claimed_at = now()
    where student_user_id = auth.uid()
      and auth_method = 'email'
      and claimed_at is null;
$$;

revoke all on function public.mark_student_claimed () from public;

revoke all on function public.mark_student_claimed () from anon;

grant execute on function public.mark_student_claimed () to authenticated;

-- ---------------------------------------------------------------------------
-- Grants (same convention as roster.sql)
-- ---------------------------------------------------------------------------
-- Additive to roster.sql's column grant, and login_code_hash stays out of it for
-- the same reason it was excluded there: managed_students_select has a student
-- branch, so a table-wide grant would ship the hash of a live claim token down
-- to a browser, for a value nothing on the client reads and that only
-- student-claim ever compares, under the service role.
--
-- The four new columns are all things a client legitimately renders: the student
-- app shows a claimed username on the account screen and the teacher's roster
-- shows which method a student is on, whether they have finished setting up, and
-- which address the invite went to.
grant select (auth_method, username, student_email, claimed_at)
on table public.managed_students to authenticated;

-- roster.sql revoked from public/anon/authenticated but never granted to
-- service_role, which is a no-op hosted (the default ACL is permissive there)
-- and a 42501 locally — the same trap 20260827140000_core_table_grants.sql
-- documents for the core tables. student-claim writes this table under the
-- service role, so it has to hold locally too.
grant all on table public.managed_students to service_role;

-- ===== supabase/migrations/20260828120000_free_tier_no_students.sql =====
-- Free becomes a taste of Personal, not a taste of Teacher.
--
-- Free previously carried students = 3, which made it a miniature teaching
-- plan: a studio could run three students indefinitely without ever reaching
-- the tier that sells the roster. Personal is the individual licence, and Free
-- is the sample of it, so the roster now starts at Teacher.
--
-- Only the 'free' branch changes; every other tier is reproduced exactly as
-- 20260826193902_billing.sql defined it, because create-or-replace rewrites the
-- whole body. tier_limits() stays the single source of truth for the numbers,
-- and the TS mirror in src/features/billing/entitlementsService.ts (FREE_LIMITS)
-- moves with it.
--
-- Existing rows are untouched: a free account that already provisioned students
-- keeps them, and those students keep signing in. What changes is that the
-- account can no longer add more (student-provision returns 402) and the client
-- hides the roster, since limits.students = 0 now reads as "no roster on this
-- plan". Check for such accounts before deploying:
--
--   select ms.teacher_id, count(*)
--   from public.managed_students ms
--   left join public.subscriptions s
--     on s.user_id = ms.teacher_id and s.status = 'active'
--   where s.tier is null
--   group by 1;
create or replace function public.tier_limits (p_tier text) returns jsonb language sql immutable
set search_path = public as $$
    select case p_tier
        -- students = 0 is what makes Personal a solo plan: no roster, no seats.
        when 'personal' then jsonb_build_object(
            'cloud_scores', -1, 'omr_runs', -1, 'vision_reads', 500, 'smart_imports', -1, 'pdf_exports', -1, 'students', 0
        )
        when 'teacher' then jsonb_build_object(
            'cloud_scores', -1, 'omr_runs', -1, 'vision_reads', 500, 'smart_imports', -1, 'pdf_exports', -1, 'students', -1
        )
        when 'academy' then jsonb_build_object(
            'cloud_scores', -1, 'omr_runs', -1, 'vision_reads', 500, 'smart_imports', -1, 'pdf_exports', -1, 'students', -1
        )
        -- Not purchasable: a provisioned student account. It creates nothing of
        -- its own -- every score it can reach is one a teacher assigned -- and it
        -- is never export-gated, because there is nobody to sell an upgrade to.
        when 'student' then jsonb_build_object(
            'cloud_scores', 0, 'omr_runs', 0, 'vision_reads', 0, 'smart_imports', 0, 'pdf_exports', -1, 'students', 0
        )
        -- Free: the whole practice tool in small amounts, for one player.
        else jsonb_build_object(
            'cloud_scores', 3, 'omr_runs', 3, 'vision_reads', 5, 'smart_imports', 2, 'pdf_exports', 1, 'students', 0
        )
    end;
$$;

-- ===== supabase/migrations/20260828180000_billing_stripe_mode.sql =====
-- Split the billing tables by Stripe account.
--
-- cleffy.io and dev.cleffy.io are two Vercel deploys of one codebase over ONE
-- Supabase project, and at the live flip they stop sharing a Stripe account:
-- production transacts against "Cleffy" (live), dev against "Cleffy sandbox"
-- (test). Two things in here were single-account assumptions that break the
-- moment that is true.
--
-- 1. A Stripe customer id belongs to exactly one account. `billing_customers`
--    allowed one row per user, so a teacher who had ever opened checkout on dev
--    would carry a sandbox `cus_…` into production, and the live Checkout call
--    would fail with "No such customer". A user now gets one customer row per
--    mode.
--
-- 2. A subscription row now records which account created it, so "who is paying"
--    can be answered per account rather than per user. dev.cleffy.io has its own
--    Supabase project, so the two populations are already separate; what this
--    guards is the remaining overlap, where a developer running locally against
--    THIS database checks out in sandbox mode and leaves a test-mode
--    subscription among the real ones.
--
-- Every existing row predates the flip and is therefore sandbox, which is what
-- the 'test' default backfills.

alter table public.billing_customers
    add column mode text not null default 'test' check (mode in ('live', 'test'));

-- One customer per user PER ACCOUNT. stripe_customer_id keeps its own unique
-- constraint: customer ids are globally unique, so it stays a valid lookup key.
alter table public.billing_customers drop constraint billing_customers_pkey;
alter table public.billing_customers add constraint billing_customers_pkey primary key (user_id, mode);

alter table public.subscriptions
    add column mode text not null default 'test' check (mode in ('live', 'test'));

create index if not exists subscriptions_user_mode on public.subscriptions (user_id, mode);

-- Which Stripe account's subscriptions actually entitle.
--
-- Both by default, which is the right answer for every database except one. The
-- `dev` branch project (qdbnlrgylelelvwbkvnm) only ever sees sandbox
-- subscriptions, so narrowing this there would silently drop every dev tester to
-- the free tier — and since that project has its own auth users, a test-mode
-- subscription in it grants nothing on cleffy.io.
--
-- PRODUCTION is the exception, and narrowing it is a step of the live flip
-- (DEPLOY.md §0), run once against jibgwgosihadbjgxdsfe only:
--
--   create or replace function public.entitling_billing_modes () returns text[]
--   language sql immutable set search_path = public as $$
--   select array['live']::text[] $$;
--
-- After that, a sandbox checkout made against production's backend from a
-- non-production origin — localhost, most plausibly — records its subscription
-- but grants nothing, which is what stops a published test card buying a real
-- plan.
create or replace function public.entitling_billing_modes () returns text[] language sql immutable
set search_path = public as $$
select array['live', 'test']::text[]
$$;

revoke all on function public.entitling_billing_modes () from public;
revoke all on function public.entitling_billing_modes () from anon;

-- Re-declared verbatim from 20260826193902_billing.sql except for the two
-- `s.mode = any (...)` predicates, so the diff against that definition is
-- exactly the mode filter and nothing else.
create or replace function public.get_entitlements (p_user uuid default null) returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_user uuid;
    v_tier text := 'free';
    v_status text;
    v_source text := 'none';
    v_period_end timestamptz;
    v_sub record;
begin
    if v_caller is null then
        if p_user is null then
            raise exception 'get_entitlements requires p_user when unauthenticated' using errcode = '22023';
        end if;
        v_user := p_user;
    else
        if p_user is not null and p_user <> v_caller then
            raise exception 'cannot read another user''s entitlements' using errcode = '42501';
        end if;
        v_user := v_caller;
    end if;

    -- A provisioned student short-circuits everything below. The flag is set by
    -- the provisioning function through the admin API, so it is not something the
    -- account itself can write, and a student has no subscription, no seat and no
    -- upgrade path to resolve.
    perform 1
    from auth.users u
    where u.id = v_user
      and u.raw_app_meta_data ->> 'user_type' = 'student';

    if found then
        return jsonb_build_object(
            'user_id', v_user,
            'tier', 'student',
            'status', null::text,
            'source', 'managed',
            'current_period_end', null::timestamptz,
            'limits', public.tier_limits ('student')
        );
    end if;

    -- Own subscription first. Highest tier wins if somehow more than one is live.
    select s.tier, s.status, s.current_period_end
    into v_sub
    from public.subscriptions s
    where s.user_id = v_user
      and s.mode = any (public.entitling_billing_modes ())
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
    order by case s.tier when 'academy' then 3 when 'teacher' then 2 when 'personal' then 1 else 0 end desc,
             s.current_period_end desc nulls last
    limit 1;

    if found then
        v_tier := v_sub.tier;
        v_status := v_sub.status;
        v_period_end := v_sub.current_period_end;
        v_source := 'subscription';
    else
        -- Otherwise: a seat in an academy whose owner is paying.
        select s.status, s.current_period_end
        into v_sub
        from public.studio_members sm
        join public.studios st on st.id = sm.studio_id
        join public.subscriptions s on s.user_id = st.owner_id
        where sm.user_id = v_user
          and s.tier = 'academy'
          and s.mode = any (public.entitling_billing_modes ())
          and s.status in ('active', 'trialing')
          and (s.current_period_end is null or s.current_period_end > now())
        order by s.current_period_end desc nulls last
        limit 1;

        if found then
            v_tier := 'academy';
            v_status := v_sub.status;
            v_period_end := v_sub.current_period_end;
            v_source := 'studio_member';
        end if;
    end if;

    return jsonb_build_object(
        'user_id', v_user,
        'tier', v_tier,
        'status', v_status,
        'source', v_source,
        'current_period_end', v_period_end,
        'limits', public.tier_limits (v_tier)
    );
end;
$$;

-- ===== supabase/migrations/20260829130000_support_messages.sql =====
-- Inbound support mail, as received by Resend.
--
-- The endpoint that fills this table (`resend-inbound`) forwards each message on
-- to a human mailbox, but forwarding is delivery, not storage: a forward that
-- bounces is gone, and a mailbox is a poor thing to query. This table is the
-- durable record — the one an agentic triage pass reads from later, rather than
-- re-parsing email.
--
-- `resend_email_id` is UNIQUE and that is load-bearing, exactly as
-- `stripe_events.id` is: Svix retries a delivery until it gets a 2xx, so the
-- same message arrives more than once as a matter of routine, and the insert is
-- what makes the second arrival a no-op instead of a second forwarded email.
--
-- No RLS policy is declared, deliberately. RLS is enabled and every grant is
-- revoked, so the table is reachable only by the service role — i.e. only from
-- an Edge Function. Support mail is written by strangers and can contain
-- anything a customer chose to type: an account number, a password they should
-- not have sent, a complaint about another user. None of it belongs in a
-- browser, so no client role can read it at all.
create table public.support_messages (
    id uuid primary key default gen_random_uuid(),
    -- Resend's id for the received email; the idempotency key.
    resend_email_id text not null unique,
    -- The sending mail system's Message-ID, kept for threading a reply later.
    message_id text,
    from_address text not null,
    to_addresses text[] not null default '{}',
    -- Which of our addresses actually accepted it. With a catch-all domain this
    -- is how triage tells support@ from billing@ without parsing `to`.
    received_for text[] not null default '{}',
    subject text,
    text_body text,
    html_body text,
    -- Metadata only. Attachment bytes stay in Resend; storing them here would
    -- put unscanned stranger-supplied files in our own bucket.
    attachments jsonb not null default '[]'::jsonb,
    -- Null until the forward succeeds. A row with received_at set and
    -- forwarded_at null is precisely the "arrived but nobody was told" case,
    -- which is the one worth alerting on.
    forwarded_at timestamptz,
    forward_error text,
    received_at timestamptz not null,
    created_at timestamptz not null default now()
);

create index support_messages_received on public.support_messages (received_at desc);

-- Finds the arrived-but-not-forwarded rows without scanning the table.
create index support_messages_unforwarded on public.support_messages (received_at desc) where forwarded_at is null;

alter table public.support_messages enable row level security;

revoke all on table public.support_messages from public;

revoke all on table public.support_messages from anon;

revoke all on table public.support_messages from authenticated;

grant all on table public.support_messages to service_role;

-- ===== supabase/migrations/20260830101624_imslp_file_licenses.sql =====
-- Per-file IMSLP license cache: which editions can be downloaded directly.
-- Filled by imslp-work from the rendered work page (the only place IMSLP
-- exposes the regional Non-PD flags); read by imslp-download as a server-side
-- backstop before a smart_imports credit is spent on a restricted file.
-- 30-day staleness window is applied by the readers, not the schema.

create table public.imslp_file_licenses (
    filename text primary key,
    work_title text not null,
    license text not null,
    license_label text,
    restriction text,
    eu_hosted boolean not null default false,
    downloadable boolean not null,
    fetched_at timestamptz not null default now()
);

alter table public.imslp_file_licenses enable row level security;
-- Zero policies — service_role only, like score_cache.
grant all on public.imslp_file_licenses to service_role;

-- ===== supabase/migrations/20260830120000_library_bootstrap_and_perf.sql =====
-- Perceived-load performance:
--  1. library_bootstrap() — one round-trip for library shell + page data.
--  2. RLS initplan: wrap auth.uid() in (select …) for favorites + document_role.
--  3. Index omr_jobs(created_by) for enqueue / active-job counts.

-- ---------------------------------------------------------------------------
-- library_bootstrap
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so we can assemble a single JSON payload, but every select
-- is scoped to auth.uid() explicitly (RLS is bypassed under definer). Matches
-- documents_select / favorites / library_tags / document_tags visibility.

create or replace function public.library_bootstrap ()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_uid uuid := (select auth.uid());
    v_rows jsonb;
    v_count int;
    v_favorites jsonb;
    v_tags jsonb;
    v_document_tags jsonb;
    v_entitlements jsonb;
begin
    if v_uid is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;

    with visible as (
        select
            d.id,
            d.owner_id,
            d.title,
            d.storage_path,
            d.page_count,
            d.content_rev,
            d.created_at,
            d.updated_at,
            d.archived_at
        from public.documents d
        where d.owner_id = v_uid
           or exists (
                select 1
                from public.document_members m
                where m.document_id = d.id
                  and m.user_id = v_uid
            )
        order by d.updated_at desc
        limit 101
    ),
    counted as (
        select count(*)::int as total from visible
    ),
    page as (
        select * from visible limit 100
    )
    select
        coalesce(
            (select jsonb_agg(to_jsonb(p) order by p.updated_at desc) from page p),
            '[]'::jsonb
        ),
        (select total from counted)
    into v_rows, v_count;

    select coalesce(jsonb_agg(f.document_id), '[]'::jsonb)
    into v_favorites
    from public.document_favorites f
    where f.user_id = v_uid;

    select coalesce(
        jsonb_agg(
            jsonb_build_object(
                'id', t.id,
                'user_id', t.user_id,
                'name', t.name,
                'created_at', t.created_at
            )
            order by t.name asc
        ),
        '[]'::jsonb
    )
    into v_tags
    from public.library_tags t
    where t.user_id = v_uid;

    select coalesce(
        jsonb_agg(
            jsonb_build_object(
                'document_id', dt.document_id,
                'tag_id', dt.tag_id
            )
        ),
        '[]'::jsonb
    )
    into v_document_tags
    from public.document_tags dt
    join public.library_tags t on t.id = dt.tag_id
    where t.user_id = v_uid;

    v_entitlements := public.get_entitlements ();

    return jsonb_build_object(
        'documents', v_rows,
        'has_more', v_count > 100,
        'favorite_ids', v_favorites,
        'tags', v_tags,
        'document_tags', v_document_tags,
        'entitlements', v_entitlements
    );
end;
$$;

revoke all on function public.library_bootstrap () from public;
revoke all on function public.library_bootstrap () from anon;
grant execute on function public.library_bootstrap () to authenticated;

-- ---------------------------------------------------------------------------
-- RLS initplan fixes
-- ---------------------------------------------------------------------------
create or replace function public.document_role (doc uuid) returns text language sql stable security definer
set search_path = public as $$
    select role from public.document_members
    where document_id = doc and user_id = (select auth.uid());
$$;

drop policy if exists favorites_select on public.document_favorites;
create policy favorites_select on public.document_favorites for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists favorites_insert on public.document_favorites;
create policy favorites_insert on public.document_favorites for insert to authenticated
with check (
    user_id = (select auth.uid())
    and public.document_role (document_id) is not null
);

drop policy if exists favorites_delete on public.document_favorites;
create policy favorites_delete on public.document_favorites for delete to authenticated
using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- omr_jobs.created_by — filtered by enqueue / active-job count
-- ---------------------------------------------------------------------------
create index if not exists omr_jobs_created_by_idx
    on public.omr_jobs (created_by);

-- ===== supabase/migrations/20260831090000_imslp_category_members.sql =====
-- Cached IMSLP category membership for Walker-style chip browse.
-- Filled by imslp-category-sync (paged categorymembers); read by imslp-search
-- via imslp_intersect_categories. Until a snapshot is `ok`, search bootstraps
-- from the curated Popular list plus a small extras set.

create table public.imslp_category_members (
    category text not null,
    page_title text not null,
    page_id bigint,
    last_seen_at timestamptz not null default now(),
    primary key (category, page_title)
);

create index imslp_category_members_title_idx on public.imslp_category_members (page_title);

create table public.imslp_category_snapshots (
    category text primary key,
    status text not null check (status in ('ok', 'partial', 'error')),
    member_count integer not null default 0,
    resume_token text,
    synced_at timestamptz not null default now()
);

alter table public.imslp_category_members enable row level security;
alter table public.imslp_category_snapshots enable row level security;

revoke all on table public.imslp_category_members from public;
revoke all on table public.imslp_category_members from anon;
revoke all on table public.imslp_category_members from authenticated;
revoke all on table public.imslp_category_snapshots from public;
revoke all on table public.imslp_category_snapshots from anon;
revoke all on table public.imslp_category_snapshots from authenticated;

grant all on table public.imslp_category_members to service_role;
grant all on table public.imslp_category_snapshots to service_role;

-- AND of OR-clauses: each jsonb array is a set of categories (instrument ∪ arr).
create or replace function public.imslp_intersect_categories (p_clauses jsonb)
    returns table (page_title text)
    language plpgsql
    stable
    set search_path = public
as $$
declare
    clause jsonb;
    first_clause boolean := true;
    sql text := '';
    cats text[];
begin
    if p_clauses is null
        or jsonb_typeof(p_clauses) <> 'array'
        or jsonb_array_length(p_clauses) = 0 then
        return;
    end if;

    for clause in select value from jsonb_array_elements(p_clauses)
    loop
        if jsonb_typeof(clause) <> 'array' or jsonb_array_length(clause) = 0 then
            return;
        end if;
        select coalesce(array_agg(value), '{}') into cats
        from jsonb_array_elements_text(clause);
        if first_clause then
            sql := format(
                'select m.page_title from public.imslp_category_members m where m.category = any (%L)',
                cats
            );
            first_clause := false;
        else
            sql := sql || format(
                ' intersect select m.page_title from public.imslp_category_members m where m.category = any (%L)',
                cats
            );
        end if;
    end loop;

    return query execute sql;
end;
$$;

revoke all on function public.imslp_intersect_categories (jsonb) from public;
revoke all on function public.imslp_intersect_categories (jsonb) from anon;
revoke all on function public.imslp_intersect_categories (jsonb) from authenticated;
grant execute on function public.imslp_intersect_categories (jsonb) to service_role;

-- ===== supabase/migrations/20260902120000_imslp_category_index.sql =====
-- IMSLP category membership index: cached Category Walker intersections.
-- Filled by the imslp-sync edge function (resumable categorymembers pager);
-- read by imslp-search via imslp_browse / imslp_index_ready /
-- imslp_titles_in_categories. Snapshots roll over by generation so a
-- mid-category failure leaves the previous ok generation live.
--
-- Vault secrets imslp_sync_url + imslp_sync_secret must be created
-- out-of-band (see SETUP_SUPABASE.md). If missing, the cron tick is a no-op.
--
-- Supersedes 20260831090000 (imslp_category_snapshots + imslp_intersect_categories).

drop function if exists public.imslp_intersect_categories (jsonb);
drop table if exists public.imslp_category_snapshots;
drop table if exists public.imslp_category_members;
drop table if exists public.imslp_category_sync;

create table public.imslp_category_members (
    category text not null,
    page_title text not null,
    page_id int not null,
    sort_key text,
    touched timestamptz,
    generation int not null,
    primary key (category, generation, page_title)
);

create index imslp_category_members_cat_gen_title
    on public.imslp_category_members (category, generation, page_title);

create index imslp_category_members_cat_gen_touched
    on public.imslp_category_members (category, generation, touched desc);

alter table public.imslp_category_members enable row level security;
-- Zero policies — service_role only, like imslp_file_licenses.
grant all on public.imslp_category_members to service_role;

create table public.imslp_category_sync (
    category text primary key,
    state text not null default 'never'
        check (state in ('never', 'building', 'ok', 'failed')),
    active_generation int not null default 0,
    building_generation int not null default 0,
    cmcontinue text,
    pages_done int not null default 0,
    last_error text,
    completed_at timestamptz,
    updated_at timestamptz not null default now()
);

alter table public.imslp_category_sync enable row level security;
grant all on public.imslp_category_sync to service_role;

-- Browse: each group is a UNION of its categories at that category's
-- active_generation; groups are INTERSECTed. total is a window count so
-- the caller can page and show a status line.
create or replace function public.imslp_browse (
    groups jsonb,
    sort text,
    lim int,
    off int
)
returns table (
    page_title text,
    page_id int,
    touched timestamptz,
    total bigint
)
language sql
stable
security definer
set search_path = public
as $$
    with bounds as (
        select
            case
                when sort in ('title', 'recent', 'relevance') then sort
                else 'relevance'
            end as sort_key,
            least(greatest(coalesce(lim, 50), 1), 300) as page_lim,
            greatest(coalesce(off, 0), 0) as page_off
    ),
    group_cats as (
        select
            g.ordinality::int as group_idx,
            cat.value as category
        from jsonb_array_elements(coalesce(groups, '[]'::jsonb)) with ordinality as g (value, ordinality)
        cross join lateral jsonb_array_elements_text(g.value) as cat (value)
        where jsonb_typeof(g.value) = 'array'
    ),
    group_count as (
        select count(distinct group_idx)::int as n from group_cats
    ),
    members as (
        select
            gc.group_idx,
            m.page_title,
            m.page_id,
            m.touched
        from group_cats gc
        join public.imslp_category_sync s
            on s.category = gc.category
        join public.imslp_category_members m
            on m.category = gc.category
            and m.generation = s.active_generation
        where s.active_generation > 0
    ),
    per_group as (
        select distinct group_idx, page_title, page_id, touched
        from members
    ),
    intersected as (
        select
            pg.page_title,
            min(pg.page_id) as page_id,
            max(pg.touched) as touched
        from per_group pg
        cross join group_count gc
        where gc.n > 0
        group by pg.page_title, gc.n
        having count(distinct pg.group_idx) = gc.n
    ),
    ordered as (
        select
            i.page_title,
            i.page_id,
            i.touched,
            count(*) over () as total,
            b.sort_key
        from intersected i
        cross join bounds b
    )
    select
        o.page_title,
        o.page_id,
        o.touched,
        o.total
    from ordered o
    cross join bounds b
    order by
        case when b.sort_key = 'recent' then o.touched end desc nulls last,
        case when b.sort_key = 'relevance' then char_length(o.page_title) end asc,
        o.page_title asc
    limit (select page_lim from bounds)
    offset (select page_off from bounds);
$$;

-- Categories in the argument list that have no ok snapshot yet.
create or replace function public.imslp_index_ready (categories text[])
returns text[]
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(array_agg(c order by c), '{}'::text[])
    from unnest(coalesce(categories, '{}'::text[])) as c
    where not exists (
        select 1
        from public.imslp_category_sync s
        where s.category = c
          and s.state = 'ok'
          and s.active_generation > 0
    );
$$;

-- Membership lookup for typed-search hard filters (cache first).
create or replace function public.imslp_titles_in_categories (
    titles text[],
    categories text[]
)
returns table (
    page_title text,
    category text
)
language sql
stable
security definer
set search_path = public
as $$
    select m.page_title, m.category
    from public.imslp_category_members m
    join public.imslp_category_sync s
        on s.category = m.category
        and m.generation = s.active_generation
    where s.state = 'ok'
      and s.active_generation > 0
      and m.page_title = any (coalesce(titles, '{}'::text[]))
      and m.category = any (coalesce(categories, '{}'::text[]));
$$;

revoke all on function public.imslp_browse (jsonb, text, int, int) from public, anon, authenticated;
grant execute on function public.imslp_browse (jsonb, text, int, int) to service_role;

revoke all on function public.imslp_index_ready (text[]) from public, anon, authenticated;
grant execute on function public.imslp_index_ready (text[]) to service_role;

revoke all on function public.imslp_titles_in_categories (text[], text[]) from public, anon, authenticated;
grant execute on function public.imslp_titles_in_categories (text[], text[]) to service_role;

-- Hosted refresh: same pg_cron + pg_net + vault pattern as omr_sweep.
-- Extensions are already enabled by 20260806140000_omr_cron.sql.
create or replace function public.imslp_sync_tick ()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
    sync_url text;
    sync_secret text;
begin
    select decrypted_secret into sync_url
    from vault.decrypted_secrets
    where name = 'imslp_sync_url'
    limit 1;

    select decrypted_secret into sync_secret
    from vault.decrypted_secrets
    where name = 'imslp_sync_secret'
    limit 1;

    if sync_url is null or sync_secret is null or length(trim(sync_url)) = 0 then
        raise notice 'imslp_sync_tick: vault secrets imslp_sync_url/imslp_sync_secret missing — skip';
        return;
    end if;

    perform net.http_post(
        url := rtrim(sync_url, '/'),
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-imslp-sync-secret', sync_secret
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 5000
    );
end;
$$;

revoke all on function public.imslp_sync_tick () from public, anon, authenticated;
grant execute on function public.imslp_sync_tick () to service_role;

do $$
begin
    perform cron.unschedule (jobid)
    from cron.job
    where jobname = 'imslp-sync';
exception
    when undefined_table then null;
    when others then null;
end;
$$;

select cron.schedule ('imslp-sync', '*/2 * * * *', $$select public.imslp_sync_tick ()$$);

-- ===== supabase/migrations/20260902130000_thumbnails.sql =====
-- Server-stored library thumbnails.
--
-- The library used to draw a cover only for scores whose PDF this device had
-- already downloaded — pdf.js rendering the first page from the Dexie cache. A
-- fresh browser therefore showed a placeholder for every score until each was
-- opened. Edge Functions cannot render PDFs (no canvas), so the client that
-- already renders a first page — on upload, on import, or on any device that
-- holds the bytes — publishes that render once, and every other device
-- downloads a ~40 KB image instead of a multi-megabyte PDF.
--
--  1. documents.thumb_rev — the content_rev the published cover was rendered
--     from; null means none yet (a fresh upload is content_rev 0, so 0 has
--     to be a real revision). Read by the library list, written by the owner
--     after a successful publish (documents_update is owner-only).
--  2. library_bootstrap() carries the new column.
--  3. A private `thumbnails` bucket, object path `{documentId}/{rev}.jpg`,
--     with the same membership policies as `scores`: members read, owner
--     writes. The bucket row is attempted here and documented in
--     SETUP_SUPABASE.md, because hosted projects can refuse storage.buckets
--     writes from migrations (see the `scores` note in 20260801160754_rls).

alter table public.documents
    add column if not exists thumb_rev integer;

-- ---------------------------------------------------------------------------
-- library_bootstrap — same body as 20260830120000, plus d.thumb_rev
-- ---------------------------------------------------------------------------
create or replace function public.library_bootstrap ()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_uid uuid := (select auth.uid());
    v_rows jsonb;
    v_count int;
    v_favorites jsonb;
    v_tags jsonb;
    v_document_tags jsonb;
    v_entitlements jsonb;
begin
    if v_uid is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;

    with visible as (
        select
            d.id,
            d.owner_id,
            d.title,
            d.storage_path,
            d.page_count,
            d.content_rev,
            d.thumb_rev,
            d.created_at,
            d.updated_at,
            d.archived_at
        from public.documents d
        where d.owner_id = v_uid
           or exists (
                select 1
                from public.document_members m
                where m.document_id = d.id
                  and m.user_id = v_uid
            )
        order by d.updated_at desc
        limit 101
    ),
    counted as (
        select count(*)::int as total from visible
    ),
    page as (
        select * from visible limit 100
    )
    select
        coalesce(
            (select jsonb_agg(to_jsonb(p) order by p.updated_at desc) from page p),
            '[]'::jsonb
        ),
        (select total from counted)
    into v_rows, v_count;

    select coalesce(jsonb_agg(f.document_id), '[]'::jsonb)
    into v_favorites
    from public.document_favorites f
    where f.user_id = v_uid;

    select coalesce(
        jsonb_agg(
            jsonb_build_object(
                'id', t.id,
                'user_id', t.user_id,
                'name', t.name,
                'created_at', t.created_at
            )
            order by t.name asc
        ),
        '[]'::jsonb
    )
    into v_tags
    from public.library_tags t
    where t.user_id = v_uid;

    select coalesce(
        jsonb_agg(
            jsonb_build_object(
                'document_id', dt.document_id,
                'tag_id', dt.tag_id
            )
        ),
        '[]'::jsonb
    )
    into v_document_tags
    from public.document_tags dt
    join public.library_tags t on t.id = dt.tag_id
    where t.user_id = v_uid;

    v_entitlements := public.get_entitlements ();

    return jsonb_build_object(
        'documents', v_rows,
        'has_more', v_count > 100,
        'favorite_ids', v_favorites,
        'tags', v_tags,
        'document_tags', v_document_tags,
        'entitlements', v_entitlements
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- thumbnails bucket + policies
-- ---------------------------------------------------------------------------
do $$
begin
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('thumbnails', 'thumbnails', false, 2097152, array['image/jpeg'])
    on conflict (id) do nothing;
exception
    when insufficient_privilege then
        -- Hosted projects may refuse storage.buckets writes from a migration
        -- (SQLSTATE 42501); the dashboard step in SETUP_SUPABASE.md creates
        -- the bucket by hand. Any other error must fail the migration.
        raise notice 'thumbnails bucket not created here (%): create it in the dashboard', sqlerrm;
end;
$$;

drop policy if exists thumbnails_read on storage.objects;
create policy thumbnails_read on storage.objects for select to authenticated
using (
    bucket_id = 'thumbnails'
    and public.document_role (((storage.foldername (name))[1])::uuid) is not null
);

drop policy if exists thumbnails_insert on storage.objects;
create policy thumbnails_insert on storage.objects for insert to authenticated
with check (
    bucket_id = 'thumbnails'
    and public.document_role (((storage.foldername (name))[1])::uuid) = 'owner'
);

drop policy if exists thumbnails_update on storage.objects;
create policy thumbnails_update on storage.objects for update to authenticated
using (
    bucket_id = 'thumbnails'
    and public.document_role (((storage.foldername (name))[1])::uuid) = 'owner'
);

drop policy if exists thumbnails_delete on storage.objects;
create policy thumbnails_delete on storage.objects for delete to authenticated
using (
    bucket_id = 'thumbnails'
    and public.document_role (((storage.foldername (name))[1])::uuid) = 'owner'
);

-- ===== supabase/migrations/20260903090000_imslp_browse_title_filters.sql =====
-- imslp_browse: apply key-chip title filters inside the intersection and let the
-- curated Popular list lead the relevance order.
--
-- Key has no IMSLP category, so imslp-search used to filter the returned page by
-- title after paging: Piano · C major reported total 62,947 with zero rows on the
-- first page. title_filters (case-insensitive regexes, any-of) now narrow the
-- intersection before total/limit/offset are computed. popular_titles puts the
-- curated works first under `relevance`; shortest title was the only prior.

drop function if exists public.imslp_browse (jsonb, text, int, int);

create or replace function public.imslp_browse (
    groups jsonb,
    sort text,
    lim int,
    off int,
    title_filters text[] default '{}'::text[],
    popular_titles text[] default '{}'::text[]
)
returns table (
    page_title text,
    page_id int,
    touched timestamptz,
    total bigint
)
language sql
stable
security definer
set search_path = public
as $$
    with bounds as (
        select
            case
                when sort in ('title', 'recent', 'relevance') then sort
                else 'relevance'
            end as sort_key,
            least(greatest(coalesce(lim, 50), 1), 300) as page_lim,
            greatest(coalesce(off, 0), 0) as page_off,
            coalesce(title_filters, '{}'::text[]) as filters,
            coalesce(popular_titles, '{}'::text[]) as popular
    ),
    group_cats as (
        select
            g.ordinality::int as group_idx,
            cat.value as category
        from jsonb_array_elements(coalesce(groups, '[]'::jsonb)) with ordinality as g (value, ordinality)
        cross join lateral jsonb_array_elements_text(g.value) as cat (value)
        where jsonb_typeof(g.value) = 'array'
    ),
    group_count as (
        select count(distinct group_idx)::int as n from group_cats
    ),
    members as (
        select
            gc.group_idx,
            m.page_title,
            m.page_id,
            m.touched
        from group_cats gc
        join public.imslp_category_sync s
            on s.category = gc.category
        join public.imslp_category_members m
            on m.category = gc.category
            and m.generation = s.active_generation
        where s.active_generation > 0
    ),
    per_group as (
        select distinct group_idx, page_title, page_id, touched
        from members
    ),
    intersected as (
        select
            pg.page_title,
            min(pg.page_id) as page_id,
            max(pg.touched) as touched
        from per_group pg
        cross join group_count gc
        where gc.n > 0
        group by pg.page_title, gc.n
        having count(distinct pg.group_idx) = gc.n
    ),
    narrowed as (
        select i.*
        from intersected i
        cross join bounds b
        where cardinality(b.filters) = 0
           or exists (
               select 1
               from unnest(b.filters) as f (pattern)
               where i.page_title ~* f.pattern
           )
    ),
    ordered as (
        select
            n.page_title,
            n.page_id,
            n.touched,
            count(*) over () as total,
            (n.page_title = any (b.popular)) as is_popular,
            b.sort_key
        from narrowed n
        cross join bounds b
    )
    select
        o.page_title,
        o.page_id,
        o.touched,
        o.total
    from ordered o
    cross join bounds b
    order by
        case when b.sort_key = 'recent' then o.touched end desc nulls last,
        case when b.sort_key = 'relevance' then o.is_popular end desc,
        case when b.sort_key = 'relevance' then char_length(o.page_title) end asc,
        o.page_title asc
    limit (select page_lim from bounds)
    offset (select page_off from bounds);
$$;

revoke all on function public.imslp_browse (jsonb, text, int, int, text[], text[]) from public, anon, authenticated;
grant execute on function public.imslp_browse (jsonb, text, int, int, text[], text[]) to service_role;

-- ===== supabase/migrations/20260903091000_imslp_index_ready_live_snapshot.sql =====
-- A category is ready while it has a live snapshot (active_generation > 0),
-- whatever its sync state. imslp_index_ready and imslp_titles_in_categories
-- required state = 'ok', so during every refresh tick the category being
-- rebuilt (For piano first, ~3 minutes) read as missing: chips fell back to
-- "Index still building" and typed search to live MediaWiki category checks,
-- even though generation-based rollover keeps the previous snapshot serving.
-- imslp_browse already reads active_generation only.

create or replace function public.imslp_index_ready (categories text[])
returns text[]
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(array_agg(c order by c), '{}'::text[])
    from unnest(coalesce(categories, '{}'::text[])) as c
    where not exists (
        select 1
        from public.imslp_category_sync s
        where s.category = c
          and s.active_generation > 0
    );
$$;

create or replace function public.imslp_titles_in_categories (
    titles text[],
    categories text[]
)
returns table (
    page_title text,
    category text
)
language sql
stable
security definer
set search_path = public
as $$
    select m.page_title, m.category
    from public.imslp_category_members m
    join public.imslp_category_sync s
        on s.category = m.category
        and m.generation = s.active_generation
    where s.active_generation > 0
      and m.page_title = any (coalesce(titles, '{}'::text[]))
      and m.category = any (coalesce(categories, '{}'::text[]));
$$;

-- ===== supabase/migrations/20260907120000_imslp_works_mirror.sql =====
-- IMSLP works mirror: one row per work page with the taxonomy categories it
-- belongs to. The committed catalog (scripts/data/imslp-works-catalog.jsonl.gz)
-- is loaded by a later migration; this file only creates the live table.
--
-- Chip browse is one GIN lookup on `categories`. Refresh ticks write
-- imslp_works_building (next migration) and promote onto this snapshot.
-- imslp_category_members stays until the catalog migration has filled
-- imslp_works, so a failed catalog load does not wipe the old index.

create table public.imslp_works (
    page_id int primary key,
    page_title text not null,
    composer text,
    categories text[] not null default '{}'::text[],
    touched timestamptz,
    seen_at timestamptz not null default now()
);

create index imslp_works_categories_gin on public.imslp_works using gin (categories);
create index imslp_works_page_title on public.imslp_works (page_title);

alter table public.imslp_works enable row level security;
-- Zero policies — service_role only, like imslp_category_sync.
grant all on public.imslp_works to service_role;

alter table public.imslp_category_sync add column if not exists building_started_at timestamptz;

-- ===== supabase/migrations/20260909153000_imslp_works_snapshot_isolation.sql =====
-- Isolate works-mirror refreshes the way imslp_category_members generations
-- used to: building ticks write imslp_works_building; readers only see
-- imslp_works. Promote+prune is one transaction after the walk completes, so
-- imslp_index_ready (active_generation > 0) never serves a half-refreshed
-- category. Membership from other completed anchors is unioned, not replaced.
--
-- imslp_browse is restored as a wrapper over imslp_browse_works so a live
-- `dev` edge that still RPCs the old name does not 404 after this lands.

create table public.imslp_works_building (
    page_id int not null,
    generation int not null,
    anchor text not null,
    page_title text not null,
    composer text,
    categories text[] not null default '{}'::text[],
    touched timestamptz,
    seen_at timestamptz not null default now(),
    primary key (page_id, generation, anchor)
);

create index imslp_works_building_anchor_gen
    on public.imslp_works_building (anchor, generation);

alter table public.imslp_works_building enable row level security;

revoke all on table public.imslp_works from public, anon, authenticated;
revoke all on table public.imslp_works_building from public, anon, authenticated;
grant all on table public.imslp_works to service_role;
grant all on table public.imslp_works_building to service_role;

drop function if exists public.imslp_prune_anchor (text, timestamptz);
drop function if exists public.imslp_browse_works (jsonb, text, int, int, text[]);
drop function if exists public.imslp_browse_works (jsonb, text, int, int, text[], text[]);
drop function if exists public.imslp_browse (jsonb, text, int, int, text[], text[]);
drop function if exists public.imslp_browse (jsonb, text, int, int);

-- Browse live snapshot only. title_filters keeps the old `dev` key-chip
-- contract (any-of case-insensitive regex) for the compatibility wrapper.
create or replace function public.imslp_browse_works (
    groups jsonb,
    sort text,
    lim int,
    off int,
    popular_titles text[] default '{}'::text[],
    title_filters text[] default '{}'::text[]
)
returns table (
    page_title text,
    page_id int,
    touched timestamptz,
    total bigint
)
language sql
stable
security definer
set search_path = public
as $$
    with bounds as (
        select
            case
                when sort in ('title', 'recent', 'relevance') then sort
                else 'relevance'
            end as sort_key,
            least(greatest(coalesce(lim, 50), 1), 300) as page_lim,
            greatest(coalesce(off, 0), 0) as page_off,
            coalesce(popular_titles, '{}'::text[]) as popular,
            coalesce(title_filters, '{}'::text[]) as filters
    ),
    group_arrays as (
        select array_agg(cat.value) as cats
        from jsonb_array_elements(coalesce(groups, '[]'::jsonb)) with ordinality as g (value, ordinality)
        cross join lateral jsonb_array_elements_text(g.value) as cat (value)
        where jsonb_typeof(g.value) = 'array'
        group by g.ordinality
    ),
    group_count as (
        select count(*)::int as n from group_arrays
    ),
    matched as (
        select w.page_title, w.page_id, w.touched
        from public.imslp_works w
        cross join group_count gc
        cross join bounds b
        where gc.n > 0
          and not exists (
              select 1
              from group_arrays ga
              where not (w.categories && ga.cats)
          )
          and (
              cardinality(b.filters) = 0
              or exists (
                  select 1
                  from unnest(b.filters) as f (pattern)
                  where w.page_title ~* f.pattern
              )
          )
    ),
    ordered as (
        select
            m.page_title,
            m.page_id,
            m.touched,
            count(*) over () as total,
            (m.page_title = any (b.popular)) as is_popular,
            b.sort_key
        from matched m
        cross join bounds b
    )
    select
        o.page_title,
        o.page_id,
        o.touched,
        o.total
    from ordered o
    cross join bounds b
    order by
        case when b.sort_key = 'recent' then o.touched end desc nulls last,
        case when b.sort_key = 'relevance' then o.is_popular end desc,
        case when b.sort_key = 'relevance' then char_length(o.page_title) end asc,
        o.page_title asc
    limit (select page_lim from bounds)
    offset (select page_off from bounds);
$$;

create or replace function public.imslp_browse (
    groups jsonb,
    sort text,
    lim int,
    off int,
    title_filters text[] default '{}'::text[],
    popular_titles text[] default '{}'::text[]
)
returns table (
    page_title text,
    page_id int,
    touched timestamptz,
    total bigint
)
language sql
stable
security definer
set search_path = public
as $$
    select *
    from public.imslp_browse_works (groups, sort, lim, off, popular_titles, title_filters);
$$;

-- Live snapshot only. Building rows are invisible until promote.
create or replace function public.imslp_titles_in_categories (
    titles text[],
    categories text[]
)
returns table (
    page_title text,
    category text
)
language sql
stable
security definer
set search_path = public
as $$
    select w.page_title, c.category
    from public.imslp_works w
    cross join lateral unnest(w.categories) as c (category)
    where w.page_title = any (coalesce(titles, '{}'::text[]))
      and c.category = any (coalesce(categories, '{}'::text[]));
$$;

-- Atomic rollover: union this walk into the live snapshot, drop the walked
-- anchor from live pages this generation did not see, then drop the building
-- rows. seen_at of some other anchor cannot keep a stale membership.
create or replace function public.imslp_promote_anchor (
    anchor text,
    generation int
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    pruned int;
begin
    if anchor is null or generation is null or generation <= 0 then
        return 0;
    end if;

    insert into public.imslp_works as live (page_id, page_title, composer, categories, touched, seen_at)
    select b.page_id, b.page_title, b.composer, b.categories, b.touched, b.seen_at
    from public.imslp_works_building b
    where b.anchor = imslp_promote_anchor.anchor
      and b.generation = imslp_promote_anchor.generation
    on conflict (page_id) do update set
        page_title = excluded.page_title,
        composer = coalesce(excluded.composer, live.composer),
        categories = (
            select coalesce(array_agg(x.cat), '{}'::text[])
            from (
                select distinct c.cat
                from unnest(live.categories || excluded.categories) as c (cat)
                where c.cat is not null and c.cat <> ''
            ) x
        ),
        touched = coalesce(excluded.touched, live.touched),
        seen_at = excluded.seen_at;

    update public.imslp_works w
    set categories = array_remove(w.categories, imslp_promote_anchor.anchor)
    where imslp_promote_anchor.anchor = any (w.categories)
      and not exists (
          select 1
          from public.imslp_works_building b
          where b.anchor = imslp_promote_anchor.anchor
            and b.generation = imslp_promote_anchor.generation
            and b.page_id = w.page_id
      );
    get diagnostics pruned = row_count;

    delete from public.imslp_works where cardinality(categories) = 0;

    delete from public.imslp_works_building
    where imslp_works_building.anchor = imslp_promote_anchor.anchor
      and imslp_works_building.generation <= imslp_promote_anchor.generation;

    return pruned;
end;
$$;

create or replace function public.imslp_sync_tick ()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
    sync_url text;
    sync_secret text;
begin
    select decrypted_secret into sync_url
    from vault.decrypted_secrets
    where name = 'imslp_sync_url'
    limit 1;

    select decrypted_secret into sync_secret
    from vault.decrypted_secrets
    where name = 'imslp_sync_secret'
    limit 1;

    if sync_url is null or sync_secret is null or length(trim(sync_url)) = 0 then
        raise notice 'imslp_sync_tick: vault secrets imslp_sync_url/imslp_sync_secret missing — skip';
        return;
    end if;

    perform net.http_post(
        url := rtrim(sync_url, '/'),
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-imslp-sync-secret', sync_secret
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 120000
    );
end;
$$;

revoke all on function public.imslp_browse_works (jsonb, text, int, int, text[], text[]) from public, anon, authenticated;
grant execute on function public.imslp_browse_works (jsonb, text, int, int, text[], text[]) to service_role;

revoke all on function public.imslp_browse (jsonb, text, int, int, text[], text[]) from public, anon, authenticated;
grant execute on function public.imslp_browse (jsonb, text, int, int, text[], text[]) to service_role;

revoke all on function public.imslp_titles_in_categories (text[], text[]) from public, anon, authenticated;
grant execute on function public.imslp_titles_in_categories (text[], text[]) to service_role;

revoke all on function public.imslp_promote_anchor (text, int) from public, anon, authenticated;
grant execute on function public.imslp_promote_anchor (text, int) to service_role;

revoke all on function public.imslp_sync_tick () from public, anon, authenticated;
grant execute on function public.imslp_sync_tick () to service_role;

-- ===== supabase/migrations/20261007120000_sharing_access_control.sql =====
-- Sharing & access control: owners manage who is on a score, members can leave,
-- and revoking a link can take back the access it handed out.
--
-- Before this, membership only ever grew. redeem_share_link and assign_score
-- were the only write paths, revoking a link set revoked_at and nothing else, so
-- everyone who had joined through it kept the score forever, and there was no
-- way to downgrade an editor or remove anyone short of deleting the score.
--
--  1. share_link_redemptions records which link a member's access came from, so
--     a revoke can optionally withdraw exactly that access. It is a side table,
--     not a column on document_members, on purpose:
--       * members_select lets EVERY member read every membership row on the
--         score. A token column there would hand a viewer the token of the
--         editor link somebody else joined through -- a working link, i.e. a
--         self-service upgrade to editor.
--       * Column-scoping document_members' select grant would close that, but
--         would also break `select *`, which the clients already in the field
--         use to read their own role (fetchMyRole) -- every deployed viewer
--         would fail to open a score in the window between this migration and
--         the frontend deploy.
--     The table has no client grants at all; only the definer functions below
--     read or write it.
--  2. Owner-only RPCs: list members (owners and editors may list; labels are
--     scoped to the caller's role), change a member's role, remove a member,
--     revoke a link with optional removal. A self-serve leave_document for
--     non-owners.
--     A role the owner set by hand sticks (document_member_role_locks): opening
--     an edit link again -- which a member does innocently, by re-clicking the
--     link in their email to get back to the score -- must not quietly undo a
--     downgrade the owner just made.
--  3. A trigger on document_members broadcasts a `membership` event on the
--     score's realtime topic whenever a role changes or a row disappears, so
--     an open viewer re-checks its access instead of discovering the change as
--     a stream of refused writes.
--
-- Roster students (managed_students + assignments) keep their own model: the
-- assignment is what grants their access, so
--  * changing their role here also flips assignments.access (the teacher's
--    Assign dialog and the student's list must agree with the membership),
--  * removing them here withdraws the assignment too -- a membership row the
--    assignment no longer backs, or an assignment with no membership, is the
--    drift unassign_score's comments warn about,
--  * revoking a link they also redeemed restores the assignment's role rather
--    than removing them, because the link was never the reason they had it,
--  * they cannot leave an assigned score themselves; it is the teacher's to
--    withdraw.

-- ---------------------------------------------------------------------------
-- Which link a member's access came from
-- ---------------------------------------------------------------------------
create table public.share_link_redemptions (
    document_id uuid not null,
    user_id uuid not null,
    -- Deleting the link (rather than revoking it) forgets the provenance; the
    -- membership itself is untouched, same as before this migration.
    token text not null references public.share_links (token) on delete cascade,
    redeemed_at timestamptz not null default now(),
    primary key (document_id, user_id),
    -- One row per membership, and it goes when the membership does -- however
    -- that happens (remove, leave, document delete, account delete).
    foreign key (document_id, user_id) references public.document_members (document_id, user_id) on delete cascade
);

create index share_link_redemptions_token on public.share_link_redemptions (token);

-- ---------------------------------------------------------------------------
-- Roles the owner set by hand
-- ---------------------------------------------------------------------------
-- redeem_share_link lifts a viewer to editor when they open an edit link. That
-- is right for someone a link let in, and wrong for someone the owner has just
-- turned into a viewer: without this, the owner's change would last until the
-- member next opened the link they joined with. A row here means "the owner
-- decided this member's role; links no longer change it". It goes with the
-- membership (removal, leave, document delete), so somebody who is removed and
-- later let back in by a link starts again as a link member.
--
-- Private for the same reason as share_link_redemptions: members_select shows
-- every member every row, and which collaborators the owner downgraded is not
-- theirs to read.
create table public.document_member_role_locks (
    document_id uuid not null,
    user_id uuid not null,
    locked_at timestamptz not null default now(),
    primary key (document_id, user_id),
    foreign key (document_id, user_id) references public.document_members (document_id, user_id) on delete cascade
);

alter table public.document_member_role_locks enable row level security;

revoke all on table public.document_member_role_locks from public;
revoke all on table public.document_member_role_locks from anon;
revoke all on table public.document_member_role_locks from authenticated;
grant all on table public.document_member_role_locks to service_role;

alter table public.share_link_redemptions enable row level security;

-- No policies and no client grants: provenance is read through
-- list_document_members (owner only sees tokens) and written by
-- redeem_share_link. service_role still needs the table-level grant.
revoke all on table public.share_link_redemptions from public;
revoke all on table public.share_link_redemptions from anon;
revoke all on table public.share_link_redemptions from authenticated;
grant all on table public.share_link_redemptions to service_role;

-- New links default to view-only. The client always sends a role, so this
-- only decides what a link created without one means -- and that should be
-- the role that cannot change anything.
alter table public.share_links alter column role set default 'viewer';

-- ---------------------------------------------------------------------------
-- Redemption: same contract as 20260801160754_rls.sql, plus provenance
-- ---------------------------------------------------------------------------
create or replace function public.redeem_share_link (p_token text) returns table (document_id uuid, granted_role text) language plpgsql security definer
set search_path = public as $$
-- OUT params (document_id) collide with column names inside the body (e.g.
-- the ON CONFLICT target) — let columns win; the OUTs are only set positionally.
#variable_conflict use_column
declare
    v_uid uuid := auth.uid();
    link record;
    v_prev_role text;
    v_new_role text;
begin
    if v_uid is null then
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

    select dm.role into v_prev_role
    from public.document_members dm
    where dm.document_id = link.document_id and dm.user_id = v_uid
    for update;

    -- The owner set this member's role by hand (set_document_member_role):
    -- the link opens the score for them, and changes nothing else -- not the
    -- role, and not where their access is recorded as coming from.
    if v_prev_role is not null and exists (
        select 1 from public.document_member_role_locks l
        where l.document_id = link.document_id and l.user_id = v_uid
    ) then
        return query select link.document_id, v_prev_role;
        return;
    end if;

    insert into public.document_members (document_id, user_id, role)
    values (link.document_id, v_uid, link.role)
    on conflict (document_id, user_id) do update
        set role = case
            when public.document_members.role = 'owner' then 'owner'
            when public.document_members.role = 'editor' then 'editor'
            else excluded.role
        end
    returning role into v_new_role;

    -- The link is recorded as the source only when it actually granted
    -- something: a first join, or a viewer lifted to editor. A redeem that
    -- changed nothing (an editor opening a view link, a member re-opening the
    -- link they joined with, another viewer link) leaves the existing source in
    -- place, so revoking THAT link still withdraws what it gave. An owner row
    -- has no source; nothing a link does can take ownership away.
    if v_new_role <> 'owner' and v_prev_role is distinct from v_new_role then
        insert into public.share_link_redemptions (document_id, user_id, token)
        values (link.document_id, v_uid, p_token)
        on conflict (document_id, user_id) do update
            set token = excluded.token,
                redeemed_at = now();
    end if;

    return query select link.document_id, v_new_role;
end;
$$;

revoke all on function public.redeem_share_link (text) from public;
revoke all on function public.redeem_share_link (text) from anon;
grant execute on function public.redeem_share_link (text) to authenticated;

-- ---------------------------------------------------------------------------
-- Internal helper: what a user leaves behind on a score they lost
-- ---------------------------------------------------------------------------
-- Favorites and tag assignments are the user's own rows and RLS hides nothing
-- about them, so without this the library would keep a starred id and a tag
-- count for a score it can no longer list. Not callable by clients: it takes
-- any user id, and is only ever reached from the definer functions below,
-- after they have decided the membership is gone.
create or replace function public.forget_document_for_user (p_document uuid, p_user uuid) returns void language sql security invoker
set search_path = public as $$
    delete from public.document_favorites
    where document_id = p_document
      and user_id = p_user;

    delete from public.document_tags dt
    using public.library_tags t
    where dt.document_id = p_document
      and dt.tag_id = t.id
      and t.user_id = p_user;
$$;

revoke all on function public.forget_document_for_user (uuid, uuid) from public;
revoke all on function public.forget_document_for_user (uuid, uuid) from anon;
revoke all on function public.forget_document_for_user (uuid, uuid) from authenticated;

-- ---------------------------------------------------------------------------
-- Member list
-- ---------------------------------------------------------------------------
-- auth.users is not client-readable, so labels have to be resolved behind a
-- definer boundary (same reason studio_roster exists). Owners and editors may
-- call it; viewers already read the bare membership rows through
-- members_select and get nothing more here.
--
-- What each caller sees is deliberately different. An editor may be a guest
-- who joined through a link the owner posted somewhere, so editors get the
-- names collaborators already show each other in presence (the account's own
-- display_name, which is also what a student account shows), and never an
-- email address, a link token, a roster name or whether someone is on an
-- assignment. The owner gets all of it: they are deciding who keeps access to
-- their score and need to recognise the account.
--
-- A roster name (managed_students.display_name) is the caller's own data only
-- when the student is on the CALLER's roster: another teacher's student who
-- joined by link shows the name their account shows everyone, and is not
-- "assigned" -- is_assigned is about assignments on this score, which is what
-- remove_document_member and revoke_share_link act on.
create or replace function public.list_document_members (p_document uuid) returns table (
    user_id uuid,
    role text,
    display_name text,
    email text,
    is_anonymous boolean,
    is_assigned boolean,
    joined_via_link text,
    joined_at timestamptz
) language plpgsql stable security definer
set search_path = public as $$
-- OUT params share names with the columns below; let columns win (see
-- redeem_share_link).
#variable_conflict use_column
declare
    v_caller uuid := auth.uid();
    v_role text;
    v_is_owner boolean;
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    v_role := public.document_role (p_document);
    if v_role is null or v_role not in ('owner', 'editor') then
        raise exception 'only the owner or an editor can list collaborators' using errcode = '42501';
    end if;
    v_is_owner := v_role = 'owner';

    return query
        select
            dm.user_id,
            dm.role,
            nullif(
                trim(coalesce(ms.display_name, u.raw_user_meta_data ->> 'display_name', '')),
                ''
            ),
            case when v_is_owner then u.email::text end,
            coalesce(u.is_anonymous, false),
            v_is_owner and exists (
                select 1 from public.assignments a
                where a.document_id = dm.document_id
                  and a.student_user_id = dm.user_id
            ),
            case when v_is_owner then r.token end,
            dm.created_at
        from public.document_members dm
        join auth.users u on u.id = dm.user_id
        left join public.managed_students ms
            on ms.student_user_id = dm.user_id
           and ms.teacher_id = v_caller
        left join public.share_link_redemptions r
            on r.document_id = dm.document_id
           and r.user_id = dm.user_id
        where dm.document_id = p_document
        order by (dm.role = 'owner') desc, dm.created_at asc, dm.user_id asc;
end;
$$;

revoke all on function public.list_document_members (uuid) from public;
revoke all on function public.list_document_members (uuid) from anon;
grant execute on function public.list_document_members (uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Change a member's role (owner only)
-- ---------------------------------------------------------------------------
create or replace function public.set_document_member_role (p_document uuid, p_user uuid, p_role text) returns void language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_current text;
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    -- document_role() reads auth.uid(), which is still the CALLER inside a
    -- definer function (see assign_score).
    if public.document_role (p_document) is distinct from 'owner' then
        raise exception 'only the score owner can change roles' using errcode = '42501';
    end if;

    -- 'owner' is not on offer: there is one owner, fixed by documents.owner_id,
    -- and handing the role out here would make a second one RLS would believe.
    if p_role is null or p_role not in ('editor', 'viewer') then
        raise exception 'role must be editor or viewer' using errcode = '22023';
    end if;

    select dm.role into v_current
    from public.document_members dm
    where dm.document_id = p_document and dm.user_id = p_user
    for update;

    if not found then
        raise exception 'not a member of this score' using errcode = 'P0002';
    end if;

    if v_current = 'owner' or exists (
        select 1 from public.documents d where d.id = p_document and d.owner_id = p_user
    ) then
        raise exception 'the owner''s access cannot be changed' using errcode = '42501';
    end if;

    -- Recorded even when the role is unchanged: the owner looked at this
    -- member and chose this role, and a link opened later must not change it
    -- (see document_member_role_locks).
    insert into public.document_member_role_locks (document_id, user_id)
    values (p_document, p_user)
    on conflict (document_id, user_id) do update
        set locked_at = now();

    if v_current = p_role then
        return;
    end if;

    update public.document_members
    set role = p_role
    where document_id = p_document and user_id = p_user;

    -- A roster student's access is the assignment's access. Keep them in step
    -- so the next assign_score (which re-applies `access`) does not silently
    -- undo this, and the teacher's Assign dialog shows what is true.
    update public.assignments
    set access = case when p_role = 'viewer' then 'view' else 'edit' end,
        updated_at = now()
    where document_id = p_document and student_user_id = p_user;
end;
$$;

revoke all on function public.set_document_member_role (uuid, uuid, text) from public;
revoke all on function public.set_document_member_role (uuid, uuid, text) from anon;
grant execute on function public.set_document_member_role (uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Remove a member (owner only)
-- ---------------------------------------------------------------------------
create or replace function public.remove_document_member (p_document uuid, p_user uuid) returns void language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_current text;
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    if public.document_role (p_document) is distinct from 'owner' then
        raise exception 'only the score owner can remove collaborators' using errcode = '42501';
    end if;

    select dm.role into v_current
    from public.document_members dm
    where dm.document_id = p_document and dm.user_id = p_user
    for update;

    if not found then
        raise exception 'not a member of this score' using errcode = 'P0002';
    end if;

    if v_current = 'owner' or exists (
        select 1 from public.documents d where d.id = p_document and d.owner_id = p_user
    ) then
        raise exception 'the owner cannot be removed from their own score' using errcode = '42501';
    end if;

    -- The assignment goes with the membership: an assignment whose score the
    -- student can no longer open is the drift unassign_score exists to prevent.
    delete from public.assignments
    where document_id = p_document and student_user_id = p_user;

    delete from public.document_members
    where document_id = p_document and user_id = p_user;

    perform public.forget_document_for_user (p_document, p_user);
end;
$$;

revoke all on function public.remove_document_member (uuid, uuid) from public;
revoke all on function public.remove_document_member (uuid, uuid) from anon;
grant execute on function public.remove_document_member (uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Leave a score (any non-owner member, for themselves)
-- ---------------------------------------------------------------------------
create or replace function public.leave_document (p_document uuid) returns void language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_role text;
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    v_role := public.document_role (p_document);
    if v_role is null then
        -- Already gone (a second tab, a removal that raced the click): the
        -- outcome the caller asked for already holds.
        return;
    end if;

    if v_role = 'owner' then
        raise exception 'the owner cannot leave their own score; delete it instead'
            using errcode = '42501',
                  detail = json_build_object('code', 'owner_cannot_leave')::text;
    end if;

    -- An assigned score is the teacher's to withdraw. Letting the student drop
    -- it would leave the teacher's assignment pointing at a score the student
    -- can no longer open, with nothing on the teacher's side saying so.
    if exists (
        select 1 from public.assignments a
        where a.document_id = p_document and a.student_user_id = v_caller
    ) then
        raise exception 'this score was assigned by your teacher'
            using errcode = '42501',
                  detail = json_build_object('code', 'assigned_score')::text;
    end if;

    delete from public.document_members
    where document_id = p_document and user_id = v_caller;

    perform public.forget_document_for_user (p_document, v_caller);
end;
$$;

revoke all on function public.leave_document (uuid) from public;
revoke all on function public.leave_document (uuid) from anon;
grant execute on function public.leave_document (uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Revoke a link, optionally withdrawing the access it granted (owner only)
-- ---------------------------------------------------------------------------
-- Returns how many members' link-granted access was withdrawn. The direct
-- share_links update (share_links_update policy) still works for a plain
-- revoke; this is the path that can also act on memberships, which no client
-- may write.
create or replace function public.revoke_share_link (p_token text, p_remove_members boolean default false) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_document uuid;
    v_member record;
    v_withdrawn int := 0;
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    select sl.document_id into v_document
    from public.share_links sl
    where sl.token = p_token
    for update;

    -- Same answer for "no such link" and "not your link": a distinct error
    -- would let anyone probe which tokens exist.
    if v_document is null or public.document_role (v_document) is distinct from 'owner' then
        raise exception 'only the score owner can revoke its links' using errcode = '42501';
    end if;

    -- Idempotent: re-revoking keeps the original timestamp, and may still be
    -- used to withdraw members after the fact.
    update public.share_links
    set revoked_at = coalesce(revoked_at, now())
    where token = p_token;

    if not coalesce(p_remove_members, false) then
        return 0;
    end if;

    for v_member in
        select r.user_id, dm.role, a.access as assignment_access
        from public.share_link_redemptions r
        join public.document_members dm
            on dm.document_id = r.document_id
           and dm.user_id = r.user_id
        left join public.assignments a
            on a.document_id = r.document_id
           and a.student_user_id = r.user_id
        where r.token = p_token
          and r.document_id = v_document
        for update of dm
    loop
        -- redeem_share_link never records a source for an owner row; this is
        -- the belt to that brace.
        if v_member.role = 'owner' then
            continue;
        end if;

        if v_member.assignment_access is not null then
            -- A roster student who also opened the link: the link's grant goes,
            -- the assignment's stays.
            update public.document_members
            set role = case when v_member.assignment_access = 'view' then 'viewer' else 'editor' end
            where document_id = v_document and user_id = v_member.user_id;

            delete from public.share_link_redemptions
            where document_id = v_document and user_id = v_member.user_id;
        else
            delete from public.document_members
            where document_id = v_document and user_id = v_member.user_id;

            perform public.forget_document_for_user (v_document, v_member.user_id);
        end if;

        v_withdrawn := v_withdrawn + 1;
    end loop;

    return v_withdrawn;
end;
$$;

revoke all on function public.revoke_share_link (text, boolean) from public;
revoke all on function public.revoke_share_link (text, boolean) from anon;
grant execute on function public.revoke_share_link (text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Tell open viewers when a membership changes
-- ---------------------------------------------------------------------------
-- Realtime authorizes a private channel when it is JOINED (realtime.messages
-- policies are evaluated then, not per message), so a member removed while the
-- score is open keeps receiving the channel until they leave it, and the
-- client is the one that has to notice. This event is how it notices; the
-- client then re-reads its own role over PostgREST, which IS checked per
-- request. The payload carries ids and the new role only -- nothing a member
-- of the score cannot already read from document_members.
create or replace function public.broadcast_membership_changes () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_row public.document_members;
begin
    if tg_op = 'UPDATE' then
        if old.role is not distinct from new.role then
            return null;
        end if;
        v_row := new;
    else
        v_row := old;
    end if;

    perform realtime.send(
        jsonb_build_object(
            'table', 'document_members',
            'document_id', v_row.document_id,
            'user_id', v_row.user_id,
            -- null: the membership is gone.
            'role', case when tg_op = 'DELETE' then null else v_row.role end
        ),
        'membership', -- event
        'doc:' || v_row.document_id::text, -- topic
        true -- private
    );
    return null;
end;
$$;

drop trigger if exists document_members_broadcast on public.document_members;
create trigger document_members_broadcast
after update or delete on public.document_members
for each row
execute function public.broadcast_membership_changes ();

-- Trigger-only: never callable via /rest/v1/rpc.
revoke all on function public.broadcast_membership_changes () from public;
revoke all on function public.broadcast_membership_changes () from anon;
revoke all on function public.broadcast_membership_changes () from authenticated;

-- ===== supabase/migrations/20261007120100_column_integrity.sql =====
-- Column integrity: identity, ownership and authorship columns are immutable
-- (or caller-pinned) for client roles. (The realtime half of the same audit —
-- committed rows on a receive-only topic — is 20261007120101_realtime_db_topic.)
--
-- Why this exists: RLS decides which ROWS a caller may write, never which
-- COLUMNS. Every table below carries a table-wide UPDATE grant (the explicit
-- grants in 20260827140000_core_table_grants, and on hosted projects the
-- permissive default ACL besides), so a policy like annotations_update — "any
-- editor of the document" — let an editor rewrite created_by (forging
-- authorship), created_at, id, or document_id (moving a mark into another
-- score they edit). The same class of hole existed on documents (id,
-- owner_id, storage_path, created_at), share_links (token, created_by,
-- document_id), document_imports (created_by, backup_path) and the rest
-- listed below; annotation_snapshots never pinned created_by at all.
--
-- Why triggers rather than column grants: column-level UPDATE grants only take
-- effect once the table-wide grant is revoked, and the hosted default ACL plus
-- the idempotent core_table_grants migration make that a revoke any later
-- `grant update on table ...` silently undoes. A BEFORE trigger holds no matter
-- what is granted, covers INSERT pinning (which grants cannot express), and
-- applies equally to PostgREST writes and to the SECURITY INVOKER batch RPCs
-- (insert_annotations_batch / patch_annotations_batch), which run as the caller.
--
-- Who is a "client": current_user in ('authenticated', 'anon') — the roles
-- PostgREST switches to for a user JWT. Everything else is trusted server code
-- and is left alone: service_role (Edge Functions, OMR service), postgres
-- (migrations, cron), SECURITY DEFINER functions (they run as their owner, and
-- are already responsible for checking their caller), and FK actions such as
-- ON DELETE SET NULL from an account deletion (Postgres runs those as the
-- referencing table's owner). The guard functions are deliberately SECURITY
-- INVOKER so current_user is the writer, not the function owner.
--
-- Refusals raise 42501 (PostgREST → 403). The client never sends any of these
-- columns on an update (AnnotationUpdate is color/payload/deleted_at only), so a
-- refusal is only ever seen by a forged request; the sync engine treats a 403 as
-- permanent and adopts server truth.
--
-- tests/sql/column_integrity.sql proves each refusal and each legitimate client
-- path in a rolled-back transaction; see tests/sql/README.md.

-- ---------------------------------------------------------------------------
-- annotations
-- ---------------------------------------------------------------------------
-- Editors may change what a mark looks like and whether it is erased (color,
-- payload, deleted_at — the product requirement: editors edit anyone's marks).
-- Everything that says what the mark IS and WHO made it is fixed at insert.
-- page and kind are included: the client never patches them (a handwriting
-- conversion is delete + create precisely because kind cannot be patched), and
-- a kind change would leave a payload peers cannot parse. seq / updated_at are
-- server-stamped by annotations_stamp on every write and need no check here.
--
-- On INSERT, created_by is already pinned by annotations_insert. created_at is
-- client-supplied on purpose (an offline mark keeps the time it was drawn), but
-- kept between the score's own created_at and the server clock: nobody drew on
-- a score before it existed or in the future. Out-of-range values are clamped
-- rather than refused, because a device whose clock is wrong is not an attacker
-- and a refused create would be discarded by the outbox. (created_at only
-- orders marks for hit-testing, so the clamp is about sanity, not access.)
create or replace function public.annotations_guard_columns () returns trigger language plpgsql
set search_path = public as $$
declare
    v_col text;
    v_floor timestamptz;
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        if new.created_at > now() then
            new.created_at := now();
        else
            -- Read as the caller: annotations_insert only admits members, who
            -- can see the score. Not visible means the insert is refused anyway.
            select d.created_at into v_floor from public.documents d where d.id = new.document_id;
            if new.created_at < v_floor then
                new.created_at := v_floor;
            end if;
        end if;
        return new;
    end if;

    if new.id is distinct from old.id then
        v_col := 'id';
    elsif new.document_id is distinct from old.document_id then
        v_col := 'document_id';
    elsif new.created_by is distinct from old.created_by then
        v_col := 'created_by';
    elsif new.created_at is distinct from old.created_at then
        v_col := 'created_at';
    elsif new.page is distinct from old.page then
        v_col := 'page';
    elsif new.kind is distinct from old.kind then
        v_col := 'kind';
    end if;

    if v_col is not null then
        raise exception 'annotations.% cannot be changed', v_col using errcode = '42501';
    end if;
    return new;
end;
$$;

drop trigger if exists annotations_guard_columns on public.annotations;

create trigger annotations_guard_columns before insert or update on public.annotations
for each row execute function public.annotations_guard_columns ();

-- ---------------------------------------------------------------------------
-- annotation_snapshots
-- ---------------------------------------------------------------------------
-- Authorship is stamped, not trusted: the client has always sent created_by
-- null (ensureDayStartingSnapshot is never given a user), so a policy-only
-- `created_by = auth.uid()` would have refused every lesson-history push. The
-- trigger overwrites it with the caller, and the policy then checks it as a
-- second line. created_at is the server clock.
--
-- captured_on is the client's LOCAL calendar day, so it cannot be pinned to the
-- server date — but no timezone is more than one day ahead of UTC (UTC+14), so
-- anything later is a forgery. Refusing it matters: one row per (document, day)
-- and the client upserts ON CONFLICT DO NOTHING, so a squatted future day would
-- silently replace that day's real starting point.
--
-- Past days are deliberately not limited: a snapshot captured offline is pushed
-- whenever the device is back, possibly days later. So an editor can still fill
-- an EMPTY past day (or today, before anyone edits) with a made-up starting
-- point. That is no more than an editor can already do to the marks themselves,
-- the row is stamped with their id, and a day that already has its real
-- starting point cannot be replaced (no update path, one row per day).
--
-- Snapshots are immutable starting points (no update policy exists); the guard
-- also refuses client updates outright so a future policy cannot reopen it.
create or replace function public.annotation_snapshots_guard_columns () returns trigger language plpgsql
set search_path = public as $$
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'UPDATE' then
        raise exception 'annotation_snapshots rows cannot be changed' using errcode = '42501';
    end if;

    new.created_by := auth.uid();
    new.created_at := now();
    if new.captured_on > (now() at time zone 'utc')::date + 1 then
        raise exception 'annotation_snapshots.captured_on is in the future' using errcode = '42501';
    end if;
    return new;
end;
$$;

drop trigger if exists annotation_snapshots_guard_columns on public.annotation_snapshots;

create trigger annotation_snapshots_guard_columns before insert or update on public.annotation_snapshots
for each row execute function public.annotation_snapshots_guard_columns ();

-- Archived scores are read-only (20260826193902_billing): the same rule now
-- covers their lesson history, which annotations_insert already enforces for
-- the marks themselves. ALTER (not drop + create) so the policy is never
-- briefly absent and its name, command and role stay exactly as they were.
alter policy annotation_snapshots_insert on public.annotation_snapshots
with check (
    public.document_role (document_id) in ('owner', 'editor')
    and created_by = (select auth.uid())
    and not public.document_is_archived (document_id)
);

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------
-- storage_path is derived from id ('{id}/original.pdf'); the Edge Functions
-- (score-analyze, imslp-download) already refuse a row where it is not, and the
-- client only ever writes that form. A CHECK makes it an invariant for every
-- role, including service code. Production and the dev branch hold no row that
-- violates it (verified before this migration was written).
alter table public.documents drop constraint if exists documents_storage_path_derived;

alter table public.documents
add constraint documents_storage_path_derived check (storage_path = id::text || '/original.pdf');

-- documents_update already limits UPDATE to the owner and WITH CHECK pins
-- owner_id = auth.uid(), so today nobody can hand a score to someone else — but
-- only because the owner is the sole 'owner' member. Making identity immutable
-- here keeps that true if co-ownership or any new owner-role path ever appears.
-- title, page_count, content_rev, thumb_rev and archived_at stay writable: they
-- are the owner's legitimate edits (archived_at is also held by the score-cap
-- trigger and by billing's archival functions).
create or replace function public.documents_guard_columns () returns trigger language plpgsql
set search_path = public as $$
declare
    v_col text;
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        new.created_at := now();
        new.updated_at := now();
        return new;
    end if;

    if new.id is distinct from old.id then
        v_col := 'id';
    elsif new.owner_id is distinct from old.owner_id then
        v_col := 'owner_id';
    elsif new.storage_path is distinct from old.storage_path then
        v_col := 'storage_path';
    elsif new.created_at is distinct from old.created_at then
        v_col := 'created_at';
    end if;

    if v_col is not null then
        raise exception 'documents.% cannot be changed', v_col using errcode = '42501';
    end if;
    return new;
end;
$$;

drop trigger if exists documents_guard_columns on public.documents;

create trigger documents_guard_columns before insert or update on public.documents
for each row execute function public.documents_guard_columns ();

-- ---------------------------------------------------------------------------
-- share_links
-- ---------------------------------------------------------------------------
-- The token is the credential, so the server always mints it: the column
-- default was only used when the client omitted it, and a client-chosen token
-- is a guessable one. created_by is pinned by share_links_insert; on UPDATE the
-- link's identity (token, document, author, created_at) is fixed. role,
-- expires_at and revoked_at stay with the owner — they are what managing a link
-- means.
create or replace function public.share_links_guard_columns () returns trigger language plpgsql
set search_path = public as $$
declare
    v_col text;
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        new.token := rtrim(
            replace(replace(encode(extensions.gen_random_bytes(16), 'base64'), '+', '-'), '/', '_'),
            '='
        );
        new.created_at := now();
        return new;
    end if;

    if new.token is distinct from old.token then
        v_col := 'token';
    elsif new.document_id is distinct from old.document_id then
        v_col := 'document_id';
    elsif new.created_by is distinct from old.created_by then
        v_col := 'created_by';
    elsif new.created_at is distinct from old.created_at then
        v_col := 'created_at';
    end if;

    if v_col is not null then
        raise exception 'share_links.% cannot be changed', v_col using errcode = '42501';
    end if;
    return new;
end;
$$;

drop trigger if exists share_links_guard_columns on public.share_links;

create trigger share_links_guard_columns before insert or update on public.share_links
for each row execute function public.share_links_guard_columns ();

-- ---------------------------------------------------------------------------
-- document_imports
-- ---------------------------------------------------------------------------
-- backup_path can only name this document's own backup object (the one
-- replaceDocumentPdf writes); no row anywhere holds anything else.
alter table public.document_imports drop constraint if exists document_imports_backup_path_derived;

alter table public.document_imports
add constraint document_imports_backup_path_derived check (
    backup_path is null
    or backup_path = document_id::text || '/pre-import-original.pdf'
);

-- created_by was never written by the client (always null); it is now the
-- caller on insert and fixed afterwards. updated_at had no touch trigger at
-- all, so it is stamped here for every role.
create or replace function public.document_imports_guard_columns () returns trigger language plpgsql
set search_path = public as $$
declare
    v_col text;
begin
    if tg_op = 'UPDATE' then
        new.updated_at := now();
    end if;

    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        new.created_by := auth.uid();
        new.created_at := now();
        new.updated_at := now();
        return new;
    end if;

    if new.document_id is distinct from old.document_id then
        v_col := 'document_id';
    elsif new.created_by is distinct from old.created_by then
        v_col := 'created_by';
    elsif new.created_at is distinct from old.created_at then
        v_col := 'created_at';
    end if;

    if v_col is not null then
        raise exception 'document_imports.% cannot be changed', v_col using errcode = '42501';
    end if;
    return new;
end;
$$;

drop trigger if exists document_imports_guard_columns on public.document_imports;

create trigger document_imports_guard_columns before insert or update on public.document_imports
for each row execute function public.document_imports_guard_columns ();

-- ---------------------------------------------------------------------------
-- library_tags
-- ---------------------------------------------------------------------------
-- library_tags_update already pins user_id to the caller on both sides; only
-- the name is meant to change (renameTag). created_at is the server clock, as
-- on every table here.
create or replace function public.library_tags_guard_columns () returns trigger language plpgsql
set search_path = public as $$
declare
    v_col text;
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        new.created_at := now();
        return new;
    end if;

    if new.id is distinct from old.id then
        v_col := 'id';
    elsif new.user_id is distinct from old.user_id then
        v_col := 'user_id';
    elsif new.created_at is distinct from old.created_at then
        v_col := 'created_at';
    end if;

    if v_col is not null then
        raise exception 'library_tags.% cannot be changed', v_col using errcode = '42501';
    end if;
    return new;
end;
$$;

drop trigger if exists library_tags_guard_columns on public.library_tags;

create trigger library_tags_guard_columns before insert or update on public.library_tags
for each row execute function public.library_tags_guard_columns ();

-- ---------------------------------------------------------------------------
-- practice_notes
-- ---------------------------------------------------------------------------
-- Updates are already confined by a column-level grant (body, shared,
-- noted_on — 20260826194426_roster), and practice_notes_insert vets author,
-- score and student. What was left is the insert-time clock: created_at orders
-- notes within a lesson day, so it is the server's, like everywhere else.
create or replace function public.practice_notes_guard_columns () returns trigger language plpgsql
set search_path = public as $$
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    new.created_at := now();
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists practice_notes_guard_columns on public.practice_notes;

create trigger practice_notes_guard_columns before insert on public.practice_notes
for each row execute function public.practice_notes_guard_columns ();

-- ---------------------------------------------------------------------------
-- score_analyses
-- ---------------------------------------------------------------------------
-- guard_score_analyses_client_write (20260803120000) decided "client or not"
-- from the JWT: anything without a service_role claim was a client. A write with
-- no JWT at all is server code — and the one that matters is account deletion:
-- removing a user makes Postgres null score_analyses.created_by (ON DELETE SET
-- NULL), the guard put the old value back, and the foreign key then refused the
-- whole deletion (or, on a 'ready' row, the status check did). Same body, but
-- keyed on the database role like every guard above, which still treats
-- PostgREST user requests (and score-analyze's user client) as clients and the
-- OMR service's service_role as trusted.
create or replace function public.guard_score_analyses_client_write () returns trigger language plpgsql
set search_path = public as $$
begin
    -- Server code (service role OMR write-back, FK actions, migrations) may
    -- write any lifecycle fields.
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        if new.status not in ('pending', 'failed') then
            raise exception 'score_analyses: clients may only insert pending or failed';
        end if;
        if new.score is not null then
            raise exception 'score_analyses: clients may not write score';
        end if;
        if new.status = 'pending' then
            new.score := null;
            new.progress := null;
            new.engine_version := null;
            new.bpm_default := null;
        end if;
        return new;
    end if;

    -- UPDATE: request/retry only.
    if new.status not in ('pending', 'failed') then
        raise exception 'score_analyses: clients may only set pending or failed';
    end if;
    if new.score is not null then
        raise exception 'score_analyses: clients may not write score';
    end if;
    -- Preserve original requester attribution across retries.
    new.created_by := old.created_by;
    if new.status = 'pending' then
        new.score := null;
        new.progress := null;
        new.error := null;
        new.engine_version := null;
        new.bpm_default := null;
    end if;
    return new;
end;
$$;

-- The guard above keeps the lifecycle fields and created_by; this adds the
-- row's identity, so an editor cannot move one score's analysis request onto
-- another score. On insert both timestamps are the server clock: updated_at is
-- what score-analyze's staleness check reads, so a client-dated request could
-- otherwise look stale (and be re-run) or fresh (and never be retried).
create or replace function public.score_analyses_guard_columns () returns trigger language plpgsql
set search_path = public as $$
declare
    v_col text;
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        new.created_at := now();
        new.updated_at := now();
        return new;
    end if;

    if new.document_id is distinct from old.document_id then
        v_col := 'document_id';
    elsif new.created_at is distinct from old.created_at then
        v_col := 'created_at';
    end if;

    if v_col is not null then
        raise exception 'score_analyses.% cannot be changed', v_col using errcode = '42501';
    end if;
    return new;
end;
$$;

drop trigger if exists score_analyses_guard_columns on public.score_analyses;

create trigger score_analyses_guard_columns before insert or update on public.score_analyses
for each row execute function public.score_analyses_guard_columns ();

-- Trigger functions are never called directly.
revoke all on function public.annotations_guard_columns () from public, anon, authenticated;
revoke all on function public.annotation_snapshots_guard_columns () from public, anon, authenticated;
revoke all on function public.documents_guard_columns () from public, anon, authenticated;
revoke all on function public.share_links_guard_columns () from public, anon, authenticated;
revoke all on function public.document_imports_guard_columns () from public, anon, authenticated;
revoke all on function public.library_tags_guard_columns () from public, anon, authenticated;
revoke all on function public.practice_notes_guard_columns () from public, anon, authenticated;
revoke all on function public.score_analyses_guard_columns () from public, anon, authenticated;
revoke all on function public.guard_score_analyses_client_write () from public, anon, authenticated;

-- ===== supabase/migrations/20261007120101_realtime_db_topic.sql =====
-- Realtime: committed rows move to a topic clients can only read.
--
-- doc:{id} carries presence and live ink, so editors must be able to send on
-- it — and Realtime authorizes a channel's sends once, at join, for every event
-- name. The committed-row fan-out (broadcast_changes 'INSERT' / 'UPDATE', the
-- documents content_rev change, and the score_analysis lifecycle) shared that
-- topic, so any editor — including an anonymous share-link editor — could send
-- a hand-made 'INSERT' that every peer applied as a committed server row: a
-- mark attributed to anyone, persisted in the peer's offline store, and a
-- forged seq that jumped the peer's pull watermark past every real change that
-- followed. The policies themselves were right (members receive, only
-- owners/editors send ink); the topic was shared with the wrong traffic.
--
-- Server-authored events now go to doc-db:{id}. Members may receive on it; no
-- client may send on it — the send policies resolve only 'doc:' topics, so they
-- never match. Rows still reach peers through exactly one broadcast each. The
-- client (src/sync/realtimeChannel.ts) joins both topics and reads committed
-- rows only from doc-db:{id}; tests/realtimeTopicsInSync.test.ts keeps the two
-- sides' topic names together.
--
-- Deploy with the frontend that joins doc-db:{id}: a tab still running the old
-- bundle stops receiving committed rows live (it still converges through its
-- pull on reconnect / coming online) until it reloads. A new bundle running
-- before this migration is refused on doc-db:{id} and falls back to polling
-- until the join succeeds (DEPLOY.md, "Release note — realtime topic split").
--
-- tests/sql/column_integrity.sql proves receive and send on both topics; see
-- tests/sql/README.md.

create or replace function public.db_topic_document_role (topic text) returns text language plpgsql stable security definer
set search_path = public as $$
declare
    doc uuid;
begin
    if topic not like 'doc-db:%' then
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

revoke all on function public.db_topic_document_role (text) from public;
revoke all on function public.db_topic_document_role (text) from anon;
grant execute on function public.db_topic_document_role (text) to authenticated;

-- ALTER rather than drop + create: members never lose their receive grant
-- mid-migration, and the policy keeps its name, command and role.
alter policy doc_topic_receive on realtime.messages
using (
    public.topic_document_role (realtime.topic ()) is not null
    or public.db_topic_document_role (realtime.topic ()) is not null
);

create or replace function public.broadcast_annotation_changes () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    perform realtime.broadcast_changes(
        'doc-db:' || new.document_id::text, -- topic (receive-only for clients)
        tg_op,                              -- event name ('INSERT' | 'UPDATE')
        tg_op,                              -- operation
        tg_table_name,
        tg_table_schema,
        new,
        old
    );
    return null;
end;
$$;

create or replace function public.broadcast_document_changes () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    perform realtime.broadcast_changes(
        'doc-db:' || new.id::text, -- topic (receive-only for clients)
        tg_op, tg_op, tg_table_name, tg_table_schema, new, old
    );
    return null;
end;
$$;

create or replace function public.broadcast_score_analysis_changes () returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if tg_op = 'UPDATE'
       and old.status is not distinct from new.status
       and old.progress is not distinct from new.progress then
        return null;
    end if;

    perform realtime.send(
        jsonb_build_object(
            'table', 'score_analyses',
            'document_id', new.document_id,
            'status', new.status,
            'error', new.error,
            'progress', new.progress,
            'updated_at', new.updated_at
        ),
        'score_analysis', -- event
        'doc-db:' || new.document_id::text, -- topic (receive-only for clients)
        true -- private
    );
    return null;
end;
$$;

revoke all on function public.broadcast_annotation_changes () from public, anon, authenticated;
revoke all on function public.broadcast_document_changes () from public, anon, authenticated;
revoke all on function public.broadcast_score_analysis_changes () from public, anon, authenticated;

-- ===== supabase/migrations/20261007120200_patch_annotations_batch_returns_ids.sql =====
-- patch_annotations_batch reports which rows it actually changed.
--
-- The function used to return void. An UPDATE that RLS filters out (the
-- caller's role dropped to viewer, the row never reached the server, the row
-- belongs to another document) matches nothing and raises nothing, so the
-- client acked those patches as saved: the outbox op was deleted while the
-- server still held the old row, and the edit quietly vanished on the next
-- open. Returning the ids that were updated lets the sync engine tell "saved"
-- from "matched nothing" and repair the latter from server truth, telling the
-- user, instead of assuming success.
--
-- Same arguments, same security-invoker semantics (RLS still decides what each
-- UPDATE may touch); only the return type changes, which CREATE OR REPLACE
-- cannot do, hence the drop. A client built before this migration ignores the
-- result, and the new client treats a null result (the old void function) as
-- "unknown" and keeps the previous ack-on-no-error behaviour, so the deploy
-- order of client and database does not matter.

drop function if exists public.patch_annotations_batch (jsonb);

create function public.patch_annotations_batch (p_patches jsonb) returns uuid[] language plpgsql security invoker
set search_path = public as $$
declare
    elem jsonb;
    v_id uuid;
    v_updated uuid[] := '{}';
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
          and document_id = (elem ->> 'document_id')::uuid
        returning id into v_id;

        -- id is the primary key, so at most one row; FOUND is false when RLS
        -- (or a missing row) left nothing to update.
        if found then
            v_updated := v_updated || v_id;
        end if;
    end loop;

    return v_updated;
end;
$$;

revoke all on function public.patch_annotations_batch (jsonb) from public;
revoke all on function public.patch_annotations_batch (jsonb) from anon;
grant execute on function public.patch_annotations_batch (jsonb) to authenticated;

-- ===== supabase/migrations/20261007120300_billing_correctness.sql =====
-- Billing correctness for the paid launch: resubscribing restores what a lapse
-- archived, and the PDF export allowance is claimed server-side before the
-- export is built.
--
-- (This migration also carried a smart-import refund ledger -- a credit spent
-- on an import the CLIENT then rolled back could be given back once. It was
-- dropped when integrating with fix/scope-imslp, before ever being applied:
-- imslp-download now creates the score itself once the PDF is in hand, refunds
-- every failure before it answers, and the client never rolls a delivered
-- score back, so there is no client rollback left to refund. Keeping a
-- client-callable refund would only have let an account import, delete the
-- score and take the credit back. See the note at the end of this file.)
--
-- Design notes:
--  * Archival now records WHY a score is archived. apply_free_tier_archival is
--    the only flow that archives on a plan event, but documents_update is an
--    owner-wide policy over a table-wide UPDATE grant, so an owner can also set
--    archived_at themselves through the API. A resubscribe must undo the first
--    and never the second: an owner who parked a score did not ask for it back.
--  * The reason is derived, never trusted from a client. A trigger stamps it from
--    who is writing -- a PostgREST client role always gets 'owner' -- so nobody
--    can label their own archive 'plan_lapse' and have billing act on it.
--  * Both the lapse and the restore serialize with documents_enforce_score_cap
--    on the same per-owner advisory lock, taking row locks first, in the order
--    the cap trigger's own callers do (row, then advisory), so the three cannot
--    deadlock against each other or count past one another.
--  * Entitlement resolution moves behind get_entitlements() into the
--    service-only resolve_entitlements(), so server bookkeeping can ask about a
--    user other than the JWT's (a seat invite restores the seated teacher's
--    scores while the request is the Academy owner's).
--  * A resubscribe restores the subscriber AND the teachers seated in the
--    studios they own: an Academy subscription entitles those seats, and a
--    seated teacher gets no webhook of their own.
--  * A share-link guest's PDF export is drawn from the score owner's allowance
--    rather than exempted, so the free plan's one export a month cannot be
--    multiplied by opening one's own share link anonymously.

-- ---------------------------------------------------------------------------
-- Why a score is archived
-- ---------------------------------------------------------------------------
alter table public.documents add column archived_reason text;

-- Archive bookkeeping is not a touch (see the billing migration's note on
-- documents_touch_updated_at): a score's place in the library, and the
-- last-touched order the lapse keeps and the restore brings back by, must
-- survive the reason being stamped or cleared -- including the backfill below.
create or replace function public.documents_touch_updated_at () returns trigger language plpgsql
set search_path = public as $$
begin
    if new.archived_at is distinct from old.archived_at
        or new.archived_reason is distinct from old.archived_reason then
        new.updated_at := old.updated_at;
        return new;
    end if;
    new.updated_at := now();
    return new;
end;
$$;

-- Every score archived before this migration was archived by a lapse: no client
-- surface has ever archived a score, and apply_free_tier_archival is the only
-- server path that does.
update public.documents
set archived_reason = 'plan_lapse'
where archived_at is not null
  and archived_reason is null;

alter table public.documents
add constraint documents_archived_reason_check check (
    (archived_at is null and archived_reason is null)
    or (archived_at is not null and archived_reason in ('plan_lapse', 'owner'))
);

-- Deliberately SECURITY INVOKER: current_user must be the role that issued the
-- write. Inside a definer trigger it would always be the function's owner, and
-- the client/trusted split below would collapse into "always trusted".
--
-- Named so it sorts before documents_touch (BEFORE triggers fire in name order),
-- which then sees the reason this trigger settled on, not the one a client sent.
create or replace function public.documents_archived_reason () returns trigger language plpgsql
set search_path = public as $$
declare
    v_client boolean := current_user in ('authenticated', 'anon');
begin
    if new.archived_at is null then
        new.archived_reason := null;
        return new;
    end if;

    -- Staying archived: the reason is whatever archived it. A client may touch
    -- the row (rename it, say) but never relabel the archive.
    if tg_op = 'UPDATE' and old.archived_at is not null then
        if v_client then
            new.archived_reason := old.archived_reason;
        end if;
        new.archived_reason := coalesce(new.archived_reason, old.archived_reason, 'owner');
        return new;
    end if;

    -- Newly archived. A client archiving its own score is the owner's choice;
    -- a trusted writer that names no reason is treated the same, so only a
    -- path that explicitly says 'plan_lapse' is ever undone by a resubscribe.
    if v_client or new.archived_reason is null then
        new.archived_reason := 'owner';
    end if;
    return new;
end;
$$;

create trigger documents_archived_reason before insert or update on public.documents
for each row execute function public.documents_archived_reason ();

revoke all on function public.documents_archived_reason () from public;

revoke all on function public.documents_archived_reason () from anon;

revoke all on function public.documents_archived_reason () from authenticated;

-- The restore runs on every entitling webhook, so finding "nothing to restore"
-- must not scan the owner's whole library.
create index documents_owner_plan_lapse on public.documents (owner_id)
where archived_reason = 'plan_lapse';

-- ---------------------------------------------------------------------------
-- Entitlements, resolved for a user the caller has already vouched for
-- ---------------------------------------------------------------------------
-- get_entitlements() refuses to answer about anyone but the signed-in caller,
-- which is right for the RPC and wrong for the server's own bookkeeping: when an
-- Academy owner seats a teacher, the restore below has to ask about the TEACHER
-- while the request's JWT still names the owner. So the resolution moves here,
-- unchanged, and get_entitlements() becomes the caller check in front of it.
-- Service-only: callers are definer code that has already decided p_user is
-- the user it may act for. The body is the 20260828180000_billing_stripe_mode.sql
-- definition verbatim, entitling_billing_modes() filter included, so the
-- production narrowing in DEPLOY.md §0 still governs both entry points.
create or replace function public.resolve_entitlements (p_user uuid) returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare
    v_user uuid := p_user;
    v_tier text := 'free';
    v_status text;
    v_source text := 'none';
    v_period_end timestamptz;
    v_sub record;
begin
    if v_user is null then
        raise exception 'resolve_entitlements requires p_user' using errcode = '22023';
    end if;

    -- A provisioned student short-circuits everything below. The flag is set by
    -- the provisioning function through the admin API, so it is not something the
    -- account itself can write, and a student has no subscription, no seat and no
    -- upgrade path to resolve.
    perform 1
    from auth.users u
    where u.id = v_user
      and u.raw_app_meta_data ->> 'user_type' = 'student';

    if found then
        return jsonb_build_object(
            'user_id', v_user,
            'tier', 'student',
            'status', null::text,
            'source', 'managed',
            'current_period_end', null::timestamptz,
            'limits', public.tier_limits ('student')
        );
    end if;

    -- Own subscription first. Highest tier wins if somehow more than one is live.
    select s.tier, s.status, s.current_period_end
    into v_sub
    from public.subscriptions s
    where s.user_id = v_user
      and s.mode = any (public.entitling_billing_modes ())
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
    order by case s.tier when 'academy' then 3 when 'teacher' then 2 when 'personal' then 1 else 0 end desc,
             s.current_period_end desc nulls last
    limit 1;

    if found then
        v_tier := v_sub.tier;
        v_status := v_sub.status;
        v_period_end := v_sub.current_period_end;
        v_source := 'subscription';
    else
        -- Otherwise: a seat in an academy whose owner is paying.
        select s.status, s.current_period_end
        into v_sub
        from public.studio_members sm
        join public.studios st on st.id = sm.studio_id
        join public.subscriptions s on s.user_id = st.owner_id
        where sm.user_id = v_user
          and s.tier = 'academy'
          and s.mode = any (public.entitling_billing_modes ())
          and s.status in ('active', 'trialing')
          and (s.current_period_end is null or s.current_period_end > now())
        order by s.current_period_end desc nulls last
        limit 1;

        if found then
            v_tier := 'academy';
            v_status := v_sub.status;
            v_period_end := v_sub.current_period_end;
            v_source := 'studio_member';
        end if;
    end if;

    return jsonb_build_object(
        'user_id', v_user,
        'tier', v_tier,
        'status', v_status,
        'source', v_source,
        'current_period_end', v_period_end,
        'limits', public.tier_limits (v_tier)
    );
end;
$$;

revoke all on function public.resolve_entitlements (uuid) from public;
revoke all on function public.resolve_entitlements (uuid) from anon;
revoke all on function public.resolve_entitlements (uuid) from authenticated;
grant execute on function public.resolve_entitlements (uuid) to service_role;

-- The RPC keeps its signature, its grants and its caller check; only the
-- resolution behind it moved.
create or replace function public.get_entitlements (p_user uuid default null) returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
begin
    if v_caller is null then
        if p_user is null then
            raise exception 'get_entitlements requires p_user when unauthenticated' using errcode = '22023';
        end if;
        return public.resolve_entitlements (p_user);
    end if;

    if p_user is not null and p_user <> v_caller then
        raise exception 'cannot read another user''s entitlements' using errcode = '42501';
    end if;
    return public.resolve_entitlements (v_caller);
end;
$$;

-- The score cap asks about the row's OWNER, who is not always the JWT's user:
-- a restore run inside an Academy owner's seat invite un-archives the seated
-- teacher's scores, and get_entitlements() would refuse that question outright
-- and abort the invite. Redefined verbatim from 20260826193902_billing.sql
-- except for that one call; its trigger and grants are unchanged.
create or replace function public.documents_enforce_score_cap () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_ent jsonb;
    v_tier text;
    v_limit int;
    v_count int;
begin
    -- Only a row that is (or becomes) active claims a slot.
    if new.archived_at is not null then
        return null;
    end if;
    if tg_op = 'UPDATE' and old.archived_at is null then
        return null; -- already active; nothing new is being claimed
    end if;

    v_ent := public.resolve_entitlements (new.owner_id);
    v_tier := v_ent ->> 'tier';
    v_limit := (v_ent -> 'limits' ->> 'cloud_scores')::int;

    if v_limit < 0 then
        return null;
    end if;

    -- Taken only on a capped tier, and only once the cheap exits are past: an
    -- unlimited plan never serializes against itself. Released at commit.
    perform pg_advisory_xact_lock (hashtext('cleffy.documents_score_cap'), hashtext(new.owner_id::text));

    -- The new row is already in, so it counts itself: the test is `>`, not `>=`.
    select count(*)::int into v_count
    from public.documents d
    where d.owner_id = new.owner_id
      and d.archived_at is null;

    if v_count > v_limit then
        raise exception 'limit_reached'
            using errcode = 'P0001',
                  detail = json_build_object(
                      'code', 'limit_reached',
                      'metric', 'cloud_scores',
                      'limit', v_limit,
                      'tier', v_tier
                  )::text,
                  hint = 'Upgrade for unlimited cloud scores.';
    end if;

    return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lapse: archive past the free cap (redefined to stamp the reason and lock)
-- ---------------------------------------------------------------------------
-- Row locks on the active set first, then the cap's advisory lock, then the
-- entitlement and the keep-set are read fresh. Without the advisory lock a score
-- uploaded mid-archival is invisible to the keep-set and survives as a fourth
-- active score; taking it before the row locks would invert the order the cap
-- trigger uses (its row is locked before it asks for the advisory lock).
create or replace function public.apply_free_tier_archival (p_user uuid) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_limit int;
    v_archived int;
begin
    if p_user is null then
        raise exception 'apply_free_tier_archival requires p_user' using errcode = '22023';
    end if;

    perform 1
    from public.documents d
    where d.owner_id = p_user and d.archived_at is null
    for update;

    perform pg_advisory_xact_lock (hashtext('cleffy.documents_score_cap'), hashtext(p_user::text));

    v_limit := (public.resolve_entitlements (p_user) -> 'limits' ->> 'cloud_scores')::int;
    if v_limit < 0 then
        return 0;
    end if;

    with keep as (
        select d.id
        from public.documents d
        where d.owner_id = p_user and d.archived_at is null
        order by d.updated_at desc, d.id
        limit v_limit
    )
    update public.documents d
    set archived_at = now(),
        archived_reason = 'plan_lapse'
    where d.owner_id = p_user
      and d.archived_at is null
      and not exists (select 1 from keep k where k.id = d.id);

    get diagnostics v_archived = row_count;
    return v_archived;
end;
$$;

-- ---------------------------------------------------------------------------
-- Resubscribe: restore what the lapse archived, up to the plan's cap
-- ---------------------------------------------------------------------------
-- One user's restore. Every paid tier is unlimited on cloud_scores, so in
-- practice this restores everything; the cap arithmetic is for an entitling
-- row that still resolves to a finite plan (an unrecognised price stores tier
-- 'free'), which must restore no further than the owner could have unarchived
-- by hand.
--
-- Most recently updated first, the same order the lapse kept by -- and the
-- touch trigger leaves updated_at alone on archive changes, so that order is
-- still the owner's own. Only 'plan_lapse' archives come back; an owner's own
-- archive stays put. The cap trigger still fires on every restored row and is
-- the real backstop: if this ever computed one slot too many, the whole restore
-- would roll back rather than leave the owner over their cap.
create or replace function public.restore_user_plan_archived_scores (p_user uuid) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_limit int;
    v_active int;
    v_slots int;
    v_restored int;
begin
    if p_user is null then
        raise exception 'restore_user_plan_archived_scores requires p_user' using errcode = '22023';
    end if;

    -- Rows first, then the advisory lock: the order a concurrent unarchive takes
    -- them (its row, then the cap trigger's lock), so the two cannot deadlock.
    perform 1
    from public.documents d
    where d.owner_id = p_user and d.archived_reason = 'plan_lapse'
    for update;

    if not found then
        return 0;
    end if;

    perform pg_advisory_xact_lock (hashtext('cleffy.documents_score_cap'), hashtext(p_user::text));

    v_limit := (public.resolve_entitlements (p_user) -> 'limits' ->> 'cloud_scores')::int;
    if v_limit < 0 then
        v_slots := null; -- LIMIT NULL is LIMIT ALL
    else
        select count(*)::int into v_active
        from public.documents d
        where d.owner_id = p_user and d.archived_at is null;

        v_slots := greatest(0, v_limit - v_active);
        if v_slots = 0 then
            return 0;
        end if;
    end if;

    with restore as (
        select d.id
        from public.documents d
        where d.owner_id = p_user and d.archived_reason = 'plan_lapse'
        order by d.updated_at desc, d.id
        limit v_slots
    )
    update public.documents d
    set archived_at = null
    where d.id in (select r.id from restore r);

    get diagnostics v_restored = row_count;
    return v_restored;
end;
$$;

revoke all on function public.restore_user_plan_archived_scores (uuid) from public;
revoke all on function public.restore_user_plan_archived_scores (uuid) from anon;
revoke all on function public.restore_user_plan_archived_scores (uuid) from authenticated;
grant execute on function public.restore_user_plan_archived_scores (uuid) to service_role;

-- The webhook's entry point, called whenever a subscription is applied in an
-- entitling status (a new checkout, a trial, unpaid -> active). It restores the
-- subscriber, and then every teacher seated in a studio the subscriber owns:
-- an Academy subscription entitles those teachers too, and they get no webhook
-- of their own. A teacher whose own plan lapsed while their Academy owner was
-- also not paying was archived down to the free cap; when the owner pays again
-- the teacher resolves to Academy, and without this would keep those scores
-- read-only indefinitely -- there is no client surface that un-archives.
--
-- A seated teacher is only restored when they now resolve to an unlimited plan
-- (the Academy that just started paying, or their own): a seat in a studio that
-- is still not paying hands nothing back past the free cap that the teacher did
-- not ask for, the same rule the backfill below follows. The member restore
-- re-reads that teacher's entitlements under their own lock, so the gate here
-- is only a filter, never the cap. Members are visited in id order, so two
-- restores that overlap on a teacher take that teacher's locks in one order.
-- Returns the number of scores restored across everyone it visited.
create or replace function public.restore_plan_archived_scores (p_user uuid) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_member uuid;
    v_restored int;
begin
    if p_user is null then
        raise exception 'restore_plan_archived_scores requires p_user' using errcode = '22023';
    end if;

    v_restored := public.restore_user_plan_archived_scores (p_user);

    for v_member in
        select distinct sm.user_id
        from public.studio_members sm
        join public.studios st on st.id = sm.studio_id
        where st.owner_id = p_user
          and sm.user_id <> p_user
        order by sm.user_id
    loop
        if (public.resolve_entitlements (v_member) -> 'limits' ->> 'cloud_scores')::int < 0 then
            v_restored := v_restored + public.restore_user_plan_archived_scores (v_member);
        end if;
    end loop;

    return v_restored;
end;
$$;

revoke all on function public.restore_plan_archived_scores (uuid) from public;
revoke all on function public.restore_plan_archived_scores (uuid) from anon;
revoke all on function public.restore_plan_archived_scores (uuid) from authenticated;
grant execute on function public.restore_plan_archived_scores (uuid) to service_role;

-- An Academy seat entitles without any webhook for the seated teacher: the
-- subscription that pays for it is the owner's. Without this, a teacher whose
-- own plan lapsed and who is then given a seat would resolve to an unlimited
-- plan and still find everything past the free cap read-only. The restore
-- re-reads the teacher's own entitlements, so a seat in an academy that is not
-- paying restores nothing past the cap. Only the seated teacher: a seat changes
-- nobody else's plan, so the studio sweep in restore_plan_archived_scores has
-- nothing to do here. Seats are written only by studio_invite_member (owner-
-- and Academy-checked) and the service role; clients have no insert grant.
create or replace function public.studio_members_restore_plan_archived () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    perform public.restore_user_plan_archived_scores (new.user_id);
    return null;
end;
$$;

revoke all on function public.studio_members_restore_plan_archived () from public;
revoke all on function public.studio_members_restore_plan_archived () from anon;
revoke all on function public.studio_members_restore_plan_archived () from authenticated;

create trigger studio_members_restore_plan_archived after insert on public.studio_members
for each row execute function public.studio_members_restore_plan_archived ();

-- Owners who are ALREADY entitled again when this ships would otherwise wait
-- for their next entitling webhook -- up to a year on an annual plan -- for the
-- fix this migration is. Only owners whose plan is unlimited now (their own
-- subscription or an Academy seat): a free owner with lapse archives gets
-- nothing back that they did not ask for. (Production held no archived scores
-- at the time of writing, so this is expected to be a no-op there; it is here
-- for every other database built from these files.)
do $$
declare
    v_owner uuid;
begin
    for v_owner in
        select distinct d.owner_id
        from public.documents d
        where d.archived_reason = 'plan_lapse'
        order by d.owner_id
    loop
        if (public.resolve_entitlements (v_owner) -> 'limits' ->> 'cloud_scores')::int < 0 then
            perform public.restore_user_plan_archived_scores (v_owner);
        end if;
    end loop;
end;
$$;

-- Same grants as before; restated because create or replace keeps them, but a
-- reader of this file should not have to go looking.
revoke all on function public.apply_free_tier_archival (uuid) from public;
revoke all on function public.apply_free_tier_archival (uuid) from anon;
revoke all on function public.apply_free_tier_archival (uuid) from authenticated;
grant execute on function public.apply_free_tier_archival (uuid) to service_role;

-- ---------------------------------------------------------------------------
-- PDF export: claim before building
-- ---------------------------------------------------------------------------
-- The export is flattened on-device, so the database cannot physically stop a
-- modified client from producing one. What it can do is be the only place the
-- allowance is decided: the shipped client builds nothing until this answers
-- ok:true, and treats anything else -- a refusal, an error, no network -- as
-- "no". The check and the increment are consume_quota's single statement, so
-- two tabs exporting at once cannot both spend the one free export.
--
-- The answer carries the tier and whether the plan is unlimited, so the client
-- can word a refusal for the plan the server actually saw, and can remember
-- that an unlimited plan needs no claim to export offline.
--
-- A share-link guest (an anonymous session) has no plan of its own, and used to
-- be exempt outright -- which made "1 PDF export a month" unenforced for any
-- free owner who opened their own share link in a private window. A guest's
-- export is now drawn from the allowance of the score's OWNER, whose plan is
-- what the export is a feature of: free if the owner pays for unlimited export,
-- the owner's one free export otherwise. So a guest must name the score
-- (p_document) and hold a membership on it -- the share link's redemption is
-- what grants one -- and the answer says billed_to:'owner' so the client words
-- a refusal for someone who cannot upgrade. A signed-in account's export is
-- always drawn from its own allowance; p_document is ignored for it.
--
-- Only what the pricing promises to limit is claimed: "1 PDF export a month".
-- Sharing a page as a photo is a PNG, never calls this, and is never counted.
create or replace function public.claim_pdf_export (p_document uuid default null) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_user uuid := auth.uid();
    v_owner uuid;
    v_ent jsonb;
    v_tier text;
    v_limit int;
begin
    if v_user is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
        if p_document is null then
            raise exception 'a share-link guest must name the score being exported' using errcode = '22023';
        end if;

        -- document_role() is the caller's membership; the owner is read only
        -- once that is established, so a guest cannot probe whose a score is.
        if public.document_role (p_document) is null then
            raise exception 'not a member of this score' using errcode = '42501';
        end if;
        select d.owner_id into v_owner
        from public.documents d
        where d.id = p_document;
        if v_owner is null then
            raise exception 'not a member of this score' using errcode = '42501';
        end if;

        -- tier_limits('student') is unlimited on pdf_exports, so a student
        -- owner's guests fall in the first branch along with every paid plan's.
        v_limit := (public.resolve_entitlements (v_owner) -> 'limits' ->> 'pdf_exports')::int;
        if v_limit < 0 then
            return jsonb_build_object('ok', true, 'unlimited', true, 'billed_to', 'owner');
        end if;

        -- The owner's tier is deliberately not returned: a guest learns that the
        -- allowance ran out, not what the owner pays for.
        return public.consume_quota (v_owner, 'pdf_exports', v_limit) - 'count'
            || jsonb_build_object('unlimited', false, 'billed_to', 'owner');
    end if;

    v_ent := public.get_entitlements ();
    v_tier := v_ent ->> 'tier';

    -- Students print what they were assigned. That is the product working, not
    -- usage to meter.
    if v_tier = 'student' then
        return jsonb_build_object('ok', true, 'exempt', 'student', 'unlimited', true, 'tier', v_tier);
    end if;

    v_limit := (v_ent -> 'limits' ->> 'pdf_exports')::int;
    if v_limit < 0 then
        return jsonb_build_object('ok', true, 'unlimited', true, 'limit', v_limit, 'tier', v_tier);
    end if;

    return public.consume_quota (v_user, 'pdf_exports', v_limit)
        || jsonb_build_object('unlimited', false, 'tier', v_tier);
end;
$$;

revoke all on function public.claim_pdf_export (uuid) from public;
revoke all on function public.claim_pdf_export (uuid) from anon;
grant execute on function public.claim_pdf_export (uuid) to authenticated;

-- Kept for bundles already in the field, which call it by this name; one
-- implementation, so the two cannot drift. The answer is a superset of the old
-- one ({ok, count, limit, exempt}). Those bundles name no score, so a guest
-- calling it is refused (22023) rather than exempted.
create or replace function public.consume_pdf_export () returns jsonb language sql security definer
set search_path = public as $$
    select public.claim_pdf_export ();
$$;

revoke all on function public.consume_pdf_export () from public;
revoke all on function public.consume_pdf_export () from anon;
grant execute on function public.consume_pdf_export () to authenticated;

-- ---------------------------------------------------------------------------
-- Smart-import credits: no client refund
-- ---------------------------------------------------------------------------
-- An earlier revision of this file added smart_import_charges,
-- record_smart_import_charge(), refund_smart_import() and the
-- documents_refuse_refunded_import trigger, so a client that rolled an IMSLP
-- import back (deleting the row it had created before calling imslp-download)
-- could ask for the credit back. With 20261007120700 and the matching
-- imslp-download, the row is created by the function after the PDF is fetched,
-- every failure path removes what the function created and refunds the credit
-- before answering, and the client keeps whatever a 200 delivered. Nothing is
-- left for a client to roll back, so none of those objects exist: a credit is
-- spent exactly when an import delivered its score, and given back by the one
-- place that knows it did not.

-- ===== supabase/migrations/20261007120400_library_pagination.sql =====
-- Library pagination and server-side search.
--
-- The library used to stop at 100 scores: library_bootstrap() and the
-- client's fallback listDocuments() both returned the newest 100 and a
-- has_more flag, and the page could only say "showing latest 100". Search,
-- tag and favorite filters ran over those loaded rows only, so a teacher with
-- 101 scores could not find the oldest one at all.
--
--  1. library_documents() — one keyset page of the caller's visible scores,
--     optionally filtered by title (ilike), one of the caller's own tags, or
--     the caller's favorites, ordered either by recency or by title. Keyset
--     rather than offset so a page boundary stays put while scores are
--     uploaded or touched in between "load more" taps.
--  2. library_bootstrap() keeps its signature and payload (cached older
--     clients call it with no arguments and read the same keys) but now takes
--     its first page from library_documents(), so the bootstrap page and the
--     pages after it share one total order: updated_at desc, id desc. The old
--     order had no tiebreak, and a bulk update (archiving on a downgrade
--     stamps every row with the same now()) made the boundary row ambiguous —
--     a keyset continuation from it could skip or repeat scores.

-- ---------------------------------------------------------------------------
-- library_documents
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER for the same reason as library_bootstrap: the visible set
-- is assembled from the caller's memberships in one indexed pass instead of
-- evaluating documents_select per row of the whole table. Every predicate is
-- therefore scoped to auth.uid() explicitly, mirroring documents_select
-- (owner, or any document_members row), favorites_select (own rows) and
-- library_tags (own tags — another user's tag id matches nothing).
--
-- Cursor: the sort key of the last row the client holds, plus its id.
--   recent: (p_after_updated_at, p_after_id) — rows strictly older.
--   title:  (p_after_title, p_after_id) — rows strictly after, compared on
--           lower(title) so A–Z is case-insensitive.
-- The client passes back the exact updated_at string it was given; a
-- truncated timestamp would skip rows that share the millisecond.
create or replace function public.library_documents (
    p_sort text default 'recent',
    p_after_updated_at timestamptz default null,
    p_after_title text default null,
    p_after_id uuid default null,
    p_query text default null,
    p_tag_id uuid default null,
    p_favorites_only boolean default false,
    p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_uid uuid := (select auth.uid());
    v_sort text := coalesce(p_sort, 'recent');
    v_limit int := least(greatest(coalesce(p_limit, 100), 1), 200);
    v_query text := nullif(btrim(coalesce(p_query, '')), '');
    v_pattern text;
    v_rows jsonb;
    v_count int;
begin
    if v_uid is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;
    if v_sort not in ('recent', 'title') then
        raise exception 'unknown library sort: %', v_sort using errcode = '22023';
    end if;
    -- A half cursor would compare against null and silently return nothing.
    if p_after_id is not null
       and ((v_sort = 'recent' and p_after_updated_at is null)
            or (v_sort = 'title' and p_after_title is null)) then
        raise exception 'library cursor is incomplete' using errcode = '22023';
    end if;

    if v_query is not null then
        -- Titles are short; a pasted paragraph is not a search worth running.
        -- Escape ilike's own wildcards so "50%" or "op_1" match literally.
        v_pattern := '%'
            || replace(replace(replace(left(v_query, 200), '\', '\\'), '%', '\%'), '_', '\_')
            || '%';
    end if;

    with visible as (
        select
            d.id,
            d.owner_id,
            d.title,
            d.storage_path,
            d.page_count,
            d.content_rev,
            d.thumb_rev,
            d.created_at,
            d.updated_at,
            d.archived_at
        from public.documents d
        where (
                d.owner_id = v_uid
                or exists (
                    select 1
                    from public.document_members m
                    where m.document_id = d.id
                      and m.user_id = v_uid
                )
            )
          and (v_pattern is null or d.title ilike v_pattern)
          and (
                p_tag_id is null
                or exists (
                    select 1
                    from public.document_tags dt
                    join public.library_tags t on t.id = dt.tag_id
                    where dt.document_id = d.id
                      and dt.tag_id = p_tag_id
                      and t.user_id = v_uid
                )
            )
          and (
                not coalesce(p_favorites_only, false)
                or exists (
                    select 1
                    from public.document_favorites f
                    where f.document_id = d.id
                      and f.user_id = v_uid
                )
            )
          and (
                p_after_id is null
                or (v_sort = 'recent' and (d.updated_at, d.id) < (p_after_updated_at, p_after_id))
                or (v_sort = 'title' and (lower(d.title), d.id) > (lower(p_after_title), p_after_id))
            )
    ),
    ordered as (
        select
            v.*,
            row_number() over (
                order by
                    case when v_sort = 'title' then lower(v.title) end asc,
                    case when v_sort = 'title' then v.id end asc,
                    case when v_sort = 'recent' then v.updated_at end desc,
                    case when v_sort = 'recent' then v.id end desc
            ) as rn
        from visible v
    ),
    page as (
        select * from ordered where rn <= v_limit + 1
    )
    select
        coalesce(
            (select jsonb_agg(to_jsonb(p) - 'rn' order by p.rn) from page p where p.rn <= v_limit),
            '[]'::jsonb
        ),
        (select count(*)::int from page)
    into v_rows, v_count;

    return jsonb_build_object(
        'documents', v_rows,
        'has_more', v_count > v_limit
    );
end;
$$;

revoke all on function public.library_documents (text, timestamptz, text, uuid, text, uuid, boolean, integer) from public;
revoke all on function public.library_documents (text, timestamptz, text, uuid, text, uuid, boolean, integer) from anon;
grant execute on function public.library_documents (text, timestamptz, text, uuid, text, uuid, boolean, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- library_bootstrap — same payload as 20260902130000; the first page now
-- comes from library_documents() so it shares the keyset order above.
-- ---------------------------------------------------------------------------
create or replace function public.library_bootstrap ()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_uid uuid := (select auth.uid());
    v_page jsonb;
    v_favorites jsonb;
    v_tags jsonb;
    v_document_tags jsonb;
    v_entitlements jsonb;
begin
    if v_uid is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;

    v_page := public.library_documents (p_sort => 'recent', p_limit => 100);

    select coalesce(jsonb_agg(f.document_id), '[]'::jsonb)
    into v_favorites
    from public.document_favorites f
    where f.user_id = v_uid;

    select coalesce(
        jsonb_agg(
            jsonb_build_object(
                'id', t.id,
                'user_id', t.user_id,
                'name', t.name,
                'created_at', t.created_at
            )
            order by t.name asc
        ),
        '[]'::jsonb
    )
    into v_tags
    from public.library_tags t
    where t.user_id = v_uid;

    select coalesce(
        jsonb_agg(
            jsonb_build_object(
                'document_id', dt.document_id,
                'tag_id', dt.tag_id
            )
        ),
        '[]'::jsonb
    )
    into v_document_tags
    from public.document_tags dt
    join public.library_tags t on t.id = dt.tag_id
    where t.user_id = v_uid;

    v_entitlements := public.get_entitlements ();

    return jsonb_build_object(
        'documents', v_page -> 'documents',
        'has_more', (v_page ->> 'has_more')::boolean,
        'favorite_ids', v_favorites,
        'tags', v_tags,
        'document_tags', v_document_tags,
        'entitlements', v_entitlements
    );
end;
$$;

revoke all on function public.library_bootstrap () from public;
revoke all on function public.library_bootstrap () from anon;
grant execute on function public.library_bootstrap () to authenticated;

-- ===== supabase/migrations/20261007120401_document_storage_cleanup.sql =====
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

-- ===== supabase/migrations/20261007120500_function_search_path_and_execute_grants.sql =====
-- Security advisor fixes (function_search_path_mutable,
-- anon_security_definer_function_executable), as reported on both the
-- production project and the dev branch on 2026-10-08.
--
-- 1. Pin search_path on the three functions created without one. A function
--    whose search_path follows the caller resolves unqualified names against
--    whatever schemas the calling role puts first, so its behavior depends on
--    who fires it. touch_updated_at and omr_error_is_permanent are copied
--    verbatim from the migrations that created them (20260801160752_schema,
--    20260806150000_omr_enqueue_and_fail_policy); only the SET clause is new.
--    guard_score_analyses_client_write keeps the body
--    20261007120100_column_integrity gave it (see below). `public`, like every
--    other function in this schema.
--
-- 2. Revoke EXECUTE from client roles on functions they have no business
--    calling through /rest/v1/rpc. Supabase's default privileges grant EXECUTE
--    on every new public function to anon and authenticated directly, so the
--    `revoke ... from public` the original migrations did left those grants in
--    place. Trigger functions keep working without EXECUTE: Postgres checks it
--    when CREATE TRIGGER runs, never when the trigger fires (the same reasoning
--    as 20260802172249_edge_rate_rls_and_revoke_execute).

-- ---------------------------------------------------------------------------
-- 1. search_path
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at () returns trigger language plpgsql
set search_path = public as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

-- guard_score_analyses_client_write: the advisor flagged the 20260803120000
-- definition. 20261007120100_column_integrity already re-created it with
-- `set search_path = public` AND a corrected body -- "client" decided by the
-- database role (current_user in authenticated/anon) instead of the JWT, so
-- that an account deletion's ON DELETE SET NULL of created_by (run as the
-- table owner, no JWT) is no longer reverted by the guard and refused by the
-- foreign key. Re-creating it here from the original body would silently undo
-- that fix, since this file runs later. It is restated with the 120100 body so
-- the two files agree whichever one a reader (or a partial apply) starts from.
create or replace function public.guard_score_analyses_client_write () returns trigger language plpgsql
set search_path = public as $$
begin
    -- Server code (service role OMR write-back, FK actions, migrations) may
    -- write any lifecycle fields.
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        if new.status not in ('pending', 'failed') then
            raise exception 'score_analyses: clients may only insert pending or failed';
        end if;
        if new.score is not null then
            raise exception 'score_analyses: clients may not write score';
        end if;
        if new.status = 'pending' then
            new.score := null;
            new.progress := null;
            new.engine_version := null;
            new.bpm_default := null;
        end if;
        return new;
    end if;

    -- UPDATE: request/retry only.
    if new.status not in ('pending', 'failed') then
        raise exception 'score_analyses: clients may only set pending or failed';
    end if;
    if new.score is not null then
        raise exception 'score_analyses: clients may not write score';
    end if;
    -- Preserve original requester attribution across retries.
    new.created_by := old.created_by;
    if new.status = 'pending' then
        new.score := null;
        new.progress := null;
        new.error := null;
        new.engine_version := null;
        new.bpm_default := null;
    end if;
    return new;
end;
$$;

-- Permanence policy lives here only (mirrors services/omr-service/src/errors.ts tests).
create or replace function public.omr_error_is_permanent (p_error text, p_attempt int)
returns boolean
language sql
immutable
set search_path = public
as $$
    select case
        when p_error in (
            'too_large', 'page_count_unknown', 'no_staves_found',
            'musicxml_parse_failed', 'backlog_full'
        ) then true
        when p_error in ('omr_crash', 'omr_timeout') then p_attempt >= 2
        else false
    end;
$$;

-- ---------------------------------------------------------------------------
-- 2. EXECUTE grants
-- ---------------------------------------------------------------------------

-- Trigger-only functions: nothing should reach them through /rest/v1/rpc.
revoke all on function public.touch_updated_at () from public, anon, authenticated;
revoke all on function public.guard_score_analyses_client_write () from public, anon, authenticated;
revoke all on function public.broadcast_document_changes () from public, anon, authenticated;
revoke all on function public.broadcast_score_analysis_changes () from public, anon, authenticated;

-- Called only by omr_fail_job (SECURITY DEFINER, runs as its owner) and the
-- service role, which keeps the grant 20260806150000 gave it.
revoke all on function public.omr_error_is_permanent (text, int) from public, anon, authenticated;
grant execute on function public.omr_error_is_permanent (text, int) to service_role;

-- Owners and editors only, and a signed-out caller is never either: the
-- function already refuses anon with 'forbidden', this stops it being callable.
-- Anonymous (guest) sessions are the authenticated role and are unaffected.
revoke all on function public.set_document_page_count (uuid, int) from public, anon;
grant execute on function public.set_document_page_count (uuid, int) to authenticated;

-- ===== supabase/migrations/20261007120501_student_login_throttle.sql =====
-- Per-account failed-sign-in throttling for student-login (see
-- supabase/functions/_shared/loginThrottle.ts for why the per-IP limit is not
-- enough: GoTrue only ever sees the edge function's IP).
--
-- Two kinds of row, told apart by key shape (the edge function derives both
-- with an HMAC, so no username or IP address is ever stored):
--
--   <scope>:<account>           ACCOUNT row: a loose fixed-window ceiling on
--                               attempts against one username from anywhere
--                               (attempts + window_ends_at).
--   <scope>:<account>:<client>  SOURCE row: the steep backoff for one username
--                               from one client address (attempts +
--                               last_attempt_at + locked_until).
--
-- The split is what keeps the limiter from being a lockout service: the steep
-- lock only ever shuts out the address that earned it, so somebody hammering a
-- classmate's username locks THEMSELVES out, not the classmate signing in from
-- home. The account ceiling is there for the one thing per-source backoff
-- cannot stop — many addresses guessing one account — and is set far above any
-- real student's use, so tripping it takes a sustained distributed effort.
--
-- Service-role only, like edge_rate_buckets: RLS on with no policies, no client
-- grants, and every function executable by service_role alone. They are
-- SECURITY INVOKER: the only caller already holds the table grants, so there is
-- nothing to elevate.

create table public.edge_login_attempts (
    key text primary key check (length(key) between 1 and 200),
    attempts int not null default 0 check (attempts >= 0),
    last_attempt_at timestamptz not null default now(),
    -- Source rows: the backoff lock.
    locked_until timestamptz,
    -- Account rows: the end of the current counting window.
    window_ends_at timestamptz
);

-- Housekeeping scans by age.
create index edge_login_attempts_last_attempt on public.edge_login_attempts (last_attempt_at);

alter table public.edge_login_attempts enable row level security;

revoke all on table public.edge_login_attempts from public, anon, authenticated;
grant select, insert, update, delete on table public.edge_login_attempts to service_role;

-- Count one attempt, or refuse it.
--
-- Called BEFORE the password is checked, holding both rows' locks, so parallel
-- requests are counted one at a time and a burst cannot outrun the count.
--
-- 1. The source's own backoff. Its p_free_attempts-th attempt is allowed and
--    arms the first lock (p_base_lock_ms); every attempt after that doubles it,
--    up to p_max_lock_ms. A source quiet for p_decay_ms starts over.
-- 2. The account ceiling: at most p_account_limit attempts per
--    p_account_window_ms window, from all sources together.
--
-- A refused attempt is counted NOWHERE: hammering a locked source does not
-- extend its lock, and cannot spend the account's shared ceiling either — only
-- attempts that were let through do.
--
-- Returns {ok: true, attempts, accountAttempts} or
-- {ok: false, retryAfterSec, scope: 'source' | 'account'}.
create or replace function public.begin_login_attempt (
    p_account_key text,
    p_source_key text,
    p_free_attempts int,
    p_base_lock_ms int,
    p_max_lock_ms int,
    p_decay_ms int,
    p_account_limit int,
    p_account_window_ms int
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
    now_ts timestamptz := clock_timestamp();
    decay interval;
    acct public.edge_login_attempts%rowtype;
    src public.edge_login_attempts%rowtype;
    lock_ms bigint;
begin
    if p_account_key is null or length(p_account_key) not between 1 and 200
        or p_source_key is null or length(p_source_key) not between 1 and 200
        -- The source key must sit under its account key, so that clearing an
        -- account (clear_login_account) reaches every source row too.
        or length(p_source_key) <= length(p_account_key) + 1
        or left(p_source_key, length(p_account_key) + 1) <> p_account_key || ':'
        or p_free_attempts is null or p_free_attempts < 1
        or p_base_lock_ms is null or p_base_lock_ms < 1
        or p_max_lock_ms is null or p_max_lock_ms < p_base_lock_ms
        or p_decay_ms is null or p_decay_ms < 1
        or p_account_limit is null or p_account_limit < 1
        or p_account_window_ms is null or p_account_window_ms < 1 then
        raise exception 'begin_login_attempt: invalid arguments';
    end if;
    decay := make_interval(secs => p_decay_ms / 1000.0);

    -- Keep the table to keys that still mean something: a few long-quiet rows
    -- with no live lock or window go per call, skipping any another attempt
    -- holds.
    delete from public.edge_login_attempts
    where key in (
        select stale.key
        from public.edge_login_attempts stale
        where stale.last_attempt_at < now_ts - decay
          and (stale.locked_until is null or stale.locked_until <= now_ts)
          and (stale.window_ends_at is null or stale.window_ends_at <= now_ts)
          and stale.key <> p_account_key
          and stale.key <> p_source_key
        limit 20
        for update skip locked
    );

    -- Account row first, then the source row: every caller takes the two locks
    -- in the same order, so concurrent attempts on one account queue rather
    -- than deadlock. The no-op DO UPDATE is deliberate: unlike DO NOTHING it
    -- locks and returns an existing row in the same statement, so there is no
    -- gap in which another call's cleanup could delete it from under us.
    insert into public.edge_login_attempts as t (key, last_attempt_at)
    values (p_account_key, now_ts)
    on conflict (key) do update set key = t.key
    returning * into acct;

    insert into public.edge_login_attempts as t (key, last_attempt_at)
    values (p_source_key, now_ts)
    on conflict (key) do update set key = t.key
    returning * into src;

    if src.locked_until is not null and src.locked_until > now_ts then
        return jsonb_build_object(
            'ok', false,
            'scope', 'source',
            'retryAfterSec', greatest(1, ceil(extract(epoch from (src.locked_until - now_ts))))::int
        );
    end if;

    if acct.window_ends_at is null or acct.window_ends_at <= now_ts then
        acct.attempts := 0;
        acct.window_ends_at := now_ts + make_interval(secs => p_account_window_ms / 1000.0);
    end if;
    if acct.attempts >= p_account_limit then
        return jsonb_build_object(
            'ok', false,
            'scope', 'account',
            'retryAfterSec', greatest(1, ceil(extract(epoch from (acct.window_ends_at - now_ts))))::int
        );
    end if;
    acct.attempts := acct.attempts + 1;

    if src.last_attempt_at < now_ts - decay then
        src.attempts := 0;
    end if;
    src.attempts := src.attempts + 1;

    if src.attempts >= p_free_attempts then
        -- 2^20 x base is far past any sane ceiling; the cap keeps the power finite.
        lock_ms := least(
            p_max_lock_ms::bigint,
            p_base_lock_ms::bigint * (2::bigint ^ least(src.attempts - p_free_attempts, 20))::bigint
        );
        src.locked_until := now_ts + make_interval(secs => lock_ms / 1000.0);
    else
        src.locked_until := null;
    end if;

    update public.edge_login_attempts
    set attempts = acct.attempts,
        last_attempt_at = now_ts,
        window_ends_at = acct.window_ends_at
    where key = p_account_key;

    update public.edge_login_attempts
    set attempts = src.attempts,
        last_attempt_at = now_ts,
        locked_until = src.locked_until
    where key = p_source_key;

    return jsonb_build_object('ok', true, 'attempts', src.attempts, 'accountAttempts', acct.attempts);
end;
$$;

-- A successful sign-in: the misses from this source before it were typos. The
-- account ceiling is left alone — it caps guessing volume, and a student who
-- just signed in is nowhere near it.
create or replace function public.clear_login_attempts (p_key text) returns void
language sql
security invoker
set search_path = public
as $$
    delete from public.edge_login_attempts where key = p_key;
$$;

-- Forget everything about one account: its ceiling and every source's backoff.
-- The teacher's recovery path (student-provision 'reset') and a successful
-- student-claim call this, so a fresh setup card really is a way back in.
-- Returns the number of rows removed.
create or replace function public.clear_login_account (p_account_key text) returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
    removed int;
begin
    if p_account_key is null or length(p_account_key) not between 1 and 200 then
        raise exception 'clear_login_account: invalid arguments';
    end if;
    delete from public.edge_login_attempts
    where key = p_account_key
       or left(key, length(p_account_key) + 1) = p_account_key || ':';
    get diagnostics removed = row_count;
    return removed;
end;
$$;

revoke all on function public.begin_login_attempt (text, text, int, int, int, int, int, int) from public, anon, authenticated;
grant execute on function public.begin_login_attempt (text, text, int, int, int, int, int, int) to service_role;

revoke all on function public.clear_login_attempts (text) from public, anon, authenticated;
grant execute on function public.clear_login_attempts (text) to service_role;

revoke all on function public.clear_login_account (text) from public, anon, authenticated;
grant execute on function public.clear_login_account (text) to service_role;

-- ===== supabase/migrations/20261007120600_account_deletion.sql =====
-- Account deletion: a departed collaborator's marks stay on other people's scores.
--
-- Self-serve deletion (supabase/functions/delete-account) ends by deleting the
-- auth user, and every user-keyed FK then fires. For almost all of them CASCADE
-- is exactly right — the user's own scores, memberships, tags, favourites,
-- roster, billing rows and usage counters belong to nobody else. One did not:
--
--   annotations.created_by references auth.users ON DELETE CASCADE
--
-- There is one shared annotation layer per score. When a student or a fellow
-- teacher who had been marking up someone ELSE's score deleted their account,
-- the cascade hard-deleted every mark they ever drew there — fingerings a
-- paying teacher had been relying on, gone from the teacher's copy without the
-- teacher doing anything. It also broke sync: annotations are tombstoned, never
-- hard-deleted, precisely so offline clients converge by `seq`; a cascade
-- delete bumps nothing, so every device that had already pulled those marks
-- would keep showing them forever while the server no longer had them.
--
-- SET NULL instead. The marks stay part of the score they were drawn on, and
-- the row stops naming anyone. Because the referential action is an UPDATE,
-- annotations_stamp() bumps `seq` and annotations_broadcast fires, so every
-- open or returning client pulls the row with its author cleared — convergence
-- for free. Annotations on scores the deleted user OWNED are unaffected by
-- this: those go with the score, through documents.id's own cascade, and the
-- delete-account function deletes owned scores before the auth user.
--
-- An ON DELETE SET NULL is an UPDATE, so a BEFORE UPDATE trigger can still
-- refuse it and with it the whole auth delete. score_analyses.created_by does:
-- guard_score_analyses_client_write (20260803120000) treats any write without
-- a service_role JWT as a client's, and GoTrue's delete carries no JWT. That
-- is left to delete-account, which clears score_analyses.created_by as the
-- service role just before the auth delete (releaseAuthorship), so deletion
-- works whatever that guard looks like. The trigger added below cannot cause
-- the same problem: it keys on the writing role, not the JWT.
--
-- Dropping NOT NULL would on its own widen what a client may write: the
-- annotations_update policy has no column restriction and `authenticated`
-- holds UPDATE on created_by, so NOT NULL was the only thing stopping an
-- editor from blanking the author of any mark on a shared score. Inserts are
-- still safe — annotations_insert requires created_by = auth.uid(), so a new
-- row can never be authorless — and annotations_freeze_created_by below closes
-- the UPDATE path: a client may not change created_by at all, to null or to
-- anyone. Who counts as a client is the role doing the write
-- (current_user in authenticated/anon), not the JWT: the FK's own SET NULL
-- runs as the table's owner — not as GoTrue's role, and with no JWT — so it
-- passes, and deleting an account that marked a shared score still works.
-- (fix/integrity's annotations_guard_columns pins the same column for the
-- same clients; the two agree and either alone is enough.)

alter table public.annotations alter column created_by drop not null;

-- SECURITY INVOKER (the default), so current_user is the writer rather than
-- this function's owner. Fires only when created_by is in the SET list, so
-- ordinary edits, which never send it, pay nothing.
create or replace function public.annotations_freeze_created_by () returns trigger language plpgsql
set search_path = ''
as $$
begin
    if current_user in ('authenticated', 'anon') and new.created_by is distinct from old.created_by then
        raise exception 'annotations.created_by cannot be changed'
            using errcode = '42501';
    end if;
    return new;
end;
$$;

revoke all on function public.annotations_freeze_created_by () from public, anon, authenticated;

drop trigger if exists annotations_freeze_created_by on public.annotations;

create trigger annotations_freeze_created_by before update of created_by on public.annotations
for each row execute function public.annotations_freeze_created_by ();

alter table public.annotations drop constraint if exists annotations_created_by_fkey;

-- Every statement here runs in the migration's one transaction, and the
-- ALTERs above already hold ACCESS EXCLUSIVE on annotations until it commits,
-- so annotation writes wait for the whole migration, FK scan included. That is
-- brief at the table's current size (tens of rows in production); a much
-- larger table would want this FK added NOT VALID and validated in a separate
-- migration.
alter table public.annotations
    add constraint annotations_created_by_fkey foreign key (created_by) references auth.users (id) on delete set null;

-- ===== supabase/migrations/20261007120700_document_provenance.sql =====
-- Score provenance + IMSLP back-off.
--
-- 1. documents.source_* — where an imported score came from. An IMSLP import
--    records the work page, the file, IMSLP's license tag verbatim, and the
--    credits IMSLP lists for that file (composer, editor, arranger,
--    publisher). Creative Commons Attribution files are licensed on the
--    condition that the credit travels with the copy; a score shared from
--    Cleffy must still say whose engraving it is. All nullable: an uploaded
--    PDF has no provenance, and rows imported before this migration have
--    none recorded.
--
--    Written only by imslp-download, under the service role, from values the
--    function derived itself (the license cache / a live parse of the work
--    page) — never from what the browser sent. documents_guard_provenance
--    keeps it that way: a client (authenticated/anon) may neither insert a
--    row claiming provenance nor change or clear it later. The table-level
--    UPDATE grant stays as it is (title, page_count, thumb_rev… are client
--    columns), so a trigger rather than column privileges does the guarding.
--    Members read it through the existing documents_select policy, like the
--    rest of the row.
--
-- 2. edge_rate_block(key, seconds) — IMSLP answered 429: hold a shared
--    edge_rate_buckets key closed for the Retry-After so every other import
--    waits it out (check_edge_rate_limit refuses until reset_at) instead of
--    each one re-discovering the throttle with another request. Service role
--    only.

alter table public.documents
    add column if not exists source_url text,
    add column if not exists source_filename text,
    add column if not exists source_license text,
    add column if not exists source_attribution jsonb;

alter table public.documents
    drop constraint if exists documents_source_url_check;

alter table public.documents
    add constraint documents_source_url_check check (
        source_url is null or (source_url ~ '^https://' and char_length(source_url) <= 4096)
    );

alter table public.documents
    drop constraint if exists documents_source_filename_check;

alter table public.documents
    add constraint documents_source_filename_check check (
        source_filename is null or char_length(source_filename) <= 512
    );

alter table public.documents
    drop constraint if exists documents_source_license_check;

alter table public.documents
    add constraint documents_source_license_check check (
        source_license is null or char_length(source_license) <= 200
    );

alter table public.documents
    drop constraint if exists documents_source_attribution_check;

alter table public.documents
    add constraint documents_source_attribution_check check (
        source_attribution is null
        or (jsonb_typeof(source_attribution) = 'object' and pg_column_size(source_attribution) <= 4096)
    );

-- Not SECURITY DEFINER on purpose: current_user must be the role that issued
-- the statement. PostgREST runs a signed-in browser as `authenticated` (or
-- `anon`); imslp-download's service client is `service_role`, and migrations
-- and definer functions run as their owner — those may write provenance.
create or replace function public.documents_guard_provenance () returns trigger language plpgsql
set search_path = public as $$
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        if new.source_url is not null
            or new.source_filename is not null
            or new.source_license is not null
            or new.source_attribution is not null then
            raise exception 'document provenance is recorded by the import service'
                using errcode = '42501';
        end if;
        return new;
    end if;

    if new.source_url is distinct from old.source_url
        or new.source_filename is distinct from old.source_filename
        or new.source_license is distinct from old.source_license
        or new.source_attribution is distinct from old.source_attribution then
        raise exception 'document provenance is recorded by the import service'
            using errcode = '42501';
    end if;
    return new;
end;
$$;

drop trigger if exists documents_guard_provenance on public.documents;

create trigger documents_guard_provenance before insert or update on public.documents
for each row execute function public.documents_guard_provenance ();

revoke all on function public.documents_guard_provenance () from public;

revoke all on function public.documents_guard_provenance () from anon;

revoke all on function public.documents_guard_provenance () from authenticated;

-- Close a rate bucket for p_seconds (clamped to 1..900). check_edge_rate_limit
-- refuses while count >= limit and reset_at is in the future, so a saturated
-- count with a pushed-out reset_at blocks every caller of that key; the next
-- check after reset_at starts a fresh window as usual. An existing, later
-- reset_at is never pulled in. SECURITY DEFINER because edge_rate_buckets has
-- RLS and no policies; callable by the service role only.
create or replace function public.edge_rate_block (p_key text, p_seconds int) returns void
language plpgsql security definer
set search_path = public as $$
declare
    v_until timestamptz;
begin
    if p_key is null or char_length(p_key) = 0 or char_length(p_key) > 200 then
        raise exception 'edge_rate_block: invalid key' using errcode = '22023';
    end if;
    if p_seconds is null or p_seconds < 1 then
        return;
    end if;

    v_until := clock_timestamp() + make_interval(secs => least(p_seconds, 900));

    insert into public.edge_rate_buckets (key, count, reset_at)
    values (p_key, 2147483647, v_until)
    on conflict (key) do update
        set count = 2147483647,
            reset_at = greatest(public.edge_rate_buckets.reset_at, excluded.reset_at);
end;
$$;

revoke all on function public.edge_rate_block (text, int) from public;

revoke all on function public.edge_rate_block (text, int) from anon;

revoke all on function public.edge_rate_block (text, int) from authenticated;

grant execute on function public.edge_rate_block (text, int) to service_role;

-- ===== supabase/migrations/20261009120100_pdf_export_claim_ids.sql =====
-- A PDF export claim the client could not use must not cost a second one.
--
-- 20261007120300 made claim_pdf_export() the one place the pdf_exports
-- allowance is decided. Two gaps were left between that decision and the file
-- reaching the teacher, and on the free plan (one export a month) either one
-- turned "Please try again" into a refusal:
--  * the shipped client claimed BEFORE flattening, so an export that then failed
--    to build had already spent the month's export. The client now builds the
--    PDF first and claims only once the file exists; that half needs nothing
--    here.
--  * an answer can be lost after the server committed it (the connection drops
--    on the way back), or the file can be built and claimed and then not
--    delivered (the share sheet dismissed). Asking again counted again.
--
-- So a claim can now carry an id the CLIENT mints for one export attempt. A
-- repeat of that id, by the same caller, for the same score, within an hour, is
-- answered ok again WITHOUT counting: it is the same export being retried, not
-- a new one. Nothing is ever given back -- there is no release to call, so no
-- way to spend and un-spend -- and an id buys at most the one unit it was first
-- answered ok for:
--  * only an ok answer is recorded; a refused id is forgotten, so it never
--    replays as ok;
--  * a replay must come from the claimer (auth.uid(), never an argument), be
--    billed to the same account and, for a share-link guest, name the same
--    score;
--  * after the hour the id is spent for good and is refused (22023) rather than
--    counted afresh, so a client never silently pays twice for one id.
-- The export is flattened on-device, so none of this can stop a modified client
-- from exporting without asking at all (see 20261007120300); what it keeps
-- honest is the shipped client, which mints a fresh id per export and keeps it
-- only until that export has been delivered.
--
-- A call with no id (bundles already in the field, consume_pdf_export) behaves
-- exactly as before: every ok answer counts.
--
-- Unlimited plans, students and an unlimited owner's guests record nothing --
-- nothing was counted, so there is nothing a retry could double.

create table public.pdf_export_claims (
    -- Minted by the client per export attempt, so a retry can name it again.
    id uuid primary key,
    claimed_by uuid not null references auth.users (id) on delete cascade,
    -- Whose allowance the unit came from: the caller, or a guest's score owner.
    billed_to uuid not null references auth.users (id) on delete cascade,
    -- The score a share-link guest named; null for an account's own export.
    document_id uuid,
    created_at timestamptz not null default now()
);

-- Rows exist only for a counted unit, so a billed account holds at most its
-- monthly allowance of them per month: nothing here needs sweeping.
create index pdf_export_claims_billed_to on public.pdf_export_claims (billed_to);
create index pdf_export_claims_claimed_by on public.pdf_export_claims (claimed_by);

-- Server bookkeeping only: claim_pdf_export() is the sole reader and writer.
alter table public.pdf_export_claims enable row level security;

revoke all on table public.pdf_export_claims from public;
revoke all on table public.pdf_export_claims from anon;
revoke all on table public.pdf_export_claims from authenticated;

-- A new trailing parameter with a default would leave the old one-argument
-- function beside it, and claim_pdf_export(p_document => x) would then match
-- both. One function, so every caller -- old bundles naming only p_document,
-- or nothing -- resolves to it.
drop function if exists public.claim_pdf_export (uuid);

-- 20261007120300's body, with the claim id woven in around consume_quota.
create or replace function public.claim_pdf_export (p_document uuid default null, p_claim uuid default null) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_user uuid := auth.uid();
    v_guest boolean;
    v_owner uuid;
    v_billed uuid;
    v_scope uuid;
    v_ent jsonb;
    v_tier text;
    v_limit int;
    v_prior public.pdf_export_claims;
    v_answer jsonb;
    v_extra jsonb;
begin
    if v_user is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    v_guest := coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);

    if v_guest then
        if p_document is null then
            raise exception 'a share-link guest must name the score being exported' using errcode = '22023';
        end if;

        -- document_role() is the caller's membership; the owner is read only
        -- once that is established, so a guest cannot probe whose a score is.
        if public.document_role (p_document) is null then
            raise exception 'not a member of this score' using errcode = '42501';
        end if;
        select d.owner_id into v_owner
        from public.documents d
        where d.id = p_document;
        if v_owner is null then
            raise exception 'not a member of this score' using errcode = '42501';
        end if;

        -- tier_limits('student') is unlimited on pdf_exports, so a student
        -- owner's guests fall in the first branch along with every paid plan's.
        v_limit := (public.resolve_entitlements (v_owner) -> 'limits' ->> 'pdf_exports')::int;
        if v_limit < 0 then
            return jsonb_build_object('ok', true, 'unlimited', true, 'billed_to', 'owner');
        end if;

        v_billed := v_owner;
        v_scope := p_document;
        -- The owner's tier is deliberately not returned: a guest learns that the
        -- allowance ran out, not what the owner pays for.
        v_extra := jsonb_build_object('unlimited', false, 'billed_to', 'owner');
    else
        v_ent := public.get_entitlements ();
        v_tier := v_ent ->> 'tier';

        -- Students print what they were assigned. That is the product working,
        -- not usage to meter.
        if v_tier = 'student' then
            return jsonb_build_object('ok', true, 'exempt', 'student', 'unlimited', true, 'tier', v_tier);
        end if;

        v_limit := (v_ent -> 'limits' ->> 'pdf_exports')::int;
        if v_limit < 0 then
            return jsonb_build_object('ok', true, 'unlimited', true, 'limit', v_limit, 'tier', v_tier);
        end if;

        v_billed := v_user;
        -- An account's export is drawn from its own allowance whatever score it
        -- names, so the score is not part of what a replay must match.
        v_scope := null;
        v_extra := jsonb_build_object('unlimited', false, 'tier', v_tier);
    end if;

    if p_claim is not null then
        -- Claimed first, counted second: a concurrent call with the same id
        -- waits on this row and then sees it, so one id is never counted twice.
        insert into public.pdf_export_claims (id, claimed_by, billed_to, document_id)
        values (p_claim, v_user, v_billed, v_scope)
        on conflict (id) do nothing;

        if not found then
            select c.* into v_prior
            from public.pdf_export_claims c
            where c.id = p_claim;

            if v_prior.claimed_by = v_user
                and v_prior.billed_to = v_billed
                and v_prior.document_id is not distinct from v_scope
                and v_prior.created_at > now() - interval '1 hour' then
                return jsonb_build_object('ok', true, 'limit', v_limit, 'replayed', true) || v_extra;
            end if;

            raise exception 'this export claim has already been used' using errcode = '22023';
        end if;
    end if;

    v_answer := public.consume_quota (v_billed, 'pdf_exports', v_limit);

    -- A refused id bought nothing, so it must not answer ok on a later retry.
    -- Removed in the same transaction that inserted it, it never existed for
    -- anyone else.
    if p_claim is not null and not (v_answer ->> 'ok')::boolean then
        delete from public.pdf_export_claims c where c.id = p_claim;
    end if;

    if v_guest then
        v_answer := v_answer - 'count';
    end if;
    return v_answer || v_extra;
end;
$$;

revoke all on function public.claim_pdf_export (uuid, uuid) from public;
revoke all on function public.claim_pdf_export (uuid, uuid) from anon;
grant execute on function public.claim_pdf_export (uuid, uuid) to authenticated;

-- Redefined only so it is plainly bound to the function above; same body as
-- 20261007120300, so an id-less claim behaves exactly as it always has.
create or replace function public.consume_pdf_export () returns jsonb language sql security definer
set search_path = public as $$
    select public.claim_pdf_export ();
$$;

revoke all on function public.consume_pdf_export () from public;
revoke all on function public.consume_pdf_export () from anon;
grant execute on function public.consume_pdf_export () to authenticated;

-- ===== supabase/migrations/20261009120101_entitlements_cancel_at_period_end.sql =====
-- Entitlements say when a plan is ending, not only when its period ends.
--
-- The webhook has always stored Stripe's cancel_at_period_end on the
-- subscription row (stripeEvents.subscriptionRowFrom), but get_entitlements()
-- never passed it on, so the Account page could only print current_period_end
-- as "Renews <date>" -- including for a teacher who had cancelled and whose plan
-- will simply stop on that date. Telling someone who cancelled that they will be
-- charged again is the wrong way round for a paid product.
--
-- resolve_entitlements() is the 20261007120300 definition with one more key,
-- read from the same row that already supplies tier, status and period end:
--  * own subscription: the subscriber's own flag -- they can resume it from the
--    billing portal;
--  * Academy seat: the paying owner's flag. A seated teacher could already see
--    the period end through this RPC; whether that date is a renewal or the
--    last day of their access is the same fact about their own plan, and RLS
--    still keeps the owner's subscription row itself out of reach.
--  * free and student: false -- there is no period to end.
-- get_entitlements() and library_bootstrap() return this object as-is, so both
-- carry the key with no change of their own.

create or replace function public.resolve_entitlements (p_user uuid) returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare
    v_user uuid := p_user;
    v_tier text := 'free';
    v_status text;
    v_source text := 'none';
    v_period_end timestamptz;
    v_cancelling boolean := false;
    v_sub record;
begin
    if v_user is null then
        raise exception 'resolve_entitlements requires p_user' using errcode = '22023';
    end if;

    -- A provisioned student short-circuits everything below. The flag is set by
    -- the provisioning function through the admin API, so it is not something the
    -- account itself can write, and a student has no subscription, no seat and no
    -- upgrade path to resolve.
    perform 1
    from auth.users u
    where u.id = v_user
      and u.raw_app_meta_data ->> 'user_type' = 'student';

    if found then
        return jsonb_build_object(
            'user_id', v_user,
            'tier', 'student',
            'status', null::text,
            'source', 'managed',
            'current_period_end', null::timestamptz,
            'cancel_at_period_end', false,
            'limits', public.tier_limits ('student')
        );
    end if;

    -- Own subscription first. Highest tier wins if somehow more than one is live.
    select s.tier, s.status, s.current_period_end, s.cancel_at_period_end
    into v_sub
    from public.subscriptions s
    where s.user_id = v_user
      and s.mode = any (public.entitling_billing_modes ())
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
    order by case s.tier when 'academy' then 3 when 'teacher' then 2 when 'personal' then 1 else 0 end desc,
             s.current_period_end desc nulls last
    limit 1;

    if found then
        v_tier := v_sub.tier;
        v_status := v_sub.status;
        v_period_end := v_sub.current_period_end;
        v_cancelling := v_sub.cancel_at_period_end;
        v_source := 'subscription';
    else
        -- Otherwise: a seat in an academy whose owner is paying.
        select s.status, s.current_period_end, s.cancel_at_period_end
        into v_sub
        from public.studio_members sm
        join public.studios st on st.id = sm.studio_id
        join public.subscriptions s on s.user_id = st.owner_id
        where sm.user_id = v_user
          and s.tier = 'academy'
          and s.mode = any (public.entitling_billing_modes ())
          and s.status in ('active', 'trialing')
          and (s.current_period_end is null or s.current_period_end > now())
        order by s.current_period_end desc nulls last
        limit 1;

        if found then
            v_tier := 'academy';
            v_status := v_sub.status;
            v_period_end := v_sub.current_period_end;
            v_cancelling := v_sub.cancel_at_period_end;
            v_source := 'studio_member';
        end if;
    end if;

    return jsonb_build_object(
        'user_id', v_user,
        'tier', v_tier,
        'status', v_status,
        'source', v_source,
        'current_period_end', v_period_end,
        'cancel_at_period_end', coalesce(v_cancelling, false),
        'limits', public.tier_limits (v_tier)
    );
end;
$$;

-- Unchanged: service-only. get_entitlements() is the caller check in front.
revoke all on function public.resolve_entitlements (uuid) from public;
revoke all on function public.resolve_entitlements (uuid) from anon;
revoke all on function public.resolve_entitlements (uuid) from authenticated;
grant execute on function public.resolve_entitlements (uuid) to service_role;

-- ===== supabase/migrations/20261009120200_share_link_errors_and_peek.sql =====
-- Share-link answers a client can act on, and a way to check a link before
-- anybody is created to redeem it.
--
--  1. redeem_share_link raised 'invalid or expired share link' with SQLSTATE
--     P0002 (no_data_found). PostgREST maps every P0 code except P0001 to HTTP
--     500, so a dead link -- the most ordinary refusal there is -- reached the
--     browser, the logs and the error monitor as a server fault. It now raises
--     PT404: PostgREST turns an SQLSTATE of the form PTxyz into HTTP status xyz,
--     and 404 is what a link that does not (or no longer) exist is. The message
--     text is unchanged, so a client deployed before this migration (which
--     matches on it) keeps working; the current client matches the stable
--     code in `detail` instead (shareService.ts redeemShareLink). The rest of
--     the function is 20261007120000's, verbatim.
--
--  2. peek_share_link(token) answers "would this link let somebody in, and as
--     what?" -- {valid, role}, nothing else. The join page asks it BEFORE
--     signing a guest in: without it, every guest who opened a dead link
--     typed their name, got a brand-new anonymous auth user, and only then
--     heard the link was dead -- an orphan account per failed join.
--
--     It is callable by anon, on purpose: the person asking has no session
--     yet, and creating one is exactly what it exists to avoid. What that
--     exposes:
--       * Nothing about the score. A valid link answers its role; an unknown,
--         revoked and expired link all answer the same {false, null}, so the
--         answer cannot tell a revoked link from one that never existed.
--       * No new oracle. Anyone can already get an anonymous session and ask
--         redeem_share_link the same question about any token, at whatever
--         rate PostgREST serves; a token is 128 random bits (share_links'
--         default), so asking, by either door, finds nothing by guessing.
--       * Next to no cost. One primary-key probe, STABLE, no writes -- unlike
--         a per-caller counter, which would turn every anonymous read into a
--         write. A token longer than any share_links default can produce is
--         answered without touching the table at all.

-- ---------------------------------------------------------------------------
-- Redemption: 20261007120000's contract, with a 4xx for a dead link
-- ---------------------------------------------------------------------------
create or replace function public.redeem_share_link (p_token text) returns table (document_id uuid, granted_role text) language plpgsql security definer
set search_path = public as $$
-- OUT params (document_id) collide with column names inside the body (e.g.
-- the ON CONFLICT target) — let columns win; the OUTs are only set positionally.
#variable_conflict use_column
declare
    v_uid uuid := auth.uid();
    link record;
    v_prev_role text;
    v_new_role text;
begin
    if v_uid is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    select sl.document_id, sl.role into link
    from public.share_links sl
    where sl.token = p_token
      and sl.revoked_at is null
      and (sl.expires_at is null or sl.expires_at > now());

    if not found then
        -- PT404 -> HTTP 404 (see the header). One answer for unknown, revoked
        -- and expired: a distinct one would tell a prober which tokens exist.
        raise exception 'invalid or expired share link'
            using errcode = 'PT404',
                  detail = json_build_object('code', 'invalid_share_link')::text;
    end if;

    select dm.role into v_prev_role
    from public.document_members dm
    where dm.document_id = link.document_id and dm.user_id = v_uid
    for update;

    -- The owner set this member's role by hand (set_document_member_role):
    -- the link opens the score for them, and changes nothing else -- not the
    -- role, and not where their access is recorded as coming from.
    if v_prev_role is not null and exists (
        select 1 from public.document_member_role_locks l
        where l.document_id = link.document_id and l.user_id = v_uid
    ) then
        return query select link.document_id, v_prev_role;
        return;
    end if;

    insert into public.document_members (document_id, user_id, role)
    values (link.document_id, v_uid, link.role)
    on conflict (document_id, user_id) do update
        set role = case
            when public.document_members.role = 'owner' then 'owner'
            when public.document_members.role = 'editor' then 'editor'
            else excluded.role
        end
    returning role into v_new_role;

    -- The link is recorded as the source only when it actually granted
    -- something: a first join, or a viewer lifted to editor. A redeem that
    -- changed nothing (an editor opening a view link, a member re-opening the
    -- link they joined with, another viewer link) leaves the existing source in
    -- place, so revoking THAT link still withdraws what it gave. An owner row
    -- has no source; nothing a link does can take ownership away.
    if v_new_role <> 'owner' and v_prev_role is distinct from v_new_role then
        insert into public.share_link_redemptions (document_id, user_id, token)
        values (link.document_id, v_uid, p_token)
        on conflict (document_id, user_id) do update
            set token = excluded.token,
                redeemed_at = now();
    end if;

    return query select link.document_id, v_new_role;
end;
$$;

revoke all on function public.redeem_share_link (text) from public;
revoke all on function public.redeem_share_link (text) from anon;
grant execute on function public.redeem_share_link (text) to authenticated;

-- ---------------------------------------------------------------------------
-- Peek: would this link let somebody in? (anon-callable; see the header)
-- ---------------------------------------------------------------------------
-- Always exactly one row. `role` is null whenever `valid` is false.
create or replace function public.peek_share_link (p_token text) returns table (valid boolean, role text) language sql stable security definer
set search_path = public as $$
    select l.role is not null, l.role
    from (select 1) as one
    left join public.share_links l
        on length(p_token) between 1 and 64
       and l.token = p_token
       and l.revoked_at is null
       and (l.expires_at is null or l.expires_at > now());
$$;

-- Granted to anon deliberately -- the one share-link function that is: its
-- caller has no session yet. Revoked from PUBLIC first so the grant list is
-- exactly the two API roles.
revoke all on function public.peek_share_link (text) from public;
grant execute on function public.peek_share_link (text) to anon;
grant execute on function public.peek_share_link (text) to authenticated;

-- ===== supabase/migrations/20261010120200_guest_email_verification.sql =====
-- Proving a guest owns an email address before it is attached to their account.
--
-- A share-link guest is an anonymous auth user. The upgrade banner used to call
-- supabase.auth.updateUser({ email }) straight from the browser, and with
-- mailer_autoconfirm on (it is on both projects: sign-ups are not confirmed)
-- GoTrue confirmed the change on the spot without sending anything. A guest
-- could therefore claim any address — the real owner then met "an account with
-- this email already exists" at sign-up, and a password reset to that address
-- would have handed the guest's account to whoever reads the mailbox.
--
-- The guest-email-start / guest-email-confirm Edge Functions replace that path
-- whatever the auth settings say: start emails a one-time code to the address
-- and records its HMAC here; confirm checks the code, and only then attaches
-- the email and a password with the admin API. Taking the call out of the app
-- is not enough on its own — GoTrue's PUT /auth/v1/user still takes it from
-- anyone holding a guest JWT and the public anon key — so a trigger on
-- auth.users (at the end of this file) refuses to give a guest an address the
-- code has not proven, whichever way the update arrives. Nothing is stored in the clear:
-- the code is HMAC'd with the user id and the address under a server secret,
-- so a row read out of a backup proves nothing, and the address is kept only
-- to bind the code to the one it was sent to.
--
-- Service-role only, like edge_login_attempts: RLS on with no policies, no
-- client grants, and the code check executable by service_role alone.

create table public.guest_email_verifications (
    -- One pending address per guest: asking again replaces the code.
    user_id uuid primary key references auth.users (id) on delete cascade,
    email text not null check (length(email) between 3 and 254 and email = lower(email)),
    code_hash text not null check (length(code_hash) between 1 and 200),
    attempts int not null default 0 check (attempts >= 0),
    expires_at timestamptz not null,
    -- The address check_guest_email_code last answered 'ok' for, and when:
    -- the auth.users guard lets that address onto this guest for a few
    -- minutes after. Its own column, not `email`, so a new code asked for
    -- another address can never inherit the proof.
    verified_email text,
    verified_at timestamptz,
    check ((verified_email is null) = (verified_at is null)),
    created_at timestamptz not null default now()
);

create index guest_email_verifications_expires on public.guest_email_verifications (expires_at);

alter table public.guest_email_verifications enable row level security;

revoke all on table public.guest_email_verifications from public, anon, authenticated;
grant select, insert, update, delete on table public.guest_email_verifications to service_role;

-- Check one code against the guest's pending verification, counting the try.
--
-- Answers:
--   'ok'       the code matches the address it was sent to. The row is KEPT,
--              stamped verified_email/_at for the auth.users guard: the caller deletes
--              it once the email is attached, so an attach that fails
--              transiently can be retried with the same code.
--   'mismatch' wrong code (or a different address); one try spent.
--   'locked'   that was the last try p_max_attempts allows; the row is gone.
--   'expired'  past expires_at; the row is gone.
--   'missing'  no code was ever sent, or it was already used up.
--
-- The row lock serialises parallel tries, so a burst of guesses is counted one
-- at a time and cannot outrun p_max_attempts. SECURITY INVOKER: its only
-- caller, the service role, already holds the table grants.
create or replace function public.check_guest_email_code (
    p_user_id uuid,
    p_email text,
    p_code_hash text,
    p_max_attempts int
) returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
    v public.guest_email_verifications%rowtype;
begin
    if p_user_id is null or p_email is null or p_code_hash is null
        or p_max_attempts is null or p_max_attempts < 1 then
        raise exception 'check_guest_email_code: invalid arguments' using errcode = '22023';
    end if;

    select * into v from public.guest_email_verifications where user_id = p_user_id for update;
    if not found then
        return 'missing';
    end if;

    if v.expires_at <= clock_timestamp() then
        delete from public.guest_email_verifications where user_id = p_user_id;
        return 'expired';
    end if;

    if v.attempts >= p_max_attempts then
        delete from public.guest_email_verifications where user_id = p_user_id;
        return 'locked';
    end if;

    if v.email = lower(trim(p_email)) and v.code_hash = p_code_hash then
        update public.guest_email_verifications
        set attempts = attempts + 1, verified_email = v.email, verified_at = clock_timestamp()
        where user_id = p_user_id;
        return 'ok';
    end if;

    if v.attempts + 1 >= p_max_attempts then
        delete from public.guest_email_verifications where user_id = p_user_id;
        return 'locked';
    end if;
    update public.guest_email_verifications set attempts = attempts + 1 where user_id = p_user_id;
    return 'mismatch';
end;
$$;

revoke all on function public.check_guest_email_code (uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.check_guest_email_code (uuid, text, text, int) to service_role;

-- Does any account already use this address? guest-email-start asks before it
-- sends a code, so a guest is told to sign in instead of being mailed a code
-- that could never attach (GoTrue refuses a duplicate with email_exists, which
-- guest-email-confirm still handles for the race). It answers a boolean and
-- nothing else about the account — the same fact sign-up already states.
--
-- SECURITY DEFINER because auth.users is not readable by the service role's
-- grants on every project; search_path is empty so every name is qualified,
-- and the caller must be the service role — a client calling it would have a
-- free, unthrottled oracle over every address, which is why it is not granted
-- to anon or authenticated either.
create or replace function public.guest_email_taken (p_email text) returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if coalesce(auth.role (), '') <> 'service_role' then
        raise exception 'guest_email_taken is for the service role only' using errcode = '42501';
    end if;
    if p_email is null or length(trim(p_email)) = 0 then
        return false;
    end if;
    return exists (
        select 1 from auth.users u where lower(u.email) = lower(trim(p_email))
    );
end;
$$;

revoke all on function public.guest_email_taken (text) from public, anon, authenticated;
grant execute on function public.guest_email_taken (text) to service_role;

-- The server-side half: a guest gets an email address only once it is proven.
--
-- GoTrue lets an anonymous user add an email with PUT /auth/v1/user, and with
-- mailer_autoconfirm on it confirms the change in the same request, mailing
-- nobody (api/user.go: "anonymous users can add an email with automatic
-- confirmation"). The app no longer makes that call, but anybody can, with
-- their own guest JWT and the public anon key — so this refuses the result
-- unless guest-email-confirm has just checked a code for exactly that address.
--
-- What is refused, on a row that is or was a guest in this transaction:
--   * becoming registered (is_anonymous true → false) with no code checked
--     ('ok' from check_guest_email_code) in the last 10 minutes;
--   * gaining or changing its email to anything but the address that code
--     was sent to.
-- "Was a guest in this transaction" matters because GoTrue does it in steps,
-- and today clears is_anonymous BEFORE it sets the email on both paths — the
-- user path (verify.go emailChangeVerify) and the admin path guest-email-
-- confirm uses (admin.go adminUserUpdate) — so by the time the email arrives
-- the row no longer says it was a guest. The step that clears is_anonymous
-- leaves the id in a transaction-local setting, which only ever adds the
-- address check to the later step. Either order, or one statement, is held to
-- the same rule. Registered accounts are untouched: GoTrue already mails both
-- addresses before it changes theirs, and nobody can set a setting on GoTrue's
-- connection to escape the check.
--
-- Refused with 42501; GoTrue rolls the whole request back and answers 500.
-- SECURITY DEFINER because GoTrue updates as supabase_auth_admin, which holds
-- no grant on the table; search_path is empty, so every name is qualified.
-- Nobody calls it: a trigger function cannot be called directly, and EXECUTE
-- is revoked all the same.
create or replace function public.guard_guest_email () returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_upgrades text := coalesce(current_setting('cleffy.guest_upgrades', true), '');
    v_leaving boolean := old.is_anonymous and not new.is_anonymous;
    v_email_changes boolean := nullif(new.email, '') is not null
        and lower(coalesce(old.email, '')) is distinct from lower(new.email);
    v_proven text;
begin
    -- A soft delete overwrites the email with an obfuscated one; that is not
    -- an address being attached.
    if not (v_leaving or v_email_changes) or new.deleted_at is not null then
        return new;
    end if;
    if not (old.is_anonymous or new.is_anonymous or strpos(v_upgrades, new.id::text) > 0) then
        return new;
    end if;

    select g.verified_email into v_proven
    from public.guest_email_verifications g
    where g.user_id = new.id
        and g.verified_at > clock_timestamp() - interval '10 minutes';
    if not found then
        raise exception 'a guest account gets an email address only through guest-email-confirm'
            using errcode = '42501';
    end if;
    if v_email_changes and lower(new.email) <> v_proven then
        raise exception 'that is not the address the guest proved'
            using errcode = '42501';
    end if;

    if v_leaving then
        perform set_config('cleffy.guest_upgrades', v_upgrades || new.id::text || ',', true);
    end if;
    return new;
end;
$$;

revoke all on function public.guard_guest_email () from public, anon, authenticated, service_role;

create trigger guard_guest_email
before update of email, is_anonymous on auth.users
for each row
when (old.email is distinct from new.email or old.is_anonymous is distinct from new.is_anonymous)
execute function public.guard_guest_email ();

-- ===== supabase/migrations/20261010120300_student_access_revocation.sql =====
-- Archiving or resetting a student ends the sessions they already have open.
--
-- Until now both only stopped the NEXT sign-in. 'archive' banned the account,
-- which refuses the password grant and every refresh, and 'reset' scrambled the
-- password. Neither touched a session that was already open: its access token
-- is a signed JWT PostgREST trusts until it expires (an hour), and every
-- membership check -- document_role() and the RLS built on it -- read
-- document_members alone. So an archived student's open tab kept reading and
-- writing the teacher's scores for up to an hour, and a reset student's other
-- devices kept their sign-in for good (nothing stopped them refreshing).
--
-- Three parts, all keyed on the managed_students row, so nothing changes for an
-- account that is not a provisioned student:
--
--  1. student_access_revoked() -- is the CALLER a student whose access the
--     teacher withdrew: their roster row archived, or their access token issued
--     before the teacher last ended their sessions (managed_students.
--     access_revoked_at, stamped by end_student_sessions on a reset or an
--     archive). The JWT stays cryptographically valid after either; its `iat`
--     against that stamp is what says whether it predates the teacher's action.
--
--     NOT "the session the JWT names is gone". GoTrue deletes every session of
--     an account on a global sign-out -- supabase-js's default scope, which is
--     how the app signs out -- and on any admin password change, so that test
--     also cut off a student's other devices the moment they signed out on one:
--     a stroke drawn there was refused and rolled back, and the queued ones
--     with it. Before this migration that device kept working until its token
--     expired, and that is what a sign-out the student chose still does.
--  2. document_role() consults it, so every policy, storage rule and realtime
--     topic check built on document_role() refuses such a caller on the very
--     next request. The student branches of assignments_select and
--     practice_notes_select (which do not go through document_role) do too.
--  3. end_student_sessions(student) -- service role only, called by
--     student-provision on archive and reset: stamps access_revoked_at, deletes
--     the student's sessions (their refresh tokens cascade), so no device can
--     refresh its way back in, and sends the existing membership hint on every
--     score the student is a member of, so an open viewer re-checks its role at
--     once instead of on its next write.
--
-- Hosted Supabase lets the migration owner (postgres) read and delete
-- auth.sessions / auth.refresh_tokens; the function that touches them is
-- plpgsql so creating it does not depend on those tables existing (the local
-- SQL harness stubs them).

-- ---------------------------------------------------------------------------
-- 0. When the teacher last withdrew the student's sign-ins
-- ---------------------------------------------------------------------------
-- Written by end_student_sessions() alone and read by student_access_revoked()
-- alone, both SECURITY DEFINER. Not added to authenticated's column grant on
-- managed_students (20260826194426_roster.sql): no client needs it.
alter table public.managed_students
add column if not exists access_revoked_at timestamptz;

comment on column public.managed_students.access_revoked_at is
'When the teacher last ended this student''s sessions (reset or archive). An access token issued before it no longer reaches anything.';

-- ---------------------------------------------------------------------------
-- 1. Has the caller's access as a student been withdrawn?
-- ---------------------------------------------------------------------------
-- About the caller only (auth.uid() / auth.jwt()), so granting it to
-- authenticated tells nobody anything about anyone else: the student app asks
-- it to tell "nothing assigned" from "your teacher archived you", and the sync
-- engine to tell a refusal of a change from a sign-in the teacher ended (the
-- first rolls the change back; the second keeps it for the next sign-in).
--
-- False for every account with no roster row except a JWT that still calls
-- itself a student (app_metadata is admin-set): a student whose row is gone was
-- deleted with their teacher, and their leftover token should read as revoked.
create or replace function public.student_access_revoked () returns boolean language plpgsql stable security definer
set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    v_archived_at timestamptz;
    v_revoked_at timestamptz;
    v_iat text;
begin
    if v_uid is null then
        return false;
    end if;

    select ms.archived_at, ms.access_revoked_at into v_archived_at, v_revoked_at
    from public.managed_students ms
    where ms.student_user_id = v_uid;

    if not found then
        return coalesce(auth.jwt () -> 'app_metadata' ->> 'user_type', '') = 'student';
    end if;

    if v_archived_at is not null then
        return true;
    end if;

    if v_revoked_at is null then
        return false;
    end if;

    -- Every GoTrue access token carries `iat` (whole seconds). One without a
    -- readable one cannot be placed after the teacher's action, so it is not.
    -- `<` on whole seconds refuses a token issued in the same second as the
    -- stamp, either side of it: nothing legitimate is, since a sign-in after a
    -- reset needs the new code the reset only hands out once it has finished.
    v_iat := auth.jwt () ->> 'iat';
    if v_iat is null or v_iat !~ '^[0-9]{1,12}(\.[0-9]+)?$' then
        return true;
    end if;

    return to_timestamp(v_iat::double precision) < v_revoked_at;
end;
$$;

revoke all on function public.student_access_revoked () from public;
revoke all on function public.student_access_revoked () from anon;
grant execute on function public.student_access_revoked () to authenticated;

-- ---------------------------------------------------------------------------
-- 2. document_role() refuses a revoked student
-- ---------------------------------------------------------------------------
-- The helper only runs for a member who HAS a roster row: for everyone else the
-- NOT EXISTS is one probe of managed_students' unique student_user_id index and
-- finds nothing, which matters because RLS calls this once per annotation row.
create or replace function public.document_role (doc uuid) returns text language sql stable security definer
set search_path = public as $$
    select dm.role
    from public.document_members dm
    where dm.document_id = doc
      and dm.user_id = (select auth.uid())
      and not exists (
          select 1
          from public.managed_students ms
          where ms.student_user_id = dm.user_id
            and public.student_access_revoked ()
      );
$$;

drop policy if exists assignments_select on public.assignments;

create policy assignments_select on public.assignments for select to authenticated
using (
    (
        student_user_id = (select auth.uid())
        and not (select public.student_access_revoked ())
    )
    or public.document_role (document_id) = 'owner'
);

drop policy if exists practice_notes_select on public.practice_notes;

create policy practice_notes_select on public.practice_notes for select to authenticated
using (
    author_id = (select auth.uid())
    or (
        shared
        and student_user_id = (select auth.uid())
        and not (select public.student_access_revoked ())
    )
);

-- ---------------------------------------------------------------------------
-- 3. End a student's sessions (student-provision, service role)
-- ---------------------------------------------------------------------------
-- Returns how many sessions were ended. Refuses anyone who is not a roster
-- student: this is the teacher's lever on their own students, not a general
-- "sign anybody out" primitive, even for the service role.
create or replace function public.end_student_sessions (p_student uuid) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_ended int;
    v_doc uuid;
begin
    if coalesce(auth.jwt () ->> 'role', '') <> 'service_role' then
        raise exception 'service role only' using errcode = '42501';
    end if;

    if not exists (
        select 1
        from public.managed_students ms
        where ms.student_user_id = p_student
    ) then
        raise exception 'not a roster student' using errcode = 'P0002';
    end if;

    -- Tokens first, by user: GoTrue's would cascade from their session, but one
    -- from before sessions existed has none, and clearing them first does not
    -- lean on the cascade at all.
    delete from auth.refresh_tokens
    where user_id = p_student::text;

    delete from auth.sessions
    where user_id = p_student;

    get diagnostics v_ended = row_count;

    -- The revocation itself: every access token issued before this moment is
    -- refused from the next request on (student_access_revoked). The clock,
    -- not now(), and after the deletes: a refresh that committed while they
    -- waited on its token's lock minted an access token before this, not
    -- after the transaction began.
    update public.managed_students
    set access_revoked_at = clock_timestamp()
    where student_user_id = p_student;

    -- The same hint document_members_broadcast sends when a membership ends,
    -- and read the same way: the viewer re-reads its role over PostgREST, where
    -- document_role() now answers null. `role` null because, for this caller,
    -- the membership is as good as gone.
    for v_doc in
        select dm.document_id
        from public.document_members dm
        where dm.user_id = p_student
    loop
        perform realtime.send(
            jsonb_build_object(
                'table', 'document_members',
                'document_id', v_doc,
                'user_id', p_student,
                'role', null
            ),
            'membership', -- event
            'doc:' || v_doc::text, -- topic
            true -- private
        );
    end loop;

    return v_ended;
end;
$$;

revoke all on function public.end_student_sessions (uuid) from public;
revoke all on function public.end_student_sessions (uuid) from anon;
revoke all on function public.end_student_sessions (uuid) from authenticated;
grant execute on function public.end_student_sessions (uuid) to service_role;

-- ===== supabase/migrations/20261010120301_annotation_payload_shape.sql =====
-- The server checks what a mark's payload and colour look like.
--
-- annotations.payload was `jsonb not null` and nothing else, so any editor
-- could store any JSON at all -- a string, a 10 MB blob, a "stroke" with no
-- points -- through PostgREST or the batch RPCs, and every peer's viewer then
-- had to cope with it. A CHECK on the table holds for every write path at once
-- (plain inserts and updates, insert_annotations_batch and
-- patch_annotations_batch, which run as the caller), so neither RPC needs its
-- own copy.
--
-- What is checked mirrors src/types/models.ts (StrokePayload / TextPayload),
-- which has carried these shapes unchanged since the ink engine landed:
--
--  * every payload: a JSON object of at most 1 MiB serialized. The largest
--    stroke ever stored is under 25 KB; a megabyte is minutes of continuous
--    pen input.
--  * stroke / highlight: `pts` a non-empty flat array of numbers in [x, y, p]
--    triplets, `w` a number in (0, 1]; `sp` / `src` 1 when present.
--  * text: `x` / `y` / `size` numbers (size in (0, 1]), `text` a string of at
--    most 10,000 characters; `src` / `sf` / `hw` / `bold` 1, `italic` 0 or 1,
--    `font` 'sans' or 'serif' when present.
--  * coordinates (and pressures) within [-1, 2]. The client clamps ink to the
--    page (0..1) and keeps text on it, so this is a sanity bound rather than
--    the page edge: a slightly out-of-range value from an older or future
--    client is not worth refusing, a 1e300 is.
--  * colour: a #hex colour, which is all the app's palette has ever held.
--
-- Unknown payload keys are allowed on purpose. A refused write is discarded by
-- the sync outbox (rolled back to server truth), so a client release that adds
-- a provenance flag before this function learns it must not lose marks; the
-- size cap is what bounds what an extra key can carry.
--
-- Production rows were checked against these rules before the constraint was
-- written (all pass); VALIDATE re-proves it at apply time and fails the
-- migration rather than leaving an unenforced constraint behind.

-- A JSON number as numeric; NULL for anything else (a string "0.5", an array,
-- a missing key), which the caller's comparison then turns into a refusal.
create or replace function public.annotation_payload_number (p_value jsonb) returns numeric
language sql immutable parallel safe
set search_path = '' as $$
    select case when jsonb_typeof(p_value) = 'number' then (p_value #>> '{}')::numeric end;
$$;

create or replace function public.annotation_payload_valid (p_kind text, p_payload jsonb) returns boolean
language sql immutable parallel safe
set search_path = '' as $$
    -- coalesce: a missing or mistyped key makes its test NULL, and a CHECK
    -- passes on NULL.
    select coalesce(
        jsonb_typeof(p_payload) = 'object'
        and octet_length(p_payload::text) <= 1048576
        and case
            -- A nested CASE, not AND: SQL does not promise to evaluate AND's
            -- arms in order, and jsonb_array_length raises on a non-array.
            when p_kind in ('stroke', 'highlight') then case
                when jsonb_typeof(p_payload -> 'pts') is distinct from 'array' then false
                else
                    jsonb_array_length(p_payload -> 'pts') >= 3
                    and jsonb_array_length(p_payload -> 'pts') % 3 = 0
                    -- Strict jsonpath (lax would unwrap a nested array into
                    -- its numbers): an element that is not a number, or is out
                    -- of range, makes the filter match.
                    and not jsonb_path_exists(
                        p_payload, 'strict $.pts[*] ? (@.type() != "number" || @ < -1 || @ > 2)'
                    )
                    and public.annotation_payload_number (p_payload -> 'w') > 0
                    and public.annotation_payload_number (p_payload -> 'w') <= 1
                    and (not p_payload ? 'sp' or p_payload -> 'sp' = '1'::jsonb)
                    and (not p_payload ? 'src' or p_payload -> 'src' = '1'::jsonb)
            end
            when p_kind = 'text' then
                public.annotation_payload_number (p_payload -> 'x') between -1 and 2
                and public.annotation_payload_number (p_payload -> 'y') between -1 and 2
                and public.annotation_payload_number (p_payload -> 'size') > 0
                and public.annotation_payload_number (p_payload -> 'size') <= 1
                and jsonb_typeof(p_payload -> 'text') = 'string'
                and char_length(p_payload ->> 'text') <= 10000
                and (not p_payload ? 'src' or p_payload -> 'src' = '1'::jsonb)
                and (not p_payload ? 'sf' or p_payload -> 'sf' = '1'::jsonb)
                and (not p_payload ? 'hw' or p_payload -> 'hw' = '1'::jsonb)
                and (not p_payload ? 'bold' or p_payload -> 'bold' = '1'::jsonb)
                and (not p_payload ? 'italic' or p_payload -> 'italic' in ('0'::jsonb, '1'::jsonb))
                and (not p_payload ? 'font' or p_payload -> 'font' in ('"sans"'::jsonb, '"serif"'::jsonb))
            else false
        end,
        false
    );
$$;

-- Pure and harmless, and the client may as well be able to ask it.
revoke all on function public.annotation_payload_valid (text, jsonb) from public;
revoke all on function public.annotation_payload_valid (text, jsonb) from anon;
grant execute on function public.annotation_payload_valid (text, jsonb) to authenticated, service_role;

revoke all on function public.annotation_payload_number (jsonb) from public;
revoke all on function public.annotation_payload_number (jsonb) from anon;
grant execute on function public.annotation_payload_number (jsonb) to authenticated, service_role;

-- NOT VALID then VALIDATE: the add itself only takes a brief lock, and the scan
-- of existing rows runs under one that lets reads and writes continue.
alter table public.annotations
    add constraint annotations_payload_shape check (public.annotation_payload_valid (kind, payload)) not valid;

alter table public.annotations validate constraint annotations_payload_shape;

alter table public.annotations
    add constraint annotations_color_hex check (color ~ '^#[0-9A-Fa-f]{3,8}$') not valid;

alter table public.annotations validate constraint annotations_color_hex;

-- ===== supabase/migrations/20261010120302_library_hides_revoked_student_scores.sql =====
-- The library stops listing an archived or reset student's scores at once.
--
-- 20261010120300 made document_role() refuse a student whose access was
-- withdrawn, which closes every policy, storage rule and realtime topic check
-- built on it. library_documents() is SECURITY DEFINER and assembles the
-- visible set from document_members directly (see 20261007120400 for why), so
-- the leftover access token of an archived or reset student could still list
-- the titles and metadata of their assigned scores for up to an hour, though
-- opening one was refused. library_bootstrap() takes its first page from
-- library_documents(), so this one change covers both.
--
-- Same function as 20261007120400 otherwise. The owner branch is untouched:
-- roster students do not own scores, and documents_select keeps owner_id too.
--
-- Residual, not fixable here: a realtime channel the student had ALREADY
-- joined stays authorized until the socket's JWT expires, because Realtime
-- checks realtime.messages policies when a channel is joined, not per message.
-- The membership hint end_student_sessions() sends makes the app leave the
-- score at once; only a tampered client that ignores it keeps receiving that
-- score's broadcasts, for at most the token's remaining lifetime.

create or replace function public.library_documents (
    p_sort text default 'recent',
    p_after_updated_at timestamptz default null,
    p_after_title text default null,
    p_after_id uuid default null,
    p_query text default null,
    p_tag_id uuid default null,
    p_favorites_only boolean default false,
    p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_uid uuid := (select auth.uid());
    v_sort text := coalesce(p_sort, 'recent');
    v_limit int := least(greatest(coalesce(p_limit, 100), 1), 200);
    v_query text := nullif(btrim(coalesce(p_query, '')), '');
    v_pattern text;
    v_rows jsonb;
    v_count int;
    -- Once per call, not per row: about the caller only.
    v_revoked boolean := public.student_access_revoked ();
begin
    if v_uid is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;
    if v_sort not in ('recent', 'title') then
        raise exception 'unknown library sort: %', v_sort using errcode = '22023';
    end if;
    -- A half cursor would compare against null and silently return nothing.
    if p_after_id is not null
       and ((v_sort = 'recent' and p_after_updated_at is null)
            or (v_sort = 'title' and p_after_title is null)) then
        raise exception 'library cursor is incomplete' using errcode = '22023';
    end if;

    if v_query is not null then
        -- Titles are short; a pasted paragraph is not a search worth running.
        -- Escape ilike's own wildcards so "50%" or "op_1" match literally.
        v_pattern := '%'
            || replace(replace(replace(left(v_query, 200), '\', '\\'), '%', '\%'), '_', '\_')
            || '%';
    end if;

    with visible as (
        select
            d.id,
            d.owner_id,
            d.title,
            d.storage_path,
            d.page_count,
            d.content_rev,
            d.thumb_rev,
            d.created_at,
            d.updated_at,
            d.archived_at
        from public.documents d
        where (
                d.owner_id = v_uid
                or (
                    not v_revoked
                    and exists (
                        select 1
                        from public.document_members m
                        where m.document_id = d.id
                          and m.user_id = v_uid
                    )
                )
            )
          and (v_pattern is null or d.title ilike v_pattern)
          and (
                p_tag_id is null
                or exists (
                    select 1
                    from public.document_tags dt
                    join public.library_tags t on t.id = dt.tag_id
                    where dt.document_id = d.id
                      and dt.tag_id = p_tag_id
                      and t.user_id = v_uid
                )
            )
          and (
                not coalesce(p_favorites_only, false)
                or exists (
                    select 1
                    from public.document_favorites f
                    where f.document_id = d.id
                      and f.user_id = v_uid
                )
            )
          and (
                p_after_id is null
                or (v_sort = 'recent' and (d.updated_at, d.id) < (p_after_updated_at, p_after_id))
                or (v_sort = 'title' and (lower(d.title), d.id) > (lower(p_after_title), p_after_id))
            )
    ),
    ordered as (
        select
            v.*,
            row_number() over (
                order by
                    case when v_sort = 'title' then lower(v.title) end asc,
                    case when v_sort = 'title' then v.id end asc,
                    case when v_sort = 'recent' then v.updated_at end desc,
                    case when v_sort = 'recent' then v.id end desc
            ) as rn
        from visible v
    ),
    page as (
        select * from ordered where rn <= v_limit + 1
    )
    select
        coalesce(
            (select jsonb_agg(to_jsonb(p) - 'rn' order by p.rn) from page p where p.rn <= v_limit),
            '[]'::jsonb
        ),
        (select count(*)::int from page)
    into v_rows, v_count;

    return jsonb_build_object(
        'documents', v_rows,
        'has_more', v_count > v_limit
    );
end;
$$;

revoke all on function public.library_documents (text, timestamptz, text, uuid, text, uuid, boolean, integer) from public;
revoke all on function public.library_documents (text, timestamptz, text, uuid, text, uuid, boolean, integer) from anon;
grant execute on function public.library_documents (text, timestamptz, text, uuid, text, uuid, boolean, integer) to authenticated;

-- ===== supabase/migrations/20261011120100_archived_student_password_check.sql =====
-- An archived student who signs in is told they were archived.
--
-- Archiving bans the student's auth account (student-provision), and GoTrue's
-- password grant refuses a banned account BEFORE it checks the password. So
-- student-login could only ever answer an archived student with its one
-- floored "That username and password did not work" -- at a password that is
-- right, which the student then retypes forever, and which also wiped the
-- "your teacher changed your access / your changes are kept" notice the app
-- had just shown them.
--
-- Saying "archived" to anyone who typed an archived username would make the
-- endpoint an oracle for which usernames exist (handler.ts explains why it has
-- one rejection). Saying it to someone who typed that account's PASSWORD tells
-- them nothing they do not already hold. GoTrue will not check that password
-- for a banned account, so this does: bcrypt, through pgcrypto's crypt(),
-- against the hash GoTrue stored.
--
-- Only for an archived, claimed roster row whose auth user is a provisioned
-- student (the same filters student-login applies to a live row, archived
-- flipped). Anything else, a non-bcrypt hash, or an error is false, which
-- student-login answers exactly as before. The service role alone may call it:
-- to anyone else it would be an unthrottled password check. student-login has
-- already counted the attempt against its per-username and per-address limits
-- before it gets here.
create or replace function public.archived_student_password_matches (p_username text, p_password text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_hash text;
begin
    if coalesce(auth.role (), '') <> 'service_role' then
        raise exception 'archived_student_password_matches is for the service role only' using errcode = '42501';
    end if;
    if p_username is null or p_password is null or p_password = '' then
        return false;
    end if;

    select u.encrypted_password into v_hash
    from public.managed_students ms
    join auth.users u on u.id = ms.student_user_id
    where ms.username = p_username
      and ms.archived_at is not null
      and ms.claimed_at is not null
      and coalesce(u.raw_app_meta_data ->> 'user_type', '') = 'student';

    -- GoTrue stores bcrypt ($2a$, or $2b$/$2y$ from elsewhere). Anything else
    -- is not a hash crypt() can check here.
    if v_hash is null or v_hash !~ '^\$2[aby]\$[0-9]{2}\$' then
        return false;
    end if;

    begin
        return extensions.crypt (p_password, v_hash) = v_hash;
    exception when others then
        return false;
    end;
end;
$$;

revoke all on function public.archived_student_password_matches (text, text) from public, anon, authenticated;
grant execute on function public.archived_student_password_matches (text, text) to service_role;

-- ===== supabase/migrations/20261011120101_refund_edge_rate_limit.sql =====
-- Hand back one use of an edge rate-limit bucket.
--
-- guest-email-start's per-mailbox and project-wide limits are meant to count
-- mail that went out (DEPLOY.md, "spent only when a code is actually mailed").
-- check_edge_rate_limit counts and checks in one step, and the function used
-- to call it just before the send and keep the count whatever happened next:
-- a deploy with no mail key, or a Resend outage, used up a mailbox's three an
-- hour and the project's sixty without one email being sent.
--
-- The function now reserves with check_edge_rate_limit (so two requests at
-- once cannot both take the last slot) and calls this when nothing was
-- mailed. One use, never below zero, and only inside the bucket's current
-- window: a refund arriving after the window rolled over must not eat into
-- the next window's allowance.
--
-- Service role only, like check_edge_rate_limit: to anyone else it would be a
-- way to undo every limit built on these buckets.
create or replace function public.refund_edge_rate_limit (p_key text) returns void language plpgsql security definer
set search_path = public as $$
begin
    update public.edge_rate_buckets
    set count = count - 1
    where key = p_key
      and count > 0
      and reset_at > clock_timestamp();
end;
$$;

revoke all on function public.refund_edge_rate_limit (text) from public, anon, authenticated;
grant execute on function public.refund_edge_rate_limit (text) to service_role;

-- ===== supabase/migrations/20261012120100_one_entitling_subscription_per_user.sql =====
-- At most one entitling subscription per user per Stripe account.
--
-- The double charge this closes (QA round 4, D1): stripe-checkout refused a
-- second purchase by reading this table, but it read it when a Checkout Session
-- was CREATED, not when one was PAID. Two sessions opened before either was
-- paid both passed the guard -- two tabs, a double-click, a back button and a
-- retry; a session stays payable for 24 hours -- and paying both left the
-- customer with two `active` subscriptions whose billed periods overlapped
-- completely, $38 for one plan's worth of service. Nothing told them: the
-- entitlements RPC takes the highest tier and stops (`order by tier ... limit
-- 1`), so the app looked exactly as it does for one subscription, and the
-- second renewed every month unnoticed.
--
-- stripe-checkout now expires the customer's open sessions before it opens
-- another and passes Stripe a deterministic idempotency key, so two sessions
-- should no longer exist to be paid. This index is the layer that does not
-- depend on an Edge Function having run at all: whatever a client, a Stripe
-- retry or a future code path does, the webhook's upsert cannot land a SECOND
-- entitling row beside one that is already there. Entitlement is computed from
-- rows with these statuses, so a status nobody is entitled by is not something
-- to serialise -- a cancelled subscription and the new one replacing it must
-- both be allowed to sit here.
--
-- What the webhook does when it hits this index is deliberate and is NOT to
-- cancel the loser in Stripe (see stripe-webhook/index.ts): the row is left
-- absent, the event is acknowledged, and a single ALERT line names the user and
-- both subscriptions for a human to reconcile.

-- Fail the push rather than skip the index.
--
-- `create unique index` on a table that already violates it aborts the whole
-- `db push` with Postgres's own message, which names the duplicated KEY but not
-- the user, and leaves whoever is deploying to work out what to do. This says
-- it instead -- and it still fails, on purpose. The alternative, creating the
-- index only when the data allows it, would mean the one database that has
-- already double-charged somebody is the one database left unprotected, and the
-- failure would be a line in a log nobody reads rather than a stopped deploy.
-- Reconcile in Stripe first (cancel the duplicate subscription, refund it),
-- then push.
--
-- Checked read-only against production (jibgwgosihadbjgxdsfe) on 2026-10-12:
-- no user holds more than one entitling subscription in either mode, out of one
-- subscription row in total.
do $$
declare
    v_dup record;
begin
    select s.user_id, s.mode, count(*) as n
    into v_dup
    from public.subscriptions s
    where s.status in ('active', 'trialing')
    group by s.user_id, s.mode
    having count(*) > 1
    limit 1;

    if found then
        raise exception
            'user % already holds % entitling subscriptions in % mode; cancel and refund the duplicate in Stripe, then push this migration',
            v_dup.user_id, v_dup.n, v_dup.mode
            using errcode = '23505';
    end if;
end
$$;

create unique index if not exists subscriptions_one_entitling_per_user_mode
    on public.subscriptions (user_id, mode)
    where status in ('active', 'trialing');

-- ===== supabase/migrations/20261012120101_stripe_event_claim_recovery.sql =====
-- Make a webhook event's claim recoverable (QA round 4, D2).
--
-- stripe-webhook claims an event id before it processes the event, so two
-- concurrent deliveries of the same event cannot both apply it. The claim was a
-- committed row and the only compensation was an in-process delete: if the
-- isolate died between claiming and finishing -- a timeout on the Stripe
-- read-back, an OOM, a deploy restarting the worker -- no catch ran, the row
-- stayed, and every one of Stripe's retries for the next three days answered
-- `200 duplicate`. For checkout.session.completed that is a customer who paid
-- and was never entitled, and nothing swept for claims that had never been
-- applied.
--
-- So a claim now records that it is in progress and when it was taken. An
-- unfinished one goes stale and Stripe's own retry re-claims it; a finished one
-- is a duplicate forever, as before.

-- Every row that exists was written by the old claim, which processed the event
-- in the same invocation and had no other state to be in -- so 'done' is what
-- they are, and the default is what backfills them. Nothing inserts without
-- naming a status (claim_stripe_event below always does), so the default only
-- ever decides for these historical rows.
alter table public.stripe_events
    add column if not exists status text not null default 'done' check (status in ('processing', 'done')),
    add column if not exists claimed_at timestamptz not null default now();

-- Claim an event, or say that someone else holds it.
--
-- Why a function rather than the upsert this replaces: the claim has to stay a
-- SINGLE statement, or two deliveries racing can both read "not claimed" and
-- both process. PostgREST's upsert can express "insert, ignore a conflict" but
-- not "insert, or take the row over when the claim on it has gone stale", which
-- is a conditional `on conflict do update ... where`.
--
-- It answers with the stamp it wrote rather than a boolean, so the answer says
-- both "do I own this?" (non-null) and WHICH claim is mine. The webhook needs
-- the second part: releasing a claim after a failure must delete the row only
-- while it is still this invocation's claim -- if the claim went stale and
-- another delivery took it over, deleting would strand that one and let a third
-- delivery in beside it.
--
--  * no row            -> claimed, and this invocation processes the event;
--  * 'done'            -> null; it has been applied, and a replay must not
--                         re-apply it;
--  * 'processing', recent -> null; another delivery is genuinely in flight, and
--                         both applying it is what the claim exists to stop;
--  * 'processing', stale -> claimed; whoever took it never finished, so this
--                         delivery takes it over and processes it.
--
-- Re-processing a taken-over event is safe: every write the handler makes is an
-- upsert keyed on the Stripe id, or an RPC (apply_free_tier_archival /
-- restore_plan_archived_scores) that recomputes from the entitlements the
-- database holds now rather than stepping a counter.
--
-- `type` is refreshed on a takeover for the same reason the insert records it:
-- it is only ever read by a human looking at the row.
create or replace function public.claim_stripe_event (p_id text, p_type text, p_stale_after interval)
returns timestamptz language plpgsql set search_path = public as $$
declare
    v_claimed_at timestamptz;
begin
    insert into public.stripe_events as e (id, type, status, claimed_at)
    values (p_id, p_type, 'processing', now())
    on conflict (id) do update
    set status = 'processing',
        claimed_at = now(),
        type = excluded.type
    where e.status = 'processing'
      and e.claimed_at < now() - p_stale_after
    returning claimed_at into v_claimed_at;

    return v_claimed_at;
end;
$$;

-- Service role only, like every other billing write: to anyone else this would
-- be a way to claim an event Stripe has not delivered yet and have the real
-- delivery answered as a duplicate -- a purchase acknowledged and dropped.
revoke all on function public.claim_stripe_event (text, text, interval) from public, anon, authenticated;

grant execute on function public.claim_stripe_event (text, text, interval) to service_role;

-- ===== supabase/migrations/20261012120102_subscriptions_refuse_stale_event.sql =====
-- Refuse a subscription write that carries an older Stripe event than the row
-- already holds (QA round 4, D3).
--
-- `customer.subscription.created` / `.updated` already re-read the subscription
-- from Stripe instead of applying the copy embedded in the event, which removes
-- most of the damage reordering can do. What it cannot remove is two deliveries
-- in flight at once: A reads `active`, B reads the newer `past_due`, B writes,
-- and then A's write lands and puts `active` back. The row then says a customer
-- whose card failed is paid up, until the next event about them -- a month away
-- on a monthly plan, a year on an annual one.
--
-- So each write now carries the `created` timestamp of the event that triggered
-- it, and the row keeps the newest one it has seen. Stripe stamps `created` on
-- every event, and it is the account's clock for both deliveries, so comparing
-- them is meaningful in a way that comparing our own two write times is not.
--
-- It has to be a trigger: the webhook writes through PostgREST's upsert, which
-- has no way to carry a conditional `where`, and splitting it into a read and a
-- write would reintroduce the same race one level up.
alter table public.subscriptions
    add column if not exists last_event_created_at timestamptz;

-- BEFORE UPDATE returning OLD rather than NULL: the write is dropped, but the
-- statement still reports a row, so PostgREST answers the webhook 200 and
-- Stripe is not asked to retry an event that is simply too old to matter.
--
-- Both NULL cases let the write through, and both are real:
--  * the row has no stamp -- every row written before this migration, and any
--    row a code path other than the webhook touches. There is nothing to
--    compare against, and refusing would freeze those rows permanently.
--  * the write has no stamp -- an event without `created` (nothing Stripe sends
--    today), or a future caller that does not thread one through. A guard that
--    swallowed those would silently drop legitimate writes, which is strictly
--    worse than the staleness it is guarding against; it keeps the stamp the
--    row already has instead, so one unstamped write cannot wipe out the
--    high-water mark and reopen the window for the next stale event.
--
-- Equal stamps pass. Re-processing the SAME event has to stay possible: a retry
-- after a failure that landed its upsert but not the archival after it depends
-- on being able to write the same state again.
create or replace function public.subscriptions_refuse_stale_event () returns trigger
language plpgsql set search_path = public as $$
begin
    if new.last_event_created_at is null then
        new.last_event_created_at := old.last_event_created_at;
        return new;
    end if;

    if old.last_event_created_at is not null and new.last_event_created_at < old.last_event_created_at then
        return old;
    end if;

    return new;
end;
$$;

revoke all on function public.subscriptions_refuse_stale_event () from public, anon, authenticated;

drop trigger if exists subscriptions_refuse_stale_event on public.subscriptions;

create trigger subscriptions_refuse_stale_event
    before update on public.subscriptions
    for each row
    execute function public.subscriptions_refuse_stale_event ();

-- ===== supabase/migrations/20261012120103_checkout_attempt_lock.sql =====
-- One checkout attempt at a time per buyer per Stripe account (QA round 4, D1
-- follow-up).
--
-- What the first round of fixes missed: expiring the customer's open sessions
-- before creating another, and keying creation on an idempotency key, only
-- serialise a double-submit that happens to agree about the purchase. Two
-- requests that disagree -- Teacher in one tab, Academy in the other -- or that
-- straddle the key's time bucket get DIFFERENT idempotency keys, so Stripe
-- creates two sessions; and because the two isolates interleave (both list,
-- both find the other's session absent or already kept, both create), the expire
-- step can leave both open. Two open sessions are two payable sessions, which is
-- the double charge again by another road.
--
-- Edge isolates share no memory, so the mutual exclusion has to live here. A
-- transaction-scoped advisory lock cannot: the critical section spans several
-- Stripe round trips, and PostgREST ends the transaction with the statement. So
-- the lock is a leased row instead -- taken by `begin_checkout_attempt`,
-- released by `finish_checkout_attempt` (recording the session it opened) or by
-- `release_checkout_attempt` (recording nothing), and reclaimable once the lease
-- goes stale, so an isolate that dies mid-checkout does not lock a buyer out of
-- paying us.
--
-- The row outlives the lock on purpose. It remembers the session the last
-- attempt opened, which is what lets the next request hand the buyer back the
-- session they already have instead of minting a second one, and it remembers
-- the attempt id that session's idempotency key was derived from, so a NEW
-- attempt always gets a new key -- Stripe replays a key for 24 hours, and
-- replaying a key whose session we have since expired would send the buyer to a
-- dead Checkout page.
create table if not exists public.checkout_attempts (
    user_id uuid not null references auth.users (id) on delete cascade,
    mode text not null check (mode in ('live', 'test')),
    -- Non-null exactly while a request is inside the critical section. The
    -- value is the token that request has to present to release it, so a
    -- request whose lease went stale cannot release the one that took over.
    holder uuid,
    claimed_at timestamptz not null default now(),
    -- The session the last attempt opened, and the attempt id its Stripe
    -- idempotency key was built from. Null until a session has been opened.
    attempt_id uuid,
    price_id text,
    session_id text,
    updated_at timestamptz not null default now(),
    primary key (user_id, mode)
);

-- Service role only, like every other billing table: the client never reads or
-- writes this, and a buyer who could would be a buyer who could park a lock on
-- their own account or point it at someone else's session. No policy, so RLS
-- refuses every client role outright.
alter table public.checkout_attempts enable row level security;

-- service_role bypasses RLS but still needs the table-level grant (see
-- 20260827140000_core_table_grants.sql): on the local image the default ACL for
-- a table `postgres` created gives nobody DML, so without this the functions
-- below answer 42501 before RLS is ever consulted.
grant all on table public.checkout_attempts to service_role;

-- Take the lock, and answer with what the last attempt left behind.
--
-- One statement, so two isolates racing cannot both win: the conditional
-- `on conflict do update ... where` is what decides, and Postgres takes a row
-- lock for the duration of it. An empty result means someone else holds the
-- lease and has not let go of it yet -- stripe-checkout answers that request
-- with a 409 rather than opening a session beside theirs.
--
-- `attempt_id` / `price_id` / `session_id` come back as they were stored: the
-- update deliberately leaves them alone, because the caller needs the PREVIOUS
-- attempt's session to decide whether to reuse it.
create or replace function public.begin_checkout_attempt (p_user uuid, p_mode text, p_stale_after interval)
returns table (holder uuid, attempt_id uuid, price_id text, session_id text)
language plpgsql set search_path = public as $$
declare
    v_holder uuid := gen_random_uuid();
    v_row public.checkout_attempts;
begin
    insert into public.checkout_attempts as c (user_id, mode, holder, claimed_at, updated_at)
    values (p_user, p_mode, v_holder, now(), now())
    on conflict (user_id, mode) do update
    set holder = v_holder,
        claimed_at = now(),
        updated_at = now()
    where c.holder is null
       or c.claimed_at < now() - p_stale_after
    returning * into v_row;

    if not found then
        return;
    end if;

    return query select v_holder, v_row.attempt_id, v_row.price_id, v_row.session_id;
end;
$$;

-- Release the lock, recording the session this attempt opened.
--
-- Scoped to our own lease (`holder = p_holder`), like the webhook's claim: if
-- ours went stale and another request took it over, that request's session is
-- the live one and overwriting it would point the next reuse at a session we
-- had already abandoned. `false` says exactly that happened.
create or replace function public.finish_checkout_attempt (
    p_user uuid,
    p_mode text,
    p_holder uuid,
    p_attempt_id uuid,
    p_price_id text,
    p_session_id text
) returns boolean language plpgsql set search_path = public as $$
begin
    update public.checkout_attempts
    set holder = null,
        attempt_id = p_attempt_id,
        price_id = p_price_id,
        session_id = p_session_id,
        updated_at = now()
    where user_id = p_user and mode = p_mode and holder = p_holder;

    return found;
end;
$$;

-- Release the lock having opened nothing, leaving the stored session as it was:
-- every refusal and every failure between taking the lock and creating a
-- session. Without it the buyer would wait out the lease before they could try
-- again.
create or replace function public.release_checkout_attempt (p_user uuid, p_mode text, p_holder uuid)
returns boolean language plpgsql set search_path = public as $$
begin
    update public.checkout_attempts
    set holder = null,
        updated_at = now()
    where user_id = p_user and mode = p_mode and holder = p_holder;

    return found;
end;
$$;

revoke all on function public.begin_checkout_attempt (uuid, text, interval) from public, anon, authenticated;
revoke all on function public.finish_checkout_attempt (uuid, text, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.release_checkout_attempt (uuid, text, uuid) from public, anon, authenticated;

grant execute on function public.begin_checkout_attempt (uuid, text, interval) to service_role;
grant execute on function public.finish_checkout_attempt (uuid, text, uuid, uuid, text, text) to service_role;
grant execute on function public.release_checkout_attempt (uuid, text, uuid) to service_role;

-- ===== supabase/migrations/20261012120104_stripe_event_claim_state.sql =====
-- Tell a webhook delivery WHY it did not get the claim (QA round 4, D2
-- follow-up).
--
-- claim_stripe_event (migration 20261012120101) answers with the stamp it wrote
-- and null for everything else, and null conflates the two outcomes that want
-- opposite answers:
--
--  * 'done'       -- the event has been applied. A redelivery is a duplicate and
--                    200 is right: nothing is lost by acknowledging it.
--  * 'processing' -- another delivery holds the claim and has not finished. A
--                    200 here tells Stripe the event landed, and Stripe stops
--                    retrying it. If that other delivery then dies -- the very
--                    case 120101 exists for -- the claim goes stale with nobody
--                    left to retry it: for checkout.session.completed, a
--                    customer charged and never entitled. The staleness window
--                    only helps if Stripe is still delivering.
--
-- So the claim now says which of the three it is, and stripe-webhook answers a
-- live claim with a 409 (Stripe retries) instead of a 200 (Stripe forgets). The
-- 409 is the honest answer either way: this delivery did nothing, and the event
-- has not been applied by anyone yet.
--
-- The losing read is a second statement, which is harmless: mutual exclusion is
-- entirely the conditional upsert's, and a losing caller is only describing a
-- row it is not allowed to touch. A row that vanishes between the two (a
-- release by the holder) reads as 'absent', which the caller treats like a live
-- claim -- a retry, which re-claims it.
-- The ledger has never carried a grant of its own, which the hosted image's
-- permissive default ACL hid: locally, a table `postgres` created gives nobody
-- DML, so the claim below -- and the webhook's own update of `status` through
-- PostgREST -- answers 42501 before RLS is consulted. Idempotent, and the
-- claim states this migration adds are the first thing a local run would have
-- needed it for.
grant all on table public.stripe_events to service_role;

drop function if exists public.claim_stripe_event (text, text, interval);

create or replace function public.claim_stripe_event (p_id text, p_type text, p_stale_after interval)
returns table (state text, claimed_at timestamptz) language plpgsql set search_path = public as $$
declare
    v_claimed_at timestamptz;
    v_status text;
begin
    insert into public.stripe_events as e (id, type, status, claimed_at)
    values (p_id, p_type, 'processing', now())
    on conflict (id) do update
    set status = 'processing',
        claimed_at = now(),
        type = excluded.type
    where e.status = 'processing'
      and e.claimed_at < now() - p_stale_after
    returning e.claimed_at into v_claimed_at;

    if v_claimed_at is not null then
        return query select 'claimed'::text, v_claimed_at;
        return;
    end if;

    -- Lost it. Which way decides whether Stripe should keep trying.
    select e.status into v_status from public.stripe_events e where e.id = p_id;

    return query select coalesce(v_status, 'absent')::text, null::timestamptz;
end;
$$;

revoke all on function public.claim_stripe_event (text, text, interval) from public, anon, authenticated;

grant execute on function public.claim_stripe_event (text, text, interval) to service_role;

-- ===== supabase/migrations/20261012120105_subscription_write_lock.sql =====
-- Serialise the webhook's read-back-and-write per subscription (QA round 4, D3
-- follow-up).
--
-- The `subscriptions_refuse_stale_event` trigger (migration 20261012120102)
-- compares the Stripe `created` stamp of the event each write carries and keeps
-- the newest. That closes reordering between events Stripe stamped a second or
-- more apart, and nothing finer: `created` has one-second resolution, so two
-- events created inside the same second compare EQUAL, and equal has to pass --
-- a retry of one event must be able to write the same state again. So the
-- window the trigger cannot see is exactly the one that matters:
-- `customer.subscription.updated` for a card failure and one for the retry
-- succeeding, both stamped 17:04:09, delivered concurrently. A reads `active`
-- from Stripe, B reads `past_due`, B writes, A writes -- and the row says a
-- customer whose card failed is paid up until the next event about them, a month
-- or a year away.
--
-- Widening the comparison to `<=` would not fix it (it would refuse the equal
-- stamp a retry needs, and still not order the two) and neither would a finer
-- clock, because the race is not in the comparison: it is that the Stripe READ
-- and the DB WRITE are two steps with a gap between them. What removes it is
-- making the pair atomic per subscription -- whoever holds the lock reads the
-- subscription as Stripe holds it NOW and writes that, and the other delivery
-- does its own read afterwards and therefore reads the same or newer state.
--
-- Same shape as the event claim, for the same reason (an Edge isolate shares no
-- memory with the next one, and PostgREST cannot hold a transaction open across
-- a Stripe round trip): a leased row, reclaimable once stale so a dead isolate
-- cannot wedge a subscription, and a delivery that cannot get it is answered
-- with a 503 so Stripe redelivers it rather than a 200 that drops it.
create table if not exists public.subscription_writes (
    stripe_subscription_id text primary key,
    holder uuid not null,
    claimed_at timestamptz not null default now()
);

-- Service role only, like the event ledger beside it: no policy, and the
-- table-level grant service_role needs even though it bypasses RLS (see
-- 20260827140000_core_table_grants.sql).
alter table public.subscription_writes enable row level security;

grant all on table public.subscription_writes to service_role;

-- Take the lock for one subscription, or answer null because someone holds it.
--
-- One statement, so two deliveries cannot both win. The lease is what keeps an
-- isolate that died mid-write from locking a subscription out of every later
-- event; `p_stale_after` is the caller's (STRIPE_SUBSCRIPTION_LOCK_STALE_AFTER).
create or replace function public.claim_subscription_write (p_subscription_id text, p_stale_after interval)
returns uuid language plpgsql set search_path = public as $$
declare
    v_holder uuid := gen_random_uuid();
    v_won uuid;
begin
    insert into public.subscription_writes as w (stripe_subscription_id, holder, claimed_at)
    values (p_subscription_id, v_holder, now())
    on conflict (stripe_subscription_id) do update
    set holder = v_holder,
        claimed_at = now()
    where w.claimed_at < now() - p_stale_after
    returning w.holder into v_won;

    return v_won;
end;
$$;

-- Give it back, but only while it is still ours: a lease that went stale and was
-- taken over belongs to the delivery holding it now, and releasing that one
-- would let a third delivery in beside it.
create or replace function public.release_subscription_write (p_subscription_id text, p_holder uuid)
returns boolean language plpgsql set search_path = public as $$
begin
    delete from public.subscription_writes
    where stripe_subscription_id = p_subscription_id and holder = p_holder;

    return found;
end;
$$;

revoke all on function public.claim_subscription_write (text, interval) from public, anon, authenticated;
revoke all on function public.release_subscription_write (text, uuid) from public, anon, authenticated;

grant execute on function public.claim_subscription_write (text, interval) to service_role;
grant execute on function public.release_subscription_write (text, uuid) to service_role;

-- ===== supabase/migrations/20261013120100_checkout_attempt_durable_key.sql =====
-- Persist a checkout attempt's Stripe idempotency key BEFORE the session is
-- created with it (QA round 4 review of #56, finding 1).
--
-- What 20261012120103 left open. The attempt id that the Stripe idempotency key
-- is derived from was minted in the Edge Function's memory one line above
-- `checkout.sessions.create`, and only written to `checkout_attempts` by
-- `finish_checkout_attempt` AFTER the create returned. Everything between those
-- two points -- which is the slowest call in the whole flow -- was therefore
-- unrecoverable: an isolate killed there left a session Stripe had created and
-- this database had never heard of, and the buyer's next attempt minted a FRESH
-- key, so Stripe made them a second one. Two payable sessions, which is the
-- double charge again.
--
-- The second half of the same finding is the lease. Two minutes was shorter than
-- the wall-clock ceiling an invocation may legally reach, so a create that was
-- merely SLOW -- Stripe retrying behind the SDK -- outlived its own lease, and a
-- second request took the lock from a request that was still running, found no
-- open session yet (the first create had not returned), expired nothing, and
-- opened its own. checkoutFlow.ts now asks for five minutes
-- (CHECKOUT_ATTEMPT_STALE_AFTER); the interval is the caller's argument, so
-- nothing here changes for it.
--
-- `stage_checkout_attempt` is what makes both safe, and it does it without
-- betting on arithmetic about how long an invocation may run:
--
--   * it writes the attempt id and price under the CURRENT lease and keeps the
--     lease, so the key reaching Stripe is one a later attempt can read back and
--     replay -- Stripe answers a repeated key with its original response for 24
--     hours, so the session the dead attempt opened comes back instead of a
--     second one;
--   * it is scoped to `holder`, like finish and release, so an attempt whose
--     lease HAS been taken over cannot stage and therefore never reaches the
--     create at all. A takeover can no longer produce two sessions however the
--     lease length compares to the invocation ceiling.
--
-- `session_id` is cleared on purpose. By the time this runs the stored session
-- has either been handed back to the buyer (layer 4) or expired (layer 5), so
-- leaving the id would point the next attempt's reuse at a session that is dead
-- -- and a null session id beside a non-null attempt id is exactly the state
-- layer 4b recognises as "this key may need replaying".
--
-- `claimed_at` is deliberately NOT re-stamped: the lease is one window from
-- `begin_checkout_attempt`, which is what keeps the bound on how long a buyer
-- can be locked out by a dead isolate readable (one lease, not two).
create or replace function public.stage_checkout_attempt (
    p_user uuid,
    p_mode text,
    p_holder uuid,
    p_attempt_id uuid,
    p_price_id text
) returns boolean language plpgsql set search_path = public as $$
begin
    update public.checkout_attempts
    set attempt_id = p_attempt_id,
        price_id = p_price_id,
        session_id = null,
        updated_at = now()
    where user_id = p_user and mode = p_mode and holder = p_holder;

    return found;
end;
$$;

revoke all on function public.stage_checkout_attempt (uuid, text, uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.stage_checkout_attempt (uuid, text, uuid, uuid, text) to service_role;

-- ===== supabase/migrations/20261013120101_subscription_write_under_lock.sql =====
-- Check the write lease in the same statement as the write (QA round 4 review of
-- #56, finding 3).
--
-- What 20261012120105 left open. The lease made the Stripe read and the row
-- write one step per subscription -- but only by convention: the webhook took
-- the lease, read Stripe, wrote the row through PostgREST, and gave the lease
-- back, and `release_subscription_write` was the ONLY statement that checked
-- whose lease it was. So the sequence that defeats it is:
--
--   A  claims the lease on sub_X, reads `past_due` from Stripe, and stalls
--      (Stripe slow, the SDK retrying -- the read is the long call here).
--   .. A's lease goes stale, because two minutes is shorter than the wall-clock
--      ceiling an invocation may reach.
--   B  takes the lease over, reads `active` from Stripe, writes it, releases.
--   A  wakes up and writes the `past_due` it read minutes ago. Nothing refuses
--      it: the upsert carried no lease, and `subscriptions_refuse_stale_event`
--      cannot order two events Stripe stamped in the same second (that is why
--      the lease exists).
--
-- The row then says a customer whose card failed is paid up -- or, with the
-- statuses the other way round, that a paying customer has lapsed and their
-- scores are archived -- until the next event about them, a month or a year
-- away. Exactly D3, through the lock instead of around it.
--
-- Lengthening the lease (checkoutFlow.ts and stripeEvents.ts both now ask for
-- five minutes) makes the race rarer and nothing more, because "rarer than the
-- ceiling" is a bet on a platform limit we do not set. What closes it is making
-- the WRITE conditional on still holding the lease, in one statement, so there
-- is no gap between the check and the write for a takeover to land in.
--
-- Hence this function rather than PostgREST's upsert: a cross-table condition is
-- not something PostgREST can express, and splitting it into a read and a write
-- would reintroduce the same race one level down.
--
-- `for update` on the lease row is the other half. It holds the row for the rest
-- of this transaction, so `claim_subscription_write` -- whose
-- `on conflict do update` needs the same row lock -- cannot take the lease over
-- WHILE this write is in flight. A takeover therefore happens strictly before
-- (and this function answers `lost_lock`) or strictly after (and the write has
-- already landed), never during.
--
-- The three answers the caller branches on, so none of them is an error string
-- it has to parse:
--
--   written       the row is this delivery's state
--   lost_lock     the lease is someone else's; nothing was written, and the
--                 delivery asks Stripe to redeliver (503)
--   duplicate     subscriptions_one_entitling_per_user_mode refused a SECOND
--                 entitling subscription for this user and account. Matched on
--                 `constraint_name` from the diagnostics rather than on the text
--                 of the message, which is what the Edge Function used to do.
--                 Any OTHER unique violation is re-raised: swallowing one would
--                 turn a bug into an acknowledged event.
--   missing_user  the FK to auth.users: the account was deleted while this
--                 subscription was live. There is no row to write, and
--                 stripe-webhook cancels whatever can still bill.
--
-- The `subscriptions_refuse_stale_event` trigger still sits on the update and
-- still wins where it can speak: it drops a write carrying an older event stamp,
-- which this function reports as `written` exactly as the PostgREST upsert
-- reported it as a success. The two guard different windows -- that trigger
-- orders events a second or more apart, this one orders what the clock cannot.

-- The grant service_role needs even though it bypasses RLS
-- (20260827140000_core_table_grants.sql). `subscriptions` predates that
-- migration and never got one; on hosted Supabase the platform's default ACL
-- hides it, and the function below is SECURITY INVOKER, so on a bare cluster it
-- would answer 42501 before it ever reached the lease check. (This is the
-- environment note at the end of tests/sql/README.md, fixed.)
grant all on table public.subscriptions to service_role;

create or replace function public.write_subscription_under_lock (
    p_holder uuid,
    p_subscription_id text,
    p_user uuid,
    p_mode text,
    p_tier text,
    p_status text,
    p_price_id text,
    p_current_period_end timestamptz,
    p_cancel_at_period_end boolean,
    p_last_event_created_at timestamptz
) returns text language plpgsql set search_path = public as $$
declare
    v_constraint text;
begin
    -- Ours, and held for the rest of the transaction. Outside the exception
    -- block below on purpose: a subtransaction rollback would give the row lock
    -- back, and the point of it is that it outlives the write.
    perform 1
    from public.subscription_writes
    where stripe_subscription_id = p_subscription_id and holder = p_holder
    for update;

    if not found then
        return 'lost_lock';
    end if;

    begin
        insert into public.subscriptions (
            stripe_subscription_id,
            user_id,
            mode,
            tier,
            status,
            price_id,
            current_period_end,
            cancel_at_period_end,
            last_event_created_at,
            updated_at
        ) values (
            p_subscription_id,
            p_user,
            p_mode,
            p_tier,
            p_status,
            p_price_id,
            p_current_period_end,
            p_cancel_at_period_end,
            p_last_event_created_at,
            now()
        )
        -- The primary key, as before: a redelivery updates the subscription's
        -- own row. The partial unique index is NOT a conflict target -- a second
        -- entitling subscription is not the same subscription, so there is no
        -- row for it to merge into.
        on conflict (stripe_subscription_id) do update
        set user_id = excluded.user_id,
            mode = excluded.mode,
            tier = excluded.tier,
            status = excluded.status,
            price_id = excluded.price_id,
            current_period_end = excluded.current_period_end,
            cancel_at_period_end = excluded.cancel_at_period_end,
            last_event_created_at = excluded.last_event_created_at,
            updated_at = now();
    exception
        when unique_violation then
            get stacked diagnostics v_constraint = constraint_name;
            if v_constraint = 'subscriptions_one_entitling_per_user_mode' then
                return 'duplicate';
            end if;
            raise;
        when foreign_key_violation then
            return 'missing_user';
    end;

    return 'written';
end;
$$;

revoke all on function public.write_subscription_under_lock (
    uuid, text, uuid, text, text, text, text, timestamptz, boolean, timestamptz
) from public, anon, authenticated;

grant execute on function public.write_subscription_under_lock (
    uuid, text, uuid, text, text, text, text, timestamptz, boolean, timestamptz
) to service_role;

-- ===== supabase/migrations/20261013120102_duplicate_refund_ledger.sql =====
-- Money we owe a double-charged customer, written down where an event cannot
-- lose it (QA round 4 review of #56, finding 2).
--
-- What 20261012120100's handler left open. When the partial unique index refuses
-- a SECOND entitling subscription, the double charge has already happened in
-- Stripe, so stripe-webhook cancels that subscription and refunds it. If the
-- refund fails in a way a retry might get past, it answers Stripe 500 and
-- releases the event claim, so the delivery comes again.
--
-- The retry does come -- and it never reaches the refund, because the CANCEL
-- succeeded. The redelivery re-reads the subscription from Stripe, which now
-- says `canceled`; `canceled` is not an entitling status, so the index has
-- nothing to refuse; so the row is written as an ordinary cancellation and the
-- event is acknowledged 200. The duplicate branch -- the only code that has ever
-- attempted a refund -- is never entered again. The customer keeps paying for a
-- plan they were charged twice for, and after the 200 nothing anywhere records
-- that a refund was owed. One ALERT line, three days old, in a log.
--
-- So the debt stops being a property of an EVENT and becomes a row. It is keyed
-- on the subscription, because that is the identifier that does not change: the
-- event id changes with every delivery, the subscription's status changes under
-- the retry, the ledger key does neither. stripeEvents.ts writes it before
-- either Stripe call is attempted and retries it from every later delivery about
-- that subscription, whatever that subscription's status has become
-- (finishPendingDuplicateUndo).
--
-- Both halves are safe to repeat, which is what makes retrying from an arbitrary
-- later delivery correct rather than merely hopeful: a subscription already ended
-- is recognised and left alone, and the refund carries an idempotency key per
-- invoice, so Stripe answers a repeat with the original refund instead of making
-- a second one (_shared/stripe.ts, cancelAndRefundDuplicate).
create table if not exists public.duplicate_refunds (
    stripe_subscription_id text not null,
    -- Mode-keyed like billing_customers, and read mode-filtered, for the reason
    -- the D4 note in stripe-webhook/index.ts gives: Stripe ids are globally
    -- unique, but that is a property of Stripe's id space rather than an
    -- invariant of this table, and every other billing lookup is filtered.
    mode text not null check (mode in ('live', 'test')),
    -- `set null` rather than `cascade`: an account being deleted does not make a
    -- refund we never issued stop being owed, and this row is the only record of
    -- it. The subscription id in it is still enough for a human to find the
    -- charge in Stripe.
    user_id uuid references auth.users (id) on delete set null,
    -- `pending` is the only one anything retries. `needs_human` is a paid
    -- invoice whose payment cannot be identified -- it reads the same way on
    -- every attempt, so retrying it would bury the alert instead of surfacing
    -- it. See DuplicateUndoState in _shared/stripeEvents.ts.
    state text not null check (state in ('pending', 'resolved', 'needs_human')),
    -- Whether the duplicate can still bill, and what came of the refund half:
    -- 'refunded' / 'nothing_to_refund' / 'needs_human' / 'failed', null before
    -- the first attempt has answered.
    stopped boolean not null default false,
    refund text,
    -- cancelAndRefundDuplicate's own notes, which is what a human reconciling
    -- this row reads.
    detail text,
    -- How many attempts have reported back (one per settle, so one per pair of
    -- Stripe calls). A row with a high count still `pending` is the shape of a
    -- refund no delivery will ever manage, which is the one a human has to take.
    attempts integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (stripe_subscription_id, mode)
);

-- What a reconciliation reads: everything still owed, oldest first.
create index if not exists duplicate_refunds_unsettled
    on public.duplicate_refunds (created_at)
    where state <> 'resolved';

-- Service role only, like every other billing table: the client never reads or
-- writes this. No policy, so RLS refuses every client role outright.
alter table public.duplicate_refunds enable row level security;

-- service_role bypasses RLS but still needs the table-level grant (see
-- 20260827140000_core_table_grants.sql).
grant all on table public.duplicate_refunds to service_role;

-- Open the debt. Called BEFORE the Stripe calls are attempted, so an isolate
-- that dies between them has still left the row.
--
-- An already `resolved` row is left resolved: the undo is idempotent, so
-- re-attempting it is harmless, but reopening a settled ledger entry would make
-- money we have handed back look outstanding. `attempts` is left alone too --
-- the attempt this call precedes is counted when it reports back, below.
create or replace function public.record_duplicate_refund (
    p_subscription_id text,
    p_mode text,
    p_user uuid
) returns void language plpgsql set search_path = public as $$
begin
    insert into public.duplicate_refunds as d (stripe_subscription_id, mode, user_id, state)
    values (p_subscription_id, p_mode, p_user, 'pending')
    on conflict (stripe_subscription_id, mode) do update
    set user_id = coalesce(excluded.user_id, d.user_id),
        state = case when d.state = 'resolved' then d.state else 'pending' end,
        updated_at = now();
end;
$$;

-- Close it, or record that this attempt did not. Scoped to nothing: whichever
-- delivery last spoke to Stripe holds the freshest answer, and all of them are
-- asking Stripe about the same subscription.
--
-- Every settle counts an attempt, including the ones that leave the row
-- `pending`, because that count is what distinguishes a refund Stripe refused
-- once from one it will refuse forever.
create or replace function public.settle_duplicate_refund (
    p_subscription_id text,
    p_mode text,
    p_state text,
    p_stopped boolean,
    p_refund text,
    p_detail text
) returns void language plpgsql set search_path = public as $$
begin
    update public.duplicate_refunds
    set state = p_state,
        stopped = p_stopped,
        refund = p_refund,
        detail = p_detail,
        attempts = attempts + 1,
        updated_at = now()
    where stripe_subscription_id = p_subscription_id and mode = p_mode;
end;
$$;

-- Is anything still owed on this subscription? Answers the row, so the caller's
-- alert can name the user the duplicate belonged to -- which the delivery doing
-- the retry has no other way of knowing, since it is usually an event about a
-- subscription that no longer looks like a duplicate at all.
create or replace function public.pending_duplicate_refund (p_subscription_id text, p_mode text)
returns table (user_id uuid, attempts integer) language sql stable set search_path = public as $$
select d.user_id, d.attempts
from public.duplicate_refunds d
where d.stripe_subscription_id = p_subscription_id and d.mode = p_mode and d.state = 'pending'
$$;

revoke all on function public.record_duplicate_refund (text, text, uuid) from public, anon, authenticated;
revoke all on function public.settle_duplicate_refund (text, text, text, boolean, text, text)
    from public, anon, authenticated;
revoke all on function public.pending_duplicate_refund (text, text) from public, anon, authenticated;

grant execute on function public.record_duplicate_refund (text, text, uuid) to service_role;
grant execute on function public.settle_duplicate_refund (text, text, text, boolean, text, text) to service_role;
grant execute on function public.pending_duplicate_refund (text, text) to service_role;

-- ===== supabase/migrations/20261014120000_library_documents_indexed_visibility.sql =====
-- The library's page query reads only the caller's scores.
--
-- library_documents() found the caller's visible scores with
--
--     d.owner_id = v_uid or exists (select 1 from document_members m ...)
--
-- An OR whose second arm is a subquery cannot be answered from an index, so
-- every call — the library's first paint (through library_bootstrap), every
-- "load more" page, every server-side search — was a sequential scan of the
-- whole documents table, every account's scores, filtered down to this one's.
-- Its cost grew with the size of the service, not with the size of the
-- caller's library: on a 40,000-score table, 875 pages read to return a
-- teacher's 653.
--
-- The visible set is now the union of two index lookups — the caller's own
-- scores (documents_owner_id_idx) and their memberships
-- (document_members_user) — fetched from documents by primary key. The set
-- is the same: owner, or (when their student access was not withdrawn, see
-- 20261010120302) any document_members row. Filters, cursor, order, limit and
-- payload are unchanged, as are the signature and grants.

create or replace function public.library_documents (
    p_sort text default 'recent',
    p_after_updated_at timestamptz default null,
    p_after_title text default null,
    p_after_id uuid default null,
    p_query text default null,
    p_tag_id uuid default null,
    p_favorites_only boolean default false,
    p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_uid uuid := (select auth.uid());
    v_sort text := coalesce(p_sort, 'recent');
    v_limit int := least(greatest(coalesce(p_limit, 100), 1), 200);
    v_query text := nullif(btrim(coalesce(p_query, '')), '');
    v_pattern text;
    v_rows jsonb;
    v_count int;
    -- Once per call, not per row: about the caller only.
    v_revoked boolean := public.student_access_revoked ();
begin
    if v_uid is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;
    if v_sort not in ('recent', 'title') then
        raise exception 'unknown library sort: %', v_sort using errcode = '22023';
    end if;
    -- A half cursor would compare against null and silently return nothing.
    if p_after_id is not null
       and ((v_sort = 'recent' and p_after_updated_at is null)
            or (v_sort = 'title' and p_after_title is null)) then
        raise exception 'library cursor is incomplete' using errcode = '22023';
    end if;

    if v_query is not null then
        -- Titles are short; a pasted paragraph is not a search worth running.
        -- Escape ilike's own wildcards so "50%" or "op_1" match literally.
        v_pattern := '%'
            || replace(replace(replace(left(v_query, 200), '\', '\\'), '%', '\%'), '_', '\_')
            || '%';
    end if;

    with visible as (
        select
            d.id,
            d.owner_id,
            d.title,
            d.storage_path,
            d.page_count,
            d.content_rev,
            d.thumb_rev,
            d.created_at,
            d.updated_at,
            d.archived_at
        from public.documents d
        -- The caller's own scores (documents_owner_id_idx) and memberships
        -- (document_members_user), collected first and then looked up by
        -- primary key. Written as `= any (array(...))` rather than a join so
        -- the planner cannot turn it back into a scan: on a join it hashed the
        -- candidates and still read every row of documents to apply a title
        -- search, 31 ms where this takes 2.
        where d.id = any (array(
                select o.id
                from public.documents o
                where o.owner_id = v_uid
                union
                select m.document_id
                from public.document_members m
                where m.user_id = v_uid
                  and not v_revoked
            ))
          and (v_pattern is null or d.title ilike v_pattern)
          and (
                p_tag_id is null
                or exists (
                    select 1
                    from public.document_tags dt
                    join public.library_tags t on t.id = dt.tag_id
                    where dt.document_id = d.id
                      and dt.tag_id = p_tag_id
                      and t.user_id = v_uid
                )
            )
          and (
                not coalesce(p_favorites_only, false)
                or exists (
                    select 1
                    from public.document_favorites f
                    where f.document_id = d.id
                      and f.user_id = v_uid
                )
            )
          and (
                p_after_id is null
                or (v_sort = 'recent' and (d.updated_at, d.id) < (p_after_updated_at, p_after_id))
                or (v_sort = 'title' and (lower(d.title), d.id) > (lower(p_after_title), p_after_id))
            )
    ),
    ordered as (
        select
            v.*,
            row_number() over (
                order by
                    case when v_sort = 'title' then lower(v.title) end asc,
                    case when v_sort = 'title' then v.id end asc,
                    case when v_sort = 'recent' then v.updated_at end desc,
                    case when v_sort = 'recent' then v.id end desc
            ) as rn
        from visible v
    ),
    page as (
        select * from ordered where rn <= v_limit + 1
    )
    select
        coalesce(
            (select jsonb_agg(to_jsonb(p) - 'rn' order by p.rn) from page p where p.rn <= v_limit),
            '[]'::jsonb
        ),
        (select count(*)::int from page)
    into v_rows, v_count;

    return jsonb_build_object(
        'documents', v_rows,
        'has_more', v_count > v_limit
    );
end;
$$;

revoke all on function public.library_documents (text, timestamptz, text, uuid, text, uuid, boolean, integer) from public;
revoke all on function public.library_documents (text, timestamptz, text, uuid, text, uuid, boolean, integer) from anon;
grant execute on function public.library_documents (text, timestamptz, text, uuid, text, uuid, boolean, integer) to authenticated;

-- ===== supabase/migrations/20261020150000_content_moderation.sql =====
-- Notice and action: reports about scores, takedowns, strikes and a notice log.
--
-- The Copyright and Content Policy (/copyright) promises: anyone, signed in or
-- not, can report a score (the content-report Edge Function writes it here and
-- emails an acknowledgment); a moderator reviews it and may restrict or remove
-- the score, which emails the uploader a statement of reasons and the reporter
-- the outcome (content-moderation); a copyright takedown is a strike against
-- the uploader; and every report, decision and notice is logged.
--
-- Every write goes through the service role, from those two functions. The
-- browser can only ask whether it is a moderator (is_content_moderator) and,
-- if it is, read the reports, takedowns and log a page at a time
-- (moderation_reports, moderation_takedowns, moderation_log). Moderators are granted by hand:
--
--     insert into public.content_moderators (user_id, note) values ('<uuid>', 'Max');
--
-- Two takedown actions, both reversible, neither deleting anything — a
-- counter-notice or complaint that succeeds must be able to put the score
-- back, and content reported as illegal may have to be preserved:
--
--   restrict  the score can no longer be shared: everyone but its owner loses
--             access (members and share links alike), and nobody new can join.
--   remove    nobody can open it, its owner included. The row, file and
--             markings stay, out of reach of every client.
--
-- Both are enforced in document_role(), which already gates every read and
-- write a client can make on a score — the documents and annotation policies,
-- the scores and thumbnails storage policies, joining either realtime topic —
-- in library_documents(), which lists memberships directly, and in
-- documents_select, whose owner clause would otherwise still hand an owner the
-- row of a removed score.
--
-- Realtime authorizes a channel when it is joined, not per message, so a
-- takedown also reaches viewers who already have the score open: the server
-- stops broadcasting the score's committed changes (doc-db:{id}) while it is
-- taken down, and tells each viewer who lost access to re-check it (see
-- "Realtime" below).

-- ---------------------------------------------------------------------------
-- Moderators
-- ---------------------------------------------------------------------------

create table if not exists public.content_moderators (
    user_id uuid primary key references auth.users (id) on delete cascade,
    added_at timestamptz not null default now(),
    note text check (note is null or char_length(note) <= 200)
);

alter table public.content_moderators enable row level security;
revoke all on table public.content_moderators from anon, authenticated;

create or replace function public.is_content_moderator () returns boolean language sql stable security definer
set search_path = public as $$
    select exists (
        select 1 from public.content_moderators m where m.user_id = (select auth.uid())
    );
$$;

revoke all on function public.is_content_moderator () from public;
revoke all on function public.is_content_moderator () from anon;
grant execute on function public.is_content_moderator () to authenticated;

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------

create table if not exists public.content_reports (
    id uuid primary key default gen_random_uuid(),
    -- What the acknowledgment email and the reporter quote back to us.
    reference text not null unique default ('CR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
    created_at timestamptz not null default now(),
    kind text not null check (kind in ('copyright', 'illegal')),
    category text not null check (
        category in (
            'copyright',
            'child_safety',
            'terrorism',
            'hate',
            'violence',
            'privacy',
            'fraud',
            'other'
        )
    ),
    content_url text not null check (char_length(content_url) between 1 and 2000),
    -- Resolved from content_url when it names a score or a live share link;
    -- null when it does not (the moderator then finds the score by hand).
    document_id uuid references public.documents (id) on delete set null,
    work_description text check (work_description is null or char_length(work_description) <= 4000),
    explanation text not null check (char_length(explanation) between 1 and 8000),
    reporter_name text not null check (char_length(reporter_name) between 1 and 200),
    reporter_email text not null check (char_length(reporter_email) between 3 and 254),
    reporter_address text check (reporter_address is null or char_length(reporter_address) <= 500),
    reporter_phone text check (reporter_phone is null or char_length(reporter_phone) <= 50),
    on_behalf_of text check (on_behalf_of is null or char_length(on_behalf_of) <= 200),
    -- Set when the reporter was signed in; never trusted from the request body.
    reporter_user_id uuid references auth.users (id) on delete set null,
    good_faith boolean not null check (good_faith),
    -- The DMCA statement "under penalty of perjury" — required for copyright.
    perjury_statement boolean not null default false,
    signature text not null check (char_length(signature) between 1 and 200),
    status text not null default 'received' check (status in ('received', 'actioned', 'rejected')),
    decided_at timestamptz,
    decided_by uuid references auth.users (id) on delete set null,
    decision_note text check (decision_note is null or char_length(decision_note) <= 4000),
    acknowledged_at timestamptz,
    check (kind <> 'copyright' or (category = 'copyright' and perjury_statement and work_description is not null)),
    check (kind <> 'illegal' or category <> 'copyright')
);

create index if not exists content_reports_created_idx on public.content_reports (created_at desc);
create index if not exists content_reports_document_idx on public.content_reports (document_id)
where document_id is not null;

alter table public.content_reports enable row level security;
revoke all on table public.content_reports from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Takedowns
-- ---------------------------------------------------------------------------

create table if not exists public.content_takedowns (
    id uuid primary key default gen_random_uuid(),
    -- Set null rather than cascaded: if the uploader deletes the score or their
    -- account, the record of what was taken down, and the strike, stay.
    document_id uuid references public.documents (id) on delete set null,
    report_id uuid references public.content_reports (id) on delete set null,
    uploader_id uuid references auth.users (id) on delete set null,
    document_title text,
    action text not null check (action in ('restrict', 'remove')),
    ground text not null check (ground in ('copyright', 'illegal', 'terms')),
    -- The statement of reasons: the law or term relied on, and the facts.
    legal_basis text not null check (char_length(legal_basis) between 1 and 1000),
    facts text not null check (char_length(facts) between 1 and 4000),
    created_at timestamptz not null default now(),
    created_by uuid references auth.users (id) on delete set null,
    lifted_at timestamptz,
    lifted_by uuid references auth.users (id) on delete set null,
    lift_reason text check (lift_reason is null or char_length(lift_reason) <= 4000)
);

-- One live takedown per score, and the lookup document_role() makes.
create unique index if not exists content_takedowns_active_document on public.content_takedowns (document_id)
where lifted_at is null;
create index if not exists content_takedowns_uploader_idx on public.content_takedowns (uploader_id);

alter table public.content_takedowns enable row level security;
revoke all on table public.content_takedowns from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Strikes (repeat-infringer policy)
-- ---------------------------------------------------------------------------

create table if not exists public.content_strikes (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    takedown_id uuid not null unique references public.content_takedowns (id) on delete cascade,
    created_at timestamptz not null default now(),
    voided_at timestamptz,
    void_reason text
);

create index if not exists content_strikes_user_idx on public.content_strikes (user_id, created_at desc);

alter table public.content_strikes enable row level security;
revoke all on table public.content_strikes from anon, authenticated;

-- Strikes that count: not withdrawn, and within the window the policy states
-- (STRIKE_WINDOW_MONTHS in src/features/moderation/moderationRules.ts).
create or replace function public.active_content_strikes (p_user uuid) returns integer language sql stable security definer
set search_path = public as $$
    select count(*)::int
    from public.content_strikes s
    where s.user_id = p_user
      and s.voided_at is null
      and s.created_at > now() - interval '12 months';
$$;

revoke all on function public.active_content_strikes (uuid) from public;
revoke all on function public.active_content_strikes (uuid) from anon;
revoke all on function public.active_content_strikes (uuid) from authenticated;
grant execute on function public.active_content_strikes (uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Notice log
-- ---------------------------------------------------------------------------

create table if not exists public.content_notice_log (
    id bigint generated by default as identity primary key,
    created_at timestamptz not null default now(),
    report_id uuid references public.content_reports (id) on delete set null,
    takedown_id uuid references public.content_takedowns (id) on delete set null,
    event text not null check (
        event in (
            'report_received',
            'report_acknowledged',
            'report_rejected',
            'reporter_notified',
            'takedown',
            'statement_of_reasons',
            'takedown_lifted',
            'uploader_notified_lift'
        )
    ),
    -- The address mailed, for an email event.
    recipient text,
    -- queued: put in content_notice_outbox; each attempt then logs how it went.
    -- skipped: there was no address to send to.
    delivery text check (delivery is null or delivery in ('queued', 'sent', 'failed', 'unconfigured', 'skipped')),
    actor_id uuid references auth.users (id) on delete set null,
    detail jsonb not null default '{}'::jsonb
);

create index if not exists content_notice_log_created_idx on public.content_notice_log (created_at desc);

alter table public.content_notice_log enable row level security;
revoke all on table public.content_notice_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Outbox: every notice we owe, kept until it is sent
-- ---------------------------------------------------------------------------
-- The acknowledgment (blind-copied to the legal mailbox), the statement of
-- reasons, the reporter's outcome and the lift notice are promises the
-- policy makes, and a mail budget or a Resend outage must delay them, never
-- lose them. So each is written here IN THE SAME TRANSACTION as the report or
-- decision it is about (the trigger and the three actions below), and the
-- content-report, content-moderation and content-notices functions deliver
-- them: claim due rows (a lease, so two deliverers never send one twice),
-- take a unit of the sender's mail budget, send with the row id as Resend's
-- idempotency key, and finish the row. Out of budget: back in the queue until
-- the budget's window reopens, not counted as an attempt. A failed or
-- unconfigured send: retried with backoff (1 minute doubling, at most 6
-- hours), indefinitely; the moderation page shows how many are waiting. A
-- crash mid-send: the lease runs out and the row is claimed again, and the
-- idempotency key stops Resend sending it twice.
--
-- What it sends is rendered at delivery from `payload` by contentReports.ts
-- (renderNotice), from the facts recorded here: the decision's wording, not
-- whatever the rows say later. The recipient is resolved now: the reporter's
-- address, or the uploader's sign-in address from auth.users.

create table if not exists public.content_notice_outbox (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    -- Whose mail budget it spends (MAIL_CATEGORY_CAPS in _shared/mailBudget.ts).
    sender text not null check (sender in ('content-report-ack', 'moderation-notice')),
    template text not null check (
        template in ('report_acknowledgment', 'statement_of_reasons', 'reporter_outcome', 'takedown_lifted')
    ),
    -- The content_notice_log event each attempt is logged as.
    event text not null check (
        event in ('report_acknowledged', 'statement_of_reasons', 'reporter_notified', 'uploader_notified_lift')
    ),
    report_id uuid references public.content_reports (id) on delete set null,
    takedown_id uuid references public.content_takedowns (id) on delete set null,
    actor_id uuid references auth.users (id) on delete set null,
    recipient text not null check (char_length(recipient) between 3 and 320),
    -- Blind-copy the legal mailbox (the acknowledgment: how a person hears of a report).
    bcc_legal boolean not null default false,
    payload jsonb not null,
    status text not null default 'pending' check (status in ('pending', 'sent')),
    attempts int not null default 0,
    next_attempt_at timestamptz not null default now(),
    claimed_until timestamptz,
    last_outcome text check (last_outcome is null or last_outcome in ('failed', 'unconfigured', 'deferred')),
    sent_at timestamptz
);

create index if not exists content_notice_outbox_due_idx on public.content_notice_outbox (next_attempt_at)
where status = 'pending';

alter table public.content_notice_outbox enable row level security;
revoke all on table public.content_notice_outbox from anon, authenticated;

-- Queue one notice and log it as queued. A recipient-less notice (an uploader
-- with no sign-in address: a guest, a roster student) is logged as skipped,
-- so the moderator sees it needs following up by hand. Internal.
create or replace function public.enqueue_content_notice (
    p_sender text,
    p_template text,
    p_event text,
    p_recipient text,
    p_bcc_legal boolean,
    p_payload jsonb,
    p_report uuid,
    p_takedown uuid,
    p_actor uuid
) returns uuid language plpgsql security definer
set search_path = public as $$
declare
    v_id uuid;
begin
    if nullif(btrim(coalesce(p_recipient, '')), '') is null then
        insert into public.content_notice_log (report_id, takedown_id, event, recipient, delivery, actor_id)
        values (p_report, p_takedown, p_event, null, 'skipped', p_actor);
        return null;
    end if;
    insert into public.content_notice_outbox (
        sender, template, event, report_id, takedown_id, actor_id, recipient, bcc_legal, payload
    ) values (
        p_sender, p_template, p_event, p_report, p_takedown, p_actor, p_recipient, p_bcc_legal, p_payload
    ) returning id into v_id;
    insert into public.content_notice_log (report_id, takedown_id, event, recipient, delivery, actor_id, detail)
    values (p_report, p_takedown, p_event, p_recipient, 'queued', p_actor, jsonb_build_object('notice_id', v_id));
    return v_id;
end;
$$;

revoke all on function public.enqueue_content_notice (text, text, text, text, boolean, jsonb, uuid, uuid, uuid) from public;
revoke all on function public.enqueue_content_notice (text, text, text, text, boolean, jsonb, uuid, uuid, uuid) from anon;
revoke all on function public.enqueue_content_notice (text, text, text, text, boolean, jsonb, uuid, uuid, uuid) from authenticated;

-- The decision time as the emails print it (UTC, ISO 8601).
create or replace function public.content_notice_time (p_at timestamptz) returns text language sql immutable
set search_path = public as $$
    select to_char(p_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

-- The report is logged and its acknowledgment queued by the insert itself, so
-- a stored report always has one owed, whatever happens to the request after.
create or replace function public.content_report_enqueue_ack () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    insert into public.content_notice_log (report_id, event, actor_id, detail)
    values (new.id, 'report_received', new.reporter_user_id,
            jsonb_build_object('kind', new.kind, 'category', new.category, 'resolved', new.document_id is not null));
    perform public.enqueue_content_notice (
        'content-report-ack',
        'report_acknowledgment',
        'report_acknowledged',
        new.reporter_email,
        true,
        jsonb_build_object(
            'reference', new.reference,
            'reporterName', new.reporter_name,
            'category', new.category,
            'contentUrl', new.content_url,
            'workDescription', new.work_description,
            'onBehalfOf', new.on_behalf_of,
            'explanation', new.explanation
        ),
        new.id,
        null,
        new.reporter_user_id
    );
    return null;
end;
$$;

revoke all on function public.content_report_enqueue_ack () from public;
revoke all on function public.content_report_enqueue_ack () from anon;
revoke all on function public.content_report_enqueue_ack () from authenticated;

drop trigger if exists content_reports_enqueue_ack on public.content_reports;
create trigger content_reports_enqueue_ack
after insert on public.content_reports
for each row execute function public.content_report_enqueue_ack ();

-- Delivery (service role only). Claim: the due rows, the caller's own first
-- (`p_first`, the notices its request just queued), each leased for
-- p_lease_seconds and counted as an attempt.
create or replace function public.claim_content_notices (
    p_limit integer default 10,
    p_first uuid[] default '{}',
    p_lease_seconds integer default 120
) returns setof public.content_notice_outbox language plpgsql security definer
set search_path = public as $$
begin
    return query
    update public.content_notice_outbox o
    set claimed_until = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 30)),
        attempts = o.attempts + 1
    where o.id in (
        select c.id
        from public.content_notice_outbox c
        where c.status = 'pending'
          and (c.next_attempt_at <= now() or c.id = any (coalesce(p_first, '{}')))
          and (c.claimed_until is null or c.claimed_until < now())
        order by (c.id = any (coalesce(p_first, '{}'))) desc, c.next_attempt_at, c.created_at
        limit least(greatest(coalesce(p_limit, 10), 1), 50)
        for update skip locked
    )
    returning o.*;
end;
$$;

-- Finish a claimed row: sent; failed or unconfigured (retry with backoff,
-- logged); or deferred because the sender's budget is spent (retry when
-- p_retry_after_seconds says the window reopens; not an attempt, not logged:
-- the row's queued entry already says it is owed).
create or replace function public.finish_content_notice (
    p_id uuid,
    p_outcome text,
    p_retry_after_seconds integer default null
) returns void language plpgsql security definer
set search_path = public as $$
declare
    v_row public.content_notice_outbox;
begin
    if p_outcome not in ('sent', 'failed', 'unconfigured', 'deferred') then
        raise exception 'unknown outcome: %', p_outcome using errcode = '22023';
    end if;
    select * into v_row from public.content_notice_outbox where id = p_id and status = 'pending' for update;
    if not found then
        return;
    end if;

    if p_outcome = 'sent' then
        update public.content_notice_outbox
        set status = 'sent', sent_at = now(), claimed_until = null, last_outcome = null
        where id = p_id;
        if v_row.template = 'report_acknowledgment' and v_row.report_id is not null then
            update public.content_reports set acknowledged_at = coalesce(acknowledged_at, now())
            where id = v_row.report_id;
        end if;
    elsif p_outcome = 'deferred' then
        update public.content_notice_outbox
        set claimed_until = null,
            attempts = greatest(attempts - 1, 0),
            last_outcome = 'deferred',
            next_attempt_at = now() + make_interval(secs => greatest(coalesce(p_retry_after_seconds, 60), 1))
        where id = p_id;
        return;
    else
        update public.content_notice_outbox
        set claimed_until = null,
            last_outcome = p_outcome,
            next_attempt_at = now() + coalesce(
                make_interval(secs => p_retry_after_seconds),
                least(interval '6 hours', interval '1 minute' * power(2, least(greatest(attempts - 1, 0), 20)))
            )
        where id = p_id;
    end if;

    insert into public.content_notice_log (report_id, takedown_id, event, recipient, delivery, actor_id, detail)
    values (v_row.report_id, v_row.takedown_id, v_row.event, v_row.recipient, p_outcome, v_row.actor_id,
            jsonb_build_object('notice_id', p_id, 'attempt', v_row.attempts));
end;
$$;

revoke all on function public.claim_content_notices (integer, uuid[], integer) from public;
revoke all on function public.claim_content_notices (integer, uuid[], integer) from anon;
revoke all on function public.claim_content_notices (integer, uuid[], integer) from authenticated;
grant execute on function public.claim_content_notices (integer, uuid[], integer) to service_role;

revoke all on function public.finish_content_notice (uuid, text, integer) from public;
revoke all on function public.finish_content_notice (uuid, text, integer) from anon;
revoke all on function public.finish_content_notice (uuid, text, integer) from authenticated;
grant execute on function public.finish_content_notice (uuid, text, integer) to service_role;

-- The retry when nobody is using either function: every five minutes, if
-- anything is due, pg_cron pokes content-notices (pg_net + vault, the
-- omr_sweep pattern). Vault secrets content_notice_url (the function's URL)
-- and content_notice_secret (= the function's CONTENT_NOTICE_SECRET) are
-- created out of band (DEPLOY.md); without them the tick is a no-op, and
-- notices still go out with the next report or moderator action.
create or replace function public.content_notice_retry_tick () returns void language plpgsql security definer
set search_path = public, extensions, vault as $$
declare
    v_url text;
    v_secret text;
begin
    if not exists (
        select 1 from public.content_notice_outbox
        where status = 'pending' and next_attempt_at <= now()
          and (claimed_until is null or claimed_until < now())
    ) then
        return;
    end if;
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'content_notice_url' limit 1;
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'content_notice_secret' limit 1;
    if v_url is null or v_secret is null or length(trim(v_url)) = 0 then
        raise notice 'content_notice_retry_tick: vault secrets content_notice_url/content_notice_secret missing — skip';
        return;
    end if;
    perform net.http_post(
        url := v_url,
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-content-notice-secret', v_secret),
        body := '{}'::jsonb,
        timeout_milliseconds := 10000
    );
end;
$$;

revoke all on function public.content_notice_retry_tick () from public, anon, authenticated;
grant execute on function public.content_notice_retry_tick () to service_role;

do $$
begin
    perform cron.unschedule (jobid) from cron.job where jobname = 'content-notice-retry';
exception
    when undefined_table then null;
    when others then null;
end;
$$;

select cron.schedule ('content-notice-retry', '*/5 * * * *', $$select public.content_notice_retry_tick ()$$);

-- ---------------------------------------------------------------------------
-- Actions (service role only: content-moderation calls them after checking
-- the caller is a moderator, then sends the emails and logs them)
-- ---------------------------------------------------------------------------

create or replace function public.apply_content_takedown (
    p_document uuid,
    p_action text,
    p_ground text,
    p_legal_basis text,
    p_facts text,
    p_report uuid,
    p_moderator uuid
) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_doc record;
    v_takedown uuid;
    v_strikes int := null;
    v_report record;
    v_uploader_notice uuid;
    v_reporter_notice uuid;
begin
    select d.id, d.owner_id, d.title into v_doc from public.documents d where d.id = p_document for update;
    if not found then
        raise exception 'score not found' using errcode = 'P0002', detail = '{"code":"document_not_found"}';
    end if;
    if exists (select 1 from public.content_takedowns t where t.document_id = p_document and t.lifted_at is null) then
        raise exception 'score already taken down' using errcode = '23505', detail = '{"code":"already_taken_down"}';
    end if;
    if p_report is not null and not exists (select 1 from public.content_reports r where r.id = p_report) then
        raise exception 'report not found' using errcode = 'P0002', detail = '{"code":"report_not_found"}';
    end if;

    insert into public.content_takedowns (
        document_id, report_id, uploader_id, document_title, action, ground, legal_basis, facts, created_by
    ) values (
        p_document, p_report, v_doc.owner_id, v_doc.title, p_action, p_ground, p_legal_basis, p_facts, p_moderator
    ) returning id into v_takedown;

    -- Repeat-infringer policy: copyright takedowns count against the uploader.
    if p_ground = 'copyright' and v_doc.owner_id is not null then
        insert into public.content_strikes (user_id, takedown_id) values (v_doc.owner_id, v_takedown);
    end if;
    if v_doc.owner_id is not null then
        v_strikes := public.active_content_strikes (v_doc.owner_id);
    end if;

    if p_report is not null then
        update public.content_reports
        set status = 'actioned', decided_at = now(), decided_by = p_moderator,
            document_id = coalesce(document_id, p_document)
        where id = p_report;
    end if;

    insert into public.content_notice_log (report_id, takedown_id, event, actor_id, detail)
    values (p_report, v_takedown, 'takedown', p_moderator,
            jsonb_build_object('document_id', p_document, 'action', p_action, 'ground', p_ground));

    -- Viewers who already have the score open: re-check, and lose it.
    perform public.content_takedown_notify_viewers (p_document, p_action);

    -- The statement of reasons to the uploader, and the outcome to the
    -- reporter, owed from this commit on (see "Outbox").
    v_uploader_notice := public.enqueue_content_notice (
        'moderation-notice', 'statement_of_reasons', 'statement_of_reasons',
        (select u.email from auth.users u where u.id = v_doc.owner_id),
        false,
        jsonb_build_object(
            'documentTitle', v_doc.title,
            'action', p_action,
            'ground', p_ground,
            'legalBasis', p_legal_basis,
            'facts', p_facts,
            'fromReport', p_report is not null,
            'activeStrikes', v_strikes,
            'decidedAt', public.content_notice_time (now())
        ),
        p_report, v_takedown, p_moderator
    );
    if p_report is not null then
        select r.reference, r.reporter_name, r.reporter_email into v_report
        from public.content_reports r where r.id = p_report;
        v_reporter_notice := public.enqueue_content_notice (
            'moderation-notice', 'reporter_outcome', 'reporter_notified',
            v_report.reporter_email,
            false,
            jsonb_build_object(
                'reference', v_report.reference,
                'reporterName', v_report.reporter_name,
                'decision', 'actioned',
                'action', p_action
            ),
            p_report, v_takedown, p_moderator
        );
    end if;

    return jsonb_build_object(
        'takedown_id', v_takedown,
        'uploader_id', v_doc.owner_id,
        'document_title', v_doc.title,
        'active_strikes', v_strikes,
        'uploader_notice_id', v_uploader_notice,
        'reporter_notice_id', v_reporter_notice
    );
end;
$$;

create or replace function public.lift_content_takedown (p_takedown uuid, p_reason text, p_moderator uuid) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_row record;
    v_uploader_notice uuid;
begin
    update public.content_takedowns
    set lifted_at = now(), lifted_by = p_moderator, lift_reason = p_reason
    where id = p_takedown and lifted_at is null
    returning id, document_id, uploader_id, document_title, report_id into v_row;
    if not found then
        raise exception 'no live takedown' using errcode = 'P0002', detail = '{"code":"takedown_not_found"}';
    end if;

    -- The policy: a strike is withdrawn when a counter-notice or complaint succeeds.
    update public.content_strikes
    set voided_at = now(), void_reason = p_reason
    where takedown_id = p_takedown and voided_at is null;

    insert into public.content_notice_log (report_id, takedown_id, event, actor_id, detail)
    values (v_row.report_id, p_takedown, 'takedown_lifted', p_moderator, jsonb_build_object('reason', p_reason));

    v_uploader_notice := public.enqueue_content_notice (
        'moderation-notice', 'takedown_lifted', 'uploader_notified_lift',
        (select u.email from auth.users u where u.id = v_row.uploader_id),
        false,
        jsonb_build_object('documentTitle', v_row.document_title, 'reason', p_reason),
        null, p_takedown, p_moderator
    );

    return jsonb_build_object(
        'takedown_id', v_row.id,
        'document_id', v_row.document_id,
        'uploader_id', v_row.uploader_id,
        'document_title', v_row.document_title,
        'report_id', v_row.report_id,
        'uploader_notice_id', v_uploader_notice
    );
end;
$$;

create or replace function public.reject_content_report (p_report uuid, p_note text, p_moderator uuid) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_row record;
begin
    update public.content_reports
    set status = 'rejected', decided_at = now(), decided_by = p_moderator, decision_note = p_note
    where id = p_report and status = 'received'
    returning id, reference, reporter_email, reporter_name, content_url into v_row;
    if not found then
        raise exception 'no open report' using errcode = 'P0002', detail = '{"code":"report_not_open"}';
    end if;

    insert into public.content_notice_log (report_id, event, actor_id, detail)
    values (p_report, 'report_rejected', p_moderator, jsonb_build_object('note', p_note));

    return to_jsonb(v_row) || jsonb_build_object(
        'reporter_notice_id',
        public.enqueue_content_notice (
            'moderation-notice', 'reporter_outcome', 'reporter_notified',
            v_row.reporter_email,
            false,
            jsonb_build_object(
                'reference', v_row.reference,
                'reporterName', v_row.reporter_name,
                'decision', 'rejected',
                'note', p_note
            ),
            p_report, null, p_moderator
        )
    );
end;
$$;

revoke all on function public.apply_content_takedown (uuid, text, text, text, text, uuid, uuid) from public;
revoke all on function public.apply_content_takedown (uuid, text, text, text, text, uuid, uuid) from anon;
revoke all on function public.apply_content_takedown (uuid, text, text, text, text, uuid, uuid) from authenticated;
grant execute on function public.apply_content_takedown (uuid, text, text, text, text, uuid, uuid) to service_role;

revoke all on function public.lift_content_takedown (uuid, text, uuid) from public;
revoke all on function public.lift_content_takedown (uuid, text, uuid) from anon;
revoke all on function public.lift_content_takedown (uuid, text, uuid) from authenticated;
grant execute on function public.lift_content_takedown (uuid, text, uuid) to service_role;

revoke all on function public.reject_content_report (uuid, text, uuid) from public;
revoke all on function public.reject_content_report (uuid, text, uuid) from anon;
revoke all on function public.reject_content_report (uuid, text, uuid) from authenticated;
grant execute on function public.reject_content_report (uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The moderator's read: reports, takedowns (with each uploader's strike
-- count) and the notice log, each a page at a time. Refuses everyone else.
-- ---------------------------------------------------------------------------
-- Keyset pagination, never a fixed cap: a list that stopped at its newest 200
-- rows would let an older open report, or an older live takedown and its lift
-- control, drop out of reach as newer ones arrive. Each call answers
-- {rows, total, next}: `next` is the cursor for the following page (null on
-- the last) and `total` counts the whole filtered set, so the page can say how
-- many are waiting. The filters are the ones a moderator works from: open
-- reports (oldest first, the queue order) or decided ones, live takedowns or
-- lifted ones.

-- An earlier draft of this migration had one capped moderation_queue(); no
-- client calls it any more.
drop function if exists public.moderation_queue ();

create index if not exists content_reports_status_created_idx on public.content_reports (status, created_at, id);
create index if not exists content_takedowns_created_idx on public.content_takedowns (created_at desc, id desc);

create or replace function public.moderation_reports (
    p_status text default 'open',
    p_after_created_at timestamptz default null,
    p_after_id uuid default null,
    p_limit integer default 25
) returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare
    v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100);
    v_open boolean;
    v_rows jsonb;
    v_count int;
    v_total int;
begin
    if not public.is_content_moderator () then
        raise exception 'not a moderator' using errcode = '42501';
    end if;
    if p_status not in ('open', 'decided', 'all') then
        raise exception 'unknown report filter: %', p_status using errcode = '22023';
    end if;
    if (p_after_created_at is null) <> (p_after_id is null) then
        raise exception 'report cursor is incomplete' using errcode = '22023';
    end if;
    -- Open reports read oldest first, so the one waiting longest is on top;
    -- the rest newest first.
    v_open := p_status = 'open';

    with filtered as (
        select cr.*
        from public.content_reports cr
        where (p_status = 'all'
               or (p_status = 'open' and cr.status = 'received')
               or (p_status = 'decided' and cr.status <> 'received'))
    ),
    page as (
        select f.*,
               row_number() over (
                   order by
                       case when v_open then f.created_at end asc,
                       case when v_open then f.id end asc,
                       case when not v_open then f.created_at end desc,
                       case when not v_open then f.id end desc
               ) as rn
        from filtered f
        where p_after_id is null
           or (v_open and (f.created_at, f.id) > (p_after_created_at, p_after_id))
           or (not v_open and (f.created_at, f.id) < (p_after_created_at, p_after_id))
    ),
    limited as (
        select * from page where rn <= v_limit + 1
    )
    select
        coalesce((
            select jsonb_agg(
                jsonb_build_object(
                    'id', l.id,
                    'reference', l.reference,
                    'created_at', l.created_at,
                    'kind', l.kind,
                    'category', l.category,
                    'content_url', l.content_url,
                    'document_id', l.document_id,
                    'document_title', (select d.title from public.documents d where d.id = l.document_id),
                    'work_description', l.work_description,
                    'explanation', l.explanation,
                    'reporter_name', l.reporter_name,
                    'reporter_email', l.reporter_email,
                    -- The complete notice as submitted, attestations included.
                    'reporter_address', l.reporter_address,
                    'reporter_phone', l.reporter_phone,
                    'on_behalf_of', l.on_behalf_of,
                    'reporter_user_id', l.reporter_user_id,
                    'good_faith', l.good_faith,
                    'perjury_statement', l.perjury_statement,
                    'signature', l.signature,
                    'status', l.status,
                    'decided_at', l.decided_at,
                    'decision_note', l.decision_note,
                    'acknowledged_at', l.acknowledged_at,
                    'active_takedown_id', (
                        select t.id from public.content_takedowns t
                        where t.document_id = l.document_id and t.lifted_at is null
                    )
                )
                order by l.rn
            )
            from limited l
            where l.rn <= v_limit
        ), '[]'::jsonb),
        (select count(*)::int from limited)
    into v_rows, v_count;

    select count(*)::int into v_total
    from public.content_reports cr
    where (p_status = 'all'
           or (p_status = 'open' and cr.status = 'received')
           or (p_status = 'decided' and cr.status <> 'received'));

    -- The cursor is the last row served; there is none after the last page.
    return jsonb_build_object(
        'rows', v_rows,
        'total', v_total,
        'next', case when v_count > v_limit
                     then jsonb_build_object('created_at', v_rows -> (v_limit - 1) -> 'created_at',
                                             'id', v_rows -> (v_limit - 1) -> 'id')
                end
    );
end;
$$;

create or replace function public.moderation_takedowns (
    p_state text default 'active',
    p_after_created_at timestamptz default null,
    p_after_id uuid default null,
    p_limit integer default 25
) returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare
    v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100);
    v_rows jsonb;
    v_count int;
    v_total int;
begin
    if not public.is_content_moderator () then
        raise exception 'not a moderator' using errcode = '42501';
    end if;
    if p_state not in ('active', 'lifted', 'all') then
        raise exception 'unknown takedown filter: %', p_state using errcode = '22023';
    end if;
    if (p_after_created_at is null) <> (p_after_id is null) then
        raise exception 'takedown cursor is incomplete' using errcode = '22023';
    end if;

    with limited as (
        select ct.*, row_number() over (order by ct.created_at desc, ct.id desc) as rn
        from public.content_takedowns ct
        where (p_state = 'all'
               or (p_state = 'active' and ct.lifted_at is null)
               or (p_state = 'lifted' and ct.lifted_at is not null))
          and (p_after_id is null or (ct.created_at, ct.id) < (p_after_created_at, p_after_id))
        order by ct.created_at desc, ct.id desc
        limit v_limit + 1
    )
    select
        coalesce((
            select jsonb_agg(
                jsonb_build_object(
                    'id', l.id,
                    'document_id', l.document_id,
                    'document_title', l.document_title,
                    'report_id', l.report_id,
                    'uploader_id', l.uploader_id,
                    'action', l.action,
                    'ground', l.ground,
                    'legal_basis', l.legal_basis,
                    'facts', l.facts,
                    'created_at', l.created_at,
                    'lifted_at', l.lifted_at,
                    'lift_reason', l.lift_reason,
                    'uploader_active_strikes', case when l.uploader_id is null then 0
                                                    else public.active_content_strikes (l.uploader_id) end
                )
                order by l.rn
            )
            from limited l
            where l.rn <= v_limit
        ), '[]'::jsonb),
        (select count(*)::int from limited)
    into v_rows, v_count;

    select count(*)::int into v_total
    from public.content_takedowns ct
    where (p_state = 'all'
           or (p_state = 'active' and ct.lifted_at is null)
           or (p_state = 'lifted' and ct.lifted_at is not null));

    -- The cursor is the last row served; there is none after the last page.
    return jsonb_build_object(
        'rows', v_rows,
        'total', v_total,
        'next', case when v_count > v_limit
                     then jsonb_build_object('created_at', v_rows -> (v_limit - 1) -> 'created_at',
                                             'id', v_rows -> (v_limit - 1) -> 'id')
                end
    );
end;
$$;

-- The log, newest first. Its identity id grows with every insert, so it is
-- the whole cursor.
create or replace function public.moderation_log (p_before_id bigint default null, p_limit integer default 50) returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare
    v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
    v_rows jsonb;
    v_count int;
begin
    if not public.is_content_moderator () then
        raise exception 'not a moderator' using errcode = '42501';
    end if;

    with limited as (
        select nl.id, nl.created_at, nl.report_id, nl.takedown_id, nl.event, nl.recipient, nl.delivery,
               row_number() over (order by nl.id desc) as rn
        from public.content_notice_log nl
        where p_before_id is null or nl.id < p_before_id
        order by nl.id desc
        limit v_limit + 1
    )
    select
        coalesce((
            select jsonb_agg(to_jsonb(l) - 'rn' order by l.rn) from limited l where l.rn <= v_limit
        ), '[]'::jsonb),
        (select count(*)::int from limited)
    into v_rows, v_count;

    return jsonb_build_object(
        'rows', v_rows,
        'next', case when v_count > v_limit
                     then jsonb_build_object('id', (v_rows -> (v_limit - 1) ->> 'id')::bigint)
                end,
        -- Notices still owed (content_notice_outbox), and how many of those
        -- last failed or found mail unconfigured rather than waiting on budget.
        'undelivered', (select count(*)::int from public.content_notice_outbox where status = 'pending'),
        'failing', (
            select count(*)::int from public.content_notice_outbox
            where status = 'pending' and last_outcome in ('failed', 'unconfigured')
        )
    );
end;
$$;

revoke all on function public.moderation_reports (text, timestamptz, uuid, integer) from public;
revoke all on function public.moderation_reports (text, timestamptz, uuid, integer) from anon;
grant execute on function public.moderation_reports (text, timestamptz, uuid, integer) to authenticated;

revoke all on function public.moderation_takedowns (text, timestamptz, uuid, integer) from public;
revoke all on function public.moderation_takedowns (text, timestamptz, uuid, integer) from anon;
grant execute on function public.moderation_takedowns (text, timestamptz, uuid, integer) to authenticated;

revoke all on function public.moderation_log (bigint, integer) from public;
revoke all on function public.moderation_log (bigint, integer) from anon;
grant execute on function public.moderation_log (bigint, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Enforcement
-- ---------------------------------------------------------------------------

-- 20261010120300's definition plus the takedown clause: a restricted score
-- answers its owner only; a removed one answers nobody.
create or replace function public.document_role (doc uuid) returns text language sql stable security definer
set search_path = public as $$
    select dm.role
    from public.document_members dm
    where dm.document_id = doc
      and dm.user_id = (select auth.uid())
      and not exists (
          select 1
          from public.managed_students ms
          where ms.student_user_id = dm.user_id
            and public.student_access_revoked ()
      )
      and not exists (
          select 1
          from public.content_takedowns ct
          where ct.document_id = doc
            and ct.lifted_at is null
            and (ct.action = 'remove' or dm.role <> 'owner')
      );
$$;

-- Nobody new joins a taken-down score — not through a share link
-- (redeem_share_link), a roster assignment, or anything else that adds a
-- member — so lifting the takedown restores exactly the access it suspended.
create or replace function public.refuse_members_on_taken_down () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if new.role <> 'owner' and exists (
        select 1 from public.content_takedowns ct
        where ct.document_id = new.document_id and ct.lifted_at is null
    ) then
        raise exception 'this score is unavailable' using errcode = '42501', detail = '{"code":"content_unavailable"}';
    end if;
    return new;
end;
$$;

revoke all on function public.refuse_members_on_taken_down () from public;
revoke all on function public.refuse_members_on_taken_down () from anon;
revoke all on function public.refuse_members_on_taken_down () from authenticated;

drop trigger if exists document_members_refuse_taken_down on public.document_members;
create trigger document_members_refuse_taken_down
before insert on public.document_members
for each row execute function public.refuse_members_on_taken_down ();

create or replace function public.refuse_share_links_on_taken_down () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if exists (
        select 1 from public.content_takedowns ct
        where ct.document_id = new.document_id and ct.lifted_at is null
    ) then
        raise exception 'this score cannot be shared' using errcode = '42501', detail = '{"code":"content_unavailable"}';
    end if;
    return new;
end;
$$;

revoke all on function public.refuse_share_links_on_taken_down () from public;
revoke all on function public.refuse_share_links_on_taken_down () from anon;
revoke all on function public.refuse_share_links_on_taken_down () from authenticated;

drop trigger if exists share_links_refuse_taken_down on public.share_links;
create trigger share_links_refuse_taken_down
before insert on public.share_links
for each row execute function public.refuse_share_links_on_taken_down ();

-- ---------------------------------------------------------------------------
-- Realtime: cutting off viewers who are already connected
-- ---------------------------------------------------------------------------
-- document_role() refuses a taken-down score when a channel JOINS, but a
-- collaborator who joined before the takedown keeps the channel: Realtime does
-- not re-run the realtime.messages policies per message. Two things close it:
--
--  1. The server stops sending the score's committed changes. Every
--     server-authored event on doc-db:{id} (committed marks, the PDF being
--     replaced, play-along status) comes from the three trigger functions
--     below, which now send nothing while the score has a live takedown. A
--     client that ignores everything we tell it still receives nothing more
--     on doc-db:{id}. For a restricted score this pauses its owner's live
--     sync between their own devices too (each still syncs by pulling, on
--     reconnect and when it comes online); nobody else can be sent its
--     changes, and a broadcast cannot pick out one recipient.
--  2. Every viewer who lost access is sent the `membership` hint on
--     doc:{id}, with role null, the way end_student_sessions does it. The
--     app re-reads the score and its role over PostgREST, which IS checked
--     per request, finds neither, closes the score and leaves both channels.
--     It is only a hint: the client never trusts the payload.
--
-- What stays open is doc:{id} itself for a client that ignores the hint: live
-- ink and presence, which clients send to each other (the server cannot drop
-- one recipient's copy). It carries in-progress strokes, never the score or
-- its committed markings, and only while the owner is drawing; Realtime
-- re-runs the policies when the client refreshes its access token and closes
-- the channel when that token expires (auth.jwt_expiry, an hour), so a
-- refused re-check ends it there. tests/sql/content_moderation.sql proves the
-- rest: no doc-db:{id} message while taken down, the hint to each member who
-- lost access, a refused re-join on both topics, and broadcasts back on lift.

-- Whether a score has a live takedown. Internal: the triggers below and the
-- notification call it as their owner; no client can ask it about a score.
create or replace function public.content_taken_down (doc uuid) returns boolean language sql stable security definer
set search_path = public as $$
    select exists (
        select 1 from public.content_takedowns ct
        where ct.document_id = doc and ct.lifted_at is null
    );
$$;

revoke all on function public.content_taken_down (uuid) from public;
revoke all on function public.content_taken_down (uuid) from anon;
revoke all on function public.content_taken_down (uuid) from authenticated;

-- The membership hint to every member a takedown shuts out: everyone but the
-- owner for restrict, everyone for remove.
create or replace function public.content_takedown_notify_viewers (p_document uuid, p_action text) returns void language plpgsql security definer
set search_path = public as $$
declare
    v_user uuid;
begin
    for v_user in
        select dm.user_id
        from public.document_members dm
        where dm.document_id = p_document
          and (p_action = 'remove' or dm.role <> 'owner')
    loop
        perform realtime.send(
            jsonb_build_object(
                'table', 'document_members',
                'document_id', p_document,
                'user_id', v_user,
                'role', null
            ),
            'membership', -- event
            'doc:' || p_document::text, -- topic
            true -- private
        );
    end loop;
end;
$$;

revoke all on function public.content_takedown_notify_viewers (uuid, text) from public;
revoke all on function public.content_takedown_notify_viewers (uuid, text) from anon;
revoke all on function public.content_takedown_notify_viewers (uuid, text) from authenticated;

-- 20261007120101's three fan-out functions, unchanged but for the takedown check.
create or replace function public.broadcast_annotation_changes () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if public.content_taken_down (new.document_id) then
        return null;
    end if;
    perform realtime.broadcast_changes(
        'doc-db:' || new.document_id::text, -- topic (receive-only for clients)
        tg_op,                              -- event name ('INSERT' | 'UPDATE')
        tg_op,                              -- operation
        tg_table_name,
        tg_table_schema,
        new,
        old
    );
    return null;
end;
$$;

create or replace function public.broadcast_document_changes () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if public.content_taken_down (new.id) then
        return null;
    end if;
    perform realtime.broadcast_changes(
        'doc-db:' || new.id::text, -- topic (receive-only for clients)
        tg_op, tg_op, tg_table_name, tg_table_schema, new, old
    );
    return null;
end;
$$;

create or replace function public.broadcast_score_analysis_changes () returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if tg_op = 'UPDATE'
       and old.status is not distinct from new.status
       and old.progress is not distinct from new.progress then
        return null;
    end if;
    if public.content_taken_down (new.document_id) then
        return null;
    end if;

    perform realtime.send(
        jsonb_build_object(
            'table', 'score_analyses',
            'document_id', new.document_id,
            'status', new.status,
            'error', new.error,
            'progress', new.progress,
            'updated_at', new.updated_at
        ),
        'score_analysis', -- event
        'doc-db:' || new.document_id::text, -- topic (receive-only for clients)
        true -- private
    );
    return null;
end;
$$;

revoke all on function public.broadcast_annotation_changes () from public, anon, authenticated;
revoke all on function public.broadcast_document_changes () from public, anon, authenticated;
revoke all on function public.broadcast_score_analysis_changes () from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The owner's own read of a removed score
-- ---------------------------------------------------------------------------
-- documents_select (20260802044133) lets an owner read their row without
-- document_role(), so a removed score's title and storage path stayed one
-- PostgREST request away from its uploader, and the app, re-checking after
-- the hint above, would still have found it. The owner clause now stops at a
-- removal; a restricted score stays readable by its owner, as document_role()
-- has it. The function answers only about the caller's own scores.
create or replace function public.owned_document_removed (doc uuid) returns boolean language sql stable security definer
set search_path = public as $$
    select exists (
        select 1
        from public.content_takedowns ct
        join public.documents d on d.id = ct.document_id
        where ct.document_id = doc
          and ct.lifted_at is null
          and ct.action = 'remove'
          and d.owner_id = (select auth.uid())
    );
$$;

revoke all on function public.owned_document_removed (uuid) from public;
revoke all on function public.owned_document_removed (uuid) from anon;
grant execute on function public.owned_document_removed (uuid) to authenticated;

-- ALTER, not drop and create: the policy keeps its name, command and role, and
-- owners never lose their read mid-migration.
alter policy documents_select on public.documents
using (
    (owner_id = (select auth.uid()) and not public.owned_document_removed (id))
    or public.document_role (id) is not null
);

-- 20261014120000's library_documents(), unchanged but for the takedown clause:
-- it lists memberships directly, so document_role() alone would leave a
-- taken-down score in its members' libraries, failing to open.
create or replace function public.library_documents (
    p_sort text default 'recent',
    p_after_updated_at timestamptz default null,
    p_after_title text default null,
    p_after_id uuid default null,
    p_query text default null,
    p_tag_id uuid default null,
    p_favorites_only boolean default false,
    p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_uid uuid := (select auth.uid());
    v_sort text := coalesce(p_sort, 'recent');
    v_limit int := least(greatest(coalesce(p_limit, 100), 1), 200);
    v_query text := nullif(btrim(coalesce(p_query, '')), '');
    v_pattern text;
    v_rows jsonb;
    v_count int;
    -- Once per call, not per row: about the caller only.
    v_revoked boolean := public.student_access_revoked ();
begin
    if v_uid is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;
    if v_sort not in ('recent', 'title') then
        raise exception 'unknown library sort: %', v_sort using errcode = '22023';
    end if;
    -- A half cursor would compare against null and silently return nothing.
    if p_after_id is not null
       and ((v_sort = 'recent' and p_after_updated_at is null)
            or (v_sort = 'title' and p_after_title is null)) then
        raise exception 'library cursor is incomplete' using errcode = '22023';
    end if;

    if v_query is not null then
        -- Titles are short; a pasted paragraph is not a search worth running.
        -- Escape ilike's own wildcards so "50%" or "op_1" match literally.
        v_pattern := '%'
            || replace(replace(replace(left(v_query, 200), '\', '\\'), '%', '\%'), '_', '\_')
            || '%';
    end if;

    with visible as (
        select
            d.id,
            d.owner_id,
            d.title,
            d.storage_path,
            d.page_count,
            d.content_rev,
            d.thumb_rev,
            d.created_at,
            d.updated_at,
            d.archived_at
        from public.documents d
        -- The caller's own scores (documents_owner_id_idx) and memberships
        -- (document_members_user), collected first and then looked up by
        -- primary key. Written as `= any (array(...))` rather than a join so
        -- the planner cannot turn it back into a scan: on a join it hashed the
        -- candidates and still read every row of documents to apply a title
        -- search, 31 ms where this takes 2.
        where d.id = any (array(
                select o.id
                from public.documents o
                where o.owner_id = v_uid
                union
                select m.document_id
                from public.document_members m
                where m.user_id = v_uid
                  and not v_revoked
            ))
          and (v_pattern is null or d.title ilike v_pattern)
          -- Taken down (20261020150000): a restricted score lists for its owner
          -- only, a removed one for nobody — the same answer document_role() gives.
          and not exists (
                select 1
                from public.content_takedowns ct
                where ct.document_id = d.id
                  and ct.lifted_at is null
                  and (ct.action = 'remove' or d.owner_id <> v_uid)
            )
          and (
                p_tag_id is null
                or exists (
                    select 1
                    from public.document_tags dt
                    join public.library_tags t on t.id = dt.tag_id
                    where dt.document_id = d.id
                      and dt.tag_id = p_tag_id
                      and t.user_id = v_uid
                )
            )
          and (
                not coalesce(p_favorites_only, false)
                or exists (
                    select 1
                    from public.document_favorites f
                    where f.document_id = d.id
                      and f.user_id = v_uid
                )
            )
          and (
                p_after_id is null
                or (v_sort = 'recent' and (d.updated_at, d.id) < (p_after_updated_at, p_after_id))
                or (v_sort = 'title' and (lower(d.title), d.id) > (lower(p_after_title), p_after_id))
            )
    ),
    ordered as (
        select
            v.*,
            row_number() over (
                order by
                    case when v_sort = 'title' then lower(v.title) end asc,
                    case when v_sort = 'title' then v.id end asc,
                    case when v_sort = 'recent' then v.updated_at end desc,
                    case when v_sort = 'recent' then v.id end desc
            ) as rn
        from visible v
    ),
    page as (
        select * from ordered where rn <= v_limit + 1
    )
    select
        coalesce(
            (select jsonb_agg(to_jsonb(p) - 'rn' order by p.rn) from page p where p.rn <= v_limit),
            '[]'::jsonb
        ),
        (select count(*)::int from page)
    into v_rows, v_count;

    return jsonb_build_object(
        'documents', v_rows,
        'has_more', v_count > v_limit
    );
end;
$$;

revoke all on function public.library_documents (text, timestamptz, text, uuid, text, uuid, boolean, integer) from public;
revoke all on function public.library_documents (text, timestamptz, text, uuid, text, uuid, boolean, integer) from anon;
grant execute on function public.library_documents (text, timestamptz, text, uuid, text, uuid, boolean, integer) to authenticated;
