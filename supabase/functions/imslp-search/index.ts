import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import {
    COMPOSER_FACETS,
    FORM_FACETS,
    categoriesInGroups,
    categoryGroupsFor,
    facetBoost,
    facetTokens,
    hardFilterGroups,
    hasActiveFilters,
    keyTitlePatterns,
    parseFilters,
    parseSort,
    type RelaxedConstraint,
    type SearchFilters,
} from '../_shared/searchFacetData.ts';
import { checkRateLimit, clientKey, mwFetch, parseComposerFromTitle, serviceClient, workPageUrl } from '../_shared/imslp.ts';
import { POPULAR_WORKS, WORK_ALIASES } from '../_shared/popularWorks.ts';
import {
    aliasTitlesForQuery,
    buildSearchVariants,
    correctTokens,
    extractPeriod,
    foldAccents,
    mergeAndRank,
    tokenizeQuery,
    type PeriodEraId,
    type RankBatch,
    type RankedHit,
    type SearchVariant,
} from '../_shared/search.ts';

interface SearchHit {
    title: string;
    pageid: number;
    snippet: string;
    composer: string | null;
    imslpUrl: string;
}

interface MwSearchHit {
    title: string;
    pageid: number;
    snippet?: string;
    timestamp?: string;
}

interface BrowseRow {
    page_title: string;
    page_id: number;
    touched: string | null;
    total: number | string;
}

interface TitleResolution {
    resolvedTitles: Map<string, string>;
    resolvedPageIds: Map<string, number>;
    /** folded resolved title → hard-filter categories the page belongs to */
    categoryHits: Map<string, Set<string>>;
    /** folded titles of chunks whose category lookup failed — unknown, not non-members */
    unverified: Set<string>;
}

/** Folded titles of the curated list — the ranking's popularity prior. */
const POPULAR_TITLES = new Set(POPULAR_WORKS.map((w) => foldAccents(w.title)));

/** Vocabulary the typo corrector snaps near-miss tokens to. */
const CORRECTION_VOCAB: Set<string> = (() => {
    const vocab = new Set<string>();
    const add = (word: string) => {
        const folded = foldAccents(word);
        if (folded.length >= 4) {
            vocab.add(folded);
        }
    };
    for (const work of POPULAR_WORKS) {
        add(work.composer);
    }
    for (const facet of COMPOSER_FACETS) {
        facet.tokens.forEach(add);
    }
    for (const facet of FORM_FACETS) {
        facet.tokens.forEach(add);
    }
    for (const alias of WORK_ALIASES) {
        for (const key of alias.keys) {
            key.split(' ').forEach(add);
        }
    }
    for (const word of ['major', 'minor', 'piano', 'violin', 'cello', 'orchestra', 'quartet', 'quintet', 'variations']) {
        add(word);
    }
    return vocab;
})();

const uniq = <T,>(values: T[]): T[] => [...new Set(values)];

/** MediaWiki caps srlimit at 50 — page with sroffset to fill larger limits. */
const mwSearch = async (q: string, limit: number): Promise<MwSearchHit[]> => {
    const hits: MwSearchHit[] = [];
    let offset = 0;
    while (hits.length < limit) {
        const batch = Math.min(50, limit - hits.length);
        const data = (await mwFetch({
            action: 'query',
            list: 'search',
            srsearch: q,
            // Body-text search: MW 1.18 defaults to title-only, which misses
            // nicknames and multi-word queries; text mode also returns MW's own
            // relevance order, which the ranker blends in via rankBonus.
            srwhat: 'text',
            srnamespace: '0',
            srlimit: String(batch),
            sroffset: String(offset),
            srprop: 'snippet|timestamp',
        })) as {
            query?: { search?: MwSearchHit[] };
            continue?: { sroffset?: number };
        };
        const page = data.query?.search ?? [];
        if (page.length === 0) {
            break;
        }
        hits.push(...page);
        offset += page.length;
        if (page.length < batch) {
            break;
        }
    }
    return hits;
};

/**
 * Resolve redirects and (when live categories remain) check membership via
 * prop=categories. Cache-backed categories are filled separately.
 */
const resolveTitles = async (titles: string[], hardCategories: string[]): Promise<TitleResolution> => {
    const resolution: TitleResolution = {
        resolvedTitles: new Map(),
        resolvedPageIds: new Map(),
        categoryHits: new Map(),
        unverified: new Set(),
    };
    if (titles.length === 0) {
        return resolution;
    }
    const chunks: string[][] = [];
    for (let i = 0; i < titles.length; i += 40) {
        chunks.push(titles.slice(i, i + 40));
    }
    await Promise.all(
        chunks.map(async (chunk) => {
            try {
                const params: Record<string, string> = {
                    action: 'query',
                    titles: chunk.join('|'),
                    redirects: '1',
                };
                if (hardCategories.length > 0) {
                    params['prop'] = 'categories';
                    params['clcategories'] = hardCategories.map((c) => `Category:${c}`).join('|');
                    params['cllimit'] = 'max';
                }
                const data = (await mwFetch(params)) as {
                    query?: {
                        redirects?: Array<{ from: string; to: string }>;
                        pages?: Record<
                            string,
                            {
                                title?: string;
                                pageid?: number;
                                missing?: boolean;
                                categories?: Array<{ title?: string }>;
                            }
                        >;
                    };
                };
                for (const r of data.query?.redirects ?? []) {
                    resolution.resolvedTitles.set(r.from, r.to);
                }
                for (const page of Object.values(data.query?.pages ?? {})) {
                    if (page.missing || !page.title) {
                        continue;
                    }
                    if (typeof page.pageid === 'number') {
                        resolution.resolvedPageIds.set(page.title, page.pageid);
                    }
                    if (page.categories?.length) {
                        const names = new Set<string>();
                        for (const cat of page.categories) {
                            const name = cat.title?.replace(/^Category:/i, '').trim();
                            if (name) {
                                names.add(name);
                            }
                        }
                        if (names.size > 0) {
                            resolution.categoryHits.set(foldAccents(page.title), names);
                        }
                    }
                }
            } catch {
                if (hardCategories.length > 0) {
                    for (const title of chunk) {
                        resolution.unverified.add(foldAccents(title));
                    }
                }
            }
        }),
    );
    return resolution;
};

const mergeCategoryHits = (into: Map<string, Set<string>>, title: string, category: string) => {
    const folded = foldAccents(title);
    const existing = into.get(folded);
    if (existing) {
        existing.add(category);
    } else {
        into.set(folded, new Set([category]));
    }
};

const toHit = (title: string, pageid: number, snippet = ''): SearchHit => ({
    title,
    pageid,
    snippet,
    composer: parseComposerFromTitle(title),
    imslpUrl: workPageUrl(title),
});

const periodSource = (
    queryEras: PeriodEraId[],
    chipEras: PeriodEraId[],
): 'query' | 'chip' | 'both' | null => {
    if (queryEras.length === 0 && chipEras.length === 0) {
        return null;
    }
    if (queryEras.length > 0 && chipEras.length > 0) {
        return 'both';
    }
    return queryEras.length > 0 ? 'query' : 'chip';
};

const browseFromIndex = async (
    filters: SearchFilters,
    limit: number,
    offset: number,
    sort: ReturnType<typeof parseSort>,
): Promise<{
    results: SearchHit[];
    total: number;
    indexReady: boolean;
    hasMore: boolean;
    notReady: string[];
}> => {
    const groups = categoryGroupsFor(filters);
    const needed = categoriesInGroups(groups);
    const admin = serviceClient();
    if (!admin || needed.length === 0) {
        return { results: [], total: 0, indexReady: needed.length === 0, hasMore: false, notReady: needed };
    }

    const { data: missingRaw, error: readyError } = await admin.rpc('imslp_index_ready', { categories: needed });
    if (readyError) {
        throw new Error(readyError.message);
    }
    const notReady = Array.isArray(missingRaw) ? (missingRaw as string[]) : [];
    if (notReady.length > 0) {
        return { results: [], total: 0, indexReady: false, hasMore: false, notReady };
    }

    // Key chips narrow the intersection inside the function, so total, paging
    // and hasMore all describe the same filtered set.
    const { data: rows, error: browseError } = await admin.rpc('imslp_browse', {
        groups,
        sort,
        lim: limit,
        off: offset,
        title_filters: keyTitlePatterns(filters),
        popular_titles: POPULAR_WORKS.map((w) => w.title),
    });
    if (browseError) {
        throw new Error(browseError.message);
    }

    const page = (rows ?? []) as BrowseRow[];
    const total = page.length > 0 ? Number(page[0]?.total ?? 0) : 0;
    const results = page.map((row) => toHit(row.page_title, row.page_id));
    return {
        results,
        total,
        indexReady: true,
        hasMore: offset + page.length < total,
        notReady: [],
    };
};

const fillCachedMembership = async (
    titles: string[],
    cachedCategories: string[],
    categoryHits: Map<string, Set<string>>,
): Promise<void> => {
    if (titles.length === 0 || cachedCategories.length === 0) {
        return;
    }
    const admin = serviceClient();
    if (!admin) {
        return;
    }
    const { data, error } = await admin.rpc('imslp_titles_in_categories', {
        titles,
        categories: cachedCategories,
    });
    if (error || !data) {
        return;
    }
    for (const row of data as Array<{ page_title?: string; category?: string }>) {
        if (row.page_title && row.category) {
            mergeCategoryHits(categoryHits, row.page_title, row.category);
        }
    }
};

const categoriesMissingSnapshot = async (categories: string[]): Promise<string[]> => {
    if (categories.length === 0) {
        return [];
    }
    const admin = serviceClient();
    if (!admin) {
        return [...categories];
    }
    const { data, error } = await admin.rpc('imslp_index_ready', { categories });
    if (error || !Array.isArray(data)) {
        return [...categories];
    }
    return data as string[];
};

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const rate = await checkRateLimit(`search:${clientKey(req)}`, 40, 60_000);
    if (!rate.ok) {
        return jsonResponse({ error: 'Too many requests', retryAfterSec: rate.retryAfterSec }, 429);
    }

    let body: {
        q?: string;
        limit?: number;
        offset?: number;
        filters?: unknown;
        sort?: unknown;
    };
    try {
        body = await req.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const q = typeof body.q === 'string' ? body.q.trim() : '';
    const filters = parseFilters(body.filters);
    const sort = parseSort(body.sort);
    const activeFilters = hasActiveFilters(filters);

    if (q.length < 2 && !activeFilters) {
        return jsonResponse({ error: 'Query must be at least 2 characters' }, 400);
    }

    const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 300);
    const offset = Math.min(Math.max(Number(body.offset) || 0, 0), 10_000);

    try {
        if (q.length < 2 && activeFilters) {
            const browsed = await browseFromIndex(filters, limit, offset, sort);
            return jsonResponse({
                results: browsed.results,
                total: browsed.total,
                mode: 'browse',
                indexReady: browsed.indexReady,
                hasMore: browsed.hasMore,
                notReady: browsed.notReady,
                filterRelaxed: false,
                relaxed: [],
                period: null,
            });
        }

        const extracted = extractPeriod(q);
        const queryEras = filters.ignoreQueryPeriod ? [] : extracted.eraIds;
        const chipEras = (filters.eras ?? []) as PeriodEraId[];
        const eraIds = uniq<PeriodEraId>([...queryEras, ...chipEras]);
        const searchQ = extracted.rest.length > 0 ? extracted.rest : q;
        const typedFilters: SearchFilters = { ...filters, eras: eraIds };

        // One group per hard dimension (instrument, era). Relaxation drops whole
        // groups, era first, so the hint can name what was actually let go.
        const instrumentGroups = hardFilterGroups({ instruments: typedFilters.instruments });
        const eraGroups = hardFilterGroups({ eras: typedFilters.eras });
        const allGroups = [...instrumentGroups, ...eraGroups];
        const hardCategories = allGroups.flat();
        const missingSnapshots = await categoriesMissingSnapshot(hardCategories);
        const liveCategories = hardCategories.filter((c) => missingSnapshots.includes(c));
        const cachedCategories = hardCategories.filter((c) => !missingSnapshots.includes(c));

        const composerSurnames = (filters.composerCategories ?? [])
            .map((c) => foldAccents(c.split(',')[0]?.trim() ?? ''))
            .filter(Boolean);

        let tokens = tokenizeQuery(searchQ);
        let aliasTitles = aliasTitlesForQuery(q, WORK_ALIASES);
        const variants = buildSearchVariants(searchQ, { aliasTitles, facetTokens: facetTokens(typedFilters) });

        const perQuery = Math.min(50, Math.max(limit, 30));
        const batches: RankBatch[] = await Promise.all(
            variants.map(async (variant: SearchVariant) => {
                try {
                    return { variant, hits: await mwSearch(variant.q, perQuery) };
                } catch {
                    return { variant, hits: [] as MwSearchHit[] };
                }
            }),
        );
        const pushAliasBatch = (titles: string[]) => {
            if (titles.length > 0) {
                batches.push({
                    variant: { q: '__alias__', weight: 0 },
                    hits: titles.map((title) => ({ title, pageid: 0 })),
                });
            }
        };
        pushAliasBatch(aliasTitles);

        const collectTitles = (): string[] => {
            const seen = new Set<string>();
            for (const batch of batches) {
                for (const hit of batch.hits) {
                    seen.add(hit.title);
                }
            }
            return [...seen];
        };

        const resolution = await resolveTitles(collectTitles(), liveCategories);
        await fillCachedMembership(collectTitles(), cachedCategories, resolution.categoryHits);

        const rank = (requiredGroups: string[][]): RankedHit[] => {
            const ranked = mergeAndRank(batches, {
                query: searchQ,
                tokens,
                aliasTitles,
                popularTitles: POPULAR_TITLES,
                resolvedTitles: resolution.resolvedTitles,
                resolvedPageIds: resolution.resolvedPageIds,
                categoryHits: resolution.categoryHits,
                unverifiedTitles: resolution.unverified,
                requiredGroups,
                extraScore: (title) => facetBoost(title, typedFilters),
            });
            if (composerSurnames.length === 0) {
                return ranked;
            }
            return ranked.filter((h) => {
                const folded = foldAccents(h.title);
                return composerSurnames.some((s) => folded.includes(s));
            });
        };

        let ranked = rank(allGroups);

        if (ranked.length < 5) {
            const corrected = correctTokens(tokens, CORRECTION_VOCAB);
            if (corrected) {
                const correctedQ = corrected.join(' ');
                try {
                    batches.push({ variant: { q: correctedQ, weight: 0.9 }, hits: await mwSearch(correctedQ, perQuery) });
                } catch {
                    // corrected query is best-effort
                }
                const correctedAliases = aliasTitlesForQuery(correctedQ, WORK_ALIASES).filter(
                    (t) => !aliasTitles.includes(t),
                );
                pushAliasBatch(correctedAliases);
                aliasTitles = [...aliasTitles, ...correctedAliases];
                tokens = [...new Set([...tokens, ...corrected])];

                const unresolved = collectTitles().filter(
                    (t) => !resolution.resolvedPageIds.has(t) && !resolution.resolvedTitles.has(t),
                );
                const extra = await resolveTitles(unresolved, liveCategories);
                for (const t of unresolved) {
                    resolution.unverified.delete(foldAccents(t));
                }
                for (const [from, to] of extra.resolvedTitles) {
                    resolution.resolvedTitles.set(from, to);
                }
                for (const [title, id] of extra.resolvedPageIds) {
                    resolution.resolvedPageIds.set(title, id);
                }
                for (const [title, cats] of extra.categoryHits) {
                    resolution.categoryHits.set(title, cats);
                }
                for (const title of extra.unverified) {
                    resolution.unverified.add(title);
                }
                await fillCachedMembership(unresolved, cachedCategories, resolution.categoryHits);
                ranked = rank(allGroups);
            }
        }

        // Too few survivors: let go of the era first (the softer axis), then the
        // instrument, and only when doing so actually finds more.
        const relaxed: RelaxedConstraint[] = [];
        if (eraGroups.length > 0 && ranked.length < 5) {
            const withoutEra = rank(instrumentGroups);
            if (withoutEra.length > ranked.length) {
                ranked = withoutEra;
                relaxed.push('era');
            }
        }
        if (instrumentGroups.length > 0 && ranked.length < 5) {
            const withoutInstrument = rank([]);
            if (withoutInstrument.length > ranked.length) {
                ranked = withoutInstrument;
                relaxed.push('instrument');
                if (eraGroups.length > 0 && !relaxed.includes('era')) {
                    relaxed.push('era');
                }
            }
        }

        if (sort === 'title') {
            ranked.sort((a, b) => a.title.localeCompare(b.title));
        } else if (sort === 'recent') {
            ranked.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? '') || b.score - a.score);
        }

        const page = ranked.slice(0, limit);
        let filterRelaxed = relaxed.length > 0;
        if (!filterRelaxed) {
            filterRelaxed = page.some((h) => resolution.unverified.has(foldAccents(h.title)));
        }
        const results = page.map((h) => toHit(h.title, h.pageid, h.snippet));
        const source = periodSource(queryEras, chipEras);

        return jsonResponse({
            results,
            total: ranked.length,
            mode: 'search',
            filterRelaxed,
            relaxed,
            indexReady: true,
            hasMore: ranked.length > page.length,
            period: source ? { eraIds, source } : null,
        });
    } catch (err) {
        return jsonResponse({ error: err instanceof Error ? err.message : 'IMSLP search failed' }, 502);
    }
});
