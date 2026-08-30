import { describe, expect, it } from 'vitest';

import {
    hardFilterCategories,
    parseFilters,
    primaryBrowseCategory,
    titleMatchesFilters,
} from '../../supabase/functions/_shared/searchFacetData';
import { isWorkTitle } from '../../supabase/functions/_shared/search';

describe('parseFilters', () => {
    it('accepts known facet ids', () => {
        expect(parseFilters({ instrument: 'piano', form: 'sonata', key: 'c-minor', era: 'classical' })).toEqual({
            instrument: 'piano',
            form: 'sonata',
            key: 'c-minor',
            era: 'classical',
        });
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

    it('needs the isWorkTitle guard too — an era seed surname alone lets index pages through', () => {
        // Mirrors the era/key-only browse filter, which seeds a body-text search.
        const filters = { era: 'romantic' } as const;
        expect(titleMatchesFilters('List of works by Frédéric Chopin', filters)).toBe(true);
        const kept = (title: string) => isWorkTitle(title) && titleMatchesFilters(title, filters);
        expect(kept('Nocturnes, Op.9 (Chopin, Frédéric)')).toBe(true);
        expect(kept('List of works by Frédéric Chopin')).toBe(false);
    });
});
