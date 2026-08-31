import { describe, expect, it } from 'vitest';

import { isWorkTitle } from '../../supabase/functions/_shared/search';
import {
    bootstrapMembership,
    clausesAreCovered,
    EXTRA_BOOTSTRAP,
    intersectClauses,
} from '../../supabase/functions/_shared/categoryMembership';
import { POPULAR_WORKS } from '../../supabase/functions/_shared/popularWorks';
import {
    browseCategoryClauses,
    ERA_BY_ID,
    FORM_BY_ID,
    INSTRUMENT_BY_ID,
    facetTokens,
    filtersForTypedSearch,
    hardFilterCategories,
    parseFilters,
    primaryBrowseCategory,
    titleMatchesFilters,
} from '../../supabase/functions/_shared/searchFacetData';

describe('parseFilters', () => {
    it('accepts known facet ids', () => {
        expect(parseFilters({ instrument: 'piano', form: 'sonata', key: 'c-minor', era: 'classical' })).toEqual({
            instrument: 'piano',
            form: 'sonata',
            key: 'c-minor',
            era: 'classical',
        });
    });

    it('accepts the split Early 20th century and Modern era ids', () => {
        expect(parseFilters({ era: 'early-20th' })).toEqual({ era: 'early-20th' });
        expect(parseFilters({ era: 'modern' })).toEqual({ era: 'modern' });
    });

    it('drops unknown ids instead of passing them through', () => {
        expect(parseFilters({ instrument: 'kazoo', form: 'jingle', key: 'h-minor', era: 'futurist' })).toEqual({});
    });

    it('drops Object.prototype member names, which are not facet ids', () => {
        expect(parseFilters({ instrument: 'constructor', form: 'toString', key: 'valueOf' })).toEqual({});
        expect(parseFilters({ instrument: '__proto__', form: 'hasOwnProperty' })).toEqual({});
    });

    it('bounds the free-text composer category to a "Surname, First" shape', () => {
        expect(parseFilters({ composerCategory: 'Beethoven, Ludwig van' })).toEqual({
            composerCategory: 'Beethoven, Ludwig van',
        });
        expect(parseFilters({ composerCategory: 'DROP TABLE users;' })).toEqual({});
        expect(parseFilters({ composerCategory: 'x'.repeat(90) })).toEqual({});
    });
});

describe('hardFilterCategories', () => {
    it('returns the instrument category plus its (arr) variant', () => {
        expect(hardFilterCategories({ instrument: 'piano' })).toEqual(['For piano', 'For piano (arr)']);
    });

    it('is empty without an instrument filter', () => {
        expect(hardFilterCategories({ form: 'sonata' })).toEqual([]);
        expect(hardFilterCategories({})).toEqual([]);
    });
});

describe('primaryBrowseCategory', () => {
    it('prefers composer, then form, then instrument', () => {
        expect(
            primaryBrowseCategory({ composerCategory: 'Chopin, Frédéric', form: 'nocturne', instrument: 'piano' }),
        ).toBe('Chopin, Frédéric');
        expect(primaryBrowseCategory({ form: 'nocturne', instrument: 'piano' })).toBe('Nocturnes');
        expect(primaryBrowseCategory({ instrument: 'piano' })).toBe('For piano');
    });
});

describe('titleMatchesFilters', () => {
    it('checks secondary facets against the title', () => {
        const filters = { composerCategory: 'Chopin, Frédéric', key: 'c-sharp-minor' } as const;
        expect(titleMatchesFilters('Nocturne in C-sharp minor (Chopin, Frédéric)', filters)).toBe(true);
        expect(titleMatchesFilters('Nocturne in E-flat major (Chopin, Frédéric)', filters)).toBe(false);
    });

    it('does not require an era surname in the title', () => {
        expect(titleMatchesFilters('Pièces de clavecin (Couperin, François)', { era: 'baroque' })).toBe(true);
        const kept = (title: string) => isWorkTitle(title) && titleMatchesFilters(title, { era: 'baroque' });
        expect(kept('Pièces de clavecin (Couperin, François)')).toBe(true);
        expect(kept('List of works by François Couperin')).toBe(false);
    });
});

describe('facetTokens', () => {
    it('does not inject era composer surnames', () => {
        const tokens = facetTokens({ era: 'baroque' });
        expect(tokens).not.toEqual(expect.arrayContaining(['Bach', 'Vivaldi', 'Handel']));
        expect(tokens.some((t) => /bach|vivaldi|handel/i.test(t))).toBe(false);
    });
});

describe('filtersForTypedSearch', () => {
    it('strips default Piano when it is the only chip', () => {
        expect(filtersForTypedSearch({ instrument: 'piano' })).toEqual({});
    });

    it('keeps Piano when another chip is on, and keeps a chosen instrument', () => {
        expect(filtersForTypedSearch({ instrument: 'piano', form: 'nocturne' })).toEqual({
            instrument: 'piano',
            form: 'nocturne',
        });
        expect(filtersForTypedSearch({ instrument: 'violin' })).toEqual({ instrument: 'violin' });
    });
});

describe('browseCategoryClauses', () => {
    it('ANDs instrument ∪ arr with era and form', () => {
        expect(browseCategoryClauses({ instrument: 'piano', era: 'baroque', form: 'fugue' })).toEqual([
            ['For piano', 'For piano (arr)'],
            ['Fugues'],
            ['Baroque'],
        ]);
    });
});

describe('category membership bootstrap', () => {
    const index = bootstrapMembership(POPULAR_WORKS, {
        instrument: (id) => INSTRUMENT_BY_ID[id]?.category,
        form: (id) => FORM_BY_ID[id]?.category,
        era: (id) => ERA_BY_ID[id]?.category,
    });

    it('Piano · Baroque includes a title that is not Bach/Vivaldi/Handel/Pachelbel', () => {
        const titles = intersectClauses(index, [
            ['For piano', 'For piano (arr)'],
            ['Baroque'],
        ]);
        expect(titles.length).toBeGreaterThan(0);
        expect(titles.some((t) => !/bach|vivaldi|handel|pachelbel/i.test(t))).toBe(true);
        expect(clausesAreCovered(index, [['For piano', 'For piano (arr)'], ['Baroque']])).toBe(true);
    });

    it('puts Debussy on Early 20th century, not Modern', () => {
        const early = intersectClauses(index, [['Early 20th century']]);
        const modern = intersectClauses(index, [['Modern']]);
        expect(early.some((t) => /debussy/i.test(t))).toBe(true);
        expect(modern.some((t) => /debussy/i.test(t))).toBe(false);
        expect(modern.some((t) => EXTRA_BOOTSTRAP.some((e) => e.title === t && e.categories.includes('Modern')))).toBe(
            true,
        );
    });

    it('treats a covered empty triple as empty, not unsynced', () => {
        const clauses = [
            ['For piano', 'For piano (arr)'],
            ['Fugues'],
            ['Modern'],
        ];
        expect(clausesAreCovered(index, clauses)).toBe(true);
        expect(intersectClauses(index, clauses)).toEqual([]);
    });

    it('does not claim coverage for a category that was never seeded', () => {
        expect(clausesAreCovered(index, [['Category that does not exist']])).toBe(false);
    });
});
