import { useCallback, useRef, useState } from 'react';

import type { Page } from '@/features/moderation/moderationApi';

export interface PagedList<Row> {
    rows: Row[];
    /** The whole filtered list's size, when the server counts it. */
    total: number | null;
    hasMore: boolean;
    loading: boolean;
    error: string | null;
    /** Back to the first page, e.g. after an action changed the list. */
    reload: () => Promise<void>;
    /** Append the next page. */
    more: () => Promise<void>;
}

/**
 * A keyset-paginated list: the first page on reload(), each next one appended
 * by more(). A reload started while an older request is in flight wins; the
 * older answer is dropped rather than appended to the wrong list.
 */
export const usePagedList = <Row, Cursor>(
    fetchPage: (after: Cursor | null) => Promise<Page<Row, Cursor>>,
    what: string,
): PagedList<Row> => {
    const [rows, setRows] = useState<Row[]>([]);
    const [total, setTotal] = useState<number | null>(null);
    const [next, setNext] = useState<Cursor | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const generation = useRef(0);

    const load = useCallback(
        async (after: Cursor | null) => {
            const mine = after === null ? ++generation.current : generation.current;
            setLoading(true);
            try {
                const page = await fetchPage(after);
                if (mine !== generation.current) {
                    return;
                }
                setRows((prev) => (after === null ? page.rows : [...prev, ...page.rows]));
                setNext(page.next);
                setTotal(page.total);
                setError(null);
            } catch (err) {
                if (mine === generation.current) {
                    setError(err instanceof Error ? err.message : `Could not load the ${what}.`);
                }
            } finally {
                if (mine === generation.current) {
                    setLoading(false);
                }
            }
        },
        [fetchPage, what],
    );

    const reload = useCallback(() => load(null), [load]);
    const more = useCallback(async () => {
        if (next !== null && !loading) {
            await load(next);
        }
    }, [load, next, loading]);

    return { rows, total, hasMore: next !== null, loading, error, reload, more };
};
