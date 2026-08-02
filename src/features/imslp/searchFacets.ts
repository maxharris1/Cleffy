/**
 * Facet dimensions for IMSLP find: map UI tags → category titles + search tokens.
 * Era has no reliable work category on IMSLP — seed composers instead.
 */

export type FacetDimension = 'composer' | 'instrument' | 'form' | 'key' | 'era';
export type SearchSort = 'relevance' | 'title' | 'recent';
export type EraId = 'baroque' | 'classical' | 'romantic' | 'modern';

export interface FacetValue {
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

export const FACET_DIMENSIONS: Array<{ id: FacetDimension; label: string }> = [
    { id: 'composer', label: 'Composer' },
    { id: 'instrument', label: 'Instrument' },
    { id: 'form', label: 'Form' },
    { id: 'key', label: 'Key' },
    { id: 'era', label: 'Era' },
];

export const COMPOSER_FACETS: FacetValue[] = [
    {
        id: 'beethoven',
        label: 'Beethoven',
        category: 'Beethoven, Ludwig van',
        tokens: ['Beethoven'],
    },
    {
        id: 'bach',
        label: 'Bach',
        category: 'Bach, Johann Sebastian',
        tokens: ['Bach'],
    },
    {
        id: 'mozart',
        label: 'Mozart',
        category: 'Mozart, Wolfgang Amadeus',
        tokens: ['Mozart'],
    },
    {
        id: 'chopin',
        label: 'Chopin',
        category: 'Chopin, Frédéric',
        tokens: ['Chopin'],
    },
    {
        id: 'schubert',
        label: 'Schubert',
        category: 'Schubert, Franz',
        tokens: ['Schubert'],
    },
    {
        id: 'tchaikovsky',
        label: 'Tchaikovsky',
        category: 'Tchaikovsky, Pyotr',
        tokens: ['Tchaikovsky'],
    },
    {
        id: 'debussy',
        label: 'Debussy',
        category: 'Debussy, Claude',
        tokens: ['Debussy'],
    },
    {
        id: 'brahms',
        label: 'Brahms',
        category: 'Brahms, Johannes',
        tokens: ['Brahms'],
    },
    {
        id: 'liszt',
        label: 'Liszt',
        category: 'Liszt, Franz',
        tokens: ['Liszt'],
    },
    {
        id: 'schumann',
        label: 'Schumann',
        category: 'Schumann, Robert',
        tokens: ['Schumann'],
    },
    {
        id: 'vivaldi',
        label: 'Vivaldi',
        category: 'Vivaldi, Antonio',
        tokens: ['Vivaldi'],
    },
    {
        id: 'handel',
        label: 'Handel',
        category: 'Handel, George Frideric',
        tokens: ['Handel'],
    },
    {
        id: 'haydn',
        label: 'Haydn',
        category: 'Haydn, Joseph',
        tokens: ['Haydn'],
    },
    {
        id: 'ravel',
        label: 'Ravel',
        category: 'Ravel, Maurice',
        tokens: ['Ravel'],
    },
    {
        id: 'joplin',
        label: 'Joplin',
        category: 'Joplin, Scott',
        tokens: ['Joplin'],
    },
    {
        id: 'satie',
        label: 'Satie',
        category: 'Satie, Erik',
        tokens: ['Satie'],
    },
    {
        id: 'rachmaninoff',
        label: 'Rachmaninoff',
        category: 'Rachmaninoff, Sergei',
        tokens: ['Rachmaninoff'],
    },
    {
        id: 'mendelssohn',
        label: 'Mendelssohn',
        category: 'Mendelssohn, Felix',
        tokens: ['Mendelssohn'],
    },
];

export const INSTRUMENT_FACETS: FacetValue[] = [
    { id: 'piano', label: 'Piano', category: 'For piano', tokens: ['piano'] },
    { id: 'violin', label: 'Violin', category: 'For violin', tokens: ['violin'] },
    { id: 'cello', label: 'Cello', category: 'For cello', tokens: ['cello'] },
    { id: 'guitar', label: 'Guitar', category: 'For guitar', tokens: ['guitar'] },
    { id: 'voice', label: 'Voice', category: 'For voice, piano', tokens: ['voice', 'song'] },
    { id: 'flute', label: 'Flute', category: 'For flute', tokens: ['flute'] },
    { id: 'organ', label: 'Organ', category: 'For organ', tokens: ['organ'] },
    { id: 'orchestra', label: 'Orchestra', category: 'For orchestra', tokens: ['orchestra', 'symphony'] },
];

export const FORM_FACETS: FacetValue[] = [
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

export const KEY_FACETS: FacetValue[] = [
    { id: 'c-major', label: 'C major', tokens: ['C major'] },
    { id: 'g-major', label: 'G major', tokens: ['G major'] },
    { id: 'd-major', label: 'D major', tokens: ['D major'] },
    { id: 'a-major', label: 'A major', tokens: ['A major'] },
    { id: 'e-flat-major', label: 'E-flat major', tokens: ['E-flat major', 'E♭ major'] },
    { id: 'a-minor', label: 'A minor', tokens: ['A minor'] },
    { id: 'd-minor', label: 'D minor', tokens: ['D minor'] },
    { id: 'e-minor', label: 'E minor', tokens: ['E minor'] },
    { id: 'c-minor', label: 'C minor', tokens: ['C minor'] },
    { id: 'c-sharp-minor', label: 'C-sharp minor', tokens: ['C-sharp minor', 'C♯ minor'] },
];

export const ERA_FACETS: FacetValue[] = [
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

export const facetValuesFor = (dimension: FacetDimension): FacetValue[] => {
    switch (dimension) {
        case 'composer':
            return COMPOSER_FACETS;
        case 'instrument':
            return INSTRUMENT_FACETS;
        case 'form':
            return FORM_FACETS;
        case 'key':
            return KEY_FACETS;
        case 'era':
            return ERA_FACETS;
        default: {
            const _exhaustive: never = dimension;
            return _exhaustive;
        }
    }
};

export const hasActiveFilters = (filters: SearchFilters): boolean =>
    Boolean(
        filters.composerCategory ||
            filters.instrument ||
            filters.form ||
            filters.key ||
            filters.era,
    );

/** Whether category browse / A–Z / New sort are meaningful. */
export const categoryBackedFilters = (filters: SearchFilters): boolean =>
    Boolean(filters.composerCategory || filters.instrument || filters.form);

export const filtersToStatusParts = (filters: SearchFilters): string[] => {
    const parts: string[] = [];
    if (filters.composerCategory) {
        const match = COMPOSER_FACETS.find((c) => c.category === filters.composerCategory);
        parts.push(match?.label ?? filters.composerCategory.split(',')[0] ?? 'Composer');
    }
    if (filters.instrument) {
        parts.push(INSTRUMENT_FACETS.find((i) => i.id === filters.instrument)?.label ?? filters.instrument);
    }
    if (filters.form) {
        parts.push(FORM_FACETS.find((f) => f.id === filters.form)?.label ?? filters.form);
    }
    if (filters.key) {
        parts.push(KEY_FACETS.find((k) => k.id === filters.key)?.label ?? filters.key);
    }
    if (filters.era) {
        parts.push(ERA_FACETS.find((e) => e.id === filters.era)?.label ?? filters.era);
    }
    return parts;
};

/** Collect all search tokens implied by active filters (for highlighting). */
export const filterSearchTokens = (filters: SearchFilters): string[] => {
    const out: string[] = [];
    if (filters.composerCategory) {
        const match = COMPOSER_FACETS.find((c) => c.category === filters.composerCategory);
        out.push(...(match?.tokens ?? []));
    }
    if (filters.instrument) {
        out.push(...(INSTRUMENT_FACETS.find((i) => i.id === filters.instrument)?.tokens ?? []));
    }
    if (filters.form) {
        out.push(...(FORM_FACETS.find((f) => f.id === filters.form)?.tokens ?? []));
    }
    if (filters.key) {
        out.push(...(KEY_FACETS.find((k) => k.id === filters.key)?.tokens ?? []));
    }
    if (filters.era) {
        out.push(...(ERA_COMPOSER_SEEDS[filters.era] ?? []).slice(0, 2));
    }
    return out;
};

/** Build API filters object from selected facet value ids. */
export const buildSearchFilters = (selected: {
    composerId?: string | null;
    instrumentId?: string | null;
    formId?: string | null;
    keyId?: string | null;
    eraId?: EraId | null;
}): SearchFilters => {
    const filters: SearchFilters = {};
    if (selected.composerId) {
        const c = COMPOSER_FACETS.find((x) => x.id === selected.composerId);
        if (c?.category) {
            filters.composerCategory = c.category;
        }
    }
    if (selected.instrumentId) {
        filters.instrument = selected.instrumentId;
    }
    if (selected.formId) {
        filters.form = selected.formId;
    }
    if (selected.keyId) {
        filters.key = selected.keyId;
    }
    if (selected.eraId) {
        filters.era = selected.eraId;
    }
    return filters;
};
