import { useCallback, useEffect, useRef, useState } from 'react';

import type { AlignmentMap, AnalysisSource } from '@/features/playback/analysisSource';
import {
    fetchScoreAnalysisFull,
    fetchScoreAnalysisStatus,
    isProcessingStale,
    loadCachedScoreAnalysis,
    requestScoreAnalysis,
} from '@/features/playback/scoreAnalysisService';
import type { CachedScoreAnalysis } from '@/sync/db';
import type { ScoreAnalysisBroadcast } from '@/sync/wire';
import type { ScoreData } from '@/types/scoreData';

export type ScoreAnalysisState =
    | { kind: 'unavailable' } // local doc, offline without cache, …
    | { kind: 'none' } // no analysis requested yet
    | { kind: 'pending' }
    | { kind: 'processing'; progress: number | null }
    | {
          kind: 'ready';
          score: ScoreData;
          bpmDefault: number | null;
          bpmOverride: number | null;
          /** Which engine produced this, so a stale analysis can offer a re-run. */
          engineVersion: string | null;
          source?: AnalysisSource;
          alignmentMap?: AlignmentMap;
      }
    | { kind: 'failed'; code: string };

const readyFromCache = (cached: CachedScoreAnalysis & { score: ScoreData }): Extract<ScoreAnalysisState, { kind: 'ready' }> => ({
    kind: 'ready',
    score: cached.score,
    bpmDefault: cached.bpmDefault,
    bpmOverride: cached.bpmOverride ?? null,
    engineVersion: cached.engineVersion,
    ...(cached.source ? { source: cached.source } : {}),
    ...(cached.alignmentMap ? { alignmentMap: cached.alignmentMap } : {}),
});

/** Fallback poll while pending/processing — Realtime is primary. */
const POLL_MS = 30_000;

/**
 * Lifecycle of a document's play-along analysis: read the existing status on
 * open (never starts one — only `generate()` does, from the user's click) →
 * poll while the OMR service works (30s fallback; Realtime drives sub-second
 * updates) → deliver validated ScoreData, with the Dexie cache covering
 * offline opens.
 */
export const useScoreAnalysis = (docId: string, enabled: boolean) => {
    const [state, setState] = useState<ScoreAnalysisState>({ kind: enabled ? 'none' : 'unavailable' });
    const aliveRef = useRef(true);

    const [resetKey, setResetKey] = useState(`${docId}:${enabled}`);
    const key = `${docId}:${enabled}`;
    if (resetKey !== key) {
        setResetKey(key);
        setState({ kind: enabled ? 'none' : 'unavailable' });
    }

    const applyStatus = useCallback(
        async (docIdNow: string): Promise<void> => {
            const set = (next: ScoreAnalysisState) => {
                if (aliveRef.current) {
                    setState(next);
                }
            };
            let status;
            try {
                status = await fetchScoreAnalysisStatus(docIdNow);
            } catch {
                const cached = await loadCachedScoreAnalysis(docIdNow).catch(() => null);
                if (cached?.status === 'ready' && cached.score) {
                    set(readyFromCache({ ...cached, score: cached.score }));
                } else {
                    set({ kind: 'unavailable' });
                }
                return;
            }

            if (!status) {
                set({ kind: 'none' });
                return;
            }
            if (status.status === 'failed') {
                set({ kind: 'failed', code: status.error ?? 'internal' });
                return;
            }
            if (status.status === 'pending' || status.status === 'processing') {
                if (isProcessingStale(status.updatedAt)) {
                    set({ kind: 'failed', code: 'stale' });
                } else if (status.status === 'processing') {
                    set({ kind: 'processing', progress: status.progress });
                } else {
                    set({ kind: 'pending' });
                }
                return;
            }

            const cached = await loadCachedScoreAnalysis(docIdNow).catch(() => null);
            if (cached?.status === 'ready' && cached.score && cached.fetchedAt >= status.updatedAt) {
                set(readyFromCache({ ...cached, score: cached.score }));
                return;
            }
            const full = await fetchScoreAnalysisFull(docIdNow).catch(() => null);
            if (full?.status === 'ready' && full.score) {
                set(readyFromCache({ ...full, score: full.score }));
            } else {
                set({ kind: 'failed', code: 'internal' });
            }
        },
        [setState],
    );

    useEffect(() => {
        aliveRef.current = true;
        if (enabled) {
            void applyStatus(docId);
        }
        return () => {
            aliveRef.current = false;
        };
    }, [docId, enabled, applyStatus]);

    const inFlight = state.kind === 'pending' || state.kind === 'processing';
    useEffect(() => {
        if (!inFlight || !enabled) {
            return;
        }
        const timer = setInterval(() => {
            if (document.visibilityState === 'visible') {
                void applyStatus(docId);
            }
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [inFlight, enabled, docId, applyStatus]);

    const generate = useCallback(async () => {
        setState({ kind: 'pending' });
        const result = await requestScoreAnalysis(docId);
        if (!aliveRef.current) {
            return;
        }
        if (!result.ok && result.code === 'already_running') {
            return;
        }
        if (!result.ok && result.code === 'already_current') {
            // Worker cannot improve this row — stay on the ready analysis,
            // do not flash a failure or spend a credit.
            void applyStatus(docId);
            return;
        }
        // backlog_full — show copy, Generate/Retry remains available via failed UI.
        if (!result.ok && result.code === 'backlog_full') {
            setState({ kind: 'failed', code: 'backlog_full' });
            return;
        }
        if (!result.ok) {
            setState({ kind: 'failed', code: result.code ?? 'internal' });
        }
    }, [docId, applyStatus]);

    const refresh = useCallback(() => {
        void applyStatus(docId);
    }, [applyStatus, docId]);

    /** Apply trimmed realtime payload; only fetch full ScoreData on ready. */
    const applyBroadcast = useCallback(
        (msg: ScoreAnalysisBroadcast) => {
            if (msg.document_id !== docId || !aliveRef.current) {
                return;
            }
            switch (msg.status) {
                case 'pending':
                    setState({ kind: 'pending' });
                    return;
                case 'processing':
                    setState({ kind: 'processing', progress: msg.progress ?? null });
                    return;
                case 'failed':
                    setState({ kind: 'failed', code: msg.error ?? 'internal' });
                    return;
                case 'ready':
                    void applyStatus(docId);
                    return;
                default: {
                    const _exhaustive: never = msg.status;
                    return _exhaustive;
                }
            }
        },
        [docId, applyStatus],
    );

    return { state, generate, refresh, applyBroadcast };
};
