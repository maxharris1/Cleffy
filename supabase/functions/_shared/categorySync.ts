/**
 * Walk planner for the IMSLP works mirror.
 *
 * NO imports — loaded by Deno (with the `.ts` extension), by vitest (without
 * it) and by the Node seed script (`--experimental-strip-types`). The hosts do
 * I/O and persistence; this module decides which category to page, which
 * generation to write into the building table, when that snapshot promotes
 * onto the live `imslp_works` mirror, and how one MediaWiki generator batch
 * is fetched and merged.
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
    /** When the building generation opened. */
    building_started_at?: string | null;
}

/** Skip a `building` row whose `updated_at` is still inside this window — another tick holds it. */
export const BUILDING_LEASE_MS = 90_000;

const CATEGORY_NAME_RE = /^[\p{L}\p{M}0-9,.'\- ()]+$/u;

/** Category titles go into MW query params, never the host; still reject URL-like junk. */
export const isSafeCategoryName = (name: string): boolean => {
    if (name.length === 0 || name.length > 80) {
        return false;
    }
    if (name.includes('://') || name.includes('|') || name.includes('\n')) {
        return false;
    }
    return CATEGORY_NAME_RE.test(name);
};

export const tickInFlight = (row: CategorySyncRow | undefined, nowMs: number): boolean => {
    if (!row || row.state !== 'building' || !row.updated_at) {
        return false;
    }
    const updated = Date.parse(row.updated_at);
    if (!Number.isFinite(updated)) {
        return false;
    }
    return nowMs - updated >= 0 && nowMs - updated < BUILDING_LEASE_MS;
};

export interface FacetCategorySource {
    category?: string;
}

/**
 * Every taxonomy category plus instrument "(arr)" variants, each its own row,
 * in build priority order: the default instrument first (every chip browse
 * intersects with it), then eras, forms and keys (the second chip), then the
 * other instruments and finally composers. pickNextCategory breaks ties by
 * this order.
 */
export const categoriesToSync = (
    composers: FacetCategorySource[],
    instruments: FacetCategorySource[],
    forms: FacetCategorySource[],
    eras: FacetCategorySource[],
    keys: FacetCategorySource[],
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
    for (const facet of keys) {
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
export const pickNextCategory = (
    categories: string[],
    rows: CategorySyncRow[],
    nowMs: number = Date.now(),
): string | null => {
    if (categories.length === 0) {
        return null;
    }
    const byCategory = new Map<string, CategorySyncRow>();
    for (const row of rows) {
        byCategory.set(row.category, row);
    }

    const rank = (category: string): [number, number] | null => {
        const row = byCategory.get(category);
        if (tickInFlight(row, nowMs)) {
            return null;
        }
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
        if (!key) {
            continue;
        }
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

/** One work page as the generator walk sees it: its taxonomy memberships come along. */
export interface GeneratorMember {
    pageid: number;
    title: string;
    /** `prop=info` touched timestamp — the "New" sort. */
    touched?: string;
    /** Taxonomy categories (no "Category:" prefix) this page belongs to. */
    categories: string[];
}

export interface GeneratorPageResult {
    members: GeneratorMember[];
    /** Next generator page, or null on the last one. */
    gcmcontinue: string | null;
    /** More categories for THIS page set — re-request with the same gcmcontinue. */
    clcontinue: string | null;
    /**
     * MediaWiki `warnings` text, if any. A truncated parameter ("Too many
     * values supplied for parameter 'clcategories'") arrives as a warning on
     * an otherwise successful response, so callers must treat it as failure.
     */
    warnings: string | null;
}

const continueToken = (legacy: unknown, modern: unknown): string | null => {
    const token = typeof legacy === 'string' ? legacy : typeof modern === 'string' ? modern : null;
    return token && token.length > 0 ? token : null;
};

/**
 * Read one `generator=categorymembers` + `prop=categories|info` response.
 * `clcategories` limits the categories to the taxonomy; `cllimit` still caps
 * the total at 500, so a 500-page batch usually needs one `clcontinue`
 * follow-up, whose pages carry only the categories the first response cut.
 */
export const parseGeneratorPage = (data: unknown): GeneratorPageResult => {
    const o = (data && typeof data === 'object' ? data : {}) as {
        query?: { pages?: unknown };
        continue?: { gcmcontinue?: unknown; clcontinue?: unknown };
        'query-continue'?: {
            categorymembers?: { gcmcontinue?: unknown };
            categories?: { clcontinue?: unknown };
        };
        warnings?: Record<string, unknown>;
    };
    const warningTexts: string[] = [];
    for (const [module, value] of Object.entries(o.warnings ?? {})) {
        const text =
            value && typeof value === 'object' && typeof (value as Record<string, unknown>)['*'] === 'string'
                ? ((value as Record<string, unknown>)['*'] as string)
                : typeof value === 'string'
                  ? value
                  : JSON.stringify(value);
        warningTexts.push(`${module}: ${text}`);
    }
    const rawPages = o.query?.pages;
    const members: GeneratorMember[] = [];
    const list = Array.isArray(rawPages)
        ? rawPages
        : rawPages && typeof rawPages === 'object'
          ? Object.values(rawPages as Record<string, unknown>)
          : [];
    for (const item of list) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const p = item as Record<string, unknown>;
        if (typeof p['title'] !== 'string' || typeof p['pageid'] !== 'number' || p['pageid'] <= 0) {
            continue;
        }
        const categories: string[] = [];
        if (Array.isArray(p['categories'])) {
            for (const cat of p['categories']) {
                const title = cat && typeof cat === 'object' ? (cat as Record<string, unknown>)['title'] : null;
                if (typeof title === 'string') {
                    const name = title.replace(/^Category:/i, '').trim();
                    if (name && !categories.includes(name)) {
                        categories.push(name);
                    }
                }
            }
        }
        members.push({
            pageid: p['pageid'],
            title: p['title'],
            touched: typeof p['touched'] === 'string' ? p['touched'] : undefined,
            categories,
        });
    }
    return {
        members,
        gcmcontinue: continueToken(o['query-continue']?.categorymembers?.gcmcontinue, o.continue?.gcmcontinue),
        clcontinue: continueToken(o['query-continue']?.categories?.clcontinue, o.continue?.clcontinue),
        warnings: warningTexts.length > 0 ? warningTexts.join('; ') : null,
    };
};

/** Union categories per page across a batch's clcontinue follow-ups. */
export const mergeGeneratorPages = (into: GeneratorMember[], more: GeneratorMember[]): GeneratorMember[] => {
    const byId = new Map<number, GeneratorMember>();
    for (const m of into) {
        byId.set(m.pageid, { ...m, categories: [...m.categories] });
    }
    for (const m of more) {
        const existing = byId.get(m.pageid);
        if (!existing) {
            byId.set(m.pageid, { ...m, categories: [...m.categories] });
            continue;
        }
        for (const c of m.categories) {
            if (!existing.categories.includes(c)) {
                existing.categories.push(c);
            }
        }
        if (!existing.touched && m.touched) {
            existing.touched = m.touched;
        }
    }
    return [...byId.values()];
};

export interface WorkRow {
    page_id: number;
    page_title: string;
    composer: string | null;
    categories: string[];
    touched: string | null;
    seen_at: string;
}

export interface BuildingWorkRow extends WorkRow {
    generation: number;
    anchor: string;
}

export const unionCategories = (...lists: string[][]): string[] => {
    const out: string[] = [];
    for (const list of lists) {
        for (const category of list) {
            if (category && !out.includes(category)) {
                out.push(category);
            }
        }
    }
    return out;
};

/**
 * One building-table upsert row. The walked category is always a membership,
 * even when the clcategories list omitted it. Same composer rule as
 * imslp.ts parseComposerFromTitle, repeated here because this module must
 * stay import-free for the Node seed script (`scripts/imslp-seed.mjs`).
 */
export const toWorkRow = (category: string, m: GeneratorMember, seenAt: string): WorkRow => {
    const composer = m.title.match(/\(([^)]+)\)\s*$/)?.[1]?.trim() ?? null;
    return {
        page_id: m.pageid,
        page_title: m.title,
        composer,
        categories: m.categories.includes(category) ? [...m.categories] : [category, ...m.categories],
        touched: m.touched ?? null,
        seen_at: seenAt,
    };
};

export const toBuildingRow = (
    category: string,
    generation: number,
    m: GeneratorMember,
    seenAt: string,
): BuildingWorkRow => ({
    ...toWorkRow(category, m, seenAt),
    generation,
    anchor: category,
});

export type MwFetchJson = (params: Record<string, string>) => Promise<unknown>;

/** IMSLP serves anonymous callers up to 500 members per generator page. */
export const GENERATOR_BATCH_SIZE = 500;
/**
 * MediaWiki caps multi-value parameters at 50 for anonymous callers and
 * silently drops the rest (with only a `warnings` entry), so a taxonomy larger
 * than this must be asked for in chunks against the same generator page.
 */
export const MW_MULTIVALUE_LIMIT = 50;
/** Guard against a wiki that keeps handing out clcontinue tokens. */
const MAX_CL_FOLLOWUPS = 20;

const chunk = <T>(items: T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }
    return out;
};

export interface WalkBatchOptions {
    category: string;
    /** Categories to report per page — the whole taxonomy. */
    clcategories: string[];
    gcmcontinue: string | null;
    batchSize?: number;
    /** Sleep this many ms *between* MediaWiki calls (clcategories chunks and clcontinue). */
    delayMs?: number;
}

export interface WalkBatchResult {
    members: GeneratorMember[];
    gcmcontinue: string | null;
    /** MediaWiki requests spent — the tick budgets by this, not by pages. */
    requests: number;
}

/**
 * Fetch one generator batch of `category` with every page's taxonomy
 * memberships: one pass per chunk of 50 `clcategories` against the same
 * generator page, each followed through `clcontinue` until complete. Any
 * MediaWiki warning is an error — a truncated parameter would otherwise read
 * as "not a member". The fetcher is injected: `mwFetch` in Deno, a
 * proxy-aware fetch in Node.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const assertCategoryName = (name: string, label: string): void => {
    if (!isSafeCategoryName(name)) {
        throw new Error(`refusing IMSLP category ${label}`);
    }
};

export const walkCategoryBatch = async (fetchJson: MwFetchJson, opts: WalkBatchOptions): Promise<WalkBatchResult> => {
    assertCategoryName(opts.category, 'title');
    for (const category of opts.clcategories) {
        assertCategoryName(category, 'clcategories');
    }
    const delayMs = opts.delayMs ?? 0;
    const base: Record<string, string> = {
        action: 'query',
        generator: 'categorymembers',
        gcmtitle: `Category:${opts.category}`,
        gcmnamespace: '0',
        gcmtype: 'page',
        gcmlimit: String(opts.batchSize ?? GENERATOR_BATCH_SIZE),
        prop: 'categories|info',
        cllimit: 'max',
    };
    if (opts.gcmcontinue) {
        base['gcmcontinue'] = opts.gcmcontinue;
    }
    const fetchPage = async (params: Record<string, string>): Promise<GeneratorPageResult> => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const page = parseGeneratorPage(await fetchJson(params));
                if (page.warnings) {
                    throw new Error(`IMSLP API warning: ${page.warnings}`);
                }
                return page;
            } catch (err) {
                lastError = err;
                const message = err instanceof Error ? err.message : '';
                if (attempt < 3 && /HTTP 429|timeout/i.test(message)) {
                    await sleep(delayMs > 0 ? delayMs * attempt : 2000 * attempt);
                    continue;
                }
                throw err;
            }
        }
        throw lastError instanceof Error ? lastError : new Error('IMSLP request failed');
    };

    let requests = 0;
    let members: GeneratorMember[] = [];
    // MW 1.18 query-continue: take gcmcontinue from any chunk (not only the
    // first) and echo it on clcontinue follow-ups as a sibling token.
    let nextGcm: string | null = null;
    const pause = async () => {
        if (requests > 0 && delayMs > 0) {
            await sleep(delayMs);
        }
    };
    for (const categories of chunk(opts.clcategories, MW_MULTIVALUE_LIMIT)) {
        const params = { ...base, clcategories: categories.map((c) => `Category:${c}`).join('|') };
        await pause();
        requests += 1;
        let page = await fetchPage(params);
        if (page.gcmcontinue) {
            nextGcm = page.gcmcontinue;
        }
        members = mergeGeneratorPages(members, page.members);
        let followups = 0;
        while (page.clcontinue) {
            followups += 1;
            if (followups > MAX_CL_FOLLOWUPS) {
                throw new Error(`IMSLP clcontinue did not settle after ${MAX_CL_FOLLOWUPS} follow-ups`);
            }
            await pause();
            requests += 1;
            const follow: Record<string, string> = { ...params, clcontinue: page.clcontinue };
            const gcm = page.gcmcontinue ?? nextGcm ?? opts.gcmcontinue;
            if (gcm) {
                follow['gcmcontinue'] = gcm;
            }
            page = await fetchPage(follow);
            if (page.gcmcontinue) {
                nextGcm = page.gcmcontinue;
            }
            members = mergeGeneratorPages(members, page.members);
        }
    }
    return { members, gcmcontinue: nextGcm, requests };
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
 * Completion/rollover: a finished page with no continue token is ready to
 * promote onto the live snapshot; a mid-category failure keeps the previous
 * active generation. An empty first page with no continue is a genuine empty
 * category (fetch errors throw before this) and completes so the chip is ready.
 */
export const applyPageResult = (
    plan: TickPlan,
    previous: CategorySyncRow | undefined,
    page: ReadonlyArray<{ title: string; pageid: number }>,
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
