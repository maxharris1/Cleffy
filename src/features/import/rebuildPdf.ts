import { buildWhiteoutPatch, type WhiteoutPatch } from '@/features/import/whiteout';
import type { ImportProposal, ProposedItem } from '@/features/import/importTypes';
import type { RebuildPatchMsg, RebuildRequest, RebuildResponse, StripAnnotMsg } from '@/features/import/rebuildWorker';

/** Bucket cap (SETUP_SUPABASE.md) — a rebuild may never exceed it. */
export const REBUILD_MAX_BYTES = 50 * 1024 * 1024;
/** Pathological-rewrite guard: output must stay near the input size. */
export const REBUILD_MAX_GROWTH = (original: number): number => Math.ceil(original * 1.25) + 2 * 1024 * 1024;

/** PNG-encode a patch's RGBA pixels (tiny images; main thread is fine). */
const patchToPng = async (patch: WhiteoutPatch): Promise<Uint8Array> => {
    const canvas = document.createElement('canvas');
    canvas.width = patch.width;
    canvas.height = patch.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('Could not create a canvas for the cleanup patch.');
    }
    ctx.putImageData(new ImageData(patch.rgba, patch.width, patch.height), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) {
        throw new Error('Cleanup patch encoding failed.');
    }
    return new Uint8Array(await blob.arrayBuffer());
};

/**
 * Rebuild the PDF with the ACCEPTED marks lifted off the pages: paper-color
 * patches over accepted raster ink, and accepted born-digital annotations
 * stripped. Unaccepted marks are untouched. Runs pdf-lib in a worker.
 */
export const rebuildCleanedPdf = async (
    sourceBytes: ArrayBuffer,
    proposal: ImportProposal,
    acceptedItems: ProposedItem[],
): Promise<Uint8Array> => {
    const patches: RebuildPatchMsg[] = [];
    const stripAnnots: StripAnnotMsg[] = [];

    for (const page of proposal.pages) {
        const pageItems = acceptedItems.filter((item) => item.pageIndex === page.pageIndex);
        const acceptedClusterIds = new Set(pageItems.flatMap((item) => item.clusterIds));
        for (const cluster of page.segmentation.clusters) {
            if (!acceptedClusterIds.has(cluster.id)) {
                continue;
            }
            const patch = buildWhiteoutPatch(
                cluster.mask,
                cluster.bgColorHex ?? '#ffffff',
                page.pageIndex,
                page.rasterWidth,
                page.rasterHeight,
            );
            patches.push({ page: page.pageIndex, bboxNorm: patch.bboxNorm, png: await patchToPng(patch) });
        }
        for (const item of pageItems) {
            if (item.sourceAnnot) {
                stripAnnots.push({
                    page: page.pageIndex,
                    subtype: item.sourceAnnot.subtype,
                    rect: item.sourceAnnot.rect,
                });
            }
        }
    }

    if (patches.length === 0 && stripAnnots.length === 0) {
        throw new Error('Nothing to clean.');
    }

    const worker = new Worker(new URL('./rebuildWorker.ts', import.meta.url), { type: 'module' });
    const outBytes = await new Promise<Uint8Array>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<RebuildResponse>) => {
            if (event.data.ok) {
                resolve(event.data.bytes);
            } else {
                reject(new Error(event.data.error));
            }
        };
        worker.onerror = () => reject(new Error('Rebuild failed'));
        const request: RebuildRequest = { bytes: sourceBytes.slice(0), patches, stripAnnots };
        worker.postMessage(request, [request.bytes, ...patches.map((p) => p.png.buffer as ArrayBuffer)]);
    }).finally(() => worker.terminate());

    if (outBytes.byteLength > REBUILD_MAX_BYTES || outBytes.byteLength > REBUILD_MAX_GROWTH(sourceBytes.byteLength)) {
        throw new Error(
            'The cleaned file came out too large to store, so the page was left as-is. ' +
                'Your imported marks are kept — they just sit over the original ink.',
        );
    }
    return outBytes;
};
