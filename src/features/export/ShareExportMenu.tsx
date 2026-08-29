import type { Session } from '@supabase/supabase-js';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';

import { isRegisteredSession, useSession, userTypeOf } from '@/features/auth/session';
import { LimitReachedNotice } from '@/features/billing/LimitReachedNotice';
import { LimitReachedError, limitHeadline } from '@/features/billing/limitErrors';
import { isBillingConfigured } from '@/features/billing/pricing';
import { exportAnnotatedPageImage } from '@/features/export/exportPageImage';
import { exportAnnotatedPdf } from '@/features/export/exportPdf';
import { getSupabase } from '@/lib/supabase';
import { getCachedPdf, readCachedPdfBytes } from '@/sync/pdfCache';
import { useViewerStore } from '@/state/store';
import { buttonClassName } from '@/ui/classNames';

// Lazy for the same reason as the library shell's copy: pricing is a rare
// destination, and the viewer should not carry it in its first paint.
const PricingDialog = lazy(() =>
    import('@/features/billing/PricingDialog').then((m) => ({ default: m.PricingDialog })),
);

/**
 * The PDF export counter. Returns the refusal to show, or null to go ahead.
 *
 * Deliberately NOT enforcement. The flattening runs entirely on this device, so
 * an unreachable meter must never stop the press: refusing to print because a
 * counter could not be reached would break the product to protect a number.
 * Only an explicit ok:false from the server holds an export back — every other
 * outcome (network down, Supabase unconfigured, a malformed answer) lets the
 * export run, uncounted.
 */
const consumePdfExport = async (session: Session | null): Promise<LimitReachedError | null> => {
    // Never gated, so never counted. A share-link guest is someone else's
    // visitor with no plan of their own to draw down, and a provisioned student
    // prints what their teacher assigned. consume_pdf_export() exempts both
    // server-side too; skipping the call here just spares them the round trip.
    if (!isRegisteredSession(session) || userTypeOf(session) !== null) {
        return null;
    }

    try {
        const { data, error } = await getSupabase().rpc('consume_pdf_export', {});
        if (error || !data || data.ok) {
            return null;
        }
        return new LimitReachedError({
            code: 'limit_reached',
            metric: 'pdf_exports',
            limit: data.limit ?? 0,
            // The RPC answers with the count and the limit but not the tier, and
            // it does not need to: tier_limits gives every paid tier -1 for
            // pdf_exports, so consume_pdf_export() returns ok:true long before it
            // counts anything for them. A refusal is always a free account.
            tier: 'free',
        });
    } catch {
        return null;
    }
};

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
     * what that counter counts.
     */
    const run = async (label: string, action: (source: ArrayBuffer) => Promise<void>, metered = false) => {
        setBusy(label);
        setLimit(null);
        try {
            // Bytes first — a local cache read, not the export — so a cache miss
            // fails before the meter ticks. There is no client-side refund, and
            // spending a free account's one monthly export on a PDF that never
            // got built is exactly the dishonesty this counter exists to avoid.
            const source = await resolveBytes();
            if (metered) {
                // Still ahead of any flattening: nothing is built and thrown away.
                const refused = await consumePdfExport(session);
                if (refused) {
                    setLimit(refused);
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
                    setOpen((v) => !v);
                }}
                className={buttonClassName('ghost', 'sm')}
            >
                {busy ?? 'Share'}
            </button>
            {open ? (
                <div
                    className={`absolute right-0 z-30 mt-1 rounded-xl border border-stone-200 bg-white py-1 shadow-lg ${
                        limit ? 'w-80' : 'w-64'
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
