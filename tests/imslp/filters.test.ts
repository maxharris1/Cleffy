import { describe, expect, it } from 'vitest';

import {
    categoryGroupsFor,
    categoriesInGroups,
    ERA_FACETS,
    hardFilterCategories,
    hardFilterGroups,
    parseFilters,
    titleMatchesFilters,
} from '../../supabase/functions/_shared/searchFacetData';
import { isWorkTitle } from '../../supabase/functions/_shared/search';

describe('parseFilters', () => {
    it('accepts known facet ids as arrays', () => {
        expect(
            parseFilters({ instruments: ['piano'], forms: ['sonata'], keys: ['c-minor'], eras: ['classical'] }),
        ).toEqual({
            instruments: ['piano'],
            forms: ['sonata'],
            keys: ['c-minor'],
            eras: ['classical'],
        });
    });

    it('accepts legacy singular fields and maps them to arrays', () => {
        expect(parseFilters({ instrument: 'piano', form: 'sonata', key: 'c-minor', era: 'classical' })).toEqual({
            instruments: ['piano'],
            forms: ['sonata'],
            keys: ['c-minor'],
            eras: ['classical'],
        });
    });

    it('accepts early-20th and modern and drops unknown era ids', () => {
        expect(parseFilters({ era: 'early-20th' })).toEqual({ eras: ['early-20th'] });
        expect(parseFilters({ era: 'modern' })).toEqual({ eras: ['modern'] });
        expect(parseFilters({ era: 'futurist' })).toEqual({});
    });

    it('dedupes and caps at 6 per dimension', () => {
        expect(
            parseFilters({
                instruments: ['piano', 'piano', 'violin', 'cello', 'guitar', 'flute', 'organ', 'orchestra'],
            }),
        ).toEqual({
            instruments: ['piano', 'violin', 'cello', 'guitar', 'flute', 'organ'],
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
            composerCategories: ['Beethoven, Ludwig van'],
        });
        expect(parseFilters({ composerCategory: 'DROP TABLE users;' })).toEqual({});
        expect(parseFilters({ composerCategory: 'x'.repeat(90) })).toEqual({});
    });
});

describe('ERA_FACETS', () => {
    it('exposes five IMSLP period categories including Early 20th century', () => {
        expect(ERA_FACETS.map((e) => e.id)).toEqual(['baroque', 'classical', 'romantic', 'early-20th', 'modern']);
        expect(ERA_FACETS.map((e) => e.category)).toEqual([
            'Baroque',
            'Classical',
            'Romantic',
            'Early 20th century',
            'Modern',
        ]);
    });
});

describe('hardFilterCategories', () => {
    it('returns the instrument category plus its (arr) variant', () => {
        expect(hardFilterCategories({ instruments: ['piano'] })).toEqual(['For piano', 'For piano (arr)']);
    });

    it('unions instrument and era categories', () => {
        expect(hardFilterCategories({ instruments: ['piano'], eras: ['baroque'] })).toEqual([
            'For piano',
            'For piano (arr)',
            'Baroque',
        ]);
    });

    it('is empty without an instrument or era filter', () => {
        expect(hardFilterCategories({ forms: ['sonata'] })).toEqual([]);
        expect(hardFilterCategories({})).toEqual([]);
    });
});

describe('hardFilterGroups', () => {
    it('keeps instrument and era as separate AND groups', () => {
        expect(hardFilterGroups({ instruments: ['piano'], eras: ['baroque'] })).toEqual([
            ['For piano', 'For piano (arr)'],
            ['Baroque'],
        ]);
    });

    it('ORs several values inside one dimension', () => {
        expect(hardFilterGroups({ instruments: ['piano', 'organ'], eras: ['baroque', 'classical'] })).toEqual([
            ['For piano', 'For piano (arr)', 'For organ', 'For organ (arr)'],
            ['Baroque', 'Classical'],
        ]);
    });

    it('emits no group for a dimension that is not set', () => {
        expect(hardFilterGroups({ eras: ['romantic'] })).toEqual([['Romantic']]);
        expect(hardFilterGroups({ forms: ['sonata'], keys: ['c-major'] })).toEqual([]);
    });
});

describe('categoryGroupsFor', () => {
    it('builds For piano ∩ Baroque as two UNION groups', () => {
        expect(categoryGroupsFor({ instruments: ['piano'], eras: ['baroque'] })).toEqual([
            ['For piano', 'For piano (arr)'],
            ['Baroque'],
        ]);
    });

    it('unions two composers in one group (OR within a dimension)', () => {
        expect(
            categoryGroupsFor({
                composerCategories: ['Bach, Johann Sebastian', 'Beethoven, Ludwig van'],
            }),
        ).toEqual([['Bach, Johann Sebastian', 'Beethoven, Ludwig van']]);
    });

    it('does not emit a group for key', () => {
        expect(categoryGroupsFor({ instruments: ['piano'], keys: ['c-minor'] })).toEqual([
            ['For piano', 'For piano (arr)'],
        ]);
    });
});

/** Fixture INTERSECT — same rule as imslp_browse (UNION within a group). */
const intersectGroups = (groups: string[][], members: Record<string, string[]>): string[] => {
    if (groups.length === 0) {
        return [];
    }
    const sets = groups.map((group) => {
        const titles = new Set<string>();
        for (const category of group) {
            for (const title of members[category] ?? []) {
                titles.add(title);
            }
        }
        return titles;
    });
    const [first, ...rest] = sets;
    if (!first) {
        return [];
    }
    return [...first].filter((title) => rest.every((s) => s.has(title)));
};

describe('browse intersection (fixture)', () => {
    const members: Record<string, string[]> = {
        'For piano': [
            'Goldberg Variations, BWV 988 (Bach, Johann Sebastian)',
            'Sonata in D minor, K.9 (Scarlatti, Domenico)',
            'Nocturnes, Op.9 (Chopin, Frédéric)',
        ],
        'For piano (arr)': ['Messiah, HWV 56 (Handel, George Frideric)'],
        Baroque: [
            'Goldberg Variations, BWV 988 (Bach, Johann Sebastian)',
            'Sonata in D minor, K.9 (Scarlatti, Domenico)',
            'Messiah, HWV 56 (Handel, George Frideric)',
            'Le quattro stagioni (Vivaldi, Antonio)',
        ],
        Fugues: ['Toccata and Fugue in D minor, BWV 565 (Bach, Johann Sebastian)'],
        Modern: ['Structures I (Boulez, Pierre)'],
    };

    it('For piano ∩ Baroque is non-empty and includes a non-seed surname (AE1)', () => {
        const groups = categoryGroupsFor({ instruments: ['piano'], eras: ['baroque'] });
        const titles = intersectGroups(groups, members);
        expect(titles.length).toBeGreaterThan(0);
        expect(titles.some((t) => t.includes('Scarlatti'))).toBe(true);
        expect(titles.some((t) => t.includes('Chopin'))).toBe(false);
    });

    it('three-way Piano · Fugue · Modern is an honest empty (AE4)', () => {
        const groups = categoryGroupsFor({ instruments: ['piano'], forms: ['fugue'], eras: ['modern'] });
        expect(intersectGroups(groups, members)).toEqual([]);
    });

    it('missing snapshot categories are distinguishable from an empty intersection', () => {
        const groups = categoryGroupsFor({ instruments: ['piano'], eras: ['baroque'] });
        const ready = new Set(['For piano', 'For piano (arr)']);
        const missing = categoriesInGroups(groups).filter((c) => !ready.has(c));
        expect(missing).toEqual(['Baroque']);
        expect(intersectGroups(groups, { 'For piano': [], 'For piano (arr)': [], Baroque: [] })).toEqual([]);
    });
});

describe('titleMatchesFilters', () => {
    it('checks key chips against the title (OR within the dimension)', () => {
        const filters = { keys: ['c-sharp-minor'] };
        expect(titleMatchesFilters('Nocturne in C-sharp minor (Chopin, Frédéric)', filters)).toBe(true);
        expect(titleMatchesFilters('Nocturne in E-flat major (Chopin, Frédéric)', filters)).toBe(false);
    });

    it('does not require an era surname in the title', () => {
        const filters = { eras: ['baroque' as const] };
        expect(titleMatchesFilters('Sonata in D minor, K.9 (Scarlatti, Domenico)', filters)).toBe(true);
        expect(isWorkTitle('List of works by Frédéric Chopin')).toBe(false);
    });
});
