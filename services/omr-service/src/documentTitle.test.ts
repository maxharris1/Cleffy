import { beforeEach, describe, expect, it, vi } from 'vitest';

import { imslpTitleOf, titleForDocument } from './documentTitle.js';

const maybeSingle = vi.fn();

vi.mock('./supabaseClient.js', () => ({
    serviceClient: () => ({
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => maybeSingle() }) }) }),
    }),
}));

beforeEach(() => {
    maybeSingle.mockReset();
});

describe('imslpTitleOf', () => {
    it('keeps an IMSLP work-page title', () => {
        expect(imslpTitleOf('Nocturnes, Op.9 (Chopin, Frédéric)')).toBe('Nocturnes, Op.9 (Chopin, Frédéric)');
        expect(imslpTitleOf('  Gymnopédies (Satie)  ')).toBe('Gymnopédies (Satie)');
    });

    it('drops an upload file name, a blank, or nothing', () => {
        expect(imslpTitleOf('scan')).toBeNull();
        expect(imslpTitleOf('My Recital Piece')).toBeNull();
        expect(imslpTitleOf('Sonata (in C major) for piano')).toBeNull();
        expect(imslpTitleOf('')).toBeNull();
        expect(imslpTitleOf(null)).toBeNull();
        expect(imslpTitleOf(undefined)).toBeNull();
    });
});

describe('titleForDocument', () => {
    it('returns the document title when it is an IMSLP work title', async () => {
        maybeSingle.mockResolvedValue({ data: { title: 'Inventions (Bach, Johann Sebastian)' }, error: null });
        expect(await titleForDocument('doc')).toBe('Inventions (Bach, Johann Sebastian)');
    });

    it('is null for an upload title, a missing row, or an error', async () => {
        maybeSingle.mockResolvedValueOnce({ data: { title: 'scan' }, error: null });
        expect(await titleForDocument('doc')).toBeNull();
        maybeSingle.mockResolvedValueOnce({ data: null, error: null });
        expect(await titleForDocument('doc')).toBeNull();
        maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
        expect(await titleForDocument('doc')).toBeNull();
        maybeSingle.mockRejectedValueOnce(new Error('network'));
        expect(await titleForDocument('doc')).toBeNull();
    });
});
