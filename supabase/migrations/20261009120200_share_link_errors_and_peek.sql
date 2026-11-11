-- Share-link answers a client can act on, and a way to check a link before
-- anybody is created to redeem it.
--
--  1. redeem_share_link raised 'invalid or expired share link' with SQLSTATE
--     P0002 (no_data_found). PostgREST maps every P0 code except P0001 to HTTP
--     500, so a dead link -- the most ordinary refusal there is -- reached the
--     browser, the logs and the error monitor as a server fault. It now raises
--     PT404: PostgREST turns an SQLSTATE of the form PTxyz into HTTP status xyz,
--     and 404 is what a link that does not (or no longer) exist is. The message
--     text is unchanged, so a client deployed before this migration (which
--     matches on it) keeps working; the current client matches the stable
--     code in `detail` instead (shareService.ts redeemShareLink). The rest of
--     the function is 20261007120000's, verbatim.
--
--  2. peek_share_link(token) answers "would this link let somebody in, and as
--     what?" -- {valid, role}, nothing else. The join page asks it BEFORE
--     signing a guest in: without it, every guest who opened a dead link
--     typed their name, got a brand-new anonymous auth user, and only then
--     heard the link was dead -- an orphan account per failed join.
--
--     It is callable by anon, on purpose: the person asking has no session
--     yet, and creating one is exactly what it exists to avoid. What that
--     exposes:
--       * Nothing about the score. A valid link answers its role; an unknown,
--         revoked and expired link all answer the same {false, null}, so the
--         answer cannot tell a revoked link from one that never existed.
--       * No new oracle. Anyone can already get an anonymous session and ask
--         redeem_share_link the same question about any token, at whatever
--         rate PostgREST serves; a token is 128 random bits (share_links'
--         default), so asking, by either door, finds nothing by guessing.
--       * Next to no cost. One primary-key probe, STABLE, no writes -- unlike
--         a per-caller counter, which would turn every anonymous read into a
--         write. A token longer than any share_links default can produce is
--         answered without touching the table at all.

-- ---------------------------------------------------------------------------
-- Redemption: 20261007120000's contract, with a 4xx for a dead link
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
        -- PT404 -> HTTP 404 (see the header). One answer for unknown, revoked
        -- and expired: a distinct one would tell a prober which tokens exist.
        raise exception 'invalid or expired share link'
            using errcode = 'PT404',
                  detail = json_build_object('code', 'invalid_share_link')::text;
    end if;

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

-- ---------------------------------------------------------------------------
-- Peek: would this link let somebody in? (anon-callable; see the header)
-- ---------------------------------------------------------------------------
-- Always exactly one row. `role` is null whenever `valid` is false.
create or replace function public.peek_share_link (p_token text) returns table (valid boolean, role text) language sql stable security definer
set search_path = public as $$
    select l.role is not null, l.role
    from (select 1) as one
    left join public.share_links l
        on length(p_token) between 1 and 64
       and l.token = p_token
       and l.revoked_at is null
       and (l.expires_at is null or l.expires_at > now());
$$;

-- Granted to anon deliberately -- the one share-link function that is: its
-- caller has no session yet. Revoked from PUBLIC first so the grant list is
-- exactly the two API roles.
revoke all on function public.peek_share_link (text) from public;
grant execute on function public.peek_share_link (text) to anon;
grant execute on function public.peek_share_link (text) to authenticated;
