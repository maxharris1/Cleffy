import type { EncodedImage } from '@/features/import/pageRaster';
import { AI_JPEG_QUALITY } from '@/features/import/pageRaster';
import type { StrokeGroup } from '@/features/viewer/ink/handwriting/grouper';
import { buildStrokePath } from '@/features/viewer/ink/strokeRenderer';

/** Raster height of one writing line sent for transcription (px). */
export const INK_RASTER_LINE_PX = 96;
/** Widest raster we will send (px); a longer line is downscaled. */
export const INK_RASTER_MAX_W = 1024;
/** Whitespace around the ink, in line heights. */
const MARGIN = 0.3;

const base64FromBytes = (bytes: Uint8Array): string => {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
};

/**
 * Draw ONLY the group's strokes, black on white, into a small JPEG — the
 * model gets the handwriting and nothing of the score page beneath it. The
 * same perfect-freehand outline as the screen, so the crop looks like what
 * the writer saw.
 */
export const renderGroupJpeg = async (group: StrokeGroup): Promise<EncodedImage> => {
    const boxW = group.box.x1 - group.box.x0;
    const boxH = Math.max(group.box.y1 - group.box.y0, 1e-6);
    const margin = MARGIN * boxH;
    // Pixels per page-width unit so the line lands INK_RASTER_LINE_PX tall.
    let pxPerUnit = INK_RASTER_LINE_PX / boxH;
    const fullW = (boxW + 2 * margin) * pxPerUnit;
    if (fullW > INK_RASTER_MAX_W) {
        pxPerUnit *= INK_RASTER_MAX_W / fullW;
    }
    const width = Math.max(1, Math.round((boxW + 2 * margin) * pxPerUnit));
    const height = Math.max(1, Math.round((boxH + 2 * margin) * pxPerUnit));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('Could not create a canvas to render the ink.');
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    // A "page" of pxPerUnit px per width unit, shifted so the group's box
    // (with margin) sits at the origin. Normalized y × aspect = width units.
    const pageWpx = pxPerUnit;
    const pageHpx = pxPerUnit * group.aspect;
    ctx.translate((margin - group.box.x0) * pxPerUnit, (margin - group.box.y0) * pxPerUnit);
    ctx.fillStyle = '#000000';
    for (const glyph of group.glyphs) {
        for (const stroke of glyph.strokes) {
            ctx.fill(buildStrokePath({ pts: stroke.pts, w: stroke.w }, pageWpx, pageHpx));
        }
    }

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', AI_JPEG_QUALITY));
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) {
        throw new Error('JPEG encoding failed.');
    }
    return { mediaType: 'image/jpeg', dataBase64: base64FromBytes(new Uint8Array(await blob.arrayBuffer())) };
};
