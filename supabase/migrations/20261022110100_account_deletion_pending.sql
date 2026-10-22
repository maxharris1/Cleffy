-- Account deletion: a durable "deletion pending" marker, taken first.
--
-- delete-account (_shared/accountDeletion.ts) deleted a teacher's students and
-- scores in two fixed sweeps while the account was still live, so a score
-- uploaded or a student provisioned from another tab after the second sweep
-- listed its rows survived it: the score's row went with the auth user's
-- cascade but its Storage objects stayed behind, and a student account created
-- mid-delete (student-provision) was left with no teacher at all.
--
-- Now the deletion writes a marker for the account BEFORE anything else, and
-- while it stands the database refuses any new score (documents) or roster row
-- (managed_students) for that account, whoever inserts it -- the owner's own
-- tab, an import under the service role, student-provision. The cleanup then
-- works from a state that cannot grow: it sweeps until a pass finds nothing.
--
-- The marker and the inserts serialize on a per-account advisory lock: taking
-- the marker waits for every insert for that account already in flight to
-- commit, and an insert that starts afterwards sees the marker. So no row can
-- slip in between the marker and the sweep that lists it.
--
-- Its lifecycle:
--   * begin_account_deletion   -- the first step of every attempt; counts it;
--   * settle_account_deletion  -- 'abandoned' when the attempt deleted nothing
--     (billing could not be stopped), which clears it and gives the account
--     back as it was; 'failed' when it stopped part-way, which KEEPS it (with
--     the error) so the half-deleted account cannot grow while the person
--     retries;
--   * the auth user's delete cascades it away when the deletion completes.
--
-- Service role only, like support_messages.
create table if not exists public.account_deletions (
    user_id uuid primary key references auth.users (id) on delete cascade,
    started_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    attempts integer not null default 1,
    -- The failure code of the last attempt that stopped part-way.
    last_error text
);

alter table public.account_deletions enable row level security;

revoke all on table public.account_deletions from public;

revoke all on table public.account_deletions from anon;

revoke all on table public.account_deletions from authenticated;

grant all on table public.account_deletions to service_role;

-- The per-account lock both sides take: exclusive to set the marker, shared to
-- insert. hashtext collisions only make two accounts wait on each other.
create or replace function public.account_deletion_lock_key (p_user uuid) returns bigint
language sql immutable
set search_path = public as $$
    select (hashtext('account_deletion')::bigint << 32) | (hashtext(p_user::text)::bigint & 4294967295);
$$;

revoke all on function public.account_deletion_lock_key (uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- begin / settle (service role only)
-- ---------------------------------------------------------------------------
create or replace function public.begin_account_deletion (p_user uuid) returns integer
language plpgsql security definer
set search_path = public as $$
declare
    v_attempts integer;
begin
    if p_user is null then
        raise exception 'p_user is required' using errcode = '22004';
    end if;
    -- Waits for any score or roster insert for this account still in flight.
    perform pg_advisory_xact_lock (public.account_deletion_lock_key (p_user));
    -- An account already gone (a retry after the auth delete landed) has
    -- nothing left to guard: 0, and no marker.
    if not exists (select 1 from auth.users where id = p_user) then
        return 0;
    end if;
    insert into public.account_deletions (user_id) values (p_user)
    on conflict (user_id) do update
    set attempts = public.account_deletions.attempts + 1, updated_at = now()
    returning attempts into v_attempts;
    return v_attempts;
end;
$$;

create or replace function public.settle_account_deletion (p_user uuid, p_outcome text, p_error text default null)
returns void language plpgsql security definer
set search_path = public as $$
begin
    if p_outcome = 'abandoned' then
        delete from public.account_deletions where user_id = p_user;
    elsif p_outcome = 'failed' then
        update public.account_deletions
        set last_error = left(p_error, 200), updated_at = now()
        where user_id = p_user;
    else
        raise exception 'unknown outcome: %', p_outcome using errcode = '22023';
    end if;
end;
$$;

revoke all on function public.begin_account_deletion (uuid) from public, anon, authenticated;

grant execute on function public.begin_account_deletion (uuid) to service_role;

revoke all on function public.settle_account_deletion (uuid, text, text) from public, anon, authenticated;

grant execute on function public.settle_account_deletion (uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- The refusal: no new score or roster row for an account being deleted
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so the owner's own tab (authenticated, no grant on the
-- table) is checked against the marker it cannot read.
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
    if v_owner is null then
        return new;
    end if;
    -- Held to this transaction's end, so a deletion starting now waits for it.
    perform pg_advisory_xact_lock_shared (public.account_deletion_lock_key (v_owner));
    if exists (select 1 from public.account_deletions where user_id = v_owner) then
        raise exception 'account_deletion_pending'
            using errcode = '55000',
                  hint = 'This account is being deleted, so nothing new can be added to it.';
    end if;
    return new;
end;
$$;

revoke all on function public.refuse_insert_during_account_deletion () from public, anon, authenticated;

drop trigger if exists documents_refuse_during_account_deletion on public.documents;

create trigger documents_refuse_during_account_deletion
before insert on public.documents
for each row execute function public.refuse_insert_during_account_deletion ();

drop trigger if exists managed_students_refuse_during_account_deletion on public.managed_students;

create trigger managed_students_refuse_during_account_deletion
before insert on public.managed_students
for each row execute function public.refuse_insert_during_account_deletion ();
