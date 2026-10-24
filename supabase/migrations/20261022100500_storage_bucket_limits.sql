-- Size and type limits on the two buckets, from a migration (launch re-audit
-- SF-3, Codex A2).
--
-- The limits lived only where the bucket was made: supabase/config.toml and
-- seed.sql for the local stack, the thumbnails migration's own insert
-- (20260902130000), and a dashboard step for hosted scores (rls.sql notes that
-- hosted storage.buckets writes from migrations can hit ownership errors). A
-- fresh replay onto a wiped project therefore had no migration that sets the
-- scores bucket's 50 MiB / application/pdf limit at all.
--
-- Same values as config.toml and seed.sql: scores 50 MiB of application/pdf,
-- thumbnails 2 MiB of image/jpeg. A missing bucket is created private; an
-- existing one keeps its `public` flag and gets the limits.
--
-- Hosted projects may refuse the write (42501, or a platform trigger's raise),
-- so each bucket is its own block that reports and moves on rather than
-- failing the replay; the notice says which happened, and
-- tests/sql/storage_name_limits.sql checks the result. If it was refused, set
-- the limits in the dashboard (Storage -> bucket -> settings). Rerunnable.

do $$
begin
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('scores', 'scores', false, 52428800, array['application/pdf'])
    on conflict (id) do update
    set file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
    raise notice 'scores bucket limits applied: 50 MiB, application/pdf';
exception
    when insufficient_privilege or raise_exception then
        raise notice 'scores bucket limits NOT applied here (% %): set them in the dashboard', sqlstate, sqlerrm;
end;
$$;

do $$
begin
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('thumbnails', 'thumbnails', false, 2097152, array['image/jpeg'])
    on conflict (id) do update
    set file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
    raise notice 'thumbnails bucket limits applied: 2 MiB, image/jpeg';
exception
    when insufficient_privilege or raise_exception then
        raise notice 'thumbnails bucket limits NOT applied here (% %): set them in the dashboard', sqlstate, sqlerrm;
end;
$$;
