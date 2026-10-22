import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useSession } from '@/features/auth/session';
import { LimitReachedNotice } from '@/features/billing/LimitReachedNotice';
import { type LimitReachedError, limitHeadline } from '@/features/billing/limitErrors';
import { isBillingConfigured } from '@/features/billing/pricing';
import {
    claimPdfExport,
    EXPORT_NOT_SENT_MESSAGE,
    exportAttemptKey,
    markExportDelivered,
} from '@/features/export/exportClaim';
import { exportAnnotatedPageImage } from '@/features/export/exportPageImage';
import { buildAnnotatedPdf, deliverPdf } from '@/features/export/exportPdf';
import { fetchDocument, isCloudDocId, loadDocumentBytes } from '@/features/library/documentsService';
import type { UploadProgress } from '@/lib/storageUpload';
import { getCachedPdf, readCachedPdfBytes } from '@/sync/pdfCache';
import { useViewerStore } from '@/state/store';
import type { DocumentRow, MemberRole } from '@/types/database';
import { ErrorText } from '@/ui/ErrorText';
import { ProgressBar } from '@/ui/ProgressBar';
import { buttonClassName } from '@/ui/classNames';

// Lazy for the same reason as the library shell's copy: pricing is a rare
// destination, and the viewer should not carry it in its first paint.
const PricingDialog = lazy(() =>
    import('@/features/billing/PricingDialog').then((m) => ({ default: m.PricingDialog })),
);

/** Matches the 0.75rem the menu's max width leaves on each side. */
const MENU_GUTTER = 12;

interface ShareExportMenuProps {
    docId: string;
    /** When omitted, bytes are loaded from the Dexie PDF cache (preferred after parse). */
    bytes?: ArrayBuffer;
    /**
     * The cloud row the viewer opened. With it, a cache miss (or a cached copy
     * older than content_rev) downloads the stored PDF instead of failing.
     */
    doc?: DocumentRow;
    /**
     * The viewer's confirmed role on `doc`. A first open that is still
     * streaming has cached nothing yet, so an export then downloads the file
     * and writes the offline copy itself: with the role, like the viewer's own
     * cache writes, or the next offline open of the score is view-only.
     */
    role?: MemberRole | null;
    title: string;
    /**
     * True for a score that exists only on this device (no cloud row). A guest's
     * PDF export of a cloud score is billed to its owner, which needs the
     * score's id; a local score has no owner to bill.
     */
    localOnly?: boolean;
    /**
     * Opens the menu each time it changes: the viewer's "couldn't be
     * saved" banner offers Export as the way to keep marks this device could
     * not store.
     */
    openSignal?: number;
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
 * The viewer's Export menu: this page as photo or PDF (Web Share → Messages on
 * iOS), or the whole annotated score as PDF. Labelled "Export", not "Share" --
 * the button and every item in it: "Share" is the owner's button for giving
 * people access (ShareDialog), and one word for both sent people to the wrong
 * one.
 */
export const ShareExportMenu = ({
    docId,
    bytes,
    doc,
    role,
    title,
    localOnly = false,
    openSignal = 0,
}: ShareExportMenuProps) => {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** Set while the source PDF is being downloaded for an export. */
    const [download, setDownload] = useState<UploadProgress | null>(null);
    const [limit, setLimit] = useState<LimitReachedError | null>(null);
    /** Why a PDF export was held back when it was not the allowance (offline, unreachable meter). */
    const [refusal, setRefusal] = useState<string | null>(null);
    /** The share sheet was dismissed after a PDF export was claimed. */
    const [notSent, setNotSent] = useState(false);
    const [pricingOpen, setPricingOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const focusedPageIndex = useViewerStore((s) => s.focusedPageIndex);
    const { session } = useSession();

    // Adjusted during render, React's pattern for state that follows a prop.
    const [seenSignal, setSeenSignal] = useState(openSignal);
    if (openSignal !== seenSignal) {
        setSeenSignal(openSignal);
        setOpen(true);
    }

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
            return loadDocumentBytes(doc, { userId, role, onProgress });
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
        return loadDocumentBytes(row, { userId, role, onProgress });
    };

    /** Shared start of every flow: one at a time, and a clean slate of messages. */
    const begin = (label: string): boolean => {
        if (busy !== null) {
            return false;
        }
        setBusy(label);
        setLimit(null);
        setRefusal(null);
        setNotSent(false);
        setError(null);
        return true;
    };

    /** The PDF is in hand; put the label back after any download progress. */
    const sourceFor = async (label: string): Promise<ArrayBuffer> => {
        const source = await resolveBytes();
        setDownload(null);
        setBusy(label);
        return source;
    };

    const fail = (stage: 'source' | 'export', failureLabel: string, err: unknown) => {
        console.warn('Export failed', err);
        setError(describeFailure(stage, failureLabel, err));
        // The menu may have been dismissed while this ran; the failure must
        // still be seen, not just logged.
        setOpen(true);
    };

    const finish = () => {
        setBusy(null);
        setDownload(null);
    };

    /**
     * Sending the page as a photo: a PNG, which is not what the pdf_exports
     * allowance counts (the pricing promises "1 PDF export a month"), so it is
     * built and handed over in one step with no claim.
     */
    const runUnmetered = async (
        label: string,
        failureLabel: string,
        action: (source: ArrayBuffer) => Promise<unknown>,
    ) => {
        if (!begin(label)) {
            return;
        }
        let stage: 'source' | 'export' = 'source';
        try {
            const source = await sourceFor(label);
            stage = 'export';
            await action(source);
            setOpen(false);
        } catch (err) {
            fail(stage, failureLabel, err);
        } finally {
            finish();
        }
    };

    /**
     * The two PDF flows, which draw down the pdf_exports allowance. In order:
     * the source bytes, the finished PDF, the claim, then the hand-over. Both
     * the download and the build come before the meter ticks, so a PDF that
     * cannot be fetched or flattened fails without spending anything -- there
     * is no refund, and spending a free account's one monthly export on a file
     * that never existed is exactly the dishonesty this counter exists to
     * avoid. The claim fails closed (see exportClaim.ts, and its one exception:
     * an unlimited plan exporting offline). What can still miss after an ok --
     * the share sheet dismissed, the answer lost -- keeps the claim id for the
     * next PDF export, whichever it is, which the server does not count twice;
     * a dismissed sheet says so, or the teacher would assume it had been.
     */
    const runMetered = async (label: string, failureLabel: string, page: number | null) => {
        if (!begin(label)) {
            return;
        }
        const attempt = exportAttemptKey(session, docId);
        let stage: 'source' | 'export' = 'source';
        try {
            const source = await sourceFor(label);
            stage = 'export';
            const userId = session?.user.id ?? null;
            const file = await (page === null
                ? buildAnnotatedPdf(docId, source, title, { userId })
                : buildAnnotatedPdf(docId, source, title, { userId, pageIndex: page }));
            const claim = await claimPdfExport(session, localOnly ? null : docId, attempt);
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
            if ((await deliverPdf(file)) === 'cancelled') {
                setNotSent(true);
                setOpen(true);
                return;
            }
            markExportDelivered(attempt);
            setOpen(false);
        } catch (err) {
            fail(stage, failureLabel, err);
        } finally {
            finish();
        }
    };

    const pageLabel = focusedPageIndex + 1;
    const status = refusal ?? (notSent ? EXPORT_NOT_SENT_MESSAGE : null);
    const wide = Boolean(limit || status || error);

    // The menu hangs from the button's right edge, which on a phone sits near
    // the middle of the toolbar: widened for a notice it would run off the
    // left of the screen, so nudge it back inside the gutter.
    useLayoutEffect(() => {
        const menu = menuRef.current;
        if (!open || !menu) {
            return;
        }
        const place = () => {
            menu.style.transform = '';
            const { left } = menu.getBoundingClientRect();
            if (left < MENU_GUTTER) {
                menu.style.transform = `translateX(${MENU_GUTTER - left}px)`;
            }
        };
        place();
        window.addEventListener('resize', place);
        return () => window.removeEventListener('resize', place);
    }, [open, wide]);

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                disabled={busy !== null}
                aria-expanded={open}
                aria-haspopup="menu"
                title="Export — this page as a photo or PDF, or the whole score as PDF"
                onClick={() => {
                    setLimit(null);
                    setRefusal(null);
                    setNotSent(false);
                    setError(null);
                    setOpen((v) => !v);
                }}
                className={buttonClassName('ghost', 'sm')}
            >
                {busy && download && download.total > 0
                    ? `${busy} ${Math.round((download.loaded / download.total) * 100)}%`
                    : (busy ?? 'Export')}
            </button>
            {open ? (
                <div
                    ref={menuRef}
                    className={`absolute right-0 z-30 mt-1 max-w-[calc(100vw-1.5rem)] rounded-xl border border-stone-200 bg-white py-1 shadow-lg ${
                        wide ? 'w-80' : 'w-64'
                    }`}
                >
                    {/* The notice is a sibling of the menu, not an item in it. */}
                    <div role="menu">
                        <MenuItem
                            label={`Send page ${pageLabel} as photo`}
                            hint="PNG — send via Messages"
                            disabled={busy !== null}
                            onClick={() =>
                                void runUnmetered('Exporting…', 'The export', (source) =>
                                    exportAnnotatedPageImage(
                                        docId,
                                        source,
                                        focusedPageIndex,
                                        title,
                                        session?.user.id ?? null,
                                    ),
                                )
                            }
                        />
                        <MenuItem
                            label={`Save page ${pageLabel} as PDF`}
                            disabled={busy !== null}
                            onClick={() => void runMetered('Exporting…', 'The export', focusedPageIndex)}
                        />
                        <div className="my-1 border-t border-stone-100" />
                        <MenuItem
                            label="Export whole score as PDF"
                            disabled={busy !== null}
                            onClick={() => void runMetered('Exporting…', 'The export', null)}
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
                    {status ? (
                        <p
                            role="status"
                            className="m-2 rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700"
                        >
                            {status}
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
