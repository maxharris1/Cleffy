import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { pdfSha256, SharedPdfBlockedError, type PdfCacheDeps, type SharedPdfEntry } from './imslpPdfCache.ts';

/** Service role only. Never accepts user uploads or user-provided provenance. */
export const imslpPdfCacheStore = (admin: SupabaseClient): PdfCacheDeps => ({
    read: async (fileId) => {
        const { data, error } = await admin
            .from('imslp_pdf_cache')
            .select('*')
            .eq('imslp_file_id', fileId)
            .maybeSingle();
        if (error) {
            throw new Error(`Could not read shared IMSLP cache: ${error.message}`);
        }
        if (data) {
            // A block covers the hash even when several edition ids share it.
            const { data: available, error: blockError } = await admin.rpc('is_shared_imslp_pdf', {
                p_path: data.storage_path,
            });
            if (blockError) {
                throw new Error(`Could not check shared IMSLP block: ${blockError.message}`);
            }
            if (available !== true) {
                throw new SharedPdfBlockedError('This edition is unavailable for import');
            }
        }
        return data as SharedPdfEntry | null;
    },
    claim: async (fileId, token) => {
        const { data, error } = await admin.rpc('claim_imslp_pdf', { p_file_id: fileId, p_token: token });
        if (error) {
            throw new Error(`Could not claim shared IMSLP download: ${error.message}`);
        }
        return data === true;
    },
    release: async (fileId, token) => {
        const { error } = await admin.rpc('release_imslp_pdf', { p_file_id: fileId, p_token: token });
        if (error) {
            throw new Error(error.message);
        }
    },
    upload: async (path, bytes) => {
        const bucket = admin.storage.from('scores');
        const { error } = await bucket.upload(path, bytes, { contentType: 'application/pdf', upsert: false });
        if (!error) {
            return;
        }
        // Different file IDs can contain identical bytes, or a previous worker
        // may have crashed after upload. A lost upload response also leaves an
        // uncertain outcome. Reuse only an existing object with identical bytes,
        // independent of which status this Storage version uses for duplicates.
        const expectedHash = path.slice(path.lastIndexOf('/') + 1, -4);
        for (let attempt = 0; attempt < 2; attempt++) {
            const { data: existing, error: readError } = await bucket.download(path);
            if (!readError && existing) {
                if (
                    existing.size === bytes.byteLength &&
                    (await pdfSha256(new Uint8Array(await existing.arrayBuffer()))) === expectedHash
                ) {
                    return;
                }
                break;
            }
            // A concurrent identical upload may not yet be committed in Storage.
            if (attempt === 0) {
                await new Promise((resolve) => setTimeout(resolve, 150));
            }
        }
        throw new Error(`Shared IMSLP upload failed integrity verification: ${error.message}`);
    },
    publish: async (entry, token) => {
        const { error } = await admin.rpc('publish_imslp_pdf', { p_entry: entry, p_token: token });
        if (error) {
            if (error.code === '42501') {
                throw new SharedPdfBlockedError('This edition is unavailable for import');
            }
            throw new Error(`Could not publish shared IMSLP PDF: ${error.message}`);
        }
    },
});
