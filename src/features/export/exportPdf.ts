import type { ExportRequest, ExportResponse } from '@/features/export/exportWorker';
import { safeFileBase, shareOrDownloadFile, type ShareOutcome } from '@/features/export/shareFile';
import { annotationNeedsMusicFont, MUSIC_FONT_URL } from '@/features/viewer/ink/musicFont';
import { getDb } from '@/sync/db';
import type { Annotation } from '@/types/models';

export interface ExportAnnotatedPdfOptions {
    /** When set, export only this 0-based page (single-page annotated PDF). */
    pageIndex?: number;
}

/**
 * Build the score with annotations baked in (plan §export), as the file the
 * teacher will receive. Runs pdf-lib in a worker. Nothing is shared or saved
 * here: the PDF flows are metered, and the allowance is claimed only once this
 * has produced a file, so an export that fails to build never spends it.
 */
export const buildAnnotatedPdf = async (
    docId: string,
    sourceBytes: ArrayBuffer,
    title: string,
    options: ExportAnnotatedPdfOptions = {},
): Promise<File> => {
    const rows = await getDb().annotations.where('docId').equals(docId).toArray();
    let annotations: Annotation[] = rows.filter((row) => !row.deletedAt).map(({ pending: _pending, ...a }) => a);
    if (options.pageIndex !== undefined) {
        annotations = annotations.filter((a) => a.page === options.pageIndex);
    }
    // Converted dynamics need the music face embedded; fetch it only then
    // (fails soft — the worker paints ASCII `mf` / `sfz` in Helvetica-Oblique).
    let musicFont: ArrayBuffer | undefined;
    if (annotations.some(annotationNeedsMusicFont)) {
        try {
            const response = await fetch(MUSIC_FONT_URL);
            if (response.ok) {
                musicFont = await response.arrayBuffer();
            }
        } catch {
            // Offline without the font cached: export without it.
        }
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
            musicFont,
        };
        worker.postMessage(request, musicFont ? [request.bytes, musicFont] : [request.bytes]);
    }).finally(() => worker.terminate());

    const blob = new Blob([outBytes as BlobPart], { type: 'application/pdf' });
    const pageSuffix = options.pageIndex !== undefined ? ` p${options.pageIndex + 1}` : ' (annotated)';
    const fileName = `${safeFileBase(title)}${pageSuffix}.pdf`;
    return new File([blob], fileName, { type: 'application/pdf' });
};

/**
 * Hand a built PDF over: the share sheet on capable devices (AirDrop/Files on
 * iPad), else a plain download. Says whether it got there, so a dismissed share
 * sheet can be retried without being treated as delivered.
 */
export const deliverPdf = (file: File): Promise<ShareOutcome> => shareOrDownloadFile(file, file.name);
