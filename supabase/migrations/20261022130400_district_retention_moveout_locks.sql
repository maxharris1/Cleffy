-- District retention: a student moved out of a district is never listed by
-- its purge, and an admin's correction takes the districts' locks in the
-- run's order.
--
-- Codex's narrow review of 20261022130300 (REVISE), both findings:
--
--  (1) MAJOR. The run listed a district's students from a snapshot and locked
--      their roster rows only to archive them, without looking at the rows
--      again. A student an admin was moving out of the district (the
--      correction open, admin_set_student_district (student, null, ...)) was
--      read as still in it; the run's UPDATE waited for the correction, and
--      once it committed archived the student anyway, and deleted their
--      sessions and refresh tokens. Now the roster rows are locked first (FOR
--      UPDATE, in roster order) and the district re-read under the locks,
--      before anything is listed, was_archived recorded or anything revoked:
--      a student the district no longer names is skipped. In
--      district_retention_list_late() (the sweep, every run, and the hard
--      delete's re-list right before it deletes) and in the soft delete's own
--      listing in retention_district_run() (the same pattern, pre-existing,
--      and a contained change). The hard delete's loop already re-checks each
--      row under its lock (20261021120500, 20261022130000), unchanged.
--
--  (2) MINOR. A correction moving a student between districts locked the
--      roster row before the destination's billing row (a raw admin-flagged
--      UPDATE: PostgreSQL locks the row before its BEFORE UPDATE trigger
--      runs), the reverse of the run, which locks a district's billing row and
--      then its students' roster rows. A run holding the destination from an
--      earlier district and reaching the student in the source deadlocked with
--      it. And a move out (to null) took no district lock at all, which is
--      what let (1) happen.
--
-- THE LOCK ORDER, everywhere, unchanged in principle from 20261022130300 and
-- now kept by every correction: the districts' billing rows first, then
-- roster rows, then the purge's lists.
--   * The run: a district's billing row FOR UPDATE (SKIP LOCKED: one someone
--     else holds is passed over until the next run), its district_retention
--     row FOR UPDATE, then its students' roster rows FOR UPDATE (ascending id,
--     here), then the list entries.
--   * admin_set_student_district(): reads the district the student is in
--     (unlocked), takes the billing rows of that district and of the one the
--     student is moved to FOR KEY SHARE, in ascending studio id (one row when
--     they are the same; the old one alone on a move out), then the roster row
--     FOR UPDATE, then the list entries. If the student's district changed
--     between the read and the row lock, the correction is refused (40001,
--     retry): taking the new district's lock under the row's would be the
--     reverse order.
--   * The backfill (20261022130300, unchanged): the billing rows of every
--     district the evidence names FOR KEY SHARE, in studio order, then the
--     roster rows (legacy rows have no district to leave).
--   * The roster trigger: on an UPDATE that changes the district, the billing
--     rows of the district left and the one joined FOR KEY SHARE NOWAIT, in
--     ascending studio id. Through admin_set_student_district() and the
--     backfill it finds them already held. A raw admin-flagged UPDATE has
--     locked the roster row before its trigger runs, so it may not wait for a
--     district now (a run holding it may be waiting for this very row): if a
--     run holds either district, the UPDATE is refused at once with SQLSTATE
--     55P03 and the message 'district_busy'. That is its retry behaviour: the
--     caller retries the statement in a new transaction (the run has
--     committed by then, or passes the district over while the correction
--     holds it), or makes the correction through admin_set_student_district(),
--     which waits its turn. On an INSERT the trigger takes the district's lock
--     as before (20261022130300): a new row is nobody else's to wait for.
-- KEY SHARE conflicts with the run's FOR UPDATE and with the studio's delete,
-- not with another correction's KEY SHARE, and not with the FOR NO KEY UPDATE
-- of a billing write; the billing record's own writers
-- (district_billing_rederive(), admin_set_district_contract_end()) lock one
-- billing row and no roster row, so they cannot invert it either.
-- Consequences: a correction that reaches a district first makes the run pass
-- it over until the next run (which then sees the student where the
-- correction left them); a run that reaches it first makes the correction
-- wait for it, then the correction finds the student listed and takes them
-- off the list as 20261022130000 does.
--
-- Rerunnable: functions are replaced with the same signatures, and the
-- privileges reset to the same end state. No table, trigger or constraint is
-- added; no step value either.

-- ---------------------------------------------------------------------------
-- The roster trigger: both districts' locks on a move, without waiting
-- ---------------------------------------------------------------------------
-- 20261022130300's definition; the UPDATE branch takes both districts' locks
-- NOWAIT, in studio order, and refuses when a run holds one.
create or replace function public.managed_students_district_attribution () returns trigger language plpgsql
security definer
set search_path = public as $$
declare
    v_refusal text;
begin
    if tg_op = 'INSERT' then
        -- Whatever the caller wrote, a new row is decided here and now.
        new.district_attribution := 'provisioned';
        if new.district_studio_id is not null then
            -- The district's lock, before its state is read (20261022130300):
            -- a run holding it is waited for, and its soft delete is seen.
            perform 1 from public.district_billing b where b.studio_id = new.district_studio_id for key share;
            v_refusal := public.district_provision_refusal (new.teacher_id, new.district_studio_id);
            if v_refusal = 'district_deletion_pending' then
                raise exception 'district_deletion_pending'
                    using errcode = '55000',
                          hint = 'This district is being deleted, so no new students can be added to it.';
            elsif v_refusal is not null then
                raise exception 'the teacher does not own or hold a seat in that district'
                    using errcode = '42501';
            end if;
        end if;
        -- Never a student dated before the district or the seat existed: a
        -- back-dated insert (none of the app's paths writes created_at) is
        -- refused rather than attributed to a time the district did not cover.
        if new.district_studio_id is not null
           and not public.district_held_at (new.teacher_id, new.district_studio_id, new.created_at) then
            raise exception 'the student predates the teacher''s seat in that district, or the district itself'
                using errcode = '42501';
        end if;
    elsif new.district_studio_id is distinct from old.district_studio_id
          or new.district_attribution is distinct from old.district_attribution then
        if current_setting('cleffy.district_attribution', true) is distinct from 'admin' then
            raise exception 'district attribution is recorded at provisioning and cannot be changed'
                using errcode = '42501';
        end if;
        if new.district_studio_id is distinct from old.district_studio_id then
            -- The lock of the district left and of the one joined, in studio
            -- order (20261022130400). admin_set_student_district() and the
            -- backfill hold them already. A raw UPDATE locked this row first,
            -- so it does not wait for a run holding either (the run may be
            -- waiting for this row): it is refused, to be retried.
            begin
                perform 1 from public.district_billing b
                where b.studio_id in (old.district_studio_id, new.district_studio_id)
                order by b.studio_id
                for key share of b nowait;
            exception
                when lock_not_available then
                    raise exception 'district_busy'
                        using errcode = '55P03',
                              hint = 'A retention run holds the district this student is leaving or joining. Retry, or use admin_set_student_district(), which waits for it.';
            end;
            -- A correction moving a student into a district being deleted.
            if new.district_studio_id is not null and public.district_deletion_pending (new.district_studio_id) then
                raise exception 'district_deletion_pending'
                    using errcode = '55000',
                          hint = 'This district is being deleted, so no student can be moved into it.';
            end if;
        end if;
    end if;
    return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- The admin correction: both districts' locks, then the roster row
-- ---------------------------------------------------------------------------
-- 20261022130300's definition; the lock of the district the student leaves
-- (a move out too) is taken with the one it joins, in studio order, before
-- the roster row's.
create or replace function public.admin_set_student_district (p_managed_student uuid, p_studio uuid, p_actor text)
returns void language plpgsql security definer
set search_path = public as $$
declare
    v_old uuid;
    v_now uuid;
    v_drop public.district_retention_students;
    v_restore text;
begin
    if coalesce(trim(p_actor), '') = '' then
        raise exception 'say who is making the change' using errcode = '22023';
    end if;
    -- The district the student is in, read without a lock, so that its lock
    -- can be taken before the row's.
    select ms.district_studio_id into v_old from public.managed_students ms where ms.id = p_managed_student;
    if not found then
        raise exception 'no such roster student' using errcode = 'P0002';
    end if;
    -- Both districts' locks first, in studio order: the run's order (billing
    -- rows, then roster rows). A run holding either is waited for; a run
    -- reaching either while this holds it passes it over until the next run.
    perform 1 from public.district_billing b
    where b.studio_id in (v_old, p_studio)
    order by b.studio_id
    for key share of b;
    select ms.district_studio_id into v_now from public.managed_students ms where ms.id = p_managed_student for update;
    if not found then
        raise exception 'no such roster student' using errcode = 'P0002';
    end if;
    if v_now is distinct from v_old then
        -- Moved by someone else since it was read: the district it is in now
        -- is not locked here, and its lock under the row's would be the
        -- reverse order.
        raise exception 'the student''s district changed while this correction was being made; retry'
            using errcode = '40001';
    end if;
    if p_studio is not null and p_studio is distinct from v_old and public.district_deletion_pending (p_studio) then
        raise exception 'district_deletion_pending'
            using errcode = '55000',
                  hint = 'This district is being deleted, so no student can be moved into it.';
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
-- The re-list: lock, then look again
-- ---------------------------------------------------------------------------
-- 20261022130300's definition; the unlisted students' roster rows are locked
-- first, and only those the district still names under the locks are listed.
-- The caller holds the district's lock (its billing row FOR UPDATE).
create or replace function public.district_retention_list_late (p_studio uuid, p_now timestamptz, p_by text)
returns int language plpgsql security definer
set search_path = public as $$
declare
    v_locked uuid[];
    v_late jsonb;
    v_n int;
begin
    -- The roster rows of the district's students not on its list yet, locked
    -- in roster order. A change in flight to one of them (an admin moving the
    -- student out, a teacher archiving them) is waited for.
    select coalesce(array_agg(l.id), '{}') into v_locked
    from (
        select ms.id from public.managed_students ms
        where ms.id in (select ds.id from public.retention_district_students (p_studio) ds)
          and not exists (
              select 1 from public.district_retention_students s
              where s.studio_id = p_studio and s.managed_student_id = ms.id
          )
        order by ms.id
        for update of ms
    ) l;
    if cardinality(v_locked) = 0 then
        return 0;
    end if;

    -- Under those locks, each row as it is now (a new statement, which reads
    -- what the transactions waited for committed): only a student still
    -- attributed to the district (retention_district_students(), the purge's
    -- one scope) is listed, with was_archived as the row is now. One moved
    -- out meanwhile is skipped: not listed, archived or signed out.
    with listed as (
        insert into public.district_retention_students (studio_id, managed_student_id, student_user_id, was_archived)
        select p_studio, ds.id, ds.student_user_id, ds.archived_at is not null
        from public.retention_district_students (p_studio) ds
        where ds.id = any (v_locked)
          and not exists (
              select 1 from public.district_retention_students s
              where s.studio_id = p_studio and s.managed_student_id = ds.id
          )
        on conflict do nothing
        returning managed_student_id, student_user_id, was_archived
    )
    select coalesce(jsonb_agg(jsonb_build_object(
               'managed_student_id', l.managed_student_id,
               'student_user_id', l.student_user_id,
               'was_archived', l.was_archived) order by l.managed_student_id), '[]'::jsonb)
    into v_late
    from listed l;

    v_n := jsonb_array_length(v_late);
    if v_n = 0 then
        return 0;
    end if;

    -- As the soft delete: archived and every token refused
    -- (student_access_revoked), under the roster rows' locks taken above.
    update public.managed_students ms
    set archived_at = coalesce(ms.archived_at, p_now),
        access_revoked_at = clock_timestamp()
    where ms.id in (select (e ->> 'managed_student_id')::uuid from jsonb_array_elements(v_late) e);

    delete from auth.refresh_tokens
    where user_id in (select e ->> 'student_user_id' from jsonb_array_elements(v_late) e);
    delete from auth.sessions
    where user_id in (select (e ->> 'student_user_id')::uuid from jsonb_array_elements(v_late) e);

    insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
    values (p_studio, 'soft_deleted',
            (select r.contract_ends_at from public.district_retention r where r.studio_id = p_studio),
            jsonb_build_object('event', 'late_students_listed', 'students_archived', v_n,
                               'students', v_late, 'by', p_by));
    return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- The run: the soft delete's listing locks first too
-- ---------------------------------------------------------------------------
-- 20261022130300's definition; the soft delete locks the district's roster
-- rows before it lists them, as district_retention_list_late() does. The hard
-- delete's re-list and the sweep call district_retention_list_late(), above.
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
        'public.managed_students_district_attribution ()',
        'public.admin_set_student_district (uuid, uuid, text)',
        'public.retention_district_run (timestamptz, int)'
    ]
    loop
        execute format('revoke all on function %s from public, anon, authenticated', fn);
        execute format('grant execute on function %s to service_role', fn);
    end loop;
end;
$$;

-- Internal, as in 20261022130300: only the run calls it, under the district's
-- lock. Not even the service role calls it directly.
revoke all on function public.district_retention_list_late (uuid, timestamptz, text)
from public, anon, authenticated, service_role;

-- DEPLOY: apply right after 20261022130300, before deploying student-provision
-- (decision 68(4)'s order, inside the freeze). No edge function changes.
-- retention_district_run() stays unscheduled (20261021120700's DEPLOY note).
