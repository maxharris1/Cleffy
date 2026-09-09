import { describe, expect, it } from 'vitest';

import {
    ALL_TAXONOMY_CATEGORIES,
    browseCategoryGroupsFor,
    categoryGroupsFor,
    categoriesInGroups,
    ERA_FACETS,
    hardFilterCategories,
    hardFilterGroups,
    KEY_FACETS,
    parseFilters,
    titleMatchesFilters,
} from '../../supabase/functions/_shared/searchFacetData';
import { browseFromIndex, readinessFor, type BrowseRpcClient } from '../../supabase/functions/_shared/imslpBrowse';
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

    it('does not put keys in typed-search groups — those stay title-only', () => {
        expect(categoryGroupsFor({ instruments: ['piano'], keys: ['c-minor', 'c-sharp-minor'] })).toEqual([
            ['For piano', 'For piano (arr)'],
        ]);
    });

    it('browse groups bind key chips to IMSLP key categories', () => {
        expect(browseCategoryGroupsFor({ instruments: ['piano'], keys: ['c-minor', 'c-sharp-minor'] })).toEqual([
            ['For piano', 'For piano (arr)'],
            ['C minor', 'C-sharp minor'],
        ]);
    });

    it('orders browse groups composer, instrument, form, key, era', () => {
        expect(
            browseCategoryGroupsFor({
                composerCategories: ['Chopin, Frédéric'],
                instruments: ['piano'],
                forms: ['nocturne'],
                keys: ['e-flat-major'],
                eras: ['romantic'],
            }),
        ).toEqual([['Chopin, Frédéric'], ['For piano', 'For piano (arr)'], ['Nocturnes'], ['E-flat major'], ['Romantic']]);
    });
});

describe('ALL_TAXONOMY_CATEGORIES', () => {
    it('names every chip category once, with instrument (arr) variants and keys', () => {
        expect(new Set(ALL_TAXONOMY_CATEGORIES).size).toBe(ALL_TAXONOMY_CATEGORIES.length);
        expect(ALL_TAXONOMY_CATEGORIES).toContain('For piano');
        expect(ALL_TAXONOMY_CATEGORIES).toContain('For piano (arr)');
        expect(ALL_TAXONOMY_CATEGORIES).toContain('Chopin, Frédéric');
        expect(ALL_TAXONOMY_CATEGORIES).toContain('Nocturnes');
        expect(ALL_TAXONOMY_CATEGORIES).toContain('C-sharp minor');
        expect(ALL_TAXONOMY_CATEGORIES).toContain('Early 20th century');
        for (const key of KEY_FACETS) {
            expect(ALL_TAXONOMY_CATEGORIES).toContain(key.category);
        }
    });
});

/** Fixture INTERSECT over per-category member lists (UNION within a group). */
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

/** Mirror rows: one work, every taxonomy category it belongs to. */
type WorkFixture = { title: string; categories: string[] };

/** Same rule as imslp_browse_works: a work overlaps every group (OR within, AND across). */
const browseWorks = (groups: string[][], works: WorkFixture[]): string[] => {
    if (groups.length === 0) {
        return [];
    }
    return works
        .filter((w) => groups.every((group) => group.some((c) => w.categories.includes(c))))
        .map((w) => w.title);
};

const fakeBrowseRpc = (works: WorkFixture[], ready: string[]): BrowseRpcClient => ({
    rpc: async (fn, args) => {
        if (fn === 'imslp_index_ready') {
            const categories = args['categories'] as string[];
            return { data: categories.filter((c) => !ready.includes(c)), error: null };
        }
        if (fn === 'imslp_browse_works') {
            expect(args).not.toHaveProperty('title_filters');
            const groups = args['groups'] as string[][];
            const titles = browseWorks(groups, works);
            const off = Number(args['off'] ?? 0);
            const lim = Number(args['lim'] ?? titles.length);
            const page = titles.slice(off, off + lim).map((title, i) => ({
                page_title: title,
                page_id: i + 1,
                touched: null,
                total: titles.length,
            }));
            return { data: page, error: null };
        }
        return { data: null, error: { message: `unknown rpc ${fn}` } };
    },
});

const WORKS: WorkFixture[] = [
    {
        title: 'Goldberg Variations, BWV 988 (Bach, Johann Sebastian)',
        categories: ['For piano', 'Baroque', 'Bach, Johann Sebastian', 'G major'],
    },
    { title: 'Sonata in D minor, K.9 (Scarlatti, Domenico)', categories: ['For piano', 'Baroque', 'Sonatas', 'D minor'] },
    {
        title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
        categories: ['For piano', 'Romantic', 'Nocturnes', 'Chopin, Frédéric', 'E-flat major'],
    },
    { title: 'Messiah, HWV 56 (Handel, George Frideric)', categories: ['For piano (arr)', 'Baroque', 'Handel, George Frideric'] },
    { title: 'Le quattro stagioni (Vivaldi, Antonio)', categories: ['For orchestra', 'Baroque', 'Vivaldi, Antonio'] },
    { title: 'Toccata and Fugue in D minor, BWV 565 (Bach, Johann Sebastian)', categories: ['For organ', 'Baroque', 'Fugues'] },
    { title: 'Structures I (Boulez, Pierre)', categories: ['For piano', 'Modern'] },
];

const browse = (rpc: BrowseRpcClient | null, filters: Parameters<typeof browseCategoryGroupsFor>[0]) => {
    const groups = browseCategoryGroupsFor(filters);
    return browseFromIndex(rpc, {
        groups,
        needed: categoriesInGroups(groups),
        sort: 'relevance',
        limit: 50,
        offset: 0,
        popularTitles: [],
    });
};

describe('browseFromIndex (mocked RPC over the works mirror)', () => {
    const allReady = ALL_TAXONOMY_CATEGORIES;

    it('For piano ∩ Baroque is non-empty and includes a non-seed surname (AE1)', async () => {
        const result = await browse(fakeBrowseRpc(WORKS, allReady), { instruments: ['piano'], eras: ['baroque'] });
        expect(result.indexReady).toBe(true);
        expect(result.rows.map((r) => r.page_title)).toEqual([
            'Goldberg Variations, BWV 988 (Bach, Johann Sebastian)',
            'Sonata in D minor, K.9 (Scarlatti, Domenico)',
            'Messiah, HWV 56 (Handel, George Frideric)',
        ]);
    });

    it('three-way Piano · Fugue · Modern is an honest empty (AE4)', async () => {
        const result = await browse(fakeBrowseRpc(WORKS, allReady), {
            instruments: ['piano'],
            forms: ['fugue'],
            eras: ['modern'],
        });
        expect(result.indexReady).toBe(true);
        expect(result.rows).toEqual([]);
        expect(result.total).toBe(0);
    });

    it('a key chip narrows by category membership, not by title text', async () => {
        const result = await browse(fakeBrowseRpc(WORKS, allReady), { instruments: ['piano'], keys: ['d-minor'] });
        expect(result.rows.map((r) => r.page_title)).toEqual(['Sonata in D minor, K.9 (Scarlatti, Domenico)']);
    });

    it('typed search does not require key membership — Goldberg has no "G major" in the title', () => {
        const goldberg = 'Goldberg Variations, BWV 988 (Bach, Johann Sebastian)';
        expect(categoryGroupsFor({ instruments: ['piano'], keys: ['g-major'] })).toEqual([
            ['For piano', 'For piano (arr)'],
        ]);
        expect(titleMatchesFilters(goldberg, { keys: ['g-major'] })).toBe(false);
        expect(browseWorks(browseCategoryGroupsFor({ instruments: ['piano'], keys: ['g-major'] }), WORKS)).toEqual([
            goldberg,
        ]);
    });

    it('is ready as soon as one selected group is fully walked — its rows carry the other facets', async () => {
        const result = await browse(fakeBrowseRpc(WORKS, ['For piano', 'For piano (arr)']), {
            instruments: ['piano'],
            eras: ['baroque'],
        });
        expect(result.indexReady).toBe(true);
        expect(result.rows.some((r) => r.page_title.includes('Scarlatti'))).toBe(true);
    });

    it('a half-walked instrument group does not count as ready', async () => {
        const result = await browse(fakeBrowseRpc(WORKS, ['For piano']), { instruments: ['piano'], eras: ['baroque'] });
        expect(result.indexReady).toBe(false);
        expect(result.notReady).toEqual(['For piano (arr)']);
        expect(result.rows).toEqual([]);
    });

    it('names the group closest to ready when nothing is walked yet', async () => {
        const result = await browse(fakeBrowseRpc(WORKS, []), { instruments: ['piano'], eras: ['baroque'] });
        expect(result.indexReady).toBe(false);
        expect(result.notReady).toEqual(['Baroque']);
    });

    it('missing admin stays not-ready', async () => {
        const result = await browse(null, { instruments: ['piano'], eras: ['baroque'] });
        expect(result.indexReady).toBe(false);
        expect(result.notReady).toEqual(['For piano', 'For piano (arr)', 'Baroque']);
    });
});

describe('readinessFor', () => {
    it('ready when any group has no missing categories', () => {
        expect(readinessFor([['A', 'B'], ['C']], ['A'])).toEqual({ ready: true });
    });

    it('not ready reports the group with the fewest gaps, first in group order on ties', () => {
        expect(readinessFor([['A', 'B'], ['C'], ['D']], ['A', 'B', 'C', 'D'])).toEqual({
            ready: false,
            notReady: ['C'],
        });
        expect(readinessFor([['A', 'B'], ['C', 'D']], ['A', 'C'])).toEqual({ ready: false, notReady: ['A'] });
    });

    it('no groups is not ready', () => {
        expect(readinessFor([], [])).toEqual({ ready: false, notReady: [] });
    });
});

describe('titleMatchesFilters', () => {
    it('checks key chips against the title (OR within the dimension)', () => {
        const filters = { keys: ['c-sharp-minor'] };
        expect(titleMatchesFilters('Nocturne in C-sharp minor (Chopin, Frédéric)', filters)).toBe(true);
        expect(titleMatchesFilters('Nocturne in E-flat major (Chopin, Frédéric)', filters)).toBe(false);
        expect(titleMatchesFilters('Nocturne in C♯ minor (Chopin, Frédéric)', filters)).toBe(true);
    });

    it('does not require an era surname in the title', () => {
        const filters = { eras: ['baroque' as const] };
        expect(titleMatchesFilters('Sonata in D minor, K.9 (Scarlatti, Domenico)', filters)).toBe(true);
        expect(isWorkTitle('List of works by Frédéric Chopin')).toBe(false);
    });
});
