-- Revocation rotation under concurrency, and archived scores (Codex round 1 on
-- #71, launchfix P4 fix round 1).
--
-- 20261022120000 moves a score to its next realtime topic generation whenever
-- someone loses it. What it left open, closed here:
--
--  1. A grant racing a student's revocation escaped it. The revocation (an
--     archive, end_student_sessions' stamp after a reset, the district soft
--     delete) queues every score the student is on when it writes their roster
--     row; an assignment committed while that write was still open was not
--     among them, and assign_score's roster check, a plain read, still saw the
--     student as active. So the student joined the new score's topics on a
--     token the revocation was about to refuse, and nothing ever moved them.
--     Now every grant takes the student's roster row FOR SHARE first (a
--     BEFORE INSERT trigger on assignments and on document_members, whatever
--     path writes them: assign_score, redeem_share_link, a score's owner row),
--     the row each revocation holds FOR UPDATE through its write. One of two
--     things happens, whichever locks first:
--       - the grant: the revocation waits for it to commit, and its trigger,
--         reading afresh (READ COMMITTED: a new snapshot per statement), finds
--         the new membership and rotates that score too;
--       - the revocation: the grant waits for it to commit, then re-reads the
--         row. An archived student's assignment is refused (`not on your
--         roster`, as assign_score says); after a reset the grant goes
--         through, and document_role() refuses every token from before the
--         reset there as everywhere (student_access_revoked).
--     The revoking callers run READ COMMITTED (PostgREST, the retention cron);
--     under REPEATABLE READ the trigger's read would keep the transaction's
--     first snapshot.
--
--  2. A revocation and the score's deletion could deadlock. The commit-time
--     rotation took the score's row FOR KEY SHARE (and the generation's
--     foreign key would have taken it anyway) while the revoking transaction
--     still held the membership row it deleted or demoted; deleting the score
--     locks the score first, then waits on that membership row through the ON
--     DELETE CASCADE. Neither can go first, so PostgreSQL aborted one. Now the
--     rotation never waits on the score: document_realtime_epochs loses its
--     foreign key (a trigger on documents removes the generation instead,
--     after every cascade, so a deletion still leaves nothing behind) and the
--     queued rotation checks with a plain read that the score still exists.
--     A rotation racing a deletion may leave a generation row naming no
--     score; nothing reads it.
--
--  3. Two rotations racing announced the same old topic. rotate_document_realtime
--     (20261020150100) read the current topics before its upsert took the
--     generation's row lock: two that both read generation 0 serialized into
--     1 and 2, and both told generation 0, so whoever had already moved to 1
--     missed the second. Now the bump comes first, under that lock, and the
--     hint goes to the generation it replaced (the new one minus one).
--
--  4. An archived score kept its realtime. Archiving (billing, past the plan's
--     score cap) makes a score read-only -- RLS refuses every annotation write
--     -- but the realtime.messages policies never asked, so a member could go
--     on sending and hearing live ink on it. Now the topic resolvers the
--     policies call answer null for an archived score (no join, no send, no
--     presence), realtime_topic_epoch answers null too (the app stops its
--     channels instead of retrying a join that is refused), and archiving
--     rotates the score so the channels already joined are told to move.
--     Restoring moves nothing: the members join again when they next open it.
--
-- What a rotation does not do: Realtime keeps the permissions it checked when
-- a channel joined until that client hands it a new access token, and it has
-- no way to evict a subscriber. A socket that ignores `topic_rotated` stays on
-- the old generation until its token expires (jwt_expiry = 3600 s in
-- supabase/config.toml, so up to about an hour), able to send and receive
-- there; but the server sends only on the new generation, and the app leaves
-- the old topics as soon as it is told (src/sync/realtimeChannel.ts), so all
-- it can reach is other clients that ignore the hint too. Accepted (decisions
-- 23, 24 and 31).
--
-- tests/sql/realtime_revocation_rotation.sql (single transaction) and
-- tests/sql/realtime_revocation_race.sql (two dblink sessions, committed) prove
-- it against a database; tests/realtimeRevocationRotation.test.ts keeps the
-- pieces from drifting.

-- ---------------------------------------------------------------------------
-- 1. Grants wait for a student's revocation, and a revocation for grants
-- ---------------------------------------------------------------------------
-- The student's roster row, locked FOR SHARE (it conflicts with the FOR
-- UPDATE / FOR NO KEY UPDATE a revocation's write holds until commit, not with
-- another grant's or student_write_allowed's share lock), and whether it is
-- archived as of the latest commit: a locked read sees that, not the
-- statement's snapshot. False, after one probe of the unique index, for an
-- account without a roster row. VOLATILE, because it locks.
create or replace function public.lock_student_for_grant (p_user uuid) returns boolean language plpgsql volatile security definer
set search_path = public as $$
declare
    v_archived boolean;
begin
    select ms.archived_at is not null into v_archived
    from public.managed_students ms
    where ms.student_user_id = p_user
    for share;
    return coalesce(v_archived, false);
end;
$$;

revoke all on function public.lock_student_for_grant (uuid) from public;
revoke all on function public.lock_student_for_grant (uuid) from anon;
revoke all on function public.lock_student_for_grant (uuid) from authenticated;

-- assign_score refuses an archived student before it writes; this is the same
-- refusal on the row it re-reads under the lock. BEFORE INSERT fires for an
-- INSERT ... ON CONFLICT DO UPDATE too, so a re-assignment locks as well.
create or replace function public.assignments_lock_student () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if public.lock_student_for_grant (new.student_user_id) then
        raise exception 'not on your roster' using errcode = 'P0002';
    end if;
    return new;
end;
$$;

revoke all on function public.assignments_lock_student () from public;
revoke all on function public.assignments_lock_student () from anon;
revoke all on function public.assignments_lock_student () from authenticated;

drop trigger if exists assignments_lock_student on public.assignments;
create trigger assignments_lock_student
before insert on public.assignments
for each row
execute function public.assignments_lock_student ();

-- Every membership: an assignment's, a redeemed link's, a score's owner row.
-- Only the lock: what an archived or reset student may do with the membership
-- is document_role()'s to say, at every request and every join.
create or replace function public.document_members_lock_student () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    perform public.lock_student_for_grant (new.user_id);
    return new;
end;
$$;

revoke all on function public.document_members_lock_student () from public;
revoke all on function public.document_members_lock_student () from anon;
revoke all on function public.document_members_lock_student () from authenticated;

drop trigger if exists document_members_lock_student on public.document_members;
create trigger document_members_lock_student
before insert on public.document_members
for each row
execute function public.document_members_lock_student ();

-- ---------------------------------------------------------------------------
-- 2. The rotation never waits on the score's row
-- ---------------------------------------------------------------------------
alter table public.document_realtime_epochs
drop constraint if exists document_realtime_epochs_document_id_fkey;

-- What the foreign key's ON DELETE CASCADE did. AFTER triggers fire in name
-- order and the cascades' internal triggers (RI_ConstraintTrigger_*) sort
-- first, so a deletion takes the generation's row only once it holds every
-- membership row -- never before waiting on a revocation that will itself
-- write the generation at commit.
create or replace function public.documents_forget_realtime_epoch () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    delete from public.document_realtime_epochs e where e.document_id = old.id;
    return null;
end;
$$;

revoke all on function public.documents_forget_realtime_epoch () from public;
revoke all on function public.documents_forget_realtime_epoch () from anon;
revoke all on function public.documents_forget_realtime_epoch () from authenticated;

drop trigger if exists documents_forget_realtime_epoch on public.documents;
create trigger documents_forget_realtime_epoch
after delete on public.documents
for each row
execute function public.documents_forget_realtime_epoch ();

-- 20261022120000's commit-time rotation, without the lock on the score.
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
        -- A plain read: a lock here would wait on a deletion that is waiting
        -- on this transaction's membership rows. A score deleted since it was
        -- queued has no topics left to move.
        if exists (select 1 from public.documents d where d.id = v_doc) then
            perform public.rotate_document_realtime (v_doc);
        end if;
    end loop;
    return null;
end;
$$;

revoke all on function public.rotate_queued_document_realtime () from public;
revoke all on function public.rotate_queued_document_realtime () from anon;
revoke all on function public.rotate_queued_document_realtime () from authenticated;

-- ---------------------------------------------------------------------------
-- 3. Bump, then announce on the generation the bump replaced
-- ---------------------------------------------------------------------------
-- A score's topic at generation p_epoch: document_live_topic /
-- document_db_topic for a generation already known.
create or replace function public.document_topic_at (p_prefix text, doc uuid, p_epoch integer) returns text language sql immutable
set search_path = public as $$
    select p_prefix || ':' || doc::text || case when p_epoch = 0 then '' else ':' || p_epoch::text end;
$$;

revoke all on function public.document_topic_at (text, uuid, integer) from public;
revoke all on function public.document_topic_at (text, uuid, integer) from anon;
revoke all on function public.document_topic_at (text, uuid, integer) from authenticated;

-- 20261020150100's rotation. The upsert holds the generation's row until
-- commit, and a second rotation's upsert waits for it and then bumps the
-- committed value, so the generation it returns is always one past the one
-- the caller's clients are on.
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
    return v_epoch;
end;
$$;

revoke all on function public.rotate_document_realtime (uuid) from public;
revoke all on function public.rotate_document_realtime (uuid) from anon;
revoke all on function public.rotate_document_realtime (uuid) from authenticated;

-- ---------------------------------------------------------------------------
-- 4. No realtime on an archived score
-- ---------------------------------------------------------------------------
-- 20261020150100's resolvers, which every realtime.messages policy calls
-- (receive, presence, live ink): null for an archived score as well.
create or replace function public.topic_document_role (topic text) returns text language plpgsql stable security definer
set search_path = public as $$
declare
    doc uuid;
begin
    if topic not like 'doc:%' then
        return null;
    end if;
    doc := public.realtime_topic_document (topic, 'doc');
    if doc is null or public.document_is_archived (doc) then
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
    if doc is null or public.document_is_archived (doc) then
        return null;
    end if;
    return public.document_role(doc);
end;
$$;

grant execute on function public.topic_document_role (text) to authenticated;
revoke all on function public.db_topic_document_role (text) from public;
revoke all on function public.db_topic_document_role (text) from anon;
grant execute on function public.db_topic_document_role (text) to authenticated;

-- Null whenever a join would be refused, so the app stops rather than retries.
create or replace function public.realtime_topic_epoch (p_document uuid) returns integer language sql stable security definer
set search_path = public as $$
    select case
        when public.document_role (p_document) is not null and not public.document_is_archived (p_document)
            then public.document_realtime_epoch (p_document)
    end;
$$;

revoke all on function public.realtime_topic_epoch (uuid) from public;
revoke all on function public.realtime_topic_epoch (uuid) from anon;
grant execute on function public.realtime_topic_epoch (uuid) to authenticated;

-- Archiving moves the score, at commit like every other revocation (a plan
-- downgrade that archives a hundred scores rotates each once).
create or replace function public.documents_queue_rotation_on_archive () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    perform public.queue_document_realtime_rotation (new.id);
    return null;
end;
$$;

revoke all on function public.documents_queue_rotation_on_archive () from public;
revoke all on function public.documents_queue_rotation_on_archive () from anon;
revoke all on function public.documents_queue_rotation_on_archive () from authenticated;

drop trigger if exists documents_rotate_on_archive on public.documents;
create trigger documents_rotate_on_archive
after update of archived_at on public.documents
for each row
when (old.archived_at is null and new.archived_at is not null)
execute function public.documents_queue_rotation_on_archive ();
