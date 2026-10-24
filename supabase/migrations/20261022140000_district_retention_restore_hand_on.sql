-- District retention: overlapping purges hand a carried restore on instead
-- of deleting it (decision 47's residual, kept a follow-up by 66(1)).
--
-- A student whom district A's soft delete archived (was_archived false) and a
-- human then moved to district B gets a restore record under A
-- (district_retention_restores, 20261022130000) when it could not be
-- restored at once: the teacher's plan had no room, or B's purge already
-- lists them ('on_another_purge'). B's own list entry says was_archived true
-- (A had archived them), so B's cancel does not un-archive them either. The
-- record under A was the only trace that the archive was a purge's, and A's
-- end deleted it:
--
--   * A's cancel retried it, got 'on_another_purge' (B lists them) and
--     deleted it with A's other records;
--   * A's hard delete deleted A's records without looking;
--   * A's hard delete skipping a student moved to B the raw way (the list
--     entry left behind) computed 'on_another_purge' and carried nothing.
--
-- Then B's renewal (its cancel) left the student archived for good. Now each
-- of the three hands the restore on (district_retention_hand_on_restore()):
-- a restore record under every other district whose purge lists the student
-- (still archived, same account), logged there as attribution_changed with
-- counts.event 'restore_handed_on'. That district's cancel retries it under
-- the same check (district_reattributed_restore(): plan room, no other purge),
-- and its hard delete deletes the student, who is that district's now.
--
-- The lock order stays the run's (20261022130400): billing rows, then roster
-- rows, then the lists. Before a cancel or a hard delete touches a roster
-- row, district_retention_lock_overlaps() takes the billing row of every
-- other district whose list shares a student with this district's list or
-- restores, FOR KEY SHARE NOWAIT in studio order. KEY SHARE conflicts only
-- with a run's FOR UPDATE (which SKIP LOCKED passes over, never waits for)
-- and with the studio's delete. If another run holds one, this district is
-- passed over until the next run (decision 69(3): a day's delay, no
-- permanent miss), with nothing written for it. Under those locks the other
-- district's purge cannot cancel or hard delete while the restore is handed
-- to it. A district that lists the student only after the lock was taken (a
-- concurrent run's soft delete of the district the student moved to) is not
-- handed anything: the earlier behaviour, the narrowest remaining window.
--
-- No new table, column or step value (step values: see 20261022130000's
-- note). Rerunnable: functions replaced with the same signatures, privileges
-- reset to the same end state.

-- ---------------------------------------------------------------------------
-- The other purges' locks, before any roster row
-- ---------------------------------------------------------------------------
-- True once the billing rows of every other district whose purge list shares
-- a student with p_studio's list or restores are held FOR KEY SHARE; false if
-- one is held by another run (taken NOWAIT, so nothing waits on a run), in
-- which case nothing is held and the caller passes p_studio over. The caller
-- holds p_studio's own billing row FOR UPDATE.
create or replace function public.district_retention_lock_overlaps (p_studio uuid) returns boolean
language plpgsql security definer
set search_path = public as $$
begin
    perform 1 from public.district_billing b
    where b.studio_id in (
        select other.studio_id
        from public.district_retention_students other
        where other.studio_id is distinct from p_studio
          and other.managed_student_id in (
              select s.managed_student_id from public.district_retention_students s where s.studio_id = p_studio
              union
              select r.managed_student_id from public.district_retention_restores r where r.studio_id = p_studio
          )
    )
    order by b.studio_id
    for key share of b nowait;
    return true;
exception
    when lock_not_available then
        return false;
end;
$$;

-- ---------------------------------------------------------------------------
-- Hand a restore on to the purges that list the student now
-- ---------------------------------------------------------------------------
-- p_from_studio's purge archived the student (was_archived false) and is
-- ending, or let the student go, without restoring them because another
-- district's purge lists them. Each such district gets the restore record, if
-- the student is still archived and still the account listed; returns how
-- many did. The caller holds those districts' locks
-- (district_retention_lock_overlaps()) and the roster row's or needs none of
-- it: nothing here locks a billing or roster row.
create or replace function public.district_retention_hand_on_restore (
    p_managed_student uuid,
    p_student_user uuid,
    p_from_studio uuid
) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_to uuid;
    v_n int := 0;
begin
    for v_to in
        insert into public.district_retention_restores (studio_id, managed_student_id, student_user_id)
        select other.studio_id, p_managed_student, p_student_user
        from public.district_retention_students other
        join public.managed_students ms on ms.id = other.managed_student_id
        where other.managed_student_id = p_managed_student
          and other.studio_id is distinct from p_from_studio
          and ms.archived_at is not null
          and ms.student_user_id = p_student_user
        order by other.studio_id
        on conflict do nothing
        returning studio_id
    loop
        v_n := v_n + 1;
        insert into public.district_retention_log (studio_id, step, counts)
        values (v_to, 'attribution_changed',
                jsonb_build_object('event', 'restore_handed_on', 'managed_student_id', p_managed_student,
                                   'student_user_id', p_student_user, 'from', p_from_studio));
    end loop;
    return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- The run: the cancel and the hard delete hand restores on
-- ---------------------------------------------------------------------------
-- 20261022130400's definition. Changed: the overlap locks before a cancel or a
-- hard delete; the cancel hands on a carried restore that another purge
-- blocks; the hard delete hands on its skipped students' and its carried
-- restores that another purge lists, before its own records go. Both log
-- restores_handed_on in their counts when they handed any on (the counts are
-- otherwise as before).
create or replace function public.retention_district_run (p_now timestamptz default now(), p_batch int default 20)
returns jsonb language plpgsql security definer
set search_path = public, extensions, vault as $$
declare
    candidate record;
    v_billing public.district_billing;
    v_state public.district_retention;
    v_step text;
    v_owner uuid;
    v_email text;
    v_name text;
    v_student record;
    v_roster record;
    v_n int;
    v_late int;
    v_locked uuid[];
    v_restored int;
    v_restore text;
    v_carried record;
    v_skipped jsonb;
    v_members int;
    v_url text;
    v_secret text;
    v_held boolean;
    v_handed int;
    v_done jsonb := '{"notice":0,"soft_delete":0,"hard_delete":0,"cancel":0,"students_archived":0,"students_deleted":0,"students_restored":0,"students_skipped_reattributed":0,"students_late_listed":0}';
begin
    for candidate in
        select c.studio_id from public.retention_district_candidates (p_now) c
        order by c.contract_ends_at nulls first
        limit greatest(p_batch, 0)
    loop
        v_billing := null;
        select b.* into v_billing from public.district_billing b where b.studio_id = candidate.studio_id
        for update skip locked;
        if not found and exists (select 1 from public.district_billing b where b.studio_id = candidate.studio_id) then
            continue; -- locked by someone else: tomorrow
        end if;

        v_state := null;
        select r.* into v_state from public.district_retention r where r.studio_id = candidate.studio_id for update;

        v_step := public.retention_district_next_step (v_billing.contract_ends_at, v_state, p_now);

        -- A cancel or hard delete can hand a carried restore on to another
        -- district's purge (20261022140000): that district's lock first,
        -- before any roster row, or the district waits for the next run.
        if v_step in ('cancel', 'hard_delete') then
            v_held := public.district_retention_lock_overlaps (candidate.studio_id);
            if not v_held then
                continue; -- another district it shares students with is busy: tomorrow
            end if;
        end if;
        v_handed := 0;

        if v_step = 'cancel' then
            update public.managed_students ms
            set archived_at = null
            from public.district_retention_students s
            where s.studio_id = candidate.studio_id
              and s.managed_student_id = ms.id
              and not s.was_archived
              and ms.archived_at is not null;
            get diagnostics v_n = row_count;
            -- And the ones re-attributed away while the purge was pending, whom
            -- the correction could not restore then: the same check again.
            v_restored := 0;
            for v_carried in
                select r.managed_student_id, r.student_user_id from public.district_retention_restores r
                where r.studio_id = candidate.studio_id
                order by r.managed_student_id
            loop
                v_restore := public.district_reattributed_restore (v_carried.managed_student_id, candidate.studio_id);
                if v_restore = 'restored' then
                    v_restored := v_restored + 1;
                elsif v_restore = 'on_another_purge' then
                    -- Another district's purge lists them now: its cancel
                    -- retries the restore, so it is not lost with this one.
                    v_handed := v_handed + public.district_retention_hand_on_restore (
                        v_carried.managed_student_id, v_carried.student_user_id, candidate.studio_id);
                end if;
            end loop;
            delete from public.district_retention_restores where studio_id = candidate.studio_id;
            delete from public.district_retention_students where studio_id = candidate.studio_id;
            delete from public.district_retention_notices
            where studio_id = candidate.studio_id and sent_at is null;
            delete from public.district_retention where studio_id = candidate.studio_id;
            insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
            values (candidate.studio_id, 'cancelled', v_state.contract_ends_at,
                    jsonb_build_object('students_restored', v_n + v_restored, 'reattributed_restored', v_restored,
                                       'new_contract_ends_at', v_billing.contract_ends_at)
                    || case when v_handed > 0 then jsonb_build_object('restores_handed_on', v_handed)
                            else '{}'::jsonb end);
            v_done := v_done || jsonb_build_object(
                'cancel', (v_done ->> 'cancel')::int + 1,
                'students_restored', (v_done ->> 'students_restored')::int + v_n + v_restored);

        elsif v_step = 'notice' then
            select st.owner_id, st.name, u.email into v_owner, v_name, v_email
            from public.studios st
            left join auth.users u on u.id = st.owner_id
            where st.id = candidate.studio_id;
            if v_email is null then
                -- Nobody to tell, so nothing will be purged: the next stage
                -- waits for a SENT notice. Logged loudly for a human.
                raise warning 'district retention: studio % has no owner address; not purging', candidate.studio_id;
                continue;
            end if;
            insert into public.district_retention (studio_id, owner_id, contract_ends_at, notice_queued_at)
            values (candidate.studio_id, v_owner, v_billing.contract_ends_at, p_now);
            insert into public.district_retention_notices
                (studio_id, owner_id, to_email, studio_name, contract_ends_at, purge_not_before)
            values (candidate.studio_id, v_owner, v_email, v_name, v_billing.contract_ends_at,
                    greatest(v_billing.contract_ends_at + interval '30 days', p_now + interval '14 days'))
            -- A cycle cancelled and begun again for the same date mails again:
            -- the owner may have been told the purge was off.
            on conflict (studio_id, contract_ends_at) do update
            set to_email = excluded.to_email,
                studio_name = excluded.studio_name,
                purge_not_before = excluded.purge_not_before,
                created_at = now(),
                attempts = 0,
                lease_until = null,
                last_error = null,
                sent_at = null;
            insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
            values (candidate.studio_id, 'notice_queued', v_billing.contract_ends_at,
                    jsonb_build_object('students', (select count(*) from public.retention_district_students (candidate.studio_id)),
                                       'members', (select count(*) from public.studio_members sm
                                                   where sm.studio_id = candidate.studio_id)));
            v_done := v_done || jsonb_build_object('notice', (v_done ->> 'notice')::int + 1);

        elsif v_step = 'soft_delete' then
            -- The district's roster rows locked first, in roster order, then
            -- listed as they are under the locks (20261022130400, as
            -- district_retention_list_late() does): a student moved out while
            -- the soft delete waited for their row is not listed, archived or
            -- signed out.
            select coalesce(array_agg(l.id), '{}') into v_locked
            from (
                select ms.id from public.managed_students ms
                where ms.id in (select ds.id from public.retention_district_students (candidate.studio_id) ds)
                order by ms.id
                for update of ms
            ) l;
            insert into public.district_retention_students (studio_id, managed_student_id, student_user_id, was_archived)
            select candidate.studio_id, ds.id, ds.student_user_id, ds.archived_at is not null
            from public.retention_district_students (candidate.studio_id) ds
            where ds.id = any (v_locked)
            on conflict do nothing;

            -- Archived and every token refused (student_access_revoked), under
            -- the roster row's lock that student writes share (20261021120400).
            update public.managed_students ms
            set archived_at = coalesce(ms.archived_at, p_now),
                access_revoked_at = clock_timestamp()
            from public.district_retention_students s
            where s.studio_id = candidate.studio_id and s.managed_student_id = ms.id;
            get diagnostics v_n = row_count;

            delete from auth.refresh_tokens
            where user_id in (select s.student_user_id::text from public.district_retention_students s
                              where s.studio_id = candidate.studio_id);
            delete from auth.sessions
            where user_id in (select s.student_user_id from public.district_retention_students s
                              where s.studio_id = candidate.studio_id);

            update public.district_retention set soft_deleted_at = p_now where studio_id = candidate.studio_id;
            insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
            values (candidate.studio_id, 'soft_deleted', v_state.contract_ends_at,
                    jsonb_build_object('students_archived', v_n,
                                       'members', (select count(*) from public.studio_members sm
                                                   where sm.studio_id = candidate.studio_id)));
            v_done := v_done || jsonb_build_object(
                'soft_delete', (v_done ->> 'soft_delete')::int + 1,
                'students_archived', (v_done ->> 'students_archived')::int + v_n);

        elsif v_step = 'hard_delete' then
            -- Everyone attributed to the district now, under its lock (held
            -- since the top of this iteration; a provision takes it too), so
            -- the loop below works from the whole district (20261022130300).
            v_late := public.district_retention_list_late (candidate.studio_id, p_now, 'hard_delete');
            v_done := v_done || jsonb_build_object(
                'students_late_listed', (v_done ->> 'students_late_listed')::int + v_late);

            v_n := 0;
            v_skipped := '[]'::jsonb;
            for v_student in
                select s.managed_student_id, s.student_user_id, s.was_archived
                from public.district_retention_students s
                where s.studio_id = candidate.studio_id
            loop
                -- The roster row's lock, as before (20261021120500's re-check),
                -- and under it the row as it is now: an admin's correction
                -- waits for it, or has committed and is read here.
                select m.district_studio_id, m.student_user_id, m.archived_at into v_roster
                from public.managed_students m
                where m.id = v_student.managed_student_id
                for update of m;
                if not found then
                    continue;
                end if;

                -- Still in the purge's scope (retention_district_students():
                -- the district this row names) and still the account that was
                -- listed. Otherwise a human re-attributed the student after
                -- the soft delete: skipped, and off the list. A student moved
                -- to another district or roster gets back what this purge took,
                -- as the correction would have done; a row whose account is not
                -- the one listed is left as it is, for a human.
                if v_roster.district_studio_id is distinct from candidate.studio_id
                   or v_roster.student_user_id is distinct from v_student.student_user_id then
                    delete from public.district_retention_students
                    where studio_id = candidate.studio_id and managed_student_id = v_student.managed_student_id;
                    v_restore := case
                        when v_roster.student_user_id is distinct from v_student.student_user_id then 'other_account'
                        when v_student.was_archived then 'was_archived'
                        else public.district_reattributed_restore (v_student.managed_student_id, candidate.studio_id) end;
                    if v_restore = 'on_another_purge' then
                        -- Moved into a district whose purge lists them too:
                        -- that purge's cancel restores them (20261022140000).
                        v_handed := v_handed + public.district_retention_hand_on_restore (
                            v_student.managed_student_id, v_student.student_user_id, candidate.studio_id);
                    end if;
                    v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
                        'managed_student_id', v_student.managed_student_id,
                        'student_user_id', v_student.student_user_id,
                        'was_archived', v_student.was_archived,
                        'now_district_studio_id', v_roster.district_studio_id,
                        'restore', v_restore));
                    continue;
                end if;

                -- Still archived (a teacher's restore since the soft delete
                -- wins) and still a provisioned student.
                if v_roster.archived_at is not null and exists (
                    select 1 from auth.users u
                    where u.id = v_student.student_user_id
                      and u.raw_app_meta_data ->> 'user_type' = 'student'
                ) then
                    perform public.scrub_student_markings (v_student.student_user_id);
                    delete from auth.users where id = v_student.student_user_id;
                    v_n := v_n + 1;
                end if;
            end loop;

            if jsonb_array_length(v_skipped) > 0 then
                insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
                values (candidate.studio_id, 'attribution_changed', v_state.contract_ends_at,
                        jsonb_build_object('event', 'skipped_reattributed',
                                           'students_skipped', jsonb_array_length(v_skipped),
                                           'students', v_skipped, 'by', 'retention_district_run'));
            end if;

            -- The restores carried over to this district that another
            -- district's purge now lists are handed on to it before this
            -- district's go (20261022140000); the rest go with it, as before.
            for v_carried in
                select r.managed_student_id, r.student_user_id from public.district_retention_restores r
                where r.studio_id = candidate.studio_id
                order by r.managed_student_id
            loop
                v_handed := v_handed + public.district_retention_hand_on_restore (
                    v_carried.managed_student_id, v_carried.student_user_id, candidate.studio_id);
            end loop;

            select count(*) into v_members from public.studio_members sm where sm.studio_id = candidate.studio_id;
            -- Takes the seats, the override and the billing record with it.
            delete from public.studios where id = candidate.studio_id;
            delete from public.district_retention_students where studio_id = candidate.studio_id;
            delete from public.district_retention_restores where studio_id = candidate.studio_id;
            update public.district_retention set hard_deleted_at = p_now where studio_id = candidate.studio_id;
            insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
            values (candidate.studio_id, 'hard_deleted', v_state.contract_ends_at,
                    jsonb_build_object('students_deleted', v_n, 'members_removed', v_members, 'studios', 1)
                    || case when v_handed > 0 then jsonb_build_object('restores_handed_on', v_handed)
                            else '{}'::jsonb end);
            v_done := v_done || jsonb_build_object(
                'hard_delete', (v_done ->> 'hard_delete')::int + 1,
                'students_deleted', (v_done ->> 'students_deleted')::int + v_n,
                'students_skipped_reattributed',
                (v_done ->> 'students_skipped_reattributed')::int + jsonb_array_length(v_skipped));
        end if;
    end loop;

    -- The sweep (20261022130300): every soft-deleted district not yet hard
    -- deleted lists anyone attributed to it since its list was taken. Locked
    -- as above, SKIP LOCKED included (a provision in flight: tomorrow). A
    -- district whose next step is its cancel is left to it; one whose billing
    -- record is gone has nobody left to provision into it, and its cycle is
    -- the cancel's too.
    for candidate in
        select r.studio_id from public.district_retention r
        where r.soft_deleted_at is not null and r.hard_deleted_at is null
        order by r.studio_id
    loop
        select b.* into v_billing from public.district_billing b where b.studio_id = candidate.studio_id
        for update skip locked;
        if not found then
            continue;
        end if;
        select r.* into v_state from public.district_retention r where r.studio_id = candidate.studio_id for update;
        if not found or v_state.soft_deleted_at is null or v_state.hard_deleted_at is not null
           or public.retention_district_next_step (v_billing.contract_ends_at, v_state, p_now) = 'cancel' then
            continue;
        end if;
        v_late := public.district_retention_list_late (candidate.studio_id, p_now, 'sweep');
        v_done := v_done || jsonb_build_object(
            'students_late_listed', (v_done ->> 'students_late_listed')::int + v_late);
    end loop;

    -- Wake the sender when there is mail to send. No-op without its secrets.
    if exists (select 1 from public.district_retention_notices where sent_at is null) then
        begin
            select decrypted_secret into v_url from vault.decrypted_secrets where name = 'district_notice_url' limit 1;
            select decrypted_secret into v_secret from vault.decrypted_secrets
            where name = 'district_notice_secret' limit 1;
            if v_url is not null and v_secret is not null then
                perform net.http_post(
                    url := v_url,
                    headers := jsonb_build_object('Content-Type', 'application/json', 'x-district-notice-secret', v_secret),
                    body := '{}'::jsonb,
                    timeout_milliseconds := 5000
                );
            end if;
        exception
            when others then
                raise warning 'district retention: could not wake the notice sender: %', sqlerrm;
        end;
    end if;

    return v_done;
end;
$$;

do $$
declare
    fn text;
begin
    foreach fn in array array[
        'public.retention_district_run (timestamptz, int)'
    ]
    loop
        execute format('revoke all on function %s from public, anon, authenticated', fn);
        execute format('grant execute on function %s to service_role', fn);
    end loop;
end;
$$;

-- Internal, like district_retention_list_late(): only the run calls them,
-- under the districts' locks. Not even the service role calls them directly.
revoke all on function public.district_retention_lock_overlaps (uuid) from public, anon, authenticated, service_role;

revoke all on function public.district_retention_hand_on_restore (uuid, uuid, uuid)
from public, anon, authenticated, service_role;

-- DEPLOY: no order constraint beyond following 20261022130400; no edge
-- function changes. retention_district_run() stays unscheduled
-- (20261021120700's DEPLOY note).
