import { getDocument } from 'pdfjs-dist';

import { createPdfWorker } from '@/features/viewer/pdf/pdfWorker';
import { pdfDocumentOptions } from '@/features/viewer/pdf/pdfDocumentOptions';
import { THUMB_MAX_SIDE } from '@/features/library/thumbnailSize';

export { THUMB_MAX_SIDE };

/**
 * Render page 1 of a PDF as a small PNG for the library list.
 *
 * This module statically imports pdf.js and MUST NOT be statically imported
 * from anything in the shell bundle — thumbnailService reaches it through
 * `await import(...)` so the ~1 MB pdf chunk stays off the library's
 * critical path. Nothing here touches the network or Dexie.
 */
export const renderFirstPagePng = async (
    bytes: ArrayBuffer,
): Promise<{ blob: Blob; width: number; height: number }> => {
    const worker = createPdfWorker();
    // `.slice(0)`: pdf.js transfers (and detaches) the buffer it is handed, so
    // the caller's copy — often the only one, straight out of the byte cache —
    // must not be the one that goes over the wire.
    const task = getDocument({ data: bytes.slice(0), worker, ...pdfDocumentOptions });
    try {
        const pdf = await task.promise;
        const page = await pdf.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(THUMB_MAX_SIDE / Math.max(base.width, base.height), 3);
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Could not create canvas for the thumbnail');
        }

        // Opaque white: scores are line art on transparent backgrounds, which
        // would otherwise read as black once the PNG lands in a dark row.
        await page.render({ canvasContext: ctx, viewport, canvas, background: 'rgba(255,255,255,1)' }).promise;

        const blob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
        });
        const width = canvas.width;
        const height = canvas.height;

        // iOS caps total canvas memory per tab and reclaims lazily; zeroing the
        // dimensions frees the backing store now rather than at GC time.
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();

        return { blob, width, height };
    } finally {
        await task.destroy().catch(() => undefined);
        worker.destroy();
    }
};
