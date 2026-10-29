import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { pdfSha256, type PdfCacheDeps, type SharedPdfEntry } from './imslpPdfCache.ts';

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
        const { data: existing, error: readError } = await bucket.download(path);
        if (
            readError ||
            !existing ||
            existing.size !== bytes.byteLength ||
            (await pdfSha256(new Uint8Array(await existing.arrayBuffer()))) !== (await pdfSha256(bytes))
        ) {
            throw new Error(`Shared IMSLP upload failed integrity verification: ${error.message}`);
        }
    },
    publish: async (entry, token) => {
        const { error } = await admin.rpc('publish_imslp_pdf', { p_entry: entry, p_token: token });
        if (error) {
            throw new Error(`Could not publish shared IMSLP PDF: ${error.message}`);
        }
    },
});
