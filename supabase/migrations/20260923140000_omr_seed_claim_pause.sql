-- Honor soft pause for seed-only workers, including already queued pokes.

create or replace function public.omr_claim_job (
    p_worker_id text,
    p_lease_seconds int default 300,
    p_max_priority int default null
)
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

    -- Check at the claim boundary as well as in the worker's fan-out loop.
    -- Unfiltered user workers retain their existing fallback behavior.
    if p_max_priority < 0 and coalesce((
        select c.paused from public.playalong_corpus_control c where c.singleton
    ), true) then
        return null;
    end if;

    select *
    into claimed
    from public.omr_jobs
    where status = 'queued'
      and run_after <= now()
      and (p_max_priority is null or priority <= p_max_priority)
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

revoke all on function public.omr_claim_job (text, int, int) from public, anon, authenticated;
grant execute on function public.omr_claim_job (text, int, int) to service_role;
