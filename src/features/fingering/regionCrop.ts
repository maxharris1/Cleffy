import type { PDFDocumentProxy } from 'pdfjs-dist';

import type { NormRect } from '@/features/fingering/model';
import { inflateRect } from '@/features/fingering/selection';
import { drawAnnotation, StrokePathCache } from '@/features/viewer/ink/strokeRenderer';
import type { Annotation } from '@/types/models';

/**
 * Builds the two JPEGs the analyze-notes edge function needs: the selected
 * region (with committed annotations COMPOSITED in, so Claude reads teacher
 * fingering digits in the same call) and the full page for clef/key context.
 * Renders from the viewer's live pdf.js document — no throwaway worker.
 */

export interface EncodedImage {
    mediaType: 'image/jpeg';
    dataBase64: string;
}

export interface RegionImages {
    regionImage: EncodedImage;
    contextImage: EncodedImage;
    /** The normalized page rect the region image actually covers (selection + margin). */
    cropRect: NormRect;
}

/** Full-page render budget (EXPORT_MAX_SIDE precedent). */
const PAGE_RENDER_MAX_SIDE = 2048;
/** Model image budget (matches the import pipeline's AI_PAGE_MAX_SIDE). */
const AI_IMAGE_MAX_SIDE = 1568;
const JPEG_QUALITY = 0.8;
/** Margin around the selection so clipped noteheads/digits stay readable. */
const CROP_MARGIN = 0.03;

export const buildRegionImages = async (
    doc: PDFDocumentProxy,
    pageIndex: number,
    rect: NormRect,
    annotations: readonly Annotation[],
): Promise<RegionImages> => {
    const page = await doc.getPage(pageIndex + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(PAGE_RENDER_MAX_SIDE / Math.max(base.width, base.height), 3);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('Could not create canvas for region crop');
    }

    try {
        await page.render({ canvasContext: ctx, viewport, canvas, background: 'rgba(255,255,255,1)' }).promise;
        const cache = new StrokePathCache();
        for (const annotation of annotations) {
            drawAnnotation(ctx, annotation, canvas.width, canvas.height, cache);
        }

        const cropRect = inflateRect(rect, CROP_MARGIN, CROP_MARGIN);
        const regionImage = await encodeJpegRegion(
            canvas,
            cropRect.x * canvas.width,
            cropRect.y * canvas.height,
            cropRect.w * canvas.width,
            cropRect.h * canvas.height,
        );
        const contextImage = await encodeJpegRegion(canvas, 0, 0, canvas.width, canvas.height);
        return { regionImage, contextImage, cropRect };
    } finally {
        // Free canvas memory promptly (iOS discipline).
        canvas.width = 0;
        canvas.height = 0;
    }
};

const base64FromBytes = (bytes: Uint8Array): string => {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
};

const encodeJpegRegion = async (
    source: HTMLCanvasElement,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
): Promise<EncodedImage> => {
    const outScale = Math.min(1, AI_IMAGE_MAX_SIDE / Math.max(sw, sh));
    const target = document.createElement('canvas');
    target.width = Math.max(1, Math.round(sw * outScale));
    target.height = Math.max(1, Math.round(sh * outScale));
    const ctx = target.getContext('2d');
    if (!ctx) {
        throw new Error('Could not create canvas for JPEG encode');
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, target.width, target.height);
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, target.width, target.height);

    const blob = await new Promise<Blob | null>((resolve) => target.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    target.width = 0;
    target.height = 0;
    if (!blob) {
        throw new Error('JPEG encoding failed.');
    }
    return { mediaType: 'image/jpeg', dataBase64: base64FromBytes(new Uint8Array(await blob.arrayBuffer())) };
};
