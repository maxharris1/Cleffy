-- The client roles keep only the table privileges the app uses (Codex round 1
-- on #69, MAJOR 4).
--
-- The default ACL for `postgres` in `public` gives anon and authenticated
-- every table privilege (arwdDxtm locally), and 20260827140000_core_table_grants
-- and the service-only tables' migrations added grants without first removing
-- it. RLS still decides every row, but not every privilege: TRUNCATE ignores
-- RLS, and REFERENCES, TRIGGER and MAINTAIN have no business with a client.
--
--  1. TRUNCATE, REFERENCES, TRIGGER and (PostgreSQL 17+) MAINTAIN are revoked
--     from anon and authenticated on every public table.
--  2. SELECT/INSERT/UPDATE/DELETE stay only where an RLS policy lets that role
--     use them. No public table has a policy for anon, so anon keeps nothing.
--     authenticated keeps, per table, the commands its policies allow; the
--     column grants on studios, practice_notes and managed_students and the
--     narrower grants elsewhere are untouched. The client's upserts into
--     annotation_snapshots, document_favorites and document_tags are ON
--     CONFLICT DO NOTHING (ignoreDuplicates), which needs no UPDATE.
--  3. omr_jobs, score_cache, imslp_category_sync and imslp_file_licenses lose
--     every client privilege: nothing in src/ reads or writes them (the OMR
--     service, imslp-sync, imslp-download and imslp-work use the service role).
--     score_analyses keeps SELECT, INSERT and UPDATE for authenticated -- the
--     app polls it (scoreAnalysisService.ts) and score-analyze upserts it with
--     the caller's own token -- and loses DELETE.
--  4. The default ACL for `postgres` in `public` no longer gives anon or
--     authenticated anything on a new table: a migration that wants a client
--     to reach a table grants it, next to the policy that allows it. The
--     service role's default is left as it is (every table also grants it
--     explicitly: tests/security/explicitServiceRoleGrants.test.ts).
--
-- tests/sql/explicit_grants.sql pins the result. Rerunnable: revokes only.

-- ---------------------------------------------------------------------------
-- 1. Never a client's, on any public table
-- ---------------------------------------------------------------------------
do $$
declare
    v_table text;
    v_maintain boolean := current_setting('server_version_num')::int >= 170000;
begin
    for v_table in
        select c.relname
        from pg_class c
        where c.relnamespace = 'public'::regnamespace
          and c.relkind in ('r', 'p')
        order by c.relname
    loop
        execute format('revoke truncate, references, trigger on table public.%I from public, anon, authenticated', v_table);
        if v_maintain then
            execute format('revoke maintain on table public.%I from public, anon, authenticated', v_table);
        end if;
    end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Only what a policy lets the client use
-- ---------------------------------------------------------------------------
-- No policy anywhere in public is for anon (or for PUBLIC).
revoke select, insert, update, delete on table public.annotation_snapshots from anon;
revoke select, insert, update, delete on table public.annotations from anon;
revoke select, insert, update, delete on table public.document_favorites from anon;
revoke select, insert, update, delete on table public.document_imports from anon;
revoke select, insert, update, delete on table public.document_members from anon;
revoke select, insert, update, delete on table public.document_tags from anon;
revoke select, insert, update, delete on table public.documents from anon;
revoke select, insert, update, delete on table public.library_tags from anon;
revoke select, insert, update, delete on table public.share_links from anon;
revoke select, insert, update, delete on table public.score_analyses from anon;

-- authenticated: the commands without a policy. Marks history is insert and
-- read (snapshots are never edited or removed by a client); marks are
-- tombstoned by UPDATE, never deleted; favourites and tags are added and
-- removed, never edited; an import record is never removed by a client;
-- sharing is changed only through the definer RPCs.
revoke update, delete on table public.annotation_snapshots from authenticated;
revoke delete on table public.annotations from authenticated;
revoke update on table public.document_favorites from authenticated;
revoke delete on table public.document_imports from authenticated;
revoke insert, update, delete on table public.document_members from authenticated;
revoke update on table public.document_tags from authenticated;

-- ---------------------------------------------------------------------------
-- 3. Service-only tables
-- ---------------------------------------------------------------------------
revoke all on table public.omr_jobs from public, anon, authenticated;
revoke all on table public.score_cache from public, anon, authenticated;
revoke all on table public.imslp_category_sync from public, anon, authenticated;
revoke all on table public.imslp_file_licenses from public, anon, authenticated;

revoke delete on table public.score_analyses from authenticated;

-- ---------------------------------------------------------------------------
-- 4. New tables start with nothing for a client
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
