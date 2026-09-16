-- Wake the seed-only worker pool (cleffy-omr-seed) while corpus seed rows are
-- queued. Same pg_cron + pg_net + vault pattern as omr_sweep, but:
--
--   * it only counts seed rows (priority < 0) — a user backlog never wakes the
--     seed pool, and omr_sweep keeps poking the user URL exactly as today;
--   * it does not reap or purge (omr_sweep already does both every minute);
--   * it is silent while playalong_corpus_control.paused is true, so flipping
--     that switch drains the pool to zero instances without touching jobs;
--   * it is a no-op until vault holds `omr_seed_service_url` — the seed service
--     is opt-in and this migration is safe to apply before it exists.
--
-- One poke per minute is enough: the worker self-pokes before it responds
-- (server.ts pokeSelf, now priority-filtered) so a single wake fans out to
-- --max-instances within seconds. When the last seed row is claimed the poke
-- stops, in-flight jobs finish, and --min-instances 0 scales the pool to zero.

create or replace function public.omr_seed_sweep ()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
    queued int;
    paused boolean;
    svc_url text;
    svc_secret text;
begin
    select c.paused into paused
    from public.playalong_corpus_control c
    limit 1;
    if coalesce(paused, false) then
        return;
    end if;

    select count(*)::int into queued
    from public.omr_jobs
    where status = 'queued'
      and priority < 0
      and run_after <= now();
    if queued is null or queued <= 0 then
        return;
    end if;

    select decrypted_secret into svc_url
    from vault.decrypted_secrets
    where name = 'omr_seed_service_url'
    limit 1;

    select decrypted_secret into svc_secret
    from vault.decrypted_secrets
    where name = 'omr_service_secret'
    limit 1;

    if svc_url is null or svc_secret is null or length(trim(svc_url)) = 0 then
        -- Seed pool not deployed: seed rows drain on the user worker via omr_sweep.
        return;
    end if;

    perform net.http_post(
        url := rtrim(svc_url, '/') || '/poke',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-omr-secret', svc_secret
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 5000
    );
end;
$$;

revoke all on function public.omr_seed_sweep () from public, anon, authenticated;
grant execute on function public.omr_seed_sweep () to service_role;

do $$
begin
    perform cron.unschedule (jobid)
    from cron.job
    where jobname = 'omr-seed-sweep';
exception
    when undefined_table then null;
    when others then null;
end;
$$;

select cron.schedule ('omr-seed-sweep', '* * * * *', $$select public.omr_seed_sweep ()$$);
