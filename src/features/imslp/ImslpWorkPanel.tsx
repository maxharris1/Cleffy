import { useMemo, useState } from 'react';

import type { ImslpEdition, ImslpWorkDetail } from '@/features/imslp/imslpApi';
import { displayEditionName, displayWorkTitle, formatBytes, recommendEdition } from '@/features/imslp/imslpDisplay';
import { buttonClassName, linkClassName } from '@/ui/classNames';

const DISCLAIMER =
    'IMSLP makes no guarantee that files are public domain in your country. By downloading you acknowledge you understand and agree to obey the copyright laws of your country.';

/** Show a short list first; expand when the user wants the full IMSLP dump. */
const EDITION_PREVIEW = 6;

export type DownloadStatus =
    { kind: 'idle' } | { kind: 'downloading' } | { kind: 'fallback'; openUrl: string; message: string };

interface ImslpWorkPanelProps {
    work: ImslpWorkDetail;
    selected: ImslpEdition | null;
    download: DownloadStatus;
    /** Library is uploading the handed-off PDF. */
    busy: boolean;
    importing: boolean;
    onSelect: (edition: ImslpEdition) => void;
    onImportSelected: () => void;
    onImportLocalPdf: (file: File) => void;
}

export const ImslpWorkPanel = ({
    work,
    selected,
    download,
    busy,
    importing,
    onSelect,
    onImportSelected,
    onImportLocalPdf,
}: ImslpWorkPanelProps) => {
    const parsed = displayWorkTitle(work.title);
    const composer = work.composer ?? parsed.composer;
    const [showAllEditions, setShowAllEditions] = useState(false);

    const recommended = useMemo(() => recommendEdition(work.editions), [work.editions]);

    const orderedEditions = useMemo(() => {
        if (!recommended) {
            return work.editions;
        }
        const rest = work.editions.filter((e) => e.filename !== recommended.filename);
        return [recommended, ...rest];
    }, [work.editions, recommended]);

    const visibleEditions =
        showAllEditions || orderedEditions.length <= EDITION_PREVIEW
            ? orderedEditions
            : orderedEditions.slice(0, EDITION_PREVIEW);

    const hiddenCount = Math.max(0, orderedEditions.length - visibleEditions.length);

    const buttonLabel =
        download.kind === 'downloading' ? 'Downloading from IMSLP…' : busy ? 'Adding to library…' : 'Add to my library';

    return (
        <div className="imslp-panel-view mt-4">
            <p className="text-sm font-medium text-stone-800">{parsed.work}</p>
            {composer ? <p className="mt-0.5 text-xs text-stone-500">{composer}</p> : null}
            <a
                href={work.imslpUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block text-xs text-accent underline decoration-accent/30 underline-offset-2 transition hover:text-accent-hover hover:decoration-accent/60"
            >
                View on IMSLP
            </a>

            {work.editions.length === 0 ? (
                <p className="mt-4 text-sm text-stone-500">No PDF editions found for this work.</p>
            ) : (
                <fieldset className="mt-4">
                    <legend className="text-xs font-medium uppercase tracking-wide text-stone-500">
                        Choose a PDF edition
                    </legend>
                    <p className="mt-1 text-xs text-stone-500">
                        {work.editions.length} available
                        {recommended ? ' — recommended edition selected' : ''}.
                    </p>
                    <ul className="mt-2 max-h-56 overflow-y-auto">
                        {visibleEditions.map((edition, index) => {
                            const checked = selected?.filename === edition.filename;
                            const sizeLabel = formatBytes(edition.size);
                            const isRecommended = recommended?.filename === edition.filename;
                            return (
                                <li key={edition.filename}>
                                    <label
                                        className={`flex cursor-pointer items-start gap-2.5 border-b border-stone-200/80 py-2.5 ${
                                            checked ? 'bg-accent-soft' : ''
                                        }`}
                                    >
                                        <input
                                            type="radio"
                                            name="imslp-edition"
                                            className="mt-1 h-4 w-4 accent-accent"
                                            checked={checked}
                                            onChange={() => onSelect(edition)}
                                            disabled={importing}
                                        />
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-sm text-stone-800">
                                                {isRecommended && index === 0 ? (
                                                    <span className="mr-1.5 text-xs font-medium text-accent">
                                                        Recommended
                                                    </span>
                                                ) : null}
                                                {displayEditionName(edition.filename)}
                                            </span>
                                            {sizeLabel ? (
                                                <span className="text-xs text-stone-500">{sizeLabel}</span>
                                            ) : null}
                                        </span>
                                    </label>
                                </li>
                            );
                        })}
                    </ul>
                    {hiddenCount > 0 ? (
                        <button
                            type="button"
                            onClick={() => setShowAllEditions(true)}
                            className={`mt-2 ${linkClassName}`}
                        >
                            Show all {orderedEditions.length} editions
                        </button>
                    ) : null}
                    {showAllEditions && orderedEditions.length > EDITION_PREVIEW ? (
                        <button
                            type="button"
                            onClick={() => setShowAllEditions(false)}
                            className="mt-2 block text-sm text-stone-600 underline decoration-stone-300 underline-offset-2 transition hover:text-accent"
                        >
                            Show fewer
                        </button>
                    ) : null}
                </fieldset>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                    type="button"
                    onClick={onImportSelected}
                    disabled={!selected || importing || work.editions.length === 0}
                    className={buttonClassName('primary', 'sm')}
                >
                    {buttonLabel}
                </button>
                {selected ? (
                    <a
                        href={selected.openUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-stone-600 underline decoration-stone-300 underline-offset-2 transition hover:text-accent"
                    >
                        Open on IMSLP
                    </a>
                ) : null}
            </div>

            <p className="mt-3 max-w-prose text-xs leading-relaxed text-stone-500">{DISCLAIMER}</p>

            {download.kind === 'fallback' ? (
                <div className="mt-4 rounded-lg border border-amber-300/70 bg-amber-50/80 p-3">
                    <p className="text-sm text-amber-950">{download.message}</p>
                    <p className="mt-1 text-xs text-amber-900/80">
                        Open the file on IMSLP (verify if asked), save the PDF, then choose it here.
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                        <a
                            href={download.openUrl}
                            target="_blank"
                            rel="noreferrer"
                            className={buttonClassName('primary', 'sm')}
                        >
                            Open on IMSLP
                        </a>
                        <label className="cursor-pointer text-sm text-stone-700 underline decoration-stone-300 underline-offset-2 transition hover:text-accent">
                            Choose downloaded PDF
                            <input
                                type="file"
                                accept="application/pdf,.pdf"
                                className="hidden"
                                disabled={importing}
                                onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) {
                                        onImportLocalPdf(file);
                                    }
                                    e.target.value = '';
                                }}
                            />
                        </label>
                    </div>
                </div>
            ) : null}
        </div>
    );
};
