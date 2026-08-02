import { useEffect, useRef, useState } from 'react';

import { exportAnnotatedPageImage } from '@/features/export/exportPageImage';
import { exportAnnotatedPdf } from '@/features/export/exportPdf';
import { getDb } from '@/sync/db';
import { useViewerStore } from '@/state/store';

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
    const rootRef = useRef<HTMLDivElement | null>(null);
    const focusedPageIndex = useViewerStore((s) => s.focusedPageIndex);

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
        const cached = await getDb().pdfCache.get(docId);
        if (!cached) {
            throw new Error('PDF is not cached on this device yet');
        }
        return cached.bytes.arrayBuffer();
    };

    const run = async (label: string, action: (source: ArrayBuffer) => Promise<void>) => {
        setBusy(label);
        try {
            const source = await resolveBytes();
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
                onClick={() => setOpen((v) => !v)}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-50"
            >
                {busy ?? 'Share'}
            </button>
            {open ? (
                <div
                    role="menu"
                    className="absolute right-0 z-30 mt-1 w-64 rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
                >
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
                            void run('Sharing…', (source) =>
                                exportAnnotatedPdf(docId, source, title, { pageIndex: focusedPageIndex }),
                            )
                        }
                    />
                    <div className="my-1 border-t border-stone-100" />
                    <MenuItem
                        label="Export whole score as PDF"
                        onClick={() => void run('Exporting…', (source) => exportAnnotatedPdf(docId, source, title))}
                    />
                </div>
            ) : null}
        </div>
    );
};

const MenuItem = ({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }) => (
    <button
        type="button"
        role="menuitem"
        onClick={onClick}
        className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-stone-50"
    >
        <span className="text-sm text-stone-800">{label}</span>
        {hint ? <span className="text-xs text-stone-500">{hint}</span> : null}
    </button>
);
