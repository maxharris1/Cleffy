import { describe, expect, it } from 'vitest';

import { SNIFF_HEADER_BYTES, sniffFile, sniffFileKind } from '@/features/import/sniffFile';

const header = (...bytes: (number | string)[]): Uint8Array => {
    const out = new Uint8Array(SNIFF_HEADER_BYTES);
    let i = 0;
    for (const b of bytes) {
        if (typeof b === 'string') {
            for (const ch of b) {
                out[i++] = ch.charCodeAt(0);
            }
        } else {
            out[i++] = b;
        }
    }
    return out;
};

describe('sniffFileKind', () => {
    it('identifies PDFs', () => {
        expect(sniffFileKind(header('%PDF-1.7'))).toBe('pdf');
    });

    it('identifies PNGs', () => {
        expect(sniffFileKind(header(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toBe('png');
    });

    it('identifies JPEGs', () => {
        expect(sniffFileKind(header(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    });

    it('identifies WebP (RIFF container with WEBP tag)', () => {
        expect(sniffFileKind(header('RIFF', 0x00, 0x00, 0x00, 0x00, 'WEBP'))).toBe('webp');
    });

    it('rejects RIFF containers that are not WebP (e.g. WAV)', () => {
        expect(sniffFileKind(header('RIFF', 0x00, 0x00, 0x00, 0x00, 'WAVE'))).toBeNull();
    });

    it('identifies HEIC by ftyp major brand', () => {
        expect(sniffFileKind(header(0x00, 0x00, 0x00, 0x18, 'ftypheic'))).toBe('heic');
        expect(sniffFileKind(header(0x00, 0x00, 0x00, 0x18, 'ftypmif1'))).toBe('heic');
    });

    it('rejects non-still ISO-BMFF brands (e.g. mp4)', () => {
        expect(sniffFileKind(header(0x00, 0x00, 0x00, 0x18, 'ftypisom'))).toBeNull();
    });

    it('rejects unknown content and short buffers', () => {
        expect(sniffFileKind(header('<!DOCTYPE html>'))).toBeNull();
        expect(sniffFileKind(new Uint8Array(2))).toBeNull();
    });
});

describe('sniffFile', () => {
    it('sniffs a Blob by reading only the header', async () => {
        const blob = new Blob(['%PDF-1.4 lots of content after the header']);
        expect(await sniffFile(blob)).toBe('pdf');
    });

    it('returns null for tiny unknown blobs', async () => {
        expect(await sniffFile(new Blob(['hi']))).toBeNull();
    });
});
