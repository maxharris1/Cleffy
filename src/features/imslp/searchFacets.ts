/**
 * Facet dimensions for IMSLP find. The taxonomy itself (values, categories,
 * search tokens) lives in supabase/functions/_shared/searchFacetData.ts so the
 * edge search and this UI read one definition; this module adds the UI-side
 * helpers (status lines, filter building).
 */

import {
    COMPOSER_FACETS,
    ERA_FACETS,
    FORM_FACETS,
    INSTRUMENT_FACETS,
    KEY_FACETS,
    categoryGroupsFor,
    type EraId,
    type FacetDimension,
    type FacetValueData,
    type SearchFilters,
} from '../../../supabase/functions/_shared/searchFacetData';

export {
    COMPOSER_FACETS,
    ERA_FACETS,
    FORM_FACETS,
    INSTRUMENT_FACETS,
    KEY_FACETS,
    MAX_FILTERS_PER_DIMENSION,
    hasActiveFilters,
} from '../../../supabase/functions/_shared/searchFacetData';
export type {
    EraId,
    FacetDimension,
    RelaxedConstraint,
    SearchFilters,
    SearchSort,
} from '../../../supabase/functions/_shared/searchFacetData';

export type FacetValue = FacetValueData;

export const FACET_DIMENSIONS: Array<{ id: FacetDimension; label: string }> = [
    { id: 'composer', label: 'Composer' },
    { id: 'instrument', label: 'Instrument' },
    { id: 'form', label: 'Form' },
    { id: 'key', label: 'Key' },
    { id: 'era', label: 'Era' },
];

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

/** Whether category browse / A–Z / New sort are meaningful. */
export const categoryBackedFilters = (filters: SearchFilters): boolean => categoryGroupsFor(filters).length > 0;

export const filtersToStatusParts = (filters: SearchFilters): string[] => {
    const parts: string[] = [];
    for (const category of filters.composerCategories ?? []) {
        const match = COMPOSER_FACETS.find((c) => c.category === category);
        parts.push(match?.label ?? category.split(',')[0] ?? 'Composer');
    }
    for (const id of filters.instruments ?? []) {
        parts.push(INSTRUMENT_FACETS.find((i) => i.id === id)?.label ?? id);
    }
    for (const id of filters.forms ?? []) {
        parts.push(FORM_FACETS.find((f) => f.id === id)?.label ?? id);
    }
    for (const id of filters.keys ?? []) {
        parts.push(KEY_FACETS.find((k) => k.id === id)?.label ?? id);
    }
    for (const id of filters.eras ?? []) {
        parts.push(ERA_FACETS.find((e) => e.id === id)?.label ?? id);
    }
    return parts;
};

/**
 * Chip labels for IMSLP category titles the server reports (e.g. notReady),
 * so copy says "Piano and Nocturne" rather than "For piano (arr)". Unknown
 * categories fall back to their own title; duplicates collapse.
 */
export const labelsForCategories = (categories: string[]): string[] => {
    const labels: string[] = [];
    const push = (label: string) => {
        if (!labels.includes(label)) {
            labels.push(label);
        }
    };
    for (const raw of categories) {
        const category = raw.replace(/\s*\(arr\)$/i, '');
        const facet = [...INSTRUMENT_FACETS, ...FORM_FACETS, ...ERA_FACETS, ...COMPOSER_FACETS].find(
            (f) => f.category === category,
        );
        push(facet?.label ?? raw);
    }
    return labels;
};

/** "Piano", "Piano and Baroque", "Piano, Baroque and Nocturne". */
export const joinLabels = (labels: string[]): string => {
    if (labels.length <= 1) {
        return labels[0] ?? '';
    }
    return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
};

/** Build API filters object from selected facet value ids (multi-select). */
export const buildSearchFilters = (selected: {
    composerIds?: Iterable<string>;
    instrumentIds?: Iterable<string>;
    formIds?: Iterable<string>;
    keyIds?: Iterable<string>;
    eraIds?: Iterable<string>;
    ignoreQueryPeriod?: boolean;
}): SearchFilters => {
    const filters: SearchFilters = {};
    const composerCategories: string[] = [];
    for (const id of selected.composerIds ?? []) {
        const c = COMPOSER_FACETS.find((x) => x.id === id);
        if (c?.category) {
            composerCategories.push(c.category);
        }
    }
    if (composerCategories.length > 0) {
        filters.composerCategories = composerCategories;
    }
    const instruments = [...(selected.instrumentIds ?? [])];
    if (instruments.length > 0) {
        filters.instruments = instruments;
    }
    const forms = [...(selected.formIds ?? [])];
    if (forms.length > 0) {
        filters.forms = forms;
    }
    const keys = [...(selected.keyIds ?? [])];
    if (keys.length > 0) {
        filters.keys = keys;
    }
    const eras = [...(selected.eraIds ?? [])].filter((id): id is EraId => ERA_FACETS.some((e) => e.id === id));
    if (eras.length > 0) {
        filters.eras = eras;
    }
    if (selected.ignoreQueryPeriod) {
        filters.ignoreQueryPeriod = true;
    }
    return filters;
};
