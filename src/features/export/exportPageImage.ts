import { getDocument } from 'pdfjs-dist';

import { safeFileBase, shareOrDownloadFile } from '@/features/export/shareFile';
import { drawAnnotation, StrokePathCache } from '@/features/viewer/ink/strokeRenderer';
import { createPdfWorker } from '@/features/viewer/pdf/pdfWorker';
import { pdfDocumentOptions } from '@/features/viewer/pdf/pdfDocumentOptions';
import { getDb } from '@/sync/db';
import type { Annotation } from '@/types/models';

/** Target longest side for exported page photos (CSS/device-independent). */
const EXPORT_MAX_SIDE = 2048;

/**
 * Render one PDF page with committed annotations baked in as a PNG,
 * then share (Messages/AirDrop/…) or download.
 */
export const exportAnnotatedPageImage = async (
    docId: string,
    sourceBytes: ArrayBuffer,
    pageIndex: number,
    title: string,
): Promise<void> => {
    const file = await buildAnnotatedPagePng(docId, sourceBytes, pageIndex, title);
    await shareOrDownloadFile(file, file.name);
};

export const buildAnnotatedPagePng = async (
    docId: string,
    sourceBytes: ArrayBuffer,
    pageIndex: number,
    title: string,
): Promise<File> => {
    const rows = await getDb().annotations.where('docId').equals(docId).toArray();
    const annotations: Annotation[] = rows
        .filter((row) => !row.deletedAt && row.page === pageIndex)
        .map(({ pending: _pending, ...a }) => a);

    const worker = createPdfWorker();
    const loadingTask = getDocument({ data: sourceBytes.slice(0), worker, ...pdfDocumentOptions });
    try {
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(pageIndex + 1);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(EXPORT_MAX_SIDE / Math.max(base.width, base.height), 3);
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Could not create canvas for page export');
        }

        await page.render({ canvasContext: ctx, viewport, canvas, background: 'rgba(255,255,255,1)' }).promise;

        const cache = new StrokePathCache();
        for (const annotation of annotations) {
            drawAnnotation(ctx, annotation, canvas.width, canvas.height, cache);
        }

        const blob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
        });

        const fileName = `${safeFileBase(title)} p${pageIndex + 1}.png`;
        return new File([blob], fileName, { type: 'image/png' });
    } finally {
        await loadingTask.destroy().catch(() => undefined);
        worker.destroy();
    }
};
