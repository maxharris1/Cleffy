/**
 * Facet taxonomy for IMSLP find — the single source of truth for the edge
 * search (_shared/facets.ts) and the client UI (src/features/imslp/searchFacets.ts).
 *
 * NO imports — like entitlements.ts and studentCodes.ts, this file is loaded
 * by Deno (with the `.ts` extension) and by Vite/vitest (without it), so both
 * runtimes read one definition and cannot drift from each other.
 *
 * Era chips bind to IMSLP period categories (Baroque, Classical, Romantic,
 * Early 20th century, Modern). Key is a title constraint only — it has no
 * work category.
 */

export type FacetDimension = 'composer' | 'instrument' | 'form' | 'key' | 'era';
export type SearchSort = 'relevance' | 'title' | 'recent';
export type EraId = 'baroque' | 'classical' | 'romantic' | 'early-20th' | 'modern';
export type RelaxedConstraint = 'instrument' | 'era';

export interface FacetValueData {
    id: string;
    label: string;
    /** IMSLP Category: title without "Category:" prefix (when browsable). */
    category?: string;
    /** Tokens appended / boosted in live search. */
    tokens: string[];
}

/**
 * Multi-select filters. Within a dimension = OR (one UNION group); across
 * dimensions = AND (INTERSECT). Legacy singular field names are accepted by
 * parseFilters for one release.
 */
export interface SearchFilters {
    composerCategories?: string[];
    instruments?: string[];
    forms?: string[];
    keys?: string[];
    eras?: EraId[];
    /** Typed-search only: do not apply a period inferred from the query. */
    ignoreQueryPeriod?: boolean;
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
    { id: 'baroque', label: 'Baroque', category: 'Baroque', tokens: ['baroque'] },
    { id: 'classical', label: 'Classical', category: 'Classical', tokens: ['classical'] },
    { id: 'romantic', label: 'Romantic', category: 'Romantic', tokens: ['romantic'] },
    { id: 'early-20th', label: 'Early 20th century', category: 'Early 20th century', tokens: ['early 20th'] },
    { id: 'modern', label: 'Modern', category: 'Modern', tokens: ['modern'] },
];

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
export const ERA_BY_ID: Record<string, FacetValueData> = byId(ERA_FACETS);
export const ERA_IDS: ReadonlySet<string> = new Set(ERA_FACETS.map((e) => e.id));

const MAX_FILTERS_PER_DIMENSION = 6;

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const uniqCap = (ids: string[], cap = MAX_FILTERS_PER_DIMENSION): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of ids) {
        const id = raw.trim();
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        out.push(id);
        if (out.length >= cap) {
            break;
        }
    }
    return out;
};

export const hasActiveFilters = (filters: SearchFilters | undefined): boolean => {
    if (!filters) {
        return false;
    }
    return Boolean(
        (filters.composerCategories && filters.composerCategories.length > 0) ||
            (filters.instruments && filters.instruments.length > 0) ||
            (filters.forms && filters.forms.length > 0) ||
            (filters.keys && filters.keys.length > 0) ||
            (filters.eras && filters.eras.length > 0),
    );
};

const instrumentCategories = (id: string): string[] => {
    const category = INSTRUMENT_BY_ID[id]?.category;
    if (!category) {
        return [];
    }
    return [category, `${category} (arr)`];
};

/**
 * One UNION group per active dimension (OR within, AND across). Instrument
 * groups include the "(arr)" variant. Key produces no group — title only.
 */
export const categoryGroupsFor = (filters: SearchFilters): string[][] => {
    const groups: string[][] = [];

    if (filters.composerCategories && filters.composerCategories.length > 0) {
        groups.push([...filters.composerCategories]);
    }

    if (filters.instruments && filters.instruments.length > 0) {
        const cats: string[] = [];
        for (const id of filters.instruments) {
            cats.push(...instrumentCategories(id));
        }
        if (cats.length > 0) {
            groups.push(cats);
        }
    }

    if (filters.forms && filters.forms.length > 0) {
        const cats: string[] = [];
        for (const id of filters.forms) {
            const category = FORM_BY_ID[id]?.category;
            if (category) {
                cats.push(category);
            }
        }
        if (cats.length > 0) {
            groups.push(cats);
        }
    }

    if (filters.eras && filters.eras.length > 0) {
        const cats: string[] = [];
        for (const id of filters.eras) {
            const category = ERA_BY_ID[id]?.category;
            if (category) {
                cats.push(category);
            }
        }
        if (cats.length > 0) {
            groups.push(cats);
        }
    }

    return groups;
};

/** Flattened categories from groups — used to ask which snapshots are missing. */
export const categoriesInGroups = (groups: string[][]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const group of groups) {
        for (const category of group) {
            if (!seen.has(category)) {
                seen.add(category);
                out.push(category);
            }
        }
    }
    return out;
};

/**
 * Hard-filter groups for typed search, one per dimension: a hit must belong to
 * at least one category in EVERY group (OR within, AND across). Instrument
 * includes "(arr)"; era is the period category. A flat list of these would let
 * For piano membership satisfy a Baroque chip.
 */
export const hardFilterGroups = (filters: SearchFilters): string[][] => {
    const groups: string[][] = [];
    const instruments: string[] = [];
    for (const id of filters.instruments ?? []) {
        instruments.push(...instrumentCategories(id));
    }
    if (instruments.length > 0) {
        groups.push(instruments);
    }
    const eras: string[] = [];
    for (const id of filters.eras ?? []) {
        const category = ERA_BY_ID[id]?.category;
        if (category) {
            eras.push(category);
        }
    }
    if (eras.length > 0) {
        groups.push(eras);
    }
    return groups;
};

/** Flattened hardFilterGroups — the categories whose membership must be looked up. */
export const hardFilterCategories = (filters: SearchFilters): string[] => hardFilterGroups(filters).flat();

/** Extra search tokens implied by filters. Era is category membership, not tokens. */
export const facetTokens = (filters: SearchFilters): string[] => {
    const out: string[] = [];
    for (const category of filters.composerCategories ?? []) {
        const surname = category.split(',')[0]?.trim();
        if (surname) {
            out.push(surname);
        }
    }
    for (const id of filters.instruments ?? []) {
        if (INSTRUMENT_BY_ID[id]) {
            out.push(...(INSTRUMENT_BY_ID[id]?.tokens ?? []));
        }
    }
    for (const id of filters.forms ?? []) {
        if (FORM_BY_ID[id]) {
            out.push(...(FORM_BY_ID[id]?.tokens ?? []));
        }
    }
    for (const id of filters.keys ?? []) {
        if (KEY_BY_ID[id]) {
            out.push(...(KEY_BY_ID[id]?.tokens ?? []));
        }
    }
    return out;
};

/**
 * Key has no IMSLP category, so browse narrows the intersection by title inside
 * imslp_browse. One case-insensitive Postgres regex per key chip, word-bounded so
 * "C major" does not match "C-sharp major".
 */
export const keyTitlePatterns = (filters: SearchFilters): string[] => {
    const patterns: string[] = [];
    for (const id of filters.keys ?? []) {
        for (const token of KEY_BY_ID[id]?.tokens ?? []) {
            const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            patterns.push(`\\m${escaped}\\M`);
        }
    }
    return patterns;
};

/**
 * Title must match key (and only key) when a key chip is set. Other dimensions
 * are category membership. Used for typed-search hits, whose titles arrive
 * from MediaWiki rather than the index.
 */
export const titleMatchesFilters = (title: string, filters: SearchFilters): boolean => {
    const folded = fold(title);
    const keys = filters.keys ?? [];
    if (keys.length === 0) {
        return true;
    }
    return keys.some((id) => {
        const key = KEY_BY_ID[id];
        if (!key) {
            return false;
        }
        return key.tokens.map(fold).some((t) => folded.includes(t));
    });
};

/** Extra score for hits that align with active facets. */
export const facetBoost = (title: string, filters: SearchFilters): number => {
    let boost = 0;
    const folded = fold(title);

    for (const category of filters.composerCategories ?? []) {
        const surname = category.split(',')[0]?.trim().toLowerCase() ?? '';
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

const asStringList = (raw: unknown): string[] => {
    if (typeof raw === 'string') {
        return [raw];
    }
    if (Array.isArray(raw)) {
        return raw.filter((v): v is string => typeof v === 'string');
    }
    return [];
};

const parseComposerCategories = (o: Record<string, unknown>): string[] => {
    const fromArray = asStringList(o['composerCategories']);
    const fromSingular = typeof o['composerCategory'] === 'string' ? [o['composerCategory']] : [];
    const accepted: string[] = [];
    for (const value of [...fromArray, ...fromSingular]) {
        const category = value.trim();
        if (category && category.length <= 80 && COMPOSER_CATEGORY_RE.test(category)) {
            accepted.push(category);
        }
    }
    return uniqCap(accepted);
};

const parseKnownIds = (raw: unknown, extra: unknown, isKnown: (id: string) => boolean): string[] => {
    const ids = [...asStringList(raw), ...asStringList(extra)];
    const accepted: string[] = [];
    for (const value of ids) {
        const id = value.trim();
        if (id && isKnown(id)) {
            accepted.push(id);
        }
    }
    return uniqCap(accepted);
};

/**
 * Validate raw filters. Ids outside the shared taxonomy are dropped rather
 * than passed through — an unknown id used to silently behave as no filter,
 * which hid client/server drift. Accepts the old singular field names for
 * one release so an un-refreshed tab keeps working.
 */
export const parseFilters = (raw: unknown): SearchFilters => {
    if (!raw || typeof raw !== 'object') {
        return {};
    }
    const o = raw as Record<string, unknown>;
    const filters: SearchFilters = {};

    const composerCategories = parseComposerCategories(o);
    if (composerCategories.length > 0) {
        filters.composerCategories = composerCategories;
    }

    const instruments = parseKnownIds(o['instruments'], o['instrument'], (id) => Boolean(INSTRUMENT_BY_ID[id]));
    if (instruments.length > 0) {
        filters.instruments = instruments;
    }

    const forms = parseKnownIds(o['forms'], o['form'], (id) => Boolean(FORM_BY_ID[id]));
    if (forms.length > 0) {
        filters.forms = forms;
    }

    const keys = parseKnownIds(o['keys'], o['key'], (id) => Boolean(KEY_BY_ID[id]));
    if (keys.length > 0) {
        filters.keys = keys;
    }

    const eras = parseKnownIds(o['eras'], o['era'], (id) => ERA_IDS.has(id));
    if (eras.length > 0) {
        filters.eras = eras as EraId[];
    }

    if (o['ignoreQueryPeriod'] === true) {
        filters.ignoreQueryPeriod = true;
    }

    return filters;
};
