-- Security advisor fixes (function_search_path_mutable,
-- anon_security_definer_function_executable), as reported on both the
-- production project and the dev branch on 2026-10-08.
--
-- 1. Pin search_path on the three functions created without one. A function
--    whose search_path follows the caller resolves unqualified names against
--    whatever schemas the calling role puts first, so its behavior depends on
--    who fires it. Bodies are copied verbatim from the migrations that created
--    them (20260801160752_schema, 20260803120000_score_analyses_write_guard,
--    20260806150000_omr_enqueue_and_fail_policy) and from the live definitions,
--    which match; only the SET clause is new. `public`, like every other
--    function in this schema.
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

-- Clients (owner/editor via user JWT, including score-analyze) may only
-- request/retry analyses. They must not forge status='ready' or write ScoreData.
-- The OMR service uses the service_role JWT and retains full write access.
create or replace function public.guard_score_analyses_client_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    -- Service role (OMR write-back) may write any lifecycle fields.
    if coalesce(auth.jwt() ->> 'role', '') = 'service_role' then
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
