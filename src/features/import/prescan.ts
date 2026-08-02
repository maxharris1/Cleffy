import { openDetectionDoc, PRESCAN_MAX_SIDE } from '@/features/import/pageRaster';
import { segmentPage } from '@/features/import/segmentation';

/** How many leading pages the free prescan looks at. */
export const PRESCAN_PAGES = 4;
/** Minimum surviving clusters on one page to call the document "annotated". */
export const PRESCAN_MIN_CLUSTERS = 4;

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
            const pages = Math.min(doc.numPages, PRESCAN_PAGES);
            for (let i = 0; i < pages; i++) {
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
