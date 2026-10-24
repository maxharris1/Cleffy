import { memo, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router';

import { HomeScreenPromptBanner } from '@/features/install/HomeScreenPromptBanner';
import {
    LIBRARY_PAGE_SIZE,
    deleteDocument,
    fetchLibraryPage,
    leaveSharedDocument,
    listDocuments,
    listFavoriteDocumentIds,
    renameDocument,
    setDocumentFavorite,
    sweepPendingStorageCleanup,
} from '@/features/library/documentsService';
import {
    fetchLibraryBootstrap,
    readCachedLibraryList,
    writeCachedLibraryList,
} from '@/features/library/libraryBootstrap';
import { libraryMutationEpoch } from '@/features/library/libraryCache';
import { coverDownloadsSettled } from '@/features/library/thumbnailRemote';
import {
    appendPage,
    applyLibraryFilters,
    displayTitleOf,
    groupByComposer,
    groupByTag,
    isFiltering,
    sortDocuments,
    type LibraryGroup,
    type LibrarySort,
} from '@/features/library/libraryView';
import { UPLOAD_ACCEPT } from '@/features/import/prepareUpload';
import { FileDropZone } from '@/features/library/FileDropZone';
import { formatUpdated } from '@/features/library/libraryFormat';
import { readLibraryView, writeLibraryView, type LibraryView } from '@/features/library/libraryPrefs';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import { prefetchWhenIdle } from '@/lib/idlePrefetch';
import { perfLogIfDev, perfMark } from '@/lib/perf';
import { isTransportFailure, useOnline } from '@/lib/useOnline';
import { LocalOpenControl } from '@/features/library/LocalOpenControl';
import { RowMenu, SharedScoreMenu } from '@/features/library/RowMenu';
import { ScoreCard } from '@/features/library/ScoreCard';
import { sameDocRow, useEntranceDelay, type ScoreActions } from '@/features/library/scoreRow';
import { ScoreLimitNotice } from '@/features/library/ScoreLimitNotice';
import { ScoreThumb } from '@/features/library/ScoreThumb';
import { TagAssignDialog } from '@/features/library/TagAssignDialog';
import { TagManageDialog } from '@/features/library/TagManageDialog';
import {
    createLibraryTag,
    deleteLibraryTag,
    listDocumentTagMap,
    listLibraryTags,
    renameLibraryTag,
    setDocumentTag,
} from '@/features/library/tagsService';
import { AssignDialog } from '@/features/roster/AssignDialog';
import { ShareDialog } from '@/features/share/ShareDialog';
import type { DocumentRow, LibraryTagRow } from '@/types/database';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { Dialog } from '@/ui/Dialog';
import { EmptyState } from '@/ui/EmptyState';
import { ErrorText } from '@/ui/ErrorText';
import { ProgressBar } from '@/ui/ProgressBar';
import { LibrarySkeleton } from '@/ui/Skeleton';
import { TextField } from '@/ui/TextField';
import { ViewToggle } from '@/ui/ViewToggle';
import { buttonClassName, chipClassName, fieldClassName } from '@/ui/classNames';
import { SettingsIcon, StarIcon, TagIcon, UploadIcon } from '@/ui/icons';

/** Above this count, tag filters switch from chips to a select. */
const TAG_CHIP_LIMIT = 8;
/** Max assigned tag names shown under a score title before “+N”. */
const INLINE_TAG_LIMIT = 3;
/** Quiet time after the last keystroke before the search goes to the server. */
const SEARCH_DEBOUNCE_MS = 300;
/**
 * Rows rendered per task — a few screens' worth — whenever the list has more
 * than are on the page: its first paint, and each "load more" page. A hundred
 * cards in one commit took half a second with the CPU slowed 4x; nothing else
 * could happen meanwhile, not the first covers starting, not a scroll. Plain
 * updates, one slice per task, rather than a transition: rows entering the
 * viewport update state as a reader scrolls, and each of those restarted a
 * transition's render, so an appended page could wait seconds to land.
 */
const ROWS_PER_TASK = 24;
/** How long the first cards get to queue their covers before the viewer prefetch looks. */
const COVERS_FIRST_MS = 400;
/** The viewer prefetch waits for the covers at most this long. */
const VIEWER_PREFETCH_MAX_WAIT_MS = 5000;

/**
 * One server-side answer for the current sort + filters, used while the
 * library is only partly loaded. `key` names the request it answers, so a
 * slow response for an earlier query can never be shown under a later one.
 */
interface RemoteResults {
    key: string;
    documents: DocumentRow[];
    hasMore: boolean;
    /** Where the next page continues — see mainCursorRef. */
    cursor: DocumentRow | null;
}

export const LibraryPage = () => {
    const {
        userId,
        uploading,
        uploadPct,
        onUpload,
        uploadError,
        limitNotice,
        clearUploadError,
        canManageStudents,
        quotaExhausted = false,
        quotaUpgradeHint = true,
        openPricing,
    } = useOutletContext<LibraryOutletContext>();
    const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
    const [favorites, setFavorites] = useState<Set<string>>(new Set());
    const [tags, setTags] = useState<LibraryTagRow[]>([]);
    const [assignments, setAssignments] = useState<Map<string, string[]>>(new Map());
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /**
     * Nothing to show because the list could not be loaded at all — no
     * snapshot on this device either. Never "No scores yet": that would tell
     * a teacher with a full library that it is empty.
     */
    const [loadFailure, setLoadFailure] = useState<LoadFailure | null>(null);
    /** Bumped to load the list again (reconnect, retry timer, or "Try again"). */
    const [reloadKey, setReloadKey] = useState(0);
    /** Automatic retries since the list last loaded, for their backoff. */
    const autoRetriesRef = useRef(0);
    const [actionError, setActionError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    // Read once on mount: a stored preference that throws (private mode) falls
    // back to the shelf rather than taking the page down with it.
    const [view, setView] = useState<LibraryView>(readLibraryView);
    const [sort, setSort] = useState<LibrarySort>('recent');
    const [groupComposer, setGroupComposer] = useState(false);
    const [groupTag, setGroupTag] = useState(false);
    const [favoritesOnly, setFavoritesOnly] = useState(false);
    const [activeTagId, setActiveTagId] = useState<string | null>(null);
    const [renameTarget, setRenameTarget] = useState<DocumentRow | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<DocumentRow | null>(null);
    const [leaveTarget, setLeaveTarget] = useState<DocumentRow | null>(null);
    const [shareTarget, setShareTarget] = useState<DocumentRow | null>(null);
    const [assignTarget, setAssignTarget] = useState<DocumentRow | null>(null);
    const [tagTarget, setTagTarget] = useState<DocumentRow | null>(null);
    const [manageTagsOpen, setManageTagsOpen] = useState(false);
    const [busyAction, setBusyAction] = useState(false);
    /** The search text the server was last asked about (debounced, trimmed). */
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const [remote, setRemote] = useState<RemoteResults | null>(null);
    /** Keyed like RemoteResults: a failure belongs to the search that failed. */
    const [remoteFailure, setRemoteFailure] = useState<{ key: string; message: string } | null>(null);
    /** Bumped by "Try again" to re-ask the server the same question. */
    const [remoteAttempt, setRemoteAttempt] = useState(0);
    const [loadingMore, setLoadingMore] = useState(false);
    const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
    /**
     * Set when a page added nothing new although the server says there is
     * more. Infinite scroll then stands down and the button is the only way
     * on: a sentinel still in view would otherwise fire again the moment the
     * load settles, and keep firing.
     */
    const [autoLoadPaused, setAutoLoadPaused] = useState(false);
    /**
     * The last row the server handed the main list, kept apart from the rows
     * on screen. A keyset continuation must start from what the server
     * returned — not from a row the page has since renamed, deleted or
     * re-sorted, which would skip or repeat scores. It is also the "is this
     * still the list the page continues?" check: anything that repaints the
     * list from the server sets a new cursor object, and a page that lands
     * for the old one is dropped. Set synchronously alongside the state it
     * describes, so the check holds even before React commits.
     */
    const mainCursorRef = useRef<DocumentRow | null>(null);
    /** Rows on screen as last committed — only used to count what a page added. */
    const documentsRef = useRef<DocumentRow[] | null>(null);
    useEffect(() => {
        documentsRef.current = documents;
    }, [documents]);
    const online = useOnline();
    /**
     * Bumped after a mutation's server write resolved, once the state updates
     * that reflect it are queued. The effect below then persists what is on
     * screen — after the render commits, so it sees the post-edit state, not
     * the closure's copy. The commit edge outranks in-flight bootstraps; this
     * is the write that puts the list the page knows is true.
     */
    const [persistTick, setPersistTick] = useState(0);
    const persistSnapshot = useCallback(() => setPersistTick((t) => t + 1), []);

    useEffect(() => {
        if (persistTick === 0 || documents === null) {
            return;
        }
        // Only the first page goes into the snapshot. It is what the next
        // visit's bootstrap returns, so the instant paint and the network
        // paint agree instead of the list shrinking under the teacher.
        void writeCachedLibraryList(userId, {
            documents: documents.slice(0, LIBRARY_PAGE_SIZE),
            hasMore: hasMore || documents.length > LIBRARY_PAGE_SIZE,
            favoriteIds: favorites,
            tags,
            documentTags: assignments,
        }).catch(() => undefined);
        // Tick + user: the list values are read at persist time, not watched.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [persistTick, userId]);

    useEffect(() => {
        let cancelled = false;
        // The network request leaves first: it must not queue behind an
        // IndexedDB open (a schema upgrade can take a good fraction of a
        // second) that it does not depend on. The snapshot read runs alongside.
        let firstResolved = false;
        const first = fetchLibraryBootstrap(userId);
        first.then(
            (boot) => {
                // Only a FRESH answer makes the snapshot moot; a payload a
                // mutation outran will be refetched, and the snapshot bridges
                // that gap exactly as it bridges a slow first request.
                firstResolved = libraryMutationEpoch() === boot.fetchedAtEpoch;
            },
            () => undefined,
        );
        void (async () => {
            // Instant paint from the last bootstrap before the network. Only the
            // user-scoped snapshot qualifies: pdfCache (opened PDFs) is shared by
            // every account on this browser, so it stays out of the happy path
            // and appears only under the labelled offline fallback below. A
            // network answer that beat the snapshot read makes the paint moot.
            const cachedList = await readCachedLibraryList(userId).catch(() => null);
            // A bootstrap that already settled must run its then before we
            // decide whether the snapshot is moot — otherwise a fresh answer
            // that beat the Dexie read still paints one frame of stale titles.
            await Promise.resolve();
            let painted = false;
            if (!cancelled && !firstResolved && cachedList && cachedList.documents.length > 0) {
                mainCursorRef.current = cachedList.documents[cachedList.documents.length - 1] ?? null;
                setAutoLoadPaused(false);
                setDocuments(cachedList.documents);
                setHasMore(cachedList.hasMore);
                setFavorites(cachedList.favoriteIds);
                setTags(cachedList.tags);
                setAssignments(cachedList.documentTags);
                painted = true;
                perfMark('library-cache-paint');
            }
            // A browser that already knows it is offline is told so now, not
            // once the requests below give up: postgrest-js retries each
            // failed GET for seconds (1 s, 2 s, 4 s) before it reports one.
            // A request that gets through after all replaces either state.
            if (!cancelled && !firstResolved && typeof navigator !== 'undefined' && navigator.onLine === false) {
                if (painted) {
                    setError(CACHED_LIST_NOTICE.offline);
                } else {
                    setDocuments((prev) => prev ?? []);
                    setLoadFailure('offline');
                }
            }

            // The painted list is interactive while the network is out, so an
            // edit made in that window outranks a response whose request left
            // before it (the epoch moves on the edit's start AND commit, so a
            // request dispatched mid-write is outranked too). A stale response
            // is not just dropped — that could strand a nothing-painted page
            // on "Loading scores…" forever — it is refetched: the new request
            // sees the post-edit server state. If the refetches are also
            // outrun, the painted state (which already reflects the edits)
            // wins over any of the payloads; only an unpainted page takes the
            // last payload regardless, because anything beats no list at all.
            for (let pass = 0; pass < 3; pass++) {
                const lastPass = pass === 2;
                try {
                    const boot = await (pass === 0 ? first : fetchLibraryBootstrap(userId));
                    if (cancelled) {
                        return;
                    }
                    if (libraryMutationEpoch() !== boot.fetchedAtEpoch) {
                        if (!lastPass) {
                            continue;
                        }
                        if (painted) {
                            return;
                        }
                    }
                    mainCursorRef.current = boot.documents[boot.documents.length - 1] ?? null;
                    setAutoLoadPaused(false);
                    setDocuments(boot.documents);
                    setHasMore(boot.hasMore);
                    setFavorites(boot.favoriteIds);
                    setTags(boot.tags);
                    setAssignments(boot.documentTags);
                    setError(null);
                    setLoadFailure(null);
                    autoRetriesRef.current = 0;
                    perfMark('library-network-paint');
                    perfLogIfDev();
                    void sweepPendingStorageCleanup(userId);
                    return;
                } catch (err: unknown) {
                    // Fallback: four parallel GETs if the bootstrap RPC is unavailable.
                    try {
                        const epochAtRetry = libraryMutationEpoch();
                        const [{ documents: docs, hasMore: more }, ids, tagRows, tagMap] = await Promise.all([
                            listDocuments(),
                            listFavoriteDocumentIds().catch(() => new Set<string>()),
                            listLibraryTags().catch(() => [] as LibraryTagRow[]),
                            listDocumentTagMap().catch(() => new Map<string, string[]>()),
                        ]);
                        if (cancelled) {
                            return;
                        }
                        if (libraryMutationEpoch() !== epochAtRetry) {
                            if (!lastPass) {
                                continue;
                            }
                            if (painted) {
                                return;
                            }
                        }
                        mainCursorRef.current = docs[docs.length - 1] ?? null;
                        setAutoLoadPaused(false);
                        setDocuments(docs);
                        setHasMore(more);
                        setFavorites(ids);
                        setTags(tagRows);
                        setAssignments(tagMap);
                        setError(null);
                        setLoadFailure(null);
                        autoRetriesRef.current = 0;
                        perfMark('library-network-paint');
                        perfLogIfDev();
                        void sweepPendingStorageCleanup(userId);
                        return;
                    } catch (fallbackErr: unknown) {
                        if (cancelled) {
                            return;
                        }
                        // Prefer the user-scoped Dexie snapshot already painted
                        // above. An empty snapshot plus a failed network is an
                        // unavailable library — opened PDFs are not a library.
                        if (cachedList && cachedList.documents.length > 0) {
                            setError(CACHED_LIST_NOTICE[classifyLoadFailure(err, fallbackErr)]);
                            return;
                        }
                        setDocuments((prev) => prev ?? []);
                        // The raw text ("TypeError: Failed to fetch") means
                        // nothing to a teacher; it goes to the console.
                        console.warn('Could not load the library', err, fallbackErr);
                        setLoadFailure(classifyLoadFailure(err, fallbackErr));
                        return;
                    }
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [userId, reloadKey]);

    const retryLoad = () => {
        setLoadFailure(null);
        setDocuments(null);
        setReloadKey((k) => k + 1);
    };
    // Nothing loaded and the network is to blame: load the library again by
    // itself — at once on reconnect, and on a backoff while the browser says
    // it is online but the server could not be reached (DNS, a blocker, an
    // outage), since no 'online' event will come then.
    useEffect(() => {
        if (loadFailure !== 'offline' && loadFailure !== 'unreachable') {
            return;
        }
        const reload = () => {
            setLoadFailure(null);
            setDocuments(null);
            setReloadKey((k) => k + 1);
        };
        window.addEventListener('online', reload);
        if (loadFailure === 'offline' && backOnline()) {
            // Reconnected between the paint and this effect: that 'online'
            // event has been and gone.
            reload();
            return () => window.removeEventListener('online', reload);
        }
        let timer: ReturnType<typeof setTimeout> | null = null;
        if (loadFailure === 'unreachable') {
            const attempt = autoRetriesRef.current;
            autoRetriesRef.current = attempt + 1;
            timer = setTimeout(reload, Math.min(LIBRARY_RETRY_BASE_MS * 2 ** attempt, LIBRARY_RETRY_MAX_MS));
        }
        return () => {
            window.removeEventListener('online', reload);
            if (timer) {
                clearTimeout(timer);
            }
        };
    }, [loadFailure]);
    // The list painted from this device's snapshot because the browser was
    // offline: load it afresh on reconnect. The painted rows stay up, and
    // the notice with them, until an answer replaces them.
    useEffect(() => {
        if (error !== CACHED_LIST_NOTICE.offline) {
            return;
        }
        const refresh = () => setReloadKey((k) => k + 1);
        window.addEventListener('online', refresh);
        if (backOnline()) {
            // As above: the reconnect came before this listened.
            refresh();
        }
        return () => window.removeEventListener('online', refresh);
    }, [error]);

    const isCachedListNotice = error !== null && CACHED_LIST_NOTICES.has(error);
    // Either the browser says so, or the library itself could only be painted
    // from this device's snapshot. A server search would just fail.
    const offline = !online || isCachedListNotice;

    const q = query.trim().toLowerCase();
    const filters = { query: q, favoritesOnly, favorites, tagId: activeTagId, assignments };
    const filtering = isFiltering(filters);

    // The server learns about the query once typing pauses; clearing the box
    // is applied at once (there is nothing to fetch for an empty query).
    useEffect(() => {
        const next = query.trim().toLowerCase();
        const timer = setTimeout(() => setDebouncedQuery(next), next === '' ? 0 : SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [query]);

    /**
     * With every score loaded, search, filters and sort all run in memory, as
     * they always did. With more on the server, an in-memory filter would
     * only see the newest page — a teacher with 300 scores could not find the
     * oldest one — so filters and the A–Z order are asked of the server.
     */
    const serverMode = hasMore && (filtering || sort === 'title');
    // Offline, the loaded rows are all there is: they are searched and sorted
    // in memory, and labelled as such, rather than asking a server that cannot
    // answer. Nothing is asked while the query is still being typed either: a
    // request for the half-typed text would only be thrown away.
    const askServer = serverMode && !offline;
    const remoteKey =
        askServer && debouncedQuery === q ? JSON.stringify([sort, debouncedQuery, activeTagId, favoritesOnly]) : null;
    const remoteRequest = useRef(0);

    useEffect(() => {
        if (remoteKey === null) {
            return;
        }
        const requestId = ++remoteRequest.current;
        fetchLibraryPage({ sort, query: debouncedQuery, tagId: activeTagId, favoritesOnly })
            .then((page) => {
                if (remoteRequest.current === requestId) {
                    setRemote({ key: remoteKey, ...page, cursor: page.documents[page.documents.length - 1] ?? null });
                    // An earlier failure of this same question is answered now.
                    setRemoteFailure((failure) => (failure?.key === remoteKey ? null : failure));
                    setLoadMoreError(null);
                    setAutoLoadPaused(false);
                }
            })
            .catch((err: unknown) => {
                if (remoteRequest.current === requestId) {
                    setRemoteFailure({
                        key: remoteKey,
                        message: err instanceof Error ? err.message : 'Search failed.',
                    });
                }
            });
    }, [remoteKey, remoteAttempt, sort, debouncedQuery, activeTagId, favoritesOnly]);

    const remoteResults = remoteKey !== null && remote?.key === remoteKey ? remote : null;
    // Results on screen outrank an older failure of the same question.
    const remoteError =
        remoteKey !== null && remoteResults === null && remoteFailure?.key === remoteKey ? remoteFailure.message : null;
    // Waiting on the server: the loaded rows that match stay on screen in
    // the meantime, labelled as a search in progress rather than an answer.
    const searching = askServer && remoteResults === null && remoteError === null;

    const visible =
        documents === null ? null : applyLibraryFilters(remoteResults ? remoteResults.documents : documents, filters);
    // Server results arrive in the requested order; re-sorting them in the
    // browser (localeCompare vs. the database's collation) could disagree
    // with where the next page continues.
    const sorted = visible ? (remoteResults ? visible : sortDocuments(visible, sort)) : null;
    const groups: LibraryGroup[] | null = sorted
        ? groupTag
            ? groupByTag(sorted, tags, assignments)
            : groupComposer
              ? groupByComposer(sorted)
              : [{ label: null, documents: sorted }]
        : null;

    // How many rows may be on the page; grows by ROWS_PER_TASK per task while
    // the list has more (see ROWS_PER_TASK). Never shrinks, so a list that
    // was whole once (a search cleared) comes back whole at once.
    const [rowBudget, setRowBudget] = useState(ROWS_PER_TASK);
    // Within the row budget; a group past it waits for a later slice.
    let budgetLeft = rowBudget;
    const shownGroups =
        groups?.flatMap((group) => {
            if (budgetLeft <= 0) {
                return [];
            }
            const shown = group.documents.length <= budgetLeft ? group.documents : group.documents.slice(0, budgetLeft);
            budgetLeft -= shown.length;
            return [{ ...group, documents: shown }];
        }) ?? null;
    const allRowsShown = (groups ?? []).reduce((n, group) => n + group.documents.length, 0) <= rowBudget;
    useEffect(() => {
        if (allRowsShown) {
            return;
        }
        // One slice per task: between them the browser paints, scrolls,
        // delivers the cards' visibility and starts their covers.
        const next = setTimeout(() => setRowBudget((budget) => budget + ROWS_PER_TASK), 0);
        return () => clearTimeout(next);
    }, [rowBudget, allRowsShown]);

    const canLoadMore = remoteResults ? remoteResults.hasMore : !serverMode && hasMore;

    /**
     * Fetch the next keyset page after the last row on screen. A page is
     * appended only if the list it continues is still the one showing — a
     * bootstrap that repainted, or a new search, makes the cursor meaningless,
     * and appending anyway could leave a gap or a duplicate run.
     */
    // Mirrors loadingMore synchronously: two observer callbacks (or a tap
    // and a callback) in the same tick both see the state before React
    // re-renders, and would both ask for the same page.
    const loadingMoreRef = useRef(false);
    const loadMore = async () => {
        if (loadingMoreRef.current || !canLoadMore) {
            return;
        }
        loadingMoreRef.current = true;
        setLoadingMore(true);
        setLoadMoreError(null);
        /** New rows a page brings, measured against the rows already held. */
        const freshCount = (held: DocumentRow[] | null, page: DocumentRow[]): number => {
            const seen = new Set((held ?? []).map((doc) => doc.id));
            return page.filter((doc) => !seen.has(doc.id)).length;
        };
        try {
            if (remoteResults) {
                const base = remoteResults;
                const cursor = base.cursor;
                if (!cursor) {
                    return;
                }
                const page = await fetchLibraryPage({
                    sort,
                    query: debouncedQuery,
                    tagId: activeTagId,
                    favoritesOnly,
                    after: cursor,
                });
                // A server that says "more" but sends nothing would have the
                // next request ask the same question; treat it as the end.
                const more = page.hasMore && page.documents.length > 0;
                setRemote((prev) =>
                    prev && prev.key === base.key && prev.cursor === cursor
                        ? {
                              ...prev,
                              documents: appendPage(prev.documents, page.documents),
                              hasMore: more,
                              cursor: page.documents[page.documents.length - 1] ?? cursor,
                          }
                        : prev,
                );
                setAutoLoadPaused(more && freshCount(base.documents, page.documents) === 0);
                return;
            }
            const cursor = mainCursorRef.current;
            if (!cursor) {
                return;
            }
            const page = await fetchLibraryPage({ sort: 'recent', after: cursor });
            if (mainCursorRef.current !== cursor) {
                // The list was repainted from the server while this page was
                // in flight; it no longer continues from here.
                return;
            }
            const more = page.hasMore && page.documents.length > 0;
            mainCursorRef.current = page.documents[page.documents.length - 1] ?? cursor;
            // An updater, not a value: a delete or rename queued while the
            // page was in flight must survive the append.
            setDocuments((prev) => (prev ? appendPage(prev, page.documents) : prev));
            setHasMore(more);
            setAutoLoadPaused(more && freshCount(documentsRef.current, page.documents) === 0);
        } catch (err) {
            setLoadMoreError(err instanceof Error ? err.message : 'Could not load more scores.');
        } finally {
            loadingMoreRef.current = false;
            setLoadingMore(false);
        }
    };
    const onSentinelVisible = useEffectEvent(() => {
        void loadMore();
    });

    // Infinite scroll: the sentinel below the list asks for the next page as
    // it nears the viewport. Re-armed after every page, so a tall screen keeps
    // filling; paused after a failure, where the button is the retry.
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const node = sentinelRef.current;
        // The sentinel mounts with the last slice of rows (allRowsShown), so
        // that is also when there is first something to observe.
        if (
            !node ||
            !allRowsShown ||
            !canLoadMore ||
            loadingMore ||
            loadMoreError ||
            autoLoadPaused ||
            typeof IntersectionObserver === 'undefined'
        ) {
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    onSentinelVisible();
                }
            },
            // About three screens ahead: the next page is asked for while
            // the reader is still a good way from the end, so a steady scroll
            // reaches older scores already on the shelf instead of waiting at
            // the bottom for them. Appending is cheap now that rows are memoized.
            { rootMargin: '2400px 0px' },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [canLoadMore, loadingMore, loadMoreError, autoLoadPaused, allRowsShown]);

    const hasScores = documents !== null && documents.length > 0;
    // A shelf with scores on it is a score about to be opened: bring in the
    // viewer (and pdf.js) while the teacher looks, not after the tap. Covers
    // first, though: on a first visit those few hundred KB would share the
    // connection with the shelf's first covers and slow them down. Once their
    // downloads go quiet (at once when they come from this device), or after
    // a few seconds at most.
    useEffect(() => {
        if (!hasScores) {
            return;
        }
        let cancelled = false;
        const prefetch = () => {
            if (!cancelled) {
                prefetchWhenIdle('viewer', () => import('@/features/viewer/ViewerPage'));
            }
        };
        // Lets the first cards ask for their covers before the queue is read.
        const settle = setTimeout(() => void coverDownloadsSettled().then(prefetch), COVERS_FIRST_MS);
        const latest = setTimeout(prefetch, VIEWER_PREFETCH_MAX_WAIT_MS);
        return () => {
            cancelled = true;
            clearTimeout(settle);
            clearTimeout(latest);
        };
    }, [hasScores]);
    const statusError = uploadError ?? actionError ?? error;
    const useTagSelect = tags.length > TAG_CHIP_LIMIT;
    /**
     * The upload tile is the last cell of the shelf, so it only makes sense
     * when the shelf is the whole library: under a filter it would look like a
     * result, and under a grouping it would have to pick a group to live in.
     */
    const showAddTile = view === 'grid' && !filtering && !groupComposer && !groupTag;

    const countLabel = (() => {
        if (documents === null || visible === null) {
            return '';
        }
        const n = documents.length;
        if (searching) {
            return 'Searching all scores…';
        }
        if (remoteResults) {
            const more = remoteResults.hasMore ? '+' : '';
            return filtering
                ? `${visible.length}${more} found`
                : `${visible.length}${more} ${visible.length === 1 && !more ? 'score' : 'scores'}, A–Z`;
        }
        // Below here with hasMore, the server was not (or could not be)
        // asked: everything counted is what this page has loaded.
        if (filtering) {
            return hasMore ? `${visible.length} of ${n} loaded` : `${visible.length} of ${n}`;
        }
        if (hasMore) {
            return sort === 'title' ? `${n} loaded, A–Z` : `Showing ${n} most recent`;
        }
        return `${n} ${n === 1 ? 'score' : 'scores'}`;
    })();

    const changeView = (next: LibraryView) => {
        setView(next);
        writeLibraryView(next);
    };

    // Stable for the life of the page (setters and userId only), so the row
    // actions built from it never change and memoized rows stay put.
    const toggleFavorite = useCallback(
        (doc: DocumentRow, next: boolean) => {
            setActionError(null);
            setFavorites((prev) => {
                if (prev.has(doc.id) === next) {
                    return prev;
                }
                const set = new Set(prev);
                if (next) {
                    set.add(doc.id);
                } else {
                    set.delete(doc.id);
                }
                return set;
            });
            setDocumentFavorite(doc.id, userId, next)
                .then(persistSnapshot)
                .catch((err: unknown) => {
                    setFavorites((prev) => {
                        const set = new Set(prev);
                        if (next) {
                            set.delete(doc.id);
                        } else {
                            set.add(doc.id);
                        }
                        return set;
                    });
                    setActionError(err instanceof Error ? err.message : 'Could not update favorites.');
                });
        },
        [userId, persistSnapshot],
    );

    /** Everything a row can ask for, as one object every row shares (see ScoreActions). */
    const actions = useMemo<ScoreActions>(
        () => ({
            toggleFavorite,
            rename: setRenameTarget,
            share: setShareTarget,
            assign: canManageStudents ? setAssignTarget : undefined,
            remove: setDeleteTarget,
            leave: setLeaveTarget,
            editTags: setTagTarget,
            filterTag: (tagId) => setActiveTagId((id) => (id === tagId ? null : tagId)),
        }),
        [toggleFavorite, canManageStudents],
    );

    const patchAssignment = (documentId: string, tagId: string, assigned: boolean) => {
        setAssignments((prev) => {
            const next = new Map(prev);
            const current = next.get(documentId) ?? [];
            if (assigned) {
                if (!current.includes(tagId)) {
                    next.set(documentId, [...current, tagId]);
                }
            } else {
                const filtered = current.filter((id) => id !== tagId);
                if (filtered.length === 0) {
                    next.delete(documentId);
                } else {
                    next.set(documentId, filtered);
                }
            }
            return next;
        });
    };

    const handleToggleTag = async (tagId: string, assigned: boolean) => {
        if (!tagTarget) {
            return;
        }
        const docId = tagTarget.id;
        patchAssignment(docId, tagId, assigned);
        try {
            await setDocumentTag(docId, tagId, assigned);
            persistSnapshot();
        } catch (err) {
            patchAssignment(docId, tagId, !assigned);
            throw err;
        }
    };

    /** Create from assign dialog — also assigns to the open score. */
    const handleCreateAndAssignTag = async (name: string) => {
        if (!tagTarget) {
            return;
        }
        const created = await createLibraryTag(userId, name);
        setTags((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
        patchAssignment(tagTarget.id, created.id, true);
        try {
            await setDocumentTag(tagTarget.id, created.id, true);
        } catch (err) {
            patchAssignment(tagTarget.id, created.id, false);
            throw err;
        } finally {
            // The tag exists either way; the assignment state is whichever
            // branch above left it in.
            persistSnapshot();
        }
    };

    /** Create from manage dialog — no score context, no auto-assign. */
    const handleCreateTagOnly = async (name: string) => {
        const created = await createLibraryTag(userId, name);
        setTags((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
        persistSnapshot();
    };

    const handleRenameTag = async (tagId: string, name: string) => {
        await renameLibraryTag(tagId, name);
        setTags((prev) =>
            prev
                .map((t) => (t.id === tagId ? { ...t, name: name.trim().replace(/\s+/g, ' ') } : t))
                .sort((a, b) => a.name.localeCompare(b.name)),
        );
        persistSnapshot();
    };

    const handleDeleteTag = async (tagId: string) => {
        await deleteLibraryTag(tagId);
        setTags((prev) => prev.filter((t) => t.id !== tagId));
        setAssignments((prev) => {
            const next = new Map(prev);
            for (const [docId, tagIds] of next) {
                const filtered = tagIds.filter((id) => id !== tagId);
                if (filtered.length === 0) {
                    next.delete(docId);
                } else {
                    next.set(docId, filtered);
                }
            }
            return next;
        });
        if (activeTagId === tagId) {
            setActiveTagId(null);
        }
        persistSnapshot();
    };

    const saveRename = async (title: string) => {
        if (!renameTarget) {
            return;
        }
        const target = renameTarget;
        setBusyAction(true);
        try {
            await renameDocument(target.id, title);
            setDocuments((docs) => docs?.map((d) => (d.id === target.id ? { ...d, title } : d)) ?? docs);
            setRemote((prev) =>
                prev
                    ? { ...prev, documents: prev.documents.map((d) => (d.id === target.id ? { ...d, title } : d)) }
                    : prev,
            );
            setRenameTarget(null);
            persistSnapshot();
        } finally {
            setBusyAction(false);
        }
    };

    const confirmDelete = async () => {
        if (!deleteTarget) {
            return;
        }
        const target = deleteTarget;
        setBusyAction(true);
        setActionError(null);
        try {
            await deleteDocument(target);
            setDocuments((docs) => docs?.filter((d) => d.id !== target.id) ?? docs);
            setRemote((prev) =>
                prev ? { ...prev, documents: prev.documents.filter((d) => d.id !== target.id) } : prev,
            );
            setAssignments((prev) => {
                const next = new Map(prev);
                next.delete(target.id);
                return next;
            });
            // A slot just came free, so the "you are at your score limit" notice
            // from the upload that failed a moment ago is no longer true.
            clearUploadError();
            persistSnapshot();
        } catch (err) {
            setActionError(err instanceof Error ? err.message : 'Could not delete the score.');
        } finally {
            setBusyAction(false);
            setDeleteTarget(null);
        }
    };

    /** Drop a score from every piece of list state, after it left the library. */
    const forgetLocally = (docId: string) => {
        setDocuments((docs) => docs?.filter((d) => d.id !== docId) ?? docs);
        // Server search / A-Z / filter results too, or the score lingers there.
        setRemote((prev) => (prev ? { ...prev, documents: prev.documents.filter((d) => d.id !== docId) } : prev));
        setFavorites((prev) => {
            if (!prev.has(docId)) {
                return prev;
            }
            const next = new Set(prev);
            next.delete(docId);
            return next;
        });
        setAssignments((prev) => {
            if (!prev.has(docId)) {
                return prev;
            }
            const next = new Map(prev);
            next.delete(docId);
            return next;
        });
    };

    const confirmLeave = async () => {
        if (!leaveTarget) {
            return;
        }
        const target = leaveTarget;
        setBusyAction(true);
        setActionError(null);
        try {
            await leaveSharedDocument(target.id);
            forgetLocally(target.id);
            persistSnapshot();
        } catch (err) {
            setActionError(err instanceof Error ? err.message : 'Could not remove the score from your library.');
        } finally {
            setBusyAction(false);
            setLeaveTarget(null);
        }
    };

    // One array per score, rebuilt only when tags or assignments change: a
    // fresh array per render would defeat the memoized rows below.
    const tagsByDoc = useMemo(() => {
        const tagsById = new Map(tags.map((t) => [t.id, t]));
        const byDoc = new Map<string, LibraryTagRow[]>();
        for (const [docId, ids] of assignments) {
            byDoc.set(
                docId,
                ids.map((id) => tagsById.get(id)).filter((t): t is LibraryTagRow => t !== undefined),
            );
        }
        return byDoc;
    }, [tags, assignments]);
    const docTags = (docId: string): LibraryTagRow[] => tagsByDoc.get(docId) ?? NO_TAGS;

    let rowIndex = 0;

    return (
        <FileDropZone
            disabled={uploading || quotaExhausted}
            onFile={(file) => void onUpload(file).catch(() => undefined)}
        >
            <div>
                <HomeScreenPromptBanner />
                {/*
                  No upload button in the header: the shell's top bar carries a
                  persistent one and the shelf ends in an "Add a score" tile. The
                  local-only path has no other home, so it rides alongside the
                  subtitle rather than standing alone where the button used to be.
                */}
                <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h1 className="font-display text-2xl font-semibold tracking-tight text-stone-800">Library</h1>
                    <p className="text-sm text-stone-500">Upload, organize, and share the scores you teach from.</p>
                    {hasScores ? <LocalOpenControl label="Open locally without uploading" subtle /> : null}
                </header>

                {hasScores ? (
                    uploading && uploadPct !== null ? (
                        <ProgressBar value={uploadPct} label="Uploading score" className="mt-4 max-w-xs" />
                    ) : null
                ) : loadFailure ? (
                    <LibraryUnavailable reason={loadFailure} onRetry={retryLoad} />
                ) : documents !== null ? (
                    <EmptyLibrary
                        uploading={uploading}
                        quotaExhausted={quotaExhausted}
                        uploadPct={uploadPct}
                        onUpload={onUpload}
                    />
                ) : null}

                {/*
              Both, never one instead of the other. The limit notice outlives the
              upload that raised it — and at the cap it is there before any
              upload, explaining the greyed-out button — so rendering it in place
              of statusError would swallow every later failure: a delete that
              errored, a listDocuments that failed, the offline notice. Two
              different things, and the teacher needs both.
            */}
                <ScoreLimitNotice
                    limit={limitNotice}
                    upgradeHint={quotaUpgradeHint}
                    onUpgrade={openPricing}
                    className="mt-5"
                />
                {statusError ? (
                    isCachedListNotice && !uploadError && !actionError ? (
                        <p className="mt-5 text-sm text-amber-800" role="status">
                            {statusError}
                        </p>
                    ) : (
                        <ErrorText className="mt-5">{statusError}</ErrorText>
                    )
                ) : null}

                {documents === null ? (
                    <LibrarySkeleton view={view} label="Loading scores…" />
                ) : hasScores ? (
                    <section className="mt-8">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <label className="sr-only" htmlFor="library-search">
                                Search scores
                            </label>
                            <input
                                id="library-search"
                                type="search"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Search by title…"
                                className={fieldClassName('sm', 'sm:max-w-xs')}
                            />
                            <div className="flex items-center gap-3">
                                <p className="text-xs tabular-nums text-stone-600" aria-live="polite">
                                    {countLabel}
                                </p>
                                <ViewToggle view={view} onChange={changeView} />
                            </div>
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-2">
                            <SortToggle sort={sort} onChange={setSort} />
                            <FilterChip
                                active={groupComposer}
                                onClick={() => {
                                    setGroupComposer((v) => !v);
                                    setGroupTag(false);
                                }}
                            >
                                Group by composer
                            </FilterChip>
                            {tags.length > 0 ? (
                                <FilterChip
                                    active={groupTag}
                                    onClick={() => {
                                        setGroupTag((v) => !v);
                                        setGroupComposer(false);
                                    }}
                                >
                                    Group by tag
                                </FilterChip>
                            ) : null}
                        </div>

                        <div className="no-scrollbar -mx-4 mt-2 flex items-center gap-2 overflow-x-auto overscroll-x-contain px-4 py-0.5 sm:mx-0 sm:flex-wrap sm:overflow-x-visible sm:px-0">
                            <FilterChip active={favoritesOnly} onClick={() => setFavoritesOnly((v) => !v)}>
                                Favorites
                            </FilterChip>
                            <span className="shrink-0 text-xs text-stone-500">Tags</span>
                            {tags.length === 0 ? (
                                <button
                                    type="button"
                                    onClick={() => setManageTagsOpen(true)}
                                    className={chipClassName(false)}
                                >
                                    Add a tag…
                                </button>
                            ) : (
                                <>
                                    {useTagSelect ? (
                                        <select
                                            aria-label="Filter by tag"
                                            value={activeTagId ?? ''}
                                            onChange={(e) => setActiveTagId(e.target.value || null)}
                                            className={fieldClassName('xs', 'h-8 w-auto max-w-[10rem]')}
                                        >
                                            <option value="">All tags</option>
                                            {tags.map((tag) => (
                                                <option key={tag.id} value={tag.id}>
                                                    {tag.name}
                                                </option>
                                            ))}
                                        </select>
                                    ) : (
                                        tags.map((tag) => (
                                            <FilterChip
                                                key={tag.id}
                                                active={activeTagId === tag.id}
                                                onClick={() => setActiveTagId((id) => (id === tag.id ? null : tag.id))}
                                            >
                                                {tag.name}
                                            </FilterChip>
                                        ))
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => setManageTagsOpen(true)}
                                        className={chipClassName(false)}
                                    >
                                        <SettingsIcon size={14} />
                                        Manage
                                    </button>
                                </>
                            )}
                        </div>

                        {serverMode && offline && !isCachedListNotice ? (
                            <p className="mt-4 text-sm text-amber-800" role="status">
                                {filtering
                                    ? `You’re offline, so only the ${documents.length} scores loaded here were searched.`
                                    : `You’re offline, so only the ${documents.length} scores loaded here are sorted A–Z.`}
                            </p>
                        ) : null}
                        {remoteError ? (
                            <ErrorText className="mt-4">
                                {filtering
                                    ? `Couldn’t search all of your scores, so only matches among the ${documents.length} loaded here are shown.`
                                    : `Couldn’t sort all of your scores A–Z, so only the ${documents.length} loaded here are shown.`}{' '}
                                {remoteError}{' '}
                                <button
                                    type="button"
                                    className="font-medium underline"
                                    onClick={() => {
                                        setRemoteFailure(null);
                                        setRemoteAttempt((n) => n + 1);
                                    }}
                                >
                                    Try again
                                </button>
                            </ErrorText>
                        ) : null}

                        {visible && visible.length === 0 ? (
                            <p
                                className="mt-8 text-sm text-stone-500 [overflow-wrap:anywhere]"
                                role={searching ? 'status' : undefined}
                            >
                                {searching
                                    ? 'Searching all of your scores…'
                                    : activeTagId && !query.trim() && !favoritesOnly
                                      ? 'No scores with this tag yet.'
                                      : favoritesOnly && !query.trim()
                                        ? 'No favorites yet — tap the star on a score to keep it handy.'
                                        : `No scores match “${query.trim()}”.`}
                            </p>
                        ) : (
                            shownGroups?.map((group) => (
                                <section key={group.label ?? 'all'}>
                                    {group.label ? (
                                        <h3 className="mt-7 border-b border-stone-300/50 pb-1.5 text-xs font-medium uppercase tracking-[0.08em] text-stone-500 [overflow-wrap:anywhere]">
                                            {group.label}
                                        </h3>
                                    ) : null}
                                    {view === 'grid' ? (
                                        <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-7 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                                            {group.documents.map((doc) => (
                                                <ScoreCard
                                                    key={`${group.label ?? 'all'}-${doc.id}`}
                                                    doc={doc}
                                                    index={rowIndex++}
                                                    stripComposer={groupComposer && group.label !== null}
                                                    isFavorite={favorites.has(doc.id)}
                                                    isOwner={doc.owner_id === userId}
                                                    actions={actions}
                                                />
                                            ))}
                                            {showAddTile && allRowsShown ? (
                                                <AddScoreTile
                                                    uploading={uploading}
                                                    quotaExhausted={quotaExhausted}
                                                    onUpload={onUpload}
                                                />
                                            ) : null}
                                        </div>
                                    ) : (
                                        <ul className={group.label ? '' : 'mt-4'}>
                                            {group.documents.map((doc) => (
                                                <ScoreRow
                                                    key={`${group.label ?? 'all'}-${doc.id}`}
                                                    doc={doc}
                                                    index={rowIndex++}
                                                    stripComposer={groupComposer && group.label !== null}
                                                    assignedTags={docTags(doc.id)}
                                                    isFavorite={favorites.has(doc.id)}
                                                    isOwner={doc.owner_id === userId}
                                                    actions={actions}
                                                />
                                            ))}
                                        </ul>
                                    )}
                                </section>
                            ))
                        )}

                        {/* Not before every row is rendered: a sentinel under a
                            partial list would ask for the next page at once. */}
                        {canLoadMore && allRowsShown ? (
                            <div className="mt-8 flex flex-col items-center gap-2">
                                <div ref={sentinelRef} aria-hidden="true" />
                                {loadMoreError ? (
                                    <ErrorText>Couldn’t load more scores. {loadMoreError}</ErrorText>
                                ) : null}
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={loadingMore}
                                    onClick={() => void loadMore()}
                                >
                                    {loadingMore ? 'Loading more…' : loadMoreError ? 'Try again' : 'Load more scores'}
                                </Button>
                            </div>
                        ) : null}
                    </section>
                ) : null}

                {renameTarget ? (
                    <RenameDialog
                        doc={renameTarget}
                        busy={busyAction}
                        onClose={() => setRenameTarget(null)}
                        onSave={saveRename}
                    />
                ) : null}
                {deleteTarget ? (
                    <ConfirmDialog
                        title="Delete this score?"
                        body={`“${deleteTarget.title}” and all of its annotations will be removed for everyone it's shared with. This can't be undone.`}
                        confirmLabel="Delete"
                        danger
                        busy={busyAction}
                        onConfirm={() => void confirmDelete()}
                        onCancel={() => setDeleteTarget(null)}
                    />
                ) : null}
                {leaveTarget ? (
                    <ConfirmDialog
                        title="Remove from your library?"
                        body={`“${leaveTarget.title}” was shared with you. Removing it ends your access on every device — you'd need a new link from its owner to get it back. Marks you made stay on the score for everyone else.`}
                        confirmLabel="Remove"
                        danger
                        busy={busyAction}
                        onConfirm={() => void confirmLeave()}
                        onCancel={() => setLeaveTarget(null)}
                    />
                ) : null}
                {shareTarget ? (
                    <ShareDialog
                        docId={shareTarget.id}
                        userId={userId}
                        role="owner"
                        onClose={() => setShareTarget(null)}
                    />
                ) : null}
                {assignTarget ? (
                    <AssignDialog
                        documentId={assignTarget.id}
                        documentTitle={assignTarget.title}
                        onClose={() => setAssignTarget(null)}
                    />
                ) : null}
                {tagTarget ? (
                    <TagAssignDialog
                        scoreTitle={tagTarget.title}
                        tags={tags}
                        assignedTagIds={new Set(assignments.get(tagTarget.id) ?? [])}
                        busy={busyAction}
                        onClose={() => setTagTarget(null)}
                        onToggleTag={handleToggleTag}
                        onCreateTag={handleCreateAndAssignTag}
                    />
                ) : null}
                {manageTagsOpen ? (
                    <TagManageDialog
                        tags={tags}
                        busy={busyAction}
                        onClose={() => setManageTagsOpen(false)}
                        onCreateTag={handleCreateTagOnly}
                        onRenameTag={handleRenameTag}
                        onDeleteTag={handleDeleteTag}
                    />
                ) : null}
            </div>
        </FileDropZone>
    );
};

const FilterChip = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) => (
    <button type="button" aria-pressed={active} onClick={onClick} className={chipClassName(active)}>
        {children}
    </button>
);

const SortToggle = ({ sort, onChange }: { sort: LibrarySort; onChange: (s: LibrarySort) => void }) => (
    <div
        role="group"
        aria-label="Sort"
        className="flex h-8 shrink-0 items-center rounded-lg border border-stone-200 p-0.5 text-xs"
    >
        {(
            [
                ['recent', 'Recent'],
                ['title', 'A–Z'],
            ] as const
        ).map(([value, label]) => (
            <button
                key={value}
                type="button"
                aria-pressed={sort === value}
                onClick={() => onChange(value)}
                // On touch the hit area reaches past the 26px pill, up and down
                // into the gaps around the toolbar row.
                className={`relative h-full rounded-md px-2.5 font-medium transition-colors pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-2.5 ${
                    sort === value ? 'bg-accent-soft text-accent' : 'text-stone-600 hover:text-stone-800'
                }`}
            >
                {label}
            </button>
        ))}
    </div>
);

/**
 * Last cell of the shelf. A <label> around a file input rather than a button,
 * for the same reason UploadButton is one — a file picker cannot be opened
 * programmatically without a user gesture on the input itself.
 *
 * The input is `sr-only` rather than `hidden` so it stays focusable: a tile
 * only reachable with a mouse would be the one upload path a keyboard user
 * cannot take.
 */
const AddScoreTile = ({
    uploading,
    quotaExhausted,
    onUpload,
}: {
    uploading: boolean;
    quotaExhausted: boolean;
    onUpload: (file: File) => Promise<void>;
}) => (
    <label
        className={`flex aspect-[1/1.414] cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-stone-300 text-stone-500 transition-colors hover:border-accent hover:text-accent focus-within:border-accent focus-within:text-accent ${
            uploading || quotaExhausted ? 'pointer-events-none opacity-60' : ''
        }`}
    >
        <span aria-hidden="true" className="text-3xl font-light leading-none">
            +
        </span>
        <span className="px-2 text-center text-xs font-medium">Add a score</span>
        <input
            type="file"
            accept={UPLOAD_ACCEPT}
            className="sr-only"
            disabled={uploading || quotaExhausted}
            onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                    void onUpload(file).catch(() => undefined);
                }
                e.target.value = '';
            }}
        />
    </label>
);

/** Shared by every untagged row, so their props compare equal between renders. */
const NO_TAGS: LibraryTagRow[] = [];

interface ScoreRowProps {
    doc: DocumentRow;
    /** Position in the list when the row mounted — only the entrance stagger reads it. */
    index: number;
    stripComposer: boolean;
    assignedTags: LibraryTagRow[];
    isFavorite: boolean;
    isOwner: boolean;
    actions: ScoreActions;
}

/** The list view's row. Memoized like ScoreCard, for the same reason. */
const ScoreRow = memo(
    ({ doc, index, stripComposer, assignedTags, isFavorite, isOwner, actions }: ScoreRowProps) => {
        const hasTags = assignedTags.length > 0;
        const visibleTags = assignedTags.slice(0, INLINE_TAG_LIMIT);
        const overflow = assignedTags.length - visibleTags.length;
        const entranceDelay = useEntranceDelay(index);
        const onTags = () => actions.editTags(doc);

        return (
            <li
                className={`library-list-item${entranceDelay === null ? ' library-card-settled' : ''}`}
                style={entranceDelay === null ? undefined : { animationDelay: `${entranceDelay}ms` }}
            >
                <div className="group relative flex items-center gap-0.5 border-b border-stone-300/50 transition-colors hover:border-accent/40 hover:bg-ink/[0.03]">
                    {/*
                      Sibling of the text block, not a child of it: that block turns
                      into a column on phones, which would stack the thumbnail above
                      the title instead of beside it.
                    */}
                    <ScoreThumb docId={doc.id} contentRev={doc.content_rev ?? 0} thumbRev={doc.thumb_rev ?? null} />
                    <div className="ml-3 flex min-w-0 flex-1 flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:gap-4 sm:py-3">
                        <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                                <Link
                                    to={`/doc/${doc.id}`}
                                    className="min-w-0 font-medium text-stone-800 transition-colors line-clamp-2 group-hover:text-accent-hover sm:line-clamp-none sm:block sm:truncate after:absolute after:inset-0 after:content-['']"
                                >
                                    {stripComposer ? displayTitleOf(doc.title) : doc.title}
                                </Link>
                                {/* Past the free cap: still readable and exportable, just not writable. */}
                                {doc.archived_at ? (
                                    <span className="relative shrink-0">
                                        <Badge tone="warn">Archived</Badge>
                                    </span>
                                ) : null}
                            </div>
                            {hasTags ? (
                                <div className="relative mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 pointer-coarse:mt-2 pointer-coarse:gap-y-4 pointer-coarse:pb-1">
                                    {/* The separator trails its chip rather than leading the
                                        next one, so a wrapped line never starts with a
                                        stray '·'. On touch each chip's hit area is
                                        stretched invisibly to 32px tall, and the margin,
                                        padding and wrap gap grow to match so that ring
                                        never reaches the title, the date or the next line. */}
                                    {visibleTags.map((tag, i) => (
                                        <span key={tag.id} className="inline-flex min-w-0 items-center gap-1.5">
                                            <button
                                                type="button"
                                                onClick={() => actions.filterTag(tag.id)}
                                                className="relative max-w-[8rem] text-xs text-stone-500 transition-colors hover:text-stone-700 hover:underline pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-2"
                                                title={`Filter by ${tag.name}`}
                                            >
                                                {/* Truncated inside, not on the button: its overflow
                                                    would clip the hit area as well as the text. */}
                                                <span className="block truncate">{tag.name}</span>
                                            </button>
                                            {i < visibleTags.length - 1 ? (
                                                <span className="text-stone-300" aria-hidden="true">
                                                    ·
                                                </span>
                                            ) : null}
                                        </span>
                                    ))}
                                    {overflow > 0 ? (
                                        <button
                                            type="button"
                                            onClick={onTags}
                                            className="text-xs text-stone-400 transition-colors hover:text-stone-600"
                                            aria-label={`Edit tags, ${overflow} more`}
                                        >
                                            +{overflow}
                                        </button>
                                    ) : null}
                                </div>
                            ) : null}
                        </div>
                        <span className="text-xs text-stone-500 sm:shrink-0">
                            {/* The reason, in words: a title tooltip never shows on touch. */}
                            {doc.archived_at ? (
                                <span className="text-amber-700">Read-only: over plan limit · </span>
                            ) : null}
                            {doc.page_count ? `${doc.page_count} ${doc.page_count === 1 ? 'page' : 'pages'} · ` : ''}
                            {formatUpdated(doc.updated_at)}
                        </span>
                    </div>
                    {/*
                      On touch the icons stay 32px (no sm: shrink) and each gets an
                      invisible 40x44 hit area over itself and the gap to its right;
                      the gaps widen just enough for that. Growing the buttons
                      instead cost the title ~40px on phones.
                    */}
                    <button
                        type="button"
                        aria-pressed={isFavorite}
                        aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                        title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                        onClick={() => actions.toggleFavorite(doc, !isFavorite)}
                        className={`relative grid place-items-center rounded-lg p-2 transition-colors hover:bg-ink/5 sm:p-1.5 sm:pointer-coarse:p-2 pointer-coarse:before:absolute pointer-coarse:before:left-0 pointer-coarse:before:-right-2 pointer-coarse:before:-inset-y-1.5 ${
                            isFavorite ? 'text-amber-500' : 'text-stone-300 hover:text-stone-500'
                        }`}
                    >
                        <StarIcon size={16} fill={isFavorite ? 'currentColor' : 'none'} />
                    </button>
                    <button
                        type="button"
                        aria-label={hasTags ? 'Edit tags' : 'Add tags'}
                        title={hasTags ? 'Edit tags' : 'Add tags'}
                        onClick={onTags}
                        className={`relative grid place-items-center rounded-lg p-2 transition-colors hover:bg-ink/5 sm:p-1.5 sm:pointer-coarse:p-2 pointer-coarse:mx-1.5 pointer-coarse:before:absolute pointer-coarse:before:left-0 pointer-coarse:before:-right-2 pointer-coarse:before:-inset-y-1.5 ${
                            hasTags ? 'text-accent' : 'text-stone-300 hover:text-stone-500'
                        }`}
                    >
                        <TagIcon size={16} />
                    </button>
                    {isOwner ? (
                        <RowMenu
                            inline
                            onRename={() => actions.rename(doc)}
                            onShare={() => actions.share(doc)}
                            onAssign={actions.assign ? () => actions.assign?.(doc) : undefined}
                            onDelete={() => actions.remove(doc)}
                        />
                    ) : (
                        <SharedScoreMenu inline onLeave={() => actions.leave(doc)} />
                    )}
                </div>
            </li>
        );
    },
    (prev, next) =>
        prev.stripComposer === next.stripComposer &&
        prev.assignedTags === next.assignedTags &&
        prev.isFavorite === next.isFavorite &&
        prev.isOwner === next.isOwner &&
        prev.actions === next.actions &&
        sameDocRow(prev.doc, next.doc),
);

ScoreRow.displayName = 'ScoreRow';

const RenameDialog = ({
    doc,
    busy,
    onClose,
    onSave,
}: {
    doc: DocumentRow;
    busy: boolean;
    onClose: () => void;
    onSave: (title: string) => Promise<void>;
}) => {
    const [title, setTitle] = useState(doc.title);
    const [error, setError] = useState<string | null>(null);

    const submit = async () => {
        const trimmed = title.trim();
        if (!trimmed) {
            setError('Enter a title.');
            return;
        }
        try {
            await onSave(trimmed);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not rename the score.');
        }
    };

    return (
        <Dialog label="Rename score" onClose={onClose}>
            <TextField
                id="rename-title"
                label="Title"
                value={title}
                autoFocus
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        void submit();
                    }
                }}
            />
            {error ? <ErrorText className="mt-2">{error}</ErrorText> : null}
            <div className="mt-5 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
                    Cancel
                </Button>
                <Button size="sm" onClick={() => void submit()} disabled={busy}>
                    {busy ? 'Saving…' : 'Save changes'}
                </Button>
            </div>
        </Dialog>
    );
};

const UploadButton = ({
    uploading,
    quotaExhausted,
    onUpload,
}: {
    uploading: boolean;
    quotaExhausted: boolean;
    onUpload: (file: File) => Promise<void>;
}) => (
    <label
        className={buttonClassName(
            'primary',
            'sm',
            uploading || quotaExhausted ? 'pointer-events-none opacity-80' : '',
        )}
    >
        <UploadIcon size={16} />
        {uploading ? 'Uploading…' : 'Upload score'}
        <input
            type="file"
            accept={UPLOAD_ACCEPT}
            className="hidden"
            disabled={uploading || quotaExhausted}
            onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                    void onUpload(file).catch(() => undefined);
                }
                e.target.value = '';
            }}
        />
    </label>
);

/**
 * Why a library with no copy on this device could not be shown:
 * - offline: the browser says so; it loads by itself on reconnect.
 * - unreachable: online, but the request never got an answer (DNS, a
 *   blocker, an outage without CORS headers); retried on a backoff.
 * - error: the server answered with a failure.
 */
type LoadFailure = 'offline' | 'unreachable' | 'error';

const LIBRARY_RETRY_BASE_MS = 5000;
const LIBRARY_RETRY_MAX_MS = 60_000;

/**
 * The browser no longer says it is offline. A page showing an 'offline' state
 * that finds this when it starts listening for 'online' missed the event (it
 * fired between the state's paint and the listener), and must reload itself.
 * An 'offline' state is only ever set while navigator.onLine is false (see
 * classifyLoadFailure), so this cannot loop.
 */
const backOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;

const classifyLoadFailure = (...errors: unknown[]): LoadFailure => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return 'offline';
    }
    return errors.some(isTransportFailure) ? 'unreachable' : 'error';
};

/**
 * The notice over the list painted from this device's snapshot when the
 * network load failed — worded by the same split as LIBRARY_UNAVAILABLE_COPY,
 * so a browser that is online but cannot reach the server is not told it is
 * offline.
 */
const CACHED_LIST_NOTICE: Record<LoadFailure, string> = {
    offline: 'Offline — showing scores cached on this device.',
    unreachable: 'Couldn’t reach Cleffy — showing scores cached on this device.',
    error: 'Couldn’t load your latest scores — showing the ones cached on this device.',
};
const CACHED_LIST_NOTICES = new Set(Object.values(CACHED_LIST_NOTICE));

const LIBRARY_UNAVAILABLE_COPY: Record<LoadFailure, { title: string; body: string }> = {
    offline: { title: 'You’re offline', body: 'Your library will appear when you reconnect.' },
    unreachable: {
        title: 'Couldn’t reach Cleffy',
        body: 'Check your connection. We’ll keep trying — your scores are safe.',
    },
    error: {
        title: 'Couldn’t load your scores',
        body: 'Something went wrong loading them. Your scores are safe — try again in a moment.',
    },
};

/** The list could not be loaded and this device holds no copy of it. */
const LibraryUnavailable = ({ reason, onRetry }: { reason: LoadFailure; onRetry: () => void }) => (
    <EmptyState
        className="library-empty mt-8 md:mt-16"
        title={LIBRARY_UNAVAILABLE_COPY[reason].title}
        body={LIBRARY_UNAVAILABLE_COPY[reason].body}
    >
        <Button size="sm" variant="secondary" onClick={onRetry}>
            Try again
        </Button>
        <LocalOpenControl label="Or open a PDF locally without uploading" subtle />
    </EmptyState>
);

const EmptyLibrary = ({
    uploading,
    quotaExhausted,
    uploadPct,
    onUpload,
}: {
    uploading: boolean;
    quotaExhausted: boolean;
    uploadPct: number | null;
    onUpload: (file: File) => Promise<void>;
}) => (
    <EmptyState
        className="library-empty mt-8 md:mt-16"
        title="No scores yet"
        body="Find a score on IMSLP or upload a PDF or photo to start annotating."
    >
        <div className="flex flex-wrap items-center justify-center gap-3">
            <Link to="/search" className={buttonClassName('primary', 'sm')}>
                Find on IMSLP
            </Link>
            <UploadButton uploading={uploading} quotaExhausted={quotaExhausted} onUpload={onUpload} />
        </div>
        {uploading && uploadPct !== null ? (
            <ProgressBar value={uploadPct} label="Uploading score" className="w-full max-w-xs" />
        ) : null}
        <LocalOpenControl label="Or open a PDF locally without uploading" subtle />
    </EmptyState>
);
