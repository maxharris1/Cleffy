import { useMemo } from 'react';

import { NO_CLOUD_SCORES_MESSAGE, limitHeadline, type LimitReachedError } from '@/features/billing/limitErrors';
import type { ImslpEdition, ImslpWorkDetail } from '@/features/imslp/imslpApi';
import {
    displayEditionName,
    displayWorkTitle,
    editionAvailability,
    editionListSummary,
    formatBytes,
    isEditionImportable,
    recommendEdition,
    splitEditions,
    urtextBadge,
} from '@/features/imslp/imslpDisplay';
import { Badge } from '@/ui/Badge';
import { buttonClassName, linkClassName } from '@/ui/classNames';

const DISCLAIMER =
    'IMSLP makes no guarantee that files are public domain in your country. By downloading you acknowledge you understand and agree to obey the copyright laws of your country.';

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

const QUEUED_COPY = 'Queued — IMSLP downloads are paced. Retrying automatically…';

interface ImslpWorkPanelProps {
    work: ImslpWorkDetail;
    selected: ImslpEdition | null;
    download: DownloadStatus;
    /** Library is uploading the handed-off PDF. */
    busy: boolean;
    importing: boolean;
    /** Free cloud-score quota is exhausted — Add stays disabled. */
    quotaExhausted?: boolean;
    /** This month's IMSLP imports are spent — Add stays disabled. */
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

const URTEXT_COPYRIGHT_NOTE = /copyright status for urtext/i;

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

    const recommended = useMemo(() => recommendEdition(work.editions), [work.editions]);
    const { importable, unavailable } = useMemo(() => splitEditions(work.editions), [work.editions]);

    const noneImportable = work.editions.length > 0 && importable.length === 0;
    const noUrtext = work.editions.length > 0 && !work.editions.some((e) => e.urtext);
    const countLine = editionListSummary(work.editions);
    const selectedImportable = selected !== null && isEditionImportable(selected);

    const buttonLabel =
        download.kind === 'downloading'
            ? 'Downloading from IMSLP…'
            : download.kind === 'queued'
              ? 'Queued for IMSLP…'
              : busy
                ? 'Adding to library…'
                : 'Add to my library';
    /* The Add button is disabled while this runs, so its label change is not
       announced — the polite region below is the only screen-reader feedback. */
    const statusLine =
        download.kind === 'downloading'
            ? 'Downloading from IMSLP…'
            : download.kind === 'queued'
              ? QUEUED_COPY
              : busy
                ? 'Adding to library…'
                : null;

    return (
        <div className="imslp-panel-view mt-4">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
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
                </div>
                <button type="button" onClick={onBack} className={buttonClassName('ghost', 'sm', 'shrink-0')}>
                    Back
                </button>
            </div>

            {work.editions.length === 0 ? (
                <p className="mt-4 text-sm text-stone-500">No PDF editions found for this work.</p>
            ) : importable.length > 0 ? (
                <fieldset className="mt-4">
                    <legend className="text-xs font-medium uppercase tracking-wide text-stone-500">
                        Choose a PDF edition
                    </legend>
                    {countLine ? <p className="mt-1 text-xs text-stone-500">{countLine}</p> : null}
                    {noUrtext ? (
                        <p className="mt-1 text-xs text-stone-500">No Urtext file tagged on this IMSLP page.</p>
                    ) : null}
                    {/* 16rem keeps Add above the fold on a 667px-tall viewport even with
                        the disclaimer sitting below the list. Only importable rows live
                        here, so the first screen is always choosable. */}
                    <ul className="mt-2 max-h-[16rem] overflow-y-auto" aria-label="PDF editions">
                        {importable.map((edition) => {
                            const checked = selected?.filename === edition.filename;
                            const name = displayEditionName(edition.filename, edition);
                            const showRecommended = !urtextBadge(edition) && recommended?.filename === edition.filename;
                            return (
                                <li key={edition.filename}>
                                    <label
                                        className={[
                                            'flex items-start gap-2.5 border-b border-stone-200/80 py-2.5',
                                            checked ? 'bg-accent-soft' : '',
                                            importing ? 'cursor-default' : 'cursor-pointer',
                                        ]
                                            .filter(Boolean)
                                            .join(' ')}
                                    >
                                        <input
                                            type="radio"
                                            name="imslp-edition"
                                            className="mt-1 h-4 w-4 shrink-0 accent-accent"
                                            checked={checked}
                                            onChange={() => onSelect(edition)}
                                            disabled={importing}
                                            aria-label={`Select ${name}`}
                                        />
                                        <EditionIdentity edition={edition} recommended={showRecommended} />
                                    </label>
                                </li>
                            );
                        })}
                    </ul>
                </fieldset>
            ) : null}

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
            ) : work.editions.length > 0 ? (
                <>
                    <p className="mt-4 max-w-prose text-xs leading-relaxed text-stone-600">{DISCLAIMER}</p>
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                        <button
                            type="button"
                            onClick={onImportSelected}
                            disabled={!selectedImportable || importing || quotaExhausted || importLimit !== null}
                            className={buttonClassName('primary', 'sm')}
                        >
                            {buttonLabel}
                        </button>
                        {selected ? (
                            <a href={selected.openUrl} target="_blank" rel="noreferrer" className={linkClassName}>
                                Open on IMSLP
                            </a>
                        ) : null}
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
                </>
            ) : null}

            {download.kind === 'queued' ? (
                <div className="mt-2 flex flex-wrap items-center gap-3">
                    <p className="text-xs text-stone-600" aria-hidden="true">
                        {QUEUED_COPY}
                    </p>
                    {onCancelQueued ? (
                        <button type="button" onClick={onCancelQueued} className={buttonClassName('ghost', 'sm')}>
                            Cancel import
                        </button>
                    ) : null}
                </div>
            ) : null}

            <p className="sr-only" role="status" aria-live="polite">
                {statusLine ?? ''}
            </p>

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
            {unavailable.length > 0 ? (
                <section className="mt-5 border-t border-stone-200/80 pt-3" aria-labelledby="imslp-unavailable-heading">
                    <h3
                        id="imslp-unavailable-heading"
                        className="text-xs font-medium uppercase tracking-wide text-stone-500"
                    >
                        Not downloadable here ({unavailable.length})
                    </h3>
                    <p className="mt-1 text-xs text-stone-500">
                        IMSLP restricts these files or their license could not be confirmed. Open one on IMSLP to see
                        your options there.
                    </p>
                    <ul className="mt-1 max-h-[12rem] overflow-y-auto" aria-label="Editions to open on IMSLP">
                        {unavailable.map((edition) => (
                            <li
                                key={edition.filename}
                                className="flex items-start border-b border-stone-200/80 py-2.5 opacity-80"
                            >
                                <EditionIdentity edition={edition} recommended={false} />
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}
        </div>
    );
};

/**
 * One edition's name, badges and facts. Rows Cleffy cannot fetch also say why
 * and link to the file on IMSLP, where the user can review their options.
 */
const EditionIdentity = ({ edition, recommended }: { edition: ImslpEdition; recommended: boolean }) => {
    const importable = isEditionImportable(edition);
    const availability = editionAvailability(edition);
    const publisherLabel = edition.publisher ? [edition.publisher, edition.year].filter(Boolean).join(' ') : null;
    const licenseLabel = availability && availability.kind === 'downloadable' ? availability.label : null;
    const sizeLabel = formatBytes(edition.size) || null;
    const facts = [licenseLabel, sizeLabel].filter(Boolean);
    const name = displayEditionName(edition.filename, edition);
    const badge = urtextBadge(edition);
    const showWarn = !importable && availability !== null;
    return (
        <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5 text-sm text-stone-800">
                {badge ? (
                    <Badge tone="accent" className="shrink-0">
                        {badge}
                    </Badge>
                ) : null}
                {recommended ? (
                    <Badge tone="accent" className="shrink-0">
                        Recommended
                    </Badge>
                ) : null}
                {showWarn && availability ? (
                    <Badge tone="warn" className="shrink-0">
                        {warnBadgeLabel(availability)}
                    </Badge>
                ) : null}
                <span className={`min-w-0 break-words ${importable ? '' : 'text-stone-500'}`}>{name}</span>
            </span>
            {/* displayEditionName falls back to these same strings on dump
                filenames — don't print the title twice. */}
            {publisherLabel && publisherLabel !== name ? (
                <span className="mt-0.5 block text-xs leading-5 text-stone-500">{publisherLabel}</span>
            ) : null}
            {edition.description && edition.description !== name ? (
                <span className="mt-0.5 block text-xs leading-5 text-stone-500">{edition.description}</span>
            ) : null}
            {facts.length > 0 ? (
                <span className="mt-0.5 block text-xs leading-5 text-stone-500">{facts.join(' · ')}</span>
            ) : null}
            {!importable ? (
                <span className="mt-0.5 block text-xs text-stone-500">
                    {edition.licenseCheck === 'unavailable'
                        ? 'Couldn’t check the license just now — '
                        : availability?.kind === 'unknown'
                          ? 'Not importable here — '
                          : 'Not downloadable here — '}
                    <a href={edition.openUrl} target="_blank" rel="noreferrer" className={`text-xs ${linkClassName}`}>
                        {edition.licenseCheck === 'unavailable' ? 'check on IMSLP' : 'open on IMSLP'}
                    </a>
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
