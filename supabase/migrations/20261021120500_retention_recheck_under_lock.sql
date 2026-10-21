-- Retention: lock each candidate and re-check it before purging it.
--
-- The purges in 20261021120300 listed their candidates once and then acted on
-- the list. A teacher who restored an archived student after the list was read
-- (or a guest who came back) was purged anyway: the loop scrubbed and deleted
-- whatever the list held, without looking again.
--
-- Now the list is only a list of names. Each candidate is locked in a statement
-- of its own, FOR UPDATE SKIP LOCKED, with the eligibility test repeated in
-- that statement:
--
--  * a restore (or sign-in) that committed since the list was read is seen,
--    because the locking statement takes a fresh snapshot and FOR UPDATE
--    re-tests its conditions against the newest row; the candidate is no
--    longer eligible and is skipped;
--  * a restore still in flight holds the row, so SKIP LOCKED passes over it
--    rather than waiting to delete it the moment it commits; the next night's
--    run looks again;
--  * a restore that arrives after the lock waits for the purge to commit, and
--    then finds no row: student-provision now reports that instead of
--    answering ok for a restore that matched nothing.
--
-- The archived-student lock is on the managed_students row, the same row
-- Delete student (20261021120400) locks and every student write shares, so a
-- purge and the student's own writes serialize the same way.

create or replace function public.retention_purge_archived_students (
    p_older_than interval default interval '12 months',
    p_batch int default 200
) returns int
language plpgsql security definer
set search_path = public as $$
declare
    candidate record;
    v_student uuid;
    v_cutoff timestamptz := now() - p_older_than;
    purged int := 0;
begin
    for candidate in
        select m.id
        from public.managed_students m
        join auth.users u on u.id = m.student_user_id
        where m.archived_at is not null
          and m.archived_at < v_cutoff
          and u.raw_app_meta_data ->> 'user_type' = 'student'
        order by m.archived_at
        limit greatest(p_batch, 0)
    loop
        select m.student_user_id into v_student
        from public.managed_students m
        join auth.users u on u.id = m.student_user_id
        where m.id = candidate.id
          and m.archived_at is not null
          and m.archived_at < v_cutoff
          and u.raw_app_meta_data ->> 'user_type' = 'student'
        for update of m skip locked;

        if not found then
            continue;
        end if;

        perform public.scrub_student_markings (v_student);
        delete from auth.users where id = v_student;
        purged := purged + 1;
    end loop;
    return purged;
end;
$$;

revoke all on function public.retention_purge_archived_students (interval, int) from public, anon, authenticated;
grant execute on function public.retention_purge_archived_students (interval, int) to service_role;

-- When a guest last did anything: the latest of the account's creation, its
-- last sign-in, its last update and its sessions' last refresh (the same
-- reading 20261021120300 used, now in one place so the list and the re-check
-- cannot drift apart).
create or replace function public.retention_guest_last_active (p_user uuid) returns timestamptz
language sql stable security definer
set search_path = public as $$
    select greatest(
        u.created_at,
        coalesce(u.last_sign_in_at, u.created_at),
        coalesce(u.updated_at, u.created_at),
        coalesce(
            (
                select max(greatest(s.updated_at, s.refreshed_at at time zone 'UTC', s.created_at))
                from auth.sessions s
                where s.user_id = u.id
            ),
            u.created_at
        )
    )
    from auth.users u
    where u.id = p_user;
$$;

revoke all on function public.retention_guest_last_active (uuid) from public, anon, authenticated;
grant execute on function public.retention_guest_last_active (uuid) to service_role;

create or replace function public.retention_purge_stale_guests (
    p_idle interval default interval '90 days',
    p_batch int default 1000
) returns int
language plpgsql security definer
set search_path = public as $$
declare
    candidate record;
    v_cutoff timestamptz := now() - p_idle;
    purged int := 0;
begin
    for candidate in
        select u.id
        from auth.users u
        where u.is_anonymous
          and public.retention_guest_last_active (u.id) < v_cutoff
        order by u.created_at
        limit greatest(p_batch, 0)
    loop
        perform 1
        from auth.users u
        where u.id = candidate.id
          and u.is_anonymous
          and public.retention_guest_last_active (u.id) < v_cutoff
        for update skip locked;

        if not found then
            continue;
        end if;

        delete from auth.users where id = candidate.id;
        purged := purged + 1;
    end loop;
    return purged;
end;
$$;

revoke all on function public.retention_purge_stale_guests (interval, int) from public, anon, authenticated;
grant execute on function public.retention_purge_stale_guests (interval, int) to service_role;
