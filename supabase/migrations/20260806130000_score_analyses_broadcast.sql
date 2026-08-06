-- Trimmed score_analyses lifecycle fan-out on the existing doc:{id} topic.
-- Never broadcast the score jsonb — only status/error/progress/updated_at.
-- Gate inside the function (INSERT triggers cannot reference OLD in WHEN).

create or replace function public.broadcast_score_analysis_changes () returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if tg_op = 'UPDATE'
       and old.status is not distinct from new.status
       and old.progress is not distinct from new.progress then
        return null;
    end if;

    perform realtime.send(
        jsonb_build_object(
            'table', 'score_analyses',
            'document_id', new.document_id,
            'status', new.status,
            'error', new.error,
            'progress', new.progress,
            'updated_at', new.updated_at
        ),
        'score_analysis', -- event
        'doc:' || new.document_id::text, -- topic
        true -- private
    );
    return null;
end;
$$;

drop trigger if exists score_analyses_broadcast on public.score_analyses;
create trigger score_analyses_broadcast
after insert or update on public.score_analyses
for each row
execute function public.broadcast_score_analysis_changes ();
