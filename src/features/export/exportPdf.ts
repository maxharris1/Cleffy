import type { ExportRequest, ExportResponse } from '@/features/export/exportWorker';
import { getDb } from '@/sync/db';
import type { Annotation } from '@/types/models';

/**
 * Export the score with annotations baked in (plan §export). Runs pdf-lib in
 * a worker; offers the share sheet on capable devices (AirDrop/Files on iPad),
 * else a plain download.
 */
export const exportAnnotatedPdf = async (docId: string, sourceBytes: ArrayBuffer, title: string): Promise<void> => {
    const rows = await getDb().annotations.where('docId').equals(docId).toArray();
    const annotations: Annotation[] = rows.filter((row) => !row.deletedAt).map(({ pending: _pending, ...a }) => a);

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
        const request: ExportRequest = { bytes: sourceBytes.slice(0), annotations };
        worker.postMessage(request, [request.bytes]);
    }).finally(() => worker.terminate());

    const blob = new Blob([outBytes as BlobPart], { type: 'application/pdf' });
    const fileName = `${title.replace(/[/\\:]/g, '-')} (annotated).pdf`;
    const file = new File([blob], fileName, { type: 'application/pdf' });

    if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({ files: [file], title: fileName });
            return;
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                return; // user closed the share sheet
            }
            // Fall through to download on share failures.
        }
    }

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
};
