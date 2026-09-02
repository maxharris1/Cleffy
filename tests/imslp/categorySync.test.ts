import { describe, expect, it } from 'vitest';

import {
    applyPageResult,
    categoriesToSync,
    parseMemberPage,
    pickNextCategory,
    planTick,
    type CategoryMemberPage,
    type CategorySyncRow,
} from '../../supabase/functions/_shared/categorySync';
import {
    COMPOSER_FACETS,
    ERA_FACETS,
    FORM_FACETS,
    INSTRUMENT_FACETS,
} from '../../supabase/functions/_shared/searchFacetData';

const row = (partial: Partial<CategorySyncRow> & Pick<CategorySyncRow, 'category'>): CategorySyncRow => ({
    state: 'never',
    active_generation: 0,
    building_generation: 0,
    cmcontinue: null,
    pages_done: 0,
    last_error: null,
    completed_at: null,
    updated_at: null,
    ...partial,
});

const page = (title: string, pageid: number): CategoryMemberPage => ({
    title,
    pageid,
    sortkeyprefix: title,
    timestamp: '2026-01-01T00:00:00Z',
});

describe('parseMemberPage', () => {
    // Verbatim shape of imslp.org/api.php?list=categorymembers (MediaWiki 1.18):
    // the next-page token lives under `query-continue`, not `continue`.
    const legacyResponse = {
        query: {
            categorymembers: [
                {
                    pageid: 1497603,
                    ns: 0,
                    title: 'Au bord de la mer, Op.68 (Oberthür, Charles)',
                    sortkeyprefix: 'AU BORD DE LA MER, OP.0068~~OBERTHUR, CHARLES',
                    timestamp: '2019-03-02T11:04:22Z',
                },
                { pageid: 42, ns: 0, title: 'Nocturne (Howe, Mary)' },
            ],
        },
        'query-continue': {
            categorymembers: {
                cmcontinue: 'page|415520424f5244|1497603',
            },
        },
    };

    it('reads the MediaWiki 1.18 query-continue token — the shape IMSLP actually returns', () => {
        const page = parseMemberPage(legacyResponse);
        expect(page.members).toHaveLength(2);
        expect(page.members[0]).toEqual({
            title: 'Au bord de la mer, Op.68 (Oberthür, Charles)',
            pageid: 1497603,
            sortkeyprefix: 'AU BORD DE LA MER, OP.0068~~OBERTHUR, CHARLES',
            timestamp: '2019-03-02T11:04:22Z',
        });
        expect(page.members[1]?.sortkeyprefix).toBeUndefined();
        expect(page.cmcontinue).toBe('page|415520424f5244|1497603');
    });

    it('also accepts the modern continue block', () => {
        const page = parseMemberPage({
            query: { categorymembers: [{ pageid: 1, title: 'Fugue (Bach, Johann Sebastian)' }] },
            continue: { cmcontinue: 'page|00|1', continue: '-||' },
        });
        expect(page.cmcontinue).toBe('page|00|1');
    });

    it('returns a null token only on the last page, and tolerates junk', () => {
        expect(parseMemberPage({ query: { categorymembers: [] } }).cmcontinue).toBeNull();
        expect(parseMemberPage(null)).toEqual({ members: [], cmcontinue: null });
        expect(parseMemberPage({ query: { categorymembers: [{ title: 'no id' }, 'junk'] } }).members).toEqual([]);
    });

    it('a full IMSLP page keeps the sync in the continue state', () => {
        const page = parseMemberPage(legacyResponse);
        const plan = planTick('For piano', undefined);
        const decision = applyPageResult(plan, undefined, page.members, page.cmcontinue, null);
        expect(decision.kind).toBe('continue');
        expect(decision.cmcontinue).toBe('page|415520424f5244|1497603');
    });
});

describe('categoriesToSync', () => {
    it('includes taxonomy categories and instrument (arr) variants as their own rows', () => {
        const cats = categoriesToSync(COMPOSER_FACETS, INSTRUMENT_FACETS, FORM_FACETS, ERA_FACETS);
        expect(cats).toContain('For piano');
        expect(cats).toContain('For piano (arr)');
        expect(cats).toContain('Baroque');
        expect(cats).toContain('Early 20th century');
        expect(cats).toContain('Beethoven, Ludwig van');
        expect(cats).toContain('Fugues');
        expect(cats.filter((c) => c.endsWith('(arr)')).length).toBe(INSTRUMENT_FACETS.length);
        expect(new Set(cats).size).toBe(cats.length);
    });

    it('builds the default instrument, then eras and forms, before the composer tail', () => {
        const cats = categoriesToSync(COMPOSER_FACETS, INSTRUMENT_FACETS, FORM_FACETS, ERA_FACETS, 'For piano');
        expect(cats.slice(0, 2)).toEqual(['For piano', 'For piano (arr)']);
        const idx = (c: string) => cats.indexOf(c);
        expect(idx('Baroque')).toBeLessThan(idx('Sonatas'));
        expect(idx('Sonatas')).toBeLessThan(idx('For violin'));
        expect(idx('For violin')).toBeLessThan(idx('Bach, Johann Sebastian'));
        expect(idx('Beethoven, Ludwig van')).toBeGreaterThan(idx('Modern'));
    });
});

describe('pickNextCategory / planTick', () => {
    const wanted = ['Baroque', 'For piano', 'For piano (arr)'];

    it('breaks ties in list order, not alphabetically, so For piano beats Bach on a cold index', () => {
        const ordered = ['For piano', 'For piano (arr)', 'Baroque', 'Bach, Johann Sebastian'];
        expect(pickNextCategory(ordered, [])).toBe('For piano');
        expect(pickNextCategory(ordered, [row({ category: 'For piano', state: 'ok', active_generation: 1 })])).toBe(
            'For piano (arr)',
        );
    });

    it('prefers never/building over a completed snapshot', () => {
        const next = pickNextCategory(wanted, [
            row({
                category: 'For piano',
                state: 'ok',
                active_generation: 1,
                completed_at: '2026-01-01T00:00:00Z',
            }),
            row({ category: 'Baroque', state: 'never' }),
        ]);
        expect(next).toBe('Baroque');
    });

    it('resumes a building generation at its cursor', () => {
        const building = row({
            category: 'For piano',
            state: 'building',
            active_generation: 1,
            building_generation: 2,
            cmcontinue: 'page|500',
            pages_done: 200,
        });
        expect(planTick('For piano', building)).toEqual({
            category: 'For piano',
            generation: 2,
            cmcontinue: 'page|500',
            pagesDone: 200,
        });
    });
});

describe('applyPageResult rollover', () => {
    const previous = row({
        category: 'Baroque',
        state: 'ok',
        active_generation: 1,
        building_generation: 2,
        completed_at: '2026-01-01T00:00:00Z',
    });
    const plan = planTick('Baroque', {
        ...previous,
        state: 'building',
        cmcontinue: null,
        pages_done: 50,
    });

    it('complete replaces the snapshot and marks older generations for delete', () => {
        const decision = applyPageResult(plan, previous, [page('Toccata (Bach, Johann Sebastian)', 1)], null, null);
        expect(decision.kind).toBe('complete');
        expect(decision.activeGeneration).toBe(2);
        expect(decision.deleteGenerationsBefore).toBe(2);
        expect(decision.cmcontinue).toBeNull();
    });

    it('mid-category failure keeps the old snapshot and marks failed', () => {
        const mid = planTick('Baroque', {
            ...previous,
            state: 'building',
            building_generation: 2,
            cmcontinue: 'page|80',
            pages_done: 80,
        });
        const decision = applyPageResult(mid, previous, [], 'page|80', 'IMSLP API HTTP 429');
        expect(decision.kind).toBe('failed');
        expect(decision.activeGeneration).toBe(1);
        expect(decision.buildingGeneration).toBe(2);
        expect(decision.cmcontinue).toBe('page|80');
        expect(decision.lastError).toBe('IMSLP API HTTP 429');
        expect(decision.deleteGenerationsBefore).toBeNull();
    });

    it('continue persists the cursor without rolling over', () => {
        const decision = applyPageResult(plan, previous, [page('Fugue (Bach, Johann Sebastian)', 2)], 'page|100', null);
        expect(decision.kind).toBe('continue');
        expect(decision.activeGeneration).toBe(1);
        expect(decision.buildingGeneration).toBe(2);
        expect(decision.cmcontinue).toBe('page|100');
        expect(decision.deleteGenerationsBefore).toBeNull();
    });
});
