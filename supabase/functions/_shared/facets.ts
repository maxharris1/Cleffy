/**
 * Facet → IMSLP category / token maps for edge search (keep in sync with client searchFacets.ts).
 */

export type EraId = 'baroque' | 'classical' | 'romantic' | 'modern';
export type SearchSort = 'relevance' | 'title' | 'recent';

export interface SearchFilters {
    composerCategory?: string;
    instrument?: string;
    form?: string;
    key?: string;
    era?: string;
}

const INSTRUMENT_MAP: Record<string, { category: string; tokens: string[] }> = {
    piano: { category: 'For piano', tokens: ['piano'] },
    violin: { category: 'For violin', tokens: ['violin'] },
    cello: { category: 'For cello', tokens: ['cello'] },
    guitar: { category: 'For guitar', tokens: ['guitar'] },
    voice: { category: 'For voice, piano', tokens: ['voice', 'song'] },
    flute: { category: 'For flute', tokens: ['flute'] },
    organ: { category: 'For organ', tokens: ['organ'] },
    orchestra: { category: 'For orchestra', tokens: ['orchestra', 'symphony'] },
};

const FORM_MAP: Record<string, { category: string; tokens: string[] }> = {
    sonata: { category: 'Sonatas', tokens: ['sonata'] },
    concerto: { category: 'Concertos', tokens: ['concerto'] },
    symphony: { category: 'Symphonies', tokens: ['symphony'] },
    nocturne: { category: 'Nocturnes', tokens: ['nocturne'] },
    prelude: { category: 'Preludes', tokens: ['prelude'] },
    fugue: { category: 'Fugues', tokens: ['fugue'] },
    waltz: { category: 'Waltzes', tokens: ['waltz'] },
    etude: { category: 'Etudes', tokens: ['etude', 'étude'] },
    opera: { category: 'Operas', tokens: ['opera'] },
    ballet: { category: 'Ballets', tokens: ['ballet'] },
};

const KEY_TOKENS: Record<string, string[]> = {
    'c-major': ['C major'],
    'g-major': ['G major'],
    'd-major': ['D major'],
    'a-major': ['A major'],
    'e-flat-major': ['E-flat major', 'E♭ major'],
    'a-minor': ['A minor'],
    'd-minor': ['D minor'],
    'e-minor': ['E minor'],
    'c-minor': ['C minor'],
    'c-sharp-minor': ['C-sharp minor', 'C♯ minor'],
};

export const ERA_COMPOSER_SEEDS: Record<string, string[]> = {
    baroque: ['Bach', 'Vivaldi', 'Handel', 'Pachelbel'],
    classical: ['Mozart', 'Haydn', 'Beethoven'],
    romantic: ['Chopin', 'Schubert', 'Brahms', 'Liszt', 'Schumann', 'Tchaikovsky'],
    modern: ['Debussy', 'Ravel', 'Satie', 'Rachmaninoff', 'Joplin'],
};

export const hasActiveFilters = (filters: SearchFilters | undefined): boolean => {
    if (!filters) {
        return false;
    }
    return Boolean(
        filters.composerCategory ||
            filters.instrument ||
            filters.form ||
            filters.key ||
            filters.era,
    );
};

/** Best category for empty-query browse: composer > instrument > form. */
export const primaryBrowseCategory = (filters: SearchFilters): string | null => {
    if (filters.composerCategory) {
        return filters.composerCategory;
    }
    if (filters.instrument && INSTRUMENT_MAP[filters.instrument]) {
        return INSTRUMENT_MAP[filters.instrument].category;
    }
    if (filters.form && FORM_MAP[filters.form]) {
        return FORM_MAP[filters.form].category;
    }
    return null;
};

/** Extra search tokens implied by filters. */
export const facetTokens = (filters: SearchFilters): string[] => {
    const out: string[] = [];
    if (filters.composerCategory) {
        const surname = filters.composerCategory.split(',')[0]?.trim();
        if (surname) {
            out.push(surname);
        }
    }
    if (filters.instrument && INSTRUMENT_MAP[filters.instrument]) {
        out.push(...INSTRUMENT_MAP[filters.instrument].tokens);
    }
    if (filters.form && FORM_MAP[filters.form]) {
        out.push(...FORM_MAP[filters.form].tokens);
    }
    if (filters.key && KEY_TOKENS[filters.key]) {
        out.push(...KEY_TOKENS[filters.key]);
    }
    if (filters.era && ERA_COMPOSER_SEEDS[filters.era]) {
        out.push(...ERA_COMPOSER_SEEDS[filters.era].slice(0, 3));
    }
    return out;
};

/** Title must match secondary facet constraints when browsing a primary category. */
export const titleMatchesFilters = (title: string, filters: SearchFilters): boolean => {
    const folded = title.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

    if (filters.composerCategory && primaryBrowseCategory(filters) !== filters.composerCategory) {
        const surname = filters.composerCategory.split(',')[0]?.trim().toLowerCase();
        if (surname && !folded.includes(surname.normalize('NFD').replace(/\p{M}/gu, ''))) {
            return false;
        }
    }

    if (filters.instrument && INSTRUMENT_MAP[filters.instrument]) {
        const tokens = INSTRUMENT_MAP[filters.instrument].tokens;
        // When browsing instrument category itself, skip token check.
        if (primaryBrowseCategory(filters) !== INSTRUMENT_MAP[filters.instrument].category) {
            if (!tokens.some((t) => folded.includes(t.toLowerCase()))) {
                return false;
            }
        }
    }

    if (filters.form && FORM_MAP[filters.form]) {
        const tokens = FORM_MAP[filters.form].tokens.map((t) =>
            t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(),
        );
        if (primaryBrowseCategory(filters) !== FORM_MAP[filters.form].category) {
            if (!tokens.some((t) => folded.includes(t))) {
                return false;
            }
        }
    }

    if (filters.key && KEY_TOKENS[filters.key]) {
        const keys = KEY_TOKENS[filters.key].map((t) =>
            t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(),
        );
        if (!keys.some((t) => folded.includes(t))) {
            return false;
        }
    }

    if (filters.era && ERA_COMPOSER_SEEDS[filters.era] && !filters.composerCategory) {
        const seeds = ERA_COMPOSER_SEEDS[filters.era].map((s) => s.toLowerCase());
        if (!seeds.some((s) => folded.includes(s))) {
            return false;
        }
    }

    return true;
};

/** Extra score for hits that align with active facets. */
export const facetBoost = (title: string, filters: SearchFilters): number => {
    let boost = 0;
    const folded = title.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

    if (filters.composerCategory) {
        const surname = filters.composerCategory.split(',')[0]?.trim().toLowerCase() ?? '';
        if (surname && folded.includes(surname)) {
            boost += 20;
        }
    }
    for (const tok of facetTokens(filters)) {
        const t = tok.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
        if (t.length >= 2 && folded.includes(t)) {
            boost += 4;
        }
    }
    return boost;
};

export const parseSort = (raw: unknown): SearchSort => {
    if (raw === 'title' || raw === 'recent' || raw === 'relevance') {
        return raw;
    }
    return 'relevance';
};

export const parseFilters = (raw: unknown): SearchFilters => {
    if (!raw || typeof raw !== 'object') {
        return {};
    }
    const o = raw as Record<string, unknown>;
    const filters: SearchFilters = {};
    if (typeof o['composerCategory'] === 'string' && o['composerCategory'].trim()) {
        filters.composerCategory = o['composerCategory'].trim();
    }
    if (typeof o['instrument'] === 'string' && o['instrument'].trim()) {
        filters.instrument = o['instrument'].trim();
    }
    if (typeof o['form'] === 'string' && o['form'].trim()) {
        filters.form = o['form'].trim();
    }
    if (typeof o['key'] === 'string' && o['key'].trim()) {
        filters.key = o['key'].trim();
    }
    if (typeof o['era'] === 'string' && o['era'].trim()) {
        filters.era = o['era'].trim();
    }
    return filters;
};
