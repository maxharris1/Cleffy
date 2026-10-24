-- Student code resets: a safe, idempotent way to clear stale
-- app_metadata.code_reset_worker markers (decision 64(1)'s follow-up).
--
-- A code reset's password scramble writes app_metadata.code_reset_worker =
-- <its worker id> in the same Auth update (20261022110800), so the worker, or
-- a retry presenting the reset's token, can tell that a write whose answer was
-- lost has landed. The marker matters only while that reset holds the student:
-- a live student_claim_reservations row (reserved_until in the future). Once
-- the reset completed (its reservation goes), was taken over, or its hold ran
-- out (600 s, longer than an Edge Function can run, so nothing of it is still
-- in flight), nothing reads it again: a new reset writes its own marker, and
-- reserve_student_code_reset() answers 'busy' (the only answer the marker
-- confirms) only under a live hold. Decision 64 left these markers for now as
-- harmless; this clears them.
--
-- clear_stale_code_reset_markers() removes the key, and nothing else of
-- app_metadata, from each account that carries one, only when no live
-- reservation holds its roster row:
--   * under the roster row's lock, then the reservation's (FOR UPDATE), the
--     order every reset and claim function takes (20261022110000), so a reset
--     starting meanwhile waits for this and writes its marker afterwards, and
--     one already holding the student is never touched;
--   * the roster row is taken SKIP LOCKED: a row someone is working on is
--     passed over until the next call;
--   * the account's own auth.users row is taken last, FOR UPDATE NOWAIT, and
--     never waited for: an Auth account deletion holds that row and then
--     waits, through managed_students' ON DELETE CASCADE, for the roster row
--     this holds, the inverse order (PR #72 fix 2). Busy, the candidate is
--     passed over until the next call, and the locks taken for it (roster
--     row, reservation) are let go at once with its subtransaction, so the
--     deletion goes straight on rather than deadlocking with this;
--   * the marker is removed only if it still names the worker read under those
--     locks, so a call never removes a marker newer than the one it judged;
--   * an account with a marker and no roster row (the student was deleted, or
--     never rostered) has no reset to hold it: cleared.
-- Idempotent: a second call finds nothing to clear. Returns how many it
-- cleared. At most p_limit accounts per call (default 500), in user id order.
--
-- Not scheduled here (as the other cleanups are first run by hand): run
-- `select public.clear_stale_code_reset_markers();` as the service role or
-- postgres, any time, as often as wanted. A JWT issued before the call keeps
-- the old claim until it is refreshed; nothing reads it there.
--
-- Rerunnable: the function is replaced with the same signature and its
-- privileges reset to the same end state.

create or replace function public.clear_stale_code_reset_markers (p_limit integer default 500) returns integer
language plpgsql security definer
set search_path = public, auth as $$
declare
    v_user record;
    v_roster uuid;
    v_marker text;
    v_live boolean;
    v_cleared integer := 0;
begin
    for v_user in
        select u.id
        from auth.users u
        where u.raw_app_meta_data ? 'code_reset_worker'
        order by u.id
        limit greatest(coalesce(p_limit, 500), 0)
    loop
        -- One subtransaction per candidate: leaving it by lock_not_available
        -- lets go of every lock taken for this candidate.
        begin
            v_roster := null;
            select ms.id into v_roster
            from public.managed_students ms
            where ms.student_user_id = v_user.id
            for update skip locked;
            if not found and exists (select 1 from public.managed_students ms where ms.student_user_id = v_user.id) then
                continue; -- someone is working on this student: the next call
            end if;

            v_live := false;
            if v_roster is not null then
                select r.reserved_until > now() into v_live
                from public.student_claim_reservations r
                where r.student_id = v_roster
                for update;
                v_live := coalesce(v_live, false);
            end if;
            if v_live then
                continue; -- a reset or claim holds the student: its marker may still be read
            end if;

            -- Never waited for (see above): busy raises lock_not_available.
            v_marker := null;
            select u.raw_app_meta_data ->> 'code_reset_worker' into v_marker
            from auth.users u
            where u.id = v_user.id
            for update nowait;
            update auth.users u
            set raw_app_meta_data = u.raw_app_meta_data - 'code_reset_worker'
            where u.id = v_user.id
              and u.raw_app_meta_data ->> 'code_reset_worker' is not distinct from v_marker
              and v_marker is not null;
            if found then
                v_cleared := v_cleared + 1;
            end if;
        exception when lock_not_available then
            null; -- the account is busy (an Auth deletion or update): the next call
        end;
    end loop;
    return v_cleared;
end;
$$;

revoke all on function public.clear_stale_code_reset_markers (integer) from public, anon, authenticated;

grant execute on function public.clear_stale_code_reset_markers (integer) to service_role;

-- DEPLOY: no order constraint, no edge function change. Run it by hand when
-- wanted (DEPLOY.md, P3 runbooks); nothing schedules it.
