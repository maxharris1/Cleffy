-- Teacher resets of a student's card: a holder token, no takeover of a live
-- reset, and only the holder may complete or release it.
--
-- 20261022110000_student_claim_reservation.sql let a reset take over another
-- reset's live reservation ("a reset retried after a partial failure"), and
-- returned nothing that identified the holder. So reset A could reserve and
-- pause before its scramble; reset B took the row over, finished and cleared
-- it; a student claimed B's new card and chose a password; and A then resumed
-- and scrambled that password -- the student's fresh account stopped working.
--
-- Now:
--   * reserve_student_code_reset() returns the reservation's token. A live
--     reservation of either kind refuses it ('busy', with its kind), unless the
--     caller presents that reservation's own token -- a reset retried by the
--     same teacher after a partial failure resumes its own reservation (and
--     renews it) instead of waiting it out. student-provision hands the token
--     back on a failed reset for exactly that.
--   * complete_student_code_reset() writes the new code hash, only for the
--     holder, and hands the row back in the same statement's transaction.
--   * release_student_code_reset() hands the row back, only for the holder.
--   * the guard trigger refuses every other change of the code hash while any
--     live reservation holds the row (before: only a claim's). The claim's own
--     commit is still the one exception.
--
-- A reservation the holder never completes (the request died) expires after
-- its TTL, 600 s, longer than an Edge Function can run. Until then the
-- student's current card cannot be claimed: the roster UI says so ("held for
-- up to 10 minutes", decision 49 item 5).
--
-- begin_student_code_reset() (same unmerged PR, never deployed) is dropped.
drop function if exists public.begin_student_code_reset (uuid, integer);

create or replace function public.reserve_student_code_reset (
    p_student uuid,
    p_reservation uuid default null,
    p_ttl_seconds integer default 600
) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_held public.student_claim_reservations;
    v_hash text;
    v_reservation uuid;
    v_until timestamptz := now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 600), 30));
begin
    -- The roster row first, then the reservation: the order every function on
    -- this table takes, so they serialize on one row lock and never deadlock.
    select login_code_hash into v_hash from public.managed_students where id = p_student for update;
    if not found then
        return jsonb_build_object('status', 'not_found');
    end if;
    select * into v_held from public.student_claim_reservations where student_id = p_student for update;
    if found and v_held.reserved_until > now() then
        if v_held.kind = 'reset' and p_reservation is not null and v_held.reservation = p_reservation then
            -- The same reset, retried by its holder: resumed, and renewed.
            update public.student_claim_reservations set reserved_until = v_until where student_id = p_student;
            return jsonb_build_object('status', 'reserved', 'reservation', v_held.reservation, 'resumed', true);
        end if;
        return jsonb_build_object(
            'status', 'busy',
            'kind', v_held.kind,
            'retry_after_seconds', greatest(1, ceil(extract(epoch from v_held.reserved_until - now()))::integer)
        );
    end if;
    v_reservation := gen_random_uuid();
    insert into public.student_claim_reservations (student_id, reservation, kind, login_code_hash, reserved_until)
    values (p_student, v_reservation, 'reset', v_hash, v_until)
    on conflict (student_id) do update
    set reservation = excluded.reservation,
        kind = 'reset',
        login_code_hash = excluded.login_code_hash,
        reserved_until = excluded.reserved_until,
        created_at = now();
    return jsonb_build_object('status', 'reserved', 'reservation', v_reservation, 'resumed', false);
end;
$$;

-- 'reset' when the holder's new code is written (and claimed_at cleared, as a
-- reset sends the student back to Invited); 'lost' when p_reservation no
-- longer holds the row -- nothing is written then.
create or replace function public.complete_student_code_reset (
    p_student uuid,
    p_reservation uuid,
    p_code_hash text
) returns text language plpgsql security definer
set search_path = public as $$
begin
    if p_code_hash is null or length(p_code_hash) = 0 then
        raise exception 'p_code_hash is required' using errcode = '22004';
    end if;
    perform 1 from public.managed_students where id = p_student for update;
    delete from public.student_claim_reservations
    where student_id = p_student and reservation = p_reservation and kind = 'reset';
    if not found then
        return 'lost';
    end if;
    -- The reservation is gone (above, same transaction), so the guard lets
    -- this one write through.
    update public.managed_students set login_code_hash = p_code_hash, claimed_at = null where id = p_student;
    return 'reset';
end;
$$;

create or replace function public.release_student_code_reset (p_student uuid, p_reservation uuid)
returns boolean language plpgsql security definer
set search_path = public as $$
begin
    delete from public.student_claim_reservations
    where student_id = p_student and reservation = p_reservation and kind = 'reset';
    return found;
end;
$$;

revoke all on function public.reserve_student_code_reset (uuid, uuid, integer) from public, anon, authenticated;

grant execute on function public.reserve_student_code_reset (uuid, uuid, integer) to service_role;

revoke all on function public.complete_student_code_reset (uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.complete_student_code_reset (uuid, uuid, text) to service_role;

revoke all on function public.release_student_code_reset (uuid, uuid) from public, anon, authenticated;

grant execute on function public.release_student_code_reset (uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The guard: no code change under ANY live reservation but the holder's own
-- ---------------------------------------------------------------------------
--  * a claim's own commit (claimed_at set as the hash clears) passes, as before;
--  * a reset's commit passes because complete_student_code_reset removed its
--    reservation first;
--  * anything else that changes the hash while a live claim OR reset holds the
--    row is refused (55006). Otherwise an expired reservation is cleared.
create or replace function public.student_claim_reservation_guard () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if new.login_code_hash is distinct from old.login_code_hash
        and not (old.claimed_at is null and new.claimed_at is not null) then
        if exists (
            select 1 from public.student_claim_reservations
            where student_id = new.id and reserved_until > now()
        ) then
            raise exception 'student_claim_in_progress'
                using errcode = '55006',
                      hint = 'A claim or a reset holds this student''s card; try again once it finishes.';
        end if;
        delete from public.student_claim_reservations where student_id = new.id;
    end if;
    return new;
end;
$$;

revoke all on function public.student_claim_reservation_guard () from public, anon, authenticated;
