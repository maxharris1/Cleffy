-- District retention: purge only the students the district provided.
--
-- Codex round-2 review of #64, new major 1: retention_district_students()
-- (20261021120700) picked every roster student of the district's owner and of
-- whoever was seated in the district on the day the purge ran. That is the
-- wrong boundary both ways:
--
--  * a teacher with private students who joins a district handed that whole
--    roster to the district's contract-end purge, and
--  * a teacher who left the district took the district's students out of it,
--    so the school-provided data the contract covered outlived the contract.
--
-- So each roster row records the district it was provisioned under, at the
-- moment it was provisioned, and the purge selects on that record alone.
-- Current membership plays no part.
--
-- Codex round-3 review of #64: that record must be POSITIVE EVIDENCE, never a
-- guess from membership. Holding a seat does not make every student a teacher
-- creates a district student; a teacher seated in a district still keeps a
-- private studio of their own. So the rule is:
--
--  * A student belongs to a district only when they were provisioned in the
--    district's context: the provisioning call names the district
--    (student-provision's districtStudioId), and the teacher owns or holds a
--    seat in that district studio (one with a district_billing record) at that
--    moment. A call that names no district provisions a private student, seated
--    or not; one that names a district the teacher is not in is refused.
--  * Cleffy has no classes or invite records a student is created under, so
--    the provisioning call is the only place that context exists.
--
-- The record is checked by a BEFORE INSERT trigger, whatever path inserts the
-- row (both student-provision branches today). It cannot be changed by an
-- UPDATE, short of the service role's admin_set_student_district() for a
-- correction a human has decided on. No foreign key: like district_retention,
-- it must outlive the studio it names, and a dangling id selects nothing.
--
-- district_attribution says how the record was decided:
--  'provisioned'  at provisioning, by the rule above (null: a private student)
--  'legacy'       provisioned before this migration, with no record of the
--                 context; the backfill below decides it, or leaves it pending
--  'backfilled'   decided by the backfill
--  'admin'        decided by a human, through admin_set_student_district()

alter table public.managed_students
add column if not exists district_studio_id uuid;

-- Every row that exists when the column is added is legacy: nothing recorded
-- the context it was provisioned in. The default fills them without an UPDATE
-- (so no trigger fires and updated_at is untouched); every later row is
-- decided by the trigger below. Rerunnable: the column is added once.
alter table public.managed_students
add column if not exists district_attribution text not null default 'legacy';

alter table public.managed_students
alter column district_attribution set default 'provisioned';

do $district_attribution$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.managed_students'::regclass
          and conname = 'managed_students_district_attribution_check'
    ) then
        alter table public.managed_students
        add constraint managed_students_district_attribution_check
        check (district_attribution in ('provisioned', 'legacy', 'backfilled', 'admin'));
    end if;
end;
$district_attribution$;

create index if not exists managed_students_district on public.managed_students (district_studio_id)
where district_studio_id is not null;

-- ---------------------------------------------------------------------------
-- May this teacher provision into this district, now?
-- ---------------------------------------------------------------------------
-- The district's owner, or a teacher holding a seat in it. student-provision
-- asks first, so a refused teacher gets a 403 before any account is created;
-- the trigger asks again, so no other insert path can skip it.
create or replace function public.district_provisionable (p_teacher uuid, p_studio uuid)
returns boolean language sql stable security definer
set search_path = public as $$
    select exists (
        select 1
        from public.district_billing b
        join public.studios st on st.id = b.studio_id
        where b.studio_id = p_studio
          and (st.owner_id = p_teacher
               or exists (select 1 from public.studio_members sm
                          where sm.studio_id = p_studio and sm.user_id = p_teacher))
    );
$$;

create or replace function public.managed_students_district_attribution () returns trigger language plpgsql
security definer
set search_path = public as $$
begin
    if tg_op = 'INSERT' then
        -- Whatever the caller wrote, a new row is decided here and now.
        new.district_attribution := 'provisioned';
        if new.district_studio_id is not null
           and not public.district_provisionable (new.teacher_id, new.district_studio_id) then
            raise exception 'the teacher does not own or hold a seat in that district'
                using errcode = '42501';
        end if;
    elsif (new.district_studio_id is distinct from old.district_studio_id
           or new.district_attribution is distinct from old.district_attribution)
          and current_setting('cleffy.district_attribution', true) is distinct from 'admin' then
        raise exception 'district attribution is recorded at provisioning and cannot be changed'
            using errcode = '42501';
    end if;
    return new;
end;
$$;

drop trigger if exists managed_students_district_attribution on public.managed_students;

create trigger managed_students_district_attribution before insert or update on public.managed_students
for each row execute function public.managed_students_district_attribution ();

-- A human's correction (a student provisioned into the wrong district, a legacy
-- row the backfill left pending, or a private student a district bought out):
-- the service role's alone, and logged where the purge logs, so the purge's
-- scope can always be explained.
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
end;
$$;

alter table public.district_retention_log drop constraint if exists district_retention_log_step_check;

alter table public.district_retention_log
add constraint district_retention_log_step_check check (
    step in ('notice_queued', 'notice_sent', 'soft_deleted', 'hard_deleted', 'cancelled', 'attribution_changed',
             'attribution_backfilled')
);

-- ---------------------------------------------------------------------------
-- Rows provisioned before this migration
-- ---------------------------------------------------------------------------
-- The round-2 rule, kept for the legacy backfill only: the district the
-- teacher owned, or held a seat in since before the student was created.
create or replace function public.district_studio_for_teacher (p_teacher uuid, p_at timestamptz default now())
returns uuid language sql stable security definer
set search_path = public as $$
    select d.studio_id
    from (
        select st.id as studio_id, 0 as rank, st.created_at as since
        from public.studios st
        join public.district_billing b on b.studio_id = st.id
        where st.owner_id = p_teacher
        union all
        select sm.studio_id, 1, sm.created_at
        from public.studio_members sm
        join public.district_billing b on b.studio_id = sm.studio_id
        where sm.user_id = p_teacher and sm.created_at <= p_at
    ) d
    order by d.rank, d.since, d.studio_id
    limit 1;
$$;

-- Legacy rows only. A row provisioned under this migration was decided at
-- provisioning, a private one included, and the backfill never revisits it.
-- Rerunnable: it touches undecided legacy rows only.
create or replace function public.backfill_district_student_attribution () returns int language plpgsql
security definer
set search_path = public as $$
declare
    v_n int;
begin
    perform set_config('cleffy.district_attribution', 'admin', true);
    update public.managed_students ms
    set district_studio_id = public.district_studio_for_teacher (ms.teacher_id, ms.created_at),
        district_attribution = 'backfilled'
    where ms.district_attribution = 'legacy'
      and ms.district_studio_id is null
      and public.district_studio_for_teacher (ms.teacher_id, ms.created_at) is not null;
    get diagnostics v_n = row_count;
    perform set_config('cleffy.district_attribution', '', true);
    if v_n > 0 then
        insert into public.district_retention_log (studio_id, step, counts)
        select ms.district_studio_id, 'attribution_backfilled', jsonb_build_object('students', count(*))
        from public.managed_students ms
        where ms.district_attribution = 'backfilled'
        group by ms.district_studio_id;
    end if;
    return v_n;
end;
$$;

select public.backfill_district_student_attribution ();

-- ---------------------------------------------------------------------------
-- The purge's scope: the district's own students, and nobody else's
-- ---------------------------------------------------------------------------
create or replace function public.retention_district_students (p_studio uuid) returns setof public.managed_students
language sql stable security definer
set search_path = public as $$
    select ms.* from public.managed_students ms where ms.district_studio_id = p_studio;
$$;

do $$
declare
    fn text;
begin
    foreach fn in array array[
        'public.district_provisionable (uuid, uuid)',
        'public.district_studio_for_teacher (uuid, timestamptz)',
        'public.managed_students_district_attribution ()',
        'public.admin_set_student_district (uuid, uuid, text)',
        'public.backfill_district_student_attribution ()',
        'public.retention_district_students (uuid)'
    ]
    loop
        execute format('revoke all on function %s from public, anon, authenticated', fn);
        execute format('grant execute on function %s to service_role', fn);
    end loop;
end;
$$;

-- Clients read the roster through column grants (20260826194426_roster.sql);
-- these columns are the purge's, and stay out of them.
