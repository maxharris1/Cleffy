import { serviceClient } from './supabaseClient.js';
import type { ErrorCode } from './errors.js';
import type { JobTimings } from './timings.js';
import { scoreDataSchema, type ScoreData } from './scoreData.js';

/**
 * Result write-back to Supabase. Pull-mode completion goes through
 * omr_complete_job / omr_fail_job RPCs. Processing heartbeats still upsert
 * score_analyses directly. Push-mode (/jobs) keeps using ready/failed here.
 */

export interface Writeback {
    processing(documentId: string, progress: number): Promise<void>;
    ready(documentId: string, score: ScoreData, engineVersion: string, timings?: JobTimings): Promise<void>;
    failed(documentId: string, code: ErrorCode): Promise<void>;
}

const upsert = async (documentId: string, patch: Record<string, unknown>): Promise<void> => {
    const supabase = serviceClient();
    if (!supabase) {
        return;
    }
    const { error } = await supabase
        .from('score_analyses')
        .upsert({ document_id: documentId, ...patch }, { onConflict: 'document_id' });
    if (error) {
        console.warn(`[writeback] ${documentId}: ${error.message}`);
    }
};

export const supabaseWriteback: Writeback = {
    processing: async (documentId, progress) => {
        const supabase = serviceClient();
        if (!supabase) {
            return;
        }
        // Never clobber ready/failed — late fire-and-forget progress must not revive terminal rows.
        const { error } = await supabase
            .from('score_analyses')
            .update({ status: 'processing', progress, error: null })
            .eq('document_id', documentId)
            .in('status', ['pending', 'processing']);
        if (error) {
            console.warn(`[writeback] ${documentId}: ${error.message}`);
        }
    },
    ready: async (documentId, score, engineVersion, timings) => {
        const checked = scoreDataSchema.safeParse(score);
        if (!checked.success) {
            console.warn(
                `[writeback] ${documentId}: ScoreData failed size/schema check`,
                checked.error.issues[0]?.message,
            );
            await upsert(documentId, { status: 'failed', error: 'internal', progress: null });
            return;
        }
        const started = Date.now();
        await upsert(documentId, {
            status: 'ready',
            score: checked.data,
            bpm_default: checked.data.defaultBpm,
            engine_version: engineVersion,
            progress: null,
            error: null,
            ...(timings ? { timings } : {}),
        });
        if (timings) {
            timings.writebackMs = Date.now() - started;
        }
    },
    failed: (documentId, code) => upsert(documentId, { status: 'failed', error: code, progress: null }),
};
