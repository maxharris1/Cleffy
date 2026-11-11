-- Takedown: move a score's realtime onto fresh topics, so nobody it shut out
-- keeps hearing it.
--
-- Realtime authorizes a private channel once, when it JOINS (and again only
-- when that client refreshes its token), and it has no way to evict one
-- subscriber. So a collaborator who had a score open when it was restricted
-- kept doc:{id}: the hint in 20261020150000 asked their app to leave, but a
-- client that ignored it went on receiving the owner's live ink (the stroke
-- coordinates of new handwriting) until its token ran out. And because a
-- broadcast cannot pick out recipients, 20261020150000 also stopped the
-- committed changes on doc-db:{id} for everyone, the owner's own devices
-- included: a device that then saw one post-lift mark live jumped its
-- watermark past every mark it had missed, further back than the pull's
-- 50-seq overlap could reach (Codex round 2, #63).
--
-- Both topics now carry a generation: doc:{id} and doc-db:{id} at generation
-- 0 (every score until something rotates it, so nothing changes for them),
-- then doc:{id}:{n} and doc-db:{id}:{n}. The realtime.messages policies admit
-- a join only on the score's CURRENT generation, and only for a member
-- document_role() still answers for. A takedown rotates the score:
--
--  * Everything the server sends goes to the new topics, which a member the
--    takedown shut out cannot join — so a restricted score's committed marks
--    keep reaching its owner's devices (and nobody else), and a removed
--    score's reach nobody.
--  * Every client on the old topics is told `topic_rotated` there. The app
--    re-reads the generation over PostgREST (realtime_topic_epoch, checked
--    per request) and moves; one the takedown shut out is refused the new
--    topics, and gets the membership hint as before. The owner's live ink
--    moves with the owner, so a collaborator still sitting on the old doc:{id}
--    hears nobody: the topic is dead, whatever that client does.
--  * A stale client that rejoins the old topics is refused (wrong generation),
--    which the app already treats as "re-check": it re-reads and moves.
--
-- Lifting does not rotate: the owner is already on the current topics, and the
-- members it restores join them when they next open the score.
--
-- tests/sql/content_moderation.sql (checks 73-85, 43b, 47) proves it against
-- a database; tests/live/takedownRealtime.live.test.ts against the Realtime
-- server, with a collaborator that ignores every hint;
-- tests/moderation/takedownRealtime.test.ts keeps the pieces from drifting.
--
-- Deploy with the frontend that follows `topic_rotated`
-- (src/sync/realtimeChannel.ts, fetchTopicEpoch). A tab on the old bundle
-- stays on generation 0 after a takedown: it receives nothing live (it still
-- converges by pulling) until it reloads, and an owner's old tab would go on
-- streaming its live ink there, so ship both together.

-- ---------------------------------------------------------------------------
-- The generation
-- ---------------------------------------------------------------------------
-- One row per score that has ever been rotated; no row is generation 0.
create table if not exists public.document_realtime_epochs (
    document_id uuid primary key references public.documents (id) on delete cascade,
    epoch integer not null check (epoch > 0),
    rotated_at timestamptz not null default now()
);

alter table public.document_realtime_epochs enable row level security;
revoke all on public.document_realtime_epochs from public;
revoke all on public.document_realtime_epochs from anon;
revoke all on public.document_realtime_epochs from authenticated;

-- Internal: the policies, the triggers and the RPC below call it as its owner.
create or replace function public.document_realtime_epoch (doc uuid) returns integer language sql stable security definer
set search_path = public as $$
    select coalesce((select e.epoch from public.document_realtime_epochs e where e.document_id = doc), 0);
$$;

revoke all on function public.document_realtime_epoch (uuid) from public;
revoke all on function public.document_realtime_epoch (uuid) from anon;
revoke all on function public.document_realtime_epoch (uuid) from authenticated;

-- The score's current topics. src/sync/realtimeChannel.ts builds the same
-- names (docTopic / docDbTopic); tests/realtimeTopicsInSync.test.ts keeps them
-- together.
create or replace function public.document_live_topic (doc uuid) returns text language sql stable security definer
set search_path = public as $$
    select 'doc:' || doc::text || case
        when public.document_realtime_epoch (doc) = 0 then ''
        else ':' || public.document_realtime_epoch (doc)::text
    end;
$$;

create or replace function public.document_db_topic (doc uuid) returns text language sql stable security definer
set search_path = public as $$
    select 'doc-db:' || doc::text || case
        when public.document_realtime_epoch (doc) = 0 then ''
        else ':' || public.document_realtime_epoch (doc)::text
    end;
$$;

revoke all on function public.document_live_topic (uuid) from public;
revoke all on function public.document_live_topic (uuid) from anon;
revoke all on function public.document_live_topic (uuid) from authenticated;
revoke all on function public.document_db_topic (uuid) from public;
revoke all on function public.document_db_topic (uuid) from anon;
revoke all on function public.document_db_topic (uuid) from authenticated;

-- The score a topic names, when it is `{prefix}:{uuid}` (generation 0) or
-- `{prefix}:{uuid}:{n}` and that is the score's current generation; null for
-- anything else, including an old generation. Never throws on a foreign topic.
create or replace function public.realtime_topic_document (topic text, prefix text) returns uuid language plpgsql stable security definer
set search_path = public as $$
declare
    v_doc uuid;
    v_tail text;
    v_epoch integer := 0;
begin
    if topic is null or split_part(topic, ':', 1) <> prefix or split_part(topic, ':', 4) <> '' then
        return null;
    end if;
    begin
        v_doc := split_part(topic, ':', 2)::uuid;
    exception when invalid_text_representation then
        return null;
    end;
    v_tail := split_part(topic, ':', 3);
    if v_tail <> '' then
        -- Canonical digits only: `:01` or `:1x` name no generation.
        if v_tail !~ '^[1-9][0-9]{0,8}$' then
            return null;
        end if;
        v_epoch := v_tail::integer;
    end if;
    if v_epoch <> public.document_realtime_epoch (v_doc) then
        return null;
    end if;
    return v_doc;
end;
$$;

revoke all on function public.realtime_topic_document (text, text) from public;
revoke all on function public.realtime_topic_document (text, text) from anon;
revoke all on function public.realtime_topic_document (text, text) from authenticated;

-- 20260801162310's and 20261007120101's topic resolvers, which the
-- realtime.messages policies call: now the current generation only. The
-- policies themselves are unchanged.
create or replace function public.topic_document_role (topic text) returns text language plpgsql stable security definer
set search_path = public as $$
declare
    doc uuid;
begin
    if topic not like 'doc:%' then
        return null;
    end if;
    doc := public.realtime_topic_document (topic, 'doc');
    if doc is null then
        return null;
    end if;
    return public.document_role(doc);
end;
$$;

create or replace function public.db_topic_document_role (topic text) returns text language plpgsql stable security definer
set search_path = public as $$
declare
    doc uuid;
begin
    if topic not like 'doc-db:%' then
        return null;
    end if;
    doc := public.realtime_topic_document (topic, 'doc-db');
    if doc is null then
        return null;
    end if;
    return public.document_role(doc);
end;
$$;

grant execute on function public.topic_document_role (text) to authenticated;
revoke all on function public.db_topic_document_role (text) from public;
revoke all on function public.db_topic_document_role (text) from anon;
grant execute on function public.db_topic_document_role (text) to authenticated;

-- What the app asks before it joins: the score's generation, for a caller
-- document_role() answers for, and null for anyone else (it says nothing a
-- member cannot already see: it only counts takedowns).
create or replace function public.realtime_topic_epoch (p_document uuid) returns integer language sql stable security definer
set search_path = public as $$
    select case
        when public.document_role (p_document) is not null then public.document_realtime_epoch (p_document)
    end;
$$;

revoke all on function public.realtime_topic_epoch (uuid) from public;
revoke all on function public.realtime_topic_epoch (uuid) from anon;
grant execute on function public.realtime_topic_epoch (uuid) to authenticated;

-- Move a score to its next generation and tell everyone on the old topics.
-- Internal: content_takedown_notify_viewers calls it.
create or replace function public.rotate_document_realtime (p_document uuid) returns integer language plpgsql security definer
set search_path = public as $$
declare
    v_old_live text := public.document_live_topic (p_document);
    v_old_db text := public.document_db_topic (p_document);
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
        v_old_db, -- topic
        true -- private
    );
    perform realtime.send (
        jsonb_build_object('document_id', p_document),
        'topic_rotated', -- event
        v_old_live, -- topic
        true -- private
    );
    return v_epoch;
end;
$$;

revoke all on function public.rotate_document_realtime (uuid) from public;
revoke all on function public.rotate_document_realtime (uuid) from anon;
revoke all on function public.rotate_document_realtime (uuid) from authenticated;

-- A score with a live takedown from before this migration moves too: its
-- shut-out members may still sit on generation 0, which the fan-out below
-- would otherwise start sending to again.
insert into public.document_realtime_epochs (document_id, epoch)
select distinct ct.document_id, 1
from public.content_takedowns ct
where ct.lifted_at is null
on conflict (document_id) do nothing;

-- Whether a score has a live REMOVAL (nobody may see it, its owner included).
-- Internal, like content_taken_down.
create or replace function public.content_removed (doc uuid) returns boolean language sql stable security definer
set search_path = public as $$
    select exists (
        select 1 from public.content_takedowns ct
        where ct.document_id = doc and ct.lifted_at is null and ct.action = 'remove'
    );
$$;

revoke all on function public.content_removed (uuid) from public;
revoke all on function public.content_removed (uuid) from anon;
revoke all on function public.content_removed (uuid) from authenticated;

-- ---------------------------------------------------------------------------
-- Takedown: hint, then rotate
-- ---------------------------------------------------------------------------
-- apply_content_takedown calls this. The membership hint goes out on the
-- topic those members are on (the current one), then the score moves.
create or replace function public.content_takedown_notify_viewers (p_document uuid, p_action text) returns void language plpgsql security definer
set search_path = public as $$
declare
    v_user uuid;
    v_topic text := public.document_live_topic (p_document);
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
            v_topic, -- topic
            true -- private
        );
    end loop;
    perform public.rotate_document_realtime (p_document);
end;
$$;

revoke all on function public.content_takedown_notify_viewers (uuid, text) from public;
revoke all on function public.content_takedown_notify_viewers (uuid, text) from anon;
revoke all on function public.content_takedown_notify_viewers (uuid, text) from authenticated;

-- ---------------------------------------------------------------------------
-- Fan-out: to the current generation
-- ---------------------------------------------------------------------------
-- A restricted score's changes go out again — to its owner's devices, the
-- only clients its current topics admit. A removed one's still go nowhere.
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
    return null;
end;
$$;

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
    if public.content_removed (new.document_id) then
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
        public.document_db_topic (new.document_id), -- doc-db:{id}[:{generation}] (receive-only for clients)
        true -- private
    );
    return null;
end;
$$;

revoke all on function public.broadcast_annotation_changes () from public, anon, authenticated;
revoke all on function public.broadcast_document_changes () from public, anon, authenticated;
revoke all on function public.broadcast_score_analysis_changes () from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Membership hints: to the current generation
-- ---------------------------------------------------------------------------
-- 20261007120000's trigger, unchanged but for the topic: after a rotation the
-- members are on doc:{id}:{n}, and a hint on doc:{id} would reach nobody.
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
        public.document_live_topic (v_row.document_id), -- topic
        true -- private
    );
    return null;
end;
$$;

revoke all on function public.broadcast_membership_changes () from public;
revoke all on function public.broadcast_membership_changes () from anon;
revoke all on function public.broadcast_membership_changes () from authenticated;

-- 20261010120300's end_student_sessions, unchanged but for the hint's topic.
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
            public.document_live_topic (v_doc), -- topic
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
