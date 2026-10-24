-- Student claims: a durable reservation, taken before any password is written.
--
-- student-claim used to read the roster row by code hash, set the account's
-- password, sign in, and only then commit -- and the commit checked neither the
-- code hash nor who was claiming. So:
--
--  * two children typing the same card at once both set a password; the one
--    that lost the commit had already overwritten the winner's, and nothing
--    undid it -- the winner's freshly chosen password stopped working;
--  * a claim in flight across a teacher's reset committed against the OLD code
--    (the commit never looked at login_code_hash), spending the new card too,
--    and its password write could land after the reset's scramble, leaving the
--    old card's holder a working password and session the teacher thought they
--    had revoked.
--
-- Now every claim first takes a RESERVATION (reserve_student_claim): one per
-- roster row, bound to the login_code_hash it was taken for, held for
-- p_ttl_seconds. Only the holder writes a password, and the claim commits only
-- if the row still carries that hash and the reservation is still theirs
-- (complete_student_claim). A second claim on the same card is told the card is
-- busy and writes nothing. A teacher's reset takes a reservation of its own
-- before it scrambles the password (begin_student_code_reset), so a reset and a
-- claim can never interleave: whichever comes second is told to wait. Archiving
-- BLOCKS a claim in flight -- its commit refuses an archived row -- but leaves
-- the reservation until that claim lets go, so a reset of the archived student
-- (or a new claim after a restore) still waits for the stale claim instead of
-- racing its password write. Any other change of the code hash refuses while a
-- live claim holds it.
--
-- The TTL is longer than an Edge Function can run (400 s wall clock on the paid
-- plan), so by the time a reservation expires its holder can no longer be
-- writing anything. A holder that fails cleanly releases it at once
-- (release_student_claim); only a crashed request leaves it to expire.
--
-- Service role only. RLS on with no policy, every client grant revoked, like
-- support_messages: the code hash a reservation carries never leaves the server.
create table if not exists public.student_claim_reservations (
    student_id uuid primary key references public.managed_students (id) on delete cascade,
    -- What the holder presents to complete or release. A new one per reservation.
    reservation uuid not null default gen_random_uuid(),
    -- 'claim': student-claim, holding the card it was taken for.
    -- 'reset': a teacher's reset of the code, from student-provision.
    kind text not null check (kind in ('claim', 'reset')),
    -- The code hash a claim was taken for; null for a reset of a claimed row.
    login_code_hash text,
    reserved_until timestamptz not null,
    created_at timestamptz not null default now(),
    constraint student_claim_reservations_claim_has_hash check (kind <> 'claim' or login_code_hash is not null)
);

alter table public.student_claim_reservations enable row level security;

revoke all on table public.student_claim_reservations from public;

revoke all on table public.student_claim_reservations from anon;

revoke all on table public.student_claim_reservations from authenticated;

grant all on table public.student_claim_reservations to service_role;

-- ---------------------------------------------------------------------------
-- reserve_student_claim: the claim's first write.
-- ---------------------------------------------------------------------------
-- Answers {status: 'reserved', reservation, student_id, student_user_id,
-- display_name}, {status: 'busy', retry_after_seconds} when another claim or a
-- reset holds the row, or {status: 'not_found'} for a hash that selects no
-- unarchived, unclaimed row (or more than one: a collision is refused, as the
-- old maybeSingle() lookup refused it).
--
-- The roster row is locked first, then the reservation: the same order as
-- complete_student_claim and begin_student_code_reset, so the three serialize
-- on one row lock and cannot deadlock.
create or replace function public.reserve_student_claim (p_code_hash text, p_ttl_seconds integer default 600)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_student public.managed_students;
    v_held public.student_claim_reservations;
    v_reservation uuid;
begin
    if p_code_hash is null or length(p_code_hash) = 0 then
        return jsonb_build_object('status', 'not_found');
    end if;
    begin
        select * into strict v_student
        from public.managed_students
        where login_code_hash = p_code_hash and archived_at is null and claimed_at is null
        for update;
    exception
        when no_data_found or too_many_rows then
            return jsonb_build_object('status', 'not_found');
    end;

    select * into v_held from public.student_claim_reservations where student_id = v_student.id for update;
    if found and v_held.reserved_until > now() then
        return jsonb_build_object(
            'status', 'busy',
            'retry_after_seconds', greatest(1, ceil(extract(epoch from v_held.reserved_until - now()))::integer)
        );
    end if;

    v_reservation := gen_random_uuid();
    insert into public.student_claim_reservations (student_id, reservation, kind, login_code_hash, reserved_until)
    values (v_student.id, v_reservation, 'claim', p_code_hash,
            now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 600), 30)))
    on conflict (student_id) do update
    set reservation = excluded.reservation,
        kind = excluded.kind,
        login_code_hash = excluded.login_code_hash,
        reserved_until = excluded.reserved_until,
        created_at = now();

    return jsonb_build_object(
        'status', 'reserved',
        'reservation', v_reservation,
        'student_id', v_student.id,
        'student_user_id', v_student.student_user_id,
        'display_name', v_student.display_name
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- complete_student_claim: the commit, only for the holder of the hash.
-- ---------------------------------------------------------------------------
-- 'claimed', or 'lost' when the row no longer carries p_code_hash, was archived
-- or claimed meanwhile, or the reservation is no longer p_reservation (released,
-- or expired and taken by another claim or a reset). A username another row
-- holds raises 23505 from the unique index, as the old UPDATE did; the
-- reservation is untouched then, and the caller releases it.
create or replace function public.complete_student_claim (
    p_student uuid,
    p_reservation uuid,
    p_code_hash text,
    p_username text
) returns text language plpgsql security definer
set search_path = public as $$
begin
    perform 1 from public.managed_students where id = p_student for update;
    perform 1
    from public.student_claim_reservations
    where student_id = p_student and reservation = p_reservation and kind = 'claim' and login_code_hash = p_code_hash
    for update;
    if not found then
        return 'lost';
    end if;

    update public.managed_students
    set username = p_username, claimed_at = now(), login_code_hash = null
    where id = p_student and login_code_hash = p_code_hash and archived_at is null and claimed_at is null;
    if not found then
        return 'lost';
    end if;

    delete from public.student_claim_reservations where student_id = p_student;
    return 'claimed';
end;
$$;

-- ---------------------------------------------------------------------------
-- release_student_claim: a holder that will not complete hands the row back.
-- ---------------------------------------------------------------------------
-- Only its own reservation: a stale holder cannot release a newer one.
create or replace function public.release_student_claim (p_student uuid, p_reservation uuid)
returns boolean language plpgsql security definer
set search_path = public as $$
begin
    delete from public.student_claim_reservations where student_id = p_student and reservation = p_reservation;
    return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- begin_student_code_reset: a teacher's reset reserves the row before it
-- scrambles the password.
-- ---------------------------------------------------------------------------
-- 'reserved', or 'busy' while a live claim holds the row: the reset must not
-- scramble a password a claim is about to set, nor rotate the code under it.
-- A live reservation of the reset's own kind (a reset retried after a partial
-- failure) is taken over. The reservation is cleared when the reset writes the
-- new code hash (student_claim_reservation_guard) and otherwise expires.
create or replace function public.begin_student_code_reset (p_student uuid, p_ttl_seconds integer default 600)
returns text language plpgsql security definer
set search_path = public as $$
declare
    v_held public.student_claim_reservations;
    v_hash text;
begin
    select login_code_hash into v_hash from public.managed_students where id = p_student for update;
    if not found then
        return 'not_found';
    end if;
    select * into v_held from public.student_claim_reservations where student_id = p_student for update;
    if found and v_held.kind = 'claim' and v_held.reserved_until > now() then
        return 'busy';
    end if;
    insert into public.student_claim_reservations (student_id, kind, login_code_hash, reserved_until)
    values (p_student, 'reset', v_hash, now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 600), 30)))
    on conflict (student_id) do update
    set reservation = gen_random_uuid(),
        kind = 'reset',
        login_code_hash = excluded.login_code_hash,
        reserved_until = excluded.reserved_until,
        created_at = now();
    return 'reserved';
end;
$$;

revoke all on function public.reserve_student_claim (text, integer) from public, anon, authenticated;

grant execute on function public.reserve_student_claim (text, integer) to service_role;

revoke all on function public.complete_student_claim (uuid, uuid, text, text) from public, anon, authenticated;

grant execute on function public.complete_student_claim (uuid, uuid, text, text) to service_role;

revoke all on function public.release_student_claim (uuid, uuid) from public, anon, authenticated;

grant execute on function public.release_student_claim (uuid, uuid) to service_role;

revoke all on function public.begin_student_code_reset (uuid, integer) from public, anon, authenticated;

grant execute on function public.begin_student_code_reset (uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- The guard: what a change to the row does to its reservation.
-- ---------------------------------------------------------------------------
--  * archived: nothing here. The claim's commit refuses an archived row, the
--    archive's ban stops any sign-in, and the reservation stays until its
--    holder releases it (or it expires), so a reset of the archived row waits
--    for the claim rather than scrambling before its password write lands.
--  * the code hash changes other than by the claim's own commit: refused while
--    a live CLAIM holds the row (so no path can rotate a card under a claim in
--    flight), otherwise the reservation is cleared -- a reset's own one
--    included, which is how a finished reset hands the row back.
create or replace function public.student_claim_reservation_guard () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if new.login_code_hash is distinct from old.login_code_hash
        and not (old.claimed_at is null and new.claimed_at is not null) then
        if exists (
            select 1 from public.student_claim_reservations
            where student_id = new.id and kind = 'claim' and reserved_until > now()
        ) then
            raise exception 'student_claim_in_progress'
                using errcode = '55006',
                      hint = 'A claim holds this student''s card; try again once it finishes.';
        end if;
        delete from public.student_claim_reservations where student_id = new.id;
    end if;
    return new;
end;
$$;

revoke all on function public.student_claim_reservation_guard () from public, anon, authenticated;

drop trigger if exists managed_students_claim_reservation_guard on public.managed_students;

create trigger managed_students_claim_reservation_guard
after update of login_code_hash on public.managed_students
for each row execute function public.student_claim_reservation_guard ();
