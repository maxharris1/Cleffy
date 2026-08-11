-- Persist backlog_full onto score_analyses so client remount/rehydrate still
-- shows the admission rejection (without clobbering an existing ready analysis).

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
        insert into public.score_analyses as sa (
            document_id, created_by, status, progress, error, score, updated_at
        )
        values (
            p_document_id, p_user_id, 'failed', null, 'backlog_full', null, now()
        )
        on conflict (document_id) do update
        set
            status = 'failed',
            progress = null,
            error = 'backlog_full',
            updated_at = now()
        where sa.status is distinct from 'ready';
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
