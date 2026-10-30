-- Deleting a roster student takes their markings with them.
--
-- Account deletion keeps a departed collaborator's marks on other people's
-- scores, authorless (20261007120600_account_deletion.sql): a fellow teacher's
-- fingerings on a shared score are part of that score. A roster student is a
-- different case. Their teacher is deleting a child's or teenager's account,
-- usually because the family asked, and what that student drew is the
-- student's data — so the teacher's "Delete student" (student-provision
-- action 'delete') and the 12-month purge of archived students
-- (20261021120300_retention_jobs.sql) both scrub it first:
--
--  * every live annotation the student made is TOMBSTONED (deleted_at set),
--    never hard-deleted, so annotations_stamp bumps `seq`,
--    annotations_broadcast fires, and every device that already pulled the
--    mark converges by sync the ordinary way. Its payload is replaced in the
--    same write by the smallest shape annotation_payload_valid() admits, so
--    the strokes and text themselves are gone at once rather than when
--    compact_annotation_tombstones() finally removes the row;
--  * every lesson-history snapshot loses the student's marks from its
--    payload, and stops naming the student as the one who captured it. The
--    rest of each snapshot (the teacher's marks) stays.
--
-- Only then is the auth user deleted, whose cascades take the roster row,
-- assignments, memberships and practice notes.
--
-- Service role (student-provision) and the owner (the cron job) only. It
-- refuses an account that is not a provisioned student, so it can never be
-- pointed at a teacher's own marks.

create or replace function public.scrub_student_markings (p_student uuid) returns jsonb
language plpgsql security definer
set search_path = public as $$
declare
    marks int;
    snapshots int;
begin
    if not exists (
        select 1 from auth.users u
        where u.id = p_student and u.raw_app_meta_data ->> 'user_type' = 'student'
    ) then
        raise exception 'scrub_student_markings: % is not a provisioned student', p_student
            using errcode = '22023';
    end if;

    update public.annotations a
    set deleted_at = coalesce(a.deleted_at, now()),
        payload = case
            when a.kind = 'text' then '{"x":0,"y":0,"size":0.01,"text":""}'::jsonb
            else '{"pts":[0,0,0],"w":0.001}'::jsonb
        end
    where a.created_by = p_student;
    get diagnostics marks = row_count;

    update public.annotation_snapshots s
    set payload = coalesce(
            (
                select jsonb_agg(e order by ord)
                from jsonb_array_elements(s.payload) with ordinality as t (e, ord)
                where e ->> 'createdBy' is distinct from p_student::text
            ),
            '[]'::jsonb
        ),
        created_by = case when s.created_by = p_student then null else s.created_by end
    where jsonb_typeof(s.payload) = 'array'
      and (
          s.created_by = p_student
          or exists (
              select 1 from jsonb_array_elements(s.payload) e
              where e ->> 'createdBy' = p_student::text
          )
      );
    get diagnostics snapshots = row_count;

    return jsonb_build_object('annotations', marks, 'snapshots', snapshots);
end;
$$;

revoke all on function public.scrub_student_markings (uuid) from public, anon, authenticated;
grant execute on function public.scrub_student_markings (uuid) to service_role;
