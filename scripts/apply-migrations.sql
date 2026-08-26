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

-- ===== supabase/migrations/20260811120000_billing.sql =====
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
        return new;
    end if;
    if tg_op = 'UPDATE' and old.archived_at is null then
        return new; -- already active; nothing new is being claimed
    end if;

    v_ent := public.get_entitlements (new.owner_id);
    v_tier := v_ent ->> 'tier';
    v_limit := (v_ent -> 'limits' ->> 'cloud_scores')::int;

    if v_limit < 0 then
        return new;
    end if;

    select count(*)::int into v_count
    from public.documents d
    where d.owner_id = new.owner_id
      and d.archived_at is null
      and d.id <> new.id;

    if v_count >= v_limit then
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

    return new;
end;
$$;

create trigger documents_enforce_score_cap before insert or update on public.documents
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

-- Owners manage their studio; members may see the studio they belong to.
create policy studios_select on public.studios for select to authenticated
using (
    owner_id = (select auth.uid())
    or exists (
        select 1
        from public.studio_members sm
        where sm.studio_id = id and sm.user_id = (select auth.uid())
    )
);

create policy studios_insert on public.studios for insert to authenticated
with check (owner_id = (select auth.uid()));

create policy studios_update on public.studios for update to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy studio_members_select on public.studio_members for select to authenticated
using (
    user_id = (select auth.uid())
    or exists (
        select 1
        from public.studios st
        where st.id = studio_id and st.owner_id = (select auth.uid())
    )
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
grant select, insert, update on table public.studios to authenticated;

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

