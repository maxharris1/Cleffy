-- Hash lookup: rank a symbolic row (Mutopia / OpenScore / IA MIDI + alignment)
-- ahead of an OMR row for the same bytes. OMR rows are keyed by the document
-- era and symbolic rows by '', so the put guard never lets one replace the
-- other and both can coexist; ordering on the era match alone served the OMR
-- fallback over the better symbolic analysis. Between OMR rows the era match
-- still decides. Same body and grants as 20260916140000_playalong_corpus.sql.

create or replace function public.playalong_corpus_get_by_hash (p_hash text, p_engine_version text, p_era text)
returns setof public.playalong_corpus
language plpgsql
security definer
set search_path = public
as $$
declare
    hit public.playalong_corpus%rowtype;
begin
    select c.* into hit
    from public.playalong_corpus c
    where c.pdf_sha256 = p_hash
      and c.engine_version = p_engine_version
      and c.era in (p_era, '')
    order by (c.symbolic_source is distinct from 'omr') desc, (c.era = p_era) desc
    limit 1;
    if not found then
        return;
    end if;

    update public.playalong_corpus c
    set last_used_at = now(), use_count = c.use_count + 1
    where c.pdf_sha256 = hit.pdf_sha256
      and c.engine_version = hit.engine_version
      and c.era = hit.era
    returning c.* into hit;
    return next hit;
end;
$$;

revoke all on function public.playalong_corpus_get_by_hash (text, text, text) from public, anon, authenticated;
grant execute on function public.playalong_corpus_get_by_hash (text, text, text) to service_role;
