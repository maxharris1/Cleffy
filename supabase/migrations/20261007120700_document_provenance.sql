-- Score provenance + IMSLP back-off.
--
-- 1. documents.source_* — where an imported score came from. An IMSLP import
--    records the work page, the file, IMSLP's license tag verbatim, and the
--    credits IMSLP lists for that file (composer, editor, arranger,
--    publisher). Creative Commons Attribution files are licensed on the
--    condition that the credit travels with the copy; a score shared from
--    Cleffy must still say whose engraving it is. All nullable: an uploaded
--    PDF has no provenance, and rows imported before this migration have
--    none recorded.
--
--    Written only by imslp-download, under the service role, from values the
--    function derived itself (the license cache / a live parse of the work
--    page) — never from what the browser sent. documents_guard_provenance
--    keeps it that way: a client (authenticated/anon) may neither insert a
--    row claiming provenance nor change or clear it later. The table-level
--    UPDATE grant stays as it is (title, page_count, thumb_rev… are client
--    columns), so a trigger rather than column privileges does the guarding.
--    Members read it through the existing documents_select policy, like the
--    rest of the row.
--
-- 2. edge_rate_block(key, seconds) — IMSLP answered 429: hold a shared
--    edge_rate_buckets key closed for the Retry-After so every other import
--    waits it out (check_edge_rate_limit refuses until reset_at) instead of
--    each one re-discovering the throttle with another request. Service role
--    only.

alter table public.documents
    add column if not exists source_url text,
    add column if not exists source_filename text,
    add column if not exists source_license text,
    add column if not exists source_attribution jsonb;

alter table public.documents
    drop constraint if exists documents_source_url_check;

alter table public.documents
    add constraint documents_source_url_check check (
        source_url is null or (source_url ~ '^https://' and char_length(source_url) <= 4096)
    );

alter table public.documents
    drop constraint if exists documents_source_filename_check;

alter table public.documents
    add constraint documents_source_filename_check check (
        source_filename is null or char_length(source_filename) <= 512
    );

alter table public.documents
    drop constraint if exists documents_source_license_check;

alter table public.documents
    add constraint documents_source_license_check check (
        source_license is null or char_length(source_license) <= 200
    );

alter table public.documents
    drop constraint if exists documents_source_attribution_check;

alter table public.documents
    add constraint documents_source_attribution_check check (
        source_attribution is null
        or (jsonb_typeof(source_attribution) = 'object' and pg_column_size(source_attribution) <= 4096)
    );

-- Not SECURITY DEFINER on purpose: current_user must be the role that issued
-- the statement. PostgREST runs a signed-in browser as `authenticated` (or
-- `anon`); imslp-download's service client is `service_role`, and migrations
-- and definer functions run as their owner — those may write provenance.
create or replace function public.documents_guard_provenance () returns trigger language plpgsql
set search_path = public as $$
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        if new.source_url is not null
            or new.source_filename is not null
            or new.source_license is not null
            or new.source_attribution is not null then
            raise exception 'document provenance is recorded by the import service'
                using errcode = '42501';
        end if;
        return new;
    end if;

    if new.source_url is distinct from old.source_url
        or new.source_filename is distinct from old.source_filename
        or new.source_license is distinct from old.source_license
        or new.source_attribution is distinct from old.source_attribution then
        raise exception 'document provenance is recorded by the import service'
            using errcode = '42501';
    end if;
    return new;
end;
$$;

drop trigger if exists documents_guard_provenance on public.documents;

create trigger documents_guard_provenance before insert or update on public.documents
for each row execute function public.documents_guard_provenance ();

revoke all on function public.documents_guard_provenance () from public;

revoke all on function public.documents_guard_provenance () from anon;

revoke all on function public.documents_guard_provenance () from authenticated;

-- Close a rate bucket for p_seconds (clamped to 1..900). check_edge_rate_limit
-- refuses while count >= limit and reset_at is in the future, so a saturated
-- count with a pushed-out reset_at blocks every caller of that key; the next
-- check after reset_at starts a fresh window as usual. An existing, later
-- reset_at is never pulled in. SECURITY DEFINER because edge_rate_buckets has
-- RLS and no policies; callable by the service role only.
create or replace function public.edge_rate_block (p_key text, p_seconds int) returns void
language plpgsql security definer
set search_path = public as $$
declare
    v_until timestamptz;
begin
    if p_key is null or char_length(p_key) = 0 or char_length(p_key) > 200 then
        raise exception 'edge_rate_block: invalid key' using errcode = '22023';
    end if;
    if p_seconds is null or p_seconds < 1 then
        return;
    end if;

    v_until := clock_timestamp() + make_interval(secs => least(p_seconds, 900));

    insert into public.edge_rate_buckets (key, count, reset_at)
    values (p_key, 2147483647, v_until)
    on conflict (key) do update
        set count = 2147483647,
            reset_at = greatest(public.edge_rate_buckets.reset_at, excluded.reset_at);
end;
$$;

revoke all on function public.edge_rate_block (text, int) from public;

revoke all on function public.edge_rate_block (text, int) from anon;

revoke all on function public.edge_rate_block (text, int) from authenticated;

grant execute on function public.edge_rate_block (text, int) to service_role;
