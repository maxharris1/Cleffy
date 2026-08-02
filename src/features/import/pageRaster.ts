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

// ---------------------------------------------------------------------------
// JPEG encoding for the AI classification call (budgets mirror the edge fn).

/** Longest side of the context page image sent to the model (≈1.6K image tokens). */
export const AI_PAGE_MAX_SIDE = 1568;
export const AI_CROP_MAX_SIDE = 200;
/** Context margin around a cluster crop. */
export const AI_CROP_MARGIN_PX = 6;
export const AI_JPEG_QUALITY = 0.8;

export interface EncodedImage {
    mediaType: 'image/jpeg';
    dataBase64: string;
}

const base64FromBytes = (bytes: Uint8Array): string => {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
};

const encodeRegionJpeg = async (
    raster: DetectionRaster,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    maxSide: number,
): Promise<EncodedImage> => {
    const source = document.createElement('canvas');
    source.width = sw;
    source.height = sh;
    const sctx = source.getContext('2d');
    if (!sctx) {
        throw new Error('Could not create a canvas to encode the page.');
    }
    // ImageData constructor wants a concrete ArrayBuffer-backed view.
    const region = sctx.createImageData(sw, sh);
    for (let y = 0; y < sh; y++) {
        const src = ((sy + y) * raster.width + sx) * 4;
        region.data.set(raster.data.subarray(src, src + sw * 4), y * sw * 4);
    }
    sctx.putImageData(region, 0, 0);

    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const outW = Math.max(1, Math.round(sw * scale));
    const outH = Math.max(1, Math.round(sh * scale));
    const target = document.createElement('canvas');
    target.width = outW;
    target.height = outH;
    const tctx = target.getContext('2d');
    if (!tctx) {
        throw new Error('Could not create a canvas to encode the page.');
    }
    tctx.fillStyle = '#ffffff';
    tctx.fillRect(0, 0, outW, outH);
    tctx.drawImage(source, 0, 0, outW, outH);
    source.width = 0;
    source.height = 0;

    const blob = await new Promise<Blob | null>((resolve) => target.toBlob(resolve, 'image/jpeg', AI_JPEG_QUALITY));
    target.width = 0;
    target.height = 0;
    if (!blob) {
        throw new Error('JPEG encoding failed.');
    }
    return { mediaType: 'image/jpeg', dataBase64: base64FromBytes(new Uint8Array(await blob.arrayBuffer())) };
};

/** Whole page, downscaled for model context. */
export const encodePageJpeg = (raster: DetectionRaster): Promise<EncodedImage> =>
    encodeRegionJpeg(raster, 0, 0, raster.width, raster.height, AI_PAGE_MAX_SIDE);

/** One cluster crop with a small context margin. */
export const encodeCropJpeg = (
    raster: DetectionRaster,
    bboxPx: { x: number; y: number; w: number; h: number },
): Promise<EncodedImage> => {
    const sx = Math.max(0, bboxPx.x - AI_CROP_MARGIN_PX);
    const sy = Math.max(0, bboxPx.y - AI_CROP_MARGIN_PX);
    const ex = Math.min(raster.width, bboxPx.x + bboxPx.w + AI_CROP_MARGIN_PX);
    const ey = Math.min(raster.height, bboxPx.y + bboxPx.h + AI_CROP_MARGIN_PX);
    return encodeRegionJpeg(raster, sx, sy, Math.max(1, ex - sx), Math.max(1, ey - sy), AI_CROP_MAX_SIDE);
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
