-- Clients (owner/editor via user JWT, including score-analyze) may only
-- request/retry analyses. They must not forge status='ready' or write ScoreData.
-- The OMR service uses the service_role JWT and retains full write access.

create or replace function public.guard_score_analyses_client_write()
returns trigger
language plpgsql
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

drop trigger if exists score_analyses_client_write_guard on public.score_analyses;
create trigger score_analyses_client_write_guard
before insert or update on public.score_analyses
for each row
execute function public.guard_score_analyses_client_write();
