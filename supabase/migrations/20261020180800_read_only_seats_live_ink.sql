-- Live ink stops when a seat goes read-only, including on a channel that was
-- already open (Codex round-3 review of PR #61, round-2 major 1 still partial).
--
-- 20261020180600's doc_topic_seat_read_only_broadcast refuses a read-only
-- seat's broadcasts on doc:{id} -- but Realtime asks that policy only when a
-- channel JOINS and again when the client hands it a new access token. In
-- between it keeps the answer it got: proven against the local Realtime
-- server (v2.143.4), a teacher who joined while active went on broadcasting
-- after their seat turned read-only, until their next token refresh, from
-- which every send was refused. Realtime offers no way to re-ask on each send
-- or to evict one subscriber.
--
-- So the server now acts at the moment a seat changes, rather than waiting for
-- the client to rejoin:
--
--  * public.seat_read_only_since records which accounts are read-only seats,
--    so that the change itself -- not every sweep -- is what acts. It is kept
--    by reconcile_studio_seats(), which every event that can move a seat
--    already runs (an override, a subscription write, a pick, a removal) and
--    the hourly sweep runs for what only the clock moves (an invoice grace
--    period running out).
--  * When an account becomes a read-only seat, every score it can write on
--    (its own, and those it edits) gets the membership hint on its live topic.
--    The app re-reads its access on that hint -- now its seat too
--    (caller_seat_read_only) -- drops to view only and restarts its channel,
--    which Realtime authorizes afresh: no more live ink. The same hint goes
--    out when the seat is active again, so the app leaves view only at once.
--  * A client that ignores the hint is cut off by topic rotation where the
--    database has it: PR #63 (content moderation, merged before this one in
--    the binding order) adds public.rotate_document_realtime(uuid), which moves
--    a score's realtime to a new topic that the policies admit only fresh
--    joins to, so a channel authorized before the change is left on a topic
--    nobody else is on. Called when present, so this migration stands on its
--    own and gains the eviction the moment #63's is applied before it. Without
--    it, such a client keeps its cached permission only until its access
--    token is refreshed or expires (jwt_expiry, an hour): Realtime refuses
--    every send after a refresh and closes the channel at expiry.
--
-- Nothing here changes who may read: a read-only seat still joins, receives
-- and appears in presence.

-- ---------------------------------------------------------------------------
-- Who is a read-only seat
-- ---------------------------------------------------------------------------
create table if not exists public.seat_read_only_since (
    user_id uuid primary key references auth.users (id) on delete cascade,
    since timestamptz not null default now()
);

alter table public.seat_read_only_since enable row level security;

revoke all on table public.seat_read_only_since from public;
revoke all on table public.seat_read_only_since from anon;
revoke all on table public.seat_read_only_since from authenticated;
grant select on table public.seat_read_only_since to service_role;

-- ---------------------------------------------------------------------------
-- Telling the account's open scores, and cutting off a stale channel
-- ---------------------------------------------------------------------------
-- Every score p_user can write on: their own and those they are an editor of.
-- On each score's live topic -- #63's current one when it has rotated it -- the
-- membership hint the app already follows (document_members_broadcast's
-- payload: it re-reads its access and never trusts the payload). With
-- p_rotate, and #63's rotation present, the score moves to a new topic too.
create or replace function public.seat_live_ink_notify (p_user uuid, p_rotate boolean) returns int
language plpgsql security definer
set search_path = public as $$
declare
    v_doc uuid;
    v_role text;
    v_topic text;
    v_live_topic boolean := to_regprocedure('public.document_live_topic(uuid)') is not null;
    v_rotate boolean := p_rotate and to_regprocedure('public.rotate_document_realtime(uuid)') is not null;
    v_count int := 0;
begin
    for v_doc, v_role in
        select d.id, 'owner' from public.documents d where d.owner_id = p_user
        union
        select dm.document_id, dm.role from public.document_members dm
        where dm.user_id = p_user and dm.role in ('owner', 'editor')
        order by 1
    loop
        if v_live_topic then
            execute 'select public.document_live_topic ($1)' into v_topic using v_doc;
        else
            v_topic := 'doc:' || v_doc::text;
        end if;

        perform realtime.send (
            jsonb_build_object('table', 'document_members', 'document_id', v_doc, 'user_id', p_user, 'role', v_role),
            'membership', -- event
            v_topic, -- topic
            true -- private
        );

        if v_rotate then
            execute 'select public.rotate_document_realtime ($1)' using v_doc;
        end if;
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;

-- Records the seat's state and acts only on a change: read-only now and not
-- before -- hint and rotate; active again -- hint.
create or replace function public.seat_live_ink_follow (p_user uuid, p_read_only boolean) returns void
language plpgsql security definer
set search_path = public as $$
begin
    if p_read_only then
        insert into public.seat_read_only_since (user_id) values (p_user) on conflict (user_id) do nothing;
        if found then
            perform public.seat_live_ink_notify (p_user, true);
        end if;
    else
        delete from public.seat_read_only_since s where s.user_id = p_user;
        if found then
            perform public.seat_live_ink_notify (p_user, false);
        end if;
    end if;
end;
$$;

revoke all on function public.seat_live_ink_notify (uuid, boolean) from public;
revoke all on function public.seat_live_ink_notify (uuid, boolean) from anon;
revoke all on function public.seat_live_ink_notify (uuid, boolean) from authenticated;

revoke all on function public.seat_live_ink_follow (uuid, boolean) from public;
revoke all on function public.seat_live_ink_follow (uuid, boolean) from anon;
revoke all on function public.seat_live_ink_follow (uuid, boolean) from authenticated;

-- ---------------------------------------------------------------------------
-- Where seats move
-- ---------------------------------------------------------------------------
-- Redefined from 20261020180500: the same walk over every member, which now
-- also records each member's seat and acts on a change.
create or replace function public.reconcile_studio_seats (p_studio uuid) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_member uuid;
    v_read_only boolean;
    v_moved int := 0;
begin
    for v_member in
        select sm.user_id
        from public.studio_members sm
        join auth.users u on u.id = sm.user_id
        where sm.studio_id = p_studio
        order by sm.user_id
    loop
        v_read_only := coalesce((public.resolve_entitlements (v_member) ->> 'seat_read_only')::boolean, false);
        if v_read_only then
            v_moved := v_moved + public.apply_free_tier_archival (v_member);
        else
            v_moved := v_moved + public.restore_user_plan_archived_scores (v_member);
        end if;
        perform public.seat_live_ink_follow (v_member, v_read_only);
    end loop;
    return v_moved;
end;
$$;

revoke all on function public.reconcile_studio_seats (uuid) from public;
revoke all on function public.reconcile_studio_seats (uuid) from anon;
revoke all on function public.reconcile_studio_seats (uuid) from authenticated;
grant execute on function public.reconcile_studio_seats (uuid) to service_role;

-- Redefined from 20261020180500: a removed member is no longer walked by the
-- studio's reconcile, so their own seat is followed here.
create or replace function public.studio_members_release_seat () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if exists (select 1 from auth.users u where u.id = old.user_id) then
        perform public.restore_user_plan_archived_scores (old.user_id);
        perform public.seat_live_ink_follow (old.user_id, public.seat_read_only (old.user_id));
    end if;
    if exists (select 1 from public.studios st where st.id = old.studio_id) then
        perform public.reconcile_studio_seats (old.studio_id);
    end if;
    return null;
end;
$$;

revoke all on function public.studio_members_release_seat () from public;
revoke all on function public.studio_members_release_seat () from anon;
revoke all on function public.studio_members_release_seat () from authenticated;
