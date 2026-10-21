-- Read-only seats cannot write score files through Storage either
-- (Codex round-3 review of PR #61, round-2 major 1 still partial).
--
-- 20261020180600 refuses a read-only seat's writes on every table it could use,
-- and documents_refuse_read_only_seat refuses bumping a score's content_rev.
-- But the PDF itself lives in the private 'scores' bucket, and its
-- scores_insert / scores_update / scores_delete policies (20260801160754) ask
-- only that the caller own the score. So a read-only seat could still replace
-- {documentId}/original.pdf, or delete it, straight through the Storage API,
-- without touching content_rev at all.
--
-- Restrictive policies beside those permissive ones, as 20261020180600 does for
-- the tables, asking the same question with the same helper:
-- caller_seat_read_only(), planned once per statement. Only the 'scores'
-- bucket: every other bucket answers true.
--
-- What stays allowed: reading and downloading (no SELECT policy changes, so
-- signed URLs and downloads work as before); every write by anyone who is not a
-- read-only seat; and removing the files of a score the seat has already
-- deleted -- deleting one's own score stays allowed, and its files are then
-- removed under document_storage_cleanup_pending (20261007120401), whose folder
-- no live score holds any more. The 'thumbnails' bucket is left alone: a cover
-- is the viewer's own backfill from opening a score, like thumb_rev, which
-- 20261020180600 lets through for the same reason.
--
-- UPDATE has both USING and WITH CHECK: an upsert's update arm (the Storage
-- API's upload with upsert: true, and every resumable upload) is refused with
-- an error by a failing USING, where a plain UPDATE just matches nothing.

drop policy if exists scores_seat_read_only_insert on storage.objects;

create policy scores_seat_read_only_insert on storage.objects as restrictive for insert to authenticated
with check (bucket_id is distinct from 'scores' or not (select public.caller_seat_read_only ()));

drop policy if exists scores_seat_read_only_update on storage.objects;

create policy scores_seat_read_only_update on storage.objects as restrictive for update to authenticated
using (bucket_id is distinct from 'scores' or not (select public.caller_seat_read_only ()))
with check (bucket_id is distinct from 'scores' or not (select public.caller_seat_read_only ()));

drop policy if exists scores_seat_read_only_delete on storage.objects;

create policy scores_seat_read_only_delete on storage.objects as restrictive for delete to authenticated
using (
    bucket_id is distinct from 'scores'
    or not (select public.caller_seat_read_only ())
    or public.document_storage_cleanup_pending ((storage.foldername (name))[1])
);
