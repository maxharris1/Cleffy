-- Access that ends cuts off the score's realtime at once, not at the next
-- token refresh (launch re-audit SF-4).
--
-- Realtime authorizes a private channel when it JOINS, and again only when the
-- client hands it a new access token (20261020150100, top). Until now a member
-- who lost a score only got a hint: broadcast_membership_changes and
-- end_student_sessions ask the app to re-check, but a client that ignored it
-- kept receiving the owner's live ink on doc:{id} and every committed mark on
-- doc-db:{id} -- and an editor turned viewer kept SENDING live ink -- until its
-- token ran out (up to jwt_expiry, an hour). The paths that only hinted:
--
--  * set_document_member_role, editor -> viewer          (20261007120000)
--  * remove_document_member, leave_document              (20261007120000)
--  * revoke_share_link with p_remove_members             (20261007120000)
--  * unassign_score; assign_score flipping to view-only  (20260826194426)
--  * a student's access ending: archive and reset (student-provision, through
--    end_student_sessions, 20261020150100) and the district soft delete
--    (district_retention_run, 20261021120700)
--
-- Each now also moves the score to its next topic generation, the takedown's
-- rotation (rotate_document_realtime, 20261020150100): the realtime.messages
-- policies admit a join only on the current generation and only for a member
-- document_role() still answers for, so whoever lost access is left on topics
-- nobody talks on, whatever their app does. Everyone who keeps access is told
-- `topic_rotated` on the old topics, re-reads the generation and rejoins
-- (src/sync/realtimeChannel.ts); the rejoin's gap-fill pull covers whatever was
-- committed in between. An editor turned viewer rejoins as a viewer, and the
-- join policy lets only an owner or editor broadcast (20260801162310).
--
-- Where it hooks in is the data, not the functions: every path above ends in a
-- write to document_members (a delete, or a role that loses write) or to
-- managed_students (archived_at / access_revoked_at), so the triggers below
-- catch them all, and anything later that writes the same rows, without
-- redefining a function another migration owns.
--
-- Batched: a write only QUEUES the score, and a deferred trigger rotates each
-- queued score once, when the transaction commits -- after every hint the
-- transaction sent, so those still go out on the topic their member is on. A
-- revoke that withdraws twenty members, or a district soft delete that ends
-- hundreds of students, rotates each score once. A rotation costs every member
-- still on the score one generation read and one rejoin; nothing rotates when
-- access is gained, or when a score is deleted.
--
-- tests/sql/realtime_revocation_rotation.sql proves every path against a
-- database; tests/realtimeRevocationRotation.test.ts keeps the triggers
-- from drifting; src/sync/realtimeChannel.test.ts covers the client.

-- ---------------------------------------------------------------------------
-- The queue: scores whose access shrank in this transaction
-- ---------------------------------------------------------------------------
-- Keyed by transaction, so concurrent revocations never wait on each other's
-- rows; every row is removed by the commit-time rotation of its own
-- transaction, so the table is empty outside one.
create table if not exists public.document_realtime_rotation_queue (
    xact xid8 not null default pg_current_xact_id (),
    document_id uuid not null,
    primary key (xact, document_id)
);

alter table public.document_realtime_rotation_queue enable row level security;
revoke all on public.document_realtime_rotation_queue from public;
revoke all on public.document_realtime_rotation_queue from anon;
revoke all on public.document_realtime_rotation_queue from authenticated;

-- Internal: the triggers below call it.
create or replace function public.queue_document_realtime_rotation (p_document uuid) returns void language sql security definer
set search_path = public as $$
    insert into public.document_realtime_rotation_queue (document_id)
    values (p_document)
    on conflict do nothing;
$$;

revoke all on function public.queue_document_realtime_rotation (uuid) from public;
revoke all on function public.queue_document_realtime_rotation (uuid) from anon;
revoke all on function public.queue_document_realtime_rotation (uuid) from authenticated;

-- At commit: rotate every score this transaction queued, once each. The first
-- firing takes the whole transaction's queue, in id order (so two commits
-- never lock the same scores' generations in opposite orders); the rest find
-- it empty. A score deleted since it was queued has no topics left to move.
create or replace function public.rotate_queued_document_realtime () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_docs uuid[];
    v_doc uuid;
begin
    select coalesce(array_agg(q.document_id order by q.document_id), '{}') into v_docs
    from public.document_realtime_rotation_queue q
    where q.xact = pg_current_xact_id ();

    if cardinality(v_docs) = 0 then
        return null;
    end if;

    delete from public.document_realtime_rotation_queue q
    where q.xact = pg_current_xact_id ();

    foreach v_doc in array v_docs loop
        -- Held against a concurrent delete until commit, so the generation's
        -- foreign key cannot fail the revocation that queued it.
        perform 1 from public.documents d where d.id = v_doc for key share;
        if found then
            perform public.rotate_document_realtime (v_doc);
        end if;
    end loop;
    return null;
end;
$$;

revoke all on function public.rotate_queued_document_realtime () from public;
revoke all on function public.rotate_queued_document_realtime () from anon;
revoke all on function public.rotate_queued_document_realtime () from authenticated;

drop trigger if exists document_realtime_rotation_queue_rotate on public.document_realtime_rotation_queue;
create constraint trigger document_realtime_rotation_queue_rotate
after insert on public.document_realtime_rotation_queue
deferrable initially deferred
for each row
execute function public.rotate_queued_document_realtime ();

-- ---------------------------------------------------------------------------
-- A member loses the score, or loses write on it
-- ---------------------------------------------------------------------------
-- Beside document_members_broadcast (the hint), which this leaves as it is.
create or replace function public.document_members_queue_rotation () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    perform public.queue_document_realtime_rotation (old.document_id);
    return null;
end;
$$;

revoke all on function public.document_members_queue_rotation () from public;
revoke all on function public.document_members_queue_rotation () from anon;
revoke all on function public.document_members_queue_rotation () from authenticated;

drop trigger if exists document_members_rotate_on_delete on public.document_members;
create trigger document_members_rotate_on_delete
after delete on public.document_members
for each row
execute function public.document_members_queue_rotation ();

-- Only a change that takes write away: an owner's or editor's channel may
-- broadcast live ink, and keeps that permission until it rejoins.
drop trigger if exists document_members_rotate_on_downgrade on public.document_members;
create trigger document_members_rotate_on_downgrade
after update of role on public.document_members
for each row
when (old.role in ('owner', 'editor') and new.role not in ('owner', 'editor'))
execute function public.document_members_queue_rotation ();

-- ---------------------------------------------------------------------------
-- A student's access ends
-- ---------------------------------------------------------------------------
-- archived_at or access_revoked_at makes document_role() refuse the student
-- (student_access_revoked) on every score: every score they are a member of
-- or assigned to moves. Not when the student was already archived, who had no
-- access left to end (archiving stamps archived_at and then runs
-- end_student_sessions, which would otherwise move every score twice).
create or replace function public.managed_students_queue_rotation () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_doc uuid;
begin
    for v_doc in
        select dm.document_id from public.document_members dm where dm.user_id = new.student_user_id
        union
        select a.document_id from public.assignments a where a.student_user_id = new.student_user_id
    loop
        perform public.queue_document_realtime_rotation (v_doc);
    end loop;
    return null;
end;
$$;

revoke all on function public.managed_students_queue_rotation () from public;
revoke all on function public.managed_students_queue_rotation () from anon;
revoke all on function public.managed_students_queue_rotation () from authenticated;

drop trigger if exists managed_students_rotate_on_access_end on public.managed_students;
create trigger managed_students_rotate_on_access_end
after update of archived_at, access_revoked_at on public.managed_students
for each row
when (
    old.archived_at is null
    and (
        new.archived_at is not null
        or (new.access_revoked_at is not null and new.access_revoked_at is distinct from old.access_revoked_at)
    )
)
execute function public.managed_students_queue_rotation ();
