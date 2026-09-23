import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { claimMaxPriority } from './claimPriority.js';
import type { ErrorCode } from './errors.js';
import { serviceClient } from './supabaseClient.js';
import { scoreDataSchema, type ScoreData } from './scoreData.js';
import type { JobTimings } from './timings.js';

const LEASE_SECONDS = 300;

const omJobRowSchema = z.object({
    id: z.number(),
    document_id: z.string().uuid(),
    status: z.string(),
    attempt: z.number(),
    max_attempts: z.number(),
    storage_path: z.string(),
    page_count: z.number(),
    created_by: z.string().uuid().nullable(),
});

export type OmJobRow = z.infer<typeof omJobRowSchema>;

export const newWorkerId = (): string => randomUUID();

const asRow = (data: unknown): OmJobRow | null => {
    const raw = Array.isArray(data) ? data[0] : data;
    const parsed = omJobRowSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
};

/** Reap expired leases at the top of each poke (Scheduler fallback path). */
export const reapExpiredLeases = async (): Promise<number> => {
    const supabase = serviceClient();
    if (!supabase) {
        return 0;
    }
    const { data, error } = await supabase.rpc('omr_reap_expired_leases');
    if (error) {
        console.warn('[jobStore] reap failed:', error.message);
        return 0;
    }
    return typeof data === 'number' ? data : 0;
};

/** Seed pools fail closed while paused or if the control row cannot be read. */
const seedPoolMayRun = async (
    supabase: NonNullable<ReturnType<typeof serviceClient>>,
    maxPriority: number | null,
): Promise<boolean> => {
    if (maxPriority === null || maxPriority >= 0) {
        return true;
    }
    const { data, error } = await supabase
        .from('playalong_corpus_control')
        .select('paused')
        .eq('singleton', true)
        .maybeSingle();
    return !error && data?.paused === false;
};

/**
 * Claim ≤1 queued job. `maxPriority` (default: CLEFFY_CLAIM_MAX_PRIORITY) limits
 * the claim to rows with `priority <= maxPriority`; null claims anything. The
 * parameter is only sent when set, so an unfiltered worker keeps calling the
 * RPC exactly as before the migration that added `p_max_priority`.
 */
export const claimJob = async (
    workerId: string,
    maxPriority: number | null = claimMaxPriority(),
): Promise<OmJobRow | null> => {
    const supabase = serviceClient();
    if (!supabase) {
        return null;
    }
    if (!(await seedPoolMayRun(supabase, maxPriority))) {
        return null;
    }
    const { data, error } = await supabase.rpc('omr_claim_job', {
        p_worker_id: workerId,
        p_lease_seconds: LEASE_SECONDS,
        ...(maxPriority !== null ? { p_max_priority: maxPriority } : {}),
    });
    if (error) {
        console.warn('[jobStore] claim failed:', error.message);
        return null;
    }
    return asRow(data);
};

export const heartbeatJob = async (jobId: number, workerId: string): Promise<boolean> => {
    const supabase = serviceClient();
    if (!supabase) {
        return false;
    }
    const { data, error } = await supabase.rpc('omr_heartbeat_job', {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_lease_seconds: LEASE_SECONDS,
    });
    if (error) {
        console.warn('[jobStore] heartbeat failed:', error.message);
        return false;
    }
    return data === true;
};

/** True if this worker still owns a running lease (used after complete RPC fails). */
export const stillOwnsJob = async (jobId: number, workerId: string): Promise<boolean> => {
    const supabase = serviceClient();
    if (!supabase) {
        return false;
    }
    const { data, error } = await supabase
        .from('omr_jobs')
        .select('id')
        .eq('id', jobId)
        .eq('status', 'running')
        .eq('worker_id', workerId)
        .maybeSingle();
    if (error) {
        return false;
    }
    return Boolean(data);
};

export const completeJob = async (
    jobId: number,
    workerId: string,
    score: ScoreData,
    engineVersion: string,
    timings: JobTimings,
): Promise<boolean> => {
    const supabase = serviceClient();
    if (!supabase) {
        return false;
    }
    const checked = scoreDataSchema.safeParse(score);
    if (!checked.success) {
        console.warn('[jobStore] complete: ScoreData schema failed', checked.error.issues[0]?.message);
        return false;
    }
    const { data, error } = await supabase.rpc('omr_complete_job', {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_score: checked.data,
        p_bpm_default: checked.data.defaultBpm,
        p_engine_version: engineVersion,
        p_timings: timings,
    });
    if (error) {
        console.warn('[jobStore] complete failed:', error.message);
        return false;
    }
    return data === true;
};

/**
 * Return a claimed job to `queued` without failing it (symbolic-only drain:
 * Mutopia MIDI miss should wait for OMR, not burn attempts or start Audiveris).
 * No-op if this worker no longer holds the running lease.
 */
export const releaseJob = async (jobId: number, workerId: string, reason: string): Promise<boolean> => {
    const supabase = serviceClient();
    if (!supabase) {
        return false;
    }
    const runAfter = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
        .from('omr_jobs')
        .update({
            status: 'queued',
            worker_id: null,
            claimed_at: null,
            lease_expires_at: null,
            last_error: reason,
            run_after: runAfter,
        })
        .eq('id', jobId)
        .eq('worker_id', workerId)
        .eq('status', 'running')
        .select('id');
    if (error) {
        console.warn('[jobStore] release failed:', error.message);
        return false;
    }
    return Array.isArray(data) && data.length > 0;
};

/** Permanence / backoff decided entirely in SQL. */
export const failJob = async (jobId: number, workerId: string, code: ErrorCode): Promise<string | null> => {
    const supabase = serviceClient();
    if (!supabase) {
        return null;
    }
    const { data, error } = await supabase.rpc('omr_fail_job', {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_error: code,
    });
    if (error) {
        console.warn('[jobStore] fail failed:', error.message);
        return null;
    }
    return typeof data === 'string' ? data : null;
};

export const mintSignedUrl = async (storagePath: string): Promise<string | null> => {
    const supabase = serviceClient();
    if (!supabase) {
        return null;
    }
    const { data, error } = await supabase.storage.from('scores').createSignedUrl(storagePath, 3600);
    if (error || !data?.signedUrl) {
        console.warn('[jobStore] sign failed:', error?.message);
        return null;
    }
    return data.signedUrl;
};

export const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export const cacheLookup = async (
    contentHash: string,
    engineVersion: string,
): Promise<{ score: ScoreData; bpmDefault: number | null } | null> => {
    const supabase = serviceClient();
    if (!supabase) {
        return null;
    }
    const { data, error } = await supabase.rpc('score_cache_get', {
        p_hash: contentHash,
        p_engine_version: engineVersion,
    });
    if (error) {
        console.warn('[jobStore] cache get failed:', error.message);
        return null;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.score) {
        return null;
    }
    const checked = scoreDataSchema.safeParse(row.score);
    if (!checked.success) {
        return null;
    }
    return {
        score: checked.data,
        bpmDefault: typeof row.bpm_default === 'number' ? row.bpm_default : checked.data.defaultBpm,
    };
};

export const cacheStore = async (contentHash: string, engineVersion: string, score: ScoreData): Promise<void> => {
    const supabase = serviceClient();
    if (!supabase) {
        return;
    }
    const { error } = await supabase.rpc('score_cache_put', {
        p_hash: contentHash,
        p_engine_version: engineVersion,
        p_score: score,
        p_bpm_default: score.defaultBpm,
    });
    if (error) {
        console.warn('[jobStore] cache put failed:', error.message);
    }
};

/**
 * Fan-out decision for pokeSelf. Must apply the same priority filter as
 * claimJob: a seed instance that counted user rows would wake another seed
 * instance that then claims nothing.
 */
export const hasQueuedWork = async (maxPriority: number | null = claimMaxPriority()): Promise<boolean> => {
    const supabase = serviceClient();
    if (!supabase) {
        return false;
    }
    if (!(await seedPoolMayRun(supabase, maxPriority))) {
        return false;
    }
    let query = supabase
        .from('omr_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'queued')
        .lte('run_after', new Date().toISOString());
    if (maxPriority !== null) {
        query = query.lte('priority', maxPriority);
    }
    const { count, error } = await query;
    if (error) {
        return false;
    }
    return (count ?? 0) > 0;
};
