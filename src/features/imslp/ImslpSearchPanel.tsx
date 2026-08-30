import { useEffect, useEffectEvent, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { displayWorkTitle, searchTokens, splitSearchResults } from '@/features/imslp/imslpDisplay';
import { searchImslp, type ImslpSearchHit } from '@/features/imslp/imslpApi';
import { filterPopularWorks, groupPopularByComposer, POPULAR_WORKS, type PopularWork } from '@/features/imslp/popularWorks';
import {
    buildSearchFilters,
    categoryBackedFilters,
    FACET_DIMENSIONS,
    facetValuesFor,
    filtersToStatusParts,
    hasActiveFilters,
    INSTRUMENT_FACETS,
    type EraId,
    type FacetDimension,
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
    const [dimension, setDimension] = useState<FacetDimension>('composer');
    const [composerId, setComposerId] = useState<string | null>(null);
    const [instrumentId, setInstrumentId] = useState<string | null>(DEFAULT_INSTRUMENT);
    const [formId, setFormId] = useState<string | null>(null);
    const [keyId, setKeyId] = useState<string | null>(null);
    const [eraId, setEraId] = useState<EraId | null>(null);
    const [sort, setSort] = useState<SearchSort>('relevance');

    // Supersede in-flight searches: the token decides who may write state, the
    // controller stops wasted network on the way out.
    const seqRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);
    // Enter and "Try again" bump the tick with the debounce skipped.
    const [searchTick, setSearchTick] = useState(0);
    const immediateRef = useRef(false);

    const filters = useMemo(
        () =>
            buildSearchFilters({
                composerId,
                instrumentId,
                formId,
                keyId,
                eraId,
            }),
        [composerId, instrumentId, formId, keyId, eraId],
    );
    const filtersActive = hasActiveFilters(filters);
    const isDefaultFilterState =
        instrumentId === DEFAULT_INSTRUMENT && !composerId && !formId && !keyId && !eraId;
    const isDefaultState = isDefaultFilterState && sort === 'relevance' && query.trim() === '';

    const q = query.trim();
    // The default state renders the curated piano list without a network call;
    // a search fires only for a typed query or a non-default filter choice.
    const isLiveQuery = q.length >= 2 || (filtersActive && !isDefaultFilterState);

    const runSearch = useEffectEvent(async (nextQ: string, nextFilters = filters, nextSort = sort) => {
        const trimmed = nextQ.trim();
        const withFilters = hasActiveFilters(nextFilters);
        const seq = ++seqRef.current;
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setSearching(true);
        try {
            const response = await searchImslp(trimmed, {
                limit: DEFAULT_SEARCH_LIMIT,
                filters: withFilters ? nextFilters : undefined,
                sort: nextSort,
                signal: controller.signal,
            });
            if (seq !== seqRef.current) {
                return;
            }
            setResults(response.results);
            setFilterRelaxed(response.filterRelaxed);
            setSearchError(null);
        } catch (err) {
            if (seq !== seqRef.current) {
                return;
            }
            if (err instanceof DOMException && err.name === 'AbortError') {
                return;
            }
            // Keep whatever results are on screen — a failed refresh is not
            // "no matches".
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
    });

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
                return;
            }
            void runSearch(q, filters, sort);
        }, delay);
        return () => window.clearTimeout(handle);
    }, [q, filters, sort, isLiveQuery, searchTick]);

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
        // Dismiss the mobile keyboard — the promised "search" action happened.
        searchRef.current?.blur();
    };

    const showCurated = !isLiveQuery;
    const showResults = isLiveQuery && results !== null;
    // Highlight only what the user typed — with a default instrument filter,
    // highlighting filter tokens would <mark> "Piano" on every row.
    const tokens = useMemo(() => searchTokens(q), [q]);
    const { best, more } = useMemo(() => splitSearchResults(results ?? []), [results]);

    const curatedWorks = useMemo(
        () =>
            filterPopularWorks(POPULAR_WORKS, {
                composerId,
                instrumentId,
                formId,
                keyId,
                eraId,
            }),
        [composerId, instrumentId, formId, keyId, eraId],
    );
    const curatedGroups = useMemo(() => groupPopularByComposer(curatedWorks), [curatedWorks]);

    const facetPrefix = (() => {
        const facetParts = filtersToStatusParts(filters);
        return facetParts.length > 0 ? `${facetParts.join(' · ')} · ` : '';
    })();

    const statusLine = searching
        ? `${facetPrefix}Searching IMSLP…`
        : isLiveQuery && results
          ? `${facetPrefix}${results.length} result${results.length === 1 ? '' : 's'}`
          : isLiveQuery
            ? // Nothing to show yet: either the debounce is still armed or the
              // first response failed.
              `${facetPrefix}${searchError ? 'Search unavailable' : 'Searching IMSLP…'}`
            : `${facetPrefix}Popular · ${curatedWorks.length} scores`;

    // The server relaxes the instrument hard filter, whichever one is selected.
    const relaxedInstrument = instrumentId
        ? (INSTRUMENT_FACETS.find((i) => i.id === instrumentId)?.label.toLowerCase() ?? null)
        : null;

    const toggleValue = (id: string) => {
        switch (dimension) {
            case 'composer':
                setComposerId((prev) => (prev === id ? null : id));
                break;
            case 'instrument':
                setInstrumentId((prev) => (prev === id ? null : id));
                break;
            case 'form':
                setFormId((prev) => (prev === id ? null : id));
                break;
            case 'key':
                setKeyId((prev) => (prev === id ? null : id));
                break;
            case 'era':
                setEraId((prev) => (prev === id ? null : (id as EraId)));
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
                return composerId;
            case 'instrument':
                return instrumentId;
            case 'form':
                return formId;
            case 'key':
                return keyId;
            case 'era':
                return eraId;
            default: {
                const _exhaustive: never = dimension;
                return _exhaustive;
            }
        }
    })();

    const resetToDefault = () => {
        setQuery('');
        setComposerId(null);
        setInstrumentId(DEFAULT_INSTRUMENT);
        setFormId(null);
        setKeyId(null);
        setEraId(null);
        setSort('relevance');
        setDimension('composer');
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

    const valueFacets = facetValuesFor(dimension);

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
                        onChange={(e) => setQuery(e.target.value)}
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
                    <button
                        type="button"
                        className={chipClassName(false)}
                        onClick={resetToDefault}
                        disabled={disabled}
                    >
                        Reset
                    </button>
                ) : null}
            </div>

            <div role="group" aria-label={`${dimension} values`} className={`${CHIP_ROW_CLASS} mt-1.5`}>
                {valueFacets.map((value) => (
                    <button
                        key={value.id}
                        type="button"
                        aria-pressed={selectedForDimension === value.id}
                        className={chipClassName(selectedForDimension === value.id)}
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

            {isLiveQuery && filterRelaxed && (results?.length ?? 0) > 0 ? (
                <p className="mt-2 text-xs text-stone-500">
                    Showing close matches — few {relaxedInstrument ? `${relaxedInstrument}-tagged` : 'matching'} scores
                    were found for this search.
                </p>
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
                    title="No matches"
                    body={
                        q
                            ? `Nothing on IMSLP matches “${q}” with these filters. Try a nickname like “moonlight”, or fewer filters.`
                            : 'Nothing on IMSLP matches these filters. Try fewer of them.'
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
                    key={`results-${q}-${composerId}-${instrumentId}-${formId}-${keyId}-${eraId}`}
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
                    {results.length >= DEFAULT_SEARCH_LIMIT ? (
                        <p className="mt-3 text-xs text-stone-500">
                            Showing the first {DEFAULT_SEARCH_LIMIT} results — add a composer or form to narrow down.
                        </p>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};
