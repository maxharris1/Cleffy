-- Security advisor fixes (function_search_path_mutable,
-- anon_security_definer_function_executable), as reported on both the
-- production project and the dev branch on 2026-10-08.
--
-- 1. Pin search_path on the three functions created without one. A function
--    whose search_path follows the caller resolves unqualified names against
--    whatever schemas the calling role puts first, so its behavior depends on
--    who fires it. touch_updated_at and omr_error_is_permanent are copied
--    verbatim from the migrations that created them (20260801160752_schema,
--    20260806150000_omr_enqueue_and_fail_policy); only the SET clause is new.
--    guard_score_analyses_client_write keeps the body
--    20261007120100_column_integrity gave it (see below). `public`, like every
--    other function in this schema.
--
-- 2. Revoke EXECUTE from client roles on functions they have no business
--    calling through /rest/v1/rpc. Supabase's default privileges grant EXECUTE
--    on every new public function to anon and authenticated directly, so the
--    `revoke ... from public` the original migrations did left those grants in
--    place. Trigger functions keep working without EXECUTE: Postgres checks it
--    when CREATE TRIGGER runs, never when the trigger fires (the same reasoning
--    as 20260802172249_edge_rate_rls_and_revoke_execute).

-- ---------------------------------------------------------------------------
-- 1. search_path
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at () returns trigger language plpgsql
set search_path = public as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

-- guard_score_analyses_client_write: the advisor flagged the 20260803120000
-- definition. 20261007120100_column_integrity already re-created it with
-- `set search_path = public` AND a corrected body -- "client" decided by the
-- database role (current_user in authenticated/anon) instead of the JWT, so
-- that an account deletion's ON DELETE SET NULL of created_by (run as the
-- table owner, no JWT) is no longer reverted by the guard and refused by the
-- foreign key. Re-creating it here from the original body would silently undo
-- that fix, since this file runs later. It is restated with the 120100 body so
-- the two files agree whichever one a reader (or a partial apply) starts from.
create or replace function public.guard_score_analyses_client_write () returns trigger language plpgsql
set search_path = public as $$
begin
    -- Server code (service role OMR write-back, FK actions, migrations) may
    -- write any lifecycle fields.
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        if new.status not in ('pending', 'failed') then
            raise exception 'score_analyses: clients may only insert pending or failed';
        end if;
        if new.score is not null then
            raise exception 'score_analyses: clients may not write score';
        end if;
        if new.status = 'pending' then
            new.score := null;
            new.progress := null;
            new.engine_version := null;
            new.bpm_default := null;
        end if;
        return new;
    end if;

    -- UPDATE: request/retry only.
    if new.status not in ('pending', 'failed') then
        raise exception 'score_analyses: clients may only set pending or failed';
    end if;
    if new.score is not null then
        raise exception 'score_analyses: clients may not write score';
    end if;
    -- Preserve original requester attribution across retries.
    new.created_by := old.created_by;
    if new.status = 'pending' then
        new.score := null;
        new.progress := null;
        new.error := null;
        new.engine_version := null;
        new.bpm_default := null;
    end if;
    return new;
end;
$$;

-- Permanence policy lives here only (mirrors services/omr-service/src/errors.ts tests).
create or replace function public.omr_error_is_permanent (p_error text, p_attempt int)
returns boolean
language sql
immutable
set search_path = public
as $$
    select case
        when p_error in (
            'too_large', 'page_count_unknown', 'no_staves_found',
            'musicxml_parse_failed', 'backlog_full'
        ) then true
        when p_error in ('omr_crash', 'omr_timeout') then p_attempt >= 2
        else false
    end;
$$;

-- ---------------------------------------------------------------------------
-- 2. EXECUTE grants
-- ---------------------------------------------------------------------------

-- Trigger-only functions: nothing should reach them through /rest/v1/rpc.
revoke all on function public.touch_updated_at () from public, anon, authenticated;
revoke all on function public.guard_score_analyses_client_write () from public, anon, authenticated;
revoke all on function public.broadcast_document_changes () from public, anon, authenticated;
revoke all on function public.broadcast_score_analysis_changes () from public, anon, authenticated;

-- Called only by omr_fail_job (SECURITY DEFINER, runs as its owner) and the
-- service role, which keeps the grant 20260806150000 gave it.
revoke all on function public.omr_error_is_permanent (text, int) from public, anon, authenticated;
grant execute on function public.omr_error_is_permanent (text, int) to service_role;

-- Owners and editors only, and a signed-out caller is never either: the
-- function already refuses anon with 'forbidden', this stops it being callable.
-- Anonymous (guest) sessions are the authenticated role and are unaffected.
revoke all on function public.set_document_page_count (uuid, int) from public, anon;
grant execute on function public.set_document_page_count (uuid, int) to authenticated;
