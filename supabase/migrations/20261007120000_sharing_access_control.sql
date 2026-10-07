-- Sharing & access control: owners manage who is on a score, members can leave,
-- and revoking a link can take back the access it handed out.
--
-- Before this, membership only ever grew. redeem_share_link and assign_score
-- were the only write paths, revoking a link set revoked_at and nothing else, so
-- everyone who had joined through it kept the score forever, and there was no
-- way to downgrade an editor or remove anyone short of deleting the score.
--
--  1. share_link_redemptions records which link a member's access came from, so
--     a revoke can optionally withdraw exactly that access. It is a side table,
--     not a column on document_members, on purpose:
--       * members_select lets EVERY member read every membership row on the
--         score. A token column there would hand a viewer the token of the
--         editor link somebody else joined through -- a working link, i.e. a
--         self-service upgrade to editor.
--       * Column-scoping document_members' select grant would close that, but
--         would also break `select *`, which the clients already in the field
--         use to read their own role (fetchMyRole) -- every deployed viewer
--         would fail to open a score in the window between this migration and
--         the frontend deploy.
--     The table has no client grants at all; only the definer functions below
--     read or write it.
--  2. Owner-only RPCs: list members (owners and editors may list; labels are
--     scoped to the caller's role), change a member's role, remove a member,
--     revoke a link with optional removal. A self-serve leave_document for
--     non-owners.
--  3. A trigger on document_members broadcasts a `membership` event on the
--     score's realtime topic whenever a role changes or a row disappears, so
--     an open viewer re-checks its access instead of discovering the change as
--     a stream of refused writes.
--
-- Roster students (managed_students + assignments) keep their own model: the
-- assignment is what grants their access, so
--  * changing their role here also flips assignments.access (the teacher's
--    Assign dialog and the student's list must agree with the membership),
--  * removing them here withdraws the assignment too -- a membership row the
--    assignment no longer backs, or an assignment with no membership, is the
--    drift unassign_score's comments warn about,
--  * revoking a link they also redeemed restores the assignment's role rather
--    than removing them, because the link was never the reason they had it,
--  * they cannot leave an assigned score themselves; it is the teacher's to
--    withdraw.

-- ---------------------------------------------------------------------------
-- Which link a member's access came from
-- ---------------------------------------------------------------------------
create table public.share_link_redemptions (
    document_id uuid not null,
    user_id uuid not null,
    -- Deleting the link (rather than revoking it) forgets the provenance; the
    -- membership itself is untouched, same as before this migration.
    token text not null references public.share_links (token) on delete cascade,
    redeemed_at timestamptz not null default now(),
    primary key (document_id, user_id),
    -- One row per membership, and it goes when the membership does -- however
    -- that happens (remove, leave, document delete, account delete).
    foreign key (document_id, user_id) references public.document_members (document_id, user_id) on delete cascade
);

create index share_link_redemptions_token on public.share_link_redemptions (token);

alter table public.share_link_redemptions enable row level security;

-- No policies and no client grants: provenance is read through
-- list_document_members (owner only sees tokens) and written by
-- redeem_share_link. service_role still needs the table-level grant.
revoke all on table public.share_link_redemptions from public;
revoke all on table public.share_link_redemptions from anon;
revoke all on table public.share_link_redemptions from authenticated;
grant all on table public.share_link_redemptions to service_role;

-- New links default to view-only. The client always sends a role, so this
-- only decides what a link created without one means -- and that should be
-- the role that cannot change anything.
alter table public.share_links alter column role set default 'viewer';

-- ---------------------------------------------------------------------------
-- Redemption: same contract as 20260801160754_rls.sql, plus provenance
-- ---------------------------------------------------------------------------
create or replace function public.redeem_share_link (p_token text) returns table (document_id uuid, granted_role text) language plpgsql security definer
set search_path = public as $$
-- OUT params (document_id) collide with column names inside the body (e.g.
-- the ON CONFLICT target) — let columns win; the OUTs are only set positionally.
#variable_conflict use_column
declare
    v_uid uuid := auth.uid();
    link record;
    v_prev_role text;
    v_new_role text;
begin
    if v_uid is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    select sl.document_id, sl.role into link
    from public.share_links sl
    where sl.token = p_token
      and sl.revoked_at is null
      and (sl.expires_at is null or sl.expires_at > now());

    if not found then
        raise exception 'invalid or expired share link' using errcode = 'P0002';
    end if;

    select dm.role into v_prev_role
    from public.document_members dm
    where dm.document_id = link.document_id and dm.user_id = v_uid;

    insert into public.document_members (document_id, user_id, role)
    values (link.document_id, v_uid, link.role)
    on conflict (document_id, user_id) do update
        set role = case
            when public.document_members.role = 'owner' then 'owner'
            when public.document_members.role = 'editor' then 'editor'
            else excluded.role
        end
    returning role into v_new_role;

    -- The link is recorded as the source only when it actually granted
    -- something: a first join, or a viewer lifted to editor. A redeem that
    -- changed nothing (an editor opening a view link, a member re-opening the
    -- link they joined with, another viewer link) leaves the existing source in
    -- place, so revoking THAT link still withdraws what it gave. An owner row
    -- has no source; nothing a link does can take ownership away.
    if v_new_role <> 'owner' and v_prev_role is distinct from v_new_role then
        insert into public.share_link_redemptions (document_id, user_id, token)
        values (link.document_id, v_uid, p_token)
        on conflict (document_id, user_id) do update
            set token = excluded.token,
                redeemed_at = now();
    end if;

    return query select link.document_id, v_new_role;
end;
$$;

revoke all on function public.redeem_share_link (text) from public;
revoke all on function public.redeem_share_link (text) from anon;
grant execute on function public.redeem_share_link (text) to authenticated;

-- ---------------------------------------------------------------------------
-- Internal helper: what a user leaves behind on a score they lost
-- ---------------------------------------------------------------------------
-- Favorites and tag assignments are the user's own rows and RLS hides nothing
-- about them, so without this the library would keep a starred id and a tag
-- count for a score it can no longer list. Not callable by clients: it takes
-- any user id, and is only ever reached from the definer functions below,
-- after they have decided the membership is gone.
create or replace function public.forget_document_for_user (p_document uuid, p_user uuid) returns void language sql security invoker
set search_path = public as $$
    delete from public.document_favorites
    where document_id = p_document
      and user_id = p_user;

    delete from public.document_tags dt
    using public.library_tags t
    where dt.document_id = p_document
      and dt.tag_id = t.id
      and t.user_id = p_user;
$$;

revoke all on function public.forget_document_for_user (uuid, uuid) from public;
revoke all on function public.forget_document_for_user (uuid, uuid) from anon;
revoke all on function public.forget_document_for_user (uuid, uuid) from authenticated;

-- ---------------------------------------------------------------------------
-- Member list
-- ---------------------------------------------------------------------------
-- auth.users is not client-readable, so labels have to be resolved behind a
-- definer boundary (same reason studio_roster exists). Owners and editors may
-- call it; viewers already read the bare membership rows through
-- members_select and get nothing more here.
--
-- What each caller sees is deliberately different. An editor may be a guest
-- who joined through a link the owner posted somewhere, so editors get the
-- names collaborators already show each other in presence, and never an email
-- address or a link token. The owner gets both: they are deciding who keeps
-- access to their score and need to recognise the account.
create or replace function public.list_document_members (p_document uuid) returns table (
    user_id uuid,
    role text,
    display_name text,
    email text,
    is_anonymous boolean,
    is_student boolean,
    joined_via_link text,
    joined_at timestamptz
) language plpgsql stable security definer
set search_path = public as $$
-- OUT params share names with the columns below; let columns win (see
-- redeem_share_link).
#variable_conflict use_column
declare
    v_caller uuid := auth.uid();
    v_role text;
    v_is_owner boolean;
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    v_role := public.document_role (p_document);
    if v_role is null or v_role not in ('owner', 'editor') then
        raise exception 'only the owner or an editor can list collaborators' using errcode = '42501';
    end if;
    v_is_owner := v_role = 'owner';

    return query
        select
            dm.user_id,
            dm.role,
            nullif(
                trim(coalesce(ms.display_name, u.raw_user_meta_data ->> 'display_name', '')),
                ''
            ),
            case when v_is_owner then u.email::text end,
            coalesce(u.is_anonymous, false),
            ms.student_user_id is not null,
            case when v_is_owner then r.token end,
            dm.created_at
        from public.document_members dm
        join auth.users u on u.id = dm.user_id
        left join public.managed_students ms on ms.student_user_id = dm.user_id
        left join public.share_link_redemptions r
            on r.document_id = dm.document_id
           and r.user_id = dm.user_id
        where dm.document_id = p_document
        order by (dm.role = 'owner') desc, dm.created_at asc, dm.user_id asc;
end;
$$;

revoke all on function public.list_document_members (uuid) from public;
revoke all on function public.list_document_members (uuid) from anon;
grant execute on function public.list_document_members (uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Change a member's role (owner only)
-- ---------------------------------------------------------------------------
create or replace function public.set_document_member_role (p_document uuid, p_user uuid, p_role text) returns void language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_current text;
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    -- document_role() reads auth.uid(), which is still the CALLER inside a
    -- definer function (see assign_score).
    if public.document_role (p_document) is distinct from 'owner' then
        raise exception 'only the score owner can change roles' using errcode = '42501';
    end if;

    -- 'owner' is not on offer: there is one owner, fixed by documents.owner_id,
    -- and handing the role out here would make a second one RLS would believe.
    if p_role is null or p_role not in ('editor', 'viewer') then
        raise exception 'role must be editor or viewer' using errcode = '22023';
    end if;

    select dm.role into v_current
    from public.document_members dm
    where dm.document_id = p_document and dm.user_id = p_user
    for update;

    if not found then
        raise exception 'not a member of this score' using errcode = 'P0002';
    end if;

    if v_current = 'owner' or exists (
        select 1 from public.documents d where d.id = p_document and d.owner_id = p_user
    ) then
        raise exception 'the owner''s access cannot be changed' using errcode = '42501';
    end if;

    if v_current = p_role then
        return;
    end if;

    update public.document_members
    set role = p_role
    where document_id = p_document and user_id = p_user;

    -- A roster student's access is the assignment's access. Keep them in step
    -- so the next assign_score (which re-applies `access`) does not silently
    -- undo this, and the teacher's Assign dialog shows what is true.
    update public.assignments
    set access = case when p_role = 'viewer' then 'view' else 'edit' end,
        updated_at = now()
    where document_id = p_document and student_user_id = p_user;
end;
$$;

revoke all on function public.set_document_member_role (uuid, uuid, text) from public;
revoke all on function public.set_document_member_role (uuid, uuid, text) from anon;
grant execute on function public.set_document_member_role (uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Remove a member (owner only)
-- ---------------------------------------------------------------------------
create or replace function public.remove_document_member (p_document uuid, p_user uuid) returns void language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_current text;
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    if public.document_role (p_document) is distinct from 'owner' then
        raise exception 'only the score owner can remove collaborators' using errcode = '42501';
    end if;

    select dm.role into v_current
    from public.document_members dm
    where dm.document_id = p_document and dm.user_id = p_user
    for update;

    if not found then
        raise exception 'not a member of this score' using errcode = 'P0002';
    end if;

    if v_current = 'owner' or exists (
        select 1 from public.documents d where d.id = p_document and d.owner_id = p_user
    ) then
        raise exception 'the owner cannot be removed from their own score' using errcode = '42501';
    end if;

    -- The assignment goes with the membership: an assignment whose score the
    -- student can no longer open is the drift unassign_score exists to prevent.
    delete from public.assignments
    where document_id = p_document and student_user_id = p_user;

    delete from public.document_members
    where document_id = p_document and user_id = p_user;

    perform public.forget_document_for_user (p_document, p_user);
end;
$$;

revoke all on function public.remove_document_member (uuid, uuid) from public;
revoke all on function public.remove_document_member (uuid, uuid) from anon;
grant execute on function public.remove_document_member (uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Leave a score (any non-owner member, for themselves)
-- ---------------------------------------------------------------------------
create or replace function public.leave_document (p_document uuid) returns void language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_role text;
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    v_role := public.document_role (p_document);
    if v_role is null then
        -- Already gone (a second tab, a removal that raced the click): the
        -- outcome the caller asked for already holds.
        return;
    end if;

    if v_role = 'owner' then
        raise exception 'the owner cannot leave their own score; delete it instead'
            using errcode = '42501',
                  detail = json_build_object('code', 'owner_cannot_leave')::text;
    end if;

    -- An assigned score is the teacher's to withdraw. Letting the student drop
    -- it would leave the teacher's assignment pointing at a score the student
    -- can no longer open, with nothing on the teacher's side saying so.
    if exists (
        select 1 from public.assignments a
        where a.document_id = p_document and a.student_user_id = v_caller
    ) then
        raise exception 'this score was assigned by your teacher'
            using errcode = '42501',
                  detail = json_build_object('code', 'assigned_score')::text;
    end if;

    delete from public.document_members
    where document_id = p_document and user_id = v_caller;

    perform public.forget_document_for_user (p_document, v_caller);
end;
$$;

revoke all on function public.leave_document (uuid) from public;
revoke all on function public.leave_document (uuid) from anon;
grant execute on function public.leave_document (uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Revoke a link, optionally withdrawing the access it granted (owner only)
-- ---------------------------------------------------------------------------
-- Returns how many members' link-granted access was withdrawn. The direct
-- share_links update (share_links_update policy) still works for a plain
-- revoke; this is the path that can also act on memberships, which no client
-- may write.
create or replace function public.revoke_share_link (p_token text, p_remove_members boolean default false) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_document uuid;
    v_member record;
    v_withdrawn int := 0;
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    select sl.document_id into v_document
    from public.share_links sl
    where sl.token = p_token
    for update;

    -- Same answer for "no such link" and "not your link": a distinct error
    -- would let anyone probe which tokens exist.
    if v_document is null or public.document_role (v_document) is distinct from 'owner' then
        raise exception 'only the score owner can revoke its links' using errcode = '42501';
    end if;

    -- Idempotent: re-revoking keeps the original timestamp, and may still be
    -- used to withdraw members after the fact.
    update public.share_links
    set revoked_at = coalesce(revoked_at, now())
    where token = p_token;

    if not coalesce(p_remove_members, false) then
        return 0;
    end if;

    for v_member in
        select r.user_id, dm.role, a.access as assignment_access
        from public.share_link_redemptions r
        join public.document_members dm
            on dm.document_id = r.document_id
           and dm.user_id = r.user_id
        left join public.assignments a
            on a.document_id = r.document_id
           and a.student_user_id = r.user_id
        where r.token = p_token
          and r.document_id = v_document
        for update of dm
    loop
        -- redeem_share_link never records a source for an owner row; this is
        -- the belt to that brace.
        if v_member.role = 'owner' then
            continue;
        end if;

        if v_member.assignment_access is not null then
            -- A roster student who also opened the link: the link's grant goes,
            -- the assignment's stays.
            update public.document_members
            set role = case when v_member.assignment_access = 'view' then 'viewer' else 'editor' end
            where document_id = v_document and user_id = v_member.user_id;

            delete from public.share_link_redemptions
            where document_id = v_document and user_id = v_member.user_id;
        else
            delete from public.document_members
            where document_id = v_document and user_id = v_member.user_id;

            perform public.forget_document_for_user (v_document, v_member.user_id);
        end if;

        v_withdrawn := v_withdrawn + 1;
    end loop;

    return v_withdrawn;
end;
$$;

revoke all on function public.revoke_share_link (text, boolean) from public;
revoke all on function public.revoke_share_link (text, boolean) from anon;
grant execute on function public.revoke_share_link (text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Tell open viewers when a membership changes
-- ---------------------------------------------------------------------------
-- Realtime authorizes a private channel when it is JOINED (realtime.messages
-- policies are evaluated then, not per message), so a member removed while the
-- score is open keeps receiving the channel until they leave it, and the
-- client is the one that has to notice. This event is how it notices; the
-- client then re-reads its own role over PostgREST, which IS checked per
-- request. The payload carries ids and the new role only -- nothing a member
-- of the score cannot already read from document_members.
create or replace function public.broadcast_membership_changes () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_row public.document_members;
begin
    if tg_op = 'UPDATE' then
        if old.role is not distinct from new.role then
            return null;
        end if;
        v_row := new;
    else
        v_row := old;
    end if;

    perform realtime.send(
        jsonb_build_object(
            'table', 'document_members',
            'document_id', v_row.document_id,
            'user_id', v_row.user_id,
            -- null: the membership is gone.
            'role', case when tg_op = 'DELETE' then null else v_row.role end
        ),
        'membership', -- event
        'doc:' || v_row.document_id::text, -- topic
        true -- private
    );
    return null;
end;
$$;

drop trigger if exists document_members_broadcast on public.document_members;
create trigger document_members_broadcast
after update or delete on public.document_members
for each row
execute function public.broadcast_membership_changes ();

-- Trigger-only: never callable via /rest/v1/rpc.
revoke all on function public.broadcast_membership_changes () from public;
revoke all on function public.broadcast_membership_changes () from anon;
revoke all on function public.broadcast_membership_changes () from authenticated;
