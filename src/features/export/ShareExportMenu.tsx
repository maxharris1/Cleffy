import { Suspense, lazy, useEffect, useRef, useState } from 'react';

import { useSession } from '@/features/auth/session';
import { LimitReachedNotice } from '@/features/billing/LimitReachedNotice';
import { type LimitReachedError, limitHeadline } from '@/features/billing/limitErrors';
import { isBillingConfigured } from '@/features/billing/pricing';
import { claimPdfExport } from '@/features/export/exportClaim';
import { exportAnnotatedPageImage } from '@/features/export/exportPageImage';
import { exportAnnotatedPdf } from '@/features/export/exportPdf';
import { fetchDocument, isCloudDocId, loadDocumentBytes } from '@/features/library/documentsService';
import type { UploadProgress } from '@/lib/storageUpload';
import { getCachedPdf, readCachedPdfBytes } from '@/sync/pdfCache';
import { useViewerStore } from '@/state/store';
import type { DocumentRow } from '@/types/database';
import { ErrorText } from '@/ui/ErrorText';
import { ProgressBar } from '@/ui/ProgressBar';
import { buttonClassName } from '@/ui/classNames';

// Lazy for the same reason as the library shell's copy: pricing is a rare
// destination, and the viewer should not carry it in its first paint.
const PricingDialog = lazy(() =>
    import('@/features/billing/PricingDialog').then((m) => ({ default: m.PricingDialog })),
);

interface ShareExportMenuProps {
    docId: string;
    /** When omitted, bytes are loaded from the Dexie PDF cache (preferred after parse). */
    bytes?: ArrayBuffer;
    /**
     * The cloud row the viewer opened. With it, a cache miss (or a cached copy
     * older than content_rev) downloads the stored PDF instead of failing.
     */
    doc?: DocumentRow;
    title: string;
    /**
     * True for a score that exists only on this device (no cloud row). A guest's
     * PDF export of a cloud score is billed to its owner, which needs the
     * score's id; a local score has no owner to bill.
     */
    localOnly?: boolean;
}

/** A failure the teacher can act on, worded for them rather than for a log. */
class ExportProblem extends Error {}

const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

/** What went wrong, in the stage it went wrong in. */
const describeFailure = (stage: 'source' | 'export', label: string, err: unknown): string => {
    if (err instanceof ExportProblem) {
        return err.message;
    }
    const detail = err instanceof Error && err.message ? ` (${err.message})` : '';
    if (stage === 'source') {
        return isOffline()
            ? 'You’re offline and this score isn’t saved on this device yet. Reconnect and try again.'
            : `Couldn’t download this score to export it${detail}. Check your connection and try again.`;
    }
    return `${label} failed${detail}. Please try again.`;
};

/**
 * Share/export menu: this page as photo or PDF (Web Share → Messages on iOS),
 * or the whole annotated score as PDF.
 */
export const ShareExportMenu = ({ docId, bytes, doc, title, localOnly = false }: ShareExportMenuProps) => {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** Set while the source PDF is being downloaded for an export. */
    const [download, setDownload] = useState<UploadProgress | null>(null);
    const [limit, setLimit] = useState<LimitReachedError | null>(null);
    /** Why a PDF export was held back when it was not the allowance (offline, unreachable meter). */
    const [refusal, setRefusal] = useState<string | null>(null);
    const [pricingOpen, setPricingOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const focusedPageIndex = useViewerStore((s) => s.focusedPageIndex);
    const { session } = useSession();

    useEffect(() => {
        if (!open) {
            return;
        }
        const onPointerDown = (e: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setOpen(false);
            }
        };
        window.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('pointerdown', onPointerDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [open]);

    /**
     * The PDF to flatten. The viewer normally cached it on open, but a browser
     * that refused the cache write (private browsing, a full disk) or a score
     * replaced since leaves nothing current here — so a cloud score is fetched
     * from Storage, with progress, rather than the export quietly failing.
     */
    const resolveBytes = async (): Promise<ArrayBuffer> => {
        if (bytes && bytes.byteLength > 0) {
            return bytes;
        }
        const onProgress = (progress: UploadProgress) => {
            setBusy('Downloading…');
            setDownload(progress);
        };
        const userId = session?.user.id;
        if (doc) {
            return loadDocumentBytes(doc, { userId, onProgress });
        }
        const cached = await getCachedPdf(docId);
        if (cached) {
            return readCachedPdfBytes(cached.bytes);
        }
        if (!isCloudDocId(docId)) {
            throw new ExportProblem('This score isn’t available on this device any more. Reopen it and try again.');
        }
        const row = await fetchDocument(docId);
        if (!row) {
            throw new ExportProblem('This score is no longer available to you.');
        }
        return loadDocumentBytes(row, { userId, onProgress });
    };

    /**
     * `metered` marks the flows that draw down the pdf_exports allowance — the
     * two that produce a PDF. Sharing the page as a photo is a PNG and is not
     * what that counter counts (the pricing promises "1 PDF export a month").
     */
    const run = async (
        label: string,
        failureLabel: string,
        action: (source: ArrayBuffer) => Promise<void>,
        metered = false,
    ) => {
        if (busy !== null) {
            return;
        }
        setBusy(label);
        setLimit(null);
        setRefusal(null);
        setError(null);
        let stage: 'source' | 'export' = 'source';
        try {
            // Bytes first — a cache read or a download, not the export — so a
            // missing PDF fails before the meter ticks. There is no client-side
            // refund, and spending a free account's one monthly export on a PDF
            // that never got built is exactly the dishonesty this counter exists
            // to avoid.
            const source = await resolveBytes();
            setDownload(null);
            setBusy(label);
            stage = 'export';
            if (metered) {
                // Still ahead of any flattening: nothing is built and thrown away.
                // Fails closed — see exportClaim.ts for why, and for the one
                // exception (an unlimited plan exporting offline).
                const claim = await claimPdfExport(session, localOnly ? null : docId);
                if (!claim.ok) {
                    if ('limit' in claim) {
                        setLimit(claim.limit);
                    } else {
                        setRefusal(claim.message);
                    }
                    // Seen even if the menu was dismissed while the claim ran.
                    setOpen(true);
                    return;
                }
            }
            await action(source);
            setOpen(false);
        } catch (err) {
            console.warn('Share/export failed', err);
            setError(describeFailure(stage, failureLabel, err));
            // The menu may have been dismissed while this ran; the failure
            // must still be seen, not just logged.
            setOpen(true);
        } finally {
            setBusy(null);
            setDownload(null);
        }
    };

    const pageLabel = focusedPageIndex + 1;

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                disabled={busy !== null}
                aria-expanded={open}
                aria-haspopup="menu"
                title="Share or save annotated page"
                onClick={() => {
                    setLimit(null);
                    setRefusal(null);
                    setError(null);
                    setOpen((v) => !v);
                }}
                className={buttonClassName('ghost', 'sm')}
            >
                {busy && download && download.total > 0
                    ? `${busy} ${Math.round((download.loaded / download.total) * 100)}%`
                    : (busy ?? 'Share')}
            </button>
            {open ? (
                <div
                    className={`absolute right-0 z-30 mt-1 rounded-xl border border-stone-200 bg-white py-1 shadow-lg ${
                        limit || refusal || error ? 'w-80' : 'w-64'
                    }`}
                >
                    {/* The notice is a sibling of the menu, not an item in it. */}
                    <div role="menu">
                        <MenuItem
                            label={`Share page ${pageLabel} as photo`}
                            hint="PNG — send via Messages"
                            disabled={busy !== null}
                            onClick={() =>
                                void run('Sharing…', 'Sharing the page', (source) =>
                                    exportAnnotatedPageImage(docId, source, focusedPageIndex, title),
                                )
                            }
                        />
                        <MenuItem
                            label={`Share page ${pageLabel} as PDF`}
                            disabled={busy !== null}
                            onClick={() =>
                                void run(
                                    'Sharing…',
                                    'Sharing the page',
                                    (source) =>
                                        exportAnnotatedPdf(docId, source, title, { pageIndex: focusedPageIndex }),
                                    true,
                                )
                            }
                        />
                        <div className="my-1 border-t border-stone-100" />
                        <MenuItem
                            label="Export whole score as PDF"
                            disabled={busy !== null}
                            onClick={() =>
                                void run(
                                    'Exporting…',
                                    'The export',
                                    (source) => exportAnnotatedPdf(docId, source, title),
                                    true,
                                )
                            }
                        />
                    </div>
                    {download ? (
                        <ProgressBar
                            value={download.total > 0 ? (download.loaded / download.total) * 100 : 0}
                            indeterminate={download.total === 0}
                            label="Downloading score for export"
                            className="mx-3 my-2 w-auto"
                        />
                    ) : null}
                    {error ? <ErrorText className="mx-3 my-2">{error}</ErrorText> : null}
                    {limit ? (
                        <LimitReachedNotice
                            limit={limit}
                            // No upgrade button when there is no checkout to send them
                            // to — the message alone is still the honest answer.
                            onUpgrade={
                                isBillingConfigured()
                                    ? () => {
                                          setPricingOpen(true);
                                          setOpen(false);
                                      }
                                    : undefined
                            }
                            className="m-2"
                        />
                    ) : null}
                    {refusal ? (
                        <p
                            role="status"
                            className="m-2 rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700"
                        >
                            {refusal}
                        </p>
                    ) : null}
                </div>
            ) : null}
            {/* Outside the menu so dismissing the menu does not take the plans with it. */}
            {pricingOpen ? (
                <Suspense fallback={null}>
                    <PricingDialog
                        currentTier={limit?.tier ?? 'free'}
                        reason={limit ? limitHeadline(limit) : undefined}
                        onClose={() => setPricingOpen(false)}
                    />
                </Suspense>
            ) : null}
        </div>
    );
};

const MenuItem = ({
    label,
    hint,
    disabled = false,
    onClick,
}: {
    label: string;
    hint?: string;
    disabled?: boolean;
    onClick: () => void;
}) => (
    <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={onClick}
        className="flex w-full flex-col items-start px-3 py-2 text-left transition hover:bg-ink/5 disabled:opacity-50"
    >
        <span className="text-sm text-stone-800">{label}</span>
        {hint ? <span className="text-xs text-stone-500">{hint}</span> : null}
    </button>
);
