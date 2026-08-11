-- Durable OMR job queue (service-role only). score_analyses stays the
-- client-facing status projection / result cache; workers claim rows here
-- with FOR UPDATE SKIP LOCKED and never put leases on score_analyses.

create table public.omr_jobs (
    id bigint generated always as identity primary key,
    document_id uuid not null references public.documents (id) on delete cascade,
    status text not null default 'queued'
        check (status in ('queued', 'running', 'succeeded', 'failed_permanent', 'dead')),
    priority smallint not null default 0,
    attempt int not null default 0,
    max_attempts int not null default 3,
    run_after timestamptz not null default now(),
    claimed_at timestamptz,
    worker_id text,
    lease_expires_at timestamptz,
    storage_path text not null,
    page_count int not null,
    last_error text,
    created_by uuid references auth.users (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index omr_jobs_one_active_per_doc
    on public.omr_jobs (document_id)
    where status in ('queued', 'running');

create index omr_jobs_claim_idx
    on public.omr_jobs (priority desc, id)
    where status = 'queued';

create trigger omr_jobs_touch before update on public.omr_jobs
for each row execute function public.touch_updated_at ();

alter table public.omr_jobs enable row level security;
-- Zero policies for authenticated — service_role only.
grant all on public.omr_jobs to service_role;
grant usage, select on sequence public.omr_jobs_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- Claim / heartbeat / complete / fail / reap
-- ---------------------------------------------------------------------------

create or replace function public.omr_claim_job (p_worker_id text, p_lease_seconds int default 300)
returns public.omr_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
    claimed public.omr_jobs;
begin
    if p_worker_id is null or length(trim(p_worker_id)) = 0 then
        raise exception 'omr_claim_job: worker_id required';
    end if;

    select *
    into claimed
    from public.omr_jobs
    where status = 'queued'
      and run_after <= now()
    order by priority desc, id
    for update skip locked
    limit 1;

    if claimed.id is null then
        return null;
    end if;

    update public.omr_jobs
    set
        status = 'running',
        attempt = claimed.attempt + 1,
        claimed_at = now(),
        worker_id = p_worker_id,
        lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 60)),
        last_error = null
    where id = claimed.id
    returning * into claimed;

    return claimed;
end;
$$;

create or replace function public.omr_heartbeat_job (
    p_job_id bigint,
    p_worker_id text,
    p_lease_seconds int default 300
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    updated int;
begin
    update public.omr_jobs
    set lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 60))
    where id = p_job_id
      and status = 'running'
      and worker_id = p_worker_id;
    get diagnostics updated = row_count;
    return updated > 0;
end;
$$;

-- Atomic success: job succeeded + score_analyses ready in one transaction.
create or replace function public.omr_complete_job (
    p_job_id bigint,
    p_worker_id text,
    p_score jsonb,
    p_bpm_default int,
    p_engine_version text,
    p_timings jsonb default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    job public.omr_jobs;
    updated int;
begin
    update public.omr_jobs
    set
        status = 'succeeded',
        worker_id = null,
        lease_expires_at = null,
        last_error = null
    where id = p_job_id
      and status = 'running'
      and worker_id = p_worker_id
    returning * into job;
    get diagnostics updated = row_count;
    if updated = 0 then
        return false;
    end if;

    insert into public.score_analyses as sa (
        document_id,
        status,
        error,
        progress,
        engine_version,
        bpm_default,
        score,
        timings,
        created_by,
        updated_at
    )
    values (
        job.document_id,
        'ready',
        null,
        null,
        p_engine_version,
        p_bpm_default,
        p_score,
        p_timings,
        job.created_by,
        now()
    )
    on conflict (document_id) do update
    set
        status = excluded.status,
        error = null,
        progress = null,
        engine_version = excluded.engine_version,
        bpm_default = excluded.bpm_default,
        score = excluded.score,
        timings = excluded.timings,
        updated_at = now();

    return true;
end;
$$;

-- Shared requeue / terminal failure used by omr_fail_job and the reaper.
create or replace function public.omr_apply_failure (
    p_job_id bigint,
    p_error text,
    p_permanent boolean
) returns text -- resulting status
language plpgsql
security definer
set search_path = public
as $$
declare
    job public.omr_jobs;
    next_status text;
    backoff_secs int;
begin
    select * into job from public.omr_jobs where id = p_job_id for update;
    if job.id is null then
        return null;
    end if;

    if p_permanent or job.attempt >= job.max_attempts then
        next_status := case when p_permanent then 'failed_permanent' else 'dead' end;
        update public.omr_jobs
        set
            status = next_status,
            last_error = p_error,
            worker_id = null,
            lease_expires_at = null,
            claimed_at = null
        where id = p_job_id;

        insert into public.score_analyses as sa (
            document_id, status, error, progress, score, timings, created_by, updated_at
        )
        values (
            job.document_id, 'failed', p_error, null, null, null, job.created_by, now()
        )
        on conflict (document_id) do update
        set
            status = 'failed',
            error = excluded.error,
            progress = null,
            score = null,
            timings = null,
            engine_version = null,
            bpm_default = null,
            updated_at = now();
    else
        -- Transient: requeue with exponential backoff 60s / 5min / 15min.
        backoff_secs := least(900, 60 * power(5, greatest(job.attempt - 1, 0))::int);
        next_status := 'queued';
        update public.omr_jobs
        set
            status = 'queued',
            last_error = p_error,
            worker_id = null,
            lease_expires_at = null,
            claimed_at = null,
            run_after = now() + make_interval(secs => backoff_secs)
        where id = p_job_id;

        update public.score_analyses
        set status = 'pending', error = null, progress = null, updated_at = now()
        where document_id = job.document_id;
    end if;

    return next_status;
end;
$$;

create or replace function public.omr_fail_job (
    p_job_id bigint,
    p_worker_id text,
    p_error text,
    p_permanent boolean
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    owned int;
begin
    update public.omr_jobs
    set updated_at = now() -- touch so we know we still own it
    where id = p_job_id
      and status = 'running'
      and worker_id = p_worker_id;
    get diagnostics owned = row_count;
    if owned = 0 then
        return null;
    end if;
    return public.omr_apply_failure (p_job_id, p_error, p_permanent);
end;
$$;

-- Reap expired leases; touch score_analyses.updated_at for live queued/running
-- rows so the client's 20-min staleness rule does not false-fail deep backlogs.
-- Returns count of jobs currently queued (for the sweeper poke decision).
create or replace function public.omr_reap_expired_leases ()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    expired record;
    queued_count int;
begin
    for expired in
        select id
        from public.omr_jobs
        where status = 'running'
          and lease_expires_at is not null
          and lease_expires_at < now()
        for update skip locked
    loop
        perform public.omr_apply_failure (expired.id, 'worker_lost', false);
    end loop;

    -- Keep-alive for client staleness: only updated_at (status/progress unchanged
    -- → realtime trigger stays silent under IS DISTINCT FROM gate).
    update public.score_analyses sa
    set updated_at = now()
    where exists (
        select 1
        from public.omr_jobs j
        where j.document_id = sa.document_id
          and j.status in ('queued', 'running')
    )
    and sa.status in ('pending', 'processing');

    select count(*)::int into queued_count
    from public.omr_jobs
    where status = 'queued'
      and run_after <= now();

    return queued_count;
end;
$$;

-- Per-user active backlog count for admission control.
create or replace function public.omr_user_active_job_count (p_user_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
    select count(*)::int
    from public.omr_jobs
    where created_by = p_user_id
      and status in ('queued', 'running');
$$;

revoke all on function public.omr_claim_job (text, int) from public, anon, authenticated;
revoke all on function public.omr_heartbeat_job (bigint, text, int) from public, anon, authenticated;
revoke all on function public.omr_complete_job (bigint, text, jsonb, int, text, jsonb) from public, anon, authenticated;
revoke all on function public.omr_apply_failure (bigint, text, boolean) from public, anon, authenticated;
revoke all on function public.omr_fail_job (bigint, text, text, boolean) from public, anon, authenticated;
revoke all on function public.omr_reap_expired_leases () from public, anon, authenticated;
revoke all on function public.omr_user_active_job_count (uuid) from public, anon, authenticated;

grant execute on function public.omr_claim_job (text, int) to service_role;
grant execute on function public.omr_heartbeat_job (bigint, text, int) to service_role;
grant execute on function public.omr_complete_job (bigint, text, jsonb, int, text, jsonb) to service_role;
grant execute on function public.omr_apply_failure (bigint, text, boolean) to service_role;
grant execute on function public.omr_fail_job (bigint, text, text, boolean) to service_role;
grant execute on function public.omr_reap_expired_leases () to service_role;
grant execute on function public.omr_user_active_job_count (uuid) to service_role;
-- Edge function uses service-role for the cap check too.
