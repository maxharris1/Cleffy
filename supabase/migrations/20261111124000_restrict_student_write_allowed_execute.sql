-- Restrict student_write_allowed() to authenticated (and service_role).
--
-- The security advisor flags EXECUTE granted to anon (and PUBLIC's default).
-- This function is SECURITY DEFINER with search_path already pinned to public
-- (20261021120400). It is not an RPC and is not used in any RLS policy. The
-- only caller is refuse_revoked_student_write(), a SECURITY INVOKER statement
-- trigger on annotations / annotation_snapshots. Signed-out flows do not
-- depend on it: anon has no INSERT/UPDATE on those tables
-- (20261022100700), and student_write_allowed() returns true when
-- auth.uid() is null. The trigger still named anon, so a later client write
-- grant would call the function as anon and fail 42501. Skip that call.

alter function public.student_write_allowed () set search_path = public;

revoke all on function public.student_write_allowed () from public;
revoke all on function public.student_write_allowed () from anon;
grant execute on function public.student_write_allowed () to authenticated, service_role;

create or replace function public.refuse_revoked_student_write () returns trigger language plpgsql
set search_path = public as $$
begin
    if current_user = 'authenticated' and not public.student_write_allowed () then
        raise exception 'this student''s access has been withdrawn' using errcode = '42501';
    end if;
    return null;
end;
$$;
