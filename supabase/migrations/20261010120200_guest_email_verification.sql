-- Proving a guest owns an email address before it is attached to their account.
--
-- A share-link guest is an anonymous auth user. The upgrade banner used to call
-- supabase.auth.updateUser({ email }) straight from the browser, and with
-- mailer_autoconfirm on (it is on both projects: sign-ups are not confirmed)
-- GoTrue confirmed the change on the spot without sending anything. A guest
-- could therefore claim any address — the real owner then met "an account with
-- this email already exists" at sign-up, and a password reset to that address
-- would have handed the guest's account to whoever reads the mailbox.
--
-- The guest-email-start / guest-email-confirm Edge Functions replace that path
-- whatever the auth settings say: start emails a one-time code to the address
-- and records its HMAC here; confirm checks the code, and only then attaches
-- the email and a password with the admin API. Taking the call out of the app
-- is not enough on its own — GoTrue's PUT /auth/v1/user still takes it from
-- anyone holding a guest JWT and the public anon key — so a trigger on
-- auth.users (at the end of this file) refuses to give a guest an address the
-- code has not proven, whichever way the update arrives. Nothing is stored in the clear:
-- the code is HMAC'd with the user id and the address under a server secret,
-- so a row read out of a backup proves nothing, and the address is kept only
-- to bind the code to the one it was sent to.
--
-- Service-role only, like edge_login_attempts: RLS on with no policies, no
-- client grants, and the code check executable by service_role alone.

create table public.guest_email_verifications (
    -- One pending address per guest: asking again replaces the code.
    user_id uuid primary key references auth.users (id) on delete cascade,
    email text not null check (length(email) between 3 and 254 and email = lower(email)),
    code_hash text not null check (length(code_hash) between 1 and 200),
    attempts int not null default 0 check (attempts >= 0),
    expires_at timestamptz not null,
    -- The address check_guest_email_code last answered 'ok' for, and when:
    -- the auth.users guard lets that address onto this guest for a few
    -- minutes after. Its own column, not `email`, so a new code asked for
    -- another address can never inherit the proof.
    verified_email text,
    verified_at timestamptz,
    check ((verified_email is null) = (verified_at is null)),
    created_at timestamptz not null default now()
);

create index guest_email_verifications_expires on public.guest_email_verifications (expires_at);

alter table public.guest_email_verifications enable row level security;

revoke all on table public.guest_email_verifications from public, anon, authenticated;
grant select, insert, update, delete on table public.guest_email_verifications to service_role;

-- Check one code against the guest's pending verification, counting the try.
--
-- Answers:
--   'ok'       the code matches the address it was sent to. The row is KEPT,
--              stamped verified_email/_at for the auth.users guard: the caller deletes
--              it once the email is attached, so an attach that fails
--              transiently can be retried with the same code.
--   'mismatch' wrong code (or a different address); one try spent.
--   'locked'   that was the last try p_max_attempts allows; the row is gone.
--   'expired'  past expires_at; the row is gone.
--   'missing'  no code was ever sent, or it was already used up.
--
-- The row lock serialises parallel tries, so a burst of guesses is counted one
-- at a time and cannot outrun p_max_attempts. SECURITY INVOKER: its only
-- caller, the service role, already holds the table grants.
create or replace function public.check_guest_email_code (
    p_user_id uuid,
    p_email text,
    p_code_hash text,
    p_max_attempts int
) returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
    v public.guest_email_verifications%rowtype;
begin
    if p_user_id is null or p_email is null or p_code_hash is null
        or p_max_attempts is null or p_max_attempts < 1 then
        raise exception 'check_guest_email_code: invalid arguments' using errcode = '22023';
    end if;

    select * into v from public.guest_email_verifications where user_id = p_user_id for update;
    if not found then
        return 'missing';
    end if;

    if v.expires_at <= clock_timestamp() then
        delete from public.guest_email_verifications where user_id = p_user_id;
        return 'expired';
    end if;

    if v.attempts >= p_max_attempts then
        delete from public.guest_email_verifications where user_id = p_user_id;
        return 'locked';
    end if;

    if v.email = lower(trim(p_email)) and v.code_hash = p_code_hash then
        update public.guest_email_verifications
        set attempts = attempts + 1, verified_email = v.email, verified_at = clock_timestamp()
        where user_id = p_user_id;
        return 'ok';
    end if;

    if v.attempts + 1 >= p_max_attempts then
        delete from public.guest_email_verifications where user_id = p_user_id;
        return 'locked';
    end if;
    update public.guest_email_verifications set attempts = attempts + 1 where user_id = p_user_id;
    return 'mismatch';
end;
$$;

revoke all on function public.check_guest_email_code (uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.check_guest_email_code (uuid, text, text, int) to service_role;

-- Does any account already use this address? guest-email-start asks before it
-- sends a code, so a guest is told to sign in instead of being mailed a code
-- that could never attach (GoTrue refuses a duplicate with email_exists, which
-- guest-email-confirm still handles for the race). It answers a boolean and
-- nothing else about the account — the same fact sign-up already states.
--
-- SECURITY DEFINER because auth.users is not readable by the service role's
-- grants on every project; search_path is empty so every name is qualified,
-- and the caller must be the service role — a client calling it would have a
-- free, unthrottled oracle over every address, which is why it is not granted
-- to anon or authenticated either.
create or replace function public.guest_email_taken (p_email text) returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if coalesce(auth.role (), '') <> 'service_role' then
        raise exception 'guest_email_taken is for the service role only' using errcode = '42501';
    end if;
    if p_email is null or length(trim(p_email)) = 0 then
        return false;
    end if;
    return exists (
        select 1 from auth.users u where lower(u.email) = lower(trim(p_email))
    );
end;
$$;

revoke all on function public.guest_email_taken (text) from public, anon, authenticated;
grant execute on function public.guest_email_taken (text) to service_role;

-- The server-side half: a guest gets an email address only once it is proven.
--
-- GoTrue lets an anonymous user add an email with PUT /auth/v1/user, and with
-- mailer_autoconfirm on it confirms the change in the same request, mailing
-- nobody (api/user.go: "anonymous users can add an email with automatic
-- confirmation"). The app no longer makes that call, but anybody can, with
-- their own guest JWT and the public anon key — so this refuses the result
-- unless guest-email-confirm has just checked a code for exactly that address.
--
-- What is refused, on a row that is or was a guest in this transaction:
--   * becoming registered (is_anonymous true → false) with no code checked
--     ('ok' from check_guest_email_code) in the last 10 minutes;
--   * gaining or changing its email to anything but the address that code
--     was sent to.
-- "Was a guest in this transaction" matters because GoTrue does it in steps,
-- and today clears is_anonymous BEFORE it sets the email on both paths — the
-- user path (verify.go emailChangeVerify) and the admin path guest-email-
-- confirm uses (admin.go adminUserUpdate) — so by the time the email arrives
-- the row no longer says it was a guest. The step that clears is_anonymous
-- leaves the id in a transaction-local setting, which only ever adds the
-- address check to the later step. Either order, or one statement, is held to
-- the same rule. Registered accounts are untouched: GoTrue already mails both
-- addresses before it changes theirs, and nobody can set a setting on GoTrue's
-- connection to escape the check.
--
-- Refused with 42501; GoTrue rolls the whole request back and answers 500.
-- SECURITY DEFINER because GoTrue updates as supabase_auth_admin, which holds
-- no grant on the table; search_path is empty, so every name is qualified.
-- Nobody calls it: a trigger function cannot be called directly, and EXECUTE
-- is revoked all the same.
create or replace function public.guard_guest_email () returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_upgrades text := coalesce(current_setting('cleffy.guest_upgrades', true), '');
    v_leaving boolean := old.is_anonymous and not new.is_anonymous;
    v_email_changes boolean := nullif(new.email, '') is not null
        and lower(coalesce(old.email, '')) is distinct from lower(new.email);
    v_proven text;
begin
    -- A soft delete overwrites the email with an obfuscated one; that is not
    -- an address being attached.
    if not (v_leaving or v_email_changes) or new.deleted_at is not null then
        return new;
    end if;
    if not (old.is_anonymous or new.is_anonymous or strpos(v_upgrades, new.id::text) > 0) then
        return new;
    end if;

    select g.verified_email into v_proven
    from public.guest_email_verifications g
    where g.user_id = new.id
        and g.verified_at > clock_timestamp() - interval '10 minutes';
    if not found then
        raise exception 'a guest account gets an email address only through guest-email-confirm'
            using errcode = '42501';
    end if;
    if v_email_changes and lower(new.email) <> v_proven then
        raise exception 'that is not the address the guest proved'
            using errcode = '42501';
    end if;

    if v_leaving then
        perform set_config('cleffy.guest_upgrades', v_upgrades || new.id::text || ',', true);
    end if;
    return new;
end;
$$;

revoke all on function public.guard_guest_email () from public, anon, authenticated, service_role;

create trigger guard_guest_email
before update of email, is_anonymous on auth.users
for each row
when (old.email is distinct from new.email or old.is_anonymous is distinct from new.is_anonymous)
execute function public.guard_guest_email ();
