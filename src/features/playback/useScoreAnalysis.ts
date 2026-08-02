import { useCallback, useEffect, useRef, useState } from 'react';

import {
    fetchScoreAnalysisFull,
    fetchScoreAnalysisStatus,
    isProcessingStale,
    loadCachedScoreAnalysis,
    requestScoreAnalysis,
} from '@/features/playback/scoreAnalysisService';
import type { ScoreData } from '@/types/scoreData';

export type ScoreAnalysisState =
    | { kind: 'unavailable' } // local doc, offline without cache, …
    | { kind: 'none' } // no analysis requested yet
    | { kind: 'pending' }
    | { kind: 'processing'; progress: number | null }
    | { kind: 'ready'; score: ScoreData; bpmDefault: number | null; bpmOverride: number | null }
    | { kind: 'failed'; code: string };

const POLL_MS = 5000;

/**
 * Lifecycle of a document's play-along analysis: fetch → poll while the OMR
 * service works (5s, only while the tab is visible) → deliver validated
 * ScoreData, with the Dexie cache covering offline opens. `generate()`
 * requests/retries analysis (owner/editor only — RLS backstops the UI).
 */
/** How long to keep polling after open while status is still `none` — covers the
 * race where LibraryShell fires requestScoreAnalysis then navigates before the
 * score_analyses row exists. */
const BOOTSTRAP_POLL_MS = 30_000;

export const useScoreAnalysis = (docId: string, enabled: boolean) => {
    const [state, setState] = useState<ScoreAnalysisState>({ kind: enabled ? 'none' : 'unavailable' });
    const aliveRef = useRef(true);
    const [bootstrapUntil, setBootstrapUntil] = useState(() => Date.now() + BOOTSTRAP_POLL_MS);

    // Reset synchronously when the document (or availability) changes —
    // during render, per the React "adjusting state" pattern, so the old
    // score never flashes against the new document.
    const [resetKey, setResetKey] = useState(`${docId}:${enabled}`);
    const key = `${docId}:${enabled}`;
    if (resetKey !== key) {
        setResetKey(key);
        setState({ kind: enabled ? 'none' : 'unavailable' });
        setBootstrapUntil(Date.now() + BOOTSTRAP_POLL_MS);
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
                // Offline: a cached ready analysis still plays.
                const cached = await loadCachedScoreAnalysis(docIdNow).catch(() => null);
                if (cached?.status === 'ready' && cached.score) {
                    set({
                        kind: 'ready',
                        score: cached.score,
                        bpmDefault: cached.bpmDefault,
                        bpmOverride: cached.bpmOverride ?? null,
                    });
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

            // ready — serve from cache when it's fresher than the row's last update.
            const cached = await loadCachedScoreAnalysis(docIdNow).catch(() => null);
            if (cached?.status === 'ready' && cached.score && cached.fetchedAt >= status.updatedAt) {
                set({
                    kind: 'ready',
                    score: cached.score,
                    bpmDefault: cached.bpmDefault,
                    bpmOverride: cached.bpmOverride ?? null,
                });
                return;
            }
            const full = await fetchScoreAnalysisFull(docIdNow).catch(() => null);
            if (full?.status === 'ready' && full.score) {
                set({ kind: 'ready', score: full.score, bpmDefault: full.bpmDefault, bpmOverride: full.bpmOverride ?? null });
            } else {
                // Row said ready but the payload didn't validate — treat as failure.
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

    // Poll while a job is in flight, and briefly while `none` after open so we
    // catch analyses started from the library before the row was visible.
    const awaitingBootstrap = state.kind === 'none' && Date.now() < bootstrapUntil;
    const inFlight = state.kind === 'pending' || state.kind === 'processing' || awaitingBootstrap;
    useEffect(() => {
        if (!inFlight || !enabled) {
            return;
        }
        const timer = setInterval(() => {
            if (document.visibilityState === 'visible') {
                void applyStatus(docId);
            }
        }, POLL_MS);
        // Drop the bootstrap window once it expires so we don't poll forever
        // for documents that truly have no analysis.
        const stopBootstrap =
            awaitingBootstrap
                ? setTimeout(() => setBootstrapUntil(0), Math.max(0, bootstrapUntil - Date.now()))
                : undefined;
        return () => {
            clearInterval(timer);
            if (stopBootstrap !== undefined) {
                clearTimeout(stopBootstrap);
            }
        };
    }, [inFlight, awaitingBootstrap, bootstrapUntil, enabled, docId, applyStatus]);

    const generate = useCallback(async () => {
        setState({ kind: 'pending' });
        const result = await requestScoreAnalysis(docId);
        if (!aliveRef.current) {
            return;
        }
        if (!result.ok && result.code !== 'already_running') {
            setState({ kind: 'failed', code: result.code ?? 'internal' });
        }
    }, [docId]);

    const refresh = useCallback(() => {
        void applyStatus(docId);
    }, [applyStatus, docId]);

    return { state, generate, refresh };
};
