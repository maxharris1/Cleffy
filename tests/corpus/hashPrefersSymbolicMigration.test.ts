import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Shape guard for the hash-lookup order. An OMR row is keyed by the document
 * era and a symbolic row by '', so both can exist for the same bytes; the
 * lookup must rank the symbolic row first rather than let the era match pin
 * the OMR fallback.
 */
const PATH = resolve(process.cwd(), 'supabase/migrations/20260924120000_playalong_corpus_hash_prefers_symbolic.sql');

describe('20260924120000_playalong_corpus_hash_prefers_symbolic.sql', () => {
    it('exists', () => {
        expect(existsSync(PATH)).toBe(true);
    });

    const sql = existsSync(PATH) ? readFileSync(PATH, 'utf8') : '';

    it('ranks a symbolic row ahead of an OMR row, then the era match', () => {
        expect(sql).toMatch(
            /create or replace function public\.playalong_corpus_get_by_hash \(p_hash text, p_engine_version text, p_era text\)/,
        );
        expect(sql).toContain("order by (c.symbolic_source is distinct from 'omr') desc, (c.era = p_era) desc");
        expect(sql).toContain("and c.era in (p_era, '')");
    });

    it('stays service_role-only', () => {
        expect(sql).toContain(
            'revoke all on function public.playalong_corpus_get_by_hash (text, text, text) from public, anon, authenticated;',
        );
        expect(sql).toContain(
            'grant execute on function public.playalong_corpus_get_by_hash (text, text, text) to service_role;',
        );
        expect(sql).toContain('security definer');
        expect(sql).toContain('set search_path = public');
    });
});
