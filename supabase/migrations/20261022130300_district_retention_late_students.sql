-- District retention: no student is provisioned into, or outlives, a district
-- whose purge has begun.
--
-- Decision 53(4), verified in the P5 rebase pass and failed there
-- (tests/sql/district_retention_late_student.sql, 3 of 6); fixed per decision
-- 67. The soft delete (20261021120700) listed the district's students once,
-- and the hard delete a week later worked from that list alone. A student
-- provisioned into the district after the list was taken (a roster insert
-- committing after the soft delete's snapshot, or simply the next day, since
-- district_provisionable() still let the owner or a seated teacher in) was
-- never listed, never archived, never deleted, and kept a dangling
-- district_studio_id after the district was gone. Three parts:
--
--  (a) The barrier. Once the district is soft deleted -- its students
--      archived and listed, the hard delete pending (district_retention row
--      with soft_deleted_at set and not cancelled), or hard deleted -- nothing
--      provisions into it or attributes a student to it:
--        * district_provisionable() answers false, and
--          district_provision_refusal() says why ('district_deletion_pending'
--          for the owner or a seated teacher, 'not_in_district' for anyone
--          else, so nobody outside the district learns its state);
--        * the roster table's trigger refuses an INSERT naming the district,
--          and the admin correction's UPDATE moving a student into it, with
--          SQLSTATE 55000 and the message 'district_deletion_pending' -- the
--          account deletion barrier's style (20261022110100), which
--          student-provision answers with a 409;
--        * admin_set_student_district() refuses to move a student into it
--          (re-confirming the district a student already has is not a new
--          attribution, and stays allowed: 20261022130000's r5);
--        * backfill_district_student_attribution() leaves a legacy row whose
--          evidence names it unattributed, counted as district_gone (the
--          district is going), so its result keeps its shape.
--  (b) The sweep. Every run, each soft-deleted district not yet hard deleted
--      has its students listed again: anyone attributed to it and not on its
--      list is listed, archived and signed out exactly as the soft delete did
--      (was_archived recorded the same way), and logged. Only students not
--      already listed are touched, so a second run changes nothing, and a
--      listed student a teacher restored since the soft delete stays restored
--      (20261021120700: the teacher's restore wins).
--  (c) The hard delete lists again, the same way, right before it scrubs and
--      deletes, under the district's lock, so the list it works from is
--      everything attributed to the district at that moment, and nothing can
--      be attributed to it after (the barrier, under the same lock).
--
-- THE LOCK. A district is locked through its billing record, as the run has
-- always done (20261021120700: FOR UPDATE SKIP LOCKED, so a district someone
-- else holds is passed over until tomorrow). The provisioning side now takes
-- the same row FOR KEY SHARE before it reads the district's state: the roster
-- trigger on an INSERT naming a district, and on an UPDATE moving a student
-- into one; admin_set_student_district() and the backfill take it first,
-- before any roster row. KEY SHARE conflicts with the run's FOR UPDATE and
-- with the studio's delete, and with nothing a provision does to other rows,
-- so:
--   * a provision in flight when the run reaches the district makes the run
--     pass it over (SKIP LOCKED) until the next run, which lists the student;
--   * a provision that starts while the run holds the district waits for the
--     run to commit, then reads soft_deleted_at (or finds the district gone)
--     and is refused;
--   * so the soft delete's list, and the hard delete's re-list, see every
--     attribution that will ever commit for the district.
-- Lock order, everywhere: the district's billing row first, then roster rows
-- (and, on a provision, the account-deletion advisory lock its own trigger
-- takes after this one), as the run takes billing, then district_retention,
-- then roster rows. Nothing takes a roster row and then the billing row,
-- except a direct UPDATE of district_studio_id that skipped
-- admin_set_student_district(); the trigger still locks and refuses there.
--
-- The barrier lifts with the cycle: a cancel (the contract renewed or moved)
-- deletes the district_retention row, and the district provisions again.
--
-- No new step value (20261022130000's note: 20261021120800 rebuilds the step
-- check with a fixed list). A late listing is logged as soft_deleted with
-- counts.event = 'late_students_listed'.
--
-- Rerunnable: functions are replaced with the same signatures (two new ones
-- are created or replaced), and the privileges reset to the same end state.
-- No table, trigger or constraint is added.

-- ---------------------------------------------------------------------------
-- Is the district being deleted?
-- ---------------------------------------------------------------------------
-- Soft deleted and not cancelled (the cancel deletes the row), or hard
-- deleted. The notice period before the soft delete is not: the soft delete
-- lists whoever is in the district on the day it runs.
create or replace function public.district_deletion_pending (p_studio uuid) returns boolean
language sql stable security definer
set search_path = public as $$
    select exists (
        select 1 from public.district_retention r
        where r.studio_id = p_studio
          and (r.soft_deleted_at is not null or r.hard_deleted_at is not null)
    );
$$;

-- Why this teacher may not provision into this district now, or null if they
-- may. Membership is asked first, so the district's state is told only to its
-- owner and its seated teachers.
create or replace function public.district_provision_refusal (p_teacher uuid, p_studio uuid) returns text
language sql stable security definer
set search_path = public as $$
    select case
        when not exists (
            select 1
            from public.district_billing b
            join public.studios st on st.id = b.studio_id
            where b.studio_id = p_studio
              and (st.owner_id = p_teacher
                   or exists (select 1 from public.studio_members sm
                              where sm.studio_id = p_studio and sm.user_id = p_teacher))
        ) then 'not_in_district'
        when public.district_deletion_pending (p_studio) then 'district_deletion_pending'
    end;
$$;

-- 20261021120800's question, now also no while the district is being deleted.
create or replace function public.district_provisionable (p_teacher uuid, p_studio uuid)
returns boolean language sql stable security definer
set search_path = public as $$
    select public.district_provision_refusal (p_teacher, p_studio) is null;
$$;

-- ---------------------------------------------------------------------------
-- The roster trigger: the barrier on every insert and every re-attribution
-- ---------------------------------------------------------------------------
-- 20261021120800's definition, plus the district's lock and the barrier.
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
        -- A correction moving a student into a district being deleted.
        if new.district_studio_id is not null and new.district_studio_id is distinct from old.district_studio_id then
            perform 1 from public.district_billing b where b.studio_id = new.district_studio_id for key share;
            if public.district_deletion_pending (new.district_studio_id) then
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
-- The admin correction: the district's lock first, and the barrier
-- ---------------------------------------------------------------------------
-- 20261022130000's definition, plus the lock (before the roster row's, the
-- run's order) and the refusal.
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
    if p_studio is not null then
        perform 1 from public.district_billing b where b.studio_id = p_studio for key share;
    end if;
    select ms.district_studio_id into v_old from public.managed_students ms where ms.id = p_managed_student for update;
    if not found then
        raise exception 'no such roster student' using errcode = 'P0002';
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
-- The backfill: no legacy row is attributed to a district being deleted
-- ---------------------------------------------------------------------------
-- 20261021120800's definition, plus the lock on every district the evidence
-- names (before any roster row, in studio order) and one more reason for
-- district_gone: the district is being deleted.
create or replace function public.backfill_district_student_attribution () returns jsonb language plpgsql
security definer
set search_path = public as $$
declare
    v_totals jsonb;
    v_districts jsonb;
    v_attributed int;
    v_result jsonb;
    v_district jsonb;
begin
    perform 1
    from public.district_billing b
    where b.studio_id in (
        select e.studio_id
        from public.district_student_evidence e
        join public.managed_students ms on ms.id = e.managed_student_id
        where ms.district_attribution = 'legacy' and ms.district_studio_id is null
    )
    order by b.studio_id
    for key share of b;

    perform set_config('cleffy.district_attribution', 'admin', true);
    with legacy as (
        select ms.id, ms.teacher_id, ms.created_at,
               array(select e.studio_id from public.district_student_evidence e
                     where e.managed_student_id = ms.id order by e.studio_id) as studios
        from public.managed_students ms
        where ms.district_attribution = 'legacy' and ms.district_studio_id is null
    ), classified as (
        select l.id, l.studios,
               case
                   when cardinality(l.studios) = 0 then 'no_evidence'
                   when cardinality(l.studios) > 1 then 'ambiguous'
                   when not exists (select 1 from public.district_billing b
                                    join public.studios st on st.id = b.studio_id
                                    where b.studio_id = l.studios[1]) then 'district_gone'
                   -- Being deleted (20261022130300): going, so gone.
                   when public.district_deletion_pending (l.studios[1]) then 'district_gone'
                   when l.created_at < (select greatest(st.created_at, b.created_at)
                                        from public.district_billing b
                                        join public.studios st on st.id = b.studio_id
                                        where b.studio_id = l.studios[1]) then 'before_district'
                   when not public.district_held_at (l.teacher_id, l.studios[1], l.created_at) then 'outside_tenure'
                   else 'attributed'
               end as outcome
        from legacy l
    ), updated as (
        update public.managed_students ms
        set district_studio_id = c.studios[1], district_attribution = 'backfilled'
        from classified c
        where c.outcome = 'attributed' and ms.id = c.id
        returning ms.id
    ), by_district as (
        select d.studio_id, jsonb_object_agg(d.outcome, d.n) as counts
        from (select s.studio_id, c.outcome, count(*) as n
              from classified c cross join lateral unnest(c.studios) as s(studio_id)
              group by s.studio_id, c.outcome) d
        group by d.studio_id
    )
    select (select count(*) from updated),
           coalesce((select jsonb_object_agg(o.outcome, o.n)
                     from (select outcome, count(*) as n from classified group by outcome) o), '{}'::jsonb),
           coalesce((select jsonb_agg(jsonb_build_object('studio_id', studio_id, 'counts', counts))
                     from by_district), '[]'::jsonb)
    into v_attributed, v_totals, v_districts;
    perform set_config('cleffy.district_attribution', '', true);

    v_result := jsonb_build_object(
        'attributed', v_attributed,
        'skipped_no_evidence', coalesce((v_totals ->> 'no_evidence')::int, 0),
        'skipped_ambiguous', coalesce((v_totals ->> 'ambiguous')::int, 0),
        'skipped_district_gone', coalesce((v_totals ->> 'district_gone')::int, 0),
        'skipped_before_district', coalesce((v_totals ->> 'before_district')::int, 0),
        'skipped_outside_tenure', coalesce((v_totals ->> 'outside_tenure')::int, 0)
    );

    if v_totals <> '{}'::jsonb then
        for v_district in select * from jsonb_array_elements(v_districts) loop
            insert into public.district_retention_log (studio_id, step, counts)
            values ((v_district ->> 'studio_id')::uuid, 'attribution_backfilled', v_district -> 'counts');
        end loop;
        insert into public.district_retention_log (studio_id, step, counts)
        values (null, 'attribution_backfill_run', v_result);
    end if;
    raise notice 'district attribution backfill: %', v_result;
    return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- List the district's students again: the ones not on its list yet
-- ---------------------------------------------------------------------------
-- The caller holds the district's lock (its billing row FOR UPDATE). Each
-- student attributed to the district (retention_district_students(), the
-- purge's one scope) and not on its list is listed, archived and signed out
-- exactly as the soft delete does it, and the listing is logged. Students
-- already listed are not touched: a second call lists, archives and logs
-- nothing, and a teacher's restore of a listed student stands. Returns how
-- many it listed.
create or replace function public.district_retention_list_late (p_studio uuid, p_now timestamptz, p_by text)
returns int language plpgsql security definer
set search_path = public as $$
declare
    v_late jsonb;
    v_n int;
begin
    with listed as (
        insert into public.district_retention_students (studio_id, managed_student_id, student_user_id, was_archived)
        select p_studio, ds.id, ds.student_user_id, ds.archived_at is not null
        from public.retention_district_students (p_studio) ds
        where not exists (
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
    -- (student_access_revoked), under the roster row's lock.
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
-- The run: the hard delete lists again first, and every run sweeps
-- ---------------------------------------------------------------------------
-- 20261022130000's definition; the hard delete calls
-- district_retention_list_late() before its loop, and after the candidates
-- every soft-deleted district not yet hard deleted is swept, each under its
-- billing row's lock taken the same way.
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
        'public.district_deletion_pending (uuid)',
        'public.district_provision_refusal (uuid, uuid)',
        'public.district_provisionable (uuid, uuid)',
        'public.managed_students_district_attribution ()',
        'public.admin_set_student_district (uuid, uuid, text)',
        'public.backfill_district_student_attribution ()',
        'public.retention_district_run (timestamptz, int)'
    ]
    loop
        execute format('revoke all on function %s from public, anon, authenticated', fn);
        execute format('grant execute on function %s to service_role', fn);
    end loop;
end;
$$;

-- Internal: only the run calls it, under the district's lock. Not even the
-- service role calls it directly (it archives students, and its caller must
-- hold the lock), whatever the project's default privileges gave it.
revoke all on function public.district_retention_list_late (uuid, timestamptz, text)
from public, anon, authenticated, service_role;

-- DEPLOY: apply before deploying student-provision (it asks
-- district_provision_refusal() when district_provisionable() says no).
-- retention_district_run() stays unscheduled (20261021120700's DEPLOY note).
