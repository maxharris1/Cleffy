import { openDetectionDoc, PRESCAN_MAX_SIDE } from '@/features/import/pageRaster';
import { segmentPage } from '@/features/import/segmentation';

/** How many sample pages the free prescan looks at, spread across the score. */
export const PRESCAN_SAMPLES = 6;
/** Minimum surviving clusters on one page to call the document "annotated". */
export const PRESCAN_MIN_CLUSTERS = 4;

/**
 * Evenly spread sample indices, always including the first and last page —
 * a 30-page score annotated only in its middle movement must still trigger
 * the offer, so sampling can't stop at the front matter.
 */
export const prescanSampleIndices = (numPages: number): number[] => {
    const count = Math.min(numPages, PRESCAN_SAMPLES);
    if (count <= 0) {
        return [];
    }
    if (count === 1) {
        return [0];
    }
    const indices = new Set<number>();
    for (let i = 0; i < count; i++) {
        indices.add(Math.round((i * (numPages - 1)) / (count - 1)));
    }
    return [...indices].sort((a, b) => a - b);
};

/**
 * Fast, free, offline check: does this score look like it already carries
 * colored handwritten annotations? Used right after upload to decide whether
 * to offer the full import flow (which is where the AI cost lives).
 * Best-effort — any failure just means "no".
 */
export const prescanDocument = async (bytes: ArrayBuffer): Promise<boolean> => {
    try {
        const doc = await openDetectionDoc(bytes);
        try {
            for (const i of prescanSampleIndices(doc.numPages)) {
                const raster = await doc.renderPage(i, PRESCAN_MAX_SIDE);
                const { clusters, flags } = segmentPage(raster, i);
                if (!flags.tooColorful && clusters.length >= PRESCAN_MIN_CLUSTERS) {
                    return true;
                }
            }
            return false;
        } finally {
            await doc.destroy();
        }
    } catch {
        return false;
    }
};
