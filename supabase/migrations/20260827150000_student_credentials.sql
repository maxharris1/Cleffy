-- Student credentials: a code becomes a claim token, and email joins it.
--
-- The model this replaces: the login code was the whole credential — its hash
-- selected the roster row AND it was the synthetic account's Supabase password,
-- forever. That is a password a child reads off a card, cannot change, and
-- shares with whoever picks the card up off the piano.
--
-- The model this establishes: the teacher picks a method per student, once, at
-- creation, and `auth_method` is fixed for the life of the row.
--
--  * 'code' — the zero-email path, for a young child. The printed code is a
--    ONE-TIME CLAIM TOKEN: student-claim spends it to choose a username and a
--    password, and from then on student-login takes those. The synthetic
--    st-<roster-id>@students.cleffy.app address stays, because Supabase needs
--    something to key an auth user on and no inbox is ever asked for.
--  * 'email' — the teacher supplies the student's real address and GoTrue
--    invites it. There is no code, no username and no synthetic address: the
--    student sets a password from the emailed link and signs in client-side,
--    exactly as a teacher does.
--
-- Four states, and this file's CHECK constraint is what makes them the only
-- four. "Invited" always means the same thing on both paths: the auth password
-- is a scramble nobody has ever seen (generateProvisionPassword), so no sign-in
-- path exists for the account at all.
--
--   code  + Invited : login_code_hash set, claimed_at null   -> student-claim
--   code  + Active  : username set, login_code_hash NULL     -> student-login
--   email + Invited : student_email set, claimed_at null     -> the invite link
--   email + Active  : student_email set, claimed_at stamped  -> ordinary sign-in
--
-- A reset returns either row to Invited, and scrambles the password FIRST —
-- that scramble is the actual revocation, exactly as the archive ban is.
-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table public.managed_students
    add column auth_method text not null default 'code'
        check (auth_method in ('code', 'email')),
    -- Stored canonical-lowercase (normalizeUsername runs before every write and
    -- every lookup), which is what makes the plain unique index below a
    -- CASE-INSENSITIVE uniqueness guarantee without a functional index or a
    -- citext column: two spellings that differ only in case are the same string
    -- by the time either one reaches this table.
    add column username text,
    -- The student's REAL address, on the email path only. Never a synthetic one:
    -- those are derived from the roster id and stored nowhere.
    add column student_email text,
    -- Setup-complete. On the code path the claim stamps it; on the email path
    -- the student does, through mark_student_claimed() below.
    add column claimed_at timestamptz,
    -- Was NOT NULL when the code was a permanent password. It is now absent for
    -- a claimed code student (spent) and for every email student (never minted).
    alter column login_code_hash drop not null;

-- The DB re-checks USERNAME_RE from _shared/studentCodes.ts. A service-role bug
-- that stored an un-normalized spelling would store one student-login could
-- never match — this refuses it at the table instead.
alter table public.managed_students add constraint managed_students_username_shape
    check (username is null or username ~ '^[a-z0-9_]{3,20}$');

-- Plain unique index, not partial: NULLs are distinct in Postgres, so every
-- email row and every unclaimed code row coexists freely.
create unique index managed_students_username_key on public.managed_students (username);

-- The state machine, enforced. Note what is deliberately NOT constrained: an
-- Invited code row may carry a username left over from a previous claim. Reset
-- does not clear it, because the next claim overwrites it and keeping-or-
-- changing the name is the student's call, not the teacher's.
--
-- Existing rows all satisfy the first branch: auth_method defaults to 'code',
-- student_email is null, claimed_at is null, and login_code_hash was NOT NULL.
alter table public.managed_students add constraint managed_students_claim_state check (
    (auth_method = 'code' and student_email is null and (
        (claimed_at is null and login_code_hash is not null)
        or (claimed_at is not null and username is not null and login_code_hash is null)))
    or (auth_method = 'email' and student_email is not null
        and login_code_hash is null and username is null));

-- ---------------------------------------------------------------------------
-- mark_student_claimed — the email student stamps their own setup-complete
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because managed_students has no client write policy at all,
-- by design (see 20260826194426_roster.sql): every write is either a definer
-- function or the service role. A code student's claim is stamped by
-- student-claim under the service role, in the same UPDATE that sets the
-- username; an email student never touches an Edge Function on their way in, so
-- this is the one write they need.
--
-- Scoped to auth.uid(), so the caller can only ever stamp their own row — the
-- function takes no arguments precisely so there is no row to aim it at.
--
-- The auth_method guard is not redundant. Without it, a code student calling
-- this would set claimed_at on a row whose username is still null, the
-- managed_students_claim_state CHECK would reject the UPDATE, and this function
-- would RAISE rather than no-op. Refusing to match the row is the tolerant
-- spelling of the same rule.
create or replace function public.mark_student_claimed () returns void
language sql security definer set search_path = public as $$
    update public.managed_students
    set claimed_at = now()
    where student_user_id = auth.uid()
      and auth_method = 'email'
      and claimed_at is null;
$$;

revoke all on function public.mark_student_claimed () from public;

revoke all on function public.mark_student_claimed () from anon;

grant execute on function public.mark_student_claimed () to authenticated;

-- ---------------------------------------------------------------------------
-- Grants (same convention as roster.sql)
-- ---------------------------------------------------------------------------
-- Additive to roster.sql's column grant, and login_code_hash stays out of it for
-- the same reason it was excluded there: managed_students_select has a student
-- branch, so a table-wide grant would ship the hash of a live claim token down
-- to a browser, for a value nothing on the client reads and that only
-- student-claim ever compares, under the service role.
--
-- The four new columns are all things a client legitimately renders: the student
-- app shows a claimed username on the account screen and the teacher's roster
-- shows which method a student is on, whether they have finished setting up, and
-- which address the invite went to.
grant select (auth_method, username, student_email, claimed_at)
on table public.managed_students to authenticated;

-- roster.sql revoked from public/anon/authenticated but never granted to
-- service_role, which is a no-op hosted (the default ACL is permissive there)
-- and a 42501 locally — the same trap 20260827140000_core_table_grants.sql
-- documents for the core tables. student-claim writes this table under the
-- service role, so it has to hold locally too.
grant all on table public.managed_students to service_role;
