-- Account deletion: a sweep for stale account_deletions rows (decision 49(6):
-- "Runbook for stale account_deletions rows in P6 now; cron sweep is a
-- follow-up").
--
-- An attempt that dies without settling (the Edge Function killed, the network
-- gone) leaves its account_deletion_attempts row open, and its account_deletions
-- marker in place. account_deletion_pending() (20261022110400) already ignores
-- an attempt whose 600 s lease ran out, so such a marker restricts nothing --
-- unless destructive cleanup had begun, in which case the account stays
-- restricted until a deletion completes (the half-deleted case, DEPLOY.md's P3
-- runbook). Nothing ever removed the harmless rows.
--
-- sweep_stale_account_deletions() does, for each account with a marker, under
-- the account's deletion lock (account_deletion_lock_key, the lock
-- begin/mark/settle take, so it never runs beside an attempt's own steps):
--   * closes every attempt whose lease ran out and that never ended, as
--     'abandoned' with error 'lease_expired' (the attempt cannot still be
--     running: the lease is longer than an Edge Function can run);
--   * then deletes the marker when no cleanup ever began and no attempt is
--     live -- exactly the rule settle_account_deletion_attempt() applies when
--     an attempt settles -- and its attempts with it (ON DELETE CASCADE);
--   * never touches a half-deleted marker (destructive_started_at set): it is
--     counted and named for a person, as the runbook says, since only a
--     completed deletion may clear it.
-- Idempotent: a second run changes nothing. At most p_limit markers per run
-- (default 500), oldest first, counting only markers with something to do: an
-- attempt to close, or a marker to delete (PR #72 fix 4). A half-deleted
-- marker whose attempts are all closed, or a marker an attempt still holds, is
-- passed over before the limit, so old ones never fill every run and starve
-- newer abandoned markers; the half-deleted are still counted below. Returns
--   {"attempts_closed": n, "markers_cleared": n, "half_deleted": n,
--    "oldest_half_deleted": <user_id or null>}.
--
-- NOT scheduled here, like retention_district_run(): DEPLOY.md gives the
-- cron line for Max. Safe to run by hand at any time.
--
-- Rerunnable: the function is replaced with the same signature and its
-- privileges reset to the same end state.

create or replace function public.sweep_stale_account_deletions (p_limit integer default 500) returns jsonb
language plpgsql security definer
set search_path = public as $$
declare
    v_user uuid;
    v_closed integer := 0;
    v_n integer;
    v_cleared integer := 0;
begin
    for v_user in
        -- What the loop below would do, read without the lock (and checked
        -- again under it): close an attempt, or delete the marker.
        select d.user_id from public.account_deletions d
        where exists (
                  select 1 from public.account_deletion_attempts a
                  where a.user_id = d.user_id and a.ended_at is null and a.lease_until <= now()
              )
           or (d.destructive_started_at is null
               and not exists (
                   select 1 from public.account_deletion_attempts a
                   where a.user_id = d.user_id and a.ended_at is null and a.lease_until > now()
               ))
        order by d.started_at, d.user_id
        limit greatest(coalesce(p_limit, 500), 0)
    loop
        perform pg_advisory_xact_lock (public.account_deletion_lock_key (v_user));

        update public.account_deletion_attempts a
        set ended_at = now(), outcome = 'abandoned', error = 'lease_expired'
        where a.user_id = v_user and a.ended_at is null and a.lease_until <= now();
        get diagnostics v_n = row_count;
        v_closed := v_closed + v_n;

        delete from public.account_deletions d
        where d.user_id = v_user
          and d.destructive_started_at is null
          and not exists (
              select 1 from public.account_deletion_attempts a
              where a.user_id = d.user_id and a.ended_at is null and a.lease_until > now()
          );
        get diagnostics v_n = row_count;
        v_cleared := v_cleared + v_n;
    end loop;

    return jsonb_build_object(
        'attempts_closed', v_closed,
        'markers_cleared', v_cleared,
        'half_deleted', (
            select count(*) from public.account_deletions d
            where d.destructive_started_at is not null
              and not exists (select 1 from public.account_deletion_attempts a
                              where a.user_id = d.user_id and a.ended_at is null and a.lease_until > now())
        ),
        'oldest_half_deleted', (
            select d.user_id from public.account_deletions d
            where d.destructive_started_at is not null
              and not exists (select 1 from public.account_deletion_attempts a
                              where a.user_id = d.user_id and a.ended_at is null and a.lease_until > now())
            order by d.destructive_started_at
            limit 1
        )
    );
end;
$$;

revoke all on function public.sweep_stale_account_deletions (integer) from public, anon, authenticated;

grant execute on function public.sweep_stale_account_deletions (integer) to service_role;

-- DEPLOY (Max, when wanted; nothing schedules it):
--   select cron.schedule ('account-deletions-sweep', '41 4 * * *',
--       $$select public.sweep_stale_account_deletions ()$$);
-- A non-zero half_deleted in its result is the P3 runbook's "Half-deleted
-- accounts" case.
