-- Content-hash result cache + timings column on score_analyses.
-- ENGINE_VERSION key invalidates cache automatically on parser/engine bumps.

alter table public.score_analyses
add column if not exists timings jsonb;

create table public.score_cache (
    content_hash text not null,
    engine_version text not null,
    score jsonb not null,
    bpm_default int,
    created_at timestamptz not null default now(),
    last_used_at timestamptz not null default now(),
    use_count int not null default 1,
    primary key (content_hash, engine_version)
);

alter table public.score_cache enable row level security;
-- Zero policies — service_role only.
grant all on public.score_cache to service_role;

create or replace function public.score_cache_get (p_hash text, p_engine_version text)
returns table (score jsonb, bpm_default int)
language plpgsql
security definer
set search_path = public
as $$
begin
    return query
    update public.score_cache sc
    set last_used_at = now(), use_count = sc.use_count + 1
    where sc.content_hash = p_hash
      and sc.engine_version = p_engine_version
    returning sc.score, sc.bpm_default;
end;
$$;

create or replace function public.score_cache_put (
    p_hash text,
    p_engine_version text,
    p_score jsonb,
    p_bpm_default int
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.score_cache (content_hash, engine_version, score, bpm_default)
    values (p_hash, p_engine_version, p_score, p_bpm_default)
    on conflict (content_hash, engine_version) do update
    set
        score = excluded.score,
        bpm_default = excluded.bpm_default,
        last_used_at = now(),
        use_count = public.score_cache.use_count + 1;
end;
$$;

create or replace function public.score_cache_purge_stale (p_max_age_days int default 180)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    deleted int;
begin
    delete from public.score_cache
    where last_used_at < now() - make_interval(days => greatest(p_max_age_days, 1));
    get diagnostics deleted = row_count;
    return deleted;
end;
$$;

revoke all on function public.score_cache_get (text, text) from public, anon, authenticated;
revoke all on function public.score_cache_put (text, text, jsonb, int) from public, anon, authenticated;
revoke all on function public.score_cache_purge_stale (int) from public, anon, authenticated;
grant execute on function public.score_cache_get (text, text) to service_role;
grant execute on function public.score_cache_put (text, text, jsonb, int) to service_role;
grant execute on function public.score_cache_purge_stale (int) to service_role;
