/**
 * Client view over the shared curated list (supabase/functions/_shared/popularWorks.ts)
 * plus UI-only grouping/filtering helpers. The list itself lives in _shared so the
 * edge ranker's popularity prior and the Popular list cannot drift apart.
 */

import type { EraId } from '@/features/imslp/searchFacets';

export { POPULAR_WORKS } from '../../../supabase/functions/_shared/popularWorks';
export type { PopularWork } from '../../../supabase/functions/_shared/popularWorks';

import { POPULAR_WORKS, type PopularWork } from '../../../supabase/functions/_shared/popularWorks';

export interface ComposerGroup {
    composer: string;
    works: PopularWork[];
}

/** Group curated works by composer for Browse mode (stable alpha order). */
export const groupPopularByComposer = (works: PopularWork[] = POPULAR_WORKS): ComposerGroup[] => {
    const map = new Map<string, PopularWork[]>();
    for (const work of works) {
        const list = map.get(work.composer);
        if (list) {
            list.push(work);
        } else {
            map.set(work.composer, [work]);
        }
    }
    return [...map.entries()]
        .map(([composer, groupWorks]) => ({ composer, works: groupWorks }))
        .sort((a, b) => a.composer.localeCompare(b.composer));
};

/** Filter curated works by facet ids (local browse when no live results needed). */
export const filterPopularWorks = (
    works: PopularWork[],
    selected: {
        composerId?: string | null;
        instrumentId?: string | null;
        formId?: string | null;
        keyId?: string | null;
        eraId?: EraId | null;
    },
): PopularWork[] => {
    return works.filter((work) => {
        if (selected.composerId) {
            // COMPOSER_FACETS ids are lowercase surnames, so a substring check
            // against the short composer label covers every curated entry.
            const short = work.composer.toLowerCase();
            const cat = work.composerCategory?.toLowerCase() ?? '';
            if (!short.includes(selected.composerId) && !cat.includes(selected.composerId)) {
                return false;
            }
        }
        if (selected.instrumentId && work.instrument !== selected.instrumentId) {
            return false;
        }
        if (selected.formId && work.form !== selected.formId) {
            return false;
        }
        if (selected.keyId && work.key !== selected.keyId) {
            return false;
        }
        if (selected.eraId && work.era !== selected.eraId) {
            return false;
        }
        return true;
    });
};
