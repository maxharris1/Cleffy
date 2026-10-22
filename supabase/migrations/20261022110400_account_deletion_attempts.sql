-- Account deletion: active attempts counted apart from historical ones, a
-- record of whether destructive cleanup began, and a lease, so a marker can
-- no longer restrict an untouched account for good.
--
-- 20261022110100_account_deletion_pending.sql cleared the marker only for a
-- lone first attempt ("attempts = 1 and last_error is null"). Two attempts that
-- both abandoned (billing down twice, two tabs) left attempts = 2, and a
-- request that crashed never settled at all: either way score uploads and new
-- students stayed refused with no way back, though nothing had been deleted.
--
-- Now:
--
--   * every attempt gets a row in account_deletion_attempts, under a lease
--     (lease_until, 600 s: longer than an Edge Function can run, so an attempt
--     whose lease has run out can no longer be doing anything). An ACTIVE
--     attempt is one that has neither ended nor run out its lease.
--     account_deletions.attempts still counts every attempt ever begun -- the
--     history -- and nothing decides anything on it any more;
--   * account_deletions.destructive_started_at is set, by the attempt itself,
--     right before the first thing is deleted (mark_account_deletion_destructive);
--   * the account is restricted (account_deletion_pending()) while an attempt
--     is active OR destructive cleanup has begun. An untouched marker with no
--     active attempt restricts nothing: a crashed attempt stops restricting the
--     moment its lease runs out, with no sweep needed, and the next attempt
--     reuses the row. An abandoned attempt that leaves no other active one
--     deletes the row outright.
--   * once destructive cleanup has begun the restriction stays until the
--     deletion completes (the auth user's cascade removes the marker): a
--     half-deleted account must not grow while the person retries. A row in
--     that state with no active attempt is the support runbook's case (P6:
--     "account_deletions with destructive_started_at set and no live attempt").
--
-- Replaces begin_account_deletion / settle_account_deletion (dropped below:
-- new in the same unmerged PR, never deployed) with attempt-scoped functions.
alter table public.account_deletions add column if not exists destructive_started_at timestamptz;

create table if not exists public.account_deletion_attempts (
    attempt uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.account_deletions (user_id) on delete cascade,
    started_at timestamptz not null default now(),
    lease_until timestamptz not null,
    ended_at timestamptz,
    outcome text check (outcome in ('abandoned', 'failed')),
    error text
);

create index if not exists account_deletion_attempts_user on public.account_deletion_attempts (user_id);

alter table public.account_deletion_attempts enable row level security;

revoke all on table public.account_deletion_attempts from public;

revoke all on table public.account_deletion_attempts from anon;

revoke all on table public.account_deletion_attempts from authenticated;

grant all on table public.account_deletion_attempts to service_role;

drop function if exists public.begin_account_deletion (uuid);

drop function if exists public.settle_account_deletion (uuid, text, text);

-- ---------------------------------------------------------------------------
-- account_deletion_pending: is this account restricted right now?
-- ---------------------------------------------------------------------------
-- Takes the per-account lock SHARED, held to the caller's transaction end, so
-- a deletion beginning now waits for whatever the caller is about to write,
-- and the caller sees an attempt that began before it. Every guard that
-- refuses a write during a deletion goes through this one function.
create or replace function public.account_deletion_pending (p_user uuid) returns boolean
language plpgsql volatile security definer
set search_path = public as $$
begin
    if p_user is null then
        return false;
    end if;
    perform pg_advisory_xact_lock_shared (public.account_deletion_lock_key (p_user));
    return exists (
        select 1
        from public.account_deletions d
        where d.user_id = p_user
          and (
              d.destructive_started_at is not null
              or exists (
                  select 1 from public.account_deletion_attempts a
                  where a.user_id = d.user_id and a.ended_at is null and a.lease_until > now()
              )
          )
    );
end;
$$;

revoke all on function public.account_deletion_pending (uuid) from public, anon, authenticated;

grant execute on function public.account_deletion_pending (uuid) to service_role;

-- ---------------------------------------------------------------------------
-- begin / mark destructive / settle (service role only)
-- ---------------------------------------------------------------------------
-- begin: the first step of every attempt. Waits for any guarded write for
-- this account still in flight, writes (or re-counts) the marker, and returns
-- the attempt's id -- or null, writing nothing, for an account already gone.
create or replace function public.begin_account_deletion_attempt (p_user uuid, p_lease_seconds integer default 600)
returns uuid language plpgsql security definer
set search_path = public as $$
declare
    v_attempt uuid;
begin
    if p_user is null then
        raise exception 'p_user is required' using errcode = '22004';
    end if;
    perform pg_advisory_xact_lock (public.account_deletion_lock_key (p_user));
    if not exists (select 1 from auth.users where id = p_user) then
        return null;
    end if;
    insert into public.account_deletions (user_id) values (p_user)
    on conflict (user_id) do update
    set attempts = public.account_deletions.attempts + 1, updated_at = now();
    insert into public.account_deletion_attempts (user_id, lease_until)
    values (p_user, now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 60)))
    returning attempt into v_attempt;
    return v_attempt;
end;
$$;

-- Called by the attempt right before it deletes anything. False (and nothing
-- recorded) when the attempt is no longer active: it must not start deleting.
create or replace function public.mark_account_deletion_destructive (p_user uuid, p_attempt uuid)
returns boolean language plpgsql security definer
set search_path = public as $$
begin
    perform 1 from public.account_deletion_attempts
    where attempt = p_attempt and user_id = p_user and ended_at is null and lease_until > now()
    for update;
    if not found then
        return false;
    end if;
    update public.account_deletions
    set destructive_started_at = coalesce(destructive_started_at, now()), updated_at = now()
    where user_id = p_user;
    return true;
end;
$$;

-- How an attempt ended without completing. 'abandoned': it deleted nothing
-- (billing could not be stopped); 'failed': it stopped part-way. Either way
-- the attempt is no longer active. The marker goes when no active attempt is
-- left and no destructive cleanup ever began -- the account is then exactly
-- as it was.
create or replace function public.settle_account_deletion_attempt (
    p_user uuid,
    p_attempt uuid,
    p_outcome text,
    p_error text default null
) returns void language plpgsql security definer
set search_path = public as $$
begin
    if p_outcome not in ('abandoned', 'failed') then
        raise exception 'unknown outcome: %', p_outcome using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock (public.account_deletion_lock_key (p_user));
    update public.account_deletion_attempts
    set ended_at = coalesce(ended_at, now()), outcome = coalesce(outcome, p_outcome), error = left(p_error, 200)
    where attempt = p_attempt and user_id = p_user;
    if p_outcome = 'failed' then
        update public.account_deletions
        set last_error = left(p_error, 200), updated_at = now()
        where user_id = p_user;
    end if;
    delete from public.account_deletions d
    where d.user_id = p_user
      and d.destructive_started_at is null
      and not exists (
          select 1 from public.account_deletion_attempts a
          where a.user_id = d.user_id and a.ended_at is null and a.lease_until > now()
      );
end;
$$;

revoke all on function public.begin_account_deletion_attempt (uuid, integer) from public, anon, authenticated;

grant execute on function public.begin_account_deletion_attempt (uuid, integer) to service_role;

revoke all on function public.mark_account_deletion_destructive (uuid, uuid) from public, anon, authenticated;

grant execute on function public.mark_account_deletion_destructive (uuid, uuid) to service_role;

revoke all on function public.settle_account_deletion_attempt (uuid, uuid, text, text) from public, anon, authenticated;

grant execute on function public.settle_account_deletion_attempt (uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- The refusal on documents and managed_students, through the one predicate
-- ---------------------------------------------------------------------------
create or replace function public.refuse_insert_during_account_deletion () returns trigger
language plpgsql security definer
set search_path = public as $$
declare
    v_owner uuid;
begin
    -- Separate statements: a field reference is planned against this table's
    -- row type, so naming the other table's column would fail here.
    if tg_table_name = 'documents' then
        v_owner := new.owner_id;
    else
        v_owner := new.teacher_id;
    end if;
    if public.account_deletion_pending (v_owner) then
        raise exception 'account_deletion_pending'
            using errcode = '55000',
                  hint = 'This account is being deleted, so nothing new can be added to it.';
    end if;
    return new;
end;
$$;

revoke all on function public.refuse_insert_during_account_deletion () from public, anon, authenticated;
