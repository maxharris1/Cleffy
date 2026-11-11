-- Library pagination and server-side search.
--
-- The library used to stop at 100 scores: library_bootstrap() and the
-- client's fallback listDocuments() both returned the newest 100 and a
-- has_more flag, and the page could only say "showing latest 100". Search,
-- tag and favorite filters ran over those loaded rows only, so a teacher with
-- 101 scores could not find the oldest one at all.
--
--  1. library_documents() — one keyset page of the caller's visible scores,
--     optionally filtered by title (ilike), one of the caller's own tags, or
--     the caller's favorites, ordered either by recency or by title. Keyset
--     rather than offset so a page boundary stays put while scores are
--     uploaded or touched in between "load more" taps.
--  2. library_bootstrap() keeps its signature and payload (cached older
--     clients call it with no arguments and read the same keys) but now takes
--     its first page from library_documents(), so the bootstrap page and the
--     pages after it share one total order: updated_at desc, id desc. The old
--     order had no tiebreak, and a bulk update (archiving on a downgrade
--     stamps every row with the same now()) made the boundary row ambiguous —
--     a keyset continuation from it could skip or repeat scores.

-- ---------------------------------------------------------------------------
-- library_documents
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER for the same reason as library_bootstrap: the visible set
-- is assembled from the caller's memberships in one indexed pass instead of
-- evaluating documents_select per row of the whole table. Every predicate is
-- therefore scoped to auth.uid() explicitly, mirroring documents_select
-- (owner, or any document_members row), favorites_select (own rows) and
-- library_tags (own tags — another user's tag id matches nothing).
--
-- Cursor: the sort key of the last row the client holds, plus its id.
--   recent: (p_after_updated_at, p_after_id) — rows strictly older.
--   title:  (p_after_title, p_after_id) — rows strictly after, compared on
--           lower(title) so A–Z is case-insensitive.
-- The client passes back the exact updated_at string it was given; a
-- truncated timestamp would skip rows that share the millisecond.
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
                or exists (
                    select 1
                    from public.document_members m
                    where m.document_id = d.id
                      and m.user_id = v_uid
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

-- ---------------------------------------------------------------------------
-- library_bootstrap — same payload as 20260902130000; the first page now
-- comes from library_documents() so it shares the keyset order above.
-- ---------------------------------------------------------------------------
create or replace function public.library_bootstrap ()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_uid uuid := (select auth.uid());
    v_page jsonb;
    v_favorites jsonb;
    v_tags jsonb;
    v_document_tags jsonb;
    v_entitlements jsonb;
begin
    if v_uid is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;

    v_page := public.library_documents (p_sort => 'recent', p_limit => 100);

    select coalesce(jsonb_agg(f.document_id), '[]'::jsonb)
    into v_favorites
    from public.document_favorites f
    where f.user_id = v_uid;

    select coalesce(
        jsonb_agg(
            jsonb_build_object(
                'id', t.id,
                'user_id', t.user_id,
                'name', t.name,
                'created_at', t.created_at
            )
            order by t.name asc
        ),
        '[]'::jsonb
    )
    into v_tags
    from public.library_tags t
    where t.user_id = v_uid;

    select coalesce(
        jsonb_agg(
            jsonb_build_object(
                'document_id', dt.document_id,
                'tag_id', dt.tag_id
            )
        ),
        '[]'::jsonb
    )
    into v_document_tags
    from public.document_tags dt
    join public.library_tags t on t.id = dt.tag_id
    where t.user_id = v_uid;

    v_entitlements := public.get_entitlements ();

    return jsonb_build_object(
        'documents', v_page -> 'documents',
        'has_more', (v_page ->> 'has_more')::boolean,
        'favorite_ids', v_favorites,
        'tags', v_tags,
        'document_tags', v_document_tags,
        'entitlements', v_entitlements
    );
end;
$$;

revoke all on function public.library_bootstrap () from public;
revoke all on function public.library_bootstrap () from anon;
grant execute on function public.library_bootstrap () to authenticated;
