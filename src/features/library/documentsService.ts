import { importImslpPdfToStorage, type ImslpDownloadFallback } from '@/features/imslp/imslpApi';
import { prepareUploadFile } from '@/features/import/prepareUpload';
import { getThumbnail } from '@/features/library/thumbnailService';
import { uploadPdfToStorage, type UploadProgress } from '@/lib/storageUpload';
import { getSupabase } from '@/lib/supabase';
import { noteLibraryMutationCommitted, noteLibraryMutation } from '@/features/library/libraryCache';
import { parsePostgrestLimitError } from '@/features/billing/limitErrors';
import { getDb } from '@/sync/db';
import { getCachedPdf, putCachedPdf, readCachedPdfBytes } from '@/sync/pdfCache';
import type { DocumentRow, MemberRole } from '@/types/database';

/** Cloud document ids are plain UUIDs; local-only docs use the 'local-' prefix. */
export const isCloudDocId = (docId: string): boolean => {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(docId);
};

export const LIBRARY_PAGE_SIZE = 100;

export const listDocuments = async (): Promise<{ documents: DocumentRow[]; hasMore: boolean }> => {
    const { data, error } = await getSupabase()
        .from('documents')
        .select(
            'id, owner_id, title, storage_path, page_count, content_rev, thumb_rev, created_at, updated_at, archived_at',
        )
        .order('updated_at', { ascending: false })
        .limit(LIBRARY_PAGE_SIZE + 1);
    if (error) {
        throw new Error(`Could not load documents: ${error.message}`);
    }
    const hasMore = data.length > LIBRARY_PAGE_SIZE;
    return { documents: hasMore ? data.slice(0, LIBRARY_PAGE_SIZE) : data, hasMore };
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

/**
 * Delete a score everywhere. Storage objects FIRST — their RLS needs the
 * owner membership that dies with the documents row (FK cascade) — then the
 * row (members/links/annotations/snapshots cascade), then every local cache.
 * The whole `{id}/` folder is listed so import backups don't leak.
 */
export const deleteDocument = async (doc: DocumentRow): Promise<void> => {
    noteLibraryMutation();
    const supabase = getSupabase();
    const { data: objects } = await supabase.storage.from('scores').list(doc.id);
    const paths = (objects ?? []).map((o) => `${doc.id}/${o.name}`);
    const { error: storageError } = await supabase.storage
        .from('scores')
        .remove(paths.length > 0 ? paths : [doc.storage_path]);
    if (storageError) {
        throw new Error(`Could not delete the PDF: ${storageError.message}`);
    }
    // Published covers live in their own bucket under the same folder. Best
    // effort: an orphaned 40 KB image must not stop the delete, and the row's
    // cascade already makes it unreachable. list() can be refused — still
    // remove the stamped revision, same as scores falling back to storage_path.
    try {
        const knownCover = doc.thumb_rev != null ? [`${doc.id}/${doc.thumb_rev}.jpg`] : [];
        const { data: covers } = await supabase.storage.from('thumbnails').list(doc.id);
        const listed = (covers ?? []).map((o) => `${doc.id}/${o.name}`);
        const coverPaths = [...new Set([...knownCover, ...listed])];
        if (coverPaths.length > 0) {
            await supabase.storage.from('thumbnails').remove(coverPaths);
        }
    } catch {
        // See above.
    }
    const { error } = await supabase.from('documents').delete().eq('id', doc.id);
    if (error) {
        throw new Error(`Could not delete: ${error.message}`);
    }
    noteLibraryMutationCommitted();
    const db = getDb();
    await Promise.all([
        db.pdfCache.delete(doc.id),
        db.syncState.delete(doc.id),
        db.annotations.where('docId').equals(doc.id).delete(),
        db.ops.where('docId').equals(doc.id).delete(),
        db.annotationSnapshots.where('docId').equals(doc.id).delete(),
        db.scoreCache.delete(doc.id),
        db.thumbnails.delete(doc.id),
    ]);
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

export const loadDocumentBytes = async (
    doc: DocumentRow,
    options: { preloaded?: PreloadedBytes; prefetch?: BytesPrefetch; userId?: string } = {},
): Promise<ArrayBuffer> => {
    const wantRev = doc.content_rev ?? 0;
    const { preloaded, prefetch, userId } = options;
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
    const prefetched =
        prefetch && prefetch.path === doc.storage_path && wantRev === 0 ? await prefetch.bytes : null;
    let bytes: ArrayBuffer;
    if (prefetched) {
        bytes = prefetched;
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
