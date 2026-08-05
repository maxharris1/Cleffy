import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PlaybackEngine } from '@/features/playback/PlaybackEngine';
import { saveBpmOverride } from '@/features/playback/scoreAnalysisService';
import { measureEndTick, measureStartTick } from '@/features/playback/scoreTime';
import type { ScoreAnalysisState } from '@/features/playback/useScoreAnalysis';
import type { PlaybackFeature } from '@/features/viewer/PdfViewport';
import { BPM_MAX, BPM_MIN, DEFAULT_BPM, useViewerStore } from '@/state/store';

/**
 * Owns the PlaybackEngine for the viewer: created as soon as ScoreData is
 * ready (cheap — the AudioContext itself is only created inside the Play
 * tap), destroyed with the document. Bridges slow zustand transport state
 * (bpm, mutes, volumes, metronome, loop) into engine calls, and persists
 * the practice tempo per score.
 */
export const usePlayback = (docId: string, analysis: ScoreAnalysisState) => {
    const engineRef = useRef<PlaybackEngine | null>(null);
    const [warning, setWarning] = useState<string | null>(null);

    const score = analysis.kind === 'ready' ? analysis.score : null;
    const bpmDefault = analysis.kind === 'ready' ? analysis.bpmDefault : null;
    const bpmOverride = analysis.kind === 'ready' ? analysis.bpmOverride : null;

    // Clear a stale sample warning when the document/score changes (during
    // render, per the React "adjusting state" pattern).
    const [warningKey, setWarningKey] = useState(docId);
    if (warningKey !== docId) {
        setWarningKey(docId);
        setWarning(null);
    }

    useEffect(() => {
        const store = useViewerStore.getState();
        store.resetPlayback();
        if (!score) {
            return;
        }
        const initialBpm = Math.min(BPM_MAX, Math.max(BPM_MIN, bpmOverride ?? bpmDefault ?? DEFAULT_BPM));
        store.setBpm(initialBpm);
        const engine = new PlaybackEngine({
            score,
            bpm: initialBpm,
            onStatus: (status) => useViewerStore.getState().setPlaybackStatus(status),
            onWarning: (code) => setWarning(code),
        });
        engineRef.current = engine;
        return () => {
            engineRef.current = null;
            engine.destroy();
            useViewerStore.getState().resetPlayback();
        };
    }, [docId, score, bpmDefault, bpmOverride]);

    // Store → engine bridge for everything the TransportBar toggles.
    const bpmSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        if (!score) {
            return;
        }
        const unsubscribe = useViewerStore.subscribe((state, prev) => {
            const engine = engineRef.current;
            if (!engine) {
                return;
            }
            if (state.bpm !== prev.bpm) {
                engine.setBpm(state.bpm);
                if (bpmSaveTimer.current !== null) {
                    clearTimeout(bpmSaveTimer.current);
                }
                bpmSaveTimer.current = setTimeout(() => {
                    void saveBpmOverride(docId, state.bpm).catch(() => undefined);
                }, 500);
            }
            if (state.muteRH !== prev.muteRH) {
                engine.setHandMuted(0, state.muteRH);
            }
            if (state.muteLH !== prev.muteLH) {
                engine.setHandMuted(1, state.muteLH);
            }
            if (state.volRH !== prev.volRH) {
                engine.setHandVolume(0, state.volRH);
            }
            if (state.volLH !== prev.volLH) {
                engine.setHandVolume(1, state.volLH);
            }
            if (state.metronomeOn !== prev.metronomeOn) {
                engine.setMetronome(state.metronomeOn);
            }
            if (state.loopRange !== prev.loopRange) {
                engine.setLoop(
                    state.loopRange
                        ? {
                              startTick: measureStartTick(score.measures, state.loopRange.a),
                              endTick: measureEndTick(score.measures, state.loopRange.b),
                          }
                        : null,
                );
            }
        });
        return () => {
            unsubscribe();
            if (bpmSaveTimer.current !== null) {
                clearTimeout(bpmSaveTimer.current);
            }
        };
    }, [docId, score]);

    const getEngine = useCallback(() => engineRef.current, []);

    const playbackFeature = useMemo<PlaybackFeature | undefined>(
        () => (score ? { score, getEngine } : undefined),
        [score, getEngine],
    );

    return { playbackFeature, getEngine, warning, dismissWarning: () => setWarning(null) };
};
