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
    fetchLibraryPage,
    listDocuments,
    loadDocumentBytes,
    loadDocumentOffline,
    prefetchDocumentBytes,
    replaceDocumentPdf,
    resetStorageCleanupSweep,
    sweepPendingStorageCleanup,
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
    /** Rows the documents delete reports; 0 is how RLS answers a refused delete. */
    deletedRows?: number;
    /** After a zero-row delete: whether the row is still visible to the caller. */
    stillVisible?: boolean;
    /** Storage remove() fails outright. */
    removeError?: string;
    /** Storage remove() "succeeds" without removing anything (a refused delete). */
    removeRefused?: boolean;
    /** Storage list() fails. */
    listError?: string;
    tombstoneDeleteError?: string;
    /** Rows document_storage_cleanup returns to the sweep. */
    tombstones?: Array<{ document_id: string; storage_path: string; thumb_rev: number | null }>;
    rpcResult?: { documents: DocumentRow[]; has_more: boolean } | null;
    rpcError?: { code?: string; message: string };
    restRows?: DocumentRow[];
}

/** A query-builder stand-in that can be awaited directly or chained further. */
const thenable = <T, X extends object>(result: T, extra: X): Promise<T> & X =>
    Object.assign(Promise.resolve(result), extra);

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
        rpc: vi.fn(),
        or: vi.fn(),
        /** Order-sensitive log of server effects: 'row:delete', 'storage:remove:<bucket>', … */
        events: [] as string[],
    };
    const folders: Record<string, string[]> = {
        scores: [...(options.listNames ?? [])],
        thumbnails: [...(options.thumbListNames ?? [])],
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
            calls.events.push(`storage:remove:${bucket}`);
            if (options.removeError) {
                return Promise.resolve({ data: null, error: { message: options.removeError } });
            }
            if (!options.removeRefused) {
                const names = new Set(paths.map((path) => path.split('/').slice(1).join('/')));
                folders[bucket] = (folders[bucket] ?? []).filter((name) => !names.has(name));
            }
            return Promise.resolve({ data: [], error: null });
        },
        list: (prefix: string) => {
            calls.list(prefix);
            if (options.listError) {
                return Promise.resolve({ data: null, error: { message: options.listError } });
            }
            return Promise.resolve({
                data: (folders[bucket] ?? []).map((name) => ({ name })),
                error: null,
            });
        },
        createSignedUrl: (path: string) =>
            Promise.resolve({ data: { signedUrl: `https://storage.test/sign/${path}` }, error: null }),
    });
    const supabase = {
        storage: { from: (bucket: string) => storageApi(bucket) },
        rpc: (fn: string, args: unknown) => {
            calls.rpc(fn, args);
            return Promise.resolve({
                data: options.rpcError ? null : (options.rpcResult ?? { documents: [], has_more: false }),
                error: options.rpcError ?? null,
            });
        },
        from: (table: string) => ({
            select: () => {
                // documents REST listing (listDocuments) and the visibility
                // re-check after a zero-row delete; tombstones for the sweep.
                const rows =
                    table === 'document_storage_cleanup' ? (options.tombstones ?? []) : (options.restRows ?? []);
                const builder = {
                    order: () => builder,
                    eq: () => builder,
                    or: (filter: string) => {
                        calls.or(filter);
                        return builder;
                    },
                    limit: () => Promise.resolve({ data: rows, error: null }),
                    maybeSingle: () =>
                        Promise.resolve({ data: options.stillVisible ? { id: 'x' } : null, error: null }),
                };
                return builder;
            },
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
                    if (table === 'documents') {
                        calls.events.push('row:delete');
                    } else if (table === 'document_storage_cleanup') {
                        calls.events.push('tombstone:delete');
                    }
                    const error =
                        table === 'document_storage_cleanup'
                            ? options.tombstoneDeleteError
                                ? { message: options.tombstoneDeleteError }
                                : null
                            : options.deleteError
                              ? { message: options.deleteError }
                              : null;
                    const rows = Array.from({ length: options.deletedRows ?? 1 }, () => ({ id: 'x' }));
                    return thenable(
                        { data: null, error },
                        { select: () => Promise.resolve({ data: error ? null : rows, error }) },
                    );
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

describe('deleteDocument ordering (row first, bytes after)', () => {
    it('deletes the row before any stored file is touched, then clears the tombstone', async () => {
        const calls = makeStub({ listNames: ['original.pdf'], thumbListNames: ['0.jpg'] });
        await deleteDocument(doc());
        expect(calls.events).toEqual([
            'row:delete',
            'storage:remove:scores',
            'storage:remove:thumbnails',
            'tombstone:delete',
        ]);
    });

    it('leaves the PDF alone when the row delete fails, so the score still opens', async () => {
        const calls = makeStub({ listNames: ['original.pdf'], deleteError: 'network down' });
        await expect(deleteDocument(doc())).rejects.toThrow('Could not delete: network down');
        expect(calls.remove).not.toHaveBeenCalled();
    });

    it('treats a zero-row delete of a still-visible score as refused and touches nothing', async () => {
        const calls = makeStub({ listNames: ['original.pdf'], deletedRows: 0, stillVisible: true });
        const before = libraryMutationEpoch();
        await expect(deleteDocument(doc())).rejects.toThrow(/only the score’s owner/);
        expect(calls.remove).not.toHaveBeenCalled();
        expect(libraryMutationEpoch()).toBe(before + 1);
    });

    it('finishes the cleanup when another device already deleted the row', async () => {
        const calls = makeStub({ listNames: ['original.pdf'], deletedRows: 0, stillVisible: false });
        const d = doc();
        await putCache({ docId: d.id, bytes: new ArrayBuffer(4), title: 'Sonata', cachedAt: 'x' });
        await deleteDocument(d);
        expect(calls.removeFrom).toHaveBeenCalledWith('scores', [`${d.id}/original.pdf`]);
        expect(memCache.has(d.id)).toBe(false);
    });

    it('still reports success when the storage cleanup fails, keeping the tombstone for a retry', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const calls = makeStub({ listNames: ['original.pdf'], removeError: 'storage unavailable' });
        const before = libraryMutationEpoch();
        await expect(deleteDocument(doc())).resolves.toBeUndefined();
        expect(libraryMutationEpoch()).toBe(before + 2);
        expect(calls.events).not.toContain('tombstone:delete');
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('keeps the tombstone when Storage silently removed nothing', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const calls = makeStub({ listNames: ['original.pdf'], removeRefused: true });
        await deleteDocument(doc());
        expect(calls.events).not.toContain('tombstone:delete');
        warn.mockRestore();
    });

    it('keeps the tombstone when the folder cannot be re-listed to prove it empty', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const calls = makeStub({ listError: 'refused' });
        const d = doc();
        await deleteDocument(d);
        // The stamped path is still removed even though the listing failed.
        expect(calls.removeFrom).toHaveBeenCalledWith('scores', [d.storage_path]);
        expect(calls.events).not.toContain('tombstone:delete');
        warn.mockRestore();
    });
});

describe('sweepPendingStorageCleanup', () => {
    beforeEach(() => {
        resetStorageCleanupSweep();
    });

    it('purges every leftover folder once per account per page load', async () => {
        const calls = makeStub({
            tombstones: [
                { document_id: 'doc-a', storage_path: 'doc-a/original.pdf', thumb_rev: null },
                { document_id: 'doc-b', storage_path: 'doc-b/original.pdf', thumb_rev: 3 },
            ],
        });
        await sweepPendingStorageCleanup('user-1');
        expect(calls.removeFrom).toHaveBeenCalledWith('scores', ['doc-a/original.pdf']);
        expect(calls.removeFrom).toHaveBeenCalledWith('scores', ['doc-b/original.pdf']);
        expect(calls.removeFrom).toHaveBeenCalledWith('thumbnails', ['doc-b/3.jpg']);
        expect(calls.events.filter((e) => e === 'tombstone:delete')).toHaveLength(2);

        calls.removeFrom.mockClear();
        await sweepPendingStorageCleanup('user-1');
        expect(calls.removeFrom).not.toHaveBeenCalled();
    });
});

describe('fetchLibraryPage', () => {
    const row = doc({ id: 'd9', title: 'Zelda', updated_at: '2026-01-01T00:00:00.123456+00:00' });

    it('continues a recent page from (updated_at, id), passed back verbatim', async () => {
        const calls = makeStub({ rpcResult: { documents: [doc()], has_more: true } });
        const page = await fetchLibraryPage({ after: row });
        expect(page).toEqual({ documents: [doc()], hasMore: true });
        expect(calls.rpc).toHaveBeenCalledWith('library_documents', {
            p_sort: 'recent',
            p_after_updated_at: '2026-01-01T00:00:00.123456+00:00',
            p_after_title: null,
            p_after_id: 'd9',
            p_query: null,
            p_tag_id: null,
            p_favorites_only: false,
            p_limit: 100,
        });
    });

    it('continues an A–Z page from (title, id) and sends the trimmed query and filters', async () => {
        const calls = makeStub();
        await fetchLibraryPage({ sort: 'title', after: row, query: '  bach ', tagId: 't1', favoritesOnly: true });
        expect(calls.rpc).toHaveBeenCalledWith(
            'library_documents',
            expect.objectContaining({
                p_sort: 'title',
                p_after_updated_at: null,
                p_after_title: 'Zelda',
                p_after_id: 'd9',
                p_query: 'bach',
                p_tag_id: 't1',
                p_favorites_only: true,
            }),
        );
    });

    it('pages over REST when the database predates library_documents', async () => {
        const calls = makeStub({
            rpcError: { code: 'PGRST202', message: 'Could not find the function' },
            restRows: [doc()],
        });
        const page = await fetchLibraryPage({ after: row });
        expect(page).toEqual({ documents: [doc()], hasMore: false });
        expect(calls.or).toHaveBeenCalledWith(
            'updated_at.lt."2026-01-01T00:00:00.123456+00:00",and(updated_at.eq."2026-01-01T00:00:00.123456+00:00",id.lt.d9)',
        );
    });

    it('does not pretend a filtered search succeeded when the RPC is missing', async () => {
        makeStub({ rpcError: { code: 'PGRST202', message: 'Could not find the function' } });
        await expect(fetchLibraryPage({ query: 'bach' })).rejects.toThrow('Could not load scores');
    });

    it('surfaces any other RPC failure', async () => {
        makeStub({ rpcError: { code: '57014', message: 'timeout' } });
        await expect(fetchLibraryPage()).rejects.toThrow('Could not load scores: timeout');
    });
});

describe('listDocuments', () => {
    it('reports more when the server returns one row past the page', async () => {
        const rows = Array.from({ length: 101 }, (_, i) => doc({ id: `d${i}` }));
        const calls = makeStub({ restRows: rows });
        const page = await listDocuments();
        expect(page.documents).toHaveLength(100);
        expect(page.hasMore).toBe(true);
        expect(calls.or).not.toHaveBeenCalled();
    });
});

describe('loadDocumentBytes with progress', () => {
    const streamResponse = (parts: string[], contentLength: number | null) => {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const part of parts) {
                    controller.enqueue(encoder.encode(part));
                }
                controller.close();
            },
        });
        const headers = new Headers(contentLength === null ? {} : { 'content-length': String(contentLength) });
        return new Response(body, { status: 200, headers });
    };

    it('streams the download, reports progress, and caches the bytes', async () => {
        makeStub();
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamResponse(['abc', 'defg'], 7));
        const progress: Array<{ loaded: number; total: number }> = [];
        const d = doc();
        const bytes = await loadDocumentBytes(d, { onProgress: (p) => progress.push(p) });
        expect(new TextDecoder().decode(bytes)).toBe('abcdefg');
        expect(fetchSpy).toHaveBeenCalledWith(`https://storage.test/sign/${d.storage_path}`);
        expect(progress[0]).toEqual({ loaded: 0, total: 7 });
        expect(progress).toContainEqual({ loaded: 3, total: 7 });
        expect(progress[progress.length - 1]).toEqual({ loaded: 7, total: 7 });
        expect(memCache.has(d.id)).toBe(true);
        fetchSpy.mockRestore();
    });

    it('reports an unknown total as 0 so the bar can go indeterminate', async () => {
        makeStub();
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamResponse(['abc'], null));
        const progress: Array<{ loaded: number; total: number }> = [];
        await loadDocumentBytes(doc(), { onProgress: (p) => progress.push(p) });
        expect(progress).toContainEqual({ loaded: 3, total: 0 });
        fetchSpy.mockRestore();
    });

    it('throws a download error rather than returning nothing when there is no cached copy', async () => {
        makeStub();
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 403 }));
        await expect(loadDocumentBytes(doc(), { onProgress: () => undefined })).rejects.toThrow(
            'Could not download score: HTTP 403',
        );
        fetchSpy.mockRestore();
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
