-- Play-along corpus: shared, precomputed ScoreData (+ AlignmentMap) for
-- public-domain / CC PDFs, keyed by the PDF's sha256 so a second copy of the
-- same file — or, by layout, another engraving of the same work — never
-- re-runs Audiveris or fetches Mutopia. `score_cache` stays the per-hash OMR
-- byte-cache (180-day purge); this table is the MIDI/XML + alignment store and
-- the OMR seed store, and is never purged. Rows are only ever derived from
-- public sources (Mutopia/OpenScore/IA/Commons/library scans or IMSLP-import /
-- corpus-owner documents) — never from a user upload. See
-- docs/omr-midi-preload-plan.md.

create table public.playalong_corpus (
    pdf_sha256 text not null,
    -- Bare ENGINE_VERSION (not the score_cache `#era=` key); the era is a column.
    engine_version text not null,
    -- '' for symbolic rows (era-independent); eraForDocument for OMR rows.
    era text not null default '',
    work_composer_id text,
    work_catalog_type text,
    work_catalog_n int,
    work_movement_index int,
    printed_bars int,
    page_count int,
    layout_fp text,
    score jsonb not null,
    alignment_map jsonb,
    -- AnalysisSource plus provenance (origin, licence_tag, editor_credit, …).
    source jsonb not null,
    candidate_sha256 text,
    candidate_url text,
    symbolic_source text check (symbolic_source in ('mutopia', 'openscore', 'ia', 'omr')),
    symbolic_format text,
    -- Work identity for ranking / discover only; never a fetch URL.
    imslp_page_title text,
    licence_tag text check (licence_tag in ('PD', 'CC0', 'CC-BY', 'CC-BY-SA')),
    editor_credit text,
    source_url text,
    created_at timestamptz not null default now(),
    last_used_at timestamptz not null default now(),
    use_count int not null default 1,
    primary key (pdf_sha256, engine_version, era)
);

-- Layout lookup filters on these before it ever touches `score`.
create index playalong_corpus_layout_idx on public.playalong_corpus (
    engine_version,
    work_composer_id,
    work_catalog_type,
    work_catalog_n,
    printed_bars
);

alter table public.playalong_corpus enable row level security;
-- Zero policies — service_role only, like score_cache.
grant all on public.playalong_corpus to service_role;

-- Seed ledger: one row per (work, origin, file) the offline seed script has
-- looked at; `status` is the resume checkpoint.
create table public.playalong_corpus_seed (
    work_title text not null,
    origin text not null,
    filename text not null,
    document_id uuid,
    tier smallint not null default 0,
    status text not null default 'pending'
        check (status in ('pending', 'fetched', 'queued', 'ready', 'skipped', 'failed', 'paused')),
    source_url text,
    licence_tag text,
    editor_credit text,
    last_error text,
    pdf_sha256 text,
    page_count int,
    batch_id int,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (work_title, origin, filename)
);

alter table public.playalong_corpus_seed enable row level security;
grant all on public.playalong_corpus_seed to service_role;

-- Kill switch for the seed crawl. Single row; `paused` stops the script.
create table public.playalong_corpus_control (
    singleton boolean primary key default true check (singleton),
    paused boolean not null default false,
    updated_at timestamptz not null default now()
);

alter table public.playalong_corpus_control enable row level security;
grant all on public.playalong_corpus_control to service_role;

insert into public.playalong_corpus_control (paused) values (false);

-- Hash lookup: the same PDF bytes under this engine. Prefer the row for this
-- era, else the era-independent symbolic row (''). Bumps usage like score_cache_get.
create or replace function public.playalong_corpus_get_by_hash (p_hash text, p_engine_version text, p_era text)
returns setof public.playalong_corpus
language plpgsql
security definer
set search_path = public
as $$
declare
    hit public.playalong_corpus%rowtype;
begin
    select c.* into hit
    from public.playalong_corpus c
    where c.pdf_sha256 = p_hash
      and c.engine_version = p_engine_version
      and c.era in (p_era, '')
    order by (c.era = p_era) desc
    limit 1;
    if not found then
        return;
    end if;

    update public.playalong_corpus c
    set last_used_at = now(), use_count = c.use_count + 1
    where c.pdf_sha256 = hit.pdf_sha256
      and c.engine_version = hit.engine_version
      and c.era = hit.era
    returning c.* into hit;
    return next hit;
end;
$$;

-- Layout lookup: another engraving of the same work with exactly the same
-- printed bar count and page count. Counts distinct PDFs on the indexed columns
-- first so `score` is only ever read for the one winner; two or more editions
-- is a collision and returns nothing (the caller falls through to discover).
create or replace function public.playalong_corpus_get_by_layout (
    p_engine_version text,
    p_work_composer_id text,
    p_work_catalog_type text,
    p_work_catalog_n int,
    p_work_movement_index int,
    p_printed_bars int,
    p_page_count int
) returns setof public.playalong_corpus
language plpgsql
security definer
set search_path = public
as $$
declare
    editions int;
    hit public.playalong_corpus%rowtype;
begin
    if p_work_composer_id is null or p_work_composer_id = 'unknown' or p_work_catalog_n is null or p_printed_bars is null or p_page_count is null then
        return;
    end if;

    select count(distinct c.pdf_sha256) into editions
    from public.playalong_corpus c
    where c.engine_version = p_engine_version
      and c.work_composer_id = p_work_composer_id
      and c.work_catalog_type = p_work_catalog_type
      and c.work_catalog_n = p_work_catalog_n
      and c.work_movement_index is not distinct from p_work_movement_index
      and c.printed_bars = p_printed_bars
      and c.page_count = p_page_count;
    if editions <> 1 then
        return;
    end if;

    select c.* into hit
    from public.playalong_corpus c
    where c.engine_version = p_engine_version
      and c.work_composer_id = p_work_composer_id
      and c.work_catalog_type = p_work_catalog_type
      and c.work_catalog_n = p_work_catalog_n
      and c.work_movement_index is not distinct from p_work_movement_index
      and c.printed_bars = p_printed_bars
      and c.page_count = p_page_count
    order by (c.era = '') desc, c.use_count desc, c.created_at
    limit 1;

    update public.playalong_corpus c
    set last_used_at = now(), use_count = c.use_count + 1
    where c.pdf_sha256 = hit.pdf_sha256
      and c.engine_version = hit.engine_version
      and c.era = hit.era
    returning c.* into hit;
    return next hit;
end;
$$;

-- Upsert. A Mutopia/OpenScore symbolic row is never overwritten by an OMR row
-- for the same engine (a new engine_version is a new primary key, so the
-- rebuild still lands). Returns whether the row was written.
create or replace function public.playalong_corpus_put (
    p_pdf_sha256 text,
    p_engine_version text,
    p_era text,
    p_score jsonb,
    p_source jsonb,
    p_alignment_map jsonb default null,
    p_work_composer_id text default null,
    p_work_catalog_type text default null,
    p_work_catalog_n int default null,
    p_work_movement_index int default null,
    p_printed_bars int default null,
    p_page_count int default null,
    p_layout_fp text default null,
    p_candidate_sha256 text default null,
    p_candidate_url text default null,
    p_symbolic_source text default null,
    p_symbolic_format text default null,
    p_imslp_page_title text default null,
    p_licence_tag text default null,
    p_editor_credit text default null,
    p_source_url text default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    written int;
begin
    insert into public.playalong_corpus as c (
        pdf_sha256, engine_version, era, score, source, alignment_map,
        work_composer_id, work_catalog_type, work_catalog_n, work_movement_index,
        printed_bars, page_count, layout_fp,
        candidate_sha256, candidate_url, symbolic_source, symbolic_format,
        imslp_page_title, licence_tag, editor_credit, source_url
    )
    values (
        p_pdf_sha256, p_engine_version, coalesce(p_era, ''), p_score, p_source, p_alignment_map,
        p_work_composer_id, p_work_catalog_type, p_work_catalog_n, p_work_movement_index,
        p_printed_bars, p_page_count, p_layout_fp,
        p_candidate_sha256, p_candidate_url, p_symbolic_source, p_symbolic_format,
        p_imslp_page_title, p_licence_tag, p_editor_credit, p_source_url
    )
    on conflict (pdf_sha256, engine_version, era) do update
    set
        score = excluded.score,
        source = excluded.source,
        alignment_map = excluded.alignment_map,
        work_composer_id = coalesce(excluded.work_composer_id, c.work_composer_id),
        work_catalog_type = coalesce(excluded.work_catalog_type, c.work_catalog_type),
        work_catalog_n = coalesce(excluded.work_catalog_n, c.work_catalog_n),
        work_movement_index = coalesce(excluded.work_movement_index, c.work_movement_index),
        printed_bars = coalesce(excluded.printed_bars, c.printed_bars),
        page_count = coalesce(excluded.page_count, c.page_count),
        layout_fp = coalesce(excluded.layout_fp, c.layout_fp),
        candidate_sha256 = excluded.candidate_sha256,
        candidate_url = excluded.candidate_url,
        symbolic_source = excluded.symbolic_source,
        symbolic_format = excluded.symbolic_format,
        imslp_page_title = coalesce(excluded.imslp_page_title, c.imslp_page_title),
        licence_tag = coalesce(excluded.licence_tag, c.licence_tag),
        editor_credit = coalesce(excluded.editor_credit, c.editor_credit),
        source_url = coalesce(excluded.source_url, c.source_url),
        last_used_at = now(),
        use_count = c.use_count + 1
    where not (c.symbolic_source in ('mutopia', 'openscore') and excluded.symbolic_source = 'omr');
    get diagnostics written = row_count;
    return written > 0;
end;
$$;

revoke all on function public.playalong_corpus_get_by_hash (text, text, text) from public, anon, authenticated;
revoke all on function public.playalong_corpus_get_by_layout (text, text, text, int, int, int, int) from public, anon, authenticated;
revoke all on function public.playalong_corpus_put (
    text, text, text, jsonb, jsonb, jsonb, text, text, int, int, int, int, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.playalong_corpus_get_by_hash (text, text, text) to service_role;
grant execute on function public.playalong_corpus_get_by_layout (text, text, text, int, int, int, int) to service_role;
grant execute on function public.playalong_corpus_put (
    text, text, text, jsonb, jsonb, jsonb, text, text, int, int, int, int, text, text, text, text, text, text, text, text, text
) to service_role;
