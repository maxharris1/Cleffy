import { describe, expect, it } from 'vitest';

import { POPULAR_WORKS, WORK_ALIASES } from '../../supabase/functions/_shared/popularWorks';
import { aliasTitlesForQuery, foldAccents } from '../../supabase/functions/_shared/search';

describe('WORK_ALIASES', () => {
    it('every alias title is an exact POPULAR_WORKS title', () => {
        const titles = new Set(POPULAR_WORKS.map((w) => w.title));
        for (const alias of WORK_ALIASES) {
            expect(titles, `alias "${alias.keys[0]}" points at an unknown title`).toContain(alias.title);
        }
    });

    it('keys are folded lowercase so query matching is exact', () => {
        for (const alias of WORK_ALIASES) {
            for (const key of alias.keys) {
                expect(key).toBe(foldAccents(key));
            }
        }
    });

    it('resolves classic nicknames', () => {
        expect(aliasTitlesForQuery('beethoven tempest', WORK_ALIASES)).toContain(
            'Piano Sonata No.17, Op.31 No.2 (Beethoven, Ludwig van)',
        );
        expect(aliasTitlesForQuery('the moonlight sonata', WORK_ALIASES)).toContain(
            'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)',
        );
        expect(aliasTitlesForQuery('für elise', WORK_ALIASES)).toContain('Für Elise, WoO 59 (Beethoven, Ludwig van)');
        expect(aliasTitlesForQuery('rach 2', WORK_ALIASES)).toContain(
            'Piano Concerto No.2, Op.18 (Rachmaninoff, Sergei)',
        );
    });

    it('returns every matching alias, not just the first', () => {
        const titles = aliasTitlesForQuery('moonlight and pathetique', WORK_ALIASES);
        expect(titles).toHaveLength(2);
    });

    it('does not fire on unrelated queries', () => {
        expect(aliasTitlesForQuery('brahms symphony', WORK_ALIASES)).toEqual([]);
    });
});

describe('POPULAR_WORKS', () => {
    it('still contains the classics the Popular list relies on', () => {
        const labels = POPULAR_WORKS.map((w) => w.label);
        expect(labels).toContain('Moonlight Sonata');
        expect(labels).toContain('Tempest Sonata');
        expect(POPULAR_WORKS.length).toBeGreaterThanOrEqual(100);
    });

    it('titles all carry a composer parenthetical', () => {
        for (const work of POPULAR_WORKS) {
            expect(work.title, work.label).toMatch(/\([^()]*,[^()]*\)\s*$/);
        }
    });
});
