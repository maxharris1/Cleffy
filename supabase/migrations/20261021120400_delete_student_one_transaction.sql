-- Delete student: revoke and scrub in one transaction, serialized against the
-- student's own writes.
--
-- 20261021120200 scrubbed first and revoked after, in separate transactions
-- (student-provision called scrub_student_markings, then end_student_sessions).
-- An active student could draw a mark in between: it committed after the scrub
-- had looked, the account deletion then cleared its author (ON DELETE SET NULL,
-- 20261007120600), and nothing could ever tell it was the student's again.
--
-- Revoking first is not enough on its own either. RLS reads the roster row with
-- the writing statement's snapshot, so an insert that began just before the
-- revocation committed still passes its policy check, and can commit after a
-- scrub that ran in the meantime. So two parts:
--
--  1. Every annotation or lesson-history write by a roster student takes a
--     FOR SHARE lock on their managed_students row and re-reads it under that
--     lock (student_write_allowed). A locked read sees the latest committed
--     row, not the statement's snapshot. The trigger is per STATEMENT, so the
--     roster row is locked before any annotation row is: the same order the
--     deletion takes them in, so the two cannot deadlock.
--  2. revoke_and_scrub_student() takes FOR UPDATE on the same row, then
--     archives it, ends the student's sessions (stamping access_revoked_at)
--     and scrubs their markings, all before it commits. A write already
--     holding the share lock finishes first and its mark is there for the
--     scrub to find; a write that arrives later waits for the commit and is
--     then refused, because the row it re-reads is archived (or, once the
--     account is deleted, gone).
--
-- Nothing changes for an account without a roster row: the guard is one probe
-- of managed_students' unique student_user_id index, finding nothing.

-- ---------------------------------------------------------------------------
-- 1. The guard on student writes
-- ---------------------------------------------------------------------------
-- About the caller only, like student_access_revoked() (20261010120300), whose
-- reading it repeats on a locked row. VOLATILE, because it locks.
create or replace function public.student_write_allowed () returns boolean language plpgsql volatile security definer
set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    v_archived_at timestamptz;
    v_revoked_at timestamptz;
    v_iat text;
begin
    if v_uid is null then
        return true;
    end if;

    select ms.archived_at, ms.access_revoked_at into v_archived_at, v_revoked_at
    from public.managed_students ms
    where ms.student_user_id = v_uid
    for share;

    if not found then
        -- A token that still calls itself a student, with no roster row behind
        -- it, belonged to a student who has been deleted.
        return coalesce(auth.jwt () -> 'app_metadata' ->> 'user_type', '') <> 'student';
    end if;

    if v_archived_at is not null then
        return false;
    end if;

    if v_revoked_at is null then
        return true;
    end if;

    v_iat := auth.jwt () ->> 'iat';
    if v_iat is null or v_iat !~ '^[0-9]{1,12}(\.[0-9]+)?$' then
        return false;
    end if;

    return to_timestamp(v_iat::double precision) >= v_revoked_at;
end;
$$;

revoke all on function public.student_write_allowed () from public;
grant execute on function public.student_write_allowed () to authenticated, anon;

-- SECURITY INVOKER, so current_user is the writer: the service role, the cron
-- job and the scrub itself are not client writes and are never refused here.
-- A statement trigger: it returns nothing, and runs once per statement (an
-- upsert, or each statement of the batch RPCs) before any row is locked.
create or replace function public.refuse_revoked_student_write () returns trigger language plpgsql
set search_path = public as $$
begin
    if current_user in ('authenticated', 'anon') and not public.student_write_allowed () then
        raise exception 'this student''s access has been withdrawn' using errcode = '42501';
    end if;
    return null;
end;
$$;

revoke all on function public.refuse_revoked_student_write () from public, anon, authenticated;

drop trigger if exists annotations_refuse_revoked_student on public.annotations;

create trigger annotations_refuse_revoked_student before insert or update on public.annotations
for each statement execute function public.refuse_revoked_student_write ();

drop trigger if exists annotation_snapshots_refuse_revoked_student on public.annotation_snapshots;

create trigger annotation_snapshots_refuse_revoked_student before insert on public.annotation_snapshots
for each statement execute function public.refuse_revoked_student_write ();

-- ---------------------------------------------------------------------------
-- 2. Revoke and scrub, in one transaction (student-provision 'delete')
-- ---------------------------------------------------------------------------
-- Service role only, like end_student_sessions, which it calls. Leaves the
-- student archived, signed out everywhere and with no markings; deleting the
-- account afterwards (GoTrue's admin delete) can no longer race a write,
-- because every write from here on is refused. A retry after a failed account
-- deletion runs this again harmlessly.
create or replace function public.revoke_and_scrub_student (p_student uuid) returns jsonb language plpgsql
security definer
set search_path = public as $$
declare
    v_id uuid;
begin
    if coalesce(auth.jwt () ->> 'role', '') <> 'service_role' then
        raise exception 'service role only' using errcode = '42501';
    end if;

    select ms.id into v_id
    from public.managed_students ms
    where ms.student_user_id = p_student
    for update;

    if not found then
        raise exception 'not a roster student' using errcode = 'P0002';
    end if;

    update public.managed_students
    set archived_at = coalesce(archived_at, now())
    where id = v_id;

    perform public.end_student_sessions (p_student);

    return public.scrub_student_markings (p_student);
end;
$$;

revoke all on function public.revoke_and_scrub_student (uuid) from public, anon, authenticated;
grant execute on function public.revoke_and_scrub_student (uuid) to service_role;
