-- Archiving or resetting a student ends the sessions they already have open.
--
-- Until now both only stopped the NEXT sign-in. 'archive' banned the account,
-- which refuses the password grant and every refresh, and 'reset' scrambled the
-- password. Neither touched a session that was already open: its access token
-- is a signed JWT PostgREST trusts until it expires (an hour), and every
-- membership check -- document_role() and the RLS built on it -- read
-- document_members alone. So an archived student's open tab kept reading and
-- writing the teacher's scores for up to an hour, and a reset student's other
-- devices kept their sign-in for good (nothing stopped them refreshing).
--
-- Three parts, all keyed on the managed_students row, so nothing changes for an
-- account that is not a provisioned student:
--
--  1. student_access_revoked() -- is the CALLER a student whose access is gone:
--     their roster row archived, or the session their JWT names no longer in
--     auth.sessions (ended by a reset, an archive or a global sign-out). The
--     JWT stays cryptographically valid after either; the session row is what
--     says whether it still stands for a sign-in.
--  2. document_role() consults it, so every policy, storage rule and realtime
--     topic check built on document_role() refuses such a caller on the very
--     next request. The student branches of assignments_select and
--     practice_notes_select (which do not go through document_role) do too.
--  3. end_student_sessions(student) -- service role only, called by
--     student-provision on archive and reset: deletes the student's sessions
--     (their refresh tokens cascade), so no device can refresh its way back in,
--     and sends the existing membership hint on every score the student is a
--     member of, so an open viewer re-checks its role at once instead of on its
--     next write.
--
-- Hosted Supabase lets the migration owner (postgres) read and delete
-- auth.sessions / auth.refresh_tokens; the two functions that touch them are
-- plpgsql so creating them does not depend on those tables existing (the local
-- SQL harness stubs them).

-- ---------------------------------------------------------------------------
-- 1. Has the caller's access as a student been withdrawn?
-- ---------------------------------------------------------------------------
-- About the caller only (auth.uid() / auth.jwt()), so granting it to
-- authenticated tells nobody anything about anyone else: the student app asks
-- it to tell "nothing assigned" from "your teacher archived you".
--
-- False for every account with no roster row except a JWT that still calls
-- itself a student (app_metadata is admin-set): a student whose row is gone was
-- deleted with their teacher, and their leftover token should read as revoked.
create or replace function public.student_access_revoked () returns boolean language plpgsql stable security definer
set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    v_archived_at timestamptz;
    v_session text;
begin
    if v_uid is null then
        return false;
    end if;

    select ms.archived_at into v_archived_at
    from public.managed_students ms
    where ms.student_user_id = v_uid;

    if not found then
        return coalesce(auth.jwt () -> 'app_metadata' ->> 'user_type', '') = 'student';
    end if;

    if v_archived_at is not null then
        return true;
    end if;

    -- Every GoTrue access token names its session. A student token without a
    -- readable one cannot be matched to a live sign-in, so it is not one.
    v_session := auth.jwt () ->> 'session_id';
    if v_session is null or v_session !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return true;
    end if;

    return not exists (
        select 1
        from auth.sessions s
        where s.id = v_session::uuid
          and s.user_id = v_uid
    );
end;
$$;

revoke all on function public.student_access_revoked () from public;
revoke all on function public.student_access_revoked () from anon;
grant execute on function public.student_access_revoked () to authenticated;

-- ---------------------------------------------------------------------------
-- 2. document_role() refuses a revoked student
-- ---------------------------------------------------------------------------
-- The helper only runs for a member who HAS a roster row: for everyone else the
-- NOT EXISTS is one probe of managed_students' unique student_user_id index and
-- finds nothing, which matters because RLS calls this once per annotation row.
create or replace function public.document_role (doc uuid) returns text language sql stable security definer
set search_path = public as $$
    select dm.role
    from public.document_members dm
    where dm.document_id = doc
      and dm.user_id = (select auth.uid())
      and not exists (
          select 1
          from public.managed_students ms
          where ms.student_user_id = dm.user_id
            and public.student_access_revoked ()
      );
$$;

drop policy if exists assignments_select on public.assignments;

create policy assignments_select on public.assignments for select to authenticated
using (
    (
        student_user_id = (select auth.uid())
        and not (select public.student_access_revoked ())
    )
    or public.document_role (document_id) = 'owner'
);

drop policy if exists practice_notes_select on public.practice_notes;

create policy practice_notes_select on public.practice_notes for select to authenticated
using (
    author_id = (select auth.uid())
    or (
        shared
        and student_user_id = (select auth.uid())
        and not (select public.student_access_revoked ())
    )
);

-- ---------------------------------------------------------------------------
-- 3. End a student's sessions (student-provision, service role)
-- ---------------------------------------------------------------------------
-- Returns how many sessions were ended. Refuses anyone who is not a roster
-- student: this is the teacher's lever on their own students, not a general
-- "sign anybody out" primitive, even for the service role.
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
            'doc:' || v_doc::text, -- topic
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
