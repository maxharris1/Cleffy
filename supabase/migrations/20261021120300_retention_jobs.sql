-- Retention: what Cleffy keeps, and for how long, enforced by pg_cron.
--
-- The launch retention decisions, as jobs rather than promises:
--
--   archived roster students   12 months after archiving   daily
--   share-link guests          90 days without activity     daily
--   rate-limit / login buckets 1 day after they last mattered daily
--   inbound support mail       24 months after receipt      daily
--   annotation tombstones      90 days after deletion       weekly
--
-- Each job is its own function, returning how many rows it removed (pg_cron
-- keeps that in cron.job_run_details), and each is bounded per run so a
-- backlog drains over several nights instead of one long lock.
--
-- pg_cron and pg_net are already installed (20260806140000_omr_cron.sql). Jobs
-- run as the postgres role, which owns these functions; nothing else may call
-- them but the service role.
--
-- District data (30 days after a contract ends) is not here: district
-- contracts are not modelled yet (mh/district-seats adds the seat override,
-- not an end date).

-- ---------------------------------------------------------------------------
-- Archived roster students: 12 months after the teacher archived them.
--
-- The same as the teacher's own "Delete student": markings scrubbed first
-- (20261021120200_delete_student_markings.sql), then the auth user, whose
-- cascades take the roster row, assignments, memberships and practice notes.
-- A row whose account is not a provisioned student is skipped rather than
-- guessed at: the scrub refuses it, and so does this.
-- ---------------------------------------------------------------------------
create or replace function public.retention_purge_archived_students (
    p_older_than interval default interval '12 months',
    p_batch int default 200
) returns int
language plpgsql security definer
set search_path = public as $$
declare
    student record;
    purged int := 0;
begin
    for student in
        select m.id, m.student_user_id
        from public.managed_students m
        join auth.users u on u.id = m.student_user_id
        where m.archived_at is not null
          and m.archived_at < now() - p_older_than
          and u.raw_app_meta_data ->> 'user_type' = 'student'
        order by m.archived_at
        limit greatest(p_batch, 0)
    loop
        perform public.scrub_student_markings (student.student_user_id);
        delete from auth.users where id = student.student_user_id;
        purged := purged + 1;
    end loop;
    return purged;
end;
$$;

revoke all on function public.retention_purge_archived_students (interval, int) from public, anon, authenticated;
grant execute on function public.retention_purge_archived_students (interval, int) to service_role;

-- ---------------------------------------------------------------------------
-- Share-link guests: 90 days since the guest last did anything.
--
-- "Anything" is the latest of the account's creation, its last sign-in, its
-- last update, and the last time any of its sessions refreshed — a guest who
-- keeps a tab open on a teacher's score keeps refreshing, and stays. A guest
-- who added an email is no longer anonymous and is never touched here.
--
-- Deleting the auth user is what account deletion does for a guest
-- (_shared/accountDeletion.ts): memberships cascade, and marks the guest drew
-- on a teacher's score stay there with their author cleared
-- (20261007120600_account_deletion.sql).
-- ---------------------------------------------------------------------------
create or replace function public.retention_purge_stale_guests (
    p_idle interval default interval '90 days',
    p_batch int default 1000
) returns int
language plpgsql security definer
set search_path = public as $$
declare
    purged int;
begin
    with stale as (
        select u.id
        from auth.users u
        where u.is_anonymous
          and greatest(
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
          ) < now() - p_idle
        order by u.created_at
        limit greatest(p_batch, 0)
    )
    delete from auth.users u
    using stale
    where u.id = stale.id;
    get diagnostics purged = row_count;
    return purged;
end;
$$;

revoke all on function public.retention_purge_stale_guests (interval, int) from public, anon, authenticated;
grant execute on function public.retention_purge_stale_guests (interval, int) to service_role;

-- ---------------------------------------------------------------------------
-- Rate-limit buckets: a day after they stopped mattering.
--
-- edge_rate_buckets rows are dead once their window resets; edge_login_attempts
-- rows once their last attempt, their lock and their counting window are all
-- in the past (STUDENT_LOGIN_THROTTLE's longest window is an hour). A day's
-- margin keeps anything still being read well clear.
-- ---------------------------------------------------------------------------
create or replace function public.retention_purge_rate_limits (p_idle interval default interval '1 day') returns int
language plpgsql security definer
set search_path = public as $$
declare
    buckets int;
    attempts int;
begin
    delete from public.edge_rate_buckets where reset_at < now() - p_idle;
    get diagnostics buckets = row_count;

    delete from public.edge_login_attempts
    where greatest(last_attempt_at, coalesce(locked_until, last_attempt_at), coalesce(window_ends_at, last_attempt_at))
        < now() - p_idle;
    get diagnostics attempts = row_count;

    return buckets + attempts;
end;
$$;

revoke all on function public.retention_purge_rate_limits (interval) from public, anon, authenticated;
grant execute on function public.retention_purge_rate_limits (interval) to service_role;

-- ---------------------------------------------------------------------------
-- Inbound support mail: 24 months after it arrived.
-- ---------------------------------------------------------------------------
create or replace function public.retention_purge_support_messages (
    p_older_than interval default interval '24 months'
) returns int
language plpgsql security definer
set search_path = public as $$
declare
    purged int;
begin
    delete from public.support_messages where received_at < now() - p_older_than;
    get diagnostics purged = row_count;
    return purged;
end;
$$;

revoke all on function public.retention_purge_support_messages (interval) from public, anon, authenticated;
grant execute on function public.retention_purge_support_messages (interval) to service_role;

-- ---------------------------------------------------------------------------
-- Schedules. Off the hour, so they do not queue behind everyone else's :00
-- jobs, and unscheduled first so a re-applied migration replaces rather than
-- duplicates. Tombstone compaction is the existing
-- compact_annotation_tombstones (20260802044133_free_plan_efficiency.sql),
-- which until now nothing called.
-- ---------------------------------------------------------------------------
do $$
begin
    perform cron.unschedule (jobid)
    from cron.job
    where jobname in (
        'retention-archived-students',
        'retention-stale-guests',
        'retention-rate-limits',
        'retention-support-messages',
        'retention-compact-tombstones'
    );
exception
    when undefined_table then null;
    when others then null;
end;
$$;

select cron.schedule ('retention-archived-students', '17 3 * * *', $$select public.retention_purge_archived_students ()$$);

select cron.schedule ('retention-stale-guests', '27 3 * * *', $$select public.retention_purge_stale_guests ()$$);

select cron.schedule ('retention-rate-limits', '37 3 * * *', $$select public.retention_purge_rate_limits ()$$);

select cron.schedule ('retention-support-messages', '47 3 * * *', $$select public.retention_purge_support_messages ()$$);

select cron.schedule (
    'retention-compact-tombstones',
    '23 4 * * 0',
    $$select public.compact_annotation_tombstones (interval '90 days')$$
);
