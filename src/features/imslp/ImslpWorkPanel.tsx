import { useMemo, useState } from 'react';

import type { ImslpEdition, ImslpWorkDetail } from '@/features/imslp/imslpApi';
import {
    displayEditionName,
    displayWorkTitle,
    editionAvailability,
    formatBytes,
    recommendEdition,
} from '@/features/imslp/imslpDisplay';
import { Badge } from '@/ui/Badge';
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
    onImportSelected: (acceptedDisclaimer: boolean) => void;
    onImportLocalPdf: (file: File) => void;
}

const isRestricted = (edition: ImslpEdition): boolean => edition.downloadable === false;

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
    // Per-work consent: the panel remounts per work title (key in ImslpBrowser),
    // so acknowledgment never carries from one work to the next.
    const [acceptedDisclaimer, setAcceptedDisclaimer] = useState(false);

    const recommended = useMemo(() => recommendEdition(work.editions), [work.editions]);

    // Recommended first, then remaining importable editions, restricted last —
    // each group in IMSLP's own order.
    const orderedEditions = useMemo(() => {
        const rest = work.editions.filter((e) => e.filename !== recommended?.filename);
        const importable = rest.filter((e) => !isRestricted(e));
        const restricted = rest.filter(isRestricted);
        return [...(recommended ? [recommended] : []), ...importable, ...restricted];
    }, [work.editions, recommended]);

    const importableCount = work.editions.filter((e) => !isRestricted(e)).length;
    const noneImportable = work.editions.length > 0 && importableCount === 0;

    const visibleEditions =
        showAllEditions || orderedEditions.length <= EDITION_PREVIEW
            ? orderedEditions
            : orderedEditions.slice(0, EDITION_PREVIEW);

    const hiddenCount = Math.max(0, orderedEditions.length - visibleEditions.length);

    const buttonLabel =
        download.kind === 'downloading' ? 'Downloading from IMSLP…' : busy ? 'Adding to library…' : 'Add to my library';

    const countLine = (() => {
        const total = work.editions.length;
        if (total === 0) {
            return null;
        }
        const counts = `${total} available — ${importableCount} downloadable directly`;
        return recommended ? `${counts}. Recommended edition selected.` : `${counts}.`;
    })();

    return (
        <div className="imslp-panel-view mt-4">
            <p className="text-sm font-medium text-stone-800">{parsed.work}</p>
            {composer ? <p className="mt-0.5 text-xs text-stone-500">{composer}</p> : null}
            <a href={work.imslpUrl} target="_blank" rel="noreferrer" className={`mt-1 inline-block text-xs ${linkClassName}`}>
                View on IMSLP
            </a>

            {work.editions.length === 0 ? (
                <p className="mt-4 text-sm text-stone-500">No PDF editions found for this work.</p>
            ) : (
                <fieldset className="mt-4">
                    <legend className="text-xs font-medium uppercase tracking-wide text-stone-500">
                        Choose a PDF edition
                    </legend>
                    {countLine ? <p className="mt-1 text-xs text-stone-500">{countLine}</p> : null}
                    <ul className="mt-2">
                        {visibleEditions.map((edition) => {
                            const checked = selected?.filename === edition.filename;
                            const restricted = isRestricted(edition);
                            const availability = editionAvailability(edition);
                            const sizeLabel = formatBytes(edition.size);
                            const meta = [
                                availability && availability.kind !== 'restricted' ? availability.label : null,
                                sizeLabel || null,
                            ].filter(Boolean);
                            return (
                                <li key={edition.filename}>
                                    <label
                                        className={`flex items-start gap-2.5 border-b border-stone-200/80 py-2.5 ${
                                            checked ? 'bg-accent-soft' : ''
                                        } ${restricted ? 'opacity-70' : 'cursor-pointer'}`}
                                    >
                                        <input
                                            type="radio"
                                            name="imslp-edition"
                                            className="mt-1 h-4 w-4 accent-accent"
                                            checked={checked}
                                            onChange={() => onSelect(edition)}
                                            disabled={importing || restricted}
                                        />
                                        <span className="min-w-0 flex-1">
                                            <span className="flex flex-wrap items-center gap-1.5 text-sm text-stone-800">
                                                {recommended?.filename === edition.filename ? (
                                                    <Badge tone="accent">Recommended</Badge>
                                                ) : null}
                                                {restricted && availability ? (
                                                    <Badge tone="warn">{availability.label}</Badge>
                                                ) : null}
                                                <span className={restricted ? 'text-stone-500' : undefined}>
                                                    {displayEditionName(edition.filename)}
                                                </span>
                                            </span>
                                            {restricted ? (
                                                <span className="mt-0.5 block text-xs text-stone-500">
                                                    Not downloadable here —{' '}
                                                    <a
                                                        href={edition.openUrl}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className={`text-xs ${linkClassName}`}
                                                    >
                                                        open on IMSLP
                                                    </a>
                                                </span>
                                            ) : meta.length > 0 ? (
                                                <span className="text-xs text-stone-500">{meta.join(' · ')}</span>
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
                            className={`mt-2 block ${linkClassName}`}
                        >
                            Show fewer
                        </button>
                    ) : null}
                </fieldset>
            )}

            {noneImportable ? (
                <div className="mt-4 rounded-lg border border-amber-300/70 bg-amber-50/80 p-3">
                    <p className="text-sm text-amber-950">
                        None of these editions can be imported automatically — Cleffy could not confirm they
                        are cleared for direct download here.
                    </p>
                    <p className="mt-1 text-xs text-amber-900/80">
                        Open the work on IMSLP to review your options there, or choose a PDF you already own.
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                        <a href={work.imslpUrl} target="_blank" rel="noreferrer" className={buttonClassName('primary', 'sm')}>
                            Open on IMSLP
                        </a>
                        <LocalPdfPicker importing={importing} onPick={onImportLocalPdf} />
                    </div>
                </div>
            ) : (
                <>
                    {work.editions.length > 0 ? (
                        <label className="mt-4 flex max-w-prose items-start gap-2.5">
                            <input
                                type="checkbox"
                                className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                                checked={acceptedDisclaimer}
                                onChange={(e) => setAcceptedDisclaimer(e.target.checked)}
                                disabled={importing}
                            />
                            <span className="text-xs leading-relaxed text-stone-600">{DISCLAIMER}</span>
                        </label>
                    ) : null}

                    <div className="mt-4 flex flex-wrap items-center gap-3">
                        <button
                            type="button"
                            onClick={() => onImportSelected(acceptedDisclaimer)}
                            disabled={!selected || importing || work.editions.length === 0 || !acceptedDisclaimer}
                            className={buttonClassName('primary', 'sm')}
                        >
                            {buttonLabel}
                        </button>
                        {selected ? (
                            <a href={selected.openUrl} target="_blank" rel="noreferrer" className={linkClassName}>
                                Open on IMSLP
                            </a>
                        ) : null}
                    </div>
                </>
            )}

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
                        <LocalPdfPicker importing={importing} onPick={onImportLocalPdf} />
                    </div>
                </div>
            ) : null}
        </div>
    );
};

/**
 * Hand-off picker for a PDF the user fetched themselves. The input is sr-only
 * rather than display:none so it stays in the tab order; the label borrows its
 * focus ring via .label-focus-ring, matching the shell upload button.
 */
const LocalPdfPicker = ({ importing, onPick }: { importing: boolean; onPick: (file: File) => void }) => (
    <label className={`label-focus-ring cursor-pointer ${linkClassName}`}>
        Choose downloaded PDF
        <input
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            disabled={importing}
            onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                    onPick(file);
                }
                e.target.value = '';
            }}
        />
    </label>
);
