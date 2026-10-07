import { Suspense, lazy, useEffect, useRef, useState } from 'react';

import { useSession } from '@/features/auth/session';
import { LimitReachedNotice } from '@/features/billing/LimitReachedNotice';
import { type LimitReachedError, limitHeadline } from '@/features/billing/limitErrors';
import { isBillingConfigured } from '@/features/billing/pricing';
import { claimPdfExport } from '@/features/export/exportClaim';
import { exportAnnotatedPageImage } from '@/features/export/exportPageImage';
import { exportAnnotatedPdf } from '@/features/export/exportPdf';
import { getCachedPdf, readCachedPdfBytes } from '@/sync/pdfCache';
import { useViewerStore } from '@/state/store';
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
    title: string;
}

/**
 * Share/export menu: this page as photo or PDF (Web Share → Messages on iOS),
 * or the whole annotated score as PDF.
 */
export const ShareExportMenu = ({ docId, bytes, title }: ShareExportMenuProps) => {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
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

    const resolveBytes = async (): Promise<ArrayBuffer> => {
        if (bytes && bytes.byteLength > 0) {
            return bytes;
        }
        const cached = await getCachedPdf(docId);
        if (!cached) {
            throw new Error('PDF is not cached on this device yet');
        }
        return readCachedPdfBytes(cached.bytes);
    };

    /**
     * `metered` marks the flows that draw down the pdf_exports allowance — the
     * two that produce a PDF. Sharing the page as a photo is a PNG and is not
     * what that counter counts (the pricing promises "1 PDF export a month").
     */
    const run = async (label: string, action: (source: ArrayBuffer) => Promise<void>, metered = false) => {
        setBusy(label);
        setLimit(null);
        setRefusal(null);
        try {
            // Bytes first — a local cache read, not the export — so a cache miss
            // fails before the meter ticks. There is no refund for a claimed
            // export (the build runs here, so "it failed" is unverifiable), and
            // spending a free account's one monthly export on a PDF that never
            // got built is exactly the dishonesty this counter exists to avoid.
            const source = await resolveBytes();
            if (metered) {
                // Still ahead of any flattening: nothing is built and thrown away.
                // Fails closed — see exportClaim.ts for why, and for the one
                // exception (an unlimited plan exporting offline).
                const claim = await claimPdfExport(session);
                if (!claim.ok) {
                    if ('limit' in claim) {
                        setLimit(claim.limit);
                    } else {
                        setRefusal(claim.message);
                    }
                    return;
                }
            }
            await action(source);
            setOpen(false);
        } catch (err) {
            console.warn('Share/export failed', err);
        } finally {
            setBusy(null);
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
                    setOpen((v) => !v);
                }}
                className={buttonClassName('ghost', 'sm')}
            >
                {busy ?? 'Share'}
            </button>
            {open ? (
                <div
                    className={`absolute right-0 z-30 mt-1 rounded-xl border border-stone-200 bg-white py-1 shadow-lg ${
                        limit || refusal ? 'w-80' : 'w-64'
                    }`}
                >
                    {/* The notice is a sibling of the menu, not an item in it. */}
                    <div role="menu">
                        <MenuItem
                            label={`Share page ${pageLabel} as photo`}
                            hint="PNG — send via Messages"
                            onClick={() =>
                                void run('Sharing…', (source) =>
                                    exportAnnotatedPageImage(docId, source, focusedPageIndex, title),
                                )
                            }
                        />
                        <MenuItem
                            label={`Share page ${pageLabel} as PDF`}
                            onClick={() =>
                                void run(
                                    'Sharing…',
                                    (source) =>
                                        exportAnnotatedPdf(docId, source, title, { pageIndex: focusedPageIndex }),
                                    true,
                                )
                            }
                        />
                        <div className="my-1 border-t border-stone-100" />
                        <MenuItem
                            label="Export whole score as PDF"
                            onClick={() =>
                                void run('Exporting…', (source) => exportAnnotatedPdf(docId, source, title), true)
                            }
                        />
                    </div>
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

const MenuItem = ({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }) => (
    <button
        type="button"
        role="menuitem"
        onClick={onClick}
        className="flex w-full flex-col items-start px-3 py-2 text-left transition hover:bg-ink/5"
    >
        <span className="text-sm text-stone-800">{label}</span>
        {hint ? <span className="text-xs text-stone-500">{hint}</span> : null}
    </button>
);
