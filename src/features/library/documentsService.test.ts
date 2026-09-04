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
const libraryListClear = vi.hoisted(() => vi.fn(() => Promise.resolve()));
// Flipped on to simulate WebKit refusing an IndexedDB write (private browsing).
const cacheFailure = vi.hoisted(() => ({ put: null as Error | null, get: null as Error | null }));
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
                get: (id: string) =>
                    cacheFailure.get ? Promise.reject(cacheFailure.get) : Promise.resolve(memCache.get(id)),
                put: (row: { docId: string }) => {
                    if (cacheFailure.put) {
                        return Promise.reject(cacheFailure.put);
                    }
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
            libraryList: table({ clear: libraryListClear }),
            transaction: (_mode: string, _table: unknown, fn: () => unknown) => Promise.resolve(fn()),
        }),
    };
});
vi.mock('@/features/import/prepareUpload', () => ({
    prepareUploadFile: vi.fn(async (file: File) => ({ file, convertedFromImage: false })),
    UPLOAD_ACCEPT: '',
}));

import {
    deleteDocument,
    loadDocumentBytes,
    loadDocumentOffline,
    prefetchDocumentBytes,
    replaceDocumentPdf,
    uploadDocument,
} from '@/features/library/documentsService';
import { libraryMutationEpoch } from '@/features/library/libraryCache';
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
    thumb_rev: null,
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
    /** Objects under the document's folder in the thumbnails bucket. */
    thumbListNames?: string[];
    /** Sequential download payloads; later calls fall back to downloadBytes. */
    downloadSequence?: string[];
    updatedRow?: DocumentRow;
    insertedRow?: DocumentRow;
    insertError?: string;
    deleteError?: string;
}

const makeStub = (options: StubOptions = {}) => {
    const calls = {
        download: vi.fn(),
        upload: vi.fn(),
        remove: vi.fn(),
        removeFrom: vi.fn(),
        list: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
        insert: vi.fn(),
        delete: vi.fn(),
    };
    const storageApi = (bucket: string) => ({
        download: (path: string) => {
            calls.download(path);
            if (options.downloadError) {
                return Promise.resolve({ data: null, error: { message: options.downloadError } });
            }
            const n = calls.download.mock.calls.length - 1;
            const payload = options.downloadSequence?.[n] ?? options.downloadBytes ?? 'fresh-bytes';
            return Promise.resolve({
                data: new Blob([payload], { type: 'application/pdf' }),
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
            calls.removeFrom(bucket, paths);
            return Promise.resolve({ data: null, error: null });
        },
        list: (prefix: string) => {
            calls.list(prefix);
            const names = bucket === 'thumbnails' ? (options.thumbListNames ?? []) : (options.listNames ?? []);
            return Promise.resolve({
                data: names.map((name) => ({ name })),
                error: null,
            });
        },
    });
    const supabase = {
        storage: { from: (bucket: string) => storageApi(bucket) },
        from: (table: string) => ({
            insert: (row: Record<string, unknown>) => {
                calls.insert(table, row);
                return {
                    select: () => ({
                        single: () =>
                            Promise.resolve({
                                data: options.insertError
                                    ? null
                                    : (options.insertedRow ??
                                      doc({
                                          id: String(row.id),
                                          owner_id: String(row.owner_id),
                                          title: String(row.title),
                                          storage_path: String(row.storage_path),
                                      })),
                                error: options.insertError ? { message: options.insertError } : null,
                            }),
                    }),
                };
            },
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
                    return Promise.resolve({
                        data: null,
                        error: options.deleteError ? { message: options.deleteError } : null,
                    });
                },
            }),
        }),
    };
    vi.mocked(getSupabase).mockReturnValue(supabase as never);
    return calls;
};

beforeEach(async () => {
    vi.mocked(uploadPdfToStorage).mockClear();
    libraryListClear.mockClear();
    cacheFailure.put = null;
    cacheFailure.get = null;
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

    // Safari in private browsing has no disk to back an IndexedDB Blob and
    // rejects the write. The bytes are already downloaded by then, so the
    // score must still open — this used to surface as
    // "Error preparing Blob/File data to be stored in object store".
    it('returns downloaded bytes when the browser refuses to cache them', async () => {
        const calls = makeStub({ downloadBytes: 'fresh-bytes' });
        cacheFailure.put = new Error('Error preparing Blob/File data to be stored in object store');
        const bytes = await loadDocumentBytes(doc({ content_rev: 1 }));
        expect(new TextDecoder().decode(bytes)).toBe('fresh-bytes');
        expect(calls.download).toHaveBeenCalledTimes(1);
    });

    // A browser with IndexedDB switched off entirely (Safari, all cookies
    // blocked) throws on the read — that is a cache miss, not a failed open.
    it('downloads when the cache cannot even be read', async () => {
        const calls = makeStub({ downloadBytes: 'fresh-bytes' });
        cacheFailure.get = new Error('UnknownError: IndexedDB is unavailable');
        cacheFailure.put = new Error('UnknownError: IndexedDB is unavailable');
        const bytes = await loadDocumentBytes(doc({ content_rev: 1 }));
        expect(new TextDecoder().decode(bytes)).toBe('fresh-bytes');
        expect(calls.download).toHaveBeenCalledTimes(1);
    });

    // Cache hits still work when the row predates the ArrayBuffer switch.
    it('reads a legacy Blob row written by an earlier build', async () => {
        const calls = makeStub();
        const d = doc({ content_rev: 1 });
        await putCache({
            docId: d.id,
            bytes: new Blob(['legacy-bytes']),
            title: d.title,
            cachedAt: '2026-08-01T00:00:00Z',
            contentRev: 1,
        });
        const bytes = await loadDocumentBytes(d);
        expect(new TextDecoder().decode(bytes)).toBe('legacy-bytes');
        expect(calls.download).not.toHaveBeenCalled();
    });

    it('stores downloaded bytes as an ArrayBuffer, never a Blob', async () => {
        makeStub({ downloadBytes: 'fresh-bytes' });
        const d = doc({ content_rev: 1 });
        await loadDocumentBytes(d);
        const cached = await getDb().pdfCache.get(d.id);
        expect(cached?.bytes).toBeInstanceOf(ArrayBuffer);
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

describe('loadDocumentBytes preloaded bytes (warm open)', () => {
    it('returns the caller’s buffer without a second cache read when the revision is current', async () => {
        const calls = makeStub();
        const d = doc({ content_rev: 1 });
        const held = new TextEncoder().encode('held-bytes').buffer as ArrayBuffer;
        // Nothing in the cache map at all: a second read would come back empty
        // and the old path would have gone to the network.
        const bytes = await loadDocumentBytes(d, {
            preloaded: { bytes: held, contentRev: 1, archivedAt: null },
        });
        expect(bytes).toBe(held);
        expect(calls.download).not.toHaveBeenCalled();
    });

    it('ignores preloaded bytes older than the row and downloads the newer revision', async () => {
        const calls = makeStub({ downloadBytes: 'cleaned-bytes' });
        const d = doc({ content_rev: 2 });
        const held = new TextEncoder().encode('held-bytes').buffer as ArrayBuffer;
        const bytes = await loadDocumentBytes(d, {
            preloaded: { bytes: held, contentRev: 1, archivedAt: null },
        });
        expect(new TextDecoder().decode(bytes)).toBe('cleaned-bytes');
        expect(calls.download).toHaveBeenCalledTimes(1);
    });

    it('refreshes the cached archive flag when the row disagrees with the preloaded one', async () => {
        makeStub();
        const d = doc({ content_rev: 1, archived_at: '2026-08-30T00:00:00Z' });
        await putCache({
            docId: d.id,
            bytes: new Blob(['cached-bytes']),
            title: d.title,
            cachedAt: '2026-08-01T00:00:00Z',
            contentRev: 1,
            archivedAt: null,
        });
        const held = new TextEncoder().encode('held-bytes').buffer as ArrayBuffer;
        await loadDocumentBytes(d, { preloaded: { bytes: held, contentRev: 1, archivedAt: null } });
        expect((await getDb().pdfCache.get(d.id))?.archivedAt).toBe('2026-08-30T00:00:00Z');
    });
});

describe('prefetchDocumentBytes (cold open)', () => {
    it('uses the download that left with the row when the row confirms the path', async () => {
        const calls = makeStub({ downloadBytes: 'prefetched-bytes' });
        const d = doc();
        const prefetch = prefetchDocumentBytes(d.id);
        expect(prefetch.path).toBe(d.storage_path);
        const bytes = await loadDocumentBytes(d, { prefetch });
        expect(new TextDecoder().decode(bytes)).toBe('prefetched-bytes');
        // One download in total — the prefetch — and the cache is seeded from it.
        expect(calls.download).toHaveBeenCalledTimes(1);
        expect((await getDb().pdfCache.get(d.id))?.contentRev).toBe(0);
    });

    it('discards the prefetch and downloads the row’s own path when they differ', async () => {
        const calls = makeStub({ downloadBytes: 'real-bytes' });
        const d = doc({ storage_path: 'a4ccff59-6f2f-4dc7-a2a8-5c8f2b6f1de1/renamed.pdf' });
        const prefetch = prefetchDocumentBytes(d.id);
        const bytes = await loadDocumentBytes(d, { prefetch });
        expect(new TextDecoder().decode(bytes)).toBe('real-bytes');
        expect(calls.download).toHaveBeenCalledTimes(2);
        expect(calls.download).toHaveBeenLastCalledWith(d.storage_path);
    });

    it('falls through to a normal download when the prefetch was refused', async () => {
        const calls = makeStub({ downloadError: 'not found' });
        const d = doc();
        const prefetch = prefetchDocumentBytes(d.id);
        expect(await prefetch.bytes).toBeNull();
        await expect(loadDocumentBytes(d, { prefetch })).rejects.toThrow(/Could not download score/);
        expect(calls.download).toHaveBeenCalledTimes(2);
    });

    it('discards prefetch bytes when the row revision is not 0 and does not cache them as that rev', async () => {
        const calls = makeStub({ downloadSequence: ['prefetched-bytes', 'rev2-bytes'] });
        const d = doc({ content_rev: 2 });
        const prefetch = prefetchDocumentBytes(d.id);
        const bytes = await loadDocumentBytes(d, { prefetch });
        expect(new TextDecoder().decode(bytes)).toBe('rev2-bytes');
        expect(calls.download).toHaveBeenCalledTimes(2);
        expect(calls.download).toHaveBeenLastCalledWith(d.storage_path);
        const cached = await getDb().pdfCache.get(d.id);
        expect(cached?.contentRev).toBe(2);
        expect(new TextDecoder().decode(cached?.bytes as ArrayBuffer)).toBe('rev2-bytes');
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
        expect(new TextDecoder().decode(cached?.bytes as ArrayBuffer)).toBe('cleaned');

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
        expect(calls.removeFrom).toHaveBeenCalledWith('scores', [
            `${d.id}/original.pdf`,
            `${d.id}/pre-import-original.pdf`,
        ]);
    });

    it('removes the published covers along with the PDF', async () => {
        const calls = makeStub({ listNames: ['original.pdf'], thumbListNames: ['0.jpg', '2.jpg'] });
        const d = doc();
        await deleteDocument(d);
        expect(calls.removeFrom).toHaveBeenCalledWith('thumbnails', [`${d.id}/0.jpg`, `${d.id}/2.jpg`]);
    });

    it('does not touch the thumbnails bucket when nothing was ever published', async () => {
        const calls = makeStub({ listNames: ['original.pdf'] });
        await deleteDocument(doc());
        expect(calls.removeFrom).not.toHaveBeenCalledWith('thumbnails', expect.anything());
    });

    it('removes the stamped cover when list returns empty', async () => {
        const calls = makeStub({ listNames: ['original.pdf'], thumbListNames: [] });
        const d = doc({ thumb_rev: 2 });
        await deleteDocument(d);
        expect(calls.removeFrom).toHaveBeenCalledWith('thumbnails', [`${d.id}/2.jpg`]);
    });

    /**
     * The producer half of the library-cache contract: the epoch moves at
     * the attempt edge, BEFORE the server write (so a bootstrap racing it is
     * outranked), and again at the commit edge (so a bootstrap dispatched
     * mid-write is outranked too). A refused delete takes only the attempt
     * edge: it must not look like a committed mutation.
     */
    it('bumps the epoch on both edges of a successful delete', async () => {
        makeStub();
        const before = libraryMutationEpoch();
        await deleteDocument(doc());
        expect(libraryMutationEpoch()).toBe(before + 2);
        expect(libraryListClear).not.toHaveBeenCalled();
    });

    it('keeps the library snapshots when the delete is refused', async () => {
        makeStub({ deleteError: 'permission denied' });
        const before = libraryMutationEpoch();
        await expect(deleteDocument(doc())).rejects.toThrow('Could not delete');
        expect(libraryMutationEpoch()).toBe(before + 1);
        expect(libraryListClear).not.toHaveBeenCalled();
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

describe('uploadDocument commit edge', () => {
    const pdf = () => new File(['%PDF-1.4'], 'sonata.pdf', { type: 'application/pdf' });

    it('does not commit the library mutation until storage succeeds, and seeds the cache as owner', async () => {
        makeStub();
        const before = libraryMutationEpoch();
        vi.mocked(uploadPdfToStorage).mockImplementation(async () => {
            expect(libraryMutationEpoch()).toBe(before + 1);
            expect(libraryListClear).not.toHaveBeenCalled();
        });
        const { document } = await uploadDocument(pdf(), 'user-1');
        expect(libraryMutationEpoch()).toBe(before + 2);
        expect(libraryListClear).not.toHaveBeenCalled();
        const cached = await getDb().pdfCache.get(document.id);
        expect(cached?.myRole).toBe('owner');
        expect(cached?.userId).toBe('user-1');
    });

    it('commits after rolling back a row whose storage upload failed', async () => {
        const calls = makeStub();
        vi.mocked(uploadPdfToStorage).mockRejectedValueOnce(new Error('storage down'));
        const before = libraryMutationEpoch();
        await expect(uploadDocument(pdf(), 'user-1')).rejects.toThrow('storage down');
        expect(calls.delete).toHaveBeenCalledWith('documents');
        expect(libraryMutationEpoch()).toBe(before + 2);
        expect(libraryListClear).not.toHaveBeenCalled();
    });
});

describe('loadDocumentOffline', () => {
    const id = 'a4ccff59-6f2f-4dc7-a2a8-5c8f2b6f1de1';
    const row = (over: Partial<CachedPdf> = {}): CachedPdf => ({
        docId: id,
        bytes: new Blob(['cached-bytes']),
        title: 'Sonata',
        cachedAt: '2026-08-01T00:00:00Z',
        myRole: 'owner',
        userId: 'user-1',
        ...over,
    });

    it('returns the cached score when userId matches', async () => {
        await putCache(row());
        const offline = await loadDocumentOffline(id, 'user-1');
        expect(offline?.role).toBe('owner');
        expect(offline?.cachedRole).toBe('owner');
        expect(offline?.doc.title).toBe('Sonata');
    });

    it('returns null when userId mismatches', async () => {
        await putCache(row());
        expect(await loadDocumentOffline(id, 'user-2')).toBeNull();
    });

    it('returns null for a legacy row with no userId', async () => {
        await putCache(row({ userId: undefined }));
        expect(await loadDocumentOffline(id, 'user-1')).toBeNull();
    });

    it('defaults a missing stored role to viewer and reports cachedRole null', async () => {
        await putCache(row({ myRole: undefined }));
        const offline = await loadDocumentOffline(id, 'user-1');
        expect(offline?.role).toBe('viewer');
        expect(offline?.cachedRole).toBeNull();
    });
});
