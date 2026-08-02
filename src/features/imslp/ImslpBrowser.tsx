import { useReducer, useState } from 'react';

import {
    downloadImslpPdf,
    fetchImslpWork,
    type ImslpEdition,
    type ImslpWorkDetail,
} from '@/features/imslp/imslpApi';
import { recommendEdition, suggestedPdfName } from '@/features/imslp/imslpDisplay';
import { ImslpSearchPanel } from '@/features/imslp/ImslpSearchPanel';
import { ImslpWorkPanel, type DownloadStatus } from '@/features/imslp/ImslpWorkPanel';

export interface ImslpBrowserProps {
    /** Called with a PDF File ready for uploadDocument. Library owns upload progress. */
    onImportFile: (file: File) => Promise<void>;
    /** True while the library is uploading the handed-off file. */
    busy?: boolean;
    autoFocus?: boolean;
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
          accepted: boolean;
          download: DownloadStatus;
      };

type Action =
    | { type: 'search' }
    | { type: 'loadingWork' }
    | { type: 'workLoaded'; work: ImslpWorkDetail }
    | { type: 'select'; edition: ImslpEdition }
    | { type: 'accept'; accepted: boolean }
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
                accepted: false,
                download: { kind: 'idle' },
            };
        }
        case 'select':
            if (state.phase !== 'work') {
                return state;
            }
            return { ...state, selected: action.edition, download: { kind: 'idle' } };
        case 'accept':
            if (state.phase !== 'work') {
                return state;
            }
            return { ...state, accepted: action.accepted };
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
    busy = false,
    autoFocus = true,
    showHeading = true,
    className = 'imslp-browser mt-6 rounded-xl border border-stone-300/60 bg-white/50 p-4 sm:p-5',
}: ImslpBrowserProps) => {
    const [flow, dispatch] = useReducer(reduce, initial);
    const [error, setError] = useState<string | null>(null);

    const openByTitle = async (title: string) => {
        setError(null);
        dispatch({ type: 'loadingWork' });
        try {
            dispatch({ type: 'workLoaded', work: await fetchImslpWork(title) });
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load work');
            dispatch({ type: 'search' });
        }
    };

    const importEdition = async () => {
        if (flow.phase !== 'work' || !flow.selected || !flow.accepted) {
            return;
        }
        const { work, selected } = flow;
        setError(null);
        dispatch({ type: 'download', download: { kind: 'downloading' } });
        try {
            const result = await downloadImslpPdf(selected.filename, true);
            if (!result.ok) {
                dispatch({
                    type: 'download',
                    download: { kind: 'fallback', openUrl: result.openUrl, message: result.message },
                });
                return;
            }
            const file = new File([result.bytes], suggestedPdfName(work.title, result.filename), {
                type: 'application/pdf',
            });
            // Hand off — library owns upload progress via `busy`.
            dispatch({ type: 'download', download: { kind: 'idle' } });
            await onImportFile(file);
        } catch (err) {
            dispatch({ type: 'download', download: { kind: 'idle' } });
            setError(err instanceof Error ? err.message : 'Import failed');
        }
    };

    const importLocalPdf = async (file: File) => {
        if (flow.phase !== 'work') {
            return;
        }
        setError(null);
        try {
            await onImportFile(new File([file], suggestedPdfName(flow.work.title, file.name), { type: 'application/pdf' }));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Upload failed');
        }
    };

    const blocked =
        busy || flow.phase === 'loadingWork' || (flow.phase === 'work' && flow.download.kind === 'downloading');

    return (
        <section className={className}>
            {showHeading || flow.phase === 'work' ? (
                <div
                    className={`flex items-start gap-3 ${showHeading ? 'justify-between' : 'justify-end'}`}
                >
                    {showHeading ? (
                        <div>
                            <h2 className="text-sm font-medium text-stone-800">Find on IMSLP</h2>
                            <p className="mt-0.5 text-xs text-stone-500">
                                Search or browse popular scores, then add a PDF to your library.
                            </p>
                        </div>
                    ) : null}
                    {flow.phase === 'work' ? (
                        <button
                            type="button"
                            onClick={() => {
                                setError(null);
                                dispatch({ type: 'search' });
                            }}
                            className="shrink-0 rounded-lg px-2.5 py-1 text-xs text-stone-600 transition hover:bg-black/5"
                        >
                            Back
                        </button>
                    ) : null}
                </div>
            ) : null}

            {flow.phase === 'loadingWork' ? (
                <p className="mt-4 animate-pulse text-xs text-stone-500">Loading editions…</p>
            ) : null}

            {flow.phase === 'search' ? (
                <ImslpSearchPanel
                    disabled={blocked}
                    autoFocus={autoFocus}
                    onSelectTitle={(title) => void openByTitle(title)}
                    onError={setError}
                />
            ) : null}

            {flow.phase === 'work' ? (
                <ImslpWorkPanel
                    key={flow.work.title}
                    work={flow.work}
                    selected={flow.selected}
                    accepted={flow.accepted}
                    download={flow.download}
                    busy={busy}
                    importing={blocked}
                    onSelect={(edition) => dispatch({ type: 'select', edition })}
                    onAcceptedChange={(accepted) => dispatch({ type: 'accept', accepted })}
                    onImportSelected={() => void importEdition()}
                    onImportLocalPdf={(file) => void importLocalPdf(file)}
                />
            ) : null}

            {error ? (
                <p className="mt-3 text-sm text-red-600" role="status">
                    {error}
                </p>
            ) : null}
        </section>
    );
};
