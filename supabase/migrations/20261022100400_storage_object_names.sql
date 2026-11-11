-- Clients may write only the object names the app writes, and may not create
-- a score that is already archived (launch re-audit SF-3, Codex A2).
--
-- The scores and thumbnails insert/update policies (20260801160754_rls.sql,
-- 20260902130000_thumbnails.sql) check only the first folder: the caller must
-- own the score named there. Anything below it went -- any name, any depth,
-- any number of objects -- so an owner could park arbitrary files under their
-- own score's folder, outside every quota, and in thumbnails in particular
-- under names nothing ever lists or cleans up.
--
-- What the app writes (grepped 2026-10-22):
--   scores      {documentId}/original.pdf             storageUpload.ts (upload and
--                                                       TUS), documentsService.ts
--               {documentId}/pre-import-original.pdf  documentsService.replaceDocumentPdf
--                                                       (the smart-import backup;
--                                                       document_imports.backup_path
--                                                       is pinned to it)
--   thumbnails  {documentId}/{rev}.jpg                thumbnailRemote.ts
-- documentId is a lower-case uuid (crypto.randomUUID(), and documents.id::text),
-- rev a non-negative int. The Edge Functions write as the service role, which
-- these policies do not reach.
--
-- RESTRICTIVE, beside the permissive owner policies, as
-- 20261020180700_read_only_seats_storage.sql does: ANDed with whatever else
-- allows the write, so this neither copies nor can undo those policies. Every
-- other bucket answers true. UPDATE has USING and WITH CHECK, so an upsert's
-- update arm (upload with upsert: true, every TUS upload) and a move are held
-- to the same names. Reads and deletes are untouched: removing an odd name
-- left from before this migration still works.
--
-- documents: billing_correctness's score cap (20261007120300, the
-- documents_enforce_score_cap trigger) skips a row inserted with archived_at
-- already set, since an archived score claims no slot. A client could insert
-- any number of them -- readable, exportable, and each one a stored PDF -- so a
-- client insert must arrive active. Archiving stays the server's (lapse,
-- read-only seats, takedown); the app never inserts one archived.
--
-- Rerunnable: each policy is dropped before it is created.

drop policy if exists scores_object_name_insert on storage.objects;

create policy scores_object_name_insert on storage.objects as restrictive for insert to authenticated
with check (
    bucket_id is distinct from 'scores'
    or name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(original|pre-import-original)\.pdf$'
);

drop policy if exists scores_object_name_update on storage.objects;

create policy scores_object_name_update on storage.objects as restrictive for update to authenticated
using (
    bucket_id is distinct from 'scores'
    or name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(original|pre-import-original)\.pdf$'
)
with check (
    bucket_id is distinct from 'scores'
    or name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(original|pre-import-original)\.pdf$'
);

drop policy if exists thumbnails_object_name_insert on storage.objects;

create policy thumbnails_object_name_insert on storage.objects as restrictive for insert to authenticated
with check (
    bucket_id is distinct from 'thumbnails'
    or name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(0|[1-9][0-9]{0,9})\.jpg$'
);

drop policy if exists thumbnails_object_name_update on storage.objects;

create policy thumbnails_object_name_update on storage.objects as restrictive for update to authenticated
using (
    bucket_id is distinct from 'thumbnails'
    or name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(0|[1-9][0-9]{0,9})\.jpg$'
)
with check (
    bucket_id is distinct from 'thumbnails'
    or name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(0|[1-9][0-9]{0,9})\.jpg$'
);

drop policy if exists documents_insert_active_only on public.documents;

create policy documents_insert_active_only on public.documents as restrictive for insert to authenticated
with check (archived_at is null);
