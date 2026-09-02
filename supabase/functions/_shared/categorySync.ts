/**
 * Category-index sync planner for IMSLP membership snapshots.
 *
 * NO imports — loaded by Deno (with the `.ts` extension) and by vitest
 * (without it). The edge function does I/O; this module decides which
 * category to page, which generation to write, and when a snapshot rolls over.
 */

export type SyncState = 'never' | 'building' | 'ok' | 'failed';

export interface CategorySyncRow {
    category: string;
    state: SyncState;
    active_generation: number;
    building_generation: number;
    cmcontinue: string | null;
    pages_done: number;
    last_error: string | null;
    completed_at: string | null;
    updated_at: string | null;
}

export interface FacetCategorySource {
    category?: string;
}

/** Every taxonomy category plus instrument "(arr)" variants, each its own row. */
export const categoriesToSync = (
    composers: FacetCategorySource[],
    instruments: FacetCategorySource[],
    forms: FacetCategorySource[],
    eras: FacetCategorySource[],
): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (category: string | undefined) => {
        const name = category?.trim();
        if (!name || seen.has(name)) {
            return;
        }
        seen.add(name);
        out.push(name);
    };
    for (const facet of composers) {
        add(facet.category);
    }
    for (const facet of instruments) {
        add(facet.category);
        if (facet.category) {
            add(`${facet.category} (arr)`);
        }
    }
    for (const facet of forms) {
        add(facet.category);
    }
    for (const facet of eras) {
        add(facet.category);
    }
    return out;
};

const completedMs = (row: CategorySyncRow | undefined): number => {
    if (!row || !row.completed_at) {
        return 0;
    }
    const ms = Date.parse(row.completed_at);
    return Number.isFinite(ms) ? ms : 0;
};

/**
 * Next category to page: never/building first (oldest completed_at, missing
 * treated as epoch), then failed, then the oldest ok snapshot.
 */
export const pickNextCategory = (categories: string[], rows: CategorySyncRow[]): string | null => {
    if (categories.length === 0) {
        return null;
    }
    const byCategory = new Map<string, CategorySyncRow>();
    for (const row of rows) {
        byCategory.set(row.category, row);
    }

    const rank = (category: string): [number, number, string] => {
        const row = byCategory.get(category);
        if (!row || row.state === 'never' || row.state === 'building') {
            return [0, completedMs(row), category];
        }
        if (row.state === 'failed') {
            return [1, completedMs(row), category];
        }
        return [2, completedMs(row), category];
    };

    let best: string | null = null;
    let bestKey: [number, number, string] | null = null;
    for (const category of categories) {
        const key = rank(category);
        if (
            !bestKey ||
            key[0] < bestKey[0] ||
            (key[0] === bestKey[0] && key[1] < bestKey[1]) ||
            (key[0] === bestKey[0] && key[1] === bestKey[1] && key[2] < bestKey[2])
        ) {
            best = category;
            bestKey = key;
        }
    }
    return best;
};

export interface TickPlan {
    category: string;
    generation: number;
    cmcontinue: string | null;
    pagesDone: number;
}

/** Resume a building/failed cursor, or open the next generation for a new pass. */
export const planTick = (category: string, row: CategorySyncRow | undefined): TickPlan => {
    if (row && (row.state === 'building' || row.state === 'failed') && row.building_generation > 0) {
        return {
            category,
            generation: row.building_generation,
            cmcontinue: row.cmcontinue,
            pagesDone: row.pages_done,
        };
    }
    const nextGen = (row?.active_generation ?? 0) + 1;
    return {
        category,
        generation: nextGen,
        cmcontinue: null,
        pagesDone: 0,
    };
};

export interface CategoryMemberPage {
    title: string;
    pageid: number;
    sortkeyprefix?: string;
    timestamp?: string;
}

export interface RolloverDecision {
    kind: 'continue' | 'complete' | 'failed';
    activeGeneration: number;
    buildingGeneration: number;
    cmcontinue: string | null;
    pagesDone: number;
    lastError: string | null;
    /** Generations to delete after a successful rollover (older than the new active). */
    deleteGenerationsBefore: number | null;
}

/**
 * Completion/rollover: a finished page with no continue token replaces the
 * live snapshot; a mid-category failure keeps the previous active generation.
 */
export const applyPageResult = (
    plan: TickPlan,
    previous: CategorySyncRow | undefined,
    page: CategoryMemberPage[],
    nextContinue: string | null,
    error: string | null,
): RolloverDecision => {
    const pagesDone = plan.pagesDone + page.length;
    if (error) {
        return {
            kind: 'failed',
            activeGeneration: previous?.active_generation ?? 0,
            buildingGeneration: plan.generation,
            cmcontinue: plan.cmcontinue,
            pagesDone: plan.pagesDone,
            lastError: error,
            deleteGenerationsBefore: null,
        };
    }
    if (nextContinue) {
        return {
            kind: 'continue',
            activeGeneration: previous?.active_generation ?? 0,
            buildingGeneration: plan.generation,
            cmcontinue: nextContinue,
            pagesDone,
            lastError: null,
            deleteGenerationsBefore: null,
        };
    }
    return {
        kind: 'complete',
        activeGeneration: plan.generation,
        buildingGeneration: plan.generation,
        cmcontinue: null,
        pagesDone,
        lastError: null,
        deleteGenerationsBefore: plan.generation,
    };
};
