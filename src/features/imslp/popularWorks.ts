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

const setHas = (ids: Iterable<string> | undefined): Set<string> => {
    const set = ids instanceof Set ? ids : new Set(ids ?? []);
    return set;
};

/** Filter curated works by facet ids (local browse when no live results needed). */
export const filterPopularWorks = (
    works: PopularWork[],
    selected: {
        composerIds?: Iterable<string>;
        instrumentIds?: Iterable<string>;
        formIds?: Iterable<string>;
        keyIds?: Iterable<string>;
        eraIds?: Iterable<EraId | string>;
    },
): PopularWork[] => {
    const composerIds = setHas(selected.composerIds);
    const instrumentIds = setHas(selected.instrumentIds);
    const formIds = setHas(selected.formIds);
    const keyIds = setHas(selected.keyIds);
    const eraIds = setHas(selected.eraIds);
    return works.filter((work) => {
        if (composerIds.size > 0) {
            const short = work.composer.toLowerCase();
            const cat = work.composerCategory?.toLowerCase() ?? '';
            const match = [...composerIds].some((id) => short.includes(id) || cat.includes(id));
            if (!match) {
                return false;
            }
        }
        if (instrumentIds.size > 0 && (!work.instrument || !instrumentIds.has(work.instrument))) {
            return false;
        }
        if (formIds.size > 0 && (!work.form || !formIds.has(work.form))) {
            return false;
        }
        if (keyIds.size > 0 && (!work.key || !keyIds.has(work.key))) {
            return false;
        }
        if (eraIds.size > 0 && (!work.era || !eraIds.has(work.era))) {
            return false;
        }
        return true;
    });
};
