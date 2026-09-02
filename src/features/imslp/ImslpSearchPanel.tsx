import { useEffect, useEffectEvent, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { displayWorkTitle, searchTokens, splitSearchResults } from '@/features/imslp/imslpDisplay';
import { searchImslp, type ImslpPeriod, type ImslpSearchHit } from '@/features/imslp/imslpApi';
import { filterPopularWorks, groupPopularByComposer, POPULAR_WORKS, type PopularWork } from '@/features/imslp/popularWorks';
import {
    buildSearchFilters,
    categoryBackedFilters,
    ERA_FACETS,
    FACET_DIMENSIONS,
    facetValuesFor,
    filtersToStatusParts,
    hasActiveFilters,
    INSTRUMENT_FACETS,
    type FacetDimension,
    type RelaxedConstraint,
    type SearchSort,
} from '@/features/imslp/searchFacets';
import { Button } from '@/ui/Button';
import { EmptyState } from '@/ui/EmptyState';
import { ErrorText } from '@/ui/ErrorText';
import { chipClassName, fieldClassName } from '@/ui/classNames';

interface ImslpSearchPanelProps {
    disabled?: boolean;
    onSelectTitle: (title: string) => void;
}

const DEFAULT_SEARCH_LIMIT = 100;

/** Cleffy's OMR reads piano music, so the search starts piano-scoped. */
const DEFAULT_INSTRUMENT = 'piano';

/** Chip strips scroll on phones (like the library's) and wrap from sm up. */
const CHIP_ROW_CLASS =
    'no-scrollbar -mx-4 flex items-center gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:overflow-x-visible sm:px-0';

const setsEqual = (a: Set<string>, b: Set<string>): boolean => {
    if (a.size !== b.size) {
        return false;
    }
    for (const v of a) {
        if (!b.has(v)) {
            return false;
        }
    }
    return true;
};

const toggleInSet = (prev: Set<string>, id: string): Set<string> => {
    const next = new Set(prev);
    if (next.has(id)) {
        next.delete(id);
    } else {
        next.add(id);
    }
    return next;
};

const highlightMatches = (text: string, tokens: string[]): ReactNode => {
    if (tokens.length === 0 || !text) {
        return text;
    }
    const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`(${escaped.join('|')})`, 'ig');
    const parts = text.split(re);
    const tokenSet = new Set(tokens.map((t) => t.toLowerCase()));
    return parts.map((part, i) =>
        tokenSet.has(part.toLowerCase()) ? (
            <mark key={`${part}-${i}`} className="imslp-hit-mark">
                {part}
            </mark>
        ) : (
            <span key={`${part}-${i}`}>{part}</span>
        ),
    );
};

export const ImslpSearchPanel = ({ disabled = false, onSelectTitle }: ImslpSearchPanelProps) => {
    const searchId = useId();
    const searchRef = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<ImslpSearchHit[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [filterRelaxed, setFilterRelaxed] = useState(false);
    const [relaxed, setRelaxed] = useState<RelaxedConstraint[]>([]);
    const [total, setTotal] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [indexReady, setIndexReady] = useState(true);
    const [notReady, setNotReady] = useState<string[]>([]);
    const [period, setPeriod] = useState<ImslpPeriod | null>(null);
    const [searchMode, setSearchMode] = useState<'browse' | 'search' | null>(null);
    const [typedLimit, setTypedLimit] = useState(DEFAULT_SEARCH_LIMIT);
    const [dimension, setDimension] = useState<FacetDimension>('composer');
    const [composerIds, setComposerIds] = useState<Set<string>>(() => new Set());
    const [instrumentIds, setInstrumentIds] = useState<Set<string>>(() => new Set([DEFAULT_INSTRUMENT]));
    const [formIds, setFormIds] = useState<Set<string>>(() => new Set());
    const [keyIds, setKeyIds] = useState<Set<string>>(() => new Set());
    const [eraIds, setEraIds] = useState<Set<string>>(() => new Set());
    const [ignoreQueryPeriod, setIgnoreQueryPeriod] = useState(false);
    const [sort, setSort] = useState<SearchSort>('relevance');

    const seqRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);
    const [searchTick, setSearchTick] = useState(0);
    const immediateRef = useRef(false);
    /** Show-more params staged by the click for the tick effect to consume. */
    const moreRef = useRef<{ limit: number; offset: number } | null>(null);
    const [moreTick, setMoreTick] = useState(0);

    const filters = useMemo(
        () =>
            buildSearchFilters({
                composerIds,
                instrumentIds,
                formIds,
                keyIds,
                eraIds,
                ignoreQueryPeriod,
            }),
        [composerIds, instrumentIds, formIds, keyIds, eraIds, ignoreQueryPeriod],
    );
    const filtersActive = hasActiveFilters(filters);
    const isDefaultFilterState =
        setsEqual(instrumentIds, new Set([DEFAULT_INSTRUMENT])) &&
        composerIds.size === 0 &&
        formIds.size === 0 &&
        keyIds.size === 0 &&
        eraIds.size === 0;
    const isDefaultState = isDefaultFilterState && sort === 'relevance' && query.trim() === '';

    const q = query.trim();
    const isLiveQuery = q.length >= 2 || (filtersActive && !isDefaultFilterState);

    const applyResponse = (
        response: Awaited<ReturnType<typeof searchImslp>>,
        append: boolean,
        seq: number,
    ) => {
        if (seq !== seqRef.current) {
            return;
        }
        setResults((prev) => {
            if (!append || !prev) {
                return response.results;
            }
            const seen = new Set(prev.map((h) => h.pageid));
            const extra = response.results.filter((h) => !seen.has(h.pageid));
            return [...prev, ...extra];
        });
        setFilterRelaxed(response.filterRelaxed);
        setRelaxed(response.relaxed);
        setTotal(response.total);
        setHasMore(response.hasMore);
        setIndexReady(response.indexReady);
        setNotReady(response.notReady ?? []);
        setPeriod(response.period);
        setSearchMode(response.mode ?? (q.length >= 2 ? 'search' : 'browse'));
        setSearchError(null);
    };

    const runSearch = useEffectEvent(
        async (
            nextQ: string,
            nextFilters = filters,
            nextSort = sort,
            opts: { limit?: number; offset?: number; append?: boolean } = {},
        ) => {
            const trimmed = nextQ.trim();
            const withFilters = hasActiveFilters(nextFilters);
            const seq = ++seqRef.current;
            abortRef.current?.abort();
            const controller = new AbortController();
            abortRef.current = controller;
            setSearching(true);
            try {
                const response = await searchImslp(trimmed, {
                    limit: opts.limit ?? DEFAULT_SEARCH_LIMIT,
                    offset: opts.offset ?? 0,
                    filters: withFilters ? nextFilters : undefined,
                    sort: nextSort,
                    signal: controller.signal,
                });
                applyResponse(response, opts.append === true, seq);
            } catch (err) {
                if (seq !== seqRef.current) {
                    return;
                }
                if (err instanceof DOMException && err.name === 'AbortError') {
                    return;
                }
                setSearchError(
                    err instanceof DOMException && err.name === 'TimeoutError'
                        ? 'IMSLP took too long to answer.'
                        : err instanceof Error
                          ? err.message
                          : 'Search failed',
                );
            } finally {
                if (seq === seqRef.current) {
                    setSearching(false);
                }
            }
        },
    );

    useEffect(() => {
        const delay = immediateRef.current ? 0 : 280;
        immediateRef.current = false;
        const handle = window.setTimeout(() => {
            if (!isLiveQuery) {
                seqRef.current++;
                abortRef.current?.abort();
                setResults(null);
                setSearching(false);
                setSearchError(null);
                setFilterRelaxed(false);
                setRelaxed([]);
                setTotal(0);
                setHasMore(false);
                setIndexReady(true);
                setNotReady([]);
                setPeriod(null);
                setSearchMode(null);
                setTypedLimit(DEFAULT_SEARCH_LIMIT);
                return;
            }
            setTypedLimit(DEFAULT_SEARCH_LIMIT);
            void runSearch(q, filters, sort, { limit: DEFAULT_SEARCH_LIMIT, offset: 0 });
        }, delay);
        return () => window.clearTimeout(handle);
    }, [q, filters, sort, isLiveQuery, searchTick]);

    useEffect(() => {
        const params = moreRef.current;
        if (!params) {
            // Re-fires on q/filters/sort are consumed clicks — nothing staged.
            return;
        }
        moreRef.current = null;
        void runSearch(q, filters, sort, { ...params, append: true });
    }, [moreTick, q, filters, sort]);

    useEffect(
        () => () => {
            abortRef.current?.abort();
        },
        [],
    );

    const searchNow = () => {
        immediateRef.current = true;
        setSearchTick((t) => t + 1);
    };

    const submitNow = () => {
        searchNow();
        searchRef.current?.blur();
    };

    const showCurated = !isLiveQuery;
    const showResults = isLiveQuery && results !== null;
    const tokens = useMemo(() => searchTokens(q), [q]);
    const { best, more } = useMemo(() => splitSearchResults(results ?? []), [results]);

    const curatedWorks = useMemo(
        () =>
            filterPopularWorks(POPULAR_WORKS, {
                composerIds,
                instrumentIds,
                formIds,
                keyIds,
                eraIds,
            }),
        [composerIds, instrumentIds, formIds, keyIds, eraIds],
    );
    const curatedGroups = useMemo(() => groupPopularByComposer(curatedWorks), [curatedWorks]);

    const facetPrefix = (() => {
        const facetParts = filtersToStatusParts(filters);
        return facetParts.length > 0 ? `${facetParts.join(' · ')} · ` : '';
    })();

    const statusLine = searching
        ? `${facetPrefix}Searching IMSLP…`
        : isLiveQuery && results
          ? searchMode === 'browse' && indexReady
              ? `${facetPrefix}${total} score${total === 1 ? '' : 's'}`
              : hasMore && total > results.length
                ? `${facetPrefix}${results.length} of ${total}`
                : `${facetPrefix}${results.length} result${results.length === 1 ? '' : 's'}`
          : isLiveQuery
            ? `${facetPrefix}${searchError ? 'Search unavailable' : 'Searching IMSLP…'}`
            : `${facetPrefix}Popular · ${curatedWorks.length} scores`;

    const relaxedHint = (() => {
        if (relaxed.length === 0) {
            return filterRelaxed
                ? 'Showing close matches — few matching scores were found for this search.'
                : null;
        }
        const names = relaxed.map((constraint) => {
            switch (constraint) {
                case 'instrument': {
                    const labels = [...instrumentIds]
                        .map((id) => INSTRUMENT_FACETS.find((i) => i.id === id)?.label.toLowerCase())
                        .filter((v): v is string => Boolean(v));
                    return labels.length > 0 ? labels.join('/') : 'instrument';
                }
                case 'era':
                    return 'era';
                default: {
                    const _exhaustive: never = constraint;
                    return _exhaustive;
                }
            }
        });
        return `Showing close matches — the ${names.join(' and ')} filter${relaxed.length === 1 ? '' : 's'} matched too few scores.`;
    })();

    const inferredEraIds =
        period?.source === 'query' && !ignoreQueryPeriod ? new Set(period.eraIds) : new Set<string>();

    const toggleValue = (id: string) => {
        switch (dimension) {
            case 'composer':
                setComposerIds((prev) => toggleInSet(prev, id));
                break;
            case 'instrument':
                setInstrumentIds((prev) => toggleInSet(prev, id));
                break;
            case 'form':
                setFormIds((prev) => toggleInSet(prev, id));
                break;
            case 'key':
                setKeyIds((prev) => toggleInSet(prev, id));
                break;
            case 'era':
                if (inferredEraIds.has(id) && !eraIds.has(id)) {
                    setIgnoreQueryPeriod(true);
                    break;
                }
                setEraIds((prev) => toggleInSet(prev, id));
                break;
            default: {
                const _exhaustive: never = dimension;
                return _exhaustive;
            }
        }
    };

    const selectedForDimension = (() => {
        switch (dimension) {
            case 'composer':
                return composerIds;
            case 'instrument':
                return instrumentIds;
            case 'form':
                return formIds;
            case 'key':
                return keyIds;
            case 'era':
                return eraIds;
            default: {
                const _exhaustive: never = dimension;
                return _exhaustive;
            }
        }
    })();

    const isChipPressed = (id: string): boolean => {
        if (dimension === 'era' && inferredEraIds.has(id)) {
            return true;
        }
        return selectedForDimension.has(id);
    };

    const resetToDefault = () => {
        setQuery('');
        setComposerIds(new Set());
        setInstrumentIds(new Set([DEFAULT_INSTRUMENT]));
        setFormIds(new Set());
        setKeyIds(new Set());
        setEraIds(new Set());
        setIgnoreQueryPeriod(false);
        setSort('relevance');
        setDimension('composer');
    };

    const showMore = () => {
        // runSearch is an Effect Event, callable only from effects — the click
        // stages its params and bumps the tick for the effect below to consume.
        if (searchMode === 'browse') {
            moreRef.current = { limit: DEFAULT_SEARCH_LIMIT, offset: results?.length ?? 0 };
        } else {
            const nextLimit = typedLimit >= 200 ? 300 : 200;
            setTypedLimit(nextLimit);
            moreRef.current = { limit: nextLimit, offset: 0 };
        }
        setMoreTick((t) => t + 1);
    };

    const renderHit = (hit: ImslpSearchHit) => {
        const parsed = displayWorkTitle(hit.title);
        const composer = hit.composer ?? parsed.composer;
        return (
            <li key={`${hit.pageid}-${hit.title}`}>
                <button
                    type="button"
                    onClick={() => onSelectTitle(hit.title)}
                    disabled={disabled}
                    className="flex w-full flex-col gap-0.5 border-b border-stone-200/80 py-2.5 text-left transition hover:border-accent/40 hover:bg-ink/5 disabled:opacity-50"
                >
                    <span className="text-sm font-medium text-stone-800">{highlightMatches(parsed.work, tokens)}</span>
                    {composer ? (
                        <span className="text-xs text-stone-500">{highlightMatches(composer, tokens)}</span>
                    ) : null}
                    {hit.snippet ? (
                        <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-stone-500/90">
                            {hit.snippet}
                        </span>
                    ) : null}
                </button>
            </li>
        );
    };

    const valueFacets = dimension === 'era' ? ERA_FACETS : facetValuesFor(dimension);
    const emptyParts = filtersToStatusParts(filters);
    const indexLabel = notReady[0] ?? emptyParts.find((p) => ERA_FACETS.some((e) => e.label === p)) ?? 'this category';

    return (
        <div className="mt-4">
            <div className="imslp-search-sticky">
                <form
                    role="search"
                    onSubmit={(e) => {
                        e.preventDefault();
                        submitNow();
                    }}
                >
                    <label className="sr-only" htmlFor={searchId}>
                        Search IMSLP by composer or piece
                    </label>
                    <input
                        ref={searchRef}
                        id={searchId}
                        type="search"
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            // An edited query voids the "ignore its period" choice.
                            setIgnoreQueryPeriod(false);
                        }}
                        placeholder="Beethoven moonlight, bolero, Chopin nocturne…"
                        className={fieldClassName('sm')}
                        autoComplete="off"
                        enterKeyHint="search"
                    />
                </form>

                <p className="mt-2 text-xs text-stone-500" aria-live="polite">
                    {statusLine}
                </p>
            </div>

            <div role="group" aria-label="Filter by" className={`${CHIP_ROW_CLASS} mt-2.5`}>
                {FACET_DIMENSIONS.map((dim) => (
                    <button
                        key={dim.id}
                        type="button"
                        aria-pressed={dimension === dim.id}
                        className={chipClassName(dimension === dim.id)}
                        onClick={() => setDimension(dim.id)}
                        disabled={disabled}
                    >
                        {dim.label}
                    </button>
                ))}
                {!isDefaultState ? (
                    <button type="button" className={chipClassName(false)} onClick={resetToDefault} disabled={disabled}>
                        Reset
                    </button>
                ) : null}
            </div>

            <div role="group" aria-label={`${dimension} values`} className={`${CHIP_ROW_CLASS} mt-1.5`}>
                {valueFacets.map((value) => (
                    <button
                        key={value.id}
                        type="button"
                        aria-pressed={isChipPressed(value.id)}
                        className={chipClassName(isChipPressed(value.id))}
                        onClick={() => toggleValue(value.id)}
                        disabled={disabled}
                    >
                        {value.label}
                    </button>
                ))}
            </div>

            {showResults && (q.length >= 2 || categoryBackedFilters(filters)) ? (
                <div role="group" aria-label="Sort results" className={`${CHIP_ROW_CLASS} mt-1.5`}>
                    {(
                        [
                            { id: 'relevance' as const, label: 'Best' },
                            { id: 'title' as const, label: 'A–Z' },
                            { id: 'recent' as const, label: 'New' },
                        ] as const
                    ).map((opt) => (
                        <button
                            key={opt.id}
                            type="button"
                            aria-pressed={sort === opt.id}
                            className={chipClassName(sort === opt.id)}
                            onClick={() => setSort(opt.id)}
                            disabled={disabled}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
            ) : null}

            {searchError ? (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                    <ErrorText>{searchError}</ErrorText>
                    <Button variant="ghost" size="sm" onClick={searchNow}>
                        Try again
                    </Button>
                </div>
            ) : null}

            {isLiveQuery && relaxedHint && (results?.length ?? 0) > 0 ? (
                <p className="mt-2 text-xs text-stone-500">{relaxedHint}</p>
            ) : null}

            {showCurated ? (
                <div key="popular" className="imslp-panel-view mt-4">
                    <h3 className="text-xs font-medium uppercase tracking-wide text-stone-500">Popular</h3>
                    {curatedGroups.map((group) => (
                        <div key={group.composer} className="mt-3 first:mt-1">
                            <h4 className="text-xs font-medium text-stone-400">{group.composer}</h4>
                            <ul>
                                {group.works.map((item: PopularWork) => (
                                    <li key={`${item.label}-${item.title}`}>
                                        <button
                                            type="button"
                                            onClick={() => onSelectTitle(item.title)}
                                            disabled={disabled}
                                            className="flex w-full flex-col gap-0.5 border-b border-stone-200/80 py-2.5 text-left transition hover:border-accent/40 hover:bg-ink/5 disabled:opacity-50"
                                        >
                                            <span className="text-sm font-medium text-stone-800">{item.label}</span>
                                            <span className="text-xs text-stone-500">
                                                {item.composer}
                                                {item.note ? ` · ${item.note}` : ''}
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            ) : null}

            {showResults && results.length === 0 && !searching && !searchError ? (
                <EmptyState
                    className="imslp-panel-view mt-8"
                    title={!indexReady ? 'Index still building' : 'No matches'}
                    body={
                        !indexReady
                            ? `IMSLP index is still being built for ${indexLabel}. Try typing a title.`
                            : q.length >= 2
                              ? `Nothing on IMSLP matches “${q}” with these filters. Try a nickname like “moonlight”, or fewer filters.`
                              : `No IMSLP works are in all of: ${emptyParts.join(' · ') || 'these filters'}.`
                    }
                >
                    {!isDefaultState ? (
                        <Button variant="ghost" size="sm" onClick={resetToDefault}>
                            Reset filters
                        </Button>
                    ) : null}
                </EmptyState>
            ) : null}

            {showResults && results.length > 0 ? (
                <div
                    key={`results-${q}-${[...composerIds]}-${[...instrumentIds]}-${[...formIds]}-${[...keyIds]}-${[...eraIds]}`}
                    aria-busy={searching}
                    className={`imslp-panel-view mt-3 transition-opacity ${searching ? 'opacity-60' : ''}`}
                >
                    <h3 className="text-xs font-medium uppercase tracking-wide text-stone-500">Best matches</h3>
                    <ul className="mt-1">{best.map(renderHit)}</ul>
                    {more.length > 0 ? (
                        <>
                            <h3 className="mt-4 text-xs font-medium uppercase tracking-wide text-stone-500">
                                More from IMSLP
                            </h3>
                            <ul className="mt-1">{more.map(renderHit)}</ul>
                        </>
                    ) : null}
                    {hasMore ? (
                        <div className="mt-3">
                            <Button variant="ghost" size="sm" onClick={showMore} disabled={searching}>
                                Show more
                            </Button>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};
