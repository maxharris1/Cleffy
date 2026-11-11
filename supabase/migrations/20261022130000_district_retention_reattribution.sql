-- District retention: a student re-attributed after the soft delete is not
-- hard deleted under the district they left, and gets back what that
-- district's purge took.
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
-- Two halves, both logged in district_retention_log as attribution_changed
-- with counts.event = 'skipped_reattributed':
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
-- No new step value. 20261021120800 drops and re-adds
-- district_retention_log_step_check with its own fixed list, so a row with any
-- step it does not know would stop an ordered replay of the migrations at
-- 20261021120800 (Codex round 1 on #66, minor 1). The skip is an attribution
-- change seen by the purge, and is logged as one. Add none here later either:
-- put a new event in counts, as this does.
--
-- And the student gets their roster place back (Codex round 1 on #66, minor 2;
-- Cleffy's decision): one the soft delete archived (was_archived false, so
-- archived only because the district lapsed) is un-archived as part of the
-- re-attribution, by district_reattributed_restore(), if their teacher's plan
-- has room for them: the same check student-provision's restore makes
-- (checkRosterStock: limits.students from the teacher's entitlements, 0 for
-- no roster, -1 for unlimited, against their unarchived students), and only if
-- no other district's purge lists them. One it cannot restore yet is carried
-- over in district_retention_restores, and the left district's cancel (its
-- contract renewed) tries again, under the same check, so the list entry's
-- restore is not lost with the entry.
--
-- Everything else stands: soft then hard delete with logged counts (decision
-- 1), attribution only on positive evidence (decisions 8-10: nothing here
-- attributes a student), the contract-end rules (21-22).
--
-- Rerunnable: the table is created if missing, the functions are replaced
-- with the same signatures, and the privileges reset to the same end state.

-- ---------------------------------------------------------------------------
-- Restores carried over from a dropped purge entry
-- ---------------------------------------------------------------------------
-- A student the district's soft delete archived, whom a human then took out of
-- the district, and whom district_reattributed_restore() could not restore at
-- that moment. Cleared, with the district's list, by its cancel (which retries
-- them) and its hard delete.
create table if not exists public.district_retention_restores (
    studio_id uuid not null,
    managed_student_id uuid not null,
    student_user_id uuid not null,
    reattributed_at timestamptz not null default now(),
    primary key (studio_id, managed_student_id)
);

alter table public.district_retention_restores enable row level security;

revoke all on table public.district_retention_restores from public, anon, authenticated;

grant all on table public.district_retention_restores to service_role;

-- ---------------------------------------------------------------------------
-- Un-archive a re-attributed student, if their teacher's plan has room
-- ---------------------------------------------------------------------------
-- p_left_studio is the district whose purge archived them. Returns what
-- happened: 'restored', or why not ('gone', 'not_archived', 'on_another_purge',
-- 'no_roster_plan', 'roster_full'). Only the callers below decide that the
-- archive was the purge's (was_archived false); this re-checks the rest under
-- the roster row's lock, which those callers already hold. Check-then-write on
-- the teacher's count, as student-provision's restore is.
create or replace function public.district_reattributed_restore (p_managed_student uuid, p_left_studio uuid)
returns text language plpgsql security definer
set search_path = public as $$
declare
    v_row public.managed_students;
    v_limit int;
    v_active int;
begin
    select * into v_row from public.managed_students ms where ms.id = p_managed_student for update;
    if not found then
        return 'gone';
    end if;
    if v_row.archived_at is null then
        return 'not_archived';
    end if;
    -- Another district's purge archived or listed them too: its own cancel or
    -- hard delete decides.
    if exists (
        select 1 from public.district_retention_students s
        where s.managed_student_id = p_managed_student and s.studio_id is distinct from p_left_studio
    ) then
        return 'on_another_purge';
    end if;
    v_limit := (public.resolve_entitlements (v_row.teacher_id) -> 'limits' ->> 'students')::int;
    if v_limit is null or v_limit = 0 then
        return 'no_roster_plan';
    end if;
    if v_limit > 0 then
        select count(*) into v_active from public.managed_students ms
        where ms.teacher_id = v_row.teacher_id and ms.archived_at is null;
        if v_active >= v_limit then
            return 'roster_full';
        end if;
    end if;
    update public.managed_students set archived_at = null where id = p_managed_student;
    return 'restored';
end;
$$;

-- ---------------------------------------------------------------------------
-- The correction drops the student from any other district's purge
-- ---------------------------------------------------------------------------
-- 20261021120800's definition, plus the lists. A purge list entry for the
-- district the student now names (an admin re-confirming the same district)
-- stays: that district's purge still covers them.
create or replace function public.admin_set_student_district (p_managed_student uuid, p_studio uuid, p_actor text)
returns void language plpgsql security definer
set search_path = public as $$
declare
    v_old uuid;
    v_drop public.district_retention_students;
    v_restore text;
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

    -- Each district whose purge it left: the entry goes, the student gets back
    -- what that purge took if their teacher's plan has room (or it is carried
    -- over to the district's cancel), logged under that district.
    for v_drop in
        delete from public.district_retention_students s
        where s.managed_student_id = p_managed_student
          and s.studio_id is distinct from p_studio
        returning s.*
    loop
        v_restore := case when v_drop.was_archived then 'was_archived'
                          else public.district_reattributed_restore (p_managed_student, v_drop.studio_id) end;
        if v_restore in ('on_another_purge', 'no_roster_plan', 'roster_full') then
            insert into public.district_retention_restores (studio_id, managed_student_id, student_user_id)
            values (v_drop.studio_id, v_drop.managed_student_id, v_drop.student_user_id)
            on conflict do nothing;
        end if;
        insert into public.district_retention_log (studio_id, step, counts)
        values (v_drop.studio_id, 'attribution_changed',
                jsonb_build_object('event', 'skipped_reattributed', 'students_skipped', 1,
                                   'managed_student_id', v_drop.managed_student_id,
                                   'student_user_id', v_drop.student_user_id, 'was_archived', v_drop.was_archived,
                                   'restore', v_restore, 'to', p_studio, 'actor', p_actor,
                                   'by', 'admin_set_student_district'));
    end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The run: the hard delete re-checks attribution under the row lock
-- ---------------------------------------------------------------------------
-- 20261021120700's definition; only the cancel (it retries the restores
-- carried over) and the hard-delete loop change.
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
    v_restored int;
    v_restore text;
    v_carried record;
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
            -- And the ones re-attributed away while the purge was pending, whom
            -- the correction could not restore then: the same check again.
            v_restored := 0;
            for v_carried in
                select r.managed_student_id from public.district_retention_restores r
                where r.studio_id = candidate.studio_id
                order by r.managed_student_id
            loop
                if public.district_reattributed_restore (v_carried.managed_student_id, candidate.studio_id) = 'restored' then
                    v_restored := v_restored + 1;
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
                                       'new_contract_ends_at', v_billing.contract_ends_at));
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

            select count(*) into v_members from public.studio_members sm where sm.studio_id = candidate.studio_id;
            -- Takes the seats, the override and the billing record with it.
            delete from public.studios where id = candidate.studio_id;
            delete from public.district_retention_students where studio_id = candidate.studio_id;
            delete from public.district_retention_restores where studio_id = candidate.studio_id;
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

-- Internal: only the two above call it.
revoke all on function public.district_reattributed_restore (uuid, uuid) from public, anon, authenticated;

-- DEPLOY: unchanged. retention_district_run() stays unscheduled
-- (20261021120700's DEPLOY note); schedule it only with this migration applied.
