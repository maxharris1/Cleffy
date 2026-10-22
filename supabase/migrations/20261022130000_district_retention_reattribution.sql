-- District retention: a student re-attributed after the soft delete is not
-- hard deleted under the district they left.
--
-- Launch re-audit, Codex A4: the soft delete (20261021120700) lists the
-- district's students in district_retention_students, and the hard delete a
-- week later deletes every listed student still archived. Between the two, a
-- human may decide a listed student is not the district's after all
-- (admin_set_student_district, 20261021120800: a student provisioned into the
-- wrong district, or a private student wrongly attributed), and the hard
-- delete never looked: it re-checked only that the roster row was archived and
-- still a provisioned student, so it deleted a student the purge's own scope
-- (retention_district_students(), district_studio_id = the district) no longer
-- included.
--
-- Two halves, both logged as 'skipped_reattributed' in district_retention_log:
--
--  * admin_set_student_district() drops the student from every purge list but
--    the one of the district it now names, under the roster row's lock.
--  * retention_district_run()'s hard delete re-checks, under the same row lock
--    as before, that the roster row still names the district being purged and
--    still belongs to the account listed; one that does not is skipped and
--    taken off the list. This is the backstop for a list the first half did
--    not reach (a soft delete running concurrently with the correction, or a
--    correction made before this migration).
--
-- Everything else stands: soft then hard delete with logged counts (decision
-- 1), attribution only on positive evidence (decisions 8-10: nothing here
-- attributes a student), the contract-end rules (21-22). A skipped student
-- stays archived as the soft delete left them; the teacher can restore them,
-- as after any archive (was_archived is logged for whoever decides).
--
-- Rerunnable: the constraint is rebuilt inside a DO block, the functions are
-- replaced with the same signatures, and the privileges reset to the same end
-- state.

do $district_retention_log_step$
begin
    alter table public.district_retention_log drop constraint if exists district_retention_log_step_check;
    alter table public.district_retention_log
    add constraint district_retention_log_step_check check (
        step in ('notice_queued', 'notice_sent', 'soft_deleted', 'hard_deleted', 'cancelled', 'attribution_changed',
                 'attribution_backfilled', 'attribution_backfill_run', 'skipped_reattributed')
    );
end;
$district_retention_log_step$;

-- ---------------------------------------------------------------------------
-- The correction drops the student from any other district's purge
-- ---------------------------------------------------------------------------
-- 20261021120800's definition, plus the list. A purge list entry for the
-- district the student now names (an admin re-confirming the same district)
-- stays: that district's purge still covers them.
create or replace function public.admin_set_student_district (p_managed_student uuid, p_studio uuid, p_actor text)
returns void language plpgsql security definer
set search_path = public as $$
declare
    v_old uuid;
begin
    if coalesce(trim(p_actor), '') = '' then
        raise exception 'say who is making the change' using errcode = '22023';
    end if;
    select ms.district_studio_id into v_old from public.managed_students ms where ms.id = p_managed_student for update;
    if not found then
        raise exception 'no such roster student' using errcode = 'P0002';
    end if;
    perform set_config('cleffy.district_attribution', 'admin', true);
    update public.managed_students
    set district_studio_id = p_studio, district_attribution = 'admin'
    where id = p_managed_student;
    perform set_config('cleffy.district_attribution', '', true);
    insert into public.district_retention_log (studio_id, step, counts)
    values (coalesce(p_studio, v_old, p_managed_student), 'attribution_changed',
            jsonb_build_object('managed_student_id', p_managed_student, 'from', v_old, 'to', p_studio,
                               'actor', p_actor));

    -- Logged under the district whose purge it left.
    with dropped as (
        delete from public.district_retention_students s
        where s.managed_student_id = p_managed_student
          and s.studio_id is distinct from p_studio
        returning s.*
    )
    insert into public.district_retention_log (studio_id, step, counts)
    select d.studio_id, 'skipped_reattributed',
           jsonb_build_object('students_skipped', 1, 'managed_student_id', d.managed_student_id,
                              'student_user_id', d.student_user_id, 'was_archived', d.was_archived,
                              'to', p_studio, 'actor', p_actor, 'by', 'admin_set_student_district')
    from dropped d;
end;
$$;

-- ---------------------------------------------------------------------------
-- The run: the hard delete re-checks attribution under the row lock
-- ---------------------------------------------------------------------------
-- 20261021120700's definition; only the hard-delete loop changes.
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
    v_skipped jsonb;
    v_members int;
    v_url text;
    v_secret text;
    v_done jsonb := '{"notice":0,"soft_delete":0,"hard_delete":0,"cancel":0,"students_archived":0,"students_deleted":0,"students_restored":0,"students_skipped_reattributed":0}';
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

        if v_step = 'cancel' then
            update public.managed_students ms
            set archived_at = null
            from public.district_retention_students s
            where s.studio_id = candidate.studio_id
              and s.managed_student_id = ms.id
              and not s.was_archived
              and ms.archived_at is not null;
            get diagnostics v_n = row_count;
            delete from public.district_retention_students where studio_id = candidate.studio_id;
            delete from public.district_retention_notices
            where studio_id = candidate.studio_id and sent_at is null;
            delete from public.district_retention where studio_id = candidate.studio_id;
            insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
            values (candidate.studio_id, 'cancelled', v_state.contract_ends_at,
                    jsonb_build_object('students_restored', v_n, 'new_contract_ends_at', v_billing.contract_ends_at));
            v_done := v_done || jsonb_build_object(
                'cancel', (v_done ->> 'cancel')::int + 1,
                'students_restored', (v_done ->> 'students_restored')::int + v_n);

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
            insert into public.district_retention_students (studio_id, managed_student_id, student_user_id, was_archived)
            select candidate.studio_id, ds.id, ds.student_user_id, ds.archived_at is not null
            from public.retention_district_students (candidate.studio_id) ds
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
                -- the soft delete: skipped, and off the list.
                if v_roster.district_studio_id is distinct from candidate.studio_id
                   or v_roster.student_user_id is distinct from v_student.student_user_id then
                    delete from public.district_retention_students
                    where studio_id = candidate.studio_id and managed_student_id = v_student.managed_student_id;
                    v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
                        'managed_student_id', v_student.managed_student_id,
                        'student_user_id', v_student.student_user_id,
                        'was_archived', v_student.was_archived,
                        'now_district_studio_id', v_roster.district_studio_id));
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
                values (candidate.studio_id, 'skipped_reattributed', v_state.contract_ends_at,
                        jsonb_build_object('students_skipped', jsonb_array_length(v_skipped),
                                           'students', v_skipped, 'by', 'retention_district_run'));
            end if;

            select count(*) into v_members from public.studio_members sm where sm.studio_id = candidate.studio_id;
            -- Takes the seats, the override and the billing record with it.
            delete from public.studios where id = candidate.studio_id;
            delete from public.district_retention_students where studio_id = candidate.studio_id;
            update public.district_retention set hard_deleted_at = p_now where studio_id = candidate.studio_id;
            insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
            values (candidate.studio_id, 'hard_deleted', v_state.contract_ends_at,
                    jsonb_build_object('students_deleted', v_n, 'members_removed', v_members, 'studios', 1));
            v_done := v_done || jsonb_build_object(
                'hard_delete', (v_done ->> 'hard_delete')::int + 1,
                'students_deleted', (v_done ->> 'students_deleted')::int + v_n,
                'students_skipped_reattributed',
                (v_done ->> 'students_skipped_reattributed')::int + jsonb_array_length(v_skipped));
        end if;
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
        'public.admin_set_student_district (uuid, uuid, text)',
        'public.retention_district_run (timestamptz, int)'
    ]
    loop
        execute format('revoke all on function %s from public, anon, authenticated', fn);
        execute format('grant execute on function %s to service_role', fn);
    end loop;
end;
$$;

-- DEPLOY: unchanged. retention_district_run() stays unscheduled
-- (20261021120700's DEPLOY note); schedule it only with this migration applied.
