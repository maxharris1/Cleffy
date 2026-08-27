import type { ScoreData, ScoreTimeSig } from './scoreData.js';

export interface SeamCompareResult {
    ok: boolean;
    reasons: string[];
}

/** Active time signature at tick (last event with tick <= t). */
export const activeTimeSigAt = (sigs: ScoreTimeSig[], tick: number): ScoreTimeSig | null => {
    let best: ScoreTimeSig | null = null;
    for (const sig of sigs) {
        if (sig.tick <= tick && (best === null || sig.tick >= best.tick)) {
            best = sig;
        }
    }
    return best;
};

/**
 * Compare a full-run ScoreData to a sharded+merged ScoreData around a page cut.
 * `seamPage0` is the first 0-based page belonging to the later exclusive region
 * (e.g. cut after overlap page 2 → seamPage0 = 2 for sheets 1-3 / 3-5).
 */
export const compareScoreDataAtSeam = (
    full: ScoreData,
    merged: ScoreData,
    seamPage0: number,
): SeamCompareResult => {
    const reasons: string[] = [];

    const fullSeamMeasures = full.measures.filter((m) => m.page === seamPage0);
    const mergedSeamMeasures = merged.measures.filter((m) => m.page === seamPage0);
    if (fullSeamMeasures.length === 0 || mergedSeamMeasures.length === 0) {
        reasons.push('missing_seam_page_measures');
    } else {
        const fullFirst = fullSeamMeasures[0]!;
        const mergedFirst = mergedSeamMeasures[0]!;
        if (fullFirst.dTicks !== mergedFirst.dTicks) {
            reasons.push(
                `seam_measure_dTicks full=${fullFirst.dTicks} merged=${mergedFirst.dTicks}`,
            );
        }
        const fullSig = activeTimeSigAt(full.timeSignatures, fullFirst.tick);
        const mergedSig = activeTimeSigAt(merged.timeSignatures, mergedFirst.tick);
        if (
            fullSig &&
            mergedSig &&
            (fullSig.num !== mergedSig.num || fullSig.den !== mergedSig.den)
        ) {
            reasons.push(
                `seam_time_sig full=${fullSig.num}/${fullSig.den} merged=${mergedSig.num}/${mergedSig.den}`,
            );
        } else if (fullSig && !mergedSig) {
            reasons.push('seam_time_sig_missing_in_merged');
        }
    }

    // Notes that sound across the seam tick in the full score should exist in merged
    // with the same pitch and comparable duration (±1 tick).
    const seamTick =
        full.measures.find((m) => m.page === seamPage0)?.tick ??
        merged.measures.find((m) => m.page === seamPage0)?.tick;
    if (seamTick !== undefined) {
        const crossing = full.notes.filter((n) => n.t < seamTick && n.t + n.d > seamTick + 2);
        for (const note of crossing) {
            const match = merged.notes.find(
                (m) => m.p === note.p && m.h === note.h && Math.abs(m.t - note.t) <= 2,
            );
            if (!match) {
                reasons.push(`crossing_note_missing pitch=${note.p} t=${note.t}`);
                continue;
            }
            if (Math.abs(match.d - note.d) > 2) {
                reasons.push(
                    `crossing_note_duration pitch=${note.p} full=${note.d} merged=${match.d}`,
                );
            }
        }
    }

    return { ok: reasons.length === 0, reasons };
};
