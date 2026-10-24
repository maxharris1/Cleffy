-- end_student_sessions() takes the roster row before the student's tokens and
-- sessions (launch-fix follow-up 17).
--
-- 20261020150100's definition deleted auth.refresh_tokens and auth.sessions
-- first and updated the roster row (access_revoked_at) last. The retention
-- run's soft delete, and district_retention_list_late() (20261021120700,
-- 20261022130400), lock the students' roster rows first and then delete their
-- tokens and sessions: the reverse. A student archived or reset by their
-- teacher (student-provision, through end_student_sessions) while a district
-- soft delete reached them could leave each transaction holding what the other
-- wanted next, and PostgreSQL aborted one with `deadlock detected`. Now the
-- function locks the roster row (FOR UPDATE) before it touches anything else,
-- so both wait for each other's commit instead.
--
-- Nothing else changes: the tokens and sessions are deleted, then
-- access_revoked_at is stamped on the clock after the deletes, then the
-- membership hints go out, exactly as before. end_student_sessions_fenced
-- (20261022110800) already holds the row when it calls this. GoTrue's own
-- writes take tokens and sessions and never a roster row, so no new order is
-- introduced.
--
-- Rerunnable: the function is replaced with the same signature and its
-- privileges reset to the same end state.

-- 20261020150100's definition, the roster row locked first.
create or replace function public.end_student_sessions (p_student uuid) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_ended int;
    v_doc uuid;
begin
    if coalesce(auth.jwt () ->> 'role', '') <> 'service_role' then
        raise exception 'service role only' using errcode = '42501';
    end if;

    -- The roster row first (20261022140900): the order the retention run
    -- takes (roster rows, then the student's tokens and sessions), and the
    -- reset and claim functions (roster row, then the reservation). Taking the
    -- tokens first and the row last deadlocked with a soft delete of the same
    -- student, each holding what the other wanted next.
    perform 1
    from public.managed_students ms
    where ms.student_user_id = p_student
    for update;
    if not found then
        raise exception 'not a roster student' using errcode = 'P0002';
    end if;

    -- Then the tokens, by user: GoTrue's would cascade from their session, but one
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

revoke all on function public.end_student_sessions (uuid) from public, anon, authenticated;

grant execute on function public.end_student_sessions (uuid) to service_role;

-- DEPLOY: no order constraint, no edge function change.
