import { buildWhiteoutPatch, type WhiteoutPatch } from '@/features/import/whiteout';
import type { ImportProposal, ProposedItem } from '@/features/import/importTypes';
import type { RebuildPatchMsg, RebuildRequest, RebuildResponse, StripAnnotMsg } from '@/features/import/rebuildWorker';

/** Bucket cap (SETUP_SUPABASE.md) — a rebuild may never exceed it. */
export const REBUILD_MAX_BYTES = 50 * 1024 * 1024;
/**
 * Pathological-rewrite guard: output must stay near the input size, plus a
 * budget for the one legitimate addition — a merged cleanup patch per page
 * (a dense teacher-fingered page compresses to well under this).
 */
export const REBUILD_MAX_GROWTH = (original: number, pagesCleaned: number): number =>
    Math.ceil(original * 1.25) + 2 * 1024 * 1024 + pagesCleaned * 150 * 1024;

/**
 * Composite a page's per-cluster patches into ONE patch (union bbox). A dense
 * page carries hundreds of clusters; embedding each as its own PDF image
 * object costs ~1 KB apiece in overhead and bloats the rebuilt file — one
 * mostly-transparent PNG per page compresses far better. Where dilated
 * patches overlap, the more solid pixel wins (rims are half-alpha).
 */
export const mergePagePatches = (
    patches: WhiteoutPatch[],
    rasterWidth: number,
    rasterHeight: number,
): WhiteoutPatch => {
    const first = patches[0];
    if (patches.length === 1 && first) {
        return first;
    }
    const origins = patches.map((patch) => ({
        x: Math.round(patch.bboxNorm.x * rasterWidth),
        y: Math.round(patch.bboxNorm.y * rasterHeight),
    }));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < patches.length; i++) {
        const patch = patches[i];
        const origin = origins[i];
        if (!patch || !origin) {
            continue;
        }
        minX = Math.min(minX, origin.x);
        minY = Math.min(minY, origin.y);
        maxX = Math.max(maxX, origin.x + patch.width);
        maxY = Math.max(maxY, origin.y + patch.height);
    }
    const width = maxX - minX;
    const height = maxY - minY;
    const rgba = new Uint8ClampedArray(width * height * 4) as Uint8ClampedArray<ArrayBuffer>;
    for (let i = 0; i < patches.length; i++) {
        const patch = patches[i];
        const origin = origins[i];
        if (!patch || !origin) {
            continue;
        }
        const ox = origin.x - minX;
        const oy = origin.y - minY;
        for (let y = 0; y < patch.height; y++) {
            for (let x = 0; x < patch.width; x++) {
                const src = (y * patch.width + x) * 4;
                const alpha = patch.rgba[src + 3] ?? 0;
                if (alpha === 0) {
                    continue;
                }
                const dst = ((oy + y) * width + (ox + x)) * 4;
                if (alpha >= (rgba[dst + 3] ?? 0)) {
                    rgba[dst] = patch.rgba[src] ?? 0;
                    rgba[dst + 1] = patch.rgba[src + 1] ?? 0;
                    rgba[dst + 2] = patch.rgba[src + 2] ?? 0;
                    rgba[dst + 3] = alpha;
                }
            }
        }
    }
    return {
        pageIndex: first?.pageIndex ?? 0,
        bboxNorm: {
            x: minX / rasterWidth,
            y: minY / rasterHeight,
            w: width / rasterWidth,
            h: height / rasterHeight,
        },
        rgba,
        width,
        height,
    };
};

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
        const pagePatches: WhiteoutPatch[] = [];
        for (const cluster of page.segmentation.clusters) {
            if (!acceptedClusterIds.has(cluster.id)) {
                continue;
            }
            pagePatches.push(
                buildWhiteoutPatch(
                    cluster.mask,
                    cluster.bgColorHex ?? '#ffffff',
                    page.pageIndex,
                    page.rasterWidth,
                    page.rasterHeight,
                ),
            );
        }
        if (pagePatches.length > 0) {
            const merged = mergePagePatches(pagePatches, page.rasterWidth, page.rasterHeight);
            patches.push({ page: page.pageIndex, bboxNorm: merged.bboxNorm, png: await patchToPng(merged) });
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

    if (
        outBytes.byteLength > REBUILD_MAX_BYTES ||
        outBytes.byteLength > REBUILD_MAX_GROWTH(sourceBytes.byteLength, patches.length)
    ) {
        throw new Error(
            'The cleaned file came out too large to store, so the page was left as-is. ' +
                'Your imported marks are kept — they just sit over the original ink.',
        );
    }
    return outBytes;
};
