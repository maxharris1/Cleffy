-- Server-stored library thumbnails.
--
-- The library used to draw a cover only for scores whose PDF this device had
-- already downloaded — pdf.js rendering the first page from the Dexie cache. A
-- fresh browser therefore showed a placeholder for every score until each was
-- opened. Edge Functions cannot render PDFs (no canvas), so the client that
-- already renders a first page — on upload, on import, or on any device that
-- holds the bytes — publishes that render once, and every other device
-- downloads a ~40 KB image instead of a multi-megabyte PDF.
--
--  1. documents.thumb_rev — the content_rev the published cover was rendered
--     from; null means none yet (a fresh upload is content_rev 0, so 0 has
--     to be a real revision). Read by the library list, written by the owner
--     after a successful publish (documents_update is owner-only).
--  2. library_bootstrap() carries the new column.
--  3. A private `thumbnails` bucket, object path `{documentId}/{rev}.jpg`,
--     with the same membership policies as `scores`: members read, owner
--     writes. The bucket row is attempted here and documented in
--     SETUP_SUPABASE.md, because hosted projects can refuse storage.buckets
--     writes from migrations (see the `scores` note in 20260801160754_rls).

alter table public.documents
    add column if not exists thumb_rev integer;

-- ---------------------------------------------------------------------------
-- library_bootstrap — same body as 20260830120000, plus d.thumb_rev
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
            d.thumb_rev,
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

-- ---------------------------------------------------------------------------
-- thumbnails bucket + policies
-- ---------------------------------------------------------------------------
do $$
begin
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('thumbnails', 'thumbnails', false, 2097152, array['image/jpeg'])
    on conflict (id) do nothing;
exception
    when insufficient_privilege then
        -- Hosted projects may refuse storage.buckets writes from a migration
        -- (SQLSTATE 42501); the dashboard step in SETUP_SUPABASE.md creates
        -- the bucket by hand. Any other error must fail the migration.
        raise notice 'thumbnails bucket not created here (%): create it in the dashboard', sqlerrm;
end;
$$;

drop policy if exists thumbnails_read on storage.objects;
create policy thumbnails_read on storage.objects for select to authenticated
using (
    bucket_id = 'thumbnails'
    and public.document_role (((storage.foldername (name))[1])::uuid) is not null
);

drop policy if exists thumbnails_insert on storage.objects;
create policy thumbnails_insert on storage.objects for insert to authenticated
with check (
    bucket_id = 'thumbnails'
    and public.document_role (((storage.foldername (name))[1])::uuid) = 'owner'
);

drop policy if exists thumbnails_update on storage.objects;
create policy thumbnails_update on storage.objects for update to authenticated
using (
    bucket_id = 'thumbnails'
    and public.document_role (((storage.foldername (name))[1])::uuid) = 'owner'
);

drop policy if exists thumbnails_delete on storage.objects;
create policy thumbnails_delete on storage.objects for delete to authenticated
using (
    bucket_id = 'thumbnails'
    and public.document_role (((storage.foldername (name))[1])::uuid) = 'owner'
);
