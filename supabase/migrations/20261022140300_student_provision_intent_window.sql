-- Provisioning intents: the email fallback is bounded to the intent's window.
--
-- student_provision_intents_for() (20261022110600) names, for each intent of a
-- teacher being deleted, the Auth account the provisioning made: the one
-- attach_student_provision() recorded, or, when the request crashed between
-- the Auth create and the attach, an account found by the intent's address.
-- That fallback took the earliest account at the address created from one
-- minute before the intent on, with no upper bound: a separate signup made at
-- the same address days later, or the account another intent for the same
-- address created and recorded, could be named as this provisioning's.
--
-- Now the fallback only finds an account created inside the intent's window,
-- from one minute before its created_at (the allowance it always had) to its
-- expires_at, after which the request that wrote it can no longer be running
-- (DEPLOY.md's orphaned-provisioning runbook uses the same window), and never
-- one that another intent recorded as its own. The recorded account is
-- returned as before. Same signature and columns; the deletion's own rule for
-- what it may delete is 20261022140400's.
--
-- Rerunnable: the function is replaced with the same signature, and its
-- privileges reset to the same end state.

-- 20261022110600's definition, with the fallback bounded.
create or replace function public.student_provision_intents_for (p_teacher uuid)
returns table (roster_id uuid, student_user_id uuid, live boolean)
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
           i.expires_at > now()
    from public.student_provision_intents i
    where i.teacher_id = p_teacher
    order by i.created_at;
$$;

revoke all on function public.student_provision_intents_for (uuid) from public, anon, authenticated;

grant execute on function public.student_provision_intents_for (uuid) to service_role;

-- DEPLOY: no order constraint; delete-account reads the same columns.
