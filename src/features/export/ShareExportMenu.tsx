import { useEffect, useRef, useState } from 'react';

import { exportAnnotatedPageImage } from '@/features/export/exportPageImage';
import { exportAnnotatedPdf } from '@/features/export/exportPdf';
import { getDb } from '@/sync/db';
import { useViewerStore } from '@/state/store';
import { ErrorText } from '@/ui/ErrorText';
import { buttonClassName } from '@/ui/classNames';

interface ShareExportMenuProps {
    docId: string;
    /** When omitted, bytes are loaded from the Dexie PDF cache (preferred after parse). */
    bytes?: ArrayBuffer;
    title: string;
}

const EXPORT_ERROR_COPY = {
    not_cached: 'This score is not ready to export yet. Wait a moment and try again.',
    failed: 'Could not export. Check your connection and try again.',
} as const;

const mapExportError = (err: unknown): string => {
    const message = err instanceof Error ? err.message : '';
    if (/not cached/i.test(message)) {
        return EXPORT_ERROR_COPY.not_cached;
    }
    return EXPORT_ERROR_COPY.failed;
};

/**
 * Export menu: this page as photo or PDF (Web Share → Messages on iOS),
 * or the whole annotated score as PDF.
 */
export const ShareExportMenu = ({ docId, bytes, title }: ShareExportMenuProps) => {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
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
        setError(null);
        try {
            const source = await resolveBytes();
            await action(source);
            setOpen(false);
        } catch (err) {
            setError(mapExportError(err));
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
                aria-label="Export"
                title="Export annotated page or score"
                onClick={() => setOpen((v) => !v)}
                className={buttonClassName('ghost', 'sm')}
            >
                {busy ?? 'Export'}
            </button>
            {open ? (
                <div
                    role="menu"
                    className="absolute right-0 z-30 mt-1 w-64 rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
                >
                    <MenuItem
                        label={`Export page ${pageLabel} as photo`}
                        hint="PNG — send via Messages"
                        onClick={() =>
                            void run('Exporting…', (source) =>
                                exportAnnotatedPageImage(docId, source, focusedPageIndex, title),
                            )
                        }
                    />
                    <MenuItem
                        label={`Export page ${pageLabel} as PDF`}
                        onClick={() =>
                            void run('Exporting…', (source) =>
                                exportAnnotatedPdf(docId, source, title, { pageIndex: focusedPageIndex }),
                            )
                        }
                    />
                    <div className="my-1 border-t border-stone-100" />
                    <MenuItem
                        label="Export whole score as PDF"
                        onClick={() => void run('Exporting…', (source) => exportAnnotatedPdf(docId, source, title))}
                    />
                    {error ? <ErrorText className="px-3 py-2">{error}</ErrorText> : null}
                </div>
            ) : error ? (
                <ErrorText className="absolute right-0 top-full z-30 mt-1 w-64 text-right">{error}</ErrorText>
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
        <span className="text-sm text-ink">{label}</span>
        {hint ? <span className="text-xs text-ink-muted">{hint}</span> : null}
    </button>
);
