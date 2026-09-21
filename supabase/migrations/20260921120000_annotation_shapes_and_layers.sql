-- Hairpin shapes, and teacher/student annotation layers.
--
-- `shape` is a real annotation kind (a hairpin is not a fake stroke).
-- The layer lives on the payload, not a column: a row with no layer is
-- teacher, so lessons written before this migration stay visible.
-- documents.share_student_layer is one flag for the whole score. Until
-- the owner sets it, a student layer is visible to the owner and to the
-- member who wrote it, and to nobody else.

alter table public.annotations drop constraint if exists annotations_kind_check;

alter table public.annotations
    add constraint annotations_kind_check
    check (kind in ('stroke', 'highlight', 'text', 'shape'));

alter table public.documents
    add column if not exists share_student_layer boolean not null default false;

create index if not exists annotations_student_layer
    on public.annotations (document_id)
    where payload ->> 'layer' = 'student';

create or replace function public.annotation_layer (payload jsonb)
returns text
language sql
immutable
set search_path = public
as $$
    select case when payload ->> 'layer' = 'student' then 'student' else 'teacher' end;
$$;

create or replace function public.caller_is_roster_student ()
returns boolean
language sql
stable
set search_path = public
as $$
    select coalesce((select auth.jwt()) -> 'app_metadata' ->> 'user_type', '') = 'student';
$$;

-- SELECT. Owner sees both layers. Every member sees the teacher layer.
-- A member sees their own student marks. Everyone else sees the student
-- layer only when the owner has shared it.
create or replace function public.annotation_row_visible (doc uuid, payload jsonb, created_by uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
    select
        public.document_role (doc) is not null
        and (
            public.document_role (doc) = 'owner'
            or public.annotation_layer (payload) <> 'student'
            or created_by = (select auth.uid())
            or exists (
                select 1
                from public.documents d
                where d.id = doc
                  and d.share_student_layer
            )
        );
$$;

-- INSERT/UPDATE. Owner writes both layers. A roster student cannot write
-- the teacher layer. Other editors may still change anyone's teacher
-- marks (the old "editors edit anyone" rule, narrowed to that layer).
-- A student layer row is writable by its author and by the owner.
create or replace function public.annotation_row_writable (doc uuid, payload jsonb, created_by uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
    select
        public.document_role (doc) in ('owner', 'editor')
        and not public.document_is_archived (doc)
        and (
            public.document_role (doc) = 'owner'
            or (
                public.annotation_layer (payload) <> 'student'
                and not public.caller_is_roster_student ()
            )
            or (
                public.annotation_layer (payload) = 'student'
                and created_by = (select auth.uid())
            )
        );
$$;

revoke all on function public.annotation_layer (jsonb) from public, anon;
grant execute on function public.annotation_layer (jsonb) to authenticated;

revoke all on function public.caller_is_roster_student () from public, anon;
grant execute on function public.caller_is_roster_student () to authenticated;

revoke all on function public.annotation_row_visible (uuid, jsonb, uuid) from public, anon;
grant execute on function public.annotation_row_visible (uuid, jsonb, uuid) to authenticated;

revoke all on function public.annotation_row_writable (uuid, jsonb, uuid) from public, anon;
grant execute on function public.annotation_row_writable (uuid, jsonb, uuid) to authenticated;

drop policy if exists annotations_select on public.annotations;
create policy annotations_select on public.annotations
    for select to authenticated
    using (public.annotation_row_visible (document_id, payload, created_by));

drop policy if exists annotations_insert on public.annotations;
create policy annotations_insert on public.annotations
    for insert to authenticated
    with check (
        public.annotation_row_writable (document_id, payload, created_by)
        and created_by = (select auth.uid())
    );

drop policy if exists annotations_update on public.annotations;
create policy annotations_update on public.annotations
    for update to authenticated
    using (public.annotation_row_writable (document_id, payload, created_by))
    with check (public.annotation_row_writable (document_id, payload, created_by));

-- The existing documents broadcast only fired when the PDF bytes changed.
-- Sharing the student layer has to reach open viewers too, or a hidden
-- layer stays hidden until the next full reload. The payload is the same
-- document row; clients tell a byte replacement from a flag flip by which
-- field moved.
drop trigger if exists documents_broadcast on public.documents;
create trigger documents_broadcast
    after update on public.documents
    for each row
    when (
        old.content_rev is distinct from new.content_rev
        or old.share_student_layer is distinct from new.share_student_layer
    )
    execute function public.broadcast_document_changes ();
