-- Share v2 (#105): share_session_resolve's `expired` answer carries the date
-- the link stopped, so a signed-out visitor on /s reads "This link expired on
-- <date>". 20261113120100's function otherwise unchanged; every other dead
-- state still says only its state and link id.
--
-- Safe to run twice (create or replace).

create or replace function public.share_session_resolve (p_token text) returns jsonb language plpgsql stable security definer
set search_path = '' as $$
declare
    v_link public.share_links;
    v_state text;
begin
    if p_token is null or p_token !~ '^[A-Za-z0-9_-]{22}$' then
        return jsonb_build_object('state', 'invalid');
    end if;
    select * into v_link from public.share_links l where l.token = p_token;
    if v_link.id is null or not v_link.general then
        return jsonb_build_object('state', 'invalid');
    end if;
    v_state := public.share_link_state (v_link);
    if v_state = 'expired' then
        return jsonb_build_object('state', v_state, 'link_id', v_link.id, 'link_expires_at', v_link.expires_at);
    end if;
    if v_state <> 'live' then
        return jsonb_build_object('state', v_state, 'link_id', v_link.id);
    end if;
    return (
        select jsonb_build_object(
            'state', 'live',
            'role', v_link.role,
            'link_id', v_link.id,
            'doc', jsonb_build_object(
                'id', d.id,
                'title', d.title,
                'page_count', d.page_count,
                'content_rev', d.content_rev
            ),
            'pdf_path', d.storage_path,
            'link_expires_at', v_link.expires_at
        )
        from public.documents d
        where d.id = v_link.document_id
    );
end;
$$;

revoke all on function public.share_session_resolve (text) from public, anon, authenticated;
grant execute on function public.share_session_resolve (text) to service_role;
