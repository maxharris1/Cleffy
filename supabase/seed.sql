-- Local / Cloud Agent seed for the current Cleffy schema (no billing tables).
-- Applied after migrations by `supabase db reset` / `supabase start` when
-- [db.seed] is enabled in config.toml.
--
-- Hosted projects create the private `scores` bucket via the dashboard; local
-- stacks need it here (or via [storage.buckets.scores] in config.toml).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'scores',
    'scores',
    false,
    52428800, -- 50 MiB; matches SETUP_SUPABASE.md / config.toml file_size_limit
    array['application/pdf']::text[]
)
on conflict (id) do update set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
