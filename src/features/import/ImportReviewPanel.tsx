import { useEffect, useMemo, useState } from 'react';

import { applyProposals } from '@/features/import/applyImport';
import { scanDocument } from '@/features/import/importPipeline';
import { recordImportStatus } from '@/features/import/importPromptService';
import { MAX_CLUSTERS_PER_PAGE } from '@/features/import/segmentation';
import { isCloudDocId } from '@/features/library/documentsService';
import type { ClassifyFn, CleanFn, ImportProposal, ImportStatus, ProposedItem } from '@/features/import/importTypes';
import type { AnnotationStore } from '@/sync/annotationStore';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { ErrorText } from '@/ui/ErrorText';
import { ProgressBar } from '@/ui/ProgressBar';

interface ImportReviewPanelProps {
    store: AnnotationStore;
    docId: string;
    bytes: ArrayBuffer;
    /** Null → strokes-only mode (no AI classification). */
    classify: ClassifyFn | null;
    /** Convert real PDF annotation objects (off for local docs). */
    includeBornDigital: boolean;
    /** Clean-and-replace step for owners of cloud docs; null hides the option. */
    clean: CleanFn | null;
    onClose: () => void;
}

/**
 * Drives the scan → review → accept flow. While reviewing, proposals render
 * through the real viewer pipeline via the store's history overlay (pixel-
 * identical preview, and the document is safely read-only meanwhile).
 */
export const ImportReviewPanel = ({
    store,
    docId,
    bytes,
    classify,
    includeBornDigital,
    clean,
    onClose,
}: ImportReviewPanelProps) => {
    const [status, setStatus] = useState<ImportStatus>({ kind: 'scanning', page: 0, pageCount: 1 });
    const [disabled, setDisabled] = useState<ReadonlySet<string>>(new Set());
    const [previewOn, setPreviewOn] = useState(true);
    const [cleanChecked, setCleanChecked] = useState(true);
    const [scanRun, setScanRun] = useState(0);
    // Scan the bytes the panel was OPENED with — accepting with cleaning swaps
    // the viewer's bytes, and that must not restart the scan over the 'done' view.
    const [scanBytes] = useState(bytes);

    useEffect(() => {
        const controller = new AbortController();
        scanDocument({
            docId,
            bytes: scanBytes,
            classify,
            includeBornDigital,
            signal: controller.signal,
            onStatus: (s) => {
                if (!controller.signal.aborted) {
                    setStatus(s);
                }
            },
        })
            .then((proposal) => {
                if (controller.signal.aborted) {
                    return;
                }
                if (proposal.pages.length === 0) {
                    setStatus({
                        kind: 'nothing-found',
                        unreadablePages: proposal.unreadablePages,
                        tooColorfulPages: proposal.tooColorfulPages,
                    });
                } else {
                    setStatus({ kind: 'review', proposal });
                }
            })
            .catch((err: unknown) => {
                if (controller.signal.aborted) {
                    return;
                }
                setStatus({
                    kind: 'error',
                    message: err instanceof Error ? err.message : 'Could not scan this score.',
                });
            });
        return () => controller.abort();
    }, [docId, scanBytes, classify, includeBornDigital, scanRun]);

    const proposal: ImportProposal | null = status.kind === 'review' ? status.proposal : null;
    const enabledItems: ProposedItem[] = useMemo(() => {
        if (!proposal) {
            return [];
        }
        return proposal.pages.flatMap((page) => page.items.filter((item) => !disabled.has(item.id)));
    }, [proposal, disabled]);

    // Live preview: proposals rendered over the real pages (read-only while shown).
    useEffect(() => {
        if (!proposal) {
            return;
        }
        if (previewOn) {
            store.setHistoryOverlay(
                [...store.liveAnnotations(), ...enabledItems.flatMap((item) => item.annotations)],
                'preview',
            );
        } else {
            store.setHistoryOverlay(null);
        }
    }, [store, proposal, enabledItems, previewOn]);

    // Any exit path must drop the overlay, or the doc stays read-only.
    useEffect(() => () => store.setHistoryOverlay(null), [store]);

    const rescan = () => {
        setDisabled(new Set());
        setStatus({ kind: 'scanning', page: 0, pageCount: 1 });
        setScanRun((n) => n + 1);
    };

    const toggleItem = (id: string) => {
        setDisabled((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    const setPage = (items: ProposedItem[], enabled: boolean) => {
        setDisabled((prev) => {
            const next = new Set(prev);
            for (const item of items) {
                if (enabled) {
                    next.delete(item.id);
                } else {
                    next.add(item.id);
                }
            }
            return next;
        });
    };

    const accept = async () => {
        if (!proposal || enabledItems.length === 0) {
            return;
        }
        const wantClean = clean !== null && cleanChecked;
        setStatus({ kind: 'applying', step: 'annotations' });
        try {
            store.setHistoryOverlay(null);
            await applyProposals(store, enabledItems);
            const created = enabledItems.length;
            let cleaned = false;
            if (wantClean && clean) {
                setStatus({ kind: 'applying', step: 'rebuild' });
                await clean(proposal, enabledItems, (step) => setStatus({ kind: 'applying', step }));
                cleaned = true;
            } else if (isCloudDocId(docId)) {
                // Cleaning records 'imported' itself (with the backup path).
                void recordImportStatus(docId, 'imported');
            }
            setStatus({ kind: 'done', created, cleaned });
        } catch (err) {
            setStatus({
                kind: 'error',
                message: err instanceof Error ? err.message : 'Import failed.',
            });
        }
    };

    // Count reviewable marks (glyphs/runs), not the stroke paths inside them —
    // "Found 312" when the user sees ~120 digits reads as a bug.
    const foundCount = proposal ? proposal.pages.reduce((sum, page) => sum + page.items.length, 0) : 0;

    return (
        <Dialog label="Import existing marks" onClose={onClose} sheet>
            {status.kind === 'idle' || status.kind === 'scanning' || status.kind === 'classifying' ? (
                <ScanProgress status={status} />
            ) : null}

            {status.kind === 'nothing-found' ? (
                <div className="mt-2">
                    <p className="text-sm text-stone-700">
                        No importable marks found. Only <span className="font-medium">colored ink</span> (blue/red pen,
                        highlighter) and real PDF annotations can be detected — pencil and black-ink handwriting can’t
                        be separated from the printed music yet.
                    </p>
                    {status.unreadablePages.length > 0 ? (
                        <p className="mt-2 text-sm text-amber-800" role="status">
                            {status.unreadablePages.length} page(s) couldn’t be read (blank or undecodable scan).
                        </p>
                    ) : null}
                    {status.tooColorfulPages.length > 0 ? (
                        <p className="mt-2 text-sm text-amber-800" role="status">
                            {status.tooColorfulPages.length} page(s) look like color photos and were skipped.
                        </p>
                    ) : null}
                    <div className="mt-4 flex justify-end">
                        <Button size="sm" onClick={onClose}>
                            Close
                        </Button>
                    </div>
                </div>
            ) : null}

            {status.kind === 'error' ? (
                <div className="mt-2">
                    <ErrorText>{status.message}</ErrorText>
                    <div className="mt-4 flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={onClose}>
                            Close
                        </Button>
                        <Button size="sm" onClick={rescan}>
                            Try again
                        </Button>
                    </div>
                </div>
            ) : null}

            {proposal ? (
                <div className="mt-1">
                    {proposal.aiDegraded ? (
                        <div className="mb-3 rounded-lg border border-amber-300/70 bg-amber-50/80 px-3 py-2.5">
                            <p className="text-sm text-amber-900">
                                Text recognition is unavailable right now — everything will import as ink you can erase,
                                not as editable text.
                            </p>
                            <button
                                type="button"
                                onClick={rescan}
                                className="mt-1.5 text-sm font-medium text-amber-900 underline underline-offset-2"
                            >
                                Try recognition again
                            </button>
                        </div>
                    ) : null}

                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm text-stone-700">
                            Found <span className="font-medium">{foundCount}</span> marks on {proposal.pages.length}{' '}
                            page(s). Unchecked marks stay untouched on the page.
                        </p>
                        <label className="flex items-center gap-1.5 text-sm text-stone-600">
                            <input
                                type="checkbox"
                                checked={previewOn}
                                onChange={(e) => setPreviewOn(e.target.checked)}
                            />
                            Preview on pages
                        </label>
                    </div>

                    <ul className="mt-3 flex max-h-72 flex-col gap-3 overflow-y-auto pr-1">
                        {proposal.pages.map((page) => {
                            const pageEnabled = page.items.filter((item) => !disabled.has(item.id));
                            return (
                                <li key={page.pageIndex}>
                                    <div className="flex items-center justify-between gap-2">
                                        <p className="text-sm font-medium text-stone-800">Page {page.pageIndex + 1}</p>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setPage(page.items, pageEnabled.length !== page.items.length)
                                            }
                                            className="text-xs text-accent underline-offset-2 hover:underline"
                                        >
                                            {pageEnabled.length === page.items.length ? 'Uncheck page' : 'Check page'}
                                        </button>
                                    </div>
                                    {page.segmentation.flags.dense ? (
                                        <p className="mt-1 text-xs text-amber-800" role="status">
                                            This page is packed with ink — only the {MAX_CLUSTERS_PER_PAGE} most
                                            prominent marks were kept.
                                        </p>
                                    ) : null}
                                    <ul className="mt-1.5 flex flex-col gap-1">
                                        {page.items.map((item) => (
                                            <li key={item.id}>
                                                <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm text-stone-700 hover:bg-ink/5">
                                                    <input
                                                        type="checkbox"
                                                        checked={!disabled.has(item.id)}
                                                        onChange={() => toggleItem(item.id)}
                                                    />
                                                    <span
                                                        aria-hidden="true"
                                                        className="h-2.5 w-2.5 shrink-0 rounded-full border border-stone-300"
                                                        style={{ backgroundColor: item.annotations[0]?.color }}
                                                    />
                                                    <span className="min-w-0 flex-1 truncate">
                                                        {item.label}
                                                        {item.isText ? '' : ' (ink)'}
                                                    </span>
                                                    {item.confidence === 'low' ? (
                                                        <Badge tone="warn">unsure</Badge>
                                                    ) : null}
                                                </label>
                                            </li>
                                        ))}
                                    </ul>
                                </li>
                            );
                        })}
                    </ul>

                    {clean !== null ? (
                        <label className="mt-3 flex items-start gap-2 text-sm text-stone-700">
                            <input
                                type="checkbox"
                                className="mt-0.5"
                                checked={cleanChecked}
                                onChange={(e) => setCleanChecked(e.target.checked)}
                            />
                            <span>
                                Also lift the original ink off the page (the file is replaced; the untouched original is
                                kept for recovery)
                            </span>
                        </label>
                    ) : null}

                    <div className="mt-4 flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button size="sm" disabled={enabledItems.length === 0} onClick={() => void accept()}>
                            Import {enabledItems.length} marks
                        </Button>
                    </div>
                </div>
            ) : null}

            {status.kind === 'applying' ? (
                <p className="mt-2 text-sm text-stone-700" role="status">
                    {status.step === 'annotations'
                        ? 'Adding marks…'
                        : status.step === 'rebuild'
                          ? 'Lifting original ink off the page…'
                          : 'Saving the cleaned score…'}
                </p>
            ) : null}

            {status.kind === 'done' ? (
                <div className="mt-2">
                    <p className="text-sm text-stone-700" role="status">
                        Imported {status.created} marks — they now behave exactly like marks made in Cleffy (edit with
                        the text tool, erase, undo).
                        {status.cleaned ? ' The page was cleaned; the original file is kept for recovery.' : ''}
                    </p>
                    <div className="mt-4 flex justify-end">
                        <Button size="sm" onClick={onClose}>
                            Done
                        </Button>
                    </div>
                </div>
            ) : null}
        </Dialog>
    );
};

const ScanProgress = ({ status }: { status: ImportStatus }) => {
    const page = status.kind === 'scanning' || status.kind === 'classifying' ? status.page : 0;
    const pageCount = status.kind === 'scanning' || status.kind === 'classifying' ? status.pageCount : 1;
    const pct = pageCount > 0 ? Math.round(((page + (status.kind === 'classifying' ? 0.5 : 0)) / pageCount) * 100) : 0;
    return (
        <div className="mt-2">
            <p className="text-sm text-stone-700" role="status">
                {status.kind === 'classifying'
                    ? `Recognizing marks on page ${page + 1} of ${pageCount}…`
                    : `Scanning page ${page + 1} of ${pageCount}…`}
            </p>
            <ProgressBar value={pct} label="Scanning score" className="mt-2" />
        </div>
    );
};
