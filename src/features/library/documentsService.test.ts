import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '@/sync/db';
import type { CachedPdf } from '@/sync/db';
import type { DocumentRow } from '@/types/database';

vi.mock('@/lib/supabase', () => ({
    getSupabase: vi.fn(),
    isSupabaseConfigured: () => true,
}));
vi.mock('@/lib/storageUpload', () => ({
    uploadPdfToStorage: vi.fn(async () => undefined),
}));

// fake-indexeddb's structured clone strips jsdom Blob methods, so the Dexie
// layer is replaced by an in-memory map that keeps real Blobs readable.
const memCache = vi.hoisted(() => new Map<string, unknown>());
const memThumbs = vi.hoisted(() => new Map<string, unknown>());
// The upload/replace paths kick off a thumbnail render; stubbed so these tests
// never pull pdf.js in.
vi.mock('@/features/library/thumbnailService', () => ({
    getThumbnail: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('@/sync/db', () => {
    const table = (impl: Record<string, unknown>) => impl;
    return {
        getDb: () => ({
            pdfCache: table({
                get: (id: string) => Promise.resolve(memCache.get(id)),
                put: (row: { docId: string }) => {
                    memCache.set(row.docId, row);
                    return Promise.resolve(row.docId);
                },
                delete: (id: string) => {
                    memCache.delete(id);
                    return Promise.resolve();
                },
                clear: () => {
                    memCache.clear();
                    return Promise.resolve();
                },
            }),
            syncState: table({ delete: () => Promise.resolve() }),
            annotations: table({
                where: () => ({ equals: () => ({ delete: () => Promise.resolve(0) }) }),
            }),
            ops: table({ where: () => ({ equals: () => ({ delete: () => Promise.resolve(0) }) }) }),
            annotationSnapshots: table({
                where: () => ({ equals: () => ({ delete: () => Promise.resolve(0) }) }),
            }),
            scoreCache: table({ delete: () => Promise.resolve() }),
            thumbnails: table({
                put: (row: { docId: string }) => {
                    memThumbs.set(row.docId, row);
                    return Promise.resolve(row.docId);
                },
                delete: (id: string) => {
                    memThumbs.delete(id);
                    return Promise.resolve();
                },
            }),
        }),
    };
});

import { deleteDocument, loadDocumentBytes, replaceDocumentPdf } from '@/features/library/documentsService';
import { uploadPdfToStorage } from '@/lib/storageUpload';
import { getSupabase } from '@/lib/supabase';

const putCache = (row: CachedPdf) => getDb().pdfCache.put(row);

const doc = (over: Partial<DocumentRow> = {}): DocumentRow => ({
    id: 'a4ccff59-6f2f-4dc7-a2a8-5c8f2b6f1de1',
    owner_id: 'user-1',
    title: 'Sonata',
    storage_path: 'a4ccff59-6f2f-4dc7-a2a8-5c8f2b6f1de1/original.pdf',
    page_count: 3,
    content_rev: 0,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    archived_at: null,
    ...over,
});

interface StubOptions {
    downloadBytes?: string;
    downloadError?: string;
    backupError?: string | null;
    listNames?: string[];
    updatedRow?: DocumentRow;
}

const makeStub = (options: StubOptions = {}) => {
    const calls = {
        download: vi.fn(),
        upload: vi.fn(),
        remove: vi.fn(),
        list: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
        delete: vi.fn(),
    };
    const storageApi = {
        download: (path: string) => {
            calls.download(path);
            if (options.downloadError) {
                return Promise.resolve({ data: null, error: { message: options.downloadError } });
            }
            return Promise.resolve({
                data: new Blob([options.downloadBytes ?? 'fresh-bytes'], { type: 'application/pdf' }),
                error: null,
            });
        },
        upload: (path: string, _body: unknown, opts: unknown) => {
            calls.upload(path, opts);
            return Promise.resolve({
                data: null,
                error:
                    options.backupError !== undefined && options.backupError !== null
                        ? { message: options.backupError }
                        : null,
            });
        },
        remove: (paths: string[]) => {
            calls.remove(paths);
            return Promise.resolve({ data: null, error: null });
        },
        list: (prefix: string) => {
            calls.list(prefix);
            return Promise.resolve({
                data: (options.listNames ?? []).map((name) => ({ name })),
                error: null,
            });
        },
    };
    const supabase = {
        storage: { from: () => storageApi },
        from: (table: string) => ({
            update: (patch: Record<string, unknown>) => {
                calls.update(table, patch);
                return {
                    eq: () => ({
                        select: () => ({
                            single: () =>
                                Promise.resolve({ data: options.updatedRow ?? doc({ content_rev: 1 }), error: null }),
                        }),
                    }),
                };
            },
            upsert: (row: Record<string, unknown>, opts: unknown) => {
                calls.upsert(table, row, opts);
                return Promise.resolve({ data: null, error: null });
            },
            delete: () => ({
                eq: () => {
                    calls.delete(table);
                    return Promise.resolve({ data: null, error: null });
                },
            }),
        }),
    };
    vi.mocked(getSupabase).mockReturnValue(supabase as never);
    return calls;
};

beforeEach(async () => {
    vi.mocked(uploadPdfToStorage).mockClear();
    await getDb().pdfCache.clear();
});

describe('loadDocumentBytes content_rev staleness', () => {
    it('serves the cache when it matches the row revision (no download)', async () => {
        const calls = makeStub();
        const d = doc({ content_rev: 1 });
        await putCache({
            docId: d.id,
            bytes: new Blob(['cached-bytes']),
            title: d.title,
            cachedAt: '2026-08-01T00:00:00Z',
            contentRev: 1,
        });
        const bytes = await loadDocumentBytes(d);
        expect(new TextDecoder().decode(bytes)).toBe('cached-bytes');
        expect(calls.download).not.toHaveBeenCalled();
    });

    it('re-downloads when the cache is older than the row revision', async () => {
        const calls = makeStub({ downloadBytes: 'cleaned-bytes' });
        const d = doc({ content_rev: 2 });
        await putCache({
            docId: d.id,
            bytes: new Blob(['cached-bytes']),
            title: d.title,
            cachedAt: '2026-08-01T00:00:00Z',
            contentRev: 1,
        });
        const bytes = await loadDocumentBytes(d);
        expect(new TextDecoder().decode(bytes)).toBe('cleaned-bytes');
        expect(calls.download).toHaveBeenCalledTimes(1);
        const cached = await getDb().pdfCache.get(d.id);
        expect(cached?.contentRev).toBe(2);
    });

    it('falls back to a stale cache when offline', async () => {
        makeStub({ downloadError: 'network down' });
        const d = doc({ content_rev: 2 });
        await putCache({
            docId: d.id,
            bytes: new Blob(['cached-bytes']),
            title: d.title,
            cachedAt: '2026-08-01T00:00:00Z',
            contentRev: 1,
        });
        const bytes = await loadDocumentBytes(d);
        expect(new TextDecoder().decode(bytes)).toBe('cached-bytes');
    });
});

describe('replaceDocumentPdf', () => {
    it('backs up the original once, uploads the replacement, bumps content_rev, refreshes the cache', async () => {
        const calls = makeStub({ updatedRow: doc({ content_rev: 1 }) });
        const d = doc();
        const original = new TextEncoder().encode('original').buffer as ArrayBuffer;
        const updated = await replaceDocumentPdf(d, original, new TextEncoder().encode('cleaned'));

        expect(calls.upload).toHaveBeenCalledWith(
            `${d.id}/pre-import-original.pdf`,
            expect.objectContaining({ upsert: false }),
        );
        expect(vi.mocked(uploadPdfToStorage)).toHaveBeenCalledWith(d.storage_path, expect.anything(), undefined);
        expect(calls.update).toHaveBeenCalledWith('documents', { content_rev: 1 });
        expect(updated.content_rev).toBe(1);

        const cached = await getDb().pdfCache.get(d.id);
        expect(cached?.contentRev).toBe(1);
        expect(await cached?.bytes.text()).toBe('cleaned');

        expect(calls.upsert).toHaveBeenCalledWith(
            'document_imports',
            expect.objectContaining({ status: 'imported' }),
            expect.anything(),
        );
    });

    it('tolerates an existing backup (first import wins)', async () => {
        makeStub({ backupError: 'The resource already exists', updatedRow: doc({ content_rev: 2 }) });
        const d = doc({ content_rev: 1 });
        const updated = await replaceDocumentPdf(
            d,
            new TextEncoder().encode('original').buffer as ArrayBuffer,
            new TextEncoder().encode('cleaned2'),
        );
        expect(updated.content_rev).toBe(2);
    });

    it('fails hard when the backup fails for real reasons', async () => {
        makeStub({ backupError: 'permission denied' });
        await expect(replaceDocumentPdf(doc(), new ArrayBuffer(4), new Uint8Array([1, 2, 3]))).rejects.toThrow(
            /backup/,
        );
    });
});

describe('deleteDocument', () => {
    it('removes every object in the folder (import backups included)', async () => {
        const calls = makeStub({ listNames: ['original.pdf', 'pre-import-original.pdf'] });
        const d = doc();
        await deleteDocument(d);
        expect(calls.remove).toHaveBeenCalledWith([`${d.id}/original.pdf`, `${d.id}/pre-import-original.pdf`]);
    });

    it('drops the cached thumbnail along with the other local caches', async () => {
        makeStub();
        const d = doc();
        await getDb().thumbnails.put({
            docId: d.id,
            contentRev: 0,
            maxSide: 512,
            blob: new Blob(['png'], { type: 'image/png' }),
            width: 181,
            height: 256,
            createdAt: '2026-08-01T00:00:00Z',
        });
        await deleteDocument(d);
        expect(memThumbs.has(d.id)).toBe(false);
    });
});
