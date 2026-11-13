-- Under-13 view links (packet U13-2). A teacher shares one reusable,
-- revocable, read-only link to a score; anyone holding it -- a child with no
-- account included -- watches the score and its marks through the view-link
-- Edge Function, which the Vercel proxy (api/view.ts) calls. The child's
-- browser never talks to Supabase (bar the large-PDF fallback, a 60 s signed
-- URL), and nothing about who opens a link is stored anywhere.
--
-- Behind three switches, all off in production until counsel signs off
-- (DEPLOY.md, "View links"). This migration is inert on its own: no client can
-- reach a link's contents without the Edge Function, which refuses unless its
-- VIEW_LINKS_ENABLED secret is 1.
--
--   * public.view_links: one row per link. The token is plaintext, like
--     share_links.token, so the owner can copy it again. One active link per
--     score (partial unique index). The owner can read their rows; no client
--     writes; anon nothing.
--   * create_view_link / rotate_view_link / revoke_view_link: owner only, on a
--     live score (not archived, not taken down), never a share-link guest or a
--     roster student.
--   * view_link_poll / view_link_pdf: service_role only, for the Edge
--     Function. They answer only for an active, unexpired link on a live score,
--     and never return created_by, a name or an email.
--   * Retention: pg_cron deletes rows revoked or expired more than 30 days ago.
--
-- Sorts after 20261112120000_web_events.sql. Rerunnable: IF NOT EXISTS for the
-- table and index, CREATE OR REPLACE for functions, policies dropped first, and
-- the cron job unscheduled before it is scheduled.

create table if not exists public.view_links (
    id uuid primary key default gen_random_uuid(),
    document_id uuid not null references public.documents (id) on delete cascade,
    created_by uuid not null references auth.users (id) on delete cascade,
    -- 32 random bytes, base64url without padding: 43 characters. Server-made.
    token text not null unique default rtrim(
        translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'),
        '='
    ),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '90 days',
    revoked_at timestamptz,
    constraint view_links_token_shape check (token ~ '^[A-Za-z0-9_-]{43}$')
);

-- One active link per score. An expired link still counts until it is
-- revoked; create_view_link revokes it first.
create unique index if not exists view_links_one_active on public.view_links (document_id)
where
    revoked_at is null;

-- The retention sweep's lookups.
create index if not exists view_links_revoked_at on public.view_links (revoked_at)
where
    revoked_at is not null;

create index if not exists view_links_expires_at on public.view_links (expires_at);

alter table public.view_links enable row level security;

drop policy if exists view_links_owner_select on public.view_links;

create policy view_links_owner_select on public.view_links for
select
    to authenticated using (public.document_role (document_id) = 'owner');

-- Explicit grants (BL-3): the owner reads through RLS; every write goes
-- through the definer functions below; anon holds nothing.
revoke all on table public.view_links from public, anon, authenticated;

grant select on table public.view_links to authenticated;

grant select, insert, update, delete on table public.view_links to service_role;

-- ---------------------------------------------------------------------------
-- Is this score one a view link may show? It exists, is not archived, and has
-- no live takedown of any kind. realtime_topic_access's predicate
-- (20261022120200: a role and not archived), made stricter for a public link:
-- a 'restrict' takedown still lets the owner see their score, but never anyone
-- through a link.
-- ---------------------------------------------------------------------------
create or replace function public.view_link_document_live (p_document uuid) returns boolean language sql stable security definer
set search_path = '' as $$
    select exists (
        select 1
        from public.documents d
        where d.id = p_document
          and not public.document_is_archived (d.id)
          and not exists (
              select 1
              from public.content_takedowns ct
              where ct.document_id = d.id
                and ct.lifted_at is null
          )
    );
$$;

revoke all on function public.view_link_document_live (uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The caller may manage this score's view link: a signed-in, non-guest,
-- non-student owner of a live score. Raises 28000 / 42501 otherwise. One
-- message for every refusal, so it does not say which test failed.
-- ---------------------------------------------------------------------------
create or replace function public.view_link_assert_owner (p_document uuid) returns uuid language plpgsql stable security definer
set search_path = '' as $$
declare
    v_uid uuid := auth.uid();
begin
    if v_uid is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;
    if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
       or exists (select 1 from public.managed_students ms where ms.student_user_id = v_uid)
       or public.document_role (p_document) is distinct from 'owner'
       or coalesce(public.realtime_topic_access (p_document) ->> 'status', '') <> 'open'
       or not public.view_link_document_live (p_document) then
        raise exception 'only the owner of a live score can share a view link' using errcode = '42501';
    end if;
    return v_uid;
end;
$$;

revoke all on function public.view_link_assert_owner (uuid) from public, anon, authenticated;

-- The active link's token, or a new one. An expired active link is revoked and
-- replaced. Concurrent calls settle on one row through the partial unique index.
create or replace function public.create_view_link (p_document uuid) returns text language plpgsql volatile security definer
set search_path = '' as $$
declare
    v_uid uuid := public.view_link_assert_owner (p_document);
    v_token text;
begin
    update public.view_links
    set revoked_at = now()
    where document_id = p_document
      and revoked_at is null
      and expires_at <= now();

    insert into public.view_links (document_id, created_by)
    values (p_document, v_uid)
    on conflict (document_id) where revoked_at is null do nothing
    returning token into v_token;

    if v_token is null then
        select vl.token into v_token
        from public.view_links vl
        where vl.document_id = p_document
          and vl.revoked_at is null;
    end if;
    return v_token;
end;
$$;

-- Revoke the active link (if any) and make a new one. The old link stops
-- working at once.
create or replace function public.rotate_view_link (p_document uuid) returns text language plpgsql volatile security definer
set search_path = '' as $$
declare
    v_uid uuid := public.view_link_assert_owner (p_document);
    v_token text;
begin
    update public.view_links
    set revoked_at = now()
    where document_id = p_document
      and revoked_at is null;

    insert into public.view_links (document_id, created_by)
    values (p_document, v_uid)
    on conflict (document_id) where revoked_at is null do nothing
    returning token into v_token;

    if v_token is null then
        -- A concurrent rotate won the race; its link is the active one.
        select vl.token into v_token
        from public.view_links vl
        where vl.document_id = p_document
          and vl.revoked_at is null;
    end if;
    return v_token;
end;
$$;

-- Turn the link off. A no-op when there is none.
create or replace function public.revoke_view_link (p_document uuid) returns void language plpgsql volatile security definer
set search_path = '' as $$
begin
    perform public.view_link_assert_owner (p_document);
    update public.view_links
    set revoked_at = now()
    where document_id = p_document
      and revoked_at is null;
end;
$$;

revoke all on function public.create_view_link (uuid) from public, anon;
revoke all on function public.rotate_view_link (uuid) from public, anon;
revoke all on function public.revoke_view_link (uuid) from public, anon;

grant execute on function public.create_view_link (uuid) to authenticated;
grant execute on function public.rotate_view_link (uuid) to authenticated;
grant execute on function public.revoke_view_link (uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The Edge Function's reads (service_role only). Null / no row for anything
-- but an active, unexpired link on a live score: unknown, revoked, expired,
-- archived and taken down all look the same.
-- ---------------------------------------------------------------------------
create or replace function public.view_link_document (p_token text) returns uuid language sql stable security definer
set search_path = '' as $$
    select vl.document_id
    from public.view_links vl
    where p_token ~ '^[A-Za-z0-9_-]{43}$'
      and vl.token = p_token
      and vl.revoked_at is null
      and vl.expires_at > now()
      and public.view_link_document_live (vl.document_id);
$$;

revoke all on function public.view_link_document (text) from public, anon, authenticated;

-- The score and the marks with seq > p_since, oldest first, at most p_limit.
-- Each mark carries exactly id, page, kind, color, payload, seq and deleted
-- (tombstones included, so the viewer can drop an erased mark). `more` says
-- another page is waiting; max_seq is the watermark of what was sent.
create or replace function public.view_link_poll (p_token text, p_since bigint, p_limit integer) returns jsonb language plpgsql stable security definer
set search_path = '' as $$
declare
    v_doc uuid := public.view_link_document (p_token);
    v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 2000);
    v_since bigint := greatest(coalesce(p_since, 0), 0);
    v_marks jsonb;
    v_count integer;
    v_max bigint;
    v_more boolean;
    v_pages integer;
    v_rev integer;
    v_bytes bigint;
begin
    if v_doc is null then
        return null;
    end if;

    select
        coalesce(jsonb_agg(jsonb_build_object(
            'id', a.id,
            'page', a.page,
            'kind', a.kind,
            'color', a.color,
            'payload', a.payload,
            'seq', a.seq,
            'deleted', a.deleted_at is not null
        ) order by a.seq), '[]'::jsonb),
        count(*),
        max(a.seq)
    into v_marks, v_count, v_max
    from (
        select an.id, an.page, an.kind, an.color, an.payload, an.seq, an.deleted_at
        from public.annotations an
        where an.document_id = v_doc
          and an.seq > v_since
        order by an.seq
        limit v_limit
    ) a;

    v_more := v_count = v_limit and exists (
        select 1 from public.annotations an
        where an.document_id = v_doc and an.seq > coalesce(v_max, v_since)
    );

    select d.page_count, d.content_rev, (o.metadata ->> 'size')::bigint
    into v_pages, v_rev, v_bytes
    from public.documents d
    left join storage.objects o on o.bucket_id = 'scores' and o.name = d.storage_path
    where d.id = v_doc;

    return jsonb_build_object(
        'doc', jsonb_build_object('pages', v_pages, 'pdf_rev', v_rev),
        'pdf_bytes', v_bytes,
        'annotations', v_marks,
        'max_seq', coalesce(v_max, v_since),
        'more', v_more
    );
end;
$$;

-- Where the score's PDF is, and how big, for the proxy-or-direct choice.
create or replace function public.view_link_pdf (p_token text) returns table (storage_path text, pdf_bytes bigint) language sql stable security definer
set search_path = '' as $$
    select d.storage_path, (o.metadata ->> 'size')::bigint
    from public.documents d
    left join storage.objects o on o.bucket_id = 'scores' and o.name = d.storage_path
    where d.id = public.view_link_document (p_token);
$$;

revoke all on function public.view_link_poll (text, bigint, integer) from public, anon, authenticated;
revoke all on function public.view_link_pdf (text) from public, anon, authenticated;

grant execute on function public.view_link_poll (text, bigint, integer) to service_role;
grant execute on function public.view_link_pdf (text) to service_role;

-- ---------------------------------------------------------------------------
-- Retention: a dead link is kept 30 days (so an owner's "I revoked it" can be
-- checked), then deleted.
-- ---------------------------------------------------------------------------
create or replace function public.view_links_retention_purge () returns integer language plpgsql volatile security definer
set search_path = '' as $$
declare
    v_deleted integer;
begin
    delete from public.view_links
    where revoked_at < now() - interval '30 days'
       or expires_at < now() - interval '30 days';
    get diagnostics v_deleted = row_count;
    return v_deleted;
end;
$$;

revoke all on function public.view_links_retention_purge () from public, anon, authenticated;

grant execute on function public.view_links_retention_purge () to service_role;

-- Off the hour and clear of the other 04:xx retention jobs; unscheduled first
-- so a re-applied migration replaces rather than duplicates.
do $$
begin
    perform cron.unschedule (jobid) from cron.job where jobname = 'retention-view-links';
exception
    when undefined_table then null;
    when others then null;
end;
$$;

select cron.schedule ('retention-view-links', '13 4 * * *', $$select public.view_links_retention_purge ()$$);
