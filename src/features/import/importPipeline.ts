import { extractBornDigital } from '@/features/import/bornDigital';
import { openDetectionDoc, whiteFraction } from '@/features/import/pageRaster';
import { buildProposals } from '@/features/import/proposals';
import { segmentPage } from '@/features/import/segmentation';
import { sampleBackgroundColor } from '@/features/import/whiteout';
import type { ClassifyFn, ImportProposal, ImportStatus, PageProposal } from '@/features/import/importTypes';

/**
 * Whole-document scan: raster → segment → (optionally) classify → convert,
 * page by page, strictly sequentially (one raster in memory at a time).
 * Returns everything the review UI and the cleanup pass need; page rasters
 * are dropped as soon as each page is done.
 */
export const scanDocument = async (opts: {
    docId: string;
    bytes: ArrayBuffer;
    /** Null → strokes-only mode (no AI). */
    classify: ClassifyFn | null;
    /** Convert real PDF annotation objects too (off for local docs — no cleanup possible). */
    includeBornDigital: boolean;
    onStatus?: (status: ImportStatus) => void;
    signal?: AbortSignal;
}): Promise<ImportProposal> => {
    const { docId, bytes, classify, includeBornDigital, onStatus, signal } = opts;
    const doc = await openDetectionDoc(bytes);
    try {
        const pages: PageProposal[] = [];
        const unreadablePages: number[] = [];
        const tooColorfulPages: number[] = [];
        let aiDegraded = false;

        for (let i = 0; i < doc.numPages; i++) {
            if (signal?.aborted) {
                throw new DOMException('Scan cancelled', 'AbortError');
            }
            onStatus?.({ kind: 'scanning', page: i, pageCount: doc.numPages });
            const raster = await doc.renderPage(i);
            const seg = segmentPage(raster, i);
            if (seg.flags.tooColorful) {
                tooColorfulPages.push(i);
            }

            const born = includeBornDigital
                ? await extractBornDigital(await doc.getPageProxy(i), i, docId)
                : { items: [], stripSubtypes: [] };

            let labels = null;
            if (seg.clusters.length > 0) {
                if (classify) {
                    onStatus?.({ kind: 'classifying', page: i, pageCount: doc.numPages });
                    labels = await classify(seg, raster, signal);
                }
                if (!labels) {
                    aiDegraded = true;
                }
                // Sample local paper colors for cleanup patches while the raster exists.
                for (const cluster of seg.clusters) {
                    cluster.bgColorHex = sampleBackgroundColor(raster, cluster.mask);
                }
            }

            const items = [...born.items, ...buildProposals(docId, seg, labels)];
            if (items.length === 0 && seg.clusters.length === 0 && whiteFraction(raster) >= 0.995) {
                unreadablePages.push(i);
            }
            if (items.length > 0) {
                pages.push({
                    pageIndex: i,
                    rasterWidth: seg.width,
                    rasterHeight: seg.height,
                    items,
                    segmentation: seg,
                    stripSubtypes: born.stripSubtypes,
                });
            }
        }

        return { docId, pages, aiDegraded: pages.length > 0 && aiDegraded, unreadablePages, tooColorfulPages };
    } finally {
        await doc.destroy();
    }
};
