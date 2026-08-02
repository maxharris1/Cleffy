import { getDocument } from 'pdfjs-dist';
import { useEffect, useState, type ReactNode } from 'react';

import { pdfDocumentOptions } from '@/features/viewer/pdf/pdfDocumentOptions';
import { LOADING_VALUE, PdfContext, type PdfContextValue } from '@/features/viewer/pdf/pdfContext';
import { createPdfWorker } from '@/features/viewer/pdf/pdfWorker';
import type { PageSize } from '@/types/models';

export interface PdfProviderProps {
    /** Raw PDF bytes. The provider copies them — pdf.js transfers (neuters) its input buffer. */
    data: ArrayBuffer;
    children: ReactNode;
}

export const PdfProvider = ({ data, children }: PdfProviderProps) => {
    // Keyed by source buffer: while `source !== data` the derived value is "loading",
    // so no synchronous setState is needed when the input changes.
    const [loaded, setLoaded] = useState<{ source: ArrayBuffer; value: PdfContextValue } | null>(null);

    useEffect(() => {
        let cancelled = false;
        const worker = createPdfWorker();

        // Copy: getDocument transfers the underlying buffer to the worker, and the
        // caller still owns `data` (export, offline cache).
        const loadingTask = getDocument({ data: data.slice(0), worker, ...pdfDocumentOptions });

        (async () => {
            try {
                const doc = await loadingTask.promise;
                const sizes: PageSize[] = [];
                for (let i = 1; i <= doc.numPages; i++) {
                    const page = await doc.getPage(i);
                    // Viewport at scale 1 applies the page's inherent /Rotate — this is
                    // the coordinate space all annotations are normalized against.
                    const viewport = page.getViewport({ scale: 1 });
                    sizes.push({ width: viewport.width, height: viewport.height });
                }
                if (!cancelled) {
                    setLoaded({ source: data, value: { doc, pageSizes: sizes, status: 'ready', error: null } });
                }
            } catch (err) {
                if (!cancelled) {
                    const message = err instanceof Error ? err.message : 'Failed to load PDF';
                    setLoaded({
                        source: data,
                        value: { doc: null, pageSizes: [], status: 'error', error: message },
                    });
                }
            }
        })();

        return () => {
            cancelled = true;
            void loadingTask
                .destroy()
                .catch(() => undefined)
                .finally(() => worker.destroy());
        };
    }, [data]);

    const value = loaded && loaded.source === data ? loaded.value : LOADING_VALUE;

    return <PdfContext.Provider value={value}>{children}</PdfContext.Provider>;
};
