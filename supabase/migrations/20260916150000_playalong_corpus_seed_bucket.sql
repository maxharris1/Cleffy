-- Play-along corpus seed: the shared public-domain PDF store and the ledger
-- columns the offline seed script (scripts/seed-playalong-corpus.mjs) needs.
-- See docs/omr-midi-preload-plan.md, Phase 2 / 2b / 2d.
--
-- `pd-pdfs` holds every PDF the seed ingested from a bulk-friendly public
-- source (Mutopia / OpenScore / Internet Archive), keyed `{sha256}/{filename}`
-- so the same bytes are stored once. It is service-role only: a user who picks
-- a corpus work gets a Storage copy into `scores/{docId}/original.pdf`, so
-- there is never a client read of this bucket and never an IMSLP fetch.
--
-- Every statement here is guarded (`if not exists` / `on conflict do nothing`)
-- because production received this schema out-of-band ahead of the merge: the
-- objects already exist there, so an unguarded `create` or `add column` would
-- fail the deploy. On a fresh database the guards change nothing.

-- ---------------------------------------------------------------------------
-- pd-pdfs bucket (no client policies; service_role bypasses storage RLS)
-- ---------------------------------------------------------------------------
do $$
begin
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('pd-pdfs', 'pd-pdfs', false, 52428800, array['application/pdf'])
    on conflict (id) do nothing;
exception
    when insufficient_privilege then
        -- Hosted projects may refuse storage.buckets writes from a migration
        -- (SQLSTATE 42501); create the bucket by hand in the dashboard.
        raise notice 'pd-pdfs bucket not created here (%): create it in the dashboard', sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------------
-- pd_pdf_store: index of what is in the bucket, with provenance per file
-- ---------------------------------------------------------------------------
create table if not exists public.pd_pdf_store (
    pdf_sha256 text primary key,
    filename text not null,
    -- IMSLP work page title: identity for ranking / the corpus-first client path.
    work_title text not null,
    origin text not null check (origin in ('mutopia', 'openscore', 'ia', 'commons', 'library')),
    source_url text,
    licence_tag text not null check (licence_tag in ('PD', 'CC0', 'CC-BY', 'CC-BY-SA')),
    editor_credit text,
    us_pd boolean not null,
    byte_length int not null,
    page_count int,
    created_at timestamptz not null default now()
);

create index if not exists pd_pdf_store_work_title_idx on public.pd_pdf_store (work_title);

alter table public.pd_pdf_store enable row level security;
-- Zero policies — service_role only, like playalong_corpus.
grant all on public.pd_pdf_store to service_role;

-- ---------------------------------------------------------------------------
-- Ledger columns the seed script checkpoints on
-- ---------------------------------------------------------------------------
alter table public.playalong_corpus_seed
    add column if not exists us_pd boolean,
    -- Fetch / enqueue attempts for this row; the script stops retrying at 3.
    add column if not exists attempts smallint not null default 0,
    -- Optional symbolic-source URL (Mutopia .mid / OpenScore .mxl) next to the PDF.
    add column if not exists candidate_url text;
