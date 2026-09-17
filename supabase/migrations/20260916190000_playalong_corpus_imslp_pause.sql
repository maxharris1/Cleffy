-- Corpus seed: record why and until when the IMSLP source paused itself.
-- After three consecutive bot checks / captchas / disclaimer walls the seed
-- stops using imslp.org for 24h and writes the reason here; the other sources
-- keep running. Clearing `imslp_paused_until` resumes. Idempotent like the
-- other corpus migrations (production may already have the columns).

alter table public.playalong_corpus_control
    add column if not exists imslp_paused_until timestamptz,
    add column if not exists imslp_pause_reason text;
