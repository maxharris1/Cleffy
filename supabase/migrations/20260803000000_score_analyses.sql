-- Play-along score analyses: one row per document holding the OMR-derived
-- ScoreData (note events split by hand + measure/system geometry in
-- normalized page coordinates) and its processing lifecycle. The row is
-- created 'pending' by the score-analyze Edge Function on behalf of the
-- caller; the OMR service (service role, bypasses RLS) heartbeats
-- 'processing' progress and writes the terminal 'ready'/'failed' state.

create table public.score_analyses (
    document_id uuid primary key references public.documents (id) on delete cascade,
    status text not null check (status in ('pending', 'processing', 'ready', 'failed')),
    error text, -- machine code, e.g. 'omr_timeout', 'no_staves_found' (see services/omr-service/src/errors.ts)
    progress int, -- pages processed so far (service heartbeat; also refreshes updated_at for staleness checks)
    engine_version text,
    bpm_default int,
    score jsonb, -- ScoreData v1 (src/types/scoreData.ts); null until ready
    created_by uuid references auth.users (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create trigger score_analyses_touch before update on public.score_analyses
for each row execute function public.touch_updated_at ();

alter table public.score_analyses enable row level security;

-- Any member may read (viewers can play along); only owner/editor may
-- request or retry an analysis. No delete policy — rows die with the
-- document via the FK cascade.
create policy score_analyses_select on public.score_analyses for select to authenticated
using (public.document_role (document_id) is not null);

create policy score_analyses_insert on public.score_analyses for insert to authenticated
with check (
    public.document_role (document_id) in ('owner', 'editor')
    and created_by = (select auth.uid())
);

create policy score_analyses_update on public.score_analyses for update to authenticated
using (public.document_role (document_id) in ('owner', 'editor'))
with check (public.document_role (document_id) in ('owner', 'editor'));

-- New tables are no longer auto-exposed to the Data API on current projects
-- (see auto_expose_new_tables note in supabase/config.toml) — grant explicitly.
grant select, insert, update on public.score_analyses to authenticated;
grant all on public.score_analyses to service_role;
