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
    type EraId,
    type FacetDimension,
    type FacetValueData,
    type SearchFilters,
} from '../../../supabase/functions/_shared/searchFacetData';

export {
    COMPOSER_FACETS,
    ERA_COMPOSER_SEEDS,
    ERA_FACETS,
    FORM_FACETS,
    INSTRUMENT_FACETS,
    KEY_FACETS,
} from '../../../supabase/functions/_shared/searchFacetData';
export type {
    EraId,
    FacetDimension,
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

export const hasActiveFilters = (filters: SearchFilters): boolean =>
    Boolean(filters.composerCategory || filters.instrument || filters.form || filters.key || filters.era);

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
