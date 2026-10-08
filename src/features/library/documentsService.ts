import { importImslpPdfToStorage, type ImslpDownloadFallback } from '@/features/imslp/imslpApi';
import { prepareUploadFile } from '@/features/import/prepareUpload';
import { getThumbnail } from '@/features/library/thumbnailService';
import { uploadPdfToStorage, type UploadProgress } from '@/lib/storageUpload';
import { getSupabase } from '@/lib/supabase';
import { noteLibraryMutationCommitted, noteLibraryMutation } from '@/features/library/libraryCache';
import { parsePostgrestLimitError } from '@/features/billing/limitErrors';
import { getDb } from '@/sync/db';
import { getCachedPdf, putCachedPdf, readCachedPdfBytes } from '@/sync/pdfCache';
import type { LibrarySort } from '@/features/library/libraryView';
import type { DocumentRow, DocumentStorageCleanupRow, MemberRole } from '@/types/database';

/** Cloud document ids are plain UUIDs; local-only docs use the 'local-' prefix. */
export const isCloudDocId = (docId: string): boolean => {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(docId);
};

export const LIBRARY_PAGE_SIZE = 100;

const DOCUMENT_COLUMNS =
    'id, owner_id, title, storage_path, page_count, content_rev, thumb_rev, created_at, updated_at, archived_at';

/**
 * The last row a page ended on; the next page starts strictly after it. The
 * row's own values are passed back untouched — updated_at in particular keeps
 * its microseconds, or rows sharing the truncated millisecond would be skipped.
 */
export type LibraryCursor = Pick<DocumentRow, 'id' | 'title' | 'updated_at'>;

export interface LibraryPage {
    documents: DocumentRow[];
    hasMore: boolean;
}

export interface LibraryPageRequest {
    sort?: LibrarySort;
    /** Title substring (case-insensitive); blank means no title filter. */
    query?: string;
    /** One of the caller's own tags. */
    tagId?: string | null;
    favoritesOnly?: boolean;
    after?: LibraryCursor | null;
    limit?: number;
}

/** PostgREST quoting for a filter value that carries `.`, `:` or `+`. */
const quoted = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Plain REST listing in the library's recent order — the fallback when the
 * bootstrap RPC is unavailable. Ordered by (updated_at, id), both descending:
 * the id breaks ties, so a bulk update that stamps many rows with one
 * timestamp cannot make a page boundary skip or repeat a score.
 */
export const listDocuments = async (after: LibraryCursor | null = null): Promise<LibraryPage> => {
    let request = getSupabase().from('documents').select(DOCUMENT_COLUMNS);
    if (after) {
        const ts = quoted(after.updated_at);
        request = request.or(`updated_at.lt.${ts},and(updated_at.eq.${ts},id.lt.${after.id})`);
    }
    const { data, error } = await request
        .order('updated_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(LIBRARY_PAGE_SIZE + 1);
    if (error) {
        throw new Error(`Could not load documents: ${error.message}`);
    }
    const hasMore = data.length > LIBRARY_PAGE_SIZE;
    return { documents: hasMore ? data.slice(0, LIBRARY_PAGE_SIZE) : data, hasMore };
};

/** PostgREST's "no such function" (schema cache) and Postgres's own. */
const isMissingFunction = (error: { code?: string } | null): boolean =>
    error?.code === 'PGRST202' || error?.code === '42883';

/**
 * One keyset page of the caller's library from library_documents(): the
 * rows after `after` in the requested order, optionally narrowed by title,
 * tag or favorites. Membership is enforced server-side, so a search reaches
 * every score the caller can open — not just the rows this page has loaded.
 */
export const fetchLibraryPage = async (request: LibraryPageRequest = {}): Promise<LibraryPage> => {
    const sort = request.sort ?? 'recent';
    const query = request.query?.trim() ?? '';
    const after = request.after ?? null;
    const plain = sort === 'recent' && !query && !request.tagId && !request.favoritesOnly;
    const { data, error } = await getSupabase().rpc('library_documents', {
        p_sort: sort,
        p_after_updated_at: after && sort === 'recent' ? after.updated_at : null,
        p_after_title: after && sort === 'title' ? after.title : null,
        p_after_id: after?.id ?? null,
        p_query: query || null,
        p_tag_id: request.tagId ?? null,
        p_favorites_only: request.favoritesOnly ?? false,
        p_limit: request.limit ?? LIBRARY_PAGE_SIZE,
    });
    if (error || !data) {
        // A database still without 20261007120400 has no library_documents;
        // the unfiltered recent listing can still page over plain REST.
        if (plain && isMissingFunction(error)) {
            return listDocuments(after);
        }
        throw new Error(`Could not load scores: ${error?.message ?? 'no response'}`);
    }
    return { documents: data.documents ?? [], hasMore: Boolean(data.has_more) };
};

export const fetchDocument = async (docId: string): Promise<DocumentRow | null> => {
    const { data, error } = await getSupabase().from('documents').select('*').eq('id', docId).maybeSingle();
    if (error) {
        throw new Error(`Could not load document: ${error.message}`);
    }
    return data;
};

export const fetchMyRole = async (docId: string, userId: string): Promise<MemberRole | null> => {
    const { data, error } = await getSupabase()
        .from('document_members')
        .select('*')
        .eq('document_id', docId)
        .eq('user_id', userId)
        .maybeSingle();
    if (error) {
        throw new Error(`Could not load membership: ${error.message}`);
    }
    const role = data?.role ?? null;
    if (role) {
        // Remember the role so an offline open gets the right editing mode.
        const cached = await getCachedPdf(docId);
        if (cached && (cached.myRole !== role || cached.userId !== userId)) {
            await putCachedPdf({ ...cached, myRole: role, userId });
        }
    }
    return role;
};

export interface OfflineDocFallback {
    doc: DocumentRow;
    role: MemberRole;
    /**
     * Role that was actually stored on the cache row. Null when the row had
     * none — the display `role` then defaults to viewer, and a true-offline
     * confirm must not lift provisional on a guessed role.
     */
    cachedRole: MemberRole | null;
    bytes: ArrayBuffer;
}

export const documentRowFromCache = (cached: {
    id: string;
    title: string;
    cachedAt: string;
    contentRev?: number;
    archivedAt?: string | null;
}): DocumentRow => ({
    id: cached.id,
    owner_id: '',
    title: cached.title,
    storage_path: `${cached.id}/original.pdf`,
    page_count: null,
    content_rev: cached.contentRev ?? 0,
    thumb_rev: null,
    created_at: cached.cachedAt,
    updated_at: cached.cachedAt,
    archived_at: cached.archivedAt ?? null,
});

/**
 * Open a previously-cached document without the network: synthesizes the
 * document row from the cache and uses the last-known role (defaulting to
 * viewer — a missing role must not grant writes). Rows stamped for another
 * account, or written before userId existed, are treated as a miss.
 */
export const loadDocumentOffline = async (docId: string, userId: string): Promise<OfflineDocFallback | null> => {
    const cached = await getCachedPdf(docId);
    if (!cached || !cached.userId || cached.userId !== userId) {
        return null;
    }
    const cachedRole = cached.myRole ?? null;
    return {
        doc: documentRowFromCache({
            id: docId,
            title: cached.title,
            cachedAt: cached.cachedAt,
            // The real revision, so a warm open can tell whether the server's
            // answer is the same bytes it already painted.
            contentRev: cached.contentRev,
            archivedAt: cached.archivedAt,
        }),
        role: cachedRole ?? 'viewer',
        cachedRole,
        bytes: await readCachedPdfBytes(cached.bytes),
    };
};

/** Count pages client-side (pdf.js) so the library can show it up front. */
export const countPdfPages = async (bytes: ArrayBuffer): Promise<number | null> => {
    try {
        const [{ getDocument }, { createPdfWorker }, { pdfDocumentOptions }] = await Promise.all([
            import('pdfjs-dist'),
            import('@/features/viewer/pdf/pdfWorker'),
            import('@/features/viewer/pdf/pdfDocumentOptions'),
        ]);
        const worker = createPdfWorker();
        const task = getDocument({ data: bytes.slice(0), worker, ...pdfDocumentOptions });
        try {
            const doc = await task.promise;
            return doc.numPages;
        } finally {
            await task.destroy().catch(() => undefined);
            worker.destroy();
        }
    } catch {
        return null;
    }
};

/** Backfill documents.page_count when missing (needed before play-along analyze). */
export const ensureDocumentPageCount = async (doc: DocumentRow, bytes: ArrayBuffer): Promise<DocumentRow> => {
    if (typeof doc.page_count === 'number' && doc.page_count > 0) {
        return doc;
    }
    const pageCount = await countPdfPages(bytes);
    if (pageCount === null || pageCount < 1) {
        return doc;
    }
    // Owners and editors may backfill via security-definer RPC (direct UPDATE
    // is owner-only under documents_update RLS).
    const { error } = await getSupabase().rpc('set_document_page_count', { doc: doc.id, pages: pageCount });
    if (error) {
        console.warn('Could not persist page_count', error.message);
        return doc;
    }
    return { ...doc, page_count: pageCount };
};

export interface UploadResult {
    document: DocumentRow;
}

/**
 * Upload flow (order matters for RLS): insert the documents row FIRST — the
 * owner-membership trigger fires and the storage policies key off membership
 * of the path's leading folder — then upload bytes, then patch page_count.
 * On upload failure the row is rolled back so the library never shows a
 * bytes-less score.
 *
 * Accepts PDFs and images: images are normalized into single-page PDFs
 * before anything touches the network (the bucket is PDF-only).
 */
export const uploadDocument = async (
    pickedFile: File,
    ownerId: string,
    onProgress?: (progress: UploadProgress) => void,
): Promise<UploadResult> => {
    noteLibraryMutation();
    const { file } = await prepareUploadFile(pickedFile);
    const supabase = getSupabase();
    const id = crypto.randomUUID();
    const storagePath = `${id}/original.pdf`;
    const title = file.name.replace(/\.pdf$/i, '');

    const { data: document, error: insertError } = await supabase
        .from('documents')
        .insert({ id, owner_id: ownerId, title, storage_path: storagePath })
        .select()
        .single();
    if (insertError) {
        // The free-tier cap is a database trigger, so it arrives here rather
        // than as an HTTP 402 — normalize it to the same typed error.
        const limit = parsePostgrestLimitError(insertError);
        if (limit) {
            throw limit;
        }
        throw new Error(`Could not create document: ${insertError.message}`);
    }

    try {
        await uploadPdfToStorage(storagePath, file, onProgress);
    } catch (err) {
        await supabase.from('documents').delete().eq('id', id);
        // The row existed, then didn't: outrank any bootstrap that saw it.
        noteLibraryMutationCommitted();
        throw err;
    }
    noteLibraryMutationCommitted();

    const bytes = await file.arrayBuffer();
    const pageCount = await countPdfPages(bytes);
    if (pageCount !== null) {
        await supabase.from('documents').update({ page_count: pageCount }).eq('id', id);
    }

    // Seed the offline cache immediately — no need to re-download what we just sent.
    await putCachedPdf({
        docId: id,
        bytes,
        title,
        cachedAt: new Date().toISOString(),
        myRole: 'owner',
        userId: ownerId,
    });

    // Render the library thumbnail from the bytes we already hold. Detached on
    // purpose: the upload is done, and a slow pdf.js pass must not delay it.
    void getThumbnail(id, 0).catch(() => undefined);

    return { document: { ...document, page_count: pageCount } };
};

/**
 * IMSLP import: create the documents row, let Edge fetch+store the PDF, then
 * hydrate Dexie from Storage (one download leg — no Edge→browser PDF proxy).
 */
export const importDocumentFromImslp = async (
    imslpFilename: string,
    workTitle: string,
    ownerId: string,
    acceptedDisclaimer: boolean,
): Promise<{ ok: true; document: DocumentRow } | { ok: false; fallback: ImslpDownloadFallback }> => {
    noteLibraryMutation();
    const supabase = getSupabase();
    const id = crypto.randomUUID();
    const storagePath = `${id}/original.pdf`;
    const title = workTitle.replace(/\.pdf$/i, '').trim() || imslpFilename.replace(/\.pdf$/i, '');

    const { data: document, error: insertError } = await supabase
        .from('documents')
        .insert({ id, owner_id: ownerId, title, storage_path: storagePath })
        .select()
        .single();
    if (insertError) {
        // The free-tier cap is a database trigger, so it arrives here rather
        // than as an HTTP 402 — normalize it to the same typed error.
        const limit = parsePostgrestLimitError(insertError);
        if (limit) {
            throw limit;
        }
        throw new Error(`Could not create document: ${insertError.message}`);
    }

    const rollback = async () => {
        await supabase.storage
            .from('scores')
            .remove([storagePath])
            .catch(() => undefined);
        await supabase.from('documents').delete().eq('id', id);
        noteLibraryMutationCommitted();
    };

    try {
        const result = await importImslpPdfToStorage(imslpFilename, id, acceptedDisclaimer, workTitle);
        if (!result.ok) {
            await rollback();
            return { ok: false, fallback: result };
        }
        noteLibraryMutationCommitted();

        const bytes = await loadDocumentBytes({ ...document, page_count: null }, { userId: ownerId });
        const pageCount = await countPdfPages(bytes);
        if (pageCount !== null) {
            await supabase.from('documents').update({ page_count: pageCount }).eq('id', id);
        }

        return { ok: true, document: { ...document, page_count: pageCount } };
    } catch (err) {
        await rollback();
        throw err;
    }
};

/** Ids of the caller's favorited documents (favorites are per-user, RLS-scoped). */
export const listFavoriteDocumentIds = async (): Promise<Set<string>> => {
    const { data, error } = await getSupabase().from('document_favorites').select('document_id');
    if (error) {
        throw new Error(`Could not load favorites: ${error.message}`);
    }
    return new Set(data.map((row) => row.document_id));
};

export const setDocumentFavorite = async (docId: string, userId: string, favorite: boolean): Promise<void> => {
    noteLibraryMutation();
    const supabase = getSupabase();
    if (favorite) {
        const { error } = await supabase
            .from('document_favorites')
            .upsert(
                { document_id: docId, user_id: userId },
                { onConflict: 'document_id,user_id', ignoreDuplicates: true },
            );
        if (error) {
            throw new Error(`Could not add favorite: ${error.message}`);
        }
        noteLibraryMutationCommitted();
        return;
    }
    const { error } = await supabase.from('document_favorites').delete().eq('document_id', docId).eq('user_id', userId);
    if (error) {
        throw new Error(`Could not remove favorite: ${error.message}`);
    }
    noteLibraryMutationCommitted();
};

export const renameDocument = async (docId: string, title: string): Promise<void> => {
    noteLibraryMutation();
    const { error } = await getSupabase().from('documents').update({ title }).eq('id', docId);
    if (error) {
        throw new Error(`Could not rename: ${error.message}`);
    }
    noteLibraryMutationCommitted();
    const cached = await getCachedPdf(docId);
    if (cached) {
        await putCachedPdf({ ...cached, title });
    }
};

/** Objects under `{docId}/` in one bucket, or null when Storage would not say. */
const listFolder = async (bucket: 'scores' | 'thumbnails', docId: string): Promise<string[] | null> => {
    const { data, error } = await getSupabase().storage.from(bucket).list(docId, { limit: 1000 });
    if (error || !data) {
        return null;
    }
    return data.map((o) => `${docId}/${o.name}`);
};

/**
 * Remove a deleted score's bytes from both buckets, then drop its tombstone.
 * Returns whether the folder is now provably empty.
 *
 * Runs AFTER the documents row is gone: the storage policies that normally
 * key off membership no longer apply, and the scores_cleanup_* /
 * thumbnails_cleanup_* policies (20261007120401) let the former owner list
 * and remove a folder whose document_storage_cleanup tombstone they hold.
 *
 * Never throws. A folder left behind is invisible — no row points at it —
 * and the tombstone stays for sweepPendingStorageCleanup to retry, so a
 * failure here is logged and nothing more.
 */
export const purgeDocumentStorage = async (
    target: Pick<DocumentStorageCleanupRow, 'document_id' | 'storage_path' | 'thumb_rev'>,
): Promise<boolean> => {
    const docId = target.document_id;
    try {
        const supabase = getSupabase();
        // Ids are client-chosen, and the database lets an owner re-create a
        // score under an id of their own that was deleted. If that happened,
        // the folder belongs to a live score again — the owner's normal
        // storage policies would happily let this remove its PDF — so the
        // tombstone is simply obsolete.
        const { data: live, error: liveError } = await supabase
            .from('documents')
            .select('id')
            .eq('id', docId)
            .maybeSingle();
        if (liveError) {
            throw new Error(liveError.message);
        }
        if (live) {
            await supabase.from('document_storage_cleanup').delete().eq('document_id', docId);
            return true;
        }
        // The whole folder, so import backups go too; the stamped path is
        // added in case the listing was refused.
        const listed = (await listFolder('scores', docId)) ?? [];
        const { error: removeError } = await supabase.storage
            .from('scores')
            .remove([...new Set([target.storage_path, ...listed])]);
        if (removeError) {
            throw new Error(removeError.message);
        }
        const knownCover = target.thumb_rev != null ? [`${docId}/${target.thumb_rev}.jpg`] : [];
        const covers = [...new Set([...knownCover, ...((await listFolder('thumbnails', docId)) ?? [])])];
        if (covers.length > 0) {
            const { error: coverError } = await supabase.storage.from('thumbnails').remove(covers);
            if (coverError) {
                throw new Error(coverError.message);
            }
        }
        // Storage answers a delete its policies refuse with an empty result,
        // not an error — only an empty re-listing proves the bytes are gone.
        const [scoresLeft, coversLeft] = await Promise.all([
            listFolder('scores', docId),
            listFolder('thumbnails', docId),
        ]);
        if (scoresLeft === null || coversLeft === null || scoresLeft.length > 0 || coversLeft.length > 0) {
            console.warn('Deleted score still has stored files; will retry', docId);
            return false;
        }
        const { error: tombstoneError } = await supabase
            .from('document_storage_cleanup')
            .delete()
            .eq('document_id', docId);
        if (tombstoneError) {
            console.warn('Could not clear the storage cleanup marker', tombstoneError.message);
            return false;
        }
        return true;
    } catch (err) {
        console.warn('Could not remove a deleted score’s files; will retry', err);
        return false;
    }
};

/** Once per account per page load is plenty: leftovers are rare and invisible. */
let sweptForUser: string | null = null;

/** Tombstones looked at per sweep, and how many of those are retried. */
const SWEEP_CANDIDATES = 100;
const SWEEP_BATCH = 20;

/**
 * Finish storage cleanups an earlier delete could not (offline, a refused
 * request, a tab closed mid-way). Detached and best-effort: the caller never
 * waits on it and nothing the user sees depends on it.
 *
 * The batch is a random draw from the oldest candidates rather than the
 * oldest few: a handful of folders Storage keeps refusing would otherwise
 * take every slot on every visit, and nothing newer would ever be retried.
 */
export const sweepPendingStorageCleanup = async (userId: string): Promise<void> => {
    if (sweptForUser === userId) {
        return;
    }
    sweptForUser = userId;
    try {
        const { data, error } = await getSupabase()
            .from('document_storage_cleanup')
            .select('document_id, storage_path, thumb_rev')
            .eq('owner_id', userId)
            .order('deleted_at', { ascending: true })
            .limit(SWEEP_CANDIDATES);
        if (error || !data) {
            return;
        }
        const batch = data
            .map((row) => ({ row, draw: Math.random() }))
            .sort((a, b) => a.draw - b.draw)
            .slice(0, SWEEP_BATCH)
            .map(({ row }) => row);
        for (const row of batch) {
            await purgeDocumentStorage(row);
        }
    } catch {
        // Next page load tries again.
    }
};

/** Test hook: forget which account was swept. */
export const resetStorageCleanupSweep = (): void => {
    sweptForUser = null;
};

/** Every local copy of a score — best effort, the server delete already happened. */
const clearLocalDocumentCaches = async (docId: string): Promise<void> => {
    try {
        const db = getDb();
        await Promise.all([
            db.pdfCache.delete(docId),
            db.syncState.delete(docId),
            db.annotations.where('docId').equals(docId).delete(),
            db.ops.where('docId').equals(docId).delete(),
            db.annotationSnapshots.where('docId').equals(docId).delete(),
            db.scoreCache.delete(docId),
            db.thumbnails.delete(docId),
        ]);
    } catch (err) {
        console.warn('Could not clear the deleted score from this device', err);
    }
};

export interface DeleteDocumentResult {
    /**
     * The detached Storage cleanup — resolves to whether the folder is now
     * provably empty, never rejects. Nobody has to wait on it; it is exposed
     * so tests (and anything that cares) can.
     */
    storageCleanup: Promise<boolean>;
}

/**
 * Delete a score everywhere. The documents row goes FIRST: one statement
 * takes the score away from every member atomically (members, links,
 * annotations and snapshots cascade), so there is never a moment where the
 * library lists a score whose PDF is already gone. Removing the bytes first —
 * the old order — left exactly that behind whenever the row delete failed.
 *
 * The bytes follow (purgeDocumentStorage), detached: the delete is complete
 * from the teacher's point of view as soon as the row is gone, and the
 * cleanup is half a dozen Storage round trips with no timeout of their own —
 * on a slow phone connection the dialog would otherwise sit on "Deleting…"
 * long after the score was deleted, or forever if Storage hung. A cleanup
 * that fails or never finishes leaves its tombstone, which a later library
 * visit retries.
 */
export const deleteDocument = async (doc: DocumentRow): Promise<DeleteDocumentResult> => {
    noteLibraryMutation();
    const supabase = getSupabase();
    const { data: deleted, error } = await supabase.from('documents').delete().eq('id', doc.id).select('id');
    if (error) {
        throw new Error(`Could not delete: ${error.message}`);
    }
    if (!deleted || deleted.length === 0) {
        // RLS turns a refused delete into zero rows, not an error. Still
        // visible means refused; gone means another device got there first,
        // and the local half below is still ours to finish.
        const { data: still, error: checkError } = await supabase
            .from('documents')
            .select('id')
            .eq('id', doc.id)
            .maybeSingle();
        if (checkError) {
            throw new Error(`Could not delete: ${checkError.message}`);
        }
        if (still) {
            throw new Error('Could not delete: only the score’s owner can delete it.');
        }
    }
    noteLibraryMutationCommitted();
    await clearLocalDocumentCaches(doc.id);
    const storageCleanup = purgeDocumentStorage({
        document_id: doc.id,
        storage_path: doc.storage_path,
        thumb_rev: doc.thumb_rev,
    });
    return { storageCleanup };
};

/**
 * PDF bytes for a cloud doc: Dexie cache first, else storage download (then
 * cache). A cache holding an older content_rev than the fetched row means the
 * file was replaced (smart-import cleanup) — re-download.
 *
 * Every cache touch here is best-effort. We already hold the bytes the caller
 * asked for by the time we try to store them, so a browser that refuses the
 * write (private browsing, no quota) gets the score without an offline copy
 * rather than an unopenable score — which is what a bare `put` cost us.
 */
/** Bytes the caller already holds from the cache, so they are not read (and copied) twice. */
export interface PreloadedBytes {
    bytes: ArrayBuffer;
    contentRev: number;
    archivedAt: string | null;
}

/** A download started before the row was known — see prefetchDocumentBytes. */
export interface BytesPrefetch {
    /** The storage path the download assumed; honoured only if the row agrees. */
    path: string;
    bytes: Promise<ArrayBuffer | null>;
}

/**
 * Start the PDF download in parallel with the row and role fetches. A cold
 * open otherwise pays two round-trips in series — the row for its
 * storage_path, then the bytes — although every score lives at
 * `{id}/original.pdf` (documentRowFromCache already assumes as much). The
 * caller hands this to loadDocumentBytes, which uses the result only if the
 * row's storage_path is the path assumed here. Storage RLS still applies: a
 * caller who cannot see the score gets null, and the row fetch says why.
 */
export const prefetchDocumentBytes = (docId: string): BytesPrefetch => {
    const path = `${docId}/original.pdf`;
    const bytes = getSupabase()
        .storage.from('scores')
        .download(path)
        .then(({ data, error }) => (error || !data ? null : data.arrayBuffer()))
        .catch(() => null);
    return { path, bytes };
};

/**
 * Download a stored score while reporting progress. supabase-js's download()
 * hands back a finished Blob with no progress events, so this reads a
 * short-lived signed URL as a stream instead — the same Storage policies
 * decide whether the URL can be minted at all. `total` is 0 when the server
 * sends no usable Content-Length (compressed responses), which the caller
 * shows as indeterminate.
 */
const downloadScoreWithProgress = async (
    path: string,
    onProgress: (progress: UploadProgress) => void,
): Promise<ArrayBuffer> => {
    const { data, error } = await getSupabase().storage.from('scores').createSignedUrl(path, 60);
    if (error || !data) {
        throw new Error(`Could not download score: ${error?.message ?? 'unknown error'}`);
    }
    const response = await fetch(data.signedUrl);
    if (!response.ok) {
        throw new Error(`Could not download score: HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length'));
    const total = Number.isFinite(declared) && declared > 0 ? declared : 0;
    if (!response.body) {
        const whole = await response.arrayBuffer();
        onProgress({ loaded: whole.byteLength, total: whole.byteLength });
        return whole;
    }
    const reader = response.body.getReader();
    // Written straight into one buffer sized from Content-Length when the
    // server sends it: collecting chunks and joining them at the end holds
    // the PDF twice at the peak, which a large score on iPad Safari can pay
    // for with a reloaded tab. The buffer grows (doubling) only when the
    // length was missing or understated.
    let out = new Uint8Array(total > 0 ? total : 1 << 20);
    let loaded = 0;
    onProgress({ loaded, total });
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (loaded + value.byteLength > out.byteLength) {
            const grown = new Uint8Array(Math.max(out.byteLength * 2, loaded + value.byteLength));
            grown.set(out.subarray(0, loaded));
            out = grown;
        }
        out.set(value, loaded);
        loaded += value.byteLength;
        onProgress({ loaded, total: total >= loaded ? total : 0 });
    }
    onProgress({ loaded, total: loaded });
    return loaded === out.byteLength ? out.buffer : out.slice(0, loaded).buffer;
};

export const loadDocumentBytes = async (
    doc: DocumentRow,
    options: {
        preloaded?: PreloadedBytes;
        prefetch?: BytesPrefetch;
        userId?: string;
        /** Asked for by callers with a progress UI; switches the download to a streamed read. */
        onProgress?: (progress: UploadProgress) => void;
    } = {},
): Promise<ArrayBuffer> => {
    const wantRev = doc.content_rev ?? 0;
    const { preloaded, prefetch, userId, onProgress } = options;
    if (preloaded && preloaded.contentRev >= wantRev) {
        // The warm open already read and materialised these bytes; a second
        // Dexie read would hold a second multi-megabyte copy for nothing.
        if (preloaded.archivedAt !== doc.archived_at) {
            const cached = await getCachedPdf(doc.id);
            if (cached) {
                await putCachedPdf({ ...cached, archivedAt: doc.archived_at });
            }
        }
        return preloaded.bytes;
    }
    const cached = await getCachedPdf(doc.id);
    if (cached && (cached.contentRev ?? 0) >= wantRev) {
        // Refresh the archive flag from the row we were handed, same as fetchMyRole
        // does for the role — an offline open must know the score is read-only.
        if (cached.archivedAt !== doc.archived_at) {
            await putCachedPdf({ ...cached, archivedAt: doc.archived_at });
        }
        return readCachedPdfBytes(cached.bytes);
    }
    // Prefetch left before the row was known. Honour it only for an
    // unreplaced score (content_rev 0): a replace that raced the download
    // would otherwise be cached under the new revision and never re-fetched.
    const prefetched = prefetch && prefetch.path === doc.storage_path && wantRev === 0 ? await prefetch.bytes : null;
    let bytes: ArrayBuffer;
    if (prefetched) {
        bytes = prefetched;
    } else if (onProgress) {
        try {
            bytes = await downloadScoreWithProgress(doc.storage_path, onProgress);
        } catch (err) {
            if (cached) {
                // Same rule as below: a stale copy beats no score at all.
                return readCachedPdfBytes(cached.bytes);
            }
            throw err;
        }
    } else {
        const { data, error } = await getSupabase().storage.from('scores').download(doc.storage_path);
        if (error || !data) {
            if (cached) {
                // Offline with a stale cache beats no score at all.
                return readCachedPdfBytes(cached.bytes);
            }
            throw new Error(`Could not download score: ${error?.message ?? 'unknown error'}`);
        }
        bytes = await data.arrayBuffer();
    }
    await putCachedPdf({
        docId: doc.id,
        bytes,
        title: doc.title,
        cachedAt: new Date().toISOString(),
        myRole: cached?.myRole,
        contentRev: wantRev,
        archivedAt: doc.archived_at,
        userId: userId ?? cached?.userId,
    });
    return bytes;
};

/** Object name (within `{docId}/`) that preserves the pre-import original. */
export const BACKUP_OBJECT_NAME = 'pre-import-original.pdf';

/**
 * Replace a document's stored PDF with a cleaned copy (owner-only via storage
 * RLS). The very first replacement stashes the untouched original next to it
 * (`upsert: false` — a later import can't clobber the true original), then
 * content_rev is bumped so every client re-downloads, and the local cache is
 * refreshed in place.
 */
export const replaceDocumentPdf = async (
    doc: DocumentRow,
    originalBytes: ArrayBuffer,
    newBytes: Uint8Array,
    onProgress?: (progress: UploadProgress) => void,
): Promise<DocumentRow> => {
    noteLibraryMutation();
    const supabase = getSupabase();
    const backupPath = `${doc.id}/${BACKUP_OBJECT_NAME}`;
    const { error: backupError } = await supabase.storage
        .from('scores')
        .upload(backupPath, new Blob([originalBytes], { type: 'application/pdf' }), {
            contentType: 'application/pdf',
            upsert: false,
        });
    if (backupError && !/exist|duplicate/i.test(backupError.message)) {
        throw new Error(`Could not keep a backup of the original: ${backupError.message}`);
    }

    await uploadPdfToStorage(
        doc.storage_path,
        new Blob([newBytes as unknown as BlobPart], { type: 'application/pdf' }),
        onProgress,
    );

    const { data: updated, error: updateError } = await supabase
        .from('documents')
        .update({ content_rev: (doc.content_rev ?? 0) + 1 })
        .eq('id', doc.id)
        .select()
        .single();
    if (updateError) {
        throw new Error(`The cleaned file was saved but the document could not be updated: ${updateError.message}`);
    }
    noteLibraryMutationCommitted();

    const cached = await getCachedPdf(doc.id);
    await putCachedPdf({
        docId: doc.id,
        bytes: newBytes.slice().buffer,
        title: updated.title,
        cachedAt: new Date().toISOString(),
        myRole: cached?.myRole ?? 'owner',
        contentRev: updated.content_rev,
        userId: cached?.userId,
    });

    // The stored bytes changed, so the old first-page render is wrong — the
    // bumped revision makes the service regenerate it.
    void getThumbnail(doc.id, updated.content_rev ?? 0).catch(() => undefined);

    // Best-effort audit row + backup pointer (never blocks the replacement).
    const { error: auditError } = await supabase.from('document_imports').upsert(
        {
            document_id: doc.id,
            status: 'imported',
            backup_path: backupPath,
        },
        { onConflict: 'document_id' },
    );
    if (auditError) {
        console.warn('Import audit row failed', auditError.message);
    }

    return updated;
};
