-- An archived score's realtime comes back on restore; share redemption locks
-- in the district hard delete's order (Codex round 2 on #71, launchfix P4 fix
-- round 2, decision 55).
--
--  1. Archiving is a temporary denial, not a lost membership.
--     20261022120100 made realtime_topic_epoch answer null for an archived
--     score, the answer a removed member gets, so an open viewer stopped its
--     channels for good: after the restore it heard no committed marks, live
--     ink or presence until the score was opened again. The app now asks
--     realtime_topic_access, which tells the two apart with a reason:
--       - null: document_role() says no (not a member, removed, taken down,
--         a revoked student's token, the score gone). Permanent: the app
--         stops.
--       - {"status":"archived"}: still a member, but the score is archived and
--         the realtime.messages policies refuse every join on it. The app
--         stays off both topics and asks again every 15-45 s (jittered), and
--         joins the score's current generation as soon as it is restored.
--       - {"status":"open","epoch":n}: join generation n.
--     Only a member is told "archived": anyone document_role() refuses gets
--     null, archived or not, so nobody learns more than before about a score
--     they cannot open. The policies are unchanged (no join, send or
--     presence on an archived score, 20261022120100), and so is
--     realtime_topic_epoch, which a build from before this migration still
--     reads. Restoring still rotates nothing: the members who were waiting
--     join the current generation, and the join's gap-fill pull brings what
--     was committed meanwhile.
--
--  2. redeem_share_link took the membership row, then the roster row. Its
--     SELECT ... FOR UPDATE of an existing membership came first, and the
--     document_members_lock_student trigger (20261022120100) took the
--     student's roster row FOR SHARE only at its insert. The district hard
--     delete (retention_district_run, 20261021120700) does the reverse: the
--     roster row FOR UPDATE, then deleting the auth user, which cascades to
--     the memberships. A redemption between the two could hold the membership
--     and wait on the roster row while the hard delete held the roster row
--     and waited on the membership: PostgreSQL aborted one. Now the
--     redemption takes the roster row first (lock_student_for_grant, a no-op
--     for an account without one), then the membership: the same order as
--     the hard delete, and as assign_score (whose assignment trigger locks the
--     roster row before its membership insert). Nothing else locks a
--     membership row and then inserts one: set_document_member_role and
--     remove_document_member lock a membership but insert none, so the
--     trigger never fires under them.
--
-- tests/sql/realtime_revocation_rotation.sql (archive, then restore, read
-- through realtime_topic_access) and tests/sql/realtime_revocation_race.sql
-- (H1/H2: a redemption and the district hard delete in both orders, two
-- dblink sessions) prove it against a database;
-- tests/realtimeRevocationRotation.test.ts keeps the pieces from drifting.

-- ---------------------------------------------------------------------------
-- 1. The realtime answer, with the reason
-- ---------------------------------------------------------------------------
create or replace function public.realtime_topic_access (p_document uuid) returns jsonb language sql stable security definer
set search_path = public as $$
    select case
        when public.document_role (p_document) is null then null
        when public.document_is_archived (p_document) then jsonb_build_object('status', 'archived')
        else jsonb_build_object('status', 'open', 'epoch', public.document_realtime_epoch (p_document))
    end;
$$;

revoke all on function public.realtime_topic_access (uuid) from public;
revoke all on function public.realtime_topic_access (uuid) from anon;
grant execute on function public.realtime_topic_access (uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Share redemption: the roster row, then the membership
-- ---------------------------------------------------------------------------
-- 20261009120200's redemption, with the roster lock moved to the front.
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
        -- PT404 -> HTTP 404 (see the header). One answer for unknown, revoked
        -- and expired: a distinct one would tell a prober which tokens exist.
        raise exception 'invalid or expired share link'
            using errcode = 'PT404',
                  detail = json_build_object('code', 'invalid_share_link')::text;
    end if;

    -- A roster student's row before their membership (20261022120200): the
    -- order the district hard delete takes them in. The insert's trigger
    -- takes it again, already held.
    perform public.lock_student_for_grant (v_uid);

    select dm.role into v_prev_role
    from public.document_members dm
    where dm.document_id = link.document_id and dm.user_id = v_uid
    for update;

    -- The owner set this member's role by hand (set_document_member_role):
    -- the link opens the score for them, and changes nothing else -- not the
    -- role, and not where their access is recorded as coming from.
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
