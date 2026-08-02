import type { PDFPageProxy } from 'pdfjs-dist';

import type { DetectionRaster } from '@/features/import/importTypes';

/** Longest raster side for the full detection pass (matches export quality). */
export const DETECT_MAX_SIDE = 2048;
/** Cheaper raster for the post-upload prescan. */
export const PRESCAN_MAX_SIDE = 1024;

export interface DetectionDoc {
    numPages: number;
    /**
     * Render one page (0-based) to RGBA pixels at `maxSide` longest side.
     * The raster is in the ROTATED viewport space — raster px ÷ dims are the
     * app's normalized annotation coordinates. PDF annotation appearances
     * (FreeText/Ink…) are NOT rendered — the born-digital pass extracts those
     * as vectors, and rendering them too would double-detect them as ink.
     */
    renderPage: (pageIndex: number, maxSide?: number) => Promise<DetectionRaster>;
    /** Raw pdf.js page proxy (born-digital annotation extraction). */
    getPageProxy: (pageIndex: number) => Promise<PDFPageProxy>;
    destroy: () => Promise<void>;
}

/**
 * Open a PDF once for a multi-page detection pass with a throwaway pdf.js
 * worker (dynamic imports keep pdf.js out of the shell bundle; wasmUrl keeps
 * JBIG2 scans from rendering blank — exportPageImage.ts precedent). Pages
 * render strictly sequentially into ONE reused canvas that is zeroed between
 * pages (iOS canvas-memory discipline, PageView.tsx precedent).
 */
export const openDetectionDoc = async (bytes: ArrayBuffer): Promise<DetectionDoc> => {
    const [{ getDocument }, { createPdfWorker }, { pdfDocumentOptions }] = await Promise.all([
        import('pdfjs-dist'),
        import('@/features/viewer/pdf/pdfWorker'),
        import('@/features/viewer/pdf/pdfDocumentOptions'),
    ]);
    const worker = createPdfWorker();
    const task = getDocument({ data: bytes.slice(0), worker, ...pdfDocumentOptions });
    let canvas: HTMLCanvasElement | null = null;
    try {
        const pdf = await task.promise;
        return {
            numPages: pdf.numPages,
            renderPage: async (pageIndex, maxSide = DETECT_MAX_SIDE) => {
                const page = await pdf.getPage(pageIndex + 1);
                const base = page.getViewport({ scale: 1 });
                const scale = Math.min(maxSide / Math.max(base.width, base.height), 3);
                const viewport = page.getViewport({ scale });
                canvas ??= document.createElement('canvas');
                canvas.width = Math.floor(viewport.width);
                canvas.height = Math.floor(viewport.height);
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (!ctx) {
                    throw new Error('Could not create a canvas to scan the page.');
                }
                await page.render({
                    canvasContext: ctx,
                    viewport,
                    canvas,
                    background: 'rgba(255,255,255,1)',
                    annotationMode: 0, // AnnotationMode.DISABLE
                }).promise;
                const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
                // Free the page's decoded resources before the next page renders.
                canvas.width = 0;
                canvas.height = 0;
                page.cleanup();
                return { data: image.data, width: image.width, height: image.height };
            },
            getPageProxy: (pageIndex) => pdf.getPage(pageIndex + 1),
            destroy: async () => {
                if (canvas) {
                    canvas.width = 0;
                    canvas.height = 0;
                    canvas = null;
                }
                await task.destroy().catch(() => undefined);
                worker.destroy();
            },
        };
    } catch (err) {
        await task.destroy().catch(() => undefined);
        worker.destroy();
        throw err;
    }
};

/**
 * Fraction of raster pixels that are near-white. A "blank" page from a JBIG2
 * scan that failed to decode reads ≥ 99.5% white — callers should say
 * "couldn't read this page" instead of "no annotations found".
 */
export const whiteFraction = (raster: DetectionRaster): number => {
    const { data } = raster;
    const total = raster.width * raster.height;
    if (total === 0) {
        return 1;
    }
    let white = 0;
    for (let p = 0; p < data.length; p += 4) {
        if ((data[p] ?? 0) > 247 && (data[p + 1] ?? 0) > 247 && (data[p + 2] ?? 0) > 247) {
            white++;
        }
    }
    return white / total;
};
