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

/**
 * Every taxonomy category plus instrument "(arr)" variants, each its own row,
 * in build priority order: the default instrument first (every chip browse
 * intersects with it), then eras and forms (the second chip), then the other
 * instruments and finally composers. pickNextCategory breaks ties by this order.
 */
export const categoriesToSync = (
    composers: FacetCategorySource[],
    instruments: FacetCategorySource[],
    forms: FacetCategorySource[],
    eras: FacetCategorySource[],
    defaultInstrumentCategory?: string,
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
    const addInstrument = (category: string | undefined) => {
        add(category);
        if (category) {
            add(`${category} (arr)`);
        }
    };
    const defaultInstrument = instruments.find((i) => i.category === defaultInstrumentCategory);
    if (defaultInstrument) {
        addInstrument(defaultInstrument.category);
    }
    for (const facet of eras) {
        add(facet.category);
    }
    for (const facet of forms) {
        add(facet.category);
    }
    for (const facet of instruments) {
        addInstrument(facet.category);
    }
    for (const facet of composers) {
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
 * treated as epoch), then failed, then the oldest ok snapshot. Ties keep the
 * order of `categories`, so a cold index builds the default-instrument
 * intersections before the long composer tail.
 */
export const pickNextCategory = (categories: string[], rows: CategorySyncRow[]): string | null => {
    if (categories.length === 0) {
        return null;
    }
    const byCategory = new Map<string, CategorySyncRow>();
    for (const row of rows) {
        byCategory.set(row.category, row);
    }

    const rank = (category: string): [number, number] => {
        const row = byCategory.get(category);
        if (!row || row.state === 'never' || row.state === 'building') {
            return [0, completedMs(row)];
        }
        if (row.state === 'failed') {
            return [1, completedMs(row)];
        }
        return [2, completedMs(row)];
    };

    let best: string | null = null;
    let bestKey: [number, number] | null = null;
    for (const category of categories) {
        const key = rank(category);
        if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
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

export interface MemberPageResult {
    members: CategoryMemberPage[];
    cmcontinue: string | null;
}

/**
 * Read one `list=categorymembers` response. IMSLP runs MediaWiki 1.18, which
 * signals the next page as `query-continue.categorymembers.cmcontinue`; newer
 * wikis use `continue.cmcontinue`. Both are honored — missing either one used
 * to end every category after its first page.
 */
export const parseMemberPage = (data: unknown): MemberPageResult => {
    const o = (data && typeof data === 'object' ? data : {}) as {
        query?: { categorymembers?: unknown };
        continue?: { cmcontinue?: unknown };
        'query-continue'?: { categorymembers?: { cmcontinue?: unknown } };
    };
    const raw = Array.isArray(o.query?.categorymembers) ? o.query.categorymembers : [];
    const members: CategoryMemberPage[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const m = item as Record<string, unknown>;
        if (typeof m['title'] !== 'string' || typeof m['pageid'] !== 'number') {
            continue;
        }
        members.push({
            title: m['title'],
            pageid: m['pageid'],
            sortkeyprefix: typeof m['sortkeyprefix'] === 'string' ? m['sortkeyprefix'] : undefined,
            timestamp: typeof m['timestamp'] === 'string' ? m['timestamp'] : undefined,
        });
    }
    const legacy = o['query-continue']?.categorymembers?.cmcontinue;
    const modern = o.continue?.cmcontinue;
    const token = typeof legacy === 'string' ? legacy : typeof modern === 'string' ? modern : null;
    return { members, cmcontinue: token && token.length > 0 ? token : null };
};

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
    // An empty first page with no continue is a failed fetch (error JSON,
    // truncated body), not a real empty category. A later empty last page
    // after members were stored still completes.
    if (page.length === 0 && plan.pagesDone === 0) {
        return {
            kind: 'failed',
            activeGeneration: previous?.active_generation ?? 0,
            buildingGeneration: plan.generation,
            cmcontinue: plan.cmcontinue,
            pagesDone: plan.pagesDone,
            lastError: 'empty first page',
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
