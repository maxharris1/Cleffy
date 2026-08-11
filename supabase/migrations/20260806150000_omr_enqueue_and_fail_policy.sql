-- Atomic enqueue + SQL-owned retry permanence (review fixes).

-- Permanence policy lives here only (mirrors services/omr-service/src/errors.ts tests).
create or replace function public.omr_error_is_permanent (p_error text, p_attempt int)
returns boolean
language sql
immutable
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

-- Fail without client-supplied permanence; SQL decides.
create or replace function public.omr_fail_job (
    p_job_id bigint,
    p_worker_id text,
    p_error text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    owned int;
    job public.omr_jobs;
begin
    update public.omr_jobs
    set updated_at = now()
    where id = p_job_id
      and status = 'running'
      and worker_id = p_worker_id
    returning * into job;
    get diagnostics owned = row_count;
    if owned = 0 then
        return null;
    end if;
    return public.omr_apply_failure (
        p_job_id,
        p_error,
        public.omr_error_is_permanent (p_error, job.attempt)
    );
end;
$$;

revoke all on function public.omr_fail_job (bigint, text, text, boolean) from public, anon, authenticated, service_role;
drop function if exists public.omr_fail_job (bigint, text, text, boolean);

revoke all on function public.omr_fail_job (bigint, text, text) from public, anon, authenticated;
grant execute on function public.omr_fail_job (bigint, text, text) to service_role;
grant execute on function public.omr_error_is_permanent (text, int) to service_role;

-- Cap + pending upsert + job insert in one transaction.
create or replace function public.omr_enqueue_job (
    p_document_id uuid,
    p_user_id uuid,
    p_storage_path text,
    p_page_count int,
    p_cap int default 10
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    active_count int;
    inserted_id bigint;
begin
    -- Clear zombie running rows before admission so Generate is not blocked
    -- for a full lease after a worker crash.
    perform public.omr_reap_expired_leases();

    perform pg_advisory_xact_lock (hashtext('omr_enqueue:' || p_user_id::text));

    select count(*)::int into active_count
    from public.omr_jobs
    where created_by = p_user_id
      and status in ('queued', 'running');

    if active_count >= p_cap then
        return jsonb_build_object('ok', false, 'code', 'backlog_full');
    end if;

    if exists (
        select 1 from public.omr_jobs
        where document_id = p_document_id
          and status in ('queued', 'running')
    ) then
        return jsonb_build_object('ok', false, 'code', 'already_running');
    end if;

    insert into public.score_analyses as sa (
        document_id, created_by, status, progress, error, score, updated_at
    )
    values (
        p_document_id, p_user_id, 'pending', null, null, null, now()
    )
    on conflict (document_id) do update
    set
        status = 'pending',
        progress = null,
        error = null,
        score = null,
        engine_version = null,
        bpm_default = null,
        timings = null,
        updated_at = now();

    begin
        insert into public.omr_jobs (
            document_id, status, storage_path, page_count, created_by, priority
        )
        values (
            p_document_id, 'queued', p_storage_path, p_page_count, p_user_id, 0
        )
        returning id into inserted_id;
    exception
        when unique_violation then
            return jsonb_build_object('ok', false, 'code', 'already_running');
    end;

    return jsonb_build_object('ok', true, 'code', 'queued', 'job_id', inserted_id);
end;
$$;

revoke all on function public.omr_enqueue_job (uuid, uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.omr_enqueue_job (uuid, uuid, text, int, int) to service_role;
