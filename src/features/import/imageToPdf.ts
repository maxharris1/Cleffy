import type { SniffedFileKind } from '@/features/import/sniffFile';

/** Re-encode quality for formats pdf-lib can't embed directly (WebP/HEIC) and for EXIF-baking JPEGs. */
const JPEG_REENCODE_QUALITY = 0.92;

/**
 * Wrap one raster image as a single-page PDF (1 source pixel = 1 PDF point)
 * so everything downstream of upload stays PDF-only.
 *
 * - PNG: embedded byte-for-byte (lossless, no orientation concerns).
 * - JPEG: decoded via createImageBitmap (which applies EXIF orientation) and
 *   re-encoded — embedding raw camera bytes would render sideways in PDF.
 * - WebP/HEIC: decoded (where the browser can) and re-encoded as JPEG.
 */
export const imageFileToPdf = async (file: Blob, kind: Exclude<SniffedFileKind, 'pdf'>): Promise<Uint8Array> => {
    if (kind === 'png') {
        return buildSingleImagePdf(new Uint8Array(await file.arrayBuffer()), 'png');
    }
    const bitmap = await decodeImage(file);
    try {
        const jpeg = await bitmapToJpeg(bitmap);
        return await buildSingleImagePdf(new Uint8Array(await jpeg.arrayBuffer()), 'jpeg');
    } finally {
        bitmap.close();
    }
};

const decodeImage = async (file: Blob): Promise<ImageBitmap> => {
    if (typeof createImageBitmap !== 'function') {
        throw new Error('This browser cannot convert images — please upload a PDF instead.');
    }
    try {
        return await createImageBitmap(file);
    } catch {
        throw new Error(
            'Could not read this image — the format may not be supported by your browser ' +
                '(HEIC photos outside Safari, for example). Convert it to JPEG or PNG and try again.',
        );
    }
};

const bitmapToJpeg = async (bitmap: ImageBitmap): Promise<Blob> => {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('Could not create a canvas to convert the image.');
    }
    // JPEG has no alpha — transparent screenshot regions must become paper, not black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', JPEG_REENCODE_QUALITY),
    );
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) {
        throw new Error('Image conversion failed.');
    }
    return blob;
};

/**
 * Pure pdf-lib step (unit-testable): PNG or JPEG bytes → a one-page PDF sized
 * to the image. pdf-lib is dynamically imported so the library bundle only
 * pays for it when an image is actually converted.
 */
export const buildSingleImagePdf = async (bytes: Uint8Array, format: 'png' | 'jpeg'): Promise<Uint8Array> => {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    // Pin the metadata pdf-lib would otherwise stamp with the current time:
    // local doc ids are content hashes, so converting the same image twice
    // must yield byte-identical PDFs or re-opening it would mint a new id.
    doc.setCreationDate(new Date(0));
    doc.setModificationDate(new Date(0));
    doc.setProducer('cleffy');
    doc.setCreator('cleffy');
    const image = format === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const page = doc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    return doc.save();
};
