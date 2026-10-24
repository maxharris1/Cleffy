import { Popover } from '@base-ui/react/popover';
import { Suspense, lazy, useRef, useState } from 'react';

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
import type { ShareOutcome } from '@/features/export/shareFile';
import { fetchDocument, isCloudDocId, loadDocumentBytes } from '@/features/library/documentsService';
import type { UploadProgress } from '@/lib/storageUpload';
import { getCachedPdf, readCachedPdfBytes } from '@/sync/pdfCache';
import { useViewerStore } from '@/state/store';
import type { DocumentRow, MemberRole } from '@/types/database';
import { ErrorText } from '@/ui/ErrorText';
import { ProgressBar } from '@/ui/ProgressBar';
import { SwapLabel } from '@/ui/SwapLabel';
import { buttonClassName } from '@/ui/classNames';
import { Menu, MenuItem, MenuSeparator } from '@/ui/Menu';
import { toast } from '@/ui/toast';

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
    /**
     * The account whose marks are exported, when it is not (or may no
     * longer be) the session's: an ended sign-in's last export of its own
     * unsaved marks (EndedSignInInkPrompt).
     */
    userId?: string | null;
    /**
     * Export the unsaved ink this tab kept of a score lost to this device
     * (inkRecovery.closeDocInk; SignedOutInkNotice), not the score's marks.
     */
    lostAccess?: boolean;
}

/** The busy label while the source PDF downloads; the button adds its percentage. */
const DOWNLOADING = 'Downloading…';

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
    userId: exportingFor,
    lostAccess = false,
}: ShareExportMenuProps) => {
    const [menuOpen, setMenuOpen] = useState(false);
    /** The panel under the button that says how the last export went. */
    const [noticeOpen, setNoticeOpen] = useState(false);
    const anchorRef = useRef<HTMLSpanElement | null>(null);
    /** The last export started, for the notice's Try again. */
    const lastRun = useRef<(() => Promise<void>) | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** Set while the source PDF is being downloaded for an export. */
    const [download, setDownload] = useState<UploadProgress | null>(null);
    const [limit, setLimit] = useState<LimitReachedError | null>(null);
    /** Why a PDF export was held back when it was not the allowance (offline, unreachable meter). */
    const [refusal, setRefusal] = useState<string | null>(null);
    /** The share sheet was dismissed after a PDF export was claimed. */
    const [notSent, setNotSent] = useState(false);
    /**
     * What the last export's marks need saying (exportNotice): marks it had
     * to leave out, or two versions of some. Shown, not just logged.
     */
    const [marksNotice, setMarksNotice] = useState<string | null>(null);
    const [pricingOpen, setPricingOpen] = useState(false);
    const focusedPageIndex = useViewerStore((s) => s.focusedPageIndex);
    const { session } = useSession();
    /** Whose marks are baked in (see the userId prop). */
    const markOwner = exportingFor !== undefined ? exportingFor : (session?.user.id ?? null);

    // Adjusted during render, React's pattern for state that follows a prop.
    const [seenSignal, setSeenSignal] = useState(openSignal);
    if (openSignal !== seenSignal) {
        setSeenSignal(openSignal);
        setNoticeOpen(false);
        setMenuOpen(true);
    }

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
            setBusy(DOWNLOADING);
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
        setMarksNotice(null);
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
        // The menu closed when the export started; the failure must still be
        // seen, not just logged.
        showNotice();
    };

    const finish = () => {
        setBusy(null);
        setDownload(null);
    };

    /**
     * Say how the export went, under the button. The menu holds only its
     * items (a Base UI Menu); what an export has to say — a failure, a
     * refusal, the limit with its way to the plans, marks it left out — is
     * not a menu item, so it is a panel of its own.
     */
    const showNotice = () => {
        setMenuOpen(false);
        setNoticeOpen(true);
    };

    /** An export whose marks need saying: shown, as a failure is. */
    const noteMarks = (notice: string) => {
        setMarksNotice(notice);
        showNotice();
    };

    /**
     * Done: say so, as a toast. The menu has usually closed by now (and on an
     * iPad the share sheet came and went over it), so without one a finished
     * export and an export that never started look the same. Nothing for a
     * dismissed share sheet, which says so in the menu instead.
     */
    const confirmDelivery = (outcome: ShareOutcome, subject: string, format: string) => {
        if (outcome === 'shared') {
            toast.shared(`${subject} shared as ${format}`, { description: title });
        } else if (outcome === 'downloaded') {
            toast.saved(`${subject} saved as ${format}`, { description: title });
        }
    };

    /**
     * Sending the page as a photo: a PNG, which is not what the pdf_exports
     * allowance counts (the pricing promises "1 PDF export a month"), so it is
     * built and handed over in one step with no claim.
     */
    const runUnmetered = async (
        label: string,
        failureLabel: string,
        action: (source: ArrayBuffer, onNotice: (notice: string) => void) => Promise<ShareOutcome>,
        subject: string,
    ) => {
        if (!begin(label)) {
            return;
        }
        let stage: 'source' | 'export' = 'source';
        try {
            const source = await sourceFor(label);
            stage = 'export';
            const outcome = await action(source, noteMarks);
            confirmDelivery(outcome, subject, 'a photo');
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
            const userId = markOwner;
            const onNotice = noteMarks;
            const file = await (page === null
                ? buildAnnotatedPdf(docId, source, title, { userId, onNotice, lostAccess })
                : buildAnnotatedPdf(docId, source, title, { userId, pageIndex: page, onNotice, lostAccess }));
            const claim = await claimPdfExport(session, localOnly ? null : docId, attempt);
            if (!claim.ok) {
                if ('limit' in claim) {
                    setLimit(claim.limit);
                } else {
                    setRefusal(claim.message);
                }
                showNotice();
                return;
            }
            const outcome = await deliverPdf(file);
            if (outcome === 'cancelled') {
                setNotSent(true);
                showNotice();
                return;
            }
            markExportDelivered(attempt);
            confirmDelivery(outcome, page === null ? 'Score' : `Page ${page + 1}`, 'a PDF');
        } catch (err) {
            fail(stage, failureLabel, err);
        } finally {
            finish();
        }
    };

    const pageLabel = focusedPageIndex + 1;
    const downloadPct = download && download.total > 0 ? Math.round((download.loaded / download.total) * 100) : null;
    const status = refusal ?? (notSent ? EXPORT_NOT_SENT_MESSAGE : null);
    const hasNotice = Boolean(limit || status || error || marksNotice);
    const active = busy === null ? 'idle' : busy === DOWNLOADING ? 'downloading' : 'exporting';
    const downloadingLabel = downloadPct === null ? 'Downloading…' : `Downloading… ${downloadPct}%`;

    /** Start an export from the menu, remembered for the notice's Try again. */
    const start = (run: () => Promise<void>) => {
        lastRun.current = run;
        void run();
    };
    const retry = () => {
        setNoticeOpen(false);
        if (lastRun.current) {
            void lastRun.current();
        }
    };

    return (
        <>
            {/* The anchor the notice panel hangs from; the download's progress
                runs along the button's foot. */}
            <span ref={anchorRef} className="relative inline-flex">
                <Menu
                    label={active === 'idle' ? 'Export' : active === 'exporting' ? 'Exporting…' : downloadingLabel}
                    triggerTitle="Export — this page as a photo or PDF, or the whole score as PDF"
                    triggerClassName={buttonClassName('ghost', 'sm', 'tabular-nums')}
                    triggerContent={
                        <SwapLabel
                            labels={{
                                idle: 'Export',
                                exporting: 'Exporting…',
                                downloading:
                                    downloadPct === null ? (
                                        'Downloading…'
                                    ) : (
                                        <>
                                            Downloading…{' '}
                                            <span className="inline-block w-[4ch] text-right">{downloadPct}%</span>
                                        </>
                                    ),
                            }}
                            active={active}
                        />
                    }
                    menuLabel="Export"
                    popupClassName="w-64"
                    open={menuOpen}
                    onOpenChange={(next) => {
                        if (next) {
                            setNoticeOpen(false);
                            setLimit(null);
                            setRefusal(null);
                            setNotSent(false);
                            setError(null);
                            setMarksNotice(null);
                        }
                        setMenuOpen(next);
                    }}
                >
                    <MenuItem
                        className={EXPORT_ITEM_CLASS}
                        disabled={busy !== null}
                        onClick={() =>
                            start(() =>
                                runUnmetered(
                                    'Exporting…',
                                    'The export',
                                    (source, onNotice) =>
                                        exportAnnotatedPageImage(
                                            docId,
                                            source,
                                            focusedPageIndex,
                                            title,
                                            markOwner,
                                            onNotice,
                                            lostAccess,
                                        ),
                                    `Page ${pageLabel}`,
                                ),
                            )
                        }
                    >
                        <span className="text-sm text-stone-800">Send page {pageLabel} as photo</span>
                        <span className="text-xs text-stone-500">PNG — send via Messages</span>
                    </MenuItem>
                    <MenuItem
                        className={EXPORT_ITEM_CLASS}
                        disabled={busy !== null}
                        onClick={() => {
                            const page = focusedPageIndex;
                            start(() => runMetered('Exporting…', 'The export', page));
                        }}
                    >
                        <span className="text-sm text-stone-800">Save page {pageLabel} as PDF</span>
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                        className={EXPORT_ITEM_CLASS}
                        disabled={busy !== null}
                        onClick={() => start(() => runMetered('Exporting…', 'The export', null))}
                    >
                        <span className="text-sm text-stone-800">Export whole score as PDF</span>
                    </MenuItem>
                </Menu>
                {download ? (
                    <ProgressBar
                        value={download.total > 0 ? (download.loaded / download.total) * 100 : 0}
                        indeterminate={download.total === 0}
                        label="Downloading score for export"
                        className="shell-progress absolute inset-x-1 bottom-0"
                    />
                ) : null}
            </span>
            {/* How the last export went. Outside press and Escape put it away;
                opening the menu again clears it. */}
            <Popover.Root open={noticeOpen && hasNotice} onOpenChange={setNoticeOpen}>
                <Popover.Portal>
                    <Popover.Positioner
                        anchor={anchorRef}
                        side="bottom"
                        align="end"
                        sideOffset={4}
                        collisionPadding={12}
                        className="z-50"
                    >
                        <Popover.Popup
                            aria-label="Export"
                            className="ui-menu-pop w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border border-stone-200 bg-white py-1 shadow-lg outline-none"
                        >
                            {error ? <ErrorText className="mx-3 my-2">{error}</ErrorText> : null}
                            {marksNotice ? (
                                <p
                                    role="status"
                                    className="m-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
                                >
                                    {marksNotice}
                                </p>
                            ) : null}
                            {limit ? (
                                <LimitReachedNotice
                                    limit={limit}
                                    // No upgrade button when there is no checkout to send them
                                    // to — the message alone is still the honest answer.
                                    onUpgrade={
                                        isBillingConfigured()
                                            ? () => {
                                                  setPricingOpen(true);
                                                  setNoticeOpen(false);
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
                            {/* What failed, or was held back or not sent, can be asked
                                for again from here, as it could from the old menu. */}
                            {error || status ? (
                                <div className="mx-3 my-2">
                                    <button
                                        type="button"
                                        onClick={retry}
                                        className={buttonClassName('secondary', 'sm')}
                                    >
                                        Try again
                                    </button>
                                </div>
                            ) : null}
                        </Popover.Popup>
                    </Popover.Positioner>
                </Popover.Portal>
            </Popover.Root>
            {/* Outside the menu so dismissing it does not take the plans with it. */}
            {pricingOpen ? (
                <Suspense fallback={null}>
                    <PricingDialog
                        currentTier={limit?.tier ?? 'free'}
                        reason={limit ? limitHeadline(limit) : undefined}
                        onClose={() => setPricingOpen(false)}
                    />
                </Suspense>
            ) : null}
        </>
    );
};

/** An export item: its label, and a hint under it when there is one. */
const EXPORT_ITEM_CLASS =
    'flex w-full cursor-pointer flex-col items-start px-3 py-2 text-left outline-none select-none data-highlighted:bg-ink/5 data-disabled:cursor-default data-disabled:opacity-50 pointer-coarse:min-h-11';
