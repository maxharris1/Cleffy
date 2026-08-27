-- Table-level grants for the core schema.
--
-- Why this exists: on the current Supabase Postgres image, the default ACL for
-- objects created by `postgres` in `public` gives anon/authenticated only
-- Dxtm (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) — no SELECT/INSERT/UPDATE/DELETE.
-- Only objects created by `supabase_admin` get the permissive arwdDxtm default.
-- Migrations run as `postgres`, so every table 0001_schema.sql created is
-- unreadable by the app: PostgREST returns 42501 "permission denied for table
-- documents" before RLS is ever consulted.
--
-- The later migrations (score_analyses, billing, roster) already grant
-- explicitly, which is why only the original core tables were affected.
--
-- Grants below mirror the RLS policies one-for-one — a table gets a privilege
-- only where a policy for that command exists. RLS still decides which ROWS are
-- visible; these grants only open the table-level gate. Tables with no
-- user-facing policy (omr_jobs, score_cache, edge_rate_buckets) are deliberately
-- absent: they stay service_role-only.
--
-- Idempotent: re-granting an existing privilege is a no-op, so this is safe to
-- replay against an environment that already has them.

grant select, insert, update, delete on table public.documents to authenticated;
grant select, insert, update          on table public.annotations to authenticated;
grant select, insert                  on table public.annotation_snapshots to authenticated;
grant select                          on table public.document_members to authenticated;
grant select, insert, update, delete on table public.share_links to authenticated;
grant select, insert, delete         on table public.document_favorites to authenticated;
grant select, insert, delete         on table public.document_tags to authenticated;
grant select, insert, update, delete on table public.library_tags to authenticated;
grant select, insert, update          on table public.document_imports to authenticated;

-- service_role bypasses RLS but still needs the table-level grant.
grant all on table public.documents,
               public.annotations,
               public.annotation_snapshots,
               public.document_members,
               public.share_links,
               public.document_favorites,
               public.document_tags,
               public.library_tags,
               public.document_imports
    to service_role;
