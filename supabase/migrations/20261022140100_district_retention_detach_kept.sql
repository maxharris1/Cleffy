-- District retention: the hard delete detaches the students it keeps
-- (decision 68(2)).
--
-- A teacher's restore during the purge week wins (20261021120700: the hard
-- delete deletes only listed students still archived). Such a student kept a
-- district_studio_id naming the district the hard delete then removed: no
-- foreign key holds it, so it dangled, and the district's id stayed on a row
-- the district no longer covers. Now the hard delete clears it for every
-- listed student it keeps in the district (restored by their teacher, or an
-- account that is not a provisioned student): district_studio_id set to null
-- under the roster row's lock, with the admin attribution setting the roster
-- trigger requires. Nothing is deleted; district_attribution keeps how the
-- original decision was made. Logged under the district as
-- attribution_changed with counts.event 'detached_kept' and the students, and
-- counted as students_detached in the run's result. The hard_deleted row's
-- counts keep their shape.
--
-- Students the hard delete skips because a human moved them elsewhere are not
-- the district's and are unchanged (20261022130000).
--
-- Lock order unchanged (20261022130400): the district's billing row (this
-- run's FOR UPDATE), the roster row (locked by the loop), then the update;
-- the trigger's NOWAIT lock on the district left finds it held by this
-- transaction, and a move to null joins no district.
--
-- Rerunnable: the function is replaced with the same signature and its
-- privileges reset to the same end state. No table, column or step value.

-- 20261022140000's definition; only the hard delete's loop (the else branch)
-- and its counts change.
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
    v_detached jsonb;
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
            v_detached := '[]'::jsonb;
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
                else
                    -- Kept: their teacher restored them since the soft delete
                    -- (that restore wins, 20261021120700), or the account is
                    -- not a provisioned student. Detached from the district
                    -- about to go, so nothing names it afterwards (decision
                    -- 68(2)): district_studio_id cleared, nothing deleted.
                    -- The roster row is locked above and the district's
                    -- billing row is this run's, so the trigger's NOWAIT lock
                    -- finds it held by this transaction.
                    perform set_config('cleffy.district_attribution', 'admin', true);
                    update public.managed_students set district_studio_id = null
                    where id = v_student.managed_student_id;
                    perform set_config('cleffy.district_attribution', '', true);
                    v_detached := v_detached || jsonb_build_array(jsonb_build_object(
                        'managed_student_id', v_student.managed_student_id,
                        'student_user_id', v_student.student_user_id,
                        'restored', v_roster.archived_at is null));
                end if;
            end loop;

            if jsonb_array_length(v_detached) > 0 then
                insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
                values (candidate.studio_id, 'attribution_changed', v_state.contract_ends_at,
                        jsonb_build_object('event', 'detached_kept', 'from', candidate.studio_id, 'to', null,
                                           'students_detached', jsonb_array_length(v_detached),
                                           'students', v_detached, 'by', 'retention_district_run'));
            end if;

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
                            else '{}'::jsonb end
);
            v_done := v_done || jsonb_build_object(
                'hard_delete', (v_done ->> 'hard_delete')::int + 1,
                'students_deleted', (v_done ->> 'students_deleted')::int + v_n,
                'students_detached', coalesce((v_done ->> 'students_detached')::int, 0) + jsonb_array_length(v_detached),
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

revoke all on function public.retention_district_run (timestamptz, int) from public, anon, authenticated;

grant execute on function public.retention_district_run (timestamptz, int) to service_role;

-- DEPLOY: after 20261022140000; no edge function changes. retention_district_run()
-- stays unscheduled (20261021120700's DEPLOY note).
