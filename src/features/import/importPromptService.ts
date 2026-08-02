import { getSupabase } from '@/lib/supabase';
import type { ImportStatusValue } from '@/types/database';

/**
 * Cross-device memory for the post-upload "make existing marks editable?"
 * offer, backed by the document_imports table (one row per document). All
 * best-effort: a failed read/write only means the prompt may show again.
 */

/** True when no offer has been made or resolved for this document yet. */
export const shouldOfferImport = async (docId: string): Promise<boolean> => {
    try {
        const { data, error } = await getSupabase()
            .from('document_imports')
            .select('status')
            .eq('document_id', docId)
            .maybeSingle();
        if (error) {
            return false;
        }
        return data === null;
    } catch {
        return false;
    }
};

export const recordImportStatus = async (docId: string, status: ImportStatusValue): Promise<void> => {
    try {
        const { error } = await getSupabase()
            .from('document_imports')
            .upsert({ document_id: docId, status }, { onConflict: 'document_id' });
        if (error) {
            console.warn('Could not record import status', error.message);
        }
    } catch (err) {
        console.warn('Could not record import status', err);
    }
};
