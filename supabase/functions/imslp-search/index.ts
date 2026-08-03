import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import {
    facetBoost,
    facetTokens,
    hasActiveFilters,
    parseFilters,
    parseSort,
    primaryBrowseCategory,
    titleMatchesFilters,
    type SearchFilters,
    type SearchSort,
} from '../_shared/facets.ts';
import { checkRateLimit, clientKey, mwFetch, parseComposerFromTitle, workPageUrl } from '../_shared/imslp.ts';
import { aliasTitlesForQuery, buildSearchVariants, scoreTitleMatch, tokenizeQuery } from '../_shared/search.ts';

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
}

interface MwCategoryMember {
    title: string;
    pageid: number;
}

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

const toHit = (title: string, pageid: number, snippet = ''): SearchHit => ({
    title,
    pageid,
    snippet,
    composer: parseComposerFromTitle(title),
    imslpUrl: workPageUrl(title),
});

const browseByFilters = async (filters: SearchFilters, limit: number, sort: SearchSort): Promise<SearchHit[]> => {
    const category = primaryBrowseCategory(filters);
    if (category) {
        const members = await mwCategoryMembers(category, Math.max(limit * 2, 100), sort);
        const filtered = members
            .filter((m) => titleMatchesFilters(m.title, filters))
            .slice(0, limit)
            .map((m) => toHit(m.title, m.pageid));
        if (sort === 'relevance') {
            // Mild preference for shorter / more specific titles when browsing.
            return [...filtered].sort((a, b) => a.title.length - b.title.length || a.title.localeCompare(b.title));
        }
        return filtered;
    }

    // Era / key-only: seed search with facet tokens.
    const tokens = facetTokens(filters);
    if (tokens.length === 0) {
        return [];
    }
    const seedQuery = tokens.slice(0, 2).join(' ');
    const hits = await mwSearch(seedQuery, limit);
    return hits
        .filter((h) => titleMatchesFilters(h.title, filters))
        .slice(0, limit)
        .map((h) => toHit(h.title, h.pageid, (h.snippet ?? '').replace(/<[^>]+>/g, '')));
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
            const results = await browseByFilters(filters, limit, sort);
            return jsonResponse({ results, total: results.length, mode: 'browse' });
        }

        const tokens = tokenizeQuery(q);
        const variants = buildSearchVariants(q);
        for (const tok of facetTokens(filters)) {
            if (tok.length >= 2 && variants.length < 8) {
                variants.push(q.length >= 2 ? `${tok} ${q}` : tok);
                variants.push(tok);
            }
        }
        // Dedupe variants
        const seenVariant = new Set<string>();
        const uniqueVariants: string[] = [];
        for (const v of variants) {
            const key = v.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
            if (!key || seenVariant.has(key)) {
                continue;
            }
            seenVariant.add(key);
            uniqueVariants.push(v);
            if (uniqueVariants.length >= 8) {
                break;
            }
        }

        const perQuery = Math.min(50, Math.max(limit, 30));
        const batches = await Promise.all(
            uniqueVariants.map(async (variant) => {
                try {
                    return await mwSearch(variant, perQuery);
                } catch {
                    return [] as MwSearchHit[];
                }
            }),
        );

        const rawByTitle = new Map<string, MwSearchHit>();
        for (const batch of batches) {
            for (const hit of batch) {
                if (!rawByTitle.has(hit.title)) {
                    rawByTitle.set(hit.title, hit);
                }
            }
        }

        for (const title of aliasTitlesForQuery(q)) {
            if (!rawByTitle.has(title)) {
                rawByTitle.set(title, { title, pageid: 0, snippet: '' });
            }
        }

        const rawHits = [...rawByTitle.values()];

        const resolvedTitles = new Map<string, string>();
        const resolvedPageIds = new Map<string, number>();
        if (rawHits.length > 0) {
            try {
                const titles = rawHits.map((h) => h.title);
                for (let i = 0; i < titles.length; i += 40) {
                    const chunk = titles.slice(i, i + 40);
                    const redirectData = (await mwFetch({
                        action: 'query',
                        titles: chunk.join('|'),
                        redirects: '1',
                    })) as {
                        query?: {
                            redirects?: Array<{ from: string; to: string }>;
                            pages?: Record<string, { title?: string; pageid?: number; missing?: boolean }>;
                        };
                    };
                    for (const r of redirectData.query?.redirects ?? []) {
                        resolvedTitles.set(r.from, r.to);
                    }
                    for (const page of Object.values(redirectData.query?.pages ?? {})) {
                        if (page.missing || !page.title) {
                            continue;
                        }
                        if (typeof page.pageid === 'number') {
                            resolvedPageIds.set(page.title, page.pageid);
                        }
                    }
                }
            } catch {
                // keep unresolved titles
            }
        }

        const aliasBoost = new Set(aliasTitlesForQuery(q));
        const scoreTokens = [...tokens, ...facetTokens(filters)];
        const merged = new Map<string, SearchHit & { score: number }>();

        for (const hit of rawHits) {
            const title = resolvedTitles.get(hit.title) ?? hit.title;
            if (activeFilters && !titleMatchesFilters(title, filters)) {
                // Soft filter: still allow but don't skip entirely when query is strong —
                // only hard-filter when composer category is set.
                if (filters.composerCategory) {
                    const surname = filters.composerCategory.split(',')[0]?.trim().toLowerCase() ?? '';
                    const folded = title.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
                    if (surname && !folded.includes(surname)) {
                        continue;
                    }
                }
            }
            const pageid = resolvedPageIds.get(title) ?? hit.pageid;
            let score = scoreTitleMatch(title, scoreTokens);
            score += facetBoost(title, filters);
            if (aliasBoost.has(title)) {
                score += 50;
            }
            if (foldEquals(hit.title, q) || foldEquals(title, q)) {
                score += 5;
            }

            const existing = merged.get(title);
            if (!existing || score > existing.score) {
                merged.set(title, {
                    title,
                    pageid,
                    snippet: (hit.snippet ?? '').replace(/<[^>]+>/g, ''),
                    composer: parseComposerFromTitle(title),
                    imslpUrl: workPageUrl(title),
                    score,
                });
            }
        }

        const ranked = [...merged.values()];
        if (sort === 'title') {
            ranked.sort((a, b) => a.title.localeCompare(b.title));
        } else if (sort === 'recent') {
            // Search API doesn't give reliable add dates; fall back to relevance.
            ranked.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
        } else {
            ranked.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
        }

        const results = ranked.slice(0, limit).map(({ score: _score, ...rest }) => rest);

        return jsonResponse({ results, total: results.length, mode: 'search' });
    } catch (err) {
        return jsonResponse({ error: err instanceof Error ? err.message : 'IMSLP search failed' }, 502);
    }
});

const foldEquals = (a: string, b: string): boolean =>
    a.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase() === b.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
