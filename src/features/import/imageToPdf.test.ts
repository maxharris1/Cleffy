import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { buildSingleImagePdf } from '@/features/import/imageToPdf';

/** Smallest valid transparent PNG (1×1). */
const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const bytesFromBase64 = (b64: string): Uint8Array => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
    }
    return out;
};

describe('buildSingleImagePdf', () => {
    it('produces a one-page PDF sized 1:1 to the image pixels', async () => {
        const pdfBytes = await buildSingleImagePdf(bytesFromBase64(TINY_PNG_B64), 'png');
        const doc = await PDFDocument.load(pdfBytes);
        expect(doc.getPageCount()).toBe(1);
        const page = doc.getPage(0);
        expect(page.getWidth()).toBe(1);
        expect(page.getHeight()).toBe(1);
    });

    it('throws on corrupt image bytes', async () => {
        await expect(buildSingleImagePdf(new Uint8Array([1, 2, 3, 4]), 'png')).rejects.toThrow();
    });
});
