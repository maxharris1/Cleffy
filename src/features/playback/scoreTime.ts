import type { ScoreData, ScoreMeasure, ScoreNote, ScoreTimeSig } from '@/types/scoreData';
import { TICKS_PER_QUARTER } from '@/types/scoreData';

/**
 * Pure tick/measure/beat math shared by the playback engine, the playhead,
 * and the transport. Everything here is side-effect free and unit tested —
 * keep it that way (geometry.ts discipline).
 */

/** Seconds per tick at a given quarter-note BPM. */
export const secondsPerTick = (bpm: number): number => 60 / (bpm * TICKS_PER_QUARTER);

/** Ticks per beat for a time-signature denominator (den 4 → 480, den 8 → 240). */
export const ticksPerBeat = (den: number): number => (TICKS_PER_QUARTER * 4) / den;

const DEFAULT_TIME_SIG: ScoreTimeSig = { tick: 0, num: 4, den: 4 };

/** The time signature in effect at a tick (last change at or before it). */
export const timeSigAt = (timeSignatures: readonly ScoreTimeSig[], tick: number): ScoreTimeSig => {
    let active = timeSignatures[0] ?? DEFAULT_TIME_SIG;
    for (const sig of timeSignatures) {
        if (sig.tick > tick) {
            break;
        }
        active = sig;
    }
    return active;
};

/**
 * Index of the measure containing `tick` (greatest start ≤ tick), clamped to
 * the first/last measure for out-of-range ticks. Returns -1 only for an
 * empty measure list.
 */
export const measureIndexAtTick = (measures: readonly ScoreMeasure[], tick: number): number => {
    if (measures.length === 0) {
        return -1;
    }
    let lo = 0;
    let hi = measures.length - 1;
    if (tick <= (measures[0]?.tick ?? 0)) {
        return 0;
    }
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if ((measures[mid]?.tick ?? 0) <= tick) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return lo;
};

/** Fraction (0–1) of the way through a measure at `tick`. */
export const fractionWithinMeasure = (measure: ScoreMeasure, tick: number): number => {
    if (measure.dTicks <= 0) {
        return 0;
    }
    return Math.min(1, Math.max(0, (tick - measure.tick) / measure.dTicks));
};

/**
 * Prev/next-measure stepping, with the standard transport nuance: stepping
 * back from >20% into a measure returns to that measure's own start first.
 * Returns the target start tick.
 */
export const stepMeasure = (measures: readonly ScoreMeasure[], tick: number, delta: -1 | 1): number => {
    const index = measureIndexAtTick(measures, tick);
    if (index < 0) {
        return 0;
    }
    const current = measures[index];
    if (!current) {
        return 0;
    }
    if (delta === 1) {
        const next = measures[index + 1];
        return next ? next.tick : current.tick;
    }
    if (tick - current.tick > current.dTicks * 0.2) {
        return current.tick;
    }
    const prev = measures[index - 1];
    return prev ? prev.tick : current.tick;
};

/** Lower bound: index of the first note starting at or after `tick`. */
export const firstNoteIndexAtOrAfter = (notes: readonly ScoreNote[], tick: number): number => {
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((notes[mid]?.t ?? 0) < tick) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
};

/** Safety cap: no sane measure has more beats than this (guards corrupt data). */
const MAX_BEATS_PER_MEASURE = 64;

/**
 * Absolute beat ticks within a measure, anchored to its barline (so pickups
 * and irregular measures click correctly). First entry is the accented
 * downbeat.
 */
export const beatsForMeasure = (measure: ScoreMeasure, timeSignatures: readonly ScoreTimeSig[]): number[] => {
    const beatTicks = ticksPerBeat(timeSigAt(timeSignatures, measure.tick).den);
    const beats: number[] = [];
    for (let k = 0; k < MAX_BEATS_PER_MEASURE; k++) {
        const tick = measure.tick + k * beatTicks;
        if (tick >= measure.tick + measure.dTicks) {
            break;
        }
        beats.push(tick);
    }
    return beats;
};

export interface CountInSpec {
    /** Number of count-in clicks (one full measure of the active time signature). */
    beats: number;
    /** Spacing between clicks, in ticks. */
    beatTicks: number;
}

/** One full measure of count-in clicks in the time signature active at `startTick`. */
export const countInSpec = (score: ScoreData, startTick: number): CountInSpec => {
    const sig = timeSigAt(score.timeSignatures, startTick);
    return { beats: sig.num, beatTicks: ticksPerBeat(sig.den) };
};

/** Start tick of a measure by index, clamped to the score. */
export const measureStartTick = (measures: readonly ScoreMeasure[], index: number): number => {
    const clamped = measures[Math.min(measures.length - 1, Math.max(0, index))];
    return clamped ? clamped.tick : 0;
};

/** End tick (exclusive) of a measure by index. */
export const measureEndTick = (measures: readonly ScoreMeasure[], index: number): number => {
    const measure = measures[Math.min(measures.length - 1, Math.max(0, index))];
    return measure ? measure.tick + measure.dTicks : 0;
};

/**
 * Measure under a normalized point on a page (tap-to-seek). Matches the
 * system whose y-band contains the point, then the measure whose x-range
 * contains it. Returns the measure index, or -1.
 */
export const measureIndexAtPagePoint = (score: ScoreData, pageIndex: number, nx: number, ny: number): number => {
    for (let sysIndex = 0; sysIndex < score.systems.length; sysIndex++) {
        const system = score.systems[sysIndex];
        if (!system || system.page !== pageIndex || ny < system.y0 || ny > system.y1) {
            continue;
        }
        for (let i = 0; i < score.measures.length; i++) {
            const measure = score.measures[i];
            if (measure && measure.sys === sysIndex && nx >= measure.x0 && nx <= measure.x1) {
                return i;
            }
        }
    }
    return -1;
};
