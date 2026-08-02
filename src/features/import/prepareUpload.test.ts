import { describe, expect, it } from 'vitest';

import { MAX_UPLOAD_BYTES } from '@/features/import/sniffFile';
import { prepareUploadFile } from '@/features/import/prepareUpload';

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

describe('prepareUploadFile', () => {
    it('passes PDFs through untouched', async () => {
        const file = new File(['%PDF-1.7 fake body'], 'Sonata No. 10.pdf', { type: 'application/pdf' });
        const prepared = await prepareUploadFile(file);
        expect(prepared.convertedFromImage).toBe(false);
        expect(prepared.file).toBe(file);
    });

    it('rejects empty files', async () => {
        await expect(prepareUploadFile(new File([], 'empty.pdf'))).rejects.toThrow(/empty/i);
    });

    it('rejects files over the bucket cap without reading them', async () => {
        // A Blob-backed File of 50MB+1 would be slow to allocate; fake the size via a sparse Blob.
        const big = new File([new Uint8Array(8)], 'big.pdf');
        Object.defineProperty(big, 'size', { value: MAX_UPLOAD_BYTES + 1 });
        await expect(prepareUploadFile(big)).rejects.toThrow(/50 MB/);
    });

    it('rejects unsupported content regardless of extension', async () => {
        const html = new File(['<!DOCTYPE html><html></html>'], 'score.pdf', { type: 'application/pdf' });
        await expect(prepareUploadFile(html)).rejects.toThrow(/Unsupported file type/);
    });

    it('wraps a PNG into a single-page PDF named after the image', async () => {
        const png = new File([bytesFromBase64(TINY_PNG_B64) as BlobPart], 'IMG_2041.png', { type: 'image/png' });
        const prepared = await prepareUploadFile(png);
        expect(prepared.convertedFromImage).toBe(true);
        expect(prepared.file.name).toBe('IMG_2041.pdf');
        expect(prepared.file.type).toBe('application/pdf');
        const head = new Uint8Array(await prepared.file.slice(0, 5).arrayBuffer());
        expect(String.fromCharCode(...head)).toBe('%PDF-');
    });
});
