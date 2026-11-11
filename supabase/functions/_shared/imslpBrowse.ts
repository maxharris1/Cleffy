/**
 * Chip-browse against the works mirror. Injected RPC so vitest can mock
 * imslp_index_ready / imslp_browse_works without the Deno edge handler.
 *
 * NO imports — Deno (with the `.ts` extension) and vitest (without it).
 */

export type BrowseRpcClient = {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export type BrowsePageRow = {
    page_title: string;
    page_id: number;
    touched: string | null;
    total: number | string;
};

export type BrowseFromIndexResult = {
    rows: BrowsePageRow[];
    total: number;
    indexReady: boolean;
    hasMore: boolean;
    notReady: string[];
};

/**
 * Every mirrored page carries its full taxonomy membership, so the browse is
 * exact as soon as ANY one selected group has been walked completely: that
 * group bounds the candidate set, and the other groups are attributes on its
 * rows. Returns the group that is complete, or null with the group closest to
 * completion (fewest missing categories, ties in group order) for the copy.
 */
export const readinessFor = (
    groups: string[][],
    missing: string[],
): { ready: true } | { ready: false; notReady: string[] } => {
    const missingSet = new Set(missing);
    let closest: string[] | null = null;
    let closestMissing = Number.POSITIVE_INFINITY;
    for (const group of groups) {
        if (group.length === 0) {
            continue;
        }
        const gaps = group.filter((c) => missingSet.has(c));
        if (gaps.length === 0) {
            return { ready: true };
        }
        if (gaps.length < closestMissing) {
            closest = gaps;
            closestMissing = gaps.length;
        }
    }
    return { ready: false, notReady: closest ?? [] };
};

export const browseFromIndex = async (
    admin: BrowseRpcClient | null,
    args: {
        groups: string[][];
        needed: string[];
        sort: string;
        limit: number;
        offset: number;
        popularTitles: string[];
    },
): Promise<BrowseFromIndexResult> => {
    if (!admin) {
        return { rows: [], total: 0, indexReady: false, hasMore: false, notReady: args.needed };
    }
    if (args.needed.length === 0) {
        return { rows: [], total: 0, indexReady: false, hasMore: false, notReady: [] };
    }

    const { data: missingRaw, error: readyError } = await admin.rpc('imslp_index_ready', {
        categories: args.needed,
    });
    if (readyError) {
        throw new Error(readyError.message);
    }
    const missing = Array.isArray(missingRaw) ? (missingRaw as string[]) : [];
    const readiness = readinessFor(args.groups, missing);
    if (!readiness.ready) {
        return { rows: [], total: 0, indexReady: false, hasMore: false, notReady: readiness.notReady };
    }

    const { data: rows, error: browseError } = await admin.rpc('imslp_browse_works', {
        groups: args.groups,
        sort: args.sort,
        lim: args.limit,
        off: args.offset,
        popular_titles: args.popularTitles,
    });
    if (browseError) {
        throw new Error(browseError.message);
    }

    const page = (Array.isArray(rows) ? rows : []) as BrowsePageRow[];
    const total = page.length > 0 ? Number(page[0]?.total ?? 0) : 0;
    return {
        rows: page,
        total,
        indexReady: true,
        hasMore: args.offset + page.length < total,
        notReady: [],
    };
};
