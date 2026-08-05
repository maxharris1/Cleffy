import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { ErrorCode } from './errors.js';
import { scoreDataSchema, type ScoreData } from './scoreData.js';

/**
 * Result write-back to Supabase. The service holds the service-role key
 * (bypasses RLS) — it is trusted infrastructure, and the score-analyze Edge
 * Function is the only authorization gate for *starting* jobs.
 */

export interface Writeback {
    processing(documentId: string, progress: number): Promise<void>;
    ready(documentId: string, score: ScoreData, engineVersion: string): Promise<void>;
    failed(documentId: string, code: ErrorCode): Promise<void>;
}

let cached: SupabaseClient | null | undefined;

const client = (): SupabaseClient | null => {
    if (cached !== undefined) {
        return cached;
    }
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        console.warn('[writeback] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — results will be dropped');
        cached = null;
        return null;
    }
    cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    return cached;
};

const upsert = async (documentId: string, patch: Record<string, unknown>): Promise<void> => {
    const supabase = client();
    if (!supabase) {
        return;
    }
    const { error } = await supabase
        .from('score_analyses')
        .upsert({ document_id: documentId, ...patch }, { onConflict: 'document_id' });
    if (error) {
        // Doc deleted mid-job (FK gone) or transient — log and drop; the
        // client-side staleness rule turns silence into a retryable state.
        console.warn(`[writeback] ${documentId}: ${error.message}`);
    }
};

/** Heartbeats also refresh updated_at, which the app's staleness rule watches. */
export const supabaseWriteback: Writeback = {
    processing: (documentId, progress) => upsert(documentId, { status: 'processing', progress, error: null }),
    ready: async (documentId, score, engineVersion) => {
        const checked = scoreDataSchema.safeParse(score);
        if (!checked.success) {
            console.warn(
                `[writeback] ${documentId}: ScoreData failed size/schema check`,
                checked.error.issues[0]?.message,
            );
            await upsert(documentId, { status: 'failed', error: 'internal', progress: null });
            return;
        }
        await upsert(documentId, {
            status: 'ready',
            score: checked.data,
            bpm_default: checked.data.defaultBpm,
            engine_version: engineVersion,
            progress: null,
            error: null,
        });
    },
    failed: (documentId, code) => upsert(documentId, { status: 'failed', error: code, progress: null }),
};
