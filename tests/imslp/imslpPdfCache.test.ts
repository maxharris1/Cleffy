import { webcrypto, createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    withImslpPdfCache,
    imslpFileId,
    pdfSha256,
    validateSharedPdf,
    type PdfCacheDeps,
    type SharedPdfEntry,
} from '../../supabase/functions/_shared/imslpPdfCache';
import { buildImslpProvenance } from '../../supabase/functions/_shared/imslpProvenance';

const filename = 'IMSLP51037-PMLP01458-Op.27-2.pdf';
const bytes = new TextEncoder().encode('%PDF-1.4\noriginal score\n%%EOF\n');
const metadata = {
    work_title: 'Sonata (Beethoven, Ludwig van)',
    license_label: 'Public Domain',
    provenance: buildImslpProvenance({
        workTitle: 'Sonata (Beethoven, Ludwig van)',
        filename,
        licenseLabel: 'Public Domain',
        credits: null,
    }),
};

const store = () => {
    const rows = new Map<string, SharedPdfEntry>();
    const claims = new Map<string, string>();
    const objects = new Map<string, Uint8Array>();
    const deps: PdfCacheDeps = {
        read: vi.fn(async (id) => rows.get(id) ?? null),
        claim: vi.fn(async (id, token) => {
            if (claims.has(id)) {
                return false;
            }
            claims.set(id, token);
            return true;
        }),
        release: vi.fn(async (id, token) => {
            if (claims.get(id) === token) {
                claims.delete(id);
            }
        }),
        upload: vi.fn(async (path, pdf) => {
            objects.set(path, pdf);
        }),
        publish: vi.fn(async (entry, token) => {
            if (claims.get(entry.imslp_file_id) !== token) {
                throw new Error('stale claim');
            }
            rows.set(entry.imslp_file_id, entry);
        }),
    };
    const download = vi.fn(async () => bytes);
    const importPdf = () =>
        withImslpPdfCache<SharedPdfEntry | 'queued'>(
            filename,
            deps,
            async (session) => session.entry ?? (await session.store(await download(), metadata)),
            () => 'queued',
        );
    return { rows, claims, objects, deps, download, importPdf };
};

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe('shared IMSLP PDF cache', () => {
    it('keys editions by stable file ID and supports legacy canonical filenames', () => {
        expect(imslpFileId(filename)).toBe('51037');
        expect(imslpFileId('IMSLP051037-different-name.pdf')).toBe('51037');
        expect(imslpFileId('IMSLP51038-another-edition.pdf')).toBe('51038');
        expect(imslpFileId('Legacy score.pdf')).toBe('filename:Legacy score.pdf');
    });

    it('miss: validates, hashes, uploads once, then publishes the mapping and provenance', async () => {
        const h = store();
        const entry = await h.importPdf();
        expect(entry).toMatchObject({ imslp_file_id: '51037', size: bytes.length, ...metadata });
        expect(h.objects.size).toBe(1);
        expect(h.rows.size).toBe(1);
        expect(h.claims.size).toBe(0);
        expect(h.deps.upload).toHaveBeenCalledBefore(vi.mocked(h.deps.publish));
        expect(await pdfSha256(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
        expect((entry as SharedPdfEntry).storage_path).toBe(
            `00000000-0000-0000-0000-000000000000/${await pdfSha256(bytes)}.pdf`,
        );
    });

    it('hit: every caller reuses the same original without downloading, uploading or claiming again', async () => {
        const h = store();
        const first = await h.importPdf();
        expect(await h.importPdf()).toBe(first);
        expect(await h.importPdf()).toBe(first);
        expect(h.download).toHaveBeenCalledTimes(1);
        expect(h.deps.upload).toHaveBeenCalledTimes(1);
        expect(h.deps.claim).toHaveBeenCalledTimes(1);
    });

    it('concurrent misses: only the claimant downloads; losers queue, then reuse its result', async () => {
        const h = store();
        let finish!: (pdf: typeof bytes) => void;
        let started!: () => void;
        const downloading = new Promise<void>((resolve) => {
            started = resolve;
        });
        h.download.mockImplementationOnce(() => {
            started();
            return new Promise((resolve) => {
                finish = resolve;
            });
        });
        const first = h.importPdf();
        await downloading;
        expect(await h.importPdf()).toBe('queued');
        expect(h.download).toHaveBeenCalledTimes(1);
        finish(bytes);
        const ready = await first;
        expect(await h.importPdf()).toBe(ready);
        expect(h.deps.upload).toHaveBeenCalledTimes(1);
    });

    it('rechecks after claim so a racing publisher costs no second download', async () => {
        const h = store();
        const ready = (await h.importPdf()) as SharedPdfEntry;
        h.rows.clear();
        vi.mocked(h.deps.claim).mockImplementationOnce(async () => {
            h.rows.set('51037', ready);
            return true;
        });
        expect(await h.importPdf()).toBe(ready);
        expect(h.download).toHaveBeenCalledTimes(1);
        expect(h.deps.release).toHaveBeenCalledTimes(2);
    });

    it.each(['fetch', 'invalid PDF', 'upload', 'publish', 'read after claim'])(
        '%s failure leaves no ready entry and allows a subsequent retry',
        async (stage) => {
            const h = store();
            if (stage === 'fetch') {
                h.download.mockRejectedValueOnce(new Error('upstream'));
            }
            if (stage === 'invalid PDF') {
                h.download.mockResolvedValueOnce(new TextEncoder().encode('<html>challenge</html>'));
            }
            if (stage === 'upload') {
                vi.mocked(h.deps.upload).mockRejectedValueOnce(new Error('storage'));
            }
            if (stage === 'publish') {
                vi.mocked(h.deps.publish).mockRejectedValueOnce(new Error('database'));
            }
            if (stage === 'read after claim') {
                vi.mocked(h.deps.read).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('read'));
            }
            await expect(h.importPdf()).rejects.toThrow();
            expect(h.rows.size).toBe(0);
            expect(h.claims.size).toBe(0);
            expect(await h.importPdf()).toMatchObject({ imslp_file_id: '51037' });
        },
    );

    it('keeps a published original when an individual library import fails', async () => {
        const h = store();
        await expect(
            withImslpPdfCache(
                filename,
                h.deps,
                async (session) => {
                    await session.store(bytes, metadata);
                    throw new Error('library unavailable');
                },
                () => 'queued',
            ),
        ).rejects.toThrow('library unavailable');
        expect(h.rows.size).toBe(1);
        expect(h.objects.size).toBe(1);
        expect(await h.importPdf()).toMatchObject({ imslp_file_id: '51037' });
        expect(h.download).not.toHaveBeenCalled();
    });

    it.each(['', '%PDFx1.4\n%%EOF', '%PDF-1.4 partial', '<html>%%EOF'])(
        'rejects incomplete/non-PDF bytes: %s',
        (pdf) => {
            expect(() => validateSharedPdf(new TextEncoder().encode(pdf))).toThrow();
        },
    );
    it('rejects oversize PDFs even with valid boundary markers', () => {
        const large = new Uint8Array(50 * 1024 * 1024 + 1);
        large.set(new TextEncoder().encode('%PDF-1.4'));
        large.set(new TextEncoder().encode('%%EOF'), large.length - 5);
        expect(() => validateSharedPdf(large)).toThrow();
    });
});
