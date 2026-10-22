-- Provisioning intents: automatic cleanup deletes only a proven account.
--
-- Account deletion (delete-account, _shared/accountDeletion.ts) deletes the
-- Auth account each of the teacher's provisioning intents names
-- (student_provision_intents_for()) once it is flagged as the teacher's
-- student. When nothing was recorded the account is found by the intent's
-- address (bounded to the intent's window since 20261022140300), and an
-- address match is never proof that this provisioning made the account: a
-- later request for the same teacher and address creates, attaches and flags
-- its own account before its roster insert, so that account sits unrostered
-- inside this intent's window while its request runs; a separate signup made
-- inside the window fits too. DEPLOY.md's orphaned-provisioning runbook has
-- one proof that permits deleting, (A): the account is the one the intent
-- recorded (attach_student_provision()) and it was created inside the window.
--
-- The function now says so in a new column, proven: true only for (A). The
-- automatic cleanup deletes only a proven account; one named by address alone,
-- or recorded but made outside the window, is left, with its intent, for a
-- person (the runbook). student_user_id still names whichever account the
-- intent points at, for the log and the runbook.
--
-- The column changes the function's result type, so it is dropped and created
-- again, in one transaction with nothing in between. delete-account reads the
-- new column; an older delete-account ignores it (deploy the new one right
-- after this migration). A newer delete-account against a database without
-- this migration reads no proven column, treats every intent as unproven and
-- deletes nothing through intents: the safe side.
--
-- Rerunnable: dropped if present and created again with the same privileges.

drop function if exists public.student_provision_intents_for (uuid);

-- 20261022140300's definition, plus proven.
create function public.student_provision_intents_for (p_teacher uuid)
returns table (roster_id uuid, student_user_id uuid, live boolean, proven boolean)
language sql stable security definer
set search_path = public as $$
    select i.roster_id,
           coalesce(
               i.student_user_id,
               (select u.id from auth.users u
                where lower(u.email) = i.auth_email
                  and u.created_at >= i.created_at - interval '1 minute'
                  and u.created_at <= i.expires_at
                  and not exists (
                      select 1 from public.student_provision_intents other
                      where other.roster_id <> i.roster_id and other.student_user_id = u.id
                  )
                order by u.created_at limit 1)
           ),
           i.expires_at > now(),
           -- DEPLOY.md's proof (A): recorded, and created inside the window.
           i.student_user_id is not null and exists (
               select 1 from auth.users r
               where r.id = i.student_user_id
                 and r.created_at >= i.created_at - interval '1 minute'
                 and r.created_at <= i.expires_at
           )
    from public.student_provision_intents i
    where i.teacher_id = p_teacher
    order by i.created_at;
$$;

revoke all on function public.student_provision_intents_for (uuid) from public, anon, authenticated;

grant execute on function public.student_provision_intents_for (uuid) to service_role;

-- DEPLOY: deploy delete-account right after this migration (see above).
