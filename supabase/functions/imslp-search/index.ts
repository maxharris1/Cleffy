import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import {
    COMPOSER_FACETS,
    FORM_FACETS,
    INSTRUMENT_BY_ID,
    facetBoost,
    facetTokens,
    hardFilterCategories,
    hasActiveFilters,
    parseFilters,
    parseSort,
    primaryBrowseCategory,
    titleMatchesFilters,
    type SearchFilters,
    type SearchSort,
} from '../_shared/searchFacetData.ts';
import { checkRateLimit, clientKey, mwFetch, parseComposerFromTitle, workPageUrl } from '../_shared/imslp.ts';
import { POPULAR_WORKS, WORK_ALIASES } from '../_shared/popularWorks.ts';
import {
    aliasTitlesForQuery,
    buildSearchVariants,
    correctTokens,
    foldAccents,
    isWorkTitle,
    mergeAndRank,
    tokenizeQuery,
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

interface MwCategoryMember {
    title: string;
    pageid: number;
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

/** MediaWiki caps cmlimit at 50 — page with cmcontinue. */
const mwCategoryMembers = async (
    categoryTitle: string,
    limit: number,
    sort: SearchSort,
): Promise<MwCategoryMember[]> => {
    const members: MwCategoryMember[] = [];
    let cmcontinue: string | undefined;
    while (members.length < limit) {
        const params: Record<string, string> = {
            action: 'query',
            list: 'categorymembers',
            cmtitle: `Category:${categoryTitle}`,
            cmnamespace: '0',
            cmtype: 'page',
            cmlimit: String(Math.min(50, limit - members.length)),
        };
        if (sort === 'recent') {
            params['cmsort'] = 'timestamp';
            params['cmdir'] = 'desc';
        } else {
            params['cmsort'] = 'sortkey';
            params['cmdir'] = 'asc';
        }
        if (cmcontinue) {
            params['cmcontinue'] = cmcontinue;
        }
        const data = (await mwFetch(params)) as {
            query?: { categorymembers?: MwCategoryMember[] };
            continue?: { cmcontinue?: string };
        };
        const page = data.query?.categorymembers ?? [];
        if (page.length === 0) {
            break;
        }
        members.push(...page);
        cmcontinue = data.continue?.cmcontinue;
        if (!cmcontinue) {
            break;
        }
    }
    return members;
};

interface TitleResolution {
    resolvedTitles: Map<string, string>;
    resolvedPageIds: Map<string, number>;
    /** folded resolved title → hard-filter categories the page belongs to */
    categoryHits: Map<string, Set<string>>;
    /** folded titles of chunks whose category lookup failed — unknown, not non-members */
    unverified: Set<string>;
}

/**
 * Resolve redirects and (when an instrument filter is active) check membership
 * in its "For X" categories — one batched call per 40 titles, in parallel.
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
                // Keep unresolved titles. When a category check was requested,
                // the whole chunk is "unknown" rather than "not a member" — a
                // transient MW failure must not silently delete 40 hits.
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

/**
 * Folded titles (of `titles`) that belong to at least one of the categories,
 * plus the ones whose lookup failed — those are unknown, not non-members.
 */
const verifyCategoryMembership = async (
    titles: string[],
    categories: string[],
): Promise<{ members: Set<string>; unverified: Set<string> }> => {
    const resolution = await resolveTitles(titles, categories);
    return {
        members: new Set([...resolution.categoryHits.keys(), ...resolution.unverified]),
        unverified: resolution.unverified,
    };
};

const toHit = (title: string, pageid: number, snippet = ''): SearchHit => ({
    title,
    pageid,
    snippet,
    composer: parseComposerFromTitle(title),
    imslpUrl: workPageUrl(title),
});

const browseByFilters = async (
    filters: SearchFilters,
    limit: number,
    sort: SearchSort,
): Promise<{ results: SearchHit[]; filterRelaxed: boolean }> => {
    const category = primaryBrowseCategory(filters);
    if (category) {
        const members = await mwCategoryMembers(category, Math.min(Math.max(limit * 2, 100), 160), sort);
        const hardCategories = hardFilterCategories(filters);
        const instrumentIsPrimary = Boolean(
            filters.instrument && INSTRUMENT_BY_ID[filters.instrument]?.category === category,
        );

        let kept = members;
        let verified = false;
        let filterRelaxed = false;
        if (hardCategories.length > 0 && !instrumentIsPrimary) {
            const { members: membership, unverified } = await verifyCategoryMembership(
                members.map((m) => m.title),
                hardCategories,
            );
            const matching = members.filter((m) => membership.has(foldAccents(m.title)));
            if (matching.length > 0) {
                kept = matching;
                // A wholly-unverified match list confirms nothing — the token
                // proxy below must stay in force rather than being dropped as
                // "already answered" when every lookup chunk failed.
                verified = matching.some((m) => !unverified.has(foldAccents(m.title)));
            } else {
                filterRelaxed = true;
            }
            if (unverified.size > 0) {
                // Some members were kept without a completed check — say so.
                filterRelaxed = true;
            }
        }

        // Category membership already answered the instrument question — the
        // token fallback would wrongly drop titles that don't say "piano".
        const residualFilters: SearchFilters = { ...filters };
        if (verified || instrumentIsPrimary) {
            delete residualFilters.instrument;
        }

        let matched = kept.filter((m) => titleMatchesFilters(m.title, residualFilters));
        if (matched.length === 0 && filterRelaxed) {
            // Relaxing means we stopped enforcing the instrument at all — the
            // token proxy must not re-impose it and blank the panel.
            const { instrument: _instrument, ...withoutInstrument } = residualFilters;
            matched = kept.filter((m) => titleMatchesFilters(m.title, withoutInstrument));
        }
        const filtered = matched.slice(0, limit).map((m) => toHit(m.title, m.pageid));
        if (sort === 'relevance') {
            // Mild preference for shorter / more specific titles when browsing.
            return {
                results: [...filtered].sort(
                    (a, b) => a.title.length - b.title.length || a.title.localeCompare(b.title),
                ),
                filterRelaxed,
            };
        }
        return { results: filtered, filterRelaxed };
    }

    // Era / key-only: seed search with facet tokens.
    const tokens = facetTokens(filters);
    if (tokens.length === 0) {
        return { results: [], filterRelaxed: false };
    }
    const seedQuery = tokens.slice(0, 2).join(' ');
    const hits = await mwSearch(seedQuery, limit);
    return {
        results: hits
            .filter((h) => isWorkTitle(h.title) && titleMatchesFilters(h.title, filters))
            .slice(0, limit)
            .map((h) => toHit(h.title, h.pageid, (h.snippet ?? '').replace(/<[^>]+>/g, ''))),
        filterRelaxed: false,
    };
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

    let body: { q?: string; limit?: number; filters?: unknown; sort?: unknown };
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

    // Per-request MW pages are 50; we paginate up to this cap.
    const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 100);

    try {
        // Empty / short query with filters → category browse or seeded search.
        if (q.length < 2 && activeFilters) {
            const { results, filterRelaxed } = await browseByFilters(filters, limit, sort);
            return jsonResponse({ results, total: results.length, mode: 'browse', filterRelaxed });
        }

        const hardCategories = hardFilterCategories(filters);
        const composerSurname = foldAccents(filters.composerCategory?.split(',')[0]?.trim() ?? '');

        let tokens = tokenizeQuery(q);
        let aliasTitles = aliasTitlesForQuery(q, WORK_ALIASES);
        const variants = buildSearchVariants(q, { aliasTitles, facetTokens: facetTokens(filters) });

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
                // Zero weight: aliases earn their +50 in scoring, not from rank.
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

        const resolution = await resolveTitles(collectTitles(), hardCategories);

        const rank = (requireCategories: boolean): RankedHit[] => {
            const ranked = mergeAndRank(batches, {
                query: q,
                tokens,
                aliasTitles,
                popularTitles: POPULAR_TITLES,
                resolvedTitles: resolution.resolvedTitles,
                resolvedPageIds: resolution.resolvedPageIds,
                categoryHits: resolution.categoryHits,
                unverifiedTitles: resolution.unverified,
                requireCategories,
                extraScore: (title) => facetBoost(title, filters),
            });
            if (!composerSurname) {
                return ranked;
            }
            return ranked.filter((h) => foldAccents(h.title).includes(composerSurname));
        };

        let ranked = rank(hardCategories.length > 0);

        // One corrective re-query when results are thin and a token looks like
        // a near-miss of a known composer/work word ("beethovn", "moonlite").
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
                // Union, not replace: a guessed spelling must not cost hits
                // that match what the user actually typed.
                tokens = [...new Set([...tokens, ...corrected])];

                const unresolved = collectTitles().filter(
                    (t) => !resolution.resolvedPageIds.has(t) && !resolution.resolvedTitles.has(t),
                );
                const extra = await resolveTitles(unresolved, hardCategories);
                // The retry supersedes the first attempt's verdict: a title
                // whose chunk failed then may be confirmed (or refuted) now.
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
                ranked = rank(hardCategories.length > 0);
            }
        }

        // Instrument hard filter emptied the pool → fall back to boost-only so
        // the panel never blanks; the client shows a "close matches" hint.
        // Same hint when an unchecked hit is actually shown — but only then:
        // an unverified title that ranked below the cut relaxed nothing.
        let filterRelaxed = ranked.slice(0, limit).some((h) => resolution.unverified.has(foldAccents(h.title)));
        if (hardCategories.length > 0 && ranked.length < 5) {
            const relaxed = rank(false);
            if (relaxed.length > ranked.length) {
                ranked = relaxed;
                filterRelaxed = true;
            }
        }

        if (sort === 'title') {
            ranked.sort((a, b) => a.title.localeCompare(b.title));
        } else if (sort === 'recent') {
            // Last-edit timestamp from srprop — a proxy for recency.
            ranked.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? '') || b.score - a.score);
        }

        const results = ranked.slice(0, limit).map((h) => toHit(h.title, h.pageid, h.snippet));

        return jsonResponse({ results, total: results.length, mode: 'search', filterRelaxed });
    } catch (err) {
        return jsonResponse({ error: err instanceof Error ? err.message : 'IMSLP search failed' }, 502);
    }
});
