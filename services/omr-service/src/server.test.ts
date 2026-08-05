import { describe, expect, it } from 'vitest';

import { validateJobRequest } from './server.js';

const DOC = '0c7fdd18-7d2d-4d24-b4dc-a17971a2b3a4';
const SUPA = 'https://project.supabase.co';
const SIGNED = `${SUPA}/storage/v1/object/sign/scores/${DOC}/original.pdf?token=abc`;

describe('validateJobRequest', () => {
    it('accepts a well-formed job', () => {
        expect(validateJobRequest({ documentId: DOC, pdfSignedUrl: SIGNED, pageCount: 3 }, SUPA)).toEqual({
            documentId: DOC,
            pdfSignedUrl: SIGNED,
            pageCount: 3,
        });
    });

    it('normalizes a missing page count to null', () => {
        expect(validateJobRequest({ documentId: DOC, pdfSignedUrl: SIGNED }, SUPA)?.pageCount).toBeNull();
    });

    it('rejects malformed ids and URLs', () => {
        expect(validateJobRequest({ documentId: 'nope', pdfSignedUrl: SIGNED }, SUPA)).toBeNull();
        expect(validateJobRequest({ documentId: DOC, pdfSignedUrl: 'not a url' }, SUPA)).toBeNull();
        expect(validateJobRequest({ documentId: DOC, pdfSignedUrl: 'ftp://x/y.pdf' }, SUPA)).toBeNull();
        expect(validateJobRequest(null, SUPA)).toBeNull();
    });

    it('SSRF guard: requires SUPABASE_URL and matching origin + document path', () => {
        expect(
            validateJobRequest({ documentId: DOC, pdfSignedUrl: 'https://evil.example.com/x.pdf' }, SUPA),
        ).toBeNull();
        // Fail closed when SUPABASE_URL is unset.
        expect(
            validateJobRequest({ documentId: DOC, pdfSignedUrl: 'https://example.com/x.pdf' }, undefined),
        ).toBeNull();
        // Prefix-on-string bypass (lookalike host) must fail origin check.
        expect(
            validateJobRequest(
                {
                    documentId: DOC,
                    pdfSignedUrl: `https://project.supabase.co.evil.com/storage/v1/object/sign/scores/${DOC}/original.pdf`,
                },
                SUPA,
            ),
        ).toBeNull();
        // Signed URL for a different document must fail.
        const other = '11111111-1111-1111-1111-111111111111';
        expect(
            validateJobRequest(
                {
                    documentId: DOC,
                    pdfSignedUrl: `${SUPA}/storage/v1/object/sign/scores/${other}/original.pdf?token=abc`,
                },
                SUPA,
            ),
        ).toBeNull();
    });
});
