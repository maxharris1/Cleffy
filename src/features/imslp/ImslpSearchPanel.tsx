import { useEffect, useEffectEvent, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { displayWorkTitle, searchTokens, splitSearchResults } from '@/features/imslp/imslpDisplay';
import { searchImslp, type ImslpSearchHit } from '@/features/imslp/imslpApi';
import { filterPopularWorks, POPULAR_WORKS, type PopularWork } from '@/features/imslp/popularWorks';
import {
    buildSearchFilters,
    categoryBackedFilters,
    FACET_DIMENSIONS,
    facetValuesFor,
    filterSearchTokens,
    filtersToStatusParts,
    hasActiveFilters,
    type EraId,
    type FacetDimension,
    type SearchSort,
} from '@/features/imslp/searchFacets';
import { fieldClassName } from '@/ui/classNames';

interface ImslpSearchPanelProps {
    disabled?: boolean;
    autoFocus?: boolean;
    onSelectTitle: (title: string) => void;
    onError?: (message: string | null) => void;
}

const DEFAULT_SEARCH_LIMIT = 100;

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

const tagClass = (active: boolean) => `imslp-facet-tag${active ? ' imslp-facet-tag--active' : ''}`;

export const ImslpSearchPanel = ({
    disabled = false,
    autoFocus = true,
    onSelectTitle,
    onError,
}: ImslpSearchPanelProps) => {
    const searchId = useId();
    const searchRef = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<ImslpSearchHit[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [dimension, setDimension] = useState<FacetDimension>('composer');
    const [composerId, setComposerId] = useState<string | null>(null);
    const [instrumentId, setInstrumentId] = useState<string | null>(null);
    const [formId, setFormId] = useState<string | null>(null);
    const [keyId, setKeyId] = useState<string | null>(null);
    const [eraId, setEraId] = useState<EraId | null>(null);
    const [sort, setSort] = useState<SearchSort>('relevance');

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
    const canCategorySort = categoryBackedFilters(filters);

    useEffect(() => {
        if (autoFocus) {
            searchRef.current?.focus();
        }
    }, [autoFocus]);

    const runSearch = useEffectEvent(async (q: string, nextFilters = filters, nextSort = sort) => {
        const trimmed = q.trim();
        const withFilters = hasActiveFilters(nextFilters);
        if (trimmed.length < 2 && !withFilters) {
            setResults(null);
            setSearching(false);
            return;
        }
        setSearching(true);
        onError?.(null);
        try {
            setResults(
                await searchImslp(trimmed, {
                    limit: DEFAULT_SEARCH_LIMIT,
                    filters: withFilters ? nextFilters : undefined,
                    sort: nextSort,
                }),
            );
        } catch (err) {
            setResults([]);
            onError?.(err instanceof Error ? err.message : 'Search failed');
        } finally {
            setSearching(false);
        }
    });

    useEffect(() => {
        const q = query.trim();
        const handle = window.setTimeout(() => {
            if (q.length < 2 && !filtersActive) {
                setResults(null);
                return;
            }
            void runSearch(q, filters, sort);
        }, 280);
        return () => window.clearTimeout(handle);
    }, [query, filters, sort, filtersActive]);

    const q = query.trim();
    const isLiveQuery = q.length >= 2 || filtersActive;
    const showCurated = !isLiveQuery;
    const showResults = isLiveQuery && results !== null;
    const tokens = useMemo(() => {
        const fromQuery = searchTokens(q);
        const fromFilters = filterSearchTokens(filters);
        return [...new Set([...fromQuery, ...fromFilters])];
    }, [q, filters]);
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

    const statusLine = (() => {
        const facetParts = filtersToStatusParts(filters);
        const facetPrefix = facetParts.length > 0 ? `${facetParts.join(' · ')} · ` : '';
        if (searching) {
            return `${facetPrefix}Searching IMSLP…`;
        }
        if (isLiveQuery && results) {
            return `${facetPrefix}${results.length} result${results.length === 1 ? '' : 's'}`;
        }
        return `Popular · ${curatedWorks.length} scores`;
    })();

    const selectPopular = (item: PopularWork) => {
        onSelectTitle(item.title);
    };

    const selectHit = (hit: ImslpSearchHit) => {
        onSelectTitle(hit.title);
    };

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

    const clearFilters = () => {
        setComposerId(null);
        setInstrumentId(null);
        setFormId(null);
        setKeyId(null);
        setEraId(null);
        setSort('relevance');
    };

    const renderHit = (hit: ImslpSearchHit) => {
        const parsed = displayWorkTitle(hit.title);
        const composer = hit.composer ?? parsed.composer;
        return (
            <li key={`${hit.pageid}-${hit.title}`}>
                <button
                    type="button"
                    onClick={() => selectHit(hit)}
                    disabled={disabled}
                    className="flex w-full flex-col gap-0.5 border-b border-stone-200/80 py-2.5 text-left transition hover:border-accent/40 disabled:opacity-60"
                >
                    <span className="text-sm font-medium text-stone-800">{highlightMatches(parsed.work, tokens)}</span>
                    {composer ? (
                        <span className="text-xs text-stone-500">{highlightMatches(composer, tokens)}</span>
                    ) : null}
                </button>
            </li>
        );
    };

    const valueFacets = facetValuesFor(dimension);

    return (
        <div className="mt-4">
            <div className="imslp-search-sticky">
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

                <div className="imslp-facet-row mt-2.5" role="tablist" aria-label="Filter by">
                    {FACET_DIMENSIONS.map((dim, i) => (
                        <span key={dim.id} className="inline-flex items-center gap-2">
                            {i > 0 ? (
                                <span className="text-stone-300" aria-hidden>
                                    ·
                                </span>
                            ) : null}
                            <button
                                type="button"
                                role="tab"
                                aria-selected={dimension === dim.id}
                                className={tagClass(dimension === dim.id)}
                                onClick={() => setDimension(dim.id)}
                            >
                                {dim.label}
                            </button>
                        </span>
                    ))}
                    {filtersActive ? (
                        <>
                            <span className="text-stone-300" aria-hidden>
                                ·
                            </span>
                            <button type="button" className="imslp-facet-tag" onClick={clearFilters}>
                                Clear
                            </button>
                        </>
                    ) : null}
                </div>

                <div className="imslp-facet-row mt-1.5" role="listbox" aria-label={`${dimension} values`}>
                    {valueFacets.map((value) => (
                        <button
                            key={value.id}
                            type="button"
                            role="option"
                            aria-selected={selectedForDimension === value.id}
                            className={tagClass(selectedForDimension === value.id)}
                            onClick={() => toggleValue(value.id)}
                            disabled={disabled}
                        >
                            {value.label}
                        </button>
                    ))}
                </div>

                {canCategorySort ? (
                    <div className="imslp-facet-row mt-1.5" aria-label="Sort">
                        {(
                            [
                                { id: 'relevance' as const, label: 'Best' },
                                { id: 'title' as const, label: 'A–Z' },
                                { id: 'recent' as const, label: 'New' },
                            ] as const
                        ).map((opt, i) => (
                            <span key={opt.id} className="inline-flex items-center gap-2">
                                {i > 0 ? (
                                    <span className="text-stone-300" aria-hidden>
                                        ·
                                    </span>
                                ) : null}
                                <button
                                    type="button"
                                    className={tagClass(sort === opt.id)}
                                    onClick={() => setSort(opt.id)}
                                >
                                    {opt.label}
                                </button>
                            </span>
                        ))}
                    </div>
                ) : null}

                <p className="mt-2 text-xs text-stone-500" aria-live="polite">
                    {statusLine}
                </p>
            </div>

            {showCurated ? (
                <div key="popular" className="imslp-panel-view mt-4">
                    <h3 className="text-xs font-medium uppercase tracking-wide text-stone-500">Popular</h3>
                    <ul className="mt-1 max-h-[28rem] overflow-y-auto">
                        {curatedWorks.map((item) => (
                            <li key={`${item.label}-${item.title}`}>
                                <button
                                    type="button"
                                    onClick={() => selectPopular(item)}
                                    disabled={disabled}
                                    className="flex w-full flex-col gap-0.5 border-b border-stone-200/80 py-2.5 text-left transition hover:border-accent/40 disabled:opacity-60"
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
            ) : null}

            {showResults && results.length === 0 && !searching ? (
                <p className="imslp-panel-view mt-4 text-sm text-stone-500">
                    No works match
                    {q ? ` “${q}”` : ' these filters'}. Try fewer tags, or a nickname like “moonlight”.
                </p>
            ) : null}

            {showResults && results.length > 0 ? (
                <div
                    key={`results-${q}-${composerId}-${instrumentId}-${formId}-${keyId}-${eraId}`}
                    className="imslp-panel-view mt-3 max-h-[28rem] overflow-y-auto"
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
                </div>
            ) : null}
        </div>
    );
};
