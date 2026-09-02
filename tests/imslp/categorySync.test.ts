import { describe, expect, it } from 'vitest';

import {
    applyPageResult,
    categoriesToSync,
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
    });
});

describe('pickNextCategory / planTick', () => {
    const wanted = ['Baroque', 'For piano', 'For piano (arr)'];

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
