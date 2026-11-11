-- Account deletion: a departed collaborator's marks stay on other people's scores.
--
-- Self-serve deletion (supabase/functions/delete-account) ends by deleting the
-- auth user, and every user-keyed FK then fires. For almost all of them CASCADE
-- is exactly right — the user's own scores, memberships, tags, favourites,
-- roster, billing rows and usage counters belong to nobody else. One did not:
--
--   annotations.created_by references auth.users ON DELETE CASCADE
--
-- There is one shared annotation layer per score. When a student or a fellow
-- teacher who had been marking up someone ELSE's score deleted their account,
-- the cascade hard-deleted every mark they ever drew there — fingerings a
-- paying teacher had been relying on, gone from the teacher's copy without the
-- teacher doing anything. It also broke sync: annotations are tombstoned, never
-- hard-deleted, precisely so offline clients converge by `seq`; a cascade
-- delete bumps nothing, so every device that had already pulled those marks
-- would keep showing them forever while the server no longer had them.
--
-- SET NULL instead. The marks stay part of the score they were drawn on, and
-- the row stops naming anyone. Because the referential action is an UPDATE,
-- annotations_stamp() bumps `seq` and annotations_broadcast fires, so every
-- open or returning client pulls the row with its author cleared — convergence
-- for free. Annotations on scores the deleted user OWNED are unaffected by
-- this: those go with the score, through documents.id's own cascade, and the
-- delete-account function deletes owned scores before the auth user.
--
-- An ON DELETE SET NULL is an UPDATE, so a BEFORE UPDATE trigger can still
-- refuse it and with it the whole auth delete. score_analyses.created_by does:
-- guard_score_analyses_client_write (20260803120000) treats any write without
-- a service_role JWT as a client's, and GoTrue's delete carries no JWT. That
-- is left to delete-account, which clears score_analyses.created_by as the
-- service role just before the auth delete (releaseAuthorship), so deletion
-- works whatever that guard looks like. The trigger added below cannot cause
-- the same problem: it keys on the writing role, not the JWT.
--
-- Dropping NOT NULL would on its own widen what a client may write: the
-- annotations_update policy has no column restriction and `authenticated`
-- holds UPDATE on created_by, so NOT NULL was the only thing stopping an
-- editor from blanking the author of any mark on a shared score. Inserts are
-- still safe — annotations_insert requires created_by = auth.uid(), so a new
-- row can never be authorless — and annotations_freeze_created_by below closes
-- the UPDATE path: a client may not change created_by at all, to null or to
-- anyone. Who counts as a client is the role doing the write
-- (current_user in authenticated/anon), not the JWT: the FK's own SET NULL
-- runs as the table's owner — not as GoTrue's role, and with no JWT — so it
-- passes, and deleting an account that marked a shared score still works.
-- (fix/integrity's annotations_guard_columns pins the same column for the
-- same clients; the two agree and either alone is enough.)

alter table public.annotations alter column created_by drop not null;

-- SECURITY INVOKER (the default), so current_user is the writer rather than
-- this function's owner. Fires only when created_by is in the SET list, so
-- ordinary edits, which never send it, pay nothing.
create or replace function public.annotations_freeze_created_by () returns trigger language plpgsql
set search_path = ''
as $$
begin
    if current_user in ('authenticated', 'anon') and new.created_by is distinct from old.created_by then
        raise exception 'annotations.created_by cannot be changed'
            using errcode = '42501';
    end if;
    return new;
end;
$$;

revoke all on function public.annotations_freeze_created_by () from public, anon, authenticated;

drop trigger if exists annotations_freeze_created_by on public.annotations;

create trigger annotations_freeze_created_by before update of created_by on public.annotations
for each row execute function public.annotations_freeze_created_by ();

alter table public.annotations drop constraint if exists annotations_created_by_fkey;

-- Every statement here runs in the migration's one transaction, and the
-- ALTERs above already hold ACCESS EXCLUSIVE on annotations until it commits,
-- so annotation writes wait for the whole migration, FK scan included. That is
-- brief at the table's current size (tens of rows in production); a much
-- larger table would want this FK added NOT VALID and validated in a separate
-- migration.
alter table public.annotations
    add constraint annotations_created_by_fkey foreign key (created_by) references auth.users (id) on delete set null;
