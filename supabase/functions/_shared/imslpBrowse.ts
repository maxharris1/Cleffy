/**
 * Chip-browse against the category index. Injected RPC so vitest can mock
 * imslp_index_ready / imslp_browse without the Deno edge handler.
 *
 * NO imports — Deno (with the `.ts` extension) and vitest (without it).
 */

export type BrowseRpcClient = {
    rpc: (
        fn: string,
        args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
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

export const browseFromIndex = async (
    admin: BrowseRpcClient | null,
    args: {
        groups: string[][];
        needed: string[];
        sort: string;
        limit: number;
        offset: number;
        titleFilters: string[];
        popularTitles: string[];
    },
): Promise<BrowseFromIndexResult> => {
    if (!admin) {
        return { rows: [], total: 0, indexReady: false, hasMore: false, notReady: args.needed };
    }
    // Key-only (no category groups) is not a completed Walker intersection.
    if (args.needed.length === 0) {
        return { rows: [], total: 0, indexReady: false, hasMore: false, notReady: [] };
    }

    const { data: missingRaw, error: readyError } = await admin.rpc('imslp_index_ready', {
        categories: args.needed,
    });
    if (readyError) {
        throw new Error(readyError.message);
    }
    const notReady = Array.isArray(missingRaw) ? (missingRaw as string[]) : [];
    if (notReady.length > 0) {
        return { rows: [], total: 0, indexReady: false, hasMore: false, notReady };
    }

    const { data: rows, error: browseError } = await admin.rpc('imslp_browse', {
        groups: args.groups,
        sort: args.sort,
        lim: args.limit,
        off: args.offset,
        title_filters: args.titleFilters,
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
