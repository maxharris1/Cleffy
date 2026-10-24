-- Teacher resets of a student's card: a fresh worker lease per attempt, with a
-- fencing epoch, separate from the resume token (Codex r2 Part B; decision 59).
--
-- 20261022110500_student_code_reset_holder.sql let a reset retried with its
-- own token resume the reservation. Both retries of one token got the same
-- answer, though, and nothing told them apart, so:
--
--   1. retry A presented token T, reserved, and paused before its password
--      write;
--   2. retry B presented T too, scrambled the password, ended the sessions and
--      completed -- a new card;
--   3. the student claimed that card and chose a password;
--   4. A resumed, overwrote the student's password and ended their sessions.
--      Its completion came back 'lost', after the Auth writes had happened.
--
-- Now the token T only says WHICH reset is being resumed. Who may act on it is
-- a separate WORKER LEASE that every attempt takes afresh, under the roster and
-- reservation row locks: a worker id plus an epoch from a sequence that never
-- goes back. The newest attempt's lease is the only one that counts.
--
--   * reserve_student_code_reset() hands each attempt its own worker and
--     epoch. A retry presenting T fences out the worker before it -- unless
--     that worker is INSIDE an Auth call (it passed a fence and has not
--     reported back), when the retry is told the reset is still finishing
--     ('busy', kind 'reset'): a password write already on its way to Auth
--     cannot be called back, so nothing may start behind it.
--   * fence_student_code_reset() is what the worker calls immediately before
--     EACH Auth side effect (the password write, then the session
--     revocation). It answers 'ok' only while this worker and epoch still hold
--     the live reservation and no claim has happened since the reservation was
--     taken (the roster's code hash and claimed_at are what they were then);
--     it marks the worker as inside an Auth call and renews the hold. 'lost'
--     means stop: a stale worker aborts before touching Auth.
--   * complete_student_code_reset() writes the new code only for the current
--     worker and epoch, under the same no-claim check.
--   * stop_student_code_reset_worker() is the worker reporting back on a
--     failure: no Auth call of its own is in flight any more, so a retry with
--     T may take a new lease at once. The reservation stays (the password may
--     already be scrambled; the old card must not be claimable meanwhile).
--
-- A worker that never reports back (its request died inside an Auth call)
-- holds the row until the reservation runs out: 600 s, renewed at each fence,
-- longer than an Edge Function can run (400 s wall clock), so by then it can
-- no longer be writing. That is the "held for up to 10 minutes" the roster UI
-- already states (decision 49 item 5).
--
-- complete_student_code_reset (uuid, uuid, text) (same unmerged PR, never
-- deployed) is replaced by the worker-checked version.

create sequence if not exists public.student_code_reset_epoch;

revoke all on sequence public.student_code_reset_epoch from public, anon, authenticated;

alter table public.student_claim_reservations
    -- The attempt allowed to act on a reset reservation; null once it reported back.
    add column if not exists worker uuid,
    -- Its fencing epoch (student_code_reset_epoch): strictly newer per attempt.
    add column if not exists worker_epoch bigint,
    -- True from a fence until that worker reports back: an Auth call may be in flight.
    add column if not exists worker_in_auth boolean not null default false,
    -- The roster's claimed_at when the reservation was taken (no claim since).
    add column if not exists claimed_at_seen timestamptz;

drop function if exists public.complete_student_code_reset (uuid, uuid, text);

-- {status: 'reserved', reservation, worker, epoch, resumed} | {status: 'busy',
-- kind, retry_after_seconds} | {status: 'not_found'}. Same signature as
-- 20261022110500; the answer gains worker and epoch.
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
        return jsonb_build_object(
            'status', 'busy',
            'kind', v_held.kind,
            'retry_after_seconds', greatest(1, ceil(extract(epoch from v_held.reserved_until - now()))::integer)
        );
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

-- Does this worker still own the live reset, with no claim since? (Locks held.)
create or replace function public.student_code_reset_owned (
    p_row public.managed_students,
    p_held public.student_claim_reservations,
    p_reservation uuid,
    p_worker uuid,
    p_epoch bigint
) returns boolean language sql immutable as $$
    select p_held.student_id is not null
        and p_held.kind = 'reset'
        and p_held.reservation = p_reservation
        and p_held.worker = p_worker
        and p_held.worker_epoch = p_epoch
        and p_row.login_code_hash is not distinct from p_held.login_code_hash
        and p_row.claimed_at is not distinct from p_held.claimed_at_seen
$$;

-- 'ok' (go ahead with the next Auth side effect) or 'lost' (abort, touch nothing).
create or replace function public.fence_student_code_reset (
    p_student uuid,
    p_reservation uuid,
    p_worker uuid,
    p_epoch bigint,
    p_ttl_seconds integer default 600
) returns text language plpgsql security definer
set search_path = public as $$
declare
    v_row public.managed_students;
    v_held public.student_claim_reservations;
begin
    select * into v_row from public.managed_students where id = p_student for update;
    if not found then
        return 'lost';
    end if;
    select * into v_held from public.student_claim_reservations where student_id = p_student for update;
    if not found or v_held.reserved_until <= now()
        or not public.student_code_reset_owned(v_row, v_held, p_reservation, p_worker, p_epoch) then
        return 'lost';
    end if;
    update public.student_claim_reservations
    set worker_in_auth = true,
        reserved_until = greatest(reserved_until, now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 600), 30)))
    where student_id = p_student;
    return 'ok';
end;
$$;

-- 'reset' when the current worker's new code is written (and claimed_at
-- cleared, as a reset sends the student back to Invited); 'lost' otherwise --
-- nothing is written then.
create or replace function public.complete_student_code_reset (
    p_student uuid,
    p_reservation uuid,
    p_worker uuid,
    p_epoch bigint,
    p_code_hash text
) returns text language plpgsql security definer
set search_path = public as $$
declare
    v_row public.managed_students;
    v_held public.student_claim_reservations;
begin
    if p_code_hash is null or length(p_code_hash) = 0 then
        raise exception 'p_code_hash is required' using errcode = '22004';
    end if;
    select * into v_row from public.managed_students where id = p_student for update;
    if not found then
        return 'lost';
    end if;
    select * into v_held from public.student_claim_reservations where student_id = p_student for update;
    if not found or not public.student_code_reset_owned(v_row, v_held, p_reservation, p_worker, p_epoch) then
        return 'lost';
    end if;
    -- The reservation goes first (same transaction), so the guard lets this
    -- one write through.
    delete from public.student_claim_reservations where student_id = p_student;
    update public.managed_students set login_code_hash = p_code_hash, claimed_at = null where id = p_student;
    return 'reset';
end;
$$;

-- The worker reporting back after a failure: no Auth call of its own is in
-- flight. The hold stays; a retry with the token may take a new lease at once.
create or replace function public.stop_student_code_reset_worker (
    p_student uuid,
    p_reservation uuid,
    p_worker uuid,
    p_epoch bigint
) returns boolean language plpgsql security definer
set search_path = public as $$
begin
    perform 1 from public.managed_students where id = p_student for update;
    update public.student_claim_reservations
    set worker = null, worker_in_auth = false
    where student_id = p_student and kind = 'reset' and reservation = p_reservation
        and worker = p_worker and worker_epoch = p_epoch;
    return found;
end;
$$;

-- Release by token, as in 20261022110500, but never under a worker that may
-- still be inside an Auth call: the old card would become claimable while a
-- password write is on its way.
create or replace function public.release_student_code_reset (p_student uuid, p_reservation uuid)
returns boolean language plpgsql security definer
set search_path = public as $$
begin
    delete from public.student_claim_reservations
    where student_id = p_student and reservation = p_reservation and kind = 'reset' and not worker_in_auth;
    return found;
end;
$$;

revoke all on function public.reserve_student_code_reset (uuid, uuid, integer) from public, anon, authenticated;

grant execute on function public.reserve_student_code_reset (uuid, uuid, integer) to service_role;

revoke all on function public.student_code_reset_owned (
    public.managed_students, public.student_claim_reservations, uuid, uuid, bigint
) from public, anon, authenticated;

revoke all on function public.fence_student_code_reset (uuid, uuid, uuid, bigint, integer) from public, anon, authenticated;

grant execute on function public.fence_student_code_reset (uuid, uuid, uuid, bigint, integer) to service_role;

revoke all on function public.complete_student_code_reset (uuid, uuid, uuid, bigint, text) from public, anon, authenticated;

grant execute on function public.complete_student_code_reset (uuid, uuid, uuid, bigint, text) to service_role;

revoke all on function public.stop_student_code_reset_worker (uuid, uuid, uuid, bigint) from public, anon, authenticated;

grant execute on function public.stop_student_code_reset_worker (uuid, uuid, uuid, bigint) to service_role;

revoke all on function public.release_student_code_reset (uuid, uuid) from public, anon, authenticated;

grant execute on function public.release_student_code_reset (uuid, uuid) to service_role;
