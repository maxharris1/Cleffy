-- The library stops listing an archived or reset student's scores at once.
--
-- 20261010120300 made document_role() refuse a student whose access was
-- withdrawn, which closes every policy, storage rule and realtime topic check
-- built on it. library_documents() is SECURITY DEFINER and assembles the
-- visible set from document_members directly (see 20261007120400 for why), so
-- the leftover access token of an archived or reset student could still list
-- the titles and metadata of their assigned scores for up to an hour, though
-- opening one was refused. library_bootstrap() takes its first page from
-- library_documents(), so this one change covers both.
--
-- Same function as 20261007120400 otherwise. The owner branch is untouched:
-- roster students do not own scores, and documents_select keeps owner_id too.
--
-- Residual, not fixable here: a realtime channel the student had ALREADY
-- joined stays authorized until the socket's JWT expires, because Realtime
-- checks realtime.messages policies when a channel is joined, not per message.
-- The membership hint end_student_sessions() sends makes the app leave the
-- score at once; only a tampered client that ignores it keeps receiving that
-- score's broadcasts, for at most the token's remaining lifetime.

create or replace function public.library_documents (
    p_sort text default 'recent',
    p_after_updated_at timestamptz default null,
    p_after_title text default null,
    p_after_id uuid default null,
    p_query text default null,
    p_tag_id uuid default null,
    p_favorites_only boolean default false,
    p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_uid uuid := (select auth.uid());
    v_sort text := coalesce(p_sort, 'recent');
    v_limit int := least(greatest(coalesce(p_limit, 100), 1), 200);
    v_query text := nullif(btrim(coalesce(p_query, '')), '');
    v_pattern text;
    v_rows jsonb;
    v_count int;
    -- Once per call, not per row: about the caller only.
    v_revoked boolean := public.student_access_revoked ();
begin
    if v_uid is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;
    if v_sort not in ('recent', 'title') then
        raise exception 'unknown library sort: %', v_sort using errcode = '22023';
    end if;
    -- A half cursor would compare against null and silently return nothing.
    if p_after_id is not null
       and ((v_sort = 'recent' and p_after_updated_at is null)
            or (v_sort = 'title' and p_after_title is null)) then
        raise exception 'library cursor is incomplete' using errcode = '22023';
    end if;

    if v_query is not null then
        -- Titles are short; a pasted paragraph is not a search worth running.
        -- Escape ilike's own wildcards so "50%" or "op_1" match literally.
        v_pattern := '%'
            || replace(replace(replace(left(v_query, 200), '\', '\\'), '%', '\%'), '_', '\_')
            || '%';
    end if;

    with visible as (
        select
            d.id,
            d.owner_id,
            d.title,
            d.storage_path,
            d.page_count,
            d.content_rev,
            d.thumb_rev,
            d.created_at,
            d.updated_at,
            d.archived_at
        from public.documents d
        where (
                d.owner_id = v_uid
                or (
                    not v_revoked
                    and exists (
                        select 1
                        from public.document_members m
                        where m.document_id = d.id
                          and m.user_id = v_uid
                    )
                )
            )
          and (v_pattern is null or d.title ilike v_pattern)
          and (
                p_tag_id is null
                or exists (
                    select 1
                    from public.document_tags dt
                    join public.library_tags t on t.id = dt.tag_id
                    where dt.document_id = d.id
                      and dt.tag_id = p_tag_id
                      and t.user_id = v_uid
                )
            )
          and (
                not coalesce(p_favorites_only, false)
                or exists (
                    select 1
                    from public.document_favorites f
                    where f.document_id = d.id
                      and f.user_id = v_uid
                )
            )
          and (
                p_after_id is null
                or (v_sort = 'recent' and (d.updated_at, d.id) < (p_after_updated_at, p_after_id))
                or (v_sort = 'title' and (lower(d.title), d.id) > (lower(p_after_title), p_after_id))
            )
    ),
    ordered as (
        select
            v.*,
            row_number() over (
                order by
                    case when v_sort = 'title' then lower(v.title) end asc,
                    case when v_sort = 'title' then v.id end asc,
                    case when v_sort = 'recent' then v.updated_at end desc,
                    case when v_sort = 'recent' then v.id end desc
            ) as rn
        from visible v
    ),
    page as (
        select * from ordered where rn <= v_limit + 1
    )
    select
        coalesce(
            (select jsonb_agg(to_jsonb(p) - 'rn' order by p.rn) from page p where p.rn <= v_limit),
            '[]'::jsonb
        ),
        (select count(*)::int from page)
    into v_rows, v_count;

    return jsonb_build_object(
        'documents', v_rows,
        'has_more', v_count > v_limit
    );
end;
$$;

revoke all on function public.library_documents (text, timestamptz, text, uuid, text, uuid, boolean, integer) from public;
revoke all on function public.library_documents (text, timestamptz, text, uuid, text, uuid, boolean, integer) from anon;
grant execute on function public.library_documents (text, timestamptz, text, uuid, text, uuid, boolean, integer) to authenticated;
