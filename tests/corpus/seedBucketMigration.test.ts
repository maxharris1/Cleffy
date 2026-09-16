import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Security / shape guard for the seed-bucket migration: the shared PD PDF
 * store is service_role-only (bucket without client policies, index table with
 * RLS on and zero policies), its licence and origin values match what the seed
 * script writes, and the ledger gains exactly the resume columns the script
 * checkpoints on.
 */
const sql = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20260916150000_playalong_corpus_seed_bucket.sql'),
    'utf8',
);

describe('20260916150000_playalong_corpus_seed_bucket.sql', () => {
    it('creates the private pd-pdfs bucket with the scores limits and no client policies', () => {
        expect(sql).toContain("values ('pd-pdfs', 'pd-pdfs', false, 52428800, array['application/pdf'])");
        expect(sql).toContain('when insufficient_privilege then');
        expect(sql).not.toMatch(/create policy/i);
    });

    it('indexes the store service_role-only with the seed constraint values', () => {
        expect(sql).toContain('create table public.pd_pdf_store (');
        expect(sql).toContain('pdf_sha256 text primary key');
        expect(sql).toContain("check (origin in ('mutopia', 'openscore', 'ia', 'commons', 'library'))");
        expect(sql).toContain("check (licence_tag in ('PD', 'CC0', 'CC-BY', 'CC-BY-SA'))");
        expect(sql).toContain('us_pd boolean not null');
        expect(sql).toContain('alter table public.pd_pdf_store enable row level security;');
        expect(sql).toContain('grant all on public.pd_pdf_store to service_role;');
        expect(sql).not.toMatch(/grant .* to (authenticated|anon)/i);
    });

    it('adds the ledger resume columns and nothing else to the corpus tables', () => {
        expect(sql).toContain('alter table public.playalong_corpus_seed');
        expect(sql).toContain('add column us_pd boolean');
        expect(sql).toContain('add column attempts smallint not null default 0');
        expect(sql).toContain('add column candidate_url text');
        expect(sql).not.toMatch(/alter table public\.playalong_corpus\b(?!_seed)/);
        expect(sql).not.toMatch(/score_cache/);
    });

    it('records edition signals as jsonb on the ledger and the store (20260916160000)', () => {
        const editions = readFileSync(
            resolve(process.cwd(), 'supabase/migrations/20260916160000_playalong_corpus_edition_signals.sql'),
            'utf8',
        );
        expect(editions).toContain('alter table public.playalong_corpus_seed');
        expect(editions).toContain('alter table public.pd_pdf_store');
        expect(editions.match(/add column edition jsonb/g)).toHaveLength(2);
        expect(editions).not.toMatch(/create policy|grant/i);
    });
});
