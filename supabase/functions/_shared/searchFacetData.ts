/**
 * Facet taxonomy for IMSLP find — the single source of truth for the edge
 * search (_shared/facets.ts) and the client UI (src/features/imslp/searchFacets.ts).
 *
 * NO imports — like entitlements.ts and studentCodes.ts, this file is loaded
 * by Deno (with the `.ts` extension) and by Vite/vitest (without it), so both
 * runtimes read one definition and cannot drift from each other.
 *
 * Era has no reliable work category on IMSLP — seed composers instead.
 */

export type FacetDimension = 'composer' | 'instrument' | 'form' | 'key' | 'era';
export type SearchSort = 'relevance' | 'title' | 'recent';
export type EraId = 'baroque' | 'classical' | 'romantic' | 'modern';

export interface FacetValueData {
    id: string;
    label: string;
    /** IMSLP Category: title without "Category:" prefix (when browsable). */
    category?: string;
    /** Tokens appended / boosted in live search. */
    tokens: string[];
}

export interface SearchFilters {
    composerCategory?: string;
    instrument?: string;
    form?: string;
    key?: string;
    era?: EraId;
}

export const COMPOSER_FACETS: FacetValueData[] = [
    { id: 'beethoven', label: 'Beethoven', category: 'Beethoven, Ludwig van', tokens: ['Beethoven'] },
    { id: 'bach', label: 'Bach', category: 'Bach, Johann Sebastian', tokens: ['Bach'] },
    { id: 'mozart', label: 'Mozart', category: 'Mozart, Wolfgang Amadeus', tokens: ['Mozart'] },
    { id: 'chopin', label: 'Chopin', category: 'Chopin, Frédéric', tokens: ['Chopin'] },
    { id: 'schubert', label: 'Schubert', category: 'Schubert, Franz', tokens: ['Schubert'] },
    { id: 'tchaikovsky', label: 'Tchaikovsky', category: 'Tchaikovsky, Pyotr', tokens: ['Tchaikovsky'] },
    { id: 'debussy', label: 'Debussy', category: 'Debussy, Claude', tokens: ['Debussy'] },
    { id: 'brahms', label: 'Brahms', category: 'Brahms, Johannes', tokens: ['Brahms'] },
    { id: 'liszt', label: 'Liszt', category: 'Liszt, Franz', tokens: ['Liszt'] },
    { id: 'schumann', label: 'Schumann', category: 'Schumann, Robert', tokens: ['Schumann'] },
    { id: 'vivaldi', label: 'Vivaldi', category: 'Vivaldi, Antonio', tokens: ['Vivaldi'] },
    { id: 'handel', label: 'Handel', category: 'Handel, George Frideric', tokens: ['Handel'] },
    { id: 'haydn', label: 'Haydn', category: 'Haydn, Joseph', tokens: ['Haydn'] },
    { id: 'ravel', label: 'Ravel', category: 'Ravel, Maurice', tokens: ['Ravel'] },
    { id: 'joplin', label: 'Joplin', category: 'Joplin, Scott', tokens: ['Joplin'] },
    { id: 'satie', label: 'Satie', category: 'Satie, Erik', tokens: ['Satie'] },
    { id: 'rachmaninoff', label: 'Rachmaninoff', category: 'Rachmaninoff, Sergei', tokens: ['Rachmaninoff'] },
    { id: 'mendelssohn', label: 'Mendelssohn', category: 'Mendelssohn, Felix', tokens: ['Mendelssohn'] },
];

export const INSTRUMENT_FACETS: FacetValueData[] = [
    { id: 'piano', label: 'Piano', category: 'For piano', tokens: ['piano'] },
    { id: 'violin', label: 'Violin', category: 'For violin', tokens: ['violin'] },
    { id: 'cello', label: 'Cello', category: 'For cello', tokens: ['cello'] },
    { id: 'guitar', label: 'Guitar', category: 'For guitar', tokens: ['guitar'] },
    { id: 'voice', label: 'Voice', category: 'For voice, piano', tokens: ['voice', 'song'] },
    { id: 'flute', label: 'Flute', category: 'For flute', tokens: ['flute'] },
    { id: 'organ', label: 'Organ', category: 'For organ', tokens: ['organ'] },
    { id: 'orchestra', label: 'Orchestra', category: 'For orchestra', tokens: ['orchestra', 'symphony'] },
];

export const FORM_FACETS: FacetValueData[] = [
    { id: 'sonata', label: 'Sonata', category: 'Sonatas', tokens: ['sonata'] },
    { id: 'concerto', label: 'Concerto', category: 'Concertos', tokens: ['concerto'] },
    { id: 'symphony', label: 'Symphony', category: 'Symphonies', tokens: ['symphony'] },
    { id: 'nocturne', label: 'Nocturne', category: 'Nocturnes', tokens: ['nocturne'] },
    { id: 'prelude', label: 'Prelude', category: 'Preludes', tokens: ['prelude'] },
    { id: 'fugue', label: 'Fugue', category: 'Fugues', tokens: ['fugue'] },
    { id: 'waltz', label: 'Waltz', category: 'Waltzes', tokens: ['waltz'] },
    { id: 'etude', label: 'Étude', category: 'Etudes', tokens: ['etude', 'étude'] },
    { id: 'opera', label: 'Opera', category: 'Operas', tokens: ['opera'] },
    { id: 'ballet', label: 'Ballet', category: 'Ballets', tokens: ['ballet'] },
];

// Symbol spellings (E♭, C♯) are not duplicated as tokens: foldAccents maps
// ♭ → "-flat" and ♯ → "-sharp", so a typed symbol matches these spellings.
export const KEY_FACETS: FacetValueData[] = [
    { id: 'c-major', label: 'C major', tokens: ['C major'] },
    { id: 'g-major', label: 'G major', tokens: ['G major'] },
    { id: 'd-major', label: 'D major', tokens: ['D major'] },
    { id: 'a-major', label: 'A major', tokens: ['A major'] },
    { id: 'e-flat-major', label: 'E-flat major', tokens: ['E-flat major'] },
    { id: 'a-minor', label: 'A minor', tokens: ['A minor'] },
    { id: 'd-minor', label: 'D minor', tokens: ['D minor'] },
    { id: 'e-minor', label: 'E minor', tokens: ['E minor'] },
    { id: 'c-minor', label: 'C minor', tokens: ['C minor'] },
    { id: 'c-sharp-minor', label: 'C-sharp minor', tokens: ['C-sharp minor'] },
];

export const ERA_FACETS: FacetValueData[] = [
    { id: 'baroque', label: 'Baroque', tokens: ['Bach', 'Vivaldi', 'Handel'] },
    { id: 'classical', label: 'Classical', tokens: ['Mozart', 'Haydn', 'Beethoven'] },
    { id: 'romantic', label: 'Romantic', tokens: ['Chopin', 'Schubert', 'Brahms'] },
    { id: 'modern', label: 'Modern', tokens: ['Debussy', 'Ravel', 'Rachmaninoff'] },
];

/** Representative surnames injected when era is set without a composer. */
export const ERA_COMPOSER_SEEDS: Record<EraId, string[]> = {
    baroque: ['Bach', 'Vivaldi', 'Handel', 'Pachelbel'],
    classical: ['Mozart', 'Haydn', 'Beethoven'],
    romantic: ['Chopin', 'Schubert', 'Brahms', 'Liszt', 'Schumann', 'Tchaikovsky'],
    modern: ['Debussy', 'Ravel', 'Satie', 'Rachmaninoff', 'Joplin'],
};

// Prototype-free: these maps are read by untrusted ids, so "constructor" or
// "toString" must miss rather than resolve to an Object.prototype member.
const byId = (values: FacetValueData[]): Record<string, FacetValueData> => {
    const out = Object.create(null) as Record<string, FacetValueData>;
    for (const v of values) {
        out[v.id] = v;
    }
    return out;
};

export const INSTRUMENT_BY_ID: Record<string, FacetValueData> = byId(INSTRUMENT_FACETS);
export const FORM_BY_ID: Record<string, FacetValueData> = byId(FORM_FACETS);
export const KEY_BY_ID: Record<string, FacetValueData> = byId(KEY_FACETS);
export const ERA_IDS: ReadonlySet<string> = new Set(ERA_FACETS.map((e) => e.id));

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export const hasActiveFilters = (filters: SearchFilters | undefined): boolean => {
    if (!filters) {
        return false;
    }
    return Boolean(filters.composerCategory || filters.instrument || filters.form || filters.key || filters.era);
};

/**
 * Best category for empty-query browse: composer > form > instrument. Form
 * before instrument because form categories (Nocturnes, Sonatas) are far
 * smaller than "For piano" — with an instrument also active, members of the
 * small category get verified against the instrument categories, which is the
 * cheap direction.
 */
export const primaryBrowseCategory = (filters: SearchFilters): string | null => {
    if (filters.composerCategory) {
        return filters.composerCategory;
    }
    if (filters.form && FORM_BY_ID[filters.form]?.category) {
        return FORM_BY_ID[filters.form]?.category ?? null;
    }
    if (filters.instrument && INSTRUMENT_BY_ID[filters.instrument]?.category) {
        return INSTRUMENT_BY_ID[filters.instrument]?.category ?? null;
    }
    return null;
};

/**
 * IMSLP categories that must contain a hit for it to survive the instrument
 * filter. Includes the "(arr)" variant — arrangements for the instrument are
 * fine to play, just ranked below originals.
 */
export const hardFilterCategories = (filters: SearchFilters): string[] => {
    if (!filters.instrument) {
        return [];
    }
    const category = INSTRUMENT_BY_ID[filters.instrument]?.category;
    if (!category) {
        return [];
    }
    return [category, `${category} (arr)`];
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
    if (filters.instrument && INSTRUMENT_BY_ID[filters.instrument]) {
        out.push(...(INSTRUMENT_BY_ID[filters.instrument]?.tokens ?? []));
    }
    if (filters.form && FORM_BY_ID[filters.form]) {
        out.push(...(FORM_BY_ID[filters.form]?.tokens ?? []));
    }
    if (filters.key && KEY_BY_ID[filters.key]) {
        out.push(...(KEY_BY_ID[filters.key]?.tokens ?? []));
    }
    if (filters.era && ERA_COMPOSER_SEEDS[filters.era]) {
        out.push(...ERA_COMPOSER_SEEDS[filters.era].slice(0, 3));
    }
    return out;
};

/** Title must match secondary facet constraints when browsing a primary category. */
export const titleMatchesFilters = (title: string, filters: SearchFilters): boolean => {
    const folded = fold(title);

    if (filters.composerCategory && primaryBrowseCategory(filters) !== filters.composerCategory) {
        const surname = filters.composerCategory.split(',')[0]?.trim().toLowerCase();
        if (surname && !folded.includes(fold(surname))) {
            return false;
        }
    }

    const instrument = filters.instrument ? INSTRUMENT_BY_ID[filters.instrument] : undefined;
    if (instrument) {
        // When browsing instrument category itself, skip token check.
        if (primaryBrowseCategory(filters) !== instrument.category) {
            if (!instrument.tokens.some((t) => folded.includes(t.toLowerCase()))) {
                return false;
            }
        }
    }

    const form = filters.form ? FORM_BY_ID[filters.form] : undefined;
    if (form) {
        const tokens = form.tokens.map(fold);
        if (primaryBrowseCategory(filters) !== form.category) {
            if (!tokens.some((t) => folded.includes(t))) {
                return false;
            }
        }
    }

    const key = filters.key ? KEY_BY_ID[filters.key] : undefined;
    if (key) {
        const keys = key.tokens.map(fold);
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
    const folded = fold(title);

    if (filters.composerCategory) {
        const surname = filters.composerCategory.split(',')[0]?.trim().toLowerCase() ?? '';
        if (surname && folded.includes(surname)) {
            boost += 20;
        }
    }
    for (const tok of facetTokens(filters)) {
        const t = fold(tok);
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

/** "Surname, First" shape — sanity bound for the free-text composer category. */
const COMPOSER_CATEGORY_RE = /^[\p{L}\p{M}.'\- ]+,\s?[\p{L}\p{M}.'\- ]+$/u;

/**
 * Validate raw filters. Ids outside the shared taxonomy are dropped rather
 * than passed through — an unknown id used to silently behave as no filter,
 * which hid client/server drift.
 */
export const parseFilters = (raw: unknown): SearchFilters => {
    if (!raw || typeof raw !== 'object') {
        return {};
    }
    const o = raw as Record<string, unknown>;
    const filters: SearchFilters = {};
    if (typeof o['composerCategory'] === 'string') {
        const category = o['composerCategory'].trim();
        if (category && category.length <= 80 && COMPOSER_CATEGORY_RE.test(category)) {
            filters.composerCategory = category;
        }
    }
    if (typeof o['instrument'] === 'string' && INSTRUMENT_BY_ID[o['instrument'].trim()]) {
        filters.instrument = o['instrument'].trim();
    }
    if (typeof o['form'] === 'string' && FORM_BY_ID[o['form'].trim()]) {
        filters.form = o['form'].trim();
    }
    if (typeof o['key'] === 'string' && KEY_BY_ID[o['key'].trim()]) {
        filters.key = o['key'].trim();
    }
    if (typeof o['era'] === 'string' && ERA_IDS.has(o['era'].trim())) {
        filters.era = o['era'].trim() as EraId;
    }
    return filters;
};
