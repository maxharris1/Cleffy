-- Age-gate backstop on auth.users INSERT.
--
-- 20261021120000_consent_age.sql's before_user_created hook is what GoTrue
-- calls for email sign-up, anonymous guest sign-in, and inviteUserByEmail.
-- The comment on that migration also named the admin API's createUser. That
-- is wrong: GoTrue does not run before_user_created for admin createUser, so
-- a service-role createUser with no age_gate succeeds (prod smoke test,
-- 2026-11-11). This trigger is the database backstop for that path.
--
-- It fires only when the inserting role is supabase_auth_admin — GoTrue's
-- role for every creation, including admin createUser. Direct SQL as
-- postgres / supabase_admin is the documented exemption: seed.sql, SQL
-- fixtures, and migrations insert fixture users without an age_gate and
-- must keep working. Those roles never serve a request.
--
-- The one app path that uses admin createUser is student-provision's code
-- method. It already writes the teacher's attestation as user_metadata
-- age_gate (source: "teacher"); this trigger accepts that the same way the
-- hook accepts a self sign-up's age_gate. inviteUserByEmail already goes
-- through the hook and still passes this check.
--
-- Anonymous guests are unchanged: signInAnonymously still carries age_gate,
-- GoTrue still inserts as supabase_auth_admin, and a passing gate gets
-- through here the same as through the hook.

create or replace function public.enforce_age_gate_on_user () returns trigger
language plpgsql
set search_path = ''
as $$
declare
    problem text;
begin
    if current_user is distinct from 'supabase_auth_admin' then
        return new;
    end if;
    problem := public.age_gate_problem (coalesce(new.raw_user_meta_data, '{}'::jsonb));
    if problem is null then
        return new;
    end if;
    if problem = 'age_check_missing' then
        raise exception 'Sign-up needs the age check first. Reload the page and try again.'
            using errcode = '22023';
    end if;
    raise exception 'Sorry, you can’t create a Cleffy account.'
        using errcode = '42501';
end;
$$;

revoke all on function public.enforce_age_gate_on_user () from public, anon, authenticated, service_role;
grant execute on function public.enforce_age_gate_on_user () to supabase_auth_admin;

drop trigger if exists enforce_age_gate_on_user on auth.users;
create trigger enforce_age_gate_on_user
before insert on auth.users
for each row
execute function public.enforce_age_gate_on_user ();
