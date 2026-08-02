/// <reference lib="webworker" />
import { whiteFraction } from '@/features/import/pageRaster';
import { segmentPage } from '@/features/import/segmentation';
import { vectorizeMask } from '@/features/import/vectorize';
import { sampleBackgroundColor } from '@/features/import/whiteout';
import type { DetectionRaster, PageSegmentation } from '@/features/import/importTypes';
import type { StrokePayload } from '@/types/models';

/**
 * Off-main-thread detection: segmentation, background sampling, and stroke
 * vectorization are pure array math over the page raster — moving them here
 * lets the pipeline render page N+1 (pdf.js, main thread) while page N is
 * being crunched, and keeps the UI fluid during long scans. pdf.js itself
 * never loads in this worker (pageRaster only imports it dynamically).
 */

export interface DetectRequest {
    pageIndex: number;
    width: number;
    height: number;
    /** RGBA pixels, transferred. */
    rgba: ArrayBuffer;
}

export type DetectResponse =
    | {
          ok: true;
          segmentation: PageSegmentation;
          /** clusterId → ready-to-use stroke payloads (strokes-only fallback + 'mark' labels). */
          vectors: [string, StrokePayload[]][];
          whiteFrac: number;
      }
    | { ok: false; error: string };

self.onmessage = (event: MessageEvent<DetectRequest>) => {
    try {
        const { pageIndex, width, height, rgba } = event.data;
        const raster: DetectionRaster = { data: new Uint8ClampedArray(rgba), width, height };
        const segmentation = segmentPage(raster, pageIndex);
        const vectors: [string, StrokePayload[]][] = [];
        for (const cluster of segmentation.clusters) {
            cluster.bgColorHex = sampleBackgroundColor(raster, cluster.mask);
            vectors.push([
                cluster.id,
                vectorizeMask(cluster.mask, cluster.area, cluster.thicknessPx, width, height),
            ]);
        }
        const response: DetectResponse = {
            ok: true,
            segmentation,
            vectors,
            whiteFrac: whiteFraction(raster),
        };
        self.postMessage(response);
    } catch (err) {
        const response: DetectResponse = { ok: false, error: err instanceof Error ? err.message : String(err) };
        self.postMessage(response);
    }
};
