import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    applyPageResult,
    BUILDING_LEASE_MS,
    categoriesToSync,
    GENERATOR_BATCH_SIZE,
    MW_MULTIVALUE_LIMIT,
    isSafeCategoryName,
    mergeGeneratorPages,
    parseGeneratorPage,
    parseMemberPage,
    pickNextCategory,
    planTick,
    toBuildingRow,
    toWorkRow,
    unionCategories,
    walkCategoryBatch,
    type CategoryMemberPage,
    type CategorySyncRow,
    type GeneratorMember,
} from '../../supabase/functions/_shared/categorySync';
import {
    ALL_TAXONOMY_CATEGORIES,
    COMPOSER_FACETS,
    ERA_FACETS,
    FORM_FACETS,
    INSTRUMENT_FACETS,
    KEY_FACETS,
} from '../../supabase/functions/_shared/searchFacetData';

const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(resolve(process.cwd(), 'tests/imslp/fixtures', name), 'utf8'));
const chopinPage1 = fixture('generator-chopin-page1.json');
const chopinPage1Cl = fixture('generator-chopin-page1-clcontinue.json');

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

describe('parseGeneratorPage', () => {
    // Verbatim imslp.org responses: generator=categorymembers over Category:Chopin
    // with prop=categories|info, cllimit=3 to force the categories cut that a
    // 500-page batch hits against the real 500 cap.
    it('reads pages with their taxonomy categories, touched, and both continue tokens (MW 1.18 shape)', () => {
        const page = parseGeneratorPage(chopinPage1);
        expect(page.members).toHaveLength(4);
        expect(page.members.map((m) => m.title).sort()).toEqual([
            'Allegretto and Mazurka (Chopin, Frédéric)',
            'Allegretto in F-sharp major (Chopin, Frédéric)',
            'Allegro de concert, Op.46 (Chopin, Frédéric)',
            'Andante spianato et Grande polonaise brillante, Op.22 (Chopin, Frédéric)',
        ]);
        const allegro = page.members.find((m) => m.pageid === 2628);
        expect(allegro?.categories).toEqual(['Chopin, Frédéric', 'For piano', 'Romantic']);
        expect(allegro?.touched).toBe('2026-09-07T00:23:12Z');
        expect(page.members.find((m) => m.pageid === 3809)?.categories).toEqual([]);
        expect(page.gcmcontinue).toMatch(/^page\|/);
        expect(page.clcontinue).toBe('3809|Chopin, Frédéric');
    });

    it('a clcontinue follow-up carries the same gcmcontinue and the categories the first cut', () => {
        const more = parseGeneratorPage(chopinPage1Cl);
        expect(more.gcmcontinue).toBe(parseGeneratorPage(chopinPage1).gcmcontinue);
        expect(more.clcontinue).toBeNull();
        expect(more.members.find((m) => m.pageid === 3809)?.categories).toEqual([
            'Chopin, Frédéric',
            'For piano',
            'Romantic',
        ]);
        expect(more.members.find((m) => m.pageid === 2628)?.categories).toEqual([]);
    });

    it('accepts the modern continue block and tolerates junk', () => {
        const page = parseGeneratorPage({
            query: {
                pages: {
                    '1': { pageid: 1, title: 'Fugue (Bach, Johann Sebastian)' },
                    '2': 'junk',
                    '3': { title: 'no id' },
                },
            },
            continue: { gcmcontinue: 'page|00|1', clcontinue: '1|Fugues', continue: '||' },
        });
        expect(page.members).toEqual([
            { pageid: 1, title: 'Fugue (Bach, Johann Sebastian)', touched: undefined, categories: [] },
        ]);
        expect(page.gcmcontinue).toBe('page|00|1');
        expect(page.clcontinue).toBe('1|Fugues');
        expect(parseGeneratorPage(null)).toEqual({ members: [], gcmcontinue: null, clcontinue: null, warnings: null });
        expect(parseGeneratorPage({ query: { pages: {} } }).gcmcontinue).toBeNull();
    });

    it('surfaces MediaWiki warnings — a truncated clcategories list arrives as one, not as an error', () => {
        const page = parseGeneratorPage({
            warnings: { categories: { '*': "Too many values supplied for parameter 'clcategories': the limit is 50" } },
            query: { pages: {} },
        });
        expect(page.warnings).toBe(
            "categories: Too many values supplied for parameter 'clcategories': the limit is 50",
        );
    });
});

describe('mergeGeneratorPages', () => {
    it('unions categories per page and keeps pages only one side saw', () => {
        const first = parseGeneratorPage(chopinPage1).members;
        const merged = mergeGeneratorPages(first, parseGeneratorPage(chopinPage1Cl).members);
        expect(merged).toHaveLength(4);
        for (const m of merged) {
            expect(m.categories).toEqual(['Chopin, Frédéric', 'For piano', 'Romantic']);
        }
        const extra: GeneratorMember = { pageid: 99, title: 'X (Y, Z)', categories: ['Nocturnes'] };
        expect(mergeGeneratorPages(merged, [extra]).find((m) => m.pageid === 99)).toEqual(extra);
    });

    it('does not mutate its inputs', () => {
        const a: GeneratorMember[] = [{ pageid: 1, title: 'A (B, C)', categories: ['For piano'] }];
        mergeGeneratorPages(a, [{ pageid: 1, title: 'A (B, C)', categories: ['Romantic'] }]);
        expect(a[0]?.categories).toEqual(['For piano']);
    });
});

describe('walkCategoryBatch', () => {
    it('asks for the taxonomy in chunks of 50 per page set, follows clcontinue per chunk, and counts requests', async () => {
        // The 59-category taxonomy exceeds MediaWiki's 50-value cap for anonymous
        // callers; a single clcategories list silently lost C-sharp minor and every
        // era on the live site.
        expect(ALL_TAXONOMY_CATEGORIES.length).toBeGreaterThan(MW_MULTIVALUE_LIMIT);
        const calls: Record<string, string>[] = [];
        const fetchJson = async (params: Record<string, string>) => {
            calls.push(params);
            return params['clcontinue'] ? chopinPage1Cl : chopinPage1;
        };
        const result = await walkCategoryBatch(fetchJson, {
            category: 'Chopin, Frédéric',
            clcategories: ALL_TAXONOMY_CATEGORIES,
            gcmcontinue: null,
        });
        expect(result.requests).toBe(4);
        expect(result.members).toHaveLength(4);
        expect(result.members.every((m) => m.categories.includes('For piano'))).toBe(true);
        expect(result.gcmcontinue).toBe(parseGeneratorPage(chopinPage1).gcmcontinue);

        expect(calls[0]).toMatchObject({
            action: 'query',
            generator: 'categorymembers',
            gcmtitle: 'Category:Chopin, Frédéric',
            gcmlimit: String(GENERATOR_BATCH_SIZE),
            prop: 'categories|info',
            cllimit: 'max',
        });
        const asParam = (cats: string[]) => cats.map((c) => `Category:${c}`).join('|');
        expect(calls[0]?.['clcategories']).toBe(asParam(ALL_TAXONOMY_CATEGORIES.slice(0, MW_MULTIVALUE_LIMIT)));
        expect(calls[0]).not.toHaveProperty('gcmcontinue');
        expect(calls[0]).not.toHaveProperty('clcontinue');
        expect(calls[1]).toMatchObject({ clcontinue: '3809|Chopin, Frédéric' });
        expect(calls[1]?.['clcategories']).toBe(calls[0]?.['clcategories']);
        expect(calls[1]?.['gcmcontinue']).toBe(parseGeneratorPage(chopinPage1).gcmcontinue);
        expect(calls[2]?.['clcategories']).toBe(asParam(ALL_TAXONOMY_CATEGORIES.slice(MW_MULTIVALUE_LIMIT)));
        expect(calls[2]).not.toHaveProperty('clcontinue');
        expect(calls[3]).toMatchObject({ clcontinue: '3809|Chopin, Frédéric' });
        expect(calls[3]?.['gcmcontinue']).toBe(parseGeneratorPage(chopinPage1).gcmcontinue);
        for (const call of calls) {
            expect(call['clcategories']?.split('|').length).toBeLessThanOrEqual(MW_MULTIVALUE_LIMIT);
        }
        expect(calls[0]).not.toHaveProperty('gcmcontinue');
        expect(calls[2]).not.toHaveProperty('gcmcontinue');
    });

    it('keeps the generator cursor on every chunk of a resumed batch', async () => {
        const calls: Record<string, string>[] = [];
        const fetchJson = async (params: Record<string, string>) => {
            calls.push(params);
            return { query: { pages: { '1': { pageid: 1, title: 'A (B, C)' } } } };
        };
        await walkCategoryBatch(fetchJson, {
            category: 'For piano',
            clcategories: ALL_TAXONOMY_CATEGORIES,
            gcmcontinue: 'page|resume',
        });
        expect(calls).toHaveLength(2);
        expect(calls.every((c) => c['gcmcontinue'] === 'page|resume')).toBe(true);
    });

    it('fails loudly on a MediaWiki warning instead of recording partial membership', async () => {
        const fetchJson = async () => ({
            warnings: { categories: { '*': "Too many values supplied for parameter 'clcategories': the limit is 50" } },
            query: { pages: { '1': { pageid: 1, title: 'A (B, C)' } } },
        });
        await expect(
            walkCategoryBatch(fetchJson, { category: 'For piano', clcategories: ['For piano'], gcmcontinue: null }),
        ).rejects.toThrow(/Too many values/);
    });

    it('resumes from a generator cursor and ends the walk on the last page', async () => {
        const fetchJson = async (params: Record<string, string>) => {
            expect(params['gcmcontinue']).toBe('page|resume');
            return {
                query: {
                    pages: { '5': { pageid: 5, title: 'Last (A, B)', categories: [{ title: 'Category:For piano' }] } },
                },
            };
        };
        const result = await walkCategoryBatch(fetchJson, {
            category: 'For piano',
            clcategories: ['For piano'],
            gcmcontinue: 'page|resume',
        });
        expect(result.requests).toBe(1);
        expect(result.gcmcontinue).toBeNull();
        expect(result.members).toEqual([
            { pageid: 5, title: 'Last (A, B)', touched: undefined, categories: ['For piano'] },
        ]);
    });

    it('unions the chunks so a page keeps categories from both halves of the taxonomy', async () => {
        const fetchJson = async (params: Record<string, string>) => {
            const asked = new Set((params['clcategories'] ?? '').split('|'));
            const cats = ['Category:For piano', 'Category:Romantic', 'Category:C-sharp minor']
                .filter((c) => asked.has(c))
                .map((title) => ({ title }));
            return {
                query: { pages: { '49': { pageid: 49, title: 'Nocturne (Chopin, Frédéric)', categories: cats } } },
            };
        };
        const result = await walkCategoryBatch(fetchJson, {
            category: 'For piano',
            clcategories: ALL_TAXONOMY_CATEGORIES,
            gcmcontinue: null,
        });
        expect(result.members).toHaveLength(1);
        expect([...(result.members[0]?.categories ?? [])].sort()).toEqual(['C-sharp minor', 'For piano', 'Romantic']);
    });

    it('takes gcmcontinue from a later clcategories chunk when the first omits it', async () => {
        let firstCl: string | null = null;
        const fetchJson = async (params: Record<string, string>) => {
            const cl = params['clcategories'] ?? '';
            if (!firstCl) {
                firstCl = cl;
            }
            return {
                query: {
                    pages: { '1': { pageid: 1, title: 'A (B, C)', categories: [{ title: 'Category:For piano' }] } },
                },
                ...(cl === firstCl
                    ? {}
                    : { 'query-continue': { categorymembers: { gcmcontinue: 'page|from-second-chunk' } } }),
            };
        };
        const result = await walkCategoryBatch(fetchJson, {
            category: 'For piano',
            clcategories: ALL_TAXONOMY_CATEGORIES,
            gcmcontinue: null,
        });
        expect(result.gcmcontinue).toBe('page|from-second-chunk');
    });

    it('rejects a category name that could smuggle a URL into the MW query', async () => {
        await expect(
            walkCategoryBatch(async () => ({}), {
                category: 'https://evil.example/api.php',
                clcategories: ['For piano'],
                gcmcontinue: null,
            }),
        ).rejects.toThrow(/refusing IMSLP category/);
    });
});

describe('toWorkRow', () => {
    it('always records the walked category and parses the composer from the title', () => {
        const row = toWorkRow(
            'For piano',
            {
                pageid: 7,
                title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
                touched: '2026-01-01T00:00:00Z',
                categories: ['Nocturnes'],
            },
            '2026-09-07T12:00:00Z',
        );
        expect(row).toEqual({
            page_id: 7,
            page_title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
            composer: 'Chopin, Frédéric',
            categories: ['For piano', 'Nocturnes'],
            touched: '2026-01-01T00:00:00Z',
            seen_at: '2026-09-07T12:00:00Z',
        });
        expect(
            toWorkRow('For piano', { pageid: 8, title: 'Untitled', categories: ['For piano'] }, 'now'),
        ).toMatchObject({
            composer: null,
            categories: ['For piano'],
            touched: null,
        });
        expect(
            toBuildingRow(
                'For piano',
                2,
                { pageid: 8, title: 'Untitled', categories: ['For piano'] },
                'now',
            ),
        ).toMatchObject({ generation: 2, anchor: 'For piano', page_id: 8 });
    });
});

describe('unionCategories / isSafeCategoryName', () => {
    it('unions without last-writer-wins replacement', () => {
        expect(unionCategories(['For piano', 'Baroque'], ['For piano', 'G major'])).toEqual([
            'For piano',
            'Baroque',
            'G major',
        ]);
    });

    it('accepts taxonomy names and rejects URL-like values', () => {
        expect(isSafeCategoryName('Chopin, Frédéric')).toBe(true);
        expect(isSafeCategoryName('For piano (arr)')).toBe(true);
        expect(isSafeCategoryName('Early 20th century')).toBe(true);
        expect(isSafeCategoryName('C-sharp minor')).toBe(true);
        expect(ALL_TAXONOMY_CATEGORIES.every(isSafeCategoryName)).toBe(true);
        expect(isSafeCategoryName('https://imslp.org/api.php')).toBe(false);
        expect(isSafeCategoryName('Foo|Bar')).toBe(false);
    });
});

describe('categoriesToSync', () => {
    it('includes taxonomy categories, keys, and instrument (arr) variants as their own rows', () => {
        const cats = categoriesToSync(COMPOSER_FACETS, INSTRUMENT_FACETS, FORM_FACETS, ERA_FACETS, KEY_FACETS);
        expect(cats).toContain('For piano');
        expect(cats).toContain('For piano (arr)');
        expect(cats).toContain('Baroque');
        expect(cats).toContain('Early 20th century');
        expect(cats).toContain('Beethoven, Ludwig van');
        expect(cats).toContain('Fugues');
        expect(cats).toContain('C-sharp minor');
        expect(cats.filter((c) => c.endsWith('(arr)')).length).toBe(INSTRUMENT_FACETS.length);
        expect(new Set(cats).size).toBe(cats.length);
        expect([...cats].sort()).toEqual([...ALL_TAXONOMY_CATEGORIES].sort());
    });

    it('builds the default instrument, then eras, forms and keys, before the composer tail', () => {
        const cats = categoriesToSync(
            COMPOSER_FACETS,
            INSTRUMENT_FACETS,
            FORM_FACETS,
            ERA_FACETS,
            KEY_FACETS,
            'For piano',
        );
        expect(cats.slice(0, 2)).toEqual(['For piano', 'For piano (arr)']);
        const idx = (c: string) => cats.indexOf(c);
        expect(idx('Baroque')).toBeLessThan(idx('Sonatas'));
        expect(idx('Sonatas')).toBeLessThan(idx('C major'));
        expect(idx('C major')).toBeLessThan(idx('For violin'));
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

    it('skips a building row still inside the lease so overlapping ticks do not share a walk', () => {
        const now = Date.parse('2026-09-09T12:00:00Z');
        const next = pickNextCategory(
            ['For piano', 'Baroque'],
            [
                row({
                    category: 'For piano',
                    state: 'building',
                    building_generation: 2,
                    updated_at: new Date(now - 1_000).toISOString(),
                }),
                row({ category: 'Baroque', state: 'never' }),
            ],
            now,
        );
        expect(next).toBe('Baroque');
        expect(BUILDING_LEASE_MS).toBeGreaterThan(60_000);
    });

    it('resumes a stale building row after the lease expires', () => {
        const now = Date.parse('2026-09-09T12:00:00Z');
        const next = pickNextCategory(
            ['For piano', 'Baroque'],
            [
                row({
                    category: 'For piano',
                    state: 'building',
                    building_generation: 2,
                    updated_at: new Date(now - BUILDING_LEASE_MS - 1).toISOString(),
                }),
                row({ category: 'Baroque', state: 'never' }),
            ],
            now,
        );
        expect(next).toBe('For piano');
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

    it('empty first page with no continue is a genuine empty category and completes', () => {
        const cold = planTick('Baroque', previous);
        expect(cold.pagesDone).toBe(0);
        const decision = applyPageResult(cold, previous, [], null, null);
        expect(decision.kind).toBe('complete');
        expect(decision.activeGeneration).toBe(2);
        expect(decision.deleteGenerationsBefore).toBe(2);
        expect(decision.lastError).toBeNull();
    });

    it('MediaWiki error JSON is a failed tick, not a complete snapshot', () => {
        const cold = planTick('For piano', previous);
        const decision = applyPageResult(cold, previous, [], null, 'out of service');
        expect(decision.kind).toBe('failed');
        expect(decision.activeGeneration).toBe(1);
        expect(decision.deleteGenerationsBefore).toBeNull();
        expect(decision.lastError).toBe('out of service');
    });

    it('an empty last page after members were stored still completes', () => {
        const mid = planTick('Baroque', {
            ...previous,
            state: 'building',
            building_generation: 2,
            cmcontinue: 'page|80',
            pages_done: 80,
        });
        const decision = applyPageResult(mid, previous, [], null, null);
        expect(decision.kind).toBe('complete');
        expect(decision.activeGeneration).toBe(2);
        expect(decision.deleteGenerationsBefore).toBe(2);
    });
});
