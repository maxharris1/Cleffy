import { parseTimingsExtras } from '@/features/playback/analysisSource';
import { eraOfTitle, type Era } from '@/features/playback/era';
import { getSupabase } from '@/lib/supabase';
import { getDb } from '@/sync/db';
import type { CachedScoreAnalysis } from '@/sync/db';
import type { ScoreAnalysisStatus } from '@/types/database';
import { parseScoreData } from '@/types/scoreData';

/**
 * Client access to score_analyses. Free-plan discipline: polling reads the
 * lifecycle columns only — the ScoreData jsonb travels once, when the row is
 * ready, and then lives in the Dexie scoreCache for offline replays.
 */

export interface ScoreAnalysisStatusRow {
    status: ScoreAnalysisStatus;
    error: string | null;
    progress: number | null;
    updatedAt: string;
}

/**
 * The svc-<n> this client expects. Keep in step with ENGINE_VERSION in
 * services/omr-service/src/job.ts: an analysis produced by an older engine
 * still plays, but is missing whatever that bump added, and nothing else in
 * the system ever re-runs it — so the reader has to be offered the choice.
 *
 * This number follows the service's only when the bump changed what a score
 * SOUNDS like. svc-6 was page sharding — the same PDF in, byte-for-byte the
 * same ScoreData out, only sooner — so it deliberately stayed behind at 5
 * rather than asking every reader to regenerate an identical analysis. svc-7
 * (D.C./D.S. roadmaps, the tempo map surviving a shard merge, pedal) changes
 * the performance, so it is worth the interruption. svc-8 seeds expression
 * across the page-cut seam, which changes what every 4+ page score sounds like.
 * svc-9 realises ornaments, appoggiaturas, tempo-relative graces and swing.
 * svc-10 is the Audiveris 5.11.0 recognizer — a new engine changes what a PDF sounds like.
 * svc-11 carries voices, infers pedal for unmarked scores and repairs misread bars (ScoreData v5).
 * svc-12: auto-pedal only for wholly unmarked scores; per-voice dynamics survive a
 * mark-less shard B; era stamped on the analysis.
 * svc-13 restores dropped tuplets, repairs single-staff key misreads, fills ghost
 * parts, and zips geometry per system so the playhead stays on the bar.
 * svc-14 skips staff-less cover/blank pages instead of failing the book.
 * svc-34 is the raster-honest OMR image (patches 0001-0004 and 0007): octave G
 * clefs, ottava ink, tuplet brackets, ledger heads, and ledger-fragment dots.
 * DEPLOYED_ENGINE_GENERATION stays 6 until Cloud Run ships this image.
 */
export const CURRENT_ENGINE_GENERATION = 34;

/**
 * The svc-<n> the DEPLOYED worker can actually produce. The OMR deploy fires
 * only on main, so this client routinely ships understanding generations the
 * live Cloud Run cannot write yet. A regenerate offer gated on
 * CURRENT_ENGINE_GENERATION alone is then a paid no-op: the click spends one
 * of the reader's metered omr_runs, the old engine answers from its cache with
 * the very row that prompted the offer, and the banner comes straight back.
 * So the offer is capped at this number, and this number moves only in the
 * release that ships the matching OMR image. `/healthz` reports ENGINE_VERSION
 * so score-analyze can refuse a charge even if this constant lags.
 */
export const DEPLOYED_ENGINE_GENERATION = 6;

/** First generation whose output depends on the document title's era. */
export const ERA_AWARE_ENGINE_GENERATION = 11;

export const engineGeneration = (engineVersion: string | null): number | null => {
    const match = /\+svc-(\d+)$/.exec(engineVersion ?? '');
    if (!match?.[1]) {
        return null;
    }
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
};

export interface AnalysisStaleOptions {
    /** Era stamped on the stored ScoreData, if any. */
    era?: Era | null;
    /** Live document title, used to re-derive the era. */
    title?: string | null;
}

/**
 * True when this analysis predates the current engine AND the deployed worker
 * could actually better it, or when the title's era no longer matches the
 * stamp and the deployed worker is era-aware. A re-run is only ever offered
 * when clicking the button produces something newer than what the reader already has.
 */
export const analysisIsStaleAgainst = (
    engineVersion: string | null,
    offerableGeneration: number,
    options: AnalysisStaleOptions = {},
): boolean => {
    const generation = engineGeneration(engineVersion);
    const engineStale = generation === null || generation < offerableGeneration;
    const stamped = options.era;
    const eraStale =
        offerableGeneration >= ERA_AWARE_ENGINE_GENERATION &&
        stamped !== undefined &&
        stamped !== null &&
        eraOfTitle(options.title) !== stamped;
    return engineStale || eraStale;
};

export const analysisIsStale = (engineVersion: string | null, options: AnalysisStaleOptions = {}): boolean =>
    analysisIsStaleAgainst(
        engineVersion,
        Math.min(CURRENT_ENGINE_GENERATION, DEPLOYED_ENGINE_GENERATION),
        options,
    );

/** A processing row untouched for this long is a lost job (service died/recycled). */
export const STALE_PROCESSING_MS = 20 * 60 * 1000;

export const isProcessingStale = (updatedAt: string): boolean =>
    Date.now() - new Date(updatedAt).getTime() > STALE_PROCESSING_MS;

/** Lifecycle-only poll — never pulls the jsonb. Null = no analysis row yet. */
export const fetchScoreAnalysisStatus = async (docId: string): Promise<ScoreAnalysisStatusRow | null> => {
    const { data, error } = await getSupabase()
        .from('score_analyses')
        .select('status, error, progress, updated_at')
        .eq('document_id', docId)
        .maybeSingle();
    if (error) {
        throw new Error(`Could not check play-along status: ${error.message}`);
    }
    if (!data) {
        return null;
    }
    return { status: data.status, error: data.error, progress: data.progress, updatedAt: data.updated_at };
};

/** How long an IMSLP import waits on its panel for a worker before opening the score anyway. */
export const QUEUE_WAIT_CAP_MS = 20_000;
const QUEUE_POLL_MS = 2_000;

export interface QueueWaitOptions {
    capMs?: number;
    intervalMs?: number;
    /**
     * Fired once, the first time a poll taken at least one interval in still
     * finds the row `pending` — i.e. the job is genuinely waiting for a worker.
     * A job claimed (or finished, e.g. a corpus hit) before then never fires it.
     */
    onQueued?: () => void;
}

/**
 * Resolve once the analysis row is no longer `pending` (a worker claimed it,
 * it finished, or it failed), or after `capMs` so nobody is parked on the
 * panel behind a slow queue. Status reads are lifecycle columns only; a
 * transient read error just waits for the next tick.
 */
export const waitForAnalysisToLeaveQueue = async (
    docId: string,
    { capMs = QUEUE_WAIT_CAP_MS, intervalMs = QUEUE_POLL_MS, onQueued }: QueueWaitOptions = {},
): Promise<ScoreAnalysisStatus | null> => {
    const started = Date.now();
    const deadline = started + capMs;
    let queuedReported = false;
    for (;;) {
        const status = await fetchScoreAnalysisStatus(docId).catch(() => null);
        if (status && status.status !== 'pending') {
            return status.status;
        }
        if (status?.status === 'pending' && !queuedReported && Date.now() - started >= intervalMs) {
            queuedReported = true;
            onQueued?.();
        }
        if (Date.now() >= deadline) {
            return status?.status ?? null;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, deadline - Date.now())));
    }
};

/** Full row (including ScoreData), validated and mirrored into the Dexie cache. */
export const fetchScoreAnalysisFull = async (docId: string): Promise<CachedScoreAnalysis | null> => {
    const { data, error } = await getSupabase()
        .from('score_analyses')
        .select('*')
        .eq('document_id', docId)
        .maybeSingle();
    if (error) {
        throw new Error(`Could not load play-along data: ${error.message}`);
    }
    if (!data) {
        return null;
    }
    const previous = await getDb().scoreCache.get(docId);
    const extras = parseTimingsExtras((data as { timings?: unknown }).timings);
    const cached: CachedScoreAnalysis = {
        docId,
        status: data.status,
        error: data.error,
        score: data.score ? parseScoreData(data.score) : null,
        engineVersion: data.engine_version,
        bpmDefault: data.bpm_default,
        fetchedAt: new Date().toISOString(),
        ...(previous?.bpmOverride !== undefined ? { bpmOverride: previous.bpmOverride } : {}),
        ...(extras.source ? { source: extras.source } : {}),
        ...(extras.alignmentMap ? { alignmentMap: extras.alignmentMap } : {}),
        ...(extras.corpusHit ? { corpusHit: extras.corpusHit } : {}),
    };
    await getDb().scoreCache.put(cached);
    return cached;
};

export const loadCachedScoreAnalysis = async (docId: string): Promise<CachedScoreAnalysis | null> => {
    return (await getDb().scoreCache.get(docId)) ?? null;
};

/** Remember the user's practice tempo for this score across sessions. */
export const saveBpmOverride = async (docId: string, bpm: number): Promise<void> => {
    const cached = await getDb().scoreCache.get(docId);
    if (cached) {
        await getDb().scoreCache.put({ ...cached, bpmOverride: bpm });
    }
};

export interface RequestAnalysisResult {
    ok: boolean;
    /** Machine code when not ok (e.g. already_running, too_large, service_unreachable). */
    code?: string;
}

/** Kick off (or retry) analysis via the score-analyze Edge Function. */
export const requestScoreAnalysis = async (docId: string): Promise<RequestAnalysisResult> => {
    const { data, error } = await getSupabase().functions.invoke<{ ok: boolean; code?: string }>('score-analyze', {
        body: { documentId: docId },
    });
    if (error) {
        const context = (error as { context?: Response }).context;
        if (context) {
            try {
                const body = (await context.json()) as { code?: string };
                if (typeof body.code === 'string') {
                    return { ok: false, code: body.code };
                }
            } catch {
                // fall through
            }
            // The per-user limiter answers 429 with `retryAfterSec` and no
            // machine code — it is not the service being down.
            if (context.status === 429) {
                return { ok: false, code: 'rate_limited' };
            }
        }
        return { ok: false, code: 'service_unreachable' };
    }
    if (data && data.ok === false) {
        return { ok: false, code: data.code ?? 'internal' };
    }
    return { ok: true };
};
