-- Edition signals for the corpus seed: which edition was chosen for a work and
-- why (typeset vs scan, complete score, IMSLP rating / download count of the
-- matching IMSLP file, and the best IMSLP edition when no bulk source carried
-- it). Stored as one jsonb blob per ledger row / store row so the pick can be
-- revisited without re-crawling. See docs/omr-midi-preload-plan.md and
-- internal/research/imslp-popularity-and-edition-signals.md.

alter table public.playalong_corpus_seed
    add column edition jsonb;

alter table public.pd_pdf_store
    add column edition jsonb;
