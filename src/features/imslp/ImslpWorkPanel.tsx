import { useMemo } from 'react';

import type { ImslpEdition, ImslpWorkDetail } from '@/features/imslp/imslpApi';
import {
    displayEditionName,
    displayWorkTitle,
    editionAvailability,
    editionListSummary,
    formatBytes,
    isEditionImportable,
    rankEditions,
    recommendEdition,
    urtextBadge,
} from '@/features/imslp/imslpDisplay';
import { Badge } from '@/ui/Badge';
import { buttonClassName, linkClassName } from '@/ui/classNames';

const DISCLAIMER =
    'IMSLP makes no guarantee that files are public domain in your country. By downloading you acknowledge you understand and agree to obey the copyright laws of your country.';

export type DownloadStatus =
    { kind: 'idle' } | { kind: 'downloading' } | { kind: 'fallback'; openUrl: string; message: string };

interface ImslpWorkPanelProps {
    work: ImslpWorkDetail;
    selected: ImslpEdition | null;
    download: DownloadStatus;
    /** Library is uploading the handed-off PDF. */
    busy: boolean;
    importing: boolean;
    /** Tapping a downloadable row selects it and starts the import. */
    onImport: (edition: ImslpEdition) => void;
    onImportLocalPdf: (file: File) => void;
}

const URTEXT_COPYRIGHT_NOTE = /copyright status for urtext/i;

type Availability = NonNullable<ReturnType<typeof editionAvailability>>;

const warnBadgeLabel = (availability: Availability): string => {
    switch (availability.kind) {
        case 'restricted':
            if (availability.label.length > 32 || URTEXT_COPYRIGHT_NOTE.test(availability.label)) {
                return 'Restricted';
            }
            return availability.label;
        case 'unknown':
            return availability.label;
        case 'downloadable':
            return availability.label;
        default: {
            const _exhaustive: never = availability;
            return _exhaustive;
        }
    }
};

export const ImslpWorkPanel = ({
    work,
    selected,
    download,
    busy,
    importing,
    onImport,
    onImportLocalPdf,
}: ImslpWorkPanelProps) => {
    const parsed = displayWorkTitle(work.title);
    const composer = work.composer ?? parsed.composer;

    const recommended = useMemo(() => recommendEdition(work.editions), [work.editions]);
    const ranked = useMemo(() => rankEditions(work.editions), [work.editions]);

    const importableCount = work.editions.filter(isEditionImportable).length;
    const noneImportable = work.editions.length > 0 && importableCount === 0;
    const noUrtext = work.editions.length > 0 && !work.editions.some((e) => e.urtext);
    const countLine = editionListSummary(work.editions);

    const statusLine = download.kind === 'downloading' ? 'Downloading from IMSLP…' : busy ? 'Adding to library…' : null;

    return (
        <div className="imslp-panel-view mt-4">
            <p className="text-sm font-medium text-stone-800">{parsed.work}</p>
            {composer ? <p className="mt-0.5 text-xs text-stone-500">{composer}</p> : null}
            <a
                href={work.imslpUrl}
                target="_blank"
                rel="noreferrer"
                className={`mt-1 inline-block text-xs ${linkClassName}`}
            >
                View on IMSLP
            </a>

            {work.editions.length === 0 ? (
                <p className="mt-4 text-sm text-stone-500">No PDF editions found for this work.</p>
            ) : (
                <div className="mt-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-stone-500">Choose a PDF edition</p>
                    {countLine ? <p className="mt-1 text-xs text-stone-500">{countLine}</p> : null}
                    {noUrtext ? (
                        <p className="mt-1 text-xs text-stone-500">No Urtext file tagged on this IMSLP page.</p>
                    ) : null}
                    {!noneImportable ? (
                        <p className="mt-3 max-w-prose text-xs leading-relaxed text-stone-600">{DISCLAIMER}</p>
                    ) : null}
                    <ul className="mt-2 max-h-[16.5rem] overflow-y-auto" aria-label="PDF editions">
                        {ranked.map((edition) => {
                            const checked = selected?.filename === edition.filename;
                            const importable = isEditionImportable(edition);
                            const availability = editionAvailability(edition);
                            const publisherLabel = edition.publisher
                                ? [edition.publisher, edition.year].filter(Boolean).join(' ')
                                : null;
                            const meta = [
                                publisherLabel,
                                edition.description,
                                availability && availability.kind === 'downloadable' ? availability.label : null,
                                formatBytes(edition.size) || null,
                            ].filter(Boolean);
                            const name = displayEditionName(edition.filename);
                            const rowClass = `flex items-start gap-2.5 border-b border-stone-200/80 py-2.5 ${
                                checked ? 'bg-accent-soft' : ''
                            }`;
                            const badge = urtextBadge(edition);
                            const showRecommended = !badge && recommended?.filename === edition.filename;
                            const showWarn = !importable && availability !== null;
                            const identity = (
                                <span className="min-w-0 flex-1">
                                    <span className="flex flex-wrap items-center gap-1.5 text-sm text-stone-800">
                                        {badge ? (
                                            <Badge tone="accent" className="shrink-0">
                                                {badge}
                                            </Badge>
                                        ) : null}
                                        {showRecommended ? (
                                            <Badge tone="accent" className="shrink-0">
                                                Recommended
                                            </Badge>
                                        ) : null}
                                        {showWarn && availability ? (
                                            <Badge tone="warn" className="shrink-0">
                                                {warnBadgeLabel(availability)}
                                            </Badge>
                                        ) : null}
                                        <span
                                            className={`min-w-0 flex-1 break-words ${importable ? '' : 'text-stone-500'}`}
                                        >
                                            {name}
                                        </span>
                                    </span>
                                    {meta.length > 0 ? (
                                        <span className="mt-0.5 block text-xs text-stone-500">{meta.join(' · ')}</span>
                                    ) : null}
                                    {!importable ? (
                                        <span className="mt-0.5 block text-xs text-stone-500">
                                            {availability?.kind === 'unknown'
                                                ? 'License unknown — '
                                                : 'Not downloadable here — '}
                                            <a
                                                href={edition.openUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                                className={`text-xs ${linkClassName}`}
                                            >
                                                open on IMSLP
                                            </a>
                                        </span>
                                    ) : null}
                                </span>
                            );
                            return (
                                <li key={edition.filename}>
                                    {importable ? (
                                        <div className={rowClass}>
                                            <button
                                                type="button"
                                                onClick={() => onImport(edition)}
                                                disabled={importing}
                                                aria-label={`Download ${name}`}
                                                className={`min-w-0 flex-1 text-left disabled:cursor-default ${
                                                    importing ? 'opacity-70' : 'cursor-pointer hover:bg-stone-50'
                                                }`}
                                            >
                                                {identity}
                                            </button>
                                            <a
                                                href={edition.openUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                                className={`mt-0.5 shrink-0 self-start text-xs ${linkClassName}`}
                                            >
                                                Open on IMSLP
                                            </a>
                                        </div>
                                    ) : (
                                        <div className={`${rowClass} opacity-70`}>{identity}</div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                    {statusLine ? (
                        <p className="mt-2 text-xs text-stone-600" role="status">
                            {statusLine}
                        </p>
                    ) : null}
                </div>
            )}

            {noneImportable ? (
                <div className="mt-4 rounded-lg border border-amber-300/70 bg-amber-50/80 p-3">
                    <p className="text-sm text-amber-950">
                        None of these editions can be imported automatically — Cleffy could not confirm they are cleared
                        for direct download here.
                    </p>
                    <p className="mt-1 text-xs text-amber-900/80">
                        Open the work on IMSLP to review your options there, or choose a PDF you already own.
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                        <a
                            href={work.imslpUrl}
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
