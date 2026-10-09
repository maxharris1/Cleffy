import { describe, expect, it } from 'vitest';

import { POPULAR_WORKS, WORK_ALIASES } from '../../supabase/functions/_shared/popularWorks';
import {
    aliasTitlesForQuery,
    buildSearchVariants,
    catalogMatch,
    catalogRefsFromTokens,
    catalogRefsInTitle,
    foldAccents,
    isExactTitleQuery,
    keyOf,
    labelTitlesForQuery,
    mergeAndRank,
    normalizeQuery,
    scoreTitleMatch,
    titleSearchQuery,
    tokenizeQuery,
    type RankBatch,
    type SearchVariant,
} from '../../supabase/functions/_shared/search';
import { categoryGroupsFor } from '../../supabase/functions/_shared/searchFacetData';

const BACH = '(Bach, Johann Sebastian)';
const WTC1 = `Das wohltemperierte Klavier I, BWV 846-869 ${BACH}`;
const WTC2 = `Das wohltemperierte Klavier II, BWV 870-893 ${BACH}`;
const BWV846 = `Prelude and Fugue in C major, BWV 846 ${BACH}`;
const BWV848 = `Prelude and Fugue in C-sharp major, BWV 848 ${BACH}`;
const BWV531 = `Prelude and Fugue in C major, BWV 531 ${BACH}`;
const HAMMERKLAVIER = 'Piano Sonata No.29, Op.106 (Beethoven, Ludwig van)';

const batch = (variant: SearchVariant, titles: string[]): RankBatch => ({
    variant,
    hits: titles.map((title, i) => ({ title, pageid: i + 1 })),
});

const POPULAR = new Set(POPULAR_WORKS.map((w) => foldAccents(w.title)));
const PIANO_GROUPS = categoryGroupsFor({ instruments: ['piano'] });

/** Live IMSLP membership (2026-10-09) for the titles these fixtures use. */
const CATEGORIES = new Map<string, Set<string>>([
    [foldAccents(WTC1), new Set(['For keyboard', 'For organ (arr)'])],
    [foldAccents(WTC2), new Set(['For keyboard'])],
    [foldAccents(BWV846), new Set(['For keyboard'])],
    [foldAccents(BWV848), new Set(['For keyboard', 'For piano (arr)'])],
    [foldAccents(BWV531), new Set(['For organ'])],
    [foldAccents(HAMMERKLAVIER), new Set(['For piano'])],
]);

/** The edge function's rank call, with its search variants answered by `answers`. */
const rank = (q: string, answers: Record<string, string[]>, instruments = PIANO_GROUPS) => {
    const labelTitles = labelTitlesForQuery(q, POPULAR_WORKS);
    const aliasTitles = [...new Set([...labelTitles, ...aliasTitlesForQuery(q, WORK_ALIASES)])];
    const batches = buildSearchVariants(q, { aliasTitles, facetTokens: ['piano'] }).map((v) =>
        batch(v, answers[`${v.what ?? 'text'}:${v.q}`] ?? []),
    );
    batches.push({ variant: { q: '__alias__', weight: 0 }, hits: aliasTitles.map((title) => ({ title, pageid: 0 })) });
    return mergeAndRank(batches, {
        query: q,
        tokens: tokenizeQuery(q),
        aliasTitles,
        exactTitles: labelTitles,
        popularTitles: POPULAR,
        categoryHits: CATEGORIES,
        requiredGroups: instruments,
    }).map((h) => h.title);
};

describe('catalogue references', () => {
    it('reads single works, volumes and opus sub-numbers out of IMSLP titles', () => {
        expect(catalogRefsInTitle(BWV846)).toEqual([{ catalog: 'bwv', num: 846, suffix: '' }]);
        expect(catalogRefsInTitle(WTC1)).toEqual([{ catalog: 'bwv', num: 846, suffix: '', rangeEnd: 869 }]);
        expect(catalogRefsInTitle('Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)')).toEqual([
            { catalog: 'op', num: 27, suffix: '', sub: 2 },
        ]);
        expect(catalogRefsInTitle('Piano Sonata No.11 in A major, K.331/300i (Mozart, Wolfgang Amadeus)')).toEqual([
            { catalog: 'k', num: 331, suffix: '' },
        ]);
        expect(catalogRefsInTitle('Keyboard Sonata in C major, Hob.XVI:50 (Haydn, Joseph)')).toEqual([
            { catalog: 'hob', num: 50, suffix: 'xvi' },
        ]);
        // A dotless single letter is a word, not a catalogue: "Polka 331", "Mark 12".
        expect(catalogRefsInTitle('Polka 331 (Someone, Else)')).toEqual([]);
    });

    it('reads the query side the way normalizeQuery spells it', () => {
        expect(normalizeQuery('Hob. XVI: 50')).toBe('hob.xvi:50');
        expect(catalogRefsFromTokens(tokenizeQuery('Beethoven Op 27 No 2'))).toEqual([
            { catalog: 'op', num: 27, suffix: '', sub: 2 },
        ]);
        expect(catalogRefsFromTokens(tokenizeQuery('mozart KV 331'))).toEqual([{ catalog: 'k', num: 331, suffix: '' }]);
    });

    it('tells the work itself from the volume that holds it', () => {
        const [bwv846] = catalogRefsFromTokens(['bwv.846']);
        expect(catalogMatch(bwv846!, catalogRefsInTitle(BWV846))).toBe('exact');
        expect(catalogMatch(bwv846!, catalogRefsInTitle(WTC1))).toBe('within');
        expect(catalogMatch(bwv846!, catalogRefsInTitle(`Fugue, BWV 8460 ${BACH}`))).toBe('none');
        const [op9no2] = catalogRefsFromTokens(['op.9', 'no.2']);
        expect(catalogMatch(op9no2!, catalogRefsInTitle('Nocturnes, Op.9 (Chopin, Frédéric)'))).toBe('within');
        expect(catalogMatch(op9no2!, catalogRefsInTitle('Mazurka, Op.9 No.3 (Somebody, Else)'))).toBe('none');
        expect(
            scoreTitleMatch(BWV846, tokenizeQuery('BWV 846')) - scoreTitleMatch(WTC1, tokenizeQuery('BWV 846')),
        ).toBeGreaterThanOrEqual(20);
    });

    it('credits the key the query names, not every title in a major key', () => {
        expect(keyOf('Bach Prelude C major')).toBe('c major');
        expect(keyOf(BWV848)).toBe('c-sharp major');
        expect(keyOf('Nocturne in C# minor')).toBe('c-sharp minor');
        const tokens = tokenizeQuery('Bach Prelude C major');
        expect(scoreTitleMatch(BWV846, tokens, 'c major')).toBeGreaterThan(scoreTitleMatch(BWV848, tokens, 'c major'));
    });
});

describe('title-mode search variant', () => {
    it('searches titles for the catalogue number alone, spelled the way IMSLP titles spell it', () => {
        expect(titleSearchQuery('BWV 846')).toBe('BWV 846');
        expect(titleSearchQuery('chopin nocturne op 9 no 2')).toBe('Op.9 No.2');
        expect(titleSearchQuery('mozart k 331')).toBe('K.331');
        expect(titleSearchQuery('Hob. XVI:50')).toBe('Hob.XVI:50');
        expect(titleSearchQuery('Bach Prelude C major')).toBe('Bach Prelude C major');
        expect(titleSearchQuery('Prelude in C major (WTC I)')).toBe('Prelude in C major WTC I');
        expect(titleSearchQuery('chopin')).toBeNull();
    });

    it('sends it third, after the text query and its normalized form, within the cap of 6', () => {
        const variants = buildSearchVariants('BWV 846', { facetTokens: ['piano'] });
        expect(variants.slice(0, 3)).toEqual([
            { q: 'BWV 846', weight: 1 },
            { q: 'bwv.846', weight: 1 },
            { q: 'BWV 846', weight: 0.8, what: 'title' },
        ]);
        expect(buildSearchVariants('beethoven moonlight sonata op 27').length).toBeLessThanOrEqual(6);
    });
});

describe('exact titles', () => {
    it('matches the work title without its composer, ignoring punctuation and accents', () => {
        expect(isExactTitleQuery(BWV846, 'prelude and fugue in c major bwv 846')).toBe(true);
        expect(isExactTitleQuery(BWV846, 'Prelude and Fugue in C major, BWV 846 (Bach, Johann Sebastian)')).toBe(true);
        expect(isExactTitleQuery(BWV846, 'prelude and fugue in c major')).toBe(false);
    });

    it('resolves a curated label typed in full', () => {
        expect(labelTitlesForQuery('prelude in c major (wtc i)', POPULAR_WORKS)).toEqual([BWV846]);
        expect(labelTitlesForQuery('prelude in c major', POPULAR_WORKS)).toEqual([]);
    });
});

describe('mergeAndRank — queries testers saw fail under the Piano chip', () => {
    // Batches are the live srwhat=text / srwhat=title orders IMSLP returned on 2026-10-09.
    it('"BWV 846" surfaces the Prelude and Fugue, above WTC I and above the text-search noise', () => {
        const ranked = rank('BWV 846', {
            'text:BWV 846': [HAMMERKLAVIER, 'Bach-Gesellschaft Ausgabe (Bach, Johann Sebastian)', WTC2, WTC1],
            'title:BWV 846': [WTC1, BWV846],
            'text:piano BWV 846': [HAMMERKLAVIER],
        });
        expect(ranked[0]).toBe(BWV846);
        expect(ranked.indexOf(WTC1)).toBeGreaterThan(0);
        expect(ranked.indexOf(WTC1)).toBeLessThan(ranked.indexOf(WTC2));
    });

    it('"Bach Prelude C major" puts BWV 846 first and keeps the organ work out', () => {
        const ranked = rank('Bach Prelude C major', {
            'text:Bach Prelude C major': [WTC2, WTC1, BWV848],
            'title:Bach Prelude C major': [BWV848, BWV531, BWV846],
        });
        expect(ranked[0]).toBe(BWV846);
        expect(ranked).not.toContain(BWV531);
        expect(ranked.indexOf(BWV846)).toBeLessThan(ranked.indexOf(WTC1));
    });

    it('a label typed in full ranks its single work above the whole volume the "wtc" alias names', () => {
        const ranked = rank('Prelude in C major (WTC I)', {
            'text:Prelude in C major (WTC I)': [BWV848],
        });
        expect(ranked.slice(0, 2)).toEqual([BWV846, WTC1]);
    });

    it('an opus number shared across composers does not outrank the composer the query names', () => {
        const chopin = 'Nocturnes, Op.9 (Chopin, Frédéric)';
        const dussek = 'Piano Sonata No.2, Op.9 No.2 (Dussek, Jan Ladislav)';
        const ranked = mergeAndRank(
            [
                batch({ q: 'chopin nocturne op 9 no 2', weight: 1 }, [chopin]),
                batch({ q: 'Op.9 No.2', weight: 0.8, what: 'title' }, [dussek]),
            ],
            { query: 'chopin nocturne op 9 no 2', tokens: tokenizeQuery('chopin nocturne op 9 no 2') },
        );
        expect(ranked.map((h) => h.title)).toEqual([chopin, dussek]);
    });
});
