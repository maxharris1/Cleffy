-- Storage: the signed-in owner can read their own usage and cap (decision
-- 50(3), P1 follow-up: the storage-full message shows usage and the cap).
--
-- An upload past the quota is refused by storage_objects_enforce_quota()
-- (20261022101000) with `storage_quota_exceeded`, and the error's detail
-- carries limit_bytes and used_bytes. The Storage API hands the app only the
-- message, not the detail, so the app said "your storage is full" with no
-- numbers. my_storage_usage() answers the caller's own figures, from the same
-- two functions the quota uses: storage_owner_bytes() (everything stored in
-- both buckets under the caller's scores, archived ones and deleted ones still
-- awaiting cleanup included) and storage_quota_bytes() for the caller's
-- resolved tier.
--
-- It reads only the caller's own account (auth.uid()); no argument names
-- anyone else. Without a signed-in caller it refuses (42501). Read-only,
-- takes no lock.
--
-- Rerunnable: the function is replaced with the same signature and its
-- privileges reset to the same end state.

create or replace function public.my_storage_usage () returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare
    v_user uuid := auth.uid ();
begin
    if v_user is null then
        raise exception 'sign in to read your storage use' using errcode = '42501';
    end if;
    return jsonb_build_object(
        'used_bytes', public.storage_owner_bytes (v_user),
        'limit_bytes', public.storage_quota_bytes (public.resolve_entitlements (v_user) ->> 'tier')
    );
end;
$$;

revoke all on function public.my_storage_usage () from public, anon;

grant execute on function public.my_storage_usage () to authenticated, service_role;

-- DEPLOY: apply before (or with) the frontend that calls it; without it the
-- storage-full message falls back to the old wording (no numbers).
