import { useEffect, useReducer, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { fetchImslpWork, type ImslpEdition, type ImslpWorkDetail } from '@/features/imslp/imslpApi';
import { recommendEdition, suggestedPdfName } from '@/features/imslp/imslpDisplay';
import { ImslpSearchPanel } from '@/features/imslp/ImslpSearchPanel';
import { ImslpWorkPanel, type DownloadStatus } from '@/features/imslp/ImslpWorkPanel';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { buttonClassName } from '@/ui/classNames';

export interface ImslpBrowserProps {
    /** Local PDF hand-off (manual file pick / hybrid fallback upload). */
    onImportFile: (file: File) => Promise<void>;
    /**
     * Automated IMSLP import: Edge writes Storage; returns fallback info when
     * the proxy cannot fetch (bot check / disclaimer / restricted license).
     * Real failures are recorded by the shell (captureFailure) before the
     * rethrow, so this component reports only its own load errors.
     */
    onImportImslp: (
        filename: string,
        workTitle: string,
        acceptedDisclaimer: boolean,
    ) => Promise<{ ok: true } | { ok: false; openUrl: string; message: string }>;
    /** True while the library is uploading / importing. */
    busy?: boolean;
    /** When false, omit the panel title (e.g. page already has a heading). */
    showHeading?: boolean;
    className?: string;
}

type Flow =
    | { phase: 'search' }
    | { phase: 'loadingWork' }
    | {
          phase: 'work';
          work: ImslpWorkDetail;
          selected: ImslpEdition | null;
          download: DownloadStatus;
      };

type Action =
    | { type: 'search' }
    | { type: 'loadingWork' }
    | { type: 'workLoaded'; work: ImslpWorkDetail }
    | { type: 'select'; edition: ImslpEdition }
    | { type: 'download'; download: DownloadStatus };

const initial: Flow = { phase: 'search' };

const reduce = (state: Flow, action: Action): Flow => {
    switch (action.type) {
        case 'search':
            return { phase: 'search' };
        case 'loadingWork':
            return { phase: 'loadingWork' };
        case 'workLoaded': {
            const recommended = recommendEdition(action.work.editions);
            return {
                phase: 'work',
                work: action.work,
                selected: recommended,
                download: { kind: 'idle' },
            };
        }
        case 'select':
            if (state.phase !== 'work') {
                return state;
            }
            return { ...state, selected: action.edition, download: { kind: 'idle' } };
        case 'download':
            if (state.phase !== 'work') {
                return state;
            }
            return { ...state, download: action.download };
        default: {
            const _exhaustive: never = action;
            return _exhaustive;
        }
    }
};

export const ImslpBrowser = ({
    onImportFile,
    onImportImslp,
    busy = false,
    showHeading = true,
    className = 'mt-6',
}: ImslpBrowserProps) => {
    const [flow, dispatch] = useReducer(reduce, initial);
    const [error, setError] = useState<string | null>(null);
    // The open work lives in the URL so the browser back button closes it
    // instead of leaving /search, and reloads restore it.
    const [searchParams, setSearchParams] = useSearchParams();
    const workParam = searchParams.get('work');
    const workSeqRef = useRef(0);
    const loadedTitleRef = useRef<string | null>(null);

    useEffect(() => {
        if (!workParam) {
            workSeqRef.current++;
            loadedTitleRef.current = null;
            dispatch({ type: 'search' });
            return;
        }
        if (loadedTitleRef.current === workParam) {
            return;
        }
        const seq = ++workSeqRef.current;
        setError(null);
        dispatch({ type: 'loadingWork' });
        fetchImslpWork(workParam).then(
            (work) => {
                if (seq !== workSeqRef.current) {
                    return;
                }
                loadedTitleRef.current = workParam;
                dispatch({ type: 'workLoaded', work });
            },
            (err: unknown) => {
                if (seq !== workSeqRef.current) {
                    return;
                }
                setError(err instanceof Error ? err.message : 'Could not load work');
                setSearchParams({}, { replace: true });
            },
        );
    }, [workParam, setSearchParams]);

    const closeWork = () => {
        setError(null);
        // Replace rather than push: the UI Back lands where browser back would.
        setSearchParams({}, { replace: true });
    };

    const importEdition = async (acceptedDisclaimer: boolean) => {
        if (flow.phase !== 'work' || !flow.selected) {
            return;
        }
        const { work, selected } = flow;
        setError(null);
        dispatch({ type: 'download', download: { kind: 'downloading' } });
        try {
            const result = await onImportImslp(selected.filename, work.title, acceptedDisclaimer);
            if (!result.ok) {
                dispatch({
                    type: 'download',
                    download: { kind: 'fallback', openUrl: result.openUrl, message: result.message },
                });
                return;
            }
            dispatch({ type: 'download', download: { kind: 'idle' } });
        } catch {
            // Recorded by the shell as uploadError/uploadLimit — reporting it
            // here too rendered the same message twice on /search.
            dispatch({ type: 'download', download: { kind: 'idle' } });
        }
    };

    const importLocalPdf = async (file: File) => {
        if (flow.phase !== 'work') {
            return;
        }
        setError(null);
        try {
            await onImportFile(
                new File([file], suggestedPdfName(flow.work.title, file.name), { type: 'application/pdf' }),
            );
        } catch {
            // Same contract as importEdition: the shell already recorded it.
        }
    };

    const blocked =
        busy || flow.phase === 'loadingWork' || (flow.phase === 'work' && flow.download.kind === 'downloading');

    return (
        <section className={className}>
            {showHeading || flow.phase === 'work' ? (
                <div className={`flex items-start gap-3 ${showHeading ? 'justify-between' : 'justify-end'}`}>
                    {showHeading ? (
                        <div>
                            <h2 className="text-sm font-medium text-stone-800">Find on IMSLP</h2>
                            <p className="mt-0.5 text-xs text-stone-500">
                                Search or browse popular scores, then add a PDF to your library.
                            </p>
                        </div>
                    ) : null}
                    {flow.phase === 'work' ? (
                        <button type="button" onClick={closeWork} className={buttonClassName('ghost', 'sm', 'shrink-0')}>
                            Back
                        </button>
                    ) : null}
                </div>
            ) : null}

            {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}

            {flow.phase === 'loadingWork' ? (
                <LoadingText className="mt-4 text-xs">Loading editions…</LoadingText>
            ) : null}

            {/* Kept mounted so query, facets and results survive opening a work. */}
            <div hidden={flow.phase !== 'search'}>
                <ImslpSearchPanel
                    disabled={blocked}
                    onSelectTitle={(title) => setSearchParams({ work: title })}
                />
            </div>

            {flow.phase === 'work' ? (
                <ImslpWorkPanel
                    key={flow.work.title}
                    work={flow.work}
                    selected={flow.selected}
                    download={flow.download}
                    busy={busy}
                    importing={blocked}
                    onSelect={(edition) => dispatch({ type: 'select', edition })}
                    onImportSelected={(accepted) => void importEdition(accepted)}
                    onImportLocalPdf={(file) => void importLocalPdf(file)}
                />
            ) : null}
        </section>
    );
};
