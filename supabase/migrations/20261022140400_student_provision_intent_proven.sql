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
-- student_provision_intents_proven() says so: the same rows and columns as
-- student_provision_intents_for() (20261022140300), plus proven, true only
-- for (A). The automatic cleanup deletes only a proven account; one named by
-- address alone, or recorded but made outside the window, is left, with its
-- intent, for a person (the runbook). student_user_id still names whichever
-- account the intent points at, for the log and the runbook.
--
-- status tells the automatic cleanup which of DEPLOY.md's cases an intent is
-- (PR #72 fix 3): 'proven' (A); 'unproven', an account named without proof;
-- 'unproven_match', nothing recorded and nothing named, but an account with
-- no roster row sits at the intent's address (outside the window, or another
-- intent's): case 5, so the intent is kept and logged for the runbook rather
-- than read as "nothing was created" and cleared; 'none', no account to
-- resolve (case 1), or only rostered ones at the address (case 2).
--
-- A new function rather than more columns on the old one: changing a
-- function's result type needs a DROP, and an ordered replay of the earlier
-- migrations over this database (CI's re-apply step, a recovery) would then
-- stop at 20261022110600's CREATE OR REPLACE of the old shape. This one is
-- dropped and created again for the same reason (its status column came
-- after its first version, which no hosted project ever applied); nothing
-- else depends on it.
-- student_provision_intents_for() stays as 20261022140300 left it, for an
-- older delete-account. delete-account calls the new one: deploy it after
-- this migration (an older database has no such function, and the deletion
-- then stops with deletion_unavailable rather than delete on an address).
--
-- Rerunnable: dropped and created with the same signature and privileges.

drop function if exists public.student_provision_intents_proven (uuid);

-- 20261022140300's student_provision_intents_for(), plus proven and status.
create function public.student_provision_intents_proven (p_teacher uuid)
returns table (roster_id uuid, student_user_id uuid, live boolean, proven boolean, status text)
language sql stable security definer
set search_path = public as $$
    select n.roster_id, n.student_user_id, n.live, n.proven,
           case
               when n.proven then 'proven'
               when n.student_user_id is not null then 'unproven'
               -- Nothing recorded (student_user_id would name it) and nothing
               -- found inside the window: any unrostered account at the address
               -- is DEPLOY.md's case 5, never "nothing was created".
               when exists (
                   select 1 from auth.users u
                   where lower(u.email) = n.auth_email
                     and not exists (select 1 from public.managed_students m where m.student_user_id = u.id)
               ) then 'unproven_match'
               else 'none'
           end
    from (
        select i.roster_id, i.auth_email, i.created_at,
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
               ) as student_user_id,
               i.expires_at > now() as live,
               -- DEPLOY.md's proof (A): recorded, and created inside the window.
               i.student_user_id is not null and exists (
                   select 1 from auth.users r
                   where r.id = i.student_user_id
                     and r.created_at >= i.created_at - interval '1 minute'
                     and r.created_at <= i.expires_at
               ) as proven
        from public.student_provision_intents i
        where i.teacher_id = p_teacher
    ) n
    order by n.created_at;
$$;

revoke all on function public.student_provision_intents_proven (uuid) from public, anon, authenticated;

grant execute on function public.student_provision_intents_proven (uuid) to service_role;

-- DEPLOY: apply before deploying delete-account (it calls this; see above).
