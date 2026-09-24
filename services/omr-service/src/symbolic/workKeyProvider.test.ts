import { describe, expect, it } from 'vitest';

import type { WorkKey } from './types.js';
import {
    pdfTextWorkKeyProvider,
    pickWorkKey,
    WORK_KEY_SOURCE_RANK,
    workKeyFromMetadata,
    type WorkKeyHit,
} from './workKeyProvider.js';

const BWV772: WorkKey = { composerId: 'bach', catalogType: 'BWV', catalogN: 772 };
const CHOPIN: WorkKey = { composerId: 'chopin', catalogType: 'Op', catalogN: 28, movementIndex: 4 };

describe('workKeyFromMetadata', () => {
    it('ranks IMSLP title over PDF text over filename', () => {
        const imslp = workKeyFromMetadata({
            imslpTitle: 'Inventions, BWV 772 (Bach, Johann Sebastian)',
            pdfText: 'Chopin Op. 28 No. 4',
            filename: 'chopin-op28-04.pdf',
        });
        expect(imslp?.source).toBe('imslp');
        expect(imslp?.workKey).toEqual(BWV772);

        const pdf = workKeyFromMetadata({ pdfText: 'Chopin Op. 28 No. 4', filename: 'bwv772.pdf' });
        expect(pdf?.source).toBe('pdf_text');
        expect(pdf?.workKey).toEqual(CHOPIN);

        const file = workKeyFromMetadata({ filename: 'bwv772-invention.pdf' });
        expect(file?.source).toBe('filename');
        expect(file?.workKey).toEqual(BWV772);
        expect(file?.confidence).toBe(0.4);
    });
});

describe('pdfTextWorkKeyProvider', () => {
    it('prefers an IMSLP page title over the PDF-text key', async () => {
        const hits = await pdfTextWorkKeyProvider.identify({
            pdfBytes: Buffer.from('%PDF'),
            imslpTitle: 'Inventions, BWV 772 (Bach, Johann Sebastian)',
            pdfTextWorkKey: CHOPIN,
        });
        expect(hits[0]?.source).toBe('imslp');
        expect(hits[0]?.workKey).toEqual(BWV772);
        expect(WORK_KEY_SOURCE_RANK[hits[0]!.source]).toBeLessThan(WORK_KEY_SOURCE_RANK[hits[1]!.source]);
        expect(pickWorkKey(hits, { composerId: 'unknown', catalogType: 'Op', catalogN: 0 })).toEqual(BWV772);
    });

    it('uses a supplied PDF-text workKey without reopening the PDF', async () => {
        const hits = await pdfTextWorkKeyProvider.identify({
            pdfBytes: Buffer.from('%PDF'),
            pdfTextWorkKey: BWV772,
        });
        expect(hits).toEqual([{ workKey: BWV772, confidence: 1, source: 'pdf_text' }]);
    });

    it('falls back to filename when PDF text is unknown', async () => {
        const hits = await pdfTextWorkKeyProvider.identify({
            pdfBytes: Buffer.from('%PDF'),
            pdfTextWorkKey: { composerId: 'unknown', catalogType: 'Op', catalogN: 0 },
            filename: 'bach-invention-bwv772.pdf',
        });
        expect(hits[0]?.source).toBe('filename');
        expect(hits[0]?.workKey).toEqual(BWV772);
    });

    it('returns no hits when every rank-1–3 source is empty', async () => {
        const hits = await pdfTextWorkKeyProvider.identify({
            pdfBytes: Buffer.from('%PDF'),
            pdfTextWorkKey: { composerId: 'unknown', catalogType: 'Op', catalogN: 0 },
        });
        expect(hits).toEqual([]);
        expect(pickWorkKey(hits, { composerId: 'unknown', catalogType: 'Op', catalogN: 0 }).composerId).toBe(
            'unknown',
        );
    });

    it('picks IMSLP over a higher-confidence vision hit (vision never outranks 1–3)', () => {
        const vision: WorkKeyHit = {
            workKey: CHOPIN,
            source: 'vision',
            confidence: 0.99,
            model: 'gemini-3.1-flash-lite',
        };
        const imslp: WorkKeyHit = { workKey: BWV772, source: 'imslp', confidence: 0.5 };
        expect(pickWorkKey([vision, imslp], CHOPIN)).toEqual(BWV772);
        expect(WORK_KEY_SOURCE_RANK.vision).toBe(4);
    });
});
