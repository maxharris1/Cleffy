import { importImslpPdfToStorage, type ImslpDownloadFallback } from '@/features/imslp/imslpApi';
import { prepareUploadFile } from '@/features/import/prepareUpload';
import { uploadPdfToStorage, type UploadProgress } from '@/lib/storageUpload';
import { getSupabase } from '@/lib/supabase';
import { getDb } from '@/sync/db';
import type { DocumentRow, MemberRole } from '@/types/database';

/** Cloud document ids are plain UUIDs; local-only docs use the 'local-' prefix. */
export const isCloudDocId = (docId: string): boolean => {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(docId);
};

export const LIBRARY_PAGE_SIZE = 100;

export const listDocuments = async (): Promise<{ documents: DocumentRow[]; hasMore: boolean }> => {
    const { data, error } = await getSupabase()
        .from('documents')
        .select('id, owner_id, title, storage_path, page_count, content_rev, created_at, updated_at')
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
        const cached = await getDb().pdfCache.get(docId);
        if (cached && cached.myRole !== role) {
            await getDb().pdfCache.put({ ...cached, myRole: role });
        }
    }
    return role;
};

export interface OfflineDocFallback {
    doc: DocumentRow;
    role: MemberRole;
    bytes: ArrayBuffer;
}

export const documentRowFromCache = (cached: {
    id: string;
    title: string;
    cachedAt: string;
    contentRev?: number;
}): DocumentRow => ({
    id: cached.id,
    owner_id: '',
    title: cached.title,
    storage_path: `${cached.id}/original.pdf`,
    page_count: null,
    content_rev: cached.contentRev ?? 0,
    created_at: cached.cachedAt,
    updated_at: cached.cachedAt,
});

/**
 * Open a previously-cached document without the network: synthesizes the
 * document row from the cache and uses the last-known role (defaulting to
 * editor — worst case an offline viewer's edits are rejected and repaired at
 * flush time by RLS).
 */
export const loadDocumentOffline = async (docId: string): Promise<OfflineDocFallback | null> => {
    const cached = await getDb().pdfCache.get(docId);
    if (!cached) {
        return null;
    }
    return {
        doc: documentRowFromCache({ id: docId, title: cached.title, cachedAt: cached.cachedAt }),
        role: cached.myRole ?? 'editor',
        bytes: await cached.bytes.arrayBuffer(),
    };
};

/** Cached scores for the offline library view. */
export const listCachedDocuments = async (): Promise<DocumentRow[]> => {
    const rows = await getDb().pdfCache.toArray();
    return rows
        .filter((row) => isCloudDocId(row.docId))
        .map((row) => documentRowFromCache({ id: row.docId, title: row.title, cachedAt: row.cachedAt }))
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
};

/** Count pages client-side (pdf.js) so the library can show it up front. */
const countPdfPages = async (bytes: ArrayBuffer): Promise<number | null> => {
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
        throw new Error(`Could not create document: ${insertError.message}`);
    }

    try {
        await uploadPdfToStorage(storagePath, file, onProgress);
    } catch (err) {
        await supabase.from('documents').delete().eq('id', id);
        throw err;
    }

    const bytes = await file.arrayBuffer();
    const pageCount = await countPdfPages(bytes);
    if (pageCount !== null) {
        await supabase.from('documents').update({ page_count: pageCount }).eq('id', id);
    }

    // Seed the offline cache immediately — no need to re-download what we just sent.
    await getDb().pdfCache.put({
        docId: id,
        bytes: new Blob([bytes], { type: 'application/pdf' }),
        title,
        cachedAt: new Date().toISOString(),
    });

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
): Promise<{ ok: true; document: DocumentRow } | { ok: false; fallback: ImslpDownloadFallback }> => {
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
        throw new Error(`Could not create document: ${insertError.message}`);
    }

    const rollback = async () => {
        await supabase.storage
            .from('scores')
            .remove([storagePath])
            .catch(() => undefined);
        await supabase.from('documents').delete().eq('id', id);
    };

    try {
        const result = await importImslpPdfToStorage(imslpFilename, id, true);
        if (!result.ok) {
            await rollback();
            return { ok: false, fallback: result };
        }

        const bytes = await loadDocumentBytes({ ...document, page_count: null });
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
        return;
    }
    const { error } = await supabase.from('document_favorites').delete().eq('document_id', docId).eq('user_id', userId);
    if (error) {
        throw new Error(`Could not remove favorite: ${error.message}`);
    }
};

export const renameDocument = async (docId: string, title: string): Promise<void> => {
    const { error } = await getSupabase().from('documents').update({ title }).eq('id', docId);
    if (error) {
        throw new Error(`Could not rename: ${error.message}`);
    }
    const db = getDb();
    const cached = await db.pdfCache.get(docId);
    if (cached) {
        await db.pdfCache.put({ ...cached, title });
    }
};

/**
 * Delete a score everywhere. Storage objects FIRST — their RLS needs the
 * owner membership that dies with the documents row (FK cascade) — then the
 * row (members/links/annotations/snapshots cascade), then every local cache.
 * The whole `{id}/` folder is listed so import backups don't leak.
 */
export const deleteDocument = async (doc: DocumentRow): Promise<void> => {
    const supabase = getSupabase();
    const { data: objects } = await supabase.storage.from('scores').list(doc.id);
    const paths = (objects ?? []).map((o) => `${doc.id}/${o.name}`);
    const { error: storageError } = await supabase.storage
        .from('scores')
        .remove(paths.length > 0 ? paths : [doc.storage_path]);
    if (storageError) {
        throw new Error(`Could not delete the PDF: ${storageError.message}`);
    }
    const { error } = await supabase.from('documents').delete().eq('id', doc.id);
    if (error) {
        throw new Error(`Could not delete: ${error.message}`);
    }
    const db = getDb();
    await Promise.all([
        db.pdfCache.delete(doc.id),
        db.syncState.delete(doc.id),
        db.annotations.where('docId').equals(doc.id).delete(),
        db.ops.where('docId').equals(doc.id).delete(),
        db.annotationSnapshots.where('docId').equals(doc.id).delete(),
        db.scoreCache.delete(doc.id),
    ]);
};

/**
 * PDF bytes for a cloud doc: Dexie cache first, else storage download (then
 * cache). A cache holding an older content_rev than the fetched row means the
 * file was replaced (smart-import cleanup) — re-download.
 */
export const loadDocumentBytes = async (doc: DocumentRow): Promise<ArrayBuffer> => {
    const db = getDb();
    const cached = await db.pdfCache.get(doc.id);
    const wantRev = doc.content_rev ?? 0;
    if (cached && (cached.contentRev ?? 0) >= wantRev) {
        return cached.bytes.arrayBuffer();
    }
    const { data, error } = await getSupabase().storage.from('scores').download(doc.storage_path);
    if (error || !data) {
        if (cached) {
            // Offline with a stale cache beats no score at all.
            return cached.bytes.arrayBuffer();
        }
        throw new Error(`Could not download score: ${error?.message ?? 'unknown error'}`);
    }
    await db.pdfCache.put({
        docId: doc.id,
        bytes: data,
        title: doc.title,
        cachedAt: new Date().toISOString(),
        myRole: cached?.myRole,
        contentRev: wantRev,
    });
    return data.arrayBuffer();
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

    const db = getDb();
    const cached = await db.pdfCache.get(doc.id);
    await db.pdfCache.put({
        docId: doc.id,
        bytes: new Blob([newBytes as unknown as BlobPart], { type: 'application/pdf' }),
        title: updated.title,
        cachedAt: new Date().toISOString(),
        myRole: cached?.myRole ?? 'owner',
        contentRev: updated.content_rev,
    });

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
