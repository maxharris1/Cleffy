-- Play-along corpus: allow `imslp` as a pd_pdf_store / seed-ledger origin.
-- The seed script can fetch one IMSLP PDF at a time via the same wait-page →
-- CDN parse the live import uses (`extractCdnUrlFromWaitPage`); it does not
-- sleep the 15s upsell. See scripts/seed-playalong-corpus.mjs `--source imslp`.
--
-- Idempotent: drop the origin check if present, then re-add it with `imslp`.
-- Production already has `pd_pdf_store` from an earlier migration (or the
-- out-of-band apply); this only widens the check. Ledger `origin` is unconstrained
-- text and already accepts `imslp`.

alter table public.pd_pdf_store drop constraint if exists pd_pdf_store_origin_check;

alter table public.pd_pdf_store
    add constraint pd_pdf_store_origin_check
    check (origin in ('mutopia', 'openscore', 'ia', 'commons', 'library', 'imslp'));
