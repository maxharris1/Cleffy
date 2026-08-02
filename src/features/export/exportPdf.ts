import type { ExportRequest, ExportResponse } from '@/features/export/exportWorker';
import { safeFileBase, shareOrDownloadFile } from '@/features/export/shareFile';
import { getDb } from '@/sync/db';
import type { Annotation } from '@/types/models';

export interface ExportAnnotatedPdfOptions {
    /** When set, export only this 0-based page (single-page annotated PDF). */
    pageIndex?: number;
}

/**
 * Export the score with annotations baked in (plan §export). Runs pdf-lib in
 * a worker; offers the share sheet on capable devices (AirDrop/Files on iPad),
 * else a plain download.
 */
export const exportAnnotatedPdf = async (
    docId: string,
    sourceBytes: ArrayBuffer,
    title: string,
    options: ExportAnnotatedPdfOptions = {},
): Promise<void> => {
    const rows = await getDb().annotations.where('docId').equals(docId).toArray();
    let annotations: Annotation[] = rows.filter((row) => !row.deletedAt).map(({ pending: _pending, ...a }) => a);
    if (options.pageIndex !== undefined) {
        annotations = annotations.filter((a) => a.page === options.pageIndex);
    }

    const worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' });
    const outBytes = await new Promise<Uint8Array>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<ExportResponse>) => {
            if (event.data.ok) {
                resolve(event.data.bytes);
            } else {
                reject(new Error(event.data.error));
            }
        };
        worker.onerror = () => reject(new Error('Export failed'));
        const request: ExportRequest = {
            bytes: sourceBytes.slice(0),
            annotations,
            pageIndex: options.pageIndex,
        };
        worker.postMessage(request, [request.bytes]);
    }).finally(() => worker.terminate());

    const blob = new Blob([outBytes as BlobPart], { type: 'application/pdf' });
    const pageSuffix = options.pageIndex !== undefined ? ` p${options.pageIndex + 1}` : ' (annotated)';
    const fileName = `${safeFileBase(title)}${pageSuffix}.pdf`;
    const file = new File([blob], fileName, { type: 'application/pdf' });
    await shareOrDownloadFile(file, fileName);
};
