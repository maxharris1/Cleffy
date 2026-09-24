-- Seed-only claimers for the play-along corpus (plan Phase 2c).
--
-- The corpus seed inserts omr_jobs rows at priority -10; user rows stay at 0.
-- A second Cloud Run service (cleffy-omr-seed) drains those seed rows in
-- parallel and must never take a user's job. omr_claim_job therefore gains an
-- optional upper bound on priority: null (the default, and what the user worker
-- passes) keeps today's behaviour exactly; a seed instance passes -1 and only
-- ever sees rows with priority <= -1. The user worker still claims everything,
-- and its `order by priority desc` keeps user rows ahead of seed rows.
--
-- The (text, int) overload is dropped rather than left beside the new one: with
-- both present a PostgREST call that names only p_worker_id / p_lease_seconds
-- would match two functions. Existing two-argument callers keep working
-- because the new parameter defaults to null.

drop function if exists public.omr_claim_job (text, int);

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
