-- Share v2, part 3 of 4: "Specific people" invites, and retention for links
-- and invites (#104, plan 6.5, D5 and D7).
--
-- The owner invites an email address as a viewer or an editor (share-invite):
--   * an existing account gets the membership at once, with a role lock so a
--     share link never changes what the owner chose;
--   * a new address gets a pending invite for 14 days. Only the sha256 of its
--     32-byte token is stored; the token itself is only in the email. Opening
--     /invite#<token> shows the invite (share-invite-accept peek), and
--     accepting it creates the account (age screen and password) and attaches
--     the membership in one step (D5).
-- A roster student's address is refused unless the inviter is their teacher,
-- who should use Assign instead (D7), when the invite is sent, resent and
-- accepted.
--
-- Every write goes through the service-role RPCs below, each starting with
-- share_assert_owner for the caller; the Edge Function checks ownership under
-- the caller's own JWT first (share_owner_ready).
--
-- Safe to run twice.

create table if not exists public.document_invites (
    id uuid primary key default gen_random_uuid (),
    document_id uuid not null references public.documents (id) on delete cascade,
    email text not null,
    role text not null,
    invited_by uuid not null references auth.users (id) on delete cascade,
    token_hash bytea not null unique,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '14 days',
    accepted_at timestamptz,
    accepted_by uuid references auth.users (id) on delete set null,
    revoked_at timestamptz,
    constraint document_invites_email_shape check (email = lower(btrim(email)) and length(email) between 3 and 320),
    constraint document_invites_role check (role in ('viewer', 'editor')),
    constraint document_invites_token_hash_length check (length(token_hash) = 32)
);

create unique index if not exists document_invites_one_pending on public.document_invites (document_id, email)
where
    accepted_at is null
    and revoked_at is null;

create index if not exists document_invites_document on public.document_invites (document_id);

alter table public.document_invites enable row level security;

drop policy if exists document_invites_owner_select on public.document_invites;
create policy document_invites_owner_select on public.document_invites for select to authenticated using (
    exists (
        select 1 from public.documents d
        where d.id = document_invites.document_id and d.owner_id = (select auth.uid ())
    )
);

-- The owner lists invites; nobody but the service role writes them, and the
-- token hash is not readable from a client.
revoke all on table public.document_invites from public, anon, authenticated;
grant select (id, document_id, email, role, invited_by, created_at, expires_at, accepted_at, accepted_by, revoked_at)
    on table public.document_invites to authenticated;
grant select, insert, update, delete on table public.document_invites to service_role;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.share_invite_state (p_invite public.document_invites) returns text language sql stable
set search_path = '' as $$
    select case
        when p_invite.id is null then 'invalid'
        when p_invite.accepted_at is not null then 'used'
        when p_invite.revoked_at is not null then 'cancelled'
        when p_invite.expires_at <= now() then 'expired'
        else 'pending'
    end;
$$;

revoke all on function public.share_invite_state (public.document_invites) from public, anon, authenticated;

create or replace function public.share_display_name (p_user uuid) returns text language sql stable security definer
set search_path = '' as $$
    select nullif(btrim(coalesce(u.raw_user_meta_data ->> 'display_name', '')), '')
    from auth.users u
    where u.id = p_user;
$$;

revoke all on function public.share_display_name (uuid) from public, anon, authenticated;

-- D7: p_email (or p_user's account) is a roster student of a teacher other
-- than p_inviter.
create or replace function public.share_invite_roster_refused (p_email text, p_inviter uuid, p_user uuid default null) returns boolean language sql stable security definer
set search_path = '' as $$
    select exists (
        select 1
        from public.managed_students ms
        left join auth.users su on su.id = ms.student_user_id
        where (lower(ms.student_email) = p_email or lower(su.email) = p_email or ms.student_user_id = p_user)
          and ms.teacher_id <> p_inviter
    );
$$;

revoke all on function public.share_invite_roster_refused (text, uuid, uuid) from public, anon, authenticated;

-- Give p_user the score as p_role, recorded as the owner's choice (a role
-- lock), as set_document_member_role does. An existing owner row is never
-- changed. The person now has the score by invite, not through a link: its
-- redemption goes, so Restricted no longer withdraws them, and a role the link
-- gave yields to p_role; any other editor is not lowered by a viewer invite.
-- A roster student's row is locked first, as redeem_share_link does.
create or replace function public.share_invite_grant (p_document uuid, p_user uuid, p_role text) returns void language plpgsql security definer
set search_path = public as $$
declare
    v_via_link boolean;
begin
    perform public.lock_student_for_grant (p_user);
    delete from public.share_link_redemptions r
    where r.document_id = p_document and r.user_id = p_user
    returning true into v_via_link;
    insert into public.document_members (document_id, user_id, role)
    values (p_document, p_user, p_role)
    on conflict (document_id, user_id) do update
        set role = case
            when public.document_members.role = 'owner' then 'owner'
            when public.document_members.role = 'editor' and v_via_link is null then 'editor'
            else excluded.role
        end;
    if not exists (
        select 1 from public.document_members dm
        where dm.document_id = p_document and dm.user_id = p_user and dm.role = 'owner'
    ) then
        insert into public.document_member_role_locks (document_id, user_id)
        values (p_document, p_user)
        on conflict do nothing;
    end if;
end;
$$;

revoke all on function public.share_invite_grant (uuid, uuid, text) from public, anon, authenticated;

-- The owner has just chosen p_user's access to p_document (invited the
-- account, set its role or removed it): a pending invite for the account's
-- address would undo that choice when accepted, so it is cancelled. Called
-- before the membership row is locked, the order share_invite_consume takes.
create or replace function public.share_invite_retire (p_document uuid, p_user uuid) returns void language sql security definer
set search_path = '' as $$
    update public.document_invites i
    set revoked_at = now()
    where i.document_id = p_document
      and i.accepted_at is null
      and i.revoked_at is null
      and i.email = (select lower(u.email) from auth.users u where u.id = p_user);
$$;

revoke all on function public.share_invite_retire (uuid, uuid) from public, anon, authenticated;

-- 20261007120000's set_document_member_role and remove_document_member, each
-- cancelling a pending invite for the member's address first.
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

    perform public.share_invite_retire (p_document, p_user);

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

    -- Recorded even when the role is unchanged: the owner looked at this
    -- member and chose this role, and a link opened later must not change it
    -- (see document_member_role_locks).
    insert into public.document_member_role_locks (document_id, user_id)
    values (p_document, p_user)
    on conflict (document_id, user_id) do update
        set locked_at = now();

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

    perform public.share_invite_retire (p_document, p_user);

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
-- The owner's check, under the caller's JWT
-- ---------------------------------------------------------------------------
create or replace function public.share_owner_ready (p_document uuid) returns boolean language plpgsql stable security definer
set search_path = '' as $$
begin
    perform public.share_assert_owner (p_document, auth.uid ());
    return true;
end;
$$;

revoke all on function public.share_owner_ready (uuid) from public, anon;
grant execute on function public.share_owner_ready (uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The service-role RPCs behind share-invite and share-invite-accept
-- ---------------------------------------------------------------------------
-- Invite p_email to p_document. Answers one of:
--   {kind:'roster_refused'}                  a roster student of another teacher (D7)
--   {kind:'member', title, inviter_name}     an existing account, now a member
--   {kind:'invite', invite_id, title, inviter_name}   a pending invite (re-inviting
--                                            the same address reissues its token)
create or replace function public.share_invite_create (
    p_caller uuid,
    p_document uuid,
    p_email text,
    p_role text,
    p_token_hash bytea
) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_email text := lower(btrim(coalesce(p_email, '')));
    v_user uuid;
    v_anonymous boolean;
    v_invite uuid;
    v_title text;
begin
    perform public.share_assert_owner (p_document, p_caller);
    if p_role is null or p_role not in ('viewer', 'editor') then
        raise exception 'an invite role is viewer or editor'
            using errcode = '22023', detail = json_build_object('code', 'invalid_role')::text;
    end if;
    if length(v_email) not between 3 and 320 or position('@' in v_email) = 0 then
        raise exception 'not an email address'
            using errcode = '22023', detail = json_build_object('code', 'invalid_email')::text;
    end if;

    if public.share_invite_roster_refused (v_email, p_caller) then
        return jsonb_build_object('kind', 'roster_refused');
    end if;

    select d.title into v_title from public.documents d where d.id = p_document;

    select u.id, u.is_anonymous into v_user, v_anonymous
    from auth.users u
    where lower(u.email) = v_email and u.deleted_at is null
    limit 1;

    if v_user is not null and not v_anonymous then
        if v_user <> p_caller then
            perform public.share_invite_retire (p_document, v_user);
            perform public.share_invite_grant (p_document, v_user, p_role);
        end if;
        return jsonb_build_object(
            'kind', 'member',
            'title', v_title,
            'inviter_name', public.share_display_name (p_caller)
        );
    end if;

    insert into public.document_invites as i (document_id, email, role, invited_by, token_hash)
    values (p_document, v_email, p_role, p_caller, p_token_hash)
    on conflict (document_id, email) where accepted_at is null and revoked_at is null do update
        set role = excluded.role,
            invited_by = excluded.invited_by,
            token_hash = excluded.token_hash,
            created_at = now(),
            expires_at = now() + interval '14 days'
    returning i.id into v_invite;

    return jsonb_build_object(
        'kind', 'invite',
        'invite_id', v_invite,
        'title', v_title,
        'inviter_name', public.share_display_name (p_caller)
    );
end;
$$;

revoke all on function public.share_invite_create (uuid, uuid, text, text, bytea) from public, anon, authenticated;
grant execute on function public.share_invite_create (uuid, uuid, text, text, bytea) to service_role;

-- Resend: a new token for a pending (or lapsed, never used or cancelled)
-- invite, good for another 14 days. Null when there is nothing to resend;
-- {kind:'roster_refused'}, the token unchanged, when the address has since
-- become another teacher's roster student (D7).
create or replace function public.share_invite_reissue (p_caller uuid, p_invite uuid, p_token_hash bytea) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_invite public.document_invites;
begin
    select * into v_invite from public.document_invites i where i.id = p_invite for update;
    if v_invite.id is null then
        return null;
    end if;
    perform public.share_assert_owner (v_invite.document_id, p_caller);
    if v_invite.accepted_at is not null or v_invite.revoked_at is not null then
        return null;
    end if;
    if public.share_invite_roster_refused (v_invite.email, p_caller) then
        return jsonb_build_object('kind', 'roster_refused');
    end if;

    update public.document_invites i
    set token_hash = p_token_hash, expires_at = now() + interval '14 days'
    where i.id = p_invite;

    return jsonb_build_object(
        'kind', 'invite',
        'invite_id', v_invite.id,
        'email', v_invite.email,
        'role', v_invite.role,
        'title', (select d.title from public.documents d where d.id = v_invite.document_id),
        'inviter_name', public.share_display_name (p_caller)
    );
end;
$$;

revoke all on function public.share_invite_reissue (uuid, uuid, bytea) from public, anon, authenticated;
grant execute on function public.share_invite_reissue (uuid, uuid, bytea) to service_role;

-- Cancel: the invite's token stops working. True when it was pending.
create or replace function public.share_invite_cancel (p_caller uuid, p_invite uuid) returns boolean language plpgsql security definer
set search_path = public as $$
declare
    v_invite public.document_invites;
begin
    select * into v_invite from public.document_invites i where i.id = p_invite for update;
    if v_invite.id is null then
        return false;
    end if;
    perform public.share_assert_owner (v_invite.document_id, p_caller);
    if v_invite.accepted_at is not null or v_invite.revoked_at is not null then
        return false;
    end if;
    update public.document_invites i set revoked_at = now() where i.id = p_invite;
    return true;
end;
$$;

revoke all on function public.share_invite_cancel (uuid, uuid) from public, anon, authenticated;
grant execute on function public.share_invite_cancel (uuid, uuid) to service_role;

-- What /invite shows: the invite's state, and for a pending one the score's
-- title, who invited, the role and the address (the Edge Function masks it).
create or replace function public.share_invite_peek (p_token_hash bytea) returns jsonb language sql stable security definer
set search_path = '' as $$
    select case
        when public.share_invite_state (i) <> 'pending' then
            jsonb_build_object('state', public.share_invite_state (i))
        else jsonb_build_object(
            'state', 'pending',
            'title', (select d.title from public.documents d where d.id = i.document_id),
            'inviter_name', public.share_display_name (i.invited_by),
            'role', i.role,
            'email', i.email
        )
    end
    from (select 1) as one
    left join public.document_invites i on i.token_hash = p_token_hash;
$$;

revoke all on function public.share_invite_peek (bytea) from public, anon, authenticated;
grant execute on function public.share_invite_peek (bytea) to service_role;

-- Accept: p_user, whose address must be the invite's, gets the score. Answers
-- {ok:true, document_id} or {ok:false, state} (state 'email_mismatch' for
-- another account, 'roster_refused' for another teacher's roster student, D7,
-- asked with their roster row locked). A pending invite is used once.
create or replace function public.share_invite_consume (p_token_hash bytea, p_user uuid) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_invite public.document_invites;
    v_state text;
begin
    select * into v_invite from public.document_invites i where i.token_hash = p_token_hash for update;
    v_state := public.share_invite_state (v_invite);
    if v_state <> 'pending' then
        return jsonb_build_object('ok', false, 'state', v_state);
    end if;
    if not exists (
        select 1 from auth.users u
        where u.id = p_user and lower(u.email) = v_invite.email and not u.is_anonymous
    ) then
        return jsonb_build_object('ok', false, 'state', 'email_mismatch');
    end if;
    perform public.lock_student_for_grant (p_user);
    if public.share_invite_roster_refused (v_invite.email, v_invite.invited_by, p_user) then
        return jsonb_build_object('ok', false, 'state', 'roster_refused');
    end if;

    perform public.share_invite_grant (v_invite.document_id, p_user, v_invite.role);
    update public.document_invites i
    set accepted_at = now(), accepted_by = p_user
    where i.id = v_invite.id;
    return jsonb_build_object('ok', true, 'document_id', v_invite.document_id);
end;
$$;

revoke all on function public.share_invite_consume (bytea, uuid) from public, anon, authenticated;
grant execute on function public.share_invite_consume (bytea, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
-- Links revoked or expired more than 30 days ago (their redemptions cascade;
-- the members they made keep the score as ordinary members).
create or replace function public.retention_purge_share_links (p_batch integer default 5000) returns integer language plpgsql security definer
set search_path = '' as $$
declare
    v_deleted integer;
begin
    with doomed as (
        select l.token
        from public.share_links l
        where l.revoked_at < now() - interval '30 days'
           or l.expires_at < now() - interval '30 days'
        limit greatest(p_batch, 0)
    )
    delete from public.share_links l
    using doomed
    where l.token = doomed.token;
    get diagnostics v_deleted = row_count;
    return v_deleted;
end;
$$;

revoke all on function public.retention_purge_share_links (integer) from public, anon, authenticated;
grant execute on function public.retention_purge_share_links (integer) to service_role;

-- Invites 30 days after they were accepted, cancelled or expired.
create or replace function public.retention_purge_share_invites (p_batch integer default 5000) returns integer language plpgsql security definer
set search_path = '' as $$
declare
    v_deleted integer;
begin
    with doomed as (
        select i.id
        from public.document_invites i
        where coalesce(i.accepted_at, i.revoked_at, i.expires_at) < now() - interval '30 days'
        limit greatest(p_batch, 0)
    )
    delete from public.document_invites i
    using doomed
    where i.id = doomed.id;
    get diagnostics v_deleted = row_count;
    return v_deleted;
end;
$$;

revoke all on function public.retention_purge_share_invites (integer) from public, anon, authenticated;
grant execute on function public.retention_purge_share_invites (integer) to service_role;

do $$
begin
    perform cron.unschedule (jobid) from cron.job where jobname in ('retention-share-links', 'retention-share-invites');
exception
    when undefined_table then null;
end;
$$;

select cron.schedule ('retention-share-links', '53 3 * * *', $$select public.retention_purge_share_links ()$$);
select cron.schedule ('retention-share-invites', '3 4 * * *', $$select public.retention_purge_share_invites ()$$);
