-- Teacher resets of a student's card: an Auth write whose outcome is unknown
-- quarantines the attempt (Codex r3 on #70; decision 61).
--
-- 20261022110700_student_code_reset_worker.sql made every attempt take its own
-- worker lease and stay "inside an Auth call" (worker_in_auth) from its fence
-- until it reported back. But the worker reported back on ANY failed password
-- write, including a dropped connection or a timeout, where GoTrue may still
-- apply the write afterwards:
--
--   1. worker A passed its fence and sent the password scramble;
--   2. the transport failed: A saw an error, while the request could still
--      commit at Auth;
--   3. A reported back (stop_student_code_reset_worker), clearing
--      worker_in_auth, and handed the teacher the resume token;
--   4. retry B took a fresh lease at once, completed, and the student claimed
--      B's card and chose a password;
--   5. A's password write committed after that, overwriting it.
--
-- Now (../functions/_shared/studentCodeReset.ts) only a DEFINITE refusal (a
-- 4xx from Auth other than 408) reports back at once. Any other failure leaves
-- worker_in_auth set: the attempt is quarantined. Nothing here changes for
-- that -- the worker simply does not call stop_student_code_reset_worker -- and
-- the quarantine ends one of two ways:
--
--   * the write is CONFIRMED. The scramble writes a marker into the same Auth
--     update (app_metadata.code_reset_worker = this worker's id; GoTrue applies
--     password and app_metadata in one transaction), so seeing the marker means
--     that write has landed and nothing of it is still in flight. Then the
--     worker carries on (when it re-reads the user straight after the error),
--     or a retry presenting the token reports the quarantined worker back
--     itself (stop_student_code_reset_worker with that worker's lease) and
--     takes a new one. reserve_student_code_reset's 'busy' answer below hands
--     that lease to the caller presenting the token, and only to them;
--   * the server-side TIME LIMIT passes: the hold the fence renewed just before
--     the write (600 s, longer than an Edge Function can run) runs out, as for
--     a worker that died inside an Auth call. That is the "held for up to 10
--     minutes" the roster already shows (decision 49 item 5).
--
-- Until then a retry is told the reset is still finishing (409
-- reset_in_progress, "try again in a few minutes"; decision 60(a)), and a claim
-- of the old card waits, as under any live hold.
--
-- The session revocation is a database call, so it can check the lease in its
-- own transaction rather than lean on the fence before it:
-- end_student_sessions_fenced() locks the roster row and the reservation, and
-- ends the sessions only for the current worker and epoch of a live hold, with
-- no claim since. A stale or delayed call does nothing. The plain
-- end_student_sessions (uuid) stays as it is for archive and the email reset,
-- which hold no lease.

-- Same signature and answers as 20261022110700. A 'busy' answer for the caller
-- presenting this reset's own token, while its worker is inside an Auth call,
-- also carries that worker's lease ('worker', 'epoch'), so the caller can report
-- the worker back once its write is confirmed.
create or replace function public.reserve_student_code_reset (
    p_student uuid,
    p_reservation uuid default null,
    p_ttl_seconds integer default 600
) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_row public.managed_students;
    v_held public.student_claim_reservations;
    v_reservation uuid;
    v_worker uuid := gen_random_uuid();
    v_epoch bigint;
    v_until timestamptz := now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 600), 30));
    v_busy jsonb;
begin
    -- The roster row first, then the reservation: the order every function on
    -- this table takes, so they serialize on one row lock and never deadlock.
    select * into v_row from public.managed_students where id = p_student for update;
    if not found then
        return jsonb_build_object('status', 'not_found');
    end if;
    select * into v_held from public.student_claim_reservations where student_id = p_student for update;
    if found and v_held.reserved_until > now() then
        if v_held.kind = 'reset' and p_reservation is not null and v_held.reservation = p_reservation
            and not v_held.worker_in_auth then
            -- The same reset, retried: a new lease fences out the worker before it.
            v_epoch := nextval('public.student_code_reset_epoch');
            update public.student_claim_reservations
            set worker = v_worker, worker_epoch = v_epoch, worker_in_auth = false, reserved_until = v_until
            where student_id = p_student;
            return jsonb_build_object(
                'status', 'reserved', 'reservation', v_held.reservation,
                'worker', v_worker, 'epoch', v_epoch, 'resumed', true
            );
        end if;
        -- Another reservation, or this one with a worker still inside an Auth call.
        v_busy := jsonb_build_object(
            'status', 'busy',
            'kind', v_held.kind,
            'retry_after_seconds', greatest(1, ceil(extract(epoch from v_held.reserved_until - now()))::integer)
        );
        if v_held.kind = 'reset' and p_reservation is not null and v_held.reservation = p_reservation
            and v_held.worker is not null then
            v_busy := v_busy || jsonb_build_object('worker', v_held.worker, 'epoch', v_held.worker_epoch);
        end if;
        return v_busy;
    end if;
    v_reservation := gen_random_uuid();
    v_epoch := nextval('public.student_code_reset_epoch');
    insert into public.student_claim_reservations (
        student_id, reservation, kind, login_code_hash, reserved_until,
        worker, worker_epoch, worker_in_auth, claimed_at_seen
    )
    values (p_student, v_reservation, 'reset', v_row.login_code_hash, v_until,
            v_worker, v_epoch, false, v_row.claimed_at)
    on conflict (student_id) do update
    set reservation = excluded.reservation,
        kind = 'reset',
        login_code_hash = excluded.login_code_hash,
        reserved_until = excluded.reserved_until,
        worker = excluded.worker,
        worker_epoch = excluded.worker_epoch,
        worker_in_auth = false,
        claimed_at_seen = excluded.claimed_at_seen,
        created_at = now();
    return jsonb_build_object(
        'status', 'reserved', 'reservation', v_reservation,
        'worker', v_worker, 'epoch', v_epoch, 'resumed', false
    );
end;
$$;

-- The reset worker's session revocation: end_student_sessions (uuid) for the
-- roster row's account, only while this worker and epoch hold the live
-- reservation, have passed a fence (worker_in_auth), and no claim has happened
-- since. The number of sessions ended, or NULL when the worker no longer owns
-- the reset (nothing is ended then).
create or replace function public.end_student_sessions_fenced (
    p_student uuid,
    p_reservation uuid,
    p_worker uuid,
    p_epoch bigint
) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_row public.managed_students;
    v_held public.student_claim_reservations;
begin
    if coalesce(auth.jwt () ->> 'role', '') <> 'service_role' then
        raise exception 'service role only' using errcode = '42501';
    end if;
    select * into v_row from public.managed_students where id = p_student for update;
    if not found then
        return null;
    end if;
    select * into v_held from public.student_claim_reservations where student_id = p_student for update;
    if not found or v_held.reserved_until <= now() or not v_held.worker_in_auth
        or not public.student_code_reset_owned(v_row, v_held, p_reservation, p_worker, p_epoch) then
        return null;
    end if;
    return public.end_student_sessions (v_row.student_user_id);
end;
$$;

revoke all on function public.reserve_student_code_reset (uuid, uuid, integer) from public, anon, authenticated;

grant execute on function public.reserve_student_code_reset (uuid, uuid, integer) to service_role;

revoke all on function public.end_student_sessions_fenced (uuid, uuid, uuid, bigint) from public, anon, authenticated;

grant execute on function public.end_student_sessions_fenced (uuid, uuid, uuid, bigint) to service_role;
