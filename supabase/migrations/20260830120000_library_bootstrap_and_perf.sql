-- Perceived-load performance:
--  1. library_bootstrap() — one round-trip for library shell + page data.
--  2. RLS initplan: wrap auth.uid() in (select …) for favorites + document_role.
--  3. Index omr_jobs(created_by) for enqueue / active-job counts.

-- ---------------------------------------------------------------------------
-- library_bootstrap
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so we can assemble a single JSON payload, but every select
-- is scoped to auth.uid() explicitly (RLS is bypassed under definer). Matches
-- documents_select / favorites / library_tags / document_tags visibility.

create or replace function public.library_bootstrap ()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_uid uuid := (select auth.uid());
    v_rows jsonb;
    v_count int;
    v_favorites jsonb;
    v_tags jsonb;
    v_document_tags jsonb;
    v_entitlements jsonb;
begin
    if v_uid is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;

    with visible as (
        select
            d.id,
            d.owner_id,
            d.title,
            d.storage_path,
            d.page_count,
            d.content_rev,
            d.created_at,
            d.updated_at,
            d.archived_at
        from public.documents d
        where d.owner_id = v_uid
           or exists (
                select 1
                from public.document_members m
                where m.document_id = d.id
                  and m.user_id = v_uid
            )
        order by d.updated_at desc
        limit 101
    ),
    counted as (
        select count(*)::int as total from visible
    ),
    page as (
        select * from visible limit 100
    )
    select
        coalesce(
            (select jsonb_agg(to_jsonb(p) order by p.updated_at desc) from page p),
            '[]'::jsonb
        ),
        (select total from counted)
    into v_rows, v_count;

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
        'documents', v_rows,
        'has_more', v_count > 100,
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

-- ---------------------------------------------------------------------------
-- RLS initplan fixes
-- ---------------------------------------------------------------------------
create or replace function public.document_role (doc uuid) returns text language sql stable security definer
set search_path = public as $$
    select role from public.document_members
    where document_id = doc and user_id = (select auth.uid());
$$;

drop policy if exists favorites_select on public.document_favorites;
create policy favorites_select on public.document_favorites for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists favorites_insert on public.document_favorites;
create policy favorites_insert on public.document_favorites for insert to authenticated
with check (
    user_id = (select auth.uid())
    and public.document_role (document_id) is not null
);

drop policy if exists favorites_delete on public.document_favorites;
create policy favorites_delete on public.document_favorites for delete to authenticated
using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- omr_jobs.created_by — filtered by enqueue / active-job count
-- ---------------------------------------------------------------------------
create index if not exists omr_jobs_created_by_idx
    on public.omr_jobs (created_by);
