-- OMR sweeper: enable pg_cron + pg_net, reap expired leases, wake workers.
-- Vault secrets omr_service_url / omr_service_secret must be created out-of-band
-- (see SETUP_SUPABASE.md). If missing, the poke is a no-op; reap still runs.
--
-- Day-one check (2026-08-06): pg_cron 1.6.4 and pg_net 0.20.4 available but
-- not installed; supabase_vault already installed. Enabling both here.
-- Fallback if enable fails on a future project: Cloud Scheduler → POST /poke
-- and have the worker call omr_reap_expired_leases() at the top of each poke.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create or replace function public.omr_sweep ()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
    queued int;
    svc_url text;
    svc_secret text;
begin
    queued := public.omr_reap_expired_leases ();
    perform public.score_cache_purge_stale (180);

    if queued is null or queued <= 0 then
        return;
    end if;

    select decrypted_secret into svc_url
    from vault.decrypted_secrets
    where name = 'omr_service_url'
    limit 1;

    select decrypted_secret into svc_secret
    from vault.decrypted_secrets
    where name = 'omr_service_secret'
    limit 1;

    if svc_url is null or svc_secret is null or length(trim(svc_url)) = 0 then
        raise notice 'omr_sweep: vault secrets omr_service_url/omr_service_secret missing — skip poke';
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

revoke all on function public.omr_sweep () from public, anon, authenticated;
grant execute on function public.omr_sweep () to service_role;

-- Schedule every minute. Unschedule prior job of the same name if re-applied.
do $$
begin
    perform cron.unschedule (jobid)
    from cron.job
    where jobname = 'omr-sweep';
exception
    when undefined_table then null;
    when others then null;
end;
$$;

select cron.schedule ('omr-sweep', '* * * * *', $$select public.omr_sweep ()$$);
