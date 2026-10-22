-- Read-only seats are read-only everywhere, from the moment they are read-only
-- (Codex round-2 review of PR #61, major 1; launch-compliance decision 2).
--
-- 20261020180500 made a seat past its studio's limit read-only in its
-- entitlements, and made its OWN scores read-only by archiving them -- which
-- annotation RLS refuses writes on, but only on the archived score, and only once
-- reconcile_studio_seats() has run. Two gaps:
--
--  * a read-only teacher who is an editor on SOMEONE ELSE's score went on
--    drawing on it indefinitely: that score is not archived, and nothing asked
--    who was writing;
--  * a seat the clock made read-only (an invoice grace period running out, a
--    period ending with no webhook) kept editing its own scores until the hourly
--    sweep archived them.
--
-- So the writer is now asked, at request time, on every write path a read-only
-- seat could otherwise use: marks (insert, update -- which includes a tombstone
-- -- and both batch RPCs, which are SECURITY INVOKER so these policies apply),
-- lesson-history snapshots, live ink on doc:{id}, a score's title and contents,
-- share links and assignments (invites), and seats (studio_invite_member already
-- requires Academy, which a read-only seat does not resolve to). seat_read_only()
-- reads resolve_entitlements(), so the answer is right the instant the clock or
-- a row moves it; the archive stays as it was, for everyone else's writes to a
-- read-only seat's own scores.
--
-- What stays allowed: reading and exporting everything (no read path changes),
-- removing one's own things, and anyone who is not a read-only seat -- a roster
-- student included: a student resolves to tier 'student' with seat_read_only
-- false, so a managed student's Edit access is exactly what it was. The check is
-- on the CALLER's seat, never on the score's owner.
--
-- Restrictive policies, added beside the existing permissive ones rather than
-- re-creating them: a restrictive policy is ANDed with whatever permissive
-- policies a table has, so this file neither copies nor can undo another
-- migration's definition of annotations_insert, doc_topic_send_broadcast and the
-- rest -- the realtime ones especially, which the content-moderation work also
-- tightens.

-- ---------------------------------------------------------------------------
-- Is this user on a read-only seat right now?
-- ---------------------------------------------------------------------------
-- Only a studio member can be: everyone else answers false without resolving
-- entitlements, so the policies below cost a non-member one index probe.
create or replace function public.seat_read_only (p_user uuid) returns boolean language plpgsql stable security definer
set search_path = public as $$
begin
    if p_user is null then
        return false;
    end if;
    if not exists (select 1 from public.studio_members sm where sm.user_id = p_user) then
        return false;
    end if;
    return coalesce((public.resolve_entitlements (p_user) ->> 'seat_read_only')::boolean, false);
end;
$$;

-- The caller's own answer, for policies (written `(select ...)` so it is planned
-- once per statement, not once per row) and for the client, which holds marks it
-- could not upload rather than undoing them (src/sync/syncEngine.ts).
create or replace function public.caller_seat_read_only () returns boolean language sql stable security definer
set search_path = public as $$
    select public.seat_read_only (auth.uid());
$$;

revoke all on function public.seat_read_only (uuid) from public;
revoke all on function public.seat_read_only (uuid) from anon;
revoke all on function public.seat_read_only (uuid) from authenticated;
grant execute on function public.seat_read_only (uuid) to service_role;

revoke all on function public.caller_seat_read_only () from public;
revoke all on function public.caller_seat_read_only () from anon;
grant execute on function public.caller_seat_read_only () to authenticated;
grant execute on function public.caller_seat_read_only () to service_role;

-- ---------------------------------------------------------------------------
-- Marks, lesson history, live ink
-- ---------------------------------------------------------------------------
drop policy if exists annotations_seat_read_only_insert on public.annotations;

create policy annotations_seat_read_only_insert on public.annotations as restrictive for insert to authenticated
with check (not (select public.caller_seat_read_only ()));

-- USING true: a read-only seat still sees every mark it could see. WITH CHECK
-- refuses the write itself, with an error, as an archived score does -- the
-- sync engine keeps a refused change instead of undoing it (see the client).
drop policy if exists annotations_seat_read_only_update on public.annotations;

create policy annotations_seat_read_only_update on public.annotations as restrictive for update to authenticated
using (true)
with check (not (select public.caller_seat_read_only ()));

drop policy if exists annotation_snapshots_seat_read_only_insert on public.annotation_snapshots;

create policy annotation_snapshots_seat_read_only_insert on public.annotation_snapshots as restrictive for insert to authenticated
with check (not (select public.caller_seat_read_only ()));

-- Live ink is broadcast on doc:{id}. Presence stays (a viewer still appears in
-- the presence bar), and so does any other topic.
drop policy if exists doc_topic_seat_read_only_broadcast on realtime.messages;

create policy doc_topic_seat_read_only_broadcast on realtime.messages as restrictive for insert to authenticated
with check (
    realtime.messages.extension is distinct from 'broadcast'
    or realtime.topic () not like 'doc:%'
    or not (select public.caller_seat_read_only ())
);

-- ---------------------------------------------------------------------------
-- Invites
-- ---------------------------------------------------------------------------
drop policy if exists share_links_seat_read_only_insert on public.share_links;

create policy share_links_seat_read_only_insert on public.share_links as restrictive for insert to authenticated
with check (not (select public.caller_seat_read_only ()));

-- assign_score is SECURITY DEFINER (it writes document_members), so no policy
-- reaches it; a trigger does. BEFORE INSERT fires for its upsert's update arm
-- too. auth.uid() is still the caller inside a definer function, and null for
-- the service role, which is never refused.
create or replace function public.refuse_read_only_seat_write () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if public.seat_read_only (auth.uid()) then
        raise exception 'this Academy seat is read-only'
            using errcode = '42501',
                  detail = json_build_object('code', 'seat_read_only')::text,
                  hint = 'The academy''s owner can make this seat active again.';
    end if;
    return new;
end;
$$;

revoke all on function public.refuse_read_only_seat_write () from public;
revoke all on function public.refuse_read_only_seat_write () from anon;
revoke all on function public.refuse_read_only_seat_write () from authenticated;

drop trigger if exists assignments_refuse_read_only_seat on public.assignments;

create trigger assignments_refuse_read_only_seat before insert on public.assignments
for each row execute function public.refuse_read_only_seat_write ();

-- ---------------------------------------------------------------------------
-- A score's own edits
-- ---------------------------------------------------------------------------
-- Renaming a score or replacing its file is an edit. page_count and thumb_rev
-- are not: the viewer backfills them just from opening a score, and refusing
-- them would break viewing. archived_at already answers to the score cap.
create or replace function public.documents_refuse_read_only_seat () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if (new.title is distinct from old.title or new.content_rev is distinct from old.content_rev)
        and public.seat_read_only (auth.uid()) then
        raise exception 'this Academy seat is read-only'
            using errcode = '42501',
                  detail = json_build_object('code', 'seat_read_only')::text,
                  hint = 'The academy''s owner can make this seat active again.';
    end if;
    return new;
end;
$$;

revoke all on function public.documents_refuse_read_only_seat () from public;
revoke all on function public.documents_refuse_read_only_seat () from anon;
revoke all on function public.documents_refuse_read_only_seat () from authenticated;

drop trigger if exists documents_refuse_read_only_seat on public.documents;

create trigger documents_refuse_read_only_seat before update on public.documents
for each row execute function public.documents_refuse_read_only_seat ();
