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
