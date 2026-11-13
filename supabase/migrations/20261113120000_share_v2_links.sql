-- Share v2, part 1 of 4: one "General access" link per score (#104, plan 6.1,
-- 6.6 and D15).
--
-- A score gets at most one live general link, created and changed only through
-- the owner RPCs below, so every change that ends or narrows it also rotates
-- the score's realtime generation (20261022120000) and withdraws or demotes the
-- members who joined through it. Links made before this (general = false) stay
-- as they are: owners copy and revoke them, and /join keeps working (D2).
--
-- The rules each have one owner here, and everything else calls it:
--   share_link_state       live | revoked | expired | unavailable | invalid
--   share_assert_owner     who may share a score (D6)
--   share_link_expiry      1 hour to 365 days, or never; 7 days by default (D15)
--
-- Inert until the Share v2 UI calls the RPCs: today's client keeps inserting
-- legacy links directly, and the expiry choices it offers (7 d, 30 d, never)
-- are all inside the new bounds.
--
-- Safe to run twice (CI re-applies every migration from 20261022100000 on).

-- ---------------------------------------------------------------------------
-- 6.6: PR #98's view links never reached dev. If a database has them, drop
-- them; on every other database each step is a no-op.
-- ---------------------------------------------------------------------------
do $$
begin
    perform cron.unschedule (jobid) from cron.job where jobname = 'retention-view-links';
exception
    when undefined_table then null;
end;
$$;

drop table if exists public.view_links cascade;

do $$
declare
    v_fn regprocedure;
begin
    for v_fn in
        select p.oid::regprocedure
        from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and (
              p.proname like 'view\_link\_%'
              or p.proname like '%\_view\_link'
              or p.proname in ('view_mark_for_viewer', 'view_links_retention_purge')
          )
    loop
        execute format('drop function if exists %s', v_fn);
    end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- share_links: an id, the general flag, and a 7-day default
-- ---------------------------------------------------------------------------
alter table public.share_links add column if not exists id uuid not null default gen_random_uuid ();
alter table public.share_links add column if not exists general boolean not null default false;
alter table public.share_links add column if not exists updated_at timestamptz;
alter table public.share_links alter column expires_at set default now() + interval '7 days';

create unique index if not exists share_links_id_key on public.share_links (id);

create unique index if not exists share_links_one_general on public.share_links (document_id)
where
    general
    and revoked_at is null;

-- 20261007120100's guard, plus the two new columns. A client never sets id or
-- general, and never updates a general link: those changes go through the
-- RPCs below, which rotate and withdraw as they must.
create or replace function public.share_links_guard_columns () returns trigger language plpgsql
set search_path = public as $$
declare
    v_col text;
begin
    if current_user not in ('authenticated', 'anon') then
        if tg_op = 'UPDATE' then
            new.updated_at := now();
        end if;
        return new;
    end if;

    if tg_op = 'INSERT' then
        if new.general then
            raise exception 'a general link is made with set_general_access' using errcode = '42501';
        end if;
        new.token := rtrim(
            replace(replace(encode(extensions.gen_random_bytes(16), 'base64'), '+', '-'), '/', '_'),
            '='
        );
        new.id := gen_random_uuid ();
        new.created_at := now();
        new.updated_at := null;
        return new;
    end if;

    if old.general then
        raise exception 'a general link changes only through the sharing RPCs' using errcode = '42501';
    end if;

    if new.token is distinct from old.token then
        v_col := 'token';
    elsif new.document_id is distinct from old.document_id then
        v_col := 'document_id';
    elsif new.created_by is distinct from old.created_by then
        v_col := 'created_by';
    elsif new.created_at is distinct from old.created_at then
        v_col := 'created_at';
    elsif new.id is distinct from old.id then
        v_col := 'id';
    elsif new.general is distinct from old.general then
        v_col := 'general';
    end if;

    if v_col is not null then
        raise exception 'share_links.% cannot be changed', v_col using errcode = '42501';
    end if;
    new.updated_at := now();
    return new;
end;
$$;

-- Deleting a general link would skip the same rotation and withdrawal.
create or replace function public.share_links_guard_general_delete () returns trigger language plpgsql
set search_path = '' as $$
begin
    if old.general and current_user in ('authenticated', 'anon') then
        raise exception 'a general link changes only through the sharing RPCs' using errcode = '42501';
    end if;
    return old;
end;
$$;

revoke all on function public.share_links_guard_general_delete () from public, anon, authenticated;

drop trigger if exists share_links_guard_general_delete on public.share_links;
create trigger share_links_guard_general_delete
before delete on public.share_links
for each row
execute function public.share_links_guard_general_delete ();

-- ---------------------------------------------------------------------------
-- D15: link expiry bounds
-- ---------------------------------------------------------------------------
-- When a link that expires should expire, for an owner's choice: null (never),
-- or 1 hour to 365 days from now. Anything else is refused with a code the UI
-- can show. Note PostgreSQL compares a month as 30 days, so pass '365 days'
-- for a year rather than '1 year' (which compares as 360 days).
create or replace function public.share_link_expiry (p_expires_in interval) returns timestamptz language plpgsql stable
set search_path = '' as $$
begin
    if p_expires_in is null then
        return null;
    end if;
    if p_expires_in < interval '1 hour' or p_expires_in > interval '365 days' then
        raise exception 'a link expires between 1 hour and 365 days from now, or never'
            using errcode = '22023',
                  detail = json_build_object('code', 'invalid_link_expiry')::text;
    end if;
    return now() + p_expires_in;
end;
$$;

revoke all on function public.share_link_expiry (interval) from public, anon, authenticated;

-- The same bounds on the links a client still inserts and updates directly,
-- with five minutes of slack for the client's clock.
create or replace function public.share_links_expiry_bounds () returns trigger language plpgsql
set search_path = '' as $$
begin
    if current_user not in ('authenticated', 'anon') or new.expires_at is null then
        return new;
    end if;
    if tg_op = 'UPDATE' and new.expires_at is not distinct from old.expires_at then
        return new;
    end if;
    if new.expires_at < now() + interval '55 minutes'
       or new.expires_at > now() + interval '365 days 5 minutes' then
        raise exception 'a link expires between 1 hour and 365 days from now, or never'
            using errcode = '22023',
                  detail = json_build_object('code', 'invalid_link_expiry')::text;
    end if;
    return new;
end;
$$;

revoke all on function public.share_links_expiry_bounds () from public, anon, authenticated;

drop trigger if exists share_links_expiry_bounds on public.share_links;
create trigger share_links_expiry_bounds
before insert or update of expires_at on public.share_links
for each row
execute function public.share_links_expiry_bounds ();

-- ---------------------------------------------------------------------------
-- Link state
-- ---------------------------------------------------------------------------
-- Whether a score may be shown through a link at all: it exists, is not
-- archived, and has no live takedown of either kind (PR #98's
-- view_link_document_live, by maxharris1).
create or replace function public.link_view_document_live (p_document uuid) returns boolean language sql stable security definer
set search_path = '' as $$
    select exists (
        select 1
        from public.documents d
        where d.id = p_document
          and d.archived_at is null
          and not exists (
              select 1
              from public.content_takedowns ct
              where ct.document_id = d.id
                and ct.lifted_at is null
          )
    );
$$;

revoke all on function public.link_view_document_live (uuid) from public, anon, authenticated;

-- The one answer to "is this link live, and if not, why". Order matters: a
-- revoked link reads revoked even after it would also have expired.
create or replace function public.share_link_state (p_link public.share_links) returns text language sql stable security definer
set search_path = '' as $$
    select case
        when p_link.token is null then 'invalid'
        when p_link.revoked_at is not null then 'revoked'
        when p_link.expires_at is not null and p_link.expires_at <= now() then 'expired'
        when not public.link_view_document_live (p_link.document_id) then 'unavailable'
        else 'live'
    end;
$$;

revoke all on function public.share_link_state (public.share_links) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Who may share (D6)
-- ---------------------------------------------------------------------------
-- The score's owner, signed in, not a guest, not a roster student, not on a
-- read-only seat, and the score live. One message for every refusal, so it
-- does not say which test failed. Takes the user so the service-role invite
-- RPCs can ask on a caller's behalf (PR #98's view_link_assert_owner).
create or replace function public.share_assert_owner (p_document uuid, p_uid uuid) returns void language plpgsql stable security definer
set search_path = '' as $$
begin
    if p_uid is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;
    if exists (select 1 from auth.users u where u.id = p_uid and u.is_anonymous)
       or exists (select 1 from public.managed_students ms where ms.student_user_id = p_uid)
       or not exists (select 1 from public.documents d where d.id = p_document and d.owner_id = p_uid)
       or public.seat_read_only (p_uid)
       or not public.link_view_document_live (p_document) then
        raise exception 'only the owner of a live score can share it' using errcode = '42501';
    end if;
end;
$$;

revoke all on function public.share_assert_owner (uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- What a link did for the people who joined through it
-- ---------------------------------------------------------------------------
-- 20261007120000 revoke_share_link's loop, unchanged: everyone the link let in
-- loses the score, except a roster student, who falls back to their
-- assignment's access. Deleting a member queues the score's rotation.
create or replace function public.share_link_withdraw_members (p_document uuid, p_token text) returns integer language plpgsql security definer
set search_path = public as $$
declare
    v_member record;
    v_withdrawn int := 0;
begin
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
          and r.document_id = p_document
        for update of dm
    loop
        if v_member.role = 'owner' then
            continue;
        end if;

        if v_member.assignment_access is not null then
            update public.document_members
            set role = case when v_member.assignment_access = 'view' then 'viewer' else 'editor' end
            where document_id = p_document and user_id = v_member.user_id;

            delete from public.share_link_redemptions
            where document_id = p_document and user_id = v_member.user_id;
        else
            delete from public.document_members
            where document_id = p_document and user_id = v_member.user_id;

            perform public.forget_document_for_user (p_document, v_member.user_id);
        end if;

        v_withdrawn := v_withdrawn + 1;
    end loop;

    return v_withdrawn;
end;
$$;

revoke all on function public.share_link_withdraw_members (uuid, text) from public, anon, authenticated;

-- An editor link turned viewer: the editors it made become viewers. A role the
-- owner set by hand (a role lock) stays; a roster student falls back to their
-- assignment's access, as in the withdraw loop. A demotion queues the rotation.
create or replace function public.share_link_demote_members (p_document uuid, p_token text) returns integer language plpgsql security definer
set search_path = public as $$
declare
    v_member record;
    v_demoted int := 0;
begin
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
          and r.document_id = p_document
          and dm.role = 'editor'
          and not exists (
              select 1 from public.document_member_role_locks l
              where l.document_id = r.document_id and l.user_id = r.user_id
          )
        for update of dm
    loop
        if v_member.assignment_access is not null then
            update public.document_members
            set role = case when v_member.assignment_access = 'view' then 'viewer' else 'editor' end
            where document_id = p_document and user_id = v_member.user_id;

            delete from public.share_link_redemptions
            where document_id = p_document and user_id = v_member.user_id;
        else
            update public.document_members
            set role = 'viewer'
            where document_id = p_document and user_id = v_member.user_id;
        end if;

        v_demoted := v_demoted + 1;
    end loop;

    return v_demoted;
end;
$$;

revoke all on function public.share_link_demote_members (uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The owner RPCs
-- ---------------------------------------------------------------------------
-- One general-link change per score at a time, so two at once cannot both
-- create a link or both decide what to withdraw.
create or replace function public.share_lock_general (p_document uuid) returns void language sql volatile
set search_path = '' as $$
    select pg_advisory_xact_lock (hashtextextended ('share_links_general:' || p_document::text, 0));
$$;

revoke all on function public.share_lock_general (uuid) from public, anon, authenticated;

-- "General access" for a score. 'restricted' revokes the general link,
-- withdraws everyone it let in and rotates. 'anyone' creates the link, or
-- updates its role and expiry: editor to viewer demotes the link's editors and
-- rotates; viewer to editor rotates too, so signed-out viewers on the link
-- stop hearing the score at once. A changed expiry alone moves nothing.
-- p_expires_in null means never.
create or replace function public.set_general_access (
    p_document uuid,
    p_mode text,
    p_role text default 'viewer',
    p_expires_in interval default interval '7 days'
) returns table (link_id uuid, token text, role text, expires_at timestamptz) language plpgsql security definer
set search_path = public as $$
#variable_conflict use_column
declare
    v_uid uuid := auth.uid();
    v_link public.share_links;
    v_expires timestamptz;
begin
    perform public.share_assert_owner (p_document, v_uid);
    if p_mode is null or p_mode not in ('restricted', 'anyone') then
        raise exception 'general access is restricted or anyone'
            using errcode = '22023', detail = json_build_object('code', 'invalid_mode')::text;
    end if;

    perform public.share_lock_general (p_document);
    select * into v_link
    from public.share_links sl
    where sl.document_id = p_document and sl.general and sl.revoked_at is null
    for update;

    if p_mode = 'restricted' then
        if v_link.id is not null then
            update public.share_links sl set revoked_at = now() where sl.id = v_link.id;
            perform public.share_link_withdraw_members (p_document, v_link.token);
            perform public.queue_document_realtime_rotation (p_document);
        end if;
        return;
    end if;

    if p_role is null or p_role not in ('viewer', 'editor') then
        raise exception 'a link role is viewer or editor'
            using errcode = '22023', detail = json_build_object('code', 'invalid_role')::text;
    end if;
    v_expires := public.share_link_expiry (p_expires_in);

    if v_link.id is null then
        insert into public.share_links as sl (document_id, role, created_by, expires_at, general)
        values (p_document, p_role, v_uid, v_expires, true)
        returning sl.* into v_link;
    else
        update public.share_links sl
        set role = p_role, expires_at = v_expires
        where sl.id = v_link.id;

        if v_link.role = 'editor' and p_role = 'viewer' then
            perform public.share_link_demote_members (p_document, v_link.token);
            perform public.queue_document_realtime_rotation (p_document);
        elsif v_link.role = 'viewer' and p_role = 'editor' then
            perform public.queue_document_realtime_rotation (p_document);
        end if;
    end if;

    return query select v_link.id, v_link.token, p_role, v_expires;
end;
$$;

revoke all on function public.set_general_access (uuid, text, text, interval) from public, anon;
grant execute on function public.set_general_access (uuid, text, text, interval) to authenticated;

-- A new address for the general link: the old token stops working, the people
-- who joined through it keep the score (now recorded against the new link),
-- and everyone on the score's realtime moves, so a signed-out viewer holding
-- the old link is cut off. Same role; same expiry, or 7 days if it had lapsed.
create or replace function public.reset_general_link (p_document uuid) returns table (
    link_id uuid,
    token text,
    role text,
    expires_at timestamptz
) language plpgsql security definer
set search_path = public as $$
#variable_conflict use_column
declare
    v_uid uuid := auth.uid();
    v_old public.share_links;
    v_new public.share_links;
begin
    perform public.share_assert_owner (p_document, v_uid);
    perform public.share_lock_general (p_document);

    select * into v_old
    from public.share_links sl
    where sl.document_id = p_document and sl.general and sl.revoked_at is null
    for update;
    if v_old.id is null then
        raise exception 'this score has no general link to reset'
            using errcode = 'P0002', detail = json_build_object('code', 'no_general_link')::text;
    end if;

    update public.share_links sl set revoked_at = now() where sl.id = v_old.id;

    insert into public.share_links as sl (document_id, role, created_by, expires_at, general)
    values (
        p_document,
        v_old.role,
        v_uid,
        case
            when v_old.expires_at is null or v_old.expires_at > now() then v_old.expires_at
            else public.share_link_expiry (interval '7 days')
        end,
        true
    )
    returning sl.* into v_new;

    update public.share_link_redemptions r
    set token = v_new.token
    where r.document_id = p_document and r.token = v_old.token;

    perform public.queue_document_realtime_rotation (p_document);
    return query select v_new.id, v_new.token, v_new.role, v_new.expires_at;
end;
$$;

revoke all on function public.reset_general_link (uuid) from public, anon;
grant execute on function public.reset_general_link (uuid) to authenticated;

-- A new expiry for a link, general or older: an expired link becomes live
-- again. A revoked one stays revoked. Renewing only widens access, so nothing
-- rotates. p_expires_in null means never.
create or replace function public.renew_share_link (p_link uuid, p_expires_in interval default interval '7 days') returns timestamptz language plpgsql security definer
set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    v_link public.share_links;
    v_expires timestamptz;
begin
    if v_uid is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;
    select * into v_link from public.share_links sl where sl.id = p_link;
    if v_link.id is null then
        raise exception 'only the owner of a live score can share it' using errcode = '42501';
    end if;
    perform public.share_assert_owner (v_link.document_id, v_uid);
    perform public.share_lock_general (v_link.document_id);

    select * into v_link from public.share_links sl where sl.id = p_link for update;
    if v_link.revoked_at is not null then
        raise exception 'a revoked link cannot be renewed'
            using errcode = '22023', detail = json_build_object('code', 'link_revoked')::text;
    end if;
    v_expires := public.share_link_expiry (p_expires_in);

    update public.share_links sl set expires_at = v_expires where sl.id = p_link;
    return v_expires;
end;
$$;

revoke all on function public.renew_share_link (uuid, interval) from public, anon;
grant execute on function public.renew_share_link (uuid, interval) to authenticated;

-- 20261007120000's revoke, same signature and the same answer for "no such
-- link" and "not your link". An older link behaves exactly as before. A
-- general link always takes its members with it, needs share_assert_owner,
-- and its first revoke rotates the score (a repeat changes nothing).
create or replace function public.revoke_share_link (p_token text, p_remove_members boolean default false) returns integer language plpgsql security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
    v_link public.share_links;
begin
    if v_caller is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    select * into v_link
    from public.share_links sl
    where sl.token = p_token
    for update;

    if v_link.document_id is null or public.document_role (v_link.document_id) is distinct from 'owner' then
        raise exception 'only the score owner can revoke its links' using errcode = '42501';
    end if;

    if v_link.general then
        perform public.share_assert_owner (v_link.document_id, v_caller);
        if v_link.revoked_at is null then
            update public.share_links sl set revoked_at = now() where sl.id = v_link.id;
            perform public.queue_document_realtime_rotation (v_link.document_id);
        end if;
        return public.share_link_withdraw_members (v_link.document_id, p_token);
    end if;

    update public.share_links
    set revoked_at = coalesce(revoked_at, now())
    where token = p_token;

    if not coalesce(p_remove_members, false) then
        return 0;
    end if;
    return public.share_link_withdraw_members (v_link.document_id, p_token);
end;
$$;

revoke all on function public.revoke_share_link (text, boolean) from public, anon;
grant execute on function public.revoke_share_link (text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- peek and redeem
-- ---------------------------------------------------------------------------
-- 20261009120200's peek plus a state. `valid` keeps exactly its old meaning
-- (not revoked, not expired), so today's callers read the same answer.
drop function if exists public.peek_share_link (text);

create or replace function public.peek_share_link (p_token text) returns table (valid boolean, role text, state text) language sql stable security definer
set search_path = public as $$
    select
        l.token is not null and l.revoked_at is null and (l.expires_at is null or l.expires_at > now()),
        case when l.revoked_at is null and (l.expires_at is null or l.expires_at > now()) then l.role end,
        public.share_link_state (l)
    from (select 1) as one
    left join public.share_links l
        on length(p_token) between 1 and 64
       and l.token = p_token;
$$;

revoke all on function public.peek_share_link (text) from public;
grant execute on function public.peek_share_link (text) to anon;
grant execute on function public.peek_share_link (text) to authenticated;

-- 20261022120200's redeem, unchanged but for the refusal's detail, which now
-- carries the link's state beside the code the client matches on.
create or replace function public.redeem_share_link (p_token text) returns table (document_id uuid, granted_role text) language plpgsql security definer
set search_path = public as $$
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
        raise exception 'invalid or expired share link'
            using errcode = 'PT404',
                  detail = json_build_object(
                      'code', 'invalid_share_link',
                      'state', coalesce((select public.share_link_state (sl) from public.share_links sl where sl.token = p_token), 'invalid')
                  )::text;
    end if;

    perform public.lock_student_for_grant (v_uid);

    select dm.role into v_prev_role
    from public.document_members dm
    where dm.document_id = link.document_id and dm.user_id = v_uid
    for update;

    if v_prev_role is not null and exists (
        select 1 from public.document_member_role_locks l
        where l.document_id = link.document_id and l.user_id = v_uid
    ) then
        return query select link.document_id, v_prev_role;
        return;
    end if;

    insert into public.document_members (document_id, user_id, role)
    values (link.document_id, v_uid, link.role)
    on conflict (document_id, user_id) do update
        set role = case
            when public.document_members.role = 'owner' then 'owner'
            when public.document_members.role = 'editor' then 'editor'
            else excluded.role
        end
    returning role into v_new_role;

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
