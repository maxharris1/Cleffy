-- Student resets: the email path is fenced like the code path (P3 follow-up:
-- "the email reset path is unfenced").
--
-- A teacher's reset of an email-method student scrambled the password, ended
-- the sessions and mailed a sign-in link with nothing serializing it: two
-- resets at once (a double click, two tabs, a retry after a timeout) could
-- interleave their Auth writes, and a delayed scramble or session revocation
-- from an earlier attempt could land after the student had already used the
-- newer link -- overwriting the password they set, or ending their fresh
-- session. The code path has had a reservation, a worker lease and fences
-- since 20261022110000 .. 20261022110800 (_shared/studentCodeReset.ts).
--
-- Now student-provision runs the email reset through the same machinery:
-- reserve_student_code_reset() (a second reset meanwhile is told it is still
-- finishing, 409), the fence before the password write and again before the
-- session revocation, end_student_sessions_fenced(), the quarantine of a
-- password write whose outcome is unknown, and the resume token. The one step
-- that differs is the end: there is no card, so instead of
-- complete_student_code_reset() it calls complete_student_email_reset(), which
-- checks the same lease, drops the reservation and sends the student back to
-- Invited (claimed_at cleared), as the email path did. The sign-in link is
-- mailed after that, as before; a link that fails to send leaves the safe
-- half-state it always did (the old password is dead) and a rerun sends it.
--
-- Rerunnable: the function is created or replaced with its privileges reset.

-- 'reset' when this lease still owns the reset of an email-method student: the
-- reservation goes and claimed_at is cleared. 'lost' otherwise; nothing is
-- written then. Refuses a code-method row (22023): dropping its reservation
-- without a new card would make the old card claimable again.
create or replace function public.complete_student_email_reset (
    p_student uuid,
    p_reservation uuid,
    p_worker uuid,
    p_epoch bigint
) returns text language plpgsql security definer
set search_path = public as $$
declare
    v_row public.managed_students;
    v_held public.student_claim_reservations;
begin
    -- The roster row first, then the reservation: the order every function on
    -- these rows takes (20261022110000).
    select * into v_row from public.managed_students where id = p_student for update;
    if not found then
        return 'lost';
    end if;
    if v_row.auth_method is distinct from 'email' then
        raise exception 'complete_student_email_reset is for email-method students only' using errcode = '22023';
    end if;
    select * into v_held from public.student_claim_reservations where student_id = p_student for update;
    if not found or not public.student_code_reset_owned (v_row, v_held, p_reservation, p_worker, p_epoch) then
        return 'lost';
    end if;
    delete from public.student_claim_reservations where student_id = p_student;
    update public.managed_students set claimed_at = null where id = p_student;
    return 'reset';
end;
$$;

revoke all on function public.complete_student_email_reset (uuid, uuid, uuid, bigint) from public, anon, authenticated;

grant execute on function public.complete_student_email_reset (uuid, uuid, uuid, bigint) to service_role;

-- DEPLOY: apply before deploying student-provision (it calls this on the email
-- path). An older student-provision never calls it.
