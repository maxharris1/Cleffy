-- Account deletion: the barrier, extended beyond the two table inserts.
--
-- 20261022110100 refused new documents and roster rows while an account's
-- deletion is pending (account_deletion_pending(), 20261022110400). Four other
-- ways to add to an account being deleted were still open (Codex r1 Part B
-- finding 3):
--
--   1. Storage writes into a score that already exists: an upload or an
--      overwrite authorized while the score was there could land after the
--      sweep had emptied its folders, leaving bytes nothing points at.
--   2. Provisioning created the student's Auth account BEFORE its roster row:
--      a request that crashed in between (or whose undo failed) left an
--      account the teacher's inventory never listed, so the deletion never
--      found it.
--   3. Checkout: a lease taken, or a session staged, from another tab could
--      open a Stripe session after the deletion's billing sweeps.
--   4. Share-link redemption (and any other membership insert) kept adding
--      members to the account, or to its scores, mid-deletion.
--
-- Each is now refused while the account is pending, through the same
-- predicate, which takes the per-account lock SHARED: a deletion beginning
-- waits for the write in flight, and a write starting after it sees the
-- marker.
--
-- And provisioning registers its intent durably BEFORE it creates an Auth
-- account (student_provision_intents): the deletion sweeps those too, and a
-- crashed request leaves a row naming what to clean up -- recoverable rather
-- than invisible. The table deliberately has no foreign key to the teacher, so
-- it outlives a teacher whose deletion completed around a crash.
--
-- Replayable: create-or-replace, if-not-exists, drop-if-exists throughout.

-- ===========================================================================
-- 1. Storage: no upload or overwrite by an account being deleted
-- ===========================================================================
-- The permissive scores_/thumbnails_ policies already require the caller to
-- own the score, so the caller is the account that matters. Keyed on the
-- caller alone, so it answers nothing about anyone else.
create or replace function public.caller_account_deletion_pending () returns boolean
language plpgsql volatile security definer
set search_path = public as $$
begin
    return public.account_deletion_pending (auth.uid());
end;
$$;

revoke all on function public.caller_account_deletion_pending () from public, anon;

grant execute on function public.caller_account_deletion_pending () to authenticated, service_role;

-- UPDATE has USING and WITH CHECK: an upsert's update arm (upload with
-- upsert: true, and resumable uploads) is refused with an error by a failing
-- USING. DELETE is left alone: the sweep, and the owner, may still remove.
drop policy if exists storage_refuse_during_account_deletion_insert on storage.objects;

create policy storage_refuse_during_account_deletion_insert on storage.objects as restrictive for insert to authenticated
with check (
    bucket_id not in ('scores', 'thumbnails')
    or not (select public.caller_account_deletion_pending ())
);

drop policy if exists storage_refuse_during_account_deletion_update on storage.objects;

create policy storage_refuse_during_account_deletion_update on storage.objects as restrictive for update to authenticated
using (bucket_id not in ('scores', 'thumbnails') or not (select public.caller_account_deletion_pending ()))
with check (bucket_id not in ('scores', 'thumbnails') or not (select public.caller_account_deletion_pending ()));

-- ===========================================================================
-- 2. Memberships: no share-link redemption (or other join) mid-deletion
-- ===========================================================================
-- redeem_share_link inserts into document_members (ON CONFLICT DO UPDATE --
-- a BEFORE INSERT trigger fires for those too). Refused when the joining
-- account is being deleted, or the score's owner is.
create or replace function public.refuse_membership_during_account_deletion () returns trigger
language plpgsql security definer
set search_path = public as $$
declare
    v_owner uuid;
begin
    if public.account_deletion_pending (new.user_id) then
        raise exception 'account_deletion_pending'
            using errcode = '55000',
                  hint = 'This account is being deleted, so it cannot join a score.';
    end if;
    select owner_id into v_owner from public.documents where id = new.document_id;
    if v_owner is not null and v_owner is distinct from new.user_id and public.account_deletion_pending (v_owner) then
        raise exception 'account_deletion_pending'
            using errcode = '55000',
                  hint = 'This score''s owner is deleting their account, so it cannot be joined.';
    end if;
    return new;
end;
$$;

revoke all on function public.refuse_membership_during_account_deletion () from public, anon, authenticated;

drop trigger if exists document_members_refuse_during_account_deletion on public.document_members;

create trigger document_members_refuse_during_account_deletion
before insert on public.document_members
for each row execute function public.refuse_membership_during_account_deletion ();

-- ===========================================================================
-- 3. Checkout: no lease taken or session staged mid-deletion
-- ===========================================================================
-- begin_checkout_attempt (taking the lease) and stage_checkout_attempt (the
-- step right before Stripe's create) both write a row that holds a holder.
-- Releasing (holder set null) stays allowed.
create or replace function public.refuse_checkout_during_account_deletion () returns trigger
language plpgsql security definer
set search_path = public as $$
begin
    if new.holder is not null and public.account_deletion_pending (new.user_id) then
        raise exception 'account_deletion_pending'
            using errcode = '55000',
                  hint = 'This account is being deleted, so no checkout can start.';
    end if;
    return new;
end;
$$;

revoke all on function public.refuse_checkout_during_account_deletion () from public, anon, authenticated;

drop trigger if exists checkout_attempts_refuse_during_account_deletion on public.checkout_attempts;

create trigger checkout_attempts_refuse_during_account_deletion
before insert or update on public.checkout_attempts
for each row execute function public.refuse_checkout_during_account_deletion ();

-- The other half: a checkout that took its lease BEFORE the marker may still
-- be creating a session. The deletion asks this after its marker is in place
-- (so no new lease can start) and refuses to go on while one is live. The
-- interval is checkoutFlow.ts's CHECKOUT_ATTEMPT_STALE_AFTER: past it the
-- lease can be taken over and its holder can no longer stage.
create or replace function public.checkout_attempt_in_flight (p_user uuid) returns boolean
language sql stable security definer
set search_path = public as $$
    select exists (
        select 1 from public.checkout_attempts
        where user_id = p_user and holder is not null and claimed_at > now() - interval '5 minutes'
    );
$$;

revoke all on function public.checkout_attempt_in_flight (uuid) from public, anon, authenticated;

grant execute on function public.checkout_attempt_in_flight (uuid) to service_role;

-- ===========================================================================
-- 4. Provisioning: the intent first, then the Auth account
-- ===========================================================================
create table if not exists public.student_provision_intents (
    roster_id uuid primary key,
    -- No foreign key: the row must outlive a teacher whose deletion completed
    -- around a crashed provisioning, or nothing would name the orphan.
    teacher_id uuid not null,
    -- The address the Auth account is created at: the synthetic one for a
    -- code student, the invited address for an email student.
    auth_email text not null,
    -- Set the moment the Auth account exists.
    student_user_id uuid,
    created_at timestamptz not null default now(),
    -- Past this the request that wrote it can no longer be running.
    expires_at timestamptz not null
);

create index if not exists student_provision_intents_teacher on public.student_provision_intents (teacher_id);

alter table public.student_provision_intents enable row level security;

revoke all on table public.student_provision_intents from public;

revoke all on table public.student_provision_intents from anon;

revoke all on table public.student_provision_intents from authenticated;

grant all on table public.student_provision_intents to service_role;

-- 'ok' (recorded), or 'deletion_pending' (nothing recorded: the teacher's
-- account is being deleted, so no account may be created for them).
create or replace function public.begin_student_provision (
    p_teacher uuid,
    p_roster_id uuid,
    p_auth_email text,
    p_ttl_seconds integer default 600
) returns text language plpgsql security definer
set search_path = public as $$
begin
    if p_teacher is null or p_roster_id is null or p_auth_email is null then
        raise exception 'p_teacher, p_roster_id and p_auth_email are required' using errcode = '22004';
    end if;
    if public.account_deletion_pending (p_teacher) then
        return 'deletion_pending';
    end if;
    insert into public.student_provision_intents (roster_id, teacher_id, auth_email, expires_at)
    values (p_roster_id, p_teacher, lower(p_auth_email),
            now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 600), 60)));
    return 'ok';
end;
$$;

-- The Auth account now exists. False when the intent is gone (a deletion swept
-- it): the caller undoes the account it just made.
create or replace function public.attach_student_provision (p_roster_id uuid, p_student_user uuid)
returns boolean language plpgsql security definer
set search_path = public as $$
begin
    update public.student_provision_intents set student_user_id = p_student_user where roster_id = p_roster_id;
    return found;
end;
$$;

-- The provisioning ended without a roster row and its Auth account is gone
-- (or was never made): nothing left to clean up.
create or replace function public.finish_student_provision (p_roster_id uuid)
returns boolean language plpgsql security definer
set search_path = public as $$
begin
    delete from public.student_provision_intents where roster_id = p_roster_id;
    return found;
end;
$$;

-- What a deletion of p_teacher must clean up: every intent, with the Auth
-- account it names -- recorded, or found by address among accounts created
-- since the intent (a crash between the create and the attach) -- and whether
-- the request that wrote it can still be running.
create or replace function public.student_provision_intents_for (p_teacher uuid)
returns table (roster_id uuid, student_user_id uuid, live boolean)
language sql stable security definer
set search_path = public as $$
    select i.roster_id,
           coalesce(
               i.student_user_id,
               (select u.id from auth.users u
                where lower(u.email) = i.auth_email and u.created_at >= i.created_at - interval '1 minute'
                order by u.created_at limit 1)
           ),
           i.expires_at > now()
    from public.student_provision_intents i
    where i.teacher_id = p_teacher
    order by i.created_at;
$$;

-- The roster row is the provisioning's success: its intent goes in the same
-- transaction.
create or replace function public.clear_student_provision_intent () returns trigger
language plpgsql security definer
set search_path = public as $$
begin
    delete from public.student_provision_intents where roster_id = new.id;
    return new;
end;
$$;

revoke all on function public.clear_student_provision_intent () from public, anon, authenticated;

drop trigger if exists managed_students_clear_provision_intent on public.managed_students;

create trigger managed_students_clear_provision_intent
after insert on public.managed_students
for each row execute function public.clear_student_provision_intent ();

revoke all on function public.begin_student_provision (uuid, uuid, text, integer) from public, anon, authenticated;

grant execute on function public.begin_student_provision (uuid, uuid, text, integer) to service_role;

revoke all on function public.attach_student_provision (uuid, uuid) from public, anon, authenticated;

grant execute on function public.attach_student_provision (uuid, uuid) to service_role;

revoke all on function public.finish_student_provision (uuid) from public, anon, authenticated;

grant execute on function public.finish_student_provision (uuid) to service_role;

revoke all on function public.student_provision_intents_for (uuid) from public, anon, authenticated;

grant execute on function public.student_provision_intents_for (uuid) to service_role;
