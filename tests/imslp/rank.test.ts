import { describe, expect, it } from 'vitest';

import {
    foldAccents,
    mergeAndRank,
    rankBonus,
    tokenizeQuery,
    type RankBatch,
} from '../../supabase/functions/_shared/search';

const batch = (q: string, weight: number, titles: string[]): RankBatch => ({
    variant: { q, weight },
    hits: titles.map((title, i) => ({ title, pageid: i + 1 })),
});

describe('rankBonus', () => {
    it('decays with position and scales with variant weight', () => {
        expect(rankBonus(0, 1)).toBe(24);
        expect(rankBonus(1, 1)).toBeCloseTo(20.4);
        expect(rankBonus(0, 0.3)).toBeCloseTo(7.2);
    });
});

describe('mergeAndRank', () => {
    it('ranks "beethoven tempest" fixture with Op.31 No.2 first', () => {
        // Modeled on live srwhat=text order: MW already ranks the right sonata
        // top for the full-query variant; the lone "beethoven" variant floods
        // with alphabetical junk that must not win.
        const tempest = 'Piano Sonata No.17, Op.31 No.2 (Beethoven, Ludwig van)';
        const batches = [
            batch('beethoven tempest', 1, [tempest, 'The Tempest, Op.31 (Arensky, Anton)']),
            batch('tempest', 0.3, ['The Tempest, Op.109 (Sibelius, Jean)', tempest]),
        ];
        const ranked = mergeAndRank(batches, {
            query: 'beethoven tempest',
            tokens: tokenizeQuery('beethoven tempest'),
        });
        expect(ranked[0]?.title).toBe(tempest);
    });

    it('lets the popularity prior lead composer-only queries with famous works', () => {
        const ballade = 'Ballade No.1, Op.23 (Chopin, Frédéric)';
        const obscure = 'Album Leaf in E major (Chopin, Frédéric)';
        // Same MW batch, obscure page listed FIRST (alphabetical-style tie today).
        const batches = [batch('chopin', 1, [obscure, ballade])];
        const ranked = mergeAndRank(batches, {
            query: 'chopin',
            tokens: tokenizeQuery('chopin'),
            popularTitles: new Set([foldAccents(ballade)]),
        });
        expect(ranked[0]?.title).toBe(ballade);
    });

    it('drops list and wishlist noise pages', () => {
        const batches = [
            batch('beethoven', 1, [
                'List of works by Ludwig van Beethoven',
                'Wishlist A-B',
                'Symphony No.5, Op.67 (Beethoven, Ludwig van)',
            ]),
        ];
        const ranked = mergeAndRank(batches, { query: 'beethoven', tokens: ['beethoven'] });
        expect(ranked.map((h) => h.title)).toEqual(['Symphony No.5, Op.67 (Beethoven, Ludwig van)']);
    });

    it('boosts alias canonical titles to the top', () => {
        const moonlight = 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)';
        const batches = [
            batch('moonlight sonata', 1, ['Moonlight Serenade (Smith, John)', moonlight]),
            { variant: { q: '__alias__', weight: 0 }, hits: [{ title: moonlight, pageid: 0 }] },
        ];
        const ranked = mergeAndRank(batches, {
            query: 'moonlight sonata',
            tokens: tokenizeQuery('moonlight sonata'),
            aliasTitles: [moonlight],
        });
        expect(ranked[0]?.title).toBe(moonlight);
    });

    it('applies redirect resolution and backfills pageids for alias injections', () => {
        const canonical = 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)';
        const batches: RankBatch[] = [
            { variant: { q: '__alias__', weight: 0 }, hits: [{ title: canonical, pageid: 0 }] },
            batch('moonlight', 1, ['Moonlight Sonata (Beethoven, Ludwig van)']),
        ];
        const ranked = mergeAndRank(batches, {
            query: 'moonlight',
            tokens: ['moonlight'],
            resolvedTitles: new Map([['Moonlight Sonata (Beethoven, Ludwig van)', canonical]]),
            resolvedPageIds: new Map([[canonical, 4321]]),
        });
        expect(ranked).toHaveLength(1);
        expect(ranked[0]?.pageid).toBe(4321);
    });

    it('hard-filters to category members when required and prefers originals over (arr)', () => {
        const original = 'Nocturnes, Op.9 (Chopin, Frédéric)';
        const arrangement = 'Violin Concerto, Op.35 (Tchaikovsky, Pyotr)';
        const excluded = 'Symphony No.5, Op.64 (Tchaikovsky, Pyotr)';
        const batches = [batch('nocturne', 1, [excluded, arrangement, original])];
        const categoryHits = new Map([
            [foldAccents(original), new Set(['For piano'])],
            [foldAccents(arrangement), new Set(['For piano (arr)'])],
        ]);
        const ranked = mergeAndRank(batches, {
            query: 'nocturne',
            tokens: ['nocturne'],
            categoryHits,
            requiredGroups: [['For piano', 'For piano (arr)']],
        });
        expect(ranked.map((h) => h.title)).not.toContain(excluded);
        expect(ranked[0]?.title).toBe(original);
    });

    it('requires every group — For piano membership does not satisfy a Baroque chip', () => {
        const baroquePiano = 'Suite No.6 in E-flat major (Mattheson, Johann)';
        const pianoOnly = 'Suite bergamasque, CD 82 (Debussy, Claude)';
        const baroqueOnly = 'Ouverture-Suite, TWV 55:e8 (Telemann, Georg Philipp)';
        const batches = [batch('suite', 1, [pianoOnly, baroqueOnly, baroquePiano])];
        const categoryHits = new Map([
            [foldAccents(baroquePiano), new Set(['For piano (arr)', 'Baroque'])],
            [foldAccents(pianoOnly), new Set(['For piano'])],
            [foldAccents(baroqueOnly), new Set(['Baroque'])],
        ]);
        const ranked = mergeAndRank(batches, {
            query: 'suite',
            tokens: ['suite'],
            categoryHits,
            requiredGroups: [['For piano', 'For piano (arr)'], ['Baroque']],
        });
        expect(ranked.map((h) => h.title)).toEqual([baroquePiano]);
    });

    it('keeps hits whose category lookup failed rather than treating them as non-members', () => {
        const member = 'Nocturnes, Op.9 (Chopin, Frédéric)';
        const unknown = 'Nocturne in C-sharp minor, B.49 (Chopin, Frédéric)';
        const nonMember = 'Symphony No.5, Op.64 (Tchaikovsky, Pyotr)';
        const batches = [batch('nocturne', 1, [member, unknown, nonMember])];
        const ranked = mergeAndRank(batches, {
            query: 'nocturne',
            tokens: ['nocturne'],
            categoryHits: new Map([[foldAccents(member), new Set(['For piano'])]]),
            unverifiedTitles: new Set([foldAccents(unknown)]),
            requiredGroups: [['For piano', 'For piano (arr)']],
        });
        expect(ranked.map((h) => h.title)).toEqual([member, unknown]);
    });

    it('keeps everything when no groups are required (relaxed mode)', () => {
        const titles = ['A (Composer, One)', 'B (Composer, Two)'];
        const batches = [batch('q', 1, titles)];
        for (const requiredGroups of [[], undefined, [[]]]) {
            const ranked = mergeAndRank(batches, {
                query: 'q',
                tokens: [],
                categoryHits: new Map(),
                requiredGroups,
            });
            expect(ranked).toHaveLength(2);
        }
    });

    it('does not let "Op." and "No." stop tokens trigger the all-tokens bonus', () => {
        const irrelevant = 'Nocturne in B major, Op.62 No.1 (Chopin, Frédéric)';
        const ranked = mergeAndRank([batch('op no', 1, [irrelevant])], {
            query: 'op no',
            tokens: tokenizeQuery('op no'),
        });
        // Only the rank bonus survives — no token score, no all-tokens bonus.
        expect(ranked[0]?.score).toBeLessThanOrEqual(24);
    });
});
