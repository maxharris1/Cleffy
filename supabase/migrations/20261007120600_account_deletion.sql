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
-- Nothing here widens what a client may write: annotations_insert still
-- requires created_by = auth.uid(), so a new row can never be authorless, and
-- the update policy and grants are untouched. Null arises only from this FK
-- action (verified on the dev branch: an authenticated insert with a null
-- author is rejected by RLS). A trigger that freezes created_by on UPDATE must let
-- this one transition (a non-null author becoming null) through, or deleting
-- any account that ever marked a shared score will fail.

alter table public.annotations alter column created_by drop not null;

alter table public.annotations drop constraint if exists annotations_created_by_fkey;

-- NOT VALID, then VALIDATE: adding a validated FK takes a lock that blocks
-- annotation writes for the whole scan of a live, write-heavy table. Splitting
-- it lets VALIDATE run under SHARE UPDATE EXCLUSIVE, which writers do not wait on.
alter table public.annotations
    add constraint annotations_created_by_fkey foreign key (created_by) references auth.users (id) on delete set null not valid;

alter table public.annotations validate constraint annotations_created_by_fkey;
