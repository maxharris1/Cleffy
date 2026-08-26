-- Roster, assignments, and practice notes — the teaching half of pricing v2.
--
-- The model, in one place:
--  * A provisioned student is a REAL Supabase user, flagged with
--    app_metadata.user_type = 'student' by the student-provision Edge Function
--    (admin-set, so it is not user-editable and can be trusted in a policy).
--    managed_students is the teacher's side of that account: the display name
--    they picked, the hash of the login code, and the archive flag that decides
--    whether the row still counts against the `students` stock.
--  * Permissions ride the roles that already exist. Assigning a score upserts a
--    document_members row — 'editor' so the student can annotate their own
--    fingerings and practice marks, or 'viewer' when the teacher flips the
--    assignment to view-only. There is no new member role, and the annotation
--    policies are untouched: a student IS an editor, by the same rules as a
--    share-link collaborator.
--  * practice_notes is the teacher's journal. Notes are private to their author
--    until `shared` is set, which is what lets a teacher write both "watch the
--    left hand in bar 12" for the student and "parents want to move to Tuesdays"
--    for themselves, in the same place.
--  * Students are never gated and never billed. get_entitlements() answers tier
--    'student' for them (see 20260811120000_billing.sql), and nothing in this
--    file consumes a quota — the teacher's roster stock is what pricing meters.
--
-- Ids are caller-generated, matching documents/annotations/library_tags: the
-- provisioning function and the client already hold the uuid they just made.

-- ---------------------------------------------------------------------------
-- Roster
-- ---------------------------------------------------------------------------
create table public.managed_students (
    id uuid primary key,
    teacher_id uuid not null references auth.users (id) on delete cascade,
    -- One roster row per student account: a student belongs to the teacher who
    -- provisioned them, and moving them means archiving and re-provisioning.
    student_user_id uuid not null unique references auth.users (id) on delete cascade,
    display_name text not null,
    -- Never the code itself. The login function hashes and compares.
    login_code_hash text not null,
    parent_email text,
    -- Archived students keep their history and stop counting against `students`.
    archived_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint managed_students_display_name_nonempty check (length(trim(display_name)) > 0)
);

-- The roster stock is "unarchived rows for this teacher", so the index carries
-- the same predicate the count does.
create index managed_students_teacher_active on public.managed_students (teacher_id) where archived_at is null;

create index managed_students_login_code on public.managed_students (login_code_hash);

create trigger managed_students_touch before update on public.managed_students
for each row execute function public.touch_updated_at ();

-- ---------------------------------------------------------------------------
-- Assignments
-- ---------------------------------------------------------------------------
create table public.assignments (
    id uuid primary key,
    document_id uuid not null references public.documents (id) on delete cascade,
    student_user_id uuid not null references auth.users (id) on delete cascade,
    assigned_by uuid not null references auth.users (id) on delete cascade,
    note text,
    due_at timestamptz,
    -- 'edit' grants the editor role, 'view' the viewer role. Full edit is the
    -- default: a student who cannot mark their own fingerings has half a score.
    access text not null default 'edit' check (access in ('edit', 'view')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (document_id, student_user_id)
);

create index assignments_student on public.assignments (student_user_id);

create index assignments_document on public.assignments (document_id);

create trigger assignments_touch before update on public.assignments
for each row execute function public.touch_updated_at ();

-- ---------------------------------------------------------------------------
-- Practice notes (the teacher's journal, with an opt-in share flag)
-- ---------------------------------------------------------------------------
create table public.practice_notes (
    id uuid primary key,
    document_id uuid not null references public.documents (id) on delete cascade,
    -- Null means a note about the score in general rather than about one student.
    student_user_id uuid references auth.users (id) on delete cascade,
    author_id uuid not null references auth.users (id) on delete cascade,
    noted_on date not null default current_date,
    body text not null,
    -- Off by default: a journal the student can read is a different thing from
    -- a journal, so sharing is always a deliberate act.
    shared boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint practice_notes_body_nonempty check (length(trim(body)) > 0)
);

create index practice_notes_doc_day on public.practice_notes (document_id, noted_on desc);

create index practice_notes_student_day on public.practice_notes (student_user_id, noted_on desc);

create trigger practice_notes_touch before update on public.practice_notes
for each row execute function public.touch_updated_at ();

-- ---------------------------------------------------------------------------
-- Assignment RPCs — the only write path for assignments and their membership
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because assigning has to write document_members, which has no
-- client write policy at all (every membership write goes through a definer
-- path: the owner trigger, redeem_share_link, and now this).
create or replace function public.assign_score (
    p_document uuid,
    p_student uuid,
    p_access text default 'edit',
    p_note text default null,
    p_due_at timestamptz default null
) returns uuid language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_role text;
    v_id uuid;
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    -- document_role() reads auth.uid(), which is still the CALLER inside a
    -- definer function — the JWT claim does not change with the executing role.
    if public.document_role (p_document) is distinct from 'owner' then
        raise exception 'only the score owner can assign it' using errcode = '42501';
    end if;

    if p_access not in ('edit', 'view') then
        raise exception 'access must be edit or view' using errcode = '22023';
    end if;

    -- A teacher may only assign to their own, unarchived roster: this is what
    -- stops an assignment from reaching a student someone else provisioned.
    if not exists (
        select 1
        from public.managed_students ms
        where ms.teacher_id = v_caller
          and ms.student_user_id = p_student
          and ms.archived_at is null
    ) then
        raise exception 'not on your roster' using errcode = 'P0002';
    end if;

    v_role := case when p_access = 'view' then 'viewer' else 'editor' end;

    insert into public.assignments (id, document_id, student_user_id, assigned_by, note, due_at, access)
    values (gen_random_uuid(), p_document, p_student, v_caller, p_note, p_due_at, p_access)
    on conflict (document_id, student_user_id) do update
        set access = excluded.access,
            note = excluded.note,
            due_at = excluded.due_at,
            updated_at = now()
    returning id into v_id;

    insert into public.document_members (document_id, user_id, role)
    values (p_document, p_student, v_role)
    on conflict (document_id, user_id) do update
        set role = case
            -- Same owner guard as redeem_share_link: assigning a score must never
            -- cost anyone ownership of it.
            when public.document_members.role = 'owner' then 'owner'
            -- Unlike a share link, the teacher's toggle otherwise wins, editor ->
            -- viewer included: flipping an assignment to view-only has to demote.
            else excluded.role
        end;

    return v_id;
end;
$$;

create or replace function public.unassign_score (p_document uuid, p_student uuid) returns void language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    if public.document_role (p_document) is distinct from 'owner' then
        raise exception 'only the score owner can unassign it' using errcode = '42501';
    end if;

    delete from public.assignments
    where document_id = p_document
      and student_user_id = p_student;

    -- Withdrawing an assignment withdraws the access it granted, but an owner row
    -- was never the assignment's to give and is not its to take away.
    delete from public.document_members
    where document_id = p_document
      and user_id = p_student
      and role <> 'owner';
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.managed_students enable row level security;
alter table public.assignments enable row level security;
alter table public.practice_notes enable row level security;

-- The teacher sees their roster; the student sees their own row (it is how the
-- student app learns its display name). NO client write policies: rows are
-- created by the student-provision Edge Function under the service role.
create policy managed_students_select on public.managed_students for select to authenticated
using (
    teacher_id = (select auth.uid())
    or student_user_id = (select auth.uid())
);

-- Both sides of an assignment can read it. Writes go through assign_score /
-- unassign_score so the membership row can never drift from the assignment.
create policy assignments_select on public.assignments for select to authenticated
using (
    student_user_id = (select auth.uid())
    or public.document_role (document_id) = 'owner'
);

create policy practice_notes_select on public.practice_notes for select to authenticated
using (
    author_id = (select auth.uid())
    or (
        shared
        and student_user_id = (select auth.uid())
    )
);

create policy practice_notes_insert on public.practice_notes for insert to authenticated
with check (
    author_id = (select auth.uid())
    and public.document_role (document_id) = 'owner'
    and (
        student_user_id is null
        or exists (
            select 1
            from public.managed_students ms
            where ms.teacher_id = (select auth.uid())
              -- Qualified: unqualified would bind to ms's own column.
              and ms.student_user_id = practice_notes.student_user_id
        )
    )
);

create policy practice_notes_update on public.practice_notes for update to authenticated
using (author_id = (select auth.uid()))
with check (author_id = (select auth.uid()));

create policy practice_notes_delete on public.practice_notes for delete to authenticated
using (author_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- documents_insert: students are editors, never creators
-- ---------------------------------------------------------------------------
-- Keeps the owner and is_anonymous conditions from free_plan_efficiency and adds
-- the student clause. A provisioned student's library is exactly what their
-- teacher assigned: letting a student create a score would give them one nobody
-- pays for, that no teacher can see, and that no roster row can reach. The
-- documents table is live, which is why this rides here rather than being edited
-- into an already-applied migration.
drop policy if exists documents_insert on public.documents;

create policy documents_insert on public.documents for insert to authenticated
with check (
    owner_id = (select auth.uid())
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'user_type', '') <> 'student'
);

-- ---------------------------------------------------------------------------
-- Privilege hardening (same convention as edge_rate_rls_and_revoke_execute)
-- ---------------------------------------------------------------------------
revoke all on table public.managed_students from public;
revoke all on table public.managed_students from anon;
revoke all on table public.managed_students from authenticated;
grant select on table public.managed_students to authenticated;

revoke all on table public.assignments from public;
revoke all on table public.assignments from anon;
revoke all on table public.assignments from authenticated;
grant select on table public.assignments to authenticated;

revoke all on table public.practice_notes from public;
revoke all on table public.practice_notes from anon;
revoke all on table public.practice_notes from authenticated;
grant select, insert, update, delete on table public.practice_notes to authenticated;

-- Client RPCs: revoke PUBLIC/anon, keep authenticated.
revoke all on function public.assign_score (uuid, uuid, text, text, timestamptz) from public;
revoke all on function public.assign_score (uuid, uuid, text, text, timestamptz) from anon;
grant execute on function public.assign_score (uuid, uuid, text, text, timestamptz) to authenticated;

revoke all on function public.unassign_score (uuid, uuid) from public;
revoke all on function public.unassign_score (uuid, uuid) from anon;
grant execute on function public.unassign_score (uuid, uuid) to authenticated;
