import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { flatten } from '@/features/export/exportWorker';
import { MUSIC_FONT_URL } from '@/features/viewer/ink/musicFont';
import type { Annotation } from '@/types/models';

/** The very file the app serves, so the test proves the shipped asset embeds. */
const musicFontBytes = (): ArrayBuffer => {
    const buffer = readFileSync(resolve(process.cwd(), 'public', MUSIC_FONT_URL.replace(/^\//, '')));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
};

/** /BaseFont names of every font dictionary in the saved PDF. */
const fontNames = async (bytes: Uint8Array): Promise<string[]> => {
    const doc = await PDFDocument.load(bytes);
    const names: string[] = [];
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
        if (object instanceof PDFDict && object.get(PDFName.of('Type')) === PDFName.of('Font')) {
            const base = object.get(PDFName.of('BaseFont'));
            if (base instanceof PDFName) {
                names.push(base.decodeText());
            }
        }
    }
    return names;
};

const blankPdf = async (): Promise<ArrayBuffer> => {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    const bytes = await doc.save();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const text = (id: string, value: string, hw?: 1): Annotation => ({
    id,
    docId: 'doc',
    page: 0,
    kind: 'text',
    color: '#dc2626',
    payload: { x: 0.2, y: 0.3, text: value, size: 0.02, ...(hw ? { hw } : {}) },
    createdBy: null,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    deletedAt: null,
    seq: 0,
});

const bravura = (names: string[]) => names.filter((n) => n.includes('BravuraText'));

describe('PDF export of converted handwriting', () => {
    it('embeds the Bravura Text face for a converted mf so the export matches the screen', async () => {
        const out = await flatten({
            bytes: await blankPdf(),
            annotations: [text('mf', 'mf', 1)],
            musicFont: musicFontBytes(),
        });
        const names = await fontNames(out);
        // Composite font: the Type0 wrapper plus its CIDFont descendant.
        expect(bravura(names).length).toBeGreaterThanOrEqual(1);
        // Subset, not the whole 450 KB face.
        expect(out.length).toBeLessThan(60_000);
    });

    it('does not embed the music face for typed text, even a typed "mf"', async () => {
        const out = await flatten({
            bytes: await blankPdf(),
            annotations: [text('typed', 'mf'), text('note', 'use wrist', 1)],
            musicFont: musicFontBytes(),
        });
        const names = await fontNames(out);
        expect(bravura(names)).toHaveLength(0);
        expect(names).toContain('Helvetica');
    });

    it('falls back to Helvetica when the font bytes are unavailable (offline export)', async () => {
        const out = await flatten({
            bytes: await blankPdf(),
            annotations: [text('mf', 'mf', 1)],
        });
        const names = await fontNames(out);
        expect(bravura(names)).toHaveLength(0);
        expect(names).toContain('Helvetica');
    });

    it('sets converted teaching words in the oblique face', async () => {
        const out = await flatten({
            bytes: await blankPdf(),
            annotations: [text('cresc', 'cresc.', 1)],
        });
        expect(await fontNames(out)).toContain('Helvetica-Oblique');
    });
});
