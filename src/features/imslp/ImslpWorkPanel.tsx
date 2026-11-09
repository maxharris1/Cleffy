import { useId, useMemo, useState } from 'react';

import { NO_CLOUD_SCORES_MESSAGE, limitHeadline, type LimitReachedError } from '@/features/billing/limitErrors';
import type { ImslpEdition, ImslpWorkDetail } from '@/features/imslp/imslpApi';
import {
    displayWorkTitle,
    editionFileLabel,
    editionHeadline,
    editionScopeTag,
    editionsNeedingFileLabel,
    isEditionImportable,
    isTaggedUrtext,
    recommendEdition,
    splitEditions,
} from '@/features/imslp/imslpDisplay';
import { Badge } from '@/ui/Badge';
import { buttonClassName, linkClassName } from '@/ui/classNames';
import { ArrowLeftIcon, ChevronDownIcon } from '@/ui/icons';

/** Full wording behind "Learn more": Add is the acknowledgement it asks for. */
const DISCLAIMER =
    'Files are not guaranteed to be public domain in your country. By downloading you acknowledge you understand and agree to obey the copyright laws of your country.';

/**
 * `queued`: IMSLP downloads are paced deployment-wide and this one is waiting
 * for its slot — the client retries on its own, so it reads as progress, not
 * as an error.
 */
export type DownloadStatus =
    | { kind: 'idle' }
    | { kind: 'downloading' }
    | { kind: 'queued' }
    | { kind: 'fallback'; openUrl: string; message: string };

const QUEUED_COPY = 'Queued — score downloads are paced. Retrying automatically…';

interface ImslpWorkPanelProps {
    work: ImslpWorkDetail;
    selected: ImslpEdition | null;
    download: DownloadStatus;
    /** Library is uploading the handed-off PDF. */
    busy: boolean;
    importing: boolean;
    /** Free cloud-score quota is exhausted — Add stays disabled. */
    quotaExhausted?: boolean;
    /** This month's imports from Find a score are spent — Add stays disabled. */
    importLimit?: LimitReachedError | null;
    /** False on student (limit 0): plain copy, no upgrade CTA. */
    quotaUpgradeHint?: boolean;
    /** Opens the plans from the disabled Add's hint. */
    onUpgrade?: () => void;
    /** Closes the work and returns to search. Sits with the title, not the page chrome. */
    onBack: () => void;
    onSelect: (edition: ImslpEdition) => void;
    onImportSelected: () => void;
    onImportLocalPdf: (file: File) => void;
    /** Stops an import waiting in the pacing queue. Nothing has been created or charged yet. */
    onCancelQueued?: () => void;
}

interface ImslpWorkPanelProps {
    work: ImslpWorkDetail;
    selected: ImslpEdition | null;
    download: DownloadStatus;
    /** Library is uploading the handed-off PDF. */
    busy: boolean;
    importing: boolean;
    /** Free cloud-score quota is exhausted — Add stays disabled. */
    quotaExhausted?: boolean;
    /** This month's imports from Find a score are spent — Add stays disabled. */
    importLimit?: LimitReachedError | null;
    /** False on student (limit 0): plain copy, no upgrade CTA. */
    quotaUpgradeHint?: boolean;
    /** Opens the plans from the disabled Add's hint. */
    onUpgrade?: () => void;
    /** Closes the work and returns to search. Sits with the title, not the page chrome. */
    onBack: () => void;
    onSelect: (edition: ImslpEdition) => void;
    onImportSelected: () => void;
    onImportLocalPdf: (file: File) => void;
    /** Stops an import waiting in the pacing queue. Nothing has been created or charged yet. */
    onCancelQueued?: () => void;
}

/**
 * The way on from a disabled Add: opens the plans. A button (it opens a dialog,
 * it goes nowhere) dressed as the inline link it reads as. Without a handler
 * the words stay as plain text rather than a control that does nothing.
 */
const UpgradeLink = ({ onUpgrade, children }: { onUpgrade?: () => void; children: string }) =>
    onUpgrade ? (
        <button type="button" onClick={onUpgrade} className={`cursor-pointer text-xs ${linkClassName}`}>
            {children}
        </button>
    ) : (
        <>{children}</>
    );

export const ImslpWorkPanel = ({
    work,
    selected,
    download,
    busy,
    importing,
    quotaExhausted = false,
    importLimit = null,
    quotaUpgradeHint = true,
    onUpgrade,
    onBack,
    onSelect,
    onImportSelected,
    onImportLocalPdf,
    onCancelQueued,
}: ImslpWorkPanelProps) => {
    const parsed = displayWorkTitle(work.title);
    const composer = work.composer ?? parsed.composer;
    const [othersOpen, setOthersOpen] = useState(false);
    const [legalOpen, setLegalOpen] = useState(false);
    const othersId = useId();
    const legalId = useId();

    const recommended = useMemo(() => recommendEdition(work.editions), [work.editions]);
    const { importable, unavailable } = useMemo(() => splitEditions(work.editions), [work.editions]);
    const needsFileLabel = useMemo(() => editionsNeedingFileLabel(importable), [importable]);

    const noneImportable = work.editions.length > 0 && importable.length === 0;
    const selectedImportable = selected !== null && isEditionImportable(selected);
    const otherCount = importable.length - 1;

    const buttonLabel =
        download.kind === 'downloading'
            ? 'Downloading score…'
            : download.kind === 'queued'
              ? 'Queued for download…'
              : busy
                ? 'Adding to library…'
                : 'Add to my library';
    /* The Add button is disabled while this runs, so its label change is not
       announced — the polite region below is the only screen-reader feedback. */
    const statusLine =
        download.kind === 'downloading'
            ? 'Downloading score…'
            : download.kind === 'queued'
              ? QUEUED_COPY
              : busy
                ? 'Adding to library…'
                : null;

    return (
        <div className="imslp-panel-view mt-2">
            <button type="button" onClick={onBack} className={buttonClassName('ghost', 'sm', '-ml-3.5')}>
                <ArrowLeftIcon size={16} aria-hidden />
                Back
            </button>
            <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-stone-900 sm:text-3xl">
                {parsed.work}
            </h2>
            <p className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-stone-500">
                {composer ? <span>{composer}</span> : null}
                <a href={work.imslpUrl} target="_blank" rel="noreferrer" className={`text-xs ${linkClassName}`}>
                    View source page
                </a>
            </p>

            {work.editions.length === 0 ? (
                <p className="mt-6 text-sm text-stone-500">No PDF editions found for this work.</p>
            ) : null}

            {importable.length > 0 ? (
                <div className="mt-6 max-w-2xl rounded-xl border border-stone-200 bg-white/70">
                    <div className="px-4 py-3.5">
                        {selected ? (
                            <EditionLabel
                                edition={selected}
                                recommended={selected.filename === recommended?.filename}
                                showFileLabel={needsFileLabel.has(selected.filename)}
                                prominent
                            />
                        ) : (
                            <p className="text-sm text-stone-500">No edition selected.</p>
                        )}
                    </div>
                    {otherCount > 0 ? (
                        <div className="border-t border-stone-200">
                            <button
                                type="button"
                                onClick={() => setOthersOpen((open) => !open)}
                                aria-expanded={othersOpen}
                                aria-controls={othersId}
                                className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-b-xl px-4 py-2.5 text-left text-sm text-stone-600 hover:bg-ink/5 hover:text-stone-800"
                            >
                                Choose a different edition ({otherCount})
                                <ChevronDownIcon
                                    size={16}
                                    aria-hidden
                                    className={`shrink-0 transition-transform ${othersOpen ? 'rotate-180' : ''}`}
                                />
                            </button>
                            {othersOpen ? (
                                <fieldset id={othersId} className="px-2 pb-2">
                                    <legend className="sr-only">PDF editions</legend>
                                    <ul aria-label="PDF editions">
                                        {importable.map((edition) => {
                                            const checked = selected?.filename === edition.filename;
                                            return (
                                                <li key={edition.filename}>
                                                    <label
                                                        className={[
                                                            'flex items-start gap-2.5 rounded-lg px-2 py-2.5',
                                                            checked ? 'bg-accent-soft' : 'hover:bg-ink/5',
                                                            importing ? 'cursor-default' : 'cursor-pointer',
                                                        ].join(' ')}
                                                    >
                                                        <input
                                                            type="radio"
                                                            name="imslp-edition"
                                                            className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                                                            checked={checked}
                                                            onChange={() => onSelect(edition)}
                                                            disabled={importing}
                                                        />
                                                        <EditionLabel
                                                            edition={edition}
                                                            recommended={edition.filename === recommended?.filename}
                                                            showFileLabel={needsFileLabel.has(edition.filename)}
                                                        />
                                                    </label>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                    {unavailable.length > 0 ? (
                                        <p className="mt-2 px-2 text-xs text-stone-500">
                                            {unavailable.length} more{' '}
                                            {unavailable.length === 1 ? 'edition' : 'editions'} can’t be downloaded
                                            here.{' '}
                                            <a
                                                href={work.imslpUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                                className={`text-xs ${linkClassName}`}
                                            >
                                                View source page
                                            </a>
                                        </p>
                                    ) : null}
                                </fieldset>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            ) : null}

            {noneImportable ? (
                <div className="mt-6 max-w-2xl rounded-lg border border-amber-300/70 bg-amber-50/80 p-3">
                    <p className="text-sm text-amber-950">
                        {unavailable.every((e) => e.licenseCheck === 'unavailable')
                            ? 'Couldn’t check the licenses just now, so nothing can be imported automatically. Try again in a minute.'
                            : 'None of these editions can be imported automatically — Cleffy could not confirm they are cleared for direct download here.'}
                    </p>
                    <p className="mt-1 text-xs text-amber-900/80">
                        View the source page to review your options there, or choose a PDF you already own.
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                        <a
                            href={work.imslpUrl}
                            target="_blank"
                            rel="noreferrer"
                            className={buttonClassName('primary', 'sm')}
                        >
                            View source page
                        </a>
                        <LocalPdfPicker importing={importing} onPick={onImportLocalPdf} />
                    </div>
                </div>
            ) : importable.length > 0 ? (
                /* Below sm the footer sticks to the bottom edge while the open
                   edition list scrolls past, so Add stays in reach of the
                   choice it adds. See .imslp-action-footer. */
                <div className="imslp-action-footer mt-4">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <button
                            type="button"
                            onClick={onImportSelected}
                            disabled={!selectedImportable || importing || quotaExhausted || importLimit !== null}
                            className={buttonClassName('primary', 'sm')}
                        >
                            {buttonLabel}
                        </button>
                        {quotaExhausted ? (
                            <p className="text-xs text-stone-600">
                                {quotaUpgradeHint ? (
                                    <>
                                        Cloud-score limit reached —{' '}
                                        <UpgradeLink onUpgrade={onUpgrade}>upgrade to add this edition</UpgradeLink>.
                                    </>
                                ) : (
                                    NO_CLOUD_SCORES_MESSAGE
                                )}
                            </p>
                        ) : importLimit ? (
                            <p className="text-xs text-stone-600">
                                {limitHeadline(importLimit)} —{' '}
                                <UpgradeLink onUpgrade={onUpgrade}>see plans</UpgradeLink>.
                            </p>
                        ) : !selectedImportable ? (
                            <p className="text-xs text-stone-500">Select a downloadable edition to add.</p>
                        ) : null}
                    </div>
                    {/* In the footer so Cancel stays beside the Add it stops. */}
                    {download.kind === 'queued' ? (
                        <div className="mt-2 flex flex-wrap items-center gap-3">
                            <p className="text-xs text-stone-600" aria-hidden="true">
                                {QUEUED_COPY}
                            </p>
                            {onCancelQueued ? (
                                <button
                                    type="button"
                                    onClick={onCancelQueued}
                                    className={buttonClassName('ghost', 'sm')}
                                >
                                    Cancel import
                                </button>
                            ) : null}
                        </div>
                    ) : null}
                    <p className="mt-2 text-xs text-stone-500">
                        Public-domain status varies by country.{' '}
                        <button
                            type="button"
                            onClick={() => setLegalOpen((open) => !open)}
                            aria-expanded={legalOpen}
                            aria-controls={legalId}
                            className={`cursor-pointer text-xs ${linkClassName}`}
                        >
                            Learn more
                        </button>
                    </p>
                    <p
                        id={legalId}
                        hidden={!legalOpen}
                        className="mt-1 max-w-prose text-xs leading-relaxed text-stone-600"
                    >
                        {DISCLAIMER}
                    </p>
                </div>
            ) : null}

            <p className="sr-only" role="status" aria-live="polite">
                {statusLine ?? ''}
            </p>

            {download.kind === 'fallback' ? (
                <div className="mt-4 max-w-2xl rounded-lg border border-amber-300/70 bg-amber-50/80 p-3">
                    <p className="text-sm text-amber-950">{download.message}</p>
                    <p className="mt-1 text-xs text-amber-900/80">
                        View the source page (verify if asked), save the PDF, then choose it here.
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                        <a
                            href={download.openUrl}
                            target="_blank"
                            rel="noreferrer"
                            className={buttonClassName('primary', 'sm')}
                        >
                            View source page
                        </a>
                        <LocalPdfPicker importing={importing} onPick={onImportLocalPdf} />
                    </div>
                </div>
            ) : null}
            <p className="mt-8 text-xs text-stone-500">Public-domain scores via IMSLP</p>
        </div>
    );
};

/**
 * Publisher and year first. Tags only say what is unusual — Urtext, the
 * recommendation, or a file that is not the complete score — and the IMSLP
 * file name shows only when it is the one thing telling two editions apart.
 */
const EditionLabel = ({
    edition,
    recommended,
    showFileLabel,
    prominent = false,
}: {
    edition: ImslpEdition;
    recommended: boolean;
    showFileLabel: boolean;
    prominent?: boolean;
}) => {
    const tag = editionScopeTag(edition);
    return (
        <span className="block min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span
                    className={`min-w-0 break-words ${prominent ? 'text-base font-medium text-stone-900' : 'text-sm text-stone-800'}`}
                >
                    {editionHeadline(edition)}
                </span>
                {isTaggedUrtext(edition) ? <Badge tone="accent">Urtext</Badge> : null}
                {recommended ? <Badge tone="accent">Recommended</Badge> : null}
                {tag ? <Badge>{tag}</Badge> : null}
            </span>
            {showFileLabel ? (
                <span className="mt-0.5 block break-words text-xs text-stone-500">
                    {editionFileLabel(edition.filename)}
                </span>
            ) : null}
        </span>
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
