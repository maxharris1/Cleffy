-- Allow owners and editors to backfill a missing documents.page_count
-- (needed before score-analyze). Does not overwrite an existing positive count.

create or replace function public.set_document_page_count (doc uuid, pages int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if pages is null or pages < 1 then
        raise exception 'invalid page count';
    end if;
    if public.document_role (doc) is distinct from 'owner'
        and public.document_role (doc) is distinct from 'editor' then
        raise exception 'forbidden';
    end if;
    update public.documents
    set page_count = pages
    where id = doc
      and (page_count is null or page_count < 1);
end;
$$;

revoke all on function public.set_document_page_count (uuid, int) from public;
grant execute on function public.set_document_page_count (uuid, int) to authenticated;
