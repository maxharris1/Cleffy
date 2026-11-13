-- Share v2, part 2 of 4: signed-out viewers of a general viewer link (#104,
-- plan 6.2 to 6.4).
--
-- A signed-out visitor opening "Anyone with the link: Viewer" never gets an
-- account. share-session (an Edge Function, the only holder of the signing
-- key) checks the link and mints a 10-minute token for the anon role:
--
--   { iss: 'cleffy-share', role: 'anon', exp, cleffy_link: { doc, link, v: 1 } }
--
-- with no `sub`. Everything here reads that claim and nothing else, and
-- re-checks the link on every request and every Realtime join, so revoking,
-- resetting, restricting or expiring the link ends the viewer's access at
-- once (the rotation in part 1 moves Realtime) or at its next renewal.
--
-- What the token may do:
--   * link_view_access / link_view_snapshot: the score's title, page count
--     and its marks, each cut down to what the renderer draws (link_view_mark)
--   * Realtime: read broadcast on doc:{id} (live ink) and doc-view:{id}
--     (saved marks, below) at the score's current generation; send presence
--     on doc:{id} only, so the owner sees an anonymous viewer. No broadcast
--     send anywhere, nothing on doc-db:{id}, no presence read (D13).
--   * Nothing else: anon holds no table, and every public function anon could
--     execute is listed at the bottom.
--
-- Spike (b) on the local stack showed Realtime admits a presence write with no
-- presence-read policy, so viewers track presence natively (no R5 fallback).
--
-- Safe to run twice.

-- ---------------------------------------------------------------------------
-- The claim
-- ---------------------------------------------------------------------------
-- The viewer token's score and link, or no row. Only for the anon role, with
-- iss cleffy-share and version 1, and both ids well-formed: an authenticated
-- token carrying a forged cleffy_link gets nothing. Never throws.
create or replace function public.link_view_claims () returns table (doc uuid, link uuid) language plpgsql stable security definer
set search_path = '' as $$
declare
    v_claims jsonb := auth.jwt ();
    v_link jsonb := v_claims -> 'cleffy_link';
    v_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
    if coalesce(current_setting('role', true), '') <> 'anon'
       or coalesce(v_claims ->> 'role', '') <> 'anon'
       or coalesce(v_claims ->> 'iss', '') <> 'cleffy-share'
       or jsonb_typeof(v_link) is distinct from 'object'
       or v_link -> 'v' is distinct from '1'::jsonb
       or coalesce(v_link ->> 'doc', '') !~ v_uuid
       or coalesce(v_link ->> 'link', '') !~ v_uuid then
        return;
    end if;
    return query select (v_link ->> 'doc')::uuid, (v_link ->> 'link')::uuid;
end;
$$;

revoke all on function public.link_view_claims () from public, anon, authenticated;

-- The claim's link and its state: 'invalid' unless the claim names a general
-- viewer link of the claimed score.
create or replace function public.link_view_link_state () returns table (doc uuid, state text, expires_at timestamptz) language sql stable security definer
set search_path = '' as $$
    select c.doc,
           coalesce(public.share_link_state (l), 'invalid'),
           l.expires_at
    from public.link_view_claims () c
    left join public.share_links l
        on l.id = c.link
       and l.document_id = c.doc
       and l.general
       and l.role = 'viewer';
$$;

revoke all on function public.link_view_link_state () from public, anon, authenticated;

-- The score the viewer token may see right now, or null.
create or replace function public.link_view_document () returns uuid language sql stable security definer
set search_path = '' as $$
    select s.doc from public.link_view_link_state () s where s.state = 'live';
$$;

revoke all on function public.link_view_document () from public, anon, authenticated;

-- What the viewer app asks before it joins: the generation to join, or why not.
create or replace function public.link_view_access () returns jsonb language sql stable security definer
set search_path = '' as $$
    select case
        when s.state is null then jsonb_build_object('status', 'invalid')
        when s.state = 'live' then jsonb_build_object(
            'status', 'open',
            'epoch', public.document_realtime_epoch (s.doc),
            'doc', s.doc,
            'link_expires_at', s.expires_at
        )
        else jsonb_build_object('status', s.state)
    end
    from (select 1) as one
    left join public.link_view_link_state () s on true;
$$;

revoke all on function public.link_view_access () from public, authenticated;
grant execute on function public.link_view_access () to anon;

-- ---------------------------------------------------------------------------
-- What a viewer may see of one mark (PR #98's view_mark_for_viewer, by
-- maxharris1, unchanged): exactly id, page, kind, color, seq, deleted=false
-- and a payload rebuilt from the keys the renderer draws with -- pts, w, sp
-- for ink; x, y, size, text, hw, font, bold, italic for text. An erased mark
-- is only {id, seq, deleted:true}: none of its content reaches a viewer.
-- ---------------------------------------------------------------------------
create or replace function public.link_view_mark (
    p_id uuid,
    p_page integer,
    p_kind text,
    p_color text,
    p_payload jsonb,
    p_seq bigint,
    p_deleted_at timestamptz
) returns jsonb language sql immutable parallel safe
set search_path = '' as $$
    select case
        when p_deleted_at is not null then
            jsonb_build_object('id', p_id, 'seq', p_seq, 'deleted', true)
        else
            jsonb_build_object(
                'id', p_id,
                'page', p_page,
                'kind', p_kind,
                'color', p_color,
                'payload', jsonb_strip_nulls(case
                    when p_kind = 'text' then jsonb_build_object(
                        'x', p_payload -> 'x',
                        'y', p_payload -> 'y',
                        'size', p_payload -> 'size',
                        'text', p_payload -> 'text',
                        'hw', p_payload -> 'hw',
                        'font', p_payload -> 'font',
                        'bold', p_payload -> 'bold',
                        'italic', p_payload -> 'italic'
                    )
                    else jsonb_build_object(
                        'pts', p_payload -> 'pts',
                        'w', p_payload -> 'w',
                        'sp', p_payload -> 'sp'
                    )
                end),
                'seq', p_seq,
                'deleted', false
            )
    end;
$$;

revoke all on function public.link_view_mark (uuid, integer, text, text, jsonb, bigint, timestamptz) from public, anon, authenticated;

-- The score and its marks with seq > p_since, oldest first, at most p_limit
-- (up to 1000), tombstones included. `more` says another page is waiting;
-- max_seq is the watermark of what was sent (PR #98's view_link_poll). A token
-- whose link is not live is refused with HTTP 403 and the link's state.
create or replace function public.link_view_snapshot (p_since bigint default 0, p_limit integer default 500) returns jsonb language plpgsql stable security definer
set search_path = '' as $$
declare
    v_access jsonb := public.link_view_access ();
    v_doc uuid := public.link_view_document ();
    v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
    v_since bigint := greatest(coalesce(p_since, 0), 0);
    v_marks jsonb;
    v_count integer;
    v_max bigint;
    v_more boolean;
    v_meta jsonb;
begin
    if v_doc is null then
        raise exception 'this link does not open the score'
            using errcode = 'PT403',
                  detail = json_build_object('code', coalesce(v_access ->> 'status', 'invalid'))::text;
    end if;

    select
        coalesce(jsonb_agg(public.link_view_mark (
            a.id, a.page, a.kind, a.color, a.payload, a.seq, a.deleted_at
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

    select jsonb_build_object('title', d.title, 'page_count', d.page_count, 'content_rev', d.content_rev)
    into v_meta
    from public.documents d
    where d.id = v_doc;

    return jsonb_build_object(
        'doc', v_meta,
        'marks', v_marks,
        'max_seq', coalesce(v_max, v_since),
        'more', v_more
    );
end;
$$;

revoke all on function public.link_view_snapshot (bigint, integer) from public, authenticated;
grant execute on function public.link_view_snapshot (bigint, integer) to anon;

-- ---------------------------------------------------------------------------
-- Realtime (plan 6.3)
-- ---------------------------------------------------------------------------
-- Whether `topic` is `{prefix}:{doc}[:{generation}]` at the current
-- generation for the score the viewer token may see. Granted to anon because
-- the policies below run their expressions as the querying role.
create or replace function public.link_view_topic_ok (topic text, prefix text) returns boolean language sql stable security definer
set search_path = '' as $$
    select public.realtime_topic_document (topic, prefix) is not null
       and public.realtime_topic_document (topic, prefix) = public.link_view_document ();
$$;

revoke all on function public.link_view_topic_ok (text, text) from public, authenticated;
grant execute on function public.link_view_topic_ok (text, text) to anon;

drop policy if exists link_view_receive on realtime.messages;
create policy link_view_receive on realtime.messages for select to anon using (
    realtime.messages.extension = 'broadcast'
    and (
        public.link_view_topic_ok (realtime.topic (), 'doc')
        or public.link_view_topic_ok (realtime.topic (), 'doc-view')
    )
);

-- No anon policy on doc-db:*, and no anon broadcast insert anywhere.
drop policy if exists link_view_presence on realtime.messages;
create policy link_view_presence on realtime.messages for insert to anon with check (
    realtime.messages.extension = 'presence'
    and public.link_view_topic_ok (realtime.topic (), 'doc')
);

-- ---------------------------------------------------------------------------
-- Fan-out to doc-view (plan 6.4)
-- ---------------------------------------------------------------------------
-- The viewer topic at the score's current generation, the twin of
-- document_db_topic. Members do not join it; viewers only receive on it.
create or replace function public.document_view_topic (doc uuid) returns text language sql stable security definer
set search_path = public as $$
    select public.document_topic_at ('doc-view', doc, public.document_realtime_epoch (doc));
$$;

revoke all on function public.document_view_topic (uuid) from public, anon, authenticated;

-- Whether a signed-out viewer could be listening: a live general viewer link
-- on a live score.
create or replace function public.document_has_live_viewer_link (doc uuid) returns boolean language sql stable security definer
set search_path = '' as $$
    select exists (
        select 1
        from public.share_links l
        where l.document_id = doc
          and l.general
          and l.revoked_at is null
          and l.role = 'viewer'
          and (l.expires_at is null or l.expires_at > now())
    ) and public.link_view_document_live (doc);
$$;

revoke all on function public.document_has_live_viewer_link (uuid) from public, anon, authenticated;

-- 20261020150100's annotation fan-out, plus the viewer's copy of the mark.
create or replace function public.broadcast_annotation_changes () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if public.content_removed (new.document_id) then
        return null;
    end if;
    perform realtime.broadcast_changes(
        public.document_db_topic (new.document_id), -- doc-db:{id}[:{generation}] (receive-only for clients)
        tg_op,                                      -- event name ('INSERT' | 'UPDATE')
        tg_op,                                      -- operation
        tg_table_name,
        tg_table_schema,
        new,
        old
    );
    if public.document_has_live_viewer_link (new.document_id) then
        perform realtime.send(
            public.link_view_mark (new.id, new.page, new.kind, new.color, new.payload, new.seq, new.deleted_at),
            'mark', -- event
            public.document_view_topic (new.document_id), -- doc-view:{id}[:{generation}] (receive-only)
            true -- private
        );
    end if;
    return null;
end;
$$;

-- 20261020150100's score fan-out, plus a new content revision for viewers.
create or replace function public.broadcast_document_changes () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if public.content_removed (new.id) then
        return null;
    end if;
    perform realtime.broadcast_changes(
        public.document_db_topic (new.id), -- doc-db:{id}[:{generation}] (receive-only for clients)
        tg_op, tg_op, tg_table_name, tg_table_schema, new, old
    );
    if tg_op = 'UPDATE'
       and old.content_rev is distinct from new.content_rev
       and public.document_has_live_viewer_link (new.id) then
        perform realtime.send(
            jsonb_build_object('content_rev', new.content_rev),
            'doc', -- event
            public.document_view_topic (new.id),
            true -- private
        );
    end if;
    return null;
end;
$$;

revoke all on function public.broadcast_annotation_changes () from public, anon, authenticated;
revoke all on function public.broadcast_document_changes () from public, anon, authenticated;

-- 20261022120100's rotation, plus the hint on the old doc-view topic for a
-- score that has ever had a general link (a revoked one included: that is
-- when its viewers most need the hint).
create or replace function public.rotate_document_realtime (p_document uuid) returns integer language plpgsql security definer
set search_path = public as $$
declare
    v_epoch integer;
begin
    insert into public.document_realtime_epochs as e (document_id, epoch)
    values (p_document, 1)
    on conflict (document_id) do update set epoch = e.epoch + 1, rotated_at = now()
    returning e.epoch into v_epoch;

    -- A hint, on both old topics: doc-db:{id} because no client can forge it
    -- there, doc:{id} because a device whose doc-db channel is down is still
    -- on it. The app never trusts the payload; it re-reads the generation.
    perform realtime.send (
        jsonb_build_object('document_id', p_document),
        'topic_rotated', -- event
        public.document_topic_at ('doc-db', p_document, v_epoch - 1), -- topic
        true -- private
    );
    perform realtime.send (
        jsonb_build_object('document_id', p_document),
        'topic_rotated', -- event
        public.document_topic_at ('doc', p_document, v_epoch - 1), -- topic
        true -- private
    );
    if exists (select 1 from public.share_links l where l.document_id = p_document and l.general) then
        perform realtime.send (
            jsonb_build_object('document_id', p_document),
            'topic_rotated', -- event
            public.document_topic_at ('doc-view', p_document, v_epoch - 1), -- topic
            true -- private
        );
    end if;
    return v_epoch;
end;
$$;

revoke all on function public.rotate_document_realtime (uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- share-session's one read (service role only)
-- ---------------------------------------------------------------------------
-- What a token names, for the Edge Function: {state:'invalid'} for anything
-- but a general link; {state, link_id} for a general link that is not live;
-- the score's facts and the PDF's storage path for a live one. Older links
-- keep the /join path (D2), so they read invalid here.
create or replace function public.share_session_resolve (p_token text) returns jsonb language plpgsql stable security definer
set search_path = '' as $$
declare
    v_link public.share_links;
    v_state text;
begin
    if p_token is null or p_token !~ '^[A-Za-z0-9_-]{22}$' then
        return jsonb_build_object('state', 'invalid');
    end if;
    select * into v_link from public.share_links l where l.token = p_token;
    if v_link.id is null or not v_link.general then
        return jsonb_build_object('state', 'invalid');
    end if;
    v_state := public.share_link_state (v_link);
    if v_state <> 'live' then
        return jsonb_build_object('state', v_state, 'link_id', v_link.id);
    end if;
    return (
        select jsonb_build_object(
            'state', 'live',
            'role', v_link.role,
            'link_id', v_link.id,
            'doc', jsonb_build_object(
                'id', d.id,
                'title', d.title,
                'page_count', d.page_count,
                'content_rev', d.content_rev
            ),
            'pdf_path', d.storage_path,
            'link_expires_at', v_link.expires_at
        )
        from public.documents d
        where d.id = v_link.document_id
    );
end;
$$;

revoke all on function public.share_session_resolve (text) from public, anon, authenticated;
grant execute on function public.share_session_resolve (text) to service_role;

-- ---------------------------------------------------------------------------
-- What anon may execute
-- ---------------------------------------------------------------------------
-- A viewer token runs as anon, so anon executes exactly: consent_age (the age
-- screen), peek_share_link (/join), record_web_events (signed-out page
-- events) and the three viewer functions above. content_notice_time was the
-- one other: an internal helper no signed-out path calls.
revoke execute on function public.content_notice_time (timestamptz) from public, anon;

-- And a function created later does not reach anon through this schema's
-- default privileges (each migration still revokes PUBLIC itself).
alter default privileges for role postgres in schema public revoke execute on functions from anon;
